/**
 * JSON 列的读写辅助
 *
 * 约定（架构文档 §3.2）：任何 JSON 解析失败都**回退到默认值并 warn**，绝不抛异常。
 * 理由：一条脏数据不应该让整个服务不可用，更不应该让首页白屏。
 */

import { logger } from '../logger.js';

/**
 * 解析 JSON 列，失败时返回 fallback。
 * @param raw 数据库里读出来的原始字符串
 * @param fallback 解析失败时的兜底值（必须是一个全新对象，避免被上游改写后污染）
 * @param context 用于日志定位，格式 `表名.列名`
 */
export function jsonGet<T>(raw: unknown, fallback: T, context = 'unknown'): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') {
    // 理论上不会发生（列都是 TEXT），但真出现了也别崩
    logger.warn('[DB] JSON 列不是字符串，回退默认值', { context, type: typeof raw });
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    logger.warn('[DB] JSON 解析失敗，回退預設值', { context, raw: raw.slice(0, 120) });
    return fallback;
  }
}

/**
 * 解析 JSON 数组列，失败时返回空数组。
 * 单独提供一个数组版本是因为调用点很多，省得每处都写 `?? []`。
 */
export function jsonArray(raw: unknown, context = 'unknown'): string[] {
  const parsed = jsonGet<unknown>(raw, [], context);
  if (!Array.isArray(parsed)) {
    logger.warn('[DB] JSON 陣列欄位內容不是陣列，回退空陣列', { context });
    return [];
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

/** 序列化成写入数据库的字符串 */
export function jsonSet(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    logger.warn('[DB] JSON 序列化失敗，寫入空物件', {});
    return '{}';
  }
}

/**
 * 浅合并：把补丁合并进原对象，只覆盖 `undefined !== value` 的键。
 * 用于 PATCH 接口（用户只改了一个字段，不能把其它字段冲成 undefined）。
 */
export function jsonMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
