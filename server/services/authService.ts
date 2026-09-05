/**
 * 认证与会话服务（V2 · T02）
 *
 * ⛔ 硬约束：**零新增依赖**。只用 `node:crypto`。
 *    禁止 bcrypt / argon2 / passport / jsonwebtoken —— 本环境无法安装新包。
 *
 * 设计要点：
 * 1. 密码：`scryptSync(password, salt, 64, {N:16384, r:8, p:1})`，
 *    存自描述格式 `scrypt$N$r$p$saltB64$hashB64`（未来调参数不必重算全库）；
 *    比对用 `timingSafeEqual`（常数时间，防时序侧信道）。
 * 2. 会话 token：`base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))`；
 *    数据库**只存 sha256(token)**，绝不存明文。
 * 3. 校验两道：① 无状态验签（失败直接 401，不查库）→ ② 有状态吊销检查（支持登出/改密码立即失效）。
 * 4. 注册支持 `attachUserId`：**复用**匿名 users 行，老用户零数据迁移（设计文档 §9.1 场景 B）。
 * 5. 暴力破解保护：连续失败 10 次锁 15 分钟。
 */

import crypto from 'node:crypto';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { ApiError } from '../errors.js';
import { ErrorCode } from '../../shared/errors.js';
import db from '../db/index.js';
import { deriveIsMinor, nowIso } from '../db/helpers.js';
import * as authRepo from '../db/repositories/auth.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import type { User, UserSession } from '../../shared/types.js';

// ============================================================
// 常量
// ============================================================

/** scrypt 参数：与需求书一致（N=16384, r=8, p=1, 64 字节输出） */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;
/** 写进 user_auth.password_algo 的标签，未来换参数时用于识别旧格式 */
const PASSWORD_ALGO = 'scrypt-16384-8-1';
/** scrypt 内存上限：128 * N * r = 16MB，给到 64MB 留余量 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 会话绝对寿命 30 天（滑动续期不会超过它） */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 滑动续期：距上次写库超过 1 小时才更新一次，避免每个请求都打 DB */
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** 连续失败多少次上锁 */
export const MAX_FAILED_ATTEMPTS = 10;
/** 上锁时长 15 分钟 */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** 密码最短长度 */
export const MIN_PASSWORD_LENGTH = 8;
/** 密码最长长度（防止用超长密码打满 CPU） */
export const MAX_PASSWORD_LENGTH = 128;

/** 邮箱正则：只做基本形状校验，真正的所有权验证靠发信（P3） */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// ============================================================
// 密码
// ============================================================

/**
 * 生成密码哈希，格式 `scrypt$N$r$p$saltB64$hashB64`。
 * 自描述格式的用意：将来想把 N 调大到 32768 时，
 * 旧哈希仍能被正确验证，只需在用户下次登录时静默升级。
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * 常数时间比对密码。
 *
 * 注意：解析失败、格式不认识时返回 false 而不是抛错——
 * 抛错会让「坏数据」和「密码错误」在接口层面表现不同，反而泄漏信息。
 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (typeof stored !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1] as string, 10);
  const r = Number.parseInt(parts[2] as string, 10);
  const p = Number.parseInt(parts[3] as string, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (N <= 1 || r <= 0 || p <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  // timingSafeEqual 要求等长；长度不同本身就说明不匹配，但要走一次假比较保持常数时间
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ============================================================
// 输入校验
// ============================================================

/** 邮箱规范化：去空白 + 转小写（防 `A@x.com` 与 `a@x.com` 注册成两个账号） */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 邮箱格式校验 */
export function isValidEmail(email: string): boolean {
  const value = email.trim();
  if (value.length < 3 || value.length > 254) return false;
  return EMAIL_RE.test(value);
}

export interface PasswordCheck {
  ok: boolean;
  /** 不通过时给用户的繁中说明；通过时为空串 */
  reason: string;
}

/**
 * 密码强度校验：≥8 位，且同时含字母与数字。
 *
 * 这里刻意只做最低限度校验——陪伴类 App 不该逼用户造一个自己记不住的密码，
 * 真正的强度靠 bcrypt/scrypt 的抗爆破能力 + 失败锁定来兜。
 */
