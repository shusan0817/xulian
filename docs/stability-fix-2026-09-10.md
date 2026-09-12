# 公开体验前稳定性修复 — 验收报告

日期：2026-09-10
提交范围：`fc660fb..f4e73f4`（7 个 commit，已 push 到 `main`）
线上验证：GitHub Pages Deploy run `34470815825` = success；Render 后端 `/api/health` = 200

---

## 一、用户要求的 18 项输出

### 1. JSON 乱码原来的原因
三处叠加：
- `server/agent/prompts.ts:456-465` 的 L8 输出契约**强制 AI 输出 JSON**（`{"reply":..., "favorability_change":..., "emotion":...}`）；
- `server/services/chatService.ts` 的流式循环把 AI 的**原始 delta 直接 yield** 给前端，服务端不做任何解析；
- `src/hooks/useChat.ts` 只在 `done` 事件后才解析正文 → **流式过程中用户盯着 JSON 外壳**。

所以是"最后看着对、过程很出戏"，不是偶发 bug，是必现。

### 2. 实际修改了哪个 Streaming 文件
- **新建** `server/services/streamReplyExtractor.ts`（核心）
- **改** `server/services/chatService.ts`（流式循环接入提取器）
- **改** `src/hooks/useChat.ts`、`src/store/favorabilityStore.ts`、`shared/sse.ts`（前端配合）

### 3. Streaming 数据格式是什么
AI 侧实际输出（真实 Ollama qwen2.5:3b 抓取）：
```
{\n  "reply": "聽起來真的很有成就感呢...",\n  "favorability_change": 4,\n  "emotion": "sweet"\n}
```
以**任意分块**的 delta 到达（可能一个字一个 chunk，也可能跨 chunk 切断 `{"rep` / `ly":...`）。

### 4. 服务端如何提取 reply/content/text
`StreamReplyExtractor` 是**字符级状态机**（pending / plain / seek / key / afterKey / preValue / inValue / skipValue / skipStr / done）：
- 识别 `{"reply":` / `"content":` / `"text":` 等目标键；
- **一进入 reply 字符串内部就逐字符吐增量**，不等整个 JSON 完成；
- 非目标字段（如 `favorability_change`、`emotion`）走 skipValue 跳过，不吐给用户；
- 兼容 `data: ` 前缀、```json 围栏、纯文本透传。

### 5. 是否增加了 buffer
是。跨 chunk 状态全部保留在提取器实例里：
- JSON 被切断 → 状态机挂起等待后续字符，不报错；
- `\uXXXX` 转义被 chunk 切断 → 等待补足 4 位再解码，不截断；
- 流结束调用 `finish()` 兜底处理"字符串未闭合"等截断场景。

### 6. 是否保留真正 Streaming
**是，逐字吐出。** 线上实测：首字增量 `"你好"`，整轮 **35 次增量**。
单元测试增量轨迹：`逐 → 逐字 → 逐字增 → 逐字增长 → 逐字增长测 → 逐字增长测试`。

### 7. 当前数据库是什么
SQLite（better-sqlite3），文件位于 `server/data/xulian.db`，**24 张表**。
Render 免费版文件系统为临时盘 → 重启/重部署会丢。

### 8. 是否迁移到 Turso
**代码层面已完成适配，但实际云端尚未启用**（缺 Turso 凭证，我无法替你注册）。
- 已安装 `libsql@0.5.29`（官方同步 API 兼容包）；
- 新增 `server/db/driver.ts` 适配层：**零 async/await**，repositories 一行未改；
- 有 `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` → 走云端；否则**回落本地文件，行为与今天完全一致**。

⚠️ 当前 Render 仍在本地文件模式，**数据仍会丢**。必须配好 Turso 变量才算真正解决。

### 9. 数据库连接如何配置
```
TURSO_DATABASE_URL=libsql://xulian-xxx.turso.io
TURSO_AUTH_TOKEN=<turso db tokens create 生成的 JWT>
```
配好后执行 `npm run db:migrate-turso` 迁移（源库只读打开，绝不删除本地文件；幂等，可反复跑，支持 `--dry-run`）。

### 10. SESSION_SECRET 是否已经使用环境变量
是。`server/env.ts` 读 `process.env.SESSION_SECRET`。
- 本地已写入 `.env`（被 `.gitignore:14` 忽略，**未进仓库**），96 字符强随机值；
- 本地原本就有一个 96 字符密钥，已换新；
- **Render 侧我无法代配，需你自己加**（见第 11 项）。

### 11. Render 需要配置哪些环境变量
**必填**
| 变量 | 值 |
|---|---|
| `SESSION_SECRET` | `5b54698651d16da7ac88f6ac230df04ce32c5d0b842e4cb83cba745eef43f92afbaacf569a14148810fb5c0ea1c1a2c6` |
| `TURSO_DATABASE_URL` | `libsql://xulian-xxx.turso.io` |
| `TURSO_AUTH_TOKEN` | Turso 生成的 JWT |
| `NODE_ENV` | `production` |
| `ALLOW_ANONYMOUS` | `false` |
| `ENABLE_DEBUG_ROUTES` | `false` |

