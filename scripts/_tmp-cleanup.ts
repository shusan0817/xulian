/**
 * 临时脚本（验证完即删）：清理 T02 测试账号
 *
 * 要求（team-lead）：
 *   1. 只删 test-user-001 的 user_auth 行（detach），users 行与其角色/记忆/会话全部保留；
 *   2. 删掉纯测试账号（连同 users 行）；
 *   3. 清空 user_sessions。
 * 预期结果：user_auth 0 行、user_sessions 0 行、users 只剩 test-user-001。
 */

import db from '../server/db/index.js';

const KEEP_USER = 'test-user-001';
const DELETE_EMAILS = [
  'user@xulian.test',
  'bob@xulian.test',
  'minor@xulian.test',
  'alice@xulian.test',
  'weak@xulian.test',
  'olduser@xulian.test',
];

// 1) 纯测试账号：删 users 行（user_auth / user_sessions 有 ON DELETE CASCADE，会跟着走）
let deletedUsers = 0;
for (const email of DELETE_EMAILS) {
  const row = db
    .prepare('SELECT user_id FROM user_auth WHERE email_normalized = ?')
    .get(email) as { user_id: string } | undefined;
  if (!row) continue;
  deletedUsers += db.prepare('DELETE FROM users WHERE id = ?').run(row.user_id).changes;
  console.log(`  删除测试账号 ${email} (userId=${row.user_id})`);
}
console.log(`  → 共删除 ${deletedUsers} 个测试用户`);

// 2) detach：只删 test-user-001 的 user_auth 行，users 行与全部数据保留
const detached = db.prepare('DELETE FROM user_auth WHERE user_id = ?').run(KEEP_USER).changes;
console.log(`  detach ${KEEP_USER}: 删除 ${detached} 行 user_auth（users 行不动）`);

// 3) 清空会话（detach 后这些会话已无意义，留着会让 /api/auth/sessions 出现幽灵数据）
const sessions = db.prepare('DELETE FROM user_sessions').run().changes;
console.log(`  清空 user_sessions: ${sessions} 行`);

// 4) 把测试注册写进 users 表的昵称/年龄字段还原成原始状态（原来是空昵称）
db.prepare(
  "UPDATE users SET display_name = '', birth_date = NULL, is_minor = 0, age_verified_at = NULL WHERE id = ?",
).run(KEEP_USER);
console.log(`  还原 ${KEEP_USER} 的昵称/年龄字段`);

// ---- 结果 ----
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
console.log('\n===== 清理后状态 =====');
console.log(`  user_auth                : ${count('SELECT COUNT(*) AS n FROM user_auth')} 行`);
console.log(`  user_sessions            : ${count('SELECT COUNT(*) AS n FROM user_sessions')} 行`);
console.log(`  users                    : ${count('SELECT COUNT(*) AS n FROM users')} 行`);
console.log('  users 明细:', db.prepare('SELECT id, display_name, is_minor, plan FROM users').all());
console.log(
  `  ai_characters(${KEEP_USER}) : ${count(`SELECT COUNT(*) AS n FROM ai_characters WHERE user_id='${KEEP_USER}'`)} 行`,
  db.prepare(`SELECT id, name, proactivity_tier FROM ai_characters WHERE user_id='${KEEP_USER}'`).all(),
);
console.log(
  `  conversations(${KEEP_USER}) : ${count(`SELECT COUNT(*) AS n FROM conversations WHERE user_id='${KEEP_USER}'`)} 行`,
);
console.log(
  `  messages(${KEEP_USER})      : ${count(`SELECT COUNT(*) AS n FROM messages WHERE user_id='${KEEP_USER}'`)} 行`,
);
console.log(
  `  memories(${KEEP_USER})      : ${count(`SELECT COUNT(*) AS n FROM memories WHERE user_id='${KEEP_USER}'`)} 行`,
);
