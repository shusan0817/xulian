/**
 * 记忆管理页（需求 §8）
 *
 * 用户必须能看见 AI 记住了什么，并且能修改、删除、全部清空、彻底关掉。
 * 这是"数据控制权归用户"最具体的一处落地。
 */

import { useState } from 'react';

import { AppHeader } from '@/components/common/AppHeader';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Modal } from '@/components/common/Modal';
import { Switch } from '@/components/common/Switch';
import { useMemories } from '@/hooks/useMemories';
import { useAppState } from '@/hooks/useAppState';
import { apiGet, apiPatch, humanizeError } from '@/api/client';
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS } from '@shared/constants';
import type { MemoryCategory } from '@shared/constants';
import { formatRelativeTime } from '@/utils/time';

export function MemoryPage(): React.ReactElement {
  const { defaultCharacterId, user, refresh: refreshApp } = useAppState();
  const { memories, loading, refresh, update, remove, clearAll } = useMemories(defaultCharacterId);

  const [filter, setFilter] = useState<MemoryCategory | 'all'>('all');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(
    user?.privacySettings.longTermMemoryEnabled ?? true,
  );

  const visible = filter === 'all' ? memories : memories.filter((m) => m.category === filter);

  const toggleMemory = async (): Promise<void> => {
    const next = !memoryEnabled;
    setMemoryEnabled(next);
    await apiPatch('/api/users/' + (user?.id ?? '') + '/settings', {
      longTermMemoryEnabled: next,
    });
    await refreshApp();
  };

  return (
    <>
      <AppHeader
        title="記憶"
        subtitle={`${memories.length} 則被記住的事`}
        showBack={false}
        right={
          memories.length > 0 ? (
            <button
              onClick={() => setConfirmClear(true)}
              className="text-[13px] text-[var(--xl-blush-deep)] active:opacity-60"
            >
              清空
            </button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {/* 长期记忆总开关 */}
        <div className="mb-3 flex items-center justify-between rounded-2xl bg-[var(--xl-card)] p-3.5 shadow-[var(--xl-shadow)]">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-[var(--xl-ink)]">長期記憶</p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--xl-sub)]">
              關閉後不再記新事，也不會在對話中提起舊事
            </p>
          </div>
          <Switch checked={memoryEnabled} onChange={() => void toggleMemory()} label="長期記憶" />
        </div>

        {/* 分类筛选 */}
        {memories.length > 0 ? (
          <div className="mb-3 flex gap-1.5 overflow-x-auto xl-no-scrollbar">
            <button
              onClick={() => setFilter('all')}
              className={`flex-none rounded-full px-3 py-1 text-[12px] ${
                filter === 'all'
                  ? 'bg-[var(--xl-blush)] text-white'
                  : 'bg-[var(--xl-mist)] text-[var(--xl-ink)]'
              }`}
            >
              全部
            </button>
            {MEMORY_CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`flex-none rounded-full px-3 py-1 text-[12px] ${
                  filter === c
                    ? 'bg-[var(--xl-blush)] text-white'
                    : 'bg-[var(--xl-mist)] text-[var(--xl-ink)]'
                }`}
              >
                {MEMORY_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        ) : null}

        {loading ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="🫧"
            title={memoryEnabled ? '還沒有被記住的事' : '長期記憶已關閉'}
            description={
              memoryEnabled
                ? 'AI 會在聊天中慢慢記下你在意的事。之後你可以在這裡查看、修改或刪除任何一條記憶。'
                : '關閉期間不會記錄新內容，已存在的記憶仍保留在這裡。'
            }
          />
        ) : (
          <div className="space-y-2">
            {visible.map((m) => (
              <div
                key={m.id}
                className="rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex-none rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
                    {MEMORY_CATEGORY_LABELS[m.category]}
                  </span>
                  <p className="min-w-0 flex-1 text-[14px] leading-relaxed text-[var(--xl-ink)]">
                    {m.content}
                  </p>
                </div>
                <div className="mt-2 flex items-center gap-2 border-t border-[var(--xl-mist)] pt-2">
                  <button
                    onClick={() => setEditing({ id: m.id, content: m.content })}
                    className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-sub)] active:opacity-70"
                  >
                    修改
                  </button>
                  <div className="flex-1" />
                  <span className="text-[10px] text-[var(--xl-sub)]/70">
                    {formatRelativeTime(m.createdAt)}
                  </span>
                  <button
                    onClick={() => void remove(m.id)}
                    className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                  >
                    刪除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑记忆 */}
      <Modal
        open={Boolean(editing)}
        title="修改記憶"
        onClose={() => setEditing(null)}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              block
              onClick={() => {
                if (!editing) return;
                void update(editing.id, { content: editing.content }).then(() =>
                  setEditing(null),
                );
              }}
            >
              儲存
            </Button>
          </div>
        }
      >
        <textarea
          value={editing?.content ?? ''}
          onChange={(e) =>
            setEditing((prev) => (prev ? { ...prev, content: e.target.value } : prev))
          }
          rows={3}
          className="w-full resize-none rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[15px] text-[var(--xl-ink)] outline-none"
        />
      </Modal>

      {/* 确认清空 */}
      <Modal
        open={confirmClear}
        title="清空全部記憶？"
        onClose={() => setConfirmClear(false)}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button
              block
              variant="danger"
              onClick={() => {
                void clearAll().then(() => setConfirmClear(false));
              }}
            >
              清空
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--xl-sub)]">
          所有被記住的事都會刪除，無法復原。聊天紀錄不會受影響。
        </p>
      </Modal>
    </>
  );
}

export default MemoryPage;
