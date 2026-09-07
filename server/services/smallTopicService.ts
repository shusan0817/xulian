/**
 * smallTopicService —— 「AI 小话题 / 今天聊什么」（P1，净新增）
 *
 * 给「不知道聊什么」的用户一个自然的入口：基于 TA 对你的了解（长期记忆）
 * 由 LLM 生成 3–4 个轻松可接的小话题；LLM 不可用时回退到预设暖场话题。
 *
 * 全程 try/catch：这是「锦上添花」，失败也要能返回可用的预设。
 */

import * as memoriesRepo from '../db/repositories/memories.repo.js';
import { completeJson } from '../agent/sdkClient.js';
import { logger } from '../logger.js';
import type { AICharacter } from '../../shared/types.js';

export interface SmallTopic {
  id: string;
  title: string;
  hint: string;
  emoji: string;
}

/** 预设暖场话题（LLM 不可用 / 还没有记忆时回退） */
const PRESETS: SmallTopic[] = [
  { id: 'preset-mood', title: '今天心情如何', hint: '隨便說說今天發生的事', emoji: '🌤️' },
  { id: 'preset-music', title: '最近在聽什麼歌', hint: '分享一首讓你 loop 的歌', emoji: '🎵' },
  { id: 'preset-food', title: '今天吃了什麼', hint: '好吃的難吃的都行', emoji: '🍜' },
  { id: 'preset-dream', title: '昨晚夢到什麼', hint: '奇怪的夢也可以聊', emoji: '🌙' },
  { id: 'preset-plan', title: '最近有什麼小計劃', hint: '週末想去哪、想做什麼', emoji: '🗺️' },
  { id: 'preset-random', title: '聊點無聊的', hint: '貓、天氣、或任何小事', emoji: '🍃' },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildPrompt(known: string[]): string {
  const knownLines = known.length
    ? `## 你已經知道的關於這個人的事（用來讓話題更貼近他，不要直接複述）\n${known
        .map((c) => `- ${c}`)
        .join('\n')}`
    : '## 你還不太了解他（用輕鬆、不會尷尬的暖場話題）';

  return `你是陪伴型 AI 角色的「小話題」生成器。幫使用者想幾個今天可以輕鬆聊起的小話題。

${knownLines}

## 要求
- 話題要輕、好接、不給壓力；
- 可以偶爾呼應你已知的他的喜好，但不要顯得太刻意；
- 每個話題給一個標題（≤10字）、一句怎麼開口的提示（≤20字）、一個 emoji。

## 輸出
只輸出 JSON：{"topics":[{"title":"<標題>","hint":"<開口提示>","emoji":"<單個emoji>"}]}
生成 4 個。`;
}

export async function suggestTopics(
  userId: string,
  character: AICharacter,
  longTermEnabled: boolean,
): Promise<SmallTopic[]> {
  try {
    const known = longTermEnabled
      ? memoriesRepo.searchMemories(userId, character.id, 6).map((m) => m.content)
      : [];

    const parsed = await completeJson<{
      topics: Array<{ title: string; hint: string; emoji: string }>;
    }>(
      {
        label: 'small-topics',
        prompt: '生成今天可以聊的小話題',
        systemPrompt: buildPrompt(known),
      },
      (value): { topics: Array<{ title: string; hint: string; emoji: string }> } | null => {
        if (typeof value !== 'object' || value === null) return null;
        const v = value as Record<string, unknown>;
        if (!Array.isArray(v.topics)) return null;
        const topics = (v.topics as unknown[])
          .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
          .map((t) => ({
            title: typeof t.title === 'string' ? t.title.trim().slice(0, 12) : '',
            hint: typeof t.hint === 'string' ? t.hint.trim().slice(0, 24) : '',
            emoji: typeof t.emoji === 'string' ? t.emoji.trim().slice(0, 2) : '💬',
          }))
          .filter((t) => t.title.length >= 1 && t.hint.length >= 1);
        return { topics: topics.slice(0, 4) };
      },
    );

    if (parsed?.topics?.length) {
      return parsed.topics.map((t, i) => ({
        id: `gen-${i}`,
        title: t.title,
        hint: t.hint,
        emoji: t.emoji || '💬',
      }));
    }
  } catch (err) {
    logger.warn('[SmallTopic] 話題生成失敗，回退預設', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return shuffle(PRESETS).slice(0, 4);
}
