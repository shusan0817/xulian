/**
 * ai_characters 数据访问
 *
 * 所有函数首参为 userId（多用户隔离硬要求）。
 * JSON 列（avatar / 各类数组 / proactive_settings）统一走 `json.ts` 反序列化，
 * 且 `proactiveSettings` **永远返回完整对象**（缺字段用默认值补齐），避免上层到处写 `?? 默认`。
 */

import db from '../index.js';
import { jsonArray, jsonGet } from '../json.js';
import { clamp01, newId, nowIso } from '../helpers.js';
import {
  DEFAULT_AVATAR,
  DEFAULT_LOCALE,
  DEFAULT_PROACTIVE_SETTINGS,
} from '../../config/defaults.js';
import type {
  AvatarSpec,
  AICharacter,
  CreateCharacterInput,
  ProactiveSettings,
  UpdateCharacterInput,
} from '../../../shared/types.js';
import { RELATIONSHIP_TYPES, REPLY_LENGTHS, EMOTION_TYPES, RELATIONSHIP_STAGES, PROACTIVE_DEFAULTS, normalizeChatMode } from '../../../shared/constants.js';

// ============================================================
// 行 → 实体
// ============================================================

/**
 * 把「詳細↔簡短」滑桿 (0..1) 映射成離散的回覆長度。
 * 滑块优先于原有的 replyLength：前端只暴露滑块，repo 负责派生离散字段。
 */
function verbosityToReplyLength(v: number): 'short' | 'medium' | 'long' {
  return v < 0.34 ? 'short' : v < 0.67 ? 'medium' : 'long';
}

