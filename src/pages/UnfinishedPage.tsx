/**
 * 未完待續（獨立模組，需求 §12）
 *
 * 把首頁裡的「未完待續」區塊提升為一個完整頁面：列出 AI 從聊天中識別出的
 * 未完成話題，點擊即帶著話題跳轉到對應聊天上下文續聊。與主動消息系統連動
 * （話題來自同一個 unfinished_topics 表）。數據全部來自真實接口。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, X } from 'lucide-react';

import { AppHeader } from '@/components/common/AppHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAppState } from '@/hooks/useAppState';
import { useUnfinished, type UnfinishedTopic } from '@/hooks/useUnfinished';

export function UnfinishedPage(): React.ReactElement {
  const navigate = useNavigate();
  const { defaultCharacterId, characters, loading: appLoading } = useAppState();
  const character = useMemo(
    () => characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null,
    [characters, defaultCharacterId],
  );
  const { items, loading, dismiss, resolve } = useUnfinished(character?.id ?? null);

  const onResume = (topic: UnfinishedTopic): void => {
    if (!character) return;
    resolve(topic);
    navigate('/chat?c=' + character.id + '&topic=' + encodeURIComponent(topic.topic));
  };

  const onDismiss = (e: React.MouseEvent, id: string): void => {
    e.stopPropagation();
    void dismiss(id);
  };

  return (
    <>
      <AppHeader
        title="未完待續"
        subtitle="你們還沒聊完的話題"
        showBack
        onBack={() => navigate(-1)}
      />

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {appLoading ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : !character ? (
          <div className="py-10">
            <EmptyState
              icon="🌱"
              title="還沒有角色"
              description="建立一個屬於你的 AI 陪伴角色，之後這裡會出現你們沒聊完的話題。"
              action={
                <button
                  onClick={() => navigate('/characters/new')}
                  className="rounded-full bg-[var(--xl-blush)] px-5 py-2 text-[14px] text-white active:scale-95"
                >
                  建立角色
                </button>
              }
            />
          </div>
        ) : loading && items.length === 0 ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-[68px] animate-pulse rounded-2xl bg-[var(--xl-mist)]/60" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="py-10">
            <EmptyState
              icon="💬"
              title="沒有未完的話題"
              description="你們聊過的話題都圓滿結束了，或還沒開始。想起什麼，就去找 TA 聊聊吧。"
            />
          </div>
        ) : (
          items.map((topic) => (
            <div
              key={topic.id}
              onClick={() => onResume(topic)}
              className="relative cursor-pointer rounded-2xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)] pr-9 active:opacity-70"
            >
              <button
                type="button"
                aria-label="關閉"
                onClick={(e) => onDismiss(e, topic.id)}
                className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-[var(--xl-sub)] active:scale-90 active:opacity-60"
              >
                <X size={14} strokeWidth={2.5} />
              </button>

              <p className="text-[14px] font-semibold text-[var(--xl-ink)]">{topic.topic}</p>
              {topic.resumeHint ? (
                <p className="mt-1 text-[12px] leading-snug text-[var(--xl-sub)]">{topic.resumeHint}</p>
              ) : null}

              <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--xl-blush)]">
                <Clock size={12} />
                繼續聊天
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

export default UnfinishedPage;
