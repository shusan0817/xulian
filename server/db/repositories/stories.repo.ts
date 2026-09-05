/**
 * stories 数据访问（V2-2「我们的故事」）
 *
 * 所有函数首参为 userId。
 *
 * 硬约束（需求 V2-2）：
 * - 用户可**查看 / 修改 / 删除**每一条；
 * - 故事必须**可追溯来源**（`source_message_ids` 非空才允许落库，由 storyService 校验）；
 * - AI 不得私自永久保存敏感信息（同样由 storyService 的 containsSensitive 把关）。
 *
 * 软删除：`deleted_at` 置位即视为删除，所有 list 默认过滤 `deleted_at IS NULL`。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { clamp01, newId, nowIso } from '../helpers.js';
import { STORY_TYPES, type StorySource, type StoryType } from '../../../shared/constants.js';
import type { Story } from '../../../shared/types.js';

// ============================================================
// 行 → 实体
// ============================================================

export interface StoryRow {
  id: string;
  user_id: string;
  character_id: string;
  type: string;
  title: string;
  summary: string;
  auto_title: string;
  auto_summary: string;
  is_user_edited: number;
  is_user_created: number;
  importance: number;
  source_type: string;
  source_message_ids: string;
  source_memory_id: string | null;
  source_habit_id: string | null;
  happened_at: string;
  pinned: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToStory(row: StoryRow): Story {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    // 脏数据兜底：未知类型一律当 user_saved，保证前端永远能渲染
    type: (STORY_TYPES as readonly string[]).includes(row.type)
      ? (row.type as StoryType)
      : 'user_saved',
    title: row.title,
    summary: row.summary,
    autoTitle: row.auto_title,
    autoSummary: row.auto_summary,
    isUserEdited: row.is_user_edited === 1,
    isUserCreated: row.is_user_created === 1,
    importance: clamp01(row.importance),
    source: (row.source_type || 'auto') as StorySource,
    sourceMessageIds: jsonGet<string[]>(row.source_message_ids, [], 'stories.source_message_ids'),
    sourceMemoryId: row.source_memory_id,
    sourceHabitId: row.source_habit_id,
    happenedAt: row.happened_at,
    pinned: row.pinned === 1,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

export interface ListStoriesOptions {
  characterId?: string;
  type?: StoryType;
  /** 是否包含软删除的（默认 false） */
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface StoryListResult {
  items: Story[];
  total: number;
}

/** 故事列表：置顶优先，其次重要度，再按发生时间倒序 */
export function list(userId: string, options: ListStoriesOptions = {}): StoryListResult {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const where: string[] = ['user_id = ?'];
  const params: Array<string | number> = [userId];
  if (options.characterId) {
    where.push('character_id = ?');
    params.push(options.characterId);
  }
  if (options.type) {
    where.push('type = ?');
    params.push(options.type);
  }
  if (!options.includeDeleted) where.push('deleted_at IS NULL');

  const whereSql = where.join(' AND ');
  const rows = db
    .prepare(
      `SELECT * FROM stories WHERE ${whereSql}
        ORDER BY pinned DESC, importance DESC, happened_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as StoryRow[];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM stories WHERE ${whereSql}`)
    .get(...params) as { n: number } | undefined;

  return { items: rows.map(rowToStory), total: totalRow?.n ?? 0 };
}

/** 按 ID 取一条（带 userId 条件，天然隔离） */
export function getById(userId: string, storyId: string): Story | null {
  const row = db
    .prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?')
    .get(storyId, userId) as StoryRow | undefined;
  return row ? rowToStory(row) : null;
}

/** 取最近的活跃故事（注入 Prompt / 空间页预览用） */
export function listRecent(
  userId: string,
  characterId: string,
  limit = 3,
): Story[] {
  const rows = db
    .prepare(
      `SELECT * FROM stories
        WHERE user_id = ? AND character_id = ? AND deleted_at IS NULL
        ORDER BY pinned DESC, importance DESC, happened_at DESC LIMIT ?`,
    )
    .all(userId, characterId, Math.min(Math.max(limit, 1), 30)) as StoryRow[];
  return rows.map(rowToStory);
}

/** 统计活跃故事条数（配额控制用） */
export function countActive(userId: string, characterId?: string): number {
  const row = characterId
    ? (db
        .prepare(
          'SELECT COUNT(*) AS n FROM stories WHERE user_id = ? AND character_id = ? AND deleted_at IS NULL',
        )
        .get(userId, characterId) as { n: number } | undefined)
    : (db
        .prepare('SELECT COUNT(*) AS n FROM stories WHERE user_id = ? AND deleted_at IS NULL')
        .get(userId) as { n: number } | undefined);
  return row?.n ?? 0;
}

/** 该角色是否已有「第一次聊天」故事（first_chat 只允许一条） */
export function hasFirstChat(userId: string, characterId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM stories
        WHERE user_id = ? AND character_id = ? AND type = 'first_chat' AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(userId, characterId) as { ok: number } | undefined;
  return row?.ok === 1;
}

// ============================================================
// 写入
// ============================================================

