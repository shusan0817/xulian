/**
 * HTTP 统一响应封装 + 用户解析中间件
 *
 * 约定（架构文档 §4.0）：
 * - 成功：`{ ok: true, data: T }`
 * - 失败：`{ ok: false, error: { code, message, details? } }`
 * - 认证：MVP 用请求头 `X-User-Id`（localStorage 生成），服务端校验用户存在性。
 *   未来换成 JWT 只需替换 `resolveUser` 这一处。
 */

import type { NextFunction, Request, Response } from 'express';
import {
  ErrorCode,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
  type ErrorCodeValue,
} from '../shared/errors.js';
import { encodeSseEvent, encodeSsePing, type ChatSseEvent } from '../shared/sse.js';
import { ApiError } from './errors.js';
import { logger } from './logger.js';
import { env } from './env.js';
import * as usersRepo from './db/repositories/users.repo.js';
import * as authRepo from './db/repositories/auth.repo.js';
import { verifySession } from './services/authService.js';

// 给 Express 的 Request 挂上身份信息，后续所有路由直接用 req.userId
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /** 通过 Bearer 校验时，对应的会话 id */
      sessionId?: string | null;
      /** 本次请求是怎么认出这个人的：'session' = 令牌；'anonymous' = 匿名回落 */
      authMode?: 'session' | 'anonymous';
    }
  }
}

/** 统一成功响应 */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true as const, data });
}

/** 统一失败响应 */
export function fail(
  res: Response,
  code: ErrorCodeValue | string,
  message?: string,
  status?: number,
  details?: unknown,
): void {
  const httpStatus =
    status ??
    (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? defaultStatusFor(code as ErrorCodeValue)
      : 500);
  res.status(httpStatus).json({
    ok: false as const,
    error: {
      code,
      message:
        message ??
        (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
          ? ERROR_MESSAGES[code as ErrorCodeValue]
          : '發生未知錯誤'),
      details,
    },
  });
}

function defaultStatusFor(code: ErrorCodeValue): number {
  // 与 shared/errors.ts 的 ERROR_HTTP_STATUS 保持单一数据源，避免两处各维护一份映射
  return ERROR_HTTP_STATUS[code] ?? 500;
}

/** 从请求里取出 userId（X-User-Id 头优先，其次 query.userId） */
function readUserId(req: Request): string {
  const header = req.header('X-User-Id');
  if (header && header.trim()) return header.trim();
  const query = req.query['userId'];
  return typeof query === 'string' && query.trim() ? query.trim() : '';
}

/** 从请求头 / query 里读 X-User-Id（不做任何鉴权判断，只是取出来） */
export function readUserIdHeader(req: Request): string {
  return readUserId(req);
}

