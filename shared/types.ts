/**
 * 「需恋」领域类型（前后端共享）
 *
 * 命名约定：
 * - 数据库里是 snake_case（见 server/db/schema.sql），Repository 负责映射成本文件的 camelCase；
 * - 所有时间字段都是 ISO 8601 **UTC** 字符串；
 * - `shared/` 内不允许出现 any，确需放宽一律用 unknown + 类型守卫。
 */

import type {
  EmotionType,
  FeedbackKind,
  HabitDimension,
  HabitStatus,
  InsightDimension,
  InsightStatus,
  MemoryCategory,
  PersonaCheckStatus,
  RelationshipStage,
  RelationshipType,
  ReplyLength,
  StorySource,
  StoryType,
  StrategyType,
} from './constants';

// ============================================================
// 头像
// ============================================================

export type AvatarKind = 'emoji' | 'preset' | 'gradient';

export interface AvatarSpec {
  kind: AvatarKind;
  /** emoji 字符 / 预设名 / 渐变序号，按 kind 解释 */
  value: string;
  /** CSS background-image（linear-gradient(...)）或纯色 */
  bg: string;
}

// ============================================================
// 用户
// ============================================================

export interface UserSettings {
  /** 主题：light / dark / system */
  theme: 'light' | 'dark' | 'system';
  /** 是否显示 AI 身份说明角标 */
  showAiDisclosure: boolean;
  /** 是否在聊天页显示策略调试信息 */
  debugOverlay: boolean;
}

export interface NotificationSettings {
  pushEnabled: boolean;
  soundEnabled: boolean;
}

export interface PrivacySettings {
  /** 长期记忆总开关（关闭后不再抽取、不再注入） */
  longTermMemoryEnabled: boolean;
  /** 是否保存聊天记录 */
  saveChatHistory: boolean;
  /** 是否允许匿名统计（MVP 恒为 false，仅预留） */
  analyticsEnabled: boolean;
}

