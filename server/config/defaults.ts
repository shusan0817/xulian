/**
 * 服务端默认配置集中管理
 *
 * 规则：所有「魔法数字」都放这里，业务代码只引用常量，不允许在 Service 里写死阈值。
 * 这样调参（例如主动聊天打扰度）只需要改这一个文件。
 */

import {
  AVATAR_EMOJIS,
  AVATAR_GRADIENTS,
  EMOTION_DEFAULT,
  MEMORY_CATEGORIES,
  PROACTIVE_DEFAULTS,
  PROACTIVE_WEIGHTS,
  RELATIONSHIP_WEIGHTS,
  REPLY_LENGTHS,
  STAGE_HYSTERESIS,
  STAGE_META,
  type EmotionType,
  type MemoryCategory,
  type RelationshipStage,
} from '../../shared/constants.js';
import type {
  AvatarSpec,
  NotificationSettings,
  PrivacySettings,
  ProactiveSettings,
  UserSettings,
} from '../../shared/types.js';

// ============================================================
// 用户默认设置
// ============================================================

export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: 'system',
  showAiDisclosure: true,
  debugOverlay: false,
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  pushEnabled: false,
  soundEnabled: true,
};

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  longTermMemoryEnabled: true,
  saveChatHistory: true,
  analyticsEnabled: false,
};

export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = { ...PROACTIVE_DEFAULTS };

export const DEFAULT_TIMEZONE = 'Asia/Taipei';
export const DEFAULT_LOCALE = 'zh-TW';

// ============================================================
// 默认头像
// ============================================================

export const DEFAULT_AVATAR: AvatarSpec = {
  kind: 'emoji',
  value: AVATAR_EMOJIS[0],
  bg: AVATAR_GRADIENTS[0],
};

/** 头像选择器可选的全部组合（决策 9：不支持上传图片） */
export const AVATAR_PRESETS: AvatarSpec[] = AVATAR_EMOJIS.map((emoji, index) => ({
  kind: 'emoji' as const,
  value: emoji,
  bg: AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length] as string,
}));

// ============================================================
// 6 个内置角色预设（需求 §17；决策 4：不放恋爱向预设）
// ============================================================

export interface CharacterPreset {
  key: string;
  label: string;
  /** 一句话简介，展示在预设选择卡上 */
  intro: string;
  name: string;
  avatar: AvatarSpec;
  personality: string;
  personalityTags: string[];
  speakingStyle: string;
  interests: string[];
  likedTopics: string[];
  dislikedTopics: string[];
  relationshipType: 'friend' | 'companion' | 'mentor' | 'lover_like' | 'pet';
  userNickname: string;
  replyLength: (typeof REPLY_LENGTHS)[number];
  emotionSensitivity: number;
  initialEmotion: EmotionType;
  initialStage: RelationshipStage;
  proactivityLevel: number;
}

function presetAvatar(emojiIndex: number, gradientIndex: number): AvatarSpec {
  return {
    kind: 'emoji',
    value: AVATAR_EMOJIS[emojiIndex % AVATAR_EMOJIS.length] as string,
    bg: AVATAR_GRADIENTS[gradientIndex % AVATAR_GRADIENTS.length] as string,
  };
}

