/**
 * 「需恋」SSE 事件协议（前后端共用）
 *
 * 传输约定：
 * - 每行格式固定为 `data: <JSON>\n\n`，不使用自定义 `event:` 名，
 *   前端统一按 `data.type` 分支（与模板 useChat.ts 的解析方式一致）。
 * - 顺序保证：`meta` 必须是第一个事件，`done` / `error` 必须是最后一个。
 * - 心跳：服务端每 15s 写一行 `: ping\n\n` 注释，前端忽略以冒号开头的行。
 *
 * 之所以不用 EventSource：聊天接口是 POST，EventSource 只支持 GET。
 */

import type {
  ChatMode,
  EmotionType,
  MemoryCategory,
  RelationshipStage,
  StrategyType,
} from './constants';

/** 生成阶段：前端据此显示陪伴感文案（「正在感受…」） */
export type SseStage = 'safety' | 'analyzing' | 'retrieving' | 'generating' | 'postprocessing';

export const SSE_STAGE_LABELS: Record<SseStage, string> = {
  safety: '正在確認內容…',
  analyzing: '正在感受你的語氣…',
  retrieving: '正在回想你們聊過的事…',
  generating: '正在組織想說的話…',
  postprocessing: '正在記下今天的事…',
};

export interface SseUsage {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export type ChatSseEvent =
  /** 首个事件：用户消息已落库，带回真实 ID */
  | { type: 'meta'; conversationId: string; userMessageId: string; assistantMessageId: string; characterId: string }
  /** 阶段进度 */
  | { type: 'status'; stage: SseStage; label: string }
  /** 增量文本（delta），前端累加拼接 */
  | { type: 'text'; content: string }
  /** 安全改写 / 中断兜底：用完整文本替换已输出内容 */
  | { type: 'replace'; content: string }
  /** 策略选定（V2：附带本轮生效的聊天模式与模式来源，供前端展示模式 chip） */
  | {
      type: 'strategy';
      strategy: StrategyType;
      reason: string;
      chatMode?: ChatMode;
      modeSource?: 'user' | 'ai' | 'system';
    }
  /** AI 情绪更新（后处理结束） */
  | { type: 'emotion'; emotion: EmotionType; intensity: number; reason: string }
  /** 抽到新记忆 */
  | { type: 'memory'; action: 'added' | 'updated'; items: Array<{ id: string; content: string; category: MemoryCategory }> }
  /** 关系更新（升级时前端放小动画） */
  | { type: 'relationship'; stage: RelationshipStage; interactionLevel: number; leveledUp: boolean }
  /** 正常结束 */
  | { type: 'done'; messageId: string; usage?: SseUsage }
  /** 出错（前端显示重试按钮） */
  | { type: 'error'; code: string; message: string; retryable: boolean };

export type ChatSseEventType = ChatSseEvent['type'];

/**
 * 把一条事件编码成 SSE 文本行。
 * 与 response body 直接 write 的字符串保持一致，前后端都用这一个函数，避免手写格式出错。
 */
export function encodeSseEvent(event: ChatSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** SSE 心跳行（冒号开头，前端解析器会忽略） */
export function encodeSsePing(): string {
  return ': ping\n\n';
}
