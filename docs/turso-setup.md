# Turso 配置指南（给站长的操作手册）

> 这份是**照着做的操作手册**，一步一步抄即可，不需要懂编程。
> 想了解「为什么要这么做、底层怎么实现的」，请看 [database-persistence.md](./database-persistence.md)。

---

## 0. 先搞清楚：我现在需要配吗？

**打开这个网址**：

```
https://xulian.onrender.com/api/health
```

你会看到一坨 JSON，找里面的 `dbMode` 字段：

| 你看到的 | 含义 | 你要做什么 |
| --- | --- | --- |
| `"dbMode": "turso"` | ✅ 持久化已生效，数据不会丢 | **不用做任何事**，文章到这里结束 |
| `"dbMode": "local"` | ⚠️ 数据存在临时盘上，**网站一重启，账号和聊天记录全没** | **继续往下做** |

**一句话背景**：网站跑在 Render 免费版上，它的硬盘是「临时」的。
不接一个外部数据库，用户注册的账号、聊过的内容、AI 记住的事，都会在某次重启后清零。
Turso 是一个云端数据库，**有免费额度，够个人使用**，配好就一劳永逸。

预计耗时：**10 分钟**。

---

## 1. 注册 Turso（免费）

1. 打开 <https://turso.tech>
2. 点右上角 **Sign up**，用 **GitHub 账号**或邮箱注册（推荐 GitHub，最快）
3. 注册完会进到 Dashboard

---

## 2. 安装 Turso 命令行工具

你需要用它来建数据库、拿密钥。**Windows / Mac 各选一段**。

### Windows（推荐）

右键开始菜单 → **终端(Terminal)** 或 **PowerShell**，粘贴回车：

```powershell
irm get.tur.so/ps | iex
```

装完**关掉窗口重新打开一个**，输入 `turso --version`，能看到版本号就成功了。

### macOS / Linux

```bash
curl -sSfL https://get.tur.so/install.sh | bash
```

---

## 3. 登录并建数据库

在同一个终端里依次执行（每行回车后等它跑完再下一行）：

```bash
turso auth login
```

浏览器会弹出登录页 → 点 **Authorize** → 回到终端看到 `Logged in` 就成功了。

然后建数据库（名字就叫 `xulian`）：

```bash
turso db create xulian
```

看到 `Created database xulian` 即可。

---

## 4. 拿到两个关键值（URL 和 Token）

### 4.1 拿 URL

```bash
turso db show xulian --url
```

会输出一行，**以 `libsql://` 开头**，类似：

```
libsql://xulian-shusan0817.turso.io
```

👉 **把这整行复制下来，存到记事本**，待会儿要填。

### 4.2 拿 Token

```bash
turso db tokens create xulian
```

会输出一长串（`eyJhbGciOi...` 开头，可能有几百个字符）。

> ⚠️ **最容易出错的一步**：这串字符太长，终端里会**自动折行显示**。
> 复制时如果只选中了一行，就会拿到**半截** token，后面必失败。
> **建议**：从 `eyJ` 开始一直拖到结尾，确保整串都在选区里；或者点终端右键「全选/复制」后粘贴到记事本里再核对首尾。

👉 同样存到记事本。

现在记事本里应该有这两样东西：

```
TURSO_DATABASE_URL = libsql://xulian-xxxx.turso.io
TURSO_AUTH_TOKEN   = eyJhbGciOi............
```

---

## 5. 填到 Render 后台

1. 打开 <https://dashboard.render.com>，点进你的 **xulian** 这个 Web Service
2. 左侧菜单点 **Environment**
3. 点 **Add Environment Variable**，逐个添加（**一共两个**）：

   | Key | Value |
   | --- | --- |
   | `TURSO_DATABASE_URL` | 第 4.1 步拿到的 `libsql://...` |
   | `TURSO_AUTH_TOKEN` | 第 4.2 步拿到的 `eyJ...` |

4. 点 **Save Changes**

Render 会**自动重新部署**（约 1–3 分钟）。等页面上方状态变回 **Live** 再继续。

> ⚠️ **两个都要填，缺一个等于白做**（详见第 8 节的坑 ①）。

---

## 6. 验证是否生效

再次打开：

```
https://xulian.onrender.com/api/health
```

**看到 `"dbMode": "turso"` 就是成功了。** 🎉

如果还是 `"local"`，直接翻到第 8 节「常见坑」。

---

## 7. 关于旧数据 —— 正常情况下，这一步什么都不用做

切到 Turso 后你拿到的是一个**全新的空数据库**。这是**预期行为，不是问题**，通常不需要搬家：

1. **表会自动建好**：驱动在启动时执行 `db.exec(schemaSql)` + `runMigrations(db)`，
   空库会自动建齐全部 24 张表，不需要你手动迁移。
2. **Render 的旧数据本来就拿不到**：我们无法访问 Render 的文件系统，
   而且修改环境变量本身就会触发一次重新部署 —— 那份数据无论如何都留不住。
3. **本地库里是测试数据，搬过去是污染**：本地 `server/data/xulian.db` 现存
   约 35 个 users / 186 条 messages / 2483 条主动消息任务，
   绝大多数是开发验收阶段注册的测试账号（`sharetest*`、`final*`、`sess*` 之类）。

