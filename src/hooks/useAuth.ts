/**
 * 认证状态 Hook（V2 · T02）
 *
 * 为什么用模块级 store 而不是 useState：
 * 路由守卫、设置页、账号页都会用到认证状态，如果各存一份就会各发一次
 * `/api/auth/status`。这里用 `useSyncExternalStore` + 模块级单例，
 * 全应用只探活一次，任何一处登录/登出都会同步到所有订阅者。
 *
 * 三种状态：
 * - `loading`       ：还没问过服务器（首屏）
 * - `anonymous`     ：没有有效登录态（匿名模式可用与否看 allowAnonymous）
 * - `authenticated` ：持有有效 token
 */

import { useCallback, useSyncExternalStore } from 'react';

import {
  apiGet,
  apiPatch,
  apiPost,
  clearToken,
  ensureLocalUserId,
  getToken,
  humanizeError,
  setToken,
  setUserId,
} from '@/api/client';
import type {
  AccountInfoResponse,
  AuthStatusResponse,
  AuthTokenResponse,
} from '@/types/api';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthSnapshot {
  status: AuthStatus;
  /** 已登录时的账号信息；未登录为 null */
  account: AccountInfoResponse | null;
  /** 服务端是否允许匿名访问（ALLOW_ANONYMOUS） */
  allowAnonymous: boolean;
  /** 最近一次操作的错误（人话），成功为 null */
  error: string | null;
}

// ============================================================
// 模块级 store
// ============================================================

let snapshot: AuthSnapshot = {
  status: 'loading',
  account: null,
  // 默认值取 true（乐观）：真正的答案由 /api/auth/status 给出，
  // 首屏不会因为等这一个请求而白屏。
  allowAnonymous: true,
  error: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setSnapshot(patch: Partial<AuthSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

/**
 * 向服务器探活：有没有 token？token 还有效吗？服务端允许匿名吗？
 * 三个问题一次问完（`allowAnonymous` 前端无法自行判断，必须问后端）。
 */
async function loadAuthState(): Promise<void> {
  const status = await apiGet<AuthStatusResponse>('/api/auth/status', undefined, {
    auth: false,
    silent: true,
  });
  setSnapshot({ allowAnonymous: status.allowAnonymous });

  if (status.authenticated && getToken()) {
    const me = await apiGet<AccountInfoResponse>('/api/auth/me', undefined, { silent: true });
    // 让 X-User-Id 与登录态保持一致，避免两个身份各说各话
    setUserId(me.user.id);
    setSnapshot({ status: 'authenticated', account: me, error: null });
    return;
  }

  clearToken();
  setSnapshot({ status: 'anonymous', account: null, error: null });
}

let bootstrapPromise: Promise<void> | null = null;

/** 保证认证状态已经探过一次活；重复调用只会发一次请求 */
export function ensureAuthReady(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = loadAuthState().catch((err: unknown) => {
      // 连不上服务器时按「匿名」处理，而不是让整个 App 卡在 loading
      setSnapshot({ status: 'anonymous', account: null, error: humanizeError(err) });
    });
  }
  return bootstrapPromise;
}

/** 丢弃缓存的探活结果（改密码 / 手动刷新后想重新拉一次时用） */
export function resetAuthCache(): void {
  bootstrapPromise = null;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  void ensureAuthReady();
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** getSnapshot 必须返回稳定引用：只在 setSnapshot 里替换整个对象 */
function getSnapshot(): AuthSnapshot {
  return snapshot;
}

// ============================================================
// 登录 / 注册 / 登出
// ============================================================

/** 拿到 token 后的统一收尾：存 token、同步 userId、拉完整账号信息 */
async function applyAuthResult(request: Promise<AuthTokenResponse>): Promise<void> {
  const result = await request;
  setToken(result.token);
  setUserId(result.user.id);
  // 注册/登录响应里带的是精简 user，这里再取一次完整账号信息（含 session 详情）
  const me = await apiGet<AccountInfoResponse>('/api/auth/me', undefined, { silent: true });
  setSnapshot({ status: 'authenticated', account: me, error: null });
}

export interface RegisterPayload {
  email: string;
  password: string;
  displayName?: string;
  /** 选填：填了且未满 18 岁会启用未成年强化保护 */
  birthDate?: string | null;
  /**
   * 是否复用当前浏览器里的匿名账号（默认 true）。
   * 传 true 时服务端复用同一个 users 行 —— 历史角色 / 记忆 / 会话一条不丢。
   */
  attachAnonymous?: boolean;
}

export interface UseAuthResult extends AuthSnapshot {
  login: (email: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<number>;
  refresh: () => Promise<void>;
  /** 当前状态是否是「已登录」的语法糖 */
  authenticated: boolean;
}

export function useAuth(): UseAuthResult {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    try {
      await applyAuthResult(
        apiPost<AuthTokenResponse>('/api/auth/login', { email, password }, { auth: false, silent: true }),
      );
    } catch (err) {
      setSnapshot({ error: humanizeError(err) });
      throw err;
    }
  }, []);

  const register = useCallback(async (payload: RegisterPayload): Promise<void> => {
    try {
      // attachUserId = 浏览器里现有的匿名 userId → 服务端复用同一行 users（零迁移）
      const attachUserId =
        payload.attachAnonymous === false ? undefined : ensureLocalUserId();
      await applyAuthResult(
        apiPost<AuthTokenResponse>(
          '/api/auth/register',
          {
            email: payload.email,
            password: payload.password,
            displayName: payload.displayName ?? '',
            birthDate: payload.birthDate ?? null,
            attachUserId,
          },
          { auth: false, silent: true },
        ),
      );
    } catch (err) {
      setSnapshot({ error: humanizeError(err) });
      throw err;
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiPost<{ success: boolean }>('/api/auth/logout', {});
    } catch {
      // 后端已经不认这个 token 时也算登出成功：本地状态必须清干净
    }
    clearToken();
    setSnapshot({ status: 'anonymous', account: null, error: null });
  }, []);

  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string): Promise<number> => {
      const result = await apiPatch<{ ok: true; revokedSessions: number }>('/api/auth/password', {
        oldPassword,
        newPassword,
      }, { silent: true });
      const revoked = result.revokedSessions;
      // 其它设备已被踢下线，本机会话仍在；刷新一次账号信息
      const me = await apiGet<AccountInfoResponse>('/api/auth/me', undefined, { silent: true });
      setSnapshot({ account: me });
      return revoked;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    resetAuthCache();
    await ensureAuthReady();
  }, []);

  return {
    status: snap.status,
    account: snap.account,
    allowAnonymous: snap.allowAnonymous,
    error: snap.error,
    authenticated: snap.status === 'authenticated',
    login,
    register,
    logout,
    changePassword,
    refresh,
  };
}

export default useAuth;
