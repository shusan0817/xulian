/**
 * 临时脚本（验证完即删）：V2 新增的 7 张表 + 6 个 Repository 全量跑一遍。
 *
 * 与 `scripts/smoke-db.ts` 的区别：本脚本**不常驻**（T11 会把这些断言并进冒烟），
 * 这里只是 T01 的自检——类型检查抓不到「列名写错」「表不存在」，只有真跑 SQL 才暴露。
 */
import * as usersRepo from '../server/db/repositories/users.repo.js';
import * as charactersRepo from '../server/db/repositories/characters.repo.js';
import * as authRepo from '../server/db/repositories/auth.repo.js';
import * as storiesRepo from '../server/db/repositories/stories.repo.js';
import * as insightsRepo from '../server/db/repositories/insights.repo.js';
import * as habitsRepo from '../server/db/repositories/habits.repo.js';
import * as feedbackRepo from '../server/db/repositories/feedback.repo.js';
import * as trendRepo from '../server/db/repositories/trend.repo.js';
import db from '../server/db/index.js';
import { newId, nowIso, dayKey, deriveIsMinor } from '../server/db/helpers.js';
import { GLOBAL_SCOPE } from '../server/db/repositories/insights.repo.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => unknown): void {
  try {
    const r = fn();
    if (r === false) throw new Error('断言为 false');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}
function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

const SUFFIX = Date.now().toString(36);
const userId = `v2-user-${SUFFIX}`;

console.log(`\n需恋 · V2 新增 Repository 自检（userId=${userId}）\n`);

// ------------------------------------------------------------
section('准备：用户 + 角色');
usersRepo.adminCreateUser({ id: userId, displayName: 'V2 测试', timezone: 'Asia/Taipei' });
const character = charactersRepo.create(userId, { name: 'V2 角色' });
console.log(`  角色 id=${character.id}`);

// ------------------------------------------------------------
section('user_auth / user_sessions');
check('insertAuth', () => authRepo.insertAuth({
  userId,
  email: `v2-${SUFFIX}@xulian.test`,
  emailNormalized: `v2-${SUFFIX}@xulian.test`,
  passwordHash: 'scrypt$16384$8$1$AAAA$BBBB',
}));
check('getByUserId', () => authRepo.getByUserId(userId)?.userId === userId);
check('hasPassword = true', () => authRepo.hasPassword(userId) === true);
check('findByEmailNormalized（大小写不敏感靠调用方归一化）', () =>
  authRepo.findByEmailNormalized(`v2-${SUFFIX}@xulian.test`) !== null);
check('emailTaken = true', () => authRepo.emailTaken(`v2-${SUFFIX}@xulian.test`) === true);
check('updatePassword', () => authRepo.updatePassword(userId, 'scrypt$16384$8$1$CCC$DDD', 'scrypt-16384-8-1'));
check('bumpFailedAttempts 累加', () => authRepo.bumpFailedAttempts(userId, 10).failedAttempts === 1);
check('bumpFailedAttempts 第 10 次上锁', () => {
  for (let i = 0; i < 9; i += 1) authRepo.bumpFailedAttempts(userId, 10);
  return authRepo.getByUserId(userId)?.lockedUntil !== null;
});
check('resetFailedAttempts 解锁', () => {
  authRepo.resetFailedAttempts(userId);
  const a = authRepo.getByUserId(userId);
  return a?.lockedUntil === null && a?.failedAttempts === 0;
});

