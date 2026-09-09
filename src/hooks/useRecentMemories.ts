/**
 * 轻量记忆读取（首页「最近記憶」用）
 *
 * 只拉 /api/memories 一条接口，不再像 useMemoryLab 那样顺带拉
 * habits / insights / stories——首页根本不展示那三类，原实现首页白白多 3 个请求。
 * （与 MemoryPage 用的 useMemories 区分开：那边需要 update/remove/clearAll 等写操作。）
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, humanizeError } from '@/api/client';
import type { MemoryItem } from '@shared/types';

export interface UseRecentMemoriesResult {
  memories: MemoryItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRecentMemories(
  characterId?: string | null,
  limit = 10,
): UseRecentMemoriesResult {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!characterId) {
      setMemories([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiGet<{ items: MemoryItem[]; total: number }>(
        `/api/memories?characterId=${encodeURIComponent(characterId)}&limit=${limit}`,
        undefined,
        { silent: true },
      );
      setMemories(res.items ?? []);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }, [characterId, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { memories, loading, error, refresh };
}
