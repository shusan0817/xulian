/**
 * 「需恋」服务端入口
 *
 * 由模板的 663 行单文件重构而来：本文件只做「组装」。
 * 启动顺序：env → logger 校验 → db（建表+迁移）→ express → routes → listen。
 *
 * 已删除的模板能力（陪伴 App 不需要）：
 * - /api/check-login、/api/save-env-config（API Key 只允许在 .env 里配置，不提供前端写入口）
 * - /api/permission-response、canUseTool 交互（无工具）
 * - /api/sessions 多会话工作台（改为单角色主线会话）
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, isAiConfigured, validateEnv, maskSecret } from './env.js';
import { logger } from './logger.js';
import { errorHandler } from './errors.js';
import { apiRoutes } from './routes/index.js';
import { closeDb } from './db/index.js';
import { startScheduler, stopScheduler } from './services/proactive/scheduler.js';
import { APP_NAME, APP_VERSION } from '../shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 前端构建产物目录（npm run build 后由本服务一并托管，方便手机直接访问 3000 端口） */
const CLIENT_DIST_DIR = path.resolve(here, '..', 'dist');

const app = express();

// ------------------------------------------------------------
// 中间件
// ------------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

/**
 * CORS：只允许 env.corsOrigins 白名单里的来源（生产填正式域名，绝不填 *）。
 * 同源部署（后端直接托管前端）时浏览器不发 Origin，本中间件不干预，API 正常。
 * 开发环境已在 env.corsOrigins 里自动包含 localhost:5173。
 */
app.use((req, res, next) => {
  const origin = req.header('Origin');
  if (origin && env.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// 请求日志（只打方法与路径，不打 body，避免聊天内容进日志）
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    logger.debug('[HTTP] 请求完成', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

// ------------------------------------------------------------
// 路由
// ------------------------------------------------------------
app.use('/api', apiRoutes);

// 托管前端静态资源 + SPA 回退：非 /api 的 GET 一律回 index.html。
// 必须始终开启——单服务部署时前端由本进程一并托管，
// 否则刷新或直接访问 /login、/register、/chat 等前端路由会 404（返回 JSON 错误而非页面）。
app.use(express.static(CLIENT_DIST_DIR));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ ok: false, error: { code: 'E_NOT_FOUND', message: '找不到頁面' } });
    }
  });
});

// 404（放在所有路由之后）
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: { code: 'E_NOT_FOUND', message: `找不到接口：${req.method} ${req.originalUrl}` },
  });
});

// 错误处理（必须在最后）
app.use(errorHandler);

// ------------------------------------------------------------
// 启动
// ------------------------------------------------------------
function printBanner(port: number): void {
  const line = '─'.repeat(52);
  logger.info(`\n${line}\n  ${APP_NAME} v${APP_VERSION} · API 服務已啟動\n${line}`, {});
  const bindNote =
    env.host === '0.0.0.0' ? '0.0.0.0（所有网络接口，局域网/公网可访问）' : env.host;
  logger.info(`  监听地址  : ${bindNote}:${port}`, {});
  logger.info(`  CORS 来源 : ${env.corsOrigins.length ? env.corsOrigins.join(', ') : '（仅同源）'}`, {});
  logger.info(`  数据库    : ${env.dbPath}`, {});
  logger.info(
    `  AI 已配置 : ${isAiConfigured()}  (供應商=${env.aiProvider} · 模型=${
      env.aiProvider === 'openai' ? env.openaiModel : env.ollamaModel
    })`,
    {},
  );
  logger.info(`  主动聊天  : ${env.proactiveEnabled ? '开' : '关'}（T11 接入 Scheduler）`, {});
}

for (const issue of validateEnv()) {
  if (issue.level === 'error') logger.error(`[Env] ${issue.key}`, { message: issue.message });
  else logger.warn(`[Env] ${issue.key}`, { message: issue.message });
}

const server = app.listen(env.port, env.host, () => {
  printBanner(env.port);

  // 主动聊天调度器（需求 §12：必须是服务端后台能力，不能依赖用户打开 App）
  // 内部延迟 20 秒启动第一轮，避免和数据库初始化抢资源
  startScheduler();
});

// ------------------------------------------------------------
// 优雅退出
// ------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Server] 收到 ${signal}，正在关闭…`, {});
  stopScheduler();
  server.close(() => {
    closeDb();
    logger.info('[Server] 已关闭', {});
    process.exit(0);
  });
  // 兜底：5 秒内没关干净就强制退出，避免长连接把进程吊住
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
