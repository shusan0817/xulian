# 需恋 · §10 主动消息冷却真实缺陷修复

**Commit:** `42a350d`（已 push `main`，Render 自动重部署）
**日期：** 2026-09-07

## 背景：审计发现的唯一实质缺陷

对 22 节需求做逐节代码审计后，绝大部分功能（自然对话、真人格、Learned Preferences、Memory Layer、后端主动引擎、决策机制、对话状态机、Streaming、情绪理解、GitHub Pages 兼容、安全隔离、禁假功能）均已在先前会话落地并运行于 Render。

唯一未闭环的真实缺陷在 **§10 主动消息冷却**：

- 原 `V5_TOO_SOON` 只按 `settings.minIntervalHours`（默认 **4 小时**）冷却，且只参考 `getLastSentTask().createdAt`（上一则主动消息的发送时间）。
- **它完全不管用户有没有回复**。§10 明确要求：「AI 主动发送消息后用户没有回复 → 必须进入 Proactive Cooldown，例如 **12~24 小时**」。
- 后果：AI 主动发一条后，只要过 4 小时、分数够高，就可能再发一条——用户没理也照发，形成骚扰。

## 修复内容

### 1. `server/config/defaults.ts`
`PROACTIVE_CONFIG` 新增：
```ts
/** §10 主动消息发出后用户未回复的冷却时长（小时），落在 12~24h 区间内 */
unrepliedCooldownHours: 16,
```

### 2. `server/services/proactive/decisionService.ts`
`V5_TOO_SOON` 由「固定间隔」改为**动态冷却**：

| 用户状态 | 冷却时长 | 依据 |
|---|---|---|
| 已回复上一则主动消息 | `minIntervalHours`（默认 4h） | 设置项 |
| **未回复** | `unrepliedCooldownHours`（16h） | §10 的 12~24h |

**「是否已回复」的判断机制**（无新增字段、零 schema 变更）：
- `relationship.lastInteractionAt` **只在用户发消息（且 AI 回完）时更新**，`touchRelationship` 写入；AI 主动发消息不会动它。
- 拿 `relationship.lastInteractionAt` 与「上一则主动消息发送时间」比较：`>=` 即视为已回复。
- 未回复时 `reasonText` 明确为「上一則主動消息你還沒回，先不打擾（冷卻中）」，直接服务 §18「为什么 AI 没来找我」决策透明化。

## 验证（证明代码真的生效，而非只是存在）

- `npx tsc --noEmit` → EXIT 0
- `npm run smoke`（DB 冒烟，76 项）→ **76/76 通过**
- 新增 `scripts/verify-cooldown.ts`：用临时 DB 跑**真实 `decide()`**，4 个场景全过：
  - ✅ 未回复 + 5h → `V5_TOO_SOON` 触发（16h 冷却生效）
  - ✅ 已回复 + 5h → `V5` 不触发（退回 4h 间隔，已过）
  - ✅ 未回复 + 20h → `V5` 不触发（16h 冷却已过）
  - ✅ 未回复 + 10h → `V5_TOO_SOON` 触发（仍在 16h 内）

## 部署与配置

- 已 push `main`（`39d1e65..42a350d`），Render 自动重部署后端。
- **无需新增任何环境变量**：`unrepliedCooldownHours` 为代码内默认常量，行为即生效。
- 如需调更长的未回复冷却，改 `server/config/defaults.ts` 的 `PROACTIVE_CONFIG.unrepliedCooldownHours` 即可（保持 12~24h 区间内）。

## 本回合未改动（说明）

- **§18 显式端点**（`/check`、`/generate`、`/send`、`/settings`）：现有 `GET /api/proactive/status`（决策 7 因子可视化 + 否决原因码）、`/dry-run`、`POST /api/proactive/tick`（调试）、以及 `PATCH /characters/:id`（主动设置）已覆盖全部功能面；需求明确「接口名可调整」，故未强行改命名以规避引入新 bug。功能齐备，仅命名风格不同。
