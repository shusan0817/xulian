/**
 * 登录页（V2 · T02）
 *
 * 真实行为：
 * - 提交 → `POST /api/auth/login` → 拿 token → 写 localStorage → 进主页；
 * - 失败时把服务端的人话错误（如「錯誤次數太多，請 15 分鐘後再試」）原样显示，
 *   **不吞错、不假装成功**；
 * - 忘記密碼**不做**（P3，团队拍板 #8），所以这里不放一个点了没反应的假链接。
 */

import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { AuthForm } from '@/components/auth/AuthForm';
import { Logo } from '@/components/common/Logo';
import { useAuth } from '@/hooks/useAuth';
import { humanizeError } from '@/api/client';

export function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const { login, authenticated } = useAuth();
  const [error, setError] = useState<string | null>(null);

  // 已经登录了就别停在登录页
  if (authenticated) return <Navigate to="/" replace />;

  const handleSubmit = async (values: { email: string; password: string }): Promise<void> => {
    setError(null);
    try {
      await login(values.email, values.password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(humanizeError(err));
    }
  };

  return (
    <>
      <AppHeader title="登入" showBack={false} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 xl-no-scrollbar">
        <div className="mb-7 flex flex-col items-center gap-2">
          <Logo size={52} />
          <p className="text-[13px] text-[var(--xl-sub)]">
            登入後，你的對話、記憶與故事會跟著帳號走
          </p>
        </div>

        <AuthForm submitLabel="登入" onSubmit={handleSubmit} error={error} passwordRule="login">
          <div className="pt-1 text-center text-[13px] text-[var(--xl-sub)]">
            還沒有帳號？
            <Link to="/register" className="ml-1 text-[var(--xl-blush-deep)] underline">
              註冊一個
            </Link>
          </div>
        </AuthForm>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--xl-sub)]/70">
          忘記密碼的功能還沒做（排在 P3）。
          <br />
          目前如果真的忘了，只能重新註冊一個帳號。
        </p>
      </div>
    </>
  );
}

export default LoginPage;
