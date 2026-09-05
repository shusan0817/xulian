/**
 * 数据层通用小工具
 *
 * 单独拆一个文件是为了避免 repositories 之间互相 import 造成循环依赖。
 * （架构文档 §7 的文件清单里没有这个文件，属于实现层面的补充：把 id / 时间 /
 * 时区日 / 归一化这几件所有 repo 都要用的小事集中一处。）
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

/** 生成主键（所有表主键都是 TEXT uuid v4） */
export function newId(): string {
  return uuidv4();
}

/** 当前时间的 ISO 8601 UTC 字符串（存储与传输统一用它） */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 把数值夹到 [min, max] */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 把数值夹到 [0,1]（情绪强度、重要度、各种 score 都用它） */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * 计算「用户所在时区的今天」：YYYY-MM-DD
 * 用于每日频控计数与活跃天统计（架构文档 §8.4）。
 */
export function dayKey(date: Date = new Date(), timezone = 'Asia/Taipei'): string {
  try {
    // en-CA 的格式正好是 YYYY-MM-DD，配合 timeZone 直接拿到当地日期
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    // 时区串非法时退回 UTC，保证频控仍然可用（只是"今天"的边界略有偏差）
    return date.toISOString().slice(0, 10);
  }
}

/** 取某个「HH:mm」在当前日期下的分钟数，用于免打扰区间判断 */
export function hhmmToMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return 0;
  const hours = Number.parseInt(match[1] as string, 10);
  const minutes = Number.parseInt(match[2] as string, 10);
  return clamp(hours, 0, 23) * 60 + clamp(minutes, 0, 59);
}

/**
 * 判断「当前分钟数」是否落在免打扰区间内。
 * 免打扰允许跨零点（如 23:00–08:00），所以用两段判断。
 */
export function isWithinDnd(nowMinutes: number, dndStart: string, dndEnd: string): boolean {
  const start = hhmmToMinutes(dndStart);
  const end = hhmmToMinutes(dndEnd);
  if (start === end) return false;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // 跨零点：23:00–08:00 → now >= 23:00 或 now < 08:00
  return nowMinutes >= start || nowMinutes < end;
}

/** 文本归一化：去掉空白与标点，用于记忆去重键 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，。！？、,.!?~～"'「」『』()（）]/g, '').toLowerCase();
}

/** 记忆去重键：sha1(category + ':' + normalize(content)[0:24]) */
export function makeDedupeKey(category: string, content: string): string {
  const normalized = normalizeText(content).slice(0, 24);
  return createHash('sha1').update(`${category}:${normalized}`).digest('hex');
}

/**
 * bigram 集合（用于计算记忆相似度）。
 * 中文没有空格分词，用二元组近似即可，成本低、效果够用。
 */
export function bigrams(text: string): Set<string> {
  const normalized = normalizeText(text);
  const out = new Set<string>();
  if (normalized.length < 2) {
    if (normalized.length === 1) out.add(normalized);
    return out;
  }
  for (let i = 0; i < normalized.length - 1; i += 1) {
    out.add(normalized.slice(i, i + 2));
  }
  return out;
}

/** Jaccard 相似度：|A∩B| / |A∪B| */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 把 unknown 安全地转成数字（数据库读出来的 REAL 理论上是 number，
 * 但驱动在极端情况下可能给 string，这里统一兜一层）。
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** 把 unknown 转成布尔（SQLite 用 INTEGER 0/1 存布尔） */
export function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** 未成年的年龄门槛：小于 18 岁（设计文档 §V2-13 / 团队拍板决策 #3） */
export const MINOR_AGE_THRESHOLD = 18;

/**
 * 解析出生日期（YYYY-MM-DD）。
 * @returns UTC 零点的 Date；格式非法或日期不存在（如 2 月 30 日）时返回 null
 */
export function parseBirthDate(birthDate: string | null | undefined): Date | null {
  if (typeof birthDate !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // 排除 2 月 30 日这类「能构造但会滚动到下个月」的非法日期
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** 由出生日期算出周岁；日期非法时返回 null */
export function ageFromBirthDate(birthDate: string | null | undefined, now: Date = new Date()): number | null {
  const born = parseBirthDate(birthDate);
  if (!born) return null;
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() ||
    (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age < 0 ? null : age;
}

/**
 * 是否未成年（门槛 < 18 岁）。
 *
 * 出生日期是**选填**的：没填时这里返回 false（即「未经年龄验证」）。
 * 但这**不等于降低保护**——L0 通用安全条款对所有用户无条件生效，
 * 未成年强化层只是额外叠加。这一点必须写清楚，否则容易被误读成「不填就绕过保护」。
 */
export function deriveIsMinor(birthDate: string | null | undefined, now: Date = new Date()): boolean {
  const age = ageFromBirthDate(birthDate, now);
  return age !== null && age < MINOR_AGE_THRESHOLD;
}
