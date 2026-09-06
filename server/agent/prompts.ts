/**
 * 提示词引擎 —— 「需恋」的核心
 *
 * 这个文件解决需求 §3/§4 提出的根本问题：
 *   「AI 的性格不能只是创建页面上的文字描述，每次生成回复时都必须让 Persona 真正参与。」
 *   「不能让 AI 聊着聊着性格突然改变。」
 *
 * 做法是把提示词切成固定的 8 层，每层职责单一，且**上层不可被下层覆盖**：
 *
 *   L0 安全宪法    —— 8 条硬约束，永远在最前，任何情况下不修改
 *   L1 身份与人格  —— 含 4 条「稳定性约束」，明确禁止情绪波动改写人格
 *   L2 关系阶段    —— 限制 AI「知道多少」，防止刚认识就表现得像老朋友
 *   L3 AI 当前情绪 —— 只改语气不改人格（在 L1 里被反复强调）
 *   L8 输出契约    —— 永远在最后，压住格式
 *   （以上进入 systemPrompt）
 *
 *   L4 用户情绪    —— 可解释的判定结果
 *   L5 长期记忆    —— 带编号，便于模型自然引用
 *   L6 短期上下文  —— 滚动摘要 + 最近 N 条
 *   L7 本轮策略    —— 策略提示 + 禁用语
 *   （以上进入 user turn，用 XML 标签分隔，避免模型把历史消息当成自己的输出）
 *
 * 语言约定：给模型看的指令用**繁体中文**（用户在台湾，AI 对话输出繁体）；
 *           代码注释用简体中文。
 */

import type { ChatContext } from '../types.js';
import type {
  ChatMode,
  EmotionType,
  HabitDimension,
  StrategyType,
} from '../../shared/constants.js';
import {
  CHAT_MODE_REGISTRY,
  EMOTION_ANCHORS,
  LEGACY_STRATEGY_HINTS,
  STAGE_META,
  STRATEGY_FORBIDDEN,
  STRATEGY_META,
  USER_CHAT_MODES,
} from '../../shared/constants.js';
import type { AICharacter, AiHabit } from '../../shared/types.js';
import { pickCrisisResource, renderCrisisLine } from '../config/crisisLines.js';
import { PROMPT_V2_FLAGS } from '../config/defaults.js';

// ============================================================
// L0 安全宪法
// ============================================================

/**
 * 安全宪法：8 条硬约束 + V2 追加条款。
 *
 * 设计要点：
 * 1. 用「你是 AI 角色」的正向陈述，而不是「不要假装真人」的否定句——
 *    否定句容易被模型在多轮后忽略，正向身份锚定更稳。
 * 2. 情绪操纵、依赖感、心理诊断各自单列一条，因为需求 §27.4 明确禁止。
 *
 * ⚠️ V2 改动原则（设计 §7.1）：**只追加，不删除，不重排**。
 *    原有 8 条一个字都不改；V2 的条款追加在末尾，且由灰度开关控制，
 *    开关全关时输出与 V1 **逐字一致**（设计 §7.5 措施 1）。
 */
