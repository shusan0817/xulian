/**
 * 顶部标题栏
 *
 * 三种形态：
 * - 带返回按钮（子页面）；
 * - 带右侧操作区（管理页）；
 * - 纯标题（Tab 页）。
 */

import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

export interface AppHeaderProps {
  title: string;
  /** 显示返回按钮（默认 true；Tab 页传 false） */
  showBack?: boolean;
  /** 自定义返回行为（不传则 history.back） */
  onBack?: () => void;
  /** 右侧操作区 */
  right?: ReactNode;
  /** 标题下方的副标题 */
  subtitle?: string;
}

export function AppHeader({
  title,
  showBack = true,
  onBack,
  right,
  subtitle,
}: AppHeaderProps): React.ReactElement {
  const navigate = useNavigate();

  return (
    <header
      className="flex-none border-b border-[var(--xl-mist)] bg-[var(--xl-card)]/95 backdrop-blur xl-safe-top"
      style={{ paddingLeft: 'var(--xl-safe-left)', paddingRight: 'var(--xl-safe-right)' }}
    >
      <div className="relative flex h-12 items-center px-2">
        {showBack ? (
          <button
            onClick={() => (onBack ? onBack() : navigate(-1))}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-full text-[var(--xl-ink)] active:bg-[var(--xl-mist)]/60"
            aria-label="返回"
          >
            <ChevronLeft size={22} />
          </button>
        ) : (
          <span className="w-10" />
        )}

        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-[16px] font-semibold text-[var(--xl-ink)]">{title}</h1>
          {subtitle ? (
            <p className="truncate text-[11px] text-[var(--xl-sub)]">{subtitle}</p>
          ) : null}
        </div>

        <div className="flex min-w-10 items-center justify-end">{right}</div>
      </div>
    </header>
  );
}

export default AppHeader;
