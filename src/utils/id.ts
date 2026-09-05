/**
 * ID 生成
 *
 * 优先用 crypto.randomUUID()（现代浏览器在 HTTPS / localhost 下都可用）；
 * 不支持时退回 getRandomValues 手工拼 v4，保证任何环境都能拿到一个唯一 ID。
 */

/** 生成一个 RFC 4122 v4 UUID */
export function uuid(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    // 按 v4 规范设置版本位与变体位
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // 极端兜底（非安全上下文且没有 crypto）：时间戳 + 随机数
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/** 短 ID：给 React key 用，不需要全局唯一 */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
