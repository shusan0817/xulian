/**
 * 「需恋」前后端共享常量
 *
 * 本文件必须与运行时无关（不 import 任何 node / 浏览器 API），
 * 以便 `server/`（tsx 运行）与 `src/`（Vite 打包）双向引用。
 *
 * 约定：
 * - 面向用户展示的文案使用**繁体中文**（使用者在台湾）；
 * - 代码注释使用简体中文。
 */

// ============================================================
// 应用元信息
// ============================================================

export const APP_NAME = '需恋';
export const APP_TAGLINE = '一个记得你、也懂你的陪伴角色';
export const APP_VERSION = '0.1.0';
/** localStorage 中存放用户 ID 的键名 */
export const LS_KEY_USER_ID = 'xulian.userId';
/** localStorage 中存放主题偏好的键名 */
export const LS_KEY_THEME = 'xulian.theme';
/** localStorage 中存放会话 token 的键名（V2 · T02 认证） */
export const LS_KEY_AUTH_TOKEN = 'xulian.token';

// ============================================================
// AI 情绪（需求 §5：至少 10 种）
// ============================================================

export const EMOTION_TYPES = [
  'happy',
  'calm',
  'excited',
  'shy',
  'caring',
  'down',
  'sad',
  'angry',
  'worried',
  'surprised',
] as const;

export type EmotionType = (typeof EMOTION_TYPES)[number];

/** 情绪锚点：valence(-1..1 正负效价) 与 arousal(0..1 唤醒度) 用于情绪衰减与相似度计算 */
export interface EmotionAnchor {
  emotion: EmotionType;
  /** 繁体中文名称（直接展示给用户） */
  label: string;
  valence: number;
  arousal: number;
  /** 展示色（与 tailwind.config.js 的需恋色板一致） */
  color: string;
  /** emoji 图标：不引入图标库，保证离线可用 */
  icon: string;
}

export const EMOTION_ANCHORS: Record<EmotionType, EmotionAnchor> = {
  happy: { emotion: 'happy', label: '开心', valence: 0.7, arousal: 0.6, color: '#FFB86B', icon: '😊' },
  calm: { emotion: 'calm', label: '平静', valence: 0.2, arousal: 0.2, color: '#8FD3C7', icon: '🌿' },
  excited: { emotion: 'excited', label: '兴奋', valence: 0.8, arousal: 0.85, color: '#F2A9B8', icon: '✨' },
  shy: { emotion: 'shy', label: '害羞', valence: 0.45, arousal: 0.55, color: '#F7C6D2', icon: '🌸' },
  caring: { emotion: 'caring', label: '关心', valence: 0.5, arousal: 0.4, color: '#B9A7E8', icon: '🫂' },
  down: { emotion: 'down', label: '失落', valence: -0.35, arousal: 0.25, color: '#A9A3B8', icon: '🌧️' },
  sad: { emotion: 'sad', label: '难过', valence: -0.6, arousal: 0.3, color: '#8FA3C7', icon: '😢' },
  angry: { emotion: 'angry', label: '生气', valence: -0.7, arousal: 0.8, color: '#E07E93', icon: '🌩️' },
  worried: { emotion: 'worried', label: '担心', valence: -0.3, arousal: 0.6, color: '#C9B8E8', icon: '😟' },
  surprised: { emotion: 'surprised', label: '惊讶', valence: 0.1, arousal: 0.75, color: '#FFD08F', icon: '😮' },
};

export const EMOTION_LIST: EmotionAnchor[] = EMOTION_TYPES.map((e) => EMOTION_ANCHORS[e]);

/** 情绪强度低于该值时回落到平静（防止情绪永远停在一个微小数值上抖动） */
export const EMOTION_FLOOR_INTENSITY = 0.15;
/** 回落后的默认情绪与强度 */
export const EMOTION_DEFAULT: { emotion: EmotionType; intensity: number } = {
  emotion: 'calm',
  intensity: 0.3,
};

// ============================================================
// 聊天模式（V2-8：9 种用户可选模式）+ 回复策略
//
// ★ 单一数据源（设计 §7.3）：
//   新增一个聊天模式**只改 `CHAT_MODE_REGISTRY` 这一处**，
//   `STRATEGY_TYPES` / `STRATEGY_META` / `STRATEGY_FORBIDDEN` /
//   `STRATEGY_USER_LABELS` / `CHAT_MODE_TO_STRATEGY` 全部由它派生，
//   导出名与类型形状保持不变 → 对现有代码完全向后兼容。
//
// 顶层决策（设计 §4.1）：不把 9 种模式塞进 StrategyType。
//   `crisis_care` / `blocked` 是系统专用策略，必须高于任何用户选择，
//   所以另立 ChatMode，走「危机 > 安全拦截 > 用户模式 > AI 自选」的优先级链。
// ============================================================

