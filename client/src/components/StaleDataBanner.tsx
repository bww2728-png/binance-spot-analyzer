import { useServerHealth } from '../lib/serverHealth';

/**
 * حزمة «بيانات قديمة» الموحّدة — مصدرها الوحيد حالة الخادم المشتركة.
 *
 * السبب: كان الوسم مكرراً في شاشة الفرص الحية وحدها، فبقيت بقية شاشات البيانات
 * تعرض أرقاماً متقادمة بلا تنبيه. هنا يُشتق الشرط من الخادم نفسه (عمر آخر سعر
 * وحالة المحركات) ويُدرج في كل شاشة بيانات.
 */
export default function StaleDataBanner({ className = '' }: { className?: string }) {
  const { status, health } = useServerHealth();
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
