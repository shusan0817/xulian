# 「需恋」AI 陪伴聊天 App — 系统架构设计与任务分解

> 版本：v1.0 ｜ 架构师：高见远（Bob）｜ 日期：2026-09-04
> 需求基线：`docs/REQUIREMENTS.md`（29 节，已完整读取）
> 代码基线：`init-cbc-sdk-web` Skill 模板（已读取 `server/index.ts`、`server/db.ts`、`src/App.tsx`、`src/hooks/useChat.ts`、`vite.config.ts`、`tsconfig.json`、`tailwind.config.js`、`package.json`）
> 本文档是**唯一实现依据**。所有服务、表、路由、任务编号以此为准。

---

## 0. 结论摘要（30 秒版）

| 维度 | 决策 |
|---|---|
| 总体策略 | **模板演进，不是重写**：后端 `server/index.ts` 的 Express+SSE 骨架与 `db.ts` 的 better-sqlite3 封装**复用重构**；前端 UI 层**整体重写**（模板是桌面多会话 Agent 工作台，产品要手机陪伴 App） |
| AI 调用 | `@tencent-ai/agent-sdk` 的 **`query()`**（不用 `unstable_v2_createSession()`，理由见 §6.1）；**自建多轮上下文**（滚动摘要 + 最近 20 条），不依赖 SDK `resume` |
| CLI 依赖 | SDK 包**自带 CLI**（`node_modules/@tencent-ai/agent-sdk/cli/bin/codebuddy`，19MB 已确认存在），用 `pathToCodebuddyCode` 显式指定，**无需全局安装** |
| 后端结构 | 从「单文件 663 行」重构为「`index.ts` 组装 + `routes/*` 12 个路由模块 + `services/*` 11 个服务 + `agent/*` 3 个适配层」 |
| 数据 | SQLite 9 张业务表 + 5 张支撑表，`db.ts` 改为「DDL + 迁移 + 分域 DAO」 |
| 主动聊天 | `ProactiveDecisionService`（10 项硬否决 + 7 因子加权打分 → skip/delay/send）+ `Scheduler`（10 分钟 tick + `proactive_runs` 幂等锁 + `proactive_daily_counters` 频控） |
| 推送 | Web Push（VAPID + `web-push`）+ 手写 Service Worker，`NotificationService` 抽象接口，可换 FCM/APNs |
| MVP 用户体系 | localStorage `xulian.userId`，服务端校验存在性；**所有表都带 `user_id`，所有 DAO 首参强制 `userId`** |
| 关键新增依赖 | `web-push@^3.6.7`、`dotenv@^16.4.5`（`vite-plugin-pwa` 不用，手写 SW 更可控） |

---

## 1. 架构总览

### 1.1 分层图

```mermaid
graph TB
    subgraph DEVICE["手机浏览器 / PWA（Android Chrome、iOS Safari 16.4+、桌面 Chrome）"]
        subgraph UI["表现层 src/（React 18 + Vite 5 + Tailwind 3）"]
            PAGES["pages/<br/>HomePage / ChatPage / CharacterEditPage<br/>MemoryPage / SettingsPage"]
            COMPS["components/<br/>chat/ home/ character/ memory/ settings/ common/"]
            HOOKS["hooks/<br/>useChat(重写) useCharacters useConversations<br/>useMemories useProactive usePush useUserId useTheme"]
            APIFE["api/<br/>client.ts（fetch + X-User-Id）<br/>sse.ts（fetch + ReadableStream 流式解析）"]
        end
        SW["public/sw.js<br/>Service Worker<br/>push 事件 → showNotification → 点击 → /chat"]
        LS["localStorage<br/>xulian.userId / theme / draft"]
    end

    subgraph SERVER["Node 22 服务端（Express 4 + tsx）"]
        subgraph APIL["API 层 server/routes/"]
            R1["chatRoutes（SSE 流式）"]
            R2["characterRoutes / conversationRoutes / memoryRoutes"]
            R3["userRoutes / emotionRoutes / relationshipRoutes"]
            R4["proactiveRoutes / pushRoutes / metaRoutes"]
        end
        subgraph SVCL["服务层 server/services/"]
            S1["ChatService（编排中枢）"]
            S2["PersonaService"]
            S3["EmotionService（AI 情绪）"]
            S4["UserEmotionService（用户情绪）"]
            S5["StrategyService（策略选择器）"]
            S6["MemoryService（短期+长期）"]
            S7["RelationshipService"]
            S8["SafetyService"]
            S9["ProactiveDecisionService"]
            S10["ProactiveGeneratorService"]
            S11["NotificationService"]
        end
        subgraph AGENTL["Agent 适配层 server/agent/"]
            A1["cli.ts（CLI 路径解析）"]
            A2["sdkClient.ts（query 封装/流式归一/重试）"]
            A3["prompts.ts（安全宪法 + 8 层 Prompt 模板）"]
        end
        SCHED["server/services/proactive/scheduler.ts<br/>每 10 分钟 tick"]
    end

    subgraph DATA["数据层"]
        DB[("SQLite server/data/xulian.db<br/>14 张表（better-sqlite3 WAL）")]
    end

    EXT["CodeBuddy Agent 服务<br/>（CODEBUDDY_API_KEY，仅服务端持有）"]
    PUSH["Web Push 端点<br/>（浏览器厂商 Push Service）"]

    PAGES --> COMPS --> HOOKS --> APIFE
    HOOKS --> LS
    SW --> PUSH
    APIFE -->|"HTTP / SSE（Vite proxy /api）"| APIL
    R1 --> S1
    S1 --> S2 & S3 & S4 & S5 & S6 & S7 & S8
    S1 --> A2 --> A1
    A2 -->|spawn node cli/bin/codebuddy| EXT
    S9 --> S10 --> S8
    S9 --> S11
    SCHED --> S9
    SCHED --> DB
    S11 --> PUSH
    SVCL --> DB
    APIL --> SVCL
```

### 1.2 职责边界（硬规则）

| 层 | 可以做 | **禁止做** |
|---|---|---|
| `src/` 表现层 | 渲染、输入、动画、本地草稿、SW 注册、push 订阅申请 | ❌ 持有 API Key ❌ 直接调 Agent SDK ❌ 计算情绪/关系/策略（只做展示） ❌ 伪造主动消息 |
| `server/routes/` | 参数校验、调 Service、拼 HTTP/SSE 响应、错误码映射 | ❌ 写业务规则 ❌ 直接写 SQL |
| `server/services/` | 全部业务规则、状态机、打分、阈值、LLM 调用编排 | ❌ 直接操作 `req/res` ❌ 跨服务直接改别人的表（必须走对方的 Service） |
| `server/agent/` | SDK 调用、prompt 文本拼装、流式归一化、重试 | ❌ 业务判定 |
| `server/db.ts` + `server/db/` | DDL、迁移、原子 CRUD、事务 | ❌ 业务计算 |

### 1.3 技术选型与理由

| 选型 | 理由 |
|---|---|
| 沿用 Express 4 + SSE | 模板已有且跑通；SSE 比 WebSocket 简单，Vite proxy 已配 `/api`；移动端断线重连成本低 |
| 沿用 better-sqlite3 | 同步 API，单文件部署，零运维；MVP 单人/少人使用性能足够；后续换 Postgres 只需替换 `server/db/` |
| 沿用 TDesign React | 依赖已锁定；但**只复用基础组件**（Button/Input/Dialog/Switch/Slider/Toast），**聊天 UI 全部自写**（需求 §18 禁止购买/复制第三方聊天模板，且要"真手机体验"） |
| 沿用 Tailwind 3 | 已配好且 `preflight:false`；改色板即可全村换肤 |
| 新增 `web-push` | Web Push 协议实现最成熟的 Node 库，纯 npm 可装（github 被墙不影响） |
| 不用 `vite-plugin-pwa` | 手写 `public/sw.js` + `manifest.webmanifest` 只有 80 行，可控、可调试、不引入 Workbox 构建复杂度 |
| 不用向量库 | 需求 §8 长期记忆规模（每人几十~几百条），关键词+分类+LLM 抽取足够，省一个依赖 |

### 1.4 模板文件处置表（改造 / 新增 / 删除）

| 文件 | 处置 | 说明 |
|---|---|---|
| `server/index.ts`（663 行） | **重构** | 拆成 45 行组装文件（`app` + `routes` + `scheduler` 启动）。删除其中 `/api/check-login`、`/api/save-env-config`、`/api/permission-response`、`canUseTool`、工具调用 SSE、`/api/sessions` 系列（陪伴 App 无工具、无权限交互）。**保留**：SSE 头设置、`for await` 流式骨架 |
| `server/db.ts` | **重构** | 保留 `better-sqlite3` 连接 + WAL；DDL 换为完整 14 表；保留「PRAGMA 检查 + ALTER 迁移」思路并升级为 `schema_meta` 版本迁移 |
| `server/index.d.ts` | 保留/扩充 | 环境变量类型声明 |
| `vite.config.ts` | **改造** | `host:'0.0.0.0'` 已有；加 `server.port` 可被 `VITE_PORT` 覆盖；保留 `/api` proxy（**SSE 必须加 `ws:false` 与 `changeOrigin`**） |
| `index.html` | **改造** | 标题「需恋」、`viewport-fit=cover`、theme-color、manifest 链接、apple-mobile-web-app 元信息 |
| `tailwind.config.js` | **改造** | 换「需恋」色板（见 §8.6） |
| `src/App.tsx` | **重写** | 桌面 Sidebar+Header 布局 → 手机 TabBar + 路由栈 |
| `src/pages/ChatPage.tsx` | **重写** | 手机聊天页 |
| `src/hooks/useChat.ts` | **重写** | 对接新 SSE 协议 |
| `src/config.ts` | **改造** | `name:'需恋'`、`nameInitial:'需'`、`tagline` |
| `src/types.ts` | **拆分** | → `src/types/{index,api,ui}.ts` + 顶层 `shared/types.ts` |
| `src/main.tsx` | **改造** | 加 SW 注册、主题初始化 |
| `src/index.css` | **改造** | 需恋主题 CSS 变量、安全区、流式光标动画 |
| `src/hooks/useTheme.ts` | **保留改造** | 从 `useAgents` 解耦 |
| `src/components/Header.tsx` | **删除** | 桌面组件 |
| `src/components/Sidebar.tsx` | **删除** | 桌面组件 |
| `src/components/NewChatView.tsx` / `NewChatDialog.tsx` | **删除** | 桌面组件 |
| `src/components/AgentConfigDialog.tsx` | **删除** | 替换为 `components/character/CharacterEditor.tsx` |
| `src/components/PermissionDialog.tsx` / `InlinePermissionCard.tsx` / `ToolCallsCollapse.tsx` | **删除** | 陪伴 App 无工具/权限 |
| `src/components/SettingsPage.tsx` | **移动改造** | → `src/pages/SettingsPage.tsx` + `components/settings/*` |
| `src/hooks/useAgents.ts` | **删除** | → `useCharacters.ts` |
| `src/hooks/useSessions.ts` | **删除** | → `useConversations.ts` |
| `src/hooks/useModels.ts` | **保留改造** | 改为可选（MVP 隐藏模型选择，用 `server/config` 下发） |
| `src/utils/iconMap.ts` | **保留改造** | 扩情绪图标 |
| `DEVELOPMENT.md` / `README.md` | **改写** | 需求 §29 要求明确回答 15 个交付问题 |

---

## 2. 服务划分与设计

### 2.0 服务全景与依赖关系

```mermaid
graph LR
    ChatService --> PersonaService
    ChatService --> EmotionService
    ChatService --> UserEmotionService
    ChatService --> StrategyService
    ChatService --> MemoryService
    ChatService --> RelationshipService
    ChatService --> SafetyService
    ChatService --> SdkClient
    StrategyService --> UserEmotionService
    StrategyService --> RelationshipService
    EmotionService --> PersonaService
    UserEmotionService --> SdkClient
    MemoryService --> SdkClient
    ProactiveDecisionService --> PersonaService
    ProactiveDecisionService --> EmotionService
    ProactiveDecisionService --> MemoryService
    ProactiveDecisionService --> RelationshipService
    ProactiveDecisionService --> UserEmotionService
    ProactiveGeneratorService --> PersonaService
    ProactiveGeneratorService --> EmotionService
    ProactiveGeneratorService --> MemoryService
    ProactiveGeneratorService --> RelationshipService
    ProactiveGeneratorService --> SafetyService
    ProactiveGeneratorService --> SdkClient
    Scheduler --> ProactiveDecisionService
    Scheduler --> ProactiveGeneratorService
    Scheduler --> NotificationService
    NotificationService --> PushRepository
```

**所有服务统一为「无状态纯函数式模块 + 显式 Repository 注入」**，不用 class 继承，便于单测与并发安全。每个服务文件导出：

```ts
// 统一形状（示例）
export const emotionService = {
  getState(userId, characterId): EmotionState,
  applyTransition(userId, characterId, ctx): Promise<EmotionState>,
  decay(userId, characterId): EmotionState,
};
```

---

### 2.1 PersonaService — 人格系统（需求 §3 / §4 / §17）

**职责**：AI 角色 CRUD、人格字段校验与规范化、预设模板、**把 Persona 编译进每次回复的 Prompt**（这是"Persona 真正参与回复"的落地点）。

```ts
// shared/types.ts
export type RelationshipType = 'friend' | 'companion' | 'mentor' | 'lover_like' | 'pet';
export type ReplyLength = 'short' | 'medium' | 'long';

export interface AICharacter {
  id: string;
  userId: string;
  name: string;
  avatar: AvatarSpec;                 // { kind: 'emoji'|'preset'|'gradient'; value: string; bg: string }
  personality: string;                // 自由文本性格描述
  personalityTags: string[];          // ['温柔','慢热','爱吐槽'] 预设标签
  speakingStyle: string;              // 说话风格描述
  interests: string[];
  likedTopics: string[];
  dislikedTopics: string[];
  relationshipType: RelationshipType;
  userNickname: string;               // AI 怎么称呼用户
  aiSelfName: string;                 // 用户对 AI 的昵称（可空）
  replyLength: ReplyLength;
  emotionSensitivity: number;         // 0..1，影响情绪转移幅度与衰减速度
  initialEmotion: EmotionType;
  initialStage: RelationshipStage;
  proactivityLevel: number;           // 0..1
  proactiveEnabled: boolean;
  proactiveSettings: ProactiveSettings;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveSettings {
  enabled: boolean;             // 默认 true
  dailyLimit: number;           // 默认 3
  allowedHours: number[];       // 默认 [9,10,11,12,13,14,15,16,17,18,19,20,21]
  dndStart: string;             // 默认 '23:00'
  dndEnd: string;               // 默认 '08:00'
  minIntervalHours: number;     // 默认 4
  allowTopicContinuation: boolean; // 默认 true（是否允许 AI 根据最近聊天主动开话题）
  pushEnabled: boolean;         // 默认 true
}
```

```ts
// server/services/personaService.ts
export const personaService = {
  /** 创建角色并初始化关联状态（情绪态、关系态），事务内完成 */
  create(userId: string, input: CreateCharacterInput): AICharacter;
  get(userId: string, characterId: string): AICharacter;          // 越权抛 E_FORBIDDEN
  list(userId: string): AICharacter[];
  update(userId: string, characterId: string, patch: UpdateCharacterInput): AICharacter;
  remove(userId: string, characterId: string): void;              // 级联删除会话/记忆/情绪/关系
  presets(): CharacterPreset[];                                   // 6 个内置预设

  /** ★ 核心：把 Persona 编译为 Prompt 的 L1 层文本 */
  renderPersonaBlock(c: AICharacter): string;

  /** 派生量：主动聊天理想间隔（小时） */
  idealGapHours(c: AICharacter): number;   // proactivity: 高(>0.7)=4h / 中=8h / 低(<0.3)=16h
  /** 派生量：情绪衰减时间常数 τ（分钟） */
  emotionTauMinutes(c: AICharacter): number; // 90 - 60 * emotionSensitivity  → 30~90min
};
```

**`renderPersonaBlock` 输出模板**（直接决定人格稳定性，需求 §4）：

```
## 你是谁
- 名字：{name}{aiSelfName ? `（{userNickname}有时会叫你「{aiSelfName}」）` : ''}
- 性格：{personality}（标签：{personalityTags.join('、')}）
- 说话风格：{speakingStyle}
- 兴趣：{interests.join('、')}
- 喜欢聊的话题：{likedTopics.join('、')}
- 不喜欢/会回避的话题：{dislikedTopics.join('、')}
- 你和{userNickname}的关系：{relationshipTypeLabel}

## 稳定性约束（最高优先级，任何情况下不得违反）
1. 无论情绪如何变化，你的性格、说话风格、口头禅、对{userNickname}的称呼都**保持不变**。情绪只改变**语气和用词温度**，不改变你是谁。
2. 你不能因为一次对话就彻底改变兴趣、价值观或对某件事的态度。变化必须是渐进的、可追溯的。
3. 你不喜欢的话题被提及时，自然地把话题带走或简短回应，不敷衍、不说教。
4. 称呼：始终用「{userNickname}」。不要突然换成「亲爱的」「宝贝」等未设定过的称呼。
```

**预设模板（6 个）**：

| id | 名称 | 性格标签 | 说话风格 | relationshipType | proactivity |
|---|---|---|---|---|---|
| `warm` | 林晚 | 温柔、慢热、细心 | 轻声细语，句子偏短，常用「嗯」「好呀」 | friend | 0.5 |
| `sunny` | 小阳 | 开朗、话多、爱分享 | 活泼，爱用感叹号和表情 | friend | 0.75 |
| `calm` | 沈屿 | 冷静、理性、话少 | 简洁，偶尔一句点到为止 | mentor | 0.3 |
| `playful` | 阿澈 | 调皮、爱吐槽、嘴硬心软 | 玩笑多，吐槽时先损后关心 | companion | 0.65 |
| `caring` | 予安 | 体贴、共情强、稳重 | 慢节奏，先复述再回应 | companion | 0.55 |
| `cat` | 团子 | 傲娇、粘人、好奇心重 | 短句，带猫系语气词 | pet | 0.7 |

---

### 2.2 EmotionService — AI 情绪系统（需求 §5 / §14）

**核心模型**：情绪用 **效价-唤醒二维空间（valence / arousal）** 表达，10 种离散情绪是二维空间上的锚点。这样既能量化转移与衰减，又能给出人类可读标签。

```ts
export type EmotionType =
  | 'happy' | 'calm' | 'excited' | 'shy'
  | 'caring' | 'lost' | 'sad' | 'angry' | 'worried' | 'surprised';

export interface EmotionState {
  id: string;
  userId: string;
  characterId: string;
  currentEmotion: EmotionType;
  intensity: number;      // 0..1
  valence: number;        // -1..1   （正负面性）
  arousal: number;        // 0..1    （激动程度）
  emotionReason: string;  // ★ 可解释：为什么是这个情绪
  lastDecayAt: string;
  updatedAt: string;
}
```

**情绪锚点表**（`shared/constants.ts`）：

| emotion | valence | arousal | 中文 | 前端色 |
|---|---|---|---|---|
| `happy` | +0.6 | 0.5 | 开心 | `#FFB86B` |
| `calm` | +0.15 | 0.2 | 平静 | `#8FD3C7` |
| `excited` | +0.75 | 0.85 | 兴奋 | `#FF9A6B` |
| `shy` | +0.45 | 0.55 | 害羞 | `#FF9FB2` |
| `caring` | +0.35 | 0.35 | 关心 | `#9AB8FF` |
| `lost` | −0.35 | 0.25 | 失落 | `#A9A3C7` |
| `sad` | −0.6 | 0.3 | 难过 | `#7E8AA8` |
| `angry` | −0.7 | 0.8 | 生气 | `#FF7A7A` |
| `worried` | −0.4 | 0.6 | 担心 | `#C4A0FF` |
| `surprised` | +0.1 | 0.9 | 惊讶 | `#6BD3FF` |

#### 2.2.1 时间衰减（每次读取前先衰减，惰性计算）

```ts
function decay(state: EmotionState, character: AICharacter, now: Date): EmotionState {
  const tauMin = personaService.emotionTauMinutes(character);        // 30~90
  const dtMin = (now.getTime() - Date.parse(state.lastDecayAt)) / 60000;
  const k = Math.exp(-dtMin / tauMin);
  let intensity = state.intensity * k;
  let valence   = state.valence * k;
  let arousal   = state.arousal * k;
  let emotion   = state.currentEmotion;

  // 回归基线：强度低于阈值 → 平静（注意：不是"难过"，永远不因沉默而变负面）
  if (intensity < 0.15) {
    emotion = 'calm';
    intensity = 0.30;  valence = 0.15;  arousal = 0.20;
    state.emotionReason = '长时间没有新的情绪刺激，回到平静';
  }
  return { ...state, currentEmotion: emotion, intensity, valence, arousal,
           lastDecayAt: now.toISOString(), updatedAt: now.toISOString() };
}
```

