/**
 * emotion_states / user_emotion_analyses / relationship_states / active_days 数据访问
 *
 * 这三张表都是「每 (user, character) 一条」的状态表，全部用 UPSERT 写入，
 * 避免"先查再决定 insert 还是 update"的竞态。
 */

import db from '../index.js';
import { jsonArray } from '../json.js';
import { clamp01, newId, nowIso } from '../helpers.js';
import { FALLBACK_EMOTION } from '../../config/defaults.js';
import type { EmotionType, RelationshipStage, StrategyType } from '../../../shared/constants.js';
import { EMOTION_ANCHORS } from '../../../shared/constants.js';
import type { EmotionState, RelationshipState, UserEmotionAnalysis } from '../../../shared/types.js';

// ============================================================
// 6. AI 情绪状态
// ============================================================

export interface EmotionRow {
  id: string;
  user_id: string;
  character_id: string;
  current_emotion: string;
  intensity: number;
  valence: number;
  arousal: number;
  emotion_reason: string;
  last_decay_at: string | null;
  updated_at: string;
}

export function rowToEmotion(row: EmotionRow): EmotionState {
  const emotion = (Object.prototype.hasOwnProperty.call(EMOTION_ANCHORS, row.current_emotion)
    ? row.current_emotion
    : FALLBACK_EMOTION.emotion) as EmotionType;
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    currentEmotion: emotion,
    intensity: clamp01(row.intensity),
    valence: row.valence,
    arousal: row.arousal,
    emotionReason: row.emotion_reason,
    lastDecayAt: row.last_decay_at,
    updatedAt: row.updated_at,
  };
}

/** 读取情绪状态（未初始化时返回 null，由 Service 决定如何初始化） */
export function getEmotion(userId: string, characterId: string): EmotionState | null {
  const row = db
    .prepare('SELECT * FROM emotion_states WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as EmotionRow | undefined;
  return row ? rowToEmotion(row) : null;
}

export interface UpsertEmotionInput {
  currentEmotion: EmotionType;
  intensity: number;
  valence?: number;
  arousal?: number;
  emotionReason?: string;
  lastDecayAt?: string | null;
}

/**
 * 写入/更新情绪状态。
 * valence / arousal 未显式传入时，用情绪锚点表里的值（保证三元组始终自洽）。
 */
export function upsertEmotion(
  userId: string,
  characterId: string,
  input: UpsertEmotionInput,
): EmotionState {
  const now = nowIso();
  const anchor = EMOTION_ANCHORS[input.currentEmotion] ?? EMOTION_ANCHORS[FALLBACK_EMOTION.emotion];

  db.prepare(
    `INSERT INTO emotion_states (id, user_id, character_id, current_emotion, intensity,
                                 valence, arousal, emotion_reason, last_decay_at, updated_at)
     VALUES (@id, @user_id, @character_id, @current_emotion, @intensity,
             @valence, @arousal, @emotion_reason, @last_decay_at, @updated_at)
     ON CONFLICT (user_id, character_id) DO UPDATE SET
        current_emotion = excluded.current_emotion,
        intensity       = excluded.intensity,
        valence         = excluded.valence,
        arousal         = excluded.arousal,
        emotion_reason  = excluded.emotion_reason,
        last_decay_at   = excluded.last_decay_at,
        updated_at      = excluded.updated_at`,
  ).run({
    id: newId(),
    user_id: userId,
    character_id: characterId,
    current_emotion: input.currentEmotion,
    intensity: clamp01(input.intensity),
    valence: input.valence ?? anchor.valence,
    arousal: input.arousal ?? anchor.arousal,
    emotion_reason: input.emotionReason ?? '',
    last_decay_at: input.lastDecayAt ?? now,
    updated_at: now,
  });

  const updated = getEmotion(userId, characterId);
  if (!updated) throw new Error(`[DB] 寫入情緒狀態後讀不回來：${userId}/${characterId}`);
  return updated;
}

// ============================================================
// 7. 用户情绪分析
// ============================================================

export interface UserEmotionRow {
  id: string;
  user_id: string;
  character_id: string;
  conversation_id: string;
  message_id: string;
  emotion: string;
  valence: number;
  intensity: number;
  confidence: number;
  trend: string;
  intent: string;
  needs_comfort: number;
  crisis_signal: string;
  suggested_strategy: string | null;
  share_depth: number;
  reasons: string;
  created_at: string;
}

export function rowToUserEmotion(row: UserEmotionRow): UserEmotionAnalysis {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    emotion: row.emotion as EmotionType,
    valence: row.valence,
    intensity: clamp01(row.intensity),
    confidence: clamp01(row.confidence),
    trend: (['improving', 'stable', 'worsening'] as const).includes(
      row.trend as 'improving' | 'stable' | 'worsening',
    )
      ? (row.trend as UserEmotionAnalysis['trend'])
      : 'stable',
    intent: row.intent,
    needsComfort: row.needs_comfort === 1,
    crisisSignal: (['none', 'mild', 'severe'] as const).includes(
      row.crisis_signal as 'none' | 'mild' | 'severe',
    )
      ? (row.crisis_signal as UserEmotionAnalysis['crisisSignal'])
      : 'none',
    suggestedStrategy: row.suggested_strategy as StrategyType | null,
    shareDepth: clamp01(row.share_depth),
    reasons: jsonArray(row.reasons, 'user_emotion_analyses.reasons'),
    createdAt: row.created_at,
  };
}

