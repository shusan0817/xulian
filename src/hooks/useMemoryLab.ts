/**
 * 记忆实验室数据源（需求 B：AI 記憶實驗室，只读聚合）
 *
 * 一次性并行拉取四类「AI 对你的了解」：记忆 / 交流习惯 / 你的偏好 / 故事。
 * 每个来源独立容错——某一个失败不会让整页空白，只会在该分类上留空并报告错误。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, humanizeError } from '@/api/client';
import type { AiHabit, MemoryItem, Story, UserInsight } from '@shared/types';

export interface MemoryLabData {
  memories: MemoryItem[];
  habits: AiHabit[];
  insights: UserInsight[];
  stories: Story[];
}

export interface MemoryLabErrors {
  memories?: string;
  habits?: string;
  insights?: string;
  stories?: string;
}

export interface UseMemoryLabResult {
  data: MemoryLabData;
  loading: boolean;
  errors: MemoryLabErrors;
  refresh: () => Promise<void>;
}

export function useMemoryLab(characterId?: string | null): UseMemoryLabResult {
  const [data, setData] = useState<MemoryLabData>({
    memories: [],
    habits: [],
    insights: [],
    stories: [],
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<MemoryLabErrors>({});

  const refresh = useCallback(async (): Promise<void> => {
    if (!characterId) {
      setData({ memories: [], habits: [], insights: [], stories: [] });
      return;
    }
    setLoading(true);
    const nextErrors: MemoryLabErrors = {};

    const [memories, habits, insights, stories] = await Promise.all([
      apiGet<{ items: MemoryItem[]; total: number }>(
        '/api/memories?characterId=' + characterId + '&limit=200',
        undefined,
        { silent: true },
      )
        .then((r) => r.items ?? [])
        .catch((e: unknown) => {
          nextErrors.memories = humanizeError(e);
          return [] as MemoryItem[];
        }),
      apiGet<{ habits: AiHabit[] }>(
        '/api/habits?characterId=' + characterId + '&includeCandidate=1',
        undefined,
        { silent: true },
      )
        .then((r) => r.habits ?? [])
        .catch((e: unknown) => {
          nextErrors.habits = humanizeError(e);
          return [] as AiHabit[];
        }),
      apiGet<{ insights: UserInsight[] }>('/api/insights', undefined, { silent: true })
        .then((r) => r.insights ?? [])
        .catch((e: unknown) => {
          nextErrors.insights = humanizeError(e);
          return [] as UserInsight[];
        }),
      apiGet<{ items: Story[]; total: number }>(
        '/api/stories?characterId=' + characterId + '&limit=200',
        undefined,
        { silent: true },
      )
        .then((r) => r.items ?? [])
        .catch((e: unknown) => {
          nextErrors.stories = humanizeError(e);
          return [] as Story[];
        }),
    ]);

    setData({ memories, habits, insights, stories });
    setErrors(nextErrors);
    setLoading(false);
  }, [characterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, errors, refresh };
}
