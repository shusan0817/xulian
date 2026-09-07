/**
 * 故事路由（需求 V2-2「我们的故事」）
 *
 * 用户对自己「被记住的故事」拥有完全控制权：可查看 / 修改 / 删除 / 还原自动版本 / 手动新增。
 * 所有写操作都带 userId 条件（repo 层天然隔离）。
 */

import { Router } from 'express';
import { STORY_TYPES, type StoryType } from '../../shared/constants.js';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as storyService from '../services/storyService.js';
import * as storiesRepo from '../db/repositories/stories.repo.js';

export const storiesRoutes = Router();

storiesRoutes.use(resolveUser);

/** 故事列表：支持按角色、类型筛选 */
storiesRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId =
      typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const rawType = typeof req.query.type === 'string' ? req.query.type : undefined;
    const type =
      rawType && (STORY_TYPES as readonly string[]).includes(rawType)
        ? (rawType as StoryType)
        : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const result = storyService.listStories(userId, { characterId, type, limit, offset });
    ok(res, result);
  }),
);

/** 单条故事 */
storiesRoutes.get(
  '/:id',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const story = storyService.getStory(userId, req.params.id);
    if (!story) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條故事');
    ok(res, story);
  }),
);

/** 用户修改故事（标题 / 摘要 / 重要度 / 置顶 / 发生时间） */
storiesRoutes.patch(
  '/:id',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: {
      title?: string;
      summary?: string;
      importance?: number;
      pinned?: boolean;
      happenedAt?: string;
    } = {};
    if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 40);
    if (typeof body.summary === 'string') patch.summary = body.summary.trim().slice(0, 200);
    if (typeof body.importance === 'number') patch.importance = body.importance;
    if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
    if (typeof body.happenedAt === 'string') patch.happenedAt = body.happenedAt;

    const updated = storyService.updateStory(userId, req.params.id, patch);
    if (!updated) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條故事');
    ok(res, updated);
  }),
);

/** 还原为自动生成版本 */
storiesRoutes.post(
  '/:id/restore',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const restored = storyService.restoreStory(userId, req.params.id);
    if (!restored) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條故事');
    ok(res, restored);
  }),
);

/** 软删除（保留行，便于误删恢复与云端同步） */
storiesRoutes.delete(
  '/:id',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const okDelete = storyService.deleteStory(userId, req.params.id);
    if (!okDelete) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這條故事');
    ok(res, { ok: true });
  }),
);

/** 用户手动新增一条故事（type 默认 user_saved，来源为用户） */
storiesRoutes.post(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const characterId = typeof body.characterId === 'string' ? body.characterId : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!characterId) throw new ApiError(ErrorCode.VALIDATION, '缺少 characterId');
    if (!title) throw new ApiError(ErrorCode.VALIDATION, '故事標題不能為空');
    if (!summary) throw new ApiError(ErrorCode.VALIDATION, '故事內容不能為空');

    const rawType = typeof body.type === 'string' ? body.type : 'user_saved';
    const type = (STORY_TYPES as readonly string[]).includes(rawType)
      ? (rawType as StoryType)
      : 'user_saved';

    const story = storiesRepo.insert(userId, {
      characterId,
      type,
      title,
      summary,
      importance:
        typeof body.importance === 'number' ? Math.max(0, Math.min(1, body.importance)) : 0.6,
      source: 'user',
      isUserCreated: true,
      sourceMessageIds: [],
      happenedAt:
        typeof body.happenedAt === 'string' ? body.happenedAt : new Date().toISOString(),
    });
    ok(res, story);
  }),
);
