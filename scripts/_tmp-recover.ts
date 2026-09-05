/**
 * 临时恢复脚本（用完即删）：从 SQLite 空闲页里抢救被误删的行
 *
 * 背景：清理脚本误把 test-user-001 的 users 行删了（连带级联掉了角色/会话/消息）。
 * SQLite 删除行时只是把 cell 指针摘掉、空间挂进空闲链表，**不清零内容**，
 * 所以只要这些页还没被新数据覆写，原始记录仍然躺在文件里。
 *
 * 本脚本：
 *   1. 用 sqlite_master 拿到各表的 rootpage 与列定义；
 *   2. 逐页扫描，在整页范围内暴力找「看起来像一条合法 record」的位置并解码；
 *   3. 按 user_id = 'test-user-001' 过滤候选，打印出来供人工确认。
 * ⚠️ 本脚本**只读**，不做任何写入。
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';

const DB_PATH = 'server/data/xulian.db';
const TARGET_USER = 'test-user-001';

// ---- 1. 读 schema ----
const db = new Database(DB_PATH, { readonly: true });
const tables = db
  .prepare("SELECT name, rootpage, sql FROM sqlite_master WHERE type='table'")
  .all() as Array<{ name: string; rootpage: number; sql: string }>;
db.close();

function columnsOf(sql: string): string[] {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const cols: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      cols.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) cols.push(current.trim());
  return cols
    .map((c) => c.split(/\s+/)[0]?.replace(/[`"[]/g, '') ?? '')
    .filter((c) => c && !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(c.toUpperCase()));
}

// ---- 2. 读原始文件 ----
const buf = fs.readFileSync(DB_PATH);
const pageSize = buf.readUInt16BE(16);
const pageCount = buf.readUInt32BE(28);
console.log(`pageSize=${pageSize}  pageCount=${pageCount}  fileSize=${buf.length}`);

/** 读 SQLite 变长整数（最多 9 字节） */
function readVarint(b: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    if (offset + i >= b.length) return null;
    const byte = b[offset + i]!;
    if (i === 7) {
      value = value * 128 + (byte & 0x7f);
      // 第 9 字节参与，用 BigInt 会丢精度；这里用近似（记录长度不会到这个量级）
      return { value, next: offset + 8 };
    }
    value = value * 256 + byte;
    if (byte < 0x80) return { value, next: offset + i + 1 };
    value = value & 0x7fffffff_ffffffff;
  }
  return null;
}

/** 解码一条 record（headerSize + serial types + body） */
function decodeRecord(payload: Buffer): Array<string | number | null> | null {
  const header = readVarint(payload, 0);
  if (!header) return null;
  const headerSize = header.value;
  if (headerSize < 1 || headerSize > payload.length) return null;

  const types: number[] = [];
  let pos = header.next;
  while (pos < headerSize) {
    const t = readVarint(payload, pos);
    if (!t) return null;
    types.push(t.value);
    pos = t.next;
  }
  if (pos !== headerSize) return null;

  const values: Array<string | number | null> = [];
  let body = headerSize;
  for (const type of types) {
    if (type === 0) {
      values.push(null);
      continue;
    }
    if (type >= 1 && type <= 6) {
      const len = [0, 1, 2, 3, 4, 6, 8][type]!;
      if (body + len > payload.length) return null;
      values.push(payload.readIntBE(body, len));
      body += len;
      continue;
    }
    if (type === 7) {
      if (body + 8 > payload.length) return null;
      values.push(payload.readDoubleBE(body));
      body += 8;
      continue;
    }
    if (type === 8) { values.push(0); continue; }
    if (type === 9) { values.push(1); continue; }
    const size = Math.floor((type - 12) / 2);
    if (body + size > payload.length) return null;
    if (type % 2 === 0) {
      values.push(payload.subarray(body, body + size).toString('hex'));
    } else {
      values.push(payload.subarray(body, body + size).toString('utf8'));
    }
    body += size;
  }
  return values;
}

/** 从某个偏移尝试解析出「一条完整的 cell」 */
function tryParseCellAt(start: number): { rowid: number; values: Array<string | number | null> } | null {
  const pLen = readVarint(buf, start);
  if (!pLen) return null;
  const payloadSize = pLen.value;
  if (payloadSize < 3 || payloadSize > 60_000) return null;
  const rowid = readVarint(buf, pLen.next);
  if (!rowid) return null;
  // 溢出页的记录内容不完整，跳过（本库记录都很小，不会走到这里）
  const usable = pageSize - 35;
  if (payloadSize > usable) return null;
  const payload = buf.subarray(rowid.next, rowid.next + payloadSize);
  if (payload.length < payloadSize) return null;
  const values = decodeRecord(payload);
  if (!values) return null;
  if (values.length < 2) return null;
  return { rowid: rowid.value, values };
}

// ---- 3. 逐页暴力扫描 ----
interface Hit {
  table: string;
  page: number;
  offset: number;
  rowid: number;
  obj: Record<string, unknown>;
}

const TARGET_TABLES = [
  'users',
  'ai_characters',
  'conversations',
  'messages',
  'emotion_states',
  'relationship_states',
  'active_days',
  'memories',
];

const schemaByTable = new Map<string, { rootpage: number; columns: string[] }>();
for (const t of tables) {
  if (!TARGET_TABLES.includes(t.name)) continue;
  schemaByTable.set(t.name, { rootpage: t.rootpage, columns: columnsOf(t.sql) });
}

const hits: Hit[] = [];

for (let p = 1; p <= pageCount; p += 1) {
  const pageStart = (p - 1) * pageSize;
  for (let off = 0; off < pageSize - 8; off += 1) {
    const cell = tryParseCellAt(pageStart + off);
    if (!cell) continue;

    for (const [table, meta] of schemaByTable) {
      if (cell.values.length !== meta.columns.length) continue;
      const obj: Record<string, unknown> = {};
      meta.columns.forEach((col, i) => {
        obj[col] = cell.values[i];
      });

      // 只保留与目标用户相关的记录
      const owner = obj['user_id'] ?? obj['id'];
      if (owner !== TARGET_USER && obj['id'] !== TARGET_USER) continue;
      if (typeof owner !== 'string') continue;

      // 基本合理性校验：不能全是 null
      const nonNull = cell.values.filter((v) => v !== null).length;
      if (nonNull < Math.min(3, meta.columns.length)) continue;

      hits.push({ table, page: p, offset: off, rowid: cell.rowid, obj });
    }
  }
}

// 去重（同一条记录可能被多个偏移解析到；按 JSON 去重）
const seen = new Set<string>();
const unique: Hit[] = [];
for (const h of hits) {
  const key = `${h.table}|${JSON.stringify(h.obj)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(h);
}

console.log(`\n扫描到 ${unique.length} 条与目标用户相关的候选记录\n`);
for (const h of unique.sort((a, b) => a.table.localeCompare(b.table))) {
  console.log(`── ${h.table}  (page ${h.page}, offset ${h.offset}, rowid ${h.rowid})`);
  console.log(`   ${JSON.stringify(h.obj, null, 2).split('\n').join('\n   ')}`);
  console.log();
}

fs.writeFileSync('.tmp-e2e/recovered-candidates.json', JSON.stringify(unique, null, 2), 'utf8');
console.log('候选已写入 .tmp-e2e/recovered-candidates.json（本脚本不写数据库）');
