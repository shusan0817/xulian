/**
 * 临时脚本（验证完即删）：强制重跑迁移 v2 两次，验证幂等性。
 *
 * 真·幂等测试不是「连续启动两次」（那只验证了 version 门控），
 * 而是把版本号强行退回 1，逼 ALTER 语句真的再执行一次——
 * 如果没有 addColumnIfMissing 包裹，这里会直接报 duplicate column name。
 */
import db from '../server/db/index.js';
import * as migrations from '../server/db/migrations.js';

function dumpTiers(): Array<{ name: string; tier: string; lv: number }> {
  return db
    .prepare('SELECT name, proactivity_tier AS tier, proactivity_level AS lv FROM ai_characters')
    .all() as Array<{ name: string; tier: string; lv: number }>;
}

console.log('初始版本:', migrations.currentVersion(db));
console.log('初始档位:', dumpTiers());

for (const round of [1, 2]) {
  console.log(`\n──── 第 ${round} 次强制重跑迁移 v2 ────`);
  migrations.setVersion(db, 1);
  console.log('  版本号已退回:', migrations.currentVersion(db));
  const after = migrations.runMigrations(db);
  console.log('  重跑后版本:', after);
  console.log('  档位（不应被覆盖）:', dumpTiers());
}

// 再验证一次 addColumnIfMissing 单独调用的幂等性
console.log('\n──── addColumnIfMissing 重复调用 ────');
for (const i of [1, 2, 3]) {
  const added = migrations.addColumnIfMissing(
    db,
    'users',
    'birth_date',
    'TEXT',
  );
  console.log(`  第 ${i} 次 addColumnIfMissing(users.birth_date) → 真的执行了 ALTER? ${added}`);
}

console.log('\n最终 schema_meta:', db.prepare('SELECT * FROM schema_meta').all());
console.log('全部 ALTER 均未抛错 → 迁移幂等 ✓');
