/**
 * safety_logs 数据访问（内容安全审计）
 *
 * 写入策略：
 * - 只存 `excerpt`（截断到 60 字），**不存用户原文全文**，避免安全日志变成第二个聊天记录库；
 * - userId 允许为空（系统级规则命中时没有用户上下文）。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { newId, nowIso } from '../helpers.js';
import { SAFETY_CONFIG } from '../../config/defaults.js';
import type { SafetyAction, SafetyDirection, SafetyLog, SafetySeverity } from '../../../shared/types.js';

export interface SafetyRow {
  id: string;
  user_id: string | null;
  character_id: string | null;
  direction: string;
  rule: string;
  action: string;
  severity: string;
  excerpt: string;
  detail: string;
  created_at: string;
}

const VALID_DIRECTIONS: readonly string[] = ['incoming', 'outgoing', 'proactive'];
const VALID_ACTIONS: readonly string[] = ['blocked', 'rewritten', 'flagged', 'crisis'];
const VALID_SEVERITIES: readonly string[] = ['info', 'warn', 'block'];

export function rowToSafetyLog(row: SafetyRow): SafetyLog {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    direction: (VALID_DIRECTIONS.includes(row.direction) ? row.direction : 'incoming') as SafetyDirection,
    rule: row.rule,
    action: (VALID_ACTIONS.includes(row.action) ? row.action : 'flagged') as SafetyAction,
    severity: (VALID_SEVERITIES.includes(row.severity) ? row.severity : 'info') as SafetySeverity,
    excerpt: row.excerpt,
    detail: jsonGet<Record<string, unknown>>(row.detail, {}, 'safety_logs.detail'),
    createdAt: row.created_at,
  };
}

export interface InsertSafetyLogInput {
  characterId?: string | null;
  direction: SafetyDirection;
  rule: string;
  action: SafetyAction;
  severity?: SafetySeverity;
  excerpt?: string;
  detail?: Record<string, unknown>;
}

/**
 * 写一条安全日志。
 * 首参 userId 允许为 null（系统级规则），这仍然满足"第一个参数是 userId"的约定。
 */
export function insertSafetyLog(userId: string | null, input: InsertSafetyLogInput): SafetyLog {
  const id = newId();
  const createdAt = nowIso();
  const excerpt = (input.excerpt ?? '').slice(0, SAFETY_CONFIG.excerptLength);

  db.prepare(
    `INSERT INTO safety_logs (id, user_id, character_id, direction, rule, action, severity, excerpt, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.characterId ?? null,
    input.direction,
    input.rule,
    input.action,
    input.severity ?? 'info',
    excerpt,
    JSON.stringify(input.detail ?? {}),
    createdAt,
  );

  return {
    id,
    userId,
    characterId: input.characterId ?? null,
    direction: input.direction,
    rule: input.rule,
    action: input.action,
    severity: input.severity ?? 'info',
    excerpt,
    detail: input.detail ?? {},
    createdAt,
  };
}

/** 列出某个用户的安全日志（设置页可向用户展示脱敏后的拦截记录） */
export function listSafetyLogs(userId: string, limit = 50): SafetyLog[] {
  const rows = db
    .prepare('SELECT * FROM safety_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, Math.min(Math.max(limit, 1), 200)) as SafetyRow[];
  return rows.map(rowToSafetyLog);
}

/** 统计某个角色近期被拦截的次数（调试面板用） */
export function countRecentBlocks(userId: string, characterId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM safety_logs
        WHERE user_id = ? AND character_id = ? AND action = 'blocked' AND created_at >= ?`,
    )
    .get(userId, characterId, sinceIso) as { n: number } | undefined;
  return row?.n ?? 0;
}