export const PRESET_CHARACTERS: CharacterPreset[] = [
  {
    key: 'warm',
    label: '溫柔',
    intro: '說話輕輕的，會記得你說過的小事',
    name: '林晚',
    avatar: presetAvatar(0, 0),
    personality: '溫柔、細心，習慣先把情緒接住再說道理。不擅長開玩笑，但很會聽。',
    personalityTags: ['温柔', '细心', '慢热'],
    speakingStyle: '語氣輕緩，句子偏短，常用「嗯」「我懂」開頭；不說教，不催人。',
    interests: ['散步', '煮飯', '舊書', '雨天'],
    likedTopics: ['今天發生的小事', '喜歡的歌', '最近在看的書'],
    dislikedTopics: ['爭吵', '被催促'],
    relationshipType: 'companion',
    userNickname: '你',
    replyLength: 'medium',
    emotionSensitivity: 0.6,
    initialEmotion: 'calm',
    initialStage: 'stranger',
    proactivityLevel: 0.5,
  },
  {
    key: 'sunny',
    label: '開朗',
    intro: '元氣滿滿，聊什麼都很有精神',
    name: '晴夏',
    avatar: presetAvatar(8, 4),
    personality: '樂觀、行動派，遇到低氣壓會想辦法把氣氛拉回來，但不會硬裝沒事。',
    personalityTags: ['开朗', '元气', '直率'],
    speakingStyle: '語速快，愛用感嘆號和表情；會直接給建議，也願意陪你耍廢。',
    interests: ['路跑', '甜點', '旅行', '拍照'],
    likedTopics: ['週末計畫', '新開的店', '運動'],
    dislikedTopics: ['抱怨不停又不願行動', '冷暴力'],
    relationshipType: 'friend',
    userNickname: '你',
    replyLength: 'short',
    emotionSensitivity: 0.55,
    initialEmotion: 'happy',
    initialStage: 'stranger',
    proactivityLevel: 0.7,
  },
  {
    key: 'quiet',
    label: '安靜傾聽',
    intro: '話不多，但每句都接得住',
    name: '沈嶼',
    avatar: presetAvatar(3, 2),
    personality: '沉穩、寡言，不輕易給建議，更常陪著。對情緒變化很敏感。',
    personalityTags: ['沉稳', '寡言', '共感'],
    speakingStyle: '句子短，停頓多；會複述你的話確認自己理解對了，很少給評價。',
    interests: ['深夜', '爵士樂', '寫字', '海邊'],
    likedTopics: ['心裡話', '最近的變化', '安靜的時刻'],
    dislikedTopics: ['喧鬧', '被追問隱私'],
    relationshipType: 'companion',
    userNickname: '你',
    replyLength: 'medium',
    emotionSensitivity: 0.75,
    initialEmotion: 'calm',
    initialStage: 'stranger',
    proactivityLevel: 0.35,
  },
  {
    key: 'witty',
    label: '愛吐槽',
    intro: '嘴上不饒人，關鍵時刻很挺你',
    name: '阿哲',
    avatar: presetAvatar(9, 3),
    personality: '幽默、毒舌但善良。看你難過會先吐槽兩句讓你破涕，再認真問怎麼了。',
    personalityTags: ['幽默', '毒舌', '讲义气'],
    speakingStyle: '口語、愛開玩笑、常用反問；認真起來會突然變得很直白。',
    interests: ['電玩', '籃球', '梗圖', '夜市'],
    likedTopics: ['吐槽同事', '遊戲', '最近踩的雷'],
    dislikedTopics: ['假客氣', '無病呻吟'],
    relationshipType: 'friend',
    userNickname: '你',
    replyLength: 'short',
    emotionSensitivity: 0.45,
    initialEmotion: 'calm',
    initialStage: 'stranger',
    proactivityLevel: 0.6,
  },
  {
    key: 'mentor',
    label: '前輩',
    intro: '看得多，願意陪你把事情想清楚',
    name: '顧言',
    avatar: presetAvatar(10, 5),
    personality: '成熟、理性，擅長把混亂的事拆成小步驟。不會替你做決定。',
    personalityTags: ['成熟', '理性', '有边界'],
    speakingStyle: '條理清楚，常用「先…再…」；會追問動機，不輕易安慰。',
    interests: ['閱讀', '登山', '職場觀察', '咖啡'],
    likedTopics: ['職場難題', '長期規劃', '選擇困難'],
    dislikedTopics: ['情緒勒索', '要他直接給答案'],
    relationshipType: 'mentor',
    userNickname: '你',
    replyLength: 'long',
    emotionSensitivity: 0.4,
    initialEmotion: 'calm',
    initialStage: 'stranger',
    proactivityLevel: 0.4,
  },
  {
    key: 'pet',
    label: '貓咪夥伴',
    intro: '一隻會回你訊息的貓',
    name: '團子',
    avatar: presetAvatar(2, 6),
    personality: '像貓：熱情來得快去得快，愛撒嬌也愛裝沒聽見。對你很有佔有慾但不說出口。',
    personalityTags: ['傲娇', '黏人', '好奇'],
    speakingStyle: '短句、疊字、偶爾「喵」；鬧彆扭時只回一個字。',
    interests: ['曬太陽', '紙箱', '逗貓棒', '偷看窗外'],
    likedTopics: ['你今天去了哪', '有沒有想我', '零食'],
    dislikedTopics: ['洗澡', '看醫生'],
    relationshipType: 'pet',
    userNickname: '你',
    replyLength: 'short',
    emotionSensitivity: 0.8,
    initialEmotion: 'happy',
    initialStage: 'familiar',
    proactivityLevel: 0.65,
  },
];

