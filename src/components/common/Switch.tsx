/**
 * 开关组件
 *
 * 移动端要点：点击区域 44×28（Apple HIG 建议的最小可触达尺寸），
 * 用 role="switch" + aria-checked 让读屏软件也能理解状态。
 */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: SwitchProps): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 flex-none rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-[var(--xl-blush)]' : 'bg-[var(--xl-mist)]'
      }`}
    >
      <span
        className={`absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all ${
          checked ? 'left-[23px]' : 'left-[3px]'
        }`}
      />
    </button>
  );
}
