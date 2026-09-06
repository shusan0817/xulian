# 需恋 · 生产部署指引

本文件说明如何把「需恋」从「本机开发可运行」变成「可被其他设备通过正式地址访问」。

> 结论先行：代码已经做了**同源部署友好**的设计——前端 API 与 SSE 全部走相对路径
> （`/api/...`），后端默认监听 `0.0.0.0`，数据库/账号/人格/聊天记录/记忆全部存在
> 服务器端 SQLite（不依赖浏览器 localStorage）。所以**只要把后端放到一个可被访问的
> 服务器并配好域名 + HTTPS，其他设备就能直接打开使用**，无需改业务代码。

---

## 方案 A：免費公網部署（Hugging Face Spaces · 無需域名/伺服器）

> 适合「不想买服务器、不想买域名」的情况。Hugging Face Spaces 免费额度提供一个
> 公开的 `*.hf.space` HTTPS 地址，**无需信用卡**。
> Ollama 只能跑在本地，所以本方案改用**免费云端 LLM**（Groq / Google Gemini 等
> OpenAI 兼容接口）——后端通过本项目新增的 `OpenAICompatibleProvider` 调用，
> 业务代码无需任何改动。

### (a) 前置条件
- 一个免费的 Hugging Face 账号（https://huggingface.co，注册无需信用卡）。
- 一个免费的 Groq 或 Google Gemini API Key（两者均免费、无需信用卡）：
  - Groq：https://console.groq.com/keys
  - Gemini：https://aistudio.google.com/app/apikey

### (b) 创建 Space（Docker SDK）
1. 进入 https://huggingface.co/spaces 点「Create new Space」。
2. SDK 选择 **Docker**，再在 Docker 模板里选 **Blank**（空白）。
3. Space 名字任意（如 `xulian`），可见性选 **Public**。
4. 创建后你会得到一个地址：`https://<your>.hf.space`。
   （本项目根目录已放 `Dockerfile`，HF 会自动识别并按它构建。）

### (c) 设置 Secrets / Variables
进入 Space 的 **Settings → Secrets / Variables**（Variables 直接明文，Secrets 加密；
`SESSION_SECRET` 与 `OPENAI_API_KEY` 建议用 Secret），逐项设置：

| 名称 | 值 | 说明 |
|------|----|------|
| `NODE_ENV` | `production` | |
| `HOST` | `0.0.0.0` | 监听所有网络接口 |
| `PORT` | `7860` | HF 注入的端口（本服务读 `process.env.PORT`，不填 HF 也会注入） |
| `AI_PROVIDER` | `openai` | 走云端 LLM 路径 |
| `OPENAI_BASE_URL` | Groq：`https://api.groq.com/openai/v1`<br>Gemini：`https://generativelanguage.googleapis.com/v1beta/openai` | |
| `OPENAI_API_KEY` | 你的免费 Key | **建议用 Secret** |
| `OPENAI_MODEL` | Groq：`llama-3.3-70b-versatile`<br>Gemini：`gemini-2.0-flash` | |
| `OPENAI_LIGHT_MODEL` | Groq：`llama-3.1-8b-instant`<br>Gemini：`gemini-2.0-flash-lite` | |
| `SESSION_SECRET` | 一段随机长字串（`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`） | **建议用 Secret** |
| `ALLOW_ANONYMOUS` | `false` | 公网必须关 |
| `ENABLE_DEBUG_ROUTES` | `false` | 公网必须关 |
| `CORS_ORIGIN` | `https://<your>.hf.space` | 同源部署其实可留空，填上更稳 |
| `CLIENT_ORIGIN` | `https://<your>.hf.space` | |

> `Dockerfile` 已预装 `python3 make g++`，可编译 `better-sqlite3` 原生模块，
> 因此 `npm run build` + `npm run server` 在容器内可直接跑。

### (d) 推送代码
把本仓库（含根目录 `Dockerfile`）推送到与 Space 关联的 Git 仓库：
```bash
git remote add space https://huggingface.co/spaces/<your>/xulian
git add -A
git commit -m "feat: xulian on HF Spaces"
git push space main
```
（也可直接用 HF 网页上传 / 同步文件。）

