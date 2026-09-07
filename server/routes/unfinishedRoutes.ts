/**
 * 未完待续路由（P0）
 *
 * 前端展示「你之前留下没说完的话」，用户点一下即可回到对应角色继续聊；
 * 主动消息引擎也会读这里的 open 话题来决定是否跟进。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as unfinishedService from '../services/unfinishedTopicService.js';

export const unfinishedRoutes = Router();

unfinishedRoutes.use(resolveUser);

/** 未完话题列表（默认仅 open） */
unfinishedRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId =
      typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 6), 1), 30);

    const items = unfinishedService.listOpen(userId, characterId, limit);
    const total = unfinishedService.countOpen(userId, characterId);
    ok(res, { items, total });
  }),
);

/** 用户回来聊了 → 标记解决 */
unfinishedRoutes.post(
  '/:id/resolve',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const okResolve = unfinishedService.resolve(userId, req.params.id);
    if (!okResolve) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條未完話題');
    ok(res, { ok: true });
  }),
);

/** 用户主动删除 */
unfinishedRoutes.delete(
  '/:id',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const okDelete = unfinishedService.remove(userId, req.params.id);
    if (!okDelete) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條未完話題');
    ok(res, { ok: true });
  }),
);
