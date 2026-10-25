import { useEffect } from 'react';
import { useServerHealth, type ServerStatus } from '../lib/serverHealth';
import { useStore } from '../store/useStore';

let lastNotifiedStatus: ServerStatus = 'loading';

/**
 * حزمة «بيانات قديمة» الموحّدة — مصدرها الوحيد حالة الخادم المشتركة.
 *
 * السبب: كان الوسم مكرراً في شاشة الفرص الحية وحدها، فبقيت بقية شاشات البيانات
 * تعرض أرقاماً متقادمة بلا تنبيه. هنا يُشتق الشرط من الخادم نفسه (عمر آخر سعر
 * وحالة المحركات) ويُدرج في كل شاشة بيانات.
 */
export default function StaleDataBanner({ className = '' }: { className?: string }) {
  const { status, health } = useServerHealth();
  const pushToast = useStore(s => s.pushToast);
  useEffect(() => {
    const previous = lastNotifiedStatus;
    if (status !== previous && (status === 'down' || status === 'stale' || status === 'stalled')) {
      const text = status === 'down'
        ? 'تعذر الاتصال بالخادم أو ببث السوق؛ راجع حالة البيانات قبل الاعتماد عليها.'
        : status === 'stale'
          ? `بيانات السوق متقادمة${health?.dataFresh?.reason ? `: ${health.dataFresh.reason}` : ''}`
          : 'أحد المحركات متوقف؛ لن تُعامل بياناته على أنها حديثة.';
      pushToast(text, 'alert', undefined, { category: 'liveOpps', severity: 'error' });
    } else if (status === 'live' && (previous === 'down' || previous === 'stale' || previous === 'stalled')) {
      pushToast('عادت صحة الخادم والبيانات إلى الحالة السليمة.', 'info', undefined, { category: 'liveOpps', severity: 'info' });
    }
    lastNotifiedStatus = status;
  }, [health?.dataFresh?.reason, pushToast, status]);
  const stale = status === 'stale' || status === 'stalled' || health?.dataFresh?.ok === false;
  if (!stale) return null;
  return (
    <div
      className={`rounded-xl px-4 py-3 text-[12px] flex items-start gap-2 ${className}`}
      style={{ background: 'var(--warn-soft)', border: '1px solid rgba(245,158,11,0.35)', color: '#b45309' }}
      dir="rtl"
    >
      <span className="font-bold">بيانات قديمة</span>
      <span style={{ color: 'var(--text-2)' }}>
        {health?.dataFresh?.reason || 'بيانات السوق متقادمة — النتائج أدناه قد لا تعكس السوق الآن.'}
      </span>
    </div>
  );
}