export interface User {
  id: string;
  displayName: string;
  avatar: AvatarSpec | null;
  timezone: string;
  locale: string;
  settings: UserSettings;
  notificationSettings: NotificationSettings;
  privacySettings: PrivacySettings;
  lastSeenAt: string | null;
  // ---- V2 新增（T01 迁移加列；设计文档 §2.3）----
  /** 出生日期 YYYY-MM-DD，**选填**；未填时下面的 isMinor 恒为 false */
  birthDate: string | null;
  /**
   * 是否未成年（门槛 < 18 岁）。
   * 注意：未成年保护条款对**所有用户无条件生效**，
   * 不填出生日期只是拿不到额外强化层，**不是降低保护**（L0 通用安全条款永远生效）。
   */
  isMinor: boolean;
  /** 会员方案（V2-12 预留，当前恒为 'free'，不做任何逻辑分支） */
  plan: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// AI 角色
// ============================================================

export interface ProactiveSettings {
  enabled: boolean;
  dailyLimit: number;
  /** 允许主动联系的整点小时，如 [9,10,...,22] 表示 09:00–23:00 */
  allowedHours: number[];
  /** 免打扰开始 HH:mm */
  dndStart: string;
  /** 免打扰结束 HH:mm */
  dndEnd: string;
  /** 两次主动消息的最小间隔（小时） */
  minIntervalHours: number;
  /** 是否允许 AI 根据最近聊天主动开话题 */
  allowTopicContinuation: boolean;
}

export interface AICharacter {
  id: string;
  userId: string;
  name: string;
  avatar: AvatarSpec;
  /** 自由文本性格描述 */
  personality: string;
  /** 预设性格标签，如 ['温柔','慢热','爱吐槽'] */
  personalityTags: string[];
  speakingStyle: string;
  interests: string[];
  likedTopics: string[];
  dislikedTopics: string[];
  relationshipType: RelationshipType;
  /** AI 怎么称呼用户 */
  userNickname: string;
  /** 用户对 AI 的昵称（可空） */
  aiSelfName: string;
  replyLength: ReplyLength;
  /** 0..1，影响情绪转移幅度与衰减速度 */
  emotionSensitivity: number;
  initialEmotion: EmotionType;
  initialStage: RelationshipStage;
  /** 0..1，主动聊天倾向 */
  proactivityLevel: number;
  proactiveEnabled: boolean;
  proactiveSettings: ProactiveSettings;
  /** 性格微調滑桿（0..1，活泼↔安静） */
  sliderPlayfulness?: number;
  /** 性格微調滑桿（0..1，幽默↔認真） */
  sliderHumor?: number;
  /** 性格微調滑桿（0..1，詳細↔簡短）→ 映射到 replyLength */
  sliderVerbosity?: number;
  /** 性格微調滑桿（0..1，主動↔安靜）→ 映射到 proactivityLevel */
  sliderProactivity?: number;
  /** 性格微調滑桿（0..1，理性↔感性） */
  sliderRationality?: number;
  /** 性格微調滑桿（0..1，傾聽↔建議） */
  sliderListening?: number;
  /** 使用者自訂描述（"你希望 TA 是什麼樣的"） */
  customDescription?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 创建角色时的输入（服务端负责补默认值与初始化情绪/关系态） */
export type CreateCharacterInput = Partial<
  Pick<
    AICharacter,
    | 'name'
    | 'avatar'
    | 'personality'
    | 'personalityTags'
    | 'speakingStyle'
    | 'interests'
    | 'likedTopics'
    | 'dislikedTopics'
    | 'relationshipType'
    | 'userNickname'
    | 'aiSelfName'
    | 'replyLength'
    | 'emotionSensitivity'
    | 'initialEmotion'
    | 'initialStage'
    | 'proactivityLevel'
    | 'proactiveEnabled'
    | 'proactiveSettings'
    | 'sliderPlayfulness'
    | 'sliderHumor'
    | 'sliderVerbosity'
    | 'sliderProactivity'
    | 'sliderRationality'
    | 'sliderListening'
    | 'customDescription'
    | 'isDefault'
  >
> & { name: string };

export type UpdateCharacterInput = Partial<Omit<AICharacter, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;

/** 列表接口里附带的运行态摘要，避免前端为每张卡片各发一次请求 */
export interface CharacterRuntimeSummary {
  emotion: EmotionState;
  relationship: RelationshipState;
  /** 最近一条消息预览（可能为空） */
  lastMessagePreview: string;
  lastMessageAt: string | null;
  unreadProactiveCount: number;
}

// ============================================================
// 会话与消息
// ============================================================

export interface Conversation {
  id: string;
  userId: string;
  characterId: string;
  title: string;
  /** 滚动摘要（短期记忆压缩后的产物） */
  summary: string;
  /** 摘要已覆盖到的最后一条 message id */
  summaryUpdatedTo: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageMeta {
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
  /** 本轮引用到的长期记忆 id */
  memoryRefs?: string[];
  /** 命中的安全规则 */
  safetyFlags?: string[];
  /** 用户聊天意图 */
  intent?: string;
}

export type MessageRole = 'user' | 'assistant';

export interface MessageRecord {
  id: string;
  conversationId: string;
  userId: string;
  characterId: string | null;
  role: MessageRole;
  content: string;
  /** assistant 消息生成时的 AI 情绪 */
  aiEmotion: EmotionType | null;
  aiEmotionIntensity: number | null;
  strategy: StrategyType | null;
  userEmotion: EmotionType | null;
  isProactive: boolean;
  isRead: boolean;
  errorCode: string | null;
  meta: MessageMeta;
  createdAt: string;
}

// ============================================================
// 长期记忆
// ============================================================

export interface MemoryItem {
  id: string;
  userId: string;
  characterId: string;
  category: MemoryCategory;
  content: string;
  /** sha1(category + ':' + normalize(content)[0:24])，用于唯一约束 */
  dedupeKey: string;
  /** 0..1 */
  importance: number;
  isSensitive: boolean;
  sourceMessageId: string | null;
  hitCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 情绪
// ============================================================

/** AI 当前情绪状态 */
export interface EmotionState {
  id: string;
  userId: string;
  characterId: string;
  currentEmotion: EmotionType;
  /** 0..1 */
  intensity: number;
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  emotionReason: string;
  lastDecayAt: string | null;
  updatedAt: string;
}

/** 用户情绪分析结果（每一条用户消息对应一条） */
export interface UserEmotionAnalysis {
  id: string;
  userId: string;
  characterId: string;
  conversationId: string;
  messageId: string;
  emotion: EmotionType;
  valence: number;
  intensity: number;
  confidence: number;
  trend: 'improving' | 'stable' | 'worsening';
  intent: string;
  needsComfort: boolean;
  crisisSignal: 'none' | 'mild' | 'severe';
  suggestedStrategy: StrategyType | null;
  /** 0..1 自我表露深度，喂给关系成长 */
  shareDepth: number;
  /** 可解释的判定理由 */
  reasons: string[];
  createdAt: string;
}

// ============================================================
// 关系
// ============================================================

export interface RelationshipState {
  id: string;
  userId: string;
  characterId: string;
  stage: RelationshipStage;
  /** 0..1 综合互动值，只增不减 */
  interactionLevel: number;
  messageScore: number;
  activeDayScore: number;
  memoryScore: number;
  shareDepthScore: number;
  totalUserMessages: number;
  distinctActiveDays: number;
  /** 用户设定的永不下限阶段 */
  floorStage: RelationshipStage;
  lastInteractionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 主动聊天
// ============================================================

export type ProactiveTaskStatus =
  | 'pending'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'expired';

export type ProactiveDecision = 'skip' | 'delay' | 'send';

export interface DecisionDetail {
  /** 每个因子的原始值与加权值，调试面板直接展示 */
  factors: Record<string, { raw: number; weight: number; weighted: number }>;
  vetoHit: string | null;
  notes: string[];
}

export interface ProactiveTask {
  id: string;
  userId: string;
  characterId: string;
  status: ProactiveTaskStatus;
  decision: ProactiveDecision;
  score: number;
  reasonCode: string;
  reasonDetail: DecisionDetail;
  scheduledAt: string | null;
  messageId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 推送
// ============================================================

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

// ============================================================
// 安全
// ============================================================

export type SafetyDirection = 'incoming' | 'outgoing' | 'proactive';
export type SafetyAction = 'blocked' | 'rewritten' | 'flagged' | 'crisis';
export type SafetySeverity = 'info' | 'warn' | 'block';

export interface SafetyLog {
  id: string;
  userId: string | null;
  characterId: string | null;
  direction: SafetyDirection;
  rule: string;
  action: SafetyAction;
  severity: SafetySeverity;
  excerpt: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

// ============================================================
// 认证与会话（V2 · T02）
// ============================================================

/**
 * 认证凭据（user_auth）。
 *
 * ⚠️ 本实体**只在服务端使用**，任何 API 响应都不得包含 `passwordHash`。
 * `server/services/authService.ts` 负责把它裁剪成 `AccountInfo` 后再出网。
 */
export interface UserAuth {
  userId: string;
  email: string;
  /** lower(trim(email))，防大小写重复注册 */
  emailNormalized: string;
  /** 预留：P3 手机号登录，当前恒为 null */
  phone: string | null;
  /** 自描述格式 'scrypt$N$r$p$saltB64$hashB64' */
  passwordHash: string;
  passwordAlgo: string;
  passwordUpdatedAt: string;
  failedAttempts: number;
  /** 暴力破解保护：连续失败 10 次锁 15 分钟 */
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 会话（user_sessions）。
 *
 * 注意：实体里**不含 tokenHash**——DB 只存 sha256(token)，
 * 而读出会话时也没必要把哈希带到上层，避免泄漏风险。
 */
export interface UserSession {
  id: string;
  userId: string;
  userAgent: string | null;
  /** 仅存 IP 前 3 段（脱敏），不存完整 IP */
  ipPrefix: string | null;
  issuedAt: string;
  expiresAt: string;
  /** 滑动续期：活跃则后延，上限 30 天 */
  lastUsedAt: string;
  /** 登出 / 改密码 / 封禁时置位 */
  revokedAt: string | null;
  createdAt: string;
}

// ============================================================
// 我们的故事（V2-2）
// ============================================================

/** 一条故事的溯源证据：来自哪条消息、当时的原话 */
export interface StoryEvidence {
  messageId: string;
  quote: string;
  at: string;
}

export interface Story {
  id: string;
  userId: string;
  characterId: string;
  type: StoryType;
  /** 当前生效标题（用户改过就是用户版） */
  title: string;
  /** 当前生效摘要（≤200 字） */
  summary: string;
  /** 自动生成原文，用户改过后可「还原」 */
  autoTitle: string;
  autoSummary: string;
  isUserEdited: boolean;
  isUserCreated: boolean;
  /** 0..1，超上限时按此归档 */
  importance: number;
  source: StorySource;
  /** ★V2-2「必须可追溯来源」：JSON string[] */
  sourceMessageIds: string[];
  sourceMemoryId: string | null;
  sourceHabitId: string | null;
  /** 故事发生的时刻（≠ 创建时刻） */
  happenedAt: string;
  pinned: boolean;
  /** 软删除（云端同步预留） */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// AI 了解的你（V2-3）
// ============================================================

export interface InsightEvidence {
  messageId: string;
  quote: string;
  at: string;
}

export interface UserInsight {
  id: string;
  userId: string;
  /**
   * ★ 必须是 '' 而不是 NULL 表示「全域偏好」。
   * SQLite 的 UNIQUE(a, NULL) **不去重**，用 NULL 会让全域偏好的唯一约束失效。
   */
  characterScope: string;
  dimension: InsightDimension;
  /** 枚举值（受控）；topic_interest 为短语数组 JSON */
  value: string;
  /** 展示用繁中标签 */
  valueLabel: string;
  /** 0..1，≥0.6 才 active */
  confidence: number;
  /** ≥3 才 active */
  observationCount: number;
  evidence: InsightEvidence[];
  source: 'auto' | 'user' | 'imported';
  isUserEdited: boolean;
  status: InsightStatus;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// AI 后天形成的交流习惯（V2-4）
// ============================================================

export interface HabitEvidence {
  messageId: string;
  quote: string;
  at: string;
}

export interface AiHabit {
  id: string;
  userId: string;
  characterId: string;
  dimension: HabitDimension;
  /** 受控值（枚举 或 已验证短语） */
  value: string;
  valueLabel: string;
  confidence: number;
  observationCount: number;
  /** 连续未复现次数，≥5 自动降级 */
  missCount: number;
  evidence: HabitEvidence[];
  status: HabitStatus;
  /** 用户手动确认 → 直接 active 且不被自动降级 */
  userConfirmed: boolean;
  /** ★ 闸门 C（人格一致性校验）结果 */
  personaCheck: PersonaCheckStatus;
  personaCheckNote: string;
  /** 关联的「AI 学会的交流习惯」故事 */
  storyId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 用户反馈与举报（V2-14）
// ============================================================

export interface MessageFeedback {
  id: string;
  userId: string;
  characterId: string | null;
  conversationId: string | null;
  /**
   * 故意不加外键：消息被删后反馈仍需留存做安全分析。
   * 因此删除用户数据时必须**显式**清理本表，外键级联帮不上忙。
   */
  messageId: string;
  kind: FeedbackKind;
  /** 用户补充文字（kind=report 时必填） */
  reason: string;
  handled: boolean;
  handledAt: string | null;
  handledNote: string;
  createdAt: string;
}

// ============================================================
// 情绪变化趋势日快照（V2-7）
// ============================================================

/**
 * 只存原始聚合值，**不存任何「分数」「指数」「诊断」**。
 * 定性描述在读时由纯函数派生，类型层面就不允许出现百分比字段。
 */
export interface TrendSnapshot {
  id: string;
  userId: string;
  characterId: string;
  /** 用户时区 YYYY-MM-DD */
  day: string;
  /** 「聊天频率变化」 */
  messageCount: number;
  sessionCount: number;
  /** 「最近回复明显变短」 */
  avgUserMsgChars: number;
  /** 「表达积极/消极程度变化」 */
  avgValence: number;
  avgIntensity: number;
  negativeRatio: number;
  /** 「语气发生变化」 */
  dominantEmotion: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 类型守卫（服务端解析未知输入时使用）
// ============================================================

/** 把 unknown 安全转成 string；非字符串一律返回空串而不是抛错 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 判断 unknown 是否是非 null 的对象（用于逐字段校验请求体） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断 unknown 是否是字符串数组（且所有元素都是字符串） */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
