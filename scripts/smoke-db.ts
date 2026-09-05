/**
 * 数据库冒烟测试
 *
 * 目的：把所有 Repository 的 SQL 都真实执行一遍。
 * 类型检查（tsc）抓不到「列名写错」「表不存在」这类问题，
 * 只有真正跑一遍 SQL 才会暴露——调度器首轮 tick 就踩过一次这种坑。
 *
 * 用法：npx tsx scripts/smoke-db.ts
 */

import * as usersRepo from '../server/db/repositories/users.repo.js';
import * as charactersRepo from '../server/db/repositories/characters.repo.js';
import * as conversationsRepo from '../server/db/repositories/conversations.repo.js';
import * as memoriesRepo from '../server/db/repositories/memories.repo.js';
import * as statesRepo from '../server/db/repositories/states.repo.js';
import * as proactiveRepo from '../server/db/repositories/proactive.repo.js';
import * as pushRepo from '../server/db/repositories/push.repo.js';
import * as safetyRepo from '../server/db/repositories/safety.repo.js';
import { newId, nowIso, dayKey } from '../server/db/helpers.js';

const SUFFIX = Date.now().toString(36);
const userId = `smoke-user-${SUFFIX}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => unknown): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

console.log(`\n需恋 · 数据库冒烟测试（userId=${userId}）\n`);

// ============================================================
section('users');
// ============================================================
check('adminCreateUser', () => usersRepo.adminCreateUser({ id: userId, timezone: 'Asia/Taipei' }));
check('getById', () => {
  if (!usersRepo.getById(userId)) throw new Error('读不回来');
});
check('exists', () => {
  if (!usersRepo.exists(userId)) throw new Error('exists=false');
});
check('updateLastSeen', () => usersRepo.updateLastSeen(userId));
check('updateSettings', () => {
  if (!usersRepo.updateSettings(userId, { theme: 'dark' } as never)) throw new Error('返回 null');
});
check('addActiveDay', () => usersRepo.addActiveDay(userId, 'char-x', dayKey()));
check('listActiveDays', () => usersRepo.listActiveDays(userId, 'char-x'));
check('countActiveDays', () => usersRepo.countActiveDays(userId, 'char-x'));

// ============================================================
section('characters');
// ============================================================
const character = charactersRepo.create(userId, { name: '冒烟角色' });
check('create', () => character);
check('getById', () => {
  if (!charactersRepo.getById(userId, character.id)) throw new Error('读不回来');
});
check('listByUser', () => charactersRepo.listByUser(userId));
check('countByUser', () => charactersRepo.countByUser(userId));
check('update', () => {
  if (!charactersRepo.update(userId, character.id, { name: '冒烟角色2' })) throw new Error('返回 null');
});
check('setDefault', () => {
  if (!charactersRepo.setDefault(userId, character.id)) throw new Error('返回 null');
});
check('getDefault', () => {
  if (!charactersRepo.getDefault(userId)) throw new Error('读不回来');
});
check('duplicate', () => charactersRepo.duplicate(userId, character.id));

// ============================================================
section('conversations & messages');
// ============================================================
const conversation = conversationsRepo.findOrCreateActive(userId, character.id);
check('findOrCreateActive', () => conversation);
check('getConversation', () => {
  if (!conversationsRepo.getConversation(userId, conversation.id)) throw new Error('读不回来');
});
check('listConversations', () => conversationsRepo.listConversations(userId, {}));
check('updateConversation', () => conversationsRepo.updateConversation(userId, conversation.id, { summary: '摘要测试' }));
const msg1 = conversationsRepo.insertMessage(userId, {
  conversationId: conversation.id,
  characterId: character.id,
  role: 'user',
  content: '测试消息',
});
check('insertMessage', () => msg1);
check('getMessage', () => {
  if (!conversationsRepo.getMessage(userId, msg1.id)) throw new Error('读不回来');
});
check('listMessages', () => conversationsRepo.listMessages(userId, conversation.id, { limit: 10 }));
check('listRecentMessages', () => conversationsRepo.listRecentMessages(userId, conversation.id, 5));
check('getLastMessage', () => conversationsRepo.getLastMessage(userId, conversation.id));
check('countUserMessages', () => conversationsRepo.countUserMessages(userId, character.id));
check('updateMessage', () => conversationsRepo.updateMessage(userId, msg1.id, { content: '改过了' }));
check('markRead', () => conversationsRepo.markRead(userId, [msg1.id]));
check('listUnreadProactive', () => conversationsRepo.listUnreadProactive(userId, 5));
check('countUnreadProactive', () => conversationsRepo.countUnreadProactive(userId, character.id));

// ============================================================
section('memories');
// ============================================================
const memory = memoriesRepo.insertMemory(userId, {
  characterId: character.id,
  category: 'preference',
  content: '喜欢喝手冲咖啡',
  importance: 0.7,
});
check('insertMemory', () => memory);
check('getMemory', () => {
  if (!memoriesRepo.getMemory(userId, memory.id)) throw new Error('读不回来');
});
check('listMemories', () => memoriesRepo.listMemories(userId, { characterId: character.id }));
check('listForDedupe', () => memoriesRepo.listForDedupe(userId, character.id, 'preference'));
check('searchMemories', () => memoriesRepo.searchMemories(userId, character.id, 5));
check('findByDedupeKey', () => memoriesRepo.findByDedupeKey(userId, character.id, memory.dedupeKey));
check('countMemories', () => memoriesRepo.countMemories(userId, character.id));
check('updateMemory', () => {
  if (!memoriesRepo.updateMemory(userId, memory.id, { importance: 0.9 })) throw new Error('返回 null');
});
check('bumpHit', () => memoriesRepo.bumpHit(userId, [memory.id]));
check('deleteMemory', () => {
  if (!memoriesRepo.deleteMemory(userId, memory.id)) throw new Error('返回 false');
});

// ============================================================
section('states (情绪 / 关系)');
// ============================================================
check('upsertEmotion', () =>
  statesRepo.upsertEmotion(userId, character.id, {
    currentEmotion: 'happy',
    intensity: 0.6,
    emotionReason: '冒烟测试',
  }),
);
check('getEmotion', () => {
  if (!statesRepo.getEmotion(userId, character.id)) throw new Error('读不回来');
});
check('upsertRelationship', () =>
  statesRepo.upsertRelationship(userId, character.id, {
    stage: 'familiar',
    interactionLevel: 0.2,
    floorStage: 'familiar',
  }),
);
check('getRelationship', () => {
  if (!statesRepo.getRelationship(userId, character.id)) throw new Error('读不回来');
});
check('insertUserEmotion', () =>
  statesRepo.insertUserEmotion(userId, {
    characterId: character.id,
    conversationId: conversation.id,
    messageId: msg1.id,
    emotion: 'down',
    intensity: 0.5,
    reasons: ['冒烟'],
  }),
);
check('getLatestUserEmotion', () => statesRepo.getLatestUserEmotion(userId, character.id));
check('listRecentUserEmotions', () => statesRepo.listRecentUserEmotions(userId, character.id, 3));

// ============================================================
section('proactive');
// ============================================================
const task = proactiveRepo.insertTask(userId, {
  characterId: character.id,
  status: 'pending',
  decision: 'send',
  score: 0.7,
  reasonCode: 'S_SEND',
});
check('insertTask', () => task);
check('getTask', () => {
  if (!proactiveRepo.getTask(userId, task.id)) throw new Error('读不回来');
});
check('listTasks', () => proactiveRepo.listTasks(userId, { characterId: character.id }));
check('updateTask', () => {
  if (!proactiveRepo.updateTask(userId, task.id, { status: 'sent', messageId: msg1.id })) {
    throw new Error('返回 null');
  }
});
check('getLastSentTask', () => proactiveRepo.getLastSentTask(userId, character.id));
check('getLastTask', () => proactiveRepo.getLastTask(userId, character.id));
check('adminFindDueTasks', () => proactiveRepo.adminFindDueTasks(nowIso(), 10));
check('adminListProactiveTargets', () => proactiveRepo.adminListProactiveTargets());
check('adminResetStaleSending', () => proactiveRepo.adminResetStaleSending(nowIso()));
check('adminExpireOldTasks', () => proactiveRepo.adminExpireOldTasks(nowIso()));
check('getDailyCount', () => proactiveRepo.getDailyCount(userId, character.id, dayKey()));
check('bumpDailyCount', () => proactiveRepo.bumpDailyCount(userId, character.id, dayKey()));
check('adminAcquireRunLock', () => {
  if (!proactiveRepo.adminAcquireRunLock(character.id, `smoke-${SUFFIX}`)) throw new Error('抢锁失败');
});
check('adminAcquireRunLock 幂等（第二次应为 false）', () => {
  if (proactiveRepo.adminAcquireRunLock(character.id, `smoke-${SUFFIX}`)) {
    throw new Error('重复抢锁成功，幂等失效');
  }
});
check('adminFinishRunLock', () => proactiveRepo.adminFinishRunLock(character.id, `smoke-${SUFFIX}`, 'done'));
check('adminCleanupOldRuns', () => proactiveRepo.adminCleanupOldRuns(nowIso()));
check('adminCleanupOldCounters', () => proactiveRepo.adminCleanupOldCounters('2000-01-01'));

// ============================================================
section('push');
// ============================================================
const endpoint = `https://smoke.example.com/push/${newId()}`;
check('upsertPush', () =>
  pushRepo.upsertPush(userId, {
    endpoint,
    p256dh: 'test-p256dh',
    auth: 'test-auth',
    userAgent: 'smoke',
  }),
);
check('listPush', () => pushRepo.listPush(userId));
check('touchPush', () => pushRepo.touchPush(endpoint));
check('deletePushByEndpoint', () => {
  if (!pushRepo.deletePushByEndpoint(userId, endpoint)) throw new Error('返回 false');
});
check('deleteAllPush', () => pushRepo.deleteAllPush(userId));
check('adminDeleteByEndpoint', () => pushRepo.adminDeleteByEndpoint(endpoint));

// ============================================================
section('safety');
// ============================================================
check('insertSafetyLog', () =>
  safetyRepo.insertSafetyLog(userId, {
    characterId: character.id,
    direction: 'outgoing',
    rule: 'GUILT_TRIP',
    action: 'blocked',
    severity: 'block',
    excerpt: '冒烟测试',
    detail: {},
  }),
);
check('listSafetyLogs', () => safetyRepo.listSafetyLogs(userId, 5));
check('countRecentBlocks', () => safetyRepo.countRecentBlocks(userId, character.id, '2000-01-01'));

// ============================================================
section('数据删除（隐私）');
// ============================================================
check('deleteUserData(memories)', () => usersRepo.deleteUserData(userId, 'memories'));
check('deleteUserData(all)', () => usersRepo.deleteUserData(userId, 'all'));
check('adminDeleteUser', () => usersRepo.adminDeleteUser(userId));

// ============================================================
console.log(`\n${'─'.repeat(52)}`);
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓\n');