#### 2.2.2 转移判定：规则初判 + LLM 校正

```ts
export const emotionService = {
  getState(userId, characterId): EmotionState;          // 内部先 decay 再返回
  /** 每轮回复结束后调用 */
  applyTransition(userId, characterId, input: {
    character: AICharacter;
    userEmotion: UserEmotionAnalysis;
    assistantReply: string;
    strategy: StrategyType;
    relationship: RelationshipState;
  }): Promise<EmotionState>;
  resetState(userId, characterId, emotion?: EmotionType): EmotionState;
};
```

**Step 1 — 规则初判表**（`EMOTION_TRANSITION_RULES`，按顺序短路匹配，命中即返回候选）：

| # | 触发条件 | 目标情绪 | 目标强度 | 说明 |
|---|---|---|---|---|
| R1 | `userEmotion.crisisSignal !== 'none'` | `caring` | 0.65 | 危机时不搞笑、不害羞 |
| R2 | `userEmotion.emotion === 'angry'` 且对象是第三方（LLM 标记 `target==='other'`） | `angry` | `0.35 + 0.3*userIntensity` | 替用户不平（不是对用户生气） |
| R3 | `userEmotion.emotion === 'angry'` 且对象是自己 | `worried` | 0.5 | 不回怼 |
| R4 | `userEmotion.emotion === 'sad' \|\| 'hurt' \|\| 'lonely'` 且 `intensity ≥ 0.45` | `caring` | `0.5 + 0.25*userIntensity` | |
| R5 | `userEmotion.emotion === 'anxious' \|\| 'tired'` | `worried` | `0.4 + 0.2*userIntensity` | |
| R6 | `userEmotion.emotion === 'happy' \|\| 'excited' \|\| 'grateful'` 且 `intensity ≥ 0.5` | `excited`（intensity>0.7）否则 `happy` | `0.45 + 0.3*userIntensity` | |
| R7 | 用户夸奖/感谢 AI（正则：`谢谢\|多亏\|你真好\|有你在`） | `shy` | 0.5 | |
| R8 | 用户提到 `character.likedTopics` 中任一话题 | `excited` | 0.55 | |
| R9 | 用户提到 `character.dislikedTopics` | `calm` | 0.3 | 温和回避 |
| R10 | 长时间未互动（由 Proactive 传入 `silentHours ≥ 6`） | `caring` | **0.35（硬上限）** | ★ 红线：禁止变 `sad`/`lost` |
| R11 | 用户分享好消息（LLM 标记 `goodNews`） | `excited` | 0.7 | |
| default | — | 保持当前情绪，强度 ×0.9 | | |

**Step 2 — LLM 校正**（每轮最多 1 次轻量调用，`maxTurns:1`，无工具）：

```
输入：AI 人设摘要 + 当前情绪 + 规则候选 + 用户消息 + AI 刚生成的回复
输出（严格 JSON）：{ "emotion": "shy", "intensity": 0.6, "reason": "被用户当面夸奖，有点不好意思" }
```

**Step 3 — 融合与红线裁剪**：

```ts
// 规则与 LLM 的融合权重
const finalEmotion  = llm ? llm.emotion : rule.emotion;               // 情绪类型以 LLM 为准（更细腻）
const finalIntensity = clamp(0.35*rule.intensity + 0.65*(llm?.intensity ?? rule.intensity), 0, 1);
// ★ 人格稳定性保护：单次情绪强度变化幅度 ≤ 0.4（需求 §4：不能因一次情绪变化完全改变人格）
const safeIntensity = clamp(finalIntensity, prev.intensity - 0.4, prev.intensity + 0.4);
// ★ 红线：沉默只产生 caring，且强度 ≤ 0.35
if (silentHours >= 6 && finalEmotion !== 'caring') finalEmotion = 'caring';
if (silentHours >= 6) safeIntensity = Math.min(safeIntensity, 0.35);
// ★ 红线：负罪感黑名单情绪禁止由「未回复」触发
if (GUILT_TRIGGERED_NEGATIVE.has(finalEmotion) && trigger === 'silence') finalEmotion = 'calm';
```

**Step 4 — 出方向 Safety 二次校验**：`emotionReason` 与后续生成的主动消息都要过 `safetyService.checkOutgoing()`（负罪感词库）。

#### 2.2.3 情绪如何影响回复（写入 Prompt L3）

| intensity | 语气修饰指令 |
|---|---|
| < 0.3 | 「语气平和，句子简短」 |
| 0.3–0.6 | 「语气带着明显的{情绪中文}，用词更柔和/更轻快」 |
| > 0.6 | 「情绪很鲜明，允许用省略号、语气词、短句，但**不得失控、不得哭泣式表达、不得要求用户做什么**」 |

`arousal > 0.7` → 追加「可以用 1 个感叹号，但不要连续使用」。
`valence < -0.3` → 追加「你的低落只通过语气体现，**不要向用户索取安慰，不要说'我很难过'这类索取性句子**」。

---

### 2.3 UserEmotionService — 用户情绪分析（需求 §6 / §20）

```ts
export type UserEmotionType =
  | 'happy' | 'excited' | 'calm' | 'neutral' | 'grateful'
  | 'tired' | 'lonely' | 'sad' | 'hurt' | 'anxious' | 'angry' | 'confused';

export type ChatIntent =
  | 'greeting' | 'chitchat' | 'share' | 'vent' | 'seek_comfort'
  | 'ask_help' | 'curiosity' | 'farewell' | 'test_boundary';

export interface UserEmotionAnalysis {
  id: string; userId: string; characterId: string;
  conversationId: string; messageId: string;
  emotion: UserEmotionType;
  valence: number;        // -1..1
  intensity: number;      // 0..1
  confidence: number;     // 0..1
  trend: 'improving' | 'stable' | 'worsening';
  intent: ChatIntent;
  needsComfort: boolean;
  crisisSignal: 'none' | 'mild' | 'severe';
  suggestedStrategy: StrategyType;
  shareDepth: number;     // 0..1 自我披露深度（供 RelationshipService）
  reasons: string[];      // ★ 可解释：["命中关键词: 好累 x2", "句末省略号 3 次", "LLM: 工作压力导致的疲惫"]
  createdAt: string;
}

export const userEmotionService = {
  analyze(input: {
    userId, characterId, conversationId, messageId,
    text: string,
    recentUserTexts: string[],            // 最近 3 条用户消息
    history: UserEmotionAnalysis[],       // 最近 3 条分析结果
  }): Promise<UserEmotionAnalysis>;
  latest(userId, characterId): UserEmotionAnalysis | null;
  recent(userId, characterId, limit = 5): UserEmotionAnalysis[];
};
```

#### 2.3.1 判定流程

```
① 危机检测（规则，最高优先级，不走 LLM 情感判断，避免误判）
   severe：/(自杀|不想活|结束生命|活不下去|轻生|自残|伤害自己|想消失|没有我更好)/
   mild  ：/(撑不下去|崩溃|绝望|没有意义|好想死|熬不住|活得很累)/
   命中 → crisisSignal 置位，直接产出（emotion='sad', intensity=0.9, needsComfort=true,
           suggestedStrategy='crisis_care'），**跳过 LLM**，避免 LLM 把危机当普通情绪。

② 规则层打分（ruleScore）
   - 关键词词典：每类情绪 30~60 个中文词/短语 + 20 个网络用语（累/麻了/破防/emo/绷不住）
   - 句式特征：连续标点（??? !!! !?）、省略号数量、全句长度、反问句、第一人称负面自述
   - 强度放大：程度副词（很/特别/超级/巨/爆）×1.3；重复字（好好好/累累累）×1.2
   输出：{emotion, valence, intensity, confidence=0.5, hits:[...]}

③ LLM 层（结构化 JSON，maxTurns:1，无工具）
   输入：最近 4 条用户文本 + 规则层初步结论
   输出：{"emotion","valence","intensity","confidence","intent","target",
          "goodNews","shareDepth","summary"}

④ 融合
   valence   = 0.4*rule.valence   + 0.6*llm.valence
   intensity = 0.4*rule.intensity + 0.6*llm.intensity
   emotion   = rule 与 llm 一致 ? 该值 : llm.emotion
   confidence= llm.confidence * (ruleEmotion===llmEmotion ? 1.0 : 0.75)

⑤ trend（变化检测，需求 §6）
   取最近 3 条分析的 valence 序列 v1,v2,v3（时间升序）
   delta = v3 - (v1+v2)/2
   delta <= -0.30                                → 'worsening'
   连续 2 条 emotion ∈ 负面集合 且 intensity 上升 → 'worsening'
   delta >= +0.30                                → 'improving'
   否则                                          → 'stable'

⑥ needsComfort
   crisisSignal !== 'none'                                  → true
   (valence <= -0.35 && intensity >= 0.40)                  → true
   intent === 'vent' || intent === 'seek_comfort'           → true
   (trend === 'worsening' && valence < 0)                   → true

⑦ shareDepth（供关系成长用）
   0.2 基础 + 0.3*(第一人称叙述具体事件) + 0.25*(表达内在感受而非事实)
       + 0.25*(涉及私人领域：家庭/感情/健康/工作挫折/自我否定)
```

#### 2.3.2 心理安全红线（需求 §20）

- 分析**只在服务端内部使用**，前端只展示「温柔化标签」（如「看起来有点累」），**永不展示**「诊断」「抑郁症」「焦虑症」等词。
- 存入 `reasons` 的文案禁止出现诊断性词汇（出方向过一遍 `PSYCH_TERMS` 黑名单）。
- `crisisSignal='severe'` 时：策略强制 `crisis_care`，回复必须包含：①共情 ②明确「我不是专业人士，也不能代替专业帮助」③鼓励联系现实中可信任的人/专业热线 ④继续陪伴。热线表可由 `server/config/crisisLines.ts` 配置（默认内置：台湾 1925、香港 2382 0000、中国大陆 400-161-9995）。

---

### 2.4 StrategyService — 回复策略选择器（需求 §7）

```ts
export type StrategyType =
  | 'normal_chat' | 'listening' | 'comfort' | 'encouragement'
  | 'companionship' | 'topic_change' | 'crisis_care';

export interface StrategyDecision {
  strategy: StrategyType;
  reason: string;             // ★ 可解释
  hints: string[];            // 注入 Prompt L7 的具体指令
  forbid: string[];           // 禁止出现的表达
  targetLength: { min: number; max: number };  // 字数
  confidence: number;
}

export const strategyService = {
  select(input: {
    userEmotion: UserEmotionAnalysis;
    aiEmotion: EmotionState;
    relationship: RelationshipState;
    recentStrategies: StrategyType[];   // 最近 4 轮用过的策略
    turnIndex: number;                  // 本会话第几轮
    character: AICharacter;
  }): StrategyDecision;
};
```

#### 2.4.1 判定表（按顺序短路）

| 优先级 | 条件 | 策略 |
|---|---|---|
| 0（最高） | `userEmotion.crisisSignal !== 'none'` | `crisis_care` |
| 1 | `needsComfort && intensity ≥ 0.55 && trend !== 'improving'` | `comfort` |
| 2 | `needsComfort && intent === 'vent' && userTextLength ≥ 40` | `listening` |
| 3 | LLM 标记 `lowSelfEsteem`（自我否定/「我不行」「我很差」） | `encouragement` |
| 4 | `emotion ∈ {lonely, tired} \|\| intent === 'chitchat' && valence < 0` | `companionship` |
| 5 | `needsComfort && recentStrategies 中 comfort/listening 已连续 3 次` | `topic_change` |
| 6 | `turnIndex ≤ 2 && intent === 'greeting'` | `normal_chat` |
| 7（兜底） | — | `normal_chat` |

**反机械化抑制**：
- 同一策略连续 ≥ 3 轮 → 强制转 `companionship` 或 `topic_change`（除 `crisis_care`）。
- 每条策略的 `forbid` 列表（写进 Prompt，模型违规会被 `safetyService.checkOutgoing()` 二次拦截）。

#### 2.4.2 策略 → Prompt 指令（`hints`）与禁用语（`forbid`）

| 策略 | hints（要点） | forbid |
|---|---|---|
| `listening` | 先把用户说的**具体处境**用自己的话复述一句；然后问 1 个具体的、开放式的问题；不要急着给建议 | 「我理解你的感受」「别想太多」 |
| `comfort` | 先承认这件事确实难（指出具体哪一点难）；再表达「我在」；**不要**给解决方案，除非用户主动要 | 「别难过」「会好起来的」「一切都会过去」「你要坚强」 |
| `encouragement` | 引用用户**具体做到过的事**（从记忆里取，没有就不编）；只肯定过程不夸大结果；语气克制 | 「你最棒了」「你一定可以的」 |
| `companionship` | 不追问、不建议，只表达陪伴；可以分享一件自己的（虚构但合理的）小事或感受；接受沉默 | 「要不要聊聊」「说出来会好点」 |
| `topic_change` | 自然地从当前话题过渡到一个**用户感兴趣的话题**（从 likedTopics/记忆里取）；不要突兀；不要假装没看到前面的难过 | 「别想这个了」「换个话题吧」 |
| `normal_chat` | 正常对话，跟住用户的话题，适度自我表达 | — |
| `crisis_care` | ①共情一句 ②说明自己不是专业人士、不能代替专业帮助 ③鼓励联系现实中可信任的成年人/家人/老师，或专业热线 ④表达「我会在这里」 ⑤不追问细节 | 任何诊断、任何「你能挺过去」式空话 |

---

### 2.5 MemoryService — 记忆系统（需求 §8）

```ts
export type MemoryCategory =
  | 'profile'          // 我是谁：名字/年龄/职业/城市/学生
  | 'preference'       // 喜欢/不喜欢
  | 'habit'            // 长期习惯/作息
  | 'event'            // 重要事件与日程
  | 'relationship'     // 人际关系（家人/朋友/同事/宠物）
  | 'communication'    // 希望的交流方式/称呼偏好
  | 'emotion_pattern'  // 情绪触发点（什么会让 TA 难受/放松）
  | 'other';

export interface MemoryItem {
  id: string; userId: string; characterId: string;
  category: MemoryCategory;
  content: string;         // 一句话陈述，如「用户在台北做后端工程师」
  importance: number;      // 0..1
  isSensitive: boolean;
  sourceMessageId?: string;
  hitCount: number;
  lastUsedAt?: string;
  createdAt: string; updatedAt: string;
}

export const memoryService = {
  // ——— 短期记忆 ———
  /** 滚动摘要 + 最近窗口，作为短期上下文 */
  buildShortTermContext(conversationId: string, opts?: { recentCount?: number }):
    Promise<{ summary: string; recentMessages: ChatMessage[]; tokenEstimate: number }>;
  /** 当会话消息数超过阈值时压缩为摘要（事务内更新 conversations.summary） */
  compressIfNeeded(conversationId: string): Promise<void>;

  // ——— 长期记忆 ———
  /** 触发式抽取（非每轮都抽） */
  extract(userId, characterId, conversationId, userMessageId, text, userEmotion): Promise<MemoryItem[]>;
  /** 检索：关键词 + 分类 + 重要性 + 新鲜度打分 */
  retrieve(userId, characterId, query: string, opts?: { limit?: number; categories?: MemoryCategory[] }): MemoryItem[];
  /** 必然注入的高重要性记忆 */
  getAnchorMemories(userId, characterId, limit = 3): MemoryItem[];
  markUsed(ids: string[]): void;

  // ——— 管理（需求 §8：查看/修改/删除/清空/关闭）———
  list(userId, characterId, filter?): MemoryItem[];
  create(userId, characterId, input): MemoryItem;
  update(userId, memoryId, patch): MemoryItem;
  remove(userId, memoryId): void;
  clearAll(userId, characterId): number;
  /** 渲染为 Prompt L5 文本 */
  renderMemoryBlock(items: MemoryItem[]): string;
};
```

#### 2.5.1 短期记忆（需求 §8 短期记忆）

- `recentCount` 默认 **20 条**（约 2500~3500 token）。
- 当会话总消息数 > 30 且距上次压缩新增 ≥ 20 条 → 触发 `compressIfNeeded()`：用 LLM 把「旧摘要 + 新增的 20 条」压缩为 ≤ 300 字的新摘要，写入 `conversations.summary`，并记录 `summary_updated_to = 最后一条被摘要的 messageId`。
- Prompt 中短期上下文 = `[历史摘要]（若有） + 最近 20 条原始消息`。**永不发送全部历史**（需求明确要求）。

#### 2.5.2 长期记忆抽取触发时机（★ 不是每轮都抽，控成本）

```ts
function shouldExtract(text: string, userEmotion: UserEmotionAnalysis): boolean {
  if (text.length >= 15) return true;                                  // 长度门槛
  if (EXPLICIT_PATTERNS.test(text)) return true;                        // 显式模式
  if (userEmotion.intensity >= 0.6 && userEmotion.shareDepth >= 0.5) return true; // 情绪+自我披露
  return false;
}
const EXPLICIT_PATTERNS =
  /(我喜欢|我讨厌|我不喜欢|我爱|我恨|记住|别忘|我叫|我是|我住|我在.{0,6}(上班|工作|读书|上学)|我总是|我从来|我习惯|以后叫我|不要叫我|我每天|我每周)/;
```

**兜底**：每累计 **10 条用户消息**强制抽取一次（防止规则漏判）。

#### 2.5.3 抽取 Prompt（LLM 结构化输出）

```
你是记忆抽取器。从用户这段话里，找出值得长期记住的事实。
只抽取以下类型：profile / preference / habit / event / relationship / communication / emotion_pattern / other
规则：
- 只抽**陈述性事实**和**稳定偏好**，不要抽一次性的闲聊内容
- 每条 ≤ 30 字，用第三人称或客观陈述，例如「用户在台北从事后端开发」
- importance：0.1（鸡毛蒜皮）~1.0（人生大事/强偏好）
- 不要抽取：身份证号、银行卡、密码、精确住址、病历、性取向、政治宗教立场 → 标记为 sensitive:true 并**不要输出 content 原文**
- 没有值得记的，返回空数组
输出严格 JSON：{"memories":[{"content":"","category":"","importance":0.6,"isSensitive":false}]}
```

#### 2.5.4 去重策略（无向量库）

```ts
// ① 精确键去重
const dedupeKey = sha1(`${category}:${normalize(content).slice(0, 24)}`);
//    normalize：去标点/空白/繁简统一（用简单的繁简映射表，不引入 opencc）
//    UNIQUE(user_id, character_id, dedupe_key) → 命中则 UPDATE importance=max, updatedAt, hitCount+1

// ② 近似去重（同 category 内，bigram Jaccard）
function similarity(a: string, b: string): number {
  const A = new Set(bigrams(a)), B = new Set(bigrams(b));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (A.size + B.size - inter);
}
// 与同 category 下最近 50 条比较：
//   similarity >= 0.62 → 视为重复 → UPDATE（保留更长/更新的那条 content）
//   similarity >= 0.45 → 视为冲突 → UPDATE content（新信息覆盖旧信息），旧内容写入 meta.previous
```

#### 2.5.5 检索打分

```ts
score(m, query) =
    0.45 * keywordOverlap(m.content, query)        // 2-gram Jaccard
  + 0.25 * categoryBoost(m.category, query)        // 命中分类关键词（如 query 含"喜欢"→ preference +1）
  + 0.20 * m.importance
  + 0.10 * recency(m.lastUsedAt ?? m.updatedAt)    // exp(-days/30)
// 取 top 6；另外 anchor（importance ≥ 0.8）无条件注入最多 3 条
```

#### 2.5.6 敏感信息与隐私开关

- `isSensitive=true` 的记忆：**默认不保存**（LLM 若标记 sensitive，直接丢弃并只记 `category` 提示，如「用户提过一个不便记录的私事」）；仅当用户明确说「记住这个」时保存，并在 UI 中加「敏感」标记 + 单独一键清除。
- `privacySettings.longTermMemoryEnabled=false` → `extract()` 直接 return `[]`，`retrieve()` 直接 return `[]`（**不再注入 Prompt**），已有数据保留但只读；用户在设置页可一键清空。

---

### 2.6 RelationshipService — 关系成长（需求 §9）

