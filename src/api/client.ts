/**
 * 统一 HTTP 客户端
 *
 * 职责：
 * - 自动注入 `X-User-Id`（MVP 的用户标识，需求 §23 的接口约定）；
 * - 把 `{ ok:false, error:{code,message} }` 转成带错误码的异常；
 * - 把 `E_AI_*` 等错误码映射成人话（架构文档 §8.2）。
 *
 * 所有网络请求都必须走这里，不要在组件里直接 fetch（架构文档 §8.8）。
 */

import { ERROR_MESSAGES, isRetryable, type ErrorCodeValue } from '@shared/errors';
import { STORAGE_KEYS } from '@/config';
import { API_BASE } from '@/config/api';
import { uuid } from '@/utils/id';
import { toast } from '@/components/common/Toast';

/** 后端无响应超过这个时间，提示“冷启动唤醒中”（Render 免费版会休眠，首个请求可能要等数十秒） */
export const COLD_START_HINT_MS = 5_000;

/**
 * 硬超时上限。给足冷启动时间（免费版唤醒可能要 20~40s），避免一超时就把用户踢走；
 * 5s 时先弹“后端正在冷启动唤醒中”的友好提示，让用户知道不是卡死了。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

let cachedUserId: string | null = null;

/**
 * 读取本地 userId；没有就生成一个并写入 localStorage。
 * 这是 MVP 的"登录"：不做真实账号，但保证同一个人每次打开是同一个 ID。
 */
export function ensureLocalUserId(): string {
  if (cachedUserId) return cachedUserId;
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.userId);
    if (saved && saved.trim()) {
      cachedUserId = saved.trim();
      return cachedUserId;
    }
  } catch {
    // 隐私模式下 localStorage 可能抛错，退化成"只在内存里保持本次会话"
  }
  cachedUserId = uuid();
  try {
    localStorage.setItem(STORAGE_KEYS.userId, cachedUserId);
  } catch {
    // 存不下就算了，本次会话仍可用
  }
  return cachedUserId;
}

/** 覆盖当前 userId（bootstrap 返回服务端 ID 后调用） */
export function setUserId(userId: string): void {
  cachedUserId = userId;
  try {
    localStorage.setItem(STORAGE_KEYS.userId, userId);
  } catch {
    // 同上：写入失败不影响内存中的值
  }
}

/** 取当前 userId（不触发创建） */
export function getUserId(): string {
  return cachedUserId ?? ensureLocalUserId();
}

// ============================================================
// 会话 token（V2 · T02）
// ============================================================

/** 读本地 token；没有返回 null */
export function getToken(): string | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.token);
    return saved && saved.trim() ? saved.trim() : null;
  } catch {
    // 隐私模式下 localStorage 可能抛错 → 退化成"只在内存里保持本次会话"
    return null;
  }
}

/** 写入 token（登录 / 注册成功后调用） */
export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.token, token);
  } catch {
    // 存不下就算了，本次会话仍可用（token 已在上层内存里）
  }
}

/** 清除 token（登出 / 401 时调用） */
export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.token);
  } catch {
    // 同上：清不掉也不影响内存态
  }
}

/**
 * 这些路径是「公开页」：在它们上面遇到 401 不跳转，
 * 否则会出现「/login 自己把用户踢到 /login」的死循环。
 */
const PUBLIC_PATHS = ['/login', '/register'];

/** 遇到「需要登录」类错误码时跳到登录页（公开页上不跳） */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return;
  clearToken();
  window.location.href = '/login';
}

/** 需要把用户踢去登录的错误码 */
const AUTH_REDIRECT_CODES: ReadonlySet<string> = new Set<string>([
  'E_AUTH_REQUIRED',
  'E_SESSION_EXPIRED',
]);

/** 网络/接口异常：带错误码与"是否值得重试"标记 */
export class ApiError extends Error {
  readonly code: ErrorCodeValue | string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    code: ErrorCodeValue | string,
    message: string,
    status: number,
    retryable: boolean,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /** query 参数（GET/DELETE 用） */
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 是否附带 X-User-Id（默认 true） */
  auth?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 为 true 时不在全局弹错误 Toast（调用方自己处理错误展示） */
  silent?: boolean;
}

function buildUrl(path: string, params?: RequestOptions['params']): string {
  // 统一加 API 基地址：生产若前后端不同源，用 VITE_API_BASE_URL 指定；
  // 同源部署时 API_BASE 为空，走相对路径（/api/...），天然兼容 HTTPS 与跨设备。
  const fullPath = API_BASE ? `${API_BASE}${path}` : path;
  if (!params) return fullPath;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `${fullPath}?${query}` : fullPath;
}

/**
 * 发起请求并解析统一的 `{ok, data}` / `{ok:false, error}` 结构。
 * 超时用 AbortController 实现，避免请求挂死导致 UI 一直转圈。
 */