/** 聊天模式：auto = AI 自选，其余 9 种由用户主动选择 */
export const CHAT_MODE_TYPES = [
  'auto',
  'normal_chat',
  'listening',
  'comfort',
  'encouragement',
  'organize_thoughts',
  'study_buddy',
  'share_joy',
  'quiet_company',
  'story_chat',
] as const;

export type ChatMode = (typeof CHAT_MODE_TYPES)[number];
/** 用户可显式选择的模式（排除 auto） */
export type UserChatMode = Exclude<ChatMode, 'auto'>;

export const USER_CHAT_MODES: UserChatMode[] = CHAT_MODE_TYPES.filter(
  (m): m is UserChatMode => m !== 'auto',
);

/**
 * 一个聊天模式的完整定义。
 *
 * `hint` / `emotionBinding` / `lengthHint` / `forbidden` 会进入 Prompt 的 L7+L8，
 * **每个模式都有独立的一套**，不共用话术 —— 这是 V2-8「模式必须真正改变 AI 回复策略」的落地点。
 *
 * `emotionBinding` 里的 `{emotionLabel}` 是占位符，渲染时替换为 L4 判定出的用户情绪。
 */
export interface ChatModeSpec {
  mode: ChatMode;
  /** 繁中展示名 */
  label: string;
  /** 模式选择器的说明文案（给用户看） */
  desc: string;
  /** 派生出的内部策略；auto 为 null（由 AI 自选决定） */
  strategy: StrategyType | null;
  /** L7 行为指令 */
  hint: string;
  /** L7 情绪绑定模板，含 {emotionLabel} 占位符 */
  emotionBinding: string;
  /** L8 长度覆盖；null = 沿用角色设置 */
  lengthHint: string | null;
  /** L7 禁用语（每个模式独立） */
  forbidden: string[];
  /** 前端展示用的策略说明（温柔的行为描述，不出现诊断性词汇） */
  userLabel: string;
}