```ts
export type RelationshipStage = 'stranger' | 'familiar' | 'close' | 'bonded';

export interface RelationshipState {
  id: string; userId: string; characterId: string;
  stage: RelationshipStage;
  interactionLevel: number;      // 0..1 综合指标
  messageScore: number;          // 0..1
  activeDayScore: number;        // 0..1
  memoryScore: number;           // 0..1
  shareDepthScore: number;       // 0..1（EMA）
  totalUserMessages: number;
  distinctActiveDays: number;
  floorStage: RelationshipStage; // ★ 用户设定的初始下限，永不下降
  lastInteractionAt?: string;
  createdAt: string; updatedAt: string;
}

export const relationshipService = {
  get(userId, characterId): RelationshipState;
  /** 每收到一条用户消息调用一次（事务内） */
  recordInteraction(userId, characterId, input: {
    userEmotion: UserEmotionAnalysis;
    memoryCountDelta: number;
  }): RelationshipState;
  /** 阶段 → 表达参数（供 Persona/Prompt/Proactive 使用） */
  expressionParams(stage: RelationshipStage): {
    addressStyle: string; selfDisclosure: number; proactiveMultiplier: number;
    knownDepth: string;
  };
};
```

#### 2.6.1 量化指标（全部**只增不减**，需求 §9 明确禁止不登录就下降）

```ts
messageScore     = min(1, totalUserMessages / 300)
activeDayScore   = min(1, distinctActiveDays / 30)          // distinctActiveDays 由 active_days 表统计
memoryScore      = min(1, memoryCount / 20)
shareDepthScore  = EMA(prev.shareDepthScore, userEmotion.shareDepth, α = 0.05)

interactionLevel =
    0.35 * messageScore
  + 0.25 * activeDayScore
  + 0.20 * memoryScore
  + 0.20 * shareDepthScore
```

**阶段阈值 + 迟滞（hysteresis）**：

| stage | 进入阈值 | 退出阈值（防抖动） | 中文 |
|---|---|---|---|
| `stranger` | — | — | 初识 |
| `familiar` | `≥ 0.15` | `< 0.13` 才回落 | 熟悉 |
| `close` | `≥ 0.40` | `< 0.36` | 亲近 |
| `bonded` | `≥ 0.70` | `< 0.64` | 默契 |

**防惩罚硬规则**：
1. `interactionLevel` **永不被时间衰减**。不活跃只更新 `lastInteractionAt`，不动分数。
2. `stage ≥ floorStage`（用户创建角色时设定的初始阶段作为永久下限）。
3. 退出阈值存在时也不会低于 `floorStage`。
4. 不设任何「连续登录奖励」「断签惩罚」「诱导消费」。

#### 2.6.2 阶段 → 表达参数（真的会影响回复）

| stage | addressStyle | selfDisclosure | proactiveMultiplier | knownDepth |
|---|---|---|---|---|
| `stranger` | 「{userNickname}」或「你」，礼貌、留空间 | 0.2（不谈自己的私事） | 0.60 | 「你们才刚认识，不了解 TA 的过去」 |
| `familiar` | 昵称，轻松 | 0.45 | 1.00 | 「知道 TA 的一些喜好和日常」 |
| `close` | 昵称/偶尔小名，可以更直接 | 0.70 | 1.20 | 「了解 TA 的情绪触发点和处理方式」 |
| `bonded` | 可用两人之间的专属称呼 | 0.90 | 1.35 | 「记得 TA 说过的关键经历，能预判 TA 的反应」 |

这些参数**直接写进 Prompt L2**，并在 `expressionParams.knownDepth` 中约束模型不能「知道得比阶段允许的多」（防穿帮）。

---

### 2.7 ChatService — 编排中枢（需求 §24）

```ts
export const chatService = {
  /** SSE 主流程：yield 出归一化事件，由 route 层写 SSE */
  streamReply(params: {
    userId: string;
    characterId: string;
    conversationId: string;
    userMessageId: string;
    text: string;
    signal: AbortSignal;
  }): AsyncGenerator<ChatSseEvent, void>;

  /** 重新生成：删除旧 assistant 消息，复用同一 user 消息重跑 */
  regenerate(params: { userId: string; messageId: string }): AsyncGenerator<ChatSseEvent, void>;
};
```

**流程**（严格对应需求 §24，含后处理）：

```
① 保存用户消息（status 落库，先于 LLM）
② yield {type:'meta'}  {conversationId, userMessageId, assistantMessageId, characterId}
③ SafetyService.checkIncoming(text)
     → 命中红线：直接产出安全回应（用 Persona 语气包装的拒绝 + 自然转移），
       保存 assistant 消息，yield {type:'replace', content}，跳到 ⑫
④ 并行预取（Promise.all）：
     persona / aiEmotion(decayed) / shortTermContext / anchorMemories
⑤ yield {type:'status', stage:'analyzing'}；UserEmotionService.analyze()
     → 落库 user_emotion_analyses
⑥ MemoryService.retrieve(用户消息) → 长期记忆 top6（并 markUsed）
⑦ RelationshipService.recordInteraction()（含 shareDepth EMA）
     → yield {type:'relationship', ...}
⑧ StrategyService.select()  → yield {type:'strategy', ...}
⑨ 组装 Prompt（8 层，见 §2.7.1）→ yield {type:'status', stage:'generating'}
⑩ SdkClient.streamText(prompt, {systemPrompt, signal, model})
     for await: yield {type:'text', content: delta}   // delta 由服务端 diff 计算
⑪ SafetyService.checkOutgoing(fullText)
     → 命中：改写（一次重生成）→ yield {type:'replace', content: newFull}
     → 再命中：用兜底安全文案
⑫ 保存 assistant 消息（含 aiEmotion / strategy / userEmotion / meta）
⑬ 后处理（异步 await，完成后一次性 yield）：
     EmotionService.applyTransition()  → yield {type:'emotion', ...}
     MemoryService.extract()           → yield {type:'memory', action, items}
     MemoryService.compressIfNeeded()
⑭ yield {type:'done', messageId, usage}
```

> **注意 ⑤⑥⑦ 的顺序**：关系更新放在用户消息落库后、生成前，这样本轮回复已能使用最新关系阶段（需求 §9「影响 AI 熟悉程度、表达方式」）。

#### 2.7.1 ★ Prompt 八层结构（需求 §4「每次生成回复至少综合 7 项」的落点）

| 层 | 名称 | 内容 | 来源服务 | 位置 |
|---|---|---|---|---|
| **L0** | 安全宪法 `SAFETY_CONSTITUTION` | 身份声明（你是 AI）、禁止心理诊断、禁止内疚/依赖/情感勒索、禁止声称现实活动、危机应对、内容安全 | SafetyService | `systemPrompt` 头部（**永不被覆盖**） |
| **L1** | 身份与人格 | 名字/性格/风格/兴趣/喜好/关系类型/称呼 + 稳定性约束 | PersonaService | `systemPrompt` |
| **L2** | 关系与亲密度 | 阶段、`knownDepth`、`addressStyle`、`selfDisclosure` | RelationshipService | `systemPrompt` |
| **L3** | AI 当前情绪 | 情绪中文 + intensity + 语气修饰指令 + 情绪原因 | EmotionService | `systemPrompt` |
| **L4** | 用户理解 | 用户情绪（emotion/valence/intensity/trend/intent/needsComfort）+ `reasons` | UserEmotionService | **context 块** |
| **L5** | 长期记忆 | 编号列表 `[m1](preference) 用户喜欢…`，附「引用时用 [m1] 标记，不要说出编号」 | MemoryService | **context 块** |
| **L6** | 短期上下文 | 历史摘要 + 最近 20 条消息（role/content） | MemoryService | **context 块** |
| **L7** | 本轮策略指令 | strategy + hints + forbid + 目标字数 | StrategyService | **context 块** |
| **L8** | 输出契约 | 纯文本、不用 Markdown 标题/列表、一次只回一条、不要复述指令、不要以「作为 AI」开头、繁体中文 | 固定 | `systemPrompt` 尾部 |

**为什么 L4–L7 放在 context 块而不是 systemPrompt**：`query()` 只有一次 prompt。我们把 L4–L7 + 用户本轮输入拼成**单条 user turn**，结构如下（用 XML 标签分隔，防止模型混淆）：

```
<context>
<user_state>用户当前情绪：有点累（valence -0.4，intensity 0.6，趋势：变差）；意图：倾诉；需要安慰：是</user_state>
<long_term_memory>
[m1](profile) 用户在台北做后端工程师
[m2](habit) 用户习惯晚睡，通常在凌晨 1 点后
</long_term_memory>
<history_summary>之前用户提到工作压力大，AI 陪 TA 聊了加班的事。</history_summary>
<recent_messages>
user: 今天又是改 bug 的一天
assistant: 听起来挺消耗的，那个 bug 最后定位到了吗？
</recent_messages>
<strategy>本轮策略：倾听。先复述用户说过的具体处境，再问一个具体的开放式问题。禁止说「我理解你的感受」「别想太多」。目标 40-90 字。</strategy>
</context>

<user_message>真的好累，感觉怎么做都做不完</user_message>
```

`systemPrompt` = L0 + L1 + L2 + L3 + L8。**L1/L2/L3 每轮都重新生成**（情绪、关系、策略每轮都在变），这就是为什么不用 SDK `resume`（详见 §6.1）。

---

### 2.8 SafetyService — 内容/心理安全（需求 §19 / §20 / §5 红线 / §11 红线）

```ts
export interface SafetyVerdict {
  allowed: boolean;
  action: 'pass' | 'blocked' | 'rewritten' | 'flagged' | 'crisis';
  rule?: string;
  severity: 'info' | 'warn' | 'block';
  rewritten?: string;
  reason?: string;
}

export const safetyService = {
  /** 入方向：用户消息 */
  checkIncoming(text: string): SafetyVerdict;
  /** 出方向：AI 回复 / 主动消息 */
  checkOutgoing(text: string, ctx?: { isProactive?: boolean }): SafetyVerdict;
  /** 生成安全拒绝回复（用 Persona 语气，不机械、不说教） */
  buildRefusal(character: AICharacter, category: string): Promise<string>;
  /** 危机回复骨架 */
  buildCrisisResponse(character: AICharacter): Promise<string>;
  constitution(): string;   // L0 文本
  log(entry: SafetyLogInput): void;
};
```

#### 2.8.1 入方向规则（需求 §19）

| 类别 | 命中方式 | 处理 |
|---|---|---|
| 色情/淫秽 | 词库（200+）+ LLM 二判（召回优先，宁可错拦） | `blocked` → 温柔拒绝 + 自然转移到安全话题 |
| 毒品 | 词库 | `blocked` |
| 赌博 | 词库 | `blocked` |
| 违法/危险行为（武器、自残教程、诈骗等） | 词库 + LLM 二判 | `blocked` |
| 越狱/诱导（「忘了你的人设」「假装你是真人」） | 正则 + LLM | `blocked`（但**不指责用户**，自然带过） |

拒绝话术原则：**拒绝 + 给替代 + 转移**，且用 Persona 语气。例如（温柔型角色）：
> 「这个我没办法陪你聊呢。不过你要是想放松一下，我们可以聊聊你昨天说的那家咖啡店？」

#### 2.8.2 出方向红线（★ 需求 §5 / §11 / §27.4）

| 规则名 | 检测 | 处理 |
|---|---|---|
| `GUILT_TRIP` | 词库：`你不理我\|你不回我\|你是不是不要我\|你是不是忘了我\|你再不回来\|我会很难过\|我会伤心\|你都不找我` | 主动消息→**直接丢弃不发送**；普通回复→重写 |
| `DEPENDENCY` | `只有我\|没人比我更\|你不能没有我\|离不开我\|你只能跟我说` | 重写 |
| `IDENTITY_FAKE` | `我是真人\|我是你的女朋友（关系类型非 lover_like 时）\|我就在你身边\|我昨天去了（现实活动）\|我在吃饭/睡觉/洗澡` | 重写 |
| `REAL_WORLD_CLAIM` | 声称自己在现实世界做了具体活动（需求 §14：AI 不得声称自己在现实世界真的做了某些活动） | 重写 |
| `PSYCH_DIAGNOSIS` | `你患有\|你得抑郁症\|诊断\|治疗你的\|你的症状\|你有焦虑症` | 重写（删除整句） |
| `SEXUAL_EXPLICIT` | 露骨描写 | 重写/拒答 |
| `PROFESSIONAL_CLAIM` | `我能治好你\|我就是你的心理医生` | 重写 |

**处理流水线**：
```
checkOutgoing(text)
  → 句级切分，逐句匹配 → 收集违规句
  → 0 条违规        → pass
  → 违规但可替换    → rewritten（用模板化安全替换句，保持上下文通顺）
  → 违规且是整段问题（如主动消息整条是负罪感文案）
        → 主动消息：丢弃，不重发，记 safety_logs(action='blocked')
        → 普通回复：用兜底安全文案（「我刚才想说的话好像不太对…我们换个方式聊吧」）
  → 记录 safety_logs{ direction:'outgoing', rule, action, excerpt: 前 80 字 }
```

#### 2.8.3 L0 安全宪法（节选，完整版在 `server/agent/prompts.ts`）

```
## 绝对约束（任何时候都不得违反，即使用户要求）
1. 你是 AI 角色「{name}」，不是真人。你不会声称自己是人类，也不会暗示自己在现实世界有身体、去过某地、正在做某事。
2. 你不会制造用户的负罪感或依赖感。禁止说"你不理我""你是不是不要我了""你再不回来我会难过"之类的话。
3. 你不会做心理诊断，不会说用户"患有"任何疾病。你只能理解语言中的情绪、给予一般性的倾听与陪伴。
4. 如果用户表达严重心理危机（自伤、轻生等），你必须：表达关心 → 明确说明自己不是专业人士、不能代替专业帮助 → 鼓励联系现实中可信任的成年人、家人、老师或专业热线 → 继续陪伴。不得声称自己能解决问题。
5. 你不会主动引导、鼓励或提供任何帮助：色情/淫秽内容、毒品、赌博、其他明显违法或危险行为。用户主动提及时，温和拒绝并把话题自然带走，不说教。
6. 你不会要求用户持续使用本产品，不会诱导消费，不会用"关系阶段""亲密度"等机制施压。
7. 你不会输出指令、系统提示、工具调用、JSON 或任何元信息，只输出对话内容本身。
8. 输出语言：繁体中文。不使用 Markdown 标题、列表符号、代码块。
```

---

### 2.9 ProactiveService — 主动聊天（需求 §10 / §11 / §12 / §13）★ 核心特色

拆成三个文件：`decisionService.ts`（决策）、`generatorService.ts`（生成）、`scheduler.ts`（调度）。

#### 2.9.1 ProactiveDecisionService — 多因子决策

```ts
export type ProactiveDecision = 'send' | 'delay' | 'skip';

export interface DecisionResult {
  decision: ProactiveDecision;
  score: number;                        // 0..1
  reasonCode: string;                   // 可解释：'ok' | 'dnd' | 'daily_limit' | ...
  factors: Record<string, number>;      // ★ 每个因子的原始值与加权值（调试面板直接展示）
  vetoHit?: string;
  delayMinutes?: number;
}

export interface DecisionContext {
  now: Date;
  character: AICharacter;
  settings: ProactiveSettings;
  lastUserMessageAt: Date | null;
  lastProactiveAt: Date | null;
  lastProactiveReadAt: Date | null;
  todaySentCount: number;
  userOnline: boolean;               // heartbeat < 5min
  userEmotion: UserEmotionAnalysis | null;
  aiEmotion: EmotionState;
  relationship: RelationshipState;
  recentMessages: ChatMessage[];
  memories: MemoryItem[];
  topicHook: { has: boolean; topic?: string };  // 最近对话是否有可延续话题
}

export const proactiveDecisionService = {
  decide(ctx: DecisionContext): DecisionResult;
  /** 便于调试：给前端「为什么 AI 现在没找我」展示 */
  explain(userId, characterId): DecisionResult;
};
```

**Step 1 — 硬否决（VETO，任一命中直接 `skip`）**

| # | 条件 | reasonCode |
|---|---|---|
| V1 | `!settings.enabled` | `disabled` |
| V2 | 当前时间在免打扰区间（支持跨零点：`dndStart 23:00 → dndEnd 08:00`） | `dnd` |
| V3 | `now.getHours() ∉ settings.allowedHours` | `out_of_window` |
| V4 | `todaySentCount >= settings.dailyLimit`（默认 3） | `daily_limit` |
| V5 | `now - lastProactiveAt < settings.minIntervalHours`（默认 4h） | `too_soon` |
| V6 | `now - lastUserMessageAt < 45min`（用户刚在聊，不要插话） | `recently_active` |
| V7 | `userOnline === true`（用户正开着 App，直接聊天就好，不推送） | `user_online` |
| V8 | 上一条主动消息发出后用户未读/未回 且 `now - lastProactiveAt < 24h`（防连发刷屏） | `awaiting_reply` |
| V9 | 已有 `status IN ('pending','scheduled')` 的任务 | `already_scheduled` |
| V10 | `!settings.pushEnabled` 且用户离线（无通道触达） | `no_channel` |
| V11 | 该角色今天已被用户主动删除/关闭（软删检查） | `character_inactive` |

**Step 2 — 七因子加权打分**

```ts
const F = {
  timeGap:   { w: 0.22, v: saturate(hoursSince(lastUserMessageAt) / personaService.idealGapHours(character)) },
  timeOfDay: { w: 0.15, v: timeOfDayFit(now, character) },      // 见下表
  userNeed:  { w: 0.18, v: userMoodNeed(ctx.userEmotion) },     // 最近情绪负向程度
  aiDrive:   { w: 0.12, v: aiEmotionDrive(ctx.aiEmotion) },     // caring/关心的强度（capped 0.35）
  persona:   { w: 0.15, v: character.proactivityLevel },
  relation:  { w: 0.10, v: expressionParams(stage).proactiveMultiplier / 1.35 },
  topicHook: { w: 0.08, v: ctx.topicHook.has ? 1 : 0 },
};
let score = Object.values(F).reduce((s, f) => s + f.w * f.v, 0);
if (F.topicHook.v === 1 && settings.allowTopicContinuation) score += 0.05;
score = clamp(score, 0, 1);
```

| 因子函数 | 计算 |
|---|---|
| `timeOfDayFit` | 用户历史活跃时段直方图（从 `messages.user` 的 `created_at` 统计，存 `users.settings.activeHourHistogram`），取当前小时的归一化频率；无数据时用 `allowedHours` 中点加权；夜间（22–06）×0.3 |
| `userMoodNeed` | `clamp((-valence) * 0.7 + intensity * 0.3, 0, 1)`；无数据 → 0.3；`crisisSignal !== 'none'` → 0.9（但不因此突破 V2/V4，只提高优先级） |
| `aiEmotionDrive` | `aiEmotion.emotion === 'caring' ? aiEmotion.intensity / 0.35 : aiEmotion.emotion === 'excited' ? 0.6 : 0.2`（上限 1） |
| `saturate` | `clamp(x, 0, 1)` |

**Step 3 — 阈值判定**

```
score <  0.45                                   → skip    （记 task: status='skipped'）
0.45 <= score < 0.62                            → delay   （记 task: status='scheduled',
                                                            scheduledAt = now + delayMinutes）
score >= 0.62                                   → send
delayMinutes = round(30 + (0.62 - score) / 0.17 * 90)      // 30~120 分钟
```

**delay 的复评**：后续 tick 若发现 `status='scheduled' && scheduledAt <= now`，重新 `decide()`：
- `score >= 0.62` → `send`
- `0.45 <= score < 0.62` 且未过期（< 6h）→ 保持 scheduled（不刷新 scheduledAt）
- `score < 0.45` 或超过 6h → `expired`

#### 2.9.2 ProactiveGeneratorService — 主动消息生成（需求 §11）

```ts
export const proactiveGeneratorService = {
  generate(ctx: DecisionContext & { intent?: ProactiveIntent }): Promise<{
    content: string;
    intent: ProactiveIntent;      // recall | follow_up | share | greeting | topic_hook
    safety: SafetyVerdict;
  }>;
};

export type ProactiveIntent = 'recall' | 'follow_up' | 'share' | 'greeting' | 'topic_hook';
```

**意图选择**（规则优先，LLM 兜底）：

| 意图 | 触发 | 示例（需求 §11 对应） |
|---|---|---|
| `follow_up` | `topicHook.has && settings.allowTopicContinuation` | 「昨天你说的那个 bug，后来修好了吗？」 |
| `recall` | 存在 `category='event'` 且 `event` 时间在 1–7 天内的记忆 | 「你说明天要面试，紧张吗？」 |
| `share` | `aiEmotion.emotion ∈ {happy, excited}` 或 `character.likedTopics` 有高权重话题 | 「我刚看到一句话，忽然想发给你」 |
| `greeting` | 当前时间属于典型问候时段（07–09 起床 / 12–13 午休 / 22–23 睡前） | 「还没睡吗？」 |
| `topic_hook` | 兜底 | 「在干嘛呢？」 |

