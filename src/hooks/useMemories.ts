/**
 * 长期记忆管理（需求 §8：可查看 / 修改 / 删除 / 全部清空 / 关闭）
 *
 * 记忆是"AI 记住了什么"的透明化窗口——
 * 用户看不到、改不了、删不掉的记忆，本质上是在侵犯用户对数据的控制权。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, humanizeError } from '@/api/client';
import type { MemoryCategory } from '@shared/constants';
import type { MemoryItem } from '@shared/types';

export interface UseMemoriesResult {
  memories: MemoryItem[];
  loading: boolean;
  error: string | null;
  total: number;
  refresh: () => Promise<void>;
  add: (input: { characterId: string; content: string; category?: MemoryCategory }) => Promise<void>;
  update: (id: string, patch: { content?: string; category?: MemoryCategory }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearAll: (characterId?: string) => Promise<void>;
}

export function useMemories(characterId?: string | null): UseMemoriesResult {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const result = await apiGet<{ items: MemoryItem[]; total: number }>('/api/memories', {
        characterId: characterId ?? undefined,
        limit: 200,
      }, { silent: true });
      setMemories(result.items ?? []);
      setTotal(result.total ?? 0);
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

  const add = useCallback(
    async (input: { characterId: string; content: string; category?: MemoryCategory }): Promise<void> => {
      await apiPost('/api/memories', input);
      await refresh();
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: { content?: string; category?: MemoryCategory }): Promise<void> => {
      await apiPatch(`/api/memories/${id}`, patch);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      try {
        await apiDelete(`/api/memories/${id}`);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const clearAll = useCallback(
    async (targetCharacterId?: string): Promise<void> => {
      const target = targetCharacterId ?? characterId;
      // apiDelete 没有 params 参数，这里直接拼 query string
      await apiDelete(target ? `/api/memories?characterId=${encodeURIComponent(target)}` : '/api/memories');
      await refresh();
    },
    [characterId, refresh],
  );

  return { memories, loading, error, total, refresh, add, update, remove, clearAll };
}
