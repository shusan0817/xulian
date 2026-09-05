/**
 * 聊天输入区（需求 §15）
 *
 * 细节：
 * - textarea 高度随内容自适应（最多 5 行），超过才滚动；
 * - 生成中显示「停止」而不是「送出」，避免用户以为卡住；
 * - Enter 发送 / Shift+Enter 换行（桌面浏览器调试时更好用）；
 * - 输入框字号 16px 起步——小于 16px 时 iOS Safari 聚焦会自动放大页面。
 */

import { useEffect, useRef, useState } from 'react';

export interface ChatComposerProps {
  disabled?: boolean;
  generating?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onStop?: () => void;
}

const MAX_LINES = 5;
const LINE_HEIGHT = 22;

export function ChatComposer({
  disabled,
  generating,
  placeholder = '說點什麼…',
  onSend,
  onStop,
}: ChatComposerProps): React.ReactElement {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // 高度自适应
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = MAX_LINES * LINE_HEIGHT;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  const submit = (): void => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="flex-none border-t border-[var(--xl-mist)] bg-[var(--xl-card)] px-3 py-2.5 xl-safe-bottom">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法组合中不拦截回车
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-[110px] min-h-[40px] flex-1 resize-none rounded-2xl bg-[var(--xl-mist)]/70 px-3.5 py-2.5 text-[16px] leading-[22px] text-[var(--xl-ink)] outline-none placeholder:text-[var(--xl-sub)]/60 disabled:opacity-50"
        />

        {generating ? (
          <button
            onClick={onStop}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[var(--xl-mist)] text-[13px] text-[var(--xl-sub)] active:scale-95"
            aria-label="停止生成"
          >
            ■
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[var(--xl-blush)] text-white transition-all active:scale-95 disabled:opacity-30"
            aria-label="送出"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 12h13M12 5l7 7-7 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
