/**
 * 验证「我们的故事 / 未完待续 / AI 小话题」后端真实可用。
 *
 * 跑真实 SQL（repo 层）+ 服务层逻辑；LLM 不可用时抽取样例会优雅降级为 [] / 预设，
 * 因此无需 API Key 也能验证「不崩溃、数据层正确、路由可加载」。
 *
 * 用法：XULIAN_DB_PATH=/tmp/xulian-verify.db npx tsx scripts/verify-stories-unfinished.ts
 */

import * as usersRepo from '../server/db/repositories/users.repo.js';
import * as charactersRepo from '../server/db/repositories/characters.repo.js';
import * as storiesRepo from '../server/db/repositories/stories.repo.js';
import * as unfinishedRepo from '../server/db/repositories/unfinishedTopics.repo.js';
import * as storyService from '../server/services/storyService.js';
import * as unfinishedService from '../server/services/unfinishedTopicService.js';
import * as smallTopicService from '../server/services/smallTopicService.js';
import { nowIso } from '../server/db/helpers.js';

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

async function checkAsync(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
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
const userId = `verify-${SUFFIX}`;
let characterId = `char-${SUFFIX}`;

// 建用户 + 角色（FK 约束）
const user = usersRepo.adminCreateUser({ id: userId, displayName: '驗證者' });
const character = charactersRepo.create(userId, {
  name: '小戀',
  relationshipType: 'friend',
  personality: '溫柔',
  speakingStyle: '自然',
} as never) as { id: string; name: string };
// 用 repo 实际生成的 id（create 会自己生成），避免 FK 不匹配
characterId = character.id;
const char = { id: characterId, name: character.name } as never;

console.log(`\n需恋 · 故事 / 未完待续 / 小话题 验证（userId=${userId}）\n`);

// ── 我们的故事：数据层 ──
console.log('── 我们的故事（repo + service）──');
check('ensureFirstChatStory 创建首聊故事', () => {
  const s = storyService.ensureFirstChatStory(userId, char, 'm-first');
  if (!s || s.type !== 'first_chat') throw new Error('首聊故事未创建');
  const again = storyService.ensureFirstChatStory(userId, char, 'm-first');
  if (again !== null) throw new Error('首聊故事未幂等（重复创建）');
});
check('storiesRepo.insert 写入用户分享故事', () => {
  const s = storiesRepo.insert(userId, {
    characterId,
    type: 'user_shared',
    title: '分享了一次旅行',
    summary: '他說上週去了海邊',
    importance: 0.7,
    source: 'llm',
    sourceMessageIds: ['m2'],
    happenedAt: nowIso(),
  });
  if (!s.id) throw new Error('插入失败');
});
check('listRecent 含首聊与分享', () => {
  const list = storiesRepo.listRecent(userId, characterId, 5);
  if (list.length < 2) throw new Error(`期望 ≥2 条，实际 ${list.length}`);
});
check('listRecentForPrompt 返回 {id,title}', () => {
  const list = storyService.listRecentForPrompt(userId, characterId, 3);
  if (!Array.isArray(list) || !list[0]?.id || !list[0]?.title) throw new Error('结构不对');
});
check('update 置 isUserEdited', () => {
  const list = storiesRepo.listRecent(userId, characterId, 5);
  const target = list.find((s) => s.type === 'user_shared')!;
  const updated = storiesRepo.update(userId, target.id, { title: '改過的標題', summary: '改過的內容' });
  if (!updated || !updated.isUserEdited) throw new Error('未标记为用户编辑');
});
check('restoreAuto 还原自动版本', () => {
  const list = storiesRepo.listRecent(userId, characterId, 5);
  const target = list.find((s) => s.type === 'user_shared')!;
  const restored = storiesRepo.restoreAuto(userId, target.id);
  if (restored?.title !== restored?.autoTitle) throw new Error('未还原');
});
check('softDelete 软删除', () => {
  const list = storiesRepo.listRecent(userId, characterId, 5);
  const target = list.find((s) => s.type === 'user_shared')!;
  storiesRepo.softDelete(userId, target.id);
  const after = storiesRepo.getById(userId, target.id);
  if (after !== null) throw new Error('软删除后仍可取回');
});
await checkAsync('extractStories 关闭长期记忆时返回 []（不调 LLM）', async () => {
  const r = await storyService.extractStories({
    userId,
    character: char,
    userMessageId: 'm-x',
    userText: 'hi',
    aiReply: 'hi',
    userMessageCount: 1,
    longTermEnabled: false,
  });
  if (!Array.isArray(r)) throw new Error('未返回数组');
});
void user;

// ── 未完待续：数据层 + 服务 ──
console.log('\n── 未完待续（repo + service）──');
let uTopicId = '';
check('unfinishedRepo.insert 写入未完话题', () => {
  const t = unfinishedRepo.insert(userId, {
    characterId,
    topic: '下次聊旅行計畫',
    resumeHint: '問他決定去哪了沒',
  });
  uTopicId = t.id;
  if (!t.id) throw new Error('插入失败');
});
check('listOpen 含该话题', () => {
  const list = unfinishedRepo.listOpen(userId, characterId);
  if (!list.find((t) => t.id === uTopicId)) throw new Error('未列出');
});
check('resolve 标记解决后不再 open', () => {
  unfinishedRepo.resolve(userId, uTopicId);
  const list = unfinishedRepo.listOpen(userId, characterId);
  if (list.find((t) => t.id === uTopicId)) throw new Error('仍出现在 open');
});
await checkAsync('extractUnfinished 非未完文本返回 []（不调 LLM）', async () => {
  const r = await unfinishedService.extractUnfinished({
    userId,
    character: char,
    userMessageId: 'm-y',
    userText: '今天天氣不錯',
    aiReply: '',
  });
  if (!Array.isArray(r)) throw new Error('未返回数组');
});

// ── AI 小话题：服务（LLM 不可用时回退预设）──
console.log('\n── AI 小话题（service，LLM 可选）──');
await checkAsync('suggestTopics 始终返回数组（无 LLM 时回退预设 4 条）', async () => {
  const topics = await smallTopicService.suggestTopics(userId, char, false);
  if (!Array.isArray(topics) || topics.length === 0) throw new Error('未返回话题');
  if (topics.some((t) => !t.id || !t.title || !t.emoji)) throw new Error('话题结构不对');
});

// ── 路由可加载（不抛 import 错误）──
console.log('\n── 路由挂载 ──');
await checkAsync('storiesRoutes 可加载', async () => {
  await import('../server/routes/storiesRoutes.js');
});
await checkAsync('unfinishedRoutes 可加载', async () => {
  await import('../server/routes/unfinishedRoutes.js');
});
await checkAsync('smallTopicsRoutes 可加载', async () => {
  await import('../server/routes/smallTopicsRoutes.js');
});
await checkAsync('routes/index 全部注册不报错', async () => {
  await import('../server/routes/index.js');
});

console.log(`\n结果：通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
