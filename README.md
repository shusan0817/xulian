# 需恋 Xulian

> 一個記得你、也懂你的 AI 陪伴角色。
> 不是聊天機器人 —— 它有穩定人格、當下情緒、長期記憶、關係階段，而且會**主動找你**。

本文件依需求 §29 的要求，逐題回答交付狀態。

---

## TL;DR

| 項目 | 狀態 |
|---|---|
| 專案目錄 | `D:\需恋\xulian` |
| 程式規模 | 92 個 TS/TSX 檔 · 15,125 行 |
| 資料庫 | SQLite，15 張表 / 161 欄 |
| API | 36 個端點 |
| 型別檢查 | `npx tsc --noEmit` → **0 錯誤** |
| 前端建置 | `npx vite build` → **成功**（472.84 kB / gzip 138.79 kB） |
| 資料庫冒煙 | `npm run smoke` → **76 通過 / 0 失敗** |
| SDK 連線 | `npm run probe` → CLI v2.143.1 可用（尚未填 API Key） |

---

## 1. 專案目錄在哪裡

```
D:\需恋\xulian\                    ← 專案根目錄
├── server/                        後端（Express + TypeScript）
│   ├── agent\                     CodeBuddy SDK 封裝 + 8 層 Prompt 引擎
│   │   ├── prompts.ts             ★ 全專案最重要的檔案（8 層 Prompt）
│   │   ├── client.ts              query() 流式呼叫封裝
│   │   └── postProcess.ts         情緒/記憶/摘要後處理
│   ├── services\                  9 個業務服務
│   ├── routes\                    7 個路由模組（36 個端點）
│   ├── db\                        schema.sql + 8 個 Repository + 遷移
│   └── data\xulian.db             資料庫檔案（執行時產生）
├── src/                           前端（React 18 + Vite）
│   ├── pages\                     6 個頁面
│   ├── components\                15 個元件
│   └── hooks\                     5 個資料流 hooks
├── shared/                        前後端共用型別與常數
├── docs\
│   ├── REQUIREMENTS.md            需求基線（原始 29 節）
│   ├── system_design.md           系統設計（2,941 行，含 7 張 Mermaid 圖）
│   ├── class-diagram.mermaid
│   └── sequence-diagram.mermaid
├── scripts\
│   ├── probe-sdk.ts               SDK 連線探測
│   ├── smoke-db.ts                資料庫冒煙測試
│   └── gen-vapid-keys.ts          VAPID 金鑰生成
└── DEVELOPMENT.md                 15 個任務的逐項開發紀錄
```

---

## 2. 使用了哪些技術

### 後端
| 技術 | 版本 | 用途 |
|---|---|---|
| Node.js | v22.22.2 | 執行環境 |
| TypeScript | ^5.3.2 | 全端型別安全 |
| Express | ^4.18.2 | HTTP 服務 |
| better-sqlite3 | ^12.6.2 | 同步 SQLite，零外部依賴 |
| @tencent-ai/agent-sdk | ^0.3.43 | CodeBuddy Agent SDK |
| web-push | ^3.6.7 | VAPID Web Push |
| tsx | ^4.6.2 | TS 直跑，免編譯 |

### 前端
| 技術 | 版本 | 用途 |
|---|---|---|
| React | ^18.2.0 | UI |
| Vite | ^5.0.10 | 建置 |
| Tailwind CSS | ^3.4.17 | 樣式 |
| react-router-dom | ^7.13.0 | 路由 |
| lucide-react | ^0.563.0 | 圖示 |

### 通訊與儲存
- **SSE over POST**：`fetch + response.body.getReader()`。不用 EventSource，因為它是 GET-only，無法帶自訂 header（`X-User-Id`）。
- **Service Worker**：手寫 `public/sw.js`（不引入 vite-plugin-pwa）。只快取 App Shell，**絕不快取 `/api`**。
- **SQLite WAL**：單檔資料庫，無需外部 DB 服務。

---

## 3. 目前使用了哪些 CodeBuddy SDK 能力

### 核心選擇：`query()` 而非 `unstable_v2_createSession()`

這是本專案最關鍵的技術判斷。

