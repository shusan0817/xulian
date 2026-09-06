import { useEffect, useRef, useState } from 'react';
import { useFavorability } from '@/store/favorabilityStore';
import type { AtmosphereEmotion } from '@/store/favorabilityStore';

const EMOTION_META: Record<AtmosphereEmotion, { label: string; icon: string }> = {
  sweet: { label: '甜美心动', icon: '💗' },
  warm: { label: '温暖日常', icon: '🌤️' },
  sad: { label: '低落自责', icon: '🌧️' },
  angry: { label: '吃醋生闷', icon: '💢' },
  normal: { label: '平淡如常', icon: '🌫️' },
};

export function FavorabilityCard(): React.ReactElement {
  const { favorability, atmosphere, pulse } = useFavorability();
  const [pulsing, setPulsing] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPulsing(true);
    const t = window.setTimeout(() => setPulsing(false), 400);
    return () => window.clearTimeout(t);
  }, [pulse]);

  const meta = EMOTION_META[atmosphere];

  return (
    <div className="flex-none px-3 pt-2 pb-1">
      <div className="flex items-center gap-3 rounded-2xl bg-[var(--xl-card)]/80 px-3 py-2 shadow-[var(--xl-shadow)] ring-1 ring-[var(--xl-mist)]">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-full bg-[var(--xl-mist)] text-[18px] transition-transform duration-300 ${
            pulsing ? 'scale-125' : 'scale-100'
          }`}
        >
          {meta.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-[var(--xl-sub)]">心动值</span>
            <span
              className={`text-[13px] font-semibold tabular-nums transition-colors duration-300 ${
                pulsing ? 'text-[var(--xl-blush-deep)]' : 'text-[var(--xl-ink)]'
              }`}
            >
              {favorability}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--xl-mist)]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[var(--xl-blush)] to-[var(--xl-blush-deep)] transition-[width] duration-300 ease-out"
              style={{ width: `${favorability}%` }}
            />
          </div>
        </div>
        <span className="flex-none text-[11px] text-[var(--xl-sub)]">{meta.label}</span>
      </div>
    </div>
  );
}

export default FavorabilityCard;
