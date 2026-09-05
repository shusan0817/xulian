/**
 * emotion_trend_snapshots 数据访问（V2-7「情绪变化趋势」）
 *
 * 所有函数首参为 userId。
 *
 * ⛔ 硬约束（V2-7）：本表只存**原始聚合值**，不存任何「分数」「指数」「诊断结论」。
 *    定性描述由 T09 的 `emotionTrendService.describe()`（纯函数）在读时派生，
 *    前端任何位置都不得出现百分比或 0–100 分数。
 */

import db from '../index.js';
import { newId, nowIso } from '../helpers.js';
import type { TrendSnapshot } from '../../../shared/types.js';

// ============================================================
// 行 → 实体
// ============================================================

export interface TrendSnapshotRow {
  id: string;
  user_id: string;
  character_id: string;
  day: string;
  message_count: number;
  session_count: number;
  avg_user_msg_chars: number;
  avg_valence: number;
  avg_intensity: number;
  negative_ratio: number;
  dominant_emotion: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToSnapshot(row: TrendSnapshotRow): TrendSnapshot {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    day: row.day,
    messageCount: row.message_count,
    sessionCount: row.session_count,
    avgUserMsgChars: row.avg_user_msg_chars,
    avgValence: row.avg_valence,
    avgIntensity: row.avg_intensity,
    negativeRatio: row.negative_ratio,
    dominantEmotion: row.dominant_emotion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

/** 取某一天的快照 */
export function getByDay(userId: string, characterId: string, day: string): TrendSnapshot | null {
  const row = db
    .prepare(
      'SELECT * FROM emotion_trend_snapshots WHERE user_id = ? AND character_id = ? AND day = ?',
    )
    .get(userId, characterId, day) as TrendSnapshotRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

/** 取最近 N 天的快照（按天升序，方便画图与做差值） */
export function listRecent(
  userId: string,
  characterId: string,
  days = 14,
  endDate?: string,
): TrendSnapshot[] {
  const end = endDate ?? nowIso().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT * FROM emotion_trend_snapshots
        WHERE user_id = ? AND character_id = ? AND day <= ?
        ORDER BY day DESC LIMIT ?`,
    )
    .all(userId, characterId, end, Math.min(Math.max(days, 1), 180)) as TrendSnapshotRow[];
  // 数据库里是倒序取的，画图要正序
  return rows.map(rowToSnapshot).reverse();
}

/** 统计已有多少天有数据（判断「数据是否足够」用） */
export function countDays(userId: string, characterId: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM emotion_trend_snapshots WHERE user_id = ? AND character_id = ?',
    )
    .get(userId, characterId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ============================================================
// 写入
// ============================================================

export interface UpsertSnapshotInput {
  characterId: string;
  day: string;
  /** 当天新增的用户消息条数（累加） */
  addMessageCount?: number;
  /** 当天新增的会话轮次（累加） */
  addSessionCount?: number;
  /** 当天用户消息平均字数（覆盖） */
  avgUserMsgChars?: number;
  /** 当天平均 valence（覆盖） */
  avgValence?: number;
  avgIntensity?: number;
  negativeRatio?: number;
  dominantEmotion?: string | null;
}

/**
 * 按天幂等聚合。
 *
 * 计数类字段做**累加**（同一天内每聊一轮就 +1），
 * 平均类字段做**覆盖**（由 service 用当天全部样本重算，避免「平均数再平均」）。
 */
export function upsertSnapshot(userId: string, input: UpsertSnapshotInput): TrendSnapshot {
  const now = nowIso();
  const existing = getByDay(userId, input.characterId, input.day);
  const id = existing?.id ?? newId();

  db.prepare(
    `INSERT INTO emotion_trend_snapshots (id, user_id, character_id, day, message_count,
                                          session_count, avg_user_msg_chars, avg_valence,
                                          avg_intensity, negative_ratio, dominant_emotion,
                                          created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @day, @message_count,
             @session_count, @avg_user_msg_chars, @avg_valence,
             @avg_intensity, @negative_ratio, @dominant_emotion,
             @created_at, @updated_at)
     ON CONFLICT (user_id, character_id, day) DO UPDATE SET
        message_count = emotion_trend_snapshots.message_count + excluded.message_count,
        session_count = emotion_trend_snapshots.session_count + excluded.session_count,
        avg_user_msg_chars = excluded.avg_user_msg_chars,
        avg_valence = excluded.avg_valence,
        avg_intensity = excluded.avg_intensity,
        negative_ratio = excluded.negative_ratio,
        dominant_emotion = COALESCE(excluded.dominant_emotion, emotion_trend_snapshots.dominant_emotion),
        updated_at = excluded.updated_at`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId,
    day: input.day,
    message_count: input.addMessageCount ?? 0,
    session_count: input.addSessionCount ?? 0,
    avg_user_msg_chars: input.avgUserMsgChars ?? existing?.avgUserMsgChars ?? 0,
    avg_valence: input.avgValence ?? existing?.avgValence ?? 0,
    avg_intensity: input.avgIntensity ?? existing?.avgIntensity ?? 0,
    negative_ratio: input.negativeRatio ?? existing?.negativeRatio ?? 0,
    dominant_emotion: input.dominantEmotion ?? existing?.dominantEmotion ?? null,
    created_at: existing?.createdAt ?? now,
    updated_at: now,
  });

  const saved = getByDay(userId, input.characterId, input.day);
  if (!saved) throw new Error(`[DB] 寫入趨勢快照後讀不回來：${input.day}`);
  return saved;
}

/** 清空某用户的全部快照（删除账号数据时用） */
export function deleteAllForUser(userId: string): number {
  return db
    .prepare('DELETE FROM emotion_trend_snapshots WHERE user_id = ?')
    .run(userId).changes;
}

/** 清理过老的快照（数据保留期限，V2-15；与具体用户无关 → admin 前缀） */
export function adminDeleteBefore(beforeDay: string): number {
  return db
    .prepare('DELETE FROM emotion_trend_snapshots WHERE day < ?')
    .run(beforeDay).changes;
}
