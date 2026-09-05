/**
 * 纯前端 UI 类型（不参与任何网络传输）
 */

export type ThemeMode = 'light' | 'dark';

export interface ToastItem {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
  /** 自动关闭毫秒数；0 表示不自动关闭 */
  duration: number;
}

/** 底部弹层的一个选项 */
export interface SheetOption {
  key: string;
  label: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

/** 顶部导航条的一颗按钮 */
export interface HeaderAction {
  key: string;
  label: string;
}

/** 列表通用加载状态 */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
