/**
 * 登录 / 注册共用表单
 *
 * 这个组件承担**真实的校验逻辑**，不是纯布局壳子：
 * - 邮箱做形状校验（与服务端 `isValidEmail` 同一条正则）；
 * - 密码按场景校验（登录只查非空，注册查强度规则）；
 * - 校验不过直接显示原因，**不让用户白跑一次网络请求**。
 *
 * 服务端的校验不会因此省略——前端校验只是为了体验，安全边界永远在后端。
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { PasswordField } from '@/components/auth/PasswordField';

export interface AuthFormValues {
  email: string;
  password: string;
}

export interface AuthFormProps {
  submitLabel: string;
  /** 校验通过后调用；返回的 Promise reject 时表单恢复可提交 */
  onSubmit: (values: AuthFormValues) => Promise<void> | void;
  /** 'login' 只查非空；'register' 查 ≥8 位 + 字母 + 数字 */
  passwordRule?: 'login' | 'register';
  loading?: boolean;
  /** 服务端返回的错误（人话） */
  error?: string | null;
  /** 额外字段（昵称 / 出生日期），渲染在密码框之后 */
  children?: ReactNode;
  /** 底部区域（「還沒有帳號？去註冊」这类链接） */
  footer?: ReactNode;
}

/** 与服务端 authService 同一条邮箱正则，保证前后端口径一致 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function AuthForm({
  submitLabel,
  onSubmit,
  passwordRule = 'login',
  loading = false,
  error = null,
  children,
  footer,
}: AuthFormProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitDisabled = busy || loading;

  const validate = (): string | null => {
    const trimmed = email.trim();
    if (!trimmed) return '請填信箱';
    if (!EMAIL_RE.test(trimmed)) return '信箱格式不對';
    if (!password) return '請填密碼';
    if (passwordRule === 'register') {
      if (password.length < 8) return '密碼至少要 8 個字';
      if (!/[A-Za-z]/.test(password)) return '密碼要有英文字母';
      if (!/\d/.test(password)) return '密碼要有數字';
    }
    return null;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    // 阻止默认提交很重要：否则整页刷新，单页应用的登录态就没了
    event.preventDefault();
    if (submitDisabled) return;

    const problem = validate();
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      await onSubmit({ email: email.trim(), password });
    } finally {
      setBusy(false);
    }
  };

  const shownError = localError ?? error;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5" noValidate>
      <Input
        label="信箱"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <PasswordField
        value={password}
        showStrength={passwordRule === 'register'}
        autoComplete={passwordRule === 'register' ? 'new-password' : 'current-password'}
        onChange={(e) => setPassword(e.target.value)}
      />

      {children}

      {shownError ? (
        <p className="rounded-xl bg-[var(--xl-blush)]/10 px-3 py-2 text-[13px] text-[var(--xl-blush-deep)]">
          {shownError}
        </p>
      ) : null}

      <Button type="submit" block size="lg" loading={submitDisabled}>
        {submitDisabled ? '處理中…' : submitLabel}
      </Button>

      {footer}
    </form>
  );
}

export default AuthForm;
