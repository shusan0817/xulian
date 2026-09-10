/**
 * 把本地 SQLite（server/data/xulian.db）的 Schema 与数据迁移到 Turso / libSQL 云端
 *
 * 用法
 * ----
 *   TURSO_DATABASE_URL=libsql://your-db-org.turso.io \
 *   TURSO_AUTH_TOKEN=eyJhbGciOi... \
 *   npx tsx scripts/migrate-to-turso.ts
 *
 * 可选环境变量
 * ------------
 *   XULIAN_DB_PATH   源库路径，默认 server/data/xulian.db
 *   --dry-run        只打印「会迁移什么」，不写入云端
 *
 * 安全保证
 * --------
 * - **绝不删除或改动本地文件**（本地库以只读方式打开）；
 * - 建表用项目自带的 `server/db/schema.sql` + `runMigrations()`，与代码期望的表结构完全一致，
 *   不会凭空新建表、也不会重复创建（`CREATE TABLE IF NOT EXISTS`）；
 * - 写数据用 `INSERT OR REPLACE`，因此脚本可以反复执行（幂等）；
 * - 目标库不存在的表 / 列会跳过并明确报告，不会中断整个迁移。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { env } from '../server/env.js';
import { logger } from '../server/logger.js';
import { runMigrations } from '../server/db/migrations.js';
import { openDatabase } from '../server/db/driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', 'server', 'db', 'schema.sql');

const DRY_RUN = process.argv.includes('--dry-run');

/** 单条语句的绑定变量上限保守取 900（SQLite 老版本为 999） */
const MAX_BIND_PARAMS = 900;

interface TableReport {
  table: string;
  sourceRows: number;
  migratedRows: number;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
}

/** 一行结果 */
type Row = Record<string, unknown>;

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * 读取某张表的列名（按表定义顺序）。
 * 云端 libSQL 不一定支持 PRAGMA，失败时返回 null，由调用方决定兜底策略。
 */