### (e) 拿到地址
推送后 HF 会自动构建并启动，构建完成后即可访问：
```
https://<your>.hf.space
```

### 免费额度与限制（请知悉）
- **CPU 休眠**：免费 Space 闲置约 48 小时后会休眠，下次访问需冷启动（约 30–60 秒）。
- **临时磁盘**：免费盘的磁盘是**临时**的——Space 重启 / 重建后，`server/data/xulian.db`
  会被清空（聊天记录、账号等全部丢失）。
  如需持久化，建议换成 **Turso（libSQL，免费、无需信用卡）** 作为数据库升级方案。
- **Groq 免费额度**：约 30 RPM / 14,400 RPD。
- **Gemini 免费额度**：约 10 RPM / 250 RPD。
> 以上 RPM/RPD 为免费层常见上限，具体以各平台官方文档为准。

---

## 方案 B（自有域名/伺服器）

> 以下为需要你自行准备服务器与正式域名的部署方式（原有指引保留）。

## 一、真正的瓶颈是「基础设施」，不是代码

当前无法跨设备访问，根因是：

1. **整个应用只跑在你的本地电脑上**：Node 后端 + Ollama（AI）+ SQLite（DB）全在本机。
2. **没有公网服务器、没有域名、没有 HTTPS**：别的网络没有路由能连到你的电脑。
3. **Ollama 只在本地**（`localhost:11434`）。这是最深的约束——后端一旦部署到远程
   服务器，就再也连不上你电脑上的 Ollama，必须在**同一台服务器**上也运行 Ollama，
   或改用云端 LLM。

代码层面已经修复/规避的点（见下方「已完成的部署就绪改造」）：
- CORS 改用**白名单**（`CORS_ORIGIN`），生产不再硬编码 localhost，也绝不返回 `*`。
- 新增 `HOST` 环境变量控制监听地址（默认 `0.0.0.0`）。
- 前端新增统一 `VITE_API_BASE_URL`：同源部署留空即可；分域名时构建期指定。

---

## 二、两种部署形态

### 形态 A：前后端同源（最简单，推荐起步）

后端进程同时托管前端（`dist/`）和 `/api`。用户访问 `https://你的域名`，
API 走同源相对路径，无需 CORS。

- 部署目标：一台装了 Node 22 的服务器（VPS / PaaS 均可）。
- 该服务器上必须同时跑 Ollama（`ollama serve`，拉好 `qwen2.5:3b`）。
- 用 Nginx/Caddy 或平台做 HTTPS 终止，反代到 `PORT`。

### 形态 B：前后端分域名

前端放 GitHub Pages / CDN（`https://xulian.com`），API 放另一处
（`https://api.xulian.com`）。此时：
- 构建前端时设 `VITE_API_BASE_URL=https://api.xulian.com`。
- 后端 `CORS_ORIGIN=https://xulian.com`。
- API 服务器同样要能连到 Ollama（同机或内网可达）。

---

## 三、部署步骤（形态 A 为例）

1. 在服务器准备环境：Node 22、Git、Ollama。
2. 拉代码：`git clone <你的仓库> && cd xulian && npm install`。
3. 复制并填写生产环境变量：`cp .env.example .env`，至少改：
   - `NODE_ENV=production`
   - `HOST=0.0.0.0`
   - `CLIENT_ORIGIN=https://你的域名`
   - `SESSION_SECRET=<随机长字串>`
   - `ALLOW_ANONYMOUS=0`
   - `ENABLE_DEBUG_ROUTES=0`
   - `OLLAMA_BASE_URL=http://localhost:11434`（与后端同机）
4. 构建前端 + 启动：`npm run build && npm run server`。
5. 配 HTTPS 反代（下面是 Caddy 例子）：

   ```Caddyfile
   yourdomain.com {
     reverse_proxy localhost:3000
   }
   ```

   Nginx 同理：`proxy_pass http://127.0.0.1:3000;` 并配好 SSL。

6. 验证：浏览器开 `https://你的域名` → 注册 → 登录 → 创建 AI → 聊天（流式）。

