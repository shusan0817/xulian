/**
 * 数据库驱动适配层：本地 better-sqlite3 / 云端 Turso libSQL
 *
 * 背景
 * ----
 * Render 免费实例的文件系统是**临时盘**，重启或重新部署后 `server/data/xulian.db` 会被清空，
 * 用户账号、聊天记录、记忆、故事会全部丢失。解决办法是把数据放到云上（Turso / libSQL）。
 *
 * 约束
 * ----
 * 全项目 `server/db/repositories/*.repo.ts` 都依赖 better-sqlite3 的**同步** API：
 * `db.prepare(sql).get() / .all() / .run()`、`db.exec()`、`db.transaction()`、`db.pragma()`。
 * 改成异步客户端（`@libsql/client` 的 `execute()`）会导致全项目重写，风险极高。
 *
 * 因此本层的核心目标是：
 *
 *   **无论底层是本地文件还是云端 Turso，对外都保持同步 API 完全一致，repositories 一行都不用改。**
 *
 * 行为（二选一）
 * ------------
 * - `TURSO_DATABASE_URL` 与 `TURSO_AUTH_TOKEN` **同时非空** → 云端模式（libSQL，`libsql://` / `wss://`）
 * - 否则 → 本地文件模式（better-sqlite3 + `env.dbPath`），**行为与改造前零差异**
 *
 * 差异抹平点（libSQL 与 better-sqlite3 的已知差异，全部在本文件内消化）
 * ------------------------------------------------------------------
 * 1. libSQL 的 `statement.get()` 会额外返回一个 `_metadata` 字段 —— 必须剥掉，
 *    否则会污染 repository 返回给业务层的行对象（甚至泄漏到 API 响应里）；
 * 2. libSQL 的 `run()` 结果里 `lastInsertRowid` 可能是 bigint —— 统一转成 number；
 * 3. 云端连接不支持部分 pragma —— 逐条容错（跳过 + 记日志），绝不让进程崩；
 * 4. 云端连接可能不支持一次 `exec()` 多条语句 —— 退化为按分号切分后逐条执行。
 */

import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import Libsql from 'libsql';
import { env } from '../env.js';
import { logger } from '../logger.js';

/** 驱动模式：local = 本地文件；turso = 云端 libSQL */
export type DbMode = 'local' | 'turso';

/** better-sqlite3 的连接类型（对外统一用它，保证 repositories 的类型推断完全不变） */
export type AppDatabase = BetterSqlite3.Database;

/** 通用行对象 */
type Row = Record<string, unknown>;

/** libSQL 的 run() 结果：比 better-sqlite3 多一个 duration 字段 */
interface RawRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
  duration?: number;
}

/** libSQL 原生 prepared statement（只声明本层用到的部分） */
interface RawStatement {
  run(...params: unknown[]): RawRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** libSQL 原生 database（只声明本层用到的部分） */
interface RawLibsqlDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): unknown;
  close(): void;
  pragma?(source: string, options?: unknown): unknown;
  transaction?<F extends (...args: never[]) => unknown>(fn: F): F;
}

/**
 * libsql 包自带的 .d.ts 落后于实现（缺 `authToken`），这里补一个最小构造签名，
 * 避免为了一个字段去改 node_modules 或整包 `any`。
 */
interface LibsqlConstructor {
  new (url: string, options?: { authToken?: string; timeout?: number }): RawLibsqlDatabase;
}

/** 统一取错误信息 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** bigint / string 统一转 number，转换不了就给 0（lastInsertRowid 只用于回读，0 是安全兜底） */
function toRowId(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * 剥掉 libSQL 在 `get()` 结果里附加的 `_metadata` 字段。
 * 非对象（null / 原始值）原样返回，保证与 better-sqlite3 行为一致。
 */
function stripMetadata(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
  const record = row as Row;
  if (!('_metadata' in record)) return record;
  const clean: Row = {};
  for (const key of Object.keys(record)) {
    if (key === '_metadata') continue;
    clean[key] = record[key];
  }
  return clean;
}

/**
 * 把一段可能包含多条语句的 SQL 按 `;` 切分。
 * 只在云端 `exec()` 批量执行失败时作为兜底，因此必须正确处理：
 * 字符串字面量（单引号 / 双引号 / 反引号）、`--` 行注释、C 风格块注释。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const push = (): void => {
    const text = current.trim();
    if (text) statements.push(text);
    current = '';
  };

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        current += '\n';
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle || inDouble || inBacktick) {
      current += ch;
      if (ch === "'" && inSingle) inSingle = false;
      else if (ch === '"' && inDouble) inDouble = false;
      else if (ch === '`' && inBacktick) inBacktick = false;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return statements;
}

/**
 * 把 libSQL 客户端包装成 better-sqlite3 的同步 API。
 *
 * 只实现项目实际用到的子集：`prepare` / `exec` / `transaction` / `pragma` / `close`。
 * （全项目对 `db` 的调用面已核实：repositories 用 prepare + transaction，migrations 用 exec + transaction，
 *   authService 用 transaction，index.ts 用 pragma + exec + prepare + close。）
 */
class LibsqlDatabase {
  readonly name: string;
  readonly open = true;
  readonly memory = false;
  readonly readonly = false;
  readonly inTransaction = false;

  private readonly raw: RawLibsqlDatabase;

  constructor(raw: RawLibsqlDatabase, url: string) {
    this.raw = raw;
    this.name = url;
  }

  /** 预处理一条 SQL，返回与 better-sqlite3 行为一致的同步 statement */
  prepare(sql: string): unknown {
    return new LibsqlStatement(this.raw.prepare(sql));
  }

  /**
   * 执行一段（可能多语句的）SQL。
   * 云端连接若不支持批量执行，退化为逐条执行；逐条阶段任一语句失败仍会抛出（不做静默吞错）。
   */
  exec(sql: string): void {
    try {
      this.raw.exec(sql);
      return;
    } catch (err) {
      logger.warn('[DB] libSQL 批量執行失敗，改為逐條執行', {
        message: errorMessage(err),
      });
    }
    for (const statement of splitSqlStatements(sql)) {
      this.raw.exec(statement);
    }
  }

  /** 事务：直接复用 libSQL 官方实现（内部走 BEGIN / COMMIT / ROLLBACK） */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    if (typeof this.raw.transaction !== 'function') {
      logger.warn('[DB] libSQL 連線不支援交易，已降級為直接執行', {});
      return fn;
    }
    return this.raw.transaction(fn);
  }

  /** pragma：云端可能不支持，失败只记日志并返回空数组，绝不让进程崩 */
  pragma(source: string, options?: unknown): unknown {
    try {
      return this.raw.pragma?.(source, options) ?? [];
    } catch (err) {
      logger.warn('[DB] libSQL 不支援此 pragma，已跳過', {
        source,
        message: errorMessage(err),
      });
      return [];
    }
  }

  close(): void {
    this.raw.close();
  }
}

