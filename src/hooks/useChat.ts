/**
 * 聊天状态管理（需求 §15 手机聊天界面）
 *
 * 关键设计：
 * 1. **乐观渲染**：用户消息先上屏再等服务端确认，避免"点发送后卡住"的手感问题；
 *    meta 事件回来后用真实 ID 替换临时 ID。
 * 2. **流式累积**：text 事件是增量 delta，拼到当前助手消息上；
 *    replace 事件表示服务端做了安全改写，直接整体替换。
 * 3. **可中断**：点「停止」时 abort，已生成的部分保留（不浪费已输出内容）。
 * 4. **失败可重试**：error 事件带 retryable，界面提供「重新生成」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, humanizeError } from '@/api/client';
import { postSse } from '@/api/sse';
import { applyAiReply, extractReply } from '@/store/favorabilityStore';
import type { ChatSseEvent, SseStage } from '@shared/sse';
import type { EmotionType, MemoryCategory, RelationshipStage, StrategyType } from '@shared/constants';
import type { MessageRecord } from '@shared/types';

/** 界面用的消息：可能还在流式生成中 */
export interface ChatMessage extends MessageRecord {
  /** 本地乐观插入、尚未被服务端确认 */
  pending?: boolean;
  /** 正在流式生成 */
  streaming?: boolean;
}

export interface RoundState {
  strategy: StrategyType | null;
  strategyReason: string | null;
  emotion: EmotionType | null;
  emotionIntensity: number;
  relationship: { stage: RelationshipStage; level: number; leveledUp: boolean } | null;
  memories: Array<{ id: string; content: string; category: MemoryCategory }>;
}

export interface UseChatResult {
  messages: ChatMessage[];
  loadingHistory: boolean;
  /** 是否正在生成（含"正在输入"指示） */
  generating: boolean;
  stage: SseStage | null;
  round: RoundState;
  error: string | null;
  /** 最近一次请求是否可重试 */
  canRetry: boolean;
  send: (text: string) => Promise<void>;
  stop: () => void;
  regenerate: () => Promise<void>;
  removeMessage: (messageId: string) => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
}

interface UseChatOptions {
  userId?: string;
  characterId: string | null;
  conversationId?: string | null;
}

