/**
 * 用户标识 + Bootstrap 单例 store（性能优化：全应用只 bootstrap 一次、缓存优先）
 *
 * 改造点（对比原 V2 useUserId）：
 * 1. 用模块级单例 store + useSyncExternalStore：App 与首页（以及任何页面）多次调用
 *    useUserId / useAppState，只会触发「一次」POST /api/users/bootstrap。
 *    原实现里 App 调 POST、首页的 useAppState 又调 GET，首屏白白发 2 次。
 * 2. 缓存优先：bootstrap 结果落地 localStorage，首屏即使后端冷启动也能立刻渲染缓存内容，
 *    再后台静默刷新——首页不再整页「載入中…」阻塞。
 * 3. 失败容错：网络 / 冷启动失败时不清空已渲染的缓存，仅标注 error，用户先看到旧数据。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ensureLocalUserId, setUserId, ApiError, apiPost, humanizeError } from '@/api/client';
import { useAuth, getAuthSnapshot } from '@/hooks/useAuth';
import { localLocale, localTimezone } from '@/utils/time';
import type { BootstrapResponse } from '@/types/api';

/** 缓存键：只存「用户 + 角色列表 + 默认角色」，不含任何 token / 密码等敏感数据 */
const CACHE_KEY = 'xulian.bootstrap.cache.v1';

export interface BootstrapState {
  userId: string;
  synced: boolean;
  loading: boolean;
  error: string | null;
  bootstrap: BootstrapResponse | null;
  attempt: number;
}

function readCache(): BootstrapResponse | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BootstrapResponse>;
    if (parsed && parsed.user && Array.isArray(parsed.characters)) {
      return parsed as BootstrapResponse;
    }
  } catch {
    /* 缓存损坏则忽略，下次成功时重写 */
  }
  return null;
}

function writeCache(b: BootstrapResponse): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(b));
  } catch {
    /* 隐私模式 / 容量满：忽略，不影响内存态 */
  }
}

const initialCache = readCache();
let store: BootstrapState = {
  userId: ensureLocalUserId(),
  synced: false,
  // 有缓存则首屏直接可渲染（不转圈）；无缓存才进入加载态
  loading: initialCache ? false : true,
  error: null,
  bootstrap: initialCache,
  attempt: 0,
};

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
function set(patch: Partial<BootstrapState>): void {
  store = { ...store, ...patch };
  emit();
}

export function getBootstrapSnapshot(): BootstrapState {
  return store;
}

let inflight: Promise<void> | null = null;

async function doFetch(): Promise<void> {
  const { status, allowAnonymous, account } = getAuthSnapshot();
  if (status === 'loading') return;
  if (status !== 'authenticated' && !allowAnonymous) {
    set({ loading: false, synced: false, bootstrap: null, error: '請先登入' });
    return;
  }
  // 有缓存时不切回 loading，后台静默刷新即可，避免骨架闪烁
  set({ loading: !store.bootstrap, error: null });
  try {
    const data = await apiPost<BootstrapResponse>(
      '/api/users/bootstrap',
      {
        clientUserId: account?.user.id ?? ensureLocalUserId(),
        timezone: localTimezone(),
        locale: localLocale(),
      },
      { silent: true },
    );
    if (data?.user?.id) setUserId(data.user.id);
    set({ bootstrap: data, synced: true, loading: false });
    writeCache(data);
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : '無法連上伺服器';
    // 保留已有缓存内容：不因一次网络抖动把首屏清空成错误页
    set({ synced: false, loading: false, error: msg });
  }
}

/** 强制重新拉取 bootstrap（登录 / 登出 / 切角色后调用） */
export function refreshBootstrap(): void {
  if (!inflight) {
    inflight = doFetch().finally(() => {
      inflight = null;
    });
  }
}

/** 本地更新默认角色（无需重新 bootstrap 整包） */
export function setDefaultCharacterLocal(characterId: string): void {
  if (!store.bootstrap) return;
  const next = { ...store.bootstrap, defaultCharacterId: characterId };
  set({ bootstrap: next });
  writeCache(next);
}

export interface UseUserIdResult {
  userId: string;
  synced: boolean;
  loading: boolean;
  error: string | null;
  bootstrap: BootstrapResponse | null;
  authenticated: boolean;
  retry: () => void;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function useUserId(): UseUserIdResult {
  const { status, allowAnonymous, account } = useAuth();
  const snap = useSyncExternalStore(subscribe, getBootstrapSnapshot, getBootstrapSnapshot);

  useEffect(() => {
    // 认证状态还没问清楚 → 等下一轮（auth store 更新会触发本组件重渲染）
    if (status === 'loading') return;
    // inflight 去重：多个组件同时挂载也只发一次请求
    if (!inflight) {
      inflight = doFetch().finally(() => {
        inflight = null;
      });
    }
  }, [status, allowAnonymous, account?.user.id, snap.attempt]);

  const retry = useCallback(() => {
    set({ attempt: store.attempt + 1 });
  }, []);

  return {
    userId: snap.userId,
    synced: snap.synced,
    loading: snap.loading,
    error: snap.error,
    bootstrap: snap.bootstrap,
    authenticated: status === 'authenticated',
    retry,
  };
}

export default useUserId;