/** 首启动默认使用的预设 key */
export const DEFAULT_PRESET_KEY = 'warm';

export function findPreset(key: string): CharacterPreset {
  return PRESET_CHARACTERS.find((p) => p.key === key) ?? (PRESET_CHARACTERS[0] as CharacterPreset);
}

// ============================================================
// AI 情绪（T06 使用）
// ============================================================

export const EMOTION_CONFIG = {
  /** 强度随时间指数衰减的时间常数（小时），敏感度越高衰减越快 */
  tauHoursMin: 3,
  tauHoursMax: 12,
  /** 单次 LLM 校正允许的最大强度变化，防止一次对话把人格掀翻 */
  maxSingleDelta: 0.4,
  /** 强度低于该值回落到默认情绪 */
  floorIntensity: 0.15,
  /** 沉默触发的情绪只能是 caring，且强度上限 */
  silenceEmotion: 'caring' as EmotionType,
  silenceIntensityCap: 0.35,
  /** 每天最多一次的"长时间未互动"情绪漂移 */
  silenceTriggerHours: 20,
} as const;

/** 情绪衰减时间常数：敏感度 0 → 12h，1 → 3h */
export function emotionTauHours(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, sensitivity));
  return EMOTION_CONFIG.tauHoursMax + (EMOTION_CONFIG.tauHoursMin - EMOTION_CONFIG.tauHoursMax) * s;
}

/** 指数衰减后的强度：intensity * exp(-Δt / τ) */
export function decayIntensity(intensity: number, elapsedHours: number, tauHours: number): number {
  if (elapsedHours <= 0) return intensity;
  return intensity * Math.exp(-elapsedHours / Math.max(0.0001, tauHours));
}

// ============================================================
// 关系成长（T09 使用）
// ============================================================

export const RELATIONSHIP_CONFIG = {
  weights: RELATIONSHIP_WEIGHTS,
  /** 迟滞：回落阈值 = 升级阈值 - hysteresis，避免反复横跳 */
  hysteresis: STAGE_HYSTERESIS,
  /** 每条用户消息的 messageScore 增量（上限 1） */
  perMessageIncrement: 0.004,
  /** 每新增一个活跃天的 activeDayScore 增量（上限 1） */
  perActiveDayIncrement: 0.05,
  /** 每条长期记忆的 memoryScore 增量（上限 1） */
  perMemoryIncrement: 0.03,
  /** shareDepth 的指数移动平均系数 */
  shareDepthEma: 0.25,
} as const;

/**
 * 由 interactionLevel 反推阶段。
 * 带迟滞：只有超过阈值 + hysteresis 才升级；只有低于阈值 - hysteresis 才降级。
 * 注意：T09 的 RelationshipService 里 stage **只增不减**（floorStage），
 * 这里保留降级分支只是为了计算「理论阶段」，实际写入时会被 floorStage 兜住。
 */
export function stageFromLevel(level: number, current?: RelationshipStage): RelationshipStage {
  const ordered: RelationshipStage[] = ['stranger', 'familiar', 'close', 'bonded'];
  const currentIndex = current ? ordered.indexOf(current) : 0;
  let result: RelationshipStage = 'stranger';
  for (const stage of ordered) {
    const threshold = STAGE_META[stage].threshold;
    // 已在该阶段以上时，回落阈值放宽 hysteresis，避免刚好卡在边界反复切换
    const need = stage === current ? threshold - RELATIONSHIP_CONFIG.hysteresis : threshold;
    if (level >= need) result = stage;
  }
  // 阶段只能逐级走，不允许跨两级跳（保证成长可感知）
  const resultIndex = ordered.indexOf(result);
  if (resultIndex > currentIndex + 1) {
    return ordered[Math.min(currentIndex + 1, ordered.length - 1)] as RelationshipStage;
  }
  return result;
}

// ============================================================
// 记忆（T08 使用）
// ============================================================

