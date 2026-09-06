/**
 * 用户标识 Hook（V2 · T02 改造）
 *
 * 与 V1 的差别：现在**先等 `useAuth` 把登录态问清楚**，再决定要不要 bootstrap。
 * 原因：V1 无条件拿着 localStorage 里的 ID 去 bootstrap，
 * 在「已注册账号 + 匿名模式关闭」的服务器上是拿不到数据的（401）。
 *
 * 降级策略保留：
 * - 匿名模式（ALLOW_ANONYMOUS=1）→ 照旧用本地 ID bootstrap；
 * - 匿名模式关闭且未登录 → 不 bootstrap，返回 `synced=false`，
 *   由路由守卫把用户送去 /login，而不是让 App 白屏或报错。
 */

import { useCallback, useEffect, useState } from 'react';
import { ensureLocalUserId, setUserId, ApiError } from '@/api/client';
import { apiPost } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { localLocale, localTimezone } from '@/utils/time';
import type { BootstrapResponse } from '@/types/api';

export interface UseUserIdResult {
  userId: string;
  /** 是否已完成与服务端的一次同步 */
  synced: boolean;
  loading: boolean;
  /** 失败原因（人话），成功时为 null */
  error: string | null;
  /** 服务端返回的 bootstrap 数据（含默认角色） */
  bootstrap: BootstrapResponse | null;
  /** 当前是否已登录（语法糖，来自 useAuth） */
  authenticated: boolean;
  /** 手动重试 */
  retry: () => void;
}

export function useUserId(): UseUserIdResult {
  const { account, status, allowAnonymous } = useAuth();
  const [userId, setLocalUserId] = useState<string>(() => ensureLocalUserId());
  const [synced, setSynced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 已登录时以服务端的账号 ID 为准，并把 X-User-Id 同步过去
  useEffect(() => {
    const id = account?.user.id;
    if (!id) return;
    setUserId(id);
    setLocalUserId(id);
  }, [account?.user.id]);

  useEffect(() => {
    // 认证状态还没问清楚 → 什么都别做，等下一轮
    if (status === 'loading') return;

    // 未登录 + 服务器不允许匿名 → 明确告诉上层「没同步」，让守卫去跳登录页
    if (status !== 'authenticated' && !allowAnonymous) {
      setLoading(false);
      setSynced(false);
      setBootstrap(null);
      setError('請先登入');
      return;
    }

    let cancelled = false;

    const run = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        // 已登录时以服务端账号 ID 为准（不拿 localStorage 里的匿名 ID），
        // 否则「登录成功后 bootstrap 仍在用匿名身份」——数据隔离会走错人。
        const data = await apiPost<BootstrapResponse>('/api/users/bootstrap', {
          clientUserId: account?.user.id ?? ensureLocalUserId(),
          timezone: localTimezone(),
          locale: localLocale(),
        }, { silent: true });
        if (cancelled) return;
        if (data?.user?.id) {
          setUserId(data.user.id);
          setLocalUserId(data.user.id);
        }
        setBootstrap(data);
        setSynced(true);
      } catch (err) {
        if (cancelled) return;
        setSynced(false);
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : '無法連上伺服器',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [status, allowAnonymous, account?.user.id, attempt]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return {
    userId,
    synced,
    loading,
    error,
    bootstrap,
    authenticated: status === 'authenticated',
    retry,
  };
}

export default useUserId;
