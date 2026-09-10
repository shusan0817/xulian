# 数据库持久化：从本地 SQLite 到 Turso / libSQL

> 目标：解决 Render 免费实例「临时盘」导致 `server/data/xulian.db` 被清空、
> 用户账号 / 聊天记录 / 记忆 / 故事全部丢失的问题。

---

## 1. 问题背景

| 环境 | 文件系统 | 后果 |
| --- | --- | --- |
| 本地开发 | 本机磁盘 | 无影响 |
| Render 免费版 | **临时盘（ephemeral）** | 重启 / 重新部署 / 休眠唤醒后 `server/data/xulian.db` 归零 |

原始实现（`server/db/index.ts`）是 `new Database(dbPath)` 直接打开本地文件，
`dbPath` 默认 `<项目根>/server/data/xulian.db`，落在临时盘上。

---

## 2. 采用的方案：Turso（libSQL）云端数据库

### 为什么是 `libsql` 而不是 `@libsql/client`

全项目 `server/db/repositories/*.repo.ts` 都在用 better-sqlite3 的**同步** API：

```ts
db.prepare(sql).get()   // 单条
db.prepare(sql).all()   // 多条
db.prepare(sql).run()   // 写入
db.exec(sql)            // 批量 DDL
db.transaction(fn)      // 事务
db.pragma(...)          // pragma
```

`@libsql/client` 只提供**异步** `execute()`，接入意味着全项目 repositories 重写，风险极高。