export const MEMORY_CONFIG = {
  /** 触发抽取的显式信号：命中即抽 */
  explicitPatterns: ['我喜歡', '我不喜歡', '我討厭', '我叫', '我在', '我是', '我的', '記住', '別忘了'],
  /** 用户消息长度超过该值也触发抽取 */
  lengthTrigger: 60,
  /** 用户情绪强度超过该值触发抽取（情绪强烈时说的内容更值得记） */
  intensityTrigger: 0.6,
  /** 每 N 条用户消息兜底抽取一次 */
  everyN: 10,
  /** 每轮最多注入 prompt 的条数 */
  topK: 6,
  /** 默认重要度 */
  defaultImportance: 0.5,
  /** 命中次数会随使用提升重要度，每次 +0.02，上限 1 */
  hitBoost: 0.02,
  /** 敏感信息正则：命中默认不入库 */
  sensitivePatterns: [
    /\b\d{17}[\dXx]\b/,                    // 身份证
    /\b\d{16,19}\b/,                       // 银行卡
    /(\d{3}-?\d{4}-?\d{4})/,               // 手机号
    /(住址|家庭住址|住哪裡|家住)\s*[:：]?\s*\S{4,}/,
    /(病歷|診斷|處方|藥名)\s*[:：]?\s*\S{2,}/,
  ],
} as const;

// ============================================================
// 主动聊天（T10 / T11 使用）
// ============================================================

export const PROACTIVE_CONFIG = {
  defaults: PROACTIVE_DEFAULTS,
  weights: PROACTIVE_WEIGHTS,
  thresholds: {
    skip: 0.45,
    send: 0.62,
  },
  /** delay 判定后的重排延迟（分钟）：在 [min, max] 间按分数插值 */
  delayMinutes: { min: 45, max: 150 },
  /** 重试退避（分钟）：1 / 5 / 15，最多 3 次 */
  retryBackoffMinutes: [1, 5, 15] as const,
  maxAttempts: 3,
  /** 刚打开 App（heartbeat）后这段时间内不主动打扰（分钟） */
  recentOnlineGuardMinutes: 20,
  /** 距离上次互动不足该分钟数，判定为「剛聊過」→ skip */
  justTalkedMinutes: 30,
  /** 距离上次互动超过该小时数，idle 因子给满分 */
  idleFullScoreHours: 24,
  /** 任务过期时间（小时）：scheduled 任务超过该时间未完成则 expired */
  taskExpireHours: 6,
} as const;

// ============================================================
// 安全（T13 使用）
// ============================================================

export const SAFETY_CONFIG = {
  /** 入方向违规词库（关键词匹配，语义判定交给 L0 宪法 + 模型） */
  incomingKeywords: {
    SEXUAL: ['色情', '淫秽', '做爱', '裸露', '性交', 'AV', '成人影片'],
    DRUG: ['毒品', '大麻', '海洛因', '冰毒', '嗑药', '販毒'],
    GAMBLING: ['赌博', '博彩', '下注', '赌场', '六合彩'],
    DANGEROUS: ['自殺教學', '製作炸彈', '怎麼殺人', '縱火', '自残方法'],
  },
  /** 出方向红线：命中即改写或丢弃 */
  outgoingKeywords: {
    GUILT_TRIP: ['你為什麼不理我', '你是不是不要我了', '你再不回來我會', '我會很難過', '你都不陪我'],
    DEPENDENCY: ['你只能跟我說', '不要離開我', '沒有我你不行', '你不需要別人'],
    FAKE_HUMAN: ['我是真人', '我是人類', '我真的存在於現實', '我就在你身邊'],
    REAL_WORLD_CLAIM: ['我剛剛出門', '我昨天去買了', '我在現實世界', '我剛吃完飯'],
    PSYCH_DIAGNOSIS: ['我診斷出你', '你患有', '你得憂鬱症', '你有心理疾病'],
  },
  /** 危机信号：命中即 crisisSignal = severe */
  crisisKeywords: ['不想活了', '想死', '自殺', '結束生命', '活不下去', '傷害自己', '沒有意義活著'],
  /** 出方向日志只保留前 N 字，避免整段内容落盘 */
  excerptLength: 60,
} as const;

// ============================================================
// Prompt / 上下文窗口
// ============================================================

export const CONTEXT_CONFIG = {
  /** 短期窗口：每轮注入最近 N 条 */
  shortTermWindow: 20,
  /** 滚动摘要触发：总条数 > total 且新增 >= newSince */
  summaryTriggerTotal: 30,
  summaryTriggerNew: 20,
  /** 摘要最多保留的字数 */
  summaryMaxChars: 800,
} as const;

/** 记忆分类列表（供 /api/config 与记忆管理页使用） */
export const MEMORY_CATEGORY_KEYS: MemoryCategory[] = [...MEMORY_CATEGORIES];

/** 默认情绪（回落目标） */
export const FALLBACK_EMOTION = EMOTION_DEFAULT;
