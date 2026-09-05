/**
 * 空状态
 *
 * 需求 §15 要求聊天页有空状态页；这里做成通用件，
 * 首页/角色页/记忆页复用同一套视觉语言。
 */

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** emoji 或简短符号 */
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon = '🌷',
  title,
  description,
  action,
  className = '',
}: EmptyStateProps): React.ReactElement {
  return (
    <div className={`flex flex-col items-center justify-center px-8 py-12 text-center ${className}`}>
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--xl-mist)]/70 text-[28px]">
        {icon}
      </div>
      <p className="text-[15px] font-medium text-[var(--xl-ink)]">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-[280px] text-[13px] leading-5 text-[var(--xl-sub)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
