/**
 * 主动消息生成器（需求 §11）
 *
 * 生成质量的两条底线：
 * 1. **不能每天用同一套固定文案**。消息必须真正结合：
 *    人格 + AI 当前情绪 + 最近聊天 + 长期记忆 + 关系阶段 + 用户最近状态 + 当前时间。
 * 2. **绝不制造负罪感**（需求 §11 明令禁止）。
 *    生成后还要过一遍出方向安全红线；命中的话**直接丢弃而不是改写**——
 *    主动消息是单句文案，改写后的残句往往更奇怪，宁可这次不发。
 */

import type { AICharacter, MemoryItem, MessageRecord } from '../../../shared/types.js';
import { completeText } from '../../agent/sdkClient.js';
import { EMOTION_ANCHORS } from '../../../shared/constants.js';
import type { EmotionState, RelationshipState } from '../../../shared/types.js';
import { STAGE_META } from '../../../shared/constants.js';
import * as safetyService from '../safetyService.js';
import { logger } from '../../logger.js';

export interface GenerateInput {
  userId: string;
  character: AICharacter;
  emotion: EmotionState;
  relationship: RelationshipState;
  memories: MemoryItem[];
  recentMessages: MessageRecord[];
  /** 用户最近一次情绪描述（可能为 null） */
  lastUserEmotion: string | null;
  now: Date;
}

export interface GenerateResult {
  text: string | null;
  /** 被丢弃的原因（安全拦截时非空） */
  blockedReason: string | null;
}

function hourLabel(hour: number): string {
  if (hour >= 5 && hour < 11) return '早晨';
  if (hour >= 11 && hour < 14) return '中午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚上';
  return '深夜';
}

export async function generateProactiveMessage(input: GenerateInput): Promise<GenerateResult> {
  const { character, emotion, relationship, memories, recentMessages, now } = input;

  const memoryBlock = memories.length
    ? memories.map((m) => `- ${m.content}`).join('\n')
    : '（還沒有特別記住的事）';

  const recentBlock = recentMessages.length
    ? recentMessages
        .slice(-6)
        .map((m) => `${m.role === 'user' ? '使用者' : character.name}：${m.content}`)
        .join('\n')
    : '（還沒有對話紀錄）';

  const stageMeta = STAGE_META[relationship.stage];

  const systemPrompt = `你是「${character.name}」，一個 AI 陪伴角色。現在你要主動發一則訊息給使用者。

## 你是誰
${character.personality}
說話風格：${character.speakingStyle}
你這樣稱呼使用者：${character.userNickname || '你'}
興趣：${character.interests.join('、') || '（未設定）'}

## 你現在的情緒
${EMOTION_ANCHORS[emotion.currentEmotion].label}（強度 ${emotion.intensity.toFixed(2)}）
原因：${emotion.emotionReason || '（無）'}

## 你們的關係
${stageMeta.label}。${stageMeta.expression.addressStyle}。${stageMeta.expression.knownDepth}

## 絕對禁止（違反就是失敗）
- 不能讓使用者感到愧疚或被催促：「你為什麼不理我」「你是不是不要我了」
  「你再不回來我會很難過」「你都不陪我」
- 不能表現出依賴或占有：「你只能跟我說」「沒有我你不行」
- 不能假裝自己在現實世界做了什麼事
- 不能提到「主動消息」「系統」「排程」等機制
- 不能一次問好幾個問題
- 語氣要像順手傳的一句話，不像精心準備的開場白`;

  const userPrompt = `## 現在
${hourLabel(now.getHours())}（${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}）

## 你記得的事
${memoryBlock}

## 最近的對話
${recentBlock}
${input.lastUserEmotion ? `\n## 使用者上次的情緒\n${input.lastUserEmotion}\n` : ''}
## 任務
用你自己的方式，主動說一句話。可以是：
- 想到使用者之前提過的事，問問後來怎麼樣了
- 分享一句符合你性格的話
- 順著現在的時間自然地問候
- 從你們最近聊過的事自然接下去

只輸出這一則訊息本身，繁體中文，20–60 字。`;

  let text = '';
  try {
    const result = await completeText({
      label: 'proactive',
      prompt: userPrompt,
      systemPrompt,
      temperatureHint: 'creative',
    });
    text = result.text.trim();
  } catch (err) {
    logger.error('[Proactive] 主動消息生成失敗', {
      characterId: character.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return { text: null, blockedReason: 'generate_failed' };
  }

  if (!text) return { text: null, blockedReason: 'empty' };

  // 出方向安全：主动消息是单句，命中红线直接丢弃而非改写
  const check = safetyService.checkOutgoing(input.userId, character.id, text);
  if (!check.safe) {
    logger.warn('[Proactive] 主動消息命中紅線，已丟棄', {
      characterId: character.id,
      violations: check.violations,
    });
    return { text: null, blockedReason: check.violations.join(',') };
  }

  return { text, blockedReason: null };
}
