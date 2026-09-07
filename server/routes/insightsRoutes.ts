/**
 * 用户偏好（AI 了解的你）管理路由（V2-3「AI 了解的你」）
 *
 * 双轨制：全域（`characterScope=''`）为底 + 角色覆盖优先。
 * 用户能：
 * - 查看（按作用域列出；默认全域）
 * - 修改（改写 valueLabel；改过即 source='user'、is_user_edited=1，不再被自动推断覆盖）
 * - 确认（直接 active）
 * - 删除（软删除）
 *
 * characterScope 用空串表示全域（不能传 null，否则唯一约束失效）。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as insightsRepo from '../db/repositories/insights.repo.js';
import { GLOBAL_SCOPE } from '../db/repositories/insights.repo.js';
import { logger } from '../logger.js';

export const insightsRoutes = Router();

insightsRoutes.use(resolveUser);

/** 列出某作用域下的用户偏好（默认全域；characterScope 传角色 id 则看该角色覆盖） */
insightsRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterScope =
      typeof req.query.characterScope === 'string' && req.query.characterScope.trim()
        ? req.query.characterScope.trim()
        : GLOBAL_SCOPE;
    const insights = insightsRepo.listByScope(userId, characterScope);
    ok(res, { insights });
  }),
);

/** 修改一条偏好（用户改写标签 / 手动置状态） */
insightsRoutes.patch(
  '/:insightId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof insightsRepo.update>[2] = {};
    if (typeof body.valueLabel === 'string') patch.valueLabel = body.valueLabel;
    if (typeof body.status === 'string') patch.status = body.status as never;

    const updated = insightsRepo.update(userId, req.params.insightId, patch);
    if (!updated) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條偏好');
    ok(res, { insight: updated });
  }),
);

/** 用户确认一条偏好：直接置 active */
insightsRoutes.post(
  '/:insightId/confirm',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const updated = insightsRepo.confirm(userId, req.params.insightId);
    if (!updated) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條偏好');
    ok(res, { insight: updated });
  }),
);

/** 软删除一条偏好 */
insightsRoutes.delete(
  '/:insightId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = insightsRepo.softDelete(userId, req.params.insightId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條偏好');
    logger.info('[Insights] 偏好已軟刪除', { insightId: req.params.insightId });
    ok(res, { success: true });
  }),
);