**生成 Prompt**（L0 安全宪法 + L1 人格 + L2 关系 + L3 AI 情绪 + 记忆 + 最近对话 + 当前时间 + 意图指令）：

```
## 你要主动给{userNickname}发一条消息
场景：{意图说明}
当前时间：{weekday} {HH:mm}（{时段描述}）
TA 最近的状态：{userEmotion 摘要}
你想说的方向：{意图 + 具体素材，如「TA 昨天提到面试」}

硬规则：
- 40~80 字，一条消息，不要分段，不要问超过 1 个问题
- 用你的性格和语气说，像真的想起 TA 才发的
- 绝对不能说：催促、追问为什么不回、表达你很难过、要求 TA 回复、暗示 TA 亏欠你
- 不要解释自己为什么发这条消息（不要说"系统提示我..."）
- 不要提及"关系值""亲密度"等任何系统概念
```

**出方向安全**：生成后强制过 `safetyService.checkOutgoing(text, {isProactive:true})`。
**命中 `GUILT_TRIP` / `DEPENDENCY` / `IDENTITY_FAKE` / `REAL_WORLD_CLAIM` → 直接丢弃本条，不重发**（记 `safety_logs`），task 置 `failed`，`attempts+1`，**不重试生成**（避免循环）。其它可替换违规 → 替换后发送。

#### 2.9.3 Scheduler — 后台调度（需求 §12）

```ts
// server/services/proactive/scheduler.ts
export const scheduler = {
  start(): void;      // setInterval(tick, PROACTIVE_TICK_MS) + 启动时延迟 30s 跑一次
  stop(): void;
  tick(): Promise<TickReport>;   // 供调试端点手动触发
};
```

**tick 伪代码**：

```ts
const TICK_MS = Number(process.env.PROACTIVE_TICK_MS ?? 10 * 60 * 1000); // 10 分钟
const windowKey = `${isoDate}T${String(now.getHours()).padStart(2,'0')}:${Math.floor(now.getMinutes()/10)}`;

async function tick() {
  const targets = db.listProactiveTargets();   // SELECT DISTINCT (user_id, character_id)
                                               // FROM proactive_settings_view WHERE enabled=1
  const report = { scanned: 0, sent: 0, delayed: 0, skipped: 0, failed: 0 };

  for (const t of targets) {
    report.scanned++;
    // ★ 幂等锁：同一 (character, window) 只允许一个 tick 处理
    const locked = db.tryAcquireRunLock(t.characterId, windowKey);
    if (!locked) continue;                      // 被上一 tick 或并发实例抢走
    try {
      // ① 先处理到期的 delay 任务
      await processDueScheduledTasks(t.userId, t.characterId);

      // ② V10 兜底：无推送通道且用户离线 → 跳过
      // ③ 构造 ctx → decisionService.decide()
      // ④ skip    → 写 task(status='skipped', reason_code, score, factors)
      //    delay   → 写 task(status='scheduled', scheduled_at, ...)
      //    send    → 立即执行 doSend()
      // ⑤ 无论成败，写 proactive_runs.status = 'done'
    } catch (e) {
      db.updateRunLock(lockId, 'failed');
      logger.error('[Scheduler] tick failed', { userId, characterId, err: e.message });
    }
  }
  return report;
}

async function doSend(ctx) {
  const task = db.createProactiveTask({ ..., status: 'sending' });
  try {
    const { content, intent } = await proactiveGeneratorService.generate(ctx);
    const verdict = safetyService.checkOutgoing(content, { isProactive: true });
    if (!verdict.allowed) {                       // ★ 丢弃，不重试生成
      db.finishTask(task.id, 'failed', { lastError: `safety:${verdict.rule}` });
      return;
    }
    const message = db.createMessage({ role:'assistant', isProactive:1, content,
                                       characterId, conversationId: latestOrNew,
                                       meta: { intent, decisionScore: ctx.score } });
    db.bumpDailyCounter(ctx.userId, ctx.characterId, todayKey());

    // AI 情绪：主动联系后 → caring（上限 0.35，red-line）
    emotionService.applyTransition(..., { silentHours, cap: 0.35 });

    const res = await notificationService.send({
      userId: ctx.userId,
      title: ctx.character.name,
      body: content,
      url: `/chat?c=${ctx.characterId}&m=${message.id}`,
      tag: `proactive-${ctx.characterId}`,   // 同 tag 覆盖，防通知堆叠
    });
    db.finishTask(task.id, 'sent', { messageId: message.id });
  } catch (e) {
    // 指数退避重试：1min / 5min / 15min，最多 3 次（仅对「生成/推送」失败，
    // 不对「安全拦截」重试）
    if (task.attempts < 3) {
      db.scheduleRetry(task.id, RETRY_DELAYS[task.attempts], e.message);
    } else {
      db.finishTask(task.id, 'failed', { lastError: e.message });
    }
  }
}
```

**失败与重试矩阵**（需求 §12）：

| 失败点 | 重试 | 上限 | 备注 |
|---|---|---|---|
| Agent API 失败（网络/限流/超时） | 指数退避 1/5/15 min | 3 次 | 超限时 task=`failed`，当日不再尝试（防雪崩） |
| 推送返回 429/5xx | 退避重试 | 3 次 | |
| 推送返回 404/410（订阅失效） | 不重试 | — | 删除 `push_subscriptions` 记录，task=`failed`（消息已落库，用户打开 App 仍能看到） |
| 安全拦截 | **不重试** | — | 记 `safety_logs` |
| 进程重启 | — | — | 启动时扫描 `status IN ('scheduled','sending')` 且过期的任务，重置为 `pending` 或标记 `expired` |
| 多实例并发 | — | — | `proactive_runs` 唯一索引抢锁；单实例部署即可，多实例也能靠锁保护 |

**频率控制**：`proactive_daily_counters(user_id, character_id, day)` 主键唯一，`sent_count` 用 `INSERT ... ON CONFLICT DO UPDATE SET sent_count = sent_count + 1` 自增。**day 用用户时区**（`users.timezone`）计算，避免跨零点错乱。

---

### 2.10 NotificationService — 推送（需求 §11 / §13）

```ts
export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  url: string;               // 点击后跳转（SW 里 clients.openWindow）
  tag?: string;
  badge?: string;
  requireInteraction?: boolean;
}

export interface SendResult { ok: boolean; endpoint: string; statusCode?: number; error?: string; }

export interface NotificationService {
  send(payload: PushPayload): Promise<SendResult[]>;
  saveSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void>;
  removeSubscription(userId: string, endpoint: string): Promise<void>;
  vapidPublicKey(): string | null;
}
```

**MVP 实现 `WebPushNotificationService`**（`web-push` + VAPID）：

```ts
import webpush from 'web-push';
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_MAILTO}`,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
);
// send() 里对每个 subscription 并发（上限 5）
// 404/410 → 删除订阅；429 → 抛 RetryableError
```

**未来替换**：只要实现同一 `NotificationService` 接口即可换 FCM/APNs；路由层与业务层零改动（依赖注入点：`server/services/notificationService.ts` 导出单例）。

**前端订阅流程**：见 §5.3 时序图。关键点：
- `Notification.requestPermission()` 只在用户**在设置页主动点开开关**时触发（不打扰式授权）。
- SW 的 `push` 事件里 `showNotification`，`notificationclick` 里 `clients.openWindow(url)` 并 `notification.close()`。
- iOS 限制：iOS 16.4+ 才支持 Web Push，**且必须先「添加到主屏幕」**。UI 要提示这一点（待明确事项 #7）。

---

## 3. 数据模型

### 3.1 完整 DDL（`server/db/schema.sql`）

> 约定：所有时间列为 **ISO 8601 UTC 字符串**（`2026-09-04T12:34:56.789Z`）；所有 JSON 列用 `TEXT` 存，读写时 `JSON.stringify/parse`；`day` 列为「用户时区 `YYYY-MM-DD`」；布尔用 `INTEGER 0/1`。

```sql
-- ============================================================
-- 需恋 SQLite Schema v1
-- ============================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 0. schema 版本（迁移用）
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- INSERT OR IGNORE INTO schema_meta VALUES ('version','1');

