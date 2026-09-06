/**
 * 消息气泡（需求 §15）
 *
 * 支持：AI/用户双头像、消息时间、流式光标、失败态、长按菜单（删除 / 重新生成 / 复制）。
 *
 * 长按用 500ms 计时器实现（移动端没有 contextmenu 的长按语义），
 * 手指移动超过 10px 就取消——避免滚动列表时误触发。
 */

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/common/Avatar';
import type { AvatarSpec } from '@shared/types';
import type { ChatMessage } from '@/hooks/useChat';
import { formatClock } from '@/utils/time';
import { STRATEGY_USER_LABELS } from './strategyLabels';

export interface MessageBubbleProps {
  message: ChatMessage;
  aiAvatar: AvatarSpec | null;
  aiName: string;
  userAvatar?: AvatarSpec | null;
  onDelete?: (id: string) => void;
  onRegenerate?: (id: string) => void;
  /** 是否显示本轮策略标签（调试模式或最近一条） */
  showStrategy?: boolean;
}

export function MessageBubble({
  message,
  aiAvatar,
  aiName,
  userAvatar,
  onDelete,
  onRegenerate,
  showStrategy,
}: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const [menuOpen, setMenuOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const startPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onTouchStart = (e: React.TouchEvent): void => {
    const touch = e.touches[0];
    startPos.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = window.setTimeout(() => setMenuOpen(true), 500);
  };

  const onTouchMove = (e: React.TouchEvent): void => {
    const touch = e.touches[0];
    const moved =
      Math.abs(touch.clientX - startPos.current.x) > 10 ||
      Math.abs(touch.clientY - startPos.current.y) > 10;
    if (moved && timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onTouchEnd = (): void => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const failed = Boolean(message.errorCode);

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className="flex-none pt-1">
        <Avatar
          spec={isUser ? (userAvatar ?? null) : aiAvatar}
          name={isUser ? '我' : aiName}
          size={32}
          ring={!isUser}
        />
      </div>

      <div className={`flex min-w-0 max-w-[78%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        {showStrategy && !isUser && message.strategy ? (
          <span className="mb-1 rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
            {STRATEGY_USER_LABELS[message.strategy] ?? message.strategy}
          </span>
        ) : null}

        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
          className={[
            'relative select-none whitespace-pre-wrap break-words px-3.5 py-2.5 text-[15px] leading-relaxed',
            isUser
              ? 'rounded-2xl rounded-tr-md bg-[var(--xl-user-bubble)] text-[var(--xl-user-bubble-ink)]'
              : 'rounded-2xl rounded-tl-md bg-[var(--xl-ai-bubble)] text-[var(--xl-ai-bubble-ink)]',
            'shadow-[var(--xl-shadow)]',
            message.pending ? 'opacity-60' : '',
            failed ? 'border border-[var(--xl-blush-deep)]/40' : '',
          ].join(' ')}
        >
          {failed ? (
            <span className="text-[var(--xl-blush-deep)]">這則回應沒有送出成功</span>
          ) : message.streaming ? (
            <span className="flex items-center gap-1 py-0.5">
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
            </span>
          ) : message.content ? (
            message.content
          ) : (
            <span className="text-[var(--xl-sub)]">（空白訊息）</span>
          )}

          {menuOpen ? (
            <BubbleMenu
              isUser={isUser}
              onClose={() => setMenuOpen(false)}
              onDelete={() => onDelete?.(message.id)}
              onRegenerate={isUser ? undefined : () => onRegenerate?.(message.id)}
              content={message.content}
            />
          ) : null}
        </div>

        <span className="mt-1 px-1 text-[10px] text-[var(--xl-sub)]/70">
          {formatClock(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

/** 正在输入的三点动画 */
function Dot({ delay }: { delay: number }): React.ReactElement {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--xl-sub)]"
      style={{ animation: `xl-bounce 1.2s ${delay}ms infinite ease-in-out` }}
    />
  );
}

interface BubbleMenuProps {
  isUser: boolean;
  onClose: () => void;
  onDelete: () => void;
  onRegenerate?: () => void;
  content: string;
}

function BubbleMenu({
  isUser,
  onClose,
  onDelete,
  onRegenerate,
  content,
}: BubbleMenuProps): React.ReactElement {
  const itemClass =
    'w-full px-3 py-2 text-left text-[13px] text-[var(--xl-ink)] active:bg-[var(--xl-mist)]';

  const run = (fn: () => void) => (): void => {
    onClose();
    fn();
  };

  return (
    <>
      {/* 点击遮罩关闭 */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute bottom-full z-50 mb-1 w-32 overflow-hidden rounded-xl bg-[var(--xl-card)] shadow-lg ring-1 ring-[var(--xl-mist)]">
        <button
          className={itemClass}
          onClick={run(() => void navigator.clipboard?.writeText(content))}
        >
          複製
        </button>
        {!isUser && onRegenerate ? (
          <button className={itemClass} onClick={run(onRegenerate)}>
            重新生成
          </button>
        ) : null}
        <button
          className={`${itemClass} text-[var(--xl-blush-deep)]`}
          onClick={run(onDelete)}
        >
          刪除
        </button>
      </div>
    </>
  );
}
