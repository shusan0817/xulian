/**
 * AI 成長展示（需求 A：成長軌跡）
 *
 * 只读展示一个角色的成长概览：统计 tiles、关系阶段与默契度进度条、
 * 成長里程碑列表（初次相遇 + 一起的节点故事），并引导到記憶實驗室。
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAppState } from '@/hooks/useAppState';
import { useGrowth } from '@/hooks/useGrowth';
import { apiGet, humanizeError } from '@/api/client';
import { STAGE_META, type StageMeta } from '@shared/constants';
import type { Story } from '@shared/types';
import { formatRelativeTime } from '@/utils/time';

interface MilestoneStoriesResponse {
  items: Story[];
  total: number;
}

export function GrowthPage(): React.ReactElement {
  const [params] = useSearchParams();
  const { defaultCharacterId } = useAppState();
  const characterId = params.get('c') || defaultCharacterId || '';

  const { growth, loading, error } = useGrowth(characterId);

  const [milestones, setMilestones] = useState<Story[]>([]);
  const [milestoneLoading, setMilestoneLoading] = useState(false);

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setMilestoneLoading(true);
    apiGet<MilestoneStoriesResponse>(
      '/api/stories',
      { characterId, type: 'shared_milestone', limit: 20 },
      { silent: true },
    )
      .then((r) => {
        if (!cancelled) setMilestones(r.items ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setMilestones([]);
        void humanizeError(e);
      })
      .finally(() => {
        if (!cancelled) setMilestoneLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  if (!characterId) {
    return (
      <>
        <AppHeader title="成長軌跡" showBack={false} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 xl-no-scrollbar">
          <EmptyState icon="🌱" title="還沒有陪伴角色" description="先建立一個 AI 角色，開始你們的成長旅程吧。" />
        </div>
      </>
    );
  }

  const stageMeta = growth ? (STAGE_META as Record<string, StageMeta>)[growth.stage] : undefined;
  const stageLabel = stageMeta?.label ?? growth?.stage ?? '—';
  const rapportPct = growth ? Math.round(growth.interactionLevelPct) : 0;

  const tiles = growth
    ? [
        { key: 'memories', label: '記憶', value: growth.memories },
        { key: 'stories', label: '故事', value: growth.stories },
        { key: 'milestones', label: '里程碑', value: growth.milestones },
        { key: 'habits', label: '交流習慣', value: growth.habits },
        { key: 'insights', label: '你的偏好', value: growth.insights },
        { key: 'activeDays', label: '在一起', value: growth.activeDays, unit: '天' },
        { key: 'totalMessages', label: '累積訊息', value: growth.totalMessages },
        { key: 'rapport', label: '默契', value: rapportPct, unit: '%' },
      ]
    : [];

  return (
    <>
      <AppHeader title="成長軌跡" showBack={false} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {loading && !growth ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : error ? (
          <EmptyState icon="⚠️" title="載入失敗" description={error} />
        ) : (
          <div className="space-y-4">
            {/* 关系阶段 + 默契度进度条 */}
            <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[var(--xl-sub)]">關係階段</span>
                <span className="rounded-full bg-[var(--xl-mist)] px-2.5 py-0.5 text-[12px] font-medium text-[var(--xl-ink)]">
                  {stageLabel}
                </span>
              </div>
              <div className="mt-3">
                <div className="flex items-center justify-between text-[12px] text-[var(--xl-sub)]">
                  <span>默契度</span>
                  <span>{rapportPct}%</span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[var(--xl-mist)]">
                  <div
                    className="h-full rounded-full bg-[var(--xl-blush)] transition-all"
                    style={{ width: `${rapportPct}%` }}
                  />
                </div>
              </div>
            </section>

            {/* 统计网格 */}
            <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {tiles.map((t) => (
                <div
                  key={t.key}
                  className="rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]"
                >
                  <p className="text-[11px] text-[var(--xl-sub)]">{t.label}</p>
                  <p className="mt-1 text-[20px] font-semibold text-[var(--xl-ink)]">
                    {t.value}
                    {t.unit ? (
                      <span className="ml-0.5 text-[12px] font-normal text-[var(--xl-sub)]">{t.unit}</span>
                    ) : null}
                  </p>
                </div>
              ))}
            </section>

            {/* 成長里程碑 */}
            <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
              <h2 className="text-[13px] font-medium text-[var(--xl-ink)]">成長里程碑</h2>
              <div className="mt-3 space-y-2">
                {growth?.firstChatAt ? (
                  <div className="flex items-center justify-between rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2">
                    <span className="text-[13px] text-[var(--xl-ink)]">初次相遇</span>
                    <span className="text-[11px] text-[var(--xl-sub)]">
                      {formatRelativeTime(growth.firstChatAt)}
                    </span>
                  </div>
                ) : null}

                {milestoneLoading ? (
                  <div className="py-4 text-center text-[12px] text-[var(--xl-sub)]">載入中…</div>
                ) : milestones.length === 0 ? (
                  <p className="py-2 text-center text-[12px] text-[var(--xl-sub)]">還沒有一起的節點</p>
                ) : (
                  milestones.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--xl-ink)]">{m.title}</span>
                      <span className="ml-2 flex-none text-[11px] text-[var(--xl-sub)]">
                        {m.happenedAt ? formatRelativeTime(m.happenedAt) : ''}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* 前往記憶實驗室 */}
            <Link
              to={`/memory-lab?c=${encodeURIComponent(characterId)}`}
              className="block rounded-2xl bg-[var(--xl-blush)] px-4 py-3 text-center text-[14px] font-medium text-white active:scale-95"
            >
              查看記憶實驗室 →
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

export default GrowthPage;
