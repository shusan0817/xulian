/**
 * 安全策略路由（V2-13）
 *
 * 挂载在 `/api/safety`。
 *
 * 为什么要有这个路由：需求 §V2-13 要求「安全机制作为核心功能，不是最后补充」。
 * 一个用户看不见、也验证不了的安全机制，跟没有是一样的。
 * 所以这里把「我们在保护什么」明明白白地返回给前端，设置页直接展示。
 */

import { Router } from 'express';
import { SAFETY_POLICY_SUMMARY, MINOR_RULES } from '../config/safetyRules.js';
import { asyncHandler } from '../errors.js';
import { ok, requireUserId, resolveUser } from '../http.js';
import * as safetyRepo from '../db/repositories/safety.repo.js';
import * as safetyPolicyService from '../services/safetyPolicyService.js';

export const safetyRoutes = Router();

safetyRoutes.use(resolveUser);

/**
 * 安全政策摘要（无需登录也能看）。
 * 不返回具体词库内容——避免把规则变成绕过指南。
 */
safetyRoutes.get(
  '/policy',
  asyncHandler((_req, res) => {
    ok(res, { policy: SAFETY_POLICY_SUMMARY });
  }),
);

/**
 * 我的未成年保护状态。
 *
 * 用户可以看懂「AI 为什么这个时间段不来找我」，而不是面对一个黑箱。
 * 这里不返回出生日期本身——那是敏感信息，账号页才展示。
 */
safetyRoutes.get(
  '/minor-guard',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : '';

    // 支持模拟时间点：?at=2026-01-01T15:00:00Z（测试与调试用）
    const atRaw = typeof req.query.at === 'string' ? Date.parse(req.query.at) : Number.NaN;
    const at = Number.isFinite(atRaw) ? new Date(atRaw) : new Date();

    const guard = safetyPolicyService.minorGuard(userId, characterId, at);
    ok(res, {
      guard: {
        isMinor: guard.isMinor,
        quietHours: guard.quietHours,
        dailyCap: guard.dailyCap,
        inQuietHours: guard.inQuietHours,
        sentToday: guard.sentToday,
        // Infinity 不能进 JSON，成年用户用 null 表示「不受上限约束」
        remaining: Number.isFinite(guard.remaining) ? guard.remaining : null,
      },
      at: at.toISOString(),
      rules: {
        ageThreshold: MINOR_RULES.ageThreshold,
        strictIncoming: MINOR_RULES.strictIncoming,
      },
    });
  }),
);

/** 我的安全日志（脱敏后的拦截记录 + 我举报过的内容） */
safetyRoutes.get(
  '/logs',
  asyncHandler((req, res) => {
    const userId = requireUserId(req);
    const limitRaw = Number(req.query.limit ?? 30);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30;
    ok(res, {
      items: safetyRepo.listSafetyLogs(userId, limit),
      reports: safetyRepo.listBySource(userId, 'user_report', limit),
    });
  }),
);
