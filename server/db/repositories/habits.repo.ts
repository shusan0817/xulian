/**
 * ai_habits 数据访问（V2-4「AI 后天形成的交流习惯」）
 *
 * 所有函数首参为 userId。
 *
 * ★ 架构硬约束（设计文档 §4.3 隔离机制 6）：
 *   本文件只 UPDATE / DELETE `ai_habits`，
 *   **绝不触碰 `ai_characters`**（核心人格字段只能由用户在角色编辑页改）。
 *   「重置全部习惯」= 把本表状态置为 archived，人格一字不动。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { clamp01, newId, nowIso } from '../helpers.js';
import {
  HABIT_DIMENSIONS,
  HABIT_MISS_LIMIT,
  HABIT_STATUSES,
  OBSERVATION_CONFIDENCE_STEP,
  OBSERVATION_EVIDENCE_LIMIT,
  OBSERVATION_MIN_CONFIDENCE,
  OBSERVATION_MIN_COUNT,
  PERSONA_CHECK_STATUSES,
  type HabitDimension,
  type HabitStatus,
  type PersonaCheckStatus,
} from '../../../shared/constants.js';
import type { AiHabit, HabitEvidence } from '../../../shared/types.js';

// ============================================================
// 行 → 实体
// ============================================================

export interface AiHabitRow {
  id: string;
  user_id: string;
  character_id: string;
  dimension: string;
  value: string;
  value_label: string;
  confidence: number;
  observation_count: number;
  miss_count: number;
  evidence: string;
  status: string;
  user_confirmed: number;
  persona_check: string;
  persona_check_note: string;
  story_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToHabit(row: AiHabitRow): AiHabit {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    dimension: (HABIT_DIMENSIONS as readonly string[]).includes(row.dimension)
      ? (row.dimension as HabitDimension)
      : 'shared_ritual',
    value: row.value,
    valueLabel: row.value_label,
    confidence: clamp01(row.confidence),
    observationCount: row.observation_count,
    missCount: row.miss_count,
    evidence: jsonGet<HabitEvidence[]>(row.evidence, [], 'ai_habits.evidence'),
    status: (HABIT_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as HabitStatus)
      : 'candidate',
    userConfirmed: row.user_confirmed === 1,
    personaCheck: (PERSONA_CHECK_STATUSES as readonly string[]).includes(row.persona_check)
      ? (row.persona_check as PersonaCheckStatus)
      : 'pending',
    personaCheckNote: row.persona_check_note ?? '',
    storyId: row.story_id,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

export interface ListHabitsOptions {
  characterId?: string;
  /** 是否包含 candidate（「觀察中」）与 archived（已归档） */
  includeCandidate?: boolean;
  includeArchived?: boolean;
  limit?: number;
}

export function list(userId: string, options: ListHabitsOptions = {}): AiHabit[] {
  const where: string[] = ['user_id = ?', 'deleted_at IS NULL'];
  const params: Array<string | number> = [userId];

  if (options.characterId) {
    where.push('character_id = ?');
    params.push(options.characterId);
  }
  if (!options.includeCandidate) where.push("status = 'active'");
  if (!options.includeArchived) where.push("status <> 'archived'");

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);
  const rows = db
    .prepare(
      `SELECT * FROM ai_habits WHERE ${where.join(' AND ')}
        ORDER BY status ASC, confidence DESC, updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as AiHabitRow[];
  return rows.map(rowToHabit);
}

/**
 * 注入 Prompt L1b 用的习惯清单：**只取 status='active'**，
 * candidate 不进 Prompt（否则就是「AI 人格每次聊天随机变化」）。
 */
export function listActiveForPrompt(userId: string, characterId: string, limit = 12): AiHabit[] {
  const rows = db
    .prepare(
      `SELECT * FROM ai_habits
        WHERE user_id = ? AND character_id = ? AND status = 'active' AND deleted_at IS NULL
        ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
    )
    .all(userId, characterId, Math.min(Math.max(limit, 1), 30)) as AiHabitRow[];
  return rows.map(rowToHabit);
}

