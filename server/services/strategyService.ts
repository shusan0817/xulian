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
 *
 * ── V2 扩展（设计 §4.2）：用户可选的 ChatMode 接入优先级链 ──────────────
 *
 *   1. crisisSignal === 'severe'          → crisis_care   🔒 不可被用户覆盖
 *   2. 入方向安全拦截 (blocked)            → blocked       🔒 不可被用户覆盖
 *   3. chatMode !== 'auto'                → CHAT_MODE_TO_STRATEGY[chatMode]
 *      └ 用户主权：不再走 AI 自选，也不因 wantsTopicChange 而切换
 *   4. chatMode === 'auto'                → 上面的 AI 自选链（扩展版）
 *
 * 连续重复保护分两档：
 *   - auto 模式：MAX_REPEAT_AUTO = 3，超限降级为 normal_chat（沿用 V1）
 *   - 用户选定模式：MAX_REPEAT_USER = 6，且**降级目标仍是该模式**，
 *     只在 L7 追加「換個說法」提示（needsVariation），不静默切走 —— 用户主权优先
 */

import type { ChatMode, StrategyType } from '../../shared/constants.js';
import { CHAT_MODE_TO_STRATEGY, normalizeChatMode } from '../../shared/constants.js';
import { PROMPT_V2_FLAGS } from '../config/defaults.js';
import type { AnalysisResult } from './userEmotionService.js';

export interface StrategyInput {
  userEmotion: AnalysisResult;
  /** 最近几轮用过的策略（正序），用于避免连续重复 */
  recentStrategies: StrategyType[];
  /** 入方向安全检查是否拦截 */
  blocked: boolean;
  /** 用户是否明显表示不想继续当前话题 */
  wantsTopicChange?: boolean;
  /**
   * 用户选定的聊天模式。'auto' / undefined = 交给 AI 自选。
   * 非法值由 normalizeChatMode 兜底为 'auto'，绝不让脏数据影响选择。
   */
  chatMode?: ChatMode;
}

export interface StrategyDecision {
  strategy: StrategyType;
  /** 为什么选它（调试面板与日志用） */
  reason: string;
  /** 是否因为连续重复而被强制切换 */
  forcedSwitch: boolean;
  /** 模式来源：系统接管 / 用户选定 / AI 自选 */
  modeSource: 'system' | 'user' | 'ai';
  /** 生效的聊天模式（系统接管时回传 'auto'，表示用户选择本轮不生效） */
  chatMode: ChatMode;
  /** 同一模式连用到上限：不切走，只在 L7 追加「换个说法」提示 */
  needsVariation?: boolean;
}

/** auto 模式下连续使用同一策略的上限（沿用 V1） */
const MAX_REPEAT_AUTO = 3;
/** 用户选定模式下的上限：更宽松，因为切走等于违背用户意愿 */
const MAX_REPEAT_USER = 6;