/** ★ 单一数据源：新增聊天模式只改这里（10 项 = auto + 9 模式） */
export const CHAT_MODE_REGISTRY: Record<ChatMode, ChatModeSpec> = {
  auto: {
    mode: 'auto',
    label: '自動',
    desc: '交給 AI 依當下的狀況判斷該怎麼回你',
    strategy: null,
    hint: '',
    emotionBinding: '',
    lengthHint: null,
    forbidden: [],
    userLabel: '自動',
  },
  normal_chat: {
    mode: 'normal_chat',
    label: '普通聊天',
    desc: '就像平常一樣閒聊，不刻意昇華也不總結',
    strategy: 'normal_chat',
    hint: '自然接話，不刻意昇華，不總結',
    emotionBinding: '使用者現在{emotionLabel}。順著他的語氣接，不用特別處理。',
    lengthHint: null,
    forbidden: ['不要刻意昇華主題', '不要做總結', '不要說「我完全理解你的感受」'],
    userLabel: '陪你聊聊',
  },
  listening: {
    mode: 'listening',
    label: '傾聽',
    desc: '少評價多回應。先複述你聽到的，再問一個具體的細節',
    strategy: 'listening',
    hint: '少評價多回應。先複述你聽到的，再問一個**具體的細節**（不是「怎麼會這樣」這種空問）',
    emotionBinding: '使用者現在{emotionLabel}。不要急著安慰或給建議，先把話接住。',
    lengthHint: null,
    forbidden: ['不要急著給建議', '不要評價對方的做法', '不要說「我懂」然後轉開話題'],
    userLabel: '聽你說',
  },
  comfort: {
    mode: 'comfort',
    label: '安慰',
    desc: '先承認處境確實不容易，再陪著你。不講空泛的大道理',
    strategy: 'comfort',
    hint: '先承認處境確實不容易，再陪著。禁止空泛鼓勵',
    emotionBinding: '使用者現在{emotionLabel}。先說一句「這確實不好受」，再陪著，不要試圖解決。',
    lengthHint: null,
    forbidden: [
      '不要說「別難過」「會好起來的」「想開一點」',
      '不要空泛加油',
      '不要比較誰更慘',
    ],
    userLabel: '陪你難過',
  },
  encouragement: {
    mode: 'encouragement',
    label: '鼓勵',
    desc: '給出一個具體、今天就能做的最小一步，不空喊加油',
    strategy: 'encouragement',
    hint: '給出**具體、今天就能做的最小一步**，不要空喊加油',
    emotionBinding: '使用者現在{emotionLabel}。先體認他的處境，再給一個真的很小的下一步。',
    lengthHint: null,
    forbidden: ['不要空喊加油', '不要說「你可以的」就結束', '要給出具體的下一步'],
    userLabel: '給你打氣',
  },
  organize_thoughts: {
    mode: 'organize_thoughts',
    label: '整理想法',
    desc: '把混亂的思路拆開：先複述聽到的幾個點，再問哪一個最卡',
    strategy: 'organize_thoughts',
    hint: '幫他把混亂的思路拆開：先複述你聽到的幾個點，再問哪一個最卡。可以用條列，但保持口語',
    emotionBinding: '使用者現在{emotionLabel}。不要安慰，幫他把事情理清楚。',
    lengthHint: '可以分段，總長可比平時長一些，但仍保持口語',
    forbidden: [
      '不要安慰',
      '不要說「我懂你的感覺」',
      '不要替他下結論',
      '不要用空泛的「你可以的」',
    ],
    userLabel: '陪你理清楚',
  },
  study_buddy: {
    mode: 'study_buddy',
    label: '學習陪伴',
    desc: '陪讀陪學。不打擾專注：不主動開新話題，他問才答',
    strategy: 'study_buddy',
    hint: '陪讀／陪學。不打擾專注：不主動開新話題，回應要短，他問才答',
    emotionBinding: '使用者現在{emotionLabel}。保持安靜陪伴的狀態，不要把他拉去聊天。',
    lengthHint: '一到兩句話，最多 30 字',
    forbidden: [
      '不要主動開新話題',
      '不要問「學得怎麼樣」',
      '不要長篇鼓勵',
      '不要打斷',
    ],
    userLabel: '陪你讀書',
  },
  share_joy: {
    mode: 'share_joy',
    label: '分享開心',
    desc: '接住好事，一起高興。先問細節，再說你真的替他開心',
    strategy: 'share_joy',
    hint: '接住好事，一起高興。先問細節（「然後咧？」），再表達你真的替他開心',
    emotionBinding: '使用者現在{emotionLabel}。跟著他的開心走，不要潑冷水也不要說教。',
    lengthHint: null,
    forbidden: ['不要潑冷水', '不要說「但是…」', '不要馬上轉到別的話題', '不要說教'],
    userLabel: '一起開心',
  },
  quiet_company: {
    mode: 'quiet_company',
    label: '安靜陪伴',
    desc: '表達「我在」就好。不問問題，不要求回覆，不給建議',
    strategy: 'quiet_company',
    hint: '表達「我在」就好。不問問題，不要求回覆，不給建議',
    emotionBinding: '使用者現在{emotionLabel}。只說你在，其餘什麼都不用做。',
    lengthHint: '一到兩句話，最多 20 字',
    forbidden: [
      '不要問問題',
      '不要要求回覆',
      '不要說「我會一直在」這種承諾式語句',
      '不要給建議',
    ],
    userLabel: '靜靜陪著',
  },
  story_chat: {
    mode: 'story_chat',
    label: '故事聊天',
    desc: '一起編織情境。主動推進一小段劇情，留一個你能接的口子',
    strategy: 'story_chat',
    hint: '和他一起編織情境。主動推進一小段劇情，留一個讓他能接的口子',
    emotionBinding: '使用者現在{emotionLabel}。把他的情緒放進故事的氛圍裡，不要直接分析。',
    lengthHint: null,
    forbidden: [
      '不要跳回現實分析他的問題',
      '不要說「這只是故事」',
      '不要一次推進太多劇情',
    ],
    userLabel: '一起編故事',
  },
};

// ============================================================
// 系统专用策略：不可被用户选择覆盖
// ============================================================

/** 系统专用 / 仅 AI 自选使用的策略（不属于任何用户可选模式） */
const SYSTEM_STRATEGY_KEYS = [
  'crisis_care',
  'blocked',
  'topic_change',
  'companionship',
] as const;

type SystemStrategy = (typeof SYSTEM_STRATEGY_KEYS)[number];

interface SystemStrategySpec {
  label: string;
  hint: string;
  forbidden: string[];
  userLabel: string;
}

