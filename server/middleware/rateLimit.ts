/**
 * 轻量限流 / 去重 / 每日配额中间件（纯内存，运营级防护，不是用户数据）。
 *
 * 设计要点：
 * - 这里维护的是「滥用防护状态」（计数、重置时间），不是聊天/记忆内容，
 *   不涉及任何 userId 维度的业务数据，因此不违反多租户隔离原则；
 * - 固定窗口限流：chatRoutes 的 /stream 同时受「每用户」+「每 IP」两道闸；
 * - 每日配额：按 user:<userId>:<YYYY-MM-DD> 计数，跨天自动重置，
 *   超过 dailyAiLimitPerUser 即拒绝（防止单用户无限烧 AI）；
 * - 全部为 best-effort 防护；进程重启计数清零（可接受，配合 env 上限配置）。
 */

import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { logger } from '../logger.js';

interface FixedWindow {
  count: number;
  resetAt: number;
}

interface DailyCounter {
  count: number;
  date: string;
}

const fixedWindows = new Map<string, FixedWindow>();
const dailyCounters = new Map<string, DailyCounter>();

/** 当前服务器日期（YYYY-MM-DD），频控不需要精确到用户时区 */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 固定窗口限流检查（会就地 +1 计数）。
 * @returns allowed=false 时给出 Retry-After（秒）
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let bucket = fixedWindows.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    fixedWindows.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

/** 每日配额检查（按自然日重置，会就地 +1 计数） */
export function checkDailyLimit(
  key: string,
  limit: number,
): { allowed: boolean; remaining: number } {
  const date = todayStr();
  let counter = dailyCounters.get(key);
  if (!counter || counter.date !== date) {
    counter = { count: 0, date };
    dailyCounters.set(key, counter);
  }
  if (counter.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  counter.count += 1;
  return { allowed: true, remaining: limit - counter.count };
}

/**
 * AI 调用限流中间件工厂。
 * 组合：
 *   1) 每用户每分钟上限（env.rateLimitUserPerMin）；
 *   2) 每用户每日总配额（env.dailyAiLimitPerUser）；
 *   3) 每 IP 每分钟上限（env.rateLimitIpPerMin，覆盖匿名/未认证路径）。
 * 注意：本中间件应在路由层 resolveUser 之后执行，此时 req.userId 已就绪。
 */
export function aiRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const userId = req.userId;
  const ip = req.ip ?? 'unknown';

  if (userId) {
    const perUser = checkRateLimit(`ai:user:${userId}`, env.rateLimitUserPerMin, 60_000);
    if (!perUser.allowed) {
      res
        .status(429)
        .set('Retry-After', String(perUser.retryAfterSec))
        .json({ error: '請慢一點，稍後再試', code: 'E_RATE_LIMIT' });
      return;
    }

    const perDay = checkDailyLimit(`ai:daily:${userId}`, env.dailyAiLimitPerUser);
    if (!perDay.allowed) {
      res.status(429).json({ error: '今日對話額度已用完，明天再來', code: 'E_RATE_LIMIT' });
      return;
    }
  }

  // 每 IP 兜底（也覆盖匿名访问场景）
  const perIp = checkRateLimit(`ai:ip:${ip}`, env.rateLimitIpPerMin, 60_000);
  if (!perIp.allowed) {
    res
      .status(429)
      .set('Retry-After', String(perIp.retryAfterSec))
      .json({ error: '請慢一點，稍後再試', code: 'E_RATE_LIMIT' });
    return;
  }

  logger.debug('[RateLimit] 通過 AI 限流', { userId: userId ?? '(匿名)', ip });
  next();
}
