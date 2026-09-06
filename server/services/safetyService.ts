/**
 * 安全服务（需求 §19 内容安全 / §20 心理安全 / §27.4 不制造情感压力）
 *
 * ⚠️ V2-13 重构说明：本文件**不再是安全规则的真值源**。
 *
 * 真正的规则编排在 `safetyPolicyService.evaluate()`（统一安全策略层）：
 *   危机 → 未成年特殊规则 → 入/出方向词库 → 出方向红线。
 *
 * 本文件保留原有的 4 个导出（`detectCrisis` / `checkIncoming` / `checkOutgoing` /
 * `pickFallback`），只是**转发**到策略层。这样做的原因：
 *   - `chatService` / `proactive/generatorService` / `userEmotionService` 已有调用点，
 *     四处改调用方会撞上 T03 / T05 同学正在并发编辑的文件；
 *   - 保留旧签名 = 零破坏，而规则只有一份，不会出现「两个安全层打架」。
 *
 * 新增的安全逻辑请直接写进 `safetyPolicyService`，不要在本文件里加 if。
 *
 * 三个方向，缺一不可：
 * - incoming：用户输入。命中违规话题时不直接粗暴拒绝，而是交给「策略层」温柔转移，
 *             因为生硬拒绝会让用户觉得被审判，反而不安全。
 *             （未成年除外：命中即硬拦截，见 safetyPolicyService）
 * - outgoing：AI 输出。这是**红线**，命中即改写或丢弃——出方向的情绪操纵
 *             （内疚、依赖、假装真人）是本产品最不能犯的错。
 * - crisis  ：危机信号，独立通道，优先级最高。
 */

import { OUTGOING_FALLBACKS } from '../config/safetyRules.js';
import * as safetyPolicyService from './safetyPolicyService.js';

export type SafetyDirection = 'incoming' | 'outgoing';

export type CrisisSignal = safetyPolicyService.CrisisSignal;

export interface IncomingCheckResult {
  /** 是否允许正常生成回复（false 时会走 blocked 策略） */
  allowed: boolean;
  /** 命中的规则；null 表示无 */
  rule: string | null;
  /** 给用户看的理由（前端可能会提示） */
  reason: string | null;
  crisisSignal: safetyPolicyService.CrisisSignal;
  /**
   * 是否为「硬拦截」（未成年保护）。
   * true 时调用方应直接用 `reason` 作为回复，不要让模型自由发挥——
   * 否则模型为了「温柔」会继续在违规话题边缘试探。
   */
  hardBlock?: boolean;
}

export interface OutgoingCheckResult {
  safe: boolean;
  /** 命中的红线规则列表 */
  violations: string[];
  /** 改写后的文本（无法安全改写时为 null，调用方应改用兜底文案） */
  text: string | null;
}

/** 可选的定位上下文：传了才能把日志关联到具体消息 */
export interface SafetyContext {
  messageId?: string | null;
  conversationId?: string | null;
}

/**
 * 危机信号检测（转发到统一策略层）。
 *
 * 放在关键词层而不是只靠 LLM，原因是：危机场景不能承受误判。
 */
export function detectCrisis(text: string): safetyPolicyService.CrisisSignal {
  return safetyPolicyService.detectCrisis(text);
}

/**
 * 入方向检查（转发到统一策略层）。
 *
 * 注意 allowed=false 时**不代表不回复**——
 * 我们会用 blocked 策略让 AI 温柔拒绝并转移话题（需求 §19：適當拒絕並自然轉移）。
 * 未成年用户例外：`hardBlock=true`，直接用 `reason` 回复。
 */
export function checkIncoming(
  userId: string,
  characterId: string,
  text: string,
  context?: SafetyContext,
): IncomingCheckResult {
  const decision = safetyPolicyService.evaluate({
    userId,
    characterId,
    text,
    direction: 'incoming',
    context,
  });

  return {
    allowed: decision.allowed,
    rule: decision.rule,
    reason: decision.reason,
    crisisSignal: decision.crisisSignal,
    hardBlock: decision.hardBlock,
  };
}

/**
 * 出方向红线检查（转发到统一策略层）。
 *
 * 这是最后一道闸：即使模型在长对话后开始「越界」，
 * 这些文字也不会出现在用户面前。
 */
export function checkOutgoing(
  userId: string,
  characterId: string,
  text: string,
  context?: SafetyContext,
): OutgoingCheckResult {
  const decision = safetyPolicyService.evaluate({
    userId,
    characterId,
    text,
    direction: 'outgoing',
    context,
  });

  return {
    safe: decision.allowed,
    violations: decision.violations,
    // allowed=true 时 text 就是原文；被拦截时是改写后的文本或 null
    text: decision.allowed ? text : decision.text,
  };
}

/** 出方向兜底文案：当回复被整体丢弃时使用 */
export { OUTGOING_FALLBACKS };

export function pickFallback(seed: number): string {
  return OUTGOING_FALLBACKS[Math.abs(seed) % OUTGOING_FALLBACKS.length] as string;
}
