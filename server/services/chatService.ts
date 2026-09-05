/**
 * 聊天编排服务（需求 §24 的完整流程实现）
 *
 *  用戶發送消息 → 內容安全檢查 → 讀取 Persona → 讀取 AI 情緒 → 分析用戶情緒
 *  → 分析意圖 → 短期記憶 → 長期記憶 → 關係階段 → 選擇策略 → 構建 Prompt
 *  → 流式生成 → 出方向安全檢查 → 顯示 → 更新 AI 情緒 → 抽取長期記憶
 *  → 更新關係 → 保存消息
 *
 * 编排原则（很重要）：
 * 1. **先落库用户消息，再生成**。前端拿到 meta 事件就知道真实 messageId，
 *    刷新页面不会丢消息；生成失败时也能看到自己说过的话 + 重试按钮。
 * 2. **后处理全部异步容错**。情绪更新、记忆抽取、关系推进任何一步失败，
 *    都只记日志不影响本轮回复——用户已经等了几十秒，不能因为"记笔记失败"而看不到回复。
 * 3. **出方向安全是硬闸**。模型输出先过红线检查，命中就用 replace 事件整体替换，
 *    改不出来就用兜底文案。这条防线不依赖模型自觉。
 */

import type { ChatStreamInput } from '../types.js';
import type { SseStage } from '../../shared/sse.js';
import type { ChatSseEvent } from '../../shared/sse.js';
import { SSE_STAGE_LABELS } from '../../shared/sse.js';
import type { AICharacter, Conversation, MessageRecord, MemoryItem } from '../../shared/types.js';
import type { ChatContext } from '../types.js';
import type { StrategyType } from '../../shared/constants.js';

import { buildSystemPrompt, buildUserPrompt } from '../agent/prompts.js';
import { streamText } from '../agent/sdkClient.js';
import { SdkCallError } from '../agent/errors.js';

import * as conversationsRepo from '../db/repositories/conversations.repo.js';
import * as usersRepo from '../db/repositories/users.repo.js';
import * as statesRepo from '../db/repositories/states.repo.js';
import { newId } from '../db/helpers.js';
import { logger } from '../logger.js';

import * as safetyService from './safetyService.js';
import * as emotionService from './emotionService.js';
import * as userEmotionService from './userEmotionService.js';
import * as strategyService from './strategyService.js';
import * as memoryService from './memoryService.js';
import * as relationshipService from './relationshipService.js';

/** 生成阶段提示 */
function stageEvent(stage: SseStage): ChatSseEvent {
  return { type: 'status', stage, label: SSE_STAGE_LABELS[stage] };
}

export interface ChatDeps {
  /** 取角色（由路由层注入，便于测试） */
  getCharacter: (userId: string, characterId: string) => AICharacter | null;
  /** 取用户隐私设置 */
  getPrivacy: (userId: string) => { longTermMemoryEnabled: boolean; saveChatHistory: boolean };
}

/**
 * 流式聊天主流程。
 * 以 AsyncGenerator 形式产出 SSE 事件，路由层负责写入 response。
 */
