/**
 * 首頁「最近記憶」區塊（需求 §3 首頁結構 / §9 記憶實驗室入口）
 *
 * 顯示當前 AI 最近記住的几條內容（來自真實接口 /api/memories），
 * 讓用戶一眼感到「TA 真的在記得我」。點擊「全部」進入記憶頁。
 * 無角色 / 無記憶時整體不渲染（條件區塊，保持首頁整潔）。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAppState } from '@/hooks/useAppState';
import { useRecentMemories } from '@/hooks/useRecentMemories';
import { formatRelativeTime } from '@/utils/time';

export function RecentMemoriesSection(): React.ReactElement | null {
  const navigate = useNavigate();
  const { defaultCharacterId, characters } = useAppState();
  const character = useMemo(
    () => characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null,
    [characters, defaultCharacterId],
  );

  const { memories, loading } = useRecentMemories(character?.id ?? null, 10);

  if (!character) return null;

  const recent = memories.slice(0, 3);

  // 首次加載且尚無內容：骨架占位
  if (loading && recent.length === 0) {
    return (
      <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">最近記憶</h3>
        </div>
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-[52px] animate-pulse rounded-2xl bg-[var(--xl-mist)]/60" />
          ))}
        </div>
      </section>
    );
  }

  // 沒有記憶：不渲染本區塊（避免堆砌空卡片）
  if (recent.length === 0) return null;

  return (
    <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">最近記憶</h3>
        <button
          onClick={() => navigate('/memories')}
          className="text-[12px] text-[var(--xl-sub)] active:opacity-60"
        >
          全部
        </button>
      </div>
      <div className="space-y-2">
        {recent.map((m) => (
          <div key={m.id} className="rounded-2xl bg-[var(--xl-mist)]/60 px-3 py-2.5">
            <p className="line-clamp-2 text-[13px] leading-relaxed text-[var(--xl-ink)]">{m.content}</p>
            <p className="mt-1 text-[10px] text-[var(--xl-sub)]">
              {m.createdAt ? formatRelativeTime(m.createdAt) : ''}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default RecentMemoriesSection;
