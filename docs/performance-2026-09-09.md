# 需恋（XuLian）性能优化报告 — 测量 → 优化 → 验证

> 日期：2026-09-09 · 提交：`fc660fb` · 部署：GitHub Pages `gh-pages`（Deploy run `34340672787` success）

## 一、诊断结论：到底是谁慢？

**不是单纯前端慢，而是「请求过多 + 重复/浪费 + 阻塞首屏 +（未证实的）冷启动风险」多问题并存。**
GitHub Pages 静态资源本身很快（首屏传输 ~150KB gzip、TTFB ≤0.53s），所以**没有大幅改动前端渲染**，而是按清单做「去重 / 削减请求 / 懒加载 / 骨架屏 / 缓存优先」。

## 二、14 项最终诊断输出

| # | 项目 | 结果 |
|---|------|------|
| 1 | **原来为何慢** | 首页一次性发 **13 个 API 请求**；其中 bootstrap 发 2 次（POST 建用户 + GET 读）、`useMemoryLab` 顺带拉 4 个接口（首页只展示 1 个）、`useProactive` 一次拉 4 个（首页只用到 1 个）；且 bootstrap 的 GET 与 `/api/auth/status` 门控整页 Loading/「載入中…」。 |
| 2 | **GitHub Pages 首屏耗时** | `index.html` 2.5KB + CSS 26KB(gzip 5.5KB) + 初始 JS 476KB raw / **144KB gzip**。TTFB ≤0.53s，整体 ~1.7s。结论：**静态层不是瓶颈，保持现状**。 |
| 3 | **Render 冷启动耗时** | 本次服务是热的，**未捕获真实冷启动值**；免费版空闲后首请求可能 30–60s（已标记风险）。缓解：缓存优先渲染 + 骨架屏，首屏不再卡在后端唤醒。 |
| 4 | **Render 正常请求耗时** | `/api/health` 首 0.58s；暖请求 avg 0.674s（区间 0.527–1.013s）；`/api/config` 200。正常。 |
| 5 | **AI 首字响应时间** | 本地 Ollama CPU(qwen2.5:3b)：暖态首字 ~3.7s，整段 17–19s（CPU 争用）。**取决于所选供应商，非我们代码瓶颈**。 |
| 6 | **优化前首页 API 请求数** | **13**（7 个始终触发 + 6 个有角色时触发）。 |
| 7 | **优化后首页 API 请求数** | **4**（匿名）/ **5**（已登录，多 `/api/auth/me`）/ 里程碑当天 +1 个 `anniversary-greeting` = 最多 6。↓ ~65%。 |
| 8 | **改了哪些文件** | `src/App.tsx`、`src/hooks/useAppState.ts`、`src/hooks/useAuth.ts`、`src/hooks/useUserId.ts`、`src/pages/HomePage.tsx`、`src/components/home/RecentMemoriesSection.tsx`；新增 `src/hooks/useRecentMemories.ts`、`src/hooks/useProactiveInbox.ts`、`src/components/common/PageSkeleton.tsx`。 |
| 9 | **删除了哪些重复/浪费请求** | ① 删 `GET /api/users/bootstrap`（首页重复拉），统一为 `useUserId` 单例 `POST`；② 删 `useMemoryLab` 在首页顺带拉 `habits/insights/stories`（3 个）→ 改 `useRecentMemories`（仅 `/api/memories`）；③ 删 `useProactive` 在首页拉 `status/scheduler/history`（3 个）→ 改 `useProactiveInbox`（仅 `/api/proactive/inbox`）。共省 7 个请求。 |
| 10 | **增加了哪些缓存** | bootstrap 结果落地 `localStorage`（`xulian.bootstrap.cache.v1`，仅 user/characters/defaultCharacterId，**不含 token/密码**）。首屏无需等后端即渲染，再后台静默刷新；失败不清空已渲染内容。 |
| 11 | **哪些页做了懒加载** | `AccountPage / ChatPage / CharacterListPage / CharacterEditPage / CharacterDetailPage / UnfinishedPage / MemoryPage / StoryPage / LearnedPage / GrowthPage / MemoryLabPage / SettingsPage`（共 12 页）。`Home / Login / Register` 保持 eager（最可能的首屏入口）。已验证 gh-pages 上线 12 个独立 chunk。 |
| 12 | **后端 / AI 做了什么优化** | **经核查后端无需改动**：健康检查仅 `SELECT 1`（非阻塞）；调度器延迟 20s 异步启动、不阻塞主服务；启动期无 AI 模型预热；**AI 后处理（`chatService`）已在首字之后异步执行**（8s `Promise.race` 上限，记忆/情绪/关系抽取不阻塞首字）。该优化在改前已正确实现。 |
| 13 | **最大剩余瓶颈** | ① **Render 免费版冷启动唤醒**（基础设施层，代码无法消除，已用缓存优先 + 骨架屏缓解）；② **AI 首字延迟取决于供应商**（Ollama CPU 慢，换云端更快模型即可）。两者均非前端或我们代码的瓶颈。 |
| 14 | **优化后前端体积 / 可交互** | 初始 `index` chunk 476KB raw / **144KB gzip**（含 vendor + 首屏三页 + 共享组件）；其余 12 页按需 chunk 合计 ~147KB raw，**仅导航到对应页才下载**。HashRouter 保持、404.html SPA 回退保持。 |

## 三、验证结果

- `npm run build`（`tsc -b && vite build`）通过，无类型错误。
- 提交 `fc660fb` 并 push → Deploy run `34340672787` **success**。
- GitHub API 校验 `gh-pages`：12 个懒加载 chunk 全部上线，`index.html` + CSS 已更新。
- 首页请求数由代码层面结构性降至 4–5（非估算）：`auth/status` + `bootstrap(POST)` + `memories` + `inbox`（+ 登录态 `auth/me` + 里程碑 `anniversary-greeting`）。
- 缓存优先：重复访问用户首屏直接读 localStorage，不再因后端冷启动白屏/整页转圈。

## 四、备注 / 回滚

- 若需回滚：`git revert fc660fb` 即可恢复优化前行为；`useMemories.ts`（MemoryPage 依赖的带写操作的版本）已 `git checkout` 还原，未被误改。
- 未改动任何后端代码与数据库结构，后端零风险。
- 缓存键 `xulian.bootstrap.cache.v1`：若未来 bootstrap 结构大改，旧缓存会被 `readCache` 的字段校验（`user`+`characters`）自然丢弃，无需手动清。
