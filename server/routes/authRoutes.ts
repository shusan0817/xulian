/**
 * 认证路由（V2 · T02）
 *
 * 公开端点（无需登录）：register / login / status
 * 需要会话的端点：me / logout / password / birth-date / sessions
 *
 * ⚠️ 需要会话的端点用 `requireSession` 而不是 `resolveUser`：
 *    `resolveUser` 在 `ALLOW_ANONYMOUS=1` 时会放行匿名请求，
 *    而这些端点操作的是账号凭据，匿名进来必须有明确拒绝。
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { fail, ok, readBearerToken, resolveUser } from '../http.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import * as authRepo from '../db/repositories/auth.repo.js';
import * as authService from '../services/authService.js';
import type {
  AccountInfoResponse,
  AuthStatusResponse,
  AuthTokenResponse,
  SessionListResponse,
} from '../types.js';

export const authRoutes = Router();

/**
 * 只允许「真会话」通过的守卫。
 * 匿名模式（ALLOW_ANONYMOUS=1）下 resolveUser 会放行匿名请求，
 * 但账号相关的操作必须先用令牌确认身份。
 */
function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (req.authMode !== 'session' || !req.userId) {
    fail(res, ErrorCode.AUTH_REQUIRED, undefined, 401);
    return;
  }
  next();
}

/** 从请求里提取客户端上下文（User-Agent / IP），会话记录用 */
function clientContext(req: Request): { userAgent: string | null; ip: string | null } {
  return {
    userAgent: req.header('User-Agent') ?? null,
    ip: req.ip ?? null,
  };
}

// ============================================================
// 公开端点
// ============================================================

/**
 * 认证能力探测（前端路由守卫用）。
 * 前端必须知道「这台服务器是否允许匿名」，
 * 否则无法决定「没登录时该跳 /login 还是直接进主页」。
 */
authRoutes.get(
  '/status',
  asyncHandler((req, res) => {
    const token = readBearerToken(req);
    const verified = token ? authService.verifySession(token) : null;
    const body: AuthStatusResponse = {
      allowAnonymous: env.allowAnonymous,
      authenticated: Boolean(verified),
      userId: verified?.userId ?? null,
    };
    ok(res, body);
  }),
);

/**
 * 注册。
 *
 * body 里的 `attachUserId` 是「老用户零迁移」的关键：
 * 带上它表示「我这个匿名账号要转正」，服务端复用同一行 users，
 * 不新建、不搬迁 —— 历史角色 / 记忆 / 会话一条不丢。
 */
authRoutes.post(
  '/register',
  asyncHandler((req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : '';
    const attachUserId =
      typeof body['attachUserId'] === 'string' && body['attachUserId'].trim()
        ? body['attachUserId'].trim()
        : undefined;
    const timezone = typeof body['timezone'] === 'string' ? body['timezone'] : undefined;
    const rawBirthDate = body['birthDate'];
    const birthDate =
      typeof rawBirthDate === 'string' && rawBirthDate.trim() ? rawBirthDate.trim() : null;

    const result = authService.register({
      email,
      password,
      displayName,
      birthDate,
      attachUserId,
      timezone,
      ...clientContext(req),
    });

    const payload: AuthTokenResponse = {
      user: result.user,
      hasPassword: result.hasPassword,
      email: result.email,
      isMinor: result.isMinor,
      token: result.token,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
    };
    ok(res, payload, 201);
  }),
);

/** 登录 */
authRoutes.post(
  '/login',
  asyncHandler((req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';

    const result = authService.login({ email, password, ...clientContext(req) });

    const payload: AuthTokenResponse = {
      user: result.user,
      hasPassword: result.hasPassword,
      email: result.email,
      isMinor: result.isMinor,
      token: result.token,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
    };
    ok(res, payload);
  }),
);

// ============================================================
// 以下端点必须有真实会话
// ============================================================

authRoutes.use(resolveUser, requireSession);

/** 当前账号信息 */
authRoutes.get(
  '/me',
  asyncHandler((req, res) => {
    const info = authService.me(req.userId as string, req.sessionId ?? null);
    const payload: AccountInfoResponse = {
      user: info.user,
      hasPassword: info.hasPassword,
      email: info.email,
      isMinor: info.isMinor,
      session: info.session,
      allowAnonymous: env.allowAnonymous,
    };
    ok(res, payload);
  }),
);

/** 登出当前会话（幂等：重复调用也返回成功） */
authRoutes.post(
  '/logout',
  asyncHandler((req, res) => {
    const userId = req.userId as string;
    const token = readBearerToken(req);
    if (token) authService.revokeSessionByToken(token);
    // 兜底：token 解析不到的极端情况下，按中间件已确认的 sessionId 再吊销一次
    if (req.sessionId) authRepo.revokeSession(userId, req.sessionId);
    logger.info('[Auth] 登出', { userId, sessionId: req.sessionId });
    ok(res, { success: true });
  }),
);

/**
 * 修改密码。
 * 成功后会吊销**其它所有会话**（当前这台保留），
 * 所以「改密码后其他设备立即掉线」是服务端保证的。
 */
authRoutes.patch(
  '/password',
  asyncHandler((req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const oldPassword = typeof body['oldPassword'] === 'string' ? body['oldPassword'] : '';
    const newPassword = typeof body['newPassword'] === 'string' ? body['newPassword'] : '';

    const result = authService.changePassword(
      req.userId as string,
      oldPassword,
      newPassword,
      req.sessionId ?? null,
    );
    ok(res, result);
  }),
);

/**
 * 更新出生日期（选填）。
 * 填了且未满 18 岁 → `isMinor=1`，启用未成年强化保护；
 * 不填或成年 → 只保留对所有用户无条件生效的通用安全条款。
 */
authRoutes.patch(
  '/birth-date',
  asyncHandler((req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body['birthDate'];
    const birthDate = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

    const info = authService.updateBirthDate(req.userId as string, birthDate);
    ok(res, { user: info.user, isMinor: info.isMinor });
  }),
);

/** 会话列表（账号页展示「目前登录了哪些设备」） */
authRoutes.get(
  '/sessions',
  asyncHandler((req, res) => {
    const sessions = authService.listMySessions(req.userId as string);
    const payload: SessionListResponse = {
      items: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ipPrefix: s.ipPrefix,
        issuedAt: s.issuedAt,
        expiresAt: s.expiresAt,
        lastUsedAt: s.lastUsedAt,
        current: s.id === req.sessionId,
      })),
    };
    ok(res, payload);
  }),
);

/** 踢掉指定会话（「登出其他设备」） */
authRoutes.delete(
  '/sessions/:id',
  asyncHandler((req, res) => {
    const sessionId = String(req.params['id'] ?? '');
    if (!sessionId) throw new ApiError(ErrorCode.VALIDATION, '缺少 session id');
    const okRemoved = authService.revokeMySession(req.userId as string, sessionId);
    if (!okRemoved) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個會話');
    ok(res, { success: true });
  }),
);
