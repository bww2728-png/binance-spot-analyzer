import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { requestNotificationPermission } from '../lib/notifications';
import { factsForSymbol } from '../lib/shariah';
import Toggle from './ui/Toggle';

const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH'];

const PERM_BADGE: Record<string, { cls: string; text: string }> = {
  granted: { cls: 'badge-up', text: 'ممنوح ✓' },
  denied: { cls: 'badge-down', text: 'مرفوض — فعّله من إعدادات المتصفح' },
  default: { cls: 'badge-warn', text: 'غير مطلوب بعد' },
  unsupported: { cls: 'badge-neutral', text: 'غير مدعوم في هذا المتصفح' }
};

export default function SettingsPanel() {
  const settings = useStore(s => s.settings);
  const saveSettings = useStore(s => s.saveSettings);
  const analyses = useStore(s => s.analyses);
  const barcodeScans = useStore(s => s.barcodeScans);
  const lastSync = useStore(s => s.lastSync);

  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    'Notification' in window ? Notification.permission : 'unsupported'
  );

  const perm = PERM_BADGE[notifPerm];

  /* ---- التصنيف الشرعي ---- */
  const shariah = useStore(s => s.shariah);
  const symbols = useStore(s => s.symbols);
  const shariahStats = useMemo(() => {
    const counts = { halal: 0, haram: 0, uncertain: 0 };
    for (const a of analyses) counts[shariah[a.symbol]?.verdict ?? 'uncertain'] += 1;
    return counts;
  }, [analyses, shariah]);

  const pendingDoc = useMemo(() => {
    let n = 0;
    for (const s of symbols) {
      const row = shariah[s.symbol];
      if (row) continue;
      if (Object.values(factsForSymbol(s.symbol)).every(v => v === null)) n += 1;
    }
    return n;
  }, [symbols, shariah]);

  const barcodeStats = useMemo(() => {
    const values = Object.values(barcodeScans);
    return {
      barcode: values.filter(v => v.status === 'success' && v.is_barcode).length,
      normal: values.filter(v => v.status === 'success' && !v.is_barcode).length,
      unknown: values.filter(v => v.status !== 'success').length
    };
  }, [barcodeScans]);

  return (
    <div className="p-6 space-y-8 max-w-5xl">
      <section>
        <h2 className="text-[15px] font-bold mb-1" style={{ color: 'var(--text-1)' }}>الإعدادات العامة</h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-3)' }}>الاقتباس، مهلة الإشعارات، والصوت — تُحفظ فوراً في قاعدة البيانات</p>
        {settings && (
          <div className="card p-5 flex flex-wrap items-center gap-x-8 gap-y-4">
            <label className="flex items-center gap-2.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              زوج الاقتباس:
              <select value={settings.quote} onChange={e => void saveSettings({ quote: e.target.value })} className="w-24">
                {QUOTES.map(q => <option key={q}>{q}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              مهلة الإشعار (دقائق):
              <input type="number" min={1} className="num w-20" value={settings.notify_timeout_min}
                onChange={e => void saveSettings({ notify_timeout_min: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
            <div className="flex items-center gap-2.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              الصوت:
              <Toggle on={settings.sound_enabled === 1} label="تفعيل الصوت" onChange={v => void saveSettings({ sound_enabled: v ? 1 : 0 })} />
            </div>
            <div className="flex items-center gap-2.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              إذن إشعارات المتصفح:
              {notifPerm === 'default' ? (
                <button className="btn btn-accent !py-1.5" onClick={() => void requestNotificationPermission().then(setNotifPerm)}>طلب الإذن</button>
              ) : (
                <span className={`badge ${perm.cls}`}>{perm.text}</span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ---------- قسم التصنيف الشرعي (عرض فقط) ---------- */}
      <section>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <h2 className="text-[15px] font-bold" style={{ color: 'var(--text-1)' }}>التصنيف الشرعي (حلال / حرام)</h2>
          <span className="badge badge-neutral">تصنيف آلي — قراءة فقط</span>
        </div>
        <p className="text-xs mb-4 leading-relaxed max-w-3xl" style={{ color: 'var(--text-3)' }}>
          يقيّم النظام كل مشروع <b>تلقائياً</b> بمحرك قواعد حتمي يفحص الحقائق الموثقة (المنفعة، الإقراض بفائدة، الميسر،
          الغرر، التغطية…)، ويخرج الحكم مع <b>السبب والدليل من الكتاب والسنة</b> بمرجعه ودرجة صحته. ما لم تُوثَّق حقائقه
          يُصنَّف «للتحقق» ويُمنع من الإدراج حتى اكتمال التوثيق — لا تخمين. التوثيق يتم من زر <b>«وثّق الآن»</b> داخل
          <b> تقرير فحص الإضافة</b>، وإدراج أي عملة يتم عبر التقرير وتأكيدك.
        </p>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="badge badge-up">حلال: {shariahStats.halal}</span>
          <span className="badge badge-down">حرام: {shariahStats.haram}</span>
          <span className="badge badge-warn">للتحقق: {shariahStats.uncertain}</span>
          <span className="badge badge-warn" title="أزواج سبوت بلا حقائق موثقة بعد — افتح تقرير الإضافة ووثّقها من هناك">بانتظار التوثيق: {pendingDoc}</span>
          <span className="badge badge-neutral">العملات في اللوحة: {analyses.length}</span>
        </div>
        <div className="card p-4 text-[12px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
          لا توجد مفاتيح يدوية للعملات. الحكم الناتج من قاعدة المعرفة المحلية هو المرجع الوحيد، ولا تُقبل الإضافة إلا للعملة الحلال الموثقة.
          أي عملة غير موثقة تُفتح عبر نموذج التوثيق في تقرير الإضافة: تجيب عن حقائق المشروع مع ذكر المصدر، فيقيّمها المحرك فوراً.
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <h2 className="text-[15px] font-bold" style={{ color: 'var(--text-1)' }}>فحوصات الباركود — فريم الدقيقة</h2>
          <span className="badge badge-neutral">فحص آلي — قراءة فقط</span>
        </div>
        <p className="text-xs mb-4 leading-relaxed max-w-3xl" style={{ color: 'var(--text-3)' }}>
          يفحص النظام آخر 100 شمعة على فريم 1m وفق معيار الفجوات والظلال وعتبة 35%. النتيجة تحذير بصري فقط، ولا يوجد فلتر يدوي أو زر لتعديلها.
        </p>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="badge badge-warn">باركود: {barcodeStats.barcode}</span>
          <span className="badge badge-up">ليست باركود: {barcodeStats.normal}</span>
          <span className="badge badge-neutral">غير معروف: {barcodeStats.unknown}</span>
          <span className="badge badge-neutral">آخر مزامنة للأزواج: {lastSync ? new Date(lastSync).toLocaleString('ar') : 'غير متوفر'}</span>
        </div>
      </section>
    </div>
  );
}
