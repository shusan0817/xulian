/**
 * 设置页（需求 §13 主动聊天设置 / §21 隐私与数据 / §27.2 不做假 UI）
 *
 * 本页最重要的部分是**主动聊天决策可视化**：
 * 它把服务端真实的决策结果（七因子的原始值 / 加权值 / 否决原因码 / 今日已发数）
 * 直接摊开给用户看。用户能验证「AI 为什么没来找我」，
 * 而不是面对一个无法证伪的「AI 会主动聊天」宣传语。
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Switch } from '@/components/common/Switch';
import { useAppState } from '@/hooks/useAppState';
import { useAuth } from '@/hooks/useAuth';
import { useProactive } from '@/hooks/useProactive';
import { usePush } from '@/hooks/usePush';
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  humanizeError,
} from '@/api/client';
import { DEFAULT_ALLOWED_HOURS, PROACTIVE_WEIGHTS } from '@shared/constants';
import type { AICharacter } from '@shared/types';
import type { ProactiveStatus } from '@/hooks/useProactive';

const FACTOR_LABELS: Record<string, string> = {
  idleHours: '許久沒聊',
  userEmotionNeed: '你的情緒需要',
  personaProactivity: '他的主動性',
  topicContinuation: '話題延續',
  relationship: '關係階段',
  timeOfDay: '時段合適',
  aiEmotion: '他的心情',
};

export function SettingsPage(): React.ReactElement {
  const navigate = useNavigate();
  const { user, characters, defaultCharacterId, refresh } = useAppState();
  const { account, authenticated } = useAuth();
  const characterId = defaultCharacterId;
  const { status, scheduler, history, refresh: refreshProactive } = useProactive(characterId);
  const push = usePush();

  const [character, setCharacter] = useState<AICharacter | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<'none' | 'messages' | 'all'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 载入当前角色的主动聊天设置
  useEffect(() => {
    if (!characterId) return;
    void apiGet<{ character: AICharacter }>(`/api/characters/${characterId}`)
      .then((res) => setCharacter(res.character))
      .catch(() => undefined);
  }, [characterId]);

  const [updatedCharacter, setUpdatedCharacter] = useState<AICharacter | null>(null);

  /** 更新角色设置；返回更新后的角色，便于立刻刷新本地 proactiveSettings */
  const updateSettings = async (
    patch: Record<string, unknown>,
  ): Promise<AICharacter | null> => {
    if (!characterId) return null;
    setBusy(true);
    try {
      const res = await apiPatch<{ character: AICharacter }>(
        `/api/characters/${characterId}`,
        patch,
      );
      setUpdatedCharacter(res.character);
      await refreshProactive();
      return res.character;
    } catch (err) {
      setError(humanizeError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  // 生效中的设置：本地刚更新过的优先，否则用服务端载入的值
  const settings = updatedCharacter?.proactiveSettings ?? character?.proactiveSettings;

  /**
   * proactiveSettings 是角色里的一个嵌套对象，
   * 后端 PATCH 不会做深层合并，所以这里必须整包替换。
   */
  const patchProactive = async (
    patch: Partial<NonNullable<AICharacter['proactiveSettings']>>,
  ): Promise<void> => {
    if (!settings) return;
    await updateSettings({ proactiveSettings: { ...settings, ...patch } });
  };

  const doDelete = async (): Promise<void> => {
    if (confirmDelete === 'none' || !user) return;
    setBusy(true);
    try {
      await apiDelete(`/api/users/${user.id}/data?scope=${confirmDelete}`);
      setConfirmDelete('none');
      await refresh();
      navigate('/');
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  };

  const sectionTitle = 'mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--xl-sub)]';
  const cardClass = 'rounded-2xl bg-[var(--xl-card)] shadow-[var(--xl-shadow)]';

  return (
    <>
      <AppHeader title="設定" showBack={false} />

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 xl-no-scrollbar">
        {error ? (
          <p className="rounded-xl bg-[var(--xl-blush)]/10 px-3 py-2 text-[13px] text-[var(--xl-blush-deep)]">
            {error}
          </p>
        ) : null}

        {/* ============ 主动聊天 ============ */}
        <section>
          <h3 className={sectionTitle}>主動聊天</h3>
          <div className={`${cardClass} divide-y divide-[var(--xl-mist)]`}>
            <Row
              title="讓他主動找我"
              desc="關閉後他只會在你先說話時回應"
              control={
                <Switch
                  checked={settings?.enabled ?? true}
                  disabled={busy || !character}
                  onChange={(v) => void updateSettings({ proactiveEnabled: v })}
                  label="主動聊天"
                />
              }
            />
            <Row
              title="根據最近聊天開啟話題"
              desc="他會記得你們聊到一半的事"
              control={
                <Switch
                  checked={settings?.allowTopicContinuation ?? true}
                  disabled={busy || !character}
                  onChange={(v) => void patchProactive({ allowTopicContinuation: v })}
                  label="話題延續"
                />
              }
            />
            <Row
              title="每日上限"
              desc={`今天已發 ${status?.todaySent ?? 0} / ${settings?.dailyLimit ?? 3} 則`}
              control={
                <NumberPicker
                  value={settings?.dailyLimit ?? 3}
                  min={1}
                  max={10}
                  disabled={busy}
                  onChange={(v) => void patchProactive({ dailyLimit: v })}
                />
              }
            />
            <Row
              title="免打擾"
              desc={`${settings?.dndStart ?? '23:00'} – ${settings?.dndEnd ?? '08:00'}`}
              control={<span className="text-[12px] text-[var(--xl-sub)]">時段內不主動</span>}
            />
            <Row
              title="最小間隔"
              desc={`兩則主動消息至少隔 ${settings?.minIntervalHours ?? 4} 小時`}
              control={
                <NumberPicker
                  value={settings?.minIntervalHours ?? 4}
                  min={1}
                  max={24}
                  disabled={busy}
                  onChange={(v) => void patchProactive({ minIntervalHours: v })}
                />
              }
            />
          </div>
        </section>

        {/* ============ 决策可视化（证明不是定时器） ============ */}
        <section>
          <h3 className={sectionTitle}>他現在為什麼（還）沒找我</h3>
          <DecisionPanel status={status} scheduler={scheduler} />
          {scheduler?.enabled ? (
            <button
              onClick={() => void apiPost('/api/proactive/tick', {}).then(() => refreshProactive())}
              className="mt-2 w-full rounded-xl bg-[var(--xl-mist)] py-2 text-[12px] text-[var(--xl-sub)] active:opacity-70"
            >
              手動執行一次檢查
            </button>
          ) : null}

          {history.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-[var(--xl-sub)]">
                最近 {history.length} 次判斷紀錄
              </summary>
              <div className="mt-2 space-y-1">
                {history.slice(0, 6).map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between rounded-lg bg-[var(--xl-mist)]/50 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="text-[var(--xl-sub)]">
                      {t.reasonCode} · {t.decision}
                      {t.score ? ` · ${t.score.toFixed(2)}` : ''}
                    </span>
                    <span className="text-[var(--xl-sub)]/70">
                      {new Date(t.createdAt).toLocaleTimeString('zh-TW', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </section>

        {/* ============ 推送 ============ */}
        <section>
          <h3 className={sectionTitle}>通知</h3>
          <div className={`${cardClass} divide-y divide-[var(--xl-mist)]`}>
            <Row
              title="推播通知"
              desc={
                push.supported.ok
                  ? push.subscribed
                    ? '已開啟'
                    : push.configured
                      ? '尚未訂閱'
                      : '伺服器未設定 VAPID 金鑰'
                  : push.supported.reason
              }
              control={
                <Switch
                  checked={push.subscribed}
                  disabled={push.busy || !push.supported.ok || !push.configured}
                  onChange={(v) => void (v ? push.subscribe() : push.unsubscribe())}
                  label="推播通知"
                />
              }
            />
            {push.subscribed ? (
              <Row
                title="送一則測試通知"
                desc="確認你的裝置收得到"
                control={
                  <button
                    onClick={() => void push.sendTest()}
                    disabled={push.busy}
                    className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[12px] text-[var(--xl-ink)]"
                  >
                    測試
                  </button>
                }
              />
            ) : null}
          </div>
          {push.error ? (
            <p className="mt-1.5 px-1 text-[11px] text-[var(--xl-blush-deep)]">{push.error}</p>
          ) : null}
        </section>

        {/* ============ 隐私 ============ */}
        <section>
          <h3 className={sectionTitle}>隱私與資料</h3>
          <div className={`${cardClass} divide-y divide-[var(--xl-mist)]`}>
            <Row
              title="長期記憶"
              desc="可到「記憶」頁逐條查看與刪除"
              control={
                <button
                  onClick={() => navigate('/memories')}
                  className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[12px] text-[var(--xl-ink)]"
                >
                  管理
                </button>
              }
            />
            <Row
              title="清除所有聊天紀錄"
              desc="保留角色與記憶"
              control={
                <button
                  onClick={() => setConfirmDelete('messages')}
                  className="rounded-full px-3 py-1 text-[12px] text-[var(--xl-blush-deep)]"
                >
                  清除
                </button>
              }
            />
            <Row
              title="清除全部資料"
              desc="角色、對話、記憶全部刪除"
              control={
                <button
                  onClick={() => setConfirmDelete('all')}
                  className="rounded-full px-3 py-1 text-[12px] text-[var(--xl-blush-deep)]"
                >
                  清除
                </button>
              }
            />
          </div>
        </section>

        {/* ============ 账号（V2 · T02）============ */}
        <section>
          <h3 className={sectionTitle}>帳號</h3>
          <div className={`${cardClass} divide-y divide-[var(--xl-mist)]`}>
            <Row
              title={authenticated ? (account?.email ?? '已登入') : '還沒登入'}
              desc={
                authenticated
                  ? '可改密碼、查看登入的裝置'
                  : '註冊後換手機也不會失去對話與記憶'
              }
              control={
                <button
                  onClick={() => navigate('/account')}
                  className="rounded-full bg-[var(--xl-mist)] px-3 py-1 text-[12px] text-[var(--xl-ink)]"
                >
                  {authenticated ? '管理' : '註冊 / 登入'}
                </button>
              }
            />
          </div>
        </section>

        {/* ============ 关于 ============ */}
        <section>
          <h3 className={sectionTitle}>關於</h3>
          <div className={`${cardClass} p-3.5`}>
            <p className="text-[13px] leading-relaxed text-[var(--xl-sub)]">
              這是一個 AI 角色，不是真人。他不會真的出現在現實世界，
              也不會取代你身邊的人。你可以隨時關掉主動聊天、通知或長期記憶，
              也可以刪除任何一則對話或記憶。
            </p>
            <p className="mt-2 text-[11px] text-[var(--xl-sub)]/70">
              {characters.length} 個角色 · 主動聊天排程
              {scheduler?.enabled ? '運作中' : '未啟動'}
            </p>
          </div>
        </section>

        <div className="h-2" />
      </div>

      <Modal
        open={confirmDelete !== 'none'}
        title={confirmDelete === 'all' ? '清除全部資料？' : '清除所有聊天紀錄？'}
        onClose={() => setConfirmDelete('none')}
        footer={
          <div className="flex gap-2">
            <Button block variant="secondary" onClick={() => setConfirmDelete('none')}>
              取消
            </Button>
            <Button block variant="danger" disabled={busy} onClick={() => void doDelete()}>
              {busy ? '處理中…' : '確認清除'}
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--xl-sub)]">
          {confirmDelete === 'all'
            ? '所有角色、對話與記憶都會刪除，無法復原。'
            : '所有對話紀錄會被刪除，角色設定與長期記憶會保留。'}
        </p>
      </Modal>
    </>
  );
}

// ============================================================
// 子组件
// ============================================================

function Row({
  title,
  desc,
  control,
}: {
  title: string;
  desc?: string;
  control: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-[var(--xl-ink)]">{title}</p>
        {desc ? (
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--xl-sub)]">{desc}</p>
        ) : null}
      </div>
      <div className="flex-none">{control}</div>
    </div>
  );
}

/** 决策明细面板：把服务端算出来的因子直接展示出来 */
function DecisionPanel({
  status,
  scheduler,
}: {
  status: ProactiveStatus | null;
  scheduler: { lastTickAt: string | null; enabled: boolean; tickMs: number } | null;
}): React.ReactElement {
  if (!status) {
    return (
      <div className="rounded-2xl bg-[var(--xl-card)] p-3.5 text-[12px] text-[var(--xl-sub)] shadow-[var(--xl-shadow)]">
        載入中…
      </div>
    );
  }

  const decisionText: Record<string, string> = {
    skip: '暫時不打擾',
    delay: '再等一下',
    send: '準備主動說話',
  };

  return (
    <div className="rounded-2xl bg-[var(--xl-card)] p-3.5 shadow-[var(--xl-shadow)]">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-medium text-[var(--xl-ink)]">
          {decisionText[status.decision] ?? status.decision}
        </span>
        <span className="rounded-full bg-[var(--xl-mist)] px-2 py-0.5 text-[11px] text-[var(--xl-sub)]">
          {status.decision === 'skip' ? '—' : status.score.toFixed(2)}
        </span>
      </div>

      <p className="mt-1 text-[12px] leading-relaxed text-[var(--xl-sub)]">
        {status.reasonText}
        <span className="ml-1 text-[10px] text-[var(--xl-sub)]/60">（{status.reasonCode}）</span>
      </p>

      {/* 七因子明细 */}
      {Object.keys(status.factors).length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {Object.entries(PROACTIVE_WEIGHTS).map(([key, weight]) => {
            const f = status.factors[key];
            if (!f) return null;
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-20 flex-none text-[11px] text-[var(--xl-sub)]">
                  {FACTOR_LABELS[key] ?? key}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--xl-mist)]">
                  <div
                    className="h-full rounded-full bg-[var(--xl-blush)]"
                    style={{ width: `${Math.round(f.raw * 100)}%` }}
                  />
                </div>
                <span className="w-16 flex-none text-right text-[10px] text-[var(--xl-sub)]/70">
                  {f.raw.toFixed(2)} × {weight}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between border-t border-[var(--xl-mist)] pt-2 text-[10px] text-[var(--xl-sub)]/70">
        <span>
          今日 {status.todaySent}/{status.dailyLimit}
        </span>
        <span>
          {scheduler?.enabled
            ? scheduler.lastTickAt
              ? `上次檢查 ${new Date(scheduler.lastTickAt).toLocaleTimeString('zh-TW', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : '等待首次檢查'
            : '排程未啟動'}
        </span>
      </div>
    </div>
  );
}

function NumberPicker({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1">
      <button
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="h-7 w-7 rounded-full bg-[var(--xl-mist)] text-[15px] text-[var(--xl-ink)] disabled:opacity-30"
      >
        −
      </button>
      <span className="w-6 text-center text-[14px] text-[var(--xl-ink)]">{value}</span>
      <button
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="h-7 w-7 rounded-full bg-[var(--xl-mist)] text-[15px] text-[var(--xl-ink)] disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

export default SettingsPage;
