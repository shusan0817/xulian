/**
 * 首页「未完待續」区块（需求：你之前留下沒說完的話）
 *
 * 展示当前角色下用户尚未聊完的话题，可「繼續」续聊或「✕」关闭。
 * 无角色 / 无 open 话题时整体不渲染（条件区块）。
 * 样式对齐 HomePage 现有卡片：rounded-3xl 卡片 + rounded-2xl 内条目 + 变量色板。
 */

import { useMemo, type MouseEvent } from 'react';
import { Clock, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAppState } from '@/hooks/useAppState';
import { useUnfinished, type UnfinishedTopic } from '@/hooks/useUnfinished';

export function UnfinishedSection(): React.ReactElement | null {
  const navigate = useNavigate();
  const { defaultCharacterId, characters } = useAppState();

  const character = useMemo(
    () => characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null,
    [characters, defaultCharacterId],
  );

  const { items, loading, dismiss, resolve } = useUnfinished(character?.id ?? null);

  // 无角色：什么都不渲染
  if (!character) return null;

  // 首次加载且还没有内容：展示骨架占位（1–2 张）
  if (loading && items.length === 0) {
    return (
      <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">未完待續</h3>
          <span className="text-[11px] text-[var(--xl-sub)]">你之前留下沒說完的話</span>
        </div>
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-2xl bg-[var(--xl-mist)]/60 px-3 py-2.5"
            />
          ))}
        </div>
      </section>
    );
  }

  // 没有 open 话题：不渲染本区块
  if (items.length === 0) return null;

  const onResume = (topic: UnfinishedTopic): void => {
    // 标记 resolved（fire-and-forget），再带话题跳转到聊天页续聊
    resolve(topic);
    navigate('/chat?c=' + character.id + '&topic=' + encodeURIComponent(topic.topic));
  };

  const onDismiss = (e: MouseEvent, id: string): void => {
    // 阻止冒泡，避免触发卡片的「繼續」
    e.stopPropagation();
    void dismiss(id);
  };

  return (
    <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">未完待續</h3>
        <span className="text-[11px] text-[var(--xl-sub)]">你之前留下沒說完的話</span>
        {items.length > 0 ? (
          <span className="rounded-full bg-[var(--xl-blush)] px-1.5 text-[10px] text-white">
            {items.length}
          </span>
        ) : null}
        <button
          onClick={() => navigate('/unfinished')}
          className="ml-auto text-[12px] text-[var(--xl-sub)] active:opacity-60"
        >
          查看全部
        </button>
      </div>

      <div className="space-y-2">
        {items.map((topic) => (
          <div
            key={topic.id}
            onClick={() => onResume(topic)}
            className="relative cursor-pointer rounded-2xl bg-[var(--xl-mist)]/60 px-3 py-2.5 pr-7 active:opacity-70"
          >
            <button
              type="button"
              aria-label="關閉"
              onClick={(e) => onDismiss(e, topic.id)}
              className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[var(--xl-sub)] active:scale-90 active:opacity-60"
            >
              <X size={12} strokeWidth={2.5} />
            </button>

            <p className="line-clamp-1 pr-4 text-[13px] font-semibold text-[var(--xl-ink)]">
              {topic.topic}
            </p>
            <p className="mt-0.5 line-clamp-1 text-[11px] text-[var(--xl-sub)]">
              {topic.resumeHint}
            </p>

            <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--xl-blush)]">
              <Clock size={11} />
              繼續
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default UnfinishedSection;
