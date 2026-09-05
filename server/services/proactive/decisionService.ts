/**
 * 主动聊天决策服务（需求 §10 / §11 / §12）
 *
 * **这是「需恋」最重要的特色功能，也是最容易被做假的地方。**
 *
 * 需求 §27.3 明确要求："不要把主动聊天做成固定定时器，必须存在真正的主动性判断。"
 *
 * 所以决策分两段，任何一段没过都不会发消息：
 *
 * **第一段：硬否决（V1–V11）**
 *   任一命中立即 skip，并记录 reasonCode。这些是"绝对不应该打扰"的情况，
 *   不存在"分数高就可以破例"——用户的免打扰设置必须被无条件尊重。
 *
 * **第二段：七因子加权打分**
 *   只有在没有任何否决项时，才评估"现在主动联系是否合适"。
 *   七个因子各自归一化到 0..1 后加权求和：
 *     空闲时长 0.25 / 用户情绪需求 0.20 / 人格主动性 0.15
 *     话题延续 0.12 / 关系阶段 0.10 / 时段匹配 0.10 / AI 情绪 0.08
 *
 * 三段式结果：<0.45 skip / 0.45–0.62 delay（稍后复评）/ ≥0.62 send
 */

import { PROACTIVE_CONFIG } from '../../config/defaults.js';
import { PROACTIVE_WEIGHTS } from '../../../shared/constants.js';
import type { ProactiveSettings } from '../../../shared/types.js';
import type { AICharacter } from '../../../shared/types.js';
import type { ProactiveStatusResponse } from '../../types.js';
import type { DecisionDetail } from '../../../shared/types.js';
import * as proactiveRepo from '../../db/repositories/proactive.repo.js';
import * as statesRepo from '../../db/repositories/states.repo.js';
import { dayKey, isWithinDnd } from '../../db/helpers.js';
import { logger } from '../../logger.js';

export interface DecisionInput {
  userId: string;
  character: AICharacter;
  settings: ProactiveSettings;
  /** 用户最近一次 heartbeat 时间（ISO），null 表示从没上报过 */
  lastSeenAt: string | null;
  /** 是否至少有一个推送通道（没有也不影响 App 内收件箱） */
  hasPushChannel: boolean;
  timezone: string;
  now?: Date;
}

export interface DecisionResult {
  decision: 'skip' | 'delay' | 'send';
  score: number;
  reasonCode: string;
  reasonText: string;
  factors: Record<string, { raw: number; weight: number; weighted: number }>;
  detail: DecisionDetail;
  /** delay 时给出建议的重新评估时间 */
  nextCheckAt: string | null;
}

// ============================================================
// 硬否决项
// ============================================================

interface VetoContext {
  now: Date;
  settings: ProactiveSettings;
  minutesSinceLastChat: number;
  minutesSinceLastProactive: number;
  lastSeenMinutesAgo: number;
  todaySent: number;
  hasPendingTask: boolean;
  hasPushChannel: boolean;
}

function evaluateVetoes(ctx: VetoContext): { code: string; text: string } | null {
  const { settings } = ctx;

  if (!settings.enabled) return { code: 'V1_DISABLED', text: '主動聊天已關閉' };

  const nowMinutes = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  if (isWithinDnd(nowMinutes, settings.dndStart, settings.dndEnd)) {
    return { code: 'V2_DND', text: `現在是免打擾時間（${settings.dndStart}–${settings.dndEnd}）` };
  }

  if (!settings.allowedHours.includes(ctx.now.getHours())) {
    return { code: 'V3_OUT_OF_HOURS', text: '不在允許主動聊天的時段' };
  }

  if (ctx.todaySent >= settings.dailyLimit) {
    return { code: 'V4_DAILY_LIMIT', text: `今日主動消息已達上限（${settings.dailyLimit} 則）` };
  }

  if (
    ctx.minutesSinceLastProactive >= 0 &&
    ctx.minutesSinceLastProactive < settings.minIntervalHours * 60
  ) {
    return { code: 'V5_TOO_SOON', text: '距離上一則主動消息太近' };
  }

  if (ctx.minutesSinceLastChat >= 0 && ctx.minutesSinceLastChat < PROACTIVE_CONFIG.justTalkedMinutes) {
    return { code: 'V6_JUST_TALKED', text: '你們剛聊過，不需要打擾' };
  }

  if (
    ctx.lastSeenMinutesAgo >= 0 &&
    ctx.lastSeenMinutesAgo < PROACTIVE_CONFIG.recentOnlineGuardMinutes
  ) {
    return { code: 'V7_USER_ONLINE', text: '使用者正在線上，不需要推送' };
  }

  if (ctx.hasPendingTask) return { code: 'V8_PENDING_TASK', text: '已有待發送的主動消息' };

  // 完全没有任何触达通道，且用户从未打开过 App → 发了也看不到
  if (!ctx.hasPushChannel && ctx.minutesSinceLastChat < 0) {
    return { code: 'V9_NO_CHANNEL', text: '沒有任何可觸達的通道' };
  }

  // 刚认识就疯狂主动会很打扰：至少先有过一次真实互动
  if (ctx.minutesSinceLastChat < 0) {
    return { code: 'V11_NO_INTERACTION', text: '還沒有任何互動紀錄' };
  }

  return null;
}

