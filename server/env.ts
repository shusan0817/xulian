/**
 * 环境变量集中管理
 *
 * 职责：
 * 1. 进程启动时加载 `.env`（只在这里调用一次 dotenv.config，其它模块禁止再调）；
 * 2. 把 process.env 收敛成一个带类型的 `env` 对象，避免全项目散落 `process.env.X`；
 * 3. 启动时输出**脱敏**的配置摘要，缺 Key 时给明确指引但不让进程崩溃（方便先跑 UI）。
 */

import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 未配置 SESSION_SECRET 时的兜底：每次启动随机生成一个（会话不跨重启） */
function randomSecret(): string {
  return `dev-ephemeral-${crypto.randomBytes(32).toString('hex')}`;
}

/** 项目根目录（server/ 的上一级） */
export const PROJECT_ROOT: string = path.resolve(here, '..');

/** 数据目录：server/data */
export const DATA_DIR: string = path.join(PROJECT_ROOT, 'server', 'data');

// ------------------------------------------------------------
// 1. 加载 .env
// ------------------------------------------------------------
const envPath: string = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // 没有 .env 也不报错：所有变量都有默认值，缺 Key 只影响 AI 调用
  dotenv.config();
}

// ------------------------------------------------------------
// 2. 读取辅助函数
// ------------------------------------------------------------