官方模板用的是 `unstable_v2_createSession()`，但它的 `SessionOptions` **沒有 `systemPrompt` 欄位** —— 而「需戀」的人格、情緒、關係階段、策略是**每一輪都在變**的，必須每輪重建 system prompt。

所以用 **`query()`** 自行管理上下文：

```ts
// server/agent/client.ts
const response = query({
  prompt: buildUserPrompt(ctx),
  options: {
    systemPrompt: buildSystemPrompt(ctx),  // 每輪重新組裝 8 層
    model: env.model,
    abortController,
    // ...
  },
});
for await (const msg of response) {
  // 累積全文後做 server-side diff 產出增量
  const delta = full.startsWith(last) ? full.slice(last.length) : full;
}
```

**伺服端 diff** 是有必要的：SDK 在不同模式下可能回傳累積全文或增量片段，統一在伺服端做 diff 才能保證 SSE 永遠吐增量，前端邏輯單純。

### 已使用的 SDK 能力清單

| 能力 | 使用位置 | 說明 |
|---|---|---|
| `query()` 單輪對話 | `client.ts` | 主對話 |
| `systemPrompt` 動態注入 | `prompts.ts` | 8 層 Prompt 每輪重建 |
| 串流輸出 | `client.ts` → `chatService` | SSE 增量推送 |
| `abortController` | `client.ts` | 客戶端斷線時中止生成 |
| 結構化輸出（JSON） | 後處理 4 個 prompt | 情緒更新、用戶情緒、記憶抽取、對話摘要 |
| 輕量模型分流 | `XULIAN_LIGHT_MODEL` | 後處理用輕量模型省成本 |
| SDK 內建 CLI | `node_modules/@tencent-ai/agent-sdk/cli/bin/codebuddy` | **v2.143.1，無需全域安裝** |

### SDK CLI 驗證結果

```
$ npm run probe
cli_ok    = true    (v2.143.1)
auth_ok   = false   ← 預期內，尚未填 API Key
```

CLI 確實回傳了 `"Authentication required. Please use /login command to sign in to your account."` —— 證明**呼叫鏈路真的通到了 CodeBuddy 服務**，不是假的。

---

## 4. 使用了哪些 Skill

| Skill | 用途 |
|---|---|
| **`codebuddy-chat-web`** | 專案骨架。`bash copy-template.sh xulian` 產生 Vite + React + TS + Express 基礎結構、`.env.example`、SDK 封裝範例 |

骨架僅供起步，實際上：
- **替換了 SDK 呼叫方式**（見第 3 題）
- 未使用 TDesign 元件庫（模板預設）—— 行動端對話 UI 全部手寫，因為 TDesign 是桌面導向，達不到「真正的手機 App 體驗」

---

## 5. 已完成哪些功能

### 15 項核心功能對照

| # | 需求 | 實作位置 | 狀態 |
|---|---|---|---|
| 1 | 被動聊天 | `chatService.streamChat()` | ✅ |
| 2 | **主動聊天** | `proactive/` 決策+生成+調度 | ✅ |
| 3 | 人格系統 | `prompts.ts` L1 層 | ✅ |
| 4 | AI 情緒系統 | `emotionService` (10 種情緒) | ✅ |
| 5 | 用戶情緒分析 | `userEmotionService` | ✅ |
| 6 | 安慰策略選擇 | `strategyService` (6 策略) | ✅ |
| 7 | 短期記憶 | `memoryService.buildShortTerm()` | ✅ |
| 8 | 長期記憶 | `memoryService.extractMemories()` | ✅ |
| 9 | 關係成長 | `relationshipService` | ✅ |
| 10 | 主動決策系統 | `decisionService` (11 否決 + 7 因子) | ✅ |
| 11 | 推播通知 | `notificationService` + `sw.js` | ✅ |
| 12 | 內容安全 | `safetyService` | ✅ |
| 13 | 隱私與資料管理 | `userRoutes` 刪除/匯出 | ✅ |
| 14 | 行動端 UI | 6 頁 + 15 元件 | ✅ |
| 15 | 角色建立/編輯 | `characterRoutes` + 2 頁 | ✅ |

### 8 層 Prompt 架構（人格真正參與的關鍵）

