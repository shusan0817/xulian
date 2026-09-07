/**
 * 聊天场景选择器（聊天页头部与角色编辑页复用）
 *
 * 行为：
 *  - 选中预设场景 → onChange(preset)
 *  - 选中「自订场景」→ 展开一个输入框，确认后 onChange({ id:'custom', label:'自訂', hint })
 *  - 清除场景 → onChange(null)
 */

import { useEffect, useRef, useState } from 'react';
import { CHAT_SCENES, type ChatScene } from '@shared/constants';

export interface SceneValue {
  id: string;
  label: string;
  hint: string;
}

interface SceneSelectorProps {
  value: SceneValue | null;
  onChange: (scene: SceneValue | null) => void;
}

/** 选择列表里跳过 'custom'（它用单独的「自订」入口处理） */
const PRESETS: ChatScene[] = CHAT_SCENES.filter((s) => s.id !== 'custom');
const CUSTOM_SCENE: ChatScene = CHAT_SCENES.find((s) => s.id === 'custom') ?? {
  id: 'custom',
  label: '自訂場景',
  emoji: '✨',
  hint: '',
};

export function SceneSelector({ value, onChange }: SceneSelectorProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭面板
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomMode(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const chipClass = (active: boolean): string =>
    `rounded-full px-3 py-1.5 text-[13px] transition-all active:scale-95 ${
      active ? 'bg-[var(--xl-blush)] text-white' : 'bg-[var(--xl-mist)] text-[var(--xl-ink)]'
    }`;

  // 「場景：{emoji} {label}」：用 value.id 在清单里找回 emoji（custom 用 ✨）
  const headerEmoji = value
    ? (CHAT_SCENES.find((s) => s.id === value.id)?.emoji ?? '✨')
    : '';

  const handlePick = (scene: ChatScene): void => {
    onChange({ id: scene.id, label: scene.label, hint: scene.hint });
    setOpen(false);
    setCustomMode(false);
  };

  const handleCustomConfirm = (): void => {
    const text = customText.trim();
    if (!text) return;
    onChange({ id: 'custom', label: '自訂', hint: text });
    setOpen(false);
    setCustomMode(false);
    setCustomText('');
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setCustomMode(false);
        }}
        className={chipClass(false)}
      >
        {value ? `場景：${headerEmoji} ${value.label}` : '＋ 場景'}
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-64 rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)] ring-1 ring-[var(--xl-mist)]">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map((scene) => (
              <button
                key={scene.id}
                type="button"
                onClick={() => handlePick(scene)}
                className={chipClass(value?.id === scene.id)}
              >
                {scene.emoji} {scene.label}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setCustomMode((v) => !v)}
              className={chipClass(value?.id === 'custom' || customMode)}
            >
              {CUSTOM_SCENE.emoji} {CUSTOM_SCENE.label}
            </button>
          </div>

          {customMode ? (
            <div className="space-y-2 border-t border-[var(--xl-mist)] pt-2">
              <textarea
                autoFocus
                rows={3}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="描述你們現在的場景，例如：我們是鄰居，常在樓下便利商店遇到。"
                className="w-full resize-none rounded-2xl bg-[var(--xl-mist)]/70 px-3 py-2 text-[14px] text-[var(--xl-ink)] outline-none focus:ring-2 focus:ring-[var(--xl-blush)]/45"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCustomMode(false)}
                  className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[13px] text-[var(--xl-sub)] active:scale-95"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCustomConfirm}
                  className="rounded-full bg-[var(--xl-blush)] px-3 py-1 text-[13px] text-white active:scale-95"
                >
                  確定
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-2 border-t border-[var(--xl-mist)] pt-2">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
                setCustomMode(false);
              }}
              className="w-full rounded-full bg-[var(--xl-mist)]/70 px-3 py-1.5 text-[13px] text-[var(--xl-sub)] active:scale-95"
            >
              清除場景
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default SceneSelector;
