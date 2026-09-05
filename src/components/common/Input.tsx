/**
 * 输入框 / 多行输入
 *
 * 移动端要点：
 * - 字号固定 16px，否则 iOS Safari 聚焦时会缩放整页；
 * - 圆角 20px、无重边框，跟整体温柔风格一致。
 */

import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const BASE =
  'w-full rounded-2xl bg-[var(--xl-mist)]/70 px-4 text-[16px] text-[var(--xl-ink)] ' +
  'placeholder:text-[var(--xl-sub)]/60 outline-none transition-all duration-150 ' +
  'focus:bg-[var(--xl-card)] focus:ring-2 focus:ring-[var(--xl-blush)]/45';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
}

export function Input({
  label,
  hint,
  error,
  className = '',
  ...rest
}: InputProps): React.ReactElement {
  return (
    <label className={`block ${className}`}>
      {label ? <span className="mb-1.5 block text-[13px] text-[var(--xl-sub)]">{label}</span> : null}
      <input
        {...rest}
        className={`${BASE} h-11 ${error ? 'ring-2 ring-[var(--xl-blush-deep)]/60' : ''}`}
      />
      {error ? (
        <span className="mt-1 block text-[12px] text-[var(--xl-blush-deep)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] text-[var(--xl-sub)]/80">{hint}</span>
      ) : null}
    </label>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
}

export function Textarea({
  label,
  hint,
  error,
  className = '',
  rows = 4,
  ...rest
}: TextareaProps): React.ReactElement {
  return (
    <label className={`block ${className}`}>
      {label ? <span className="mb-1.5 block text-[13px] text-[var(--xl-sub)]">{label}</span> : null}
      <textarea
        {...rest}
        rows={rows}
        className={`${BASE} resize-none py-3 leading-6 ${error ? 'ring-2 ring-[var(--xl-blush-deep)]/60' : ''}`}
      />
      {error ? (
        <span className="mt-1 block text-[12px] text-[var(--xl-blush-deep)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] text-[var(--xl-sub)]/80">{hint}</span>
      ) : null}
    </label>
  );
}