這是讓「人格不是放在建立頁面的文字」的機制：

| 層 | 內容 | 作用 |
|---|---|---|
| **L0** | 安全憲法 | 8 條硬約束，永遠在最前 |
| **L1** | 人格層 | 性格、說話風格、興趣、稱呼 + **4 條穩定性約束** |
| **L2** | 關係層 | 當前階段 + 親密度上限（初識不會說親密話） |
| **L3** | AI 情緒層 | 當前情緒+強度，**明確指令「只改變語氣，不改變性格」** |
| **L4** | 用戶情緒層 | 偵測到的情緒、趨勢、意圖 |
| **L5** | 記憶層 | 檢索出的長期記憶 |
| **L6** | 上下文層 | 近期對話 + 摘要 |
| **L7** | 策略層 | 當前應對策略 + **該策略的禁用語句** |
| **L8** | 輸出契約 | 回覆長度、格式、禁止事項 |

**人格穩定性**是這樣保證的（L1 層原文）：

> 你的情緒只會**改變語氣**，不會改變你的性格。
> 高興時你還是你，難過時你也還是你 —— 變的是表達方式，不是你是誰。

**策略層帶禁用語句**是「不機械化安慰」的實作。`STRATEGY_FORBIDDEN` 對每種策略列了禁用句，例如 `comfort` 策略禁用「別難過」「會好起來的」「一切都會過去的」。

---

## 6. 哪些功能是真正可運行的

以下都經過**實際執行驗證**，不是「寫完就宣稱完成」。

### ✅ 已實測通過

| 功能 | 驗證方式 | 結果 |
|---|---|---|
| **資料庫層** | `npm run smoke`（76 項操作） | 76/76 通過，含冪等鎖驗證 |
| **SDK 呼叫鏈路** | `npm run probe` | CLI v2.143.1 可用，確實連到服務 |
| **SSE 串流** | curl 打 `/api/chat/stream` | 完整事件序列 `strategy → delta → done` |
| **策略選擇器** | 輸入「今天工作好累，有點撐不住」 | 回傳 `strategy: comfort`，理由「明顯負面情緒（valence -0.35）」 |
| **主動決策是曲線不是定時器** | `/api/proactive/dry-run` 掃不同靜默時長 | 見下表 |
| **推播配置** | `/api/push/status` | `configured: true`（金鑰已生成） |
| **型別檢查** | `npx tsc --noEmit` | 0 錯誤 |
| **前端建置** | `npx vite build` | 成功 |

### 主動聊天決策實測曲線

這是最能證明「不是固定定時器」的證據：

| 靜默時長 | 綜合分 | 決策 | 說明 |
|---|---|---|---|
| 1h | 0.438 | **skip** | 太早，不適合打擾 |
| 6h | 0.510 | **delay** | 113 分鐘後重新評估 |
| 14h | 0.614 | **delay** | 49 分鐘後重新評估 |
| 25h | 0.669 | **send** | 覺得現在適合主動說點什麼 |

七個因子各自的 raw / weight / weighted 都會完整回傳，可在 `/api/proactive/dry-run` 檢視。

### 硬否決項（V1–V11）實測

```
V1_DISABLED        主動聊天已關閉
V2_DND             現在是免打擾時間（23:00–08:00）      ← 實測命中
V3_OUT_OF_HOURS    不在允許主動聊天的時段（09:00–23:00） ← 實測命中
V4_DAILY_LIMIT     今日主動消息已達上限（3 則）
V5_TOO_SOON        距離上一則主動消息太近（<4h）
V6_JUST_TALKED     你們剛聊過，不需要打擾
V7_USER_ONLINE     使用者正在線上
V8_PENDING_TASK    已有待發送的主動消息
V9_NO_CHANNEL      沒有任何可觸達的通道
V11_NO_INTERACTION 還沒有任何互動紀錄
```

**任何一項命中就無條件 skip，不存在「分數高就可以破例」** —— 用戶的免打擾設定必須被絕對尊重。

### ⚠️ 尚未實測（需要 API Key）

