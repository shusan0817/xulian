/**
 * 流式回复提取器
 *
 * 背景：System Prompt 要求模型输出结构化 JSON
 *   {"reply":"...","favorability_change":2,"emotion":"warm"}
 * 但 SSE 是逐 token 推送的——如果服务端把 delta 原样转发，
 * 用户会在气泡里盯着几十秒的 JSON 原文，消息结束才突然变成人话。
 *
 * 这个模块用**字符级状态机**在流式过程中实时剥掉 JSON 外壳：
 * 一旦进入 reply 字符串内部，每来一个新字符就立刻吐出一个增量，
 * 用户看到的是「你」→「你好」→「你好，今天」逐字增长，
 * 而不是等整个 JSON 完成之后一次性刷出。
 *
 * 设计要点（刻意不用 replace('{','') 这类字符串替换糊弄）：
 * 1. 跨 chunk 边界安全：JSON 可以被切成任意碎片，哪怕每次只来一个字符。
 * 2. 完整处理 JSON 转义：\n \t \" \\ \/ \b \f \uXXXX；
 *    \uXXXX 不足 4 位时**等待后续数据**，不会截断成半个字。
 * 3. 兼容多种外壳：`data: ` 前缀、```json 围栏、content/text 等替代字段名。
 * 4. 模型没按格式输出纯文本时原样透传：绝不丢字、绝不报错。
 * 5. 单个 chunk 不是完整 JSON 时安静地缓冲等待，不抛异常。
 */

/** 目标字段：按优先级匹配，第一个出现的作为回复正文 */
const TARGET_KEYS: readonly string[] = ['reply', 'content', 'text'];

/** SSE 行前缀（模型偶尔会 echo 这个格式） */
const SSE_PREFIX = 'data:';

/** markdown 代码块围栏 */
const FENCE = '```';

/**
 * 状态机阶段
 * - pending       还没收够数据判断是 JSON 还是纯文本
 * - plain         纯文本，原样透传
 * - seek          JSON 对象内，寻找下一个 key
 * - key           正在读 key 字符串
 * - afterKey      key 结束，等冒号
 * - preValue      冒号后，等 value 起始字符
 * - inValue       正在读字符串 value（只有命中目标字段时才吐增量）
 * - skipValue     跳过非字符串 value（数字 / 布尔 / null）
 * - skipStr       跳过非目标字段的字符串 value
 * - done          已取完回复正文，后续内容忽略
 */
type Phase =
  | 'pending'
  | 'plain'
  | 'seek'
  | 'key'
  | 'afterKey'
  | 'preValue'
  | 'inValue'
  | 'skipValue'
  | 'skipStr'
  | 'done';

/** 转义字符解析结果：text 为解码后的字符，len 为消耗的原始字符数 */
interface EscapeResult {
  text: string;
  len: number;
}

/** 解析出的结构化回复（供落库 / 元数据使用） */
export interface StructuredReply {
  /** 回复正文；模型没输出时可能是 null */
  reply: string | null;
  /** 好感度增减，默认 0 */
  change: number;
  /** 氛围情绪名（sweet/warm/sad/angry/normal），模型没给时为 null */
  emotion: string | null;
}

/**
 * 流式提取器：把「可能是 JSON 的流式输出」转成「纯文本的流式增量」。
 *
 * 用法：
 *   const ex = createStreamReplyExtractor();
 *   for await (const { delta } of stream) {
 *     const inc = ex.push(delta);
 *     if (inc) yield { type: 'text', content: inc };
 *   }
 *   const tail = ex.finish(); // 收尾兜底
 */
export class StreamReplyExtractor {
  /** 尚未消费完的原始缓冲 */
  private buf = '';
  /** buf 中下一个待处理字符的下标 */
  private i = 0;
  private phase: Phase = 'pending';
  /** JSON 花括号深度（1 = 顶层对象内） */
  private depth = 0;
  /** 当前正在读的 key */
  private currentKey = '';
  /** 已捕获的目标字段名（null = 还没抓到） */
  private captured: string | null = null;
  /** inValue 阶段是否向外吐增量 */
  private emitting = false;
  /** 累积的原始输入，供兜底解析 */
  private raw = '';

