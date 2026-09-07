/**
 * 纪念日编辑弹窗（需求：支持在 localStorage 存取自定义纪念日数据）
 *
 * 可设定：① 相识日期（驱动「我们已经相识 X 天」）② 任意自定义纪念日（生日 / 在一起 / 任何日子），
 * 支持新增 / 编辑 / 删除。保存即写入 localStorage（经 useAnniversary 的回调）。
 */

import { useState } from 'react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import type { CustomAnniversary } from '@/hooks/useAnniversary';

interface AnniversaryEditorProps {
  open: boolean;
  meetDate: string | null;
  custom: CustomAnniversary[];
  onClose: () => void;
  onSetMeet: (date: string | null) => void;
  onUpsert: (a: CustomAnniversary) => void;
  onRemove: (id: string) => void;
}

interface Draft {
  id: string | null;
  label: string;
  date: string;
  repeat: 'yearly' | 'once';
}

const emptyDraft = (): Draft => ({ id: null, label: '', date: '', repeat: 'yearly' });

export function AnniversaryEditor({
  open,
  meetDate,
  custom,
  onClose,
  onSetMeet,
  onUpsert,
  onRemove,
}: AnniversaryEditorProps): React.ReactElement {
  const [meet, setMeet] = useState(meetDate ?? '');
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);

  // 每次打开时同步外部 store 的最新值
  const syncFromProps = (): void => {
    setMeet(meetDate ?? '');
    setDraft(emptyDraft());
    setEditingId(null);
  };

  const saveMeet = (): void => {
    onSetMeet(meet || null);
  };

  const startAdd = (): void => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const startEdit = (a: CustomAnniversary): void => {
    setEditingId(a.id);
    setDraft({ id: a.id, label: a.label, date: a.date, repeat: a.repeat });
  };

  const saveDraft = (): void => {
    if (!draft.label.trim() || !draft.date) return;
    onUpsert({
      id: draft.id ?? `ann-${Date.now()}`,
      label: draft.label.trim(),
      date: draft.date,
      repeat: draft.repeat,
    });
    setDraft(emptyDraft());
    setEditingId(null);
  };

  return (
    <Modal
      open={open}
      title="紀念日設定"
      description="記錄你們的日子，TA 會在特別的那天給你驚喜。"
      onClose={() => {
        syncFromProps();
        onClose();
      }}
      closeOnMask={false}
      footer={
        <Button block variant="secondary" onClick={() => { syncFromProps(); onClose(); }}>
          完成
        </Button>
      }
    >
      <div className="space-y-4">
        {/* 相识日期 */}
        <div>
          <label className="text-[13px] font-medium text-[var(--xl-ink)]">我們的相識日</label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="date"
              value={meet}
              onChange={(e) => setMeet(e.target.value)}
              className="flex-1 rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[14px] text-[var(--xl-ink)] outline-none"
            />
            <Button variant="primary" onClick={saveMeet}>
              儲存
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--xl-sub)]">
            用來計算「我們已經相識 X 天」，並在 100 天 / 週年等日子觸發慶祝。
          </p>
        </div>

        {/* 自定义纪念日 */}
        <div className="border-t border-[var(--xl-mist)] pt-3">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-medium text-[var(--xl-ink)]">自訂紀念日</label>
            {editingId === null ? (
              <button onClick={startAdd} className="text-[12px] text-[var(--xl-blush-deep)] active:opacity-60">
                + 新增
              </button>
            ) : null}
          </div>

          {editingId === null ? (
            <div className="mt-2 space-y-2">
              {custom.length === 0 ? (
                <p className="text-[12px] text-[var(--xl-sub)]">還沒有。例如：生日、在一起那天。</p>
              ) : (
                custom.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-2xl bg-[var(--xl-mist)]/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] text-[var(--xl-ink)]">{a.label}</p>
                      <p className="text-[11px] text-[var(--xl-sub)]">
                        {a.date} · {a.repeat === 'yearly' ? '每年' : '單次'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => startEdit(a)}
                        className="rounded-full bg-[var(--xl-card)] px-2.5 py-1 text-[12px] text-[var(--xl-ink)] active:opacity-70"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => onRemove(a.id)}
                        className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="mt-2 space-y-2 rounded-2xl bg-[var(--xl-mist)]/40 p-3">
              <input
                type="text"
                value={draft.label}
                placeholder="名稱，如：生日"
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                className="w-full rounded-xl bg-[var(--xl-card)] px-3 py-2 text-[14px] text-[var(--xl-ink)] outline-none"
              />
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={draft.date}
                  onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                  className="flex-1 rounded-xl bg-[var(--xl-card)] px-3 py-2 text-[14px] text-[var(--xl-ink)] outline-none"
                />
                <select
                  value={draft.repeat}
                  onChange={(e) => setDraft({ ...draft, repeat: e.target.value as 'yearly' | 'once' })}
                  className="rounded-xl bg-[var(--xl-card)] px-2 py-2 text-[13px] text-[var(--xl-ink)] outline-none"
                >
                  <option value="yearly">每年</option>
                  <option value="once">單次</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Button block variant="secondary" onClick={() => { setDraft(emptyDraft()); setEditingId(null); }}>
                  取消
                </Button>
                <Button block onClick={saveDraft}>
                  儲存
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default AnniversaryEditor;
