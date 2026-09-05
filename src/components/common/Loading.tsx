/**
 * 加载指示
 *
 * 两个组件：
 * - `Loading`：整块区域的转圈；
 * - `TypingDots`：聊天页「AI 正在输入」的三点跳动。
 */

export interface LoadingProps {
  /** 提示文案，留空则不显示 */
  label?: string;
  className?: string;
}

export function Loading({ label = '載入中…', className = '' }: LoadingProps): React.ReactElement {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 py-8 ${className}`}>
      <div
        className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--xl-mist)] border-t-[var(--xl-blush)]"
        role="status"
        aria-label="loading"
      />
      {label ? <span className="text-[12px] text-[var(--xl-sub)]">{label}</span> : null}
    </div>
  );
}

/** AI 正在输入的三点（延迟错开做出波浪感） */
export function TypingDots({ className = '' }: { className?: string }): React.ReactElement {
  return (
    <div className={`flex items-center gap-1 ${className}`} aria-label="AI 正在輸入">
      <span className="xl-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--xl-blush)]" style={{ animationDelay: '0ms' }} />
      <span className="xl-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--xl-blush)]" style={{ animationDelay: '180ms' }} />
      <span className="xl-typing-dot h-1.5 w-1.5 rounded-full bg-[var(--xl-blush)]" style={{ animationDelay: '360ms' }} />
    </div>
  );
}

export default Loading;