export function useChat(options: UseChatOptions): UseChatResult {
  const { characterId, conversationId } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState<SseStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const [round, setRound] = useState<RoundState>({
    strategy: null,
    strategyReason: null,
    emotion: null,
    emotionIntensity: 0,
    relationship: null,
    memories: [],
  });

  const activeConversationId = useRef<string | null>(conversationId ?? null);
  const controllerRef = useRef<AbortController | null>(null);
  const lastUserText = useRef<string>('');
  const streamingIdRef = useRef<string | null>(null);
  const rawReplyRef = useRef<string>('');

  // 切换角色时清空会话
  useEffect(() => {
    activeConversationId.current = conversationId ?? null;
    setMessages([]);
    setRound({
      strategy: null,
      strategyReason: null,
      emotion: null,
      emotionIntensity: 0,
      relationship: null,
      memories: [],
    });
  }, [characterId, conversationId]);

  // ---- 加载历史 ----
  const loadHistory = useCallback(
    async (convId: string): Promise<void> => {
      try {
        setLoadingHistory(true);
        const page = await apiGet<{ messages: MessageRecord[]; hasMore: boolean }>(
          `/api/chat/conversations/${convId}/messages`,
          { limit: 30 },
          { silent: true },
        );
        const cleaned = (page.messages as ChatMessage[]).map((m) =>
          m.role === 'assistant' ? { ...m, content: extractReply(m.content) } : m,
        );
        setMessages(cleaned);
        setHasMore(page.hasMore);
      } catch (err) {
        setError(humanizeError(err));
      } finally {
        setLoadingHistory(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (conversationId) {
      activeConversationId.current = conversationId;
      void loadHistory(conversationId);
    }
  }, [conversationId, loadHistory]);

  // ---- 事件处理 ----
  const handleEvent = useCallback((event: ChatSseEvent): void => {
    switch (event.type) {
      case 'meta': {
        activeConversationId.current = event.conversationId;
        // 用户消息：把本地乐观插入的那条换成服务端真实 ID
        setMessages((prev) => {
          const withoutPending = prev.filter((m) => !m.pending);
          const confirmed: ChatMessage = {
            id: event.userMessageId,
            conversationId: event.conversationId,
            userId: '',
            characterId: event.characterId,
            role: 'user',
            content: lastUserText.current,
            aiEmotion: null,
            aiEmotionIntensity: null,
            strategy: null,
            userEmotion: null,
            isProactive: false,
            isRead: true,
            errorCode: null,
            meta: {},
            createdAt: new Date().toISOString(),
          };
          // 助手占位（马上会被流式内容填充）
          const assistant: ChatMessage = {
            ...confirmed,
            id: event.assistantMessageId,
            role: 'assistant',
            content: '',
            streaming: true,
          };
          streamingIdRef.current = event.assistantMessageId;
          return [...withoutPending, confirmed, assistant];
        });
        break;
      }

      case 'status':
        setStage(event.stage);
        break;

      case 'text':
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingIdRef.current ? { ...m, content: m.content + event.content } : m,
          ),
        );
        rawReplyRef.current += event.content;
        break;

      case 'replace':
        // 服务端安全改写：整体替换已输出内容
        setMessages((prev) =>
          prev.map((m) => (m.id === streamingIdRef.current ? { ...m, content: event.content } : m)),
        );
        rawReplyRef.current = event.content;
        break;

      case 'strategy':
        setRound((prev) => ({ ...prev, strategy: event.strategy, strategyReason: event.reason }));
        break;

      case 'emotion':
        setRound((prev) => ({
          ...prev,
          emotion: event.emotion,
          emotionIntensity: event.intensity,
        }));
        break;

      case 'memory':
        setRound((prev) => ({ ...prev, memories: [...prev.memories, ...event.items] }));
        break;

      case 'relationship':
        setRound((prev) => ({
          ...prev,
          relationship: {
            stage: event.stage,
            level: event.interactionLevel,
            leveledUp: event.leveledUp,
          },
        }));
        break;

      case 'done': {
        const id = streamingIdRef.current;
        const raw = rawReplyRef.current;
        rawReplyRef.current = '';
        const display = applyAiReply(raw); // 在 updater 外调用，避免 StrictMode 双调用导致好感度翻倍
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: display, streaming: false } : m)),
        );
        streamingIdRef.current = null;
        setStage(null);
        break;
      }

      case 'error':
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingIdRef.current
              ? { ...m, streaming: false, errorCode: event.code }
              : m,
          ),
        );
        streamingIdRef.current = null;
        rawReplyRef.current = '';
        setError(event.message);
        setCanRetry(event.retryable);
        setStage(null);
        break;
    }
  }, []);

  // ---- 发送 ----
  const send = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim();
      if (!content || !characterId || generating) return;

      lastUserText.current = content;
      setError(null);
      setCanRetry(false);
      setGenerating(true);

      // 乐观插入用户消息
      const tempId = `temp-${Date.now()}`;
      setMessages((prev) => [
        ...prev.filter((m) => !m.pending),
        {
          id: tempId,
          conversationId: activeConversationId.current ?? '',
          userId: '',
          characterId,
          role: 'user',
          content,
          aiEmotion: null,
          aiEmotionIntensity: null,
          strategy: null,
          userEmotion: null,
          isProactive: false,
          isRead: true,
          errorCode: null,
          meta: {},
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ]);

      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        await postSse(
          '/api/chat/stream',
          {
            characterId,
            conversationId: activeConversationId.current ?? undefined,
            text: content,
          },
          { onEvent: handleEvent },
          { signal: controller.signal },
        );
      } catch (err) {
        // 主动中断不算错误
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(humanizeError(err));
          setCanRetry(true);
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === streamingIdRef.current ? { ...m, streaming: false } : m)),
        );
        streamingIdRef.current = null;
      } finally {
        setGenerating(false);
        setStage(null);
        controllerRef.current = null;
      }
    },
    [characterId, generating, handleEvent],
  );

  const stop = useCallback((): void => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setGenerating(false);
  }, []);

  /** 重新生成：删掉最后一条助手消息后重发上一条用户消息 */
  const regenerate = useCallback(async (): Promise<void> => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || !characterId) return;

    const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
    setMessages((prev) =>
      lastAssistantId ? prev.filter((m) => m.id !== lastAssistantId) : prev,
    );

    setError(null);
    setGenerating(true);
    lastUserText.current = lastUser.content;

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      await postSse(
        '/api/chat/regenerate',
        { characterId, conversationId: activeConversationId.current },
        { onEvent: handleEvent },
        { signal: controller.signal },
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(humanizeError(err));
      }
    } finally {
      setGenerating(false);
      setStage(null);
      controllerRef.current = null;
    }
  }, [messages, characterId, handleEvent]);

  const removeMessage = useCallback(async (messageId: string): Promise<void> => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await apiDelete(`/api/chat/messages/${messageId}`);
    } catch {
      // 删除失败不回滚：本地已经移除，下次刷新以服务端为准
    }
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    const convId = activeConversationId.current;
    if (!convId || !messages.length) return;
    try {
      const page = await apiGet<{ messages: MessageRecord[]; hasMore: boolean }>(
        `/api/chat/conversations/${convId}/messages`,
        { limit: 30, before: messages[0].createdAt },
      );
      setMessages((prev) => [...(page.messages as ChatMessage[]), ...prev]);
      setHasMore(page.hasMore);
    } catch {
      // 加载更多失败时静默，不影响已有内容
    }
  }, [messages]);

  return {
    messages,
    loadingHistory,
    generating,
    stage,
    round,
    error,
    canRetry,
    send,
    stop,
    regenerate,
    removeMessage,
    loadMore,
    hasMore,
  };
}