export function pickStrategy(input: StrategyInput): StrategyDecision {
  const { userEmotion: ue, recentStrategies, blocked } = input;
  const chatMode = normalizeChatMode(input.chatMode);

  // 0) 危机最高优先（🔒 不可被用户选择的模式覆盖）
  if (ue.crisisSignal === 'severe') {
    return {
      strategy: 'crisis_care',
      reason: '偵測到危機訊號',
      forcedSwitch: false,
      modeSource: 'system',
      chatMode: 'auto',
    };
  }

  // 1) 安全拦截（🔒 不可被用户选择的模式覆盖）
  if (blocked) {
    return {
      strategy: 'blocked',
      reason: '話題不適合深入',
      forcedSwitch: false,
      modeSource: 'system',
      chatMode: 'auto',
    };
  }

  // 2) 用户主权：用户明确选了模式 → 直接用它，不因 wantsTopicChange 而切换。
  //    （用户明确选了「倾听」，就不要自作主张换话题）
  if (chatMode !== 'auto') {
    const strategy = CHAT_MODE_TO_STRATEGY[chatMode];
    const tail = recentStrategies.slice(-MAX_REPEAT_USER);
    const repeated =
      tail.length === MAX_REPEAT_USER && tail.every((s) => s === strategy);
    return {
      strategy,
      reason: repeated
        ? `使用者選定「${chatMode}」，已連續 ${MAX_REPEAT_USER} 輪，本輪換個說法`
        : `使用者選定的聊天模式：${chatMode}`,
      forcedSwitch: false,
      modeSource: 'user',
      chatMode,
      needsVariation: repeated || undefined,
    };
  }

  // 3) 用户明确想换话题（仅 auto 模式）
  if (input.wantsTopicChange || /(別說這個|不要聊這個|換個話題|不想提)/.test(ue.intent)) {
    return {
      strategy: 'topic_change',
      reason: '使用者不想繼續這個話題',
      forcedSwitch: false,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  const negative = ue.valence <= -0.15;
  const strong = ue.intensity >= 0.45;

  // 4) 安慰：明显负面 + 需要安慰
  if (negative && strong && ue.needsComfort) {
    return {
      strategy: 'comfort',
      reason: `明顯負面情緒（valence ${ue.valence.toFixed(2)}）`,
      forcedSwitch: false,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  // 5) 倾听：负面、自我表露深，但还没到需要安慰
  if (negative && ue.shareDepth >= 0.45) {
    return {
      strategy: 'listening',
      reason: '使用者正在傾訴，先接住再說',
      forcedSwitch: false,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  // 6) 鼓励：明确寻求建议或打气
  if (/(建議|怎麼辦|該不該|加油|鼓勵|幫我)/.test(ue.intent) || /(怎麼辦|該怎麼|有什麼建議)/.test(ue.intent)) {
    return {
      strategy: 'encouragement',
      reason: '使用者在尋求建議或鼓勵',
      forcedSwitch: false,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  // 7) 分享开心（V2 新增，仅 auto 模式 + 灰度开关开启时）：
  //    明显正向情绪也让 AI 有对应的接法，而不是一律走普通聊天
  if (
    PROMPT_V2_FLAGS.modeLayer &&
    ue.valence >= 0.5 &&
    (ue.emotion === 'happy' || ue.emotion === 'excited')
  ) {
    return {
      strategy: 'share_joy',
      reason: `使用者在分享開心的事（valence ${ue.valence.toFixed(2)}）`,
      forcedSwitch: false,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  // 8) 陪伴：孤单感
  if (/(孤單|寂寞|一個人|無聊|陪我)/.test(ue.intent) || ue.emotion === 'down') {
    return {
      strategy: 'companionship',
      reason: '使用者想有人陪著',
      forcedSwitch: false,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  // 9) 默认普通聊天
  const decision: StrategyDecision = {
    strategy: 'normal_chat',
    reason: '一般對話',
    forcedSwitch: false,
    modeSource: 'ai',
    chatMode: 'auto',
  };

  // 连续重复保护：同一策略连续用满 MAX_REPEAT_AUTO 次就降级为普通聊天，
  // 让 AI 换个方式说话（避免"安慰三连"）
  const tail = recentStrategies.slice(-MAX_REPEAT_AUTO);
  if (
    tail.length === MAX_REPEAT_AUTO &&
    tail.every((s) => s === decision.strategy) &&
    decision.strategy !== 'normal_chat'
  ) {
    return {
      strategy: 'normal_chat',
      reason: `${decision.strategy} 已連續 ${MAX_REPEAT_AUTO} 輪，降級為普通聊天`,
      forcedSwitch: true,
      modeSource: 'ai',
      chatMode: 'auto',
    };
  }

  return decision;
}

/**
 * 给前端展示用的策略说明（用户看得懂的版本）。
 * 注意：不暴露"诊断"类措辞（需求 §20）。
 *
 * V2：13 个策略全部来自 `shared/constants.ts` 的单一数据源（CHAT_MODE_REGISTRY），
 * 这里只是再导出，避免两处维护导致漂移。
 */
export { STRATEGY_USER_LABELS } from '../../shared/constants.js';
