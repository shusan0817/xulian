/**
 * 我们的故事（需求 V2-2）
 *
 * 时间线页面：把 AI 与用户之间发生过的故事按日期分组呈现，
 * 支持新增 / 编辑 / 删除 / 还原。全部读写真实接口，无假数据。
 */

import { useMemo, useState } from 'react';
import {
  BookOpen,
  Pin,
  Pencil,
  Trash2,
  RotateCcw,
  Plus,
} from 'lucide-react';

import { AppHeader } from '@/components/common/AppHeader';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Modal } from '@/components/common/Modal';
import { Switch } from '@/components/common/Switch';
import { useAppState } from '@/hooks/useAppState';
import { useStories } from '@/hooks/useStories';
import type { Story } from '@shared/types';
import type { StoryType } from '@shared/constants';
import { formatDateDivider } from '@/utils/time';

const TYPE_LABELS: Record<StoryType, string> = {
  first_chat: '初次相遇 🌱',
  user_shared: '他的分享 💬',
  shared_milestone: '一起的節點 ⭐',
  user_saved: '你存的話題 📌',
  habit_learned: '學到的習慣 🧠',
  special_interaction: '特別瞬間 ✨',
};

const NEW_STORY_TYPES: StoryType[] = [
  'first_chat',
  'user_shared',
  'shared_milestone',
  'user_saved',
  'habit_learned',
  'special_interaction',
];

interface EditForm {
  title: string;
  summary: string;
  importance: number;
  pinned: boolean;
}

