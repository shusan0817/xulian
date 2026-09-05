/**
 * 用户情绪分析服务（需求 §6 / §20）
 *
 * 设计原则：
 * 1. **危机词先行**：关键词命中 severe 时直接短路，跳过 LLM。
 *    危机场景无法承受模型的误判，这是安全底线而不是性能考虑。
 * 2. **规则 + LLM 融合（0.4 / 0.6）**：规则层负责可预测，LLM 负责语义。
 * 3. **可解释**：每条分析都带 reasons[]，前端可以展示「为什么 AI 这样回应」，
 *    也便于我们自己调试。
 * 4. **只做语言情绪理解，不做心理诊断**（需求 §20）。
 *    输出里永远不出现诊断性词汇，前端展示时也只显示温柔化的情绪标签。
 */

import { EMOTION_ANCHORS, EMOTION_TYPES } from '../../shared/constants.js';
import type { EmotionType, StrategyType } from '../../shared/constants.js';
import type { UserEmotionAnalysis } from '../../shared/types.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import { completeJson } from '../agent/sdkClient.js';
import { buildUserEmotionPrompt } from '../agent/prompts.js';
import { detectCrisis } from './safetyService.js';
import { logger } from '../logger.js';
import { clamp01 } from '../db/helpers.js';

export interface AnalysisResult {
  emotion: EmotionType;
  valence: number;
  intensity: number;
  confidence: number;
  trend: 'improving' | 'stable' | 'worsening';
  intent: string;
  needsComfort: boolean;
  crisisSignal: 'none' | 'mild' | 'severe';
  shareDepth: number;
  reasons: string[];
}

export interface AnalyzeInput {
  userId: string;
  characterId: string;
  conversationId: string;
  messageId: string;
  text: string;
  /** 最近几条用户消息（正序），用于 trend 与上下文判断 */
  recentUserTexts: string[];
}

// ============================================================
// 规则层
// ============================================================

const RULE_PATTERNS: Array<{ emotion: EmotionType; valence: number; words: string[] }> = [
  { emotion: 'happy', valence: 0.7, words: ['開心', '高興', '哈哈', '太好了', '不錯', '喜歡', '成功', '終於'] },
  { emotion: 'excited', valence: 0.8, words: ['超級', '太棒了', '!!!', '好期待', '興奮'] },
  { emotion: 'sad', valence: -0.6, words: ['難過', '想哭', '傷心', '失落', '孤單', '寂寞', '委屈'] },
  { emotion: 'angry', valence: -0.7, words: ['生氣', '氣死', '憑什麼', '太過分', '討厭死了', '崩潰'] },
  { emotion: 'worried', valence: -0.3, words: ['擔心', '害怕', '焦慮', '緊張', '壓力', '不安', '怎麼辦'] },
  { emotion: 'down', valence: -0.35, words: ['好累', '沒力氣', '算了', '不想動', '沒意思', '撐不下去'] },
  { emotion: 'shy', valence: 0.45, words: ['害羞', '不好意思', '尷尬'] },
  { emotion: 'surprised', valence: 0.1, words: ['居然', '竟然', '沒想到', '嚇到', '真的假的'] },
];

function ruleBasedAnalysis(text: string): { emotion: EmotionType; valence: number; intensity: number; reason: string } | null {
  for (const rule of RULE_PATTERNS) {
    const hit = rule.words.filter((w) => text.includes(w));
    if (hit.length) {
      // 命中词越多、句子越长，强度越高（避免一个"哈哈"就被判成狂喜）
      const density = Math.min(1, hit.length / 2);
      const lengthBoost = Math.min(0.3, text.length / 200);
      return {
        emotion: rule.emotion,
        valence: rule.valence,
        intensity: clamp01(0.4 + density * 0.3 + lengthBoost),
        reason: `出現「${hit.slice(0, 2).join('、')}」等情緒詞`,
      };
    }
  }
  return null;
}

// ============================================================
// trend 计算
// ============================================================

/**
 * 用最近 3 条分析的 valence 移动平均判断趋势。
 * 需求 §6 要求能检测「用户情绪发生明显变化」，
 * 这里用 Δ ≤ -0.30 作为 worsening 的判据。
 */
function computeTrend(history: UserEmotionAnalysis[], currentValence: number): {
  trend: 'improving' | 'stable' | 'worsening';
  reason: string;
} {
  if (history.length < 2) return { trend: 'stable', reason: '尚不足以判斷趨勢' };

  const recent = history.slice(-3).map((h) => h.valence);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const delta = currentValence - avg;

  if (delta <= -0.3) return { trend: 'worsening', reason: `情緒較先前明顯下滑（Δ${delta.toFixed(2)}）` };
  if (delta >= 0.3) return { trend: 'improving', reason: `情緒較先前好轉（Δ+${delta.toFixed(2)}）` };
  return { trend: 'stable', reason: '情緒大致平穩' };
}

// ============================================================
// 主入口
// ============================================================