  /**
   * 推入一个增量片段，返回「本次应转发给前端的纯文本增量」。
   * 没有新内容时返回空字符串。
   */
  push(chunk: string): string {
    if (!chunk) return '';

    this.raw += chunk;
    this.buf += chunk;

    const out: string[] = [];

    if (this.phase === 'pending') this.detect();

    if (this.phase === 'plain') {
      // 纯文本：把尚未吐出的部分全部吐出
      out.push(this.buf.slice(this.i));
      this.i = this.buf.length;
    } else if (this.phase !== 'pending' && this.phase !== 'done') {
      this.step(out);
    }

    this.compact();
    return out.join('');
  }

  /**
   * 流结束时的收尾，返回「还需要补发的文本」。
   * 用于兜底：JSON 一直没抓到目标字段时，尝试整段解析一次。
   */
  finish(): string {
    if (this.phase === 'plain') {
      const rest = this.buf.slice(this.i);
      this.i = this.buf.length;
      this.phase = 'done';
      return rest;
    }

    if (this.phase === 'pending') {
      // 始终没能判定格式（例如只有空白或半截围栏）：当纯文本吐出，避免丢字
      const rest = this.buf.slice(this.i).trim();
      this.i = this.buf.length;
      this.phase = 'done';
      return rest;
    }

    if (this.captured === null) {
      const parsed = parseStructuredReply(this.raw);
      if (parsed && parsed.reply) {
        this.phase = 'done';
        return parsed.reply;
      }
    }

    this.phase = 'done';
    return '';
  }

  /** 累积的原始输入（调试 / 最终解析用） */
  getRaw(): string {
    return this.raw;
  }

  /** 是否已经进入过回复正文（用于判断流式是否真的吐过内容） */
  hasCaptured(): boolean {
    return this.captured !== null;
  }

  // ---------------- 内部实现 ----------------

  /** 判定输入是 JSON 还是纯文本，并推进游标越过各种外壳前缀 */
  private detect(): void {
    const rest = this.buf.slice(this.i);
    const leading = rest.length - rest.trimStart().length;
    let s = rest.trimStart();
    this.i += leading;
    if (!s) return;

    // 1) SSE 前缀
    if (s.startsWith(SSE_PREFIX)) {
      this.i += SSE_PREFIX.length;
      s = s.slice(SSE_PREFIX.length);
      const w = s.length - s.trimStart().length;
      this.i += w;
      s = s.trimStart();
      if (!s) return;
    } else if (SSE_PREFIX.startsWith(s) && s.length < SSE_PREFIX.length) {
      // 只收到 "d" / "da" / "dat" / "data"，等更多数据再判定
      return;
    }

    // 2) markdown 围栏
    if (s.startsWith(FENCE)) {
      const brace = s.indexOf('{');
      if (brace >= 0) {
        this.i += brace + 1;
        this.depth = 1;
        this.phase = 'seek';
        return;
      }
      const nl = s.indexOf('\n');
      if (nl >= 0) {
        // 围栏里不是 JSON：越过围栏起始行，按纯文本透传
        this.i += nl + 1;
        this.phase = 'plain';
        return;
      }
      return; // 连围栏行都还没收全
    }

    // 3) 真正的 JSON
    if (s.startsWith('{')) {
      this.i += 1;
      this.depth = 1;
      this.phase = 'seek';
      return;
    }

    // 4) 其余一律当纯文本
    this.phase = 'plain';
  }

