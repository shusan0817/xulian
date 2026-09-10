/**
 * SQLite 连接单例 + 建表 + 迁移
 *
 * 由原 `server/db.ts`（227 行）重构而来：
 * - 保留 better-sqlite3 同步 API 与 WAL；
 * - DDL 抽到 `schema.sql`，迁移抽到 `migrations.ts`，CRUD 抽到 `repositories/*.repo.ts`；
 * - 本文件只负责「把连接准备好」，不再承担任何业务查询。
 *
 * 持久化：底层驱动由 `./driver.ts` 决定 ——
 * 配了 `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` 就走云端 libSQL（Render 重启不丢数据），
 * 否则走本地文件（与改造前完全一致）。两种模式对外的同步 API 完全一致，
 * 所以 `repositories/*.repo.ts` 无需任何改动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { runMigrations } from './migrations.js';
import { openDatabase, type DbMode } from './driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, 'schema.sql');

// ------------------------------------------------------------
// 1. 打开连接（本地文件 / 云端 Turso，由 driver 决定）
// ------------------------------------------------------------
const opened = openDatabase();

/** 数据库连接：类型仍为 better-sqlite3 的 Database，repositories 用法不变 */
export const db = opened.db;

/** 实际驱动模式：'local' = 本地文件；'turso' = 云端 libSQL */
export const dbMode: DbMode = opened.mode;

/** 连接目标描述（云端已脱敏），仅用于日志与健康检查 */
export const dbTarget: string = opened.target;

// ------------------------------------------------------------
// 2. 建表 + 迁移
// ------------------------------------------------------------
try {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  const version = runMigrations(db);
  logger.info('[DB] 資料庫已就緒', {
    mode: dbMode,
    target: dbTarget,
    schemaVersion: version,
  });
} catch (err) {
  logger.error('[DB] 初始化失敗', { err, mode: dbMode, target: dbTarget });
  throw err;
}

// ------------------------------------------------------------
// 3. 辅助
// ------------------------------------------------------------

/** 健康检查：跑一条最便宜的查询，确认连接还活着 */
export function dbHealth(): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch (err) {
    logger.error('[DB] 健康檢查失敗', { err, mode: dbMode });
    return false;
  }
}

/** 关闭连接（进程退出时调用） */
export function closeDb(): void {
  try {
    db.close();
    logger.info('[DB] 連線已關閉', { mode: dbMode });
  } catch (err) {
    logger.warn('[DB] 關閉連線時發生錯誤', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export default db;
