/**
 * AI 调用错误契约
 *
 * 目的：把供应商抛出的 AIProviderError 统一收敛成 `SdkCallError`，
 * 并保留 `UserAbortError`（用户主动中断，不算错误，已生成内容照常落库）。
 *
 * 注：本项目已切换为自建 Ollama 运行时，不再依赖任何第三方 Agent SDK。
 */

import { ErrorCode, type ErrorCodeValue } from '../../shared/errors.js';

export class SdkCallError extends Error {
  public readonly code: ErrorCodeValue | string;
  public readonly retryable: boolean;
  /** 错误分类（provider 的 AIErrorCode 或 unknown），用于日志排障 */
  public readonly subtype: string;
  public readonly details: unknown;

  constructor(
    message: string,
    options: {
      code?: ErrorCodeValue | string;
      retryable?: boolean;
      subtype?: string;
      details?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'SdkCallError';
    this.code = options.code ?? ErrorCode.AI_UNAVAILABLE;
    this.retryable = options.retryable ?? false;
    this.subtype = options.subtype ?? 'unknown';
    this.details = options.details;
  }
}

/** 用户主动中断（点「停止」）：不算错误，已生成内容照常落库 */
export class UserAbortError extends Error {
  constructor(message = '使用者中斷了這次的回覆') {
    super(message);
    this.name = 'UserAbortError';
  }
}

export { ErrorCode };
