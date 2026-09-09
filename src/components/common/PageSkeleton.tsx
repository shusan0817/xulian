/**
 * 页面级骨架屏（路由懒加载 / 首屏数据未就绪时的占位）
 * 保持与 App 手机外壳一致的视觉，纯 CSS 脉冲，无额外网络请求。
 */
import type { ReactNode } from 'react';

export function PageSkeleton({ label }: { label?: string }): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="h-10 w-10 animate-pulse rounded-full bg-[var(--xl-mist)]/70" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-[var(--xl-mist)]/70" />
          <div className="h-2 w-32 animate-pulse rounded bg-[var(--xl-mist)]/50" />
        </div>
      </div>
      <div className="flex-1 space-y-3 px-4 py-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-3xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]"
          />
        ))}
      </div>
      {label ? (
        <p className="pb-4 text-center text-[11px] text-[var(--xl-sub)]/70">{label}</p>
      ) : null}
    </div>
  );
}

export default PageSkeleton;
