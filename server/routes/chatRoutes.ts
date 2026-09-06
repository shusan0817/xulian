/**
 * 聊天 / 会话 / 消息路由
 *
 * SSE 实现要点（不能用 EventSource，因为它是 GET 且不支持自定义头）：
 * - 服务端：`initSseResponse` 写头 → 逐条 `writeSseEvent` → `endSse`；
 * - 每 15 秒写一行 `: ping` 心跳，防止反代/浏览器判定连接超时；
 * - 客户端断开时（res.on('close')）abort 掉 SDK 调用，避免继续烧 token；
 *   注意不能用 req.on('close')，Node 16+ 里它在请求体读完后就触发了。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { MAX_USER_INPUT_LENGTH, normalizeChatMode } from '../../shared/constants.js';
import { ApiError, asyncHandler } from '../errors.js';
import {
  endSse,
  initSseResponse,
  ok,
  requireUserId,
  resolveUser,
  writeSseEvent,
  writeSsePing,
} from '../http.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as personaService from '../services/personaService.js';
import { streamChat } from '../services/chatService.js';
import * as emotionService from '../services/emotionService.js';
import * as relationshipService from '../services/relationshipService.js';
import { aiRateLimiter } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { newId } from '../db/helpers.js';

export const chatRoutes = Router();

chatRoutes.use(resolveUser);

// ============================================================
// 流式聊天
// ============================================================

chatRoutes.post(
  '/stream',
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const userId = requireUserId(req);
    logger.info('[Chat] request received', {
      userId,
      sessionId: req.sessionId ?? null,
      authMode: req.authMode ?? null,
    });
    const body = (req.body ?? {}) as Record<string, unknown>;

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new ApiError(ErrorCode.EMPTY_MESSAGE, '說點什麼吧');
    if (text.length > MAX_USER_INPUT_LENGTH) {
      throw new ApiError(ErrorCode.TOO_LONG, `訊息太長了（上限 ${MAX_USER_INPUT_LENGTH} 字）`);
    }

    let characterId = typeof body.characterId === 'string' ? body.characterId : '';
    if (!characterId) {
      // 未指定角色时自动取默认角色；首次使用则创建一个默认角色，
      // 避免新用户一进来就 404「還沒有可用的角色」。
      characterId = personaService.bootstrapDefaultCharacter(userId).id;
    }
    if (!characterId) throw new ApiError(ErrorCode.NOT_FOUND, '還沒有可用的角色');

    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
    const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined;

    // V2-8：本轮聊天模式。不传或非法值 → 服务端回落到角色设置 / auto
    const chatMode =
      typeof body.chatMode === 'string' && body.chatMode.trim()
        ? normalizeChatMode(body.chatMode.trim())
        : undefined;

    initSseResponse(res);

    const controller = new AbortController();
    let closed = false;
    // 注意：必须监听 res 的 close 而不是 req 的——Node 16+ 里 req 的 close
    // 在请求体读完后就会触发，用它判断「客户端断开」会让 SSE 立刻中断。
    res.on('close', () => {
      closed = true;
      controller.abort();
    });

    // 心跳：防止反代判定空闲连接超时
    const heartbeat = setInterval(() => {
      if (!closed) writeSsePing(res);
    }, 15_000);

    try {
      logger.info('[Chat] AI request started', { userId, characterId });
      const events = streamChat(
        { userId, characterId, conversationId, text, clientMessageId, chatMode },
        {
          getCharacter: (uid, cid) => personaService.getCharacter(uid, cid),
          getPrivacy: (uid) => {
            const user = usersRepo.getById(uid);
            return {
              longTermMemoryEnabled: user?.privacySettings.longTermMemoryEnabled ?? true,
              saveChatHistory: user?.privacySettings.saveChatHistory ?? true,
            };
          },
        },
        controller.signal,
      );

      for await (const event of events) {
        if (closed) break;
        writeSseEvent(res, event);
      }
    } catch (err) {
      logger.error('[Chat] SSE 串流出錯', {
        message: err instanceof Error ? err.message : String(err),
      });
      if (!closed) {
        writeSseEvent(res, {
          type: 'error',
          code: ErrorCode.INTERNAL,
          message: '連線出了點問題，再試一次好嗎？',
          retryable: true,
        });
      }
    } finally {
      clearInterval(heartbeat);
      endSse(res);
    }
  }),
);

/**
 * 重新生成：删除上一条助手消息后重新走一次完整流程。
 * 按决策 11，只保留最新一条（覆盖式），不做分支树。
 */