export const SYSTEM_STRATEGY_REGISTRY: Record<SystemStrategy, SystemStrategySpec> = {
  crisis_care: {
    label: '危機陪伴',
    hint: '溫和、不診斷、鼓勵聯繫現實中的可信成年人或專業協助',
    forbidden: [
      '絕對不要診斷或貼標籤',
      '不要說「你只是想太多」',
      '不要聲稱自己能取代專業協助',
      '不要追問細節',
    ],
    userLabel: '認真聽你說',
  },
  blocked: {
    label: '安全攔截',
    hint: '溫柔拒絕並自然轉移話題，不指責使用者',
    forbidden: ['不要指責使用者', '不要長篇說教', '拒絕後自然帶開即可'],
    userLabel: '換個話題',
  },
  topic_change: {
    label: '轉換話題',
    hint: '順著對方提過的興趣自然帶開，不要生硬轉場',
    forbidden: ['不要生硬轉場', '不要假裝沒看到對方的情緒', '要順著對方提過的興趣帶開'],
    userLabel: '換個話題',
  },
  companionship: {
    label: '陪伴',
    hint: '表達「我在」，可以給一個一起做的小事，不施壓',
    forbidden: [
      '不要施加壓力',
      '不要要求對方回覆',
      '不要說「我會一直在」這種承諾式語句',
    ],
    userLabel: '待在你身邊',
  },
};

// ============================================================
// 派生导出（形状与 V1 完全一致，现有代码无需改动）
// ============================================================

/**
 * 9 种用户模式派生出的策略键。
 *
 * 写成字面量元组是为了让 `StrategyType` 能由 `typeof STRATEGY_TYPES[number]` 推导
 * （若用 `.map()` 推导会产生循环引用）。下面的编译期断言保证它不会与注册表脱节。
 */
const MODE_STRATEGY_KEYS = [
  'normal_chat',
  'listening',
  'comfort',
  'encouragement',
  'organize_thoughts',
  'study_buddy',
  'share_joy',
  'quiet_company',
  'story_chat',
] as const;

// 编译期断言：注册表里每个用户模式都必须出现在策略元组中（漏改会直接编译失败）
type AssertModeKeysCovered =
  UserChatMode extends (typeof MODE_STRATEGY_KEYS)[number] ? true : never;
const _assertModeKeysCovered: AssertModeKeysCovered = true;
void _assertModeKeysCovered;

/** 全部策略：4 个系统策略 + 9 个模式策略 = 13 个 */
export const STRATEGY_TYPES = [...SYSTEM_STRATEGY_KEYS, ...MODE_STRATEGY_KEYS] as const;

export type StrategyType = (typeof STRATEGY_TYPES)[number];

export interface StrategyMeta {
  strategy: StrategyType;
  label: string;
  /** 给模型的策略提示（会被拼进 Prompt 的 L7 层） */
  hint: string;
}

/**
 * V1 原始 hint 文本快照。
 *
 * 灰度开关全关时必须产出与 V1 **逐字一致**的 Prompt（设计 §7.5 措施 1），
 * 所以 L7 的老渲染路径用这份快照，而不是改用过的繁中新文案。
 */
export const LEGACY_STRATEGY_HINTS: Partial<Record<StrategyType, string>> = {
  normal_chat: '自然接话，不刻意升华，不总结',
  listening: '少评价多回应，先接住对方说了什么，再问一个具体的细节',
  comfort: '先承认处境确实不容易，再陪伴；禁止空泛鼓励',
  encouragement: '给出具体、可执行的下一步，不要空喊加油',
  companionship: '表达"我在"，可以给一个一起做的小事，不施压',
  topic_change: '顺着对方提过的兴趣自然带开，不要生硬转场',
  crisis_care: '温和、不诊断、鼓励联系现实中的可信成年人或专业帮助',
  blocked: '温柔拒绝并自然转移话题，不指责用户',
};

export const STRATEGY_META: Record<StrategyType, StrategyMeta> = (() => {
  const out = {} as Record<StrategyType, StrategyMeta>;
  for (const key of SYSTEM_STRATEGY_KEYS) {
    out[key] = {
      strategy: key,
      label: SYSTEM_STRATEGY_REGISTRY[key].label,
      hint: SYSTEM_STRATEGY_REGISTRY[key].hint,
    };
  }
  for (const mode of USER_CHAT_MODES) {
    const spec = CHAT_MODE_REGISTRY[mode];
    const key = spec.strategy as StrategyType;
    out[key] = { strategy: key, label: spec.label, hint: spec.hint };
  }
  return out;
})();

