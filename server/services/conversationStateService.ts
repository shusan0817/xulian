/**
 * AI 对话状态推导（需求 §：AI 聊天状态影响表达）
 *
 * 本服务只做「这轮对话里 AI 处于什么状态」的轻量判定，
 * 与情绪（emotion_states）、回复策略（strategyService）三者正交：
 * - 情绪：只改语气，不改人格；
 * - 策略：危机 / 安慰 / 倾听…系统专用或用户选定；
 * - 对话状态：描述「当前对话的氛围走向」，让同一人格在不同对话里有自然的
 *   表达差异（例如正在傾聽 vs 聊開了）。
 *
 * 纯函数、确定性、零成本（不烧 LLM）。实际落库由 chatService 调用 statesRepo 完成。
 */

import type { ConversationState } from '../../shared/constants.js';
import type { MessageRecord } from '../../shared/types.js';

export interface DeriveInput {
  userText: string;
  userEmotion: {
    emotion: string;
    valence: number;
    intensity: number;
    shareDepth: number;
    intent: string;
    needsComfort: boolean;
  };
  /** 最近几条消息（正序），用于判断是否「你來我往」 */
  recentMessages: MessageRecord[];
  /** 当前聊天模式（story_chat / share_joy 等会偏向「分享中」） */
  chatMode?: string | null;
}

const PLAYFUL_MARKERS = /(😂|🤣|😆|哈哈|嘻嘻|嘿嘿|調皮|鬧|開玩笑|哈哈哈)/;
const QUESTION_RE = /[?？]\s*$/;
const NEGATIVE_EMOTIONS = ['sad', 'down', 'worried', 'angry'];

/**
 * 根据本轮上下文推导对话状态。
 * @returns { state, reason } —— reason 用于调试面板与可解释性展示。
 */
export function deriveConversationState(
  input: DeriveInput,
): { state: ConversationState; reason: string } {
  const { userText, userEmotion: ue, recentMessages, chatMode } = input;
  const txt = userText ?? '';

  // 1) 倾述 / 明显负面情绪 → 傾聽（先接住，不急著下結論）
  if (
    ue.shareDepth >= 0.5 ||
    (ue.valence < -0.1 && NEGATIVE_EMOTIONS.includes(ue.emotion))
  ) {
    return { state: 'listening', reason: '使用者正在說心事，專注傾聽' };
  }

  // 2) 调皮信号 → 調皮
  if (PLAYFUL_MARKERS.test(txt)) {
    return { state: 'playful', reason: '使用者語氣輕鬆好玩' };
  }

  // 3) 分享好事 / 兴奋好奇 → 好奇（想多知道一點）
  if (
    ['happy', 'excited', 'surprised'].includes(ue.emotion) ||
    /(分享|好事|趣事|開心|興奮|太棒)/.test(ue.intent)
  ) {
    return { state: 'curious', reason: '使用者說了有趣 / 開心的事，想多了解' };
  }

  // 4) 故事 / 分享類模式 → 分享中
  if (chatMode === 'story_chat' || chatMode === 'share_joy') {
    return { state: 'sharing', reason: `聊天模式偏向分享：${chatMode}` };
  }

  // 5) 上一轮 AI 抛了问句，或已多轮你来我往 → 聊開了
  const lastAi = [...recentMessages].reverse().find((m) => m.role === 'assistant');
  const userTurns = recentMessages.filter((m) => m.role === 'user').length;
  if ((lastAi && QUESTION_RE.test(lastAi.content.trim())) || userTurns >= 3) {
    return { state: 'discussing', reason: '話題正熱，你來我往' };
  }

  // 6) 默认：平常放鬆閒聊
  return { state: 'calm', reason: '尋常閒聊，放鬆自在' };
}