export async function analyzeUserEmotion(input: AnalyzeInput): Promise<AnalysisResult> {
  const { userId, characterId, conversationId, messageId, text, recentUserTexts } = input;

  // 1) 危机短路（不依赖 LLM）
  const crisisSignal = detectCrisis(text);

  if (crisisSignal === 'severe') {
    const result: AnalysisResult = {
      emotion: 'sad',
      valence: -0.8,
      intensity: 0.9,
      confidence: 0.95,
      trend: 'worsening',
      intent: '表達嚴重危機',
      needsComfort: true,
      crisisSignal: 'severe',
      shareDepth: 0.9,
      reasons: ['偵測到明確的自我傷害相關表述'],
    };
    persist(userId, characterId, conversationId, messageId, result, 'crisis_care');
    return result;
  }

  // 2) 规则层
  const rule = ruleBasedAnalysis(text);

  // 3) LLM 层
  const history = statesRepo.listRecentUserEmotions(userId, characterId, 5);
  let llm: {
    emotion: EmotionType;
    valence: number;
    intensity: number;
    confidence: number;
    intent: string;
    needsComfort: boolean;
    shareDepth: number;
    reasons: string[];
  } | null = null;

  try {
    llm = await completeJson<{
      emotion: EmotionType;
      valence: number;
      intensity: number;
      confidence: number;
      intent: string;
      needsComfort: boolean;
      shareDepth: number;
      reasons: string[];
    }>(
      {
        label: 'emotion',
        prompt: '分析這句話的情緒。',
        systemPrompt: buildUserEmotionPrompt({
          userText: text,
          recentTexts: recentUserTexts,
          previousLabel: history.length ? EMOTION_ANCHORS[history[history.length - 1]!.emotion].label : null,
        }),
      },
      (value) => {
        if (typeof value !== 'object' || value === null) return null;
        const v = value as Record<string, unknown>;
        const emotion = v.emotion;
        if (typeof emotion !== 'string' || !(EMOTION_TYPES as readonly string[]).includes(emotion)) {
          return null;
        }
        return {
          emotion: emotion as EmotionType,
          valence: typeof v.valence === 'number' ? Math.max(-1, Math.min(1, v.valence)) : 0,
          intensity: clamp01(typeof v.intensity === 'number' ? v.intensity : 0.4),
          confidence: clamp01(typeof v.confidence === 'number' ? v.confidence : 0.6),
          intent: typeof v.intent === 'string' ? v.intent.slice(0, 30) : '一般閒聊',
          needsComfort: v.needsComfort === true,
          shareDepth: clamp01(typeof v.shareDepth === 'number' ? v.shareDepth : 0.3),
          reasons: Array.isArray(v.reasons)
            ? v.reasons.filter((r): r is string => typeof r === 'string').slice(0, 3)
            : [],
        };
      },
    );
  } catch (err) {
    logger.warn('[UserEmotion] LLM 分析失敗，降級為純規則', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 4) 融合
  let emotion: EmotionType;
  let valence: number;
  let intensity: number;
  let intent: string;
  let needsComfort: boolean;
  let shareDepth: number;
  let reasons: string[];
  let confidence: number;

  if (rule && llm) {
    emotion = llm.emotion;
    valence = 0.4 * rule.valence + 0.6 * llm.valence;
    intensity = clamp01(0.4 * rule.intensity + 0.6 * llm.intensity);
    confidence = llm.confidence;
    intent = llm.intent;
    needsComfort = llm.needsComfort;
    shareDepth = llm.shareDepth;
    reasons = [rule.reason, ...llm.reasons];
  } else if (llm) {
    ({ emotion, valence, intensity, confidence, intent, needsComfort, shareDepth, reasons } = llm);
  } else if (rule) {
    emotion = rule.emotion;
    valence = rule.valence;
    intensity = rule.intensity;
    confidence = 0.5;
    intent = '一般閒聊';
    needsComfort = valence < -0.2;
    shareDepth = 0.3;
    reasons = [rule.reason];
  } else {
    emotion = 'calm';
    valence = 0.1;
    intensity = 0.25;
    confidence = 0.4;
    intent = '一般閒聊';
    needsComfort = false;
    shareDepth = 0.2;
    reasons = ['未偵測到明顯情緒訊號'];
  }

  // 危机信号为 mild 时，强制提升关注等级
  if (crisisSignal === 'mild') {
    needsComfort = true;
    shareDepth = Math.max(shareDepth, 0.6);
    reasons = [...reasons, '出現輕微的絕望感表述'];
  }

  const { trend, reason: trendReason } = computeTrend(history, valence);
  reasons = [...reasons, trendReason];

  const result: AnalysisResult = {
    emotion,
    valence,
    intensity,
    confidence,
    trend,
    intent,
    needsComfort,
    crisisSignal,
    shareDepth,
    reasons,
  };

  persist(userId, characterId, conversationId, messageId, result, null);
  return result;
}

function persist(
  userId: string,
  characterId: string,
  conversationId: string,
  messageId: string,
  result: AnalysisResult,
  suggested: StrategyType | null,
): void {
  statesRepo.insertUserEmotion(userId, {
    characterId,
    conversationId,
    messageId,
    emotion: result.emotion,
    valence: result.valence,
    intensity: result.intensity,
    confidence: result.confidence,
    trend: result.trend,
    intent: result.intent,
    needsComfort: result.needsComfort,
    crisisSignal: result.crisisSignal,
    suggestedStrategy: suggested,
    shareDepth: result.shareDepth,
    reasons: result.reasons,
  });
}
