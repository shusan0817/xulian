/** 临时：把测试注册写入的昵称/年龄验证时间还原成原始状态 */
import db from '../server/db/index.js';
const r = db
  .prepare("UPDATE users SET display_name = '', age_verified_at = NULL, birth_date = NULL, is_minor = 0 WHERE id = 'test-user-001'")
  .run();
console.log('还原 test-user-001 昵称/年龄字段，影响行数:', r.changes);
console.log(db.prepare("SELECT id, display_name, birth_date, is_minor, age_verified_at FROM users").all());