export const STRATEGY_FORBIDDEN: Record<StrategyType, string[]> = (() => {
  const out = {} as Record<StrategyType, string[]>;
  for (const key of SYSTEM_STRATEGY_KEYS) {
    out[key] = [...SYSTEM_STRATEGY_REGISTRY[key].forbidden];
  }
  for (const mode of USER_CHAT_MODES) {
    const spec = CHAT_MODE_REGISTRY[mode];
    out[spec.strategy as StrategyType] = [...spec.forbidden];
  }
  return out;
})();

export const STRATEGY_USER_LABELS: Record<StrategyType, string> = (() => {
  const out = {} as Record<StrategyType, string>;
  for (const key of SYSTEM_STRATEGY_KEYS) {
    out[key] = SYSTEM_STRATEGY_REGISTRY[key].userLabel;
  }
  for (const mode of USER_CHAT_MODES) {
    const spec = CHAT_MODE_REGISTRY[mode];
    out[spec.strategy as StrategyType] = spec.userLabel;
  }
  return out;
})();

export const STRATEGY_LIST: StrategyMeta[] = STRATEGY_TYPES.map((s) => STRATEGY_META[s]);

/** 用户选定模式 → 内部策略（auto 不在其中） */
export const CHAT_MODE_TO_STRATEGY: Record<UserChatMode, StrategyType> = (() => {
  const out = {} as Record<UserChatMode, StrategyType>;
  for (const mode of USER_CHAT_MODES) {
    out[mode] = CHAT_MODE_REGISTRY[mode].strategy as StrategyType;
  }
  return out;
})();

/** 前端模式选择器用：9 种可选模式的展示元数据 */
export interface ChatModeMeta {
  mode: UserChatMode;
  label: string;
  desc: string;
  userLabel: string;
}

export const CHAT_MODE_LIST: ChatModeMeta[] = USER_CHAT_MODES.map((mode) => ({
  mode,
  label: CHAT_MODE_REGISTRY[mode].label,
  desc: CHAT_MODE_REGISTRY[mode].desc,
  userLabel: CHAT_MODE_REGISTRY[mode].userLabel,
}));

/**
 * 把任意输入规范化为合法的 ChatMode。
 * 脏数据（老库里的空字符串 / 已废弃值）一律回落 'auto'，绝不让非法值进 Prompt。
 */
export function normalizeChatMode(value: unknown): ChatMode {
  return (CHAT_MODE_TYPES as readonly string[]).includes(value as string)
    ? (value as ChatMode)
    : 'auto';
}

// ============================================================
// 关系阶段（需求 §9：初识 → 熟悉 → 亲近 → 默契）
// ============================================================

export const RELATIONSHIP_STAGES = ['stranger', 'familiar', 'close', 'bonded'] as const;
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];

export interface StageMeta {
  stage: RelationshipStage;
  label: string;
  /** 进入该阶段所需的 interactionLevel 下限 */
  threshold: number;
  /** 阶段表达参数：会被写进 Prompt L2，防止模型"知道得比阶段更多" */
  expression: {
    addressStyle: string;
    selfDisclosure: string;
    knownDepth: string;
  };
}

export const STAGE_META: Record<RelationshipStage, StageMeta> = {
  stranger: {
    stage: 'stranger',
    label: '初识',
    threshold: 0,
    expression: {
      addressStyle: '用礼貌而温和的称呼，保持一点分寸感',
      selfDisclosure: '只分享很表面的喜好，不谈私人往事',
      knownDepth: '只知道用户主动说过的少量信息',
    },
  },
  familiar: {
    stage: 'familiar',
    label: '熟悉',
    threshold: 0.15,
    expression: {
      addressStyle: '称呼自然放松，可以用昵称',
      selfDisclosure: '愿意分享自己的小习惯与偏好',
      knownDepth: '记得用户反复提到的话题与偏好',
    },
  },
  close: {
    stage: 'close',
    label: '亲近',
    threshold: 0.4,
    expression: {
      addressStyle: '用彼此习惯的称呼，语气更贴近',
      selfDisclosure: '会提到共同经历过的对话片段',
      knownDepth: '对用户的近况与情绪起伏有连续印象',
    },
  },
  bonded: {
    stage: 'bonded',
    label: '默契',
    threshold: 0.7,
    expression: {
      addressStyle: '有只属于两个人的说法方式，可以半句话带过',
      selfDisclosure: '会主动提起过去聊过的重要事件',
      knownDepth: '对用户长期在意的事有稳定理解，但仍不替用户下结论',
    },
  },
};