/** 从 Authorization 头里取 Bearer token；没有就返回空串 */
export function readBearerToken(req: Request): string {
  const header = req.header('Authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

/**
 * 用户解析中间件（V2 · T02）——这是全站鉴权的唯一入口。
 *
 * 优先级（设计文档 §9.1 场景 D）：
 *   1. `Authorization: Bearer <token>` → 走会话校验；
 *      **只要带了 Bearer，无论校验成功失败都绝不回落到 X-User-Id**，
 *      否则伪造一个坏 token 就能绕过鉴权。
 *   2. 没有 Bearer 时才考虑 `X-User-Id` 回落，且必须同时满足两条：
 *      a) `ALLOW_ANONYMOUS=1`；
 *      b) 该 userId **未注册**（user_auth 里没有记录）。
 *
 * 第 2 条的 (b) 正是 V1 最大的安全漏洞的修补点：
 * 任何人都能在 curl 里写 `X-User-Id: <别人的 id>` 冒充对方，
 * 现在只要对方注册过，匿名回落一律 401。
 */
export function resolveUser(req: Request, res: Response, next: NextFunction): void {
  const token = readBearerToken(req);

  // ---- ① Bearer 优先 ----
  if (token) {
    let verified: { userId: string; sessionId: string } | null = null;
    try {
      verified = verifySession(token);
    } catch (err) {
      logger.error('[HTTP] 會話校驗拋出例外', { err });
      fail(res, ErrorCode.INTERNAL);
      return;
    }
    if (!verified) {
      // 验签失败 / 已吊销 / 已过期 → 一律 401，绝不回落到 X-User-Id
      fail(res, ErrorCode.SESSION_EXPIRED, undefined, 401);
      return;
    }
    req.userId = verified.userId;
    req.sessionId = verified.sessionId;
    req.authMode = 'session';
    next();
    return;
  }

  // ---- ② 无 Bearer：X-User-Id 回落 ----
  const userId = readUserId(req);
  if (!userId) {
    fail(res, ErrorCode.AUTH_REQUIRED, undefined, 401);
    return;
  }

  if (!env.allowAnonymous) {
    fail(res, ErrorCode.AUTH_REQUIRED, undefined, 401);
    return;
  }

  try {
    // ★ 已注册的账号不允许匿名访问：这是修补「伪造 X-User-Id 冒充他人」的关键判断
    if (authRepo.hasPassword(userId)) {
      logger.warn('[HTTP] 匿名請求嘗試存取已註冊帳號，已拒絕', {
        userId,
        path: req.originalUrl,
        ip: req.ip,
      });
      fail(res, ErrorCode.AUTH_REQUIRED, '這個帳號已註冊，請先登入', 401);
      return;
    }
    if (!usersRepo.exists(userId)) {
      fail(res, ErrorCode.USER_NOT_FOUND, '找不到這個使用者，請重新開啟 App');
      return;
    }
  } catch (err) {
    logger.error('[HTTP] 校驗使用者失敗', { err, userId });
    fail(res, ErrorCode.DB_ERROR);
    return;
  }

  req.userId = userId;
  req.sessionId = null;
  req.authMode = 'anonymous';
  next();
}

/**
 * 可选的用户解析：没有身份也放行（/api/health、/api/config 这类公开接口）。
 *
 * 注意：它**不做鉴权**，只是「有就挂上」，
 * 因此任何需要数据隔离的路由都必须用 `resolveUser`，不能用它。
 */
export function optionalUser(req: Request, _res: Response, next: NextFunction): void {
  const token = readBearerToken(req);
  if (token) {
    const verified = verifySession(token);
    if (verified) {
      req.userId = verified.userId;
      req.sessionId = verified.sessionId;
      req.authMode = 'session';
      next();
      return;
    }
  }
  const userId = readUserId(req);
  if (userId) {
    req.userId = userId;
    req.authMode = 'anonymous';
  }
  next();
}

/** 在路由里取 userId；取不到直接抛 401（配合 asyncHandler 使用） */
export function requireUserId(req: Request): string {
  const userId = req.userId ?? readUserId(req);
  if (!userId) throw new ApiError(ErrorCode.USER_NOT_FOUND, '缺少 X-User-Id');
  return userId;
}

// ============================================================
// SSE 辅助（chatRoutes / regenerate 复用）
// ============================================================

/**
 * 打开一个 SSE 响应。
 * 关键头：
 * - `X-Accel-Buffering: no`：禁止 Nginx 之类反代缓冲，否则流式会变成一次性返回；
 * - `Cache-Control: no-transform`：禁止中间代理压缩/改写。
 */
export function initSseResponse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/** 是否已断开（写之前检查一下，避免往关闭的连接写导致报错） */
export function isSseClosed(res: Response): boolean {
  return res.writableEnded || res.destroyed;
}

/** 写一条 SSE 事件 */
export function writeSseEvent(res: Response, event: ChatSseEvent): boolean {
  if (isSseClosed(res)) return false;
  res.write(encodeSseEvent(event));
  return true;
}

/** 写一行心跳注释（每 15s 一次，防代理断连） */
export function writeSsePing(res: Response): boolean {
  if (isSseClosed(res)) return false;
  res.write(encodeSsePing());
  return true;
}

/** 正常结束 SSE */
export function endSse(res: Response): void {
  if (isSseClosed(res)) return;
  res.end();
}
