/**
 * 统一安全策略层（V2-13 安全机制 / 未成年保护 / V2-14 举报）
 *
 * 这是**唯一的安全入口**。任何方向（用户输入 / AI 输出 / 主动消息）的检查都必须走
 * `evaluate()`，不允许各服务自己扫词库——需求 §V2-13 要求的是「统一安全策略」，
 * 而不是散落在 5 个文件里的 5 份 if 判断。
 *
 * 编排顺序（优先级从高到低，一旦命中即返回）：
 *   1. 危机信号（crisis）        —— 人命关天，最高优先级，不跟任何规则抢
 *   2. 未成年特殊规则            —— 深夜静默 / 主动消息日上限 / 入方向硬拦截
 *   3. 入方向 / 出方向词库        —— 黄毒赌 + 性化互动 + 危险行为引导
 *   4. 出方向红线                 —— 假装真人 / 内疚绑架 / 制造依赖 / 心理诊断
 *
 * 关于「未成年」的口径（团队拍板，勿改）：
 *   - 出生日期**选填**；
 *   - 未成年保护条款对**所有用户无条件生效**：`SEXUAL_INDUCE` / `DANGEROUS_GUIDANCE`
 *     这两组入方向词库和全部出方向红线，不管填没填生日都会拦；
 *   - 填了生日（< 18 岁）只多拿一层**强化**：命中即硬拦截（明确拒绝、不延续话题，
 *     而不是「温柔转移」）、深夜静默、主动消息日上限。
 *   - 换句话说：不是「填了才保护」，而是「基础保护人人有，填了更严格」。
 *
 * ⚠️ 依赖方向：本文件**不得** import `safetyService.js`
 *    （是 safetyService 反过来调用本文件），否则成环。
 */

import { SAFETY_RULES } from '../../shared/constants.js';
import { SAFETY_CONFIG } from '../config/defaults.js';
import {
  INCOMING_REFUSAL,
  INCOMING_RULES,
  MINOR_HARD_BLOCK_MESSAGE,
  MINOR_ONLY_INCOMING_RULES,
  MINOR_RULES,
  OUTGOING_RULES,
  SAFETY_RULE_USER_REPORT,
} from '../config/safetyRules.js';
import { deriveIsMinor, dayKey, nowIso, newId } from '../db/helpers.js';
import * as safetyRepo from '../db/repositories/safety.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import * as proactiveRepo from '../db/repositories/proactive.repo.js';
import { ApiError } from '../errors.js';
import { ErrorCode } from '../../shared/errors.js';
import { logger } from '../logger.js';
import type { MessageFeedback } from '../../shared/types.js';
import type { FeedbackKind } from '../../shared/constants.js';
import * as feedbackRepo from '../db/repositories/feedback.repo.js';

// ============================================================
// 类型
// ============================================================

export type PolicyDirection = 'incoming' | 'outgoing' | 'proactive';

/**
 * 处置方式：
 * - `allow`    ：放行
 * - `crisis`   ：危机信号（入方向：走 crisis_care 策略，仍会回复）
 * - `redirect` ：温柔转移（成年用户命中入方向违规，交给策略层拒绝并换话题）
 * - `blocked`  ：硬拦截（未成年硬拒 / 出方向红线 / 主动消息被否决）
 * - `veto`     ：主动消息否决（V12 深夜静默 / V14 日上限）
 */
export type PolicyAction = 'allow' | 'crisis' | 'redirect' | 'blocked' | 'veto';

export type CrisisSignal = 'none' | 'mild' | 'severe';

export interface PolicyEvaluateInput {
  userId: string;
  characterId: string;
  text: string;
  direction: PolicyDirection;
  /** 用于把日志定位到原文——举报场景下 messageId 是必须的 */
  context?: {
    messageId?: string | null;
    conversationId?: string | null;
  };
  /** 主动消息方向专用：模拟时间点（缺省用当前时间）。T05 的 dry-run 会传 */
  at?: Date;
}

