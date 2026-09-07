/**
 * 首页「交流默契」卡片（需求 #3）
 *
 * 全部由 character.runtime.relationship 真实字段派生，不调用 LLM、不编造内容。
 * 刻意使用中性文案（默契 / 合拍），与聊天页 FavorabilityCard 的「心动值」区分开。
 *
 * 派生内容：
 *  - 默契%   → interactionLevel * 100
 *  - 四阶段时间线 → RELATIONSHIP_STAGES + STAGE_META，高亮当前阶段
 *  - 四个子分数进度条 → messageScore / activeDayScore / memoryScore / shareDepthScore（0..1）
 *  - 「查看成長」→ /growth?c=<id>（该路由由另一 worker 添加，此处仅做导航）
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import type { CharacterWithRuntime } from '@/hooks/useAppState';
import { RELATIONSHIP_STAGES, STAGE_META } from '@shared/constants';

interface RapportCardProps {
  character: CharacterWithRuntime;
}

/** 一个 0..1 子分数进度条 */
function ScoreBar({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.ReactElement {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-[var(--xl-sub)]">{label}</span>
        <span className="text-[11px] text-[var(--xl-sub)]">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--xl-mist)]/70">
        <div
          className="h-full rounded-full bg-[var(--xl-blush)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function RapportCard({ character }: RapportCardProps): React.ReactElement {
  const view = useMemo(() => {
    const rel = character.runtime.relationship;
    const levelPct = Math.round(rel.interactionLevel * 100);
    const currentStage = rel.stage;

    const stageTimeline = RELATIONSHIP_STAGES.map((stage) => ({
      stage,
      label: STAGE_META[stage].label,
      active: stage === currentStage,
      // 当前阶段之前的阶段视为已到达
      reached: RELATIONSHIP_STAGES.indexOf(stage) <= RELATIONSHIP_STAGES.indexOf(currentStage),
    }));

    return {
      levelPct,
      stageTimeline,
      scores: {
        message: rel.messageScore,
        activeDay: rel.activeDayScore,
        memory: rel.memoryScore,
        shareDepth: rel.shareDepthScore,
      },
    };
  }, [character]);

  return (
    <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
      <div className="flex items-end justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">我們的默契</h3>
        <span className="text-[11px] text-[var(--xl-sub)]">相處越久，越合拍</span>
      </div>

      {/* 大默契% + 进度条 */}
      <div className="mt-3 flex items-center gap-3">
        <span className="text-[34px] font-bold leading-none text-[var(--xl-blush-deep)]">
          {view.levelPct}%
        </span>
        <div className="flex-1">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--xl-mist)]/70">
            <div
              className="h-full rounded-full bg-[var(--xl-blush)]"
              style={{ width: `${view.levelPct}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-[var(--xl-sub)]">我們越聊越合拍</p>
        </div>
      </div>

      {/* 四阶段时间线 */}
      <div className="mt-4 flex items-center">
        {view.stageTimeline.map((s, i) => (
          <div key={s.stage} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1">
              <span
                className={[
                  'flex h-3 w-3 items-center justify-center rounded-full',
                  s.reached ? 'bg-[var(--xl-blush)]' : 'bg-[var(--xl-mist)]/70',
                ].join(' ')}
              />
              <span
                className={[
                  'text-[10px] whitespace-nowrap',
                  s.active
                    ? 'font-semibold text-[var(--xl-ink)]'
                    : 'text-[var(--xl-sub)]',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>
            {i < view.stageTimeline.length - 1 ? (
              <span
                className={[
                  'mx-1 mb-3 h-px flex-1',
                  s.reached ? 'bg-[var(--xl-blush)]' : 'bg-[var(--xl-mist)]/70',
                ].join(' ')}
              />
            ) : null}
          </div>
        ))}
      </div>

      {/* 四个子分数进度条 */}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <ScoreBar label="訊息" value={view.scores.message} />
        <ScoreBar label="活躍天數" value={view.scores.activeDay} />
        <ScoreBar label="記憶" value={view.scores.memory} />
        <ScoreBar label="分享深度" value={view.scores.shareDepth} />
      </div>

      <Link
        to={`/growth?c=${character.id}`}
        className="mt-4 flex w-full items-center justify-center rounded-full bg-[var(--xl-blush)] px-4 py-2 text-[13px] text-white active:scale-[0.99]"
      >
        查看成長
      </Link>
    </section>
  );
}

export default RapportCard;