export interface InsertUserEmotionInput {
  characterId: string;
  conversationId: string;
  messageId: string;
  emotion: EmotionType;
  valence?: number;
  intensity?: number;
  confidence?: number;
  trend?: UserEmotionAnalysis['trend'];
  intent?: string;
  needsComfort?: boolean;
  crisisSignal?: UserEmotionAnalysis['crisisSignal'];
  suggestedStrategy?: StrategyType | null;
  shareDepth?: number;
  reasons?: string[];
}

/** 每条用户消息对应一条分析记录（MessageId 上无唯一约束，允许重新生成时追加） */
export function insertUserEmotion(
  userId: string,
  input: InsertUserEmotionInput,
): UserEmotionAnalysis {
  const id = newId();
  const createdAt = nowIso();
  const anchor = EMOTION_ANCHORS[input.emotion] ?? EMOTION_ANCHORS[FALLBACK_EMOTION.emotion];

  db.prepare(
    `INSERT INTO user_emotion_analyses (id, user_id, character_id, conversation_id, message_id,
                                        emotion, valence, intensity, confidence, trend, intent,
                                        needs_comfort, crisis_signal, suggested_strategy,
                                        share_depth, reasons, created_at)
     VALUES (@id, @user_id, @character_id, @conversation_id, @message_id,
             @emotion, @valence, @intensity, @confidence, @trend, @intent,
             @needs_comfort, @crisis_signal, @suggested_strategy,
             @share_depth, @reasons, @created_at)`,
  ).run({
    id,
    user_id: userId,
    character_id: input.characterId,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    emotion: input.emotion,
    valence: input.valence ?? anchor.valence,
    intensity: clamp01(input.intensity ?? 0.5),
    confidence: clamp01(input.confidence ?? 0.6),
    trend: input.trend ?? 'stable',
    intent: input.intent ?? 'chitchat',
    needs_comfort: input.needsComfort ? 1 : 0,
    crisis_signal: input.crisisSignal ?? 'none',
    suggested_strategy: input.suggestedStrategy ?? null,
    share_depth: clamp01(input.shareDepth ?? 0),
    reasons: JSON.stringify(input.reasons ?? []),
    created_at: createdAt,
  });

  return {
    id,
    userId,
    characterId: input.characterId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    emotion: input.emotion,
    valence: input.valence ?? anchor.valence,
    intensity: clamp01(input.intensity ?? 0.5),
    confidence: clamp01(input.confidence ?? 0.6),
    trend: input.trend ?? 'stable',
    intent: input.intent ?? 'chitchat',
    needsComfort: Boolean(input.needsComfort),
    crisisSignal: input.crisisSignal ?? 'none',
    suggestedStrategy: input.suggestedStrategy ?? null,
    shareDepth: clamp01(input.shareDepth ?? 0),
    reasons: input.reasons ?? [],
    createdAt,
  };
}

/** 取最近一条用户情绪分析（主动决策与 trend 判断用） */
export function getLatestUserEmotion(
  userId: string,
  characterId: string,
): UserEmotionAnalysis | null {
  const row = db
    .prepare(
      'SELECT * FROM user_emotion_analyses WHERE user_id = ? AND character_id = ? ' +
        'ORDER BY created_at DESC LIMIT 1',
    )
    .get(userId, characterId) as UserEmotionRow | undefined;
  return row ? rowToUserEmotion(row) : null;
}

/**
 * 取最近 N 条分析（**正序**返回）。
 * trend 检测需要"连续 N 条"的时间顺序，所以倒序取完再反转。
 */