/** 抹平 `get()` 的 `_metadata` 与 `run()` 的 bigint rowid 的 statement 包装 */
class LibsqlStatement {
  private readonly raw: RawStatement;

  constructor(raw: RawStatement) {
    this.raw = raw;
  }

  run(...params: unknown[]): BetterSqlite3.RunResult {
    const result = this.raw.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: toRowId(result.lastInsertRowid),
    };
  }

  get(...params: unknown[]): unknown {
    return stripMetadata(this.raw.get(...params));
  }

  all(...params: unknown[]): unknown[] {
    const rows = this.raw.all(...params);
    return Array.isArray(rows) ? rows.map(stripMetadata) : [];
  }
}

/** 打开数据库后返回的结果 */
export interface OpenedDatabase {
  /** 对外统一按 better-sqlite3 的 Database 类型暴露，repositories 无需任何改动 */
  db: AppDatabase;
  /** 实际使用的驱动模式 */
  mode: DbMode;
  /** 连接目标描述（云端 URL 已抹掉 userinfo） */
  target: string;
}

/** 建连后统一应用的 pragma（与改造前本地模式完全一致） */
const PRAGMAS: readonly string[] = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'synchronous = NORMAL',
];

/** 抹掉 URL 里的 userinfo，避免日志泄露凭证 */
function maskDbUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    // 不是标准 URL（例如 file: 路径）时，简单截断即可
    return url.length > 60 ? `${url.slice(0, 60)}...` : url;
  }
}

/**
 * 打开数据库：
 * - 两个 Turso 变量都非空 → 云端 libSQL；
 * - 否则 → 本地 better-sqlite3 文件（与改造前完全一致）。
 */
export function openDatabase(): OpenedDatabase {
  const hasUrl = Boolean(env.tursoUrl);
  const hasToken = Boolean(env.tursoAuthToken);

  if (hasUrl && hasToken) {
    return openTurso();
  }
  if (hasUrl !== hasToken) {
    const missing = hasUrl ? 'TURSO_AUTH_TOKEN' : 'TURSO_DATABASE_URL';
    logger.warn('[DB] Turso 設定不完整，已回落到本地檔案模式', { missing });
  }
  return openLocal();
}

/** 本地文件模式：与改造前逐行等价（同路径、同 pragma、同顺序） */
function openLocal(): OpenedDatabase {
  const dbPath = env.dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new BetterSqlite3(dbPath);
  // WAL：读写并发更好，且崩溃后恢复更快（单文件部署场景足够）
  db.pragma('journal_mode = WAL');
  // 外键级联必须每条连接单独打开，否则 ON DELETE CASCADE 不生效
  db.pragma('foreign_keys = ON');
  // 并发写时最多等 5 秒再报 SQLITE_BUSY，避免瞬时抖动直接炸请求
  db.pragma('busy_timeout = 5000');
  // NORMAL 在 WAL 模式下已足够安全，且明显比 FULL 快
  db.pragma('synchronous = NORMAL');

  return { db, mode: 'local', target: dbPath };
}

/** 云端 Turso / libSQL 模式 */
function openTurso(): OpenedDatabase {
  const url = env.tursoUrl;
  const LibsqlCtor = Libsql as unknown as LibsqlConstructor;
  const raw = new LibsqlCtor(url, { authToken: env.tursoAuthToken });

  const libsqlDb = new LibsqlDatabase(raw, url);
  const db = libsqlDb as unknown as AppDatabase;

  // 云端模式下 WAL / synchronous 由服务端托管，客户端 pragma 可能不被支持：
  // LibsqlDatabase.pragma() 已逐条容错，这里再包一层 try/catch 兜底。
  for (const pragma of PRAGMAS) {
    try {
      db.pragma(pragma);
    } catch (err) {
      logger.warn('[DB] 雲端模式略過 pragma', {
        pragma,
        message: errorMessage(err),
      });
    }
  }

  return { db, mode: 'turso', target: maskDbUrl(url) };
}