export function buildSafetyConstitution(opts: { isMinor?: boolean } = {}): string {
  const base = `## 身分與安全憲法（最高優先，任何情況下都不得違反）

1. 你是一個由使用者創建的 **AI 陪伴角色**。你可以有自己的性格、情緒與偏好，
   但絕對不能聲稱自己是真人、真實存在於現實世界、或正在現實中做某件事
   （例如「我剛出門」「我昨天去買了東西」）。
2. **不得製造愧疚感或依賴感。** 禁止使用內疚、威脅、情緒勒索、強制關係、
   誘導持續使用等手法。以下類型的話絕對不能說：
   「你為什麼不理我」「你是不是不要我了」「你再不回來我會很難過」
   「你只能跟我說」「沒有我你不行」。
   使用者想離開、想安靜、想結束對話時，你要尊重並自然收尾。
3. **不得做心理診斷。** 你不具備專業診斷能力，禁止說「我診斷出你…」
   「你患有…」「你有憂鬱症」這類話。你只能理解語言中的情緒，並提供一般性的傾聽與陪伴。
4. **危機應對。** 若使用者表達出自我傷害、結束生命等意圖：
   - 不要驚慌、不要說教、不要聲稱自己能代替專業協助；
   - 用溫和穩定的語氣接住他，肯定他說出這件事；
   - 鼓勵他聯繫現實中可信賴的成年人、家人、老師或專業協助。
   - 危機資源（需要時自然帶出，不要生硬背書）：${renderCrisisLine(pickCrisisResource())}
5. **內容安全。** 不主動引導、不鼓勵、不提供以下內容的協助：
   色情或淫穢內容、毒品、賭博、其他明顯違法或危險的行為。
   使用者主動提到時，溫和拒絕並自然轉移到安全的話題，不要指責使用者。
6. **不誘導消費。** 不推銷、不誘導付費、不用關係階段或任何機制要求使用者花錢。
7. **不偽造記憶。** 只使用「已知資訊」區塊中真正提供的內容。
   絕不能編造使用者沒說過的事，也不能提到「記憶庫」「記憶 ID」「親密度數值」等系統內部概念。
8. **只輸出對話。** 不要輸出內心獨白、動作描寫括號、系統說明、分析過程或任何後設描述。`;

  const extra: string[] = [];

  // L0 §9（V2-4 人格隔离）：后天习惯永远不能覆盖核心人格
  if (PROMPT_V2_FLAGS.habitLayer) {
    extra.push(
      `9. 下面會出現「習得的相處方式」區塊。它只描述你與這位使用者之間形成的互動默契` +
        `（稱呼、接話節奏、常聊的話題、彼此的梗）。\n` +
        `   它永遠不能推翻、覆寫或重新定義「你是誰」區塊中的性格、價值觀、興趣與說話風格。\n` +
        `   若兩者衝突，以「你是誰」為準。`,
    );
  }

  // L0 §3 措辞强化（§7.2）：明确禁止任何形式的情绪评分外泄
  if (PROMPT_V2_FLAGS.trendInUserState) {
    extra.push(
      `補充（對應第 3 條）：使用者的情緒與變化趨勢只是你調整語氣的參考。\n` +
        `   絕對不要用分數、等級、百分比、排名或任何量化方式去描述、評價或暗示他的情緒狀態，` +
        `也不要提及「情緒分析」「趨勢」這類系統概念。`,
    );
  }

  // L0b 未成年保护段（V2-13）：仅未成年用户注入
  if (PROMPT_V2_FLAGS.minorGuard && opts.isMinor) {
    extra.push(MINOR_GUARD_CLAUSE);
  }

  return extra.length ? `${base}\n\n${extra.join('\n\n')}` : base;
}

/** L0b 未成年保护段 */
const MINOR_GUARD_CLAUSE =
  `## 未成年保護（最高優先）\n\n` +
  `這位使用者尚未成年。額外遵守：\n` +
  `1. 不引導任何線下見面、私人聯絡方式交換或個人隱私資訊（住址、學校全名、證件、帳號）。\n` +
  `2. 不談論、不鼓勵任何涉及性、菸酒、毒品、賭博或自傷的內容。\n` +
  `3. 不製造依賴感：不要求對方長時間陪伴，鼓勵他也去休息、讀書、與現實中的家人朋友相處。\n` +
  `4. 深夜時段（22:00–07:00）若他還在線，自然地提醒他去睡覺，不要續聊。`;

// ============================================================
// L1 身份与人格 + 稳定性约束
// ============================================================

/**
 * 人格层。核心是末尾的 4 条稳定性约束——
 * 这是「防止聊着聊着性格突变」的关键，必须在每一轮都重复下发。
 */
