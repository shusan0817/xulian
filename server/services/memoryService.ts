/**
 * 记忆服务（需求 §8）
 *
 * 分两层，职责完全不同：
 *
 * **短期记忆**：滚动摘要 + 最近 20 条。
 * 关键是「不把全部历史塞给模型」——长对话全量注入既贵又会让模型抓不住重点。
 * 超过阈值时把旧消息压缩成摘要，摘要本身也参与后续压缩（滚动）。
 *
 * **长期记忆**：只存真正有价值的信息。
 * 三个防失控设计：
 * 1. **触发式抽取**（不是每轮都抽）：命中显式信号 / 长文本 / 强情绪才抽，
 *    另加每 10 条兜底。省成本，也避免把闲聊碎片全记下来。
 * 2. **两层去重**：dedupeKey（category + 内容指纹）挡住完全重复，
 *    bigram Jaccard ≥ 0.62 挡住同义重复（改成更新而非新增）。
 * 3. **敏感信息默认不入库**（身份证 / 银行卡 / 手机号 / 住址 / 病历）。
 *
 * 用户可以关闭长期记忆（隐私设置），关闭后既不抽取也不注入。
 */

import type { AICharacter, Conversation, MemoryItem, MessageRecord } from '../../shared/types.js';
import type { MemoryCategory } from '../../shared/constants.js';
import { MEMORY_CATEGORIES, MEMORY_DEDUPE_JACCARD, MAX_HISTORY_MESSAGES } from '../../shared/constants.js';
import {
  CONTEXT_CONFIG,
  MEMORY_CONFIG,
} from '../config/defaults.js';
import * as memoriesRepo from '../db/repositories/memories.repo.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import { completeJson, completeText } from '../agent/sdkClient.js';
import { buildMemoryExtractPrompt, buildSummaryPrompt } from '../agent/prompts.js';
import { bigrams, clamp01, jaccard, normalizeText } from '../db/helpers.js';
import { logger } from '../logger.js';

// ============================================================
// 短期记忆
// ============================================================

export interface ShortTerm {
  summary: string;
  recent: MessageRecord[];
}

export function buildShortTerm(
  userId: string,
  conversation: Conversation,
): ShortTerm {
  // 历史天花板：短期窗口与全局上限取较小值，避免长对话无限撑大 Prompt（多租户安全无关，仅成本/稳定性）
  const historyLimit = Math.min(CONTEXT_CONFIG.shortTermWindow, MAX_HISTORY_MESSAGES);
  const recent = conversationsRepo.listRecentMessages(userId, conversation.id, historyLimit);
  return { summary: conversation.summary, recent };
}

/**
 * 滚动摘要压缩。
 * 触发条件：总条数 > 30 且距上次摘要新增 >= 20 条。
 * 失败不影响主流程（摘要只是上下文优化）。
 */
