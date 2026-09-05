/** 临时：打印某个用户的数据快照，用于证明「注册前后数据零丢失」 */
import db from '../server/db/index.js';
const uid = process.argv[2] ?? 'test-user-001';
const c = (sql: string, p: string): number => (db.prepare(sql).get(p) as { n: number }).n;
const snap = {
  userId: uid,
  displayName: (db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid) as { display_name: string } | undefined)?.display_name ?? '(不存在)',
  hasPassword: c('SELECT COUNT(*) AS n FROM user_auth WHERE user_id = ?', uid) > 0,
  characters: db.prepare('SELECT name, proactivity_tier FROM ai_characters WHERE user_id = ?').all(uid),
  conversations: c('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?', uid),
  messages: c('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?', uid),
  memories: c('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?', uid),
  emotionStates: c('SELECT COUNT(*) AS n FROM emotion_states WHERE user_id = ?', uid),
  relationships: c('SELECT COUNT(*) AS n FROM relationship_states WHERE user_id = ?', uid),
  lastMessages: db.prepare('SELECT role, substr(content,1,30) AS content FROM messages WHERE user_id = ? ORDER BY created_at').all(uid),
};
console.log(JSON.stringify(snap, null, 2));
