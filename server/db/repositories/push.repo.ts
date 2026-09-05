/**
 * push_subscriptions 数据访问（Web Push 订阅）
 *
 * 失效订阅的清理策略：Scheduler 收到 Push Service 的 404/410 时调用
 * `adminDeleteByEndpoint` 直接删除，避免反复向已失效的端点推送。
 */

import db from '../index.js';
import { newId, nowIso } from '../helpers.js';
import type { PushSubscriptionRecord } from '../../../shared/types.js';

export interface PushRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function rowToPush(row: PushRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export interface UpsertPushInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * 写入或刷新一条订阅。
 * 用 endpoint 做唯一键：同一浏览器重复订阅不会产生两条记录，
 * 同时把订阅"续期"（更新 created_at 之外的 last_used_at）。
 */
export function upsertPush(userId: string, input: UpsertPushInput): PushSubscriptionRecord {
  const now = nowIso();
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
     VALUES (@id, @user_id, @endpoint, @p256dh, @auth, @user_agent, @created_at, @last_used_at)
     ON CONFLICT (endpoint) DO UPDATE SET
        user_id      = excluded.user_id,
        p256dh       = excluded.p256dh,
        auth         = excluded.auth,
        user_agent   = excluded.user_agent,
        last_used_at = excluded.last_used_at`,
  ).run({
    id: newId(),
    user_id: userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    user_agent: input.userAgent ?? null,
    created_at: now,
    last_used_at: now,
  });

  const row = db
    .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
    .get(input.endpoint) as PushRow | undefined;
  if (!row) throw new Error(`[DB] 寫入推播訂閱後讀不回來：${input.endpoint.slice(0, 40)}`);
  return rowToPush(row);
}

/** 列出某个用户的全部订阅（一个用户可能有多台设备） */
export function listPush(userId: string): PushSubscriptionRecord[] {
  const rows = db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as PushRow[];
  return rows.map(rowToPush);
}

/** 退订指定 endpoint */
export function deletePushByEndpoint(userId: string, endpoint: string): boolean {
  const result = db
    .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .run(userId, endpoint);
  return result.changes > 0;
}

/** 退订该用户的全部设备 */
export function deleteAllPush(userId: string): number {
  const result = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  return result.changes;
}

/**
 * 删除失效订阅（Push Service 返回 404/410 时调用）。
 * 以 admin 开头：入口是 endpoint，不是 userId。
 */
export function adminDeleteByEndpoint(endpoint: string): boolean {
  const result = db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
    .run(endpoint);
  return result.changes > 0;
}

/** 发送成功后刷新 last_used_at（排障时可看出哪些订阅还活着） */
export function touchPush(endpoint: string): void {
  db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?').run(
    nowIso(),
    endpoint,
  );
}
