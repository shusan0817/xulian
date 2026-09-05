/**
 * 头像组件
 *
 * 决策 9：MVP 不支持上传图片，头像是「渐变背景 + emoji / 文字」的组合。
 * 背景色直接来自 AvatarSpec.bg（CSS gradient 字符串）。
 */

import type { AvatarSpec } from '@shared/types';

export interface AvatarProps {
  /** 头像规格；为空时用 name 首字兜底 */
  spec?: AvatarSpec | null;
  name?: string;
  size?: number;
  /** 是否显示一圈品牌色描边（AI 头像常用） */
  ring?: boolean;
  className?: string;
}

const FALLBACK_BG = 'linear-gradient(135deg,#EFEAF6,#D9C6F2)';

export function Avatar({
  spec,
  name = '',
  size = 48,
  ring = false,
  className = '',
}: AvatarProps): React.ReactElement {
  const background = spec?.bg || FALLBACK_BG;
  // emoji 优先；没有 emoji 就显示名字首字，保证任何情况都不出现空白方块
  const content = spec?.value?.trim() ? spec.value : name.trim().slice(0, 1) || '需';
  const fontSize = spec?.value?.trim() ? Math.round(size * 0.5) : Math.round(size * 0.42);

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full ${
        ring ? 'ring-2 ring-[var(--xl-blush)]/50' : ''
      } ${className}`}
      style={{
        width: size,
        height: size,
        background,
        fontSize,
        lineHeight: 1,
        color: '#FFFFFF',
        textShadow: '0 1px 2px rgba(43,39,51,0.18)',
      }}
      aria-label={name || 'avatar'}
      role="img"
    >
      <span style={{ fontSize }}>{content}</span>
    </div>
  );
}

export default Avatar;
