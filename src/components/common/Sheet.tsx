/**
 * 底部弹层（长按消息 / 更多操作用）
 *
 * 移动端原生观感：从底部滑出，圆角在上方，最后一项通常是危险操作（红色）。
 */

import type { SheetOption } from '@/types/ui';

export interface SheetProps {
  open: boolean;
  title?: string;
  options: SheetOption[];
  onSelect: (key: string) => void;
  onClose: () => void;
}

export function Sheet({ open, title, options, onSelect, onClose }: SheetProps): React.ReactElement | null {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40 xl-fade-up" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-[480px] pb-[env(safe-area-inset-bottom,0px)]">
        <div className="mx-2 mb-2 overflow-hidden rounded-3xl bg-[var(--xl-card)]">
          {title ? (
            <div className="border-b border-[var(--xl-mist)] px-4 py-2.5 text-center text-[12px] text-[var(--xl-sub)]">
              {title}
            </div>
          ) : null}
          {options.map((option) => (
            <button
              key={option.key}
              disabled={option.disabled}
              onClick={() => {
                onSelect(option.key);
                onClose();
              }}
              className={`block w-full px-4 py-3.5 text-center text-[16px] transition-colors active:bg-[var(--xl-mist)]/60 disabled:opacity-40 ${
                option.tone === 'danger' ? 'text-[var(--xl-blush-deep)]' : 'text-[var(--xl-ink)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="mx-2 mb-2 block w-[calc(100%-16px)] rounded-3xl bg-[var(--xl-card)] py-3.5 text-center text-[16px] font-medium text-[var(--xl-sub)] active:opacity-80"
        >
          取消
        </button>
      </div>
    </div>
  );
}

export default Sheet;