chatRoutes.post(
  '/regenerate',
  asyncHandler(async (req, res) => {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const conversationId = String(body.conversationId ?? '');
    const characterId = String(body.characterId ?? '');

    if (!conversationId || !characterId) {
      throw new ApiError(ErrorCode.BAD_REQUEST, '缺少 conversationId 或 characterId');
    }

    // 找到最后一条助手消息并删除
    const recent = conversationsRepo.listRecentMessages(userId, conversationId, 10);
    const lastAssistant = [...recent].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      conversationsRepo.deleteMessage(userId, lastAssistant.id);
    }

    // 取最后一条用户消息作为输入
    const lastUser = [...recent].reverse().find((m) => m.role === 'user');
    if (!lastUser) throw new ApiError(ErrorCode.BAD_REQUEST, '沒有可重新生成的訊息');

    initSseResponse(res);
    const controller = new AbortController();
    let closed = false;
    // 注意：必须监听 res 的 close 而不是 req 的——Node 16+ 里 req 的 close
    // 在请求体读完后就会触发，用它判断「客户端断开」会让 SSE 立刻中断。
    res.on('close', () => {
      closed = true;
      controller.abort();
    });

    const heartbeat = setInterval(() => {
      if (!closed) writeSsePing(res);
    }, 15_000);

    try {
      const events = streamChat(
        { userId, characterId, conversationId, text: lastUser.content, clientMessageId: newId() },
        {
          getCharacter: (uid, cid) => personaService.getCharacter(uid, cid),
          getPrivacy: (uid) => {
            const user = usersRepo.getById(uid);
            return {
              longTermMemoryEnabled: user?.privacySettings.longTermMemoryEnabled ?? true,
              saveChatHistory: user?.privacySettings.saveChatHistory ?? true,
            };
          },
        },
        controller.signal,
      );

      for await (const event of events) {
        if (closed) break;
        writeSseEvent(res, event);
      }
    } finally {
      clearInterval(heartbeat);
      endSse(res);
    }
  }),
);

// ============================================================
// 会话
// ============================================================

chatRoutes.get(
  '/conversations',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const conversations = conversationsRepo.listConversations(userId, { characterId });
    ok(res, { conversations });
  }),
);

chatRoutes.get(
  '/conversations/:conversationId/messages',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    // ★ IDOR 防护：先确认这个会话属于当前用户，否则一律 404，
    //    绝不返回「他人会话的空消息列表」（空 200 仍算越权口径不严谨）。
    const conversation = conversationsRepo.getConversation(userId, req.params.conversationId);
    if (!conversation) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個對話');
    const limit = Number(req.query.limit ?? 30);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const page = conversationsRepo.listMessages(userId, req.params.conversationId, {
      limit: Number.isFinite(limit) ? limit : 30,
      before,
    });
    ok(res, page);
  }),
);

chatRoutes.delete(
  '/conversations/:conversationId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = conversationsRepo.deleteConversation(userId, req.params.conversationId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個對話');
    ok(res, { success: true });
  }),
);

// ============================================================
// 消息
// ============================================================

chatRoutes.delete(
  '/messages/:messageId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const success = conversationsRepo.deleteMessage(userId, req.params.messageId);
    if (!success) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這則訊息');
    ok(res, { success: true });
  }),
);

/** 标记主动消息已读（进入聊天页时调用） */
chatRoutes.post(
  '/messages/read',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const ids = (req.body ?? {}).messageIds;
    if (!Array.isArray(ids)) throw new ApiError(ErrorCode.BAD_REQUEST, 'messageIds 必須是陣列');
    const count = conversationsRepo.markRead(userId, ids.filter((i): i is string => typeof i === 'string'));
    ok(res, { success: true, count });
  }),
);

// ============================================================
// 状态查询（首页用）
// ============================================================

/** 某个角色的当前情绪 / 关系（首页卡片） */
chatRoutes.get(
  '/state/:characterId',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const character = personaService.getCharacter(userId, req.params.characterId);
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '找不到這個角色');

    ok(res, {
      emotion: emotionService.getEmotion(userId, character),
      relationship: relationshipService.ensureState(userId, character),
    });
  }),
);