export async function maybeSummarize(
  userId: string,
  conversation: Conversation,
): Promise<void> {
  const total = conversation.messageCount;
  if (total <= CONTEXT_CONFIG.summaryTriggerTotal) return;

  const all = conversationsRepo.listRecentMessages(userId, conversation.id, 200);
  const lastSummarizedIndex = conversation.summaryUpdatedTo
    ? all.findIndex((m) => m.id === conversation.summaryUpdatedTo)
    : -1;
  const newMessages = all.slice(lastSummarizedIndex + 1);

  // 保留最近 10 条不进摘要（它们本来就在短期窗口里）
  if (newMessages.length < CONTEXT_CONFIG.summaryTriggerNew) return;
  const toSummarize = newMessages.slice(0, Math.max(0, newMessages.length - 10));
  if (!toSummarize.length) return;

  try {
    const { text } = await completeText({
      label: 'summary',
      prompt: '請壓縮這段對話。',
      systemPrompt: buildSummaryPrompt({
        previousSummary: conversation.summary,
        newMessages: toSummarize.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    const summary = text.trim().slice(0, CONTEXT_CONFIG.summaryMaxChars);
    if (!summary) return;

    conversationsRepo.updateConversation(userId, conversation.id, {
      summary,
      summaryUpdatedTo: toSummarize[toSummarize.length - 1]!.id,
    });
    logger.info('[Memory] 滾動摘要已更新', { conversationId: conversation.id, length: summary.length });
  } catch (err) {
    logger.warn('[Memory] 摘要壓縮失敗，維持原狀', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================================
// 长期记忆检索
// ============================================================

/**
 * 取本轮要注入 Prompt 的记忆。
 * 策略：高分 top6 + 重要度 ≥ 0.8 的锚点无条件补 3 条（避免关键偏好被挤掉）。
 */
export function retrieveForPrompt(
  userId: string,
  characterId: string,
  longTermEnabled: boolean,
): MemoryItem[] {
  if (!longTermEnabled) return [];

  const top = memoriesRepo.searchMemories(userId, characterId, MEMORY_CONFIG.topK);
  const ids = new Set(top.map((m) => m.id));

  const anchors = memoriesRepo
    .listMemories(userId, { characterId, limit: 200 })
    .items.filter((m) => m.importance >= 0.8 && !ids.has(m.id))
    .slice(0, 3);

  const result = [...top, ...anchors];
  if (result.length) {
    memoriesRepo.bumpHit(userId, result.map((m) => m.id));
  }
  return result;
}

// ============================================================
// 长期记忆抽取
// ============================================================

export interface ExtractInput {
  userId: string;
  character: AICharacter;
  messageId: string;
  userText: string;
  aiReply?: string;
  /** 本轮用户情绪强度，用于触发判定 */
  userEmotionIntensity: number;
  /** 用户消息总数（用于每 N 条兜底） */
  userMessageCount: number;
  longTermEnabled: boolean;
}

/** 判断是否值得抽取 */
function shouldExtract(input: ExtractInput): boolean {
  if (!input.longTermEnabled) return false;
  if (containsSensitive(input.userText)) return false;

  // 1) 显式信号
  if (MEMORY_CONFIG.explicitPatterns.some((p) => input.userText.includes(p))) return true;
  // 2) 长文本
  if (input.userText.length >= MEMORY_CONFIG.lengthTrigger) return true;
  // 3) 强情绪（情绪强烈时说的内容更值得记）
  if (input.userEmotionIntensity >= MEMORY_CONFIG.intensityTrigger) return true;
  // 4) 兜底：每 N 条
  if (input.userMessageCount > 0 && input.userMessageCount % MEMORY_CONFIG.everyN === 0) return true;

  return false;
}

/** 敏感信息检测（需求 §8：不要自动保存不必要的敏感信息） */
export function containsSensitive(text: string): boolean {
  return MEMORY_CONFIG.sensitivePatterns.some((re) => re.test(text));
}

interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
  importance: number;
}

/**
 * 抽取并入库。
 * 全程 try/catch —— 记忆是增值能力，绝不能因为它失败而让用户收不到回复。
 */
export async function extractMemories(input: ExtractInput): Promise<MemoryItem[]> {
  if (!shouldExtract(input)) return [];

  const { userId, character, messageId, userText, aiReply } = input;

  try {
    const existing = memoriesRepo
      .listMemories(userId, { characterId: character.id, limit: 100 })
      .items.map((m) => ({ content: m.content, category: m.category }));

    const parsed = await completeJson<{ memories: ExtractedMemory[] }>(
      {
        label: 'memory',
        prompt: '從這段對話中抽取值得長期記住的資訊。',
        systemPrompt: buildMemoryExtractPrompt({ userText, aiReply, existing }),
      },
      (value): { memories: ExtractedMemory[] } | null => {
        if (typeof value !== 'object' || value === null) return null;
        const v = value as Record<string, unknown>;
        if (!Array.isArray(v.memories)) return null;
        const memories = v.memories
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .map((m) => ({
            category: (
              (MEMORY_CATEGORIES as readonly string[]).includes(String(m.category))
                ? String(m.category)
                : 'profile'
            ) as MemoryCategory,
            content: typeof m.content === 'string' ? m.content.trim().slice(0, 60) : '',
            importance: clamp01(typeof m.importance === 'number' ? m.importance : 0.5),
          }))
          .filter((m) => m.content.length >= 2 && !containsSensitive(m.content));
        return { memories: memories.slice(0, 5) };
      },
    );

    if (!parsed?.memories?.length) return [];

    const saved: MemoryItem[] = [];
    for (const m of parsed.memories) {
      const item = upsertWithDedupe(userId, character.id, messageId, m);
      if (item) saved.push(item);
    }

    if (saved.length) {
      logger.info('[Memory] 新增/更新長期記憶', { count: saved.length });
    }
    return saved;
  } catch (err) {
    logger.warn('[Memory] 記憶抽取失敗（不影響對話）', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * 带去重的写入。
 * 先看 dedupeKey 是否命中；再对同 category 的记忆算 bigram Jaccard，
 * 相似度过高视为同一件事 → 更新内容而不是新增。
 */
function upsertWithDedupe(
  userId: string,
  characterId: string,
  sourceMessageId: string,
  candidate: ExtractedMemory,
): MemoryItem | null {
  const existing = memoriesRepo.listForDedupe(userId, characterId, candidate.category);
  const candidateBigrams = bigrams(normalizeText(candidate.content));

  for (const item of existing) {
    const similarity = jaccard(candidateBigrams, bigrams(normalizeText(item.content)));
    if (similarity >= MEMORY_DEDUPE_JACCARD) {
      // 同义记忆：保留重要度更高的，更新内容。
      // 不覆盖 sourceMessageId——它记录的是"最初从哪句话里发现的"，更新不应改写出处
      return memoriesRepo.updateMemory(userId, item.id, {
        content: candidate.content,
        importance: Math.max(item.importance, candidate.importance),
      });
    }
  }

  // 没有同义 → 新增（dedupeKey 唯一约束会挡住完全重复）
  try {
    return memoriesRepo.insertMemory(userId, {
      characterId,
      category: candidate.category,
      content: candidate.content,
      importance: candidate.importance,
      isSensitive: false,
      sourceMessageId,
    });
  } catch {
    // 唯一约束冲突：说明已经有几乎一样的记忆了，忽略即可
    return null;
  }
}
