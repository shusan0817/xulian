/**
 * 首页「纪念日」卡片（需求：在顶部增加纪念日卡片，显示「我们已经相识 X 天」）
 *
 * 展示：
 *  - 相识天数大字（来自 localStorage 的 meetDate，真实计算）
 *  - 今天是否命中里程碑（100 天 / 週年 / 自定义生日等）→ 小徽章
 *  - 最近的自定义纪念日倒计时
 * 点「設定」打开编辑弹窗（写入 localStorage）。
 *
 * 真正的「节日特效 + AI 专属问候」由首页在 milestone 命中时统一渲染（彩带 + 问候横幅），
 * 这里只负责常驻状态展示与数据维护。
 */

import { useState } from 'react';

import type { CharacterWithRuntime } from '@/hooks/useAppState';
import { useAnniversary } from '@/hooks/useAnniversary';
import { AnniversaryEditor } from '@/components/home/AnniversaryEditor';

interface AnniversaryCardProps {
  character: CharacterWithRuntime | null;
}

export function AnniversaryCard({ character }: AnniversaryCardProps): React.ReactElement {
  const { daysSinceMeet, upcoming, milestone, setMeetDate, upsertCustom, removeCustom, store } =
    useAnniversary(character?.name);
  const [editing, setEditing] = useState(false);

  return (
    <section className="rounded-3xl bg-gradient-to-br from-[var(--xl-blush)]/15 to-[var(--xl-blush-deep)]/10 p-4 shadow-[var(--xl-shadow)]">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--xl-ink)]">
          📅 紀念日
        </h3>
        <button
          onClick={() => setEditing(true)}
          className="rounded-full bg-[var(--xl-card)] px-2.5 py-0.5 text-[12px] text-[var(--xl-sub)] active:opacity-60"
        >
          設定
        </button>
      </div>

      {daysSinceMeet === null ? (
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--xl-sub)]">
          還沒記錄相識的日子。點「設定」記下你們的第一天，之後 TA 會陪你數著過。
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-[12px] text-[var(--xl-sub)]">我們已經相識</p>
          <p className="text-[30px] font-bold leading-tight text-[var(--xl-blush-deep)]">
            {daysSinceMeet}
            <span className="ml-1 text-[14px] font-normal text-[var(--xl-sub)]">天</span>
          </p>

          {milestone ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-[var(--xl-blush)] px-2.5 py-0.5 text-[11px] text-white">
              🎉 今天是 {milestone.label}
            </span>
          ) : null}

          {upcoming && !upcoming.isToday ? (
            <p className="mt-2 text-[12px] text-[var(--xl-sub)]">
              距離「{upcoming.label}」還有 <span className="font-medium text-[var(--xl-ink)]">{upcoming.days}</span> 天
            </p>
          ) : null}

          {upcoming && upcoming.isToday ? (
            <p className="mt-2 text-[12px] font-medium text-[var(--xl-blush-deep)]">
              🎉 今天是「{upcoming.label}」
            </p>
          ) : null}
        </>
      )}

      <AnniversaryEditor
        open={editing}
        meetDate={store.meetDate}
        custom={store.custom}
        onClose={() => setEditing(false)}
        onSetMeet={setMeetDate}
        onUpsert={upsertCustom}
        onRemove={removeCustom}
      />
    </section>
  );
}

export default AnniversaryCard;
