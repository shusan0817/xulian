/**
 * AI 供应商抽象层类型定义。
 *
 * 设计目标：
 * - 把「具体用哪一家 AI」从业务代码里剥离出来；
 * - 业务侧（sdkClient 门面）只依赖本文件里的接口，不关心背后是 OpenAI 还是 CodeBuddy；
 * - 所有错误统一成 AIProviderError，绝不在错误信息里泄露 apiKey / 原始堆栈。
 */

/** 一条对话消息（OpenAI chat/completions 格式） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** AI 供应商错误码（与业务侧 shared/errors.ts 的 E_AI_* 一一对应） */
export type AIErrorCode =
  | 'E_AI_UNAVAILABLE'
  | 'E_AI_TIMEOUT'
  | 'E_AI_AUTH'
  | 'E_AI_RATE_LIMIT'
  | 'E_AI_MODEL_MISSING'
  | 'E_AI_EMPTY';

/**
 * 供应商统一错误。
 * - message：永远是对外的、安全的文案，绝不含有 apiKey 或原始 body 全文；
 * - 敏感细节（状态码、截断后的 body）只进服务端日志，且经过 maskSecret 脱敏。
 */
export class AIProviderError extends Error {
  public readonly code: AIErrorCode;
  public readonly retryable: boolean;
  public readonly status?: number;

  constructor(
    message: string,
    code: AIErrorCode,
    retryable: boolean,
    status?: number,
  ) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** 流式 / 一次性生成的可选参数（温度提示、模型、超时、中断信号等） */
export interface AIStreamOptions {
  model?: string;
  signal?: AbortSignal;
  temperatureHint?: 'precise' | 'balanced' | 'creative';
  jsonMode?: boolean;
  label?: string;
}

/**
 * AI 供应商契约。
 * - streamChat：流式产出增量 delta，结束时通过 return 值回传完整文本（便于门面兜底）；
 * - complete：一次性返回完整文本（情绪 / 记忆 / 主动消息等后处理用）。
 */
export interface AIProvider {
  streamChat(
    messages: ChatMessage[],
    opts: AIStreamOptions,
  ): AsyncGenerator<{ delta: string }, { text: string }, void>;
  complete(messages: ChatMessage[], opts: AIStreamOptions): Promise<string>;
}
