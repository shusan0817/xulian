/**
 * AI 了解的你（Learned Preferences）管理页（V2-3 / V2-4）
 *
 * 把"AI 后天学到关于你的事"摊在阳光下，且用户能逐条：
 *  - 查看（交流习惯 / 你的偏好两个区块）
 *  - 确认（认可这条，直接 active）
 *  - 修改（改写标签，改过就不再被自动推断覆盖）
 *  - 删除（软删除）
 *  - 一键重置全部交流习惯（人格一字不动，只清后天习惯）
 *
 * 这是"数据控制权归用户"最具体的一处落地，也直接对应验收标准里
 * "Learned Preferences 可查看 / 修改 / 删除"。
 */

import { useEffect, useState } from 'react';

import { AppHeader } from '@/components/common/AppHeader';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Modal } from '@/components/common/Modal';
import { useAppState } from '@/hooks/useAppState';
import { apiDelete, apiGet, apiPatch, apiPost, humanizeError } from '@/api/client';
import {
  HABIT_DIMENSIONS,
  INSIGHT_DIMENSIONS,
  type HabitDimension,
  type InsightDimension,
} from '@shared/constants';
import type { AiHabit, UserInsight } from '@shared/types';

/** 习惯维度 → 展示文案（本地定义，避免后端无 label map） */
const HABIT_DIM_LABELS: Record<HabitDimension, string> = {
  address_style: '稱呼方式',
  reply_pacing: '回覆節奏',
  question_style: '提問風格',
  topic_preference: '話題偏好',
  shared_ritual: '共同儀式',
};

/** 偏好维度 → 展示文案 */
const INSIGHT_DIM_LABELS: Record<InsightDimension, string> = {
  reply_length: '回覆長度',
  advice_vs_listen: '建議 vs 傾聽',
  question_tolerance: '被追問耐受度',
  topic_interest: '感興趣的話題',
  proactive_timing: '主動時機',
  tone_preference: '語氣偏好',
};

const HABIT_STATUS_LABEL: Record<AiHabit['status'], string> = {
  candidate: '觀察中',
  active: '已生效',
  archived: '已封存',
};

const INSIGHT_STATUS_LABEL: Record<UserInsight['status'], string> = {
  candidate: '觀察中',
  active: '已生效',
  rejected: '已捨棄',
};

/** 把后端返回的 habit / insight 列表响应类型化 */
interface HabitsResponse {
  habits: AiHabit[];
}
interface InsightsResponse {
  insights: UserInsight[];
}

