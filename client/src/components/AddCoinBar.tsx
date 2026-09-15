import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { evaluateShariah, factsForSymbol } from '../lib/shariah';
import AddReviewModal from './AddReviewModal';

const VERDICT_STYLE: Record<string, { cls: string; label: string }> = {
  halal: { cls: 'badge-up', label: 'حلال' },
  haram: { cls: 'badge-down', label: 'حرام' },
  uncertain: { cls: 'badge-warn', label: 'للتحقق' }
};

/** شريط إضافة عملة: بحث شامل في كل أزواج السبوت — كل نتيجة تفتح تقرير الفحص قبل الإدراج */
export default function AddCoinBar() {
  const symbols = useStore(s => s.symbols);
  const symbolsLoaded = useStore(s => s.symbolsLoaded);
  const shariah = useStore(s => s.shariah);
  const syncSymbols = useStore(s => s.syncSymbols);
  const syncing = useStore(s => s.syncing);
  const lastSync = useStore(s => s.lastSync);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [reviewSymbol, setReviewSymbol] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const verdictOf = (symbol: string): { verdict: 'halal' | 'haram' | 'uncertain'; undocumented: boolean } => {
    const row = shariah[symbol];
    if (row?.verdict) return { verdict: row.verdict, undocumented: false };
    const facts = factsForSymbol(symbol);
    const undocumented = Object.values(facts).every(v => v === null);
    return { verdict: undocumented ? 'uncertain' : evaluateShariah(facts, symbol).verdict, undocumented };
  };

  /** بحث شامل: كل أزواج السبوت — القرار بعد تقرير الفحص لا هنا */
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return symbols
      .filter(s => q === '' || s.symbol.includes(q) || s.base.includes(q))
      .slice(0, 200);
  }, [symbols, query]);

  const halalCount = useMemo(
    () => new Set(
      symbols
        .filter(s => !verdictOf(s.symbol).undocumented && verdictOf(s.symbol).verdict === 'halal')
        .map(s => s.base)
    ).size,
    [symbols, shariah]
  );

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 relative flex-wrap"
      style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-1)' }}
      ref={boxRef}
    >
      {/* حقل البحث */}
      <div className="relative w-full sm:w-[26rem]">
        <span
          className="absolute top-1/2 -translate-y-1/2 text-[13px] pointer-events-none"
          style={{ insetInlineStart: '10px', color: 'var(--text-3)' }}
        >
          ⌕
        </span>
        <input
          className="w-full"
          style={{ paddingInlineStart: '30px' }}
          placeholder={symbolsLoaded ? 'ابحث عن عملة… (كل أزواج السبوت — النتيجة تفتح تقرير الفحص)' : 'جارٍ تحميل القائمة…'}
          value={query}
          disabled={!symbolsLoaded}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
        />
        {open && symbolsLoaded && (
          <div
            className="absolute top-full mt-1.5 w-full max-h-80 overflow-auto z-30 rounded-xl"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border-2)',
              boxShadow: 'var(--shadow-lg)',
              animation: 'modal-in 0.18s ease both'
            }}
          >
            {filtered.length === 0 && (
              <div className="p-4 text-xs text-center leading-relaxed" style={{ color: 'var(--text-3)' }}>
                لا توجد نتائج
                <span className="block mt-0.5" style={{ color: 'var(--text-4)' }}>تأكد من الاسم أو حدّث القائمة من بينانس</span>
              </div>
            )}
            {filtered.map(s => {
              const { verdict, undocumented } = verdictOf(s.symbol);
              const vs = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.uncertain;
              return (
                <button
                  key={s.symbol}
                  className="w-full text-right px-3.5 py-2 flex justify-between items-center gap-3"
                  style={{ transition: 'background var(--transition)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-4)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  onClick={() => { setReviewSymbol(s.symbol); setOpen(false); setQuery(''); }}
                >
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[13px]" style={{ color: 'var(--text-1)' }}>{s.base}</span>
                    <span className={`badge ${vs.cls}`}>{vs.label}</span>
                    {undocumented && <span className="badge badge-warn">غير موثق — ممنوع</span>}
                  </span>
                  <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>{s.symbol}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* زر التحديث الاحتياطي */}
      <button className="btn" onClick={() => void syncSymbols()} disabled={syncing} title="تحديث يدوي احتياطي — القائمة تتحديث آلياً بالبث">
        {syncing && <span className="anim-spin">◌</span>}
        {syncing ? '…يحدّث' : 'تحديث يدوي'}
      </button>

      {/* شارات معلوماتية */}
      <div className="flex items-center gap-2 flex-wrap mr-auto">
        <span className="badge badge-up">{halalCount} أصل حلال موثق</span>
        <span className="badge badge-accent">تحديث آلي بالبث</span>
        {lastSync > 0 && (
          <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>
            آخر مزامنة: {new Date(lastSync).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        )}
      </div>
      {open && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}

      {/* نافذة تقرير الفحص قبل الإدراج */}
      {reviewSymbol && (
        <AddReviewModal symbol={reviewSymbol} onClose={() => setReviewSymbol(null)} />
      )}
    </div>
  );
}
