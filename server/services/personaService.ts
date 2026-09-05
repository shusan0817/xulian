/**
 * 人格服务（需求 §3 / §17）
 *
 * 职责是把「角色创建」这件事收敛成两条清晰路径：
 * - 预设模板（findPreset）：降低首次使用门槛；
 * - 完全自定义（create）：用户可改任何字段。
 *
 * 角色创建时会**同时初始化情绪状态与关系状态**，
 * 因为这两者是「角色存在」的一部分——没有情绪态的角色在第一轮对话里
 * 会退化成默认值，破坏了「角色是活的」这个体验。
 */

import type { AICharacter, User } from '../../shared/types.js';
import type { CreateCharacterInput } from '../../shared/types.js';
import {
  DEFAULT_PRESET_KEY,
  PRESET_CHARACTERS,
  findPreset,
} from '../config/defaults.js';
import * as charactersRepo from '../db/repositories/characters.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import { logger } from '../logger.js';

/** 预设模板列表（给角色创建页展示） */
export function listPresets() {
  return PRESET_CHARACTERS.map((p) => ({
    key: p.key,
    label: p.label,
    intro: p.intro,
    name: p.name,
    avatar: p.avatar,
    personality: p.personality,
    personalityTags: p.personalityTags,
    speakingStyle: p.speakingStyle,
    interests: p.interests,
  }));
}

/** 确保用户存在；不存在则创建（MVP 无登录，前端 localStorage 里的 ID 直接信任） */
export function ensureUser(userId: string, timezone?: string): User {
  const existing = usersRepo.getById(userId);
  if (existing) return existing;
  return usersRepo.adminCreateUser({ id: userId, timezone });
}

/** 创建角色（自定义或基于预设兜底） */
export function createCharacter(userId: string, input: CreateCharacterInput): AICharacter {
  const character = charactersRepo.create(userId, input);

  // 同步初始化情绪态与关系态
  statesRepo.upsertEmotion(userId, character.id, {
    currentEmotion: character.initialEmotion,
    intensity: 0.3,
    emotionReason: '剛認識你',
  });
  statesRepo.upsertRelationship(userId, character.id, {
    stage: character.initialStage,
    interactionLevel: 0,
    floorStage: character.initialStage,
  });

  logger.info('[Persona] 角色已建立', { characterId: character.id, name: character.name });
  return character;
}

/** 用预设模板创建角色 */
export function createFromPreset(userId: string, presetKey: string): AICharacter {
  const preset = findPreset(presetKey) ?? findPreset(DEFAULT_PRESET_KEY);
  if (!preset) {
    throw new Error('[Persona] 預設模板缺失，無法建立角色');
  }
  return createCharacter(userId, {
    name: preset.name,
    avatar: preset.avatar,
    personality: preset.personality,
    personalityTags: [...preset.personalityTags],
    speakingStyle: preset.speakingStyle,
    interests: [...preset.interests],
    likedTopics: [...preset.likedTopics],
    dislikedTopics: [...preset.dislikedTopics],
    relationshipType: preset.relationshipType,
    userNickname: preset.userNickname,
    replyLength: preset.replyLength,
    emotionSensitivity: preset.emotionSensitivity,
    initialEmotion: preset.initialEmotion,
    initialStage: preset.initialStage,
    proactivityLevel: preset.proactivityLevel,
  });
}

/** Bootstrap：首次使用时创建一个默认角色 */
export function bootstrapDefaultCharacter(userId: string): AICharacter {
  const existing = charactersRepo.listByUser(userId);
  if (existing.length) return existing.find((c) => c.isDefault) ?? existing[0]!;

  const character = createFromPreset(userId, DEFAULT_PRESET_KEY);
  charactersRepo.setDefault(userId, character.id);
  return character;
}

export function listCharacters(userId: string): AICharacter[] {
  return charactersRepo.listByUser(userId);
}

export function getCharacter(userId: string, characterId: string): AICharacter | null {
  return charactersRepo.getById(userId, characterId);
}

export function updateCharacter(
  userId: string,
  characterId: string,
  patch: Parameters<typeof charactersRepo.update>[2],
): AICharacter | null {
  return charactersRepo.update(userId, characterId, patch);
}

export function deleteCharacter(userId: string, characterId: string): boolean {
  return charactersRepo.deleteById(userId, characterId);
}

export function setDefaultCharacter(userId: string, characterId: string): AICharacter | null {
  return charactersRepo.setDefault(userId, characterId);
}
