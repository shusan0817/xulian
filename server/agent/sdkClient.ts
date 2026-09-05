/**
 * AI 调用门面（对外唯一入口）。
 *
 * 业务侧（chatService / emotionService / memoryService / userEmotionService /
 * generatorService）只调用本文件的 streamText / completeText / completeJson，
 * 不关心背后是 OpenAI 还是 CodeBuddy。供应商切换完全由 getAIProvider() 决定。
 *
 * 本文件刻意保留历史对外签名，确保现有 5 个调用方零改动就能编译通过：
 *   - streamText(opts) / completeText(opts) / completeJson<T>(opts, validate?)
 *   - 导出 SdkCallError / UserAbortError / StreamTextOptions / createStreamController
 *
 * 错误契约：OpenAI 供应商抛出的 AIProviderError 会在这里被映射回 SdkCallError，
 * 沿用旧的 { code, retryable, subtype, message } 形状，使调用方既有的错误处理继续生效；
 * CodeBuddy 供应商本身仍直接抛 SdkCallError（不重复包装）。
 */

import type { ChatMessage, AIStreamOptions } from '../ai/types.js';
import { AIProviderError } from '../ai/types.js';
import { getAIProvider } from '../ai/index.js';
import { SdkCallError, UserAbortError } from './errors.js';
import { ErrorCode } from '../../shared/errors.js';
import { logger } from '../logger.js';

export interface StreamTextOptions {
  /** 本轮用户输入（单条 user turn，多轮上下文由调用方拼装） */
  prompt: string;
  systemPrompt: string;
  model?: string;
  /** 外部中断信号（SSE 客户端断开时由路由层 abort） */
  signal?: AbortSignal;
  /** 结构化 JSON 输出模式：会追加严格的输出契约，并由 completeJson 负责解析 */
  jsonMode?: boolean;
  /** 温度提示：SDK 未暴露 temperature，只能用措辞影响模型 */
  temperatureHint?: 'precise' | 'balanced' | 'creative';
  /** 日志标签，便于定位是哪一类调用（chat / emotion / memory / proactive） */
  label?: string;
}

export interface SdkUsage {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface StreamTextResult {
  text: string;
  usage?: SdkUsage;
  sessionId?: string;
}

// 历史导出保留，调用方可能引用
export { SdkCallError, UserAbortError };

// ============================================================
// AIProviderError → SdkCallError 映射
// ============================================================

function toSdkCode(code: AIProviderError['code']): string {
  switch (code) {
    case 'E_AI_AUTH':
      return ErrorCode.AI_AUTH;
    case 'E_AI_RATE_LIMIT':
      return ErrorCode.AI_RATE_LIMIT;
    case 'E_AI_MODEL_MISSING':
      return ErrorCode.AI_MODEL_MISSING;
    case 'E_AI_TIMEOUT':
      return ErrorCode.AI_TIMEOUT;
    case 'E_AI_EMPTY':
    case 'E_AI_UNAVAILABLE':
    default:
      return ErrorCode.AI_UNAVAILABLE;
  }
}

function toSdkCallError(err: AIProviderError): SdkCallError {
  return new SdkCallError(err.message, {
    code: toSdkCode(err.code),
    retryable: err.retryable,
    subtype: err.code,
    details: { status: err.status },
  });
}

/** 把任意未知错误收敛成 SdkCallError（绝不给调用方裸抛未知异常） */
function toSdkError(err: unknown): SdkCallError {
  if (err instanceof AIProviderError) return toSdkCallError(err);
  if (err instanceof SdkCallError) return err;
  if (err instanceof UserAbortError) {
    return new SdkCallError(err.message, { code: ErrorCode.AI_TIMEOUT, retryable: false });
  }
  return new SdkCallError(err instanceof Error ? err.message : String(err), {
    code: ErrorCode.AI_UNAVAILABLE,
    retryable: true,
    subtype: 'unknown',
  });
}

// ============================================================
// 门面入参 → 供应商入参
// ============================================================

function toMessages(opts: StreamTextOptions): ChatMessage[] {
  return [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.prompt },
  ];
}

function toProviderOpts(opts: StreamTextOptions): AIStreamOptions {
  return {
    model: opts.model,
    signal: opts.signal,
    temperatureHint: opts.temperatureHint,
    jsonMode: opts.jsonMode,
    label: opts.label,
  };
}

// ============================================================
// 对外 API
// ============================================================

