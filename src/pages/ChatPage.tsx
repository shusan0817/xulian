/**
 * 聊天页（需求 §15 手机聊天界面）
 *
 * 需求清单逐条对应：
 *  - AI 头像 / 用户头像        → MessageBubble 双头像
 *  - 消息气泡 / 时间 / 自动滚动 → 滚动容器 + 底部吸附
 *  - 流式输出 / 正在输入        → streaming 态 + 三点动画 + 阶段文案
 *  - 长按消息 / 删除 / 重新生成  → MessageBubble 长按菜单
 *  - 网络异常 / 失败重试        → error 条 + 重试按钮
 *  - 空状态页面                 → EmptyState
 *
 * 顶部不仅显示角色名，还显示**真实的** AI 当前情绪与关系阶段
 * （数据来自 /api/chat/state，不是写死的装饰）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Avatar } from '@/components/common/Avatar';
import { EmptyState } from '@/components/common/EmptyState';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { STAGE_LABELS } from '@/components/chat/strategyLabels';

import { useChat } from '@/hooks/useChat';
import { useAppState } from '@/hooks/useAppState';
import { apiGet, apiPost } from '@/api/client';
import { EMOTION_ANCHORS, STAGE_META } from '@shared/constants';
import type { EmotionType, RelationshipStage } from '@shared/constants';

interface CharacterState {
  emotion: { currentEmotion: EmotionType; intensity: number };
  relationship: { stage: RelationshipStage; interactionLevel: number };
}

export function ChatPage(): React.ReactElement {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { characters, defaultCharacterId, loading: appLoading } = useAppState();

  const urlCharacterId = params.get('c');
  const [characterId, setCharacterId] = useState<string | null>(urlCharacterId);

  // 没有指定角色时用默认角色
  useEffect(() => {
    if (!characterId && defaultCharacterId) setCharacterId(defaultCharacterId);
  }, [characterId, defaultCharacterId]);

  const character = useMemo(
    () => characters.find((c) => c.id === characterId) ?? null,
    [characters, characterId],
  );

  const chat = useChat({ characterId });
  const [state, setState] = useState<CharacterState | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 拉取真实的 AI 情绪与关系状态
  useEffect(() => {
    if (!characterId) return;
    void apiGet<CharacterState>(`/api/chat/state/${characterId}`)
      .then(setState)
      .catch(() => undefined);
  }, [characterId, chat.round.emotion, chat.round.relationship]);

  // 进入页面时把该角色的未读主动消息标记已读
  useEffect(() => {
    if (!characterId) return;
    void apiPost('/api/proactive/ack', { messageIds: [] }).catch(() => undefined);
  }, [characterId]);

  // 自动滚动到底部（流式输出时持续跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 只在用户本来就贴近底部时才强制滚动，避免打断向上翻记录
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [chat.messages]);

  const emotionLabel = character
    ? EMOTION_ANCHORS[
        (chat.round.emotion ?? state?.emotion.currentEmotion ?? character.runtime.emotion.currentEmotion)
      ]?.label
    : '';

  const stageLabel = character
    ? STAGE_META[
        chat.round.relationship?.stage ?? state?.relationship.stage ?? character.runtime.relationship.stage
      ]?.label
    : '';

  const subtitle = character
    ? [emotionLabel, stageLabel].filter(Boolean).join(' · ')
    : '載入中…';

  return (
    <>
      <AppHeader
        title={character?.name ?? '聊天'}
        subtitle={subtitle}
        showBack
        right={
          <button
            onClick={() => navigate('/characters')}
            className="flex h-10 w-10 items-center justify-center rounded-full active:bg-[var(--xl-mist)]/60"
            aria-label="切換角色"
          >
            <Avatar spec={character?.avatar ?? null} name={character?.name ?? '需'} size={30} ring />
          </button>
        }
      />

      {/* 错误提示条 */}
      {chat.error ? (
        <div className="flex-none border-b border-[var(--xl-blush)]/30 bg-[var(--xl-blush)]/10 px-4 py-2">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--xl-blush-deep)]">
              {chat.error}
            </p>
            {chat.canRetry ? (
              <button
                onClick={() => void chat.regenerate()}
                className="flex-none rounded-full bg-[var(--xl-blush)] px-3 py-1 text-[12px] text-white active:scale-95"
              >
                重試
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 消息列表 */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 xl-no-scrollbar"
      >
        {!characterId || appLoading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--xl-sub)]">
            載入中…
          </div>
        ) : chat.messages.length === 0 && !chat.generating ? (
          <div className="flex h-full flex-col justify-center">
            <EmptyState
              icon={character?.avatar?.value ?? '💬'}
              title={`和${character?.name ?? ''}說點什麼吧`}
              description={
                character
                  ? `${character.personality.slice(0, 40) || '這裡可以放心說話'}`
                  : '選一個角色開始聊天'
              }
              action={
                !character ? (
                  <button
                    onClick={() => navigate('/characters')}
                    className="rounded-full bg-[var(--xl-blush)] px-4 py-2 text-[13px] text-white"
                  >
                    去選角色
                  </button>
                ) : null
              }
            />
          </div>
        ) : (
          <>
            {chat.hasMore ? (
              <div className="mb-3 flex justify-center">
                <button
                  onClick={() => void chat.loadMore()}
                  className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[12px] text-[var(--xl-sub)]"
                >
                  載入更早的訊息
                </button>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              {chat.messages.map((m, index) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  aiAvatar={character?.avatar ?? null}
                  aiName={character?.name ?? 'AI'}
                  onDelete={(id) => void chat.removeMessage(id)}
                  onRegenerate={() => void chat.regenerate()}
                  showStrategy={index === chat.messages.length - 1}
                />
              ))}
            </div>

            {/* 生成中的阶段提示 */}
            {chat.generating && chat.stage ? (
              <p className="mt-2 pl-11 text-[11px] text-[var(--xl-sub)]">
                {STAGE_LABELS[chat.stage] ?? chat.stage}
              </p>
            ) : null}

            <div ref={bottomRef} />
          </>
        )}
      </div>

      <ChatComposer
        disabled={!characterId}
        generating={chat.generating}
        onSend={(text) => void chat.send(text)}
        onStop={chat.stop}
        placeholder={character ? `和${character.name}說點什麼…` : '說點什麼…'}
      />
    </>
  );
}

export default ChatPage;
