/**
 * 居中弹窗
 *
 * 移动端要点：
 * - 打开时锁 body 滚动，关闭时恢复；
 * - 点击遮罩关闭；
 * - 最大宽度跟随手机外壳（480px），桌面预览时不会撑满整屏。
 */

import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title?: string;
  description?: string;
  children?: ReactNode;
  /** 底部按钮区 */
  footer?: ReactNode;
  onClose: () => void;
  /** 点击遮罩是否关闭（表单类弹窗建议关掉，防误触丢失输入） */
  closeOnMask?: boolean;
}

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  closeOnMask = true,
}: ModalProps): React.ReactElement | null {
  // 打开时锁定背景滚动；关闭/卸载时必须恢复，否则页面会永久卡住
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-5">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={closeOnMask ? onClose : undefined}
        aria-hidden
      />
      <div className="xl-pop-in relative w-full max-w-[420px] overflow-hidden rounded-3xl bg-[var(--xl-card)] p-5 shadow-sheet">
        {title ? (
          <h3 className="mb-1 text-[17px] font-semibold text-[var(--xl-ink)]">{title}</h3>
        ) : null}
        {description ? (
          <p className="mb-3 text-[13px] leading-5 text-[var(--xl-sub)]">{description}</p>
        ) : null}
        {children ? <div className="text-[14px] leading-6 text-[var(--xl-ink)]">{children}</div> : null}
        {footer ? <div className="mt-5 flex gap-2.5">{footer}</div> : null}
      </div>
    </div>
  );
}

export default Modal;