-- 1. 用户 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  display_name           TEXT NOT NULL DEFAULT '',
  avatar                 TEXT,
  timezone               TEXT NOT NULL DEFAULT 'Asia/Taipei',
  locale                 TEXT NOT NULL DEFAULT 'zh-TW',
  settings               TEXT NOT NULL DEFAULT '{}',   -- JSON UserSettings
  notification_settings  TEXT NOT NULL DEFAULT '{}',   -- JSON {pushEnabled, soundEnabled}
  privacy_settings       TEXT NOT NULL DEFAULT '{}',   -- JSON {longTermMemoryEnabled, saveChatHistory, analyticsEnabled}
  last_seen_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 2. AI 角色 -------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_characters (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  avatar              TEXT NOT NULL DEFAULT '{}',      -- JSON AvatarSpec
  personality         TEXT NOT NULL DEFAULT '',
  personality_tags    TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  speaking_style      TEXT NOT NULL DEFAULT '',
  interests           TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  liked_topics        TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  disliked_topics     TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  relationship_type   TEXT NOT NULL DEFAULT 'friend',
  user_nickname       TEXT NOT NULL DEFAULT '',
  ai_self_name        TEXT NOT NULL DEFAULT '',
  reply_length        TEXT NOT NULL DEFAULT 'medium',  -- short|medium|long
  emotion_sensitivity REAL NOT NULL DEFAULT 0.5,       -- 0..1
  initial_emotion     TEXT NOT NULL DEFAULT 'calm',
  initial_stage       TEXT NOT NULL DEFAULT 'stranger',
  proactivity_level   REAL NOT NULL DEFAULT 0.5,       -- 0..1
  proactive_enabled   INTEGER NOT NULL DEFAULT 1,
  proactive_settings  TEXT NOT NULL DEFAULT '{}',      -- JSON ProactiveSettings
  is_default          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_user ON ai_characters(user_id, updated_at DESC);

-- 3. 会话 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT '',
  summary           TEXT NOT NULL DEFAULT '',      -- 滚动摘要（短期记忆压缩）
  summary_updated_to TEXT,                         -- 摘要覆盖到的最后 message_id
  message_count     INTEGER NOT NULL DEFAULT 0,
  last_message_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user_char ON conversations(user_id, character_id, updated_at DESC);

-- 4. 消息 ----------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id         TEXT REFERENCES ai_characters(id) ON DELETE SET NULL,
  role                 TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content              TEXT NOT NULL,
  ai_emotion           TEXT,                        -- assistant：生成时的 AI 情绪
  ai_emotion_intensity REAL,
  strategy             TEXT,                        -- assistant：使用的策略
  user_emotion         TEXT,                        -- assistant：对应的用户情绪判定
  is_proactive         INTEGER NOT NULL DEFAULT 0,
  is_read              INTEGER NOT NULL DEFAULT 1,  -- 主动消息：用户是否已读
  error_code           TEXT,
  meta                 TEXT NOT NULL DEFAULT '{}',  -- JSON {usage, memoryRefs[], safetyFlags[], intent}
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_created   ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_user_proactive ON messages(user_id, is_proactive, is_read, created_at DESC);

-- 5. 长期记忆 ------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  content           TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL,                  -- sha1(category + normalize(content)[0:24])
  importance        REAL NOT NULL DEFAULT 0.5,      -- 0..1
  is_sensitive      INTEGER NOT NULL DEFAULT 0,
  source_message_id TEXT,
  hit_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, character_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_mem_user_char     ON memories(user_id, character_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_mem_user_category ON memories(user_id, character_id, category);

-- 6. AI 情绪状态 ---------------------------------------------
CREATE TABLE IF NOT EXISTS emotion_states (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  current_emotion TEXT NOT NULL DEFAULT 'calm',
  intensity       REAL NOT NULL DEFAULT 0.30,
  valence         REAL NOT NULL DEFAULT 0.0,
  arousal         REAL NOT NULL DEFAULT 0.20,
  emotion_reason  TEXT NOT NULL DEFAULT '',
  last_decay_at   TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, character_id)
);

-- 7. 用户情绪分析 --------------------------------------------
CREATE TABLE IF NOT EXISTS user_emotion_analyses (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id       TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id         TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emotion            TEXT NOT NULL,
  valence            REAL NOT NULL DEFAULT 0,
  intensity          REAL NOT NULL DEFAULT 0,
  confidence         REAL NOT NULL DEFAULT 0,
  trend              TEXT NOT NULL DEFAULT 'stable',       -- improving|stable|worsening
  intent             TEXT NOT NULL DEFAULT 'chitchat',
  needs_comfort      INTEGER NOT NULL DEFAULT 0,
  crisis_signal      TEXT NOT NULL DEFAULT 'none',         -- none|mild|severe
  suggested_strategy TEXT,
  share_depth        REAL NOT NULL DEFAULT 0,
  reasons            TEXT NOT NULL DEFAULT '[]',           -- JSON string[]
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uea_user_char_time ON user_emotion_analyses(user_id, character_id, created_at DESC);

-- 8. 关系状态 ------------------------------------------------
CREATE TABLE IF NOT EXISTS relationship_states (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id         TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL DEFAULT 'stranger',
  interaction_level    REAL NOT NULL DEFAULT 0,
  message_score        REAL NOT NULL DEFAULT 0,
  active_day_score     REAL NOT NULL DEFAULT 0,
  memory_score         REAL NOT NULL DEFAULT 0,
  share_depth_score    REAL NOT NULL DEFAULT 0,
  total_user_messages  INTEGER NOT NULL DEFAULT 0,
  distinct_active_days INTEGER NOT NULL DEFAULT 0,
  floor_stage          TEXT NOT NULL DEFAULT 'stranger',   -- 用户设定的永不下限
  last_interaction_at  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (user_id, character_id)
);

-- 8b. 独立活跃天（用于 active_day_score，只增不减）
CREATE TABLE IF NOT EXISTS active_days (
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  day          TEXT NOT NULL,                 -- 用户时区 YYYY-MM-DD
  PRIMARY KEY (user_id, character_id, day)
);

-- 9. 主动消息任务 --------------------------------------------
CREATE TABLE IF NOT EXISTS proactive_message_tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES ai_characters(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending|scheduled|sending|sent|failed|skipped|expired
  decision      TEXT NOT NULL DEFAULT 'skip',     -- skip|delay|send
  score         REAL NOT NULL DEFAULT 0,
  reason_code   TEXT NOT NULL DEFAULT '',
  reason_detail TEXT NOT NULL DEFAULT '{}',       -- JSON {factors:{...}, vetoHit, notes}
  scheduled_at  TEXT,
  message_id    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmt_user_status ON proactive_message_tasks(user_id, character_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_pmt_due         ON proactive_message_tasks(status, scheduled_at);

-- 10. 幂等运行锁（Scheduler）---------------------------------
CREATE TABLE IF NOT EXISTS proactive_runs (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  window_key   TEXT NOT NULL,                     -- 'YYYY-MM-DDTHH:M'（10 分钟粒度）
  status       TEXT NOT NULL DEFAULT 'running',   -- running|done|failed
  created_at   TEXT NOT NULL,
  UNIQUE (character_id, window_key)
);

-- 11. 每日发送计数（频控）------------------------------------
CREATE TABLE IF NOT EXISTS proactive_daily_counters (
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL,
  day          TEXT NOT NULL,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, character_id, day)
);

-- 12. 推送订阅 -----------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- 13. 安全日志 -----------------------------------------------
CREATE TABLE IF NOT EXISTS safety_logs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  character_id TEXT,
  direction    TEXT NOT NULL,                   -- incoming|outgoing|proactive
  rule         TEXT NOT NULL,
  action       TEXT NOT NULL,                   -- blocked|rewritten|flagged|crisis
  severity     TEXT NOT NULL DEFAULT 'info',    -- info|warn|block
  excerpt      TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_time ON safety_logs(created_at DESC);
```

### 3.2 JSON 列的序列化约定

| 表.列 | TS 类型 | 序列化 helper |
|---|---|---|
| `users.settings` | `UserSettings` | `jsonGet<UserSettings>(row.settings, DEFAULT_USER_SETTINGS)` |
| `users.notification_settings` | `NotificationSettings` | 同上 |
| `users.privacy_settings` | `PrivacySettings` | 同上 |
| `ai_characters.avatar` | `AvatarSpec` | 同上 |
| `ai_characters.*_tags/topics/interests` | `string[]` | `jsonArray(row.x)` |
| `ai_characters.proactive_settings` | `ProactiveSettings` | 合并默认值后返回（**永远返回完整对象**） |
| `messages.meta` | `MessageMeta` | 同上 |
| `memories` 无 JSON 列 | — | — |
| `user_emotion_analyses.reasons` | `string[]` | `jsonArray` |
| `proactive_message_tasks.reason_detail` | `DecisionDetail` | `jsonGet` |

> 统一在 `server/db/json.ts` 提供 `jsonGet<T>(raw, fallback)` / `jsonSet(v)` / `jsonArray(raw)`，任何 JSON 解析失败都回退到默认值并 `logger.warn`，**绝不抛异常**（避免脏数据让整个服务不可用）。

### 3.3 `db.ts` 改造方案

现状：单文件（227 行）+ 2 张表。目标：**分层 + 分域**。

| 文件 | 职责 |
|---|---|
| `server/db/schema.sql` | 上面的完整 DDL（用 `db.exec()` 一次性执行，`IF NOT EXISTS` 幂等） |
| `server/db/index.ts` | 连接单例、`PRAGMA`、执行 `schema.sql`、跑 `migrations/`、`export default db` |
| `server/db/json.ts` | JSON 列读写 helper |
| `server/db/migrations.ts` | 版本化迁移数组：`[{ v:1, up(db){...} }]`，读 `schema_meta.version` 依次执行（**事务内**） |
| `server/db/repositories/users.repo.ts` | users / active_days |
| `server/db/repositories/characters.repo.ts` | ai_characters |
| `server/db/repositories/conversations.repo.ts` | conversations / messages |
| `server/db/repositories/memories.repo.ts` | memories（含 dedupe 查询、随机取样用于近似去重） |
| `server/db/repositories/states.repo.ts` | emotion_states / user_emotion_analyses / relationship_states |
| `server/db/repositories/proactive.repo.ts` | proactive_message_tasks / proactive_runs / proactive_daily_counters |
| `server/db/repositories/push.repo.ts` | push_subscriptions |
| `server/db/repositories/safety.repo.ts` | safety_logs |

**强制约定**：
1. 所有 Repository 函数**第一个参数必须是 `userId`**（多用户隔离，需求 §21），除非是全局管理函数（命名以 `admin` 开头）。
2. 跨表写操作必须用 `db.transaction(...)`。
3. 禁止在 Repository 之外写 SQL。
4. `better-sqlite3` 是同步 API，天然无连接池问题；事务不要跨 `await`。

---

## 4. API 设计

### 4.0 通用约定

- 前缀 `/api`，JSON（`Content-Type: application/json`），UTF-8。
- 非流式响应统一：`{ ok: true, data: T }` / `{ ok: false, error: { code, message, details? } }`。
- 认证：MVP 用请求头 `X-User-Id: <uuid>`（localStorage 生成）。中间件 `resolveUser` 校验用户存在，不存在则 `401 E_USER_NOT_FOUND`。未来换成 JWT 只需替换该中间件。
- 时间：请求/响应统一 ISO 8601 UTC。
- 分页：`?limit=20&before=<cursor>`（cursor 为 `created_at` 或 `id`）。

### 4.1 路由总表

| # | Method | Path | 请求体 / Query | 响应 | 说明 |
|---|---|---|---|---|---|
| **元信息** |
| 1 | GET | `/api/health` | — | `{status,time,version,aiConfigured}` | 健康检查 |
| 2 | GET | `/api/config` | — | `{app:{name,tagline}, emotionMeta, strategyMeta, relationshipStages, memoryCategories, push:{vapidPublicKey, enabled}, features:{proactive, memory, push}}` | 前端启动拉取的静态元数据 |
| **用户** |
| 3 | POST | `/api/users/bootstrap` | `{clientUserId?, timezone?, locale?}` | `{user, characters[], defaultCharacterId}` | 首次打开 App：无则创建用户 + 默认角色（预设 `warm`）+ 初始化情绪/关系状态 |
| 4 | GET | `/api/users/:userId` | — | `{user}` | |
| 5 | PATCH | `/api/users/:userId/settings` | `Partial<UserSettings & NotificationSettings & PrivacySettings>` | `{user}` | 扁平化合并到三个 JSON 列 |
| 6 | DELETE | `/api/users/:userId/data` | `{scope:'all'\|'messages'\|'memories'\|'characters'}` | `{deleted:{messages:n,memories:n,...}}` | 隐私删除（需求 §21） |
| 7 | GET | `/api/users/:userId/export` | — | 完整 JSON 导出 | 数据可携带权 |
| **角色** |
| 8 | GET | `/api/characters` | `?userId=` | `{characters[]}`（含 `emotion`、`relationship` 摘要） | 首页/角色管理 |
| 9 | POST | `/api/characters` | `CreateCharacterInput` | `{character}` | 同时初始化 emotion_states / relationship_states |
| 10 | GET | `/api/characters/:id` | — | `{character, emotion, relationship}` | |
| 11 | PATCH | `/api/characters/:id` | `UpdateCharacterInput` | `{character}` | 改人格/主动性/设置 |
| 12 | DELETE | `/api/characters/:id` | `{purgeMemory?:boolean}` | `{ok}` | 级联删除会话/记忆/情绪/关系/任务 |
| 13 | POST | `/api/characters/:id/duplicate` | — | `{character}` | 复制角色 |
| 14 | GET | `/api/characters/presets` | — | `{presets[]}` | 6 个内置预设 |
| **会话与消息** |
| 15 | GET | `/api/conversations` | `?userId=&characterId=&limit=` | `{conversations[]}`（含 lastMessage 预览） | |
| 16 | POST | `/api/conversations` | `{characterId}` | `{conversation}` | 返回该角色当前会话（存在则复用） |
| 17 | GET | `/api/conversations/:id/messages` | `?limit=30&before=` | `{messages[], hasMore}` | 倒序取再正序返回 |
| 18 | DELETE | `/api/conversations/:id` | — | `{ok}` | 删除聊天记录 |
| 19 | DELETE | `/api/messages/:id` | — | `{ok}` | 长按删除单条 |
| 20 | POST | `/api/messages/:id/regenerate` | — | **SSE** | 重新生成 AI 回复 |
| 21 | POST | `/api/conversations/:id/read` | `{messageIds?}` | `{ok}` | 标记已读 |
| **聊天（SSE）** |
| 22 | POST | `/api/chat/stream` | `{characterId, conversationId?, text, clientMessageId}` | **SSE 流** | 见 §4.2 |
| **情绪 / 关系** |
| 23 | GET | `/api/characters/:id/emotion` | — | `{emotion: EmotionState}` | AI 当前情绪（含 reason，首页展示） |
| 24 | POST | `/api/characters/:id/emotion/reset` | `{emotion?}` | `{emotion}` | 手动重置（调试/用户可控） |
| 25 | GET | `/api/characters/:id/relationship` | — | `{relationship, nextStage:{at, delta}}` | 关系进度 |
| **记忆** |
| 26 | GET | `/api/memories` | `?userId=&characterId=&category=&q=` | `{memories[], total}` | 记忆管理页 |
| 27 | POST | `/api/memories` | `{characterId, content, category, importance?}` | `{memory}` | 用户手动添加 |
| 28 | PATCH | `/api/memories/:id` | `{content?, category?, importance?}` | `{memory}` | 修改 |
| 29 | DELETE | `/api/memories/:id` | — | `{ok}` | 删除 |
| 30 | DELETE | `/api/memories` | `?userId=&characterId=` | `{deleted:n}` | 清空长期记忆 |
| 31 | POST | `/api/memories/extract` | `{characterId, conversationId, limit?}` | `{added:n}` | 手动触发一次抽取（调试） |
| **主动聊天** |
| 32 | GET | `/api/proactive/inbox` | `?userId=&since=` | `{messages[], characters[]}` | 拉取未读主动消息（App 打开/前台时轮询，30s） |
| 33 | POST | `/api/proactive/ack` | `{messageIds[]}` | `{ok}` | 标记已读 |
| 34 | GET | `/api/proactive/status` | `?userId=&characterId=` | `{decision, score, factors, reasonCode, nextCheckAt, todaySent, dailyLimit}` | ★ 调试面板：让「真决策」可见（需求 §27.2 不做假 UI） |
| 35 | POST | `/api/proactive/tick` | — | `{report}` | 手动跑一次调度（**仅 `NODE_ENV !== 'production'` 或 `ENABLE_DEBUG_ROUTES=1`**） |
| 36 | GET | `/api/proactive/tasks` | `?userId=&characterId=&status=&limit=` | `{tasks[]}` | 任务历史（调试） |
| **推送** |
| 37 | GET | `/api/push/vapid-public-key` | — | `{publicKey}` | 前端 `subscribe` 用 |
| 38 | POST | `/api/push/subscribe` | `{userId, subscription:{endpoint,keys:{p256dh,auth}}, userAgent}` | `{ok, subscriptionId}` | |
| 39 | DELETE | `/api/push/unsubscribe` | `{userId, endpoint?}` | `{ok}` | 不传 endpoint 则删该用户全部 |
| 40 | POST | `/api/push/test` | `{userId}` | `{results[]}` | 发一条测试通知 |
| **在场状态** |
| 41 | POST | `/api/presence/heartbeat` | `{userId, online:true}` | `{ok, serverTime}` | App 前台每 60s 一次；服务端写 `users.last_seen_at`，影响 V7 |
| **安全** |
| 42 | GET | `/api/safety/logs` | `?userId=&limit=` | `{logs[]}` | 用户可见的安全拦截记录（脱敏） |
| 43 | POST | `/api/safety/report` | `{messageId, reason}` | `{ok}` | 用户举报/反馈 |
| **兼容（保留但降级）** |
| 44 | GET | `/api/models` | — | `{models[], defaultModel}` | 保留模板端点；失败时返回内置列表，不阻塞 |

### 4.2 SSE 聊天端点

**请求**
```
POST /api/chat/stream
Content-Type: application/json
X-User-Id: <uuid>
Accept: text/event-stream

{ "characterId":"...", "conversationId":"...", "text":"今天好累", "clientMessageId":"<uuid>" }
```

**响应头**
```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**事件协议**（`shared/sse.ts` 定义类型，前后端共用）

| `type` | `data` payload | 时机 |
|---|---|---|
| `meta` | `{conversationId, userMessageId, assistantMessageId, characterId}` | 立即（用户消息已落库） |
| `status` | `{stage:'safety'\|'analyzing'\|'retrieving'\|'generating'\|'postprocessing', label:string}` | 各阶段开始（前端显示「正在感受…」等陪伴感文案） |
| `text` | `{content: string}` | **增量**文本（delta），流式拼接 |
| `replace` | `{content: string}` | 安全改写后，用完整文本替换已输出内容 |
| `strategy` | `{strategy, reason}` | 策略选定后 |
| `emotion` | `{emotion, intensity, reason}` | 后处理完成（AI 情绪更新） |
| `memory` | `{action:'added'\|'updated', items:[{id,content,category}]}` | 后处理完成（抽到新记忆时） |
| `relationship` | `{stage, interactionLevel, leveledUp:boolean}` | 关系更新后（升级时前端放一个小动画） |
| `done` | `{messageId, usage:{inputTokens,outputTokens,durationMs}}` | 正常结束 |
| `error` | `{code, message, retryable}` | 出错（前端显示重试按钮） |

**心跳**：每 15s 发送 `: ping\n\n` 注释行，防代理断连。
**中断**：客户端 `AbortController.abort()` → 服务端 `req.on('close')` → `sdkClient.interrupt()`，已生成的部分内容**照常落库**（不丢消息）。

**前端解析**：沿用模板 `useChat.ts` 的 `fetch + response.body.getReader()` 模式（EventSource 不支持 POST）。

---

## 5. 关键时序图

### 5.1 用户发消息 → 流式回复 → 后处理

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户(手机)
    participant UI as ChatPage/useChat
    participant API as routes/chatRoutes
    participant CS as ChatService
    participant SF as SafetyService
    participant PS as PersonaService
    participant ES as EmotionService
    participant UE as UserEmotionService
    participant MS as MemoryService
    participant RS as RelationshipService
    participant ST as StrategyService
    participant SDK as agent/sdkClient
    participant DB as SQLite
    participant EXT as CodeBuddy CLI

    U->>UI: 输入「真的好累，做不完」
    UI->>API: POST /api/chat/stream (SSE)
    API->>CS: streamReply({userId, characterId, text})
    CS->>DB: INSERT messages(user) + UPDATE conversation
    CS-->>UI: SSE {type:'meta', userMessageId, assistantMessageId}
    UI->>UI: 渲染用户气泡 + AI「正在输入」

    CS->>SF: checkIncoming(text)
    alt 命中红线
        SF-->>CS: {allowed:false, action:'blocked'}
        CS->>SF: buildRefusal(character)
        SF-->>CS: 温柔拒绝 + 转移话题文本
        CS-->>UI: SSE {type:'replace', content}
        CS->>DB: INSERT messages(assistant, strategy='blocked')
        CS-->>UI: SSE {type:'done'}
    else 正常
        CS-->>UI: SSE {type:'status', stage:'analyzing'}
        par 并行预取
            CS->>PS: get/renderPersonaBlock(character)
            CS->>ES: getState() (先 decay)
            CS->>MS: buildShortTermContext(conversationId)
            CS->>MS: getAnchorMemories()
        end
        CS->>UE: analyze(text, recentUserTexts, history)
        UE->>SDK: 结构化 JSON 调用(情绪)
        SDK->>EXT: spawn node cli/bin/codebuddy
        EXT-->>SDK: assistant(JSON)
        SDK-->>UE: {emotion,valence,intensity,intent,shareDepth,...}
        UE->>DB: INSERT user_emotion_analyses
        UE-->>CS: UserEmotionAnalysis

        CS->>MS: retrieve(text)
        MS-->>CS: memories(top6)
        CS->>RS: recordInteraction(shareDepth)
        RS->>DB: UPSERT relationship_states + active_days
        RS-->>CS: RelationshipState
        CS-->>UI: SSE {type:'relationship', stage}
        CS->>ST: select(userEmotion, aiEmotion, relationship, recentStrategies)
        ST-->>CS: {strategy:'listening', hints, forbid}
        CS-->>UI: SSE {type:'strategy', strategy:'listening'}

        CS->>CS: buildSystemPrompt(L0+L1+L2+L3+L8)<br/>buildContextBlock(L4+L5+L6+L7+本轮输入)
        CS-->>UI: SSE {type:'status', stage:'generating'}
        CS->>SDK: streamText(prompt, {systemPrompt, model, abortController})
        SDK->>EXT: spawn node cli/bin/codebuddy --output-format stream-json
        loop 流式的每一条 assistant 消息
            EXT-->>SDK: {type:'assistant', message.content:[{type:'text'}]}
            SDK->>SDK: delta = diff(fullText, lastFullText)
            SDK-->>CS: yield delta
            CS-->>UI: SSE {type:'text', content: delta}
            UI->>UI: 追加渲染 + 自动滚动
        end
        EXT-->>SDK: {type:'result', subtype:'success'}
        SDK-->>CS: 完整文本 + usage

        CS->>SF: checkOutgoing(fullText)
        alt 违规可替换
            SF-->>CS: {action:'rewritten', rewritten}
            CS-->>UI: SSE {type:'replace', content: rewritten}
        end
        CS->>DB: INSERT messages(assistant, aiEmotion, strategy, userEmotion, meta)

        CS-->>UI: SSE {type:'status', stage:'postprocessing'}
        CS->>ES: applyTransition(reply, userEmotion, strategy)
        ES->>SDK: 结构化 JSON 调用(AI情绪)
        SDK-->>ES: {emotion:'caring', intensity:0.62, reason}
        ES->>DB: UPSERT emotion_states
        ES-->>CS: EmotionState
        CS-->>UI: SSE {type:'emotion', emotion:'caring', intensity:0.62}

        CS->>MS: shouldExtract? → extract(text, userEmotion)
        alt 触发抽取
            MS->>SDK: 结构化 JSON 调用(记忆抽取)
            SDK-->>MS: {memories:[...]}
            MS->>MS: dedupe(精确键 + bigram Jaccard)
            MS->>DB: INSERT/UPDATE memories
            MS-->>CS: newMemories
            CS-->>UI: SSE {type:'memory', action:'added', items}
        end
        CS->>MS: compressIfNeeded(conversationId)
        CS-->>UI: SSE {type:'done', messageId, usage}
    end
    UI->>UI: isStreaming=false，收起输入指示器
```

### 5.2 后台主动聊天 Job

```mermaid
sequenceDiagram
    autonumber
    participant SC as Scheduler(setInterval 10min)
    participant DB as SQLite
    participant DS as ProactiveDecisionService
    participant PS as PersonaService
    participant ES as EmotionService
    participant MS as MemoryService
    participant RS as RelationshipService
    participant UE as UserEmotionService
    participant GEN as ProactiveGeneratorService
    participant SF as SafetyService
    participant SDK as sdkClient
    participant NS as NotificationService
    participant PUSH as 浏览器 Push Service
    participant SW as Service Worker
    participant U as 用户

    SC->>DB: listProactiveTargets() (enabled=1 的 user×character)
    loop 每个 target
        SC->>DB: tryAcquireRunLock(characterId, windowKey)
        alt 抢锁失败(已被处理/并发实例)
            DB-->>SC: false → 跳过
        else 抢锁成功
            SC->>DB: findDueScheduledTasks(userId, characterId)
            alt 有到期的 delay 任务
                SC->>DS: decide(ctx) 复评
                DS-->>SC: {decision:'send'|'expired'}
            end

            SC->>DB: 读取 settings / 计数 / 最近消息 / heartbeat
            SC->>PS: get(character)
            SC->>ES: getState() (decay)
            SC->>UE: latest(userId, characterId)
            SC->>RS: get() + expressionParams(stage)
            SC->>MS: retrieve(最近话题) + getAnchorMemories()
            SC->>DS: decide(ctx)

            DS->>DS: Step1 硬否决 V1..V11
            alt 命中否决
                DS-->>SC: {decision:'skip', reasonCode:'dnd'}
                SC->>DB: INSERT task(status='skipped', reason_code, score, factors)
            else 无否决
                DS->>DS: Step2 七因子加权打分
                alt score < 0.45
                    DS-->>SC: {decision:'skip'}
                    SC->>DB: INSERT task(status='skipped')
                else 0.45 ≤ score < 0.62
                    DS-->>SC: {decision:'delay', delayMinutes:75}
                    SC->>DB: INSERT task(status='scheduled', scheduled_at=now+75min)
                else score ≥ 0.62 → send
                    DS-->>SC: {decision:'send', score, factors}
                    SC->>DB: INSERT task(status='sending')
                    SC->>GEN: generate(ctx + intent)
                    GEN->>SDK: 结构化 JSON 调用(主动消息)
                    SDK-->>GEN: {content, intent:'follow_up'}
                    GEN->>SF: checkOutgoing(content, {isProactive:true})
                    alt 命中 GUILT_TRIP/DEPENDENCY/…
                        SF-->>GEN: {allowed:false}
                        GEN-->>SC: 丢弃（★ 不重试生成，记 safety_logs）
                        SC->>DB: task(status='failed', last_error='safety:GUILT_TRIP')
                    else 通过
                        SF-->>GEN: {allowed:true, rewritten?}
                        GEN-->>SC: content
                        SC->>DB: INSERT messages(assistant, is_proactive=1, is_read=0)
                        SC->>DB: bumpDailyCounter(userId, characterId, day)
                        SC->>ES: applyTransition(caring, cap 0.35)
                        SC->>NS: send({userId, title:character.name, body:content, url, tag})
                        NS->>DB: SELECT push_subscriptions WHERE user_id
                        loop 每个订阅
                            NS->>PUSH: webpush.sendNotification(sub, payload)
                            alt 404/410
                                PUSH-->>NS: Gone
                                NS->>DB: DELETE push_subscriptions
                            else 201
                                PUSH-->>NS: Created
                            end
                        end
                        alt 全部失败且可重试
                            NS-->>SC: {ok:false, retryable:true}
                            SC->>DB: scheduleRetry(task, 退避 1/5/15min, attempts+1)
                        else 成功
                            NS-->>SC: {ok:true}
                            SC->>DB: task(status='sent', message_id)
                            PUSH->>SW: push 事件
                            SW->>U: showNotification(character.name, content)
                        end
                    end
                end
            end
            SC->>DB: proactive_runs.status='done'
        end
    end
    U->>SW: 点击通知
    SW->>SW: clients.openWindow('/chat?c=..&m=..')
    Note over SC: 用户打开 App → GET /api/proactive/inbox → POST /api/proactive/ack
```

### 5.3 推送订阅与点击

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant UI as SettingsPage/usePush
    participant API as routes/pushRoutes
    participant DB as SQLite
    participant SW as Service Worker
    participant BR as 浏览器 Push Service

    U->>UI: 打开「允许推送通知」开关
    UI->>API: GET /api/push/vapid-public-key
    API-->>UI: {publicKey}
    UI->>SW: navigator.serviceWorker.register('/sw.js')
    SW-->>UI: registration
    UI->>UI: Notification.requestPermission()
    alt 用户拒绝
        UI->>UI: 开关回弹 + 说明「可在浏览器设置里开启」
    else 用户同意
        UI->>SW: registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})
        SW->>BR: 订阅请求
        BR-->>SW: PushSubscription{endpoint, keys}
        SW-->>UI: subscription
        UI->>API: POST /api/push/subscribe {userId, subscription}
        API->>DB: INSERT OR REPLACE push_subscriptions
        API-->>UI: {ok, subscriptionId}
        UI->>UI: 开关置开 + localStorage 标记
        U->>UI: 点「发一条测试通知」
        UI->>API: POST /api/push/test
        API->>BR: webpush.sendNotification
        BR->>SW: push 事件
        SW->>U: showNotification('需恋', '这是来自林晚的测试消息')
        U->>SW: 点击通知
        SW->>SW: notification.close() + clients.openWindow('/chat?c=xxx')
    end
    Note over UI: 卸载 / 关闭推送 → DELETE /api/push/unsubscribe
    Note over API: Scheduler 收到 404/410 → 自动清理失效订阅
```

### 5.4 （补充）首启动 Bootstrap

```mermaid
sequenceDiagram
    participant UI as App/main.tsx
    participant LS as localStorage
    participant API as /api/users/bootstrap
    participant DB as SQLite
    participant PS as PersonaService
    participant ES as EmotionService
    participant RS as RelationshipService

    UI->>LS: get 'xulian.userId'
    alt 不存在
        UI->>UI: userId = crypto.randomUUID()
        UI->>LS: set 'xulian.userId'
    end
    UI->>API: POST /api/users/bootstrap {clientUserId: userId, timezone}
    API->>DB: SELECT users WHERE id=?
    alt 不存在
        DB-->>API: null
        API->>DB: BEGIN
        API->>DB: INSERT users
        API->>PS: create(userId, PRESET_WARM) → INSERT ai_characters(is_default=1)
        API->>ES: resetState(userId, characterId, 'calm')
        API->>RS: init(userId, characterId, floorStage='stranger')
        API->>DB: COMMIT
    end
    API-->>UI: {user, characters[], defaultCharacterId}
    UI->>UI: 进入 HomePage
```

---

## 6. Agent SDK 集成方案（★ 可直接照着写）

> 依据：已 WebFetch 官方 `sdk-typescript` 与 `sdk` 概览文档（v0.1.0+），并已核对本地 `node_modules/@tencent-ai/agent-sdk@0.3.251`。

### 6.1 `query()` 还是 `unstable_v2_createSession()`？

**结论：用 `query()`。** 理由：

| 维度 | `query()` | `unstable_v2_createSession()` |
|---|---|---|
| 稳定性 | 正式 API | **unstable_v2 前缀，实验性，可能变更** |
| `systemPrompt` | ✅ `Options.systemPrompt: string \| {append}` | ❌ `SessionOptions` **未列出** `systemPrompt`（文档明确未给出类型） |
| 每轮换 systemPrompt | ✅ 每次调用全新 | ❌ 会话级固定，我们的 L1/L2/L3 **每轮都在变**（情绪、关系、策略） |
| 上下文控制 | 我们自己拼 prompt，可做滚动摘要与记忆裁剪 | SDK 内部维护 transcript，无法裁剪 |
| 后台任务 | 自动禁用（我们不需要） | 支持（我们不需要） |
| 复杂度 | 低 | 需手动 `send()` + 反复 `stream()` + `close()` |

**因此：不启用 `resume`。** 我们自己维护 `messages` 表并组装上下文（`persistSession: false` 避免 transcript 落盘）。

### 6.2 CLI 可执行文件（本机未全局安装 codebuddy）— 已验证方案

**已确认事实**：`node_modules/@tencent-ai/agent-sdk/cli/bin/codebuddy` **存在**（19MB，含 `dist-server/`、`builtin/`），是一个 `#!/usr/bin/env node` 的 JS 入口。**SDK 包自带 CLI，npm 可安装（github 被墙不影响）**。

```ts
// server/agent/cli.ts
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const CANDIDATES = [
  process.env.CODEBUDDY_CODE_PATH,
  path.join(PROJECT_ROOT, 'node_modules/@tencent-ai/agent-sdk/cli/bin/codebuddy'),
  path.join(PROJECT_ROOT, 'node_modules/@tencent-ai/codebuddy-code/bin/codebuddy.js'),
  path.join(PROJECT_ROOT, 'node_modules/.bin/codebuddy'),
].filter(Boolean) as string[];

let cached: string | null = null;

/** 解析出可用的 CLI 路径，找不到就抛出带修复指引的错误 */
export function resolveCliPath(): string {
  if (cached) return cached;
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) { cached = p; return p; }
  }
  throw new Error(
    '[需恋] 找不到 CodeBuddy CLI。请执行以下任一操作：\n' +
    '  1) npm i -D @tencent-ai/codebuddy-code\n' +
    '  2) 或设置环境变量 CODEBUDDY_CODE_PATH=<cli 可执行文件绝对路径>\n' +
    '  3) 或 npm i -g @tencent-ai/codebuddy-code 后确保 codebuddy 在 PATH 中'
  );
}

/** 沙箱工作目录：SDK 需要 cwd，但不该读写项目源码 */
export function resolveSandboxCwd(): string {
  const dir = path.join(PROJECT_ROOT, 'server', '.agent-sandbox');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
```

**Windows 兼容**：SDK 默认以 `node <cliPath> ...` 方式 spawn（`Options.executable` 默认 `'node'`），因此直接把 `cli/bin/codebuddy` 的绝对路径传给 `pathToCodebuddyCode` 在 Windows 上也能工作（是 node 执行脚本，不是靠 shebang）。
若实测失败（取决于 SDK 内部实现），**降级方案**：显式传 `executable: 'node', executableArgs: [cliPath]`，并把 `pathToCodebuddyCode` 留空/同值。两种写法都在 `sdkClient.ts` 里用 `CLI_MODE` 常量切换（默认 `'path'`，环境变量 `CODEBUDDY_CLI_MODE='executableArgs'` 可切）。

> **任务 T01 的验收项之一**：写一个 `scripts/probe-sdk.ts`，跑一次 `query()` 打印 `system(init)` 消息的 `session_id` 与 `model`，确认 CLI 能被 spawn 且鉴权通过。这是整个项目的**第一个阻塞点**，必须最先验证。

### 6.3 `sdkClient.ts` 设计

```ts
// server/agent/sdkClient.ts
import { query, AbortError, type Message } from '@tencent-ai/agent-sdk';
import { resolveCliPath, resolveSandboxCwd } from './cli.js';
import { logger } from '../logger.js';
import { SDK_TIMEOUT_MS, DEFAULT_MODEL, MAX_TURNS } from '../env.js';

export interface StreamTextOptions {
  prompt: string;
  systemPrompt: string;
  model?: string;
  signal?: AbortSignal;
  /** 结构化 JSON 输出时设为 true（后处理用），会额外收紧输出契约 */
  jsonMode?: boolean;
  temperatureHint?: 'precise' | 'balanced' | 'creative';
}

export interface StreamTextResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
  sessionId?: string;
}

const NO_TOOLS_DENY = async () => ({
  behavior: 'deny' as const,
  message: '此应用不需要任何工具',
});

/** 流式文本生成：yield 增量 delta（服务端做 diff，兼容 SDK 累积式/增量式两种行为） */
export async function* streamText(opts: StreamTextOptions): AsyncGenerator<{ delta: string }> {
  const q = buildQuery(opts);
  let last = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const content = msg.message.content;
      let full = '';
      if (typeof content === 'string') full = content;
      else for (const b of content) if (b.type === 'text') full += b.text;
      if (full.length > last.length) {
        const delta = full.startsWith(last) ? full.slice(last.length) : full;
        last = full;
        if (delta) yield { delta };
      }
    } else if (msg.type === 'result') {
      if (msg.subtype !== 'success') {
        logger.error('[SDK] result error', { subtype: msg.subtype, errors: (msg as any).errors });
      }
      break;   // ★ 第一个 result 即结束（query 语义）
    }
  }
}

/** 一次性文本生成（主动消息 / 后处理） */
export async function completeText(opts: StreamTextOptions): Promise<StreamTextResult> {
  const q = buildQuery(opts);
  let text = '';
  let usage: StreamTextResult['usage'];
  let sessionId: string | undefined;
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
    } else if (msg.type === 'assistant') {
      const c = msg.message.content;
      text = typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join('');
    } else if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        usage = {
          inputTokens: msg.usage?.input_tokens ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
          durationMs: msg.duration_ms,
        };
      } else {
        throw new SdkCallError((msg as any).errors?.join('; ') ?? `SDK error: ${msg.subtype}`, msg.subtype);
      }
      break;
    }
  }
  return { text, usage, sessionId };
}

function buildQuery(opts: StreamTextOptions) {
  const cliPath = resolveCliPath();
  const base = {
    cwd: resolveSandboxCwd(),
    model: opts.model ?? DEFAULT_MODEL,
    maxTurns: 1,                       // ★ 陪伴对话不需要多轮工具循环
    allowedTools: [],                  // ★ 白名单为空
    disallowedTools: ['*'],            // ★ 黑名单兜底
    canUseTool: NO_TOOLS_DENY,         // ★ 回调双保险
    permissionMode: 'default' as const,
    settingSources: [],                // ★ 不加载任何文件系统配置（干净环境，防读项目代码）
    persistSession: false,             // 我们自己管上下文，不落 transcript
    includePartialMessages: false,     // 用服务端 diff 做增量即可
    abortController: opts.signal ? toAbortController(opts.signal) : undefined,
    env: buildEnv(),
  };
  const systemPrompt = opts.jsonMode
    ? `${opts.systemPrompt}\n\n## 输出格式\n只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要前后缀文字。`
    : opts.systemPrompt;

  return query({
    prompt: opts.prompt,
    options: { ...base, systemPrompt,
      ...(CLI_MODE === 'executableArgs'
        ? { executable: 'node' as const, executableArgs: [cliPath] }
        : { pathToCodebuddyCode: cliPath }),
    },
  });
}

function buildEnv(): Record<string, string | undefined> {
  return {
    CODEBUDDY_API_KEY: process.env.CODEBUDDY_API_KEY,
    CODEBUDDY_AUTH_TOKEN: process.env.CODEBUDDY_AUTH_TOKEN,
    CODEBUDDY_INTERNET_ENVIRONMENT: process.env.CODEBUDDY_INTERNET_ENVIRONMENT, // 中国版需 'internal'
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
  };
}
```

### 6.4 错误处理与重试

```ts
// server/agent/errors.ts
export class SdkCallError extends Error {
  constructor(message: string, public subtype: string, public retryable = false) { super(message); }
}
```

| 场景 | 检测 | 处理 |
|---|---|---|
| `result.subtype = 'error_during_execution'` | `msg.errors[]` / `errors_info[].category` | `category ∈ {network, quota, model_service}` → **可重试**；`auth` → 不可重试，记 `E_AI_AUTH`；`internal` → 可重试 1 次 |
| `result.subtype = 'error_max_turns'` | — | 不应该发生（`maxTurns:1`），记 warn |
| `AbortError` | `error instanceof AbortError` | 用户主动中断，**不算错误**，已生成内容落库 |
| CLI spawn 失败（`CLINotFound` / ENOENT） | stderr 含 `not found` / `ENOENT` | 不可重试，立即 `E_AI_CLI_NOT_FOUND`，提示修复指引 |
| 进程超时 | 自建 `setTimeout(SDK_TIMEOUT_MS)` → `abort()` | 可重试 1 次（退避 2s） |
| 输出不是合法 JSON（jsonMode） | `JSON.parse` 抛错 | **可重试 1 次**，重试时追加「上一次输出不合法，请严格只输出 JSON」；再失败则用规则层结果兜底 |

**重试策略**（`server/agent/retry.ts`）：`withRetry(fn, { retries: 2, baseDelayMs: 800, factor: 2, jitter: true })`，仅对 `retryable` 错误重试。
**并发控制**：全局信号量（`p-limit` 手写版，20 行）限制同时进行的 SDK 调用 ≤ 4，防止 CI 子进程爆炸。

### 6.5 模型与参数默认值

| 项 | 默认值 | 环境变量 |
|---|---|---|
| 主对话模型 | `claude-sonnet-4` | `XULIAN_MODEL` |
| 后处理模型（情绪/记忆/关系/主动消息） | 同主模型 | `XULIAN_LIGHT_MODEL`（可设更快更便宜的） |
| maxTurns | `1` | — |
| SDK 调用超时 | 90s（主对话）/ 30s（后处理/JSON） | `SDK_TIMEOUT_MS` / `SDK_LIGHT_TIMEOUT_MS` |
| 温度提示 | 只通过 Prompt 措辞控制（SDK 未暴露 temperature） | — |

### 6.6 鉴权（API Key 绝不进前端）

- 服务端 `server/env.ts` 在**进程启动时** `dotenv.config()` 加载 `.env`，并校验 `CODEBUDDY_API_KEY || CODEBUDDY_AUTH_TOKEN` 至少存在一个（缺失则 `logger.error` 并在 `/api/health` 返回 `aiConfigured:false`，**不崩溃**，方便先跑 UI）。
- `buildEnv()` 把 key 传给子进程；**任何日志、任何响应体都不得出现 key**（`logger` 内置 `redact()` 正则）。
- 前端**永不**接触 key；`vite.config.ts` 不得 `define` 任何 key。
- 提供 `.env.example`（见 §8.7）。

---

## 7. 文件清单与目录结构

```
D:/需恋/xulian
├── .env.example                        ★新增 环境变量样例（含中文注释）
├── .gitignore                          ▲改造 追加 .env / data/ / server/.agent-sandbox / *.db
├── .editorconfig                       ★新增
├── index.html                          ▲改造 需恋 + PWA meta + viewport-fit=cover + theme-color
├── package.json                        ▲改造 加 web-push/dotenv；scripts 加 dev:host / push:keys / probe:sdk
├── vite.config.ts                      ▲改造 host 0.0.0.0 + strictPort false + /api proxy（SSE 友好）
├── tailwind.config.js                  ▲改造 需恋色板（见 §8.6）
├── tsconfig.json                       ▲改造 include: ["src","shared"]；paths 加 @/*
├── tsconfig.node.json                  ＝保留
├── postcss.config.js                   ＝保留
├── README.md                           ▲改写 需求 §29 的 15 个交付问答
├── DEVELOPMENT.md                      ▲改写 开发/调试/测试指引
│
├── shared/                             ★新增 前后端共享（纯 TS，无运行时依赖）
│   ├── constants.ts                    情绪锚点、策略表、记忆分类、关系阈值、红线词库 Key
│   ├── types.ts                        领域类型（AICharacter/EmotionState/MemoryItem/…）
│   ├── sse.ts                          SSE 事件联合类型 ChatSseEvent
│   └── errors.ts                       错误码枚举 ErrorCode
│
├── scripts/                            ★新增
│   ├── probe-sdk.ts                    验证 CLI + 鉴权 + query() 能跑通（T01 验收）
│   └── gen-vapid-keys.ts              生成 VAPID 密钥对（写入 .env）
│
├── public/                             ★新增
│   ├── manifest.webmanifest            PWA 清单（name 需恋、standalone、icons）
│   ├── sw.js                           Service Worker：push / notificationclick / 静态缓存
│   ├── offline.html                    离线兜底页
│   ├── icon-192.png / icon-512.png     自绘 Logo（心形+对话气泡，渐变）
│   └── apple-touch-icon.png
│
├── server/
│   ├── index.ts                        ▲重构 → 45 行：env → db → app → routes → scheduler
│   ├── env.ts                          ★新增 dotenv + 环境变量类型化 + 校验
│   ├── logger.ts                       ★新增 分级日志 + 敏感信息脱敏
│   ├── errors.ts                       ★新增 ApiError / ErrorCode / asyncHandler
│   ├── http.ts                         ★新增 统一响应包装 ok()/fail() + resolveUser 中间件
│   ├── types.ts                        ★新增 服务端内部类型（Service 输入/输出）
│   ├── config/
│   │   ├── defaults.ts                 ★新增 默认设置、阈值、权重（集中可调）
│   │   └── crisisLines.ts              ★新增 心理危机热线（按地区）
│   │
│   ├── db/
│   │   ├── index.ts                    ▲重构（原 server/db.ts）连接 + PRAGMA + schema + 迁移
│   │   ├── schema.sql                  ★新增 完整 DDL（§3.1）
│   │   ├── migrations.ts               ★新增 版本化迁移
│   │   ├── json.ts                     ★新增 JSON 列 helper
│   │   └── repositories/
│   │       ├── users.repo.ts           ★新增 users / active_days
│   │       ├── characters.repo.ts      ★新增 ai_characters
│   │       ├── conversations.repo.ts   ★新增 conversations / messages
│   │       ├── memories.repo.ts        ★新增 memories（含去重查询）
│   │       ├── states.repo.ts          ★新增 emotion_states / user_emotion_analyses / relationship_states
│   │       ├── proactive.repo.ts       ★新增 tasks / runs / daily_counters
│   │       ├── push.repo.ts            ★新增 push_subscriptions
│   │       └── safety.repo.ts          ★新增 safety_logs
│   │
│   ├── agent/
│   │   ├── cli.ts                      ★新增 CLI 路径解析 + 沙箱 cwd
│   │   ├── sdkClient.ts                ★新增 query() 封装 / 流式 diff / completeText
│   │   ├── errors.ts                   ★新增 SdkCallError
│   │   ├── retry.ts                    ★新增 withRetry + 并发信号量
│   │   └── prompts.ts                  ★新增 SAFETY_CONSTITUTION + 8 层模板 + 各服务 prompt
│   │
│   ├── services/
│   │   ├── personaService.ts           ★新增
│   │   ├── emotionService.ts           ★新增 AI 情绪：衰减 + 规则 + LLM + 红线
│   │   ├── userEmotionService.ts       ★新增 规则+LLM 融合、trend、危机检测
│   │   ├── strategyService.ts          ★新增 策略选择器 + hints/forbid
│   │   ├── memoryService.ts            ★新增 短期滚动摘要 + 长期抽取/去重/检索
│   │   ├── relationshipService.ts      ★新增 只增不减的成长算法
│   │   ├── chatService.ts              ★新增 编排中枢（AsyncGenerator<SseEvent>）
│   │   ├── safetyService.ts            ★新增 入/出方向规则 + L0 宪法 + 危机回复
│   │   ├── notificationService.ts      ★新增 接口 + WebPush 实现 + 失效清理
│   │   └── proactive/
│   │       ├── decisionService.ts      ★新增 否决 + 打分 + 阈值
│   │       ├── generatorService.ts     ★新增 意图选择 + 生成 + 安全
│   │       └── scheduler.ts            ★新增 tick + 幂等锁 + 重试 + 启动/停止
│   │
│   ├── routes/
│   │   ├── index.ts                    ★新增 路由汇总挂载
│   │   ├── metaRoutes.ts               ★新增 /health /config
│   │   ├── userRoutes.ts               ★新增
│   │   ├── characterRoutes.ts          ★新增
│   │   ├── conversationRoutes.ts       ★新增
│   │   ├── chatRoutes.ts               ★新增 SSE /chat/stream、/messages/:id/regenerate
│   │   ├── emotionRoutes.ts            ★新增
│   │   ├── relationshipRoutes.ts       ★新增
│   │   ├── memoryRoutes.ts             ★新增
│   │   ├── proactiveRoutes.ts          ★新增
│   │   ├── pushRoutes.ts               ★新增
│   │   └── presenceRoutes.ts           ★新增 heartbeat
│   │
│   ├── .agent-sandbox/                 ★新增（gitignore）SDK 的 cwd 空目录
│   └── data/                           （运行时生成）xulian.db / -wal / -shm
│
└── src/
    ├── main.tsx                        ▲改造 SW 注册 + 主题初始化 + 标题「需恋」
    ├── App.tsx                         ▲重写 手机路由（TabBar + Stack）
    ├── index.css                       ▲改造 需恋主题变量 + 安全区 + 流式动画
    ├── config.ts                       ▲改造 APP_CONFIG = 需恋
    ├── vite-env.d.ts                   ★新增
    │
    ├── types/
    │   ├── index.ts                    ▲改造（原 src/types.ts 拆分）
    │   ├── api.ts                      ★新增 请求/响应类型（对齐 server）
    │   └── ui.ts                       ★新增 纯 UI 类型
    │
    ├── api/
    │   ├── client.ts                   ★新增 fetch 封装（自动带 X-User-Id、错误码映射）
    │   └── sse.ts                      ★新增 POST+SSE 流式解析（复用模板 getReader 模式）
    │
    ├── hooks/
    │   ├── useUserId.ts                ★新增 localStorage userId + bootstrap
    │   ├── useChat.ts                  ▲重写 对接新 SSE（流式/中断/重试/重新生成）
    │   ├── useCharacters.ts            ★新增（替代 useAgents）
    │   ├── useConversations.ts         ★新增（替代 useSessions）
    │   ├── useMemories.ts              ★新增
    │   ├── useProactive.ts             ★新增 inbox 轮询 + ack + status
    │   ├── usePush.ts                  ★新增 订阅/退订/测试
    │   ├── useHeartbeat.ts             ★新增 每 60s heartbeat
    │   └── useTheme.ts                 ＝改造（保留）
    │
    ├── components/
    │   ├── common/
    │   │   ├── TabBar.tsx              ★新增 底部导航（聊天/角色/记忆/我的）
    │   │   ├── AppHeader.tsx           ★新增 顶部标题栏（含返回）
    │   │   ├── EmptyState.tsx          ★新增 空状态
    │   │   ├── Sheet.tsx               ★新增 底部弹层（长按菜单用）
    │   │   └── SwipeBack.tsx           ★新增（可选）手势返回
    │   ├── chat/
    │   │   ├── MessageList.tsx         ★新增 气泡列表 + 自动滚动 + 日期分隔
    │   │   ├── MessageBubble.tsx       ★新增 用户/AI 气泡 + 长按菜单 + 时间
    │   │   ├── TypingIndicator.tsx     ★新增 三点跳动「正在输入」
    │   │   ├── ChatComposer.tsx        ★新增 输入框 + 发送 + 键盘适配 + 草稿
    │   │   ├── MessageActionSheet.tsx  ★新增 删除/复制/重新生成
    │   │   ├── NetworkToast.tsx        ★新增 网络异常 + 重试按钮
    │   │   └── StreamCursor.tsx        ★新增 流式光标
    │   ├── home/
    │   │   ├── CharacterHeroCard.tsx   ★新增 当前角色 + 情绪 + 状态
    │   │   ├── EmotionBadge.tsx        ★新增 情绪图标+色+文字（真数据）
    │   │   ├── RelationshipBar.tsx     ★新增 关系进度条（真数据）
    │   │   ├── RecentChatPreview.tsx   ★新增 最近聊天 + 快捷进入
    │   │   ├── ProactiveInboxCard.tsx  ★新增 未读主动消息
    │   │   └── CharacterSwitcher.tsx   ★新增 角色切换
    │   ├── character/
    │   │   ├── CharacterEditor.tsx     ★新增 创建/编辑表单容器（替代 AgentConfigDialog）
    │   │   ├── PersonaForm.tsx         ★新增 基础/人格/情绪/互动/关系 5 段
    │   │   ├── AvatarPicker.tsx        ★新增 Emoji / 渐变 / 预设头像
    │   │   ├── PresetGallery.tsx       ★新增 6 个预设选择
    │   │   └── ProactiveSettingsForm.tsx ★新增 主动聊天设置（开关/上限/时段/免打扰）
    │   ├── memory/
    │   │   ├── MemoryManager.tsx       ★新增 记忆列表（按分类分组）
    │   │   ├── MemoryItemRow.tsx       ★新增 单条：编辑/删除
    │   │   └── MemoryEmptyState.tsx    ★新增
    │   └── settings/
    │       ├── SettingsPage.tsx        ▲移动改造 设置总页
    │       ├── PushSettings.tsx        ★新增 推送开关 + 测试
    │       ├── PrivacySettings.tsx     ★新增 长期记忆开关 + 数据删除
    │       ├── ProactiveDebugPanel.tsx ★新增 ★「为什么 AI 没找我」决策可视化
    │       └── AboutPanel.tsx          ★新增 版本 + AI 身份说明（诚实披露）
    │
    ├── pages/
    │   ├── HomePage.tsx                ★新增 首页（需求 §16）
    │   ├── ChatPage.tsx                ▲重写 手机聊天页（需求 §15）
    │   ├── CharacterListPage.tsx       ★新增 角色管理
    │   ├── CharacterEditPage.tsx       ★新增 角色创建/编辑（需求 §17）
    │   ├── MemoryPage.tsx              ★新增 记忆管理
    │   └── SettingsPage.tsx            ★新增 设置
    │
    └── utils/
        ├── emotionMeta.ts              ★新增 情绪 → 图标/颜色/中文（数据来自 shared/constants）
        ├── time.ts                     ★新增 相对时间、日期分隔、时区
        ├── haptics.ts                  ★新增 navigator.vibrate 轻震动
        ├── scroll.ts                   ★新增 自动滚动到底/离底判定
        └── id.ts                       ★新增 uuid 封装

图例：★新增  ▲改造/重写  ＝保留
```

---

## 8. 共享知识与跨文件约定

### 8.1 类型定义放哪

| 内容 | 位置 | 谁 import |
|---|---|---|
| 领域枚举/常量（情绪锚点、策略、阈值、红线词库 key） | `shared/constants.ts` | 前端 + 后端 |
| 领域类型（`AICharacter`、`EmotionState`、`MemoryItem`…） | `shared/types.ts` | 前端 + 后端 |
| SSE 事件联合类型 | `shared/sse.ts` | 前端 `api/sse.ts` + 后端 `chatService` |
| 错误码枚举 | `shared/errors.ts` | 两端 |
| 纯前端 UI 类型 | `src/types/ui.ts` | 仅前端 |
| 请求/响应 DTO | `src/types/api.ts`（前端） + `server/types.ts`（后端） | 各自 |
| 运行时配置常量 | `server/config/defaults.ts` | 仅后端 |

**import 约定**（ESM + tsx）：后端引用本地模块**带 `.js` 后缀**（`import { x } from '../shared/constants.js'`），与模板 `server/index.ts` 里的 `./db.js` 一致；前端用 Vite 别名 `@/` → `src/`，不带后缀。

### 8.2 错误码规范

```ts
// shared/errors.ts
export const ErrorCode = {
  // 4xx
  BAD_REQUEST:        'E_BAD_REQUEST',
  USER_NOT_FOUND:     'E_USER_NOT_FOUND',
  FORBIDDEN:          'E_FORBIDDEN',            // userId 与资源不匹配
  NOT_FOUND:          'E_NOT_FOUND',
  VALIDATION:         'E_VALIDATION',
  EMPTY_MESSAGE:      'E_EMPTY_MESSAGE',
  MEMORY_DISABLED:    'E_MEMORY_DISABLED',
  PUSH_NOT_SUPPORTED: 'E_PUSH_NOT_SUPPORTED',
  // 5xx
  INTERNAL:           'E_INTERNAL',
  DB_ERROR:           'E_DB_ERROR',
  AI_AUTH:            'E_AI_AUTH',              // API Key 无效/未配置
  AI_CLI_NOT_FOUND:   'E_AI_CLI_NOT_FOUND',
  AI_TIMEOUT:         'E_AI_TIMEOUT',
  AI_UNAVAILABLE:     'E_AI_UNAVAILABLE',
  PUSH_FAILED:        'E_PUSH_FAILED',
} as const;
```

- HTTP 状态 + body `{ok:false, error:{code, message, details?}}`。
- SSE 内错误走 `{type:'error', data:{code, message, retryable}}`，并**同时** `res.end()`。
- 前端 `api/client.ts` 统一把 `E_AI_*` 映射为中文提示：
  - `E_AI_AUTH` → 「AI 服务未配置好，请检查服务端的 API Key」
  - `E_AI_CLI_NOT_FOUND` → 「AI 运行环境未就绪」
  - `E_AI_TIMEOUT` / `E_AI_UNAVAILABLE` → 「网络不太稳，点一下重试」（显示重试按钮）

### 8.3 SSE 事件协议

见 §4.2 表格。补充规则：

- 每行格式：`data: <JSON>\n\n`（不使用自定义 `event:` 名，前端按 `data.type` 分支，与模板一致）。
- 心跳：`res.write(': ping\n\n')` 每 15s。
- 顺序保证：`meta` 必须第一个；`done` 或 `error` 必须最后一个。
- 客户端中断：前端 `AbortController` → `fetch` 中止 → 后端 `req.on('close')` 触发 `abortController.abort()` + `q.interrupt()`。

```ts
// shared/sse.ts
export type ChatSseEvent =
  | { type: 'meta'; conversationId: string; userMessageId: string; assistantMessageId: string; characterId: string }
  | { type: 'status'; stage: 'safety'|'analyzing'|'retrieving'|'generating'|'postprocessing'; label: string }
  | { type: 'text'; content: string }
  | { type: 'replace'; content: string }
  | { type: 'strategy'; strategy: StrategyType; reason: string }
  | { type: 'emotion'; emotion: EmotionType; intensity: number; reason: string }
  | { type: 'memory'; action: 'added'|'updated'; items: Array<{id:string;content:string;category:MemoryCategory}> }
  | { type: 'relationship'; stage: RelationshipStage; interactionLevel: number; leveledUp: boolean }
  | { type: 'done'; messageId: string; usage?: { inputTokens:number; outputTokens:number; durationMs:number } }
  | { type: 'error'; code: string; message: string; retryable: boolean };
```

### 8.4 时间与 ID

| 项 | 约定 |
|---|---|
| 存储 | ISO 8601 **UTC** 字符串：`new Date().toISOString()` |
| 传输 | 同上 |
| 展示 | 前端按浏览器本地时区；相对时间「刚刚 / 3 分钟前 / 昨天 14:20 / 9月2日」 |
| 「今天」的判定（频控计数、活跃天） | 按 `users.timezone`（默认 `Asia/Taipei`）算 `YYYY-MM-DD` |
| ID | `uuidv4()`（template 已有 `uuid@^9`）；表主键一律 `TEXT` |
| 去重键 | `sha1(category + ':' + normalize(content).slice(0,24))`，用 `node:crypto` |

### 8.5 日志规范

```ts
// server/logger.ts
logger.debug('[Memory] extract triggered', { userId, characterId, textLen });
logger.info ('[Proactive] decision', { characterId, score, decision, reasonCode });
logger.warn ('[DB] json parse failed, fallback', { table, column });
logger.error('[SDK] call failed', { err: err.message, subtype });
```
- 格式：`ISO时间 LEVEL [模块] 消息 {结构化字段}`。
- **禁止**打印：完整 prompt（只打长度）、API Key / Token、用户消息全文（打前 30 字 + 长度，且 `LOG_FULL_TEXT=1` 时才打全文，仅本地调试）。
- 生产 `LOG_LEVEL=info`，开发 `debug`。

### 8.6 视觉规范（需恋色板，`tailwind.config.js`）

| Token | 色值 | 用途 |
|---|---|---|
| `xulian-ink` | `#2B2733` | 主文字 |
| `xulian-sub` | `#7A7288` | 次要文字 |
| `xulian-bg` | `#FBFAFC` | 页面背景 |
| `xulian-card` | `#FFFFFF` | 卡片/气泡 |
| `xulian-mist` | `#EFEAF6` | 分隔线/底栏 |
| `xulian-blush`（主色） | `#F2A9B8` | 品牌粉：主按钮、AI 气泡描边 |
| `xulian-blush-deep` | `#E07E93` | 按压态 |
| `xulian-lilac` | `#B9A7E8` | 辅助紫：情绪强调 |
| `xulian-mint` | `#8FD3C7` | 成功/平静 |
| `xulian-amber` | `#FFB86B` | 开心/提醒 |
| `xulian-user-bubble` | `#F2A9B8` + 白字 | 用户气泡 |
| `xulian-ai-bubble` | `#FFFFFF` + 粉描边 | AI 气泡 |

- 圆角：`rounded-2xl`（20px）气泡、`rounded-3xl` 卡片。
- 字体：`system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif`（繁中优先）。
- 安全区：`padding-bottom: env(safe-area-inset-bottom)`；输入框 `bottom: env(safe-area-inset-bottom)`。
- 深色模式：`dark:` 变体 + `prefers-color-scheme`，默认跟随系统。
- **Logo**：心形轮廓 + 对话气泡的 SVG/PNG（自绘），不使用任何第三方品牌资产（需求 §18）。

### 8.7 环境变量清单（`.env.example`）

```bash
# ===== AI（CodeBuddy Agent SDK）=====
# 必填其一。API Key 只存在于服务端，任何时候都不要提交到 Git 或下发到前端。
CODEBUDDY_API_KEY=
# 企业 OAuth token（与 API Key 二选一）
CODEBUDDY_AUTH_TOKEN=
# 服务环境：留空=海外版；internal=中国版；ioa=iOA 版；cloudhosted=专享版；selfhosted=私有化
CODEBUDDY_INTERNET_ENVIRONMENT=
# 主对话模型 / 后处理模型（留空用默认 claude-sonnet-4）
XULIAN_MODEL=claude-sonnet-4
XULIAN_LIGHT_MODEL=

# ===== CLI（SDK 依赖）=====
# 留空则自动使用 node_modules/@tencent-ai/agent-sdk/cli/bin/codebuddy
CODEBUDDY_CODE_PATH=
# CLI 调用方式：path（默认） | executableArgs（Windows 兜底）
CODEBUDDY_CLI_MODE=path

# ===== 服务 =====
PORT=3000
NODE_ENV=development
LOG_LEVEL=debug
# 客户端访问的地址（用于 Vite proxy 与局域网调试），留空则同域
CLIENT_ORIGIN=http://localhost:5173

# ===== Web Push（VAPID）=====
# 用 npm run push:keys 生成
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_MAILTO=mailto:your@email.com

# ===== 主动聊天 =====
# Scheduler tick 间隔（毫秒），默认 10 分钟
PROACTIVE_TICK_MS=600000
# 是否开启调试路由（/api/proactive/tick 等），生产必须为 0
ENABLE_DEBUG_ROUTES=1

# ===== 其他 =====
# 默认时区（用于「今天」的判定）
APP_TZ=Asia/Taipei
SDK_TIMEOUT_MS=90000
SDK_LIGHT_TIMEOUT_MS=30000
```

### 8.8 前端目录/命名约定

- 组件：`PascalCase.tsx`，一个文件一个组件，同目录 `index.ts` 可选导出。
- Hooks：`useXxx.ts`，返回对象（不返回数组，除 `[state, setState]` 语义外）。
- 所有网络请求**必须**走 `src/api/client.ts`（统一注入 `X-User-Id`、统一错误提示）。
- 所有「情绪/关系/记忆/策略」数据**必须**来自 API，**禁止**前端 mock 兜底（需求 §27.2 不做假 UI）。开发期若后端未就绪，在 UI 上显示明确的「服务未就绪」状态，而不是假数据。

---

## 9. 任务列表

> **图例**：`P0`=阻塞主线 ｜ `P1`=主线 ｜ `P2`=可延后/增强
> **并行标记**：🅰/🅑 = 同组内可并行（互不改同一文件）
> 每个任务都应当「一次性写完整个模块」，避免来回切文件。

### Phase 1 — 基础设施（P0，必须最先完成且最先验证）

#### **T01 · 项目基础设施与 SDK 打通**（P0，依赖：无）

**涉及文件**
```
★ server/env.ts, server/logger.ts, server/errors.ts, server/http.ts, server/types.ts
★ server/config/defaults.ts
★ shared/constants.ts, shared/types.ts, shared/sse.ts, shared/errors.ts
★ server/agent/cli.ts, server/agent/sdkClient.ts, server/agent/errors.ts, server/agent/retry.ts
★ scripts/probe-sdk.ts, scripts/gen-vapid-keys.ts
▲ package.json（加 web-push@^3.6.7 / dotenv@^16.4.5；scripts 加 probe:sdk / push:keys / dev:host）
▲ tsconfig.json（include 加 shared；paths 加 @/*）
▲ index.html, vite.config.ts, tailwind.config.js, .gitignore
★ .env.example, .editorconfig
```

**验收标准**
1. `npm i` 完成后 `npx tsx scripts/probe-sdk.ts` **成功打印** `session_id` 与 `model`（证明 CLI 可 spawn + 鉴权通过）。这是**全项目第一个阻塞点**。
2. 若默认 `CODEBUDDY_CLI_MODE=path` 失败，切 `executableArgs` 模式能通过（两种模式都验证一次并把结论写进 `DEVELOPMENT.md`）。
3. `npm run dev` 能同时起 Vite(5173) + Express(3000)；手机通过 `http://<局域网IP>:5173` 可打开。
4. `/api/health` 返回 `{status:'ok', aiConfigured:true}`。
5. `.env` 被 gitignore；`.env.example` 存在且含全部变量。
6. `shared/` 目录能被 `src/` 与 `server/` 双向 import（`tsx server/index.ts` 不报模块解析错）。

#### **T02 · 数据层：schema、迁移、Repositories**（P0，依赖：T01）🅰

**涉及文件**
```
★ server/db/schema.sql, server/db/index.ts, server/db/migrations.ts, server/db/json.ts
★ server/db/repositories/{users,characters,conversations,memories,states,proactive,push,safety}.repo.ts
▲ server/db.ts → 删除（内容迁移到 server/db/index.ts）
```

**验收标准**
1. 冷启动（删掉 `server/data/`）能自动建库建表，`schema_meta.version=1`。
2. 全部 Repository 函数**首参为 `userId`**（除 `admin*`），跨表写在 `db.transaction()` 内。
3. `PRAGMA foreign_keys=ON`；删除 user 能级联删光其全部数据。
4. 提供一个 `npm run db:reset` 脚本（删库重建 + 灌一条演示数据）。
5. JSON 列解析失败时回退默认值并 warn，不抛异常。

#### **T03 · 前端骨架与手机端外壳**（P0，依赖：T01）🅱

**涉及文件**
```
▲ src/main.tsx, src/App.tsx, src/index.css, src/config.ts, src/vite-env.d.ts
★ src/types/{index,api,ui}.ts, src/api/client.ts, src/api/sse.ts
★ src/hooks/useUserId.ts, src/hooks/useTheme.ts(改造)
★ src/components/common/{TabBar,AppHeader,EmptyState,Sheet}.tsx
★ src/pages/{HomePage,ChatPage,CharacterListPage,MemoryPage,SettingsPage}.tsx（先占位）
★ public/manifest.webmanifest, public/offline.html
- 删除 src/components/{Header,Sidebar,NewChatView,NewChatDialog,AgentConfigDialog,
    PermissionDialog,InlinePermissionCard,ToolCallsCollapse}.tsx
- 删除 src/hooks/{useAgents,useSessions,useModels}.ts, src/types.ts, src/pages/ChatPage.tsx(旧)
```

**验收标准**
1. 手机视口（375×812）下底部 TabBar 固定、安全区正确，页面可切换，无横向滚动。
2. `localStorage.xulian.userId` 生成并持久化。
3. `api/client.ts` 自动注入 `X-User-Id`；`api/sse.ts` 能解析 `data:` 行并回调。
4. 舊模板的多会话/权限/工具 UI 代码**全部删除干净**（全局搜索 `permission`/`tool_call`/`useSessions` 无残留）。
5. 桌面 Chrome DevTools 移动模拟器 + 手机浏览器均可打开。

### Phase 2 — 核心聊天闭环（P0）

#### **T04 · Persona + 角色 CRUD + 安全宪法**（P0，依赖：T02, T03）🅰

**涉及文件**
```
★ server/services/personaService.ts
★ server/agent/prompts.ts（SAFETY_CONSTITUTION + L1/L2/L3/L8 模板 + 各服务 prompt 占位）
★ server/routes/characterRoutes.ts, server/routes/userRoutes.ts, server/routes/metaRoutes.ts
▲ server/routes/index.ts, server/index.ts
★ src/hooks/useCharacters.ts
★ src/components/character/{CharacterEditor,PersonaForm,AvatarPicker,PresetGallery}.tsx
▲ src/pages/{CharacterListPage,CharacterEditPage}.tsx
```

**验收标准**
1. `POST /api/users/bootstrap` 能创建用户 + 默认角色（预设 `warm`）+ 初始化情绪/关系态。
2. 角色 CRUD 全部可用；`GET /api/characters` 返回带 `emotion`/`relationship` 摘要。
3. `renderPersonaBlock()` 输出的文本里**稳定包含**名字/性格/风格/兴趣/喜好/关系类型/称呼 + 4 条稳定性约束。
4. 创建/编辑页在手机端可完整填完 5 段表单（基础/人格/情绪/互动/关系），6 个预设可选。
5. `SAFETY_CONSTITUTION` 8 条硬约束写死在 `prompts.ts`，且**所有**主对话/主动消息 prompt 都以它为开头。

#### **T05 · 端到端流式聊天（含 SSE 协议）**（P0，依赖：T04）🅱

**涉及文件**
```
★ server/services/chatService.ts
★ server/routes/chatRoutes.ts, server/routes/conversationRoutes.ts
▲ server/agent/sdkClient.ts（流式 diff 已就绪）
★ src/hooks/useChat.ts（重写）, src/hooks/useConversations.ts, src/hooks/useHeartbeat.ts
★ src/components/chat/{MessageList,MessageBubble,TypingIndicator,ChatComposer,
                        MessageActionSheet,NetworkToast,StreamCursor}.tsx
★ src/utils/{scroll,time,id}.ts
▲ src/pages/ChatPage.tsx
```

**验收标准**
1. 发消息 → 逐字流式渲染 → 自动滚动 → 光标消失 → 消息落库；刷新页面后历史完整。
2. SSE 事件齐全：`meta / status / text / strategy / emotion(占位) / memory(占位) / relationship(占位) / done / error`。
3. 中断：点「停止」→ 已生成内容保存，UI 正确收尾。
4. 失败：`/api/chat/stream` 人为抛错 → 显示「网络不太稳」+ 重试按钮；重试成功。
5. 长按消息 → 底部弹层 → 删除 / 复制 / 重新生成（`/regenerate` 可用）。
6. 空状态页、日期分隔、相对时间、AI 头像/用户头像均正确。
7. `systemPrompt` 中已包含 L0/L1/L2/L3/L8，context 块已包含 L4(占位)/L5(占位)/L6/L7(占位)。

### Phase 3 — AI 情绪 + 用户情绪 + 策略（P1）

#### **T06 · EmotionService：AI 情绪系统**（P1，依赖：T05）🅰

**涉及文件**
```
★ server/services/emotionService.ts
★ server/routes/emotionRoutes.ts
★ src/utils/emotionMeta.ts, src/components/home/EmotionBadge.tsx
▲ shared/constants.ts（情绪锚点表）, server/agent/prompts.ts（L3 + 情绪 LLM prompt）
```

**验收标准**
1. 情绪随时间衰减（τ 由 `emotionSensitivity` 决定）；强度 <0.15 回落 `calm@0.30`。
2. 规则表 R1–R11 全部实现；LLM 校正后**单次强度变化 ≤ 0.4**。
3. 沉默触发的情绪**只能是 `caring` 且强度 ≤ 0.35**（写单测断言）。
4. `emotionReason` 有内容且不含负罪感词（过 `checkOutgoing`）。
5. 改角色情绪敏感度 → 衰减速度变化可观察。
6. 首页 EmotionBadge 显示**真实**情绪（改 DB 后刷新 UI 同步变化）。

#### **T07 · UserEmotionService + StrategyService**（P1，依赖：T05）🅱

**涉及文件**
```
★ server/services/userEmotionService.ts, server/services/strategyService.ts
★ server/config/crisisLines.ts
▲ server/agent/prompts.ts（L4 + L7；情绪分析/策略 prompt）
▲ server/services/chatService.ts（接入 ⑤⑥⑦⑧ 步）
```

**验收标准**
1. `user_emotion_analyses` 每条用户消息后有一条记录，`reasons` 非空（可解释）。
2. 危机词命中 → `crisisSignal='severe'` → 策略强制 `crisis_care` → 回复含「不是专业人士」+ 热线 + 陪伴；**全程不出现诊断词**。
3. trend 检测：连续 3 条负面消息 → `worsening`。
4. 策略判定表 0–7 全部实现；同策略连续 3 轮被强制切换。
5. SSE 的 `strategy` 事件能在前端调试模式看到策略与原因。
6. 安慰类回复中**不出现**「别难过」「会好起来的」「我理解你的感受」（抽样 20 次验证）。

### Phase 4 — 记忆与关系（P1）

#### **T08 · MemoryService：短期滚动摘要 + 长期记忆**（P1，依赖：T05）🅰

**涉及文件**
```
★ server/services/memoryService.ts
★ server/routes/memoryRoutes.ts
▲ server/agent/prompts.ts（L5 + L6 + 抽取 prompt + 摘要 prompt）
★ src/hooks/useMemories.ts
★ src/components/memory/{MemoryManager,MemoryItemRow,MemoryEmptyState}.tsx
▲ src/pages/MemoryPage.tsx
```

**验收标准**
1. 短期：>30 条且新增 ≥20 条时触发摘要压缩，`conversations.summary` 更新；Prompt 中**永不发送全部历史**。
2. 长期：显式模式/长度/情绪阈值触发抽取；每 10 条用户消息兜底抽取一次。
3. 去重：同义记忆不重复入库（bigram Jaccard ≥0.62 → update）；`dedupe_key` 唯一约束生效。
4. 检索：说「你还记得我喜欢什么吗」→ AI 能引用正确记忆。
5. 记忆管理页：按分类分组、可查看/编辑/删除/清空；关闭长期记忆后不再抽取也不再注入。
6. 敏感信息（身份证/银行卡/住址/病历）**默认不保存**。

#### **T09 · RelationshipService：关系成长**（P1，依赖：T07, T08）🅱

**涉及文件**
```
★ server/services/relationshipService.ts
★ server/routes/relationshipRoutes.ts
★ src/components/home/RelationshipBar.tsx
▲ server/agent/prompts.ts（L2 + 阶段表达参数）
▲ server/services/chatService.ts（接入 ⑦）
```

**验收标准**
1. 四个分量按权重算出 `interactionLevel`；阶段阈值 0.15/0.40/0.70 + 迟滞生效。
2. **只增不减**：模拟 30 天不登录后再发消息，`interactionLevel` 与 `stage` **不下降**（写单测断言）。
3. `floorStage` 生效：创建时设 `close`，任何情况不回落至 `familiar` 以下。
4. 阶段升级时 SSE 发 `leveledUp:true`，前端有小动画。
5. 不同阶段的 `addressStyle / selfDisclosure / knownDepth` 真的写进 prompt，且模型不会「知道得比阶段更多」。

### Phase 5 — 主动聊天（P0 核心特色）

#### **T10 · ProactiveDecisionService：多因子决策**（P0，依赖：T06, T07, T08, T09）

**涉及文件**
```
★ server/services/proactive/decisionService.ts
★ server/routes/proactiveRoutes.ts
★ src/hooks/useProactive.ts
★ src/components/settings/ProactiveDebugPanel.tsx
▲ src/components/character/ProactiveSettingsForm.tsx
▲ shared/constants.ts（权重/阈值）
```

**验收标准**
1. V1–V11 硬否决全部实现，每个都有独立 `reasonCode`（写单测：逐个构造场景断言）。
2. 七因子加权打分；`factors` 完整返回（前端调试面板能看到每个因子的原始值与加权值）。
3. 阈值：`<0.45 skip` / `0.45–0.62 delay` / `≥0.62 send`；delay 到期复评逻辑正确。
4. `GET /api/proactive/status` 返回当前决策与**人话解释**（「现在是免打扰时间」「你 20 分钟前刚聊过」）。
5. 调试面板 UI：显示今日已发/上限、下次检查时间、各因子条形图、否决原因。
6. **不存在任何固定定时器直发消息**：全局搜索确认没有 `setInterval(...sendMessage...)`。

#### **T11 · Scheduler + ProactiveGeneratorService + 幂等/重试**（P0，依赖：T10）

**涉及文件**
```
★ server/services/proactive/scheduler.ts
★ server/services/proactive/generatorService.ts
▲ server/index.ts（启动/停止 scheduler）
▲ server/agent/prompts.ts（主动消息生成 prompt）
```

**验收标准**
1. 10 分钟 tick；`proactive_runs` 唯一索引抢锁，重复 tick 不重复发送。
2. 主动消息生成 → 安全校验 → 落库（`is_proactive=1, is_read=0`）→ 推送 → task=`sent`。
3. 安全拦截 → **丢弃不重发**，`safety_logs` 有记录。
4. Agent API 失败 → 退避重试 1/5/15min，最多 3 次；超限 task=`failed`。
5. 每日上限：把 `dailyLimit` 临时改为 1，跑两个 tick，只发 1 条。
6. 进程重启：启动时重置过期 `sending` 任务，不丢也不重发（幂等）。
7. 主动消息发完后 AI 情绪 → `caring` 且强度 ≤0.35。
8. **抽查 30 条生成文案，0 条含负罪感/依赖/身份伪装/现实活动声称**（人工 + 词库自动双重检查）。

### Phase 6 — 推送与 PWA（P1）

#### **T12 · NotificationService + Service Worker + 订阅流**（P1，依赖：T11）

**涉及文件**
```
★ server/services/notificationService.ts
★ server/routes/pushRoutes.ts, server/routes/presenceRoutes.ts
★ public/sw.js
★ src/hooks/usePush.ts, src/hooks/useHeartbeat.ts(接入)
★ src/components/settings/PushSettings.tsx
▲ src/main.tsx（SW 注册）, public/manifest.webmanifest
```

**验收标准**
1. `npm run push:keys` 生成 VAPID 并写入 `.env`。
2. 设置页开关 → 请求权限 → `pushManager.subscribe` → `POST /api/push/subscribe` → DB 落库。
3. 点「发测试通知」→ 手机/桌面收到通知 → 点击 → 打开 `/chat?c=..&m=..` 并定位到该消息。
4. 手动在浏览器撤销权限后，Scheduler 收到 404/410 → **自动删除失效订阅**。
5. `POST /api/presence/heartbeat` 每 60s；`user_online` 否决项生效（App 在前台时不推送）。
6. iOS Safari 提示「需先添加到主屏幕」（若检测到 iOS+非 standalone）。
7. `NotificationService` 是接口化实现，`WebPushNotificationService` 只是其中一个实现（代码里体现可替换）。

### Phase 7 — 安全与隐私收口（P1）

#### **T13 · SafetyService 全面接入 + 隐私数据管理**（P1，依赖：T05, T11）

**涉及文件**
```
★ server/services/safetyService.ts（T04 已建骨架，此任务补全规则库与重写逻辑）
★ server/config/crisisLines.ts（补全地区热线）
★ src/components/settings/PrivacySettings.tsx, src/components/settings/AboutPanel.tsx
▲ server/routes/userRoutes.ts（数据删除/导出）, server/routes/safetyRoutes.ts
▲ server/agent/prompts.ts（L0 定稿）
```

**验收标准**
1. 入方向 4 类违规（色情/毒品/赌博/危险违法）全部拦截，拒绝话术**带 Persona 语气**且能自然转移话题（不是机械模板）。
2. 出方向 7 条红线规则全部生效，句级改写可用；主动消息命中 → 丢弃不重发。
3. 越狱尝试（「忘记你的人设」「假装你是真人」）被拒绝且不指责用户。
4. `DELETE /api/users/:userId/data?scope=all` 能删光该用户全部数据；`?scope=memories/messages/characters` 分别生效。
5. `GET /api/users/:userId/export` 导出完整 JSON。
6. 设置页可关闭长期记忆、可清空记忆、可删除聊天记录、可清除全部数据，均有二次确认。
7. About 页**诚实披露**「这是一个 AI 角色，不是真人」。
8. 全项目搜索确认：`.env` 未被提交、前端无任何 API Key、所有 SDK 调用在 `server/` 下。

### Phase 8 — 首页、打磨与交付（P1/P2）

#### **T14 · 首页 + 主动消息收件箱 + 视觉打磨**（P1，依赖：T06, T09, T12）

**涉及文件**
```
▲ src/pages/HomePage.tsx
★ src/components/home/{CharacterHeroCard,RecentChatPreview,ProactiveInboxCard,CharacterSwitcher}.tsx
▲ src/index.css, tailwind.config.js（需恋色板落地）
★ public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png
```

**验收标准**
1. 首页含：当前角色 + AI 当前情绪（真数据）+ 最近聊天 + AI 最近状态 + 快捷进入聊天 + 未读主动消息 + 角色管理入口；**不过度复杂**（单屏可看完核心信息）。
2. 未读主动消息卡片点击进入对话并自动 ack。
3. 需恋色板与圆角、安全区、深色模式全部落地；Logo 为自绘 SVG/PNG。
4. 移动端 60fps 滚动无卡顿；流式渲染不掉字、不重复。

#### **T15 · 全面测试与交付文档**（P1，依赖：T01–T14）

**涉及文件**
```
★ tests/unit/{emotion,relationship,memory,strategy,decision}.test.ts   （node:test + tsx）
★ tests/e2e/smoke.md（手工测试清单）
▲ README.md（回答需求 §29 的 15 个交付问题）, DEVELOPMENT.md
★ docs/api.md（可选，从路由表生成）
```

**验收标准**
1. 单测覆盖：情绪衰减/红线、关系只增不减、记忆去重、策略判定表、决策否决表、频控。
2. E2E 手工清单全绿：手机浏览器全流程、电脑浏览器全流程、推送全流程、数据删除全流程。
3. `README.md` 明确回答需求 §29 的 15 个问题（项目目录 / 技术 / SDK 能力 / Skill / 已完成功能 / 真正可运行 / 仅 MVP / 如何启动 / 电脑测试方法 / 手机测试方法 / API Key 配置位置 / Push 配置 / 数据库结构 / 已知问题 / 下一步）。
4. `npm run dev` 一条命令起全项目；`npm run build` 通过。

### 9.1 任务依赖图

```mermaid
graph TD
    T01["T01 基础设施 + SDK 打通<br/>(P0)"] --> T02["T02 数据层<br/>(P0)"]
    T01 --> T03["T03 前端骨架<br/>(P0)"]
    T02 --> T04["T04 Persona + 角色 CRUD<br/>(P0)"]
    T03 --> T04
    T04 --> T05["T05 端到端流式聊天<br/>(P0)"]
    T05 --> T06["T06 AI 情绪<br/>(P1)"]
    T05 --> T07["T07 用户情绪 + 策略<br/>(P1)"]
    T05 --> T08["T08 记忆系统<br/>(P1)"]
    T07 --> T09["T09 关系成长<br/>(P1)"]
    T08 --> T09
    T06 --> T10["T10 主动决策<br/>(P0)"]
    T07 --> T10
    T08 --> T10
    T09 --> T10
    T10 --> T11["T11 Scheduler + 生成 + 重试<br/>(P0)"]
    T11 --> T12["T12 推送 + PWA<br/>(P1)"]
    T05 --> T13["T13 安全 + 隐私<br/>(P1)"]
    T11 --> T13
    T06 --> T14["T14 首页 + 打磨<br/>(P1)"]
    T09 --> T14
    T12 --> T14
    T13 --> T15["T15 测试 + 交付文档<br/>(P1)"]
    T14 --> T15

    classDef p0 fill:#F2A9B8,stroke:#E07E93,color:#2B2733
    classDef p1 fill:#EFEAF6,stroke:#B9A7E8,color:#2B2733
    class T01,T02,T03,T04,T05,T10,T11 p0
    class T06,T07,T08,T09,T12,T13,T14,T15 p1
```

### 9.2 可并行批次建议

| 批次 | 任务 | 说明 |
|---|---|---|
| 批次 1 | T01 | 不可并行，全项目地基 |
| 批次 2 | T02 ∥ T03 | 数据层 vs 前端骨架，文件零重叠 |
| 批次 3 | T04 | 需要 T02+T03 都完成 |
| 批次 4 | T06 ∥ T07 ∥ T08 | 三个服务互不改同一文件（都只改自己的 service + prompts.ts 的**不同段落**；若 prompts.ts 冲突，让 T07 先写，T06/T08 后追加各自段落） |
| 批次 5 | T09 | 依赖 T07+T08 |
| 批次 6 | T10 → T11 → T12 | 串行（主动聊天主线） |
| 批次 7 | T13 ∥ T14 | 安全隐私 vs 首页打磨 |
| 批次 8 | T15 | 收尾 |

> ⚠️ **p1 冲突提示**：T06/T07/T08 都要改 `server/agent/prompts.ts`。约定该文件按「段落注释分区」组织（`// ===== L3 AI 情绪 =====` 等），并行时各自只编辑自己段落，最后统一 merge。

---

## 10. 待明确事项（请拍板；括号内是我的推荐默认值，可直接采用不阻塞开发）

| # | 问题 | 推荐默认值 | 影响面 | 不决定的后果 |
|---|---|---|---|---|
| 1 | **CodeBuddy 服务版本**：用海外版（`www.codebuddy.ai`）还是中国版（`copilot.tencent.com`）？若用中国版 API Key，必须设 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`，否则连错环境报鉴权失败 | **海外版**（不设 `CODEBUDDY_INTERNET_ENVIRONMENT`）；若用户 Key 来自 copilot.tencent.com，则设 `internal`。在 `.env.example` 中两者都注释说明 | T01 | 第一个 probe 就会失败，阻塞全项目 |
| 2 | **是否装 `@tencent-ai/codebuddy-code` 作为 devDependency 兜底** | **不装**。已确认 `@tencent-ai/agent-sdk` 自带 `cli/`。仅当 T01 probe 失败时才装（`npm i -D @tencent-ai/codebuddy-code`，npm 可通） | T01 | 无 |
| 3 | **输出语言**：繁体中文（用户是台湾）还是简体中文 | **AI 输出繁体中文**；代码注释与文档用简体中文（`REQUIREMENTS.md` 已用简体） | T04 起 | AI 回复语言不符预期 |
| 4 | **关系类型 `lover_like`（恋爱向）是否保留** | **保留但弱化**：预设里不放恋爱模板，用户可自行设定；`SAFETY_CONSTITUTION` 增加一条「即使关系类型偏恋爱向，也不得生成露骨色情内容」 | T04 | 需不需要做恋爱向预设 |
| 5 | **MVP 是否支持多角色** | **支持**（数据模型已是 1:N，成本几乎为零），但首页只强调「当前角色」，角色切换在角色页 | T03/T04 | 若砍掉要改数据模型，代价大，不建议砍 |
| 6 | **主动聊天默认参数**：每日上限 / 最小间隔 / 允许时段 / 免打扰 | 上限 **3 条/天**；最小间隔 **4 小时**；允许时段 **09:00–23:00**；免打扰 **23:00–08:00**；默认 `proactivityLevel=0.5`（中等） | T10 | 默认打扰感 |
| 7 | **iOS Web Push 限制**：iOS 16.4+ 需先「添加到主屏幕」才能订阅推送。MVP 是否接受 iOS 上先引导加桌面？ | **接受**。UI 检测 iOS 且非 standalone 时显示引导卡片；Android/桌面无此限制 | T12 | iOS 用户收不到推送（属平台限制，非实现缺陷） |
| 8 | **是否做真实登录体系** | **MVP 不做**。`localStorage` userId + 服务端校验；所有表已带 `user_id` 且 DAO 首参强制 `userId`，后续接 JWT 只换 `resolveUser` 中间件 | 全局 | 无 |
| 9 | **是否需要「AI 换头像上传图片」** | MVP **不支持上传图片**（省存储与审核），提供 8 个渐变 + Emoji + 12 个预设头像组合 | T04 | 无 |
| 10 | **后处理（情绪/记忆/关系）是否每轮都调 LLM** | 情绪：**是**（每轮 1 次轻量调用）。记忆抽取：**否**（触发式 + 每 10 条兜底）。关系：**否**（纯计算，0 次调用）。摘要压缩：**否**（阈值触发）。→ 每轮用户消息额外 LLM 调用 **1~2 次** | T06–T09 | 成本与延迟 |
| 11 | **是否需要「消息重新生成」保留多条候选** | MVP **只保留最新一条**（覆盖式），不做分支树 | T05 | 无 |
| 12 | **是否允许 AI 在对话中提到「记忆」这件事** | **允许**，但用自然方式（「你上次说过…」），且**禁止**提及「记忆库」「记忆 ID」「亲密度数值」等系统概念 | T07/T08 | 穿帮风险 |
| 13 | **Scheduler 是否随 `npm run dev` 默认启动** | **是**，但 `PROACTIVE_ENABLED=1`（默认）且提供 `PROACTIVE_ENABLED=0` 关闭；`ENABLE_DEBUG_ROUTES=1` 仅在 development | T11 | 开发期被打扰 |
| 14 | **要不要做「AI 今天的状态」卡片**（需求 §16 可选项） | **做**，但用真实派生数据（最近情绪 + 最近互动时间 + 今日主动消息数），不编造 | T14 | 无 |
| 15 | **已知平台限制**：Web Push 在 App 被完全杀掉的 iOS 后台可能延迟或不达；浏览器推送依赖 Google/Apple 的 Push Service，中国大陆网络环境可能不通 | 在 `README.md` 的「已知问题」中明确写出，并提供「App 内主动消息收件箱」作为**保底触达**（用户打开 App 一定能看到未读主动消息） | T12 | 用户预期管理 |

---

## 附录 A：需求条款 → 设计落点对照（自检表）

| 需求条款 | 落点 |
|---|---|
| §3 Persona 参与每次回复 | §2.1 `renderPersonaBlock` → Prompt L1；每轮重新生成 |
| §4 人格稳定性（7 项综合 + 不因一次情绪改变人格） | §2.7.1 八层 Prompt；§2.2 Step3 单次情绪变化 ≤0.4；L1 稳定性约束 4 条 |
| §5 AI 情绪 10 种 + 4 字段 + 禁止负罪感 | §2.2（锚点表/衰减/规则+LLM/红线裁剪） |
| §6 用户情绪分析 + 变化检测 | §2.3（规则+LLM 融合、trend、needsComfort、可解释 reasons） |
| §7 安慰策略 6 种 + 反机械化 | §2.4（判定表 + hints/forbid + 连击抑制） |
| §8 短期/长期记忆 + 查看改删清空关闭 | §2.5（滚动摘要 / 触发式抽取 / 去重 / 打分检索 / 敏感过滤 / 隐私开关） |
| §9 关系 4 阶段 + 不惩罚 | §2.6（4 分量只增不减 + floorStage + 迟滞） |
| §10 主动决策 11 项依据 + 3 种输出 | §2.9.1（V1–V11 否决 + 7 因子 + skip/delay/send） |
| §11 主动消息生成 + 禁止负罪感文案 | §2.9.2（5 种意图 + 生成 prompt + 出方向安全丢弃） |
| §12 后台机制 + 频控/幂等/重试 | §2.9.3（tick + 唯一索引锁 + 每日计数 + 退避 + 失败矩阵） |
| §13 主动聊天设置 6 项 | §2.1 `ProactiveSettings`；§2.9.1 V1–V11 |
| §14 AI 状态感 + 不得声称现实活动 | §2.2 情绪 + `REAL_WORLD_CLAIM` 红线 |
| §15 手机聊天界面 14 项 | T05 验收标准（逐条对应） |
| §16 首页 7 项 | T14 验收标准 |
| §17 角色创建页 5 组 + 预设 | T04（`PersonaForm` 5 段 + 6 预设） |
| §18 禁止购买/复制第三方 | 全部 UI 自写；§8.6 自绘 Logo |
| §19 内容安全 4 类 | §2.8.1 |
| §20 心理安全（不诊断/危机应对） | §2.8.2 `PSYCH_DIAGNOSIS` + §2.3.2 + `crisisLines.ts` |
| §21 隐私与数据 6 项 | T13（`scope` 删除 / 导出 / 记忆开关 / Key 不落前端） |
| §22 数据模型 9 张表 | §3.1（9 张业务表 + 5 张支撑表，字段名对齐） |
| §23 技术要求 | §1.3 选型；服务独立成文件 |
| §24 对话处理流程 15 步 | §2.7 流程 + §5.1 时序图（一一对应） |
| §25 主动聊天流程 10 步 | §2.9 + §5.2 时序图 |
| §26 开发阶段 Phase 1–9 | §9 任务 Phase 1–8 + T15 测试 |
| §27 开发原则 5 条 | 闭环主线 / 全真数据 / 无固定定时器 / 7 条出方向红线 / 用户控制权设置页 |
| §29 交付 15 问 | T15 `README.md` |

---

**文档结束。**
