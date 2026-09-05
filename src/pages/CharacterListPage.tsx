/**
 * 角色列表页（需求 §17 角色管理）
 *
 * 每张卡片展示真实的运行态：当前情绪、关系阶段、最后一句、未读主动消息数。
 * 删除需要二次确认——角色带着会话、记忆、情绪与关系态，删了就回不来。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Avatar } from '@/components/common/Avatar';
import { EmptyState } from '@/components/common/EmptyState';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useAppState } from '@/hooks/useAppState';
import type { CharacterWithRuntime } from '@/hooks/useAppState';
import { apiDelete, apiPost } from '@/api/client';
import { EMOTION_ANCHORS, STAGE_META } from '@shared/constants';
import { formatRelativeTime } from '@/utils/time';

export function CharacterListPage(): React.ReactElement {
  const navigate = useNavigate();
  const { characters, defaultCharacterId, loading, refresh } = useAppState();
  const [pendingDelete, setPendingDelete] = useState<CharacterWithRuntime | null>(null);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    await apiDelete(`/api/characters/${pendingDelete.id}`);
    setPendingDelete(null);
    await refresh();
  };

  const setDefault = async (id: string): Promise<void> => {
    await apiPost(`/api/characters/${id}/default`, {});
    await refresh();
  };

  return (
    <>
      <AppHeader
        title="角色"
        showBack={false}
        right={
          <button
            onClick={() => navigate('/characters/new')}
            className="flex h-9 items-center rounded-full bg-[var(--xl-blush)] px-3 text-[13px] text-white active:scale-95"
          >
            新增
          </button>
        }
      />

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {loading ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : characters.length === 0 ? (
          <EmptyState
            icon="🌱"
            title="還沒有角色"
            description="建立第一個屬於你的 AI 陪伴角色。"
            action={
              <button
                onClick={() => navigate('/characters/new')}
                className="rounded-full bg-[var(--xl-blush)] px-5 py-2 text-[14px] text-white"
              >
                建立角色
              </button>
            }
          />
        ) : (
          characters.map((c) => {
            const emotion = EMOTION_ANCHORS[c.runtime.emotion.currentEmotion];
            const stage = STAGE_META[c.runtime.relationship.stage];
            const isDefault = c.id === defaultCharacterId;

            return (
              <div
                key={c.id}
                className="rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]"
              >
                <div className="flex items-start gap-3">
                  <button onClick={() => navigate(`/chat?c=${c.id}`)} className="flex-none">
                    <Avatar spec={c.avatar} name={c.name} size={48} ring={isDefault} />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-[15px] font-semibold text-[var(--xl-ink)]">
                        {c.name}
                      </h3>
                      {isDefault ? (
                        <span className="flex-none rounded-full bg-[var(--xl-mist)] px-1.5 py-0.5 text-[10px] text-[var(--xl-sub)]">
                          預設
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--xl-sub)]">
                      {emotion?.icon} {emotion?.label} · {stage?.label}
                      {c.runtime.lastMessageAt
                        ? ` · ${formatRelativeTime(c.runtime.lastMessageAt)}`
                        : ''}
                    </p>
                    <p className="mt-1 line-clamp-1 text-[12px] text-[var(--xl-sub)]/80">
                      {c.runtime.lastMessagePreview || c.personality || '還沒有對話'}
                    </p>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--xl-mist)] pt-2.5">
                  <button
                    onClick={() => navigate(`/characters/${c.id}`)}
                    className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[12px] text-[var(--xl-ink)] active:opacity-70"
                  >
                    編輯
                  </button>
                  {!isDefault ? (
                    <button
                      onClick={() => void setDefault(c.id)}
                      className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[12px] text-[var(--xl-ink)] active:opacity-70"
                    >
                      設為預設
                    </button>
                  ) : null}
                  <div className="flex-1" />
                  <button
                    onClick={() => setPendingDelete(c)}
                    className="rounded-full px-3 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                  >
                    刪除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <Modal
        open={Boolean(pendingDelete)}
        title={`刪除「${pendingDelete?.name ?? ''}」？`}
        onClose={() => setPendingDelete(null)}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button block variant="danger" onClick={() => void confirmDelete()}>
              刪除
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--xl-sub)]">
          這個角色的對話、記憶、情緒與關係狀態都會一併刪除，無法復原。
        </p>
      </Modal>
    </>
  );
}

export default CharacterListPage;
