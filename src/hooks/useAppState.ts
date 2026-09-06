/**
 * 应用状态：用户 + 角色列表
 *
 * 所有页面共用的基础数据（用户资料、角色列表、当前默认角色）放在这里，
 * 避免在多个页面各自 bootstrap 造成重复请求与状态不一致。
 *
 * 首次进入时调一次 `/api/users/bootstrap`：
 * 后端会保证用户存在，并在没有任何角色时自动创建一个默认角色，
 * 所以新用户打开 App 就能直接聊天，不需要先填空白创建页。
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import type {
  AICharacter,
  CharacterRuntimeSummary,
  User,
} from '@shared/types';

export type CharacterWithRuntime = AICharacter & { runtime: CharacterRuntimeSummary };

interface BootstrapPayload {
  user: User;
  characters: CharacterWithRuntime[];
  defaultCharacterId: string | null;
}

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
  const [user, setUser] = useState<User | null>(null);
  const [characters, setCharacters] = useState<CharacterWithRuntime[]>([]);
  const [defaultCharacterId, setDefaultCharacterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const data = await apiGet<BootstrapPayload>('/api/users/bootstrap', {
        auth: false,
        silent: true,
      });
      setUser(data.user);
      setCharacters(data.characters ?? []);
      setDefaultCharacterId(
        data.defaultCharacterId ?? data.characters?.[0]?.id ?? null,
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const setDefault = useCallback(
    async (characterId: string): Promise<void> => {
      await apiPost(`/api/characters/${characterId}/default`, {});
      setDefaultCharacterId(characterId);
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    user,
    characters,
    defaultCharacterId,
    loading,
    error,
    refresh,
    setDefault,
  };
}

export type { User, AICharacter, CharacterRuntimeSummary };
