/**
 * 主题 Hook
 *
 * 三态：light / dark / system。
 * - system：跟随系统，且监听系统变化实时切换；
 * - 手动选择后写入 localStorage，下次打开沿用。
 *
 * 实现方式：在 <html> 上加/去 `dark` class，配合 index.css 里的 CSS 变量。
 */

import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '@/config';
import type { ThemeMode } from '@/types/ui';

function readStoredTheme(): ThemeMode | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useTheme() {
  const [stored, setStored] = useState<ThemeMode | null>(() => readStoredTheme());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // 监听系统主题变化（只在没有手动选择时生效）
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const theme: ThemeMode = stored ?? (systemDark ? 'dark' : 'light');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    // 同步 theme-color，让 iOS/ Android 的状态栏颜色跟着变
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#1B1822' : '#FBFAFC');
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setStored(next);
    try {
      localStorage.setItem(STORAGE_KEYS.theme, next);
    } catch {
      // 隐私模式写不进去也不影响本次会话
    }
  }, []);

  /** 跟随系统：清掉手动选择 */
  const useSystem = useCallback(() => {
    setStored(null);
    try {
      localStorage.removeItem(STORAGE_KEYS.theme);
    } catch {
      // 同上
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggleTheme, useSystem, followingSystem: stored === null };
}

export default useTheme;
