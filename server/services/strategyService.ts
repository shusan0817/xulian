/**
 * 回复策略选择器（需求 §7）
 *
 * 解决的核心问题：**检测到负面情绪就输出一大段安慰**是陪伴类产品最常见的败笔。
 * 用户轻微抱怨时被灌鸡汤，体验比不安慰更糟。
 *
 * 所以策略选择严格遵循「先理解，再决定」：
 *   危机 → 安全拦截 → 安慰 → 倾听 → 鼓励 → 陪伴 → 转话题 → 普通聊天
 *
 * 另外两条防呆：
 * - **连续同策略上限 3 轮**：连续安慰三轮会变成噪音，强制让 AI 换个方式。
 * - **低强度情绪不触发安慰**：intensity < 0.45 的负面情绪走普通聊天 + 共情，
 *   这是对「不要机械化安慰」的量化。
 */

import type { StrategyType } from '../../shared/constants.js';
import type { AnalysisResult } from './userEmotionService.js';

export interface StrategyInput {
  userEmotion: AnalysisResult;
  /** 最近几轮用过的策略（正序），用于避免连续重复 */
  recentStrategies: StrategyType[];
  /** 入方向安全检查是否拦截 */
  blocked: boolean;
  /** 用户是否明显表示不想继续当前话题 */
  wantsTopicChange?: boolean;
}

export interface StrategyDecision {
  strategy: StrategyType;
  /** 为什么选它（调试面板与日志用） */
  reason: string;
  /** 是否因为连续重复而被强制切换 */
  forcedSwitch: boolean;
}

/** 连续使用同一策略的上限 */
const MAX_REPEAT = 3;

export function pickStrategy(input: StrategyInput): StrategyDecision {
  const { userEmotion: ue, recentStrategies, blocked } = input;

  // 0) 危机最高优先
  if (ue.crisisSignal === 'severe') {
    return { strategy: 'crisis_care', reason: '偵測到危機訊號', forcedSwitch: false };
  }

  // 1) 安全拦截
  if (blocked) {
    return { strategy: 'blocked', reason: '話題不適合深入', forcedSwitch: false };
  }

  // 2) 用户明确想换话题
  if (input.wantsTopicChange || /(別說這個|不要聊這個|換個話題|不想提)/.test(ue.intent)) {
    return { strategy: 'topic_change', reason: '使用者不想繼續這個話題', forcedSwitch: false };
  }

  const negative = ue.valence <= -0.15;
  const strong = ue.intensity >= 0.45;

  // 3) 安慰：明显负面 + 需要安慰
  if (negative && strong && ue.needsComfort) {
    return { strategy: 'comfort', reason: `明顯負面情緒（valence ${ue.valence.toFixed(2)}）`, forcedSwitch: false };
  }

  // 4) 倾听：负面、自我表露深，但还没到需要安慰
  if (negative && ue.shareDepth >= 0.45) {
    return { strategy: 'listening', reason: '使用者正在傾訴，先接住再說', forcedSwitch: false };
  }

  // 5) 鼓励：明确寻求建议或打气
  if (/(建議|怎麼辦|該不該|加油|鼓勵|幫我)/.test(ue.intent) || /(怎麼辦|該怎麼|有什麼建議)/.test(ue.intent)) {
    return { strategy: 'encouragement', reason: '使用者在尋求建議或鼓勵', forcedSwitch: false };
  }

  // 6) 陪伴：孤单感
  if (/(孤單|寂寞|一個人|無聊|陪我)/.test(ue.intent) || ue.emotion === 'down') {
    return { strategy: 'companionship', reason: '使用者想有人陪著', forcedSwitch: false };
  }

  // 7) 默认普通聊天
  const decision: StrategyDecision = { strategy: 'normal_chat', reason: '一般對話', forcedSwitch: false };

  // 连续重复保护：同一策略连续用满 MAX_REPEAT 次就降级为普通聊天，
  // 让 AI 换个方式说话（避免"安慰三连"）
  const tail = recentStrategies.slice(-MAX_REPEAT);
  if (
    tail.length === MAX_REPEAT &&
    tail.every((s) => s === decision.strategy) &&
    decision.strategy !== 'normal_chat'
  ) {
    return {
      strategy: 'normal_chat',
      reason: `${decision.strategy} 已連續 ${MAX_REPEAT} 輪，降級為普通聊天`,
      forcedSwitch: true,
    };
  }

  return decision;
}

/**
 * 给前端展示用的策略说明（用户看得懂的版本）。
 * 注意：不暴露"诊断"类措辞（需求 §20）。
 */
export const STRATEGY_USER_LABELS: Record<StrategyType, string> = {
  normal_chat: '陪你聊聊',
  listening: '聽你說',
  comfort: '陪你難過',
  encouragement: '給你打氣',
  companionship: '待在你身邊',
  topic_change: '換個話題',
  crisis_care: '認真聽你說',
  blocked: '換個話題',
};
