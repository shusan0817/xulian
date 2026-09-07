import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import App from './App';
import { APP_CONFIG } from './config';
import './index.css';

/**
 * 应用入口
 *
 * 说明：这里不再引入 TDesign 的全量样式（约 1MB），
 * 手机端只需要 index.css 里那套 CSS 变量 + Tailwind。
 * 基础组件（Button/Input/Modal/Toast…）都是自写的，见 src/components/common/。
 *
 * Service Worker 在 `public/sw.js`（推送通知 + 离线外壳）。
 * 这里只做注册：订阅推送的时机由用户在设置页主动触发，
 * 因为浏览器要求通知权限必须在用户手势中请求。
 */

document.title = APP_CONFIG.name;

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 掛載點');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    {/*
      改用 HashRouter（原 BrowserRouter 在 GitHub Pages 项目页上，
      深链接 /xulian/chat 等会踩平台默认 404 白屏，因为 GitHub Pages 不支持服务端 rewrite）。
      HashRouter 的 URL 形如 /xulian/#/chat，hash 不发服务器请求，
      GitHub Pages 永远只服务 /xulian/（index.html），深链接永不 404。
    */}
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);

/**
 * 注册 Service Worker。
 * 只在生产构建或 HTTPS/localhost 下注册——dev 环境下 Vite 的 HMR
 * 与 SW 缓存容易打架，导致改了代码看不到效果。
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {
      // 注册失败不影响主功能（App 内收件箱是保底触达通道）
    });
  });
}

// 启动成功标志：供 index.html 自愈引导判断（5 秒未启动则硬刷新拉最新版）。
// 成功启动后清掉重试计数，保证下次真遇到旧缓存仍拥有完整 3 次重试额度。
try {
  (window as unknown as { __XULIAN_BOOTED__?: boolean }).__XULIAN_BOOTED__ = true;
  sessionStorage.removeItem('xulian_reload');
} catch (e) {}
