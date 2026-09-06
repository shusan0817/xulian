/**
 * message_feedback 数据访问（V2-14「用户举报与内容反馈」）
 *
 * 所有函数首参为 userId。
 *
 * ⚠️ 本表 `message_id` **故意不加外键**：消息被删后反馈仍需留存做安全分析。
 *    代价是外键级联帮不上忙——`users.repo.deleteUserData('all')` 必须
 *    **显式** `DELETE FROM message_feedback WHERE user_id = ?`，否则删不干净。
 */

import db from '../index.js';
import { newId, nowIso } from '../helpers.js';
import { FEEDBACK_KINDS, type FeedbackKind } from '../../../shared/constants.js';
import type { MessageFeedback } from '../../../shared/types.js';

// ============================================================
// 行 → 实体
// ============================================================

export interface MessageFeedbackRow {
  id: string;
  user_id: string;
  character_id: string | null;
  conversation_id: string | null;
  message_id: string;
  kind: string;
  reason: string;
  handled: number;
  handled_at: string | null;
  handled_note: string;
  created_at: string;
}

export function rowToFeedback(row: MessageFeedbackRow): MessageFeedback {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: (FEEDBACK_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as FeedbackKind)
      : 'not_interesting',
    reason: row.reason ?? '',
    handled: row.handled === 1,
    handledAt: row.handled_at,
    handledNote: row.handled_note ?? '',
    createdAt: row.created_at,
  };
}

// ============================================================
// 查询
// ============================================================

