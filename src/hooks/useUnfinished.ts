/**
 * 未完待續（需求：首页「你之前留下沒說完的話」）
 *
 * 拉取某个角色当前「open」状态的未完话题，并提供本地 dismiss / resolve 的调用封装。
 * 所有网络请求走统一的 api 客户端（自动注入用户态、错误归一化）。
 *
 * 注意：UnfinishedTopic 类型由本文件自包含定义，避免改动 shared 公共类型。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '@/api/client';

/** 未完话题（与后端 /api/unfinished 契约一致） */
export interface UnfinishedTopic {
  id: string;
  userId: string;
  characterId: string;
  topic: string;
  resumeHint: string;
  sourceMessageIds: string[];
  status: 'open' | 'resolved' | 'archived';
  lastTouchedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface UnfinishedList {
  items: UnfinishedTopic[];
  total: number;
}

export interface UseUnfinishedResult {
  items: UnfinishedTopic[];
  loading: boolean;
  error: string | null;
  /** 重新拉取（dismiss 失败回滚、外部想刷新时调用） */
  refetch: () => void;
  /** 关闭一条未完话题：本地乐观移除 + DELETE，失败回滚重拉 */
  dismiss: (id: string) => Promise<void>;
  /** 用户点击「繼續」时调用：fire-and-forget 标记 resolve，忽略错误 */
  resolve: (topic: UnfinishedTopic) => void;
}

/**
 * 取某个角色的 open 未完话题。characterId 为空时直接返回空列表。
 * characterId 变化或 refetch 触发时自动重新拉取。
 */
export function useUnfinished(characterId: string | null): UseUnfinishedResult {
  const [items, setItems] = useState<UnfinishedTopic[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const fetchTopics = useCallback(async (): Promise<void> => {
    if (!characterId) {
      setItems([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<UnfinishedList>(
        '/api/unfinished',
        { characterId },
        { silent: true },
      );
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    void fetchTopics();
  }, [fetchTopics, nonce]);

  const refetch = useCallback((): void => {
    setNonce((n) => n + 1);
  }, []);

  const dismiss = useCallback(
    async (id: string): Promise<void> => {
      // 乐观移除：先更新 UI，再请求后端，失败回滚重拉
      setItems((prev) => prev.filter((t) => t.id !== id));
      try {
        await apiDelete<{ ok: true }>(
          '/api/unfinished/' + id,
          undefined,
          { silent: true },
        );
      } catch {
        void refetch();
      }
    },
    [refetch],
  );

  const resolve = useCallback((topic: UnfinishedTopic): void => {
    // fire-and-forget：用户已决定续聊，标记 resolved，失败无所谓
    void apiPost<{ ok: true }>(
      '/api/unfinished/' + topic.id + '/resolve',
      undefined,
      { silent: true },
    ).catch(() => {});
  }, []);

  return { items, loading, error, refetch, dismiss, resolve };
}
