# 需恋 · 纪念日 / 进站彩蛋 增强说明

> 提交 `9fcd5c5`（基于 `b88cdf5` 纪念日系统 + 随机日常事件）。已部署：前端 GitHub Pages、后端 Render。
> 线上地址：https://shusan0817.github.io/xulian/

## 1. 彩蛋概率可在「设置」里调
- 新增 `src/hooks/useUserPrefs.ts`：localStorage（`xulian.prefs.v1`）存放 `dailyEventChance`，默认 `0.25`。
- `src/hooks/useDailyEvent.ts` 改用该概率，不再写死 25%。
- `src/pages/SettingsPage.tsx` 新增「小彩蛋」分区：
  - 频率步进器（0–100%，步长 5%）；
  - 「關閉彩蛋」开关（一键归零）。
- 行为：每次打开/刷新首页按概率触发日常小事件弹窗；调成 0% 即不再弹出。

## 2. 里程碑问候改为 AI 真实生成
- 后端新增 `POST /api/characters/:id/anniversary-greeting`（`server/routes/characterRoutes.ts`）：
  - 用角色人格（name / personality / speakingStyle / userNickname）让 LLM 生成「以 TA 口吻、针对今天这个纪念日」的专属问候。
  - `isAiConfigured()` 为 false、或生成失败/超时 → 回 `{ greeting: null }`，前端回落到本地预写温暖文案（绝不卡死彩蛋）。
- 前端 `src/pages/HomePage.tsx`：命中里程碑（相识 100 天 / 週年 / 自定义生日等）时请求 AI 问候并展示，预写文案作降级；`AbortController` 超时清理。

## 验证
- `npm run build`（tsc -b + vite）通过，无类型错误。
- 本地实测 AI 生成（林晚 / qwen2.5:3b）：
  - 相识 100 天 →「100 天感謝有你，每一步都是最美的陪伴。」
  - 自定义生日 →「生日快樂，過得比我還開心。」
- 线上校验：gh-pages bundle 含 `小彩蛋` / `日常小事件頻率` / `關閉彩蛋` / `anniversary-greeting` / `dailyEventChance`；Render 路由已部署（返回 401 鉴权门 = 路由与中间件生效）。

## 降级保障
任一环节（AI 未配置、模型缺失、网络超时）都不会破坏体验——用户始终看到预写的「相识 X 天」问候与彩带特效。
