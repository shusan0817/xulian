/**
 * 前端请求/响应 DTO
 *
 * 与 `server/types.ts` 一一对应；字段名与后端保持一致（后端返回 camelCase）。
 * 这里只描述「前端会用到的字段」，不追求与后端完全同构。
 */

import type {
  EmotionType,
  MemoryCategory,
  RelationshipStage,
  StrategyType,
} from '@shared/constants';
import type {
  AICharacter,
  AvatarSpec,
  CharacterRuntimeSummary,
  Conversation,
  MemoryItem,
  MessageRecord,
  NotificationSettings,
  PrivacySettings,
  ProactiveTask,
  RelationshipState,
  User,
  UserSettings,
} from '@shared/types';
import type { ChatSseEvent } from '@shared/sse';

export type { ChatSseEvent };

// ---- /api/health ----
export interface HealthResponse {
  status: 'ok' | 'degraded';
  time: string;
  version: string;
  aiConfigured: boolean;
  ollamaConfigured: boolean;
  database: boolean;
}

// ---- /api/config ----
export interface AppConfigResponse {
  app: {
    name: string;
    tagline: string;
    version: string;
    aiDisclosure: string;
  };
  emotionMeta: Array<{ emotion: EmotionType; label: string; color: string; icon: string }>;
  strategyMeta: Array<{ strategy: StrategyType; label: string }>;
  relationshipStages: Array<{ stage: RelationshipStage; label: string; threshold: number }>;
  memoryCategories: Array<{ category: MemoryCategory; label: string }>;
  push: { vapidPublicKey: string; enabled: boolean };
  features: { proactive: boolean; memory: boolean; push: boolean };
}

// ---- /api/users/bootstrap ----
export interface BootstrapResponse {
  user: User;
  characters: Array<AICharacter & { runtime: CharacterRuntimeSummary }>;
  defaultCharacterId: string | null;
  /** 是否已设置密码（= 是否已注册）；匿名账号为 false */
  hasPassword: boolean;
  /** 未成年强化保护是否生效 */
  isMinor: boolean;
}

// ---- /api/auth/* （V2 · T02）----

/** 注册 / 登录的响应 */
export interface AuthTokenResponse {
  user: User;
  hasPassword: boolean;
  email: string | null;
  isMinor: boolean;
  token: string;
  expiresAt: string;
  sessionId: string;
}

/** GET /api/auth/me */
export interface AccountInfoResponse {
  user: User;
  hasPassword: boolean;
  email: string | null;
  isMinor: boolean;
  session: {
    id: string;
    issuedAt: string;
    expiresAt: string;
    lastUsedAt: string;
  } | null;
  allowAnonymous: boolean;
}

/** GET /api/auth/status（无需登录） */
export interface AuthStatusResponse {
  allowAnonymous: boolean;
  authenticated: boolean;
  userId: string | null;
}

/** GET /api/auth/sessions */
export interface SessionListResponse {
  items: Array<{
    id: string;
    userAgent: string | null;
    ipPrefix: string | null;
    issuedAt: string;
    expiresAt: string;
    lastUsedAt: string;
    current: boolean;
  }>;
}

export interface BootstrapRequest {
  clientUserId: string;
  timezone?: string;
  locale?: string;
}

// ---- 角色 ----
export interface CharacterListItem extends AICharacter {
  runtime?: CharacterRuntimeSummary;
}

export interface CreateCharacterRequest {
  name: string;
  avatar?: AvatarSpec;
  personality?: string;
  personalityTags?: string[];
  speakingStyle?: string;
  interests?: string[];
  likedTopics?: string[];
  dislikedTopics?: string[];
  relationshipType?: AICharacter['relationshipType'];
  userNickname?: string;
  aiSelfName?: string;
  replyLength?: AICharacter['replyLength'];
  emotionSensitivity?: number;
  initialEmotion?: EmotionType;
  initialStage?: RelationshipStage;
  proactivityLevel?: number;
  proactiveEnabled?: boolean;
}

// ---- 会话与消息 ----
export interface ConversationItem extends Conversation {
  lastMessage?: MessageRecord | null;
}

export interface MessagePage {
  messages: MessageRecord[];
  hasMore: boolean;
}

// ---- 记忆 ----
export interface MemoryListResponse {
  items: MemoryItem[];
  total: number;
}

// ---- 情绪 / 关系 ----
export interface EmotionResponse {
  emotion: {
    currentEmotion: EmotionType;
    intensity: number;
    valence: number;
    arousal: number;
    emotionReason: string;
    updatedAt: string;
  };
}

export interface RelationshipResponse {
  relationship: RelationshipState;
  nextStage: { stage: RelationshipStage | null; delta: number };
}

// ---- 主动聊天 ----
export interface ProactiveStatusResponse {
  decision: 'skip' | 'delay' | 'send';
  score: number;
  factors: Record<string, { raw: number; weight: number; weighted: number }>;
  reasonCode: string;
  reasonText: string;
  nextCheckAt: string | null;
  todaySent: number;
  dailyLimit: number;
}

export interface ProactiveInboxResponse {
  messages: MessageRecord[];
  characters: CharacterListItem[];
}

// ---- 设置 ----
export type SettingsPatch = Partial<UserSettings & NotificationSettings & PrivacySettings>;