// ============================================================
// 七因子打分
// ============================================================

function scoreFactors(input: DecisionInput, ctx: VetoContext) {
  const { character, settings } = input;
  const factors: Record<string, { raw: number; weight: number; weighted: number }> = {};
  const notes: string[] = [];

  const record = (
    key: keyof typeof PROACTIVE_WEIGHTS,
    raw: number,
  ): void => {
    const weight = PROACTIVE_WEIGHTS[key];
    factors[key] = {
      raw: Math.max(0, Math.min(1, Number(raw.toFixed(3)))),
      weight,
      weighted: Number((Math.max(0, Math.min(1, raw)) * weight).toFixed(4)),
    };
  };

  // 1) 空闲时长：越久越想联系，满分为 idleFullScoreHours（默认 24h）
  const idleHours = ctx.minutesSinceLastChat / 60;
  const idle = idleHours / PROACTIVE_CONFIG.idleFullScoreHours;
  record('idleHours', idle);
  notes.push(`已 ${idleHours.toFixed(1)} 小時沒互動`);

  // 2) 用户情绪需求：用户上次情绪越差、越需要陪伴，主动联系的价值越高
  const lastUserEmotion = statesRepo.getLatestUserEmotion(input.userId, character.id);
  let emotionNeed = 0.2;
  if (lastUserEmotion) {
    if (lastUserEmotion.crisisSignal === 'severe') emotionNeed = 1;
    else if (lastUserEmotion.needsComfort) emotionNeed = 0.75;
    else if (lastUserEmotion.valence < -0.15) emotionNeed = 0.6;
    else if (lastUserEmotion.valence > 0.3) emotionNeed = 0.35; // 开心时也值得分享
    notes.push(`上次情緒：${lastUserEmotion.emotion}`);
  }
  record('userEmotionNeed', emotionNeed);

  // 3) 人格主动性：角色本身的 proactivityLevel
  const proactivity = character.proactivityLevel;
  record('personaProactivity', proactivity);
  notes.push(`人格主動性 ${proactivity.toFixed(2)}`);

  // 4) 话题延续：设置允许时，最近聊的话题有"未完待续"的钩子
  let topicContinuation = 0.3;
  if (settings.allowTopicContinuation && ctx.minutesSinceLastChat < 48 * 60) {
    topicContinuation = 0.75; // 48 小时内的话题还算"热的"
    notes.push('最近聊過的話題還有延續性');
  } else {
    notes.push('沒有明顯的話題延續點');
  }
  record('topicContinuation', topicContinuation);

  // 5) 关系阶段：越熟越自然
  const rel = statesRepo.getRelationship(input.userId, character.id);
  const stageIndex = rel ? ['stranger', 'familiar', 'close', 'bonded'].indexOf(rel.stage) : 0;
  record('relationship', 0.2 + stageIndex * 0.27);
  notes.push(`關係階段：${rel?.stage ?? 'stranger'}`);

  // 6) 时段匹配：晚间是陪伴需求最高的时段
  const hour = ctx.now.getHours();
  let timeOfDay = 0.5;
  if (hour >= 19 && hour <= 22) timeOfDay = 1; // 黄金陪伴时段
  else if (hour >= 12 && hour <= 14) timeOfDay = 0.8; // 午休
  else if (hour >= 8 && hour <= 11) timeOfDay = 0.6; // 早晨
  else timeOfDay = 0.35;
  record('timeOfDay', timeOfDay);

  // 7) AI 情绪：AI 处于关心/想念状态时更容易主动
  const aiEmotion = statesRepo.getEmotion(input.userId, character.id);
  let aiDrive = 0.3;
  if (aiEmotion) {
    if (aiEmotion.currentEmotion === 'caring') aiDrive = 0.8;
    else if (aiEmotion.currentEmotion === 'worried') aiDrive = 0.7;
    else if (aiEmotion.currentEmotion === 'happy' || aiEmotion.currentEmotion === 'excited') aiDrive = 0.6;
    else if (aiEmotion.currentEmotion === 'sad' || aiEmotion.currentEmotion === 'down') aiDrive = 0.25;
  }
  record('aiEmotion', aiDrive);

  const score = Object.values(factors).reduce((sum, f) => sum + f.weighted, 0);
  return { factors, score, notes };
}

