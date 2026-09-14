import { useStore } from '../store/useStore';
import type { Analysis } from './types';
import { isUptrend, isDowntrend } from './sorting';
import { notifyBrowser, playAlarm, requestNotificationPermission } from './notifications';
import { api } from './api';

interface ArmState {
  armedAt: number;
  lastTimeoutNotify: number | null;
}

/**
 * محرّك المراقبة:
 * - لمس منطقة SSL/BSL (عبور السعر للمنطقة) → إشعار + تعليم اللمس تلقائياً
 * - هابط: لمس BSL ثم SSL ثم تعدّي BSL صعوداً → إشعار CHoCH up + تعليم passed_bsl_after_ssl
 * - مهلة (افتراضي 30 د) دون وصول السعر للمنطقة → إشعار، ويعاد التسليح تلقائياً
 */
export function startEngine() {
  const armStates = new Map<number, ArmState>();

  const arm = (a: Analysis) => {
    armStates.set(a.id, { armedAt: Date.now(), lastTimeoutNotify: null });
  };

  let prevPrices: Record<string, number> = {};

  const check = async () => {
    const st = useStore.getState();
    const settings = st.settings;
    if (!settings) return;
    const timeoutMs = Math.max(1, settings.notify_timeout_min) * 60_000;
    const now = Date.now();

    for (const a of st.analyses) {
      if (!a.notify_enabled) { armStates.delete(a.id); continue; }
      const price = st.prices[a.symbol];
      if (price === undefined) continue;
      const prev = prevPrices[a.symbol];
      prevPrices = { ...prevPrices, [a.symbol]: price };

      const up = isUptrend(a);
      const down = isDowntrend(a) && !up;

      // تحديد المنطقة الهدف حسب الاتجاه واللمسات
      let targetZone: 'ssl' | 'bsl' | null = null;
      if (up) targetZone = a.ssl_price != null ? 'ssl' : null;
      if (down) {
        if (!a.bsl_touched && a.bsl_price != null) targetZone = 'bsl';
        else if (a.bsl_touched && a.ssl_price != null) targetZone = 'ssl';
      }

      // 1) كشف عبور المنطقة
      if (prev !== undefined && targetZone) {
        const zone = targetZone === 'ssl' ? a.ssl_price : a.bsl_price;
        if (zone != null) {
          const crossed = (prev < zone && price >= zone) || (prev > zone && price <= zone) ||
                          Math.abs(price - zone) / zone < 0.0002;
          if (crossed) {
            if (targetZone === 'bsl' && !a.bsl_touched) {
              await st.updateAnalysis(a.id, { bsl_touched: 1 });
              fire(st, a, 'zone_touch', `لمس ${a.symbol} منطقة BSL عند ${zone}`);
              armStates.delete(a.id);
              continue;
            }
            if (targetZone === 'ssl' && !a.ssl_touched) {
              await st.updateAnalysis(a.id, { ssl_touched: 1 });
              fire(st, a, 'zone_touch', `لمس ${a.symbol} منطقة SSL عند ${zone}`);
              armStates.delete(a.id);
              continue;
            }
          }
        }
      }

      // 2) هابط: لمس BSL و SSL ثم تعدّى BSL صعوداً → CHoCH up
      if (down && a.bsl_touched && a.ssl_touched && a.bsl_price != null && !a.passed_bsl_after_ssl) {
        if (price > a.bsl_price) {
          await st.updateAnalysis(a.id, { passed_bsl_after_ssl: 1 });
          fire(st, a, 'choch_check', `تعدّى ${a.symbol} منطقة BSL بعد SSL — هل حدث CHoCH up؟`);
          continue;
        }
      }

      // 3) مهلة عدم الوصول
      if (targetZone) {
        let armState = armStates.get(a.id);
        if (!armState) { arm(a); armState = armStates.get(a.id)!; }
        if (armState.lastTimeoutNotify === null && now - armState.armedAt >= timeoutMs) {
          const zone = targetZone === 'ssl' ? a.ssl_price : a.bsl_price;
          armState.lastTimeoutNotify = now;
          fire(st, a, 'timeout', `${a.symbol}: مرّت ${settings.notify_timeout_min} دقيقة دون وصول السعر لمنطقة ${targetZone.toUpperCase()} (${zone})`);
        }
      } else {
        armStates.delete(a.id);
      }
    }
  };

  const fire = (st: ReturnType<typeof useStore.getState>, a: Analysis, type: string, message: string) => {
    const sound = st.settings?.sound_enabled ?? 1;
    notifyBrowser(`تنبيه ${a.symbol}`, message);
    if (sound) playAlarm();
    st.pushToast(message, 'alert');
    void api.postEvent(a.symbol, type, message).catch(() => { /* ignore */ });
  };

  // إعادة تسليح عند تعديل الأسعار أو اللمسات
  useStore.subscribe((st, prev) => {
    for (const a of st.analyses) {
      const p = prev.analyses.find(x => x.id === a.id);
      if (!p) { arm(a); continue; }
      if (p.ssl_price !== a.ssl_price || p.bsl_price !== a.bsl_price ||
          p.bsl_touched !== a.bsl_touched || p.ssl_touched !== a.ssl_touched ||
          p.notify_enabled !== a.notify_enabled) {
        arm(a);
      }
    }
  });

  // طلب إذن الإشعارات عند بدء التشغيل
  void requestNotificationPermission();

  setInterval(() => { void check().catch(() => { /* ignore */ }); }, 3000);
}
