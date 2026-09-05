/**
 * 主动聊天路由（需求 §10–§13）
 *
 * `/status` 是**刻意暴露的决策可视化接口**：
 * 需求 §27.2 要求"不能只显示 AI 会主动聊天，实际上没有后台任务"。
 * 所以这里把七因子的原始值、加权值、否决原因码全部返回，
 * 用户能在设置页亲眼看到"AI 现在为什么不来找我"。
 */

import { Router } from 'express';
import { ErrorCode } from '../../shared/errors.js';
import { env } from '../env.js';
import { ApiError, asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as pushRepo from '../db/repositories/push.repo.js';
import * as proactiveRepo from '../db/repositories/proactive.repo.js';
import * as personaService from '../services/personaService.js';
import { explain, decide } from '../services/proactive/decisionService.js';
import { runOnce, schedulerState } from '../services/proactive/scheduler.js';
import { logger } from '../logger.js';

export const proactiveRoutes = Router();

proactiveRoutes.use(resolveUser);

/**
 * 主动消息收件箱。
 * 即使没有推送通道（iOS 未加到主屏幕 / 用户关了通知），
 * 主动消息也会在这里——这是保底触达，保证功能不会因为平台限制而失效。
 */
proactiveRoutes.get(
  '/inbox',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const limit = Number(req.query.limit ?? 20);
    const messages = conversationsRepo.listUnreadProactive(
      userId,
      Number.isFinite(limit) ? limit : 20,
    );
    ok(res, { messages });
  }),
);

/** 标记主动消息已读 */
proactiveRoutes.post(
  '/ack',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const ids = (req.body ?? {}).messageIds;
    if (!Array.isArray(ids)) throw new ApiError(ErrorCode.BAD_REQUEST, 'messageIds 必須是陣列');
    const count = conversationsRepo.markRead(
      userId,
      ids.filter((i): i is string => typeof i === 'string'),
    );
    ok(res, { success: true, count });
  }),
);

/**
 * 决策状态可视化。
 * 返回完整的因子明细与"今天是第几条 / 上限多少"。
 */
proactiveRoutes.get(
  '/status',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const rawId = typeof req.query.characterId === 'string' ? req.query.characterId : '';
    const characters = personaService.listCharacters(userId);
    const character = characters.find((c) => c.id === rawId) ?? characters[0];
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '還沒有可用的角色');

    const user = usersRepo.getById(userId);
    const status = explain({
      userId,
      character,
      settings: character.proactiveSettings,
      lastSeenAt: user?.lastSeenAt ?? null,
      hasPushChannel: pushRepo.listPush(userId).length > 0,
      timezone: user?.timezone ?? env.appTz,
    });

    ok(res, status);
  }),
);

/** 决策历史（最近 20 条，含被否决的记录） */
proactiveRoutes.get(
  '/history',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    const tasks = proactiveRepo.listTasks(userId, { characterId, limit: 20 });
    ok(res, { tasks });
  }),
);

/** 调度器运行状态 */
proactiveRoutes.get(
  '/scheduler',
  asyncHandler((_req, res) => {
    ok(res, {
      enabled: schedulerState.enabled,
      running: schedulerState.running,
      lastTickAt: schedulerState.lastTickAt,
      tickMs: env.proactiveTickMs,
      proactiveEnabled: env.proactiveEnabled,
    });
  }),
);

/**
 * 手动触发一次调度（仅开发环境）。
 * 生产环境必须设置 ENABLE_DEBUG_ROUTES=0。
 */
proactiveRoutes.post(
  '/tick',
  asyncHandler(async (_req, res) => {
    if (!env.enableDebugRoutes) {
      throw new ApiError(ErrorCode.FORBIDDEN, '除錯路由未啟用');
    }
    await runOnce();
    ok(res, { success: true, lastTickAt: schedulerState.lastTickAt });
  }),
);

/**
 * 仅做决策不发送（调试用，方便前端快速看到因子变化）。
 */
proactiveRoutes.get(
  '/dry-run',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const rawId = typeof req.query.characterId === 'string' ? req.query.characterId : '';
    const characters = personaService.listCharacters(userId);
    const character = characters.find((c) => c.id === rawId) ?? characters[0];
    if (!character) throw new ApiError(ErrorCode.NOT_FOUND, '還沒有可用的角色');

    const user = usersRepo.getById(userId);
    const result = decide({
      userId,
      character,
      settings: character.proactiveSettings,
      lastSeenAt: user?.lastSeenAt ?? null,
      hasPushChannel: pushRepo.listPush(userId).length > 0,
      timezone: user?.timezone ?? env.appTz,
      // 允许调试时把时钟往后拨，模拟「已经 N 小时没聊了」。
      // 注意方向：必须 + 而不是 -。若往前拨，lastInteractionAt 会落在「未来」，
      // minutesSinceLastChat 变成负数，会被 V9/V11 误判为「从未互动过」，
      // 这个调试参数就永远看不到真实的打分过程。
      now: req.query.simulateIdleHours
        ? new Date(Date.now() + Number(req.query.simulateIdleHours) * 3_600_000)
        : new Date(),
    });

    logger.debug('[Proactive] dry-run', { characterId: character.id, decision: result.decision });
    ok(res, result);
  }),
);
