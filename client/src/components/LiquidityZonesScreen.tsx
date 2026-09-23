import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ZoneCard, ZoneDetail, kindLabel } from './ZoneCards';
import { TIMEFRAMES, type LiquidityDetection, type LiquidityZoneEngineStatus } from '../lib/types';

export default function LiquidityZonesScreen() {
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [status, setStatus] = useState<LiquidityZoneEngineStatus | null>(null);
  const [rows, setRows] = useState<LiquidityDetection[]>([]);
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [kind, setKind] = useState('');
  const [sortMode, setSortMode] = useState<'confidence' | 'work'>('confidence');
  const [selected, setSelected] = useState<LiquidityDetection | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [s, r] = await Promise.all([
        api.getLiquidityZoneStatus(signal),
        api.getLiquidityZones({ mode, symbol: symbol.trim().toUpperCase() || undefined, timeframe: timeframe || undefined, kind: kind || undefined, limit: 500 }, signal)
      ]);
      if (!signal?.aborted) { setStatus(s); setRows(r.results); setError(''); }
    } catch (e) {
      if (!signal?.aborted) setError(String(e));
    }
  }, [mode, symbol, timeframe, kind]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    const timer = setInterval(() => void load(), 10000);
    return () => { ac.abort(); clearInterval(timer); };
  }, [load]);

  const reviewed = (zone: LiquidityDetection) => {
    setRows(prev => prev.map(x => x.id === zone.id ? zone : x));
    setSelected(zone);
    void load();
  };
  const visible = useMemo(() => [...rows].sort((a, b) => sortMode === 'work'
    ? (a.workOrder ?? Number.MAX_SAFE_INTEGER) - (b.workOrder ?? Number.MAX_SAFE_INTEGER)
    : b.confidence - a.confidence), [rows, sortMode]);
  const progress = mode === 'live' ? status?.live : status?.history;

  return (
    <section className="max-w-[1600px] mx-auto px-3 sm:px-5 py-4 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>محرك مناطق السيولة</h2><p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>BSL / SSL أفقي وTrendline — كل عملة وفريم مستقل — العرض والتحليل فقط</p></div>
        <button onClick={() => void api.runLiquidityZones().then(() => void load())} className="px-4 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--accent)', color: '#fff' }}>تشغيل لفة الآن</button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>محرك الحي</div><div className="num font-bold">{status?.live.rotation ?? 0} · {status?.live.pairsDone ?? 0}/{status?.live.pairsTotal ?? 0}</div></div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>التاريخي</div><div className="num font-bold">{status?.history.rotation ?? 0} · {status?.history.pairsDone ?? 0}/{status?.history.pairsTotal ?? 0}</div></div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>السجلات المعروضة</div><div className="num font-bold">{visible.length}</div></div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>أمثلة التعلم</div><div className="num font-bold">{status?.adjustment.examples ?? 0}</div></div>
        <div className="rounded-xl p-3" style={{ background: 'var(--surface-1)' }}><div className="text-[10px]" style={{ color: 'var(--text-3)' }}>الحالة</div><div className="text-[12px] font-bold" style={{ color: progress?.busy ? 'var(--accent)' : 'var(--up)' }}>{progress?.busy ? 'قيد العمل تدريجياً' : 'جاهز'}</div></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setMode('live')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: mode === 'live' ? 'var(--accent-soft)' : 'var(--surface-1)', color: mode === 'live' ? 'var(--accent)' : 'var(--text-2)' }}>التحديدات الحية</button>
        <button onClick={() => setMode('history')} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: mode === 'history' ? 'var(--accent-soft)' : 'var(--surface-1)', color: mode === 'history' ? 'var(--accent)' : 'var(--text-2)' }}>كل تحديدات الباك تيست</button>
        <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="العملة مثل BTCUSDT" className="px-3 py-2 rounded-lg text-[12px] w-40" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
        <select value={timeframe} onChange={e => setTimeframe(e.target.value)} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}><option value="">كل الفريمات</option>{TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}</select>
        <select value={kind} onChange={e => setKind(e.target.value)} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}><option value="">كل الأنواع</option>{Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button onClick={() => setSortMode(sortMode === 'confidence' ? 'work' : 'confidence')} className="px-3 py-2 rounded-lg text-[11px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>{sortMode === 'confidence' ? 'ترتيب العمل' : 'ترتيب الثقة'}</button>
        <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>الافتراضي: أعلى ثقة أولاً</span>
      </div>
      {error && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {visible.map(zone => <ZoneCard key={zone.id} zone={zone} onOpen={setSelected} />)}
      </div>
      {!visible.length && <div className="rounded-xl py-16 text-center text-sm" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>{progress?.busy ? 'المحرك يعمل ويضيف النتائج تدريجياً…' : 'لا توجد تحديدات مطابقة للفلاتر الحالية'}</div>}
      {selected && <ZoneDetail zone={selected} onClose={() => setSelected(null)} onReviewed={reviewed} />}
    </section>
  );
}