**结论**：直接让朋友注册新账号即可。之前注册的测试账号会消失，这是正常的。

> ⚠️ 如果你的情况确实需要保留某份数据（例如本地库里有真实用户），脚本仍然可用，
> 但**动手前务必先预览**，确认源库内容真的是你要的：
>
> ```bash
> # 预览：只打印各表行数，不写入任何数据
> set TURSO_DATABASE_URL=libsql://你的地址
> set TURSO_AUTH_TOKEN=你的token
> npm run db:migrate-turso -- --dry-run
> ```
>
> 确认无误后再正式执行 `npm run db:migrate-turso`，跑完会逐表打印结果。
> 脚本以**只读**方式打开源库，**绝不删除本地文件**，且可重复执行。

---

## 8. 常见坑（按踩坑概率排序）

### ① 只填了一个变量 —— **最阴的坑**

**现象**：`/api/health` 显示 `"dbMode": "local"`，但网站看起来**一切正常**，没有任何报错。

**原因**：系统设计成「两个变量都配齐才走云端，缺任何一个就自动回落到本地文件」，
目的是保证配错了也不会让网站挂掉。副作用是**数据照样会丢，而且你不容易发现**。

**后端日志里会有明确提示**（这也是我在代码里加的告警原文）：

```
[DB] Turso 設定不完整，已回落到本地檔案模式
```

以及启动检查里会报：

```
已設定 TURSO_DATABASE_URL 但缺少 TURSO_AUTH_TOKEN，資料庫已回落到本地檔案模式（重啟會丟資料）。
```

（反过来只填了 Token 也会有对应提示。）

**处理**：回 Render 的 Environment 检查，**两个变量是否都存在且都不为空**。

### ② 值里混进了多余空格或换行

**现象**：填了但仍是 `"local"`，或启动日志出现 `[DB] 初始化失敗`。

**原因**：从终端/记事本复制时，头尾容易带上**一个空格**或**一个换行**。
`libsql://xxx.turso.io ` 末尾多一个空格，就是另一个地址了。

**处理**：在 Render 的输入框里点进去，按 **End** 键跳到末尾，用退格删掉看不见的多余字符；
更稳妥的做法是**删掉重新手动粘贴一次**，粘完检查首尾没有空格。

### ③ Token 复制了一半

**现象**：`[DB] 初始化失敗`，提示认证失败。

**原因**：见 4.2 节的警告 —— 长 token 在终端折行，容易只复制到前半段。

**处理**：重新执行 `turso db tokens create xulian` 生成一个新的，这次完整复制。

### ④ URL 写成了 `https://` 开头

**现象**：连不上。

**处理**：Turso 的地址是 **`libsql://`** 开头，不是 `https://`。
用 `turso db show xulian --url` 输出什么就填什么，不要自己改。

### ⑤ 刚填完变量就急着刷新 health

**现象**：填完立刻访问，还是 `"local"`。

**原因**：Render 要**重新部署**才会加载新环境变量，通常需要 1–3 分钟。

**处理**：等 Dashboard 状态变回 **Live** 再测；也可以手动点 **Manual Deploy → Deploy latest commit** 立刻触发。

### ⑥ 以为「老账号应该还在」

**现象**：`dbMode` 已经是 `turso`，但之前注册的账号登录不了，或者提示用户不存在。

**原因**：不是故障。切到 Turso 是**全新的空库**；Render 旧库的数据无法导出，
本地库里又大多是测试账号 —— 详见第 7 节。

**处理**：重新注册即可。从这一刻起的数据才会被持久保存。
想确认「真的不会丢」，请做第 9 节的终局验证。

---

## 9. 终局验证（比看 JSON 更硬）

JSON 说 `turso` 只是「配置生效了」。要证明「**数据真的不会丢**」，做一次完整的：

1. 打开网站，**注册一个新账号**，随便聊几句
2. 回 Render 面板，点 **Manual Deploy → Deploy latest commit**（或 **Restart**）
3. 等重新部署完成（约 1–3 分钟）
4. **重新打开网站、登录刚才那个账号**

✅ **账号还在、聊天记录还在** → 持久化彻底成功，可以放心分享给朋友了。
❌ **数据没了** → 对照第 8 节排查，重点看坑 ①。

---

## 10. 常见问题

**Q：Turso 免费额度够用吗？**
A：个人网站绰绰有余（免费版有 500 个数据库、每月数亿次读、数百万次写）。
真用超了 Turso 会发邮件通知，届时再考虑升级。

**Q：配好了还能改回本地吗？**
A：能。在 Render 的 Environment 里把那两个变量**删掉**即可，代码会自动回落本地模式，无需改动任何代码。

**Q：我的 Token 泄露了怎么办？**
A：去终端执行 `turso db tokens invalidate xulian` 撤销，再生成一个新填进去。

**Q：想看更详细的技术说明？**
A：见 [database-persistence.md](./database-persistence.md)（适配层设计、差异抹平、Render Disk 备选方案对比）。
