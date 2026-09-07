/**
 * 首页「今天聊什麼」区块（需求：AI 小话题）
 *
 * 横向滑动的话题卡片，点一下就带话题跳到聊天页（ChatPage 读取 `topic` 查询参数回填输入框）。
 * 真实数据来自 useSmallTopics；无角色时不渲染。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';

import { useAppState } from '@/hooks/useAppState';
import { useSmallTopics, type SmallTopic } from '@/hooks/useSmallTopics';

export function SmallTopicsSection(): React.ReactElement | null {
  const navigate = useNavigate();
  const { defaultCharacterId, characters } = useAppState();

  const character = useMemo(
    () => characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null,
    [characters, defaultCharacterId],
  );

  // 无角色：什么都不渲染
  if (!character) return null;

  return <SmallTopicsInner characterId={character.id} characterName={character.name} />;
}

interface InnerProps {
  characterId: string;
  characterName: string;
}

function SmallTopicsInner({ characterId, characterName }: InnerProps): React.ReactElement {
  const navigate = useNavigate();
  const { topics, loading } = useSmallTopics(characterId);

  const openTopic = (topic: SmallTopic): void => {
    navigate('/chat?c=' + characterId + '&topic=' + encodeURIComponent(topic.title));
  };

  return (
    <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
      <div className="mb-3 flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-[var(--xl-blush-deep)]" />
        <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">今天聊什麼</h3>
        <span className="ml-1 text-[11px] text-[var(--xl-sub)]">
          不知道聊什麼，點一個試試
        </span>
      </div>

      {loading ? (
        <div className="flex gap-3 overflow-x-auto xl-no-scrollbar">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[68px] min-w-[140px] flex-none animate-pulse rounded-2xl bg-[var(--xl-mist)]/60"
            />
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto xl-no-scrollbar">
          {topics.map((topic) => (
            <button
              key={topic.id}
              onClick={() => openTopic(topic)}
              className="min-w-[140px] flex-none rounded-2xl bg-[var(--xl-mist)]/60 px-3 py-2.5 text-left active:scale-[0.98]"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xl leading-none">{topic.emoji}</span>
                <span className="text-[13px] font-bold text-[var(--xl-ink)] line-clamp-1">
                  {topic.title}
                </span>
              </div>
              <p className="mt-1 line-clamp-1 text-[11px] text-[var(--xl-sub)]">
                {topic.hint}
              </p>
            </button>
          ))}
        </div>
      )}

      <span className="sr-only">和 {characterName} 聊这些小话题</span>
    </section>
  );
}

export default SmallTopicsSection;
