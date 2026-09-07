/**
 * 纪念日状态（需求：纪念日系统）
 *
 * 数据全部存 localStorage（spec 明确要求），不依赖后端：
 *  - meetDate：相识日期（YYYY-MM-DD），用来计算「我们已经相识 X 天」
 *  - custom：用户自定义纪念日（生日 / 在一起 / 任何想记住的日子）
 *
 * 派生：
 *  - daysSinceMeet：相识天数（null 表示未设定）
 *  - upcoming：最近的下一个自定义纪念日（含倒计时）
 *  - milestone：今天是否命中某个纪念日（相识里程碑 或 自定义命中），含 AI 专属问候文案
 *
 * 命名说明：卡片与首页各持有一份独立实例（都读同一份 LS），本 hook 不跨组件共享。
 */

import { useCallback, useMemo, useState } from 'react';
import { isSameDay } from '@/utils/time';
import { getCustomMilestone, getMeetMilestone } from '@/lib/anniversaries';

const LS_KEY = 'xulian.anniversary.v1';
const DAY = 86_400_000;

export interface CustomAnniversary {
  id: string;
  label: string;
  /** YYYY-MM-DD */
  date: string;
  repeat: 'yearly' | 'once';
}

export interface AnniversaryStore {
  meetDate: string | null;
  custom: CustomAnniversary[];
}

export interface Milestone {
  kind: 'meet' | 'custom';
  /** 展示标签，如「100 天」「生日」 */
  label: string;
  /** 相识天数（custom 为 0） */
  days: number;
  /** AI 专属问候（已代入角色名） */
  greeting: string;
}

export interface UpcomingAnniversary {
  label: string;
  days: number;
  isToday: boolean;
}

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY);
}

function load(): AnniversaryStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { meetDate: null, custom: [] };
    const parsed = JSON.parse(raw) as Partial<AnniversaryStore>;
    return {
      meetDate: typeof parsed.meetDate === 'string' ? parsed.meetDate : null,
      custom: Array.isArray(parsed.custom) ? parsed.custom : [],
    };
  } catch {
    return { meetDate: null, custom: [] };
  }
}

export interface UseAnniversaryResult {
  store: AnniversaryStore;
  daysSinceMeet: number | null;
  upcoming: UpcomingAnniversary | null;
  milestone: Milestone | null;
  setMeetDate: (date: string | null) => void;
  upsertCustom: (a: CustomAnniversary) => void;
  removeCustom: (id: string) => void;
}

export function useAnniversary(name?: string): UseAnniversaryResult {
  const [store, setStore] = useState<AnniversaryStore>(() => load());
  const who = name ?? 'TA';

  const persist = useCallback((next: AnniversaryStore) => {
    setStore(next);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用时静默：仅内存态可用
    }
  }, []);

  const setMeetDate = useCallback(
    (date: string | null) => {
      persist({ ...store, meetDate: date || null });
    },
    [store, persist],
  );

  const upsertCustom = useCallback(
    (a: CustomAnniversary) => {
      const exists = store.custom.some((c) => c.id === a.id);
      const custom = exists ? store.custom.map((c) => (c.id === a.id ? a : c)) : [...store.custom, a];
      persist({ ...store, custom });
    },
    [store, persist],
  );

  const removeCustom = useCallback(
    (id: string) => {
      persist({ ...store, custom: store.custom.filter((c) => c.id !== id) });
    },
    [store, persist],
  );

  const { daysSinceMeet, upcoming, milestone } = useMemo(() => {
    const today = todayMidnight();
    const days = store.meetDate ? Math.max(0, daysBetween(parseDate(store.meetDate), today)) : null;

    // 下一个自定义纪念日（仅取未来的 / 今天的）
    let upcoming: UpcomingAnniversary | null = null;
    if (store.custom.length) {
      const list = store.custom
        .map((a) => {
          const d = parseDate(a.date);
          let next: Date;
          if (a.repeat === 'yearly') {
            next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
            if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
          } else {
            next = d;
          }
          return { a, days: daysBetween(today, next) };
        })
        .filter((x) => x.days >= 0)
        .sort((x, y) => x.days - y.days);
      if (list[0]) {
        const top = list[0];
        upcoming = {
          label: top.a.label,
          days: top.days,
          isToday: top.days === 0,
        };
      }
    }

    // 里程碑：先查相识天数，再查自定义命中当天
    let milestone: Milestone | null = null;
    if (store.meetDate && days !== null) {
      const mm = getMeetMilestone(days);
      if (mm) {
        milestone = { kind: 'meet', label: mm.label, days, greeting: mm.greeting(who) };
      }
    }
    if (!milestone) {
      for (const a of store.custom) {
        const d = parseDate(a.date);
        const hit =
          a.repeat === 'yearly'
            ? d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
            : isSameDay(d, today);
        if (hit) {
          milestone = {
            kind: 'custom',
            label: a.label,
            days: 0,
            greeting: getCustomMilestone(a.label).greeting(who),
          };
          break;
        }
      }
    }

    return { daysSinceMeet: days, upcoming, milestone };
  }, [store, who]);

  return { store, daysSinceMeet, upcoming, milestone, setMeetDate, upsertCustom, removeCustom };
}
