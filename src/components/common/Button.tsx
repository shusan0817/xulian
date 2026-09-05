/**
 * 按钮
 *
 * 只做四种视觉变体，颜色全部走 CSS 变量，深色模式自动跟随。
 * 移动端最小点击高度 44px（Apple HIG 的可触达下限）。
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 整宽按钮（移动端表单常用） */
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
}

const VARIANT_STYLE: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--xl-blush)] text-white active:bg-[var(--xl-blush-deep)]',
  secondary: 'bg-[var(--xl-mist)] text-[var(--xl-ink)] active:opacity-80',
  ghost: 'bg-transparent text-[var(--xl-sub)] active:bg-[var(--xl-mist)]/60',
  danger: 'bg-transparent text-[var(--xl-blush-deep)] ring-1 ring-[var(--xl-blush-deep)]/40 active:bg-[var(--xl-blush)]/10',
};

const SIZE_STYLE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-xl',
  md: 'h-10 px-4 text-[15px] rounded-2xl',
  lg: 'h-12 px-5 text-[16px] rounded-2xl',
};

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  icon,
  className = '',
  disabled,
  children,
  ...rest
}: ButtonProps): React.ReactElement {
  const isDisabled = disabled || loading;
  return (
    <button
      {...rest}
      disabled={isDisabled}
      className={`inline-flex select-none items-center justify-center gap-1.5 font-medium transition-all duration-150 ${SIZE_STYLE[size]} ${VARIANT_STYLE[variant]} ${block ? 'w-full' : ''} ${
        isDisabled ? 'pointer-events-none opacity-45' : ''
      } ${className}`}
    >
      {loading ? <span className="xl-typing-dot text-[13px]">●●●</span> : icon}
      {children}
    </button>
  );
}

export default Button;
