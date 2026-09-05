/**
 * 时间格式化
 *
 * 服务端存的是 ISO 8601 **UTC** 字符串，前端按浏览器本地时区展示。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对时间：刚刚 / 3 分鐘前 / 昨天 14:20 / 9月2日 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;

  if (diff < 0) return '剛剛';
  if (diff < MINUTE) return '剛剛';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分鐘前`;
  if (diff < 6 * HOUR) return `${Math.floor(diff / HOUR)} 小時前`;

  const date = new Date(time);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();

  if (isSameDay(date, now)) return formatClock(date);
  if (isYesterday(date)) return `昨天 ${formatClock(date)}`;
  if (sameYear) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 时钟格式 HH:mm（补零） */
export function formatClock(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(date, yesterday);
}

/**
 * 日期分隔文案：今天 / 昨天 / M月D日
 * 聊天页用它把消息按天分组。
 */
export function formatDateDivider(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (isSameDay(date, now)) return '今天';
  if (isYesterday(date)) return '昨天';
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 当前浏览器时区的 IANA 名称（bootstrap 时上报给服务端） */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
  } catch {
    return 'Asia/Taipei';
  }
}

/** 当前语言（繁中优先） */
export function localLocale(): string {
  return typeof navigator !== 'undefined' ? navigator.language || 'zh-TW' : 'zh-TW';
}
