/**
 * Ollama 供应商实现（自建开源模型运行时）。
 *
 * 关键约束（用户需求）：
 * - 仅后端可访问 Ollama；baseUrl / model 全部来自服务端 env，前端不可见、不可覆盖；
 * - 绝不在日志或错误信息里泄露 Ollama 地址、端口、原始 body 全文；
 * - Ollama 没启动（连接被拒）→ E_AI_UNAVAILABLE（"AI 服務暫時不可用，請稍後再試"）；
 * - 模型不存在（HTTP 404 / body.error 含 not found）→ E_AI_MODEL_MISSING（"AI 模型暫時不可用，請聯絡管理員"）；
 * - 超时 → E_AI_TIMEOUT。
 *
 * 协议：POST ${baseUrl}/api/chat
 *   - 流式：body.stream=true，响应为「换行分隔的 JSON」（每行一个 {message, done} 或 {error}），
 *     不是 SSE 的 `data:` 前缀；
 *   - 非流式：body.stream=false，响应为单个 JSON {message:{role,content}, done:true}。
 */

import type { ChatMessage, AIStreamOptions, AIProvider } from './types.js';
import { AIProviderError } from './types.js';
import { UserAbortError } from '../agent/errors.js';
import { logger } from '../logger.js';

/** Ollama /api/chat 返回的单条 JSON 结构（流式每行一个，非流式整体一个） */
interface OllamaChunk {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

/** 温度提示 → Ollama temperature 数值 */
function hintToTemp(opts: AIStreamOptions): number {
  if (opts.jsonMode) return 0.2; // 结构化输出要稳定
  switch (opts.temperatureHint) {
    case 'precise':
      return 0.3;
    case 'creative':
      return 0.9;
    case 'balanced':
    default:
      return 0.7;
  }
}

interface AbortState {
  timedOut: boolean;
  outer?: AbortSignal;
}

export class OllamaProvider implements AIProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly lightModel: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, model: string, lightModel: string, timeoutMs: number) {
    // 去掉尾部斜杠，避免拼出 http://host:11434//api/chat
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.lightModel = lightModel || model;
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : 120_000;
  }

  /**
   * 后端决定用哪个模型：轻量任务（情绪 / 记忆抽取 / JSON）走 lightModel，其余走主模型。
   * 故意忽略 opts.model —— 用户无法透过请求覆盖后端配置的模型（需求：用户不可控模型）。
   */
  private resolveModel(opts: AIStreamOptions): string {
    return opts.jsonMode ? this.lightModel : this.model;
  }

  private buildBody(messages: ChatMessage[], opts: AIStreamOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.resolveModel(opts),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      options: { temperature: hintToTemp(opts) },
    };
    // jsonMode 时要求 Ollama 直接产出 JSON（配合 sdkClient 的 completeJson 兜底）
    if (opts.jsonMode) body.format = 'json';
    return body;
  }

  /**
   * 发起 Ollama 请求并处理超时 / 用户中断 / 连接失败。
   * 返回一个响应对象 + 本次请求的 AbortState（流式读取阶段需要据此判断中断原因）。
   */
  private async fetchChat(
    body: unknown,
    opts: AIStreamOptions,
    timeoutMs: number,
  ): Promise<{ res: Response; state: AbortState }> {
    const outer = opts.signal;
    const controller = new AbortController();
    const state: AbortState = { timedOut: false, outer };
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (outer) outer.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { res, state };
    } catch (err) {
      if (state.timedOut) {
        throw new AIProviderError('AI 回應超時，請稍後再試', 'E_AI_TIMEOUT', true);
      }
      if (outer?.aborted) {
        throw new UserAbortError();
      }
      // fetch 抛错通常是 ECONNREFUSED / 网络不可达 → Ollama 没启动
      logger.warn('[Ollama] 連線失敗（Ollama 可能未啟動）', {
        message: err instanceof Error ? err.message : String(err),
      });
      throw new AIProviderError('AI 服務暫時不可用，請稍後再試', 'E_AI_UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 非 2xx 时抛出脱敏错误（404=模型缺失） */
  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = typeof data?.error === 'string' ? data.error : '';
    } catch {
      /* 响应体不是 JSON，忽略 */
    }
    throw this.errorFromDetail(res.status, detail);
  }

  private errorFromDetail(status: number, detail: string): AIProviderError {
    if (status === 404 || /not found|does not exist|model/i.test(detail)) {
      return new AIProviderError('AI 模型暫時不可用，請聯絡管理員', 'E_AI_MODEL_MISSING', false, status);
    }
    if (status === 429) {
      return new AIProviderError('AI 服務繁忙，請稍後再試', 'E_AI_RATE_LIMIT', true, status);
    }
    // 400 / 其他 → 视为服务暂不可用（不泄露状态码细节给前端）
    return new AIProviderError('AI 服務暫時不可用，請稍後再試', 'E_AI_UNAVAILABLE', true, status);
  }

  /** 流式读取阶段的中断分类（区分超时 vs 用户断开） */
  private classifyReadError(err: unknown, state: AbortState): Error {
    if (state.timedOut) return new AIProviderError('AI 回應超時，請稍後再試', 'E_AI_TIMEOUT', true);
    if (state.outer?.aborted) return new UserAbortError();
    return new AIProviderError('AI 服務暫時不可用，請稍後再試', 'E_AI_UNAVAILABLE', true);
  }

  async *streamChat(
    messages: ChatMessage[],
    opts: AIStreamOptions,
  ): AsyncGenerator<{ delta: string }, { text: string }, void> {
    const body = this.buildBody(messages, opts, true);
    const { res, state } = await this.fetchChat(body, opts, this.timeoutMs);
    await this.assertOk(res);
    if (!res.body) throw new AIProviderError('AI 服務回傳空白', 'E_AI_UNAVAILABLE', true);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let parsed: OllamaChunk;
          try {
            parsed = JSON.parse(line) as OllamaChunk;
          } catch {
            continue; // 跳过不完整/脏行
          }
          if (parsed.error) throw this.errorFromDetail(0, parsed.error);
          const delta = parsed.message?.content;
          if (delta) {
            full += delta;
            yield { delta };
          }
        }
      }

      // 冲刷缓冲区里最后可能残留的一行
      const rest = buffer.trim();
      if (rest) {
        try {
          const parsed = JSON.parse(rest) as OllamaChunk;
          if (parsed.error) throw this.errorFromDetail(0, parsed.error);
          const c = parsed.message?.content;
          if (c) {
            full += c;
            yield { delta: c };
          }
        } catch {
          /* 忽略尾部残片 */
        }
      }
    } catch (err) {
      if (err instanceof AIProviderError || err instanceof UserAbortError) throw err;
      throw this.classifyReadError(err, state);
    }

    return { text: full };
  }

  async complete(messages: ChatMessage[], opts: AIStreamOptions): Promise<string> {
    const body = this.buildBody(messages, opts, false);
    const { res } = await this.fetchChat(body, opts, this.timeoutMs);
    await this.assertOk(res);

    let parsed: OllamaChunk;
    try {
      parsed = (await res.json()) as OllamaChunk;
    } catch {
      throw new AIProviderError('AI 服務回傳格式錯誤', 'E_AI_UNAVAILABLE', true);
    }
    if (parsed.error) throw this.errorFromDetail(0, parsed.error);

    const text = parsed.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new AIProviderError('AI 回傳內容為空', 'E_AI_EMPTY', false);
    }
    return text;
  }
}
