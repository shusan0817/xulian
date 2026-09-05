/**
 * 情绪展示元数据
 *
 * 数据源是 `@shared/constants` 的 EMOTION_ANCHORS（服务端同一份），
 * 前端**不硬编码**任何情绪文案，避免两端不一致。
 */

import { EMOTION_ANCHORS, type EmotionType } from '@shared/constants';

export interface EmotionDisplay {
  emotion: EmotionType;
  label: string;
  color: string;
  icon: string;
}

/** 取某个情绪的展示信息；未知情绪回落到 calm */
export function getEmotionDisplay(emotion: EmotionType | string | null | undefined): EmotionDisplay {
  const key = (emotion ?? 'calm') as EmotionType;
  const anchor = EMOTION_ANCHORS[key] ?? EMOTION_ANCHORS.calm;
  return {
    emotion: anchor.emotion,
    label: anchor.label,
    color: anchor.color,
    icon: anchor.icon,
  };
}

/** 把 0..1 的强度转成人话（首页状态卡用） */
export function describeIntensity(intensity: number): string {
  if (intensity >= 0.75) return '很強烈';
  if (intensity >= 0.5) return '有點明顯';
  if (intensity >= 0.3) return '淡淡的';
  return '很輕微';
}