export function StoryPage(): React.ReactElement {
  const { defaultCharacterId, characters } = useAppState();
  const character =
    characters.find((c) => c.id === defaultCharacterId) ?? characters[0] ?? null;

  const {
    stories,
    total,
    loading,
    error,
    refresh,
    updateStory,
    removeStory,
    restoreStory,
    addStory,
  } = useStories(character?.id);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: '',
    summary: '',
    importance: 0.5,
    pinned: false,
  });

  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState<{ title: string; summary: string; type: StoryType }>({
    title: '',
    summary: '',
    type: 'user_saved',
  });
  const [addError, setAddError] = useState<string | null>(null);
  const [savingAdd, setSavingAdd] = useState(false);

  // 按日期分组：API 已按 happenedAt 倒序，这里顺次切分即可
  const groups = useMemo(() => {
    const out: { label: string; items: Story[] }[] = [];
    for (const story of stories) {
      const label = formatDateDivider(story.happenedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(story);
      else out.push({ label, items: [story] });
    }
    return out;
  }, [stories]);

  if (!character) {
    return (
      <>
        <AppHeader title="我們的故事" subtitle="你們之間發生過的事" showBack={false} />
        <EmptyState
          icon="🌱"
          title="還沒有陪伴角色"
          description="先建立一個 AI 角色，開始你們之間的故事吧。"
        />
      </>
    );
  }

  const openEditor = (story: Story): void => {
    setEditingId(story.id);
    setEditForm({
      title: story.title,
      summary: story.summary,
      importance: story.importance,
      pinned: story.pinned,
    });
  };

  const closeEditor = (): void => setEditingId(null);

  const saveEdit = async (id: string): Promise<void> => {
    await updateStory(id, {
      title: editForm.title.trim(),
      summary: editForm.summary.trim(),
      importance: editForm.importance,
      pinned: editForm.pinned,
    });
    closeEditor();
  };

  const handleDelete = async (id: string): Promise<void> => {
    if (!window.confirm('確定要刪除這則故事嗎？')) return;
    await removeStory(id);
  };

  const handleRestore = async (id: string): Promise<void> => {
    await restoreStory(id);
  };

  const submitAdd = async (): Promise<void> => {
    if (!addForm.title.trim() || !addForm.summary.trim()) {
      setAddError('標題與內容都不能為空');
      return;
    }
    setSavingAdd(true);
    setAddError(null);
    try {
      await addStory({
        characterId: character!.id,
        type: addForm.type,
        title: addForm.title.trim(),
        summary: addForm.summary.trim(),
      });
      setAdding(false);
      setAddForm({ title: '', summary: '', type: 'user_saved' });
    } catch {
      setAddError('新增失敗，請再試一次');
    } finally {
      setSavingAdd(false);
    }
  };

  return (
    <>
      <AppHeader
        title="我們的故事"
        subtitle="你們之間發生過的事"
        showBack={false}
        right={
          <span className="rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
            {total} 則
          </span>
        }
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {loading ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : error ? (
          <EmptyState
            icon="⚠️"
            title="載入失敗"
            description={error}
            action={
              <button
                onClick={() => void refresh()}
                className="rounded-full bg-[var(--xl-blush)] px-5 py-2 text-[14px] text-white active:scale-95"
              >
                重試
              </button>
            }
          />
        ) : stories.length === 0 ? (
          <EmptyState
            icon="📖"
            title="還沒有故事"
            description="還沒有故事，聊聊天，AI 會記下你們之間的事。"
          />
        ) : (
          groups.map((group) => (
            <section key={group.label} className="space-y-2">
              <div className="flex items-center gap-2 px-1 pt-1">
                <span className="text-[11px] font-medium text-[var(--xl-sub)]">{group.label}</span>
                <span className="h-px flex-1 bg-[var(--xl-mist)]" />
              </div>

              {group.items.map((story) => {
                const editing = editingId === story.id;
                return (
                  <div
                    key={story.id}
                    className="rounded-3xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]"
                  >
                    <div className="flex items-start gap-2">
                      <span className="flex-none rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
                        {TYPE_LABELS[story.type]}
                      </span>
                      {story.pinned ? (
                        <Pin size={14} className="mt-1 flex-none text-[var(--xl-blush-deep)]" aria-label="置頂" />
                      ) : null}
                    </div>

                    {editing ? (
                      <div className="mt-3 space-y-3">
                        <textarea
                          value={editForm.title}
                          onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                          rows={2}
                          placeholder="標題"
                          className="w-full resize-none rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[15px] font-medium text-[var(--xl-ink)] outline-none"
                        />
                        <textarea
                          value={editForm.summary}
                          onChange={(e) => setEditForm((f) => ({ ...f, summary: e.target.value }))}
                          rows={3}
                          placeholder="內容"
                          className="w-full resize-none rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[14px] leading-relaxed text-[var(--xl-sub)] outline-none"
                        />
                        <div>
                          <div className="flex items-center justify-between text-[12px] text-[var(--xl-sub)]">
                            <span>重要程度</span>
                            <span>{Math.round(editForm.importance * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.1}
                            value={editForm.importance}
                            onChange={(e) =>
                              setEditForm((f) => ({ ...f, importance: Number(e.target.value) }))
                            }
                            className="mt-1 w-full accent-[var(--xl-blush)]"
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] text-[var(--xl-ink)]">置頂</span>
                          <Switch
                            checked={editForm.pinned}
                            onChange={(v) => setEditForm((f) => ({ ...f, pinned: v }))}
                            label="置頂"
                          />
                        </div>

                        <div className="flex gap-2">
                          <Button block variant="secondary" onClick={closeEditor}>
                            取消
                          </Button>
                          <Button block onClick={() => void saveEdit(story.id)}>
                            儲存
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <h3 className="mt-2 text-[15px] font-semibold text-[var(--xl-ink)]">
                          {story.title}
                        </h3>
                        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-[var(--xl-sub)]">
                          {story.summary}
                        </p>

                        <div className="mt-3 flex items-center gap-2 border-t border-[var(--xl-mist)] pt-2">
                          <button
                            onClick={() => openEditor(story)}
                            className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-sub)] active:opacity-70"
                          >
                            編輯
                          </button>
                          {story.isUserEdited ? (
                            <button
                              onClick={() => void handleRestore(story.id)}
                              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-sub)] active:opacity-70"
                            >
                              <RotateCcw size={12} /> 還原
                            </button>
                          ) : null}
                          <div className="flex-1" />
                          <button
                            onClick={() => void handleDelete(story.id)}
                            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                          >
                            <Trash2 size={12} /> 刪除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>

      {/* 悬浮新增按钮 */}
      {!loading && !error && character ? (
        <button
          onClick={() => {
            setAddError(null);
            setAdding(true);
          }}
          className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--xl-blush)] text-white shadow-[var(--xl-shadow)] active:scale-95 xl-safe-bottom"
          aria-label="新增故事"
        >
          <Plus size={24} />
        </button>
      ) : null}

      {/* 新增故事表单 */}
      <Modal
        open={adding}
        title="新增故事"
        onClose={() => setAdding(false)}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setAdding(false)}>
              取消
            </Button>
            <Button block onClick={() => void submitAdd()} loading={savingAdd}>
              新增
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <select
            value={addForm.type}
            onChange={(e) => setAddForm((f) => ({ ...f, type: e.target.value as StoryType }))}
            className="w-full rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[14px] text-[var(--xl-ink)] outline-none"
          >
            {NEW_STORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <input
            value={addForm.title}
            onChange={(e) => setAddForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="標題"
            className="w-full rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[15px] text-[var(--xl-ink)] outline-none"
          />
          <textarea
            value={addForm.summary}
            onChange={(e) => setAddForm((f) => ({ ...f, summary: e.target.value }))}
            rows={4}
            placeholder="發生了什麼？"
            className="w-full resize-none rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[14px] leading-relaxed text-[var(--xl-ink)] outline-none"
          />
          {addError ? <p className="text-[12px] text-[var(--xl-blush-deep)]">{addError}</p> : null}
        </div>
      </Modal>
    </>
  );
}

export default StoryPage;
