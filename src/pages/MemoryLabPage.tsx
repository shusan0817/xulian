/**
 * AI 記憶實驗室（需求 B：記憶實驗室）
 *
 * 把记忆 / 交流习惯 / 你的偏好 / 故事 四类「AI 对你的了解」聚合到一处，
 * 用分类筛选 + 客户端搜索做探索式浏览。纯只读——复用既有接口，不做任何 CRUD。
 */

import { useMemo, useState } from 'react';

import { AppHeader } from '@/components/common/AppHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAppState } from '@/hooks/useAppState';
import { useMemoryLab } from '@/hooks/useMemoryLab';
import {
  MEMORY_CATEGORY_LABELS,
  type HabitDimension,
  type InsightDimension,
} from '@shared/constants';
import type { AiHabit, MemoryItem, Story, UserInsight } from '@shared/types';
import { formatRelativeTime } from '@/utils/time';
import { ChevronDown } from 'lucide-react';

type LabCategory = 'all' | 'memory' | 'habit' | 'insight' | 'story';

const CATEGORY_TABS: { key: LabCategory; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'memory', label: '記憶' },
  { key: 'habit', label: '習慣' },
  { key: 'insight', label: '偏好' },
  { key: 'story', label: '故事' },
];

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

const STORY_TYPE_LABELS: Record<string, string> = {
  first_chat: '初次相遇',
  user_shared: '他的分享',
  shared_milestone: '一起的節點',
  user_saved: '你存的話題',
  habit_learned: '學到的習慣',
  special_interaction: '特別瞬間',
};

interface LabItem {
  key: string;
  category: Exclude<LabCategory, 'all'>;
  badge: string;
  text: string;
  time: string | null;
  metrics: { label: string; value: string }[];
  evidence: { label: string; value: string }[];
  searchBlob: string;
}