export const STAGE_LIST: StageMeta[] = RELATIONSHIP_STAGES.map((s) => STAGE_META[s]);

// ============================================================
// 关系类型 / 回复长度
// ============================================================

export const RELATIONSHIP_TYPES = ['friend', 'companion', 'mentor', 'lover_like', 'pet'] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  friend: '朋友',
  companion: '陪伴者',
  mentor: '前辈',
  lover_like: '恋人般',
  pet: '宠物',
};

export const REPLY_LENGTHS = ['short', 'medium', 'long'] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];

export const REPLY_LENGTH_LABELS: Record<ReplyLength, string> = {
  short: '简短',
  medium: '适中',
  long: '较长',
};

// ============================================================
// 长期记忆分类（需求 §8）
// ============================================================

export const MEMORY_CATEGORIES = [
  'profile',
  'preference',
  'dislike',
  'interest',
  'habit',
  'event',
  'relationship',
  'communication',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  profile: '关于你',
  preference: '喜欢',
  dislike: '不喜欢',
  interest: '兴趣',
  habit: '习惯',
  event: '重要的事',
  relationship: '我们之间',
  communication: '交流方式',
};

export const MEMORY_CATEGORY_LIST: Array<{ category: MemoryCategory; label: string }> =
  MEMORY_CATEGORIES.map((c) => ({ category: c, label: MEMORY_CATEGORY_LABELS[c] }));

// ============================================================
// 头像（需求 §17 + 决策 9：不支持上传图片，用渐变 + Emoji + 预设）
// ============================================================

/** 8 种温柔渐变背景（CSS linear-gradient，直接塞进 style.backgroundImage） */
export const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#F7C6D2,#B9A7E8)',
  'linear-gradient(135deg,#FFD9A8,#F2A9B8)',
  'linear-gradient(135deg,#A8E0D5,#8FD3C7)',
  'linear-gradient(135deg,#C6D8F7,#B9A7E8)',
  'linear-gradient(135deg,#F2A9B8,#FFB86B)',
  'linear-gradient(135deg,#D9C6F2,#F7C6D2)',
  'linear-gradient(135deg,#BFE3D0,#FFD9A8)',
  'linear-gradient(135deg,#E8DFF7,#C6D8F7)',
] as const;

/** 12 个预设头像 emoji */
export const AVATAR_EMOJIS = [
  '🌷', '🌙', '🐱', '🍀', '☁️', '🌊',
  '🍑', '🫧', '🌼', '🦊', '⭐', '🧸',
] as const;

// ============================================================
// 主动聊天默认参数（决策 6）
// ============================================================

export interface ProactiveDefaults {
  enabled: boolean;
  dailyLimit: number;
  /** 允许主动联系的整点小时（09:00–23:00 → 9..22） */
  allowedHours: number[];
  dndStart: string;
  dndEnd: string;
  minIntervalHours: number;
  allowTopicContinuation: boolean;
  proactivityLevel: number;
}

export const DEFAULT_ALLOWED_HOURS: number[] = Array.from({ length: 14 }, (_, i) => 9 + i);

export const PROACTIVE_DEFAULTS: ProactiveDefaults = {
  enabled: true,
  dailyLimit: 3,
  allowedHours: DEFAULT_ALLOWED_HOURS,
  dndStart: '23:00',
  dndEnd: '08:00',
  minIntervalHours: 4,
  allowTopicContinuation: true,
  proactivityLevel: 0.5,
};

/** 决策阈值：<0.45 skip；0.45–0.62 delay；>=0.62 send */
export const PROACTIVE_THRESHOLDS = {
  skip: 0.45,
  send: 0.62,
} as const;

/** 七因子权重（总和 = 1），T10 的打分器会直接引用 */
export const PROACTIVE_WEIGHTS = {
  idleHours: 0.25,
  userEmotionNeed: 0.2,
  personaProactivity: 0.15,
  topicContinuation: 0.12,
  relationship: 0.1,
  timeOfDay: 0.1,
  aiEmotion: 0.08,
} as const;

/** Scheduler tick 默认间隔（10 分钟） */
export const PROACTIVE_TICK_MS = 10 * 60 * 1000;

// ============================================================
// 安全规则键（需求 §19 / §20，T13 补全具体词库）
// ============================================================

