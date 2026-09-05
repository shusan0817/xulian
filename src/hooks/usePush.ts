/**
 * Web Push 订阅与在线心跳（需求 §11–§13）
 *
 * 三条平台限制必须如实告知用户，不能用"假装成功"糊过去：
 * 1. iOS 16.4+ 必须先把 PWA「加到主屏幕」才能订阅推送；
 * 2. 浏览器要求用户手势触发才会弹权限框；
 * 3. HTTP 站点（localhost 除外）拿不到 Service Worker，必须 HTTPS。
 *
 * 心跳的作用：App 在前台时每 60 秒上报一次，
 * 主动聊天决策的 V7 否决项据此判断"用户在线就别推送"。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiDelete, humanizeError } from '@/api/client';

const HEARTBEAT_INTERVAL_MS = 60_000;

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: string };

export interface UsePushResult {
  supported: PushSupport;
  /** 后端是否配置了 VAPID */
  configured: boolean;
  subscribed: boolean;
  permission: NotificationPermission | 'unsupported';
  busy: boolean;
  error: string | null;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
  sendTest: () => Promise<void>;
}

function detectSupport(): PushSupport {
  if (typeof window === 'undefined') return { ok: false, reason: '不支援的環境' };
  if (!('serviceWorker' in navigator)) return { ok: false, reason: '瀏覽器不支援 Service Worker' };
  if (!('PushManager' in window)) return { ok: false, reason: '瀏覽器不支援 Web Push' };
  if (!('Notification' in window)) return { ok: false, reason: '瀏覽器不支援通知' };
  // iOS 限制：非 standalone（未加到主屏幕）时不允许订阅
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos && !(navigator as { standalone?: boolean }).standalone) {
    return { ok: false, reason: 'iOS 請先「加入主螢幕」後才能開啟推播' };
  }
  return { ok: true };
}

/** 把 VAPID 公钥（base64url）转成 Uint8Array */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function usePush(): UsePushResult {
  const [supported] = useState<PushSupport>(() => detectSupport());
  const [configured, setConfigured] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heartbeatRef = useRef<number | null>(null);

  // ---- 读取当前订阅状态 ----
  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<{ configured: boolean; subscribed: boolean; count: number }>(
        '/api/push/status',
      );
      setConfigured(res.configured);
      setSubscribed(res.subscribed);
    } catch {
      // 状态读取失败不阻塞界面
    }
  }, []);

  // ---- 心跳：App 在前台时定期上报 ----
  useEffect(() => {
    void refreshStatus();

    const beat = (): void => {
      void apiPost('/api/push/heartbeat', {}).catch(() => undefined);
    };
    beat();
    heartbeatRef.current = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);

    // 页面隐藏时也上报一次（用户切走了，AI 可以更主动一些）
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') beat();
    };
    document.addEventListener('visibilitychange', onHidden);

    return () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [refreshStatus]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!supported.ok) {
      setError(supported.reason);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      // 1. 拿 VAPID 公钥
      const { publicKey, enabled } = await apiGet<{ publicKey: string; enabled: boolean }>(
        '/api/push/vapid-public-key',
      );
      if (!enabled || !publicKey) {
        setError('伺服器尚未設定 VAPID 金鑰，推播功能未啟用');
        return false;
      }

      // 2. 请求通知权限（必须在用户手势中调用）
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError('你還沒開啟通知權限');
        return false;
      }

      // 3. 注册 Service Worker 并订阅
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          // 断言成 BufferSource：TS 5.7 的 Uint8Array<ArrayBufferLike> 与
          // PushSubscription 期望的 BufferSource 不直接兼容，运行时行为一致
          applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
        }));

      const json = subscription.toJSON();
      await apiPost('/api/push/subscribe', {
        endpoint: subscription.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent,
      });

      setSubscribed(true);
      return true;
    } catch (err) {
      setError(humanizeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await apiDelete(
          `/api/push/unsubscribe?endpoint=${encodeURIComponent(subscription.endpoint)}`,
        );
        await subscription.unsubscribe();
      } else {
        await apiDelete('/api/push/unsubscribe');
      }
      setSubscribed(false);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await apiPost('/api/push/test', {});
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    supported,
    configured,
    subscribed,
    permission,
    busy,
    error,
    subscribe,
    unsubscribe,
    sendTest,
  };
}
