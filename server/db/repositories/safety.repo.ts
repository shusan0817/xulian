/**
 * safety_logs 数据访问（内容安全审计）
 *
 * 写入策略：
 * - 只存 `excerpt`（截断到 60 字），**不存用户原文全文**，避免安全日志变成第二个聊天记录库；
 * - userId 允许为空（系统级规则命中时没有用户上下文）。
 *
 * V2-14（D2 ALTER）：新增 `message_id` / `conversation_id` / `source` 三列。
 * 之前只有 excerpt 前 60 字，用户举报一条 AI 回复后**定位不到原文**——
 * 安全同学看到日志却不知道被举报的是哪句话，这条日志基本等于废的。
 * 现在：举报必须带 message_id；source 用来把「用户举报」和「规则自动拦截」分开统计。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { newId, nowIso } from '../helpers.js';
import { SAFETY_CONFIG } from '../../config/defaults.js';
import type {
  SafetyAction,
  SafetyDirection,
  SafetyLog,
  SafetyLogSource,
  SafetySeverity,
} from '../../../shared/types.js';

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
  message_id: string | null;
  conversation_id: string | null;
  source: string;
}

const VALID_DIRECTIONS: readonly string[] = ['incoming', 'outgoing', 'proactive'];
const VALID_ACTIONS: readonly string[] = ['blocked', 'rewritten', 'flagged', 'crisis'];
const VALID_SEVERITIES: readonly string[] = ['info', 'warn', 'block'];
const VALID_SOURCES: readonly string[] = ['system', 'user_report'];

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
    messageId: row.message_id ?? null,
    conversationId: row.conversation_id ?? null,
    source: (VALID_SOURCES.includes(row.source) ? row.source : 'system') as SafetyLogSource,
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
  /** V2-14：定位到原文。用户举报时**必填**。 */
  messageId?: string | null;
  conversationId?: string | null;
  /** 默认 'system'；用户举报传 'user_report' */
  source?: SafetyLogSource;
}

/**
 * 写一条安全日志。
 * 首参 userId 允许为 null（系统级规则），这仍然满足"第一个参数是 userId"的约定。
 */
export function insertSafetyLog(userId: string | null, input: InsertSafetyLogInput): SafetyLog {
  const id = newId();
  const createdAt = nowIso();
  const excerpt = (input.excerpt ?? '').slice(0, SAFETY_CONFIG.excerptLength);

  const source: SafetyLogSource = input.source ?? 'system';

  db.prepare(
    `INSERT INTO safety_logs (id, user_id, character_id, direction, rule, action, severity, excerpt, detail, created_at,
                              message_id, conversation_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.messageId ?? null,
    input.conversationId ?? null,
    source,
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
    messageId: input.messageId ?? null,
    conversationId: input.conversationId ?? null,
    source,
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

/**
 * 按来源列出日志。
 * `source='user_report'` 即「我举报过的内容」——设置页可向用户展示处理进度。
 */
export function listBySource(userId: string, source: SafetyLogSource, limit = 50): SafetyLog[] {
  const rows = db
    .prepare(
      `SELECT * FROM safety_logs WHERE user_id = ? AND source = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, source, Math.min(Math.max(limit, 1), 200)) as SafetyRow[];
  return rows.map(rowToSafetyLog);
}

/** 按 message_id 定位日志（举报后回查、避免同一条被重复记录时抓瞎） */
export function listByMessageId(userId: string, messageId: string): SafetyLog[] {
  const rows = db
    .prepare('SELECT * FROM safety_logs WHERE user_id = ? AND message_id = ? ORDER BY created_at DESC')
    .all(userId, messageId) as SafetyRow[];
  return rows.map(rowToSafetyLog);
}

/**
 * 待处理的举报队列（运营/安全排查用，与具体用户无关 → admin 前缀）。
 * 只取「用户举报」，且必须能定位到 message_id 才有排查价值。
 */
export function adminListUserReports(limit = 100): SafetyLog[] {
  const rows = db
    .prepare(
      `SELECT * FROM safety_logs
        WHERE source = 'user_report' AND message_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as SafetyRow[];
  return rows.map(rowToSafetyLog);
}
