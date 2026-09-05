/**
 * user_insights 数据访问（V2-3「AI 了解的你」）
 *
 * 所有函数首参为 userId。
 *
 * ★ 避坑 D5（设计文档 §2.2）：`character_scope` 必须用 `''` 表示全域，
 *   **不能**用 NULL——SQLite 的 `UNIQUE(a, NULL)` 不去重，
 *   用 NULL 会让全域偏好的唯一约束失效、产生重复行。
 *
 * 双轨制（已拍板决策 #1）：全域（`character_scope=''`）为底 + 角色覆盖优先。
 * `listForPrompt()` 负责把这两层合并成一份给 Prompt 用的清单。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { clamp01, newId, nowIso } from '../helpers.js';
import {
  INSIGHT_DIMENSIONS,
  INSIGHT_STATUSES,
  OBSERVATION_CONFIDENCE_STEP,
  OBSERVATION_EVIDENCE_LIMIT,
  OBSERVATION_MIN_CONFIDENCE,
  OBSERVATION_MIN_COUNT,
  type InsightDimension,
  type InsightStatus,
} from '../../../shared/constants.js';
import type { InsightEvidence, UserInsight } from '../../../shared/types.js';

/** ★ 全域作用域的常量：空串，不是 null / undefined */
export const GLOBAL_SCOPE = '';

// ============================================================
// 行 → 实体
// ============================================================