填入 API Key 後才會真正走通的部分：
- 完整的 AI 回覆生成
- 情緒更新的 LLM 融合（0.35 規則 + 0.65 LLM）
- 長期記憶抽取
- 主動消息的實際文案生成

目前後處理在無 Key 時會走規則降級，不會崩潰。

---

## 7. 哪些功能目前只是 MVP

誠實列出邊界，避免過度承諾：

| 功能 | MVP 程度 | 限制 |
|---|---|---|
| **帳號系統** | 極簡 | 用 `X-User-Id` header 識別，**沒有真正的使用者註冊/登入/密碼**。單機自用可以，多用戶上線前必須補 |
| **主動聊天調度** | 單體 | 用 in-process `setInterval`（預設 10 分鐘 tick）。**重啟即重置**，多實例部署會重複發送。上線需換成外部 cron / 分散式鎖 |
| **關係成長** | 單調遞增 | 刻意不做時間衰減、不做連續登入獎勵、不用關係誘導付費（需求明令禁止）。但也因此長期不活躍不會有任何變化 |
| **記憶檢索** | 關鍵詞 + 類別 | 沒有向量嵌入（embedding），語義相近但字面不同的記憶可能檢索不到 |
| **情緒更新** | 規則 + LLM | 無 Key 時純規則降級，準確度有限 |
| **記憶去重** | 字面相似度 | 用 `dedupeKey` + bigram Jaccard ≥ 0.62，能合併近義表述，但不是語義層級 |
| **內容安全** | 關鍵詞 + LLM | 無 Key 時純關鍵詞，繞過方式很多 |
| **推播** | Web Push | iOS 需「加入主畫面」才支援，且 Safari 限制多。Android Chrome 體驗最好 |
| **多角色** | 支援 | 但一次對話只綁定一個角色，沒有群聊 |
| **語音/圖片** | 無 | 純文字 |

---

## 8. 如何啟動專案

```bash
cd D:/需恋/xulian

# 第一次：安裝依賴
npm install

# 複製環境變數檔
cp .env.example .env

# 產生 Web Push 金鑰（可選，見第 12 題）
npm run push:keys

# 啟動（同時跑前端+後端）
npm run dev
```

- 前端 → http://localhost:5173
- 後端 → http://localhost:3000

### 常用指令

```bash
npm run dev         # 前後端一起跑
npm run typecheck   # 型別檢查
npm run build       # 生產建置
npm run probe       # 驗證 SDK/CLI 連線
npm run smoke       # 資料庫冒煙測試（76 項）
npm run push:keys   # 生成 VAPID 金鑰並寫入 .env
```

### 重裝 better-sqlite3（換機器時注意）

`better-sqlite3` 需要原生二進位檔。若安裝時卡住（GitHub 被擋）：

```bash
npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 npm install
```

---

## 9. 如何在電腦瀏覽器測試

```bash
npm run dev
```

1. 開 http://localhost:5173
2. 按 **F12** → 點左上角裝置工具列圖示（或 `Ctrl+Shift+M`）切換成手機模擬
3. 選 **iPhone 14 Pro** 或 **Pixel 7**

### 建議驗證順序

| 步驟 | 預期 |
|---|---|
| 1. 首頁 | 看到預設角色「林晚」，含情緒徽章與關係階段 |
| 2. 進對話頁 | 空狀態引導文案 |
| 3. 輸入「今天工作好累，有點撐不住」 | 策略標籤顯示「安慰」，AI 回覆語氣轉為傾聽 |
| 4. 長按任一氣泡 | 出現選單：複製 / 重新生成 / 刪除 |
| 5. 去「記憶」頁 | 看到從對話抽取出的長期記憶，可編輯/刪除 |
| 6. 去「設定」頁 | 可關閉長期記憶、匯出資料、清空全部 |

### 純 API 驗證（不看 UI 也能確認核心邏輯）

```bash
# 健康檢查
curl http://localhost:3000/api/health

# 主動聊天決策（模擬靜默 25 小時）
curl -H "X-User-Id: test-user-001" \
  "http://localhost:3000/api/proactive/dry-run?simulateIdleHours=25"

# 決策歷史
curl -H "X-User-Id: test-user-001" \
  http://localhost:3000/api/proactive/history

# 推播配置狀態
curl -H "X-User-Id: test-user-001" \
  http://localhost:3000/api/push/status
```