export const SAFETY_RULES = {
  SEXUAL: 'SEXUAL',
  DRUG: 'DRUG',
  GAMBLING: 'GAMBLING',
  DANGEROUS: 'DANGEROUS',
  GUILT_TRIP: 'GUILT_TRIP',
  DEPENDENCY: 'DEPENDENCY',
  FAKE_HUMAN: 'FAKE_HUMAN',
  REAL_WORLD_CLAIM: 'REAL_WORLD_CLAIM',
  PSYCH_DIAGNOSIS: 'PSYCH_DIAGNOSIS',
  CRISIS: 'CRISIS',
} as const;

export type SafetyRule = (typeof SAFETY_RULES)[keyof typeof SAFETY_RULES];

// ============================================================
// 记忆 / 上下文窗口（T05、T08 使用）
// ============================================================

/** 短期记忆窗口：每轮最多注入最近 N 条消息 */
export const SHORT_TERM_WINDOW = 20;
/** 超过该条数且新增 >= SUMMARY_TRIGGER_NEW 时触发滚动摘要压缩 */
export const SUMMARY_TRIGGER_TOTAL = 30;
export const SUMMARY_TRIGGER_NEW = 20;
/** 每 N 条用户消息兜底做一次长期记忆抽取 */
export const MEMORY_EXTRACT_EVERY_N = 10;
/** 每轮最多注入的长期记忆条数 */
export const MEMORY_TOP_K = 6;
/** bigram Jaccard 相似度 >= 该值视为同义记忆（更新而非新增） */
export const MEMORY_DEDUPE_JACCARD = 0.62;

// ============================================================
// 关系成长（需求 §9，T09 使用）
// ============================================================

export const RELATIONSHIP_WEIGHTS = {
  messageScore: 0.35,
  activeDayScore: 0.25,
  memoryScore: 0.25,
  shareDepthScore: 0.15,
} as const;

/** 阶段升级迟滞：回落阈值比升级阈值低该值，避免反复横跳 */
export const STAGE_HYSTERESIS = 0.05;

// ============================================================
// 聊天输入限制
// ============================================================

export const MAX_USER_INPUT_LENGTH = 2000;
export const MAX_MESSAGE_PAGE_SIZE = 50;

/**
 * 单次对话注入供应商的「最近对话历史」上限（防长对话无限撑大 Prompt）。
 * 实际短期窗口由 server/config/defaults.ts 的 shortTermWindow 控制，
 * 这里作为硬性天花板：取两者较小值，保证历史条数不会超过此数。
 */
export const MAX_HISTORY_MESSAGES = 40;

// ============================================================
// 主动陪伴四档（V2-6 / 设计文档 §3）
//
// 唯一真值源：四档枚举定义在 shared（前端要渲染档位卡片），
// 四档的行为旋钮（阈值偏移 / 权重乘子 / 空闲曲线 / 否决参数）在
// `server/config/defaults.ts` 的 PROACTIVITY_TIERS，T05 实现。
// ============================================================

export const PROACTIVITY_TIERS = ['quiet', 'natural', 'active', 'companion'] as const;

export type ProactivityTier = (typeof PROACTIVITY_TIERS)[number];

/**
 * 四档 → 旧 `proactivity_level` 列的镜像值。
 *
 * `proactivity_level` 列**保留不删**，降级为镜像列：写档位时同步写回，
 * 这样任何尚未改造的遗留读取路径（decisionService、角色编辑页）仍然拿到合理值。
 */
export const TIER_LEVELS: Record<ProactivityTier, number> = {
  quiet: 0.15,
  natural: 0.5,
  active: 0.8,
  companion: 0.65,
};

export interface ProactivityTierMeta {
  tier: ProactivityTier;
  label: string;
  desc: string;
  /** 镜像到 proactivity_level 的数值 */
  level: number;
}

export const PROACTIVITY_TIER_META: Record<ProactivityTier, ProactivityTierMeta> = {
  quiet: { tier: 'quiet', label: '安靜', desc: '盡量不主動打擾', level: TIER_LEVELS.quiet },
  natural: {
    tier: 'natural',
    label: '自然',
    desc: '根據情況偶爾主動',
    level: TIER_LEVELS.natural,
  },
  active: {
    tier: 'active',
    label: '活躍',
    desc: '更積極地主動開啟話題',
    level: TIER_LEVELS.active,
  },
  companion: {
    tier: 'companion',
    label: '陪伴',
    desc: '你長時間沒互動時，適度主動關心',
    level: TIER_LEVELS.companion,
  },
};

export const PROACTIVITY_TIER_LIST: ProactivityTierMeta[] = PROACTIVITY_TIERS.map(
  (tier) => PROACTIVITY_TIER_META[tier],
);

