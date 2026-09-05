/**
 * memories 数据访问（长期记忆）
 *
 * 所有函数首参为 userId。
 * 去重策略（T08 实现，这里提供所需查询）：
 *   1. 精确：`UNIQUE(user_id, character_id, dedupe_key)`；
 *   2. 近似：取同分类的候选记忆，用 bigram Jaccard 比对（`listForDedupe`）。
 */

import db from '../index.js';
import { clamp01, makeDedupeKey, newId, nowIso } from '../helpers.js';
import { MEMORY_CONFIG } from '../../config/defaults.js';
import type { MemoryCategory } from '../../../shared/constants.js';
import type { MemoryItem } from '../../../shared/types.js';

export interface MemoryRow {
  id: string;
  user_id: string;
  character_id: string;
  category: string;
  content: string;
  dedupe_key: string;
  importance: number;
  is_sensitive: number;
  source_message_id: string | null;
  hit_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    category: row.category as MemoryCategory,
    content: row.content,
    dedupeKey: row.dedupe_key,
    importance: clamp01(row.importance),
    isSensitive: row.is_sensitive === 1,
    sourceMessageId: row.source_message_id,
    hitCount: row.hit_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

export interface ListMemoriesOptions {
  characterId?: string;
  category?: MemoryCategory;
  /** 关键字（对 content 做 LIKE 匹配） */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryListResult {
  items: MemoryItem[];
  total: number;
}

/** 记忆管理页：支持按角色、分类、关键字筛选 */
export function listMemories(
  userId: string,
  options: ListMemoriesOptions = {},
): MemoryListResult {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const where: string[] = ['user_id = ?'];
  const params: Array<string | number> = [userId];

  if (options.characterId) {
    where.push('character_id = ?');
    params.push(options.characterId);
  }
  if (options.category) {
    where.push('category = ?');
    params.push(options.category);
  }
  if (options.q) {
    where.push('content LIKE ?');
    params.push(`%${options.q}%`);
  }

  const whereSql = where.join(' AND ');
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE ${whereSql}
        ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as MemoryRow[];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${whereSql}`)
    .get(...params) as { n: number } | undefined;

  return { items: rows.map(rowToMemory), total: totalRow?.n ?? 0 };
}

/** 按 ID 取一条 */
export function getMemory(userId: string, memoryId: string): MemoryItem | null {
  const row = db
    .prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
    .get(memoryId, userId) as MemoryRow | undefined;
  return row ? rowToMemory(row) : null;
}

/** 精确去重查询：同角色 + 同 dedupe_key */
export function findByDedupeKey(
  userId: string,
  characterId: string,
  dedupeKey: string,
): MemoryItem | null {
  const row = db
    .prepare(
      'SELECT * FROM memories WHERE user_id = ? AND character_id = ? AND dedupe_key = ?',
    )
    .get(userId, characterId, dedupeKey) as MemoryRow | undefined;
  return row ? rowToMemory(row) : null;
}

/**
 * 取同分类的候选记忆，用于近似去重（bigram Jaccard）。
 * 只取最近 200 条：记忆规模本来就在几百条量级，全表比对没有意义。
 */
export function listForDedupe(
  userId: string,
  characterId: string,
  category: MemoryCategory,
  limit = 200,
): MemoryItem[] {
  const rows = db
    .prepare(
      'SELECT * FROM memories WHERE user_id = ? AND character_id = ? AND category = ? ' +
        'ORDER BY updated_at DESC LIMIT ?',
    )
    .all(userId, characterId, category, limit) as MemoryRow[];
  return rows.map(rowToMemory);
}

/**
 * 检索用于注入 Prompt 的记忆：重要度优先，兼顾最近使用。
 * 排序权重 = importance + hit_count * 0.02（被引用得多的更可能是用户真正在意的）。
 */
export function searchMemories(
  userId: string,
  characterId: string,
  limit: number = MEMORY_CONFIG.topK,
): MemoryItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
        WHERE user_id = ? AND character_id = ? AND is_sensitive = 0
        ORDER BY (importance + hit_count * 0.02) DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(userId, characterId, Math.min(Math.max(limit, 1), 50)) as MemoryRow[];
  return rows.map(rowToMemory);
}

/** 统计某个角色的记忆条数（关系成长的 memoryScore 用） */
export function countMemories(userId: string, characterId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ============================================================
// 写入
// ============================================================

export interface InsertMemoryInput {
  characterId: string;
  category: MemoryCategory;
  content: string;
  importance?: number;
  isSensitive?: boolean;
  sourceMessageId?: string | null;
}

/** 新增记忆；dedupe_key 由 (category, content) 自动生成，保证唯一约束可用 */
export function insertMemory(userId: string, input: InsertMemoryInput): MemoryItem {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO memories (id, user_id, character_id, category, content, dedupe_key,
                           importance, is_sensitive, source_message_id, hit_count,
                           last_used_at, created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @category, @content, @dedupe_key,
             @importance, @is_sensitive, @source_message_id, 0, NULL, @created_at, @updated_at)`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId,
    category: input.category,
    content: input.content,
    dedupe_key: makeDedupeKey(input.category, input.content),
    importance: clamp01(input.importance ?? MEMORY_CONFIG.defaultImportance),
    is_sensitive: input.isSensitive ? 1 : 0,
    source_message_id: input.sourceMessageId ?? null,
    created_at: now,
    updated_at: now,
  });
  const created = getMemory(userId, id);
  if (!created) throw new Error(`[DB] 寫入記憶後讀不回來：${id}`);
  return created;
}

export interface UpdateMemoryPatch {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
}

/** 更新记忆（改内容会重算 dedupe_key，避免改完之后又跟另一条撞车） */
export function updateMemory(
  userId: string,
  memoryId: string,
  patch: UpdateMemoryPatch,
): MemoryItem | null {
  const current = getMemory(userId, memoryId);
  if (!current) return null;

  const nextContent = patch.content ?? current.content;
  const nextCategory = patch.category ?? current.category;

  db.prepare(
    `UPDATE memories SET content = ?, category = ?, dedupe_key = ?, importance = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    nextContent,
    nextCategory,
    makeDedupeKey(nextCategory, nextContent),
    clamp01(patch.importance ?? current.importance),
    nowIso(),
    memoryId,
    userId,
  );
  return getMemory(userId, memoryId);
}

/** 删除单条记忆 */
export function deleteMemory(userId: string, memoryId: string): boolean {
  const result = db
    .prepare('DELETE FROM memories WHERE id = ? AND user_id = ?')
    .run(memoryId, userId);
  return result.changes > 0;
}

/** 清空记忆（可按角色，不传则清空该用户全部） */
export function deleteAllMemories(userId: string, characterId?: string): number {
  const result = characterId
    ? db.prepare('DELETE FROM memories WHERE user_id = ? AND character_id = ?').run(userId, characterId)
    : db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
  return result.changes;
}

/**
 * 记忆被引用后提升热度：hit_count +1、last_used_at 更新、重要度小幅上调。
 * 让"用户反复提到的事"自然排在检索结果前面。
 */
export function bumpHit(userId: string, memoryIds: string[]): void {
  if (memoryIds.length === 0) return;
  const now = nowIso();
  const stmt = db.prepare(
    `UPDATE memories
        SET hit_count = hit_count + 1,
            last_used_at = ?,
            importance = MIN(1, importance + ?),
            updated_at = ?
      WHERE id = ? AND user_id = ?`,
  );
  const run = db.transaction(() => {
    for (const id of memoryIds) {
      stmt.run(now, MEMORY_CONFIG.hitBoost, now, id, userId);
    }
  });
  run();
}
