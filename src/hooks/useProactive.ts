/**
 * 主动聊天状态（需求 §10–§13）
 *
 * 这个 hook 的意义不只是取数据——它对应需求 §27.2「不要做假 UI」：
 * `/api/proactive/status` 返回的是**真实的决策明细**（七因子的原始值、
 * 加权值、否决原因码），用户可以在设置页看到"AI 现在为什么不找我"。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, humanizeError } from '@/api/client';
import type { MessageRecord, ProactiveTask } from '@shared/types';

export interface ProactiveStatus {
  decision: 'skip' | 'delay' | 'send';
  score: number;
  factors: Record<string, { raw: number; weight: number; weighted: number }>;
  reasonCode: string;
  reasonText: string;
  nextCheckAt: string | null;
  todaySent: number;
  dailyLimit: number;
}

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  lastTickAt: string | null;
  tickMs: number;
  proactiveEnabled: boolean;
}

export interface UseProactiveResult {
  inbox: MessageRecord[];
  status: ProactiveStatus | null;
  scheduler: SchedulerStatus | null;
  history: ProactiveTask[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  ack: (messageIds: string[]) => Promise<void>;
  runTick: () => Promise<void>;
}

export function useProactive(characterId?: string | null): UseProactiveResult {
  const [inbox, setInbox] = useState<MessageRecord[]>([]);
  const [status, setStatus] = useState<ProactiveStatus | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [history, setHistory] = useState<ProactiveTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const [inboxRes, statusRes, schedRes, historyRes] = await Promise.all([
        apiGet<{ messages: MessageRecord[] }>('/api/proactive/inbox', { limit: 20 }, { silent: true }),
        apiGet<ProactiveStatus>('/api/proactive/status', {
          characterId: characterId ?? undefined,
        }, { silent: true }),
        apiGet<SchedulerStatus>('/api/proactive/scheduler', undefined, { silent: true }),
        apiGet<{ tasks: ProactiveTask[] }>('/api/proactive/history', { limit: 10 }, { silent: true }),
      ]);
      setInbox(inboxRes.messages ?? []);
      setStatus(statusRes);
      setScheduler(schedRes);
      setHistory(historyRes.tasks ?? []);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ack = useCallback(
    async (messageIds: string[]): Promise<void> => {
      if (!messageIds.length) return;
      await apiPost('/api/proactive/ack', { messageIds });
      setInbox((prev) => prev.filter((m) => !messageIds.includes(m.id)));
    },
    [],
  );

  const runTick = useCallback(async (): Promise<void> => {
    await apiPost('/api/proactive/tick', {});
    await refresh();
  }, [refresh]);

  return { inbox, status, scheduler, history, loading, error, refresh, ack, runTick };
}