export interface CharacterRow {
  id: string;
  user_id: string;
  name: string;
  avatar: string;
  personality: string;
  personality_tags: string;
  speaking_style: string;
  interests: string;
  liked_topics: string;
  disliked_topics: string;
  relationship_type: string;
  user_nickname: string;
  ai_self_name: string;
  reply_length: string;
  emotion_sensitivity: number;
  initial_emotion: string;
  initial_stage: string;
  proactivity_level: number;
  proactive_enabled: number;
  proactive_settings: string;
  slider_playfulness: number;
  slider_humor: number;
  slider_verbosity: number;
  slider_proactivity: number;
  slider_rationality: number;
  slider_listening: number;
  custom_description: string;
  /** V2：聊天模式（迁移 v2 新增列，老库可能为 NULL） */
  chat_mode?: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/** 把数据库行映射成领域对象；所有枚举字段都做一次白名单校验，脏数据不会污染上层 */
export function rowToCharacter(row: CharacterRow): AICharacter {
  const proactiveRaw = jsonGet<Partial<ProactiveSettings>>(
    row.proactive_settings,
    {},
    'ai_characters.proactive_settings',
  );
  const proactiveSettings: ProactiveSettings = {
    enabled: proactiveRaw.enabled ?? DEFAULT_PROACTIVE_SETTINGS.enabled,
    dailyLimit: proactiveRaw.dailyLimit ?? DEFAULT_PROACTIVE_SETTINGS.dailyLimit,
    allowedHours: Array.isArray(proactiveRaw.allowedHours)
      ? proactiveRaw.allowedHours
      : [...DEFAULT_PROACTIVE_SETTINGS.allowedHours],
    dndStart: proactiveRaw.dndStart ?? DEFAULT_PROACTIVE_SETTINGS.dndStart,
    dndEnd: proactiveRaw.dndEnd ?? DEFAULT_PROACTIVE_SETTINGS.dndEnd,
    minIntervalHours: proactiveRaw.minIntervalHours ?? DEFAULT_PROACTIVE_SETTINGS.minIntervalHours,
    allowTopicContinuation:
      proactiveRaw.allowTopicContinuation ?? DEFAULT_PROACTIVE_SETTINGS.allowTopicContinuation,
  };

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    avatar: jsonGet<AvatarSpec>(row.avatar, { ...DEFAULT_AVATAR }, 'ai_characters.avatar'),
    personality: row.personality,
    personalityTags: jsonArray(row.personality_tags, 'ai_characters.personality_tags'),
    speakingStyle: row.speaking_style,
    interests: jsonArray(row.interests, 'ai_characters.interests'),
    likedTopics: jsonArray(row.liked_topics, 'ai_characters.liked_topics'),
    dislikedTopics: jsonArray(row.disliked_topics, 'ai_characters.disliked_topics'),
    relationshipType: (RELATIONSHIP_TYPES as readonly string[]).includes(row.relationship_type)
      ? (row.relationship_type as AICharacter['relationshipType'])
      : 'friend',
    userNickname: row.user_nickname,
    aiSelfName: row.ai_self_name,
    replyLength: (REPLY_LENGTHS as readonly string[]).includes(row.reply_length)
      ? (row.reply_length as AICharacter['replyLength'])
      : 'medium',
    emotionSensitivity: clamp01(row.emotion_sensitivity),
    initialEmotion: (EMOTION_TYPES as readonly string[]).includes(row.initial_emotion)
      ? (row.initial_emotion as AICharacter['initialEmotion'])
      : 'calm',
    initialStage: (RELATIONSHIP_STAGES as readonly string[]).includes(row.initial_stage)
      ? (row.initial_stage as AICharacter['initialStage'])
      : 'stranger',
    proactivityLevel: clamp01(row.proactivity_level),
    proactiveEnabled: row.proactive_enabled === 1,
    proactiveSettings,
    sliderPlayfulness: row.slider_playfulness ?? 0.5,
    sliderHumor: row.slider_humor ?? 0.5,
    sliderVerbosity: row.slider_verbosity ?? 0.5,
    sliderProactivity: row.slider_proactivity ?? 0.5,
    sliderRationality: row.slider_rationality ?? 0.5,
    sliderListening: row.slider_listening ?? 0.5,
    customDescription: row.custom_description ?? '',
    // 脏数据 / 老库 NULL 一律回落 'auto'，绝不让非法值进 Prompt
    chatMode: row.chat_mode ? normalizeChatMode(row.chat_mode) : 'auto',
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================
// 查询
// ============================================================

/** 列出某个用户的全部角色（默认角色排最前，其次按更新时间倒序） */
export function listByUser(userId: string): AICharacter[] {
  const rows = db
    .prepare(
      'SELECT * FROM ai_characters WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC',
    )
    .all(userId) as CharacterRow[];
  return rows.map(rowToCharacter);
}

/** 取单个角色（带上 userId 条件，天然隔离） */
export function getById(userId: string, characterId: string): AICharacter | null {
  const row = db
    .prepare('SELECT * FROM ai_characters WHERE id = ? AND user_id = ?')
    .get(characterId, userId) as CharacterRow | undefined;
  return row ? rowToCharacter(row) : null;
}

/** 取用户的默认角色；没有默认角色时退回最近更新的一个 */
export function getDefault(userId: string): AICharacter | null {
  const row = db
    .prepare(
      'SELECT * FROM ai_characters WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC LIMIT 1',
    )
    .get(userId) as CharacterRow | undefined;
  return row ? rowToCharacter(row) : null;
}

/** 统计角色数量（创建角色时可据此决定是否自动设为默认） */
export function countByUser(userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM ai_characters WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ============================================================
// 写入
// ============================================================

/**
 * 创建角色。
 * 注意：这里只写 ai_characters 表；emotion_states / relationship_states 的初始化
 * 由 PersonaService 负责（Repository 不做跨表业务初始化）。
 */
export function create(userId: string, input: CreateCharacterInput): AICharacter {
  const now = nowIso();
  const id = newId();
  // 第一个角色自动成为默认角色，避免"没有当前角色"的空档
  const shouldBeDefault = input.isDefault ?? countByUser(userId) === 0;

  db.prepare(
    `INSERT INTO ai_characters (
        id, user_id, name, avatar, personality, personality_tags, speaking_style,
        interests, liked_topics, disliked_topics, relationship_type, user_nickname,
        ai_self_name, reply_length, emotion_sensitivity, initial_emotion, initial_stage,
        proactivity_level, proactive_enabled, proactive_settings,
        slider_playfulness, slider_humor, slider_verbosity, slider_proactivity,
        slider_rationality, slider_listening, custom_description,
        is_default,
        created_at, updated_at
     ) VALUES (
        @id, @user_id, @name, @avatar, @personality, @personality_tags, @speaking_style,
        @interests, @liked_topics, @disliked_topics, @relationship_type, @user_nickname,
        @ai_self_name, @reply_length, @emotion_sensitivity, @initial_emotion, @initial_stage,
        @proactivity_level, @proactive_enabled, @proactive_settings,
        @slider_playfulness, @slider_humor, @slider_verbosity, @slider_proactivity,
        @slider_rationality, @slider_listening, @custom_description,
        @is_default,
        @created_at, @updated_at
     )`,
  ).run({
    id,
    user_id: userId,
    name: input.name,
    avatar: JSON.stringify(input.avatar ?? { ...DEFAULT_AVATAR }),
    personality: input.personality ?? '',
    personality_tags: JSON.stringify(input.personalityTags ?? []),
    speaking_style: input.speakingStyle ?? '',
    interests: JSON.stringify(input.interests ?? []),
    liked_topics: JSON.stringify(input.likedTopics ?? []),
    disliked_topics: JSON.stringify(input.dislikedTopics ?? []),
    relationship_type: input.relationshipType ?? 'friend',
    user_nickname: input.userNickname ?? '',
    ai_self_name: input.aiSelfName ?? '',
    // 回覆長度由「詳細↔簡短」滑桿派生；滑桿優先於 replyLength
    reply_length: verbosityToReplyLength(clamp01(input.sliderVerbosity ?? 0.5)),
    emotion_sensitivity: clamp01(input.emotionSensitivity ?? 0.5),
    initial_emotion: input.initialEmotion ?? 'calm',
    initial_stage: input.initialStage ?? 'stranger',
    // 主動程度：滑桿 (sliderProactivity) 優先；未傳滑桿時退回原 proactivityLevel / 預設
    proactivity_level: clamp01(
      input.sliderProactivity ?? input.proactivityLevel ?? PROACTIVE_DEFAULTS.proactivityLevel,
    ),
    proactive_enabled: input.proactiveEnabled ?? true ? 1 : 0,
    proactive_settings: JSON.stringify({
      ...DEFAULT_PROACTIVE_SETTINGS,
      ...(input.proactiveSettings ?? {}),
    }),
    slider_playfulness: clamp01(input.sliderPlayfulness ?? 0.5),
    slider_humor: clamp01(input.sliderHumor ?? 0.5),
    slider_verbosity: clamp01(input.sliderVerbosity ?? 0.5),
    slider_proactivity: clamp01(input.sliderProactivity ?? 0.5),
    slider_rationality: clamp01(input.sliderRationality ?? 0.5),
    slider_listening: clamp01(input.sliderListening ?? 0.5),
    custom_description: input.customDescription ?? '',
    is_default: shouldBeDefault ? 1 : 0,
    created_at: now,
    updated_at: now,
  });

  const created = getById(userId, id);
  if (!created) throw new Error(`[DB] 建立角色後讀不回來：${id}`);
  return created;
}

/** 局部更新：只更新传入的字段，其余保持原样 */
export function update(
  userId: string,
  characterId: string,
  patch: UpdateCharacterInput,
): AICharacter | null {
  const current = getById(userId, characterId);
  if (!current) return null;

  const fields: string[] = [];
  const values: Array<string | number> = [];

  const push = (column: string, value: string | number): void => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.name !== undefined) push('name', patch.name);
  if (patch.avatar !== undefined) push('avatar', JSON.stringify(patch.avatar));
  if (patch.personality !== undefined) push('personality', patch.personality);
  if (patch.personalityTags !== undefined) push('personality_tags', JSON.stringify(patch.personalityTags));
  if (patch.speakingStyle !== undefined) push('speaking_style', patch.speakingStyle);
  if (patch.interests !== undefined) push('interests', JSON.stringify(patch.interests));
  if (patch.likedTopics !== undefined) push('liked_topics', JSON.stringify(patch.likedTopics));
  if (patch.dislikedTopics !== undefined) push('disliked_topics', JSON.stringify(patch.dislikedTopics));
  if (patch.relationshipType !== undefined) push('relationship_type', patch.relationshipType);
  if (patch.userNickname !== undefined) push('user_nickname', patch.userNickname);
  if (patch.aiSelfName !== undefined) push('ai_self_name', patch.aiSelfName);
  if (patch.replyLength !== undefined) push('reply_length', patch.replyLength);
  if (patch.emotionSensitivity !== undefined) {
    push('emotion_sensitivity', clamp01(patch.emotionSensitivity));
  }
  if (patch.initialEmotion !== undefined) push('initial_emotion', patch.initialEmotion);
  if (patch.initialStage !== undefined) push('initial_stage', patch.initialStage);
  if (patch.proactivityLevel !== undefined) {
    push('proactivity_level', clamp01(patch.proactivityLevel));
  }
  if (patch.sliderPlayfulness !== undefined) push('slider_playfulness', clamp01(patch.sliderPlayfulness));
  if (patch.sliderHumor !== undefined) push('slider_humor', clamp01(patch.sliderHumor));
  if (patch.sliderVerbosity !== undefined) {
    const v = clamp01(patch.sliderVerbosity);
    push('slider_verbosity', v);
    push('reply_length', verbosityToReplyLength(v)); // 同步離散字段
  }
  if (patch.sliderProactivity !== undefined) {
    const v = clamp01(patch.sliderProactivity);
    push('slider_proactivity', v);
    push('proactivity_level', v); // 同步離散字段
  }
  if (patch.sliderRationality !== undefined) push('slider_rationality', clamp01(patch.sliderRationality));
  if (patch.sliderListening !== undefined) push('slider_listening', clamp01(patch.sliderListening));
  if (patch.customDescription !== undefined) push('custom_description', patch.customDescription);
  if (patch.proactiveEnabled !== undefined) push('proactive_enabled', patch.proactiveEnabled ? 1 : 0);
  if (patch.proactiveSettings !== undefined) {
    // 合并而不是整体替换：用户可能只想改每日上限
    push(
      'proactive_settings',
      JSON.stringify({
        ...current.proactiveSettings,
        ...patch.proactiveSettings,
        allowedHours: patch.proactiveSettings.allowedHours ?? current.proactiveSettings.allowedHours,
      }),
    );
  }
  if (patch.isDefault !== undefined) push('is_default', patch.isDefault ? 1 : 0);
  if (patch.chatMode !== undefined) push('chat_mode', normalizeChatMode(patch.chatMode));

  if (fields.length === 0) return current;

  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(characterId, userId);

  db.prepare(
    `UPDATE ai_characters SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
  ).run(...values);

  return getById(userId, characterId);
}

/** 设为默认角色（同一用户的其它角色自动取消默认） */
export function setDefault(userId: string, characterId: string): AICharacter | null {
  const target = getById(userId, characterId);
  if (!target) return null;
  const run = db.transaction(() => {
    db.prepare('UPDATE ai_characters SET is_default = 0, updated_at = ? WHERE user_id = ?').run(
      nowIso(),
      userId,
    );
    db.prepare('UPDATE ai_characters SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?').run(
      nowIso(),
      characterId,
      userId,
    );
  });
  run();
  return getById(userId, characterId);
}

/** 复制一个角色（名称加「 的副本」，不复制默认标记） */
export function duplicate(userId: string, characterId: string): AICharacter | null {
  const source = getById(userId, characterId);
  if (!source) return null;
  return create(userId, {
    ...source,
    name: `${source.name} 的副本`,
    isDefault: false,
  });
}

/**
 * 删除角色。
 * 级联由外键（ON DELETE CASCADE）兜住：会话 / 消息 / 记忆 / 情绪 / 关系 / 任务都会一起删掉。
 */
export function deleteById(userId: string, characterId: string): boolean {
  const result = db
    .prepare('DELETE FROM ai_characters WHERE id = ? AND user_id = ?')
    .run(characterId, userId);
  return result.changes > 0;
}
