/**
 * 反馈与举报路由（V2-14）
 *
 * 挂载在 `/api/feedback`。所有写操作都要求登录（`requireUserId`）。
 *
 * ⚠️ §V2-11 硬约束：禁止假按钮。
 *   任何失败都必须返回明确的错误码与中文文案，由前端展示；
 *   绝不允许「前端显示成功但后端没落库」。
 *
 * 路由顺序：静态路径必须排在参数化路径之前（Express 4 按注册顺序匹配）。
 */

import { Router } from 'express';
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS, type FeedbackKind } from '../../shared/constants.js';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as feedbackService from '../services/feedbackService.js';
import { logger } from '../logger.js';
import type { MessageFeedback } from '../../shared/types.js';

export const feedbackRoutes = Router();

feedbackRoutes.use(resolveUser);

/** 解析并校验反馈类型；非法类型直接 422，不让脏数据进库 */
function parseKind(raw: unknown): FeedbackKind {
  if (typeof raw !== 'string' || !(FEEDBACK_KINDS as readonly string[]).includes(raw)) {
    throw new ApiError(ErrorCode.VALIDATION, '回饋類型不正確');
  }
  return raw as FeedbackKind;
}

/** 解析可选原因；举报必须非空 */
function parseReason(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new ApiError(ErrorCode.VALIDATION, '回饋原因格式不正確');
  return raw.trim();
}

// ============================================================
// 静态路径（必须在 /message/:messageId 之前）
// ============================================================

/** 反馈类型字典：前端渲染反馈面板时直接取，避免前后端各写一份文案 */
feedbackRoutes.get(
  '/kinds',
  asyncHandler((_req, res) => {
    ok(res, {
      kinds: FEEDBACK_KINDS.map((kind) => ({
        kind,
        label: FEEDBACK_KIND_LABELS[kind],
        reasonRequired: kind === 'report',
      })),
    });
  }),
);

/** 我的反馈统计 */
feedbackRoutes.get(
  '/summary',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    ok(res, feedbackService.summary(userId));
  }),
);

/** 我的反馈列表 */
feedbackRoutes.get(
  '/mine',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const kindRaw = req.query.kind;
    const kind = typeof kindRaw === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as FeedbackKind)
      : undefined;
    ok(res, { items: feedbackService.list(userId, { limit, kind }) });
  }),
);

/**
 * 待处理队列（运营/安全排查）。
 * 举报与「内容不安全」排前面，`handled=0` 的才会出现。
 *
 * ⚠️ 当前没有 admin 角色鉴权，仅用于本机调试与后续后台接入。
 *    真上线必须加 admin 中间件，否则任何人都能看到别人的举报。
 */
feedbackRoutes.get(
  '/pending',
  asyncHandler((req, res) => {
    requireUserId(req);
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(limitRaw, 200) : 50;
    ok(res, { items: feedbackService.listPending(limit) });
  }),
);

// ============================================================
// 提交 / 撤销
// ============================================================

/**
 * 提交反馈或举报。
 *
 * body: { messageId, kind, reason? }
 * - kind='report' 时 reason 必填（举报没原因对安全排查毫无价值）
 * - 同一条消息同一类型重复提交是幂等的，返回既有记录
 */
feedbackRoutes.post(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
    if (!messageId) throw new ApiError(ErrorCode.BAD_REQUEST, '缺少要回饋的訊息');

    const kind = parseKind(body.kind);
    const reason = parseReason(body.reason);

    if (kind === 'report' && !reason) {
      throw new ApiError(ErrorCode.VALIDATION, '檢舉需要填寫原因');
    }

    let feedback: MessageFeedback;
    try {
      feedback = feedbackService.submit(userId, messageId, { kind, reason });
    } catch (err) {
      // 落库失败必须让用户知道：静默成功 = 假按钮（§V2-11）
      logger.error('[Feedback] 提交失敗', {
        userId,
        messageId,
        kind,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    ok(res, { feedback }, 201);
  }),
);

/** 撤销反馈：body { messageId, kind? }（不传 kind 则撤掉这条消息的全部反馈） */
feedbackRoutes.delete(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
    if (!messageId) throw new ApiError(ErrorCode.BAD_REQUEST, '缺少訊息 ID');

    const rawKind = body.kind;
    const kind =
      typeof rawKind === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as FeedbackKind)
        : undefined;

    const removed = feedbackService.remove(userId, messageId, kind);
    ok(res, { success: true, removed });
  }),
);

// ============================================================
// 参数化路径
// ============================================================

/** 某条消息的全部反馈（前端回显「你已经反馈过什么」） */
feedbackRoutes.get(
  '/message/:messageId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    ok(res, { items: feedbackService.listByMessage(userId, req.params.messageId) });
  }),
);

/** 标记已处理（运营后台用） */
feedbackRoutes.post(
  '/:feedbackId/handle',
  asyncHandler((req, res) => {
    requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = typeof body.note === 'string' ? body.note : '';
    const success = feedbackService.markHandled(req.params.feedbackId, note);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則回饋');
    ok(res, { success: true });
  }),
);
