/**
 * 「需恋」Service Worker
 *
 * 只做三件事，保持极简可控：
 * 1. 接收 Web Push，弹出通知；
 * 2. 点击通知时把用户带到对应的聊天页（带上角色与消息 ID）；
 * 3. 基础离线兜底：网络失败时回退到已缓存的 App 外壳。
 *
 * 不缓存 /api 请求——聊天内容是实时数据，缓存会导致用户看到旧消息。
 */

const CACHE_NAME = 'xulian-shell-v3';
// 用相对 scope 的路径（SW 自身位于 /xulian/sw.js，所以 './' = '/xulian/'），
// 不要写死根路径 '/' 或 '/index.html'，否则在 GitHub Pages 子路径下会缓存错页。
const SHELL_ASSETS = ['./', './index.html', './manifest.webmanifest'];

function scopePath() {
  try {
    return new URL(self.registration.scope).pathname.replace(/\/$/, '');
  } catch {
    return '/xulian';
  }
}

// ---- 安装：预缓存 App 外壳 ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

// ---- 激活：清理旧缓存 ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// ---- 推送：显示通知 ----
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = { title: '需戀', body: '有新的訊息', url: '/', tag: 'xulian' };
  try {
    const parsed = event.data.json();
    payload = { ...payload, ...parsed };
  } catch {
    // 纯文本负载
    payload.body = event.data.text() || payload.body;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      // 同一角色的消息堆叠显示，避免刷屏
      renotify: false,
      data: { url: payload.url },
      requireInteraction: false,
    }),
  );
});

// ---- 点击通知：带到对应页面 ----
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  const targetUrl = raw.startsWith('http')
    ? raw
    : scopePath() + (raw.startsWith('/') ? raw : '/' + raw);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // 已经有打开的页面 → 聚焦并导航到目标
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        // 没有 → 新开一个
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        return undefined;
      }),
  );
});

// ---- 请求拦截：只兜底外壳，不碰 /api ----
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API 请求与 SSE 一律不缓存
  if (url.pathname.startsWith('/api/')) return;
  // 只处理 GET
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(request).then((cached) => cached || caches.match('./index.html')),
    ),
  );
});
