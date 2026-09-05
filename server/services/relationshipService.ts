/**
 * 关系成长服务（需求 §9）
 *
 * **最重要的设计约束：只增不减。**
 *
 * 需求 §9 明确写了两条禁令：
 *   - 不要设计成「用户一天不登录，关系就下降」的惩罚机制；
 *   - 不要利用关系系统诱导用户消费。
 *
 * 所以本服务里：
 *   - 没有任何时间衰减项；
 *   - interactionLevel 用 Math.max 单向抬升，永不回落；
 *   - floorStage 保证阶段不会掉下去（哪怕用户手动调低了初始设定）；
 *   - 阶段只能逐级推进，不允许跨两级跳（保证成长可感知）。
 *
 * 四个分量（权重见 RELATIONSHIP_WEIGHTS）：
 *   消息量 0.35 / 活跃天 0.25 / 记忆数 0.25 / 自我表露深度 0.15
 */

import { RELATIONSHIP_STAGES, RELATIONSHIP_WEIGHTS } from '../../shared/constants.js';
import type { RelationshipStage } from '../../shared/constants.js';
import type { AICharacter, RelationshipState } from '../../shared/types.js';
import { RELATIONSHIP_CONFIG, stageFromLevel } from '../config/defaults.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import * as memoriesRepo from '../db/repositories/memories.repo.js';
import { clamp01, dayKey, nowIso } from '../db/helpers.js';
import { logger } from '../logger.js';

export interface TouchInput {
  userId: string;
  character: AICharacter;
  /** 本轮用户自我表露深度 0..1（来自用户情绪分析） */
  shareDepth: number;
  timezone?: string;
}

/**
 * 一轮互动后推进关系。
 * 返回更新后的状态；如果本次没有实质推进（例如刚初始化），也返回当前状态。
 */
export function touchRelationship(input: TouchInput): RelationshipState {
  const { userId, character, shareDepth } = input;

  const current = ensureState(userId, character);

  // ---- 1. 累加各分量 ----
  const messageCount = conversationsRepo.countUserMessages(userId, character.id);
  const memoryCount = memoriesRepo.countMemories(userId, character.id);

  // 活跃天：今天是否已经记过（同一天只算一次）
  const today = dayKey(new Date(), input.timezone);
  const existed = usersRepo.listActiveDays(userId, character.id).includes(today);
  if (!existed) usersRepo.addActiveDay(userId, character.id, today);
  const activeDays = usersRepo.countActiveDays(userId, character.id);

  const messageScore = clamp01(messageCount * RELATIONSHIP_CONFIG.perMessageIncrement);
  const activeDayScore = clamp01(activeDays * RELATIONSHIP_CONFIG.perActiveDayIncrement);
  const memoryScore = clamp01(memoryCount * RELATIONSHIP_CONFIG.perMemoryIncrement);

  // shareDepth 用指数移动平均，避免单轮深度表露把分数拉爆
  const alpha = RELATIONSHIP_CONFIG.shareDepthEma;
  const shareDepthScore = clamp01(
    current.shareDepthScore * (1 - alpha) + clamp01(shareDepth) * alpha,
  );

  // ---- 2. 加权合成（只增不减）----
  const level = clamp01(
    messageScore * RELATIONSHIP_WEIGHTS.messageScore +
      activeDayScore * RELATIONSHIP_WEIGHTS.activeDayScore +
      memoryScore * RELATIONSHIP_WEIGHTS.memoryScore +
      shareDepthScore * RELATIONSHIP_WEIGHTS.shareDepthScore,
  );
  const nextLevel = Math.max(current.interactionLevel, level);

  // ---- 3. 阶段推进（含 floorStage 兜底 + 逐级限制）----
  const theoretical = stageFromLevel(nextLevel, current.stage);
  const nextStage = maxStage(theoretical, current.stage, current.floorStage);

  const updated = statesRepo.upsertRelationship(userId, character.id, {
    stage: nextStage,
    interactionLevel: nextLevel,
    messageScore: Math.max(current.messageScore, messageScore),
    activeDayScore: Math.max(current.activeDayScore, activeDayScore),
    memoryScore: Math.max(current.memoryScore, memoryScore),
    shareDepthScore: Math.max(current.shareDepthScore, shareDepthScore),
    totalUserMessages: messageCount,
    distinctActiveDays: activeDays,
    lastInteractionAt: nowIso(),
  });

  if (nextStage !== current.stage) {
    logger.info('[Relationship] 關係階段推進', {
      characterId: character.id,
      from: current.stage,
      to: nextStage,
      level: nextLevel.toFixed(3),
    });
  }

  return updated;
}

/** 确保关系状态存在（首次互动时初始化） */
export function ensureState(userId: string, character: AICharacter): RelationshipState {
  const existing = statesRepo.getRelationship(userId, character.id);
  if (existing) return existing;

  return statesRepo.upsertRelationship(userId, character.id, {
    stage: character.initialStage,
    interactionLevel: 0,
    messageScore: 0,
    activeDayScore: 0,
    memoryScore: 0,
    shareDepthScore: 0,
    totalUserMessages: 0,
    distinctActiveDays: 0,
    floorStage: character.initialStage,
    lastInteractionAt: nowIso(),
  });
}

/** 取三个 stage 中最高（按成长顺序）的那个 */
function maxStage(...stages: RelationshipStage[]): RelationshipStage {
  let best: RelationshipStage = 'stranger';
  for (const s of stages) {
    if (RELATIONSHIP_STAGES.indexOf(s) > RELATIONSHIP_STAGES.indexOf(best)) best = s;
  }
  return best;
}

/**
 * 用户手动修改关系阶段时调用（设置页）。
 * 手动设定会同时抬高 floorStage，表示该阶段是「用户认可的底线」。
 */
export function setStage(
  userId: string,
  characterId: string,
  stage: RelationshipStage,
): RelationshipState {
  const current = statesRepo.getRelationship(userId, characterId);
  return statesRepo.upsertRelationship(userId, characterId, {
    stage,
    floorStage: stage,
    // 手动设定到某阶段时，把互动值抬到该阶段门槛，避免"阶段是默契但互动值 0.05"的割裂
    interactionLevel: Math.max(
      current?.interactionLevel ?? 0,
      stageThreshold(stage),
    ),
  });
}

function stageThreshold(stage: RelationshipStage): number {
  const thresholds: Record<RelationshipStage, number> = {
    stranger: 0,
    familiar: 0.15,
    close: 0.4,
    bonded: 0.7,
  };
  return thresholds[stage];
}
