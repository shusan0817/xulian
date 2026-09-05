/**
 * 服务端错误定义与 Express 错误处理
 *
 * 约定：
 * - 业务代码只 throw ApiError，HTTP 状态码与错误码的映射集中在本文件；
 * - 未知异常统一转成 E_INTERNAL，**不把堆栈回给前端**，但完整写进日志；
 * - 路由一律用 asyncHandler 包裹，避免 async 抛错变成未捕获 Promise。
 */

import type { NextFunction, Request, Response } from 'express';
import {
  ErrorCode,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
  type ErrorCodeValue,
} from '../shared/errors.js';
import { logger } from './logger.js';

/**
 * 业务异常。
 * code 用 shared/errors.ts 里的 ErrorCode，保证前后端一致。
 */
export class ApiError extends Error {
  public readonly code: ErrorCodeValue | string;
  public readonly httpStatus: number;
  public readonly details: unknown;
  /** 前端是否值得显示「重试」按钮 */
  public readonly retryable: boolean;

  constructor(
    code: ErrorCodeValue | string,
    message?: string,
    options: { httpStatus?: number; details?: unknown; retryable?: boolean } = {},
  ) {
    // 没传 message 时回落 ERROR_MESSAGES，别把裸错误码（如 E_EMAIL_TAKEN）显示给用户
    super(
      message ??
        (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
          ? ERROR_MESSAGES[code as ErrorCodeValue]
          : code),
    );
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus =
      options.httpStatus ??
      ERROR_HTTP_STATUS[code as ErrorCodeValue] ??
      500;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  // ---- 常用工厂方法 ----

  static badRequest(message = '請求有誤', details?: unknown): ApiError {
    return new ApiError(ErrorCode.BAD_REQUEST, message, { details });
  }

  static validation(message = '欄位驗證失敗', details?: unknown): ApiError {
    return new ApiError(ErrorCode.VALIDATION, message, { details });
  }

  static notFound(message = '找不到資源'): ApiError {
    return new ApiError(ErrorCode.NOT_FOUND, message);
  }

  static forbidden(message = '這不是你的資料'): ApiError {
    return new ApiError(ErrorCode.FORBIDDEN, message);
  }

  static userNotFound(message = '找不到這個使用者'): ApiError {
    return new ApiError(ErrorCode.USER_NOT_FOUND, message);
  }

  static dbError(message = '資料庫操作失敗', details?: unknown): ApiError {
    return new ApiError(ErrorCode.DB_ERROR, message, { details });
  }
}

/** 把任意异常归一化成 ApiError（未知异常 → E_INTERNAL，并记录完整日志） */
export function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  logger.error('[Error] 未預期的例外', { err });
  return new ApiError(ErrorCode.INTERNAL, '伺服器出了點狀況', { details: { message } });
}

/**
 * Express 错误处理中间件。
 * 必须注册在所有路由之后，否则拿不到路由里 throw 出来的错误。
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiError = normalizeError(err);
  if (res.headersSent) {
    // 流式响应已经开始（例如 SSE 中途出错），此时只能结束连接
    res.end();
    return;
  }
  res.status(apiError.httpStatus).json({
    ok: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
    },
  });
}

/**
 * 包裹 async 路由处理器，把 reject 转交 next(err)。
 * Express 4 不认识 async handler 的 reject，漏了这层会让进程挂掉。
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): (req: Req, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