而官方 [`libsql`](https://www.npmjs.com/package/libsql) 包是 better-sqlite3 的
**同步 API 兼容替代**（同一个作者 Fork 的 API 形态）：

```ts
new Database('libsql://xxx.turso.io', { authToken })   // 云端
new Database('./local.db')                              // 本地文件
```

因此选型：`libsql@0.5.29`，**同步 API 一行不改，repositories 零改动**。

### 适配层设计

新增 `server/db/driver.ts`，对外统一按 better-sqlite3 的 `Database` 类型暴露：

```
server/db/index.ts
    └── openDatabase()
            ├── TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 都非空 → openTurso()   （libSQL 云端）
            └── 否则                                        → openLocal()   （better-sqlite3 本地文件）
```

**关键：两种模式对外都是 `export const db`，类型仍是 `better-sqlite3.Database`，
所以 `repositories/*.repo.ts`、`migrations.ts`、`authService.ts` 一行都不用改。**

### 抹平的 libSQL 与 better-sqlite3 差异（全部消化在 driver.ts 内）

| 差异 | 处理 |
| --- | --- |
| `statement.get()` 会多返回一个 `_metadata` 字段 | 适配层剥掉，避免污染行对象 / 泄漏到 API 响应 |
| `run().lastInsertRowid` 可能是 `bigint` | 统一转成 `number` |
| 云端不支持部分 pragma（WAL / synchronous 等） | 逐条 `try/catch`，失败只记日志并跳过，**不崩** |
| 云端可能不支持一次 `exec()` 多条语句 | 失败后按 `;` 切分逐条重跑（切分器正确处理引号与注释） |
| 云端事务 | 直接复用 libSQL 官方 `transaction()`（内部 BEGIN / COMMIT / ROLLBACK） |

### 回落保证

**没有配置 Turso 凭证时，行为与改造前 100% 一致**：同路径、同 pragma、同顺序、同 API。
只配了 URL 或只配了 Token 其中一个时，也会回落本地并在启动日志里明确告警。

---

## 3. Render 需要配置的环境变量

在 Render → 你的 Service → **Environment** 里加：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | ✅ | 形如 `libsql://xulian-org.turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | `turso db tokens create xulian` 生成的 JWT |
| `SESSION_SECRET` | ✅（生产） | 原本就需要；不配会导致每次重启全员登出 |
| `NODE_ENV` | ✅ | `production` |
| `ALLOW_ANONYMOUS` | ✅ | `false` |
| `ENABLE_DEBUG_ROUTES` | ✅ | `false` |
| `CORS_ORIGIN` | 看情况 | 前端与 API 不同域名时必须填 |
| `AI_PROVIDER` / `OPENAI_*` | 看情况 | 云端 LLM 配置（免费公网部署用） |
| `XULIAN_DB_PATH` | ❌ | 走 Turso 后不需要；只有 Render Disk 备选方案才用 |

> ⚠️ 两个 Turso 变量必须**同时**设置。只设一个不会启用云端模式，
> 启动日志会出现 `[DB] Turso 設定不完整，已回落到本地檔案模式`。

---

## 4. 开通与迁移步骤

```bash
# 1) 安装 Turso CLI（macOS / Linux）
curl -sSfL https://get.tur.so/install.sh | bash
# Windows（PowerShell）
# irm get.tur.so/ps | iex

# 2) 登录并建库
turso auth signup          # 或 turso auth login
turso db create xulian

# 3) 取 URL 与 Token
turso db show xulian --url         # → TURSO_DATABASE_URL
turso db tokens create xulian      # → TURSO_AUTH_TOKEN

# 4) 先预览要迁移什么（不写入）
TURSO_DATABASE_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=eyJ... \
  npx tsx scripts/migrate-to-turso.ts --dry-run

# 5) 正式迁移（也可 npm run db:migrate-turso）
TURSO_DATABASE_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=eyJ... \
  npm run db:migrate-turso
```

迁移脚本（`scripts/migrate-to-turso.ts`）的保证：

- 源库以 **只读** 方式打开，**绝不删除或改动本地文件**；
- 目标库先用项目自带的 `server/db/schema.sql` + `runMigrations()` 建表，
  **沿用现有表结构，不会凭空新建表、也不会重复建表**；
- 写数据用 `INSERT OR REPLACE`，**可反复执行（幂等）**；
- 迁移结束后逐表比对行数并打印报告，不一致时以非零退出码结束；
- 目标库缺列 / 缺表会跳过并在报告里说明，不会中断整个迁移。

覆盖的表（以 `server/db/schema.sql` 实际存在的表为准，脚本自动枚举）：
`users`、`ai_characters`、`conversations`、`messages`、`memories`、`conversation_states`、
`emotion_states`、`user_emotion_analyses`、`relationship_states`、`active_days`、
`proactive_message_tasks`、`proactive_runs`、`proactive_daily_counters`、`push_subscriptions`、
`safety_logs`、`user_auth`、`user_sessions`、`stories`、`unfinished_topics`、`user_insights`、
`ai_habits`、`message_feedback`、`emotion_trend_snapshots`、`schema_meta`。

---

## 5. 备选方案：Render 持久磁盘（Persistent Disk）

如果不想引入外部数据库，也可以挂载 Render Disk（**付费方案起**）：

1. Render → 你的 Service → **Disks** → Add Disk
   - Name：`xulian-data`
   - Mount Path：`/var/data`
   - Size：1 GB 起
2. Environment 增加：`XULIAN_DB_PATH=/var/data/xulian.db`
3. 重新部署。之后数据落在持久盘上，重启不再丢失。

**注意事项**

- 代码**无需任何改动**：`server/env.ts` 本来就支持 `XULIAN_DB_PATH`，
  本方案直接复用即可（这也是本次改造顺带保留的能力）；
- **免费版 Render 不提供 Disk**，需要升级到付费实例；
- 持久盘只挂在**单个实例**上，横向扩容后多实例无法共享同一份数据；
- 磁盘仍需自行备份，Turso 有免费额度且自带托管，通常更省心。

### 两条路的对比

| | Turso / libSQL | Render Disk |
| --- | --- | --- |
| 免费版可用 | ✅ | ❌（需付费实例） |
| 代码改动 | 已内置（配 2 个环境变量即可） | 无（配 1 个环境变量） |
| 延迟 | 多一次网络往返（同区域通常几十 ms） | 本地磁盘，最快 |
| 多实例扩容 | ✅ | ❌ |
| 推荐度 | ★★★★★ | ★★★☆☆（已有付费实例时可考虑） |

---

## 6. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动日志 `[DB] Turso 設定不完整，已回落到本地檔案模式` | 两个 Turso 变量只配了一个，补齐另一个 |
| 启动日志 `[DB] libSQL 不支援此 pragma，已跳過` | 正常。云端由服务端托管 WAL / synchronous，跳过不影响功能 |
| 启动日志 `[DB] 初始化失敗` | 检查 URL 是否为 `libsql://` 开头、Token 是否过期（`turso db tokens create` 重签） |
| 迁移后少表 | 看报告里 `·`（skipped）行，通常是目标库该表已被新 schema 移除 |
| 想回到本地模式 | 删掉 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 两个变量即可，代码无需改动 |

确认当前生效的模式：启动日志里会有

```
[DB] 資料庫已就緒 {"mode":"turso","target":"libsql://xxx.turso.io","schemaVersion":6}
```

`mode` 为 `local` 说明仍在用本地文件。
