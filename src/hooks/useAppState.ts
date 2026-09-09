/**
 * 应用状态：用户 + 角色列表
 *
 * 数据来源统一走 useUserId 的单例 bootstrap store——
 * 不再各自发 GET /api/users/bootstrap，全应用只 bootstrap 一次（POST）。
 * 缓存优先：store 已落地 localStorage，首屏可立即渲染，无需整页 Loading。
 */

import { useCallback } from 'react';
import { apiPost } from '@/api/client';
import { useUserId, refreshBootstrap, setDefaultCharacterLocal } from '@/hooks/useUserId';
import type {
  AICharacter,
  CharacterRuntimeSummary,
  User,
} from '@shared/types';

export type CharacterWithRuntime = AICharacter & { runtime: CharacterRuntimeSummary };

interface AppState {
  user: User | null;
  characters: CharacterWithRuntime[];
  defaultCharacterId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setDefault: (characterId: string) => Promise<void>;
}

export function useAppState(): AppState {
  const { bootstrap, loading, error } = useUserId();

  const refresh = useCallback(async (): Promise<void> => {
    await refreshBootstrap();
  }, []);

  const setDefault = useCallback(async (characterId: string): Promise<void> => {
    await apiPost(`/api/characters/${characterId}/default`, {});
    setDefaultCharacterLocal(characterId);
  }, []);

  return {
    user: bootstrap?.user ?? null,
    characters: (bootstrap?.characters ?? []) as CharacterWithRuntime[],
    defaultCharacterId:
      bootstrap?.defaultCharacterId ?? bootstrap?.characters?.[0]?.id ?? null,
    loading,
    error,
    refresh,
    setDefault,
  };
}

export type { User, AICharacter, CharacterRuntimeSummary };
