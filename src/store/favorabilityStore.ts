import { useSyncExternalStore } from 'react';

export type AtmosphereEmotion = 'sweet' | 'warm' | 'sad' | 'angry' | 'normal';

const VALID_EMOTIONS: AtmosphereEmotion[] = ['sweet', 'warm', 'sad', 'angry', 'normal'];

export interface FavorabilityState {
  /** 0~100，初始 50 */
  favorability: number;
  atmosphere: AtmosphereEmotion;
  /** 每次数值/氛围变化 +1，用于触发 Pulse 动画 */
  pulse: number;
}

const INITIAL: FavorabilityState = { favorability: 50, atmosphere: 'normal', pulse: 0 };

let state: FavorabilityState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FavorabilityState {
  return state;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 去掉可能的 ```json ... ``` 围栏，避免模型包裹代码块导致解析失败 */
function stripFences(raw: string): string {
  const s = raw.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : s;
}

interface AiReplyShape {
  reply?: unknown;
  favorability_change?: unknown;
  emotion?: unknown;
}

/**
 * 解析 AI 响应文本并更新好感度/氛围。
 * 返回用于聊天气泡展示的文本：解析成功=reply，失败=原始文本（兜底）。
 * 务必在 React state updater 之外调用，避免 StrictMode 双调用导致好感度翻倍。
 */
export function applyAiReply(raw: string): string {
  const clean = stripFences(raw);
  let display = raw;
  try {
    const data = JSON.parse(clean) as AiReplyShape;
    if (data && typeof data.reply === 'string') {
      display = data.reply;
      const delta = Number(data.favorability_change);
      const emo =
        typeof data.emotion === 'string' && (VALID_EMOTIONS as string[]).includes(data.emotion)
          ? (data.emotion as AtmosphereEmotion)
          : null;
      const nextFav = clamp(
        Math.round(state.favorability + (Number.isFinite(delta) ? delta : 0)),
        0,
        100,
      );
      const nextAtm = emo ?? state.atmosphere;
      const changed = nextFav !== state.favorability || nextAtm !== state.atmosphere;
      state = {
        favorability: nextFav,
        atmosphere: nextAtm,
        pulse: changed ? state.pulse + 1 : state.pulse,
      };
      emit();
      return display;
    }
  } catch {
    /* 解析失败 → 走下方兜底 */
  }
  // 兜底：模型未按格式输出纯文本时，保底 +1，emotion 保持当前
  const nextFav = clamp(state.favorability + 1, 0, 100);
  const changed = nextFav !== state.favorability;
  state = {
    ...state,
    favorability: nextFav,
    pulse: changed ? state.pulse + 1 : state.pulse,
  };
  emit();
  return display;
}

/** 纯函数：历史消息清洗用，只取 reply 不改动全局状态 */
export function extractReply(raw: string): string {
  const clean = stripFences(raw);
  try {
    const data = JSON.parse(clean) as AiReplyShape;
    if (data && typeof data.reply === 'string') return data.reply;
  } catch {
    /* ignore */
  }
  return raw;
}

export function useFavorability(): FavorabilityState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 仅供调试/重置 */
export function resetFavorability(): void {
  state = { ...INITIAL, pulse: state.pulse + 1 };
  emit();
}
