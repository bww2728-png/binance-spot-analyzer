import { useCallback, useEffect, useRef, useState } from 'react';
import { useScreenVisible } from './screenVisibility';

/**
 * استقصاء موحّد واعٍ بالإخفاء.
 *
 * السبب: كانت كل شاشة تُنشئ `setInterval` خاصاً بها، فيستمر الطلب حتى والشاشة
 * مخفية أو التبويب في الخلفية، وتتراكم الطلبات فوق بعضها عند بطء الخادم.
 * هذا الخطاف يوقف الدورة عند `document.visibilityState === 'hidden'` وعند إخفاء
 * الشاشة (عبر `enabled`)، ويمنع إطلاق طلب جديد قبل انتهاء السابق (منع التراكب).
 *
 * وإخفاء الشاشة يُقرأ من `ScreenVisibilityContext` الذي يوفّره حاضن الشاشات، فلا
 * تحتاج أي شاشة أن تمرّر شيئاً: الخطّاف يعرف بنفسه أن شاشته مخفية فيهبط الطلب.
 */
export interface VisiblePollOptions {
  /** الفترة بالمللي ثانية — 0 أو أقل يعطّل الدورة الدورية (يبقى refresh اليدوي) */
  intervalMs: number;
  /** إيقاف الدورة عند إخفاء الشاشة (يُمرَّر من حاضن الشاشات) */
  enabled?: boolean;
  /** تشغيل جلب أولي فور التفعيل */
  immediate?: boolean;
}

export interface VisiblePollResult {
  /** جلب يدوي فوري — يتجاهل منع التراكب لكنه لا يطلق طلباً إن كان هناك طلب جارٍ */
  refresh: () => void;
  /** هل هناك طلب جارٍ الآن؟ */
  busy: boolean;
}

/** هل التبويب مرئي الآن؟ (يُقرأ عند كل دورة لا مرة واحدة) */
function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function useVisiblePoll(
  task: (signal: AbortSignal) => void | Promise<void>,
  { intervalMs, enabled = true, immediate = true }: VisiblePollOptions
): VisiblePollResult {
  // رؤية الشاشة داخل الحاضن: شاشة مخفية = لا استقصاء (وإن بقيت محمّلة في الذاكرة)
  const screenVisible = useScreenVisible();
  const active = enabled && screenVisible;

  const taskRef = useRef(task);
  taskRef.current = task;

  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    // منع التراكب: لا طلب جديد قبل انتهاء السابق
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await taskRef.current(ac.signal);
    } catch { /* الأخطاء تُدار داخل المهمة نفسها */ }
    finally {
      runningRef.current = false;
      if (abortRef.current === ac) abortRef.current = null;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer != null) return;
      if (immediate) void run();
      if (intervalMs > 0) timer = setInterval(() => { if (tabVisible()) void run(); }, intervalMs);
    };
    const stop = () => {
      if (timer != null) { clearInterval(timer); timer = null; }
    };

    // إخفاء التبويب يوقف الدورة تماماً — لا طلبات في الخلفية
    const onVisibility = () => {
      if (tabVisible()) start();
      else stop();
    };

    if (tabVisible()) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      abortRef.current?.abort();
      abortRef.current = null;
      runningRef.current = false;
    };
  }, [active, intervalMs, immediate, run]);

  return { refresh: () => void run(), busy };
}
