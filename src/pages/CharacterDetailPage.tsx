/**
 * AI 詳情頁（需求 §6 我的 AI → 點擊 AI 進入詳情）
 *
 * 展示該 AI 的人格、說話風格、關係階段，以及由後端成長接口算出的真實統計
 * （聊天數 / 記憶數 / 活躍天數 / 默契值）。提供三個核心動作：
 * 開始聊天 / 編輯AI / 查看記憶。所有數據來自真實接口，不做假 UI。
 */

import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Avatar } from '@/components/common/Avatar';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { useAppState, type CharacterWithRuntime } from '@/hooks/useAppState';
import { useGrowth } from '@/hooks/useGrowth';
import { EMOTION_ANCHORS, STAGE_META } from '@shared/constants';
import { formatRelativeTime } from '@/utils/time';

function StatTile({ label, value }: { label: string; value: number | string | null | undefined }): React.ReactElement {
  return (
    <div className="rounded-2xl bg-[var(--xl-card)] p-3 text-center shadow-[var(--xl-shadow)]">
      <p className="text-[20px] font-semibold text-[var(--xl-ink)]">{value ?? '—'}</p>
      <p className="mt-0.5 text-[11px] text-[var(--xl-sub)]">{label}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-[13px] text-[var(--xl-sub)]">{label}</span>
      <span className="max-w-[60%] truncate text-right text-[13px] text-[var(--xl-ink)]">{value}</span>
    </div>
  );
}

export function CharacterDetailPage(): React.ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { characters, loading } = useAppState();
  const character = useMemo<CharacterWithRuntime | null>(
    () => characters.find((c) => c.id === id) ?? null,
    [characters, id],
  );
  const { growth } = useGrowth(id || null);

  if (loading) {
    return (
      <>
        <AppHeader title="載入中" showBack onBack={() => navigate('/characters')} />
        <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--xl-sub)]">
          載入中…
        </div>
      </>
    );
  }

  if (!character) {
    return (
      <>
        <AppHeader title="找不到角色" showBack onBack={() => navigate('/characters')} />
        <div className="flex flex-1 items-center justify-center px-6">
          <EmptyState
            icon="🔍"
            title="找不到這個 AI"
            description="它可能已被刪除，或連結有誤。"
            action={
              <button
                onClick={() => navigate('/characters')}
                className="rounded-full bg-[var(--xl-blush)] px-5 py-2 text-[14px] text-white active:scale-95"
              >
                回到我的AI
              </button>
            }
          />
        </div>
      </>
    );
  }

  const emotion = EMOTION_ANCHORS[character.runtime.emotion.currentEmotion];
  const stage = STAGE_META[character.runtime.relationship.stage];

  return (
    <>
      <AppHeader title={character.name} showBack onBack={() => navigate('/characters')} />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 xl-no-scrollbar">
        {/* 頭像 + 名稱 + 狀態 */}
        <section className="flex flex-col items-center pt-2 text-center">
          <Avatar spec={character.avatar} name={character.name} size={88} ring />
          <h2 className="mt-3 text-[20px] font-semibold text-[var(--xl-ink)]">{character.name}</h2>
          <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">
            {emotion ? (
              <span className="rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
                {emotion.icon} {emotion.label}
              </span>
            ) : null}
            {stage ? (
              <span className="rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
                {stage.label}
              </span>
            ) : null}
          </div>
          {character.personality ? (
            <p className="mt-3 px-2 text-[13px] leading-relaxed text-[var(--xl-sub)]">
              {character.personality}
            </p>
          ) : null}
          {character.speakingStyle ? (
            <p className="mt-1 px-2 text-[12px] leading-relaxed text-[var(--xl-sub)]/80">
              {character.speakingStyle}
            </p>
          ) : null}
        </section>

        {/* 真實統計（來自 /api/characters/:id/growth） */}
        <section className="grid grid-cols-2 gap-2">
          <StatTile label="聊天數" value={growth?.totalMessages} />
          <StatTile label="記憶數" value={growth?.memories} />
          <StatTile label="活躍天數" value={growth?.activeDays} />
          <StatTile label="默契值" value={growth ? `${growth.interactionLevelPct}%` : null} />
        </section>

        {/* 核心動作 */}
        <div className="grid grid-cols-3 gap-2">
          <Button block onClick={() => navigate('/chat?c=' + character.id)}>
            開始聊天
          </Button>
          <Button block variant="secondary" onClick={() => navigate('/characters/' + character.id)}>
            編輯AI
          </Button>
          <Button block variant="secondary" onClick={() => navigate('/memories?c=' + character.id)}>
            查看記憶
          </Button>
        </div>

        {/* 詳細資訊 */}
        <section className="rounded-2xl bg-[var(--xl-card)] px-4 shadow-[var(--xl-shadow)]">
          <InfoRow label="關係階段" value={stage?.label ?? '—'} />
          <div className="border-t border-[var(--xl-mist)]" />
          <InfoRow
            label="最後聊天"
            value={character.runtime.lastMessageAt ? formatRelativeTime(character.runtime.lastMessageAt) : '還沒聊過'}
          />
          <div className="border-t border-[var(--xl-mist)]" />
          <InfoRow label="主動程度" value={String(character.proactivityLevel ?? '—')} />
          {character.personalityTags && character.personalityTags.length > 0 ? (
            <>
              <div className="border-t border-[var(--xl-mist)]" />
              <InfoRow label="個性標籤" value={character.personalityTags.join('、')} />
            </>
          ) : null}
        </section>

        <p className="px-2 pb-2 text-center text-[11px] leading-relaxed text-[var(--xl-sub)]/70">
          這是一個 AI 角色，不是真人，也不會取代你身邊的人。
        </p>
      </div>
    </>
  );
}

export default CharacterDetailPage;
