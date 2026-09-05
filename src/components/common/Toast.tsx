/**
 * 全局轻提示
 *
 * 用一个极简的发布订阅 store，任何地方 `toast.show(...)` 即可，
 * 不需要在组件树里挂 Context Provider。
 */

import { useEffect, useState } from 'react';
import type { ToastItem } from '@/types/ui';
import { shortId } from '@/utils/id';

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(items);
}

function push(message: string, tone: ToastItem['tone'] = 'info', duration = 2200): string {
  const item: ToastItem = { id: shortId(), message, tone, duration };
  items = [...items, item];
  emit();
  if (duration > 0) {
    setTimeout(() => dismiss(item.id), duration);
  }
  return item.id;
}

function dismiss(id: string): void {
  items = items.filter((item) => item.id !== id);
  emit();
}

export const toast = {
  info: (message: string, duration?: number): string => push(message, 'info', duration),
  success: (message: string, duration?: number): string => push(message, 'success', duration),
  error: (message: string, duration?: number): string => push(message, 'error', duration ?? 3200),
  dismiss,
};

const TONE_STYLE: Record<ToastItem['tone'], string> = {
  info: 'bg-[var(--xl-ink)]/90 text-white',
  success: 'bg-[var(--xl-mint)] text-white',
  error: 'bg-[var(--xl-blush-deep)] text-white',
};

/** 挂在 App 根部的提示容器 */
export function ToastHost(): React.ReactElement | null {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    const listener: Listener = (next) => setList([...next]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex flex-col items-center gap-2 px-4 xl-safe-top">
      <div className="h-[calc(env(safe-area-inset-top,0px)+8px)]" />
      {list.map((item) => (
        <div
          key={item.id}
          className={`xl-pop-in pointer-events-auto w-full max-w-[420px] rounded-2xl px-4 py-2.5 text-center text-[13px] leading-5 shadow-card ${TONE_STYLE[item.tone]}`}
          onClick={() => dismiss(item.id)}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}

export default ToastHost;
