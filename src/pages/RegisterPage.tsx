/**
 * 注册页（V2 · T02）
 *
 * 关键行为：**注册会带上当前浏览器里的匿名 userId**（`attachUserId`），
 * 服务端复用同一行 users，所以「注册」不会把之前聊的角色 / 记忆 / 会话清空——
 * 这不是附带的好处，而是「老用户零迁移」的核心设计（设计文档 §9.1 场景 B）。
 *
 * 出生日期**选填**：填了且未满 18 岁会启用未成年强化保护；
 * 不填**不代表降低保护**——通用安全条款对所有用户无条件生效。这句话必须写在页面上。
 */

import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { AuthForm } from '@/components/auth/AuthForm';
import { Input } from '@/components/common/Input';
import { useAuth } from '@/hooks/useAuth';
import { humanizeError } from '@/api/client';

export function RegisterPage(): React.ReactElement {
  const navigate = useNavigate();
  const { register, authenticated } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (authenticated) return <Navigate to="/" replace />;

  const handleSubmit = async (values: { email: string; password: string }): Promise<void> => {
    setError(null);
    try {
      await register({
        email: values.email,
        password: values.password,
        displayName: displayName.trim() || undefined,
        // 空串视为「不填」→ 传 null 给后端
        birthDate: birthDate.trim() ? birthDate.trim() : null,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(humanizeError(err));
    }
  };

  return (
    <>
      <AppHeader title="註冊" showBack={false} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 xl-no-scrollbar">
        <div className="mb-6">
          <h2 className="text-[19px] font-semibold text-[var(--xl-ink)]">建立帳號</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--xl-sub)]">
            註冊後，你現在這個瀏覽器裡已經聊過的內容
            <span className="text-[var(--xl-ink)]">會原封不動保留</span>
            ——我們是直接把這個匿名帳號轉正，不會重新開始。
          </p>
        </div>

        <AuthForm
          submitLabel="註冊"
          onSubmit={handleSubmit}
          error={error}
          passwordRule="register"
        >
          <Input
            label="暱稱（選填）"
            placeholder="他該怎麼稱呼你"
            maxLength={40}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Input
            label="出生日期（選填）"
            type="date"
            value={birthDate}
            hint="選填。填了才知道要不要啟用未成年的額外保護；不填也一樣受安全保護。"
            onChange={(e) => setBirthDate(e.target.value)}
          />
        </AuthForm>

        <div className="pt-4 text-center text-[13px] text-[var(--xl-sub)]">
          已經有帳號？
          <Link to="/login" className="ml-1 text-[var(--xl-blush-deep)] underline">
            去登入
          </Link>
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-[var(--xl-sub)]/70">
          註冊後你隨時可以在「設定 → 帳號」裡改密碼、查看登入的裝置，或刪除全部資料。
        </p>
      </div>
    </>
  );
}

export default RegisterPage;
