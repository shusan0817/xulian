/**
 * storyService —— 「我们的故事」（V2-2）业务层
 *
 * 职责：
 * 1. 注入 Prompt：listRecentForPrompt 返回 ChatContext.stories 所需结构；
 * 2. 抽取：extractStories 在每轮对话后异步调用，用 LLM 把「你们之间发生的事」落库；
 * 3. 首聊里程碑：ensureFirstChatStory 幂等创建 first_chat 故事；
 * 4. CRUD 包装：供 storiesRoutes 直接复用 repo（用户可查看/改/删/还原）。
 *
 * 硬约束（需求 V2-2）：
 * - 全程 try/catch：故事是增值能力，绝不能因为它失败而让用户收不到回复；
 * - 敏感信息不入库（containsSensitive 把关）；
 * - 自动抽取的故事必须有来源消息（source_message_ids 非空），first_chat 例外（系统里程碑）。
 */

import * as storiesRepo from '../db/repositories/stories.repo.js';
import { completeJson } from '../agent/sdkClient.js';
import { buildStoryExtractPrompt } from '../agent/prompts.js';
import { STORY_TYPES, type StoryType } from '../../shared/constants.js';
import { containsSensitive } from './memoryService.js';
import { logger } from '../logger.js';
import { clamp01 } from '../db/helpers.js';
import type { AICharacter, Story } from '../../shared/types.js';

// ============================================================
// 1. 注入 Prompt（对应 ChatContext.stories）
// ============================================================

export function listRecentForPrompt(
  userId: string,
  characterId: string,
  limit = 3,
): Array<{ id: string; title: string }> {
  return storiesRepo
    .listRecent(userId, characterId, limit)
    .map((s) => ({ id: s.id, title: s.title }));
}

// ============================================================
// 2. 抽取（对话后异步）
// ============================================================

export interface StoryExtractInput {
  userId: string;
  character: AICharacter;
  userMessageId: string;
  userText: string;
  aiReply: string;
  /** 用户消息总数（用于每 N 条兜底） */
  userMessageCount: number;
  longTermEnabled: boolean;
}

interface ExtractedStory {
  type: string;
  title: string;
  summary: string;
  importance: number;
}

/** 是否值得抽取：与记忆同思路（敏感/关闭/太短都不抽） */
function shouldExtract(input: StoryExtractInput): boolean {
  if (!input.longTermEnabled) return false;
  if (containsSensitive(input.userText)) return false;
  if (input.userText.trim().length < 12) return false;
  // 每 3 条用户消息兜底抽一次，避免漏掉值得记的瞬间
  if (input.userMessageCount > 0 && input.userMessageCount % 3 === 0) return true;
  return false;
}

/**
 * 抽取并入库。
 * 失败时返回 []（不影响对话主流程）。
 */
export async function extractStories(input: StoryExtractInput): Promise<Story[]> {
  if (!shouldExtract(input)) return [];

  const { userId, character, userMessageId, userText, aiReply } = input;
  try {
    const parsed = await completeJson<{ stories: ExtractedStory[] }>(
      {
        label: 'story',
        prompt: '從這段對話中抽取值得長期記住的「你們之間發生的事」',
        systemPrompt: buildStoryExtractPrompt({ userText, aiReply }),
      },
      (value): { stories: ExtractedStory[] } | null => {
        if (typeof value !== 'object' || value === null) return null;
        const v = value as Record<string, unknown>;
        if (!Array.isArray(v.stories)) return null;
        const stories = (v.stories as unknown[])
          .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
          .map((s) => ({
            type: (STORY_TYPES as readonly string[]).includes(String(s.type))
              ? String(s.type)
              : 'user_shared',
            title: typeof s.title === 'string' ? s.title.trim().slice(0, 40) : '',
            summary: typeof s.summary === 'string' ? s.summary.trim().slice(0, 200) : '',
            importance: clamp01(typeof s.importance === 'number' ? s.importance : 0.5),
          }))
          .filter(
            (s) =>
              s.title.length >= 2 &&
              s.summary.length >= 2 &&
              !containsSensitive(s.title) &&
              !containsSensitive(s.summary),
          );
        return { stories: stories.slice(0, 2) };
      },
    );

    if (!parsed?.stories?.length) return [];

    const saved: Story[] = [];
    for (const s of parsed.stories) {
      const created = storiesRepo.insert(userId, {
        characterId: character.id,
        type: s.type as StoryType,
        title: s.title,
        summary: s.summary,
        importance: s.importance,
        source: 'llm',
        sourceMessageIds: [userMessageId],
        happenedAt: new Date().toISOString(),
      });
      saved.push(created);
    }

    if (saved.length) logger.info('[Story] 抽取故事', { count: saved.length });
    return saved;
  } catch (err) {
    logger.warn('[Story] 故事抽取失敗（不影響對話）', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ============================================================
// 3. 首聊里程碑（幂等）
// ============================================================

export function ensureFirstChatStory(
  userId: string,
  character: AICharacter,
  userMessageId: string,
): Story | null {
  if (storiesRepo.hasFirstChat(userId, character.id)) return null;
  return storiesRepo.insert(userId, {
    characterId: character.id,
    type: 'first_chat',
    title: `第一次和${character.name}說話`,
    summary: `這是你們聊天的起點——從此有人記得你說過的話。`,
    importance: 0.9,
    source: 'auto',
    sourceMessageIds: [userMessageId],
    happenedAt: new Date().toISOString(),
  });
}

// ============================================================
// 4. CRUD 包装（供 routes 复用）
// ============================================================

export const listStories = storiesRepo.list;
export const getStory = storiesRepo.getById;
export const updateStory = storiesRepo.update;
export const deleteStory = storiesRepo.softDelete;
export const restoreStory = storiesRepo.restoreAuto;