---

## 10. 如何在手機上測試

### 前置：讓手機連得到電腦

```bash
# 查電腦區網 IP
ipconfig | findstr IPv4
# 假設是 192.168.1.23
```

前端已用 `--host` 對外開放。後端的 CORS 需允許來源，編輯 `.env`：

```env
CLIENT_ORIGIN=http://192.168.1.23:5173
```

### Android Chrome（推薦，體驗最完整）

1. 手機與電腦連同一個 Wi-Fi
2. 開 `http://192.168.1.23:5173`
3. 右上角選單 → **「安裝應用程式」/「加入主畫面」**
4. 從主畫面開啟 → 有全螢幕、有推播權限

### iOS Safari（限制較多）

1. 開 `http://192.168.1.23:5173`
2. 分享按鈕 → **「加入主畫面」**
3. **必須從主畫面圖示開啟**（Safari 分頁內不支援推播）
4. iOS 16.4+ 才支援 Web Push

### ⚠️ HTTPS 限制

Web Push 與 Service Worker 在**非 localhost 的 HTTP 下不會啟用**。區網 IP 是 HTTP，所以：

- **對話、記憶、策略、主動訊息收件箱** → 全部正常
- **推播通知** → 區網測不出來

要測推播，用 tunnel：

```bash
npx localtunnel --port 5173
# 或
npx ngrok http 5173
```

用產生的 HTTPS 網址開啟即可。

### 主動訊息的保底設計

即使推播完全不能用，主動訊息也會進 **App 內收件箱**（`/api/proactive/inbox`）。
這是刻意設計的保底觸達 —— 功能不會因為平台限制而失效。

---

## 11. API Key 在哪裡設定

**只在後端 `.env`，永遠不會下發到前端。**

```bash
cd D:/需恋/xulian
cp .env.example .env
```

編輯 `.env`：

```env
# 海外版 → https://www.codebuddy.ai （下面這行留空）
# 中國版 → https://copilot.tencent.com（必須設 internal）
CODEBUDDY_INTERNET_ENVIRONMENT=

CODEBUDDY_API_KEY=你的金鑰
```

### 兩個環境的差別

| 環境 | 取值 | 取值位置 |
|---|---|---|
| 海外版 | 留空 | https://www.codebuddy.ai |
| 中國版 | `internal` | https://copilot.tencent.com |
| iOA 版 | `ioa` | 企業內部 |
| 專享版 | `cloudhosted` | 企業 |
| 私有化 | `selfhosted` | 自建 |

### 驗證

```bash
npm run probe
```

看到 `auth_ok = true` 就代表 Key 生效。

### 安全性

- `.env` 已在 `.gitignore` 第 14–16 行忽略
- 前端程式碼中**不存在任何** API Key 或 SDK 呼叫
- 所有 AI 呼叫都在 `server/agent/` 內

---

## 12. Push Notification 要設定什麼

### 一步完成

```bash
npm run push:keys
```

會自動生成 VAPID 金鑰對並寫入 `.env`：

```env
VAPID_PUBLIC_KEY=BM4AJ9...    # 會下發給瀏覽器
VAPID_PRIVATE_KEY=Sngzf4...   # 只留在伺服器
VAPID_MAILTO=mailto:your@email.com
```

> 本機已生成好一組，`.env` 裡已經有值，可直接使用。

### 手動設定（若想要自己管金鑰）

```bash
npx web-push generate-vapid-keys
```

### 三項必要條件

| # | 條件 | 說明 |
|---|---|---|
| 1 | **HTTPS** | localhost 除外，其他一律要 HTTPS |
| 2 | **Service Worker** | 已寫好 `public/sw.js`，**且只在 `import.meta.env.PROD` 註冊** |
| 3 | **使用者授權** | 前端 `usePush` hook 會觸發授權請求 |

### 為什麼 SW 只在生產註冊

開發時註冊 SW 會快取舊的 HMR 模組，導致改程式碼畫面不更新 —— 這是 Vite + SW 的經典坑。所以：

```ts
// src/main.tsx
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
```

