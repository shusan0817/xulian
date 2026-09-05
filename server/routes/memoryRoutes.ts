/**
 * 记忆路由（需求 §8：长期记忆可查看 / 修改 / 删除 / 全部清空 / 关闭）
 *
 * 这些接口是"用户对自己数据拥有控制权"的具体落地——
 * AI 记住了什么，用户必须能看见、能改、能删。
 */

import { Router } from 'express';
import { MEMORY_CATEGORIES } from '../../shared/constants.js';
import type { MemoryCategory } from '../../shared/constants.js';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as memoriesRepo from '../db/repositories/memories.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import { containsSensitive } from '../services/memoryService.js';
import { logger } from '../logger.js';

export const memoryRoutes = Router();

memoryRoutes.use(resolveUser);

/** 记忆列表：支持按角色、分类、关键字筛选 */
memoryRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : undefined;
    const category =
      rawCategory && (MEMORY_CATEGORIES as readonly string[]).includes(rawCategory)
        ? (rawCategory as MemoryCategory)
        : undefined;
    const limit = Number(req.query.limit ?? 100);

    const result = memoriesRepo.listMemories(userId, {
      characterId,
      category,
      q,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    ok(res, result);
  }),
);

/** 手动添加一条记忆（用户主动告诉 AI "记住这件事"） */
memoryRoutes.post(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const characterId = typeof body.characterId === 'string' ? body.characterId : '';
    if (!content) throw new ApiError(ErrorCode.VALIDATION, '記憶內容不能為空');
    if (!characterId) throw new ApiError(ErrorCode.VALIDATION, '缺少 characterId');

    // 敏感信息不入库（需求 §8）
    if (containsSensitive(content)) {
      throw new ApiError(ErrorCode.VALIDATION, '這段內容包含敏感資訊，我不會記下來');
    }

    const rawCategory = typeof body.category === 'string' ? body.category : 'profile';
    const category = ((MEMORY_CATEGORIES as readonly string[]).includes(rawCategory)
      ? rawCategory
      : 'profile') as MemoryCategory;

    const memory = memoriesRepo.insertMemory(userId, {
      characterId,
      category,
      content: content.slice(0, 120),
      importance: typeof body.importance === 'number' ? body.importance : 0.6,
      isSensitive: false,
      sourceMessageId: null,
    });

    ok(res, { memory }, 201);
  }),
);

/** 修改记忆内容 */
memoryRoutes.patch(
  '/:memoryId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (typeof body.content === 'string' && containsSensitive(body.content)) {
      throw new ApiError(ErrorCode.VALIDATION, '這段內容包含敏感資訊');
    }

    const patch: Parameters<typeof memoriesRepo.updateMemory>[2] = {};
    if (typeof body.content === 'string') patch.content = body.content.trim().slice(0, 120);
    if (typeof body.importance === 'number') patch.importance = body.importance;
    if (typeof body.category === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(body.category)) {
      patch.category = body.category as MemoryCategory;
    }

    const memory = memoriesRepo.updateMemory(userId, req.params.memoryId, patch);
    if (!memory) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則記憶');
    ok(res, { memory });
  }),
);

/** 删除单条记忆 */
memoryRoutes.delete(
  '/:memoryId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = memoriesRepo.deleteMemory(userId, req.params.memoryId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則記憶');
    ok(res, { success: true });
  }),
);

/**
 * 清空记忆。
 * 支持按角色清空；不传 characterId 则清空该用户的全部记忆。
 */
memoryRoutes.delete(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const count = memoriesRepo.deleteAllMemories(userId, characterId);
    logger.info('[Memory] 記憶已清空', { userId, characterId: characterId ?? 'ALL', count });
    ok(res, { success: true, count });
  }),
);

/** 长期记忆总开关状态（设置页用） */
memoryRoutes.get(
  '/status',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const user = usersRepo.getById(userId);
    ok(res, {
      longTermMemoryEnabled: user?.privacySettings.longTermMemoryEnabled ?? true,
      total: memoriesRepo.listMemories(userId, { limit: 1 }).total,
    });
  }),
);