// ============================================================
// 主入口
// ============================================================

export function decide(input: DecisionInput): DecisionResult {
  const now = input.now ?? new Date();
  const { userId, character, settings } = input;

  const lastSent = proactiveRepo.getLastSentTask(userId, character.id);

  // 关系状态里才有最近互动时间（AICharacter 上不存在该字段）
  const relationship = statesRepo.getRelationship(userId, character.id);

  // 最近 10 条决策里只要还有未完成的，就不再排队新的（防重复发送）
  const recentTasks = proactiveRepo.listTasks(userId, {
    characterId: character.id,
    limit: 10,
  });
  const hasPendingTask = recentTasks.some((t) =>
    ['pending', 'scheduled', 'sending'].includes(t.status),
  );

  const minutesSinceLastChat = relationship?.lastInteractionAt
    ? (now.getTime() - new Date(relationship.lastInteractionAt).getTime()) / 60000
    : -1;

  const minutesSinceLastProactive = lastSent?.createdAt
    ? (now.getTime() - new Date(lastSent.createdAt).getTime()) / 60000
    : -1;

  const lastSeenMinutesAgo = input.lastSeenAt
    ? (now.getTime() - new Date(input.lastSeenAt).getTime()) / 60000
    : -1;

  const todaySent = proactiveRepo.getDailyCount(userId, character.id, dayKey(now, input.timezone));

  const vetoCtx: VetoContext = {
    now,
    settings,
    minutesSinceLastChat,
    minutesSinceLastProactive,
    lastSeenMinutesAgo,
    todaySent,
    hasPendingTask,
    hasPushChannel: input.hasPushChannel,
  };

  // ---- 第一段：硬否决 ----
  const veto = evaluateVetoes(vetoCtx);
  if (veto) {
    return {
      decision: 'skip',
      score: 0,
      reasonCode: veto.code,
      reasonText: veto.text,
      factors: {},
      detail: { factors: {}, vetoHit: veto.code, notes: [] },
      nextCheckAt: null,
    };
  }

  // ---- 第二段：七因子打分 ----
  const { factors, score, notes } = scoreFactors(input, vetoCtx);

  const detail: DecisionDetail = { factors, vetoHit: null, notes };

  if (score < PROACTIVE_CONFIG.thresholds.skip) {
    return {
      decision: 'skip',
      score: Number(score.toFixed(3)),
      reasonCode: 'S_LOW_SCORE',
      reasonText: `綜合評估後覺得現在不太適合打擾（${score.toFixed(2)}）`,
      factors,
      detail,
      nextCheckAt: null,
    };
  }

  if (score < PROACTIVE_CONFIG.thresholds.send) {
    // delay：分数中等，稍后再看看（可能用户马上就回来了）
    const { min, max } = PROACTIVE_CONFIG.delayMinutes;
    const ratio =
      (score - PROACTIVE_CONFIG.thresholds.skip) /
      (PROACTIVE_CONFIG.thresholds.send - PROACTIVE_CONFIG.thresholds.skip);
    const delayMinutes = Math.round(min + (max - min) * (1 - ratio));
    return {
      decision: 'delay',
      score: Number(score.toFixed(3)),
      reasonCode: 'S_DELAY',
      reasonText: `再等一下看看（${delayMinutes} 分鐘後重新評估）`,
      factors,
      detail,
      nextCheckAt: new Date(now.getTime() + delayMinutes * 60000).toISOString(),
    };
  }

  return {
    decision: 'send',
    score: Number(score.toFixed(3)),
    reasonCode: 'S_SEND',
    reasonText: '覺得現在適合主動說點什麼',
    factors,
    detail,
    nextCheckAt: null,
  };
}

/**
 * 供前端「主动聊天决策可视化」使用（需求 §27.2：不做假 UI）。
 * 把完整的因子明细返回，用户能亲眼看到 AI 为什么发 / 为什么没发。
 */
export function explain(input: DecisionInput): ProactiveStatusResponse {
  const result = decide(input);
  return {
    decision: result.decision,
    score: result.score,
    factors: result.factors,
    reasonCode: result.reasonCode,
    reasonText: result.reasonText,
    nextCheckAt: result.nextCheckAt,
    todaySent: proactiveRepo.getDailyCount(
      input.userId,
      input.character.id,
      dayKey(input.now ?? new Date(), input.timezone),
    ),
    dailyLimit: input.settings.dailyLimit,
  };
}
