/**
 * 用户路由（需求 §21 隐私与数据管理）
 *
 * MVP 没有真实登录：前端在 localStorage 存一个 userId，通过 X-User-Id 头带上来。
 * 服务端只校验"这个用户是否存在"，不做身份校验——
 * 但要接真实登录时，只需要替换 `resolveUser` 中间件，业务层不用动
 * （所有 Repository 首参都是 userId，天然隔离）。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { asyncHandler } from '../errors.js';
import { fail, ok, readBearerToken, readUserIdHeader, requireUserId, resolveUser } from '../http.js';
import type { BootstrapResponse } from '../types.js';
import { env } from '../env.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as charactersRepo from '../db/repositories/characters.repo.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import * as authRepo from '../db/repositories/auth.repo.js';
import * as personaService from '../services/personaService.js';
import * as authService from '../services/authService.js';
import { verifySession } from '../services/authService.js';
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';

export const userRoutes = Router();

/**
 * 解析 bootstrap 的调用者身份。
 *
 * 优先级与 `resolveUser` 保持一致：Bearer 优先 → 匿名回落（仅 ALLOW_ANONYMOUS=1 且该账号未注册）。
 * 单独写一份是因为 bootstrap 是「用户还不存在时也要能进来」的特例，
 * 不能套用 resolveUser（它会要求 users 表里已有这一行）。
 */
function resolveBootstrapUser(req: import('express').Request): string | null {
  const token = readBearerToken(req);
  if (token) {
    const verified = verifySession(token);
    return verified ? verified.userId : null;
  }
  if (!env.allowAnonymous) return null;

  const body = (req.body ?? {}) as { userId?: string; clientUserId?: string };
  const candidate = (body.userId ?? body.clientUserId ?? readUserIdHeader(req) ?? '').trim();
  if (!candidate) return null;
  // ★ 已注册账号不允许匿名 bootstrap：否则伪造 X-User-Id 就能读到别人的角色列表
  if (authRepo.hasPassword(candidate)) return null;
  return candidate;
}

/**
 * Bootstrap：首次打开 App 时调用。
 * 用户不存在则创建，并自动建一个默认角色——
 * 让新用户打开就能聊天，而不是先面对一个空白的创建页。
 *
 * 同时支持 GET（前端 `useAppState` 用的是 GET）与 POST（`useUserId` 用的是 POST），
 * 两者行为完全一致。
 */
function bootstrap(req: import('express').Request, res: import('express').Response): void {
  const userId = resolveBootstrapUser(req);
  if (!userId) {
    fail(res, ErrorCode.AUTH_REQUIRED, '請先登入', 401);
    return;
  }

  const body = (req.body ?? {}) as { timezone?: string };
  const user = personaService.ensureUser(userId, body.timezone);
  const character = personaService.bootstrapDefaultCharacter(userId);

  const characters = charactersRepo.listByUser(userId).map((c) => ({
    ...c,
    runtime: buildRuntime(userId, c.id),
  }));

  const payload: BootstrapResponse = {
    user,
    characters,
    defaultCharacterId: character.id,
    // V2：前端据此决定「要不要提示去注册」「未成年强化保护是否生效」
    hasPassword: authRepo.hasPassword(userId),
    isMinor: user.isMinor,
  };
  ok(res, payload);
}

userRoutes.post('/bootstrap', asyncHandler(bootstrap));
userRoutes.get('/bootstrap', asyncHandler(bootstrap));

// 以下路由都需要用户身份
userRoutes.use(resolveUser);

/** 取当前用户资料 */
userRoutes.get(
  '/:userId',
  asyncHandler((req, res) => {
    const user = usersRepo.getById(requireUserId(req));
    if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND);
    ok(res, { user });
  }),
);

/** 更新设置（外观 / 通知 / 隐私三合一，按需传字段） */
userRoutes.patch(
  '/:userId/settings',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const user = usersRepo.updateSettings(userId, patch as never);
    if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND);
    ok(res, { user });
  }),
);

/**
 * 删除数据（需求 §21：用户拥有对自己数据的控制权）
 * scope: messages | memories | characters | all
 */
userRoutes.delete(
  '/:userId/data',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const scope = (req.query.scope as string) ?? 'all';
    if (!['all', 'messages', 'memories', 'characters'].includes(scope)) {
      throw new ApiError(ErrorCode.VALIDATION, 'scope 只能是 all/messages/memories/characters');
    }

    // 删全部数据前先把凭据与会话清掉：否则删完账号还留着一个「已登录」的令牌
    if (scope === 'all') {
      authService.purgeCredentials(userId);
    }

    const result = usersRepo.deleteUserData(userId, scope as 'all');

    // 清空后补一个默认角色，避免用户回到一个完全空白、无法聊天的状态
    if (scope === 'all' || scope === 'characters') {
      personaService.bootstrapDefaultCharacter(userId);
    }

    logger.info('[User] 資料已刪除', { userId, scope, deleted: result.deleted });
    ok(res, { success: true, deleted: result.deleted });
  }),
);

/** 导出全部数据（数据可携带权） */
userRoutes.get(
  '/:userId/export',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const user = usersRepo.getById(userId);
    if (!user) throw new ApiError(ErrorCode.USER_NOT_FOUND);

    ok(res, {
      exportedAt: new Date().toISOString(),
      user,
      characters: charactersRepo.listByUser(userId),
      conversations: conversationsRepo.listConversations(userId, {}),
      memories: [],   // 记忆按角色维度存，见 /api/memories
      emotions: [],
    });
  }),
);

// ============================================================
// 辅助
// ============================================================

function buildRuntime(userId: string, characterId: string) {
  const conversation = conversationsRepo.findOrCreateActive(userId, characterId);
  const lastMessages = conversationsRepo.listRecentMessages(userId, conversation.id, 1);
  const last = lastMessages[0];

  return {
    emotion:
      statesRepo.getEmotion(userId, characterId) ?? {
        id: '',
        userId,
        characterId,
        currentEmotion: 'calm',
        intensity: 0.3,
        valence: 0.2,
        arousal: 0.2,
        emotionReason: '',
        lastDecayAt: null,
        updatedAt: new Date().toISOString(),
      },
    relationship:
      statesRepo.getRelationship(userId, characterId) ?? {
        id: '',
        userId,
        characterId,
        stage: 'stranger',
        interactionLevel: 0,
        messageScore: 0,
        activeDayScore: 0,
        memoryScore: 0,
        shareDepthScore: 0,
        totalUserMessages: 0,
        distinctActiveDays: 0,
        floorStage: 'stranger',
        lastInteractionAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    lastMessagePreview: last ? last.content.slice(0, 40) : '',
    lastMessageAt: last?.createdAt ?? null,
    unreadProactiveCount: conversationsRepo.countUnreadProactive(userId, characterId),
  };
}

export { buildRuntime };