function readColumns(db: BetterSqlite3.Database, table: string): string[] | null {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.map((r) => r.name);
  } catch (err) {
    logger.warn('[migrate] 讀取欄位失敗', {
      table,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 给标识符加双引号并转义内部双引号，防止表名/列名带特殊字符时拼错 SQL */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 读取库里所有用户表名（排除 sqlite_* 内部表） */
function readUserTables(db: BetterSqlite3.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** 统计某张表的行数 */
function countRows(db: BetterSqlite3.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/** 目标库是否已有这张表 */
function tableExists(db: BetterSqlite3.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok: number } | undefined;
  return row?.ok === 1;
}

/** 尽力执行一条 pragma，云端不支持就跳过（不崩） */
function tryPragma(db: { pragma?: (source: string) => unknown }, source: string): void {
  try {
    db.pragma?.(source);
  } catch (err) {
    logger.warn('[migrate] 目標庫不支援 pragma，已跳過', {
      source,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function main(): void {
  console.log('\n需恋 · 本地 SQLite → Turso 迁移工具\n');

  // ------------------------------------------------------------
  // 1. 校验配置
  // ------------------------------------------------------------
  if (!env.tursoUrl || !env.tursoAuthToken) {
    fail(
      '缺少 Turso 配置。请设置两个环境变量后重试：\n' +
        '  TURSO_DATABASE_URL=libsql://your-db-org.turso.io\n' +
        '  TURSO_AUTH_TOKEN=eyJhbGciOi...\n\n' +
        '获取方式：turso db create xulian && turso db show xulian --url && turso db tokens create xulian'
    );
  }

  const sourcePath = env.dbPath;
  if (!fs.existsSync(sourcePath)) {
    fail(`源数据库不存在：${sourcePath}\n（若云端库是全新的、本地也没有数据，则无需迁移，直接部署即可。）`);
  }

  console.log(`源库（只读）  : ${sourcePath}`);
  console.log(`目标库        : ${env.tursoUrl.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`模式          : ${DRY_RUN ? 'DRY-RUN（只预览，不写入）' : '正式迁移'}\n`);

  // ------------------------------------------------------------
  // 2. 打开源库（只读，绝不修改本地文件）
  // ------------------------------------------------------------
  const source = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  const sourceTables = readUserTables(source);
  console.log(`源库共 ${sourceTables.length} 张表：${sourceTables.join(', ')}\n`);

  if (DRY_RUN) {
    for (const table of sourceTables) {
      console.log(`  · ${table.padEnd(32)} ${countRows(source, table)} 行`);
    }
    console.log('\nDRY-RUN 结束，未写入任何数据。\n');
    source.close();
    return;
  }

  // ------------------------------------------------------------
  // 3. 打开目标库，并建表 / 跑迁移（与代码期望的结构完全一致）
  // ------------------------------------------------------------
  const opened = openDatabase();
  if (opened.mode !== 'turso') {
    source.close();
    fail('目标库没有走云端模式（TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 未同时生效），已中止以免误写本地库。');
  }
  const target = opened.db;

  console.log('── 建立目标库表结构 ──');
  target.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const version = runMigrations(target);
  console.log(`  ✓ schema.sql 已套用，迁移版本 = ${version}\n`);

  // 导入期间临时关掉外键约束，避免「先插子表后插父表」被 FK 拦住
  tryPragma(target, 'foreign_keys = OFF');

  // ------------------------------------------------------------
  // 4. 逐表复制数据
  // ------------------------------------------------------------
  console.log('── 复制数据 ──');
  const reports: TableReport[] = [];

  for (const table of sourceTables) {
    if (!tableExists(target, table)) {
      reports.push({
        table,
        sourceRows: countRows(source, table),
        migratedRows: 0,
        status: 'skipped',
        note: '目标库没有这张表（可能已被新 schema 移除）',
      });
      continue;
    }

    const sourceCols = readColumns(source, table) ?? [];
    const targetCols = readColumns(target, table);
    // 云端读不到字段清单时，信任源库字段（本地库本来就是同一套 schema 跑出来的）
    const columns = targetCols ? sourceCols.filter((c) => targetCols.includes(c)) : sourceCols;
    const missingCols = targetCols ? sourceCols.filter((c) => !targetCols.includes(c)) : [];

    if (columns.length === 0) {
      reports.push({
        table,
        sourceRows: countRows(source, table),
        migratedRows: 0,
        status: 'skipped',
        note: '没有任何共同列，跳过',
      });
      continue;
    }

    const sourceRows = countRows(source, table);
    const columnList = columns.map(quoteIdent).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT OR REPLACE INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders})`;

    try {
      const insert = target.prepare(insertSql);
      // 按绑定变量上限分批，避免超出 SQLITE_MAX_VARIABLE_NUMBER
      const batchSize = Math.max(1, Math.floor(MAX_BIND_PARAMS / columns.length));
      const pagedSelect = source.prepare(
        `SELECT ${columnList} FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`
      );

      let migrated = 0;
      let offset = 0;
      while (offset < sourceRows) {
        const rows = pagedSelect.all(batchSize, offset) as Row[];
        if (rows.length === 0) break;
        const apply = target.transaction(() => {
          for (const row of rows) {
            insert.run(...columns.map((c) => row[c] ?? null));
          }
        });
        apply();
        migrated += rows.length;
        offset += batchSize;
      }

      reports.push({
        table,
        sourceRows,
        migratedRows: migrated,
        status: 'ok',
        note: missingCols.length > 0 ? `目标库缺少列：${missingCols.join(', ')}（已忽略）` : undefined,
      });
    } catch (err) {
      reports.push({
        table,
        sourceRows,
        migratedRows: 0,
        status: 'failed',
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 恢复外键约束
  tryPragma(target, 'foreign_keys = ON');

  // ------------------------------------------------------------
  // 5. 输出报告
  // ------------------------------------------------------------
  let failed = 0;
  for (const r of reports) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'skipped' ? '·' : '✗';
    if (r.status === 'failed') failed += 1;
    console.log(
      `  ${icon} ${r.table.padEnd(32)} ${String(r.migratedRows).padStart(6)}/${String(r.sourceRows).padEnd(6)} 行` +
        (r.note ? `  （${r.note}）` : '')
    );
  }

  console.log('\n── 校验目标库 ──');
  let mismatched = 0;
  for (const r of reports) {
    if (r.status !== 'ok') continue;
    const targetCount = countRows(target, r.table);
    const same = targetCount === r.sourceRows;
    if (!same) mismatched += 1;
    console.log(`  ${same ? '✓' : '✗'} ${r.table.padEnd(32)} 云端 ${targetCount} 行 / 本地 ${r.sourceRows} 行`);
  }

  console.log(`\n本地文件保持原样，未做任何删除：${sourcePath}\n`);

  source.close();
  opened.db.close();

  if (failed > 0 || mismatched > 0) {
    console.error(`✗ 迁移未完全成功：${failed} 张表失败、${mismatched} 张表行数不一致\n`);
    process.exit(1);
  }
  console.log('✓ 迁移完成\n');
}

main();
