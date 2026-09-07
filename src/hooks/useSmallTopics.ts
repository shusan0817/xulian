/**
 * 「今天聊什麼」小话题
 *
 * 拉取当前角色的建议闲聊话题（真实接口：`GET /api/small-topics?characterId=`）。
 * 接口失败或返回空时，回落到本地 4 个预设话题，保证首页永远有得聊。
 */

import { useEffect, useState } from 'react';
import { apiGet } from '@/api/client';

export interface SmallTopic {
  id: string;
  title: string;
  hint: string;
  emoji: string;
}

/** 接口挂掉 / 没数据时用的兜底话题，保证体验不空 */
export const PRESET_TOPICS: SmallTopic[] = [
  { id: 'preset-mood', title: '今天心情如何', hint: '隨便說說今天發生的事', emoji: '🌤️' },
  { id: 'preset-music', title: '最近在聽什麼歌', hint: '分享一首讓你 loop 的歌', emoji: '🎵' },
  { id: 'preset-food', title: '今天吃了什麼', hint: '好吃的難吃的都行', emoji: '🍜' },
  { id: 'preset-dream', title: '昨晚夢到什麼', hint: '奇怪的夢也可以聊', emoji: '🌙' },
];

interface SmallTopicsState {
  topics: SmallTopic[];
  loading: boolean;
  /** 是否来自本地兜底（接口失败/空），UI 可用于微调 */
  isFallback: boolean;
}

/**
 * 拉取指定角色的小话题。
 * @param characterId 当前角色 id；为空时直接回落到预设、不请求
 */
export function useSmallTopics(characterId: string | null): SmallTopicsState {
  const [topics, setTopics] = useState<SmallTopic[]>(PRESET_TOPICS);
  const [loading, setLoading] = useState<boolean>(true);
  const [isFallback, setIsFallback] = useState<boolean>(true);

  useEffect(() => {
    // 没有角色就不发请求，直接展示预设
    if (!characterId) {
      setTopics(PRESET_TOPICS);
      setIsFallback(true);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    apiGet<{ topics: SmallTopic[] }>(
      '/api/small-topics?characterId=' + encodeURIComponent(characterId),
      undefined,
      { silent: true },
    )
      .then((data) => {
        if (cancelled) return;
        const fetched = data?.topics;
        if (Array.isArray(fetched) && fetched.length > 0) {
          setTopics(fetched);
          setIsFallback(false);
        } else {
          setTopics(PRESET_TOPICS);
          setIsFallback(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setTopics(PRESET_TOPICS);
        setIsFallback(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [characterId]);

  return { topics, loading, isFallback };
}
