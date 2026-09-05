/**
 * 路由守卫（V2 · T02）
 *
 * 规则只有一条：**服务端说要登录才拦**。
 *
 * `ALLOW_ANONYMOUS=1`（开发默认）时放行匿名用户，
 * 这样老用户打开 App 仍然能直接聊天，不会被登录页挡在门外；
 * `ALLOW_ANONYMOUS=0`（生产默认）时未登录一律跳 `/login`。
 *
 * 注意：鉴权的真正边界在服务端 `resolveUser`，
 * 这个组件只是**省掉一次白屏**，不是安全机制。
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { Loading } from '@/components/common/Loading';
import { useAuth } from '@/hooks/useAuth';

export interface ProtectedRouteProps {
  children: ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps): React.ReactElement {
  const location = useLocation();
  const { status, allowAnonymous } = useAuth();

  // 还在问服务器「我登录了吗」→ 先转圈，不要闪一下登录页再跳回来
  if (status === 'loading') {
    return <Loading label="檢查登入狀態…" className="py-16" />;
  }

  if (status === 'authenticated') return <>{children}</>;

  // 匿名模式：服务器明确说了可以不登录
  if (allowAnonymous) return <>{children}</>;

  // 跳登录页时带上来源，登录完成后能回得去
  return <Navigate to="/login" replace state={{ from: location.pathname }} />;
}

export default ProtectedRoute;
