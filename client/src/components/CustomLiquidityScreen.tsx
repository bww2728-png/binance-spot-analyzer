import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ZoneCard, ZoneDetail, kindLabel, stateLabel, pct } from './ZoneCards';
import MultiZoneChart from './MultiZoneChart';
import MarketReadPanel from './MarketReadPanel';
import { TIMEFRAMES, type LiquidityDetection } from '../lib/types';

const isoDay = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dayStartMs = (iso: string) => new Date(`${iso}T00:00:00`).getTime();
const dayEndMs = (iso: string) => new Date(`${iso}T23:59:59.999`).getTime();

export default function CustomLiquidityScreen() {
  const [targets, setTargets] = useState<string[]>([]);
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('5m');
  const [fromIso, setFromIso] = useState('');
  const [toIso, setToIso] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [runInfo, setRunInfo] = useState<{ symbol: string; timeframe: string; fromTs: number; toTs: number } | null>(null);
  const [candles, setCandles] = useState<Array<[number, number, number, number, number]>>([]);
  const [zones, setZones] = useState<LiquidityDetection[]>([]);
  const [selected, setSelected] = useState<LiquidityDetection | null>(null);
  // فلاتر الشارت المستقل — المسحوبة مخفية افتراضياً
  const [chartKinds, setChartKinds] = useState<Record<string, boolean>>({ horizontal_bsl: true, horizontal_ssl: true, trendline_bsl: true, trendline_ssl: true });
  const [chartStates, setChartStates] = useState<Record<string, boolean>>({ potential: true, candidate: true, confirmed: true, swept: false });
  const [showStopPrices, setShowStopPrices] = useState(true);
  const [cap, setCap] = useState(0);
  // فلاتر القائمة
  const [listKind, setListKind] = useState('');
  const [listState, setListState] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    void api.getLiquidityTargets(ac.signal).then(r => setTargets(r.targets)).catch(() => {});
    // الافتراضي: آخر 30 يوماً
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400000);
    setToIso(isoDay(to));
    setFromIso(isoDay(from));
    return () => ac.abort();
  }, []);

  const applyPreset = (days: number) => {
    const to = new Date();
    setToIso(isoDay(to));
    setFromIso(isoDay(new Date(to.getTime() - days * 86400000)));
  };

  const run = async () => {
    setError('');
    const sym = symbol.trim().toUpperCase();
    if (!sym) { setError('اختر العملة أولاً'); return; }
    if (!(TIMEFRAMES as readonly string[]).includes(timeframe)) { setError('فريم غير صالح'); return; }
    if (!fromIso || !toIso) { setError('حدد مدى زمني من/إلى'); return; }
    const fromTs = dayStartMs(fromIso);
    const toTs = dayEndMs(toIso);
    if (toTs <= fromTs) { setError('المدى الزمني غير صالح — يجب أن يكون "إلى" بعد "من"'); return; }
    setRunning(true);
    try {
      const r = await api.runCustomLiquidityZones({ symbol: sym, timeframe, fromTs, toTs });
      setRunInfo({ symbol: r.symbol, timeframe: r.timeframe, fromTs: r.fromTs, toTs: r.toTs });
      setCandles(r.candles ?? []);
      setZones(r.results ?? []);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setRunning(false);
    }
  };

  const chartZones = useMemo(() => {
    const filtered = [...zones]
      .filter(z => chartKinds[z.kind] !== false)
      .filter(z => chartStates[z.state] !== false)
      .sort((a, b) => b.confidence - a.confidence);
    return cap > 0 ? filtered.slice(0, cap) : filtered;
  }, [zones, chartKinds, chartStates, cap]);

  const listZones = useMemo(() => [...zones]
    .filter(z => !listKind || z.kind === listKind)
    .filter(z => !listState || z.state === listState)
    .sort((a, b) => b.confidence - a.confidence), [zones, listKind, listState]);

  const reviewed = (zone: LiquidityDetection) => {
    setZones(prev => prev.map(x => x.id === zone.id ? zone : x));
    setSelected(zone);
  };

  const filteredKinds = Object.values(chartKinds).filter(Boolean).length;

  return (
    <section className="max-w-[1600px] mx-auto px-3 sm:px-5 py-4 space-y-4" dir="rtl">
      <div>
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>جولة مخصصة لتحديد مناطق السيولة</h2>
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>عملة وفريم ومدى زمني من اختيارك — الحلال غير الباركود حصراً — الشارت المستقل يرسم كل المناطق وخط وقف الخسائر لكل منطقة</p>
      </div>

      {/* لوحة التخصيص */}
      <div className="rounded-2xl p-3 sm:p-4 space-y-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <input list="custom-targets" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="العملة — مثل BTCUSDT" className="px-3 py-2 rounded-lg text-[12px] w-48" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
          <datalist id="custom-targets">
            {targets.map(t => <option key={t} value={t} />)}
          </datalist>
          <select value={timeframe} onChange={e => setTimeframe(e.target.value)} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
            {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-3)' }}>من
            <input type="date" value={fromIso} onChange={e => setFromIso(e.target.value)} className="px-2 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
          </label>
          <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-3)' }}>إلى
            <input type="date" value={toIso} onChange={e => setToIso(e.target.value)} className="px-2 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
          </label>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => applyPreset(d)} className="px-2.5 py-2 rounded-lg text-[11px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-2)' }}>آخر {d} يوماً</button>
          ))}
          <button disabled={running} onClick={() => void run()} className="px-5 py-2 rounded-lg text-[12px] font-bold" style={{ background: 'var(--accent)', color: '#fff', opacity: running ? .5 : 1 }}>{running ? 'جولة تعمل…' : 'تشغيل الجولة'}</button>
        </div>
        <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>الجولة تعمل بخطوة 1 فوق شموع الصفحات حتى آلاف الشموع بحد 1000 منطقة — النتائج تظهر تحت مع الشارت المستقل</div>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>{error}</div>}

      {/* مساعد قراءة السوق — حتمي من أرقام محرك مناطق السيولة */}
      <MarketReadPanel symbol={runInfo?.symbol ?? symbol} currentTimeframe={timeframe} />

      {runInfo && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span style={{ color: 'var(--text-2)' }}>
            <span className="num font-bold">{runInfo.symbol}</span> · {runInfo.timeframe} · {new Date(runInfo.fromTs).toLocaleDateString('ar-SA')} ← {new Date(runInfo.toTs).toLocaleDateString('ar-SA')} · <span className="num">{zones.length}</span> منطقة · <span className="num">{candles.length}</span> شمعة
          </span>
        </div>
      )}

      {/* الشارت المستقل */}
      {!!candles.length && (
        <div className="rounded-2xl p-3 space-y-2" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12px] font-bold" style={{ color: 'var(--text-1)' }}>الشارت المستقل — كل المناطق المختارة فوق شموع النافذة</h3>
            <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>معروض <span className="num font-bold">{chartZones.length}</span> من <span className="num">{zones.length}</span></span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {Object.entries(kindLabel).map(([k, label]) => (
              <button key={k} onClick={() => setChartKinds(p => ({ ...p, [k]: !p[k] }))} className="px-2 py-1.5 rounded-lg text-[10px]" style={{ background: chartKinds[k] !== false ? 'var(--accent-soft)' : 'var(--surface-0)', color: chartKinds[k] !== false ? 'var(--accent)' : 'var(--text-3)', border: '1px solid var(--border-1)' }}>{label}</button>
            ))}
            <span className="w-px h-4" style={{ background: 'var(--border-1)' }} />
            {Object.entries(stateLabel).map(([s, label]) => (
              <button key={s} onClick={() => setChartStates(p => ({ ...p, [s]: !p[s] }))} className="px-2 py-1.5 rounded-lg text-[10px]" style={{ background: chartStates[s] !== false ? 'var(--accent-soft)' : 'var(--surface-0)', color: chartStates[s] !== false ? 'var(--accent)' : 'var(--text-3)', border: '1px solid var(--border-1)' }}>{label}</button>
            ))}
            <span className="w-px h-4" style={{ background: 'var(--border-1)' }} />
            <button onClick={() => setShowStopPrices(p => !p)} className="px-2 py-1.5 rounded-lg text-[10px]" style={{ background: showStopPrices ? 'var(--accent-soft)' : 'var(--surface-0)', color: showStopPrices ? 'var(--accent)' : 'var(--text-3)', border: '1px solid var(--border-1)' }}>أسعار الوقف على المحور</button>
            <label className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>أعلى
              <input type="number" min={0} max={60} value={cap} onChange={e => setCap(parseInt(e.target.value, 10) || 0)} className="w-14 px-1.5 py-1.5 rounded-lg text-[11px] text-center" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
              ثقة (0 = الكل)
            </label>
            {filteredKinds === 0 && <span className="text-[10px]" style={{ color: 'var(--down)' }}>فعّل نوعاً واحداً على الأقل</span>}
          </div>
          <div className="rounded-xl overflow-hidden" style={{ background: '#fff', border: '1px solid var(--border-1)' }}>
            <MultiZoneChart candles={candles} zones={chartZones} height={420} showStopPrices={showStopPrices} />
          </div>
        </div>
      )}

      {/* قائمة النتائج — نفس نقاط التحديد مثل واجهة مناطق السيولة */}
      {zones.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[12px] font-bold" style={{ color: 'var(--text-1)' }}>نقاط التحديد ({listZones.length})</h3>
            <select value={listKind} onChange={e => setListKind(e.target.value)} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل الأنواع</option>
              {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={listState} onChange={e => setListState(e.target.value)} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
              <option value="">كل الحالات</option>
              {Object.entries(stateLabel).map(([s, v]) => <option key={s} value={s}>{v}</option>)}
            </select>
            <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>ترتيب الثقة: أعلى {zones.length ? pct(Math.max(...zones.map(z => z.confidence))) : ''} · أسفل {zones.length ? pct(Math.min(...zones.map(z => z.confidence))) : ''}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {listZones.map(zone => <ZoneCard key={zone.id} zone={zone} onOpen={setSelected} />)}
          </div>
        </>
      )}

      {runInfo && !running && !zones.length && (
        <div className="rounded-xl py-16 text-center text-sm" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>شموع النافذة جاهزة لكن لا تحديدات مطابقة — جرّب مدى أطول أو فريماً أكبر</div>
      )}

      {selected && <ZoneDetail zone={selected} onClose={() => setSelected(null)} onReviewed={reviewed} />}
    </section>
  );
}
