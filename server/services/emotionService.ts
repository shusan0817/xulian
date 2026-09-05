/**
 * AI 情绪服务（需求 §5）
 *
 * 情绪不是 UI 上一个可切换的装饰品，它是**真正进入 Prompt L3 的状态**。
 *
 * 三个机制保证它既自然又稳定：
 * 1. **指数衰减**：情绪强度随时间自然回落，tau 由人格的 emotionSensitivity 决定
 *    （敏感度高的角色情绪来得快去得也快）。低于 floorIntensity 回落到平静，
 *    避免情绪永远停在一个微小数值上抖动。
 * 2. **规则 + LLM 融合**：规则层给出可预测的基准（R1–R8），LLM 负责语义理解，
 *    按 0.35 / 0.65 融合。单次强度变化硬上限 0.4——这是「不因一次情绪变化
 *    就完全改变人格」的量化实现。
 * 3. **沉默漂移**：用户长时间不互动时，AI 只能产生 caring 情绪且强度 ≤ 0.35。
 *    这条硬红线直接对应需求 §5「不能让 AI 用难过/痛苦来制造用户负罪感」。
 */

import { EMOTION_ANCHORS, EMOTION_TYPES } from '../../shared/constants.js';
import type { EmotionType } from '../../shared/constants.js';
import type { AICharacter, EmotionState } from '../../shared/types.js';
import { EMOTION_CONFIG, decayIntensity, emotionTauHours } from '../config/defaults.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import { completeJson } from '../agent/sdkClient.js';
import { buildEmotionUpdatePrompt } from '../agent/prompts.js';
import { logger } from '../logger.js';
import { clamp01 } from '../db/helpers.js';

// ============================================================
// 读取（含衰减）
// ============================================================

/**
 * 取当前情绪，并**先应用衰减再返回**。
 * 衰减在读取时计算（而不是靠定时任务），这样即使服务重启过也不会算错。
 */
export function getEmotion(userId: string, character: AICharacter): EmotionState {
  const existing = statesRepo.getEmotion(userId, character.id);
  if (!existing) {
    return statesRepo.upsertEmotion(userId, character.id, {
      currentEmotion: character.initialEmotion,
      intensity: 0.3,
      emotionReason: '初次見面',
    });
  }

  const tau = emotionTauHours(character.emotionSensitivity);
  const elapsedHours =
    (Date.now() - new Date(existing.lastDecayAt ?? existing.updatedAt).getTime()) / 3_600_000;

  const decayed = decayIntensity(existing.intensity, elapsedHours, tau);

  // 强度过低 → 回落到平静，避免情绪永远停在一个微小数值上抖动
  if (decayed < EMOTION_CONFIG.floorIntensity && existing.currentEmotion !== 'calm') {
    return statesRepo.upsertEmotion(userId, character.id, {
      currentEmotion: 'calm',
      intensity: 0.3,
      emotionReason: '情緒慢慢平復了',
    });
  }

  // 只在强度变化超过 0.01 时才写库，避免高频读造成无谓写入
  if (Math.abs(decayed - existing.intensity) > 0.01) {
    return statesRepo.upsertEmotion(userId, character.id, {
      currentEmotion: existing.currentEmotion,
      intensity: decayed,
      valence: existing.valence,
      arousal: existing.arousal,
      emotionReason: existing.emotionReason,
      lastDecayAt: new Date().toISOString(),
    });
  }

  return existing;
}

// ============================================================
// 规则层：可预测的情绪初判
// ============================================================

interface RuleResult {
  emotion: EmotionType;
  /** 目标强度 */
  intensity: number;
  reason: string;
}

const POSITIVE_MARKERS = ['開心', '高興', '哈哈哈', '太好了', '成功', '錄取', '過了', '喜歡', '驚喜', '棒'];
const NEGATIVE_MARKERS = ['難過', '難受', '委屈', '壓力', '累', '煩', '焦慮', '緊張', '失望', '崩潰', '孤單'];
const WORRY_MARKERS = ['擔心', '怕', '害怕', '不安', '如果失敗', '怎麼辦'];
const GRATITUDE_MARKERS = ['謝謝', '感謝', '多虧你', '有你在'];
const PRAISE_MARKERS = ['你好溫柔', '你好棒', '喜歡你', '好貼心'];

/**
 * 规则初判。
 * 存在的意义是给情绪一个「可预测的下限」——
 * 纯 LLM 判定在长对话里会漂移，规则层能把它拉回来。
 */
function ruleBasedEmotion(userText: string, current: EmotionType): RuleResult | null {
  const has = (list: string[]): boolean => list.some((w) => userText.includes(w));

  if (has(PRAISE_MARKERS)) {
    return { emotion: 'shy', intensity: 0.55, reason: '被使用者稱讚了' };
  }
  if (has(GRATITUDE_MARKERS)) {
    return { emotion: 'happy', intensity: 0.5, reason: '接收到使用者的感謝' };
  }
  if (has(POSITIVE_MARKERS)) {
    return { emotion: 'happy', intensity: 0.65, reason: '使用者分享了開心的事' };
  }
  if (has(WORRY_MARKERS)) {
    return { emotion: 'worried', intensity: 0.5, reason: '使用者表達了擔憂' };
  }
  if (has(NEGATIVE_MARKERS)) {
    // 用户低落时 AI 进入「关心」而不是「难过」——
    // 陪伴者的价值在于稳住，而不是跟着一起沉下去
    return { emotion: 'caring', intensity: 0.6, reason: '使用者正在經歷低潮' };
  }
  if (userText.length <= 6 && current !== 'calm') {
    return { emotion: current, intensity: 0.3, reason: '簡短的回應，情緒趨於平靜' };
  }
  return null;
}