---

## 四、我已完成的部署就绪改造（代码层面）

| 文件 | 改动 |
|------|------|
| `server/env.ts` | 新增 `HOST`（默认 `0.0.0.0`）、`corsOrigins`（取自 `CORS_ORIGIN`，开发期自动含 localhost:5173）；生产环境校验缺失项 |
| `server/index.ts` | `app.listen(port, host)`；CORS 改为白名单校验，移除硬编码 localhost/127.0.0.1；启动日志显示监听地址与 CORS 来源 |
| `src/config/api.ts`（新） | 统一 `API_BASE`（取自 `VITE_API_BASE_URL`，去尾斜杠） |
| `src/api/client.ts` | `buildUrl` 自动套用 `API_BASE` |
| `src/api/sse.ts` | `postSse` 自动套用 `API_BASE` |
| `src/vite-env.d.ts` | 声明 `VITE_API_BASE_URL` 类型 |
| `.env.example` | 增加 `HOST` / `CORS_ORIGIN` / 生产部署清单 |
| `DEPLOY.md` | 本文件 |

---

## 四-B、前端 Service Worker 发布规范（子路径部署必读，否则「刷新无效」）

本应用注册了 Service Worker（`public/sw.js`，由 `src/main.tsx` 在 production 注册，
作用域 `/xulian/`），用于离线兜底与 Web Push。**它曾在发布后造成「用户硬刷新也没用、
一直看到旧页面」的脏缓存事故**，根因如下，发布时务必遵守：

### 铁律
1. **改 `public/sw.js`（或任何外壳/资源策略）后，必须把 `CACHE_NAME` 版本号 +1**
   （`xulian-shell-v1` → `v2` → `v3`…）。`activate` 只删除「名字 ≠ 当前版本」的缓存，
   若版本号不变，旧的、引用已失效 JS 的 App 外壳将**永远不被清除**。
2. **路径必须相对 scope，绝不写死根路径**：应用部署在 `/xulian/` 子路径，
   `SHELL_ASSETS` 用 `['./', './index.html', './manifest.webmanifest']`，
   离线兜底用 `caches.match('./index.html')`。写 `/` 或 `/index.html` 会缓存/回退到
   GitHub 根目录页（错页）。
3. **SW 注册必须带 BASE_URL**：用 `navigator.serviceWorker.register(
   import.meta.env.BASE_URL + 'sw.js')`，不要写 `/sw.js`（会注册到根 scope，错误）。
4. **`activate` 里 `caches.delete` 所有 ≠ 当前 `CACHE_NAME` 的缓存**，并在末尾
   `self.clients.claim()`，确保新 SW 立即接管、旧缓存被清。
5. 请求拦截保持**网络优先**（`fetch(request).catch(() => 缓存兜底)`），保证拿到最新资源；
   但 `/api/` 与 SSE 一律不缓存。

### 发布后验证（本机沙箱注意）
- 验证一律走线上 CDN：`https://shusan0817.github.io/xulian/sw.js`，
  确认 `CACHE_NAME` 已是新版本、`SHELL_ASSETS` 为 `./` 相对路径。
- `raw.githubusercontent.com` 在本机常不稳（curl 报 write error），不要依赖它判断。
- 若用户仍卡旧页：DevTools → Application → Service Workers → **Unregister**，
  或 Storage → **Clear site data** 一次即可，之后正常。

---

## 五、还需要你提供/决定的事项（我不会替你编造）

- **服务器**：你是否有 VPS / 可部署的 PaaS（Railway / Render / Fly.io）？还是先用本机
  LAN 内网 IP 做测试？
- **域名 + HTTPS**：是否有正式域名？是否已由平台/Caddy 自动签发证书？
- **Ollama 位置**：后端若部署到远程，Ollama 是否也装到那台服务器？（否则 AI 无法工作）
- 若你**暂时只想在自家局域网内多设备测试**，把 `HOST=0.0.0.0`、打开系统防火墙
  3000 端口、用电脑局域网 IP 访问即可——但这只是测试，不是公网方案。
