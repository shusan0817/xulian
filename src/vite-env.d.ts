/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 生产环境若前后端不同源，用此变量指定 API 正式地址，例如 https://api.yourdomain.com；同源部署留空 */
  readonly VITE_API_BASE_URL?: string;
}

/**
 * 浏览器侧全局类型补充。
 * 这里只放「确实需要但 TS 内置 lib 没给」的声明，不放 any。
 */

interface NavigatorStandalone extends Navigator {
  /** iOS Safari「添加到主屏幕」后为 true（Web Push 在 iOS 上必须先 standalone） */
  standalone?: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var navigator: NavigatorStandalone;
}

export {};