async function request<T>(options: RequestOptions): Promise<T> {
  const {
    method,
    path,
    params,
    body,
    auth = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: externalSignal,
    silent = false,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 冷启动提示：Render 免费版休眠后首请求可能要数十秒才响应，5s 内无响应先提示"唤醒中"
  let coldStartId: string | null = null;
  const coldStartTimer = setTimeout(() => {
    coldStartId = toast.info('后端正在冷启动唤醒中，请稍候...', 0); // duration=0 → 常驻，手动消失
  }, COLD_START_HINT_MS);

  // 外部 signal 也要能中断（聊天流式请求用）
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers['X-User-Id'] = getUserId();
  // V2：有 token 就带上 Bearer——服务端以它为准，X-User-Id 只是匿名模式的回落
  const token = getToken();
  if (token && auth !== false) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, params), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    const apiErr = new ApiError(
      aborted ? 'E_AI_TIMEOUT' : 'E_INTERNAL',
      aborted ? '請求逾時，請再試一次' : '連不上伺服器，請確認網路',
      0,
      true,
      { cause: err instanceof Error ? err.message : String(err) },
    );
    if (!silent) toast.error(apiErr.message);
    throw apiErr;
  } finally {
    clearTimeout(timer);
    clearTimeout(coldStartTimer);
    if (coldStartId) toast.dismiss(coldStartId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  // 204 No Content（OPTIONS 预检 / 空响应）
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  let payload: unknown;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON 响应：绝大多数是「后端冷启动 / Render 免费版」回的 HTML 错误页（503 / 服务不可用 /
      // Application is starting），不是真的"非预期内容"。给友好提示并标记可重试，
      // 别让用户看到一串看不懂的文案。
      const looksLikeHtml =
        /^\s*</.test(text) ||
        /<html|<!doctype/i.test(text) ||
        /service\s*unavailable|503|application (is )?starting|upstream|bad gateway/i.test(text);
      const apiErr = new ApiError(
        looksLikeHtml ? 'E_BACKEND_UNAVAILABLE' : 'E_INTERNAL',
        looksLikeHtml
          ? '后端暂时无法响应，可能正在冷启动唤醒中，请稍后重试'
          : '伺服器回傳了非預期內容',
        response.status,
        true,
        { preview: text.slice(0, 120) },
      );
      if (!silent) toast.error(apiErr.message);
      throw apiErr;
    }
  }

  if (!response.ok || (isRecord(payload) && payload['ok'] === false)) {
    const errorObj = isRecord(payload) && isRecord(payload['error']) ? payload['error'] : {};
    const code = typeof errorObj['code'] === 'string' ? (errorObj['code'] as string) : 'E_INTERNAL';
    const serverMessage = typeof errorObj['message'] === 'string' ? errorObj['message'] : '';
    const message =
      serverMessage ||
      (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
        ? ERROR_MESSAGES[code as ErrorCodeValue]
        : '發生未知錯誤');
    const error = new ApiError(
      code,
      message,
      response.status,
      isRetryable(code),
      errorObj['details'],
    );

    if (!silent) toast.error(error.message);

    // 登录态失效：立刻清 token 并跳登录页（登录/注册页本身不跳，避免死循环）。
    // E_INVALID_CREDENTIALS 不在这里处理——那是"刚才输入的密码不对"，
    // 用户还站在登录页上，跳走反而看不到错误提示。
    if (AUTH_REDIRECT_CODES.has(code)) redirectToLogin();

    throw error;
  }

  if (isRecord(payload) && payload['ok'] === true && 'data' in payload) {
    return payload['data'] as T;
  }
  // 兜底：既不是 {ok:true,data} 也不是错误，就原样返回
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- 对外方法 ----

export function apiGet<T>(
  path: string,
  params?: RequestOptions['params'],
  init?: { timeoutMs?: number; signal?: AbortSignal; auth?: boolean; silent?: boolean },
): Promise<T> {
  return request<T>({ method: 'GET', path, params, ...init });
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  init?: { timeoutMs?: number; signal?: AbortSignal; auth?: boolean; silent?: boolean },
): Promise<T> {
  return request<T>({ method: 'POST', path, body, ...init });
}

export function apiPatch<T>(
  path: string,
  body?: unknown,
  init?: { timeoutMs?: number; signal?: AbortSignal; auth?: boolean; silent?: boolean },
): Promise<T> {
  return request<T>({ method: 'PATCH', path, body, ...init });
}

export function apiDelete<T>(
  path: string,
  body?: unknown,
  init?: { timeoutMs?: number; signal?: AbortSignal; auth?: boolean; silent?: boolean },
): Promise<T> {
  return request<T>({ method: 'DELETE', path, body, ...init });
}

/**
 * 把任意异常转成可以给用户看的一句话。
 * 网络层异常没有错误码，统一走「网络不太稳」这条文案。
 */
export function humanizeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message || '發生未知錯誤';
  return '發生未知錯誤';
}
