/**
 * 版本化迁移
 *
 * 设计要点：
 * - `schema_meta` 表里的 `version` 记录当前版本号；
 * - 每次启动读取当前版本，按顺序执行 version 更大的迁移，**在事务内**执行，失败整体回滚；
 * - 迁移必须幂等（可重复执行），因为开发期会频繁重建/切换分支；
 * - v1 的基线就是 `schema.sql`，所以 v1 的 up() 是空操作（建表由 IF NOT EXISTS 的 DDL 完成）；
 * - v2 = V2 增量的 6 处 ALTER + 四档等级回填（设计文档 §2.3 / §3.1）。
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../logger.js';
import { TIER_LEVELS, tierFromLevel, type ProactivityTier } from '../../shared/constants.js';

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

// ============================================================
// 幂等 DDL 辅助
// ============================================================

/** SQLite 的 ADD COLUMN 不支持参数化标识符，这里白名单校验后拼进 SQL */
function assertIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`[DB] 非法識別字：${name}`);
  }
  return name;
}

/** 判断表里是否已有某列（靠 PRAGMA table_info，天然幂等） */
export function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${assertIdent(table)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

/**
 * 幂等地加列：列已存在则跳过。
 * @param ddlFragment 列定义片段，例如 `TEXT NOT NULL DEFAULT 'free'`
 * @returns 是否真的执行了 ADD COLUMN
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  ddlFragment: string,
): boolean {
  if (hasColumn(db, table, column)) return false;
  db.exec(
    `ALTER TABLE ${assertIdent(table)} ADD COLUMN ${assertIdent(column)} ${ddlFragment}`,
  );
  logger.info('[DB] 新增欄位', { table, column });
  return true;
}

/** 读/写 schema_meta 里的任意标记位（用于「只做一次」类操作） */
function getMetaFlag(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMetaFlag(db: Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// ============================================================
// 迁移 v2：四档等级回填
// ============================================================

/**
 * 回填标记位。
 *
 * 为什么要单独一个标记：把 tier 写成 `TIER_LEVELS[tier]` 之后，
 * `companion` 的镜像值是 0.65，而 0.65 按 §3.1 的区间映射会落回 `active`——
 * 也就是说「level → tier」在 companion 上**不是不动点**，重跑会把用户后来
 * 手动选的「陪伴」档悄悄降成「活躍」。
 * 迁移本身只跑一次（version 门控已经保证），这里再加一个标记位做双保险：
 * 即使有人手动把 schema 版本号改回去，也绝不会覆盖用户已经选过的档位。
 */
const TIER_BACKFILL_FLAG = 'migration.v2.tierBackfill';

/** 把 proactivity_level 回填成 proactivity_tier，并同步镜像列 */
export function backfillProactivityTier(db: Database): number {
  if (!hasColumn(db, 'ai_characters', 'proactivity_tier')) return 0;
  if (getMetaFlag(db, TIER_BACKFILL_FLAG)) {
    logger.debug('[DB] 四檔等級已回填過，跳過', {});
    return 0;
  }

  const rows = db
    .prepare('SELECT id, proactivity_level, proactivity_tier FROM ai_characters')
    .all() as Array<{ id: string; proactivity_level: number; proactivity_tier: string | null }>;

  const update = db.prepare(
    'UPDATE ai_characters SET proactivity_tier = ?, proactivity_level = ?, updated_at = updated_at WHERE id = ?',
  );

  let changed = 0;
  for (const row of rows) {
    const level = Number.isFinite(row.proactivity_level) ? row.proactivity_level : 0.5;
    // 已经是合法档位且镜像值一致 → 说明这条是迁移后才建的（create 时已写默认档），跳过
    const tier = tierFromLevel(level) as ProactivityTier;
    update.run(tier, TIER_LEVELS[tier], row.id);
    changed += 1;
  }

  setMetaFlag(db, TIER_BACKFILL_FLAG, String(changed));
  logger.info('[DB] 四檔等級回填完成', { characters: changed });
  return changed;
}

/** 迁移列表：新增迁移只能追加到数组末尾，禁止修改或删除已有条目 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline-schema-v1',
    up(): void {
      // 基线版本：建表语句全部写在 schema.sql 里（带 IF NOT EXISTS），这里无需额外操作
    },
  },

  {
    version: 2,
    name: 'v2-accounts-stories-habits-feedback',
    up(db: Database): void {
      // ---- users：账号 + 未成年保护 + 会员预留 ----
      addColumnIfMissing(db, 'users', 'birth_date', 'TEXT');
      addColumnIfMissing(db, 'users', 'is_minor', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'users', 'age_verified_at', 'TEXT');
      addColumnIfMissing(db, 'users', 'plan', "TEXT NOT NULL DEFAULT 'free'");
      addColumnIfMissing(db, 'users', 'plan_expires_at', 'TEXT');
      addColumnIfMissing(db, 'users', 'quotas', "TEXT NOT NULL DEFAULT '{}'");

      // ---- ai_characters：四档等级 + 聊天模式 + 习惯开关 ----
      addColumnIfMissing(
        db,
        'ai_characters',
        'proactivity_tier',
        "TEXT NOT NULL DEFAULT 'natural'",
      );
      addColumnIfMissing(db, 'ai_characters', 'chat_mode', 'TEXT');
      addColumnIfMissing(
        db,
        'ai_characters',
        'habit_learning_enabled',
        'INTEGER NOT NULL DEFAULT 1',
      );

      // ---- conversations：最近主题 + 同步预留 ----
      addColumnIfMissing(db, 'conversations', 'recent_topics', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'conversations', 'deleted_at', 'TEXT');

      // ---- messages：模式留痕 + 同步预留 ----
      addColumnIfMissing(db, 'messages', 'chat_mode', 'TEXT');
      addColumnIfMissing(db, 'messages', 'deleted_at', 'TEXT');
      addColumnIfMissing(db, 'messages', 'revision', 'INTEGER NOT NULL DEFAULT 1');

      // ---- memories：保留期限 + 来源 + 同步预留（V2-15）----
      addColumnIfMissing(db, 'memories', 'source_kind', "TEXT NOT NULL DEFAULT 'auto'");
      addColumnIfMissing(db, 'memories', 'expires_at', 'TEXT');
      addColumnIfMissing(db, 'memories', 'deleted_at', 'TEXT');
      addColumnIfMissing(db, 'memories', 'revision', 'INTEGER NOT NULL DEFAULT 1');

      // ---- safety_logs：可定位到原文 + 区分来源（V2-14）----
      addColumnIfMissing(db, 'safety_logs', 'message_id', 'TEXT');
      addColumnIfMissing(db, 'safety_logs', 'conversation_id', 'TEXT');
      addColumnIfMissing(db, 'safety_logs', 'source', "TEXT NOT NULL DEFAULT 'system'");

      // ---- 回填四档等级 + 同步 proactivity_level 镜像列 ----
      backfillProactivityTier(db);
    },
  },

  {
    version: 3,
    name: 'v3-message-client-id',
    up(db: Database): void {
      // 前端幂等去重用的客户端消息 id（双提交时不用重复烧 AI）
      addColumnIfMissing(db, 'messages', 'client_message_id', 'TEXT');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(user_id, client_message_id)',
      );
    },
  },

  {
    version: 4,
    name: 'v4-character-persona-sliders',
    up(db: Database): void {
      // 人格微調滑桿 + 自訂描述（P0：让 AI 人格自定义真正生效）
      addColumnIfMissing(db, 'ai_characters', 'slider_playfulness', 'REAL NOT NULL DEFAULT 0.5');
      addColumnIfMissing(db, 'ai_characters', 'slider_humor', 'REAL NOT NULL DEFAULT 0.5');
      addColumnIfMissing(db, 'ai_characters', 'slider_verbosity', 'REAL NOT NULL DEFAULT 0.5');
      addColumnIfMissing(db, 'ai_characters', 'slider_proactivity', 'REAL NOT NULL DEFAULT 0.5');
      addColumnIfMissing(db, 'ai_characters', 'slider_rationality', 'REAL NOT NULL DEFAULT 0.5');
      addColumnIfMissing(db, 'ai_characters', 'slider_listening', 'REAL NOT NULL DEFAULT 0.5');
      addColumnIfMissing(db, 'ai_characters', 'custom_description', "TEXT NOT NULL DEFAULT ''");
    },
  },
];

/** 读取当前 schema 版本（读不到时视为 0） */
export function currentVersion(db: Database): number {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined;
    if (!row) return 0;
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (err) {
    logger.warn('[DB] 讀取 schema 版本失敗，視為 0', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** 写入 schema 版本 */
export function setVersion(db: Database, version: number): void {
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
}

/**
 * 执行所有未应用的迁移。
 * @returns 迁移后的版本号；没有待执行迁移时直接返回当前版本
 */
export function runMigrations(db: Database): number {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug('[DB] 沒有待執行的遷移', { currentVersion: from });
    return from;
  }

  // 迁移全部包在一个事务里：中途失败则整体回滚，避免数据库停在半升级状态
  const apply = db.transaction(() => {
    for (const migration of pending) {
      logger.info('[DB] 執行遷移', { version: migration.version, name: migration.name });
      migration.up(db);
      setVersion(db, migration.version);
    }
  });

  apply();
  const after = currentVersion(db);
  logger.info('[DB] 遷移完成', { from, to: after, applied: pending.length });
  return after;
}
