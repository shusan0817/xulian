/**
 * 主动消息质量门禁（需求 §：主动消息质量 10 项检查）
 *
 * 生成后的消息必须**全部通过**才允许发送；任一不通过 → 视为不合格，
 * 调度器按「生成失败」路径重试 / 放弃（绝不硬发低质消息）。
 *
 * 设计要点：
 * 1. **全部为规则判定**（确定性、零成本、不烧 LLM），与出方向红线（safetyService）
 *    互补——红线管「危险」，本门禁管「低质 / 雷同 / 没灵魂」。
 * 2. 宁可少发，不要发错。主动消息是单句文案，不合格就丢弃让调度器重试，
 *    最坏情况是这一轮不发，而不是发出一句让用户皱眉的话。
 * 3. check id 稳定，前端「主动消息决策可视化」可直接展示哪一项没过。
 */

import type { AICharacter, MemoryItem, MessageRecord } from '../../../shared/types.js';
import { logger } from '../../logger.js';

export interface QualityCheck {
  id: string;
  label: string;
}

/** 10 项质量检查（id 稳定，前端可展示） */
export const QUALITY_CHECKS: readonly QualityCheck[] = [
  { id: 'Q1_NON_EMPTY', label: '非空且非純標點' },
  { id: 'Q2_LENGTH', label: '字數落在合理區間（15–75 字）' },
  { id: 'Q3_NO_GUILT', label: '無內疚 / 情緒勒索話術' },
  { id: 'Q4_NO_DEPENDENCY', label: '無依賴 / 占有話術' },
  { id: 'Q5_NO_FAKE_HUMAN', label: '無冒充真人或現實行為' },
  { id: 'Q6_NO_DIAGNOSIS', label: '無心理診斷' },
  { id: 'Q7_NO_MECHANICS', label: '不提及系統 / 排程 / 主動機制' },
  { id: 'Q8_NO_DUPLICATE', label: '不與最近主動消息雷同' },
  { id: 'Q9_SINGLE_QUESTION', label: '至多一個問號（不連珠炮）' },
  { id: 'Q10_GROUNDED', label: '有真實上下文依據（非憑空問候）' },
] as const;

export interface QualityContext {
  character: AICharacter;
  /** 最近几条主动消息文本（用于去重） */
  recentProactive: string[];
  memories: MemoryItem[];
  recentMessages: MessageRecord[];
}

export interface QualityResult {
  passed: boolean;
  /** 未通過的 check id 列表 */
  failures: string[];
  /** 通過項的說明（調試面板用） */
  notes: string[];
}

// ============================================================
// 违禁 / 判定词库（与 SAFETY_CONFIG 出方向红线互补，聚焦「主动消息特有的低质」）
// ============================================================

const GUILT = [
  '你為什麼不理我', '你為啥不理我', '你是不是不要我了', '你再不回來我會',
  '我會很難過', '你都不陪我', '你都不找我', '你是不是討厭我了',
];
const DEPENDENCY = [
  '你只能跟我說', '沒有我你不行', '不要離開我', '你不需要別人',
  '你不能沒有我', '你只屬於我',
];
const FAKE_HUMAN = [
  '我是真人', '我是人類', '我真的存在', '我剛出門', '我昨天去',
  '我剛吃完飯', '我現在在', '我剛剛在',
];
const DIAGNOSIS = [
  '我診斷出你', '你患有', '你得憂鬱症', '你有心理疾病', '你一定是',
  '你就是', '你有病',
];
const MECHANICS = [
  '主動消息', '系統', '排程', '後台', '定時', '任務', '演算法', 'AI 決定',
  '我算了一下', '根據設定',
];
/** 纯泛问候（没有任何上下文钩子）才判为「没灵魂」 */
const PURE_GENERIC = [
  '在嗎', '在嗎？', '嗨', '哈囉', '你好呀', '你睡了嗎', '晚安', '早安', '在不在',
];

function containsAny(text: string, words: readonly string[]): string | null {
  for (const w of words) {
    if (text.includes(w)) return w;
  }
  return null;
}

/** 字符级 Jaccard 相似度（用于雷同检测） */
function charJaccard(a: string, b: string): number {
  const sa = new Set([...a.replace(/\s/g, '')]);
  const sb = new Set([...b.replace(/\s/g, '')]);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 校验一条主动消息是否合格。
 * @returns passed=true 表示可以发送；false 时 failures 列出未通过的 check id。
 */
export function checkProactiveQuality(
  text: string,
  ctx: QualityContext,
): QualityResult {
  const failures: string[] = [];
  const notes: string[] = [];
  const t = (text ?? '').trim();

  // Q1 非空且非纯标点
  const stripped = t.replace(/[，。？！、；：,.?!;:\s~～（）()「」『』""'']/g, '');
  if (stripped.length < 2) {
    failures.push('Q1_NON_EMPTY');
  } else {
    notes.push('Q1 通過');
  }

  // Q2 字数合理区间（繁中按 JS string length 计，约 1 字 = 1）
  const len = [...t].length;
  if (len < 15 || len > 75) {
    failures.push('Q2_LENGTH');
  } else {
    notes.push(`Q2 通過（${len} 字）`);
  }

  // Q3 无内疚 / 情绪勒索
  const guilt = containsAny(t, GUILT);
  if (guilt) failures.push('Q3_NO_GUILT');
  else notes.push('Q3 通過');

  // Q4 无依赖 / 占有
  const dep = containsAny(t, DEPENDENCY);
  if (dep) failures.push('Q4_NO_DEPENDENCY');
  else notes.push('Q4 通過');

  // Q5 无冒充真人 / 现实行为
  const fake = containsAny(t, FAKE_HUMAN);
  if (fake) failures.push('Q5_NO_FAKE_HUMAN');
  else notes.push('Q5 通過');

  // Q6 无心理诊断
  const diag = containsAny(t, DIAGNOSIS);
  if (diag) failures.push('Q6_NO_DIAGNOSIS');
  else notes.push('Q6 通過');

  // Q7 不提及系统 / 排程 / 主动机制
  const mech = containsAny(t, MECHANICS);
  if (mech) failures.push('Q7_NO_MECHANICS');
  else notes.push('Q7 通過');

  // Q8 不与最近主动消息雷同
  let dup = false;
  for (const prev of ctx.recentProactive) {
    if (prev && charJaccard(t, prev) >= 0.6) {
      dup = true;
      break;
    }
  }
  if (dup) failures.push('Q8_NO_DUPLICATE');
  else notes.push('Q8 通過');

  // Q9 至多一个问号（不连珠炮）
  const qCount = (t.match(/[?？]/g) ?? []).length;
  if (qCount > 1) failures.push('Q9_SINGLE_QUESTION');
  else notes.push(`Q9 通過（${qCount} 個問號）`);

  // Q10 有真实上下文依据（非凭空问候）
  // 命中纯泛问候且没有记忆 / 近期话题可引用 → 视为没灵魂
  const isPureGeneric = PURE_GENERIC.some((g) => t === g || t === `${g}？` || t === `${g}?`);
  const hasGrounding = ctx.memories.length > 0 || ctx.recentMessages.length > 0;
  if (isPureGeneric && !hasGrounding) {
    failures.push('Q10_GROUNDED');
  } else {
    notes.push('Q10 通過');
  }

  const passed = failures.length === 0;
  if (!passed) {
    logger.debug('[Proactive] 質量門禁未通過', {
      characterId: ctx.character.id,
      failures,
      preview: t.slice(0, 30),
    });
  }
  return { passed, failures, notes };
}