export function MemoryLabPage(): React.ReactElement {
  const { defaultCharacterId } = useAppState();
  const { data, loading, errors } = useMemoryLab(defaultCharacterId);
  const [category, setCategory] = useState<LabCategory>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const items = useMemo<LabItem[]>(() => {
    const out: LabItem[] = [];

    for (const m of data.memories) {
      out.push({
        key: 'mem-' + m.id,
        category: 'memory',
        badge: MEMORY_CATEGORY_LABELS[m.category] ?? m.category,
        text: m.content,
        time: m.createdAt,
        metrics:
          m.importance != null
            ? [{ label: '重要度', value: `${Math.round(m.importance * 100)}%` }]
            : [],
        evidence: [
          { label: '來源訊息', value: m.sourceMessageId ?? '—' },
          { label: '被引用', value: `${m.hitCount} 次` },
          {
            label: '最後使用',
            value: m.lastUsedAt ? formatRelativeTime(m.lastUsedAt) : '—',
          },
          { label: '建立於', value: m.createdAt ? formatRelativeTime(m.createdAt) : '—' },
        ],
        searchBlob: `${m.content} ${m.category}`.toLowerCase(),
      });
    }

    for (const h of data.habits) {
      out.push({
        key: 'habit-' + h.id,
        category: 'habit',
        badge: HABIT_DIM_LABELS[h.dimension] ?? h.dimension,
        text: h.valueLabel || h.value,
        time: h.createdAt,
        metrics: [{ label: '信心', value: `${Math.round(h.confidence * 100)}%` }],
        evidence: [
          { label: '狀態', value: h.status },
          { label: '觀察次數', value: `${h.observationCount}` },
          { label: '連續未復現', value: `${h.missCount}` },
          {
            label: '人格校驗',
            value: `${h.personaCheck}${h.personaCheckNote ? ' · ' + h.personaCheckNote : ''}`,
          },
          ...h.evidence.slice(0, 3).map((e) => ({
            label: '證據',
            value: `${e.quote} (${formatRelativeTime(e.at)})`,
          })),
        ],
        searchBlob: `${(h.valueLabel || h.value)} ${h.dimension}`.toLowerCase(),
      });
    }

    for (const ins of data.insights) {
      out.push({
        key: 'insight-' + ins.id,
        category: 'insight',
        badge: INSIGHT_DIM_LABELS[ins.dimension] ?? ins.dimension,
        text: ins.valueLabel || ins.value,
        time: ins.createdAt,
        metrics: [{ label: '信心', value: `${Math.round(ins.confidence * 100)}%` }],
        evidence: [
          { label: '狀態', value: ins.status },
          { label: '觀察次數', value: `${ins.observationCount}` },
          { label: '作用範圍', value: ins.characterScope || '全域' },
          ...ins.evidence.slice(0, 3).map((e) => ({
            label: '證據',
            value: `${e.quote} (${formatRelativeTime(e.at)})`,
          })),
        ],
        searchBlob: `${(ins.valueLabel || ins.value)} ${ins.dimension}`.toLowerCase(),
      });
    }

    for (const s of data.stories) {
      out.push({
        key: 'story-' + s.id,
        category: 'story',
        badge: STORY_TYPE_LABELS[s.type] ?? s.type,
        text: s.title,
        time: s.happenedAt,
        metrics:
          s.importance != null
            ? [{ label: '重要度', value: `${Math.round(s.importance * 100)}%` }]
            : [],
        evidence: [
          {
            label: '發生於',
            value: s.happenedAt ? formatRelativeTime(s.happenedAt) : '—',
          },
          { label: '摘要', value: s.summary || '—' },
          {
            label: '來源訊息',
            value: (s.sourceMessageIds ?? []).join(', ') || '—',
          },
          { label: '關聯記憶', value: s.sourceMemoryId ?? '—' },
          { label: '關聯習慣', value: s.sourceHabitId ?? '—' },
        ],
        searchBlob: `${s.title} ${s.summary} ${s.type}`.toLowerCase(),
      });
    }

    return out;
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== 'all' && it.category !== category) return false;
      if (q && !it.searchBlob.includes(q)) return false;
      return true;
    });
  }, [items, category, query]);

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <>
      <AppHeader title="記憶實驗室" subtitle="AI 對你了解多少" showBack={false} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 xl-no-scrollbar">
        {/* 分类筛选 tabs */}
        <div className="mb-3 flex gap-1.5 overflow-x-auto xl-no-scrollbar">
          {CATEGORY_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setCategory(t.key)}
              className={`flex-none rounded-full px-3 py-1 text-[12px] ${
                category === t.key
                  ? 'bg-[var(--xl-blush)] text-white'
                  : 'bg-[var(--xl-mist)] text-[var(--xl-ink)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 搜索框（纯客户端过滤） */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋 AI 記住的內容…"
          className="mb-3 w-full rounded-2xl bg-[var(--xl-mist)]/60 px-4 py-2.5 text-[14px] text-[var(--xl-ink)] outline-none placeholder:text-[var(--xl-sub)]"
        />

        {hasErrors ? (
          <div className="mb-3 rounded-2xl bg-[var(--xl-mist)]/60 p-3 text-[12px] text-[var(--xl-blush-deep)]">
            {Object.entries(errors).map(([k, v]) => (
              <p key={k}>部分資料載入失敗：{v}</p>
            ))}
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-[var(--xl-sub)]">載入中…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="🧪"
            title="還沒有可探索的內容"
            description="多聊幾次，AI 會慢慢記下關於你的事。"
          />
        ) : (
          <div className="space-y-2">
            {filtered.map((it) => {
              const open = expanded.has(it.key);
              return (
                <div
                  key={it.key}
                  className="rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex-none rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[10px] text-[var(--xl-sub)]">
                      {it.badge}
                    </span>
                    <p className="min-w-0 flex-1 text-[14px] leading-relaxed text-[var(--xl-ink)]">
                      {it.text}
                    </p>
                  </div>

                  <div className="mt-2 flex items-center gap-2 border-t border-[var(--xl-mist)] pt-2">
                    {it.metrics.map((m) => (
                      <span key={m.label} className="text-[10px] text-[var(--xl-sub)]/70">
                        {m.label} {m.value}
                      </span>
                    ))}
                    {it.time ? (
                      <span className="text-[10px] text-[var(--xl-sub)]/70">
                        {formatRelativeTime(it.time)}
                      </span>
                    ) : null}
                    <div className="flex-1" />
                    <button
                      onClick={() => toggle(it.key)}
                      className="flex items-center gap-0.5 rounded-full px-2 py-1 text-[11px] text-[var(--xl-sub)] active:opacity-70"
                    >
                      <ChevronDown
                        size={12}
                        className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
                      />
                      證據
                    </button>
                  </div>

                  {open ? (
                    <div className="mt-2 space-y-1 rounded-xl bg-[var(--xl-mist)]/50 p-2.5">
                      {it.evidence.map((e, i) => (
                        <div key={i} className="flex gap-2 text-[11px] leading-snug">
                          <span className="flex-none text-[var(--xl-sub)]">{e.label}</span>
                          <span className="min-w-0 flex-1 break-words text-[var(--xl-ink)]">
                            {e.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

export default MemoryLabPage;
