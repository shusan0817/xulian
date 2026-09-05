/**
 * user_auth / user_sessions 数据访问（V2 · T02 认证与会话）
 *
 * 强制约定（架构文档 §3.3）：除 `admin*` 开头的全局管理函数外，
 * 所有 Repository 函数的**第一个参数必须是 userId**，保证多用户数据隔离（需求 §21）。
 *
 * 本文件有两个**刻意的例外**，都是「还不知道 userId 是谁」的场合，
 * 这恰恰就是登录存在的意义，无法也不应该套用首参约束：
 *   1. `findByEmailNormalized()` — 登录时用邮箱换 userId；
 *   2. `findByTokenHash()` — 验签时按 sha256(token) 查会话。
 * 两者都只返回内部行，不会越权读取他人业务数据。
 *
 * 安全约定：
 * - `user_sessions.token_hash` 存的是 sha256(token)，**绝不存明文**；
 * - 映射成实体的 `UserSession` **不含 tokenHash**，避免哈希泄漏到上层。
 */

import db from '../index.js';
import { newId, nowIso } from '../helpers.js';
import type { UserAuth, UserSession } from '../../../shared/types.js';

// ============================================================
// user_auth
// ============================================================

export interface UserAuthRow {
  user_id: string;
  email: string;
  email_normalized: string;
  phone: string | null;
  password_hash: string;
  password_algo: string;
  password_updated_at: string;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToUserAuth(row: UserAuthRow): UserAuth {
  return {
    userId: row.user_id,
    email: row.email,
    emailNormalized: row.email_normalized,
    phone: row.phone,
    passwordHash: row.password_hash,
    passwordAlgo: row.password_algo,
    passwordUpdatedAt: row.password_updated_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 按 userId 取认证行（首参即 userId） */
export function getByUserId(userId: string): UserAuth | null {
  const row = db.prepare('SELECT * FROM user_auth WHERE user_id = ?').get(userId) as
    | UserAuthRow
    | undefined;
  return row ? rowToUserAuth(row) : null;
}

/**
 * 该用户是否已有密码（= 是否已注册）。
 * `resolveUser` 用它判断「这个账号能不能再用匿名方式访问」——
 * 已注册的账号一旦允许 X-User-Id 回落，就等同于任何人都能冒充，是 V1 最大的安全漏洞。
 */
export function hasPassword(userId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM user_auth WHERE user_id = ?')
    .get(userId) as { ok: number } | undefined;
  return row?.ok === 1;
}

/** 按原样邮箱查（保留用于后台排查） */
export function findByEmail(email: string): UserAuth | null {
  const row = db.prepare('SELECT * FROM user_auth WHERE email = ?').get(email) as
    | UserAuthRow
    | undefined;
  return row ? rowToUserAuth(row) : null;
}

/** ★ 登录入口：按规范化邮箱查（此时还不知道 userId，故为约定例外） */
export function findByEmailNormalized(emailNormalized: string): UserAuth | null {
  const row = db
    .prepare('SELECT * FROM user_auth WHERE email_normalized = ?')
    .get(emailNormalized) as UserAuthRow | undefined;
  return row ? rowToUserAuth(row) : null;
}

/** 该邮箱是否已被占用（注册前检查；大小写不敏感） */
export function emailTaken(emailNormalized: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM user_auth WHERE email_normalized = ?')
    .get(emailNormalized) as { ok: number } | undefined;
  return row?.ok === 1;
}

export interface InsertAuthInput {
  userId: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  passwordAlgo?: string;
  phone?: string | null;
}

/** 建立认证凭据（user_auth 与 users 严格 1:1） */
export function insertAuth(input: InsertAuthInput): UserAuth {
  const now = nowIso();
  db.prepare(
    `INSERT INTO user_auth (user_id, email, email_normalized, phone,
                            password_hash, password_algo, password_updated_at,
                            failed_attempts, locked_until, created_at, updated_at)
     VALUES (@user_id, @email, @email_normalized, @phone,
             @password_hash, @password_algo, @password_updated_at,
             0, NULL, @created_at, @updated_at)`,
  ).run({
    user_id: input.userId,
    email: input.email,
    email_normalized: input.emailNormalized,
    phone: input.phone ?? null,
    password_hash: input.passwordHash,
    password_algo: input.passwordAlgo ?? 'scrypt-16384-8-1',
    password_updated_at: now,
    created_at: now,
    updated_at: now,
  });
  const created = getByUserId(input.userId);
  if (!created) throw new Error(`[DB] 寫入認證後讀不回來：${input.userId}`);
  return created;
}

/** 更新密码哈希（改密码 / 未来升级算法） */
export function updatePassword(
  userId: string,
  passwordHash: string,
  passwordAlgo: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE user_auth
          SET password_hash = ?, password_algo = ?, password_updated_at = ?,
              failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE user_id = ?`,
    )
    .run(passwordHash, passwordAlgo, nowIso(), nowIso(), userId);
  return result.changes > 0;
}

/**
 * 记一次登录失败。
 * 达到上限时自动上锁：`locked_until = now + lockMs`，并把计数归零（解锁后重新计数）。
 * @returns 上锁后的状态
 */
export function bumpFailedAttempts(
  userId: string,
  maxAttempts = 10,
  lockMs = 15 * 60_000,
): { failedAttempts: number; lockedUntil: string | null } {
  const now = nowIso();
  const attempts = db
    .prepare('UPDATE user_auth SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE user_id = ?')
    .run(now, userId);
  if (attempts.changes === 0) return { failedAttempts: 0, lockedUntil: null };

  const current = getByUserId(userId);
  if (!current) return { failedAttempts: 0, lockedUntil: null };

  if (current.failedAttempts >= maxAttempts) {
    const lockedUntil = new Date(Date.now() + lockMs).toISOString();
    db.prepare(
      'UPDATE user_auth SET locked_until = ?, failed_attempts = 0, updated_at = ? WHERE user_id = ?',
    ).run(lockedUntil, nowIso(), userId);
    return { failedAttempts: current.failedAttempts, lockedUntil };
  }
  return { failedAttempts: current.failedAttempts, lockedUntil: null };
}

/** 登录成功：清空失败计数与锁定 */
export function resetFailedAttempts(userId: string): void {
  db.prepare(
    'UPDATE user_auth SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?',
  ).run(nowIso(), userId);
}

/** 手动解锁（管理用途；首参仍是 userId） */
export function adminClearLock(userId: string): boolean {
  const result = db
    .prepare(
      'UPDATE user_auth SET locked_until = NULL, failed_attempts = 0, updated_at = ? WHERE user_id = ?',
    )
    .run(nowIso(), userId);
  return result.changes > 0;
}

/** 删除认证凭据（删除账号数据时用；外键级联之外再显式清一次） */
export function deleteByUserId(userId: string): number {
  return db.prepare('DELETE FROM user_auth WHERE user_id = ?').run(userId).changes;
}

// ============================================================
// user_sessions
// ============================================================

export interface UserSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  ip_prefix: string | null;
  issued_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** 行 → 实体：刻意**丢弃 token_hash**，实体里不带任何与 token 相关的材料 */
export function rowToUserSession(row: UserSessionRow): UserSession {
  return {
    id: row.id,
    userId: row.user_id,
    userAgent: row.user_agent,
    ipPrefix: row.ip_prefix,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export interface InsertSessionInput {
  sessionId?: string;
  /**
   * 可选：本函数的**第一个参数**就是 userId，这里留着只是为了让调用方能写成
   * `insertSession(userId, { userId, ... })` 这种自解释的形式（Repository 约定）。
   */
  userId?: string;
  tokenHash: string;
  userAgent?: string | null;
  ipPrefix?: string | null;
  issuedAt: string;
  expiresAt: string;
}

/** 建立会话（首参 userId） */
export function insertSession(userId: string, input: InsertSessionInput): UserSession {
  const now = nowIso();
  const id = input.sessionId ?? newId();
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, token_hash, user_agent, ip_prefix,
                                issued_at, expires_at, last_used_at, revoked_at, created_at)
     VALUES (@id, @user_id, @token_hash, @user_agent, @ip_prefix,
             @issued_at, @expires_at, @last_used_at, NULL, @created_at)`,
  ).run({
    id,
    user_id: userId,
    token_hash: input.tokenHash,
    user_agent: input.userAgent ?? null,
    ip_prefix: input.ipPrefix ?? null,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    last_used_at: now,
    created_at: now,
  });
  const created = getSession(userId, id);
  if (!created) throw new Error(`[DB] 寫入會話後讀不回來：${id}`);
  return created;
}

/** ★ 验签第二步：按 sha256(token) 查会话（此时 userId 来自 token 本身，故为约定例外） */
export function findByTokenHash(tokenHash: string): UserSessionRow | null {
  const row = db.prepare('SELECT * FROM user_sessions WHERE token_hash = ?').get(tokenHash) as
    | UserSessionRow
    | undefined;
  return row ?? null;
}

/** 取某用户的某个会话（带 userId 条件，天然隔离） */
export function getSession(userId: string, sessionId: string): UserSession | null {
  const row = db
    .prepare('SELECT * FROM user_sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId) as UserSessionRow | undefined;
  return row ? rowToUserSession(row) : null;
}

/** 列出会话（默认只看未吊销的） */
export function listSessions(userId: string, includeRevoked = false): UserSession[] {
  const sql = includeRevoked
    ? 'SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_used_at DESC'
    : 'SELECT * FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_used_at DESC';
  const rows = db.prepare(sql).all(userId) as UserSessionRow[];
  return rows.map(rowToUserSession);
}

/**
 * 滑动续期：更新 last_used_at（并按上限顺延 expires_at）。
 * 只在距上次更新超过 1 小时时才写库，避免每个请求都打一次 UPDATE。
 */
export function touchSession(
  sessionId: string,
  options: { at?: string; maxLifetimeMs?: number } = {},
): void {
  const at = options.at ?? nowIso();
  const maxLifetimeMs = options.maxLifetimeMs ?? 30 * 24 * 60 * 60 * 1000;
  const row = db.prepare('SELECT issued_at FROM user_sessions WHERE id = ?').get(sessionId) as
    | { issued_at: string }
    | undefined;
  if (!row) return;

  const issued = Date.parse(row.issued_at);
  // 绝对上限：签发时间 + 30 天，滑动续期不会无限延长
  const ceiling = Number.isFinite(issued) ? issued + maxLifetimeMs : Date.now() + maxLifetimeMs;
  const nextExpiry = new Date(Math.min(Date.now() + maxLifetimeMs, ceiling)).toISOString();

  db.prepare('UPDATE user_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(
    at,
    nextExpiry,
    sessionId,
  );
}

/** 吊销单个会话（登出） */
export function revokeSession(userId: string, sessionId: string): boolean {
  const result = db
    .prepare(
      'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .run(nowIso(), sessionId, userId);
  return result.changes > 0;
}

/**
 * 吊销该用户的全部会话（改密码 / 封禁）。
 * @param exceptSessionId 传了就保留这一条（改密码时不踢掉当前设备）
 */
export function revokeAllSessions(userId: string, exceptSessionId?: string): number {
  const now = nowIso();
  const result = exceptSessionId
    ? db
        .prepare(
          'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
        )
        .run(now, userId, exceptSessionId)
    : db
        .prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(now, userId);
  return result.changes;
}

/** 清理过期会话（维护用，与具体用户无关 → admin 前缀） */
export function adminDeleteExpiredSessions(now = nowIso()): number {
  return db
    .prepare('DELETE FROM user_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?')
    .run(now).changes;
}

/** 统计活跃会话数（/api/health 自检用） */
export function adminCountActiveSessions(): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE revoked_at IS NULL')
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}
