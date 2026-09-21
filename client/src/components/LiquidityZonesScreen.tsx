import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import ZoneChart from './ZoneChart';
import { TIMEFRAMES, type LiquidityDetection, type LiquidityZoneEngineStatus } from '../lib/types';

const kindLabel: Record<string, string> = {
  horizontal_bsl: 'BSL أفقي',
  horizontal_ssl: 'SSL أفقي',
  trendline_bsl: 'BSL خط اتجاه',
  trendline_ssl: 'SSL خط اتجاه'
};

const stateLabel: Record<string, string> = {
  potential: 'محتمل',
  candidate: 'مرشح',
  confirmed: 'مؤكد',
  swept: 'مسحوب'
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const price = (n: number | null | undefined) => n == null ? '—' : Number(n).toPrecision(8);
const date = (n: number | null | undefined) => n ? new Date(n > 1e12 ? n : n * 1000).toLocaleString('ar-SA') : '—';

function ZoneCard({ zone, onOpen }: { zone: LiquidityDetection; onOpen: (zone: LiquidityDetection) => void }) {
  const bullish = zone.kind.includes('ssl');
  return (
    <button
      onClick={() => onOpen(zone)}
      className="text-right rounded-xl p-3 transition-colors"
      style={{ background: 'var(--surface-1)', border: `1px solid ${bullish ? 'rgba(8,153,129,.35)' : 'rgba(242,54,69,.35)'}` }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="num font-bold" style={{ color: bullish ? 'var(--up)' : 'var(--down)' }}>{zone.symbol}</span>
          <span className="num text-[11px]" style={{ color: 'var(--text-3)' }}>{zone.timeframe}</span>
        </div>
        <span className="px-2 py-0.5 rounded-full text-[10px]" style={{ background: bullish ? 'var(--up-soft)' : 'var(--down-soft)', color: bullish ? 'var(--up)' : 'var(--down)' }}>
          {kindLabel[zone.kind] ?? zone.kind}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span style={{ color: 'var(--text-2)' }}>{stateLabel[zone.state] ?? zone.state}</span>
        <span className="num font-bold" style={{ color: zone.confidence >= .7 ? 'var(--accent)' : 'var(--text-1)' }}>{pct(zone.confidence)} ثقة</span>
      </div>
      <div className="grid grid-cols-3 gap-1 mt-2 text-center">
        <div><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>المرجع</div><div className="num text-[11px]">{price(zone.referenceLevel)}</div></div>
        <div><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>السيولة</div><div className="num text-[11px]">{price(zone.liquidityLevel)}</div></div>
        <div><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>اللمسات</div><div className="num text-[11px]">{zone.touches}</div></div>
      </div>
    </button>
  );
}

function ZoneDetail({ zone, onClose, onReviewed }: { zone: LiquidityDetection; onClose: () => void; onReviewed: (zone: LiquidityDetection) => void }) {
  const [note, setNote] = useState(zone.review?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<'at' | 'after'>('at');
  const review = async (verdict: 'accept' | 'reject') => {
    setSaving(true);
    try {
      const r = await api.reviewLiquidityZone(zone.id, { verdict, note });
      onReviewed(r.zone);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: 'rgba(15,23,42,.35)' }} onClick={onClose}>
      <div className="w-full max-w-5xl max-h-[92vh] overflow-auto rounded-2xl p-4" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', boxShadow: 'var(--shadow-lg)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2"><span className="num font-bold">{zone.symbol}</span><span className="num text-[12px]" style={{ color: 'var(--text-3)' }}>{zone.timeframe}</span><span className="text-[12px]" style={{ color: 'var(--accent)' }}>{kindLabel[zone.kind]}</span></div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>الحالة: {stateLabel[zone.state]} · اكتُشف: {date(zone.detectedAt)}</div>
          </div>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[12px]" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>إغلاق</button>
        </div>
        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button onClick={() => setPhase('at')} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: phase === 'at' ? 'var(--accent-soft)' : 'var(--surface-1)', color: phase === 'at' ? 'var(--accent)' : 'var(--text-2)' }}>عند الكشف</button>
              <button onClick={() => setPhase('after')} className="px-3 py-1.5 rounded-lg text-[11px]" style={{ background: phase === 'after' ? 'var(--accent-soft)' : 'var(--surface-1)', color: phase === 'after' ? 'var(--accent)' : 'var(--text-2)' }}>بعد الكشف</button>
              <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>شارت حي تفاعلي من بينانس مباشرة</span>
            </div>
            <div className="rounded-xl overflow-hidden" style={{ background: '#fff', border: '1px solid var(--border-1)' }}>
              <ZoneChart zone={zone} phase={phase} height={360} />
            </div>
            <div className="rounded-lg p-2 flex flex-wrap gap-x-4 gap-y-1" style={{ background: 'var(--surface-1)' }}>
              <span className="text-[10px]"><span title="المرجع" style={{ color: '#64748b' }}>— —</span> المرجع (المقاومة/الدعم)</span>
              <span className="text-[10px]"><span style={{ color: '#7c3aed' }}>◯</span> نقطة لمس (قمة/قاع بنّت المنطقة)</span>
              <span className="text-[10px]"><span style={{ color: '#f59e0b' }}>━</span> خط الاتجاه</span>
              <span className="text-[10px]"><span style={{ color: '#7c3aed' }}>تظليل</span> Premium</span>
              <span className="text-[10px]"><span style={{ color: '#d97706' }}>· ·</span> وقف Retail</span>
            </div>
            <div className="text-[10px] rounded-lg p-2" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>
              لتحقيق منطقك: راقب النقاط ◯ والمستويات فوق الشموع الحقيقية. إن كان التحديد خاطئاً ارفضه واكتب ملاحظتك — ملاحظتك تدخل تعلّم المحرك.
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                ['Reference', price(zone.referenceLevel)],
                ['Liquidity', price(zone.liquidityLevel)],
                ['Retail Stop', price(zone.retailStop)],
                ['ATR', price(zone.atr)],
                ['المسافة ATR', String(zone.distanceAtr)],
                ['البروز ATR', String(zone.prominenceAtr)],
                ['اللمسات', String(zone.touches)],
                ['الثقة', pct(zone.confidence)]
              ].map(([label, value]) => <div key={label} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-1)' }}><div className="text-[9px]" style={{ color: 'var(--text-3)' }}>{label}</div><div className="num text-[12px] font-semibold">{value}</div></div>)}
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--surface-1)' }}>
              <div className="text-[11px] font-bold mb-1.5">سبب التحديد</div>
              <ul className="space-y-1">{zone.reasons.map(reason => <li key={reason} className="text-[11px]" style={{ color: 'var(--text-2)' }}>• {reason}</li>)}</ul>
            </div>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="ملاحظتك على التحديد…" className="w-full min-h-20 rounded-lg p-2 text-[12px] resize-y" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
            <div className="flex gap-2">
              <button disabled={saving} onClick={() => void review('accept')} className="flex-1 px-3 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--up-soft)', color: 'var(--up)', opacity: saving ? .5 : 1 }}>قبول وتعلم</button>
              <button disabled={saving} onClick={() => void review('reject')} className="flex-1 px-3 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--down-soft)', color: 'var(--down)', opacity: saving ? .5 : 1 }}>رفض وتعلم</button>
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>المستويات تحليلية فقط وليست أوامر تنفيذ. كل فريم وكل نوع محفوظ كسجل مستقل.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

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