// ============================================================
// 更新：LLM 校正 + 规则融合
// ============================================================

export interface EmotionUpdateInput {
  userId: string;
  character: AICharacter;
  userText: string;
  aiReply: string;
  userEmotionLabel: string;
}

/**
 * 一轮对话后更新 AI 情绪。
 *
 * 融合策略：0.35 规则 + 0.65 LLM。
 * LLM 挂掉时**静默降级**到纯规则（或维持原情绪）——
 * 情绪是锦上添花，绝不能因为情绪更新失败就让用户收不到回复。
 */
export async function updateAfterTurn(input: EmotionUpdateInput): Promise<EmotionState> {
  const { userId, character, userText, aiReply, userEmotionLabel } = input;
  const current = getEmotion(userId, character);

  const rule = ruleBasedEmotion(userText, current.currentEmotion);

  let llmResult: { emotion: EmotionType; intensity: number; reason: string } | null = null;
  try {
    llmResult = await completeJson<{ emotion: EmotionType; intensity: number; reason: string }>(
      {
        label: 'emotion',
        prompt: '請根據這輪對話判斷 AI 的情緒變化。',
        systemPrompt: buildEmotionUpdatePrompt({
          character,
          currentEmotion: current.currentEmotion,
          currentIntensity: current.intensity,
          emotionReason: current.emotionReason,
          userText,
          aiReply,
          userEmotionLabel,
        }),
      },
      (value): { emotion: EmotionType; intensity: number; reason: string } | null => {
        if (typeof value !== 'object' || value === null) return null;
        const v = value as Record<string, unknown>;
        const emotion = v.emotion;
        if (typeof emotion !== 'string' || !(EMOTION_TYPES as readonly string[]).includes(emotion)) {
          return null;
        }
        return {
          emotion: emotion as EmotionType,
          intensity: clamp01(typeof v.intensity === 'number' ? v.intensity : 0.4),
          reason: typeof v.reason === 'string' ? v.reason.slice(0, 60) : '',
        };
      },
    );
  } catch (err) {
    logger.warn('[Emotion] LLM 情緒校正失敗，降級為純規則', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 融合
  let targetEmotion: EmotionType;
  let targetIntensity: number;
  let reason: string;

  if (rule && llmResult) {
    targetEmotion = llmResult.emotion;
    targetIntensity = 0.35 * rule.intensity + 0.65 * llmResult.intensity;
    reason = llmResult.reason || rule.reason;
  } else if (llmResult) {
    targetEmotion = llmResult.emotion;
    targetIntensity = llmResult.intensity;
    reason = llmResult.reason;
  } else if (rule) {
    targetEmotion = rule.emotion;
    targetIntensity = rule.intensity;
    reason = rule.reason;
  } else {
    // 都没有 → 维持当前情绪，强度轻微回落
    targetEmotion = current.currentEmotion;
    targetIntensity = Math.max(0.2, current.intensity - 0.05);
    reason = current.emotionReason;
  }

  // 敏感度放大：敏感度高的角色情绪起伏更明显
  const sensitivity = character.emotionSensitivity;
  targetIntensity = clamp01(targetIntensity * (0.7 + 0.6 * sensitivity));

  // 硬约束：单次强度变化不超过 maxSingleDelta（防止一次对话把人格掀翻）
  const maxDelta = EMOTION_CONFIG.maxSingleDelta;
  const delta = targetIntensity - current.intensity;
  const clampedIntensity = clamp01(
    current.intensity + Math.max(-maxDelta, Math.min(maxDelta, delta)),
  );

  return statesRepo.upsertEmotion(userId, character.id, {
    currentEmotion: targetEmotion,
    intensity: clampedIntensity,
    valence: EMOTION_ANCHORS[targetEmotion].valence,
    arousal: EMOTION_ANCHORS[targetEmotion].arousal,
    emotionReason: reason,
  });
}

// ============================================================
// 沉默漂移
// ============================================================

/**
 * 用户长时间未互动时的情绪漂移。
 *
 * **硬红线**：只能产生 caring，强度上限 0.35。
 * 需求 §5 明确禁止 AI 用「你不回覆我我會難過」来制造负罪感，
 * 所以这里从代码层面就杜绝了 sad / down / angry 的可能。
 */
export function applySilenceDrift(
  userId: string,
  character: AICharacter,
  hoursSinceLastChat: number,
): EmotionState | null {
  if (hoursSinceLastChat < EMOTION_CONFIG.silenceTriggerHours) return null;

  const current = getEmotion(userId, character);
  if (current.currentEmotion === EMOTION_CONFIG.silenceEmotion) return null;

  return statesRepo.upsertEmotion(userId, character.id, {
    currentEmotion: EMOTION_CONFIG.silenceEmotion,
    intensity: Math.min(EMOTION_CONFIG.silenceIntensityCap, 0.3),
    emotionReason: '有點掛念使用者',
  });
}