export interface UserInsightRow {
  id: string;
  user_id: string;
  character_scope: string;
  dimension: string;
  value: string;
  value_label: string;
  confidence: number;
  observation_count: number;
  evidence: string;
  source: string;
  is_user_edited: number;
  status: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToInsight(row: UserInsightRow): UserInsight {
  return {
    id: row.id,
    userId: row.user_id,
    characterScope: row.character_scope ?? GLOBAL_SCOPE,
    dimension: (INSIGHT_DIMENSIONS as readonly string[]).includes(row.dimension)
      ? (row.dimension as InsightDimension)
      : 'tone_preference',
    value: row.value,
    valueLabel: row.value_label,
    confidence: clamp01(row.confidence),
    observationCount: row.observation_count,
    evidence: jsonGet<InsightEvidence[]>(row.evidence, [], 'user_insights.evidence'),
    source: (['auto', 'user', 'imported'] as readonly string[]).includes(row.source)
      ? (row.source as UserInsight['source'])
      : 'auto',
    isUserEdited: row.is_user_edited === 1,
    status: (INSIGHT_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as InsightStatus)
      : 'candidate',
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

/** 列出某个作用域下的全部偏好（默认全域） */
export function listByScope(
  userId: string,
  characterScope: string = GLOBAL_SCOPE,
  includeDeleted = false,
): UserInsight[] {
  const rows = db
    .prepare(
      `SELECT * FROM user_insights
        WHERE user_id = ? AND character_scope = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY dimension ASC, confidence DESC`,
    )
    .all(userId, characterScope) as UserInsightRow[];
  return rows.map(rowToInsight);
}

/**
 * 给 Prompt / 前端展示用的合并清单（双轨制）：
 * 全域（`character_scope=''`）为底，同一 dimension 上存在角色覆盖时以角色覆盖为准。
 */
export function listForPrompt(
  userId: string,
  characterId: string,
  options: { activeOnly?: boolean } = {},
): UserInsight[] {
  const statusSql = options.activeOnly ? "AND status = 'active'" : '';
  const rows = db
    .prepare(
      `SELECT * FROM user_insights
        WHERE user_id = ? AND deleted_at IS NULL
          AND (character_scope = ? OR character_scope = ?)
          ${statusSql}
        ORDER BY character_scope ASC, confidence DESC`,
    )
    .all(userId, GLOBAL_SCOPE, characterId) as UserInsightRow[];

  const insights = rows.map(rowToInsight);
  // 全域在前、角色在后（ORDER BY character_scope ASC 保证 '' 排最前），
  // 后写的角色覆盖会赢，正好实现「角色覆盖优先」
  const merged = new Map<InsightDimension, UserInsight>();
  for (const insight of insights) merged.set(insight.dimension, insight);
  return [...merged.values()];
}

/** 按 ID 取一条 */
export function getById(userId: string, insightId: string): UserInsight | null {
  const row = db
    .prepare('SELECT * FROM user_insights WHERE id = ? AND user_id = ?')
    .get(insightId, userId) as UserInsightRow | undefined;
  return row ? rowToInsight(row) : null;
}

/** 按维度取一条（全域或指定角色） */
export function getByDimension(
  userId: string,
  dimension: InsightDimension,
  characterScope: string = GLOBAL_SCOPE,
): UserInsight | null {
  const row = db
    .prepare(
      'SELECT * FROM user_insights WHERE user_id = ? AND character_scope = ? AND dimension = ? AND deleted_at IS NULL',
    )
    .get(userId, characterScope, dimension) as UserInsightRow | undefined;
  return row ? rowToInsight(row) : null;
}

/** 统计活跃（status='active'）偏好条数 */
export function countActive(userId: string, characterScope: string = GLOBAL_SCOPE): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_insights
        WHERE user_id = ? AND character_scope = ? AND status = 'active' AND deleted_at IS NULL`,
    )
    .get(userId, characterScope) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ============================================================
// 写入
// ============================================================

export interface UpsertInsightInput {
  characterScope?: string;
  dimension: InsightDimension;
  value: string;
  valueLabel: string;
  confidence?: number;
  observationCount?: number;
  evidence?: InsightEvidence[];
  source?: UserInsight['source'];
  status?: InsightStatus;
}

/**
 * 新增或更新一条偏好（`UNIQUE(user_id, character_scope, dimension)` 保证一个维度一条）。
 *
 * 观测累积规则：confidence 只单调上升（`c += (1 - c) * 0.2`），
 * observation_count 累加；达标（≥3 次且 ≥0.6）自动升级为 active。
 */
export function upsert(userId: string, input: UpsertInsightInput): UserInsight {
  const now = nowIso();
  const scope = input.characterScope ?? GLOBAL_SCOPE;
  const existing = getByDimension(userId, input.dimension, scope);

  const nextCount = (existing?.observationCount ?? 0) + (input.observationCount ?? 1);
  const baseConfidence = existing?.confidence ?? 0;
  const nextConfidence = clamp01(
    input.confidence ?? baseConfidence + (1 - baseConfidence) * OBSERVATION_CONFIDENCE_STEP,
  );
  const nextStatus: InsightStatus =
    input.status ??
    (nextCount >= OBSERVATION_MIN_COUNT && nextConfidence >= OBSERVATION_MIN_CONFIDENCE
      ? 'active'
      : 'candidate');

  const evidence = input.evidence?.length
    ? [...(existing?.evidence ?? []), ...input.evidence].slice(-OBSERVATION_EVIDENCE_LIMIT)
    : (existing?.evidence ?? []);

  db.prepare(
    `INSERT INTO user_insights (id, user_id, character_scope, dimension, value, value_label,
                                confidence, observation_count, evidence, source,
                                is_user_edited, status, deleted_at, created_at, updated_at)
     VALUES (@id, @user_id, @character_scope, @dimension, @value, @value_label,
             @confidence, @observation_count, @evidence, @source,
             0, @status, NULL, @created_at, @updated_at)
     ON CONFLICT (user_id, character_scope, dimension) DO UPDATE SET
        value = excluded.value,
        value_label = excluded.value_label,
        confidence = excluded.confidence,
        observation_count = excluded.observation_count,
        evidence = excluded.evidence,
        source = excluded.source,
        status = excluded.status,
        deleted_at = NULL,
        updated_at = excluded.updated_at`,
  ).run({
    id: existing?.id ?? newId(),
    user_id: userId,
    character_scope: scope,
    dimension: input.dimension,
    value: input.value,
    value_label: input.valueLabel,
    confidence: nextConfidence,
    observation_count: nextCount,
    evidence: JSON.stringify(evidence),
    source: input.source ?? existing?.source ?? 'auto',
    status: nextStatus,
    created_at: existing?.createdAt ?? now,
    updated_at: now,
  });

  const saved = getByDimension(userId, input.dimension, scope);
  if (!saved) throw new Error(`[DB] 寫入偏好後讀不回來：${input.dimension}`);
  return saved;
}

export interface UpdateInsightPatch {
  value?: string;
  valueLabel?: string;
  status?: InsightStatus;
  confidence?: number;
}

/** 用户修改偏好 → `is_user_edited=1` 且 `source='user'`（用户改过就不再被自动推断覆盖值） */
export function update(userId: string, insightId: string, patch: UpdateInsightPatch): UserInsight | null {
  const current = getById(userId, insightId);
  if (!current) return null;

  const fields: string[] = [];
  const values: Array<string | number> = [];
  const push = (column: string, value: string | number): void => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.value !== undefined) push('value', patch.value);
  if (patch.valueLabel !== undefined) push('value_label', patch.valueLabel);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.confidence !== undefined) push('confidence', clamp01(patch.confidence));

  if (fields.length === 0) return current;

  // 用户手动改过 → 直接置 active 并标记为已编辑
  push('is_user_edited', 1);
  push('source', 'user');
  if (patch.status === undefined) push('status', 'active');
  push('updated_at', nowIso());
  values.push(insightId, userId);

  db.prepare(`UPDATE user_insights SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(
    ...values,
  );
  return getById(userId, insightId);
}

/** 用户确认 → 直接 active（等同 update 的语义糖） */
export function confirm(userId: string, insightId: string): UserInsight | null {
  return update(userId, insightId, { status: 'active' });
}

/** 软删除 */
export function softDelete(userId: string, insightId: string): boolean {
  const result = db
    .prepare(
      'UPDATE user_insights SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .run(nowIso(), nowIso(), insightId, userId);
  return result.changes > 0;
}

/** 清空某用户的全部偏好（删除账号数据时用，硬删除） */
export function deleteAllForUser(userId: string): number {
  return db.prepare('DELETE FROM user_insights WHERE user_id = ?').run(userId).changes;
}
