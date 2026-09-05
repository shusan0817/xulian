/**
 * proactive_message_tasks / proactive_runs / proactive_daily_counters 数据访问
 *
 * 三张表共同支撑「主动聊天不能是固定定时器」（需求 §27.3）：
 * - `proactive_message_tasks`：每次决策留痕，可解释、可追溯；
 * - `proactive_runs`：10 分钟粒度的幂等锁，重复 tick 不会重复发送；
 * - `proactive_daily_counters`：每日频控。
 */

import db from '../index.js';
import { jsonGet } from '../json.js';
import { newId, nowIso } from '../helpers.js';
import type {
  DecisionDetail,
  ProactiveDecision,
  ProactiveTask,
  ProactiveTaskStatus,
} from '../../../shared/types.js';

// ============================================================
// 9. 主动消息任务
// ============================================================

export interface ProactiveTaskRow {
  id: string;
  user_id: string;
  character_id: string;
  status: string;
  decision: string;
  score: number;
  reason_code: string;
  reason_detail: string;
  scheduled_at: string | null;
  message_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const EMPTY_DETAIL: DecisionDetail = { factors: {}, vetoHit: null, notes: [] };

export function rowToTask(row: ProactiveTaskRow): ProactiveTask {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    status: row.status as ProactiveTaskStatus,
    decision: row.decision as ProactiveDecision,
    score: row.score,
    reasonCode: row.reason_code,
    reasonDetail: jsonGet<DecisionDetail>(row.reason_detail, { ...EMPTY_DETAIL }, 'proactive_message_tasks.reason_detail'),
    scheduledAt: row.scheduled_at,
    messageId: row.message_id,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertTaskInput {
  characterId: string;
  status: ProactiveTaskStatus;
  decision: ProactiveDecision;
  score?: number;
  reasonCode?: string;
  reasonDetail?: DecisionDetail;
  scheduledAt?: string | null;
  messageId?: string | null;
}

/** 记下一次决策（skip / delay / send 都要留痕，调试面板靠它解释"为什么 AI 没找我"） */
export function insertTask(userId: string, input: InsertTaskInput): ProactiveTask {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO proactive_message_tasks (id, user_id, character_id, status, decision, score,
                                          reason_code, reason_detail, scheduled_at, message_id,
                                          attempts, last_error, created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @status, @decision, @score,
             @reason_code, @reason_detail, @scheduled_at, @message_id,
             0, NULL, @created_at, @updated_at)`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId,
    status: input.status,
    decision: input.decision,
    score: input.score ?? 0,
    reason_code: input.reasonCode ?? '',
    reason_detail: JSON.stringify(input.reasonDetail ?? { ...EMPTY_DETAIL }),
    scheduled_at: input.scheduledAt ?? null,
    message_id: input.messageId ?? null,
    created_at: now,
    updated_at: now,
  });
  const created = getTask(userId, id);
  if (!created) throw new Error(`[DB] 寫入主動任務後讀不回來：${id}`);
  return created;
}

/** 按 ID 取任务 */
export function getTask(userId: string, taskId: string): ProactiveTask | null {
  const row = db
    .prepare('SELECT * FROM proactive_message_tasks WHERE id = ? AND user_id = ?')
    .get(taskId, userId) as ProactiveTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export interface UpdateTaskPatch {
  status?: ProactiveTaskStatus;
  decision?: ProactiveDecision;
  score?: number;
  reasonCode?: string;
  reasonDetail?: DecisionDetail;
  scheduledAt?: string | null;
  messageId?: string | null;
  attempts?: number;
  lastError?: string | null;
}

/** 更新任务（重试、发送成功、失败都会走这里） */
export function updateTask(
  userId: string,
  taskId: string,
  patch: UpdateTaskPatch,
): ProactiveTask | null {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  const push = (column: string, value: string | number | null): void => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.status !== undefined) push('status', patch.status);
  if (patch.decision !== undefined) push('decision', patch.decision);
  if (patch.score !== undefined) push('score', patch.score);
  if (patch.reasonCode !== undefined) push('reason_code', patch.reasonCode);
  if (patch.reasonDetail !== undefined) push('reason_detail', JSON.stringify(patch.reasonDetail));
  if (patch.scheduledAt !== undefined) push('scheduled_at', patch.scheduledAt);
  if (patch.messageId !== undefined) push('message_id', patch.messageId);
  if (patch.attempts !== undefined) push('attempts', Math.max(0, Math.trunc(patch.attempts)));
  if (patch.lastError !== undefined) push('last_error', patch.lastError);

  if (fields.length === 0) return getTask(userId, taskId);

  fields.push('updated_at = ?');
  values.push(nowIso(), taskId, userId);
  db.prepare(
    `UPDATE proactive_message_tasks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
  ).run(...values);
  return getTask(userId, taskId);
}

export interface ListTasksOptions {
  characterId?: string;
  status?: ProactiveTaskStatus;
  limit?: number;
}

/** 任务历史（调试面板用） */
export function listTasks(userId: string, options: ListTasksOptions = {}): ProactiveTask[] {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const where: string[] = ['user_id = ?'];
  const params: Array<string | number> = [userId];
  if (options.characterId) {
    where.push('character_id = ?');
    params.push(options.characterId);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const rows = db
    .prepare(
      `SELECT * FROM proactive_message_tasks WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as ProactiveTaskRow[];
  return rows.map(rowToTask);
}

/** 取某个角色最近一次「发送成功」的任务（最小间隔与今日计数以外的时间参考） */
export function getLastSentTask(userId: string, characterId: string): ProactiveTask | null {
  const row = db
    .prepare(
      `SELECT * FROM proactive_message_tasks
        WHERE user_id = ? AND character_id = ? AND status = 'sent'
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(userId, characterId) as ProactiveTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/** 取某个角色最近一次决策（不论结果，用于"下次检查时间"提示） */
export function getLastTask(userId: string, characterId: string): ProactiveTask | null {
  const row = db
    .prepare(
      'SELECT * FROM proactive_message_tasks WHERE user_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(userId, characterId) as ProactiveTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * 取所有到期的 scheduled 任务（Scheduler 用）。
 * 以 admin 开头：这是跨用户的调度查询，不属于某个用户的私有数据访问。
 */
export function adminFindDueTasks(now: string, limit = 50): ProactiveTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM proactive_message_tasks
        WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
        ORDER BY scheduled_at ASC LIMIT ?`,
    )
    .all(now, limit) as ProactiveTaskRow[];
  return rows.map(rowToTask);
}

/**
 * 列出所有开启了主动聊天的「用户 × 角色」组合（Scheduler 的扫描目标）。
 * 以 admin 开头：跨用户扫描。
 */
export function adminListProactiveTargets(): Array<{ userId: string; characterId: string }> {
  const rows = db
    .prepare(
      // ai_characters 的主键就是 id（没有 character_id 列），这里用别名统一输出形状
      `SELECT user_id, id AS character_id FROM ai_characters WHERE proactive_enabled = 1`,
    )
    .all() as Array<{ user_id: string; character_id: string }>;
  return rows.map((r) => ({ userId: r.user_id, characterId: r.character_id }));
}

/**
 * 进程重启时把卡在 sending 的任务重置为 pending，既不丢也不重发。
 * 以 admin 开头：跨用户维护操作。
 */
export function adminResetStaleSending(cutoff: string): number {
  const result = db
    .prepare(
      `UPDATE proactive_message_tasks
          SET status = 'pending', attempts = attempts + 1, last_error = 'reboot_reset', updated_at = ?
        WHERE status = 'sending' AND updated_at < ?`,
    )
    .run(nowIso(), cutoff);
  return result.changes;
}

/** 把超过有效期的 scheduled 任务标记为 expired（以 admin 开头：跨用户维护） */
export function adminExpireOldTasks(cutoff: string): number {
  const result = db
    .prepare(
      `UPDATE proactive_message_tasks
          SET status = 'expired', updated_at = ?
        WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at < ?`,
    )
    .run(nowIso(), cutoff);
  return result.changes;
}

// ============================================================
// 10. 幂等运行锁
// ============================================================

/**
 * 抢占一个 10 分钟窗口的运行锁。
 * 靠 `UNIQUE(character_id, window_key)` 保证同一窗口只会有一个实例成功，
 * 多进程/多实例部署时也不会重复发消息。
 *
 * 以 admin 开头：锁不属于任何用户的私有数据。
 */
export function adminAcquireRunLock(characterId: string, windowKey: string): boolean {
  try {
    db.prepare(
      `INSERT INTO proactive_runs (id, character_id, window_key, status, created_at)
       VALUES (?, ?, ?, 'running', ?)`,
    ).run(newId(), characterId, windowKey, nowIso());
    return true;
  } catch {
    // 唯一索引冲突 → 这个窗口已经有人跑过了
    return false;
  }
}

/** 标记运行结束（status: done | failed），以 admin 开头 */
export function adminFinishRunLock(
  characterId: string,
  windowKey: string,
  status: 'done' | 'failed',
): void {
  db.prepare(
    'UPDATE proactive_runs SET status = ? WHERE character_id = ? AND window_key = ?',
  ).run(status, characterId, windowKey);
}

/** 清理 24 小时前的运行锁，避免表无限膨胀（以 admin 开头） */
export function adminCleanupOldRuns(cutoff: string): number {
  const result = db.prepare('DELETE FROM proactive_runs WHERE created_at < ?').run(cutoff);
  return result.changes;
}

// ============================================================
// 11. 每日计数（频控）
// ============================================================

/** 读取今日已发送条数 */
export function getDailyCount(userId: string, characterId: string, day: string): number {
  const row = db
    .prepare(
      'SELECT sent_count AS n FROM proactive_daily_counters WHERE user_id = ? AND character_id = ? AND day = ?',
    )
    .get(userId, characterId, day) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 发送成功后 +1（UPSERT，天然幂等） */
export function bumpDailyCount(userId: string, characterId: string, day: string): number {
  db.prepare(
    `INSERT INTO proactive_daily_counters (user_id, character_id, day, sent_count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (user_id, character_id, day)
     DO UPDATE SET sent_count = sent_count + 1, updated_at = excluded.updated_at`,
  ).run(userId, characterId, day, nowIso());
  return getDailyCount(userId, characterId, day);
}

/** 清理 N 天前的计数（以 admin 开头：跨用户维护） */
export function adminCleanupOldCounters(cutoffDay: string): number {
  const result = db
    .prepare('DELETE FROM proactive_daily_counters WHERE day < ?')
    .run(cutoffDay);
  return result.changes;
}
