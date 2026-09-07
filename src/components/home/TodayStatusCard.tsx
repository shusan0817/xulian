/**
 * 首页「AI 今日狀態」卡片（需求 #1）
 *
 * 全部由 character.runtime 真实字段派生，不调用 LLM、不编造内容：
 *  - 情绪 → runtime.emotion.currentEmotion（EMOTION_ANCHORS 取展示信息）
 *  - 关系阶段 → runtime.relationship.stage（STAGE_META 取中文名）
 *  - 最后聊天时间 → runtime.lastMessageAt（算出"剛剛 / N 小時前 / N 天前"）
 *  - 默契% → runtime.relationship.interactionLevel * 100
 */

import { useMemo } from 'react';

import type { CharacterWithRuntime } from '@/hooks/useAppState';
import { EMOTION_ANCHORS, STAGE_META } from '@shared/constants';

interface TodayStatusCardProps {
  character: CharacterWithRuntime;
}

export function TodayStatusCard({ character }: TodayStatusCardProps): React.ReactElement {
  const view = useMemo(() => {
    const runtime = character.runtime;
    const emotion =
      EMOTION_ANCHORS[runtime.emotion.currentEmotion] ?? EMOTION_ANCHORS.calm;
    const stage = STAGE_META[runtime.relationship.stage];
    const levelPct = Math.round(runtime.relationship.interactionLevel * 100);

    const last = runtime.lastMessageAt;
    let statusLine: string;
    if (!last) {
      statusLine = '還沒有聊過，先打聲招呼吧';
    } else {
      const hours = (Date.now() - new Date(last).getTime()) / 3_600_000;
      if (hours < 1) statusLine = '剛剛才聊過';
      else if (hours < 24) statusLine = `${Math.floor(hours)} 小時前聊過`;
      else statusLine = `${Math.floor(hours / 24)} 天前聊過`;
    }

    return { emotion, stage, levelPct, statusLine };
  }, [character]);

  return (
    <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">今日狀態</h3>
        <span className="rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
          {view.emotion.icon} {view.emotion.label}
        </span>
      </div>

      <p className="text-[13px] leading-relaxed text-[var(--xl-ink)]">{view.statusLine}</p>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-[var(--xl-sub)]">
          現在是「{view.stage?.label ?? '初識'}」的關係
        </span>
        <span className="flex items-center gap-1 text-[12px] text-[var(--xl-sub)]">
          默契
          <span className="text-[15px] font-semibold text-[var(--xl-blush-deep)]">
            {view.levelPct}%
          </span>
        </span>
      </div>
    </section>
  );
}

export default TodayStatusCard;
