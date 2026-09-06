/**
 * 策略标签（前端版）
 *
 * 与服务端 `strategyService.STRATEGY_USER_LABELS` 保持一致，
 * 但不能直接 import 服务端文件（会把服务端代码打进前端包，且可能泄漏内部常量）。
 *
 * 展示原则（需求 §20）：只用温柔的行为描述，绝不出现诊断性词汇。
 */

import type { StrategyType } from '@shared/constants';

export const STRATEGY_USER_LABELS: Record<StrategyType, string> = {
  normal_chat: '陪你聊聊',
  listening: '聽你說',
  comfort: '陪你難過',
  encouragement: '給你打氣',
  companionship: '待在你身邊',
  topic_change: '換個話題',
  crisis_care: '認真聽你說',
  blocked: '換個話題',
  // ---- V2：9 种聊天模式新增的 5 个策略（与 shared/constants 的 userLabel 一致）----
  organize_thoughts: '陪你理清楚',
  study_buddy: '陪你讀書',
  share_joy: '一起開心',
  quiet_company: '靜靜陪著',
  story_chat: '一起編故事',
};

/** 生成阶段提示文案 */
export const STAGE_LABELS: Record<string, string> = {
  safety: '正在確認內容…',
  analyzing: '正在感受你的語氣…',
  retrieving: '正在回想你們聊過的事…',
  generating: '正在組織想說的話…',
  postprocessing: '正在記下今天的事…',
};
