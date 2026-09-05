/**
 * 密码输入框
 *
 * 三件真事，不是装饰：
 * 1. 眼睛按钮切换明文（移动端长密码很容易打错）；
 * 2. 实时给出强度提示（≥8 位 + 字母 + 数字），与服务端 `checkPassword` 口径一致；
 * 3. 关闭自动填充建议里的「新密码自动生成」，避免浏览器把密码填到昵称框。
 */

import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/components/common/Input';

export interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> {
  label?: string;
  error?: string;
  /** 是否显示强度提示（注册页需要，登录页不需要） */
  showStrength?: boolean;
  className?: string;
}

/** 与服务端 `authService.checkPassword` 保持同一套规则 */
export function passwordHint(password: string): string {
  if (!password) return '至少 8 個字，要有英文字母和數字';
  if (password.length < 8) return `還差 ${8 - password.length} 個字`;
  if (!/[A-Za-z]/.test(password)) return '還要有英文字母';
  if (!/\d/.test(password)) return '還要有數字';
  return '可以使用';
}

export function PasswordField({
  label = '密碼',
  error,
  showStrength = false,
  className = '',
  value,
  ...rest
}: PasswordFieldProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const text = typeof value === 'string' ? value : '';
  const hint = passwordHint(text);

  return (
    <div className={`relative ${className}`}>
      <Input
        {...rest}
        value={value}
        type={visible ? 'text' : 'password'}
        label={label}
        autoComplete="current-password"
        // 无 error 且开启强度提示时，把强度提示放进 hint 槽（复用 Input 的样式）
        hint={showStrength ? hint : undefined}
        error={error}
        className="pr-12"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '隱藏密碼' : '顯示密碼'}
        className="absolute right-2 top-[30px] flex h-8 w-9 items-center justify-center rounded-full text-[var(--xl-sub)] active:bg-[var(--xl-mist)]"
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

export default PasswordField;
