/**
 * POST + SSE 流式解析
 *
 * 为什么不用 EventSource：聊天接口是 POST（要带用户输入与上下文），
 * 而 EventSource 只支持 GET。所以沿用模板的 `fetch + response.body.getReader()`
 * 方案，按 SSE 文本协议自己拆行。
 *
 * 协议（shared/sse.ts）：每行 `data: <JSON>\n\n`；`: ping` 是心跳注释行，直接忽略。
 */

import type { ChatSseEvent } from '@shared/sse';
import { ApiError, getToken, getUserId, redirectToLogin, COLD_START_HINT_MS } from './client';
import { API_BASE } from '@/config/api';
import { toast } from '@/components/common/Toast';

export interface SseStreamHandlers {
  /** 每收到一条事件回调一次（text 事件是增量 delta，调用方负责拼接） */
  onEvent: (event: ChatSseEvent) => void;
  /** 连接层出错（网络中断等）。业务错误走 event.type === 'error' */
  onError?: (err: Error) => void;
  /** 流结束（无论正常还是异常） */
  onClose?: () => void;
}

export interface SseStreamOptions {
  signal?: AbortSignal;
  /** 是否附带 X-User-Id（默认 true） */
  auth?: boolean;
}

/**
 * 发起一个 SSE 流式 POST 请求。
 * 正常返回表示流已读完；抛出 Error 表示连接层异常（不含业务 error 事件）。
 */
/**
 * 把非 2xx 的聊天响应转成带错误码的 ApiError（与 client.ts 的 request() 一致）。
 * 这样聊天失败也能按 401/403/404/429/500/503 分流提示，而不是一律「伺服器回應 401」。
 * 绝不输出完整 token / key 等敏感信息。
 */
async function responseToApiError(response: Response): Promise<ApiError> {
  let code: string = 'E_INTERNAL';
  let message = `伺服器回應 ${response.status}`;
  let details: unknown;
  try {
    const text = await response.text();
    if (text) {
      const payload = JSON.parse(text) as unknown;
      const errorObj =
        payload && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: Record<string, unknown> }).error
          : undefined;
      if (errorObj && typeof errorObj === 'object') {
        if (typeof errorObj['code'] === 'string') code = errorObj['code'] as string;
        if (typeof errorObj['message'] === 'string') message = errorObj['message'] as string;
        details = errorObj['details'];
      }
    }
  } catch {
    // 解析失败就用默认文案，不要因为日志解析而掩盖真实错误
  }
  return new ApiError(code, message, response.status, false, details);
}

export async function postSse(
  path: string,
  body: unknown,
  handlers: SseStreamHandlers,
  options: SseStreamOptions = {},
): Promise<void> {
  const { signal, auth = true } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (auth) {
    headers['X-User-Id'] = getUserId();
    // V2：有 token 就带上 Bearer——服务端以它为准，X-User-Id 只是匿名模式的回落。
    // 只带 X-User-Id 在 ALLOW_ANONYMOUS=0 时会直接 401，导致已登录用户无法聊天。
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const url = API_BASE ? `${API_BASE}${path}` : path;

  // 冷启动提示（与 client.ts 一致）：后端休眠后首请求慢，5s 内无响应先提示"唤醒中"
  let coldStartId: string | null = null;
  const coldStartTimer = setTimeout(() => {
    coldStartId = toast.info('后端正在冷启动唤醒中，请稍候...', 0);
  }, COLD_START_HINT_MS);
  const clearColdStart = (): void => {
    clearTimeout(coldStartTimer);
    if (coldStartId) toast.dismiss(coldStartId);
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    // 用户主动中断（点「停止」）不算错误，直接安静结束
    if (err instanceof DOMException && err.name === 'AbortError') {
      clearColdStart();
      handlers.onClose?.();
      return;
    }
    const error = new Error('連不上伺服器，請確認網路');
    clearColdStart();
    handlers.onError?.(error);
    handlers.onClose?.();
    throw error;
  }

  // 一旦拿到任意响应（成功或失败）就撤掉冷启动提示
  clearColdStart();

  if (!response.ok) {
    const apiError = await responseToApiError(response);
    // 登录态失效：清 token 并跳登录页（与 client.ts 的 request() 保持一致），
    // 避免用户停留在聊天页一直收到 401。
    if (apiError.code === 'E_AUTH_REQUIRED' || apiError.code === 'E_SESSION_EXPIRED') {
      redirectToLogin();
    }
    clearColdStart();
    handlers.onError?.(apiError);
    handlers.onClose?.();
    throw apiError;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const error = new Error('這個瀏覽器不支援串流回應');
    handlers.onError?.(error);
    handlers.onClose?.();
    throw error;
  }

  const decoder = new TextDecoder('utf-8');
  // 缓冲区：网络包可能在任意位置切断一行，必须跨包拼接后再解析
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件，这里按 \n\n 切块，最后一块可能不完整，留在 buffer 里
      let sepIndex = buffer.indexOf('\n\n');
      while (sepIndex >= 0) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        handleRawEvent(rawEvent, handlers);
        sepIndex = buffer.indexOf('\n\n');
      }
    }

    // 流结束时把剩余内容也处理掉（有些实现最后一行不加空行）
    if (buffer.trim()) {
      handleRawEvent(buffer, handlers);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      handlers.onClose?.();
      return;
    }
    const error = err instanceof Error ? err : new Error(String(err));
    handlers.onError?.(error);
    throw error;
  } finally {
    handlers.onClose?.();
  }
}

/**
 * 解析一个 SSE 事件块。
 * 可能包含多行（我们的协议每行一个 data:），逐行处理。
 */
function handleRawEvent(rawEvent: string, handlers: SseStreamHandlers): void {
  for (const line of rawEvent.split('\n')) {
    const trimmed = line.trim();
    // 心跳注释行与空行直接忽略
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (!trimmed.startsWith('data:')) continue;

    const json = trimmed.slice(5).trim();
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as ChatSseEvent;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        handlers.onEvent(parsed);
      }
    } catch {
      // 单行 JSON 解析失败不应该中断整条流（可能是半包），直接跳过
    }
  }
}
