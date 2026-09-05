/**
 * users / active_days 数据访问
 *
 * 强制约定（架构文档 §3.3）：除 `admin*` 开头的全局管理函数外，
 * 所有 Repository 函数的**第一个参数必须是 userId**，保证多用户数据隔离（需求 §21）。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { deriveIsMinor, newId, nowIso } from '../helpers.js';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE, DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_PRIVACY_SETTINGS, DEFAULT_USER_SETTINGS } from '../../config/defaults.js';
import type { DeleteDataResult } from '../../types.js';
import type { AvatarSpec, NotificationSettings, PrivacySettings, User, UserSettings } from '../../../shared/types.js';

// ============================================================
// 行 → 实体
// ============================================================

export interface UserRow {
  id: string;
  display_name: string;
  avatar: string | null;
  timezone: string;
  locale: string;
  settings: string;
  notification_settings: string;
  privacy_settings: string;
  last_seen_at: string | null;
  // ---- V2 迁移加的列（可能读不到：老版本 DB 尚未迁移时给安全兜底）----
  birth_date?: string | null;
  is_minor?: number;
  plan?: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    avatar: row.avatar ? jsonGet<AvatarSpec | null>(row.avatar, null, 'users.avatar') : null,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    locale: row.locale || DEFAULT_LOCALE,
    settings: { ...DEFAULT_USER_SETTINGS, ...jsonGet<Partial<UserSettings>>(row.settings, {}, 'users.settings') },
    notificationSettings: {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...jsonGet<Partial<NotificationSettings>>(row.notification_settings, {}, 'users.notification_settings'),
    },
    privacySettings: {
      ...DEFAULT_PRIVACY_SETTINGS,
      ...jsonGet<Partial<PrivacySettings>>(row.privacy_settings, {}, 'users.privacy_settings'),
    },
    lastSeenAt: row.last_seen_at,
    // V2：列可能不存在（迁移前的老库），用 `??` 兜底而不是让字段变成 undefined
    birthDate: row.birth_date ?? null,
    isMinor: row.is_minor === 1,
    plan: row.plan && row.plan.trim() ? row.plan : 'free',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

/** 按 ID 取用户（首参 userId 就是它本身） */
export function getById(userId: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

/** 用户是否存在（resolveUser 中间件用它做校验） */
export function exists(userId: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(userId) as
    | { ok: number }
    | undefined;
  return row?.ok === 1;
}

// ============================================================
// 写入
// ============================================================

export interface CreateUserInput {
  id?: string;
  displayName?: string;
  avatar?: AvatarSpec | null;
  timezone?: string;
  locale?: string;
}

/**
 * 创建用户（Bootstrap 用）。
 * 以 admin 开头：它不作用于某个已有用户，因此不受「首参 userId」约束。
 */
export function adminCreateUser(input: CreateUserInput = {}): User {
  const now = nowIso();
  const id = input.id ?? newId();
  db.prepare(
    `INSERT INTO users (id, display_name, avatar, timezone, locale,
                        settings, notification_settings, privacy_settings,
                        last_seen_at, created_at, updated_at)
     VALUES (@id, @display_name, @avatar, @timezone, @locale,
             @settings, @notification_settings, @privacy_settings,
             @last_seen_at, @created_at, @updated_at)`,
  ).run({
    id,
    display_name: input.displayName ?? '',
    avatar: input.avatar ? JSON.stringify(input.avatar) : null,
    timezone: input.timezone ?? DEFAULT_TIMEZONE,
    locale: input.locale ?? DEFAULT_LOCALE,
    settings: JSON.stringify(DEFAULT_USER_SETTINGS),
    notification_settings: JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS),
    privacy_settings: JSON.stringify(DEFAULT_PRIVACY_SETTINGS),
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  });
  const created = getById(id);
  if (!created) throw new Error(`[DB] 建立使用者後讀不回來：${id}`);
  return created;
}

/** 更新在线心跳时间（presence heartbeat 用） */
export function updateLastSeen(userId: string, at: string = nowIso()): void {
  db.prepare('UPDATE users SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(
    at,
    nowIso(),
    userId,
  );
}