/** 我的反馈记录（倒序） */
export function list(userId: string, options: { limit?: number; kind?: FeedbackKind } = {}): MessageFeedback[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = options.kind
    ? (db
        .prepare(
          'SELECT * FROM message_feedback WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(userId, options.kind, limit) as MessageFeedbackRow[])
    : (db
        .prepare('SELECT * FROM message_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(userId, limit) as MessageFeedbackRow[]);
  return rows.map(rowToFeedback);
}

/** 按 ID 取一条（带 userId 条件） */
export function getById(userId: string, feedbackId: string): MessageFeedback | null {
  const row = db
    .prepare('SELECT * FROM message_feedback WHERE id = ? AND user_id = ?')
    .get(feedbackId, userId) as MessageFeedbackRow | undefined;
  return row ? rowToFeedback(row) : null;
}

/** 某条消息的某个反馈（用于「同一条消息同一类型只能反馈一次」的检查） */
export function getByMessage(userId: string, messageId: string, kind: FeedbackKind): MessageFeedback | null {
  const row = db
    .prepare('SELECT * FROM message_feedback WHERE user_id = ? AND message_id = ? AND kind = ?')
    .get(userId, messageId, kind) as MessageFeedbackRow | undefined;
  return row ? rowToFeedback(row) : null;
}

/** 某条消息的全部反馈 */
export function listByMessage(userId: string, messageId: string): MessageFeedback[] {
  const rows = db
    .prepare(
      'SELECT * FROM message_feedback WHERE user_id = ? AND message_id = ? ORDER BY created_at DESC',
    )
    .all(userId, messageId) as MessageFeedbackRow[];
  return rows.map(rowToFeedback);
}

/** 我的反馈统计（每种类型各几条） */
export function summary(userId: string): Record<FeedbackKind, number> {
  const rows = db
    .prepare('SELECT kind, COUNT(*) AS n FROM message_feedback WHERE user_id = ? GROUP BY kind')
    .all(userId) as Array<{ kind: string; n: number }>;
  const out = {} as Record<FeedbackKind, number>;
  for (const kind of FEEDBACK_KINDS) out[kind] = 0;
  for (const row of rows) {
    if ((FEEDBACK_KINDS as readonly string[]).includes(row.kind)) {
      out[row.kind as FeedbackKind] = row.n;
    }
  }
  return out;
}

/**
 * 待处理队列（运营/安全排查用，与具体用户无关 → admin 前缀）。
 * 举报（report）与「内容不安全」排前面。
 */
export function adminListOpen(limit = 100): MessageFeedback[] {
  const rows = db
    .prepare(
      `SELECT * FROM message_feedback
        WHERE handled = 0
        ORDER BY CASE kind WHEN 'report' THEN 0 WHEN 'unsafe' THEN 1 ELSE 2 END, created_at DESC
        LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as MessageFeedbackRow[];
  return rows.map(rowToFeedback);
}

/**
 * 统计最近一段时间内的负反馈条数（T05 的 V13 反馈疲劳否决要读它）。
 * 与具体用户无关 → admin 前缀；这里按 userId 过滤只是调用方的需要。
 */
export function adminCountRecentNegative(userId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message_feedback
        WHERE user_id = ? AND created_at >= ? AND kind IN ('not_interesting','inappropriate','unsafe','report')`,
    )
    .get(userId, sinceIso) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * 最近 N 条主动消息里，有多少条被用户给了负反馈（T05 的 V13 反馈疲劳否决要读它）。
 *
 * 与「按时间窗口计数」的区别：V13 的口径是「最近 3 条主动消息里有 2 条被嫌弃」，
 * 而不是「最近 72 小时有多少条负反馈」——前者才对应用户真实的疲劳感受。
 * 所以这里先取最近 N 条主动消息，再数其中被负反馈的条数。
 */
export function adminCountNegativeOnProactive(userId: string, characterId: string, lastN = 3): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT f.message_id) AS n
         FROM message_feedback f
         JOIN messages m ON m.id = f.message_id
        WHERE f.user_id = ?
          AND m.is_proactive = 1
          AND f.kind IN ('not_interesting','inappropriate','unsafe','report')
          AND m.id IN (
            SELECT id FROM messages
             WHERE user_id = ? AND is_proactive = 1
               AND (? = '' OR character_id = ?)
             ORDER BY created_at DESC
             LIMIT ?
          )`,
    )
    .get(userId, userId, characterId ?? '', characterId ?? '', Math.min(Math.max(lastN, 1), 20)) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

// ============================================================
// 写入
// ============================================================

export interface InsertFeedbackInput {
  messageId: string;
  kind: FeedbackKind;
  reason?: string;
  characterId?: string | null;
  conversationId?: string | null;
}

/**
 * 提交反馈。
 * `UNIQUE(user_id, message_id, kind)` 保证同一条消息同一类型只能反馈一次；
 * 重复提交视为幂等（返回既有记录），不报错。
 */
export function insert(userId: string, input: InsertFeedbackInput): MessageFeedback {
  const existing = getByMessage(userId, input.messageId, input.kind);
  if (existing) {
    // 幂等：只补充原因（用户可能先点了「不合适」，再补文字说明）
    if (input.reason && !existing.reason) {
      db.prepare('UPDATE message_feedback SET reason = ? WHERE id = ? AND user_id = ?').run(
        input.reason,
        existing.id,
        userId,
      );
      return getById(userId, existing.id) ?? existing;
    }
    return existing;
  }

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO message_feedback (id, user_id, character_id, conversation_id, message_id,
                                   kind, reason, handled, handled_at, handled_note, created_at)
     VALUES (@id, @user_id, @character_id, @conversation_id, @message_id,
             @kind, @reason, 0, NULL, '', @created_at)`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId ?? null,
    conversation_id: input.conversationId ?? null,
    message_id: input.messageId,
    kind: input.kind,
    reason: input.reason ?? '',
    created_at: now,
  });
  const created = getById(userId, id);
  if (!created) throw new Error(`[DB] 寫入回饋後讀不回來：${id}`);
  return created;
}

/** 撤销反馈（可指定类型，不指定则撤掉该消息的全部反馈） */
export function remove(userId: string, messageId: string, kind?: FeedbackKind): number {
  const result = kind
    ? db
        .prepare('DELETE FROM message_feedback WHERE user_id = ? AND message_id = ? AND kind = ?')
        .run(userId, messageId, kind)
    : db
        .prepare('DELETE FROM message_feedback WHERE user_id = ? AND message_id = ?')
        .run(userId, messageId);
  return result.changes;
}

/** 标记已处理（运营后台用） */
export function markHandled(feedbackId: string, note = ''): boolean {
  const result = db
    .prepare('UPDATE message_feedback SET handled = 1, handled_at = ?, handled_note = ? WHERE id = ?')
    .run(nowIso(), note, feedbackId);
  return result.changes > 0;
}

/** 清空某用户的全部反馈（删除账号数据时用） */
export function deleteAllForUser(userId: string): number {
  return db.prepare('DELETE FROM message_feedback WHERE user_id = ?').run(userId).changes;
}
