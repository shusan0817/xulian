/**
 * AI 成長展示（growth）：把成長頁需要的各類計數匯總成一個唯讀快照。
 *
 * 所有 repo 查詢都做了兜底（缺行 / 空結果 → 0 / null），絕不讓單表異常
 * 導致整個成長接口 500。各項含義見 GrowthSummary 註解。
 */

import * as memoriesRepo from '../db/repositories/memories.repo.js';
import * as storiesRepo from '../db/repositories/stories.repo.js';
import * as habitsRepo from '../db/repositories/habits.repo.js';
import * as insightsRepo from '../db/repositories/insights.repo.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';

export interface GrowthSummary {
  /** 長期記憶條數 */
  memories: number;
  /** 活躍故事條數（我們的故事） */
  stories: number;
  /** 里程碑故事條數（type = shared_milestone） */
  milestones: number;
  /** 活躍交流習慣條數 */
  habits: number;
  /** 活躍「AI 了解的你」偏好條數（全域作用域） */
  insights: number;
  /** 活躍天數（關係態 distinctActiveDays） */
  activeDays: number;
  /** 使用者累計發送訊息數 */
  totalMessages: number;
  /** 互動等級（0..1 → 0..100 的整數百分比） */
  interactionLevelPct: number;
  /** 關係階段；無關係態時回落 'stranger' */
  stage: string;
  /** 第一次聊天時間（ISO 字串）；無則 null */
  firstChatAt: string | null;
}

/** 匯總某個 (使用者, 角色) 的成長快照。唯讀、冪等、失敗安全。 */
export function getGrowth(userId: string, characterId: string): GrowthSummary {
  const rel = safe(() => statesRepo.getRelationship(userId, characterId)) ?? null;

  const memories = safe(() => memoriesRepo.countMemories(userId, characterId)) ?? 0;
  const stories = safe(() => storiesRepo.countActive(userId, characterId)) ?? 0;
  const milestones = safe(
    () => storiesRepo.list(userId, { characterId, type: 'shared_milestone' }).total,
  ) ?? 0;
  const habits = safe(() => habitsRepo.countActive(userId, characterId)) ?? 0;
  const insights = safe(() => insightsRepo.countActive(userId, '')) ?? 0;
  const activeDays = rel?.distinctActiveDays ?? 0;
  const totalMessages =
    rel?.totalUserMessages ?? safe(() => conversationsRepo.countUserMessages(userId, characterId)) ?? 0;
  const interactionLevelPct = Math.round((rel?.interactionLevel ?? 0) * 100);
  const stage = rel?.stage ?? 'stranger';

  const firstChatAt = safe(() => {
    const fc = storiesRepo.list(userId, { characterId, type: 'first_chat', limit: 1 });
    return fc.items[0]?.happenedAt ?? null;
  }) ?? null;

  return {
    memories,
    stories,
    milestones,
    habits,
    insights,
    activeDays,
    totalMessages,
    interactionLevelPct,
    stage,
    firstChatAt,
  };
}

/**
 * 把任意 repo 查詢包進 try，異常時返回 null（由呼叫點決定回落值）。
 * 目的是讓「某個計數炸了」不拖垮整個成長接口——這是唯讀展示頁，
 * 容忍單項缺失遠比整頁 500 更符合產品語義。
 */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
