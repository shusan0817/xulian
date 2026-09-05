/**
 * SQLite 连接单例 + 建表 + 迁移
 *
 * 由原 `server/db.ts`（227 行）重构而来：
 * - 保留 better-sqlite3 同步 API 与 WAL；
 * - DDL 抽到 `schema.sql`，迁移抽到 `migrations.ts`，CRUD 抽到 `repositories/*.repo.ts`；
 * - 本文件只负责「把连接准备好」，不再承担任何业务查询。
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { runMigrations } from './migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, 'schema.sql');

// ------------------------------------------------------------
// 1. 确保数据目录存在
// ------------------------------------------------------------
const dbPath = env.dbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// ------------------------------------------------------------
// 2. 打开连接
// ------------------------------------------------------------
export const db: Database.Database = new Database(dbPath);

// WAL：读写并发更好，且崩溃后恢复更快（单文件部署场景足够）
db.pragma('journal_mode = WAL');
// 外键级联必须每条连接单独打开，否则 ON DELETE CASCADE 不生效
db.pragma('foreign_keys = ON');
// 并发写时最多等 5 秒再报 SQLITE_BUSY，避免瞬时抖动直接炸请求
db.pragma('busy_timeout = 5000');
// NORMAL 在 WAL 模式下已足够安全，且明显比 FULL 快
db.pragma('synchronous = NORMAL');

// ------------------------------------------------------------
// 3. 建表 + 迁移
// ------------------------------------------------------------
try {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  const version = runMigrations(db);
  logger.info('[DB] 資料庫已就緒', { path: dbPath, schemaVersion: version });
} catch (err) {
  logger.error('[DB] 初始化失敗', { err, path: dbPath });
  throw err;
}

// ------------------------------------------------------------
// 4. 辅助
// ------------------------------------------------------------

/** 健康检查：跑一条最便宜的查询，确认连接还活着 */
export function dbHealth(): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch (err) {
    logger.error('[DB] 健康檢查失敗', { err });
    return false;
  }
}

/** 关闭连接（进程退出时调用） */
export function closeDb(): void {
  try {
    db.close();
    logger.info('[DB] 連線已關閉', {});
  } catch (err) {
    logger.warn('[DB] 關閉連線時發生錯誤', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export default db;