要測推播就必須 `npm run build && npm run preview`，不能用 dev server。

### iOS 特別注意

- iOS 16.4+ 才支援 Web Push
- **必須「加入主畫面」後從圖示開啟**
- Safari 分頁內不會有推播權限

### 未來換 FCM / APNs

`notificationService.ts` 是抽象層，目前實作是 Web Push。
要換原生推播時只需替換這一層，商業邏輯不用動。

---

## 13. 目前的資料庫結構

SQLite，檔案在 `server/data/xulian.db`。
**15 張表 / 161 欄**，schema 定義在 `server/db/schema.sql`。

| 表 | 欄數 | 用途 |
|---|---|---|
| `users` | 11 | 使用者、設定、隱私開關 |
| `ai_characters` | 23 | AI 角色完整定義（人格/風格/主動性等） |
| `conversations` | 10 | 會話 |
| `messages` | 15 | 訊息（含策略標籤、主動標記） |
| `emotion_states` | 10 | AI 當前情緒（emotion / intensity / reason） |
| `user_emotion_analyses` | 17 | 用戶情緒分析結果（含趨勢、意圖、理由） |
| `memories` | 13 | 長期記憶（類別、去重鍵、敏感度） |
| `relationship_states` | 15 | 關係階段與分數 |
| `proactive_message_tasks` | 14 | 主動訊息任務（狀態機） |
| `proactive_runs` | 5 | **排程冪等鎖** |
| `proactive_daily_counters` | 5 | 每日頻控計數 |
| `push_subscriptions` | 8 | Web Push 訂閱 |
| `active_days` | 3 | 活躍天（關係成長用） |
| `safety_logs` | 10 | 安全事件紀錄 |
| `schema_meta` | 2 | schema 版本（遷移用） |

### 關鍵設計

**冪等鎖**（`proactive_runs`）：

```sql
UNIQUE(character_id, window_key)
```

同一個角色同一個時間窗只會跑一次。多實例同時 tick 也不會重複發送 —— 這在 76 項冒煙測試中有專門驗證。

**關係階段只增不減**：

```ts
// relationshipService.ts
state.interactionLevel = Math.max(state.interactionLevel, next);
```

`Math.max` 保證單調遞增。沒有時間衰減、沒有連續登入獎勵 —— 需求明確禁止用關係誘導付費或懲罰未登入。

**情緒衰減**：

```ts
intensity * Math.exp(-Δt / τ)    // τ = 90 − 60 × emotionSensitivity
```

情緒會隨時間自然平復，情緒敏感度高的角色平復得慢。

---

## 14. 目前還有哪些已知問題

### 🔴 需要 API Key 才能完整運作

無 Key 時：
- AI 回覆無法生成
- 情緒更新的 LLM 融合降級為純規則
- 記憶抽取不執行
- 主動訊息文案不生成

後處理有 8 秒 race timeout，不會卡住主流程，但功能不完整。

### 🟡 架構限制

| 問題 | 影響 | 解決方向 |
|---|---|---|
| **無真正的使用者系統** | 任何人帶 `X-User-Id` 就能讀別人資料 | 上線前必須補註冊/登入/JWT |
| **Scheduler 是 in-process** | 重啟重置；多實例會重複發 | 換外部 cron 或分散式鎖 |
| **記憶無向量檢索** | 語義相近但字面不同檢索不到 | 加 embedding |
| **內容安全無 Key 時很弱** | 純關鍵詞，容易繞過 | 補獨立的內容審核 API |
| **iOS 推播限制多** | 需加主畫面 + iOS 16.4+ | 長期要做原生 App |
| **無 rate limiting** | API 可被濫打 | 加 express-rate-limit |
| **無請求體積限制** | 超長輸入可能撐爆 | 加 body size limit |
| **JS 單塊 472 kB**（gzip 139 kB） | 手機首次載入偏慢 | 目前全部塞在同一個 chunk（`React 18 + React Router 7` 佔大宗）。可做路由級 code-splitting 砍到 150 kB 以下 |

### 關於 bundle 體積

已確認**沒有**服務端依賴洩漏到前端包（`better-sqlite3` / `web-push` / `express` 皆為 0 命中），
React 也沒有重複打包。472 kB 的構成是：