export interface InsertStoryInput {
  characterId: string;
  type: StoryType;
  title: string;
  summary: string;
  /** 自动生成版本；不传则与 title/summary 相同（用户创建时） */
  autoTitle?: string;
  autoSummary?: string;
  isUserCreated?: boolean;
  importance?: number;
  source?: StorySource;
  sourceMessageIds?: string[];
  sourceMemoryId?: string | null;
  sourceHabitId?: string | null;
  happenedAt?: string;
  pinned?: boolean;
}

/** 新增故事 */
export function insert(userId: string, input: InsertStoryInput): Story {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO stories (id, user_id, character_id, type, title, summary,
                          auto_title, auto_summary, is_user_edited, is_user_created,
                          importance, source_type, source_message_ids, source_memory_id,
                          source_habit_id, happened_at, pinned, deleted_at,
                          created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @type, @title, @summary,
             @auto_title, @auto_summary, @is_user_edited, @is_user_created,
             @importance, @source_type, @source_message_ids, @source_memory_id,
             @source_habit_id, @happened_at, @pinned, NULL,
             @created_at, @updated_at)`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId,
    type: input.type,
    title: input.title,
    summary: input.summary,
    auto_title: input.autoTitle ?? input.title,
    auto_summary: input.autoSummary ?? input.summary,
    // 用户手动创建的、或标题/摘要与自动版不同的，都算「用户编辑过」
    is_user_edited: input.isUserCreated ? 1 : 0,
    is_user_created: input.isUserCreated ? 1 : 0,
    importance: clamp01(input.importance ?? 0.5),
    source_type: input.source ?? 'auto',
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    source_memory_id: input.sourceMemoryId ?? null,
    source_habit_id: input.sourceHabitId ?? null,
    happened_at: input.happenedAt ?? now,
    pinned: input.pinned ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  const created = getById(userId, id);
  if (!created) throw new Error(`[DB] 寫入故事後讀不回來：${id}`);
  return created;
}

export interface UpdateStoryPatch {
  title?: string;
  summary?: string;
  importance?: number;
  pinned?: boolean;
  happenedAt?: string;
}

/**
 * 用户修改故事 → 置 `is_user_edited = 1`。
 * 只改展示用的 title/summary，**不动 auto_* 原文**，所以随时可以还原。
 */
export function update(userId: string, storyId: string, patch: UpdateStoryPatch): Story | null {
  const current = getById(userId, storyId);
  if (!current) return null;

  const fields: string[] = [];
  const values: Array<string | number> = [];
  const push = (column: string, value: string | number): void => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) push('title', patch.title);
  if (patch.summary !== undefined) push('summary', patch.summary);
  if (patch.importance !== undefined) push('importance', clamp01(patch.importance));
  if (patch.pinned !== undefined) push('pinned', patch.pinned ? 1 : 0);
  if (patch.happenedAt !== undefined) push('happened_at', patch.happenedAt);

  if (fields.length === 0) return current;

  // 用户改过内容 → 打上编辑标记（「还原」按钮据此出现）
  if (patch.title !== undefined || patch.summary !== undefined) {
    push('is_user_edited', 1);
  }
  push('updated_at', nowIso());
  values.push(storyId, userId);

  db.prepare(`UPDATE stories SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  return getById(userId, storyId);
}

/** 软删除（保留行，便于误删恢复与云端同步） */
export function softDelete(userId: string, storyId: string): boolean {
  const result = db
    .prepare(
      'UPDATE stories SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .run(nowIso(), nowIso(), storyId, userId);
  return result.changes > 0;
}

/** 还原为自动生成版本（auto_title / auto_summary） */
export function restoreAuto(userId: string, storyId: string): Story | null {
  const current = getById(userId, storyId);
  if (!current) return null;
  if (!current.autoTitle && !current.autoSummary) {
    // 用户手动创建的故事没有自动版本，还原没有意义
    return current;
  }
  db.prepare(
    `UPDATE stories
        SET title = auto_title, summary = auto_summary, is_user_edited = 0, updated_at = ?
      WHERE id = ? AND user_id = ?`,
  ).run(nowIso(), storyId, userId);
  return getById(userId, storyId);
}

/**
 * 配额归档：活跃条数超上限时，把最不重要的（未置顶、重要度最低、最早）软删除掉。
 * @returns 被归档的条数
 */
export function archiveOverflow(userId: string, characterId: string, maxActive = 200): number {
  const overflow = countActive(userId, characterId) - maxActive;
  if (overflow <= 0) return 0;
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE stories
          SET deleted_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM stories
            WHERE user_id = ? AND character_id = ? AND deleted_at IS NULL AND pinned = 0
            ORDER BY importance ASC, happened_at ASC
            LIMIT ?
        )`,
    )
    .run(now, now, userId, characterId, overflow);
  return result.changes;
}

/** 清空某用户的全部故事（删除账号数据时用，硬删除） */
export function deleteAllForUser(userId: string): number {
  return db.prepare('DELETE FROM stories WHERE user_id = ?').run(userId).changes;
}
