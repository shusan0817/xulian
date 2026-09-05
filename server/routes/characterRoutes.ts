/**
 * 角色路由（需求 §3 / §17 角色创建与编辑）
 *
 * 注意挂载顺序：`/presets` 必须排在 `/:id` 之前，
 * 否则 Express 会把 "presets" 当成角色 ID 匹配掉。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as personaService from '../services/personaService.js';
import * as charactersRepo from '../db/repositories/characters.repo.js';
import { buildRuntime } from './userRoutes.js';
import { logger } from '../logger.js';

export const characterRoutes = Router();

characterRoutes.use(resolveUser);

/** 预设模板列表（给角色创建页展示，无需身份校验也可看，但保持一致性仍走 resolveUser） */
characterRoutes.get(
  '/presets',
  asyncHandler((_req, res) => {
    ok(res, { presets: personaService.listPresets() });
  }),
);

/** 角色列表（含运行态：情绪 / 关系 / 未读主动消息） */
characterRoutes.get(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characters = personaService.listCharacters(userId).map((c) => ({
      ...c,
      runtime: buildRuntime(userId, c.id),
    }));
    ok(res, { characters });
  }),
);

/** 创建角色：body 里带 presetKey 走模板，否则按自定义字段创建 */
characterRoutes.post(
  '/',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const presetKey = typeof body.presetKey === 'string' ? body.presetKey : null;

    const character = presetKey
      ? personaService.createFromPreset(userId, presetKey)
      : personaService.createCharacter(userId, body as never);

    ok(res, { character: { ...character, runtime: buildRuntime(userId, character.id) } }, 201);
  }),
);

/** 单个角色 */
characterRoutes.get(
  '/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.getCharacter(userId, req.params.characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');
    ok(res, { character: { ...character, runtime: buildRuntime(userId, character.id) } });
  }),
);

/** 编辑角色 */
characterRoutes.patch(
  '/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.updateCharacter(
      userId,
      req.params.characterId,
      (req.body ?? {}) as never,
    );
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');
    ok(res, { character });
  }),
);

/** 删除角色（级联删除会话、消息、记忆、情绪态、关系态） */
characterRoutes.delete(
  '/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = personaService.deleteCharacter(userId, req.params.characterId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');

    // 删光了就补一个默认角色，避免用户无角色可用
    const remaining = charactersRepo.listByUser(userId);
    if (!remaining.length) personaService.bootstrapDefaultCharacter(userId);

    logger.info('[Character] 角色已刪除', { characterId: req.params.characterId });
    ok(res, { success: true });
  }),
);

/** 设为默认角色 */
characterRoutes.post(
  '/:characterId/default',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.setDefaultCharacter(userId, req.params.characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');
    ok(res, { character });
  }),
);
