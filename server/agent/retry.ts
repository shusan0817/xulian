/**
 * 重试与并发控制
 *
 * 策略（决策：鉴权失败与安全拦截不重试）：
 * - 最多 3 次尝试，退避 1s / 5s / 15s，带 20% 抖动（避免多个请求同时重试造成雪崩）；
 * - 只有 `SdkCallError.retryable === true` 才重试，鉴权/内容拦截立即放弃；
 * - 全局信号量限制并发 SDK 调用数，防止一次性 spawn 出几十个 CLI 子进程。
 */

import { logger } from '../logger.js';
import { SdkCallError } from './errors.js';

export interface RetryPolicy {
  /** 总尝试次数（含第一次） */
  maxAttempts: number;
  /** 每次失败后的等待时间（毫秒），长度不足时复用最后一个 */
  delays: number[];
  /** 是否加随机抖动 */
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  delays: [1_000, 5_000, 15_000],
  jitter: true,
};

/** 轻量重试策略：后处理（情绪/记忆）用，避免用户等太久 */
export const LIGHT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  delays: [1_000, 5_000],
  jitter: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function delayFor(policy: RetryPolicy, attempt: number): number {
  const base = policy.delays[Math.min(attempt - 1, policy.delays.length - 1)] ?? 1_000;
  if (!policy.jitter) return base;
  // ±20% 抖动
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** 默认重试判定：只有显式标记 retryable 的 SdkCallError 才重试 */
export function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof SdkCallError) return err.retryable;
  return false;
}

/**
 * 带退避的重试执行器。
 * @param fn 每次尝试调用的函数，入参是第几次尝试（从 1 开始）
 * @param policy 重试策略
 * @param shouldRetry 自定义重试判定（默认用 defaultShouldRetry）
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  shouldRetry: (err: unknown) => boolean = defaultShouldRetry,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry = shouldRetry(err) && attempt < policy.maxAttempts;
      if (!canRetry) {
        throw err;
      }
      const waitMs = delayFor(policy, attempt);
      logger.warn('[SDK] 呼叫失敗，準備重試', {
        attempt,
        maxAttempts: policy.maxAttempts,
        waitMs,
        code: err instanceof SdkCallError ? err.code : 'unknown',
        subtype: err instanceof SdkCallError ? err.subtype : 'unknown',
        message: err instanceof Error ? err.message : String(err),
      });
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/**
 * 极简信号量：限制同时进行的操作数。
 * 不用 p-limit 是为了少一个依赖，实现只有 20 行且行为可预测。
 */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  /** 当前正在执行的数量（排障用） */
  get running(): number {
    return this.active;
  }

  /** 排队等待的数量（排障用） */
  get pending(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * 全局 SDK 并发闸门。
 * 上限 4：CLI 子进程每个约占用 100MB 级内存，4 个足够撑住个人使用场景又不炸机器。
 */
export const sdkSemaphore = new Semaphore(4);