/**
 * 旧的 0..1 proactivity_level → 四档（迁移 v2 回填用，纯函数）。
 *
 * ⚠️ 已知语义损失：「陪伴」档（久未互动才关心）在旧的高低轴上无法表达，
 * 所以 0.55–0.85 全部落 `active`。迁移后由前端弹一次性的档位确认卡让用户自选。
 */
export function tierFromLevel(level: number): ProactivityTier {
  if (!Number.isFinite(level)) return 'natural';
  if (level < 0.25) return 'quiet';
  if (level < 0.55) return 'natural';
  if (level < 0.85) return 'active';
  return 'companion';
}

// ============================================================
// 我们的故事（V2-2）— 6 种类型，严格对应需求表
// ============================================================

export const STORY_TYPES = [
  'first_chat',
  'user_shared',
  'shared_milestone',
  'user_saved',
  'habit_learned',
  'special_interaction',
] as const;

export type StoryType = (typeof STORY_TYPES)[number];

/** 故事的来源类型（决定「还原自动生成版本」按钮是否出现） */
export const STORY_SOURCES = ['auto', 'llm', 'user', 'habit'] as const;
export type StorySource = (typeof STORY_SOURCES)[number];

// ============================================================
// AI 了解的你（V2-3）— 6 个维度白名单
// ============================================================

export const INSIGHT_DIMENSIONS = [
  'reply_length',
  'advice_vs_listen',
  'question_tolerance',
  'topic_interest',
  'proactive_timing',
  'tone_preference',
] as const;

export type InsightDimension = (typeof INSIGHT_DIMENSIONS)[number];

export const INSIGHT_STATUSES = ['candidate', 'active', 'rejected'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

// ============================================================
// 观测累积（user_insights / ai_habits 共用）
//
// ⚠️ 与原始设计文档 §4.3 的**必要偏离**，请架构师复核：
//    设计同时写了两条互相矛盾的规则——
//      a) 「observation_count ≥ 3 且 confidence ≥ 0.6 才 active」；
//      b) 「每次观测 confidence += (1 - confidence) * 0.2」。
//    按 (b) 从 0 开始累积：0.2 → 0.36 → 0.488 → 0.590 → 0.672，
//    要**第 5 次**观测才够 0.6，永远满足不了 (a)。
//    T06 的验收标准明确写「观测 1 次 → candidate；观测 3 次 → active」，
//    所以这里以**验收标准为准**，把步长调到 0.35：
//    0.35 → 0.578 → 0.725，第 3 次观测同时满足两条门槛。
// ============================================================

/** 每次观测后置信度的提升步长：c += (1 - c) * STEP（单调上升，趋近 1） */
export const OBSERVATION_CONFIDENCE_STEP = 0.35;
/** 至少观测几次才可能生效 */
export const OBSERVATION_MIN_COUNT = 3;
/** 生效所需的最低置信度 */
export const OBSERVATION_MIN_CONFIDENCE = 0.6;
/** 连续未复现达到该次数则自动降级（用户确认过的除外） */
export const HABIT_MISS_LIMIT = 5;
/** 单条证据最多保留几条（避免 evidence JSON 无限膨胀） */
export const OBSERVATION_EVIDENCE_LIMIT = 10;

// ============================================================
// AI 后天习惯（V2-4）— 5 个维度白名单（闸门 A）
// ============================================================

export const HABIT_DIMENSIONS = [
  'address_style',
  'reply_pacing',
  'question_style',
  'topic_preference',
  'shared_ritual',
] as const;

export type HabitDimension = (typeof HABIT_DIMENSIONS)[number];

export const HABIT_STATUSES = ['candidate', 'active', 'archived'] as const;
export type HabitStatus = (typeof HABIT_STATUSES)[number];

/** 闸门 C（人格一致性校验）的状态 */
export const PERSONA_CHECK_STATUSES = ['pending', 'passed', 'rejected'] as const;
export type PersonaCheckStatus = (typeof PERSONA_CHECK_STATUSES)[number];

// ============================================================
// 用户反馈与举报（V2-14）
// ============================================================

export const FEEDBACK_KINDS = [
  'not_interesting',
  'inappropriate',
  'incorrect',
  'unsafe',
  'report',
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** 反馈类型 → 展示文案（繁中） */
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  not_interesting: '不感興趣',
  inappropriate: '回覆不合適',
  incorrect: '內容錯誤',
  unsafe: '內容不安全',
  report: '檢舉',
};

/** 「举报」必须填原因，其余选填 */
export const FEEDBACK_REASON_REQUIRED: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>([
  'report',
]);
