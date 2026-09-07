/**
 * AI 后天习惯管理路由（V2-4「AI 了解的你 / AI 形成的交流习惯」）
 *
 * 用户必须能看见 AI 后天形成了哪些交流习惯，并可以：
 * - 查看（active + 可选 candidate / archived）
 * - 修改（改写 valueLabel）
 * - 确认（userConfirmed → 直接 active，且永不自动降级）
 * - 删除（软删除）
 * - 一键重置（本角色全部习惯归档，人格一字不动）
 *
 * 这是"数据控制权归用户"在 Learned Preferences 上的落地。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as habitsRepo from '../db/repositories/habits.repo.js';
import { logger } from '../logger.js';

export const habitsRoutes = Router();

habitsRoutes.use(resolveUser);

/** 列出某用户的 AI 习惯（默认只取 active；includeCandidate=1 含观察中，includeArchived=1 含已归档） */
habitsRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const includeCandidate = req.query.includeCandidate === '1';
    const includeArchived = req.query.includeArchived === '1';

    const habits = habitsRepo.list(userId, {
      characterId,
      includeCandidate,
      includeArchived,
    });
    ok(res, { habits });
  }),
);

/** 修改一条习惯（用户改写标签 / 手动置状态） */
habitsRoutes.patch(
  '/:habitId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof habitsRepo.update>[2] = {};
    if (typeof body.valueLabel === 'string') patch.valueLabel = body.valueLabel;
    if (typeof body.status === 'string') patch.status = body.status as never;
    if (typeof body.userConfirmed === 'boolean') patch.userConfirmed = body.userConfirmed;

    const updated = habitsRepo.update(userId, req.params.habitId, patch);
    if (!updated) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條習慣');
    ok(res, { habit: updated });
  }),
);

/** 用户确认一条习惯：直接置为 active 且永不自动降级 */
habitsRoutes.post(
  '/:habitId/confirm',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const updated = habitsRepo.update(userId, req.params.habitId, { userConfirmed: true });
    if (!updated) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條習慣');
    ok(res, { habit: updated });
  }),
);

/** 软删除一条习惯 */
habitsRoutes.delete(
  '/:habitId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = habitsRepo.softDelete(userId, req.params.habitId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條習慣');
    logger.info('[Habits] 習慣已軟刪除', { habitId: req.params.habitId });
    ok(res, { success: true });
  }),
);

/** 重置某角色的全部后天习惯（归档，不改人格） */
habitsRoutes.post(
  '/reset',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof (req.body ?? {}).characterId === 'string'
      ? ((req.body as { characterId: string }).characterId)
      : '';
    if (!characterId) throw new ApiError(ErrorCode.BAD_REQUEST, '缺少 characterId');
    const count = habitsRepo.resetAll(userId, characterId);
    logger.info('[Habits] 已重置全部習慣', { characterId, count });
    ok(res, { success: true, count });
  }),
);
