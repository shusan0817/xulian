/**
 * 前端应用配置
 *
 * 只放**不会随接口变化**的静态信息；情绪/策略/阶段这类元数据一律从
 * `GET /api/config` 拉取（需求 §27.2：不做假 UI）。
 */

import {
  APP_NAME,
  APP_TAGLINE,
  APP_VERSION,
  LS_KEY_AUTH_TOKEN,
  LS_KEY_THEME,
  LS_KEY_USER_ID,
} from '@shared/constants';

export const APP_CONFIG = {
  /** 应用名称 */
  name: APP_NAME,

  /** Logo 上显示的首字 */
  nameInitial: '需',

  /** 一句话定位 */
  tagline: APP_TAGLINE,

  /** 应用描述 */
  description: '一個記得你、也懂你的 AI 陪伴角色',

  /** 版本号（与 package.json 保持一致） */
  version: APP_VERSION,
} as const;

/** localStorage 键名集中管理，避免散落字符串 */
export const STORAGE_KEYS = {
  userId: LS_KEY_USER_ID,
  theme: LS_KEY_THEME,
  draft: 'xulian.chatDraft',
  /** 会话 token（`Authorization: Bearer`）；登出时清除 */
  token: LS_KEY_AUTH_TOKEN,
} as const;

/** 移动端最大内容宽度：桌面浏览器预览时呈现手机边框 */
export const PHONE_MAX_WIDTH = 480;

/** 底部 Tab 定义（顺序即展示顺序） */
export const TABS = [
  { key: 'home', label: '首頁', path: '/', icon: 'home' },
  { key: 'characters', label: '角色', path: '/characters', icon: 'users' },
  { key: 'memories', label: '記憶', path: '/memories', icon: 'book' },
  { key: 'settings', label: '我的', path: '/settings', icon: 'user' },
] as const;

export type TabKey = (typeof TABS)[number]['key'];

export default APP_CONFIG;
