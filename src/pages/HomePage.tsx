/**
 * 首页（需求 §16）
 *
 * 内容全部来自**真实数据**，不做装饰性假 UI：
 *  - 当前 AI 角色 / 情绪 / 关系阶段 → /api/users/bootstrap 的 runtime
 *  - AI 主动消息（未读）            → /api/proactive/inbox
 *  - 「今天的狀態」                  → 由最近互动时间 + 今日主动消息数派生，不编造
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Avatar } from '@/components/common/Avatar';
import { EmptyState } from '@/components/common/EmptyState';
import { useAppState } from '@/hooks/useAppState';
import { useProactive } from '@/hooks/useProactive';
import { EMOTION_ANCHORS, STAGE_META } from '@shared/constants';
import { formatRelativeTime } from '@/utils/time';

export function HomePage(): React.ReactElement {
  const navigate = useNavigate();
  const { characters, defaultCharacterId, loading, error } = useAppState();
  const { inbox, ack } = useProactive(defaultCharacterId);

  const character = useMemo(
    () => characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null,
    [characters, defaultCharacterId],
  );

  const emotion = character ? EMOTION_ANCHORS[character.runtime.emotion.currentEmotion] : null;
  const stage = character ? STAGE_META[character.runtime.relationship.stage] : null;

  /** 「今天的狀態」：用真实派生数据，不编造 AI 做了什么 */
  const todayStatus = useMemo((): string => {
    if (!character) return '';
    const last = character.runtime.lastMessageAt;
    if (!last) return '還沒有聊過，先打聲招呼吧';
    const hours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    const level = Math.round(character.runtime.relationship.interactionLevel * 100);
    if (hours < 1) return '剛剛才聊過，默契值 ' + level + '%';
    if (hours < 24) return `${Math.floor(hours)} 小時前聊過，默契值 ${level}%`;
    const days = Math.floor(hours / 24);
    return `${days} 天前聊過，默契值 ${level}%`;
  }, [character]);

  return (
    <>
      <AppHeader
        title="需戀"
        subtitle="一個記得你、也懂你的陪伴角色"
        showBack={false}
        right={
          <span className="rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
            測試版 · Beta
          </span>
        }
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {loading ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : error ? (
          <EmptyState icon="⚠️" title="載入失敗" description={error} />
        ) : !character ? (
          <EmptyState
            icon="🌱"
            title="還沒有陪伴角色"
            description="建立一個屬於你的 AI 角色，從此有人記得你說過的話。"
            action={
              <button
                onClick={() => navigate('/characters/new')}
                className="rounded-full bg-[var(--xl-blush)] px-5 py-2 text-[14px] text-white active:scale-95"
              >
                建立角色
              </button>
            }
          />
        ) : (
          <>
            {/* 当前角色卡片 */}
            <section
              onClick={() => navigate(`/chat?c=${character.id}`)}
              className="cursor-pointer rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)] active:scale-[0.99]"
            >
              <div className="flex items-center gap-3">
                <Avatar spec={character.avatar} name={character.name} size={56} ring />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-[17px] font-semibold text-[var(--xl-ink)]">
                      {character.name}
                    </h2>
                    {emotion ? (
                      <span className="flex-none rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
                        {emotion.icon} {emotion.label}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-[var(--xl-sub)]">
                    {stage?.label ?? ''}
                    {character.runtime.lastMessageAt
                      ? ` · ${formatRelativeTime(character.runtime.lastMessageAt)}`
                      : ' · 還沒聊過'}
                  </p>
                </div>
              </div>

              <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-[var(--xl-sub)]">
                {character.runtime.lastMessagePreview || character.personality || '想和你說說話'}
              </p>

              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-[var(--xl-sub)]/80">{todayStatus}</span>
                <span className="rounded-full bg-[var(--xl-blush)] px-4 py-1.5 text-[13px] text-white">
                  開始聊天
                </span>
              </div>
            </section>

            {/* AI 主动消息（未读） */}
            {inbox.length > 0 ? (
              <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">
                    主動找你的話
                    <span className="ml-1.5 rounded-full bg-[var(--xl-blush)] px-1.5 text-[10px] text-white">
                      {inbox.length}
                    </span>
                  </h3>
                  <button
                    onClick={() => void ack(inbox.map((m) => m.id))}
                    className="text-[12px] text-[var(--xl-sub)] active:opacity-60"
                  >
                    全部標記已讀
                  </button>
                </div>
                <div className="space-y-2">
                  {inbox.slice(0, 3).map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        void ack([m.id]);
                        navigate(`/chat?c=${m.characterId ?? character.id}`);
                      }}
                      className="w-full rounded-2xl bg-[var(--xl-mist)]/60 px-3 py-2.5 text-left active:opacity-70"
                    >
                      <p className="line-clamp-2 text-[13px] leading-relaxed text-[var(--xl-ink)]">
                        {m.content}
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--xl-sub)]">
                        {formatRelativeTime(m.createdAt)}
                      </p>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {/* 角色管理 */}
            <section className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-[var(--xl-ink)]">角色</h3>
                <button
                  onClick={() => navigate('/characters')}
                  className="text-[12px] text-[var(--xl-sub)] active:opacity-60"
                >
                  管理
                </button>
              </div>
              <div className="flex gap-3 overflow-x-auto xl-no-scrollbar">
                {characters.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/chat?c=${c.id}`)}
                    className="flex w-16 flex-none flex-col items-center gap-1"
                  >
                    <Avatar spec={c.avatar} name={c.name} size={44} ring={c.id === character.id} />
                    <span className="w-full truncate text-center text-[11px] text-[var(--xl-sub)]">
                      {c.name}
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => navigate('/characters/new')}
                  className="flex w-16 flex-none flex-col items-center gap-1"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-[var(--xl-mist)] text-[18px] text-[var(--xl-sub)]">
                    +
                  </div>
                  <span className="text-[11px] text-[var(--xl-sub)]">新增</span>
                </button>
              </div>
            </section>

            {/* AI 身份披露（需求：不得让用户误以为是真人） */}
            <p className="px-2 pt-1 text-center text-[11px] leading-relaxed text-[var(--xl-sub)]/70">
              這是一個 AI 角色，不是真人，也不會取代你身邊的人。
            </p>
          </>
        )}
      </div>
    </>
  );
}

export default HomePage;