/** 按 ID 取一条 */
export function getById(userId: string, habitId: string): AiHabit | null {
  const row = db
    .prepare('SELECT * FROM ai_habits WHERE id = ? AND user_id = ?')
    .get(habitId, userId) as AiHabitRow | undefined;
  return row ? rowToHabit(row) : null;
}

/** 按 (角色, 维度, 值) 精确取一条（唯一约束就是这个三元组） */
export function getByKey(
  userId: string,
  characterId: string,
  dimension: HabitDimension,
  value: string,
): AiHabit | null {
  const row = db
    .prepare(
      `SELECT * FROM ai_habits
        WHERE user_id = ? AND character_id = ? AND dimension = ? AND value = ? AND deleted_at IS NULL`,
    )
    .get(userId, characterId, dimension, value) as AiHabitRow | undefined;
  return row ? rowToHabit(row) : null;
}

/** 统计某角色的活跃习惯数 */
export function countActive(userId: string, characterId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_habits
        WHERE user_id = ? AND character_id = ? AND status = 'active' AND deleted_at IS NULL`,
    )
    .get(userId, characterId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ============================================================
// 写入
// ============================================================

export interface UpsertHabitInput {
  characterId: string;
  dimension: HabitDimension;
  value: string;
  valueLabel: string;
  confidence?: number;
  observationCount?: number;
  evidence?: HabitEvidence[];
  storyId?: string | null;
  personaCheck?: PersonaCheckStatus;
  personaCheckNote?: string;
  userConfirmed?: boolean;
}

/**
 * 观测一次习惯（闸门 B 的落库侧）。
 *
 * confidence **只单调上升**（`c += (1 - c) * 0.2`），
 * 达标（≥3 次且 ≥0.6）自动升级为 active；未达标停在 candidate（不进 Prompt）。
 */
export function upsert(userId: string, input: UpsertHabitInput): AiHabit {
  const now = nowIso();
  const existing = getByKey(userId, input.characterId, input.dimension, input.value);

  const nextCount = (existing?.observationCount ?? 0) + (input.observationCount ?? 1);
  const baseConfidence = existing?.confidence ?? 0;
  const nextConfidence = clamp01(
    input.confidence ?? baseConfidence + (1 - baseConfidence) * OBSERVATION_CONFIDENCE_STEP,
  );
  const userConfirmed = input.userConfirmed ?? existing?.userConfirmed ?? false;
  // 用户确认过的直接 active，且不会被 miss_count 自动降级
  const nextStatus: HabitStatus = userConfirmed
    ? 'active'
    : nextCount >= OBSERVATION_MIN_COUNT && nextConfidence >= OBSERVATION_MIN_CONFIDENCE
      ? 'active'
      : 'candidate';

  const evidence = input.evidence?.length
    ? [...(existing?.evidence ?? []), ...input.evidence].slice(-OBSERVATION_EVIDENCE_LIMIT)
    : (existing?.evidence ?? []);

  db.prepare(
    `INSERT INTO ai_habits (id, user_id, character_id, dimension, value, value_label,
                            confidence, observation_count, miss_count, evidence, status,
                            user_confirmed, persona_check, persona_check_note, story_id,
                            deleted_at, created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @dimension, @value, @value_label,
             @confidence, @observation_count, 0, @evidence, @status,
             @user_confirmed, @persona_check, @persona_check_note, @story_id,
             NULL, @created_at, @updated_at)
     ON CONFLICT (user_id, character_id, dimension, value) DO UPDATE SET
        value_label = excluded.value_label,
        confidence = excluded.confidence,
        observation_count = excluded.observation_count,
        miss_count = 0,
        evidence = excluded.evidence,
        status = excluded.status,
        user_confirmed = excluded.user_confirmed,
        persona_check = excluded.persona_check,
        persona_check_note = excluded.persona_check_note,
        story_id = COALESCE(excluded.story_id, ai_habits.story_id),
        deleted_at = NULL,
        updated_at = excluded.updated_at`,
  ).run({
    id: existing?.id ?? newId(),
    user_id: userId,
    character_id: input.characterId,
    dimension: input.dimension,
    value: input.value,
    value_label: input.valueLabel,
    confidence: nextConfidence,
    observation_count: nextCount,
    evidence: JSON.stringify(evidence),
    status: nextStatus,
    user_confirmed: userConfirmed ? 1 : 0,
    persona_check: input.personaCheck ?? existing?.personaCheck ?? 'pending',
    persona_check_note: input.personaCheckNote ?? existing?.personaCheckNote ?? '',
    story_id: input.storyId ?? existing?.storyId ?? null,
    created_at: existing?.createdAt ?? now,
    updated_at: now,
  });

  const saved = getByKey(userId, input.characterId, input.dimension, input.value);
  if (!saved) throw new Error(`[DB] 寫入習慣後讀不回來：${input.dimension}/${input.value}`);
  return saved;
}

export interface UpdateHabitPatch {
  value?: string;
  valueLabel?: string;
  status?: HabitStatus;
  confidence?: number;
  userConfirmed?: boolean;
  storyId?: string | null;
  personaCheck?: PersonaCheckStatus;
  personaCheckNote?: string;
}

/** 更新习惯（用户编辑 / 确认 / 闸门 C 校验结果回写都走这里） */
export function update(userId: string, habitId: string, patch: UpdateHabitPatch): AiHabit | null {
  const current = getById(userId, habitId);
  if (!current) return null;

  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  const push = (column: string, value: string | number | null): void => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.value !== undefined) push('value', patch.value);
  if (patch.valueLabel !== undefined) push('value_label', patch.valueLabel);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.confidence !== undefined) push('confidence', clamp01(patch.confidence));
  if (patch.userConfirmed !== undefined) push('user_confirmed', patch.userConfirmed ? 1 : 0);
  if (patch.storyId !== undefined) push('story_id', patch.storyId);
  if (patch.personaCheck !== undefined) push('persona_check', patch.personaCheck);
  if (patch.personaCheckNote !== undefined) push('persona_check_note', patch.personaCheckNote);

  if (fields.length === 0) return current;

  // 用户确认 → 直接 active
  if (patch.userConfirmed === true && patch.status === undefined) push('status', 'active');
  push('updated_at', nowIso());
  values.push(habitId, userId);

  db.prepare(`UPDATE ai_habits SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(
    ...values,
  );
  return getById(userId, habitId);
}

