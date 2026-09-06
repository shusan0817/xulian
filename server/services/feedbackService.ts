/**
 * 消息反馈服务（V2-14 用户举报与内容反馈）
 *
 * 职责：把「用户对一条 AI 回复的态度」真正落到后端，而不是在前端弹个 Toast 就完事。
 *
 * 五种反馈：
 *   不感兴趣 / 回复不合适 / 内容错误 / 内容不安全 / 举报
 *
 * 落库分两处（缺一不可）：
 *   - `message_feedback` ：反馈本体，`handled=0` 进待处理队列；
 *   - `safety_logs`      ：`unsafe` 与 `report` 额外留痕，`report` 标记的
 *                          `source='user_report'` 且**带 message_id**（能定位到原文）。
 *
 * 反馈的实际用途（不是摆设）：
 *   - T05 的 V13_FEEDBACK_FATIGUE 读这里的负反馈数，决定要不要停发主动消息；
 *   - 安全侧读 `safety_logs(source='user_report')` 排查模型越界。
 */

import { FEEDBACK_KINDS, type FeedbackKind } from '../../shared/constants.js';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError } from '../errors.js';
import * as feedbackRepo from '../db/repositories/feedback.repo.js';
import * as safetyPolicyService from './safetyPolicyService.js';
import { logger } from '../logger.js';
import type { MessageFeedback } from '../../shared/types.js';

/** 「负反馈」的四种：V13 疲劳检测只认这四种，'incorrect'（内容错误）不算用户嫌弃 */
const NEGATIVE_KINDS: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>([
  'not_interesting',
  'inappropriate',
  'unsafe',
  'report',
]);

export interface SubmitFeedbackInput {
  kind: FeedbackKind;
  reason?: string;
}

/** 最近 N 条主动消息里被负反馈的条数；V13 的触发阈值是「3 条里 2 条」 */
export const FEEDBACK_FATIGUE_WINDOW = 3;
export const FEEDBACK_FATIGUE_THRESHOLD = 2;

/**
 * 提交反馈。
 *
 * 校验规则：
 * - `kind` 必须是 FEEDBACK_KINDS 之一（防止前端传脏数据进库）；
 * - `report` 必须填原因——没有原因的举报对安全排查毫无价值。
 *
 * ⚠️ 失败一律抛 ApiError，由路由层转成明确报错。
 *    绝不允许「前端显示成功但后端没落库」（§V2-11 禁止假按钮）。
 */
export function submit(userId: string, messageId: string, input: SubmitFeedbackInput): MessageFeedback {
  const kind = input.kind;
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError(ErrorCode.VALIDATION, '回饋類型不正確');
  }
  if (!messageId) {
    throw new ApiError(ErrorCode.BAD_REQUEST, '缺少要回饋的訊息');
  }
  const reason = (input.reason ?? '').trim();

  if (kind === 'report') {
    // 举报走安全策略层的专用通道：它同时落 message_feedback + safety_logs(source='user_report')
    return safetyPolicyService.report(userId, messageId, reason);
  }

  const feedback = safetyPolicyService.submitFeedback(userId, messageId, kind, reason);
  logger.info('[Feedback] 收到回饋', { userId, messageId, kind });
  return feedback;
}

/** 撤销反馈（不指定 kind 则撤掉这条消息的全部反馈） */
export function remove(userId: string, messageId: string, kind?: FeedbackKind): number {
  if (!messageId) throw new ApiError(ErrorCode.BAD_REQUEST, '缺少訊息 ID');
  const changes = feedbackRepo.remove(userId, messageId, kind);
  if (changes === 0) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則回饋');
  return changes;
}

/** 某条消息的全部反馈（前端用于回显「你已经反馈过什么」） */
export function listByMessage(userId: string, messageId: string): MessageFeedback[] {
  return feedbackRepo.listByMessage(userId, messageId);
}

/** 我的反馈列表 */
export function list(
  userId: string,
  options: { limit?: number; kind?: FeedbackKind } = {},
): MessageFeedback[] {
  return feedbackRepo.list(userId, options);
}

/**
 * 最近 N 条主动消息里被负反馈的条数。
 * 供 T05 的 V13_FEEDBACK_FATIGUE 否决使用。
 */
export function countNegativeOnProactive(userId: string, characterId: string, lastN = FEEDBACK_FATIGUE_WINDOW): number {
  return feedbackRepo.adminCountNegativeOnProactive(userId, characterId, lastN);
}

/**
 * 是否处于「反馈疲劳」状态：最近 3 条主动消息里有 ≥2 条被嫌弃。
 * 命中后 T05 应在 72 小时内停发主动消息——被嫌弃还一直发，本身就是骚扰。
 */
export function isFatigued(userId: string, characterId: string): boolean {
  return countNegativeOnProactive(userId, characterId) >= FEEDBACK_FATIGUE_THRESHOLD;
}

/** 我的反馈统计（每种类型各几条 + 总数） */
export function summary(userId: string): { total: number; byKind: Record<FeedbackKind, number> } {
  const byKind = feedbackRepo.summary(userId);
  let total = 0;
  for (const kind of FEEDBACK_KINDS) total += byKind[kind] ?? 0;
  return { total, byKind };
}

/**
 * 待处理队列（运营/安全排查用）。
 *
 * 这里不做鉴权（项目当前没有 admin 角色），但**仅限本机调试与后续后台接入**；
 * 真上线必须加 admin 中间件。先留注释，避免后来者直接把它公开出去。
 */
export function listPending(limit = 100): MessageFeedback[] {
  return feedbackRepo.adminListOpen(limit);
}

/** 标记已处理（运营后台用） */
export function markHandled(feedbackId: string, note = ''): boolean {
  return feedbackRepo.markHandled(feedbackId, note);
}