/** 扁平化合并设置：三个 JSON 列各取各的补丁 */
export function updateSettings(
  userId: string,
  patch: Partial<UserSettings & NotificationSettings & PrivacySettings>,
): User | null {
  const current = getById(userId);
  if (!current) return null;

  const settings: UserSettings = { ...current.settings };
  const notification: NotificationSettings = { ...current.notificationSettings };
  const privacy: PrivacySettings = { ...current.privacySettings };

  if (patch.theme !== undefined && patch.theme in { light: 1, dark: 1, system: 1 }) {
    settings.theme = patch.theme;
  }
  if (patch.showAiDisclosure !== undefined) settings.showAiDisclosure = Boolean(patch.showAiDisclosure);
  if (patch.debugOverlay !== undefined) settings.debugOverlay = Boolean(patch.debugOverlay);
  if (patch.pushEnabled !== undefined) notification.pushEnabled = Boolean(patch.pushEnabled);
  if (patch.soundEnabled !== undefined) notification.soundEnabled = Boolean(patch.soundEnabled);
  if (patch.longTermMemoryEnabled !== undefined) {
    privacy.longTermMemoryEnabled = Boolean(patch.longTermMemoryEnabled);
  }
  if (patch.saveChatHistory !== undefined) privacy.saveChatHistory = Boolean(patch.saveChatHistory);
  if (patch.analyticsEnabled !== undefined) privacy.analyticsEnabled = Boolean(patch.analyticsEnabled);

  db.prepare(
    `UPDATE users SET settings = ?, notification_settings = ?, privacy_settings = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(settings),
    JSON.stringify(notification),
    JSON.stringify(privacy),
    nowIso(),
    userId,
  );
  return getById(userId);
}

// ============================================================
// V2：账号资料（出生日期 / 昵称）
// ============================================================

/** 更新昵称（注册时补填） */
export function updateDisplayName(userId: string, displayName: string): User | null {
  if (!getById(userId)) return null;
  db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(
    displayName,
    nowIso(),
    userId,
  );
  return getById(userId);
}

/**
 * 更新出生日期，并同步派生列 `is_minor`。
 *
 * 派生放在这里而不是 service 里，是为了保证「不管谁写 birth_date，is_minor 都不会跑偏」。
 * 传 null 表示清除（用户不想填了），此时 is_minor 归 0。
 */
export function updateBirthDate(userId: string, birthDate: string | null): User | null {
  if (!getById(userId)) return null;
  const isMinor = deriveIsMinor(birthDate) ? 1 : 0;
  db.prepare(
    'UPDATE users SET birth_date = ?, is_minor = ?, age_verified_at = ?, updated_at = ? WHERE id = ?',
  ).run(
    birthDate && birthDate.trim() ? birthDate.trim() : null,
    isMinor,
    nowIso(),
    nowIso(),
    userId,
  );
  return getById(userId);
}

// ============================================================
// 活跃天（只增不减，供关系成长使用）
// ============================================================

/** 记下一天活跃；同一天重复调用返回 false（幂等） */
export function addActiveDay(userId: string, characterId: string, day: string): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO active_days (user_id, character_id, day) VALUES (?, ?, ?)`,
    )
    .run(userId, characterId, day);
  return result.changes > 0;
}

/** 统计累计活跃天数 */
export function countActiveDays(userId: string, characterId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM active_days WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 列出全部活跃天（数据导出用，按天升序） */
export function listActiveDays(userId: string, characterId: string): string[] {
  const rows = db
    .prepare(
      'SELECT day FROM active_days WHERE user_id = ? AND character_id = ? ORDER BY day ASC',
    )
    .all(userId, characterId) as Array<{ day: string }>;
  return rows.map((r) => r.day);
}

// ============================================================
// 数据删除（需求 §21：用户对自己的数据有完全控制权）
// ============================================================

/**
 * 按范围删除用户数据。
 * 全部在一个事务里完成；`all` 会连带删除用户本身（其余表靠外键级联 + 显式清理兜底）。
 */
export function deleteUserData(
  userId: string,
  scope: 'all' | 'messages' | 'memories' | 'characters',
): DeleteDataResult {
  const result: DeleteDataResult = {
    deleted: { messages: 0, memories: 0, conversations: 0, characters: 0, tasks: 0 },
  };

  const run = db.transaction(() => {
    if (scope === 'all' || scope === 'messages' || scope === 'characters') {
      // messages / conversations / 任务 / 情绪分析都绑在会话或角色上，先清这些
      result.deleted.messages += db
        .prepare('DELETE FROM messages WHERE user_id = ?')
        .run(userId).changes;
      result.deleted.conversations += db
        .prepare('DELETE FROM conversations WHERE user_id = ?')
        .run(userId).changes;
      result.deleted.tasks += db
        .prepare('DELETE FROM proactive_message_tasks WHERE user_id = ?')
        .run(userId).changes;
      db.prepare('DELETE FROM user_emotion_analyses WHERE user_id = ?').run(userId);
    }

    if (scope === 'all' || scope === 'memories' || scope === 'characters') {
      result.deleted.memories += db
        .prepare('DELETE FROM memories WHERE user_id = ?')
        .run(userId).changes;
    }

    if (scope === 'all' || scope === 'characters') {
      // 角色删除会级联掉 emotion_states / relationship_states / 任务
      db.prepare('DELETE FROM active_days WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM emotion_states WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM relationship_states WHERE user_id = ?').run(userId);
      result.deleted.characters += db
        .prepare('DELETE FROM ai_characters WHERE user_id = ?')
        .run(userId).changes;
    }

    if (scope === 'all') {
      // safety_logs 与 push_subscriptions 的 user_id 没有外键级联，这里显式清
      db.prepare('DELETE FROM safety_logs WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM proactive_daily_counters WHERE user_id = ?').run(userId);

      // ---- V2 新增表：外键能级联的一律显式再清一次（双保险），
      //      其中 message_feedback 是**必须**显式的：它的 message_id 故意无外键，
      //      删消息不会带走反馈，删用户虽然 user_id 有级联，但显式清理能让
      //      「删完以后这几张表必须为 0 行」这条断言在任何外键配置下都成立。
      db.prepare('DELETE FROM message_feedback WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_auth WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM stories WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_insights WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM ai_habits WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM emotion_trend_snapshots WHERE user_id = ?').run(userId);

      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
  });

  run();
  return result;
}

/** 全量删除某个用户（管理用途，首参仍是 userId） */
export function adminDeleteUser(userId: string): DeleteDataResult {
  return deleteUserData(userId, 'all');
}
