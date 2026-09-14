import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { detectBarcode } from '../lib/binance';
import { evaluateShariah, factsForSymbol } from '../lib/shariah';

/** شريط إضافة عملة: بحث في قائمة السبوت الحلال فقط (تحديث آلي بالبث) */
export default function AddCoinBar() {
  const symbols = useStore(s => s.symbols);
  const symbolsLoaded = useStore(s => s.symbolsLoaded);
  const flags = useStore(s => s.flags);
  const shariah = useStore(s => s.shariah);
  const analyses = useStore(s => s.analyses);
  const addAnalysis = useStore(s => s.addAnalysis);
  const setFlag = useStore(s => s.setFlag);
  const pushToast = useStore(s => s.pushToast);
  const syncSymbols = useStore(s => s.syncSymbols);
  const syncing = useStore(s => s.syncing);
  const lastSync = useStore(s => s.lastSync);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const existing = useMemo(() => new Set(analyses.map(a => a.symbol)), [analyses]);

  /** حكم الشريعة لأي رمز: من المخزن أو محسوب فوراً من قاعدة المعرفة */
  const verdictOf = (base: string): 'halal' | 'haram' | 'uncertain' => {
    const row = shariah[`${base}USDT`] ?? shariah[base];
    if (row?.verdict) return row.verdict;
    return evaluateShariah(factsForSymbol(`${base}USDT`), `${base}USDT`).verdict;
  };

  /** فلتر قطعي: سبوت + حلال فقط (غير الحلال و«للتحقق» لا يظهران أبداً) */
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return symbols.filter(s =>
      !existing.has(s.symbol) &&
      flags[s.base]?.halal !== 0 &&
      flags[s.symbol]?.barcode !== 1 &&
      flags[s.base]?.barcode !== 1 &&
      (q === '' || s.symbol.includes(q) || s.base.includes(q)) &&
      verdictOf(s.base) === 'halal'
    ).slice(0, 200);
  }, [symbols, flags, existing, query, shariah]);

  const halalCount = useMemo(
    () => new Set(symbols.filter(s => !flags[s.base]?.barcode && verdictOf(s.base) === 'halal').map(s => s.base)).size,
    [symbols, flags, shariah]
  );

  /** فحص الباركود للعملات المحللة (فوري وحتمي) */
  const scanBarcode = async () => {
    setScanning(true);
    try {
      for (const a of analyses) {
        const { barcode } = await detectBarcode(a.symbol);
        if (barcode) {
          await setFlag(a.symbol, { barcode: true });
          pushToast(`${a.symbol}: وُسمت «باركود» تلقائياً (يمكن المراجعة من الإعدادات)`);
        }
      }
      pushToast('انتهى فحص الباركود للعملات المحللة');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 relative flex-wrap"
      style={{ borderBottom: '1px solid var(--border-1)', background: 'var(--surface-1)' }}
      ref={boxRef}
    >
      {/* حقل البحث */}
      <div className="relative w-[26rem] max-w-full">
        <span
          className="absolute top-1/2 -translate-y-1/2 text-[13px] pointer-events-none"
          style={{ insetInlineStart: '10px', color: 'var(--text-3)' }}
        >
          ⌕
        </span>
        <input
          className="w-full"
          style={{ paddingInlineStart: '30px' }}
          placeholder={symbolsLoaded ? 'ابحث عن عملة… (القائمة: سبوت حلال فقط)' : 'جارٍ تحميل القائمة…'}
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
                <span className="block mt-0.5" style={{ color: 'var(--text-4)' }}>القائمة تشمل السبوت الحلال غير الموسوم باركود فقط</span>
              </div>
            )}
            {filtered.map(s => (
              <button
                key={s.symbol}
                className="w-full text-right px-3.5 py-2 flex justify-between items-center gap-3"
                style={{ transition: 'background var(--transition)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-4)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                onClick={() => {
                  void addAnalysis(s.symbol).then(() => {
                    pushToast(`أُضيفت ${s.symbol}`);
                  }).catch(e => pushToast(String(e), 'alert'));
                  setOpen(false); setQuery('');
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-[13px]" style={{ color: 'var(--text-1)' }}>{s.base}</span>
                  <span className="badge badge-up">حلال</span>
                </span>
                <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>{s.symbol}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* الأزرار */}
      <button className="btn" onClick={scanBarcode} disabled={scanning || analyses.length === 0}>
        {scanning && <span className="anim-spin">◌</span>}
        {scanning ? '…يفحص' : 'فحص الباركود'}
      </button>
      <button className="btn" onClick={() => void syncSymbols()} disabled={syncing} title="تحديث يدوي احتياطي — القائمة تتحديث آلياً بالبث">
        {syncing && <span className="anim-spin">◌</span>}
        {syncing ? '…يحدّث' : 'تحديث يدوي'}
      </button>

      {/* شارات معلوماتية */}
      <div className="flex items-center gap-2 flex-wrap mr-auto">
        <span className="badge badge-up">{halalCount} أصل حلال متاح</span>
        <span className="badge badge-accent">تحديث آلي بالبث</span>
        {lastSync > 0 && (
          <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>
            آخر مزامنة: {new Date(lastSync).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        )}
      </div>
      {open && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}
    </div>
  );
}
