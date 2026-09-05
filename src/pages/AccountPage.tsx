/**
 * 账号页（V2 · T02）
 *
 * 全部数据来自真实接口，没有一项是前端编的：
 * - `/api/auth/me`        账号资料（信箱、昵称、未成年状态、当前会话）
 * - `/api/auth/sessions`  目前登入的裝置
 * - `/api/auth/password`  改密碼（成功後其他裝置立即被踢下線，數字由後端回傳）
 * - `/api/auth/birth-date` 出生日期（選填）
 *
 * 未註冊（匿名）時本頁不假裝有帳號，而是給一條明確的「去註冊」入口。
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Loading } from '@/components/common/Loading';
import { PasswordField } from '@/components/auth/PasswordField';
import { toast } from '@/components/common/Toast';
import { apiDelete, apiGet, apiPatch, humanizeError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import type { SessionListResponse } from '@/types/api';
import { formatRelativeTime } from '@/utils/time';

export function AccountPage(): React.ReactElement {
  const navigate = useNavigate();
  const { account, authenticated, logout, refresh, changePassword } = useAuth();

  const [sessions, setSessions] = useState<SessionListResponse['items']>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [birthDate, setBirthDate] = useState('');
  const [birthBusy, setBirthBusy] = useState(false);

  const loadSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true);
    try {
      const res = await apiGet<SessionListResponse>('/api/auth/sessions');
      setSessions(res.items ?? []);
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  // 账号信息到位后再拉会话列表（未登录时这两件事都跳过，不发无谓的请求）
  useEffect(() => {
    if (!authenticated) {
      setSessionsLoading(false);
      return;
    }
    void loadSessions();
  }, [authenticated, loadSessions]);

  useEffect(() => {
    setBirthDate(account?.user.birthDate ?? '');
  }, [account?.user.birthDate]);

  const submitPassword = async (): Promise<void> => {
    setPasswordError(null);
    if (!oldPassword) {
      setPasswordError('請填目前的密碼');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('新密碼至少要 8 個字');
      return;
    }
    setPasswordBusy(true);
    try {
      const revoked = await changePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      toast.success(
        revoked > 0 ? `密碼已更新，${revoked} 個其他裝置已登出` : '密碼已更新',
      );
      void loadSessions();
    } catch (err) {
      setPasswordError(humanizeError(err));
    } finally {
      setPasswordBusy(false);
    }
  };

  const submitBirthDate = async (): Promise<void> => {
    setBirthBusy(true);
    try {
      await apiPatch('/api/auth/birth-date', {
        birthDate: birthDate.trim() ? birthDate.trim() : null,
      });
      await refresh();
      toast.success('出生日期已更新');
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setBirthBusy(false);
    }
  };

  const revokeSession = async (sessionId: string): Promise<void> => {
    try {
      await apiDelete(`/api/auth/sessions/${sessionId}`);
      toast.success('已登出該裝置');
      await loadSessions();
    } catch (err) {
      toast.error(humanizeError(err));
    }
  };

  const doLogout = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  // ---- 未登录：不假装有账号 ----
  if (!authenticated || !account) {
    return (
      <>
        <AppHeader title="帳號" />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-6 xl-no-scrollbar">
          <div className="rounded-2xl bg-[var(--xl-card)] p-4 shadow-[var(--xl-shadow)]">
            <h3 className="text-[15px] font-semibold text-[var(--xl-ink)]">還沒登入</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--xl-sub)]">
              現在是用「匿名」的方式在使用，資料只存在這台裝置上。
              註冊一個帳號，換手機或清掉瀏覽器資料時對話與記憶才不會不見。
            </p>
            <div className="mt-3 flex gap-2">
              <Button block onClick={() => navigate('/register')}>
                註冊
              </Button>
              <Button block variant="secondary" onClick={() => navigate('/login')}>
                登入
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const cardClass = 'rounded-2xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]';
  const sectionTitle =
    'mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--xl-sub)]';

  return (
    <>
      <AppHeader title="帳號" />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 xl-no-scrollbar">
        {/* ---- 基本资料 ---- */}
        <section>
          <h3 className={sectionTitle}>基本資料</h3>
          <div className={`${cardClass} divide-y divide-[var(--xl-mist)] p-4`}>
            <Row label="信箱" value={account.email ?? '—'} />
            <Row label="暱稱" value={account.user.displayName || '—'} />
            <Row label="方案" value={account.user.plan === 'free' ? '免費' : account.user.plan} />
            <Row
              label="未成年保護"
              value={account.isMinor ? '已啟用（未滿 18 歲）' : '未啟用（未滿 18 歲才會啟用）'}
            />
            <Row
              label="目前會話到期"
              value={
                account.session
                  ? formatRelativeTime(account.session.expiresAt)
                  : '—'
              }
            />
          </div>
          <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-[var(--xl-sub)]/80">
            未成年保護只影響「額外加強」的那一層。
            不論是否填出生日期，安全規則都對所有人一視同仁地生效。
          </p>
        </section>

        {/* ---- 出生日期 ---- */}
        <section>
          <h3 className={sectionTitle}>出生日期（選填）</h3>
          <div className={`${cardClass} space-y-3 p-4`}>
            <Input
              type="date"
              value={birthDate}
              hint="選填。填了才知道要不要啟用未成年的額外保護。"
              onChange={(e) => setBirthDate(e.target.value)}
            />
            <Button block variant="secondary" loading={birthBusy} onClick={() => void submitBirthDate()}>
              儲存出生日期
            </Button>
          </div>
        </section>

        {/* ---- 修改密码 ---- */}
        <section>
          <h3 className={sectionTitle}>修改密碼</h3>
          <div className={`${cardClass} space-y-3 p-4`}>
            <PasswordField
              label="目前的密碼"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
            <PasswordField
              label="新密碼"
              showStrength
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            {passwordError ? (
              <p className="rounded-xl bg-[var(--xl-blush)]/10 px-3 py-2 text-[13px] text-[var(--xl-blush-deep)]">
                {passwordError}
              </p>
            ) : null}
            <Button block loading={passwordBusy} onClick={() => void submitPassword()}>
              更新密碼
            </Button>
            <p className="text-[11px] leading-relaxed text-[var(--xl-sub)]/80">
              更新後，其他裝置上的登入會立刻失效（你自己這台會保持登入）。
            </p>
          </div>
        </section>

        {/* ---- 登入的裝置 ---- */}
        <section>
          <h3 className={sectionTitle}>登入的裝置</h3>
          <div className={cardClass}>
            {sessionsLoading ? (
              <Loading label="載入中…" />
            ) : sessions.length === 0 ? (
              <p className="p-4 text-[13px] text-[var(--xl-sub)]">沒有其他登入中的裝置</p>
            ) : (
              <ul className="divide-y divide-[var(--xl-mist)]">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] text-[var(--xl-ink)]">
                        {describeDevice(s.userAgent)}
                        {s.current ? (
                          <span className="ml-1.5 rounded-full bg-[var(--xl-mint)]/20 px-1.5 py-0.5 text-[10px] text-[var(--xl-mint)]">
                            這台
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--xl-sub)]">
                        {s.ipPrefix ? `${s.ipPrefix}.* · ` : ''}
                        最近使用 {formatRelativeTime(s.lastUsedAt)}
                      </p>
                    </div>
                    {s.current ? null : (
                      <button
                        onClick={() => void revokeSession(s.id)}
                        className="flex-none rounded-full px-2.5 py-1 text-[12px] text-[var(--xl-blush-deep)]"
                      >
                        登出
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <Button block variant="danger" onClick={() => void doLogout()}>
          登出這個帳號
        </Button>

        <div className="h-2" />
      </div>
    </>
  );
}

// ============================================================
// 辅助
// ============================================================

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="text-[13px] text-[var(--xl-sub)]">{label}</span>
      <span className="min-w-0 truncate text-[14px] text-[var(--xl-ink)]">{value}</span>
    </div>
  );
}

/**
 * 从 User-Agent 里读出一个能看的装置名。
 * 只做最粗略的归类：认不出来就显示「未知裝置」——
 * 宁可显示未知，也不要编一个看起来很像真的装置名。
 */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return '未知裝置';
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'Mac';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('linux')) return 'Linux';
  // 去掉版本号，只留浏览器名（curl / Postman 之类调试客户端也能认）
  const match = /^([a-z]+)\//.exec(ua);
  return match ? match[1] ?? '未知裝置' : '未知裝置';
}

export default AccountPage;