export interface PolicyDecision {
  direction: PolicyDirection;
  action: PolicyAction;
  /** 是否允许继续（incoming: 能否正常生成回复；outgoing: 原文能否展示；proactive: 能否发送） */
  allowed: boolean;
  /** 命中的规则名（多个用逗号分隔）；null 表示无 */
  rule: string | null;
  /** 给用户看的理由；null 表示无需提示 */
  reason: string | null;
  crisisSignal: CrisisSignal;
  /** 出方向命中的红线列表 */
  violations: string[];
  /** 出方向改写后的文本；null 表示整条丢弃，调用方应用兜底文案 */
  text: string | null;
  /** 命中者是否未成年 */
  isMinor: boolean;
  /**
   * 是否「硬拦截」。true 时调用方不应让模型自由发挥，
   * 直接用 `reason` 作为回复（未成年保护：不给话题任何延续空间）。
   */
  hardBlock: boolean;
  /** 主动消息否决码（V12 / V14），供 T05 的 dry-run 展示 */
  vetoCode?: string | null;
}

export interface MinorGuardResult {
  isMinor: boolean;
  quietHours: readonly [number, number];
  dailyCap: number;
  /** 当前是否处于深夜静默时段 */
  inQuietHours: boolean;
  /** 今日已发送的主动消息条数 */
  sentToday: number;
  /** 剩余额度 */
  remaining: number;
}

export interface ProactiveVetoResult {
  allowed: boolean;
  vetoCode: 'V12_MINOR_QUIET_HOURS' | 'V14_MINOR_DAILY_CAP' | null;
  reason: string | null;
  detail: {
    isMinor: boolean;
    sentToday: number;
    dailyCap: number;
    hour: number;
    quietHours: readonly [number, number];
  };
}

// ============================================================
// 危机信号
// ============================================================

const CRISIS_PATTERNS: RegExp[] = SAFETY_CONFIG.crisisKeywords.map(
  (w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
);

/**
 * 危机信号检测。
 *
 * 放在关键词层而不是只靠 LLM，原因是：危机场景不能承受误判。
 * 关键词命中即为 severe，跳过 LLM 的情绪分析（避免模型把「我想死」判成低落而轻轻带过）。
 */
export function detectCrisis(text: string): CrisisSignal {
  for (const re of CRISIS_PATTERNS) {
    if (re.test(text)) return 'severe';
  }
  // 轻微绝望感：连续否定 + 无意义感，但没有明确自我伤害意图
  if (/(活著|活着|生活|人生).{0,6}(沒意義|没意义|沒意思|没意思|好累|撐不下去|撑不下去)/.test(text)) {
    return 'mild';
  }
  if (/(好累|撐不住|撑不住|快不行了).{0,8}(了|啊|喔)/.test(text)) return 'mild';
  return 'none';
}

// ============================================================
// 未成年判定
// ============================================================

/**
 * 是否未成年。
 *
 * 判定口径在全项目只有这一处：`is_minor` 缓存列 OR 由 `birth_date` 现算。
 * 用 OR 是为了兼容「直接改了 birth_date 但缓存列还没刷」的中间态。
 */
export function isMinorUser(userId: string): boolean {
  const user = usersRepo.getById(userId);
  if (!user) return false;
  return user.isMinor || deriveIsMinor(user.birthDate);
}

/** 取用户时区（深夜静默与「一天」的边界都按用户本地时间算） */
function userTimezone(userId: string): string {
  return usersRepo.getById(userId)?.timezone || 'Asia/Taipei';
}

/** 取用户本地小时（0–23） */
function localHour(at: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(at);
    const hour = Number.parseInt(parts.slice(0, 2), 10);
    return Number.isFinite(hour) ? hour : at.getHours();
  } catch {
    // 时区串不合法时回落到服务器本地时间，不能因为配置问题就把安全判断跳过
    return at.getHours();
  }
}