  /** JSON 状态机主循环：逐字符推进，把命中目标字段的字符写入 out */
  private step(out: string[]): void {
    while (this.i < this.buf.length) {
      const c = this.buf[this.i];

      switch (this.phase) {
        case 'seek':
          if (c === '"') {
            this.currentKey = '';
            this.phase = 'key';
            this.i++;
          } else if (c === '{') {
            this.depth++;
            this.i++;
          } else if (c === '}') {
            this.depth--;
            this.i++;
            if (this.depth <= 0) {
              this.phase = 'done';
              return;
            }
          } else {
            this.i++;
          }
          break;

        case 'key':
          if (c === '\\') {
            this.i += 2; // key 里的转义极罕见，直接跳过
            break;
          }
          if (c === '"') {
            this.phase = 'afterKey';
            this.i++;
            break;
          }
          this.currentKey += c;
          this.i++;
          break;

        case 'afterKey':
          if (c === ':') {
            this.phase = 'preValue';
            this.i++;
          } else if (/\s/.test(c)) {
            this.i++;
          } else {
            this.phase = 'seek'; // 结构异常，退回寻找下一个 key
          }
          break;

        case 'preValue':
          if (/\s/.test(c)) {
            this.i++;
            break;
          }
          if (c === '"') {
            // 命中目标字段且还没抓过 → 这个 value 就是回复正文
            if (this.captured === null && TARGET_KEYS.includes(this.currentKey)) {
              this.captured = this.currentKey;
              this.emitting = true;
            } else {
              this.emitting = false;
            }
            this.phase = 'inValue';
            this.i++;
            break;
          }
          this.phase = 'skipValue'; // 数字 / 布尔 / null / 嵌套结构
          break;

        case 'inValue':
          if (c === '\\') {
            const r = this.readEscape();
            if (r === null) return; // 转义序列没收全，等待后续数据
            if (this.emitting) out.push(r.text);
            this.i += r.len;
            break;
          }
          if (c === '"') {
            this.i++;
            if (this.emitting) {
              this.phase = 'done'; // 回复正文取完
              return;
            }
            this.phase = 'seek'; // 非目标字段，继续找
            break;
          }
          if (this.emitting) out.push(c);
          this.i++;
          break;

        case 'skipValue':
          if (c === '"') {
            this.phase = 'skipStr';
            this.i++;
          } else if (c === '{') {
            this.depth++;
            this.i++;
          } else if (c === '}') {
            this.depth--;
            this.i++;
            if (this.depth <= 0) {
              this.phase = 'done';
              return;
            }
          } else if (c === ',') {
            if (this.depth <= 1) this.phase = 'seek';
            this.i++;
          } else {
            this.i++;
          }
          break;

        case 'skipStr':
          if (c === '\\') {
            this.i += 2;
            break;
          }
          if (c === '"') {
            this.phase = 'seek';
            this.i++;
            break;
          }
          this.i++;
          break;

        case 'done':
          return;

        default:
          return;
      }
    }
  }

  /**
   * 解析以游标处 `\` 开头的转义序列。
   * 数据不足时返回 null（调用方应停止消费并等待更多数据）。
   */
  private readEscape(): EscapeResult | null {
    const n = this.buf.length;
    if (this.i + 1 >= n) return null;

    const e = this.buf[this.i + 1];

    if (e === 'u') {
      // \uXXXX 必须凑齐 4 个十六进制位才能解码
      if (this.i + 6 > n) return null;
      const hex = this.buf.slice(this.i + 2, this.i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { text: '?', len: 2 }; // 畸形 \u，降级处理
      }
      return { text: String.fromCharCode(parseInt(hex, 16)), len: 6 };
    }

    const map: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      b: '\b',
      f: '\f',
      '"': '"',
      '\\': '\\',
      '/': '/',
    };
    const mapped = map[e];
    return mapped !== undefined ? { text: mapped, len: 2 } : { text: e, len: 2 };
  }

  /** 丢弃已消费的前缀，避免长对话里 buffer 无限增长 */
  private compact(): void {
    if (this.i > 16384) {
      this.buf = this.buf.slice(this.i);
      this.i = 0;
    }
  }
}

/** 工厂函数：创建一个流式提取器 */
export function createStreamReplyExtractor(): StreamReplyExtractor {
  return new StreamReplyExtractor();
}

/** 剥掉各种外壳（围栏 / data: 前缀 / 空白），得到可能可解析的 JSON 文本 */
export function stripEnvelope(raw: string): string {
  let s = raw.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) s = fenced[1].trim();
  if (s.startsWith(SSE_PREFIX)) s = s.slice(SSE_PREFIX.length).trim();
  return s;
}

/**
 * 对**完整**的原始输出做一次整段解析，取出 reply / favorability_change / emotion。
 * 非 JSON 或解析失败时返回 null（调用方应保留原文，不要报错给用户）。
 */
export function parseStructuredReply(raw: string): StructuredReply | null {
  const s = stripEnvelope(raw);
  if (!s.startsWith('{')) return null;

  try {
    const data = JSON.parse(s) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;

    const replyRaw = data.reply ?? data.content ?? data.text;
    const reply = typeof replyRaw === 'string' ? replyRaw : null;

    const changeNum = Number(data.favorability_change);
    const change = Number.isFinite(changeNum) ? changeNum : 0;

    const emotion = typeof data.emotion === 'string' ? data.emotion : null;

    return { reply, change, emotion };
  } catch {
    // 解析失败不是用户该承担的错，静默返回 null，由调用方走兜底
    return null;
  }
}
