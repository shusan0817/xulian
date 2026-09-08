/**
 * 用户偏好（需求：「可以试试」— 彩蛋概率可在设置里调）
 *
 * 与纪念日数据一样存 localStorage（纯客户端、无需后端账号），key 独立，
 * 不污染 anniversary store。目前只有 dailyEventChance 一项，预留为空对象方便日后扩展。
 */

import { useCallback, useState } from 'react';

const PREFS_KEY = 'xulian.prefs.v1';

export interface UserPrefs {
  /** 进站日常小事件（彩蛋）触发概率，0..1 */
  dailyEventChance: number;
}

const DEFAULTS: UserPrefs = { dailyEventChance: 0.25 };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.dailyEventChance;
  return Math.min(1, Math.max(0, n));
}

function load(): UserPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UserPrefs>;
    return { dailyEventChance: clamp01(parsed.dailyEventChance ?? DEFAULTS.dailyEventChance) };
  } catch {
    return { ...DEFAULTS };
  }
}

export interface UseUserPrefsResult {
  dailyEventChance: number;
  setDailyEventChance: (chance: number) => void;
}

export function useUserPrefs(): UseUserPrefsResult {
  const [prefs, setPrefs] = useState<UserPrefs>(() => load());

  const setDailyEventChance = useCallback(
    (chance: number) => {
      const next: UserPrefs = { ...prefs, dailyEventChance: clamp01(chance) };
      setPrefs(next);
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // localStorage 不可用时静默：仅内存态可用
      }
    },
    [prefs],
  );

  return { dailyEventChance: prefs.dailyEventChance, setDailyEventChance };
}
