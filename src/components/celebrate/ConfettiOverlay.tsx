/**
 * 节日彩带特效（需求：纪念日里程碑的「页面节日特效」）
 *
 * 纯 CSS 动画 + 随机参数，无第三方依赖。覆盖全屏（pointer-events-none，不挡操作），
 * 播放 duration 毫秒后自动卸载并回调 onDone。颜色取自品牌同系（blush / 点缀色）。
 */

import { useEffect, useState } from 'react';

const COLORS = [
  '#F7A8B8',
  '#F472B6',
  '#FB7185',
  '#FBCFE8',
  '#C4B5FD',
  '#FCD34D',
  '#A7F3D0',
  '#93C5FD',
];

interface Piece {
  id: number;
  left: number;
  delay: number;
  dur: number;
  color: string;
  size: number;
  rot: number;
}

export interface ConfettiOverlayProps {
  /** 播放时长（毫秒），到点自动消失 */
  duration?: number;
  onDone?: () => void;
}

export function ConfettiOverlay({ duration = 4500, onDone }: ConfettiOverlayProps): React.ReactElement | null {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const arr: Piece[] = Array.from({ length: 64 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.7,
      dur: 2.6 + Math.random() * 2.2,
      color: COLORS[i % COLORS.length],
      size: 6 + Math.random() * 9,
      rot: Math.random() * 360,
    }));
    setPieces(arr);
    const t = window.setTimeout(() => {
      setHidden(true);
      onDone?.();
    }, duration);
    return () => window.clearTimeout(t);
  }, [duration, onDone]);

  if (hidden) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[80] overflow-hidden" aria-hidden="true">
      <style>{`@keyframes xl-confetti-fall{0%{transform:translateY(-12vh) rotate(0deg);opacity:1}100%{transform:translateY(112vh) rotate(720deg);opacity:.85}}`}</style>
      {pieces.map((p) => (
        <span
          key={p.id}
          style={{
            position: 'absolute',
            left: `${p.left}%`,
            top: 0,
            width: p.size,
            height: p.size * 0.55 + 4,
            background: p.color,
            borderRadius: 2,
            opacity: 0.95,
            animation: `xl-confetti-fall ${p.dur}s linear ${p.delay}s forwards`,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

export default ConfettiOverlay;