function str(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

/**
 * 构建 CORS 允许来源白名单：
 * - CORS_ORIGIN 可填多个（逗号分隔），例如 https://xulian.com,https://api.xulian.com
 * - 开发环境额外放行 Vite 本地预览地址（localhost:5173 / 127.0.0.1:5173）
 * - 生产环境绝不自动放行 localhost，必须显式配置正式域名
 */
function buildCorsOrigins(): string[] {
  const raw = str('CORS_ORIGIN', '');
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (str('NODE_ENV', 'development') !== 'production') {
    list.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }
  return Array.from(new Set(list));
}

// ------------------------------------------------------------
// 3. 类型化的 env
// ------------------------------------------------------------

export type NodeEnv = 'development' | 'production' | 'test';

export interface Env {
  nodeEnv: NodeEnv;
  isDev: boolean;
  port: number;
  /** 监听地址：默认 0.0.0.0（所有网络接口，可被局域网/公网访问）；纯本机调试可设 127.0.0.1 */
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 是否打印用户消息全文（仅本地调试，默认关） */
  logFullText: boolean;
  /** 网站正式地址（用于推送深链、日志提示等） */
  clientOrigin: string;
  /** 允许跨域访问 API 的来源白名单（CORS）。生产环境填正式域名，绝不填 * */
  corsOrigins: string[];

  // ---- Ollama（自建开源模型运行时，无需任何第三方 API Key）----
  /** Ollama 服务地址（仅后端可访问，前端不可见、不可被用户覆盖） */
  ollamaBaseUrl: string;
  /** 默认聊天模型名（如 qwen2.5:3b） */
  ollamaModel: string;
  /** 轻量任务（情绪 / 记忆抽取）模型，留空回退 ollamaModel */
  ollamaLightModel: string;
  /** 单次 AI 调用超时（毫秒） */
  aiTimeoutMs: number;

  // ---- 云端 LLM（OpenAI 兼容接口，用于免費公網部署，无需本地 Ollama）----
  /** AI 供应商：'ollama' = 本地自建；'openai' = 云端 OpenAI 兼容接口（Groq/Gemini 等） */
  aiProvider: 'ollama' | 'openai';
  /** 云端 LLM 的 OpenAI 兼容 baseUrl（如 https://api.groq.com/openai/v1） */
  openaiBaseUrl: string;
  /** 云端 LLM 的 API Key（仅后端可见，绝不下发前端、绝不可被用户覆盖） */
  openaiApiKey: string;
  /** 主对话模型名（如 llama-3.3-70b-versatile） */
  openaiModel: string;
  /** 轻量任务（情绪 / 记忆抽取 / JSON）模型，留空回退 openaiModel */
  openaiLightModel: string;

  // ---- 限流 / 配额 ----
  rateLimitUserPerMin: number;
  rateLimitIpPerMin: number;
  /** 每用户每日 AI 调用上限 */
  dailyAiLimitPerUser: number;

  // ---- Web Push ----
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidMailto: string;

  // ---- 主动聊天 ----
  proactiveEnabled: boolean;
  proactiveTickMs: number;
  enableDebugRoutes: boolean;

  // ---- 认证与会话（V2 · T02）----
  /**
   * 会话 token 的 HMAC 签名密钥。
   * 生产环境**必须**设置（见 validateEnv）：泄露它等于可以伪造任何人的登录态。
   */
  sessionSecret: string;
  /**
   * 是否允许「无 Bearer token」的匿名访问（用 X-User-Id 认人）。
   * 开发环境默认开（方便直接调试），生产默认关。
   * 即使开启，**已注册**的账号也绝不允许匿名访问（见 http.ts resolveUser）。
   */
  allowAnonymous: boolean;

  // ---- 其他 ----
  appTz: string;
  /** 数据库文件路径 */
  dbPath: string;
}

export const env: Env = {
  nodeEnv: (str('NODE_ENV', 'development') as NodeEnv) ?? 'development',
  isDev: str('NODE_ENV', 'development') !== 'production',
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  logLevel: (str('LOG_LEVEL', 'debug') as Env['logLevel']) ?? 'debug',
  logFullText: bool('LOG_FULL_TEXT', false),
  clientOrigin: str('CLIENT_ORIGIN', 'http://localhost:5173'),
  corsOrigins: buildCorsOrigins(),

  ollamaBaseUrl: str('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaModel: str('OLLAMA_MODEL', 'qwen2.5:3b'),
  ollamaLightModel: str('OLLAMA_LIGHT_MODEL') || str('OLLAMA_MODEL', 'qwen2.5:3b'),
  aiTimeoutMs: int('AI_TIMEOUT_MS', 120_000),

  // ---- 云端 LLM（OpenAI 兼容，用于免費公網部署）----
  aiProvider: (str('AI_PROVIDER', 'ollama') as 'ollama' | 'openai') ?? 'ollama',
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.groq.com/openai/v1'),
  openaiApiKey: str('OPENAI_API_KEY'),
  openaiModel: str('OPENAI_MODEL', 'llama-3.3-70b-versatile'),
  openaiLightModel: str('OPENAI_LIGHT_MODEL', 'llama-3.1-8b-instant'),

  rateLimitUserPerMin: int('RATE_LIMIT_USER_PER_MIN', 12),
  rateLimitIpPerMin: int('RATE_LIMIT_IP_PER_MIN', 40),
  dailyAiLimitPerUser: int('DAILY_AI_LIMIT_PER_USER', 200),

  vapidPublicKey: str('VAPID_PUBLIC_KEY'),
  vapidPrivateKey: str('VAPID_PRIVATE_KEY'),
  vapidMailto: str('VAPID_MAILTO', 'mailto:dev@example.com'),

  proactiveEnabled: bool('PROACTIVE_ENABLED', true),
  proactiveTickMs: int('PROACTIVE_TICK_MS', 600_000),
  enableDebugRoutes: bool('ENABLE_DEBUG_ROUTES', true),

  // SESSION_SECRET 不设硬编码默认值：没配就用一个**随机值**，
  // 代价是重启后所有会话失效，但绝不会出现「全世界的部署共用同一个密钥」这种事故。
  sessionSecret: str('SESSION_SECRET') || randomSecret(),
  // ALLOW_ANONYMOUS：开发默认 1，生产默认 0
  allowAnonymous: bool('ALLOW_ANONYMOUS', str('NODE_ENV', 'development') !== 'production'),

  appTz: str('APP_TZ', 'Asia/Taipei'),
  dbPath: str('XULIAN_DB_PATH', path.join(DATA_DIR, 'xulian.db')),
};

// ------------------------------------------------------------
// 4. 校验与脱敏输出
// ------------------------------------------------------------

/** 敏感值脱敏：只保留前 4 与后 4 位，短值全部打码 */
export function maskSecret(value: string): string {
  if (!value) return '(未設定)';
  if (value.length <= 10) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export interface EnvIssue {
  level: 'warn' | 'error';
  key: string;
  message: string;
}

/**
 * 启动时检查环境变量。
 * AI 相关缺失只 warn（不阻断进程），这样即使没配 Key 也能先把 UI / DB 跑起来。
 */
export function validateEnv(): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (!isAiConfigured()) {
    issues.push({
      level: 'warn',
      key: 'OLLAMA_BASE_URL',
      message:
        '未檢測到 Ollama 配置：請在 .env 設定 OLLAMA_BASE_URL（預設 http://localhost:11434）' +
        '與 OLLAMA_MODEL（如 qwen2.5:3b），並確認 Ollama 已啟動且已拉取該模型。',
    });
  }
  if (env.aiProvider === 'openai' && !env.openaiApiKey) {
    issues.push({
      level: 'warn',
      key: 'OPENAI_API_KEY',
      message: '未設定 OPENAI_API_KEY：使用雲端 LLM 時必須提供免費的 Groq/Gemini API Key。',
    });
  }
  if (!env.vapidPublicKey || !env.vapidPrivateKey) {
    issues.push({
      level: 'warn',
      key: 'VAPID_PUBLIC_KEY',
      message: '未配置 VAPID 金鑰，Web Push 將不可用（執行 npm run push:keys 可生成）。',
    });
  }
  if (env.nodeEnv === 'production' && env.enableDebugRoutes) {
    issues.push({
      level: 'warn',
      key: 'ENABLE_DEBUG_ROUTES',
      message: '生產環境不應開啟 ENABLE_DEBUG_ROUTES。',
    });
  }
  if (env.nodeEnv === 'production' && !process.env['SESSION_SECRET']) {
    issues.push({
      level: 'error',
      key: 'SESSION_SECRET',
      message:
        '生產環境必須設定 SESSION_SECRET（隨機長字串）。未設定時系統會用隨機值兜底，' +
        '這會導致每次重啟所有使用者都被登出。',
    });
  }
  if (env.nodeEnv === 'production' && env.allowAnonymous) {
    issues.push({
      level: 'warn',
      key: 'ALLOW_ANONYMOUS',
      message: '生產環境不應開啟 ALLOW_ANONYMOUS（任何人都能用 X-User-Id 冒充未註冊帳號）。',
    });
  }
  if (env.nodeEnv === 'production' && env.corsOrigins.length === 0) {
    issues.push({
      level: 'warn',
      key: 'CORS_ORIGIN',
      message:
        '生產環境未設定 CORS_ORIGIN。若前端與 API 部署在同一域名（後端直接托管前端），同源無需 CORS；' +
        '若前端在別的域名（如 GitHub Pages / CDN），必須設定 CORS_ORIGIN 為該域名，否則瀏覽器會攔截 API 請求。',
    });
  }
  return issues;
}

/** AI 是否已配置好（/api/health 与前端优雅降级都依赖它） */
export function isAiConfigured(): boolean {
  if (env.aiProvider === 'openai') return Boolean(env.openaiApiKey);
  return Boolean(env.ollamaBaseUrl && env.ollamaModel);
}

export default env;