export function LearnedPage(): React.ReactElement {
  const { defaultCharacterId } = useAppState();

  const [habits, setHabits] = useState<AiHabit[]>([]);
  const [insights, setInsights] = useState<UserInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<
    { kind: 'habit' | 'insight'; id: string; label: string } | null
  >(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setLoading(true);
      const [h, i] = await Promise.all([
        apiGet<HabitsResponse>('/api/habits', { includeCandidate: '1' }, { silent: true }),
        apiGet<InsightsResponse>('/api/insights', {}, { silent: true }),
      ]);
      setHabits(h.habits ?? []);
      setInsights(i.insights ?? []);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const confirmHabit = async (id: string): Promise<void> => {
    await apiPost(`/api/habits/${id}/confirm`);
    await refresh();
  };
  const deleteHabit = async (id: string): Promise<void> => {
    await apiDelete(`/api/habits/${id}`);
    await refresh();
  };
  const confirmInsight = async (id: string): Promise<void> => {
    await apiPost(`/api/insights/${id}/confirm`);
    await refresh();
  };
  const deleteInsight = async (id: string): Promise<void> => {
    await apiDelete(`/api/insights/${id}`);
    await refresh();
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    const label = editing.label.trim();
    if (!label) return;
    if (editing.kind === 'habit') {
      await apiPatch(`/api/habits/${editing.id}`, { valueLabel: label });
    } else {
      await apiPatch(`/api/insights/${editing.id}`, { valueLabel: label });
    }
    setEditing(null);
    await refresh();
  };

  const resetHabits = async (): Promise<void> => {
    if (!defaultCharacterId) return;
    await apiPost('/api/habits/reset', { characterId: defaultCharacterId });
    setConfirmReset(false);
    await refresh();
  };

  const pct = (c: number): string => `${Math.round(c * 100)}%`;

  return (
    <>
      <AppHeader
        title="AI 了解的你"
        subtitle={`${habits.length} 項習慣 · ${insights.length} 項偏好`}
        showBack={false}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {/* 说明卡片 */}
        <div className="mb-3 rounded-2xl bg-[var(--xl-card)] p-3.5 shadow-[var(--xl-shadow)]">
          <p className="text-[13px] leading-relaxed text-[var(--xl-sub)]">
            這裡記錄 AI 在相處中慢慢學到的關於你的事。它們都<strong className="text-[var(--xl-ink)]">可以查看、修改、刪除</strong>，
            改成你認可的樣子，或一键清空後天習慣（核心人格不會變）。
          </p>
        </div>

        {loading ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : error ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-blush-deep)]">{error}</div>
        ) : (
          <div className="space-y-5">
            {/* ===== 交流習慣 ===== */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] font-medium text-[var(--xl-ink)]">交流習慣</h2>
                {habits.length > 0 ? (
                  <button
                    onClick={() => setConfirmReset(true)}
                    className="text-[12px] text-[var(--xl-sub)] active:opacity-60"
                  >
                    重置全部
                  </button>
                ) : null}
              </div>

              {habits.length === 0 ? (
                <EmptyState
                  icon="🌱"
                  title="還沒有形成的習慣"
                  description="多聊幾次，AI 會慢慢記住你喜歡的相處方式。"
                />
              ) : (
                <div className="space-y-2">
                  {habits.map((h) => (
                    <div
                      key={h.id}
                      className="rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]"
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 flex-none rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
                          {HABIT_DIM_LABELS[h.dimension] ?? h.dimension}
                        </span>
                        <p className="min-w-0 flex-1 text-[14px] leading-relaxed text-[var(--xl-ink)]">
                          {h.valueLabel || h.value}
                        </p>
                      </div>
                      <div className="mt-2 flex items-center gap-2 border-t border-[var(--xl-mist)] pt-2">
                        <span className="rounded-full bg-[var(--xl-mist)]/70 px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
                          {HABIT_STATUS_LABEL[h.status]}
                        </span>
                        <span className="text-[10px] text-[var(--xl-sub)]/70">
                          信心 {pct(h.confidence)}
                        </span>
                        <div className="flex-1" />
                        {h.status !== 'active' ? (
                          <button
                            onClick={() => void confirmHabit(h.id)}
                            className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                          >
                            確認
                          </button>
                        ) : null}
                        <button
                          onClick={() => setEditing({ kind: 'habit', id: h.id, label: h.valueLabel || h.value })}
                          className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-sub)] active:opacity-70"
                        >
                          修改
                        </button>
                        <button
                          onClick={() => void deleteHabit(h.id)}
                          className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                        >
                          刪除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ===== 你的偏好 ===== */}
            <section>
              <h2 className="mb-2 text-[13px] font-medium text-[var(--xl-ink)]">你的偏好</h2>
              {insights.length === 0 ? (
                <EmptyState
                  icon="💡"
                  title="還沒有歸納出的偏好"
                  description="AI 會從對話裡觀察你喜歡什麼、在意什麼，確認後就會被記住。"
                />
              ) : (
                <div className="space-y-2">
                  {insights.map((ins) => (
                    <div
                      key={ins.id}
                      className="rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]"
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 flex-none rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
                          {INSIGHT_DIM_LABELS[ins.dimension] ?? ins.dimension}
                        </span>
                        <p className="min-w-0 flex-1 text-[14px] leading-relaxed text-[var(--xl-ink)]">
                          {ins.valueLabel || ins.value}
                        </p>
                      </div>
                      <div className="mt-2 flex items-center gap-2 border-t border-[var(--xl-mist)] pt-2">
                        <span className="rounded-full bg-[var(--xl-mist)]/70 px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
                          {INSIGHT_STATUS_LABEL[ins.status]}
                        </span>
                        {ins.isUserEdited ? (
                          <span className="text-[10px] text-[var(--xl-sub)]/70">你改過</span>
                        ) : null}
                        <div className="flex-1" />
                        {ins.status !== 'active' ? (
                          <button
                            onClick={() => void confirmInsight(ins.id)}
                            className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                          >
                            確認
                          </button>
                        ) : null}
                        <button
                          onClick={() => setEditing({ kind: 'insight', id: ins.id, label: ins.valueLabel || ins.value })}
                          className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-sub)] active:opacity-70"
                        >
                          修改
                        </button>
                        <button
                          onClick={() => void deleteInsight(ins.id)}
                          className="rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)] active:opacity-70"
                        >
                          刪除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* 修改标签 */}
      <Modal
        open={Boolean(editing)}
        title="修改內容"
        onClose={() => setEditing(null)}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button block onClick={() => void saveEdit()}>
              儲存
            </Button>
          </div>
        }
      >
        <textarea
          value={editing?.label ?? ''}
          onChange={(e) =>
            setEditing((prev) => (prev ? { ...prev, label: e.target.value } : prev))
          }
          rows={3}
          className="w-full resize-none rounded-xl bg-[var(--xl-mist)]/60 px-3 py-2 text-[15px] text-[var(--xl-ink)] outline-none"
        />
      </Modal>

      {/* 确认重置习惯 */}
      <Modal
        open={confirmReset}
        title="重置全部交流習慣？"
        onClose={() => setConfirmReset(false)}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setConfirmReset(false)}>
              取消
            </Button>
            <Button block variant="danger" onClick={() => void resetHabits()}>
              重置
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--xl-sub)]">
          所有後天形成的交流習慣會被封存，AI 會重新觀察你。核心人格設定不受影響。
        </p>
      </Modal>
    </>
  );
}

export default LearnedPage;
