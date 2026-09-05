/**
 * 「需恋」前后端共享错误码
 *
 * 后端用 ErrorCode 抛错，前端 `src/api/client.ts` 按 code 映射成中文提示。
 * 新增错误码必须同时在本文件的 ERROR_MESSAGES 里补一条面向用户的文案。
 */

export const ErrorCode = {
  // ---- 4xx：客户端可修复 ----
  BAD_REQUEST: 'E_BAD_REQUEST',
  USER_NOT_FOUND: 'E_USER_NOT_FOUND',
  FORBIDDEN: 'E_FORBIDDEN',
  NOT_FOUND: 'E_NOT_FOUND',
  VALIDATION: 'E_VALIDATION',
  EMPTY_MESSAGE: 'E_EMPTY_MESSAGE',
  MEMORY_DISABLED: 'E_MEMORY_DISABLED',
  PUSH_NOT_SUPPORTED: 'E_PUSH_NOT_SUPPORTED',
  TOO_LONG: 'E_TOO_LONG',

  // ---- 4xx：认证与会话（V2 · T02）----
  /** 需要登录才能访问（匿名模式已关闭，或账号已注册却没带 token） */
  AUTH_REQUIRED: 'E_AUTH_REQUIRED',
  /** 邮箱或密码错误（不区分具体哪一个，避免账号枚举） */
  INVALID_CREDENTIALS: 'E_INVALID_CREDENTIALS',
  /** 邮箱已被注册（决策 #4：不做账号合并，直接拒绝） */
  EMAIL_TAKEN: 'E_EMAIL_TAKEN',
  /** 邮箱格式不合法 */
  EMAIL_INVALID: 'E_EMAIL_INVALID',
  /** 密码强度不足（≥8 位且含字母+数字） */
  PASSWORD_WEAK: 'E_PASSWORD_WEAK',
  /** 连续失败次数过多，账号临时锁定 15 分钟 */
  ACCOUNT_LOCKED: 'E_ACCOUNT_LOCKED',
  /** 会话已过期或被吊销 */
  SESSION_EXPIRED: 'E_SESSION_EXPIRED',
  /** 该匿名账号已经注册过，不能重复注册 */
  ALREADY_REGISTERED: 'E_ALREADY_REGISTERED',

  // ---- 5xx：服务端 / AI 链路 ----
  INTERNAL: 'E_INTERNAL',
  DB_ERROR: 'E_DB_ERROR',
  AI_AUTH: 'E_AI_AUTH',
  AI_RATE_LIMIT: 'E_AI_RATE_LIMIT',
  AI_MODEL_MISSING: 'E_AI_MODEL_MISSING',
  AI_CLI_NOT_FOUND: 'E_AI_CLI_NOT_FOUND',
  AI_TIMEOUT: 'E_AI_TIMEOUT',
  AI_UNAVAILABLE: 'E_AI_UNAVAILABLE',
  AI_BLOCKED: 'E_AI_BLOCKED',
  PUSH_FAILED: 'E_PUSH_FAILED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 → HTTP 状态码 */
export const ERROR_HTTP_STATUS: Record<ErrorCodeValue, number> = {
  E_BAD_REQUEST: 400,
  E_USER_NOT_FOUND: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_VALIDATION: 422,
  E_EMPTY_MESSAGE: 400,
  E_MEMORY_DISABLED: 409,
  E_PUSH_NOT_SUPPORTED: 400,
  E_TOO_LONG: 400,

  // 认证与会话
  E_AUTH_REQUIRED: 401,
  E_INVALID_CREDENTIALS: 401,
  E_EMAIL_TAKEN: 409,
  E_EMAIL_INVALID: 422,
  E_PASSWORD_WEAK: 422,
  E_ACCOUNT_LOCKED: 429,
  E_SESSION_EXPIRED: 401,
  E_ALREADY_REGISTERED: 409,

  E_INTERNAL: 500,
  E_DB_ERROR: 500,
  E_AI_AUTH: 503,
  E_AI_RATE_LIMIT: 429,
  E_AI_MODEL_MISSING: 503,
  E_AI_CLI_NOT_FOUND: 503,
  E_AI_TIMEOUT: 504,
  E_AI_UNAVAILABLE: 503,
  E_AI_BLOCKED: 200, // 安全拦截对客户端是"正常结束"，复用 200 + ok:false
  E_PUSH_FAILED: 502,
};

/** 错误码 → 面向用户的繁体中文提示 */
export const ERROR_MESSAGES: Record<ErrorCodeValue, string> = {
  E_BAD_REQUEST: '請求有誤，請重試',
  E_USER_NOT_FOUND: '找不到這個使用者，請重新開啟 App',
  E_FORBIDDEN: '這不是你的資料',
  E_NOT_FOUND: '找不到內容',
  E_VALIDATION: '填寫的內容有問題',
  E_EMPTY_MESSAGE: '說點什麼吧',
  E_MEMORY_DISABLED: '長期記憶已關閉',
  E_PUSH_NOT_SUPPORTED: '這個瀏覽器不支援推播通知',
  E_TOO_LONG: '內容太長了',

  E_AUTH_REQUIRED: '請先登入',
  E_INVALID_CREDENTIALS: '信箱或密碼不對',
  E_EMAIL_TAKEN: '這個信箱已經註冊過了',
  E_EMAIL_INVALID: '信箱格式不對',
  E_PASSWORD_WEAK: '密碼至少要 8 個字，而且要有英文字母和數字',
  E_ACCOUNT_LOCKED: '錯誤次數太多，請 15 分鐘後再試',
  E_SESSION_EXPIRED: '登入已過期，請重新登入',
  E_ALREADY_REGISTERED: '這個帳號已經註冊過了，請直接登入',

  E_INTERNAL: '伺服器出了點狀況',
  E_DB_ERROR: '資料讀取失敗',
  E_AI_AUTH: 'AI 服務尚未設定好，請聯絡管理員',
  E_AI_RATE_LIMIT: 'AI 服務繁忙，請稍後再試',
  E_AI_MODEL_MISSING: 'AI 模型暫時不可用，請聯絡管理員',
  E_AI_CLI_NOT_FOUND: 'AI 執行環境還沒就緒',
  E_AI_TIMEOUT: '這次等太久了，網路不太穩',
  E_AI_UNAVAILABLE: 'AI 暫時連不上',
  E_AI_BLOCKED: '這段內容被安全規則擋下了',
  E_PUSH_FAILED: '推播發送失敗',
};

/** 该错误码是否值得让用户点「重试」 */
export const RETRYABLE_ERRORS: ReadonlySet<ErrorCodeValue> = new Set<ErrorCodeValue>([
  'E_AI_TIMEOUT',
  'E_AI_UNAVAILABLE',
  'E_INTERNAL',
  'E_DB_ERROR',
  'E_PUSH_FAILED',
]);

export function isRetryable(code: string): boolean {
  return RETRYABLE_ERRORS.has(code as ErrorCodeValue);
}

/** 统一的 API 失败响应体形状 */
export interface ApiErrorBody {
  ok: false;
  error: {
    code: ErrorCodeValue | string;
    message: string;
    details?: unknown;
  };
}

/** 统一的 API 成功响应体形状 */
export interface ApiSuccessBody<T> {
  ok: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessBody<T> | ApiErrorBody;
