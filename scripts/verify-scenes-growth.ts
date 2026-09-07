/**
 * 验证「聊天场景 (scenes)」与「AI 成長展示 (growth)」后端真实可用。
 *
 * 跑真实 SQL（repo 层）+ 服务层 + 提示词层；无需 API Key。
 *
 * 用法：XULIAN_DB_PATH=/tmp/xulian-verify-sg.db npx tsx scripts/verify-scenes-growth.ts
 */

import * as usersRepo from '../server/db/repositories/users.repo.js';
import * as charactersRepo from '../server/db/repositories/characters.repo.js';
import * as growthService from '../server/services/growthService.js';
import { buildPersonaLayer } from '../server/agent/prompts.js';

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

const SUFFIX = Date.now().toString(36);
const userId = `verify-sg-${SUFFIX}`;

// 建用户 + 角色（FK 约束）
usersRepo.adminCreateUser({ id: userId, displayName: '驗證者' });
const created = charactersRepo.create(userId, {
  name: '小戀',
  relationshipType: 'friend',
  personality: '溫柔',
  speakingStyle: '自然',
  scenePreset: '你們身處中世紀背景：城堡、騎士、魔法或王國氛圍。',
} as never) as { id: string; name: string };
const characterId = created.id;

console.log(`\n需恋 · 聊天场景 / 成長展示 验证（userId=${userId}）\n`);

// ── 聊天场景：数据层 ──
console.log('── 聊天场景（repo）──');
check('create 写入 scenePreset 并回读', () => {
  const c = charactersRepo.getById(userId, characterId);
  if (!c) throw new Error('角色读不回');
  if (c.scenePreset !== '你們身處中世紀背景：城堡、騎士、魔法或王國氛圍。') {
    throw new Error(`scenePreset 不符： ${c.scenePreset}`);
  }
});
check('update 可改 scenePreset', () => {
  const updated = charactersRepo.update(userId, characterId, {
    scenePreset: '你們是職場上的同事，對話帶點工作日常。',
  } as never);
  if (!updated || updated.scenePreset !== '你們是職場上的同事，對話帶點工作日常。') {
    throw new Error('scenePreset 更新后不符');
  }
});

// ── 聊天场景：提示词注入 ──
console.log('── 聊天场景（提示词）──');
check('buildPersonaLayer 注入场景段', () => {
  const c = charactersRepo.getById(userId, characterId)!;
  const out = buildPersonaLayer(c, '你們正處於校園場景：青春感。');
  if (!out.includes('當前場景（背景設定，不是你的性格）')) {
    throw new Error('缺少場景段標題');
  }
  if (!out.includes('你們正處於校園場景：青春感。')) {
    throw new Error('場景文案未注入');
  }
});
check('buildPersonaLayer 无场景时不渲染场景段', () => {
  const c = charactersRepo.getById(userId, characterId)!;
  const out = buildPersonaLayer(c, null);
  if (out.includes('當前場景（背景設定，不是你的性格）')) {
    throw new Error('无场景时不应出现場景段');
  }
});

// ── AI 成長展示：聚合端点 ──
console.log('── AI 成長展示（growthService）──');
check('getGrowth 返回完整聚合且类型正确', () => {
  const g = growthService.getGrowth(userId, characterId);
  const keys = [
    'memories', 'stories', 'milestones', 'habits', 'insights',
    'activeDays', 'totalMessages', 'interactionLevelPct', 'stage', 'firstChatAt',
  ] as const;
  for (const k of keys) {
    if (!(k in g)) throw new Error(`缺少字段 ${k}`);
  }
  for (const k of ['memories', 'stories', 'milestones', 'habits', 'insights', 'activeDays', 'totalMessages', 'interactionLevelPct'] as const) {
    if (typeof (g as unknown as Record<string, unknown>)[k] !== 'number') {
      throw new Error(`字段 ${k} 不是 number`);
    }
  }
  if (typeof g.stage !== 'string') throw new Error('stage 不是 string');
  if (g.firstChatAt !== null && typeof g.firstChatAt !== 'string') {
    throw new Error('firstChatAt 类型异常');
  }
});
check('getGrowth 空数据不抛错（safe 守卫）', () => {
  // 换一个全新角色，零记忆/零故事，断言仍返回（值为 0 / null）
  const c2 = charactersRepo.create(userId, {
    name: '新手', relationshipType: 'friend',
  } as never) as { id: string };
  const g = growthService.getGrowth(userId, c2.id);
  if (g.memories !== 0 || g.stories !== 0) {
    throw new Error('空角色应有 0 计数');
  }
});

console.log(`\n结果：通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