/**
 * 记一次「未复现」：miss_count +1，≥5 自动降级为 candidate。
 * 用户确认过的（user_confirmed=1）**永不自动降级**。
 */
export function recordMiss(userId: string, habitId: string, missLimit = HABIT_MISS_LIMIT): AiHabit | null {
  const current = getById(userId, habitId);
  if (!current) return null;
  if (current.userConfirmed) return current;

  const nextMiss = current.missCount + 1;
  db.prepare(
    `UPDATE ai_habits SET miss_count = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(nextMiss, nextMiss >= missLimit ? 'candidate' : current.status, nowIso(), habitId, userId);
  return getById(userId, habitId);
}

/** 软删除单条 */
export function softDelete(userId: string, habitId: string): boolean {
  const result = db
    .prepare(
      'UPDATE ai_habits SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .run(nowIso(), nowIso(), habitId, userId);
  return result.changes > 0;
}

/**
 * 重置全部后天习惯：把本角色的习惯全部归档（archived）。
 *
 * ⛔ 只 UPDATE ai_habits，**绝不碰 ai_characters**——
 *    「重置习惯不能改变核心人格」是 V2-4 的硬约束。
 */
export function resetAll(userId: string, characterId: string): number {
  const result = db
    .prepare(
      `UPDATE ai_habits SET status = 'archived', updated_at = ?
        WHERE user_id = ? AND character_id = ? AND status <> 'archived'`,
    )
    .run(nowIso(), userId, characterId);
  return result.changes;
}

/** 清空某用户的全部习惯（删除账号数据时用，硬删除） */
export function deleteAllForUser(userId: string): number {
  return db.prepare('DELETE FROM ai_habits WHERE user_id = ?').run(userId).changes;
}
