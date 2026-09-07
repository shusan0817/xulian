/**
 * 我们的故事（需求 V2-2）
 *
 * 封装对一个角色的故事列表的读取与 CRUD。
 * 数据全部来自真实接口（/api/stories*），不落地任何假数据。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, humanizeError } from '@/api/client';
import { toast } from '@/components/common/Toast';
import type { Story } from '@shared/types';
import type { StoryType } from '@shared/constants';

/** PATCH /api/stories/:id 允许的字段 */
export interface StoryPatch {
  title?: string;
  summary?: string;
  importance?: number;
  pinned?: boolean;
  happenedAt?: string;
}

/** POST /api/stories 的入参 */
export interface StoryCreateInput {
  characterId: string;
  type?: StoryType;
  title: string;
  summary: string;
  happenedAt?: string;
}

export interface UseStoriesResult {
  stories: Story[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateStory: (id: string, patch: StoryPatch) => Promise<void>;
  removeStory: (id: string) => Promise<void>;
  restoreStory: (id: string) => Promise<void>;
  addStory: (input: StoryCreateInput) => Promise<void>;
}

export function useStories(characterId?: string | null): UseStoriesResult {
  const [stories, setStories] = useState<Story[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!characterId) {
      setStories([]);
      setTotal(0);
      return;
    }
    try {
      setLoading(true);
      const result = await apiGet<{ items: Story[]; total: number }>(
        '/api/stories',
        { characterId },
        { silent: true },
      );
      setStories(result.items ?? []);
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

  const updateStory = useCallback(
    async (id: string, patch: StoryPatch): Promise<void> => {
      await apiPatch(`/api/stories/${id}`, patch);
      toast.success('已更新故事');
      await refresh();
    },
    [refresh],
  );

  const removeStory = useCallback(
    async (id: string): Promise<void> => {
      setStories((prev) => prev.filter((s) => s.id !== id));
      try {
        await apiDelete<{ ok: true }>(`/api/stories/${id}`);
        toast.success('已刪除故事');
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const restoreStory = useCallback(
    async (id: string): Promise<void> => {
      await apiPost<Story>(`/api/stories/${id}/restore`);
      toast.success('已還原為自動版本');
      await refresh();
    },
    [refresh],
  );

  const addStory = useCallback(
    async (input: StoryCreateInput): Promise<void> => {
      await apiPost<Story>('/api/stories', input);
      toast.success('已新增故事');
      await refresh();
    },
    [refresh],
  );

  return { stories, total, loading, error, refresh, updateStory, removeStory, restoreStory, addStory };
}