export function checkPassword(password: string): PasswordCheck {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `密碼至少要 ${MIN_PASSWORD_LENGTH} 個字` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `密碼最多 ${MAX_PASSWORD_LENGTH} 個字` };
  }
  if (!/[A-Za-z]/.test(password)) return { ok: false, reason: '密碼要有英文字母' };
  if (!/\d/.test(password)) return { ok: false, reason: '密碼要有數字' };
  return { ok: true, reason: '' };
}

/** 出生日期校验（选填；填了就必须是合法的 YYYY-MM-DD 且不晚于今天） */
export function isValidBirthDate(birthDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate.trim())) return false;
  const parsed = Date.parse(`${birthDate.trim()}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  // 回推校验：防止 2026-02-30 这种「能 parse 但会滚动」的日期
  const iso = new Date(parsed).toISOString().slice(0, 10);
  if (iso !== birthDate.trim()) return false;
  return parsed <= Date.now();
}

/** IP 脱敏：IPv4 取前 3 段，IPv6 取前 3 组，其余返回 null */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const clean = ip.trim();
  if (clean.includes(':')) {
    const groups = clean.split(':').filter(Boolean);
    return groups.length >= 3 ? `${groups.slice(0, 3).join(':')}::` : null;
  }
  const parts = clean.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : null;
}

// ============================================================
// 会话 token
// ============================================================

export interface SessionPayload {
  sid: string;
  uid: string;
  iat: number;
  exp: number;
}

export interface VerifyResult {
  userId: string;
  sessionId: string;
  expiresAt: string;
}

function b64u(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString('base64url') : Buffer.from(input, 'utf8').toString('base64url');
}

/** 对 payload 做 HMAC-SHA256 签名（base64url） */
function sign(payloadJson: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(payloadJson, 'utf8').digest('base64url');
}

/** 常数时间比较签名 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 无状态验签：只做 HMAC 比对 + exp 检查，**不查库** */
export function verifyTokenSignature(token: string): SessionPayload | null {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let payloadJson = '';
  try {
    payloadJson = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  // ① 先验签，签名对不上直接 401（不查库，也就不存在被枚举/打库的风险）
  if (!safeEqual(signature, sign(payloadJson))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(payloadJson) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.sid !== 'string' || typeof payload?.uid !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  return payload;
}

/** 滑动续期的节流表：sessionId → 上次写库时间 */
const lastTouch = new Map<string, number>();

export interface CreateSessionContext {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * 签发一个会话。
 * @returns token（只在这一次返回，之后只能靠 sha256 在库里认它）
 */
export function createSession(
  userId: string,
  context: CreateSessionContext = {},
): { token: string; session: UserSession; expiresAt: string } {
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();

  const payload: SessionPayload = { sid: sessionId, uid: userId, iat: now, exp: now + SESSION_TTL_MS };
  const payloadJson = JSON.stringify(payload);
  const token = `${b64u(payloadJson)}.${sign(payloadJson)}`;
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');

  const session = authRepo.insertSession(userId, {
    sessionId,
    tokenHash,
    userAgent: context.userAgent ?? null,
    ipPrefix: ipPrefix(context.ip),
    issuedAt: new Date(now).toISOString(),
    expiresAt,
  });

  lastTouch.set(sessionId, now);
  return { token, session, expiresAt };
}

/**
 * 完整校验一个 token（两道校验）。
 *
 * ① 无状态：HMAC 验签 + exp —— 失败直接返回 null，不查库；
 * ② 有状态：按 sha256(token) 查 user_sessions，确认未吊销、未过期、且 uid 与库里一致。
 *
 * @returns 校验通过返回 {userId, sessionId, expiresAt}；任何一步失败返回 null
 */
export function verifySession(token: string): VerifyResult | null {
  const payload = verifyTokenSignature(token);
  if (!payload) return null;

  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const row = authRepo.findByTokenHash(tokenHash);
  if (!row) return null;

  // ② 有状态吊销：登出 / 改密码 / 封禁 都在这里生效
  if (row.revoked_at !== null) return null;
  if (row.user_id !== payload.uid || row.id !== payload.sid) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  // 滑动续期（节流：最多一小时写一次库）
  const last = lastTouch.get(row.id) ?? 0;
  const now = Date.now();
  if (now - last > SESSION_TOUCH_INTERVAL_MS) {
    try {
      authRepo.touchSession(row.id, { maxLifetimeMs: SESSION_TTL_MS });
      lastTouch.set(row.id, now);
    } catch (err) {
      // 续期失败不影响本次请求：会话本身仍然有效，下次再试
      logger.warn('[Auth] 會話續期失敗', {
        sessionId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { userId: row.user_id, sessionId: row.id, expiresAt: row.expires_at };
}

/** 吊销当前会话（登出） */
export function revokeSessionByToken(token: string): boolean {
  const payload = verifyTokenSignature(token);
  if (!payload) return false;
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const row = authRepo.findByTokenHash(tokenHash);
  if (!row) return false;
  lastTouch.delete(row.id);
  return authRepo.revokeSession(row.user_id, row.id);
}

// ============================================================
// 对外服务：注册 / 登录 / 登出 / 改密码
// ============================================================

/** 出网用的账号信息（绝不含 passwordHash） */
export interface AccountInfo {
  user: User;
  /** 是否设置了密码（= 是否已注册） */
  hasPassword: boolean;
  /** 邮箱（未注册时为 null） */
  email: string | null;
  /** 未成年强化保护是否生效（选填出生日期才可能为 true） */
  isMinor: boolean;
  session: {
    id: string;
    issuedAt: string;
    expiresAt: string;
    lastUsedAt: string;
  } | null;
}

export interface AuthResult {
  user: User;
  hasPassword: boolean;
  email: string | null;
  isMinor: boolean;
  token: string;
  expiresAt: string;
  sessionId: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  /** 选填：填了才启用未成年强化保护（不填也受通用安全条款保护） */
  birthDate?: string | null;
  /**
   * 老匿名用户的 userId。传了就**复用**这一行 users（不新建、不迁移 → 零数据丢失），
   * 这也是「老用户注册后历史角色/记忆/会话一条不丢」的实现方式。
   */
  attachUserId?: string;
  timezone?: string;
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * 注册。
 *
 * 关键设计：`user_auth` 与 `users` 严格 1:1。
 * 传了 attachUserId 就复用已有的 users 行，只往 user_auth 插一条凭据——
 * 角色、记忆、会话、情绪、关系态全都原封不动，这是**零迁移**而不是「迁移后校验」。
 */
export function register(input: RegisterInput): AuthResult {
  const email = typeof input.email === 'string' ? input.email : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (!isValidEmail(email)) {
    throw new ApiError(ErrorCode.EMAIL_INVALID, undefined, {
      details: { field: 'email' },
    });
  }
  const passwordCheck = checkPassword(password);
  if (!passwordCheck.ok) {
    throw new ApiError(ErrorCode.PASSWORD_WEAK, passwordCheck.reason, {
      details: { field: 'password' },
    });
  }
  if (input.birthDate !== undefined && input.birthDate !== null && input.birthDate !== '') {
    if (!isValidBirthDate(input.birthDate)) {
      throw new ApiError(ErrorCode.VALIDATION, '出生日期不對', { details: { field: 'birthDate' } });
    }
  }

  const emailNormalized = normalizeEmail(email);

  // 决策 #4：邮箱已被占用 → 直接拒绝，不做账号合并
  if (authRepo.emailTaken(emailNormalized)) {
    throw new ApiError(ErrorCode.EMAIL_TAKEN);
  }

  const attachUserId = input.attachUserId?.trim() ?? '';

  // 建用户 + 写凭据放在同一个事务里：任一步失败都不会留下「有 users 没凭据」的孤儿账号
  const apply = db.transaction((): string => {
    let userId: string;

    if (attachUserId) {
      const existing = usersRepo.getById(attachUserId);
      if (existing) {
        if (authRepo.hasPassword(attachUserId)) {
          throw new ApiError(ErrorCode.ALREADY_REGISTERED);
        }
        // ★ 复用这一行 users：角色 / 记忆 / 会话 / 情绪 / 关系态全部原封不动
        userId = attachUserId;
        if (input.displayName && input.displayName.trim()) {
          usersRepo.updateDisplayName(userId, input.displayName.trim().slice(0, 40));
        }
      } else {
        // 本地匿名 id 在后端不存在（例如 ALLOW_ANONYMOUS=0 时从未建立匿名账号）。
        // 不能拿它当「复用」依据，否则注册会因悬空 id 直接报 USER_NOT_FOUND；
        // 这里退化为新建一个账号，保证注册必定成功。
        userId = usersRepo.adminCreateUser({
          displayName: (input.displayName ?? '').trim().slice(0, 40),
          timezone: input.timezone ?? undefined,
        }).id;
      }
    } else {
      userId = usersRepo.adminCreateUser({
        displayName: (input.displayName ?? '').trim().slice(0, 40),
        timezone: input.timezone ?? undefined,
      }).id;
    }

    if (input.birthDate) {
      usersRepo.updateBirthDate(userId, input.birthDate.trim());
    }

    authRepo.insertAuth({
      userId,
      email: email.trim(),
      emailNormalized,
      passwordHash: hashPassword(password),
      passwordAlgo: PASSWORD_ALGO,
    });

    return userId;
  });

  let userId: string;
  try {
    userId = apply();
  } catch (err) {
    // 并发注册同一个邮箱：UNIQUE 冲突 → 转成业务错误码（不能用 500）
    if (err instanceof Error && /UNIQUE constraint failed: user_auth/.test(err.message)) {
      throw new ApiError(ErrorCode.EMAIL_TAKEN);
    }
    throw err;
  }

  const { token, expiresAt, session } = createSession(userId, {
    userAgent: input.userAgent,
    ip: input.ip,
  });

  const user = usersRepo.getById(userId);
  if (!user) throw new ApiError(ErrorCode.DB_ERROR, '註冊後讀不回使用者');

  logger.info('[Auth] 註冊成功', { userId, attached: Boolean(attachUserId) });

  return {
    user,
    hasPassword: true,
    email: email.trim(),
    isMinor: user.isMinor,
    token,
    expiresAt,
    sessionId: session.id,
  };
}

export interface LoginInput {
  email: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}

/** 登录：失败计数 + 15 分钟锁定都在这里 */
export function login(input: LoginInput): AuthResult {
  const email = typeof input.email === 'string' ? input.email : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const emailNormalized = normalizeEmail(email);

  const auth = authRepo.findByEmailNormalized(emailNormalized);

  // 账号不存在时也走一遍「假比对」，让响应耗时与密码错误时接近（防账号枚举时序侧信道）
  const storedHash = auth?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
  const passwordOk = verifyPassword(password, storedHash);

  if (!auth) {
    throw new ApiError(ErrorCode.INVALID_CREDENTIALS);
  }

  // 锁定检查
  if (auth.lockedUntil && Date.parse(auth.lockedUntil) > Date.now()) {
    const minutes = Math.max(1, Math.ceil((Date.parse(auth.lockedUntil) - Date.now()) / 60_000));
    throw new ApiError(ErrorCode.ACCOUNT_LOCKED, `錯誤次數太多，請 ${minutes} 分鐘後再試`);
  }

  if (!passwordOk) {
    const state = authRepo.bumpFailedAttempts(
      auth.userId,
      MAX_FAILED_ATTEMPTS,
      LOCK_DURATION_MS,
    );
    logger.warn('[Auth] 登入失敗', {
      userId: auth.userId,
      failedAttempts: state.failedAttempts,
      locked: Boolean(state.lockedUntil),
    });
    if (state.lockedUntil) throw new ApiError(ErrorCode.ACCOUNT_LOCKED);
    throw new ApiError(ErrorCode.INVALID_CREDENTIALS);
  }

  authRepo.resetFailedAttempts(auth.userId);

  const { token, expiresAt, session } = createSession(auth.userId, {
    userAgent: input.userAgent,
    ip: input.ip,
  });

  const user = usersRepo.getById(auth.userId);
  if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND);

  logger.info('[Auth] 登入成功', { userId: auth.userId });
  return {
    user,
    hasPassword: true,
    email: auth.email,
    isMinor: user.isMinor,
    token,
    expiresAt,
    sessionId: session.id,
  };
}

/** 当前账号信息（/api/auth/me） */
export function me(userId: string, sessionId: string | null): AccountInfo {
  const user = usersRepo.getById(userId);
  if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND);
  const auth = authRepo.getByUserId(userId);
  const session = sessionId ? authRepo.getSession(userId, sessionId) : null;

  return {
    user,
    hasPassword: Boolean(auth),
    email: auth?.email ?? null,
    isMinor: user.isMinor,
    session: session
      ? {
          id: session.id,
          issuedAt: session.issuedAt,
          expiresAt: session.expiresAt,
          lastUsedAt: session.lastUsedAt,
        }
      : null,
  };
}

export interface ChangePasswordResult {
  ok: true;
  /** 被踢掉的其他设备数（当前设备保留登录态） */
  revokedSessions: number;
}

/**
 * 改密码。
 * 成功后**吊销该用户的其它所有会话**（当前这台保留）——
 * 这样「改密码后其他会话立即失效」是数据库层面保证的，不是靠前端自觉。
 */
export function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
  currentSessionId: string | null,
): ChangePasswordResult {
  const auth = authRepo.getByUserId(userId);
  if (!auth) throw new ApiError(ErrorCode.AUTH_REQUIRED, '這個帳號還沒設定密碼');

  if (!verifyPassword(oldPassword ?? '', auth.passwordHash)) {
    throw new ApiError(ErrorCode.INVALID_CREDENTIALS, '目前的密碼不對');
  }

  const check = checkPassword(newPassword ?? '');
  if (!check.ok) throw new ApiError(ErrorCode.PASSWORD_WEAK, check.reason);

  if (verifyPassword(newPassword, auth.passwordHash)) {
    throw new ApiError(ErrorCode.VALIDATION, '新密碼不能和舊密碼一樣');
  }

  authRepo.updatePassword(userId, hashPassword(newPassword), PASSWORD_ALGO);
  const revoked = authRepo.revokeAllSessions(userId, currentSessionId ?? undefined);

  logger.info('[Auth] 密碼已變更', { userId, revokedSessions: revoked });
  return { ok: true, revokedSessions: revoked };
}

/**
 * 更新出生日期（未成年保护）。
 *
 * 强调：出生日期**选填**。不填只是拿不到未成年强化层，
 * L0 通用安全条款对所有用户无条件生效——不存在「不填就能绕过保护」。
 */
export function updateBirthDate(userId: string, birthDate: string | null): AccountInfo {
  if (birthDate && !isValidBirthDate(birthDate)) {
    throw new ApiError(ErrorCode.VALIDATION, '出生日期不對');
  }
  const user = usersRepo.updateBirthDate(userId, birthDate ? birthDate.trim() : null);
  if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND);
  return me(userId, null);
}

/** 列出我的未吊销会话（账号页「登录了哪些设备」） */
export function listMySessions(userId: string): UserSession[] {
  return authRepo.listSessions(userId, false);
}

/** 踢掉我名下的一条会话；不是自己的会话返回 false（天然防越权） */
export function revokeMySession(userId: string, sessionId: string): boolean {
  return authRepo.revokeSession(userId, sessionId);
}

/** 删除账号的全部凭据与会话（删除数据前调用，保证删完就登出） */
export function purgeCredentials(userId: string): { auth: number; sessions: number } {
  const sessions = authRepo.revokeAllSessions(userId);
  const auth = authRepo.deleteByUserId(userId);
  return { auth, sessions };
}

/** 判断某段文本是否来自未注册（匿名）用户——供 http.ts 的回落判断使用 */
export function isRegistered(userId: string): boolean {
  return authRepo.hasPassword(userId);
}

/**
 * 未成年的派生入口（T04 安全策略会用）。
 * 单独暴露一个函数，是为了让「未成年」的判定口径在全项目只有一处。
 */
export function isMinorUser(userId: string): boolean {
  const user = usersRepo.getById(userId);
  return user ? user.isMinor || deriveIsMinor(user.birthDate) : false;
}

/** 距下次会话过期的毫秒数（前端可用于静默刷新提示；当前未启用自动刷新） */
export function msUntilExpiry(expiresAt: string): number {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return 0;
  return Math.max(0, exp - Date.now());
}

/** 当前时间（ISO）——统一出口，方便测试时替换 */
export function currentIso(): string {
  return nowIso();
}
