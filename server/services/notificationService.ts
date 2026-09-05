/**
 * 通知服务（需求 §12 推送 / §13 用户控制）
 *
 * MVP 用 Web Push（VAPID）+ Service Worker，原因：
 * - 无需 Firebase / APNs 账号，本地即可端到端验证；
 * - 同一套 Service Worker 在 Android Chrome 与桌面浏览器直接可用；
 * - iOS 16.4+ 需要用户先「加到主屏幕」才能订阅，这是平台限制，
 *   我们在设置页给出引导，并用 **App 内主动消息收件箱**作为保底触达。
 *
 * 抽象成接口是为了未来换 FCM/APNs 时只改这一个类。
 *
 * 失败处理：
 * - 410/404（订阅已失效）→ 直接删除该订阅，避免下次继续失败；
 * - 其他错误 → 记日志，任务层负责重试（退避 1/5/15 分钟）。
 */

import webpush from 'web-push';
import { env } from '../env.js';
import * as pushRepo from '../db/repositories/push.repo.js';
import { logger } from '../logger.js';

export interface PushPayload {
  title: string;
  body: string;
  /** 点击通知后打开的站内路径 */
  url: string;
  tag: string;
}

export interface SendResult {
  sent: number;
  failed: number;
  /** 被清理的失效订阅数 */
  pruned: number;
}

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;

  webpush.setVapidDetails(env.vapidMailto, env.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
  return true;
}

/** VAPID 是否已配置（决定前端是否显示推送开关） */
export function isPushConfigured(): boolean {
  return Boolean(env.vapidPublicKey && env.vapidPrivateKey);
}

export function getVapidPublicKey(): string {
  return env.vapidPublicKey;
}

/**
 * 向某个用户的所有订阅推送。
 * 返回成功/失败数量；不会抛错（推送失败不该影响主流程）。
 */
export async function sendToUser(userId: string, payload: PushPayload): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, pruned: 0 };

  if (!ensureConfigured()) {
    logger.debug('[Push] VAPID 未配置，跳過推送', { userId });
    return result;
  }

  const subscriptions = pushRepo.listPush(userId);
  if (!subscriptions.length) return result;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
        { TTL: 60 * 60 * 12, urgency: 'normal' },
      );
      result.sent += 1;
      pushRepo.touchPush(sub.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      result.failed += 1;

      // 410 Gone / 404 Not Found：订阅已失效（用户清了浏览器数据或卸载了 PWA）
      if (status === 410 || status === 404) {
        pushRepo.deletePushByEndpoint(userId, sub.endpoint);
        result.pruned += 1;
        logger.info('[Push] 已清理失效訂閱', { endpoint: sub.endpoint.slice(0, 40) });
      } else {
        logger.warn('[Push] 推送失敗', {
          status,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/** 测试推送（设置页「发送测试通知」按钮） */
export async function sendTest(userId: string): Promise<SendResult> {
  return sendToUser(userId, {
    title: '需戀',
    body: '這是一則測試通知。我會在合適的時候主動找你，你也可以隨時關掉。',
    url: '/',
    tag: 'xulian-test',
  });
}
