/**
 * 首页主动消息收件箱（轻量版）
 *
 * 首页只需要「未读主动消息」列表 + 标记已读，不需要 settings 页才用到的
 * status / scheduler / history。原 useProactive 一次拉 4 个接口，首页白费 3 个。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import type { MessageRecord } from '@shared/types';

export interface UseProactiveInboxResult {
  inbox: MessageRecord[];
  loading: boolean;
  ack: (messageIds: string[]) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProactiveInbox(): UseProactiveInboxResult {
  const [inbox, setInbox] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<{ messages: MessageRecord[] }>(
        '/api/proactive/inbox',
        { limit: 20 },
        { silent: true },
      );
      setInbox(res.messages ?? []);
    } catch {
      setInbox([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ack = useCallback(async (messageIds: string[]): Promise<void> => {
    if (!messageIds.length) return;
    await apiPost('/api/proactive/ack', { messageIds });
    setInbox((prev) => prev.filter((m) => !messageIds.includes(m.id)));
  }, []);

  return { inbox, loading, ack, refresh };
}