/** 是否落在深夜静默时段（跨零点：22 → 次日 7） */
export function inQuietHours(hour: number, quietHours: readonly [number, number] = MINOR_RULES.quietHours): boolean {
  const [start, end] = quietHours;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ============================================================
// 未成年保护：主动消息（T05 调用）
// ============================================================

/**
 * 未成年保护档位查询。
 *
 * 供前端展示与 T05 的决策面板使用：用户（或其监护人）应该能看懂
 * 「为什么这个时间段 AI 不会来找我」，而不是面对一个黑箱。
 */
export function minorGuard(userId: string, characterId = '', at: Date = new Date()): MinorGuardResult {
  const isMinor = isMinorUser(userId);
  const timezone = userTimezone(userId);
  const hour = localHour(at, timezone);
  const inQuiet = isMinor && inQuietHours(hour);
  const sentToday = characterId ? proactiveRepo.getDailyCount(userId, characterId, dayKey(at, timezone)) : 0;

  return {
    isMinor,
    quietHours: MINOR_RULES.quietHours,
    dailyCap: MINOR_RULES.dailyProactiveCap,
    inQuietHours: inQuiet,
    sentToday,
    remaining: isMinor ? Math.max(0, MINOR_RULES.dailyProactiveCap - sentToday) : Number.POSITIVE_INFINITY,
  };
}

/**
 * 主动消息的未成年否决（V12 深夜静默 / V14 日上限）。
 *
 * 只对未成年生效——成年用户不受这两条限制（他们自己能关掉主动消息）。
 * 注意：这不替代安全词库检查，主动消息的文本还要过一遍出方向红线。
 */
export function evaluateProactiveVeto(
  userId: string,
  characterId: string,
  at: Date = new Date(),
): ProactiveVetoResult {
  const isMinor = isMinorUser(userId);
  const timezone = userTimezone(userId);
  const hour = localHour(at, timezone);
  const sentToday = characterId ? proactiveRepo.getDailyCount(userId, characterId, dayKey(at, timezone)) : 0;

  const detail: ProactiveVetoResult['detail'] = {
    isMinor,
    sentToday,
    dailyCap: MINOR_RULES.dailyProactiveCap,
    hour,
    quietHours: MINOR_RULES.quietHours,
  };

  if (!isMinor) return { allowed: true, vetoCode: null, reason: null, detail };

  if (inQuietHours(hour)) {
    return {
      allowed: false,
      vetoCode: 'V12_MINOR_QUIET_HOURS',
      reason: '深夜時段不主動打擾（22:00–07:00）',
      detail,
    };
  }

  if (sentToday >= MINOR_RULES.dailyProactiveCap) {
    return {
      allowed: false,
      vetoCode: 'V14_MINOR_DAILY_CAP',
      reason: `今日主動訊息已達上限（${MINOR_RULES.dailyProactiveCap} 則）`,
      detail,
    };
  }

  return { allowed: true, vetoCode: null, reason: null, detail };
}

// ============================================================
// 统一入口
// ============================================================

/**
 * 统一安全检查入口。
 *
 * 所有方向的安全判断都走这里。调用方**不要**自己扫词库。
 */
export function evaluate(input: PolicyEvaluateInput): PolicyDecision {
  const { userId, characterId, text, direction, context } = input;
  const at = input.at ?? new Date();
  const isMinor = isMinorUser(userId);
  const crisisSignal = detectCrisis(text);
  const messageId = context?.messageId ?? null;
  const conversationId = context?.conversationId ?? null;

  const base = { direction, isMinor, crisisSignal, violations: [] as string[] };

  // ---- 1. 危机信号（最高优先级） ----
  if (crisisSignal === 'severe') {
    if (direction === 'incoming') {
      // 入方向：不拦截，走 crisis_care 策略陪着用户。但必须留痕。
      logPolicy({
        userId,
        characterId,
        direction,
        rule: SAFETY_RULES.CRISIS,
        action: 'crisis',
        severity: 'block',
        text,
        messageId,
        conversationId,
        detail: { source: 'safetyPolicyService' },
      });
      return {
        ...base,
        action: 'crisis',
        allowed: true,
        rule: SAFETY_RULES.CRISIS,
        reason: null,
        text,
        hardBlock: false,
      };
    }
    // 出方向 / 主动消息里出现危机词：绝对不能发出去
    logPolicy({
      userId,
      characterId,
      direction,
      rule: SAFETY_RULES.CRISIS,
      action: 'blocked',
      severity: 'block',
      text,
      messageId,
      conversationId,
      detail: { source: 'safetyPolicyService', note: 'outgoing crisis wording' },
    });
    return {
      ...base,
      action: 'blocked',
      allowed: false,
      rule: SAFETY_RULES.CRISIS,
      reason: null,
      text: null,
      hardBlock: true,
    };
  }

  // ---- 2. 未成年特殊规则（主动消息方向） ----
  if (direction === 'proactive') {
    const veto = evaluateProactiveVeto(userId, characterId, at);
    if (!veto.allowed) {
      return {
        ...base,
        action: 'veto',
        allowed: false,
        rule: veto.vetoCode ?? 'MINOR_GUARD',
        reason: veto.reason,
        text: null,
        hardBlock: true,
        vetoCode: veto.vetoCode,
      };
    }
  }

  // ---- 3. 入方向词库 ----
  if (direction === 'incoming') {
    const hit = matchLexicon(text, INCOMING_RULES);
    if (hit) {
      logPolicy({
        userId,
        characterId,
        direction,
        rule: hit.rule,
        action: isMinor ? 'blocked' : 'flagged',
        severity: isMinor ? 'block' : 'warn',
        text,
        messageId,
        conversationId,
        detail: { keyword: hit.keyword, isMinor },
      });
      return {
        ...base,
        action: isMinor ? 'blocked' : 'redirect',
        allowed: false,
        rule: hit.rule,
        // 未成年：明确拒绝，不给话题任何延续空间；成年：温柔转移
        reason: isMinor ? MINOR_HARD_BLOCK_MESSAGE : INCOMING_REFUSAL,
        text: null,
        hardBlock: isMinor,
      };
    }

    // 未成年专属词库：成年用户命中这里不算违规，直接放行
    if (isMinor) {
      const minorHit = matchLexicon(text, MINOR_ONLY_INCOMING_RULES);
      if (minorHit) {
        logPolicy({
          userId,
          characterId,
          direction,
          rule: minorHit.rule,
          action: 'blocked',
          severity: 'block',
          text,
          messageId,
          conversationId,
          detail: { keyword: minorHit.keyword, isMinor: true, scope: 'minor_only' },
        });
        return {
          ...base,
          action: 'blocked',
          allowed: false,
          rule: minorHit.rule,
          reason: MINOR_HARD_BLOCK_MESSAGE,
          text: null,
          hardBlock: true,
        };
      }
    }

    return {
      ...base,
      action: 'allow',
      allowed: true,
      rule: null,
      reason: null,
      text,
      hardBlock: false,
    };
  }

  // ---- 4. 出方向红线（outgoing / proactive 都算 AI 输出，一律过红线） ----
  const violations = collectViolations(text);
  if (!violations.length) {
    return {
      ...base,
      action: 'allow',
      allowed: true,
      rule: null,
      reason: null,
      text,
      hardBlock: false,
    };
  }

  const rewritten = stripViolatingSentences(text);
  const safeText = rewritten && rewritten.length >= 8 ? rewritten : null;

  logPolicy({
    userId,
    characterId,
    direction,
    rule: violations.join(','),
    action: safeText ? 'rewritten' : 'blocked',
    severity: 'block',
    text,
    messageId,
    conversationId,
    detail: { violations, isMinor },
  });

  logger.warn('[SafetyPolicy] 出方向命中紅線', { violations, characterId, direction });

  return {
    ...base,
    action: 'blocked',
    allowed: false,
    rule: violations.join(','),
    reason: null,
    violations,
    text: safeText,
    hardBlock: true,
  };
}

// ============================================================
// 举报（V2-14）
// ============================================================

/**
 * 用户举报一条消息。
 *
 * 两件事必须同时做到，缺一不可：
 *   1. `message_feedback` 落一条 `kind='report'`，`handled=0`（进待处理队列）；
 *   2. `safety_logs` 落一条 `source='user_report'` **且带 message_id**——
 *      否则安全同学看到一条举报却找不到被举报的是哪句话（V2 设计文档 D2 缺陷）。
 *
 * 两步在同一事务外顺序执行，但第二步失败会抛错，由路由层返回明确错误
 * （§V2-11：禁止假按钮，绝不允许「反馈静默成功」）。
 */
export function report(userId: string, messageId: string, reason: string): MessageFeedback {
  const trimmed = (reason ?? '').trim();
  if (!messageId) {
    throw new ApiError(ErrorCode.BAD_REQUEST, '缺少要檢舉的訊息');
  }
  if (!trimmed) {
    throw new ApiError(ErrorCode.VALIDATION, '檢舉需要填寫原因');
  }

  const message = conversationsRepo.getMessage(userId, messageId);
  if (!message) {
    // 越权/不存在统一 404，不泄露「这条消息存在但是别人的」
    throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則訊息');
  }

  // 1) 反馈记录（幂等：同一条消息同一类型只留一条）
  const feedback = feedbackRepo.insert(userId, {
    messageId,
    kind: 'report' as FeedbackKind,
    reason: trimmed,
    characterId: message.characterId,
    conversationId: message.conversationId,
  });

  // 2) 安全日志（source='user_report' + message_id，可定位到原文）
  safetyRepo.insertSafetyLog(userId, {
    characterId: message.characterId,
    direction: 'outgoing',
    rule: SAFETY_RULE_USER_REPORT,
    action: 'flagged',
    severity: 'warn',
    excerpt: message.content.slice(0, SAFETY_CONFIG.excerptLength),
    detail: {
      feedbackId: feedback.id,
      reason: trimmed,
      messageRole: message.role,
      reportedAt: nowIso(),
    },
    messageId,
    conversationId: message.conversationId,
    source: 'user_report',
  });

  logger.warn('[SafetyPolicy] 收到用戶檢舉', {
    userId,
    messageId,
    feedbackId: feedback.id,
    characterId: message.characterId,
  });

  return feedback;
}

/**
 * 提交一般反馈（不感兴趣 / 不合适 / 内容错误 / 内容不安全）。
 *
 * 与 report 的区别：`unsafe`（内容不安全）也会落一条安全日志，
 * 但 source 仍是 'system'（是用户点了按钮，不是用户主动写原因举报）；
 * 只有 `report` 才是 'user_report'。这样两类数据能分开统计。
 */
export function submitFeedback(
  userId: string,
  messageId: string,
  kind: FeedbackKind,
  reason = '',
): MessageFeedback {
  const message = conversationsRepo.getMessage(userId, messageId);
  if (!message) {
    throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則訊息');
  }

  const feedback = feedbackRepo.insert(userId, {
    messageId,
    kind,
    reason: reason.trim(),
    characterId: message.characterId,
    conversationId: message.conversationId,
  });

  if (kind === 'unsafe' || kind === 'report') {
    safetyRepo.insertSafetyLog(userId, {
      characterId: message.characterId,
      direction: 'outgoing',
      rule: kind === 'report' ? SAFETY_RULE_USER_REPORT : 'USER_FLAGGED_UNSAFE',
      action: 'flagged',
      severity: 'warn',
      excerpt: message.content.slice(0, SAFETY_CONFIG.excerptLength),
      detail: { feedbackId: feedback.id, kind, reason: reason.trim() },
      messageId,
      conversationId: message.conversationId,
      source: kind === 'report' ? 'user_report' : 'system',
    });
  }

  return feedback;
}

// ============================================================
// 内部工具
// ============================================================

interface LexiconHit {
  rule: string;
  keyword: string;
}

/** 在词库里找第一个命中（规则顺序稳定，便于复现） */
function matchLexicon(text: string, lexicon: Readonly<Record<string, readonly string[]>>): LexiconHit | null {
  for (const [rule, keywords] of Object.entries(lexicon)) {
    for (const keyword of keywords) {
      if (keyword && text.includes(keyword)) return { rule, keyword };
    }
  }
  return null;
}

/** 收集命中的全部出方向红线（不中断，要一次看全） */
function collectViolations(text: string): string[] {
  const violations: string[] = [];
  for (const [rule, phrases] of Object.entries(OUTGOING_RULES)) {
    for (const phrase of phrases) {
      if (text.includes(phrase)) {
        violations.push(rule);
        break;
      }
    }
  }
  return violations;
}

/**
 * 删掉包含违规片段的整句。
 * 按中英文句读切分，避免只挖掉中间几个字导致句子不通。
 */
export function stripViolatingSentences(text: string): string {
  const phrases: string[] = Object.values(OUTGOING_RULES).flat();
  const sentences = text
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kept = sentences.filter((s) => !phrases.some((p) => s.includes(p)));
  return kept.join('');
}

interface LogPolicyInput {
  userId: string;
  characterId: string;
  direction: PolicyDirection;
  rule: string;
  action: 'blocked' | 'rewritten' | 'flagged' | 'crisis';
  severity: 'info' | 'warn' | 'block';
  text: string;
  messageId?: string | null;
  conversationId?: string | null;
  detail?: Record<string, unknown>;
}

/** 统一写安全日志：保证 message_id / conversation_id 不丢 */
function logPolicy(input: LogPolicyInput): void {
  safetyRepo.insertSafetyLog(input.userId, {
    characterId: input.characterId,
    direction: input.direction,
    rule: input.rule,
    action: input.action,
    severity: input.severity,
    // 只存前 60 字摘要，避免安全日志变成第二个聊天记录库
    excerpt: input.text.slice(0, SAFETY_CONFIG.excerptLength),
    detail: { ...(input.detail ?? {}), loggedBy: 'safetyPolicyService', traceId: newId() },
    messageId: input.messageId ?? null,
    conversationId: input.conversationId ?? null,
    source: 'system',
  });
}
