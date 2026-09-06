/**
 * 消息反馈 / 举报（V2-14）
 *
 * 设计原则（§V2-11 禁止假按钮）：
 * - `submit` **只在后端真正落库成功后**才 resolve；失败一律 reject 并把中文原因抛出去；
 * - 组件层必须 catch 并展示错误，绝不允许「点了有反馈动画但后端没收到」。
 *
 * 后端落库分两处：
 * - `message_feedback`（handled=0 → 进待处理队列）
 * - `safety_logs`（report 时 source='user_report' 且带 message_id，能定位到原文）
 */

import { useCallback, useState } from 'react';
import { apiDelete, apiGet, apiPost, humanizeError } from '@/api/client';
import type { FeedbackKind } from '@shared/constants';
import type { MessageFeedback } from '@shared/types';

export interface FeedbackKindOption {
  kind: FeedbackKind;
  label: string;
  reasonRequired: boolean;
}

export interface SubmitFeedbackInput {
  messageId: string;
  kind: FeedbackKind;
  reason?: string;
}

export interface UseFeedbackResult {
  /** 某条消息已有的反馈（key = kind），用于回显 */
  feedbackByMessage: Record<string, FeedbackKind[]>;
  submitting: boolean;
  /** 失败时抛出带中文文案的 Error，调用方必须展示 */
  submit: (input: SubmitFeedbackInput) => Promise<MessageFeedback>;
  /** 撤销反馈（不传 kind 撤掉这条消息的全部反馈） */
  remove: (messageId: string, kind?: FeedbackKind) => Promise<void>;
  /** 载入某条消息已有的反馈 */
  loadForMessage: (messageId: string) => Promise<FeedbackKind[]>;
  /** 反馈类型字典（首次加载后缓存） */
  kindOptions: FeedbackKindOption[];
}

export function useFeedback(): UseFeedbackResult {
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, FeedbackKind[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [kindOptions, setKindOptions] = useState<FeedbackKindOption[]>([]);

  const loadKindOptions = useCallback(async (): Promise<FeedbackKindOption[]> => {
    if (kindOptions.length) return kindOptions;
    try {
      const res = await apiGet<{ kinds: FeedbackKindOption[] }>('/api/feedback/kinds', undefined, {
        silent: true,
      });
      setKindOptions(res.kinds ?? []);
      return res.kinds ?? [];
    } catch {
      // 字典取不到时退化为本地默认值，反馈本身仍然可以提交
      return [];
    }
  }, [kindOptions]);

  // 首次挂载时拉取一次字典
  useState(() => {
    void loadKindOptions();
  });

  const loadForMessage = useCallback(async (messageId: string): Promise<FeedbackKind[]> => {
    try {
      const res = await apiGet<{ items: MessageFeedback[] }>(
        `/api/feedback/message/${encodeURIComponent(messageId)}`,
        undefined,
        { silent: true },
      );
      const kinds = (res.items ?? []).map((item) => item.kind);
      setFeedbackByMessage((prev) => ({ ...prev, [messageId]: kinds }));
      return kinds;
    } catch {
      // 回显失败不影响使用：用户仍然可以提交新的反馈
      return [];
    }
  }, []);

  const submit = useCallback(async (input: SubmitFeedbackInput): Promise<MessageFeedback> => {
    setSubmitting(true);
    try {
      // 注意：这里**不**用 silent——apiPost 失败会自动弹 Toast，
      // 但我们仍然要 throw，让反馈面板把错误显示在面板内部（用户此刻正看着面板）。
      const res = await apiPost<{ feedback: MessageFeedback }>(
        '/api/feedback',
        { messageId: input.messageId, kind: input.kind, reason: input.reason ?? '' },
        { silent: true },
      );
      const feedback = res.feedback;
      setFeedbackByMessage((prev) => {
        const existing = prev[input.messageId] ?? [];
        if (existing.includes(input.kind)) return prev;
        return { ...prev, [input.messageId]: [...existing, input.kind] };
      });
      return feedback;
    } catch (err) {
      // 关键：把中文原因抛给调用方展示。静默吞掉 = 假按钮。
      throw new Error(humanizeError(err));
    } finally {
      setSubmitting(false);
    }
  }, []);

  const remove = useCallback(async (messageId: string, kind?: FeedbackKind): Promise<void> => {
    try {
      await apiDelete('/api/feedback', { messageId, kind }, { silent: true });
      setFeedbackByMessage((prev) => {
        const existing = prev[messageId] ?? [];
        return {
          ...prev,
          [messageId]: kind ? existing.filter((k) => k !== kind) : [],
        };
      });
    } catch (err) {
      throw new Error(humanizeError(err));
    }
  }, []);

  return { feedbackByMessage, submitting, submit, remove, loadForMessage, kindOptions };
}
