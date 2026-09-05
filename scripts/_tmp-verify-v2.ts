/** 临时验证脚本（验证完即删）：检查迁移 v2 的列、表与四档回填结果 */
import db from '../server/db/index.js';
import * as migrations from '../server/db/migrations.js';

const NEW_COLS: Record<string, string[]> = {
  users: ['birth_date', 'is_minor', 'age_verified_at', 'plan', 'plan_expires_at', 'quotas'],
  ai_characters: ['proactivity_tier', 'chat_mode', 'habit_learning_enabled'],
  conversations: ['recent_topics', 'deleted_at'],
  messages: ['chat_mode', 'deleted_at', 'revision'],
  memories: ['source_kind', 'expires_at', 'deleted_at', 'revision'],
  safety_logs: ['message_id', 'conversation_id', 'source'],
};

console.log('schema version =', migrations.currentVersion(db));

for (const [table, cols] of Object.entries(NEW_COLS)) {
  const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  const missing = cols.filter((c) => !existing.includes(c));
  console.log(`  ${table.padEnd(15)} 缺列: ${missing.length === 0 ? '无 ✓' : missing.join(',')}`);
}

const tables = (
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN
       ('user_auth','user_sessions','stories','user_insights','ai_habits','message_feedback','emotion_trend_snapshots')`,
    )
    .all() as Array<{ name: string }>
).map((r) => r.name);
console.log('  新表:', tables.sort().join(', '), `(共 ${tables.length}/7)`);

console.log('\n四档回填结果（角色）:');
for (const row of db
  .prepare('SELECT name, proactivity_level AS lv, proactivity_tier AS tier FROM ai_characters')
  .all() as Array<{ name: string; lv: number; tier: string }>) {
  console.log(`  ${row.name.padEnd(8)} level=${row.lv}  tier=${row.tier}`);
}

console.log('\n用户:');
for (const row of db
  .prepare('SELECT id, display_name, birth_date, is_minor, plan FROM users')
  .all() as Array<{ id: string; display_name: string; birth_date: string | null; is_minor: number; plan: string }>) {
  console.log(`  ${row.id}  name="${row.display_name}"  birth=${row.birth_date ?? '-'}  isMinor=${row.is_minor}  plan=${row.plan}`);
}

console.log('\nschema_meta:', db.prepare('SELECT * FROM schema_meta').all());
console.log('\n角色/记忆/会话 存量:');
for (const t of ['ai_characters', 'memories', 'conversations', 'messages']) {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  console.log(`  ${t.padEnd(15)} ${n} 行`);
}
