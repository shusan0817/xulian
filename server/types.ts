/**
 * 服务端内部类型（Service 输入 / 路由 DTO）
 *
 * 与 shared/types.ts 的分工：
 * - `shared/types.ts` = 领域实体（前后端共用，直接对应数据库行）；
 * - `server/types.ts` = 服务端专属的服务入参、接口响应、运行期上下文。
 * 前端对应的请求/响应类型放 `src/types/api.ts`。
 */

import type {
  AICharacter,
  CharacterRuntimeSummary,
  Conversation,
  MemoryItem,
  MessageRecord,
  ProactiveTask,
  RelationshipState,
  User,
} from '../shared/types.js';
import type {
  EmotionType,
  MemoryCategory,
  RelationshipStage,
  StrategyType,
  ChatMode,
} from '../shared/constants.js';
import type { HabitPromptItem } from './agent/prompts.js';

// ============================================================
// 运行期上下文
// ============================================================

/** 一次请求的最小上下文：谁 + 哪个角色 */
export interface ServiceContext {
  userId: string;
  characterId: string;
}

/** 组装 Prompt 所需的全部上下文（T05 的 ChatService 会填满它） */
export interface ChatContext {
  userId: string;
  character: AICharacter;
  conversation: Conversation;
  /** 本轮用户消息原文 */
  userText: string;
  /** 短期上下文（滚动摘要 + 最近 N 条） */
  shortTerm: { summary: string; recent: MessageRecord[] };
  /** 检索到的长期记忆 */
  memories: MemoryItem[];
  emotion: {
    currentEmotion: EmotionType;
    intensity: number;
    valence: number;
    arousal: number;
    emotionReason: string;
  };
  userEmotion: {
    emotion: EmotionType;
    intensity: number;
    trend: 'improving' | 'stable' | 'worsening';
    intent: string;
    needsComfort: boolean;
    crisisSignal: 'none' | 'mild' | 'severe';
    shareDepth: number;
    reasons: string[];
  };
  /** 用户情绪分析里的近期趋势提示（定性文案，无分数）；由 emotionTrendService 提供 */
  trendHint?: string;
  /** 供 L5 引用的故事（≤3 条生效）；由 stories 服务提供 */
  stories?: Array<{ id: string; title: string }>;
  relationship: RelationshipState;
  strategy: StrategyType;

  // ---- V2：聊天模式（设计 §4） ----
  /** 本轮生效的聊天模式；auto = AI 自选。默认 'auto' 以保持向后兼容 */
  chatMode?: ChatMode;
  /**
   * 模式来源：
   * - user   = 用户主动选定（优先级链第 3 级）
   * - ai     = auto 模式下的 AI 自选（第 4 级）
   * - system = 危机 / 安全拦截接管（第 1、2 级，不可被用户覆盖）
   */
  modeSource?: 'user' | 'ai' | 'system';
  /** 同一模式连用到上限 → 只在 L7 追加「换個說法」，不切走模式 */
  needsVariation?: boolean;
  /** L1b：已 active 的后天习惯（核心人格与后天习惯隔离） */
  habits?: HabitPromptItem[];
  /** 未成年用户（L0b 未成年保护段） */
  isMinor?: boolean;
}

// ============================================================
// 接口响应 DTO
// ============================================================

export interface HealthResponse {
  status: 'ok' | 'degraded';
  time: string;
  version: string;
  aiConfigured: boolean;
  /** Ollama 是否已配置（baseUrl + model 同时存在） */
  ollamaConfigured: boolean;
  database: boolean;
}

export interface AppMeta {
  name: string;
  tagline: string;
  version: string;
  /** AI 身份诚实披露文案（设置页 About 直接展示） */
  aiDisclosure: string;
}

export interface ConfigResponse {
  app: AppMeta;
  emotionMeta: Array<{
    emotion: EmotionType;
    label: string;
    color: string;
    icon: string;
  }>;
  strategyMeta: Array<{ strategy: StrategyType; label: string }>;
  relationshipStages: Array<{
    stage: RelationshipStage;
    label: string;
    threshold: number;
  }>;
  memoryCategories: Array<{ category: MemoryCategory; label: string }>;
  push: { vapidPublicKey: string; enabled: boolean };
  features: { proactive: boolean; memory: boolean; push: boolean };
}

export interface BootstrapResponse {
  user: User;
  characters: Array<AICharacter & { runtime: CharacterRuntimeSummary }>;
  defaultCharacterId: string | null;
  /** 该账号是否已设置密码（= 是否已注册）；匿名账号为 false */
  hasPassword: boolean;
  /** 未成年强化保护是否生效 */
  isMinor: boolean;
}

export interface MessagePage {
  messages: MessageRecord[];
  hasMore: boolean;
}

// ============================================================
// 认证与会话 DTO（V2 · T02）
// ============================================================

/** 注册 / 登录的响应（含一次性下发的 token） */
export interface AuthTokenResponse {
  user: User;
  hasPassword: boolean;
  email: string | null;
  isMinor: boolean;
  token: string;
  expiresAt: string;
  sessionId: string;
}

/** GET /api/auth/me 的响应 */
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
  /** 该服务器是否允许匿名访问（前端路由守卫据此决定要不要跳登录页） */
  allowAnonymous: boolean;
}

/** GET /api/auth/status 的响应（无需登录） */
export interface AuthStatusResponse {
  allowAnonymous: boolean;
  authenticated: boolean;
  userId: string | null;
}

/** GET /api/auth/sessions 的响应 */
export interface SessionListResponse {
  items: Array<{
    id: string;
    userAgent: string | null;
    ipPrefix: string | null;
    issuedAt: string;
    expiresAt: string;
    lastUsedAt: string;
    /** 是否是当前这次请求所用的会话 */
    current: boolean;
  }>;
}

export interface DeleteDataResult {
  deleted: {
    messages: number;
    memories: number;
    conversations: number;
    characters: number;
    tasks: number;
  };
}

export interface ProactiveStatusResponse {
  decision: 'skip' | 'delay' | 'send';
  score: number;
  factors: Record<string, { raw: number; weight: number; weighted: number }>;
  reasonCode: string;
  /** 给人看的解释，如「現在是免打擾時間」 */
  reasonText: string;
  nextCheckAt: string | null;
  todaySent: number;
  dailyLimit: number;
}

export interface ProactiveTaskListItem extends ProactiveTask {
  characterName: string;
}

// ============================================================
// Service 层入参
// ============================================================

export interface ChatStreamInput {
  userId: string;
  characterId: string;
  conversationId?: string;
  text: string;
  clientMessageId?: string;
  /**
   * 本轮聊天模式。不传时回落到角色身上的持久设置（ai_characters.chat_mode），
   * 再没有则 'auto'。非法值一律按 'auto' 处理。
   */
  chatMode?: ChatMode;
}

export interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  /** 点击通知后打开的站内路径，如 /chat?c=xxx&m=yyy */
  url: string;
  tag: string;
}
