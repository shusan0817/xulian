/**
 * 主动聊天调度器（需求 §12 / §25）
 *
 * 需求 §12 的完整链路在这里闭环：
 *   Scheduler tick → 檢查符合條件的用戶 → 讀取設定 → 免打擾 → 頻率
 *   → 讀最近聊天 / 用戶情緒 / AI 情緒 / Persona / 記憶 / 關係
 *   → 主動性決策 → 生成消息 → 安全檢查 → 保存消息 → 推送
 *
 * 工程上必须解决的问题：
 * 1. **幂等**：用 `proactive_runs(character_id, window_key)` 的唯一索引抢锁，
 *    保证同一个时间窗内同一个角色不会被处理两次（服务重启/多实例都安全）。
 * 2. **失败重试**：退避 1 / 5 / 15 分钟，最多 3 次。
 *    **但安全拦截不重试生成**——模型反复产出违规内容的概率很高，重试只是浪费额度。
 * 3. **不阻塞主服务**：整个 tick 是异步的，且单个角色出错不影响其他角色。
 * 4. **可关闭**：`PROACTIVE_ENABLED=0` 时完全不启动（生产环境按需控制）。
 */

import { env } from '../../env.js';
import { PROACTIVE_CONFIG } from '../../config/defaults.js';
import { PROACTIVE_TICK_MS } from '../../../shared/constants.js';
import type { ProactiveTask } from '../../../shared/types.js';

import * as proactiveRepo from '../../db/repositories/proactive.repo.js';
import * as usersRepo from '../../db/repositories/users.repo.js';
import * as pushRepo from '../../db/repositories/push.repo.js';
import * as charactersRepo from '../../db/repositories/characters.repo.js';
import * as conversationsRepo from '../../db/repositories/conversations.repo.js';
import * as memoriesRepo from '../../db/repositories/memories.repo.js';
import * as statesRepo from '../../db/repositories/states.repo.js';

import { decide } from './decisionService.js';
import { generateProactiveMessage } from './generatorService.js';
import { sendToUser } from '../notificationService.js';
import { logger } from '../../logger.js';
import { dayKey, nowIso } from '../../db/helpers.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastTickAt: string | null = null;

/** 启动调度器 */
export function startScheduler(): void {
  if (!env.proactiveEnabled) {
    logger.info('[Proactive] 調度器已停用（PROACTIVE_ENABLED=0）');
    return;
  }
  if (timer) return;

  const interval = env.proactiveTickMs || PROACTIVE_TICK_MS;
  logger.info('[Proactive] 調度器啟動', { intervalMs: interval });

  // 启动后延迟 20 秒再跑第一轮，避免和数据库初始化抢资源
  setTimeout(() => void tick(), 20_000);
  timer = setInterval(() => void tick(), interval);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[Proactive] 調度器已停止');
  }
}

/**
 * 一轮检查。
 * 用 running 标志防止上一轮还没跑完就开下一轮（tick 间隔 10 分钟，
 * 但生成消息可能因为 LLM 慢而超时）。
 */
