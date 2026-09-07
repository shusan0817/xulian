/**
 * AI 成长摘要（需求 A：成長展示）
 *
 * 读取后端返回的单个角色成长概览：记忆 / 故事 / 里程碑 / 习惯 / 偏好 数量，
 * 以及活跃天数、累积消息数、默契度百分比、关系阶段与初次聊天时间。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, humanizeError } from '@/api/client';

/** 后端 GET /api/characters/:id/growth 返回的摘要结构（前端本地定义） */
export interface GrowthSummary {
  memories: number;
  stories: number;
  milestones: number;
  habits: number;
  insights: number;
  activeDays: number;
  totalMessages: number;
  /** 0..100 的默契度百分比 */
  interactionLevelPct: number;
  /** 关系阶段，原始字符串（可能是 RelationshipStage 枚举值） */
  stage: string;
  /** 初次聊天时间（ISO 字符串），可能为 null */
  firstChatAt: string | null;
}

export interface UseGrowthResult {
  growth: GrowthSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useGrowth(characterId?: string | null): UseGrowthResult {
  const [growth, setGrowth] = useState<GrowthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!characterId) {
      setGrowth(null);
      return;
    }
    try {
      setLoading(true);
      const result = await apiGet<{ growth: GrowthSummary }>(
        '/api/characters/' + characterId + '/growth',
        undefined,
        { silent: true },
      );
      setGrowth(result.growth);
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

  return { growth, loading, error, refresh };
}
