/**
 * 小话题路由（P1「AI 小话题 / 今天聊什么」）
 *
 * 给「不知道聊什么」的用户生成轻松可接的小话题。基于该角色对用户的长期记忆做个性化；
 * LLM 不可用时回退到预设暖场话题。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as charactersRepo from '../db/repositories/characters.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as smallTopicService from '../services/smallTopicService.js';

export const smallTopicsRoutes = Router();

smallTopicsRoutes.use(resolveUser);

smallTopicsRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : '';
    if (!characterId) throw new ApiError(ErrorCode.VALIDATION, '缺少 characterId');

    const character = charactersRepo.getById(userId, characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');

    const longTermEnabled = usersRepo.getById(userId)?.privacySettings.longTermMemoryEnabled ?? true;
    const topics = await smallTopicService.suggestTopics(userId, character, longTermEnabled);
    ok(res, { topics });
  }),
);
