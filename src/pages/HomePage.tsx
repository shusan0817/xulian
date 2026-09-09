/**
 * 首页（需求 §16）
 *
 * 内容全部来自**真实数据**，不做装饰性假 UI：
 *  - 当前 AI 角色 / 情绪 / 关系阶段 → /api/users/bootstrap 的 runtime
 *  - AI 主动消息（未读）            → /api/proactive/inbox
 *  - 「今天的狀態」                  → 由最近互动时间 + 今日主动消息数派生，不编造
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Avatar } from '@/components/common/Avatar';
import { EmptyState } from '@/components/common/EmptyState';
import { RapportCard } from '@/components/home/RapportCard';
import { SmallTopicsSection } from '@/components/home/SmallTopicsSection';
import { TodayStatusCard } from '@/components/home/TodayStatusCard';
import { UnfinishedSection } from '@/components/home/UnfinishedSection';
import { RecentMemoriesSection } from '@/components/home/RecentMemoriesSection';
import { AnniversaryCard } from '@/components/home/AnniversaryCard';
import { ConfettiOverlay } from '@/components/celebrate/ConfettiOverlay';
import { DailyEventModal } from '@/components/DailyEventModal';
import { useAppState } from '@/hooks/useAppState';
import { useAnniversary } from '@/hooks/useAnniversary';
import { useDailyEvent } from '@/hooks/useDailyEvent';
import { useProactiveInbox } from '@/hooks/useProactiveInbox';
import { apiPost } from '@/api/client';
import { EMOTION_ANCHORS, STAGE_META } from '@shared/constants';
import { formatRelativeTime } from '@/utils/time';

export function HomePage(): React.ReactElement {
  const navigate = useNavigate();
  const { characters, defaultCharacterId, loading, error } = useAppState();
  const { inbox, ack } = useProactiveInbox();

  const character = useMemo(
    () => characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null,
    [characters, defaultCharacterId],
  );

  // 纪念日里程碑（命中当天 → 首页渲染彩带 + AI 专属问候横幅）
  const { milestone } = useAnniversary(character?.name);
  const todayKey = new Date().toISOString().slice(0, 10);
  const [celebrated, setCelebrated] = useState(
    sessionStorage.getItem('xulian.celebrated.v1') === todayKey,
  );
  const showCelebrate = Boolean(milestone) && !celebrated && Boolean(character);
  const dismissCelebrate = (): void => {
    sessionStorage.setItem('xulian.celebrated.v1', todayKey);
    setCelebrated(true);
  };

  // 命中里程碑时，向服务端请求「以 TA 口吻、针对今天纪念日」的 AI 专属问候；
  // 失败 / 未配置则回落到本地预写文案（aiGreeting 保持 null）。
  const [aiGreeting, setAiGreeting] = useState<string | null>(null);
  useEffect(() => {
    if (!showCelebrate || !milestone || !character) return;
    const controller = new AbortController();
    setAiGreeting(null);
    apiPost<{ greeting: string | null }>(
      `/api/characters/${character.id}/anniversary-greeting`,
      { type: milestone.kind, label: milestone.label, days: milestone.days },
      { signal: controller.signal, silent: true },
    )
      .then((res) => {
        if (res?.greeting) setAiGreeting(res.greeting);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [showCelebrate, milestone, character]);

  // 进站彩蛋：随机日常事件弹窗（25% 触发，需已有 AI 角色）
  const { event: dailyEvent, dismiss: dismissDaily } = useDailyEvent(Boolean(character));

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
      {showCelebrate ? <ConfettiOverlay onDone={dismissCelebrate} /> : null}

      <AppHeader
        title="需戀"
        subtitle="一個記得你、也懂你的陪伴角色"
        showBack={false}
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {showCelebrate && character ? (
          <section className="rounded-3xl bg-gradient-to-br from-[var(--xl-blush)] to-[var(--xl-blush-deep)] p-4 text-white shadow-[var(--xl-shadow)]">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              🎉 今天是 {milestone!.label}
            </div>
            <p className="mt-2 text-[14px] leading-relaxed">{aiGreeting ?? milestone!.greeting}</p>
            <button
              onClick={() => {
                dismissCelebrate();
                navigate(`/chat?c=${character.id}`);
              }}
              className="mt-3 rounded-full bg-white/95 px-4 py-1.5 text-[13px] font-medium text-[var(--xl-blush-deep)] active:scale-95"
            >
              和 TA 聊聊
            </button>
          </section>
        ) : null}

        {loading && !character ? (
          <HomeSkeleton />
        ) : error && !character ? (
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

            {/* 纪念日：相识天数 + 里程碑 + 倒计时（顶部状态卡片） */}
            <AnniversaryCard character={character} />

            {/* 今天聊什么（AI 小话题）：给不知道聊什么的用户一个入口 */}
            <SmallTopicsSection />

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

            {/* 未完待续：用户之前留下没说完的话题 */}
            <UnfinishedSection />

            {/* 最近记忆：让首页一眼感到「TA 真的在记得我」 */}
            <RecentMemoriesSection />

            {/* 交流默契（真实派生，中性文案，区别于聊天页「心动值」） */}
            <RapportCard character={character} />

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

      {dailyEvent && character ? (
        <DailyEventModal
          event={dailyEvent}
          characterId={character.id}
          characterName={character.name}
          onClose={dismissDaily}
        />
      ) : null}
    </>
  );
}

/** 首屏数据未就绪（且无缓存）时的骨架占位：保持卡片结构，纯 CSS 脉冲 */
function HomeSkeleton(): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="h-24 animate-pulse rounded-3xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]" />
      <div className="h-20 animate-pulse rounded-3xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]" />
      <div className="h-20 animate-pulse rounded-3xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]" />
      <div className="h-20 animate-pulse rounded-3xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]" />
    </div>
  );
}

export default HomePage;
