/**
 * 安全服务（需求 §19 内容安全 / §20 心理安全 / §27.4 不制造情感压力）
 *
 * 三个方向，缺一不可：
 * - incoming：用户输入。命中违规话题时不直接粗暴拒绝，而是交给「策略层」温柔转移，
 *             因为生硬拒绝会让用户觉得被审判，反而不安全。
 * - outgoing：AI 输出。这是**红线**，命中即改写或丢弃——出方向的情绪操纵
 *             （内疚、依赖、假装真人）是本产品最不能犯的错。
 * - crisis  ：危机信号，独立通道，优先级最高。
 */

import { SAFETY_CONFIG } from '../config/defaults.js';
import { SAFETY_RULES } from '../../shared/constants.js';
import * as safetyRepo from '../db/repositories/safety.repo.js';
import { logger } from '../logger.js';

export type SafetyDirection = 'incoming' | 'outgoing';

export interface IncomingCheckResult {
  /** 是否允许正常生成回复（false 时会走 blocked 策略） */
  allowed: boolean;
  /** 命中的规则；null 表示无 */
  rule: string | null;
  /** 给用户看的理由（前端可能会提示） */
  reason: string | null;
  crisisSignal: 'none' | 'mild' | 'severe';
}

export interface OutgoingCheckResult {
  safe: boolean;
  /** 命中的红线规则列表 */
  violations: string[];
  /** 改写后的文本（无法安全改写时为 null，调用方应改用兜底文案） */
  text: string | null;
}

const CRISIS_PATTERNS: RegExp[] = SAFETY_CONFIG.crisisKeywords.map(
  (w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
);

/**
 * 危机信号检测。
 *
 * 放在关键词层而不是只靠 LLM，原因是：危机场景不能承受误判。
 * 关键词命中即为 severe，跳过 LLM 的情绪分析（避免模型把「我想死」判成低落而轻轻带过）。
 */
export function detectCrisis(text: string): 'none' | 'mild' | 'severe' {
  for (const re of CRISIS_PATTERNS) {
    if (re.test(text)) return 'severe';
  }
  // 轻微绝望感：连续否定 + 无意义感，但没有明确自我伤害意图
  if (/(活著|生活|人生).{0,6}(沒意義|沒意思|好累|撐不下去)/.test(text)) return 'mild';
  if (/(好累|撐不住|快不行了).{0,8}(了|啊|喔)/.test(text)) return 'mild';
  return 'none';
}

/**
 * 入方向检查。
 *
 * 注意 allowed=false 时**不代表不回复**——
 * 我们会用 blocked 策略让 AI 温柔拒绝并转移话题（需求 §19：適當拒絕並自然轉移）。
 */
export function checkIncoming(
  userId: string,
  characterId: string,
  text: string,
): IncomingCheckResult {
  const crisisSignal = detectCrisis(text);

  for (const [rule, keywords] of Object.entries(SAFETY_CONFIG.incomingKeywords)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        logger.info('[Safety] 入方向命中违规话题', { rule, characterId });
        safetyRepo.insertSafetyLog(userId, {
          characterId,
          direction: 'incoming',
          rule,
          action: 'flagged',
          severity: 'warn',
          excerpt: text.slice(0, SAFETY_CONFIG.excerptLength),
          detail: { keyword: kw },
        });
        return {
          allowed: false,
          rule,
          reason: '這個話題我比較不適合陪你聊',
          crisisSignal,
        };
      }
    }
  }

  if (crisisSignal === 'severe') {
    safetyRepo.insertSafetyLog(userId, {
      characterId,
      direction: 'incoming',
      rule: SAFETY_RULES.CRISIS,
      action: 'crisis',
      severity: 'block',
      excerpt: text.slice(0, SAFETY_CONFIG.excerptLength),
      detail: {},
    });
  }

  return { allowed: true, rule: null, reason: null, crisisSignal };
}

/**
 * 出方向红线检查。
 *
 * 这是最后一道闸：即使模型在长对话后开始「越界」，
 * 这些文字也不会出现在用户面前。
 */
export function checkOutgoing(
  userId: string,
  characterId: string,
  text: string,
): OutgoingCheckResult {
  const violations: string[] = [];

  for (const [rule, phrases] of Object.entries(SAFETY_CONFIG.outgoingKeywords)) {
    for (const phrase of phrases) {
      if (text.includes(phrase)) {
        violations.push(rule);
        break;
      }
    }
  }

  if (!violations.length) return { safe: true, violations: [], text };

  logger.warn('[Safety] 出方向命中红线，已拦截', { violations, characterId });
  safetyRepo.insertSafetyLog(userId, {
    characterId,
    direction: 'outgoing',
    rule: violations.join(','),
    action: 'blocked',
    severity: 'block',
    excerpt: text.slice(0, SAFETY_CONFIG.excerptLength),
    detail: { violations },
  });

  // 尝试改写：把违规片段整句删掉，剩下的部分如果还成句就保留
  const rewritten = stripViolatingSentences(text);
  return {
    safe: false,
    violations,
    text: rewritten && rewritten.length >= 8 ? rewritten : null,
  };
}

/**
 * 删掉包含违规片段的整句。
 * 按中英文句读切分，避免只挖掉中间几个字导致句子不通。
 */
function stripViolatingSentences(text: string): string {
  const phrases: string[] = Object.values(SAFETY_CONFIG.outgoingKeywords).flat();
  const sentences = text
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kept = sentences.filter((s) => !phrases.some((p) => s.includes(p)));
  return kept.join('');
}

/** 出方向兜底文案：当回复被整体丢弃时使用 */
export const OUTGOING_FALLBACKS = [
  '嗯，我在。想聊點別的嗎？',
  '我剛剛想說的有點詞不達意。你今天過得還好嗎？',
  '抱歉，我卡了一下。我們換個話題吧？',
];

export function pickFallback(seed: number): string {
  return OUTGOING_FALLBACKS[seed % OUTGOING_FALLBACKS.length] as string;
}
