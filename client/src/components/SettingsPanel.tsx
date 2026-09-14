import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { requestNotificationPermission } from '../lib/notifications';
import { evaluateShariah, factsForSymbol, DEFAULT_FACTS } from '../lib/shariah';
import type { CoinFlag } from '../lib/types';
import Toggle from './ui/Toggle';
import ShariahBadge from './ShariahBadge';

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
  const flags = useStore(s => s.flags);
  const symbols = useStore(s => s.symbols);

  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    'Notification' in window ? Notification.permission : 'unsupported'
  );
  const [coinQuery, setCoinQuery] = useState('');
  const [localFlags, setLocalFlags] = useState<Record<string, CoinFlag>>({});

  useEffect(() => { setLocalFlags(flags); }, [flags]);

  const manageList = useMemo(() => {
    const q = coinQuery.trim().toUpperCase();
    const fromSymbols = symbols.map(s => s.base);
    const bases = new Set<string>([...Object.keys(localFlags), ...fromSymbols]);
    const analyzed = new Set(analyses.map(a => a.symbol.replace(/USDT$|USDC$|FDUSD$|BTC$|ETH$/, '')));
    return [...bases]
      .filter(b => q === '' || b.includes(q))
      .sort((x, y) => {
        const ax = analyzed.has(x) ? 0 : 1;
        const ay = analyzed.has(y) ? 0 : 1;
        return ax - ay || x.localeCompare(y);
      })
      .slice(0, 300);
  }, [symbols, localFlags, coinQuery, analyses]);

  const toggle = async (base: string, patch: { halal?: boolean; barcode?: boolean }) => {
    const targets = [`${base}USDT`, `${base}USDC`, `${base}FDUSD`];
    for (const t of targets) {
      await api.setCoinFlag(t, patch).catch(() => { /* قد لا يكون الزوج موجوداً كعلم */ });
    }
    setLocalFlags(prev => ({ ...prev, [base]: { symbol: base, halal: patch.halal === undefined ? prev[base]?.halal ?? 1 : (patch.halal ? 1 : 0), barcode: patch.barcode === undefined ? prev[base]?.barcode ?? 0 : (patch.barcode ? 1 : 0), updated_at: Date.now() } }));
  };

  const perm = PERM_BADGE[notifPerm];

  /* ---- التصنيف الشرعي ---- */
  const shariah = useStore(s => s.shariah);
  const saveShariah = useStore(s => s.saveShariah);
  const pushToast = useStore(s => s.pushToast);

  const shariahSymbols = useMemo(() => {
    const analyzed = analyses.map(a => a.symbol);
    const catalog = Object.keys(DEFAULT_FACTS).map(b => `${b}USDT`);
    return [...new Set([...analyzed, ...catalog])].sort();
  }, [analyses]);

  const shariahStats = useMemo(() => {
    const counts = { halal: 0, haram: 0, uncertain: 0 };
    for (const sym of shariahSymbols) {
      const verdict = shariah[sym]?.verdict ?? evaluateShariah(factsForSymbol(sym), sym).verdict;
      counts[verdict] += 1;
    }
    return counts;
  }, [shariahSymbols, shariah]);

  const saveAllShariah = async () => {
    let n = 0;
    for (const sym of shariahSymbols) {
      const facts = factsForSymbol(sym);
      const res = evaluateShariah(facts, sym);
      await saveShariah(sym, {
        verdict: res.verdict,
        facts: facts as unknown as Record<string, unknown>,
        reasons: res.reasons,
        evidence: res.evidence,
        source: 'نظام التقييم الحتمي (قواعد مثبتة)',
        notes: null
      });
      n += 1;
    }
    pushToast(`حُفظت تقييمات ${n} عملة في قاعدة البيانات`);
  };

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

      <section>
        <h2 className="text-[15px] font-bold mb-1" style={{ color: 'var(--text-1)' }}>فلتر الشريعة والباركود</h2>
        <p className="text-xs mb-4 leading-relaxed max-w-3xl" style={{ color: 'var(--text-3)' }}>
          القائمة المرجعية للحلال مزروعة كمؤشر فقط وليست فتوى — عدّلها كما تشاء. وسم «باركود» يستبعد العملة من الإضافة
          (شموع 1m متفرقة/غير مستقرة).
        </p>
        <div className="flex items-center gap-3 mb-4">
          <input className="w-72" placeholder="ابحث عن أصل…" value={coinQuery} onChange={e => setCoinQuery(e.target.value)} />
          <span className="badge badge-neutral">{manageList.length} أصل معروض</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {manageList.map(base => {
            const f = localFlags[base];
            const halal = f?.halal !== 0;
            const barcode = f?.barcode === 1;
            return (
              <div
                key={base}
                className="flex items-center justify-between rounded-lg px-3.5 py-2"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', transition: 'border-color var(--transition)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-1)'; }}
              >
                <span className="font-semibold text-[13px]" style={{ color: 'var(--text-1)' }}>{base}</span>
                <div className="flex items-center gap-4 text-[11px]">
                  <label className="flex items-center gap-1.5 cursor-pointer" style={{ color: halal ? 'var(--up)' : 'var(--text-3)' }}>
                    <Toggle on={halal} label={`حلال: ${base}`} onChange={v => void toggle(base, { halal: v })} />
                    حلال
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer" style={{ color: barcode ? 'var(--warn)' : 'var(--text-3)' }}>
                    <Toggle on={barcode} label={`باركود: ${base}`} onChange={v => void toggle(base, { barcode: v })} />
                    باركود
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- قسم التصنيف الشرعي ---------- */}
      <section>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <h2 className="text-[15px] font-bold" style={{ color: 'var(--text-1)' }}>التصنيف الشرعي (حلال / حرام)</h2>
          <button className="btn btn-accent" onClick={() => void saveAllShariah()}>احفظ تقييمات كل العملات دفعة واحدة</button>
        </div>
        <p className="text-xs mb-4 leading-relaxed max-w-3xl" style={{ color: 'var(--text-3)' }}>
          يقيّم النظام كل مشروع <b>تلقائياً</b> بمحرك قواعد حتمي يفحص الحقائق الموثقة (المنفعة، الإقراض بفائدة، الميسر،
          الغرر، التغطية…)، ويخرج الحكم مع <b>السبب والدليل من الكتاب والسنة</b> بمرجعه ودرجة صحته. ما لم تُوثَّق حقائقه
          يُصنَّف «للتحقق» ويُوقف اختياره احتياطاً — لا تخمين. قائمة الإضافة تعرض <b>الحلال الموثق فقط</b>.
        </p>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="badge badge-up">حلال: {shariahStats.halal}</span>
          <span className="badge badge-down">حرام: {shariahStats.haram}</span>
          <span className="badge badge-warn">للتحقق: {shariahStats.uncertain}</span>
          <span className="badge badge-neutral">الأعمال المقيّمة: {shariahSymbols.length}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {shariahSymbols.map(sym => (
            <div
              key={sym}
              className="flex items-center justify-between gap-2 rounded-lg px-3.5 py-2"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', transition: 'border-color var(--transition)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-2)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-1)'; }}
            >
              <span className="font-semibold text-[13px] num" style={{ color: 'var(--text-1)' }}>{sym}</span>
              <ShariahBadge symbol={sym} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
