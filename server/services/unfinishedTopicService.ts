/**
 * unfinishedTopicService —— 「未完待续」（P0）
 *
 * 职责：
 * 1. 抽取：extractUnfinished 在每轮对话后调用，用启发式 + LLM 判断用户是否留下了
 *    没说完的话题；命中则落库（去重复用同一话题，超出上限归档最旧）；
 * 2. 列表：listOpen 供主动消息引擎与前端读取；
 * 3. 解决：resolve 在用户回来聊到该话题时标记关闭。
 *
 * 全程 try/catch：未完待续是增值能力，失败不影响对话。
 */

import * as unfinishedRepo from '../db/repositories/unfinishedTopics.repo.js';
import { completeJson } from '../agent/sdkClient.js';
import { buildUnfinishedExtractPrompt } from '../agent/prompts.js';
import { containsSensitive } from './memoryService.js';
import { logger } from '../logger.js';
import type { AICharacter } from '../../shared/types.js';
import type { UnfinishedTopic } from '../db/repositories/unfinishedTopics.repo.js';

export interface UnfinishedExtractInput {
  userId: string;
  character: AICharacter;
  userMessageId: string;
  userText: string;
  aiReply: string;
}

interface ExtractedItem {
  topic: string;
  resumeHint: string;
}

/** 启发式预筛：明显「没说完」才进 LLM，省成本 */
function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (t.endsWith('?') || t.endsWith('？')) return true;
  if (/下次|改天|以後|以后|回頭|晚點|晚点|之後|之后|留到|等下|等一下|下次再|改天再|有空|有空再|再說|再说|先不說|回頭聊|之後聊/.test(t))
    return true;
  // 长句但没句号收尾，可能话没说完
  if (t.length > 36 && !/[。.!！.?？]$/.test(t)) return true;
  return false;
}

/** 简单相似度（字符重合），用于同话题去重 */
function similarity(a: string, b: string): number {
  const sa = new Set(a.split(''));
  const sb = new Set(b.split(''));
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function extractUnfinished(
  input: UnfinishedExtractInput,
): Promise<UnfinishedTopic[]> {
  if (!looksUnfinished(input.userText)) return [];
  if (containsSensitive(input.userText)) return [];

  const { userId, character, userMessageId, userText, aiReply } = input;
  try {
    const parsed = await completeJson<{ items: ExtractedItem[] }>(
      {
        label: 'unfinished',
        prompt: '判斷這句話是否留下了未完的話題',
        systemPrompt: buildUnfinishedExtractPrompt({ userText, aiReply }),
      },
      (value): { items: ExtractedItem[] } | null => {
        if (typeof value !== 'object' || value === null) return null;
        const v = value as Record<string, unknown>;
        if (!Array.isArray(v.items)) return null;
        const items = (v.items as unknown[])
          .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
          .map((s) => ({
            topic: typeof s.topic === 'string' ? s.topic.trim().slice(0, 60) : '',
            resumeHint: typeof s.resumeHint === 'string' ? s.resumeHint.trim().slice(0, 200) : '',
          }))
          .filter((s) => s.topic.length >= 2 && !containsSensitive(s.topic));
        return { items: items.slice(0, 1) };
      },
    );

    if (!parsed?.items?.length) return [];

    const open = unfinishedRepo.listOpen(userId, character.id, 12);
    const saved: UnfinishedTopic[] = [];

    for (const it of parsed.items) {
      const dup = open.find(
        (e) => e.topic === it.topic || similarity(e.topic, it.topic) > 0.6,
      );
      if (dup) {
        const touched = unfinishedRepo.touch(userId, dup.id, it.resumeHint);
        if (touched) saved.push(touched);
      } else {
        const created = unfinishedRepo.insert(userId, {
          characterId: character.id,
          topic: it.topic,
          resumeHint: it.resumeHint,
          sourceMessageIds: [userMessageId],
        });
        saved.push(created);
      }
    }

    // 控制规模：保留最近 6 条，其余归档
    unfinishedRepo.archiveOverflow(userId, character.id, 6);
    if (saved.length) logger.info('[Unfinished] 记录未完话题', { count: saved.length });
    return saved;
  } catch (err) {
    logger.warn('[Unfinished] 未完話題抽取失敗（不影響對話）', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function listOpen(
  userId: string,
  characterId?: string,
  limit = 6,
): UnfinishedTopic[] {
  return unfinishedRepo.listOpen(userId, characterId, limit);
}

export function resolve(userId: string, id: string): boolean {
  return unfinishedRepo.resolve(userId, id);
}

export function remove(userId: string, id: string): boolean {
  return unfinishedRepo.softDelete(userId, id);
}

export function countOpen(userId: string, characterId?: string): number {
  return unfinishedRepo.countOpen(userId, characterId);
}
