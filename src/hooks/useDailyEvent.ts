/**
 * 随机日常事件（需求：进站彩蛋）
 *
 * 首页挂载时按概率（默认 25%）抽一个日常小事件，返回给首页渲染弹窗。
 * 用 sessionStorage 把「本次会话已抽过」记下来，避免 SPA 内来回切换页面反复弹出；
 * 新开标签页 / 刷新会重新进入会话，可再次触发。
 *
 * enabled=false（例如还没有任何 AI 角色）时永不触发。
 */

import { useEffect, useState } from 'react';

import { DAILY_EVENTS, type DailyEvent } from '@/lib/dailyEvents';

const SESSION_KEY = 'xulian.dailyEvent.v1';
const CHANCE = 0.25;

export interface UseDailyEventResult {
  event: DailyEvent | null;
  dismiss: () => void;
}

export function useDailyEvent(enabled: boolean): UseDailyEventResult {
  const [event, setEvent] = useState<DailyEvent | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;
    // 标记已抽，避免本次会话重复
    sessionStorage.setItem(SESSION_KEY, '1');
    if (Math.random() < CHANCE) {
      const pick = DAILY_EVENTS[Math.floor(Math.random() * DAILY_EVENTS.length)];
      setEvent(pick);
    }
  }, [enabled]);

  const dismiss = (): void => setEvent(null);

  return { event, dismiss };
}
