/**
 * 推送与在线状态路由（需求 §11–§13）
 *
 * 两条互相独立的触达通道：
 * 1. **Web Push**（需要 VAPID + 用户授权 + Service Worker）
 * 2. **App 内收件箱**（永远可用）
 *
 * iOS 16.4+ 的限制：必须先「加到主屏幕」才能订阅 Web Push。
 * 所以推送失败绝不能让主动聊天功能整体失效——
 * 消息照样入库，用户打开 App 时在收件箱看到。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as pushRepo from '../db/repositories/push.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import { getVapidPublicKey, isPushConfigured, sendTest } from '../services/notificationService.js';
import { logger } from '../logger.js';

export const pushRoutes = Router();

pushRoutes.use(resolveUser);

/** VAPID 公钥：前端用它生成订阅 */
pushRoutes.get(
  '/vapid-public-key',
  asyncHandler((_req, res) => {
    ok(res, {
      publicKey: getVapidPublicKey(),
      enabled: isPushConfigured(),
    });
  }),
);

/** 保存订阅（同一 endpoint 幂等更新） */
pushRoutes.post(
  '/subscribe',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    const keys = (body.keys ?? {}) as Record<string, unknown>;
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
    const auth = typeof keys.auth === 'string' ? keys.auth : '';

    if (!endpoint || !p256dh || !auth) {
      throw new ApiError(ErrorCode.BAD_REQUEST, '訂閱資料不完整');
    }

    const record = pushRepo.upsertPush(userId, {
      endpoint,
      p256dh,
      auth,
      userAgent: typeof body.userAgent === 'string' ? body.userAgent : null,
    });

    logger.info('[Push] 已訂閱', { userId, endpoint: endpoint.slice(0, 40) });
    ok(res, { success: true, id: record.id });
  }),
);

/** 取消订阅 */
pushRoutes.delete(
  '/unsubscribe',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : undefined;

    const count = endpoint
      ? Number(pushRepo.deletePushByEndpoint(userId, endpoint))
      : pushRepo.deleteAllPush(userId);

    ok(res, { success: true, count });
  }),
);

/** 发送一条测试通知（设置页按钮） */
pushRoutes.post(
  '/test',
  asyncHandler(async (req, res) => {
    const userId = requireUserId(req);
    const result = await sendTest(userId);
    if (result.sent === 0) {
      throw new ApiError(ErrorCode.PUSH_FAILED, '沒有可用的推播通道，請先開啟通知權限');
    }
    ok(res, { success: true, ...result });
  }),
);

/** 当前订阅状态 */
pushRoutes.get(
  '/status',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const subscriptions = pushRepo.listPush(userId);
    const user = usersRepo.getById(userId);
    ok(res, {
      configured: isPushConfigured(),
      subscribed: subscriptions.length > 0,
      count: subscriptions.length,
      pushEnabled: user?.notificationSettings.pushEnabled ?? false,
    });
  }),
);

// ============================================================
// 在线状态（影响主动聊天的 V7 否决项）
// ============================================================

/**
 * 心跳：App 在前台时每 60 秒上报一次。
 * 主动聊天决策用「最近一次心跳时间」判断用户是否在线——
 * 用户正在 App 里时不推送，这是最基本的礼貌。
 */
pushRoutes.post(
  '/heartbeat',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    usersRepo.updateLastSeen(userId);
    ok(res, { success: true, at: new Date().toISOString() });
  }),
);
