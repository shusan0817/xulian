/**
 * unfinished_topics 数据访问（P0「未完待续」）
 *
 * 所有函数首参为 userId。
 *
 * 设计要点：
 * - 只保留「open」的未完话题，resolved/archived 视为关闭（listOpen 默认过滤）；
 * - 同一角色最多保留少量 open 话题，超出则把最旧的归档（archiveOverflow），避免堆积；
 * - 软状态机：open → resolved（用户回来聊了）/ archived（被新话题挤掉）。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { newId, nowIso } from '../helpers.js';

export interface UnfinishedTopicRow {
  id: string;
  user_id: string;
  character_id: string;
  topic: string;
  resume_hint: string;
  source_message_ids: string;
  status: string;
  last_touched_at: string;
  created_at: string;
  updated_at: string;
}

export interface UnfinishedTopic {
  id: string;
  userId: string;
  characterId: string;
  topic: string;
  resumeHint: string;
  sourceMessageIds: string[];
  status: 'open' | 'resolved' | 'archived';
  lastTouchedAt: string;
  createdAt: string;
  updatedAt: string;
}

export function rowToUnfinished(row: UnfinishedTopicRow): UnfinishedTopic {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    topic: row.topic,
    resumeHint: row.resume_hint,
    sourceMessageIds: jsonGet<string[]>(row.source_message_ids, [], 'unfinished_topics.source_message_ids'),
    status: (row.status as UnfinishedTopic['status']) ?? 'open',
    lastTouchedAt: row.last_touched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 列出某用户/角色下仍 open 的未完话题（按最近触及倒序） */
export function listOpen(
  userId: string,
  characterId?: string,
  limit = 6,
): UnfinishedTopic[] {
  const where: string[] = ['user_id = ?', 'status = ?'];
  const params: Array<string> = [userId, 'open'];
  if (characterId) {
    where.push('character_id = ?');
    params.push(characterId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM unfinished_topics WHERE ${where.join(' AND ')}
        ORDER BY last_touched_at DESC LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(limit, 1), 30)) as UnfinishedTopicRow[];
  return rows.map(rowToUnfinished);
}

export function getById(userId: string, id: string): UnfinishedTopic | null {
  const row = db
    .prepare('SELECT * FROM unfinished_topics WHERE id = ? AND user_id = ?')
    .get(id, userId) as UnfinishedTopicRow | undefined;
  return row ? rowToUnfinished(row) : null;
}

export interface InsertUnfinishedInput {
  characterId: string;
  topic: string;
  resumeHint?: string;
  sourceMessageIds?: string[];
}

export function insert(userId: string, input: InsertUnfinishedInput): UnfinishedTopic {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO unfinished_topics
        (id, user_id, character_id, topic, resume_hint, source_message_ids, status, last_touched_at, created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @topic, @resume_hint, @source_message_ids, 'open', @last, @created_at, @updated_at)`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId,
    topic: input.topic.slice(0, 60),
    resume_hint: (input.resumeHint ?? '').slice(0, 200),
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    last: now,
    created_at: now,
    updated_at: now,
  });
  const created = getById(userId, id);
  if (!created) throw new Error(`[DB] 寫入未完話題後讀不回來：${id}`);
  return created;
}

/** 更新话题内容与最近触及时间（去重命中时复用） */
export function touch(userId: string, id: string, resumeHint?: string): UnfinishedTopic | null {
  const current = getById(userId, id);
  if (!current) return null;
  const now = nowIso();
  db.prepare(
    `UPDATE unfinished_topics SET resume_hint = ?, last_touched_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(resumeHint?.slice(0, 200) ?? current.resumeHint, now, now, id, userId);
  return getById(userId, id);
}

export function resolve(userId: string, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE unfinished_topics SET status = 'resolved', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'`,
    )
    .run(nowIso(), id, userId);
  return result.changes > 0;
}

export function softDelete(userId: string, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE unfinished_topics SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?`,
    )
    .run(nowIso(), id, userId);
  return result.changes > 0;
}

/** 归档超出上限的最旧 open 话题（保留最近的 keep 条） */
export function archiveOverflow(userId: string, characterId: string, keep = 6): number {
  const open = listOpen(userId, characterId, 100);
  if (open.length <= keep) return 0;
  const toArchive = open.slice(keep);
  const now = nowIso();
  const stmt = db.prepare(
    `UPDATE unfinished_topics SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?`,
  );
  for (const t of toArchive) stmt.run(now, t.id, userId);
  return toArchive.length;
}

export function countOpen(userId: string, characterId?: string): number {
  const row = characterId
    ? (db
        .prepare(
          'SELECT COUNT(*) AS n FROM unfinished_topics WHERE user_id = ? AND character_id = ? AND status = ?',
        )
        .get(userId, characterId, 'open') as { n: number } | undefined)
    : (db
        .prepare('SELECT COUNT(*) AS n FROM unfinished_topics WHERE user_id = ? AND status = ?')
        .get(userId, 'open') as { n: number } | undefined);
  return row?.n ?? 0;
}