export function listRecentUserEmotions(
  userId: string,
  characterId: string,
  limit = 5,
): UserEmotionAnalysis[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM user_emotion_analyses WHERE user_id = ? AND character_id = ?
         ORDER BY created_at DESC LIMIT ?
       ) ORDER BY created_at ASC`,
    )
    .all(userId, characterId, Math.min(Math.max(limit, 1), 50)) as UserEmotionRow[];
  return rows.map(rowToUserEmotion);
}

// ============================================================
// 8. 关系状态
// ============================================================

export interface RelationshipRow {
  id: string;
  user_id: string;
  character_id: string;
  stage: string;
  interaction_level: number;
  message_score: number;
  active_day_score: number;
  memory_score: number;
  share_depth_score: number;
  total_user_messages: number;
  distinct_active_days: number;
  floor_stage: string;
  last_interaction_at: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_STAGES: readonly string[] = ['stranger', 'familiar', 'close', 'bonded'];

function toStage(raw: string, fallback: RelationshipStage = 'stranger'): RelationshipStage {
  return (VALID_STAGES.includes(raw) ? raw : fallback) as RelationshipStage;
}

export function rowToRelationship(row: RelationshipRow): RelationshipState {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    stage: toStage(row.stage),
    interactionLevel: clamp01(row.interaction_level),
    messageScore: clamp01(row.message_score),
    activeDayScore: clamp01(row.active_day_score),
    memoryScore: clamp01(row.memory_score),
    shareDepthScore: clamp01(row.share_depth_score),
    totalUserMessages: row.total_user_messages,
    distinctActiveDays: row.distinct_active_days,
    floorStage: toStage(row.floor_stage),
    lastInteractionAt: row.last_interaction_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 读取关系状态 */
export function getRelationship(userId: string, characterId: string): RelationshipState | null {
  const row = db
    .prepare('SELECT * FROM relationship_states WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as RelationshipRow | undefined;
  return row ? rowToRelationship(row) : null;
}

export interface UpsertRelationshipInput {
  stage?: RelationshipStage;
  interactionLevel?: number;
  messageScore?: number;
  activeDayScore?: number;
  memoryScore?: number;
  shareDepthScore?: number;
  totalUserMessages?: number;
  distinctActiveDays?: number;
  floorStage?: RelationshipStage;
  lastInteractionAt?: string;
}

/**
 * 写入/更新关系状态。
 * 只更新显式传入的字段：关系成长是「多个分量分别累积」的，
 * 一次性覆盖全部字段很容易把某个分量打回 0（违反"只增不减"）。
 */
export function upsertRelationship(
  userId: string,
  characterId: string,
  input: UpsertRelationshipInput,
): RelationshipState {
  const now = nowIso();
  const current = getRelationship(userId, characterId);

  db.prepare(
    `INSERT INTO relationship_states (id, user_id, character_id, stage, interaction_level,
                                      message_score, active_day_score, memory_score,
                                      share_depth_score, total_user_messages,
                                      distinct_active_days, floor_stage, last_interaction_at,
                                      created_at, updated_at)
     VALUES (@id, @user_id, @character_id, @stage, @interaction_level,
             @message_score, @active_day_score, @memory_score,
             @share_depth_score, @total_user_messages,
             @distinct_active_days, @floor_stage, @last_interaction_at,
             @created_at, @updated_at)
     ON CONFLICT (user_id, character_id) DO UPDATE SET
        stage                = excluded.stage,
        interaction_level    = excluded.interaction_level,
        message_score        = excluded.message_score,
        active_day_score     = excluded.active_day_score,
        memory_score         = excluded.memory_score,
        share_depth_score    = excluded.share_depth_score,
        total_user_messages  = excluded.total_user_messages,
        distinct_active_days = excluded.distinct_active_days,
        floor_stage          = excluded.floor_stage,
        last_interaction_at  = COALESCE(excluded.last_interaction_at, relationship_states.last_interaction_at),
        updated_at           = excluded.updated_at`,
  ).run({
    id: newId(),
    user_id: userId,
    character_id: characterId,
    stage: input.stage ?? current?.stage ?? 'stranger',
    interaction_level: clamp01(input.interactionLevel ?? current?.interactionLevel ?? 0),
    message_score: clamp01(input.messageScore ?? current?.messageScore ?? 0),
    active_day_score: clamp01(input.activeDayScore ?? current?.activeDayScore ?? 0),
    memory_score: clamp01(input.memoryScore ?? current?.memoryScore ?? 0),
    share_depth_score: clamp01(input.shareDepthScore ?? current?.shareDepthScore ?? 0),
    total_user_messages: Math.max(0, Math.trunc(input.totalUserMessages ?? current?.totalUserMessages ?? 0)),
    distinct_active_days: Math.max(0, Math.trunc(input.distinctActiveDays ?? current?.distinctActiveDays ?? 0)),
    floor_stage: input.floorStage ?? current?.floorStage ?? 'stranger',
    last_interaction_at: input.lastInteractionAt ?? current?.lastInteractionAt ?? now,
    created_at: now,
    updated_at: now,
  });

  const updated = getRelationship(userId, characterId);
  if (!updated) throw new Error(`[DB] 寫入關係狀態後讀不回來：${userId}/${characterId}`);
  return updated;
}