export async function* streamChat(
  input: ChatStreamInput,
  deps: ChatDeps,
  signal?: AbortSignal,
): AsyncGenerator<ChatSseEvent, void, void> {
  const { userId, characterId, text } = input;

  const character = deps.getCharacter(userId, characterId);
  if (!character) {
    yield { type: 'error', code: 'E_NOT_FOUND', message: '找不到這個角色', retryable: false };
    return;
  }

  const privacy = deps.getPrivacy(userId);

  // ---------- 1. 入方向安全检查 ----------
  yield stageEvent('safety');
  const incoming = safetyService.checkIncoming(userId, characterId, text);

  // ---------- 2. 取会话 & 落库用户消息 ----------
  const conversation: Conversation = input.conversationId
    ? conversationsRepo.getConversation(userId, input.conversationId) ??
      conversationsRepo.findOrCreateActive(userId, characterId)
    : conversationsRepo.findOrCreateActive(userId, characterId);

  const userMessage = conversationsRepo.insertMessage(userId, {
    id: input.clientMessageId ?? newId(),
    conversationId: conversation.id,
    characterId,
    role: 'user',
    content: text,
  });

  const assistantMessageId = newId();
  yield {
    type: 'meta',
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId,
    characterId,
  };

  usersRepo.updateLastSeen(userId);

  // ---------- 3. 用户情绪分析 ----------
  yield stageEvent('analyzing');
  const recent = conversationsRepo.listRecentMessages(userId, conversation.id, 10);
  const recentUserTexts = recent
    .filter((m) => m.role === 'user' && m.id !== userMessage.id)
    .map((m) => m.content);

  // ---------- 3. 用户情绪分析（快速路径：读上一轮已持久化的情绪，不再同步烧 LLM） ----------
  // 上一轮的后处理已经把分析结果持久化到 user_emotion_analyses，
  // 这里直接读取，避免首字前约 19s 的同步 LLM 等待。
  const last = statesRepo.getLatestUserEmotion(userId, characterId);
  const userEmotion: userEmotionService.AnalysisResult = last
    ? {
        emotion: last.emotion,
        valence: last.valence,
        intensity: last.intensity,
        confidence: last.confidence,
        trend: last.trend,
        intent: last.intent,
        needsComfort: last.needsComfort,
        crisisSignal: last.crisisSignal,
        shareDepth: last.shareDepth,
        reasons: last.reasons,
      }
    : {
        emotion: 'calm',
        valence: 0.1,
        intensity: 0.25,
        confidence: 0.4,
        trend: 'stable',
        intent: '一般閒聊',
        needsComfort: false,
        crisisSignal: 'none',
        shareDepth: 0.2,
        reasons: ['尚無情緒紀錄，使用中性預設'],
      };

  // 同步安全闸：纯规则判断，无 LLM。命中 severe 时强制走 crisis_care。
  const crisis = safetyService.detectCrisis(text);
  if (crisis === 'severe') {
    userEmotion.crisisSignal = 'severe';
    userEmotion.needsComfort = true;
  }

  // ---------- 4. 读取 AI 情绪 / 记忆 / 短期上下文 ----------
  yield stageEvent('retrieving');
  const aiEmotion = emotionService.getEmotion(userId, character);
  const memories: MemoryItem[] = memoryService.retrieveForPrompt(
    userId,
    characterId,
    privacy.longTermMemoryEnabled,
  );
  const shortTerm = memoryService.buildShortTerm(userId, conversation);
  const relationship = relationshipService.ensureState(userId, character);

  // ---------- 5. 策略选择 ----------
  const recentStrategies = recent
    .filter((m) => m.role === 'assistant' && m.strategy)
    .slice(-3)
    .map((m) => m.strategy as StrategyType);

  const decision = strategyService.pickStrategy({
    userEmotion,
    recentStrategies,
    blocked: !incoming.allowed,
  });

  yield { type: 'strategy', strategy: decision.strategy, reason: decision.reason };
  logger.info('[Chat] 策略選定', {
    characterId,
    strategy: decision.strategy,
    reason: decision.reason,
    userEmotion: userEmotion.emotion,
    valence: userEmotion.valence.toFixed(2),
  });

  // ---------- 6. 构建 Prompt ----------
  const ctx: ChatContext = {
    userId,
    character,
    conversation,
    userText: text,
    shortTerm,
    memories,
    emotion: {
      currentEmotion: aiEmotion.currentEmotion,
      intensity: aiEmotion.intensity,
      valence: aiEmotion.valence,
      arousal: aiEmotion.arousal,
      emotionReason: aiEmotion.emotionReason,
    },
    userEmotion: {
      emotion: userEmotion.emotion,
      intensity: userEmotion.intensity,
      trend: userEmotion.trend,
      intent: userEmotion.intent,
      needsComfort: userEmotion.needsComfort,
      crisisSignal: userEmotion.crisisSignal,
      shareDepth: userEmotion.shareDepth,
      reasons: userEmotion.reasons,
    },
    relationship,
    strategy: decision.strategy,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildUserPrompt(ctx);

  // ---------- 7. 流式生成 ----------
  yield stageEvent('generating');
  let full = '';
  let usage: { inputTokens: number; outputTokens: number; durationMs: number } | undefined;

  try {
    const iterator = streamText(
      { prompt: userPrompt, systemPrompt, label: 'chat', signal },
    );
    let next = await iterator.next();
    while (!next.done) {
      const delta = next.value.delta;
      if (delta) {
        full += delta;
        yield { type: 'text', content: delta };
      }
      next = await iterator.next();
    }
    if (next.value?.usage) usage = next.value.usage;
  } catch (err) {
    const sdkErr =
      err instanceof SdkCallError ? err : new Error(err instanceof Error ? err.message : String(err));
    const code = err instanceof SdkCallError ? err.code : 'E_AI_UNAVAILABLE';
    const retryable = err instanceof SdkCallError ? err.retryable : true;

    logger.error('[Chat] 生成失敗', { code, message: sdkErr.message });

    // 用户消息已保存，助手侧记一条错误占位，前端可据此显示"重试"
    conversationsRepo.insertMessage(userId, {
      id: assistantMessageId,
      conversationId: conversation.id,
      characterId,
      role: 'assistant',
      content: '',
      errorCode: code,
    });
    yield { type: 'error', code, message: toUserMessage(code), retryable };
    return;
  }

  // ---------- 8. 出方向安全检查（硬闸） ----------
  const outgoing = safetyService.checkOutgoing(userId, characterId, full);
  let finalText = full;

  if (!outgoing.safe) {
    if (outgoing.text) {
      finalText = outgoing.text;
      yield { type: 'replace', content: finalText };
    } else {
      finalText = safetyService.pickFallback(full.length);
      yield { type: 'replace', content: finalText };
    }
  }

  if (!finalText.trim()) {
    finalText = safetyService.pickFallback(full.length);
    yield { type: 'replace', content: finalText };
  }

  // ---------- 9. 保存助手消息 ----------
  const assistantMessage: MessageRecord = conversationsRepo.insertMessage(userId, {
    id: assistantMessageId,
    conversationId: conversation.id,
    characterId,
    role: 'assistant',
    content: finalText,
    aiEmotion: aiEmotion.currentEmotion,
    aiEmotionIntensity: aiEmotion.intensity,
    strategy: decision.strategy,
    userEmotion: userEmotion.emotion,
    meta: {
      usage,
      memoryRefs: memories.map((m) => m.id),
      safetyFlags: outgoing.violations.length ? outgoing.violations : undefined,
      intent: userEmotion.intent,
    },
  });

  // ---------- 10. 后处理（情绪 / 记忆 / 关系） ----------
  yield stageEvent('postprocessing');

  const postEvents: ChatSseEvent[] = [];
  const postPromise = runPostProcessing({
    userId,
    character,
    conversation,
    userMessage,
    assistantMessage,
    userText: text,
    aiReply: finalText,
    userEmotionIntensity: userEmotion.intensity,
    shareDepth: userEmotion.shareDepth,
    userEmotionLabel: userEmotion.emotion,
    longTermEnabled: privacy.longTermMemoryEnabled,
    recentUserTexts,
    onEvent: (e) => postEvents.push(e),
  }).catch(() => undefined);

  // 后处理涉及一次轻量 LLM 调用（情绪校正），通常 1–3 秒。
  // 这里给 8 秒上限：绝大多数情况能带上完整的情绪/记忆/关系事件；
  // 超时也不阻塞——用户已经拿到回复，后处理会在后台继续跑完。
  await Promise.race([postPromise, new Promise((r) => setTimeout(r, 8000))]);

  for (const e of postEvents) yield e;

  yield { type: 'done', messageId: assistantMessage.id, usage };
}

// ============================================================
// 后处理
// ============================================================

interface PostInput {
  userId: string;
  character: AICharacter;
  conversation: Conversation;
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  userText: string;
  aiReply: string;
  userEmotionIntensity: number;
  shareDepth: number;
  userEmotionLabel: string;
  longTermEnabled: boolean;
  /** 最近几条用户消息（正序），供后台情绪分析做 trend 判断 */
  recentUserTexts: string[];
  onEvent: (e: ChatSseEvent) => void;
}

async function runPostProcessing(input: PostInput): Promise<void> {
  const {
    userId, character, conversation, userMessage, assistantMessage,
    userText, aiReply, userEmotionIntensity, shareDepth, userEmotionLabel,
    longTermEnabled, recentUserTexts, onEvent,
  } = input;

  try {
    // 1) 更新 AI 情绪
    const nextEmotion = await emotionService.updateAfterTurn({
      userId,
      character,
      userText,
      aiReply,
      userEmotionLabel,
    });
    onEvent({
      type: 'emotion',
      emotion: nextEmotion.currentEmotion,
      intensity: nextEmotion.intensity,
      reason: nextEmotion.emotionReason,
    });

    // 2) 抽取长期记忆
    const userMessageCount = conversationsRepo.countUserMessages(userId, character.id);
    const saved = await memoryService.extractMemories({
      userId,
      character,
      messageId: userMessage.id,
      userText,
      aiReply,
      userEmotionIntensity,
      userMessageCount,
      longTermEnabled,
    });
    if (saved.length) {
      onEvent({
        type: 'memory',
        action: 'added',
        items: saved.map((m) => ({ id: m.id, content: m.content, category: m.category })),
      });
    }

    // 3) 更新关系
    const prevStage = relationshipService.ensureState(userId, character).stage;
    const rel = relationshipService.touchRelationship({ userId, character, shareDepth });
    onEvent({
      type: 'relationship',
      stage: rel.stage,
      interactionLevel: rel.interactionLevel,
      leveledUp: rel.stage !== prevStage,
    });

    // 4) 滚动摘要（异步，不阻塞）
    void memoryService.maybeSummarize(userId, conversation);

    // 5) 用户情绪完整分析（持久化到 user_emotion_analyses，供下一轮快速路径读取）
    //    放在后处理里：首字前不再同步等待，但下一轮仍能拿到本轮分析结果。
    await userEmotionService.analyzeUserEmotion({
      userId,
      characterId: character.id,
      conversationId: conversation.id,
      messageId: userMessage.id,
      text: userText,
      recentUserTexts,
    });

    logger.info('[Chat] 後處理完成', {
      messageId: assistantMessage.id,
      emotion: nextEmotion.currentEmotion,
      memories: saved.length,
      stage: rel.stage,
    });
  } catch (err) {
    // 后处理失败绝不影响用户已经收到的回复
    logger.error('[Chat] 後處理失敗（不影響本輪回覆）', {
      messageId: assistantMessage.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 错误码 → 用户看得懂的繁中提示（绝不泄露密钥 / 原始错误文本） */
function toUserMessage(code: string): string {
  const map: Record<string, string> = {
    E_AI_AUTH: 'AI 服務尚未設定好（缺少有效的金鑰）',
    E_AI_UNAVAILABLE: 'AI 服務暫時連不上，等一下再試試好嗎？',
    E_AI_TIMEOUT: '這次想太久逾時了，再試一次好嗎？',
    E_AI_CONTENT: '這段內容沒辦法回應，我們換個話題吧',
    E_NO_CLI: 'AI 執行環境還沒就緒，請稍後再試',
  };
  return map[code] ?? '剛剛出了點狀況，再試一次好嗎？';
}