export async function tick(): Promise<void> {
  if (running) {
    logger.debug('[Proactive] 上一輪尚未結束，跳過本次 tick');
    return;
  }
  running = true;
  lastTickAt = nowIso();
  const started = Date.now();

  try {
    // 先做清理：重置卡住的 sending、过期老任务
    const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    proactiveRepo.adminResetStaleSending(staleCutoff);
    proactiveRepo.adminExpireOldTasks(
      new Date(Date.now() - PROACTIVE_CONFIG.taskExpireHours * 3_600_000).toISOString(),
    );

    const targets = proactiveRepo.adminListProactiveTargets();
    logger.debug('[Proactive] 本輪待評估目標', { count: targets.length });

    for (const target of targets) {
      try {
        await processTarget(target.userId, target.characterId);
      } catch (err) {
        logger.error('[Proactive] 處理目標失敗', {
          characterId: target.characterId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 清理旧的幂等记录与计数器（保留 3 天）
    const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();
    proactiveRepo.adminCleanupOldRuns(cutoff);
    proactiveRepo.adminCleanupOldCounters(dayKey(new Date(Date.now() - 3 * 86_400_000)));

    logger.info('[Proactive] tick 完成', {
      targets: targets.length,
      durationMs: Date.now() - started,
    });
  } finally {
    running = false;
  }
}

/** 处理单个（用户 × 角色） */
async function processTarget(userId: string, characterId: string): Promise<void> {
  const now = new Date();
  const user = usersRepo.getById(userId);
  const character = charactersRepo.getById(userId, characterId);
  if (!user || !character) return;

  // ---- 幂等抢锁：同一时间窗只处理一次 ----
  const windowKey = makeWindowKey(now, env.proactiveTickMs || PROACTIVE_TICK_MS);
  if (!proactiveRepo.adminAcquireRunLock(characterId, windowKey)) {
    return; // 已被本轮（或另一个实例）处理过
  }

  try {
    const settings = character.proactiveSettings;
    const hasPushChannel = pushRepo.listPush(userId).length > 0;

    const result = decide({
      userId,
      character,
      settings,
      lastSeenAt: user.lastSeenAt,
      hasPushChannel,
      timezone: user.timezone,
      now,
    });

    // skip：留痕即可（调试面板要能解释"为什么 AI 没来找我"）
    if (result.decision === 'skip') {
      proactiveRepo.insertTask(userId, {
        characterId,
        status: 'skipped',
        decision: 'skip',
        score: result.score,
        reasonCode: result.reasonCode,
        reasonDetail: result.detail,
      });
      return;
    }

    // delay：排一个稍后重评的任务
    if (result.decision === 'delay') {
      proactiveRepo.insertTask(userId, {
        characterId,
        status: 'scheduled',
        decision: 'delay',
        score: result.score,
        reasonCode: result.reasonCode,
        reasonDetail: result.detail,
        scheduledAt: result.nextCheckAt,
      });
      return;
    }

    // ---- send：生成 → 安全 → 保存 → 推送 ----
    const task = proactiveRepo.insertTask(userId, {
      characterId,
      status: 'sending',
      decision: 'send',
      score: result.score,
      reasonCode: result.reasonCode,
      reasonDetail: result.detail,
    });

    await sendProactiveMessage(userId, character, task);
  } finally {
    proactiveRepo.adminFinishRunLock(characterId, windowKey, 'done');
  }
}

/**
 * 生成并投递一条主动消息。
 * 失败时按 1 / 5 / 15 分钟退避重试，最多 3 次。
 */
async function sendProactiveMessage(
  userId: string,
  character: Parameters<typeof generateProactiveMessage>[0]['character'],
  task: ProactiveTask,
): Promise<void> {
  const user = usersRepo.getById(userId);
  const now = new Date();

  const emotion = statesRepo.getEmotion(userId, character.id) ?? {
    currentEmotion: character.initialEmotion,
    intensity: 0.3,
    emotionReason: '',
  } as ReturnType<typeof statesRepo.getEmotion>;

  const relationship =
    statesRepo.getRelationship(userId, character.id) ?? statesRepo.upsertRelationship(userId, character.id, {
      stage: character.initialStage,
      interactionLevel: 0,
      floorStage: character.initialStage,
    });

  const memories = memoriesRepo.searchMemories(userId, character.id, 4);
  const conversation = conversationsRepo.findOrCreateActive(userId, character.id);
  const recentMessages = conversationsRepo.listRecentMessages(userId, conversation.id, 10);
  const lastUserEmotion = statesRepo.getLatestUserEmotion(userId, character.id);

  const generated = await generateProactiveMessage({
    userId,
    character,
    emotion: emotion as NonNullable<typeof emotion>,
    relationship,
    memories,
    recentMessages,
    lastUserEmotion: lastUserEmotion ? lastUserEmotion.emotion : null,
    now,
  });

  // 生成失败或命中安全红线 → 重试（安全拦截也重试，因为模型有随机性，
  // 但最多 3 次；3 次都不行就放弃这一轮，绝不硬发）
  if (!generated.text) {
    const attempts = task.attempts + 1;
    if (attempts >= PROACTIVE_CONFIG.maxAttempts) {
      proactiveRepo.updateTask(userId, task.id, {
        status: 'failed',
        lastError: generated.blockedReason ?? 'generate_failed',
      });
      logger.warn('[Proactive] 主動消息重試次數用盡，放棄本輪', {
        characterId: character.id,
        blockedReason: generated.blockedReason,
      });
      return;
    }

    const backoffMinutes =
      PROACTIVE_CONFIG.retryBackoffMinutes[
        Math.min(attempts - 1, PROACTIVE_CONFIG.retryBackoffMinutes.length - 1)
      ] ?? 15;
    proactiveRepo.updateTask(userId, task.id, {
      status: 'scheduled',
      attempts,
      lastError: generated.blockedReason ?? 'generate_failed',
      scheduledAt: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
    });
    logger.info('[Proactive] 主動消息將重試', {
      characterId: character.id,
      attempts,
      backoffMinutes,
    });
    return;
  }

  // 保存消息（isProactive = true，前端首页收件箱会显示）
  const message = conversationsRepo.insertMessage(userId, {
    conversationId: conversation.id,
    characterId: character.id,
    role: 'assistant',
    content: generated.text,
    aiEmotion: emotion?.currentEmotion ?? null,
    aiEmotionIntensity: emotion?.intensity ?? null,
    strategy: 'companionship',
    isProactive: true,
    isRead: false,
  });

  proactiveRepo.updateTask(userId, task.id, {
    status: 'sent',
    messageId: message.id,
  });

  // 频控计数
  proactiveRepo.bumpDailyCount(userId, character.id, dayKey(now, user?.timezone));

  // 推送（失败不影响消息已入库——App 内收件箱是保底触达）
  const pushResult = await sendToUser(userId, {
    title: character.name,
    body: generated.text,
    url: `/chat?c=${character.id}&m=${message.id}`,
    tag: `xulian-${message.id}`,
  });

  logger.info('[Proactive] 主動消息已送出', {
    characterId: character.id,
    messageId: message.id,
    pushSent: pushResult.sent,
    pushFailed: pushResult.failed,
  });
}

/** 时间窗 key：用于幂等锁。同一 tick 窗口内返回相同值。 */
function makeWindowKey(now: Date, tickMs: number): string {
  const window = Math.floor(now.getTime() / tickMs);
  return `${dayKey(now, env.appTz)}#${window}`;
}

/** 手动触发一次（调试路由用） */
export async function runOnce(): Promise<void> {
  await tick();
}

export const schedulerState = {
  get running(): boolean {
    return running;
  },
  get enabled(): boolean {
    return timer !== null;
  },
  get lastTickAt(): string | null {
    return lastTickAt;
  },
};