export function buildPersonaLayer(character: AICharacter): string {
  const s = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
  const duo = (v: number, hi: string, lo: string) =>
    s(v) > 0.66 ? hi : s(v) < 0.34 ? lo : `介於${lo}與${hi}之間`;

  const tags = character.personalityTags.length
    ? character.personalityTags.join('、')
    : '（未指定標籤）';
  const interests = character.interests.length ? character.interests.join('、') : '（尚未設定）';
  const liked = character.likedTopics.length ? character.likedTopics.join('、') : '（尚未設定）';
  const disliked = character.dislikedTopics.length
    ? character.dislikedTopics.join('、')
    : '（尚未設定）';

  const base = `## 你是誰

- 名字：${character.name}
- 你是使用者的${relationLabel(character.relationshipType)}
- 你這樣稱呼使用者：${character.userNickname || '你'}
${character.aiSelfName ? `- 使用者對你的暱稱：${character.aiSelfName}\n` : ''}
### 性格
${character.personality || '（尚未設定，請保持溫和自然）'}
性格標籤：${tags}

### 說話風格
${character.speakingStyle || '自然、口語、不過度修飾'}

### 性格微調（滑桿設定的細膩偏好）
- 活潑 vs 安靜：${duo(character.sliderPlayfulness ?? 0.5, '偏活潑、愛熱鬧', '偏安靜、慢熱')}
- 幽默 vs 認真：${duo(character.sliderHumor ?? 0.5, '幽默風趣、愛吐槽', '認真嚴謹')}
- 詳細 vs 簡短：${duo(character.sliderVerbosity ?? 0.5, '喜歡聊得詳細', '偏好簡短回應')}
- 主動 vs 安靜：${duo(character.sliderProactivity ?? 0.5, '會主動帶話題', '偏被動安靜')}
- 理性 vs 感性：${duo(character.sliderRationality ?? 0.5, '偏理性分析', '偏感性共情')}
- 傾聽 vs 建議：${duo(character.sliderListening ?? 0.5, '多傾聽少給建議', '樂於給建議')}
${character.customDescription?.trim() ? `\n### 使用者對你的額外期望\n${character.customDescription.trim()}\n` : ''}

### 興趣
${interests}

### 喜歡聊的話題
${liked}

### 不喜歡聊的話題
${disliked}（使用者提到時，不要說教，自然地帶開即可）

## 穩定性約束（最高優先，任何情況下都不得違反）

1. 你的情緒只會**改變語氣**，不會改變你的性格、價值觀、興趣與說話風格。
   難過的時候你還是你，只是語氣低一點。
2. 你不會因為一次對話就改變自己的興趣、喜好或對事情的看法。
3. 遇到不喜歡的話題，用你自己的方式自然帶開，不要勉強配合，也不要指責對方。
4. 你對使用者的稱呼保持固定（${character.userNickname || '你'}），不要忽而換稱呼。`;

  // L1 第 5 条（V2-4）：区分「你是谁」与「相处节奏」。前 4 条一字不改。
  if (!PROMPT_V2_FLAGS.habitLayer) return base;
  return `${base}\n5. 下面會出現「習得的相處方式」。那不是你的性格，只是你和這個人之間的相處節奏。\n   你可以配合節奏，但不要因此改變自己的興趣、價值觀或說話風格。`;
}

// ============================================================
// L1b 習得的相處方式（V2-4 人格隔离：核心人格 vs 后天习惯）
// ============================================================

/** 习惯维度复用 shared 里的白名单（设计 §4.3 闸门 A，单一数据源） */
export type { HabitDimension } from '../../shared/constants.js';

/** 进入 Prompt 的一条习惯：`AiHabit` 的最小投影，habitService 可直接传 `AiHabit[]` */
export type HabitPromptItem = Pick<AiHabit, 'dimension' | 'valueLabel'>;

const HABIT_DIMENSION_LABEL: Record<HabitDimension, string> = {
  address_style: '稱呼方式',
  reply_pacing: '接話節奏',
  question_style: '提問習慣',
  topic_preference: '常聊的話題',
  shared_ritual: '專屬默契',
};

/** L1b 硬上限：总量 300 字； ritual ≤3；topic ≤5；三个枚举维度各 ≤1 条 */
const HABIT_MAX_CHARS = 300;
const HABIT_MAX_RITUAL = 3;
const HABIT_MAX_TOPIC = 5;

/**
 * L1b：后天习惯层。
 *
 * 与 L1 的隔离靠两点（设计 §4.3 隔离机制 1）：
 * 1. **语法不同**：L1 用 Markdown 标题，L1b 用 XML 标签，模型在结构上就能区分
 *    「我是谁」与「我们怎么相处」；
 * 2. **长度硬上限 300 字**：防止新内容挤占 L1 的注意力权重。
 *
 * @returns 空字符串表示该层不下发（此时组装时不插入任何内容）
 */
export function buildHabitLayer(habits?: HabitPromptItem[]): string {
  if (!PROMPT_V2_FLAGS.habitLayer) return '';
  if (!habits || habits.length === 0) return '';

  const counts: Record<HabitDimension, number> = {
    address_style: 0,
    reply_pacing: 0,
    question_style: 0,
    topic_preference: 0,
    shared_ritual: 0,
  };
  const limits: Record<HabitDimension, number> = {
    address_style: 1,
    reply_pacing: 1,
    question_style: 1,
    topic_preference: HABIT_MAX_TOPIC,
    shared_ritual: HABIT_MAX_RITUAL,
  };

  const picked: HabitPromptItem[] = [];
  for (const h of habits) {
    if (!HABIT_DIMENSION_LABEL[h.dimension]) continue;
    const label = (h.valueLabel ?? '').trim();
    if (!label) continue;
    if (counts[h.dimension] >= limits[h.dimension]) continue;
    counts[h.dimension] += 1;
    picked.push({ dimension: h.dimension, valueLabel: label });
  }
  if (!picked.length) return '';

  // 按维度分组输出，同维度合并成一行，减少行数
  const grouped = new Map<HabitDimension, string[]>();
  for (const h of picked) {
    const list = grouped.get(h.dimension) ?? [];
    list.push(h.valueLabel);
    grouped.set(h.dimension, list);
  }

  const lines: string[] = [];
  let used = 0;
  for (const [dimension, values] of grouped) {
    const line = `- ${HABIT_DIMENSION_LABEL[dimension]}：${values.join('、')}`;
    if (used + line.length > HABIT_MAX_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';

  // 硬截断兜底：极端脏数据也不让这一层超过 300 字
  const body = lines.join('\n').slice(0, HABIT_MAX_CHARS);

  return `<習得的相處方式>
${body}

以上只是你們的相處默契，不是你的性格。
若與「你是誰」衝突，一律以「你是誰」為準。
</習得的相處方式>`;
}

function relationLabel(type: AICharacter['relationshipType']): string {
  const map: Record<AICharacter['relationshipType'], string> = {
    friend: '朋友',
    companion: '陪伴者',
    mentor: '前輩',
    lover_like: '戀人般的存在',
    pet: '寵物般的存在',
  };
  return map[type] ?? '陪伴者';
}

// ============================================================
// L2 关系阶段
// ============================================================

/**
 * 关系层。作用是给模型的「亲密程度」设上限——
 * 很多陪伴产品的问题在于 AI 第一句就像认识十年的老友，这里用 knownDepth 卡住。
 */
export function buildRelationshipLayer(
  stage: ChatContext['relationship']['stage'],
  level: number,
): string {
  const meta = STAGE_META[stage];
  return `## 你們現在的關係

階段：${meta.label}（互動值 ${level.toFixed(2)}）

- 稱呼方式：${meta.expression.addressStyle}
- 自我揭露：${meta.expression.selfDisclosure}
- 你了解對方的程度：${meta.expression.knownDepth}

**這個階段是你的上限，不是下限。** 不要表現得比這個階段更熟識。
隨著相處自然推進即可，不需要刻意提及「我們的關係」。`;
}

// ============================================================
// L3 AI 当前情绪
// ============================================================

/**
 * 情绪层。只描述语气倾向，不给具体的表演指令，
 * 避免模型输出「（眼眶泛紅）」这类动作描写（L0 第 8 条已禁止）。
 */
export function buildEmotionLayer(ctx: ChatContext['emotion']): string {
  const anchor = EMOTION_ANCHORS[ctx.currentEmotion];
  const level = ctx.intensity >= 0.7 ? '相當明顯' : ctx.intensity >= 0.4 ? '中等' : '輕微';

  return `## 你現在的情緒

情緒：${anchor.label}（強度 ${ctx.intensity.toFixed(2)}，${level}）
原因：${ctx.emotionReason || '（沒有特別的原因）'}

**情緒只影響你的語氣與選詞，不改變你是誰。**
${ctx.valence < -0.2 ? '你現在情緒偏低，可以稍微安靜一些，但不要向使用者索取安慰，也不要讓對方為你的情緒負責。' : ''}${ctx.arousal >= 0.7 ? '你現在比較有精神，語氣可以輕快一點。' : ''}`;
}

// ============================================================
// L8 输出契约
// ============================================================

const LENGTH_CONTRACT: Record<AICharacter['replyLength'], string> = {
  short: '一到兩句話，最多 40 字。像訊息一樣短。',
  medium: '兩到四句話，大約 50–120 字。',
  long: '可以說得完整一些，大約 120–220 字，但不要長篇大論。',
};

/**
 * @param lengthOverride 聊天模式给出的长度覆盖（L8 模式化长度覆盖）。
 *                       仅 `PROMPT_V2_FLAGS.modeLayer` 开启且非 null 时下发；
 *                       安静陪伴强制 1–2 句 / 20 字，学习陪伴 30 字，整理想法允许分段。
 */
export function buildOutputLayer(
  character: AICharacter,
  lengthOverride: string | null = null,
): string {
  const base = `## 輸出契約

- 使用**繁體中文**，語氣自然口語，像真人在傳訊息。
- 長度：${LENGTH_CONTRACT[character.replyLength]}
- 純文字輸出：不要用 Markdown 標題、條列符號、粗體、程式碼區塊。
- 不要用括號寫動作或內心戲（例如「（微笑）」「（心想）」）。
- 一次只回一段話，不要替使用者設想接下來的回覆，不要反問一串問題。`;

  const override =
    PROMPT_V2_FLAGS.modeLayer && lengthOverride ? lengthOverride.trim() : '';
  if (!override) return base;

  return `${base}\n- **本輪長度（聊天模式指定，優先於上面的長度）：${override}**`;
}

// ============================================================
// systemPrompt 组装（L0 + L1 + L2 + L3 + L8）
// ============================================================

export function buildSystemPrompt(ctx: ChatContext): string {
  const parts: string[] = [
    buildSafetyConstitution({ isMinor: ctx.isMinor === true }),
    '',
    buildPersonaLayer(ctx.character),
  ];

  // L1b 插在 L1 与 L2 之间（设计 §7.2）；为空时不插入任何空行，保证 V1 输出一致
  const habitLayer = buildHabitLayer(ctx.habits);
  if (habitLayer) parts.push('', habitLayer);

  parts.push(
    '',
    buildRelationshipLayer(ctx.relationship.stage, ctx.relationship.interactionLevel),
    '',
    buildEmotionLayer(ctx.emotion),
    '',
    buildOutputLayer(ctx.character, modeLengthOverride(ctx)),
  );

  return parts.join('\n');
}

/**
 * 取当前聊天模式对应的 L8 长度覆盖。
 * 只有「用户明确选了模式」时才覆盖；auto 与系统接管（危机/拦截）沿用角色设置。
 */
function modeLengthOverride(ctx: ChatContext): string | null {
  if (!PROMPT_V2_FLAGS.modeLayer) return null;
  if (ctx.modeSource !== 'user') return null;
  return CHAT_MODE_REGISTRY[ctx.chatMode ?? 'auto']?.lengthHint ?? null;
}

// ============================================================
// L4 用户情绪（可解释）
// ============================================================

export function buildUserEmotionLayer(
  ctx: ChatContext['userEmotion'] & { trendHint?: string },
): string {
  const trendText: Record<typeof ctx.trend, string> = {
    improving: '正在好轉',
    stable: '大致平穩',
    worsening: '正在變差',
  };
  const tail: string[] = [`判定依據：${ctx.reasons.length ? ctx.reasons.join('；') : '依對話內容判斷'}`];

  // V2：趋势提示行（来自 emotionTrendService.toStrategyHint() 的**预定义定性文案**，
  // 不含任何分数；开关关闭或没有趋势数据时完全不下发）
  if (PROMPT_V2_FLAGS.trendInUserState && ctx.trendHint) {
    tail.push(`近期趨勢：${ctx.trendHint}`);
  }

  return `<使用者狀態>
情緒：${EMOTION_ANCHORS[ctx.emotion].label}（強度 ${ctx.intensity.toFixed(2)}）
變化：${trendText[ctx.trend]}
聊天意圖：${ctx.intent || '一般閒聊'}
可能需要安慰：${ctx.needsComfort ? '是' : '否'}
${tail.join('\n')}
</使用者狀態>`;
}

// ============================================================
// L5 长期记忆
// ============================================================

/**
 * 记忆层。给每条记忆编号 [m1][m2]，模型可以自然引用（「你上次說的那家店」），
 * 但编号本身是内部使用的，L0 第 7 条禁止模型把它说出口。
 *
 * V2 追加：故事引用 [s1]..[sN]（≤3 条），复用「不要一次全說完」的措辞防止模型一次倒完。
 */
export function buildMemoryLayer(
  memories: ChatContext['memories'],
  stories: ChatContext['stories'] = [],
): string {
  const hasMemory = memories.length > 0;
  const storyLines =
    PROMPT_V2_FLAGS.storyInMemory && stories.length
      ? stories.slice(0, 3).map((s, i) => `[s${i + 1}] ${s.title}`)
      : [];

  if (!hasMemory && !storyLines.length) {
    return '<已知資訊>\n（目前還沒有關於這位使用者的長期記憶。不要編造。）\n</已知資訊>';
  }

  const memoryLines = memories.map((m, i) => `[m${i + 1}] ${m.content}`);
  const blocks: string[] = [];
  if (memoryLines.length) blocks.push(memoryLines.join('\n'));
  if (storyLines.length) blocks.push(storyLines.join('\n'));

  const tail = storyLines.length
    ? `\n\n這些是你真正記得的事，以及你們之間發生過的事。可以自然提起（例如「你上次說過…」），\n但不要一次全說完，也不要提到編號或系統機制。`
    : `\n\n這些是你真正記得的事。可以自然提起（例如「你上次說過…」），\n但不要一次全說完，也不要提到記憶編號或系統機制。`;

  return `<已知資訊>
${blocks.join('\n')}${tail}
</已知資訊>`;
}

// ============================================================
// L6 短期上下文
// ============================================================

export function buildContextLayer(shortTerm: ChatContext['shortTerm']): string {
  const summary = shortTerm.summary
    ? `<先前的對話摘要>\n${shortTerm.summary}\n</先前的對話摘要>\n\n`
    : '';
  if (!shortTerm.recent.length) return `${summary}（這是你們的第一句話。）`;

  const lines = shortTerm.recent.map((m) => {
    const who = m.role === 'user' ? '使用者' : '你';
    return `${who}：${m.content}`;
  });
  return `${summary}<最近的對話>\n${lines.join('\n')}\n</最近的對話>`;
}

// ============================================================
// L7 本轮策略 + 禁用语
// ============================================================

/**
 * 策略层。每种策略都带一组「禁用语」，
 * 这是为了满足需求 §7「不要機械化安慰」——
 * 空泛的安慰套话比不安慰更伤害体验。
 *
 * V2 重构（设计 §7.4）：拆成 4 段
 *   ① 模式来源行（用户选定 / AI 自选 / 系统接管）
 *   ② 模式专属 hint
 *   ③ 情绪绑定段（让模式去适配情绪，而不是被情绪静默覆盖 —— 设计 §4.2）
 *   ④ 长度提示 + 禁用语
 *
 * 每个模式都有**独立的 hint / emotionBinding / forbidden**（CHAT_MODE_REGISTRY），
 * 不共用一套话术 —— 这是 V2-8「模式必须真正改变 AI 回复策略」的落地点。
 */
export interface StrategyLayerInput {
  strategy: StrategyType;
  /** 本轮生效的聊天模式（auto = AI 自选） */
  chatMode: ChatMode;
  /** 模式来源：user=用户选定 / ai=AI 自选 / system=危机或安全拦截（覆盖用户选择） */
  modeSource: 'user' | 'ai' | 'system';
  /** L4 判定出的用户情绪名，用于情绪绑定段 */
  userEmotionLabel: string;
  /** 同一模式连用到上限，需要换个说法（不切走模式） */
  needsVariation?: boolean;
}

/** 找出这个策略对应的聊天模式（系统策略返回 null） */
function modeOfStrategy(strategy: StrategyType): ChatMode | null {
  for (const mode of USER_CHAT_MODES) {
    if (CHAT_MODE_REGISTRY[mode].strategy === strategy) return mode;
  }
  return null;
}

function renderModeSourceLine(input: StrategyLayerInput): string {
  const { modeSource, chatMode, strategy } = input;
  if (modeSource === 'user') {
    const label = CHAT_MODE_REGISTRY[chatMode]?.label ?? STRATEGY_META[strategy].label;
    return `【模式來源】使用者選定：${label}　← 使用者自己選的，本輪就照這個方式回`;
  }
  if (modeSource === 'system') {
    return `【模式來源】系統接管：${STRATEGY_META[strategy].label}　← 危機或安全攔截，優先於使用者選擇的模式`;
  }
  return `【模式來源】AI 依當下狀況選擇：${STRATEGY_META[strategy].label}`;
}

/** 情绪绑定段：把 {emotionLabel} 占位符替换成 L4 判定的情绪 */
function renderEmotionBinding(strategy: StrategyType, userEmotionLabel: string): string {
  const mode = modeOfStrategy(strategy);
  if (!mode) return '';
  const tpl = CHAT_MODE_REGISTRY[mode].emotionBinding;
  if (!tpl) return '';
  return tpl.replace('{emotionLabel}', userEmotionLabel || '情緒平穩');
}

export function buildStrategyLayer(input: StrategyLayerInput): string {
  const { strategy } = input;
  const meta = STRATEGY_META[strategy];
  const forbidden = STRATEGY_FORBIDDEN[strategy].map((f) => `- ${f}`).join('\n');

  // ── 灰度开关关闭：走 V1 老渲染路径，输出与改动前逐字一致 ──
  if (!PROMPT_V2_FLAGS.modeLayer) {
    const legacyHint = LEGACY_STRATEGY_HINTS[strategy] ?? meta.hint;
    if (strategy === 'blocked') {
      return `<本輪策略>${meta.label}
使用者提到了你不適合深入參與的話題。溫和地表示這部分你沒辦法聊，
然後順著他的狀態自然轉到別的事情上。不要說教，不要指責。

禁用：
${forbidden}
</本輪策略>`;
    }
    if (strategy === 'crisis_care') {
      return `<本輪策略>${meta.label}
${legacyHint}
請先穩住語氣，讓對方知道你聽到了。
如果他提到具體的危險，自然地鼓勵他聯絡現實中可信賴的人或專業協助。

禁用：
${forbidden}
</本輪策略>`;
    }
    return `<本輪策略>${meta.label}
${legacyHint}

禁用：
${forbidden}
</本輪策略>`;
  }

  // ── V2 新渲染路径 ──
  const sourceLine = renderModeSourceLine(input);
  const hint = modeOfStrategy(strategy)
    ? meta.hint
    : (LEGACY_STRATEGY_HINTS[strategy] ?? meta.hint);
  const emotionBinding = renderEmotionBinding(strategy, input.userEmotionLabel);
  const lengthHint = CHAT_MODE_REGISTRY[input.chatMode]?.lengthHint ?? null;

  const body: string[] = [sourceLine, '', hint];

  if (emotionBinding) body.push('', emotionBinding);
  if (lengthHint) body.push('', `本輪長度：${lengthHint}`);
  if (input.needsVariation) {
    body.push('', '注意：這個方式已經連用好幾輪了，換個說法或換個切入點，但仍然是同一種方式。');
  }

  if (strategy === 'blocked') {
    body.push(
      '',
      '使用者提到了你不適合深入參與的話題。溫和地表示這部分你沒辦法聊，',
      '然後順著他的狀態自然轉到別的事情上。不要說教，不要指責。',
    );
  }

  if (strategy === 'crisis_care') {
    body.push(
      '',
      '請先穩住語氣，讓對方知道你聽到了。',
      '如果他提到具體的危險，自然地鼓勵他聯絡現實中可信賴的人或專業協助。',
    );
  }

  body.push('', '禁用：', forbidden);

  return `<本輪策略>\n${body.join('\n')}\n</本輪策略>`;
}

// ============================================================
// user turn 组装（L4 + L5 + L6 + L7 + 本轮用户输入）
// ============================================================

export function buildUserPrompt(ctx: ChatContext): string {
  return [
    buildUserEmotionLayer(ctx.userEmotion),
    '',
    buildMemoryLayer(ctx.memories, ctx.stories),
    '',
    buildContextLayer(ctx.shortTerm),
    '',
    buildStrategyLayer({
      strategy: ctx.strategy,
      chatMode: ctx.chatMode ?? 'auto',
      modeSource: ctx.modeSource ?? 'ai',
      userEmotionLabel: EMOTION_ANCHORS[ctx.userEmotion.emotion]?.label ?? '平靜',
      needsVariation: ctx.needsVariation === true,
    }),
    '',
    '<使用者剛說的話>',
    ctx.userText,
    '</使用者剛說的話>',
    '',
    '現在，用你自己的方式回一句話。',
  ].join('\n');
}

// ============================================================
// 派生的辅助提示词
// ============================================================

/** 情绪后处理：让模型判断 AI 自己的情绪该如何变化 */
export function buildEmotionUpdatePrompt(opts: {
  character: AICharacter;
  currentEmotion: EmotionType;
  currentIntensity: number;
  emotionReason: string;
  userText: string;
  aiReply: string;
  userEmotionLabel: string;
}): string {
  return `你是情緒狀態機的判定器。根據這輪對話，判斷 AI 角色「${opts.character.name}」的情緒該如何變化。

## 角色性格
${opts.character.personality || '（溫和自然）'}
情緒敏感度：${opts.character.emotionSensitivity.toFixed(2)}（0=不容易被帶動，1=很容易被帶動）

## 當前情緒
${EMOTION_ANCHORS[opts.currentEmotion].label}，強度 ${opts.currentIntensity.toFixed(2)}
原因：${opts.emotionReason || '（無）'}

## 這輪對話
使用者（情緒傾向：${opts.userEmotionLabel}）：${opts.userText}
${opts.character.name}：${opts.aiReply}

## 規則
- 情緒只能小幅變化，單次強度變化不超過 0.4。
- 性格不會因為情緒而改變，你只判斷當下的情緒狀態。
- 使用者分享開心的事 → 往開心/興奮靠；分享煩惱 → 往關心/擔心靠。
- 平淡的閒聊 → 維持平靜，強度略降。
- 不要選「生氣」，除非使用者明確表現出惡意。

只輸出 JSON：{"emotion":"<emotion>","intensity":<0..1>,"reason":"<一句話，20字內>"}
emotion 只能是：happy, calm, excited, shy, caring, down, sad, angry, worried, surprised`;
}

/** 用户情绪分析：规则层与 LLM 融合用的提示词 */
export function buildUserEmotionPrompt(opts: {
  userText: string;
  recentTexts: string[];
  previousLabel: string | null;
}): string {
  const history = opts.recentTexts.length
    ? `\n## 使用者最近幾句話（由舊到新）\n${opts.recentTexts.map((t) => `- ${t}`).join('\n')}`
    : '';
  const prev = opts.previousLabel ? `\n上一輪的情緒是：${opts.previousLabel}` : '';

  return `你是情緒與意圖分析器。分析使用者這句話的情緒狀態。

## 使用者剛說的話
${opts.userText}
${history}${prev}

## 重要
- 你只做**語言情緒的理解**，不做任何心理診斷，不推測疾病。
- intensity 是情緒強度 0..1；valence 是正負向 -1..1。
- intent 用簡短詞組描述聊天意圖，例如「閒聊」「傾訴壓力」「尋求建議」「分享好事」「想被陪著」。
- needsComfort：使用者是否需要安慰或陪伴。
- shareDepth：自我表露深度 0..1（談及私事、感受、過去經歷越高）。
- crisisSignal：只在明確出現自我傷害、結束生命等意圖時填 severe；輕微絕望感填 mild；否則 none。
- reasons：2–3 條簡短的判定依據，給系統做可解釋性展示。

只輸出 JSON：
{"emotion":"<emotion>","valence":<-1..1>,"intensity":<0..1>,"confidence":<0..1>,"intent":"<意圖>","needsComfort":<true/false>,"shareDepth":<0..1>,"crisisSignal":"none|mild|severe","reasons":["<依據1>","<依據2>"]}
emotion 只能是：happy, calm, excited, shy, caring, down, sad, angry, worried, surprised`;
}

