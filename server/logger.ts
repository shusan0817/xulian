/**
 * 分级日志 + 敏感信息脱敏
 *
 * 规范（架构文档 §8.5）：
 * - 格式：`时间 LEVEL [模块] 消息 {结构化字段}`
 * - 日志调用一律带模块前缀：`logger.info('[Chat] 收到消息', {...})`
 * - 禁止打印：完整 prompt（只打长度）、API Key / Token、用户消息全文（默认只打前 30 字 + 长度）
 */

import { env } from './env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// ------------------------------------------------------------
// 敏感信息正则（任何日志输出前都会过一遍）
// ------------------------------------------------------------
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // sk-xxx / ck-xxx 之类的 key
  { re: /\b(sk|ck|ak)-[A-Za-z0-9_\-]{8,}\b/g, replacement: '$1-****' },
  // KEY=value / "key": "value"
  {
    re: /((?:api[_-]?key|auth[_-]?token|token|secret|password)["'\s:=]+)[A-Za-z0-9._\-]{6,}/gi,
    replacement: '$1****',
  },
  // VAPID 私钥（base64url 长串）
  { re: /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/g, replacement: '****' },
];

/**
 * 脱敏：对字符串与对象里的所有字符串字段递归处理。
 * 这是防止 API Key 泄进日志文件的最后一道闸，任何日志出口都必须经过它。
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const { re, replacement } of SECRET_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    // Error 对象的 message/stack 才是重点，直接展开会丢字段，这里单独处理
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redact(value.message),
        stack: env.isDev ? redact(value.stack ?? '') : undefined,
      };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(item);
    }
    return out;
  }
  return value;
}

/** 用户消息摘要：默认只留前 30 字 + 长度，避免整段聊天内容落盘 */
export function textSummary(text: string): string {
  if (env.logFullText) return text;
  const head = text.slice(0, 30);
  return `${head}${text.length > 30 ? '…' : ''} (len=${text.length})`;
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return '';
  try {
    return ` ${JSON.stringify(redact(fields))}`;
  } catch {
    // 循环引用等极端情况下 JSON.stringify 会抛错，这里兜底不让日志把进程打挂
    return ' [unserializable]';
  }
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[env.logLevel]) return;
  const time = new Date().toISOString();
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${formatFields(fields)}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(message: string, fields?: Record<string, unknown>): void {
    write('debug', message, fields);
  },
  info(message: string, fields?: Record<string, unknown>): void {
    write('info', message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    write('warn', message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    write('error', message, fields);
  },
};

export default logger;