**看情况**：`CORS_ORIGIN`（前后端不同域名时必填）、`AI_PROVIDER` / `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`
**不需要**：`XULIAN_DB_PATH`（启用 Turso 后失效）

### 12. 是否发现 Secret 暴露风险
**未发现。** 三项扫描全通过：
- `.env.example` 只有占位符，无真实值；
- 代码无硬编码密钥（`sk-` / `gsk_` / JWT 模式扫描为空）；
- 前端产物 `dist` 与线上 bundle 均无 `SESSION_SECRET` / `TURSO_AUTH_TOKEN` / API Key。

### 13. 修改了哪些文件
- `server/services/chatService.ts`
- `src/hooks/useChat.ts`
- `src/store/favorabilityStore.ts`
- `shared/sse.ts`（仅新增可选字段 `favorability?`）
- `server/env.ts`（+2 个 Turso 变量 + 配置不完整告警）
- `server/db/index.ts`、`server/index.ts`
- `package.json`（+`libsql`）

### 14. 新增了哪些文件
- `server/services/streamReplyExtractor.ts`（核心提取器）
- `server/db/driver.ts`（Turso/本地双模式适配层）
- `scripts/migrate-to-turso.ts`（迁移脚本，含 `npm run db:migrate-turso`）
- `scripts/test-stream-extractor.ts`（19 项单元测试）
- `scripts/test-live-stream.ts`（真实 Ollama 端到端联调）
- `docs/database-persistence.md`

### 15. 数据库修改了什么
**Schema 未改、表未新建、数据未删。** 只改了连接层（`driver.ts`），差异在适配层内抹平：
| 差异 | 处理 |
|---|---|
| `get()` 多返回 `_metadata` | 适配层剥掉（避免污染行对象/泄漏到 API） |
| `lastInsertRowid` 可能是 bigint | 统一转 number |
| 云端不支持部分 pragma | 逐条 try/catch 跳过 + 记日志，不崩 |
| 云端可能不支持批量 `exec()` | 按 `;` 切分逐条重跑（正确处理引号/注释） |

### 16. 测试了哪些场景
- 流式提取器单元测试 19 项（完整 JSON / `data:` 前缀 / 单字符切分 / 纯文本 / `content` / `text` / 中文+转义 / markdown 围栏 / 尾部截断 / 字符串未闭合 / 随机切块 / 元数据在前 / `\uXXXX` / `\uXXXX` 被切断 / 非目标字段在前）
- 真实 Ollama 端到端（qwen2.5:3b，42 个 delta → 19 次增量）
- `npx tsc --noEmit` 全仓库
- `npm run smoke` 数据库回归（两种驱动模式各跑一遍）
- 线上真实聊天（注册 → bootstrap → SSE 聊天）
- 前端 `vite build`

### 17. 哪些测试通过
| 项目 | 结果 |
|---|---|
| 流式提取器单元测试 | ✅ 19/19 |
| 真实 Ollama 端到端 | ✅ 逐字增量，无 JSON 外壳 |
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npm run smoke`（local 模式） | ✅ 76/76 |
| `npm run smoke`（turso 代码路径） | ✅ 76/76 |
| 迁移脚本真实执行 | ✅ 24 表全部迁移，行数 100% 一致，本地文件未删 |
| `npx vite build` | ✅ 成功（24.67s） |
| **线上真实聊天** | ✅ 首字 `"你好"`，35 次增量，全文无 `{` `}` `"reply"` `data:` |
| GitHub Pages 部署 | ✅ run `34470815825` success |
| Render `/api/health` | ✅ 200，`aiConfigured:true`，`database:true` |

### 18. 是否还有剩余问题
1. **数据持久化尚未真正生效** —— 代码就绪，但缺 Turso 凭证，Render 仍在临时盘模式。**这是当前最大的剩余风险。**
2. `SESSION_SECRET` 需你在 Render 后台手动配置（我看不到 Render 面板）。
3. Render 免费版冷启动（首请求可达 40s）—— 基础设施层限制，已有保活 cron（每 10 分钟）+ 前端冷启动 Toast 缓解。
4. `server/db.ts` 是遗留死文件（无人 import），未清理，不影响功能。

---

## 二、好感度语义约定（易踩坑，改动前务必读）

服务端与前端靠「**字段是否存在**」区分两种情况：
- **A. 模型守格式、解析成功** → done 事件**带** `favorability` 字段。即使 `change: 0` 也原样采纳（尊重模型判断）。
- **B. 解析失败 / 模型没按格式输出** → done 事件**整个字段都不带**，前端回退 `applyAiReply` 的 +1 保底。

⚠️ 千万不要把服务端改成"永远带字段、失败时发 `change:0` 空壳" —— A/B 会混成一团，小模型跑偏时心动值会永久卡住不涨。