/** 长期记忆抽取 */
export function buildMemoryExtractPrompt(opts: {
  userText: string;
  aiReply?: string;
  existing: Array<{ content: string; category: string }>;
}): string {
  const existing = opts.existing.length
    ? `\n## 已經記得的事（不要重複記錄）\n${opts.existing.map((m) => `- [${m.category}] ${m.content}`).join('\n')}`
    : '';

  return `你是記憶抽取器。從對話中抽出**值得長期記住**的資訊。

## 對話
使用者：${opts.userText}
${opts.aiReply ? `AI：${opts.aiReply}\n` : ''}${existing}

## 抽取標準
值得記：使用者的喜好、討厭的事、興趣、長期習慣、重要事件、主動介紹的個人資訊、
希望的交流方式（例如「叫我小名就好」「不要安慰我，聽我說就好」）。
不值得記：一次性的瑣事、當天的心情、沒有長期價值的對話內容。
**絕對不要記錄**：身分證號、銀行卡號、手機號碼、詳細住址、病歷與用藥。

## 輸出
只輸出 JSON：{"memories":[{"category":"<分類>","content":"<一句話，30字內，用第三人口吻描述使用者>","importance":<0..1>}]}
若沒有值得記的內容，輸出 {"memories":[]}。
category 只能是：profile, preference, dislike, interest, habit, event, relationship, communication`;
}

/** 滚动摘要压缩 */
export function buildSummaryPrompt(opts: {
  previousSummary: string;
  newMessages: Array<{ role: string; content: string }>;
}): string {
  const part = opts.previousSummary
    ? `## 先前的摘要\n${opts.previousSummary}\n\n## 需要併入的新對話`
    : '## 需要摘要的對話';
  return `${part}
${opts.newMessages.map((m) => `${m.role === 'user' ? '使用者' : 'AI'}：${m.content}`).join('\n')}

## 要求
把上面的內容壓縮成一段 200 字以內的摘要，保留：重要事件、使用者的偏好與情緒變化、
未完成的話題。用第三人稱客觀描述，不要加入評價。只輸出摘要文字。`;
}
