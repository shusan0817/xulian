/**
 * §10 主动消息冷却验证（端到端，跑真实 decide() + 真实 DB）
 *
 * 验证核心：AI 主动发出消息后，若用户「未回复」→ V5_TOO_SOON 必须按
 * unrepliedCooldownHours（16h，落在 §10 的 12~24h 区间内）冷却；
 * 若用户已回复 → 退回到设置里的 minIntervalHours（默认 4h）。
 *
 * 运行：XULIAN_DB_PATH=<临时 db> npx tsx scripts/verify-cooldown.ts
 */

import db from '../server/db/index.js';
import * as usersRepo from '../server/db/repositories/users.repo.js';
import * as charactersRepo from '../server/db/repositories/characters.repo.js';
import * as statesRepo from '../server/db/repositories/states.repo.js';
import * as proactiveRepo from '../server/db/repositories/proactive.repo.js';
import { decide } from '../server/services/proactive/decisionService.js';
import type { AICharacter } from '../shared/types.js';

const userId = `verify-cooldown-${Date.now().toString(36)}`;

// 用户 + 角色（DND 设为相同值 → isWithinDnd 返回 false，避免无关否决）
usersRepo.adminCreateUser({ id: userId, timezone: 'Asia/Taipei' });
const longAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(longAgo, userId);

const character = charactersRepo.create(userId, {
  name: '验证角色',
  proactivityLevel: 0.5,
  initialStage: 'familiar',
  initialEmotion: 'neutral',
  proactiveSettings: {
    enabled: true,
    dailyLimit: 99,
    allowedHours: [new Date().getHours()],
    dndStart: '03:00',
    dndEnd: '03:00',
    minIntervalHours: 4,
    allowTopicContinuation: true,
    proactivityLevel: 0.5,
  },
}) as AICharacter;

const charId = character.id;

function mkInput(now: Date) {
  return {
    userId,
    character,
    settings: character.proactiveSettings!,
    lastSeenAt: longAgo,
    hasPushChannel: true,
    timezone: 'Asia/Taipei',
    now,
  };
}

/** 清掉旧任务，插入一条 createdAt = now - hoursAgo 的「已发送」任务 */
function seedSentTask(hoursAgo: number): void {
  db.prepare('DELETE FROM proactive_message_tasks WHERE user_id = ?').run(userId);
  const t = proactiveRepo.insertTask(userId, {
    characterId: charId,
    status: 'sent',
    decision: 'send',
  });
  const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  db.prepare('UPDATE proactive_message_tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(
    ts,
    ts,
    t.id,
  );
}

function setLastUserInteraction(hoursAgo: number): void {
  statesRepo.upsertRelationship(userId, charId, {
    stage: 'familiar',
    interactionLevel: 0.5,
    lastInteractionAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  });
}

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const now = new Date();

// A：未回复（用户最后互动 30h 前，主动消息 5h 前）→ 应触发冷却
setLastUserInteraction(30);
seedSentTask(5);
const rA = decide(mkInput(now));
assert(
  'A 未回复+5h → V5_TOO_SOON 触发',
  rA.reasonCode === 'V5_TOO_SOON',
  `(reasonCode=${rA.reasonCode}, text=${rA.reasonText})`,
);

// B：已回复（用户最后互动 1h 前，晚于 5h 前的主动消息）→ 不应触发 V5
setLastUserInteraction(1);
seedSentTask(5);
const rB = decide(mkInput(now));
assert('B 已回复+5h → V5 不触发', rB.reasonCode !== 'V5_TOO_SOON', `(reasonCode=${rB.reasonCode})`);

// C：未回复但已过 16h 冷却（用户 40h 前，主动 20h 前）→ 不应触发 V5
setLastUserInteraction(40);
seedSentTask(20);
const rC = decide(mkInput(now));
assert('C 未回复+20h → V5 不触发（冷却已过）', rC.reasonCode !== 'V5_TOO_SOON', `(reasonCode=${rC.reasonCode})`);

// D：未回复且在 16h 内（用户 40h 前，主动 10h 前）→ 应触发 V5
setLastUserInteraction(40);
seedSentTask(10);
const rD = decide(mkInput(now));
assert(
  'D 未回复+10h(<16h) → V5 触发',
  rD.reasonCode === 'V5_TOO_SOON',
  `(reasonCode=${rD.reasonCode})`,
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
