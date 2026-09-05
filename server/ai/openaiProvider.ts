/**
 * OpenAI 兼容供应商实现（云端 LLM，用于免費公網部署）。
 *
 * 关键约束（与 OllamaProvider 保持一致）：
 * - baseUrl / apiKey / model 全部来自服务端 env，前端不可见、不可覆盖；
 * - 绝不在日志或错误信息里泄露 apiKey / 原始 body 全文；
 * - 超时 → E_AI_TIMEOUT；
 * - 用户中断 → UserAbortError；
 * - 401 → E_AI_AUTH（金鑰無效）；429 → E_AI_RATE_LIMIT（可重试）；
 * - 404 / not found → E_AI_MODEL_MISSING；其余 → E_AI_UNAVAILABLE。
 *
 * 协议：POST ${baseUrl}/chat/completions
 *   - 流式：SSE，每行 `data: {...}`，结束标记 `data: [DONE]`；
 *   - 非流式：JSON { choices:[{ message:{ content } }] }。
 *
 * 典型用法：Groq / Google Gemini 等「OpenAI 兼容」接口，无需本地 Ollama，
 * 适合部署到 Hugging Face Spaces 等免费公网环境。
 */

import type { ChatMessage, AIStreamOptions, AIProvider } from './types.js';
import { AIProviderError } from './types.js';
import { UserAbortError } from '../agent/errors.js';
import { logger } from '../logger.js';

/** 温度提示 → OpenAI temperature 数值（与 OllamaProvider 完全一致） */
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

/** OpenAI /chat/completions 流式分片结构 */
interface OpenAIChatChunk {
  choices?: Array<{ delta?: { content?: string | null } | null } | null | undefined>;
}

/** OpenAI /chat/completions 非流式响应结构 */
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } | null } | null | undefined>;
  error?: { message?: string } | null;
}

export class OpenAICompatibleProvider implements AIProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly lightModel: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    lightModel: string,
    timeoutMs: number,
  ) {
    // 去掉尾部斜杠，避免拼出 https://api.groq.com/openai/v1//chat/completions
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.lightModel = lightModel || model;
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : 120_000;
  }

  /**
   * 后端决定用哪个模型：轻量任务（情绪 / 记忆抽取 / JSON）走 lightModel，其余走主模型。
   * 故意忽略 opts.model —— 用户无法透过请求覆盖后端配置的模型。
   */
  private resolveModel(opts: AIStreamOptions): string {
    return opts.jsonMode ? this.lightModel : this.model;
  }

  /** 请求头：仅携带 Bearer apiKey，绝不在任何日志里重复打印它 */
  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildBody(
    messages: ChatMessage[],
    opts: AIStreamOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.resolveModel(opts),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      temperature: hintToTemp(opts),
    };
    // jsonMode 时要求模型直接产出 JSON 对象（配合 sdkClient 的 completeJson 兜底）
    if (opts.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    return body;
  }

  /**
   * 发起 OpenAI 兼容请求并处理超时 / 用户中断 / 连接失败。
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
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
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
      // fetch 抛错通常是网络不可达 / DNS 失败 → 云端 LLM 不可达
      logger.warn('[OpenAI] 連線失敗（雲端 LLM 可能不可達）', {
        message: err instanceof Error ? err.message : String(err),
      });
      throw new AIProviderError('AI 服務暫時不可用，請稍後再試', 'E_AI_UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 非 2xx 时抛出脱敏错误（401=金鑰無效 / 429=限流 / 404=模型缺失） */
  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    let detail = '';
    try {
      const data = (await res.json()) as { error?: { message?: string } | null };
      detail = typeof data?.error?.message === 'string' ? data.error.message : '';
    } catch {
      /* 响应体不是 JSON，忽略 */
    }
    throw this.errorFromDetail(res.status, detail);
  }

  private errorFromDetail(status: number, detail: string): AIProviderError {
    if (status === 401) {
      // 不把 detail 带进对外文案，避免泄露模型名/账户信息
      return new AIProviderError('AI 金鑰無效，請檢查 API Key', 'E_AI_AUTH', false, status);
    }
    if (status === 429) {
      return new AIProviderError('AI 服務繁忙，請稍後再試', 'E_AI_RATE_LIMIT', true, status);
    }
    if (status === 404 || /not found/i.test(detail)) {
      return new AIProviderError('AI 模型暫時不可用，請聯絡管理員', 'E_AI_MODEL_MISSING', false, status);
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
          // SSE keep-alive 注释或空行跳过
          if (line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') break;
          let parsed: OpenAIChatChunk;
          try {
            parsed = JSON.parse(payload) as OpenAIChatChunk;
          } catch {
            continue; // 跳过不完整/脏行
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') {
            full += delta;
            yield { delta };
          }
        }
      }

      // 冲刷缓冲区里最后可能残留的一行
      const rest = buffer.trim();
      if (rest && !rest.startsWith(':') && rest.startsWith('data:')) {
        const payload = rest.slice('data:'.length).trim();
        if (payload !== '[DONE]') {
          try {
            const parsed = JSON.parse(payload) as OpenAIChatChunk;
            const c = parsed.choices?.[0]?.delta?.content;
            if (typeof c === 'string') {
              full += c;
              yield { delta: c };
            }
          } catch {
            /* 忽略尾部残片 */
          }
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

    let parsed: OpenAIChatResponse;
    try {
      parsed = (await res.json()) as OpenAIChatResponse;
    } catch {
      throw new AIProviderError('AI 服務回傳格式錯誤', 'E_AI_UNAVAILABLE', true);
    }

    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new AIProviderError('AI 回傳內容為空', 'E_AI_EMPTY', false);
    }
    return text;
  }
}