/**
 * 一次性文本生成（情绪分析 / 记忆抽取 / 主动消息生成用）。
 * 内部通过 getAIProvider().complete 调用实际供应商；并发闸门与重试由供应商各自负责
 * （CodeBuddy 仍走 sdkSemaphore + withRetry；OpenAI 走自身的轻量重试）。
 */
export async function completeText(opts: StreamTextOptions): Promise<StreamTextResult> {
  const started = Date.now();
  try {
    const text = await getAIProvider().complete(toMessages(opts), toProviderOpts(opts));
    logger.debug('[SDK] completeText 完成', {
      label: opts.label ?? 'default',
      jsonMode: Boolean(opts.jsonMode),
      textLen: text.length,
      durationMs: Date.now() - started,
    });
    return { text };
  } catch (err) {
    const sdkErr = toSdkError(err);
    logger.error('[SDK] completeText 失敗', {
      label: opts.label ?? 'default',
      code: sdkErr.code,
      subtype: sdkErr.subtype,
      retryable: sdkErr.retryable,
      message: sdkErr.message,
      durationMs: Date.now() - started,
    });
    throw sdkErr;
  }
}

/**
 * 提取文本中的 JSON。
 * 模型偶尔还是会裹一层 ```json 代码块，这里做三道清理再 parse。
 */
function extractJson(raw: string): unknown {
  let text = raw.trim();
  // 1) 去掉 markdown 代码块围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) text = fenced[1].trim();
  // 2) 截取第一个 { 到最后一个 }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(text);
}

/**
 * 结构化 JSON 调用（后处理用）。
 * 第一次失败会在 systemPrompt 上追加「严格只输出 JSON」再试一次；两次都失败就抛错，
 * 由调用方走规则层兜底（绝不让后处理失败拖垮主对话）。
 */
export async function completeJson<T>(
  opts: StreamTextOptions,
  validate?: (value: unknown) => T | null,
): Promise<T> {
  const strictReminder =
    '\n\n## 重要提醒\n上一次的輸出不是合法 JSON。請嚴格只輸出一個 JSON 物件，' +
    '不要任何解釋文字、不要 markdown 程式碼區塊。';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await completeText({
      ...opts,
      jsonMode: true,
      systemPrompt: attempt === 1 ? opts.systemPrompt : `${opts.systemPrompt}${strictReminder}`,
    });
    try {
      const parsed = extractJson(result.text);
      if (!validate) return parsed as T;
      const validated = validate(parsed);
      if (validated !== null) return validated;
      logger.warn('[SDK] completeJson 校驗未通過，重試一次', {
        label: opts.label ?? 'default',
        attempt,
        raw: result.text.slice(0, 200),
      });
    } catch (err) {
      logger.warn('[SDK] completeJson 解析失敗', {
        label: opts.label ?? 'default',
        attempt,
        message: err instanceof Error ? err.message : String(err),
        raw: result.text.slice(0, 200),
      });
    }
  }
  throw new SdkCallError('AI 回傳的內容不是合法的結構化資料', {
    code: 'E_AI_UNAVAILABLE',
    retryable: false,
    subtype: 'json_parse',
    details: { label: opts.label },
  });
}

/**
 * 流式文本生成：yield 增量 delta，结束时返回完整文本（兜底用）。
 * 实际 delta 由供应商产生，本门面只负责累积 + 错误映射。
 */
export async function* streamText(
  opts: StreamTextOptions,
): AsyncGenerator<{ delta: string }, StreamTextResult, void> {
  const messages = toMessages(opts);
  const providerOpts = toProviderOpts(opts);
  let full = '';
  let usage: SdkUsage | undefined;

  try {
    const iterator = getAIProvider().streamChat(messages, providerOpts);
    let next = await iterator.next();
    while (!next.done) {
      const delta = next.value?.delta;
      if (delta) {
        full += delta;
        yield { delta };
      }
      next = await iterator.next();
    }
    const returned = next.value as { text?: string } | undefined;
    if (returned && typeof returned.text === 'string' && returned.text) {
      full = returned.text;
    }
  } catch (err) {
    if (err instanceof AIProviderError) {
      throw toSdkCallError(err);
    }
    if (err instanceof UserAbortError) {
      // 用户主动中断：不抛错，已流式内容由调用方落库
      return { text: full } as StreamTextResult;
    }
    throw toSdkError(err);
  }

  return { text: full, usage } as StreamTextResult;
}

/**
 * 主动中断一次流式生成（SSE 客户端断开时调用）。
 * 实际中断通过 opts.signal 的 AbortController 生效，这里保留对外语义。
 */
export function createStreamController(): AbortController {
  return new AbortController();
}