```
React 18 + ReactDOM      ~140 kB
react-router-dom v7      ~90 kB
lucide-react（已 tree-shake）+ 應用碼   ~240 kB
```

未做 code-splitting，屬可優化項而非 bug。

### 🟢 本輪修復的問題

開發過程中修掉並記錄在 `DEVELOPMENT.md`：

1. **SSE 不吐資料**（嚴重）—— 用了 `req.on('close')`，但 Node 16+ 中 `req` 的 close 在 body 讀完後才觸發，不是客戶端斷線。改成 `res.on('close')` 後正常。
2. **`SqliteError: no such column: character_id`** —— `ai_characters` 主鍵是 `id` 不是 `character_id`。修 SQL 後寫了 `smoke-db.ts` 系統性防堵這類錯誤。
3. **`simulateIdleHours` 方向錯**（本輪修復）—— 原本把時鐘**往前**撥，導致「上次互動」落在未來，`minutesSinceLastChat` 變負數，被 V9/V11 誤判為「從未互動」。改成往**後**撥後，決策曲線才跑得出來（見第 6 題的實測表）。
4. **43 個 TypeScript 錯誤** —— 相對路徑層級錯誤（`proactive/` 是 3 層不是 2 層）等，已全數修正至 0。
5. **better-sqlite3 原生檔抓不到** —— GitHub 被擋，改用 npmmirror 鏡像。

### 環境限制（非程式問題）

- **github.com 被擋** —— 依賴安裝需走 npmmirror
- 本環境無 API Key，AI 相關功能僅驗證到「呼叫鏈路通」

---

## 15. 下一階段最值得開發什麼

按「價值 ÷ 成本」排序：

### 🥇 第一優先：補上真正的使用者系統

**理由**：這是唯一擋在「能給別人用」前面的東西。現在任何人換個 `X-User-Id` 就能讀到別人的記憶和對話 —— 資料隔離完全沒做。

範圍：註冊/登入、密碼雜湊（argon2）、JWT、把 `X-User-Id` 換成 token 解析。

### 🥈 第二優先：記憶的向量檢索

**理由**：長期記憶是「記得你」的核心承諾。現在字面檢索會漏掉大量語義相關的記憶，直接影響「被記住」的體感。

範圍：embedding + sqlite-vec 或獨立向量庫，召回改成 hybrid（關鍵詞 + 語義）。

### 🥉 第三優先：Scheduler 外部化

**理由**：現在重啟就重置，多實例會重複發訊息。主動聊天是產品靈魂，不能建立在一個 `setInterval` 上。

範圍：獨立 worker 行程 + 分散式鎖（Redis 或 DB advisory lock）。

### 其餘

| 項目 | 理由 |
|---|---|
| 內容安全獨立審核 | 無 Key 時太弱，陪伴型產品的安全失誤代價很高 |
| 多模態（語音/圖片） | 陪伴場景語音體感差距巨大 |
| 情緒可視化時間軸 | 讓「關係成長」和「情緒變化」被看見，強化長期留存 |
| 原生 App（iOS/Android） | 徹底解決 iOS 推播限制 |

---

## 附錄：需求底線的遵守確認

需求 §27 明令禁止的事項，逐條確認：

| 禁止事項 | 狀態 | 實作方式 |
|---|---|---|
| 不要把主動聊天做成固定定時器 | ✅ | 11 項硬否決 + 7 因子加權，三段式決策 |
| 不要用情緒綁架用戶 | ✅ | L0 憲法禁止，`STRATEGY_FORBIDDEN` 逐策略禁用語句 |
| 不要出現「你為什麼不理我」 | ✅ | 生成後安全檢查，違規直接丟棄不重寫 |
| 不要用關係階段誘導付費 | ✅ | 關係只增不減，無任何付費鉤子 |
| 不要懲罰未登入 | ✅ | 無時間衰減、無連續登入獎勵 |
| 不要假 UI | ✅ | 所有功能都有真實後端支撐 |
| 用戶永遠有控制權 | ✅ | 可關閉主動、可關記憶、可刪除全部資料 |

---

*最後更新：2026-09-05*