const session = authRepo.insertSession(userId, {
  tokenHash: `hash-${SUFFIX}`,
  userAgent: 'smoke',
  ipPrefix: '192.168.1',
  issuedAt: nowIso(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
check('insertSession', () => session.id.length > 0);
check('findByTokenHash', () => authRepo.findByTokenHash(`hash-${SUFFIX}`)?.user_id === userId);
check('★ UserSession 实体不含 tokenHash', () => !('tokenHash' in session));
check('listSessions（未吊销）', () => authRepo.listSessions(userId).length === 1);
check('touchSession', () => {
  authRepo.touchSession(session.id, { maxLifetimeMs: 86_400_000 });
  return true;
});
check('revokeSession', () => authRepo.revokeSession(userId, session.id) === true);
check('吊销后 listSessions 为空', () => authRepo.listSessions(userId).length === 0);
check('revokeAllSessions（except）', () => {
  const s2 = authRepo.insertSession(userId, {
    tokenHash: `hash2-${SUFFIX}`, issuedAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const s3 = authRepo.insertSession(userId, {
    tokenHash: `hash3-${SUFFIX}`, issuedAt: nowIso(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const revoked = authRepo.revokeAllSessions(userId, s2.id);
  const alive = authRepo.listSessions(userId);
  return revoked === 1 && alive.length === 1 && alive[0]?.id === s2.id;
});
check('adminDeleteExpiredSessions', () => authRepo.adminDeleteExpiredSessions(nowIso()) >= 0);

// ------------------------------------------------------------
section('stories');
const story = storiesRepo.insert(userId, {
  characterId: character.id,
  type: 'user_shared',
  title: '第一次聊到咖啡',
  summary: '他说自己喜欢手冲',
  autoTitle: '自动标题',
  autoSummary: '自动摘要',
  sourceMessageIds: [newId()],
  importance: 0.8,
});
check('insert', () => story.id.length > 0);
check('getById', () => storiesRepo.getById(userId, story.id)?.title === '第一次聊到咖啡');
check('list（含 type 过滤）', () =>
  storiesRepo.list(userId, { characterId: character.id, type: 'user_shared' }).total === 1);
check('update → isUserEdited = 1', () =>
  storiesRepo.update(userId, story.id, { title: '改成我喜欢的标题' })?.isUserEdited === true);
check('restoreAuto → 还原自动版本', () =>
  storiesRepo.restoreAuto(userId, story.id)?.title === '自动标题');
check('countActive', () => storiesRepo.countActive(userId, character.id) === 1);
check('hasFirstChat = false', () => storiesRepo.hasFirstChat(userId, character.id) === false);
check('listRecent', () => storiesRepo.listRecent(userId, character.id, 3).length === 1);
check('softDelete', () => storiesRepo.softDelete(userId, story.id) === true);
check('软删除后 list 默认过滤掉', () => storiesRepo.list(userId).total === 0);
check('archiveOverflow（配额 0 → 全归档）', () => {
  storiesRepo.insert(userId, { characterId: character.id, type: 'user_saved', title: 't', summary: 's' });
  const n = storiesRepo.archiveOverflow(userId, character.id, 0);
  return n === 1;
});

// ------------------------------------------------------------
section('user_insights（★ D5：scope 用 "" 不用 NULL）');
insightsRepo.upsert(userId, {
  dimension: 'reply_length', value: 'short', valueLabel: '喜欢简短回复',
  confidence: 0.3, observationCount: 1,
});
insightsRepo.upsert(userId, {
  dimension: 'reply_length', value: 'balanced', valueLabel: '改了',
});
check('★ 全域 scope 用 "" 而非 NULL', () =>
  count('SELECT COUNT(*) AS n FROM user_insights WHERE user_id=? AND character_scope=?', userId, GLOBAL_SCOPE) === 1);
check('★ 同一维度不堆叠（UNIQUE 生效）', () =>
  insightsRepo.listByScope(userId).length === 1);
check('观测累积到 3 次 → 自动 active', () => {
  insightsRepo.upsert(userId, { dimension: 'reply_length', value: 'balanced', valueLabel: '改了' });
  const it = insightsRepo.getByDimension(userId, 'reply_length');
  return it?.observationCount === 3 && it?.status === 'active';
});
check('角色覆盖与全域共存', () => {
  insightsRepo.upsert(userId, {
    characterScope: character.id, dimension: 'reply_length',
    value: 'detailed', valueLabel: '对这个角色要详细',
  });
  return insightsRepo.listByScope(userId, character.id).length === 1 &&
    insightsRepo.listByScope(userId).length === 1;
});
check('★ listForPrompt：角色覆盖赢过全域', () => {
  const merged = insightsRepo.listForPrompt(userId, character.id);
  return merged.length === 1 && merged[0]?.value === 'detailed';
});
check('update → source=user 且 active', () => {
  const target = insightsRepo.getByDimension(userId, 'reply_length');
  const updated = insightsRepo.update(userId, target!.id, { value: 'very_short', valueLabel: '极短' });
  return updated?.source === 'user' && updated?.isUserEdited === true && updated?.status === 'active';
});
check('confirm', () => {
  const target = insightsRepo.getByDimension(userId, 'reply_length');
  return insightsRepo.confirm(userId, target!.id)?.status === 'active';
});

// ------------------------------------------------------------
section('ai_habits（★ 重置不得触碰核心人格）');
const personalityBefore = charactersRepo.getById(userId, character.id)!.personality;
charactersRepo.update(userId, character.id, { personality: '温柔、慢热、爱看书' });
const personalitySet = charactersRepo.getById(userId, character.id)!.personality;

habitsRepo.upsert(userId, {
  characterId: character.id, dimension: 'reply_pacing',
  value: 'short', valueLabel: '回得短一点',
});
check('insert → candidate（不进 Prompt）', () => {
  const h = habitsRepo.getByKey(userId, character.id, 'reply_pacing', 'short');
  return h?.status === 'candidate' && habitsRepo.listActiveForPrompt(userId, character.id).length === 0;
});
check('观测 3 次 → active（进 Prompt）', () => {
  habitsRepo.upsert(userId, { characterId: character.id, dimension: 'reply_pacing', value: 'short', valueLabel: '回得短一点' });
  habitsRepo.upsert(userId, { characterId: character.id, dimension: 'reply_pacing', value: 'short', valueLabel: '回得短一点' });
  return habitsRepo.listActiveForPrompt(userId, character.id).length === 1;
});
check('list（含 candidate）', () => habitsRepo.list(userId, { characterId: character.id, includeCandidate: true }).length === 1);
check('update userConfirmed → active', () => {
  const h = habitsRepo.getByKey(userId, character.id, 'reply_pacing', 'short')!;
  return habitsRepo.update(userId, h.id, { userConfirmed: true })?.status === 'active';
});
check('recordMiss 对已确认的习惯不降级', () => {
  const h = habitsRepo.getByKey(userId, character.id, 'reply_pacing', 'short')!;
  for (let i = 0; i < 6; i += 1) habitsRepo.recordMiss(userId, h.id);
  return habitsRepo.getById(userId, h.id)?.status === 'active';
});
check('★ resetAll 后 ai_characters.personality 一字未改', () => {
  habitsRepo.resetAll(userId, character.id);
  const after = charactersRepo.getById(userId, character.id)!.personality;
  return after === personalitySet && after !== personalityBefore;
});
check('resetAll 后活跃习惯为 0', () => habitsRepo.countActive(userId, character.id) === 0);

// ------------------------------------------------------------
section('message_feedback（★ message_id 无外键）');
const fakeMessageId = newId();
check('insert', () => feedbackRepo.insert(userId, {
  messageId: fakeMessageId, kind: 'report', reason: '内容不安全',
  characterId: character.id,
}).kind === 'report');
check('★ 重复反馈同一 message+kind 是幂等的（不新增行）', () => {
  feedbackRepo.insert(userId, { messageId: fakeMessageId, kind: 'report', reason: '再点一次' });
  return count('SELECT COUNT(*) AS n FROM message_feedback WHERE user_id=? AND message_id=?', userId, fakeMessageId) === 1;
});
check('不同 kind 可以并存', () => {
  feedbackRepo.insert(userId, { messageId: fakeMessageId, kind: 'not_interesting' });
  return count('SELECT COUNT(*) AS n FROM message_feedback WHERE user_id=? AND message_id=?', userId, fakeMessageId) === 2;
});
check('summary 统计', () => feedbackRepo.summary(userId)['report'] === 1);
check('listByMessage', () => feedbackRepo.listByMessage(userId, fakeMessageId).length === 2);
check('adminListOpen', () => feedbackRepo.adminListOpen(50).length >= 1);
check('markHandled', () => {
  const item = feedbackRepo.getByMessage(userId, fakeMessageId, 'report')!;
  return feedbackRepo.markHandled(item.id, '已处理') === true;
});
check('remove（指定 kind）', () => feedbackRepo.remove(userId, fakeMessageId, 'not_interesting') === 1);
check('★ 删除不存在的 message 不影响反馈留存', () => {
  // 故意不建 messages 行：证明 feedback 不需要 FK 也能存在
  return count('SELECT COUNT(*) AS n FROM message_feedback WHERE user_id=?', userId) === 1;
});

// ------------------------------------------------------------
section('emotion_trend_snapshots');
const day = dayKey();
trendRepo.upsertSnapshot(userId, {
  characterId: character.id, day, addMessageCount: 3, addSessionCount: 1,
  avgUserMsgChars: 42, avgValence: -0.2, dominantEmotion: 'down',
});
trendRepo.upsertSnapshot(userId, { characterId: character.id, day, addMessageCount: 2, addSessionCount: 1 });
check('★ 按天幂等 + 计数累加', () => {
  const s = trendRepo.getByDay(userId, character.id, day);
  return s?.messageCount === 5 && s?.sessionCount === 2;
});
check('平均类字段被覆盖而非再平均', () => {
  trendRepo.upsertSnapshot(userId, { characterId: character.id, day, avgUserMsgChars: 10 });
  return trendRepo.getByDay(userId, character.id, day)?.avgUserMsgChars === 10;
});
check('listRecent（正序）', () => trendRepo.listRecent(userId, character.id, 14).length === 1);
check('countDays', () => trendRepo.countDays(userId, character.id) === 1);
check('⛔ 快照表不含任何百分比/分数字段', () => {
  const s = trendRepo.getByDay(userId, character.id, day)!;
  return !Object.keys(s).some((k) => /score|percent|index|rate/i.test(k));
});

// ------------------------------------------------------------
section('未成年派生（helpers）');
check('deriveIsMinor：17 岁 → true', () => deriveIsMinor('2009-01-01', new Date('2026-09-05')) === true);
check('deriveIsMinor：18 岁生日当天 → false', () => deriveIsMinor('2008-09-05', new Date('2026-09-05')) === false);
check('deriveIsMinor：前一天 17 岁 → true', () => deriveIsMinor('2008-09-06', new Date('2026-09-05')) === true);
check('deriveIsMinor：不填 → false（不是降低保护）', () => deriveIsMinor(null) === false);
check('updateBirthDate 同步 is_minor', () => {
  usersRepo.updateBirthDate(userId, '2012-05-20');
  return usersRepo.getById(userId)?.isMinor === true;
});
check('清除出生日期 → is_minor 归 0', () => {
  usersRepo.updateBirthDate(userId, null);
  return usersRepo.getById(userId)?.isMinor === false;
});

// ------------------------------------------------------------
section('★ 删除全部数据后，7 张新表必须归零');
usersRepo.deleteUserData(userId, 'all');
const TABLES = [
  'user_auth', 'user_sessions', 'stories', 'user_insights',
  'ai_habits', 'message_feedback', 'emotion_trend_snapshots',
];
for (const table of TABLES) {
  check(`${table} = 0 行`, () => count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId) === 0);
}
check('users 行本身也被删除', () => usersRepo.getById(userId) === null);

// ------------------------------------------------------------
console.log(`\n${'─'.repeat(52)}`);
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓\n');
