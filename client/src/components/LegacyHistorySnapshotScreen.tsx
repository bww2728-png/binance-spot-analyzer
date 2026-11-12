import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildElements, defaultFilters, selectElements } from '../../../shared/historyModel.mjs';
import { TIMEFRAMES } from '../lib/types';
import { fetchLiquidityHistorySnapshot, type LiquidityHistorySnapshotResponse } from '../lib/liquidityHistory';
import HistoryChartView, { type CandleRow } from './history/HistoryChartView';

const SNAPSHOT_TIMEFRAMES = TIMEFRAMES;
const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (count: number) => new Date(Date.now() - count * DAY_MS).toISOString().slice(0, 10);
const utcStart = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const utcEndExclusive = (date: string) => utcStart(date) + DAY_MS;
const formatDateTime = (seconds: number | null | undefined) => seconds == null
  ? '—'
  : new Date(seconds * 1000).toLocaleString('ar', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });

export default function LegacyHistorySnapshotScreen({ onBack }: { onBack: () => void }) {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('1h');
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(today());
  const [data, setData] = useState<LiquidityHistorySnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState({ drawn: 0, culled: 0, labelSkips: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const load = useCallback(async () => {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const startTime = utcStart(startDate);
    const endTime = utcEndExclusive(endDate);
    if (!normalizedSymbol || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      setError('تحقق من الرمز وتواريخ البداية والنهاية.');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    const snapshotTime = Math.min(endTime, Date.now());
    setData(null);
    setSelectedId(null);
    setError('');
    setLoading(true);

    try {
      const result = await fetchLiquidityHistorySnapshot({
        symbol: normalizedSymbol,
        timeframe,
        startTime,
        endTime,
        snapshotTime,
        signal: controller.signal
      });
      if (!controller.signal.aborted && requestId === requestIdRef.current) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted && requestId === requestIdRef.current) {
        setError(String((cause as Error)?.message ?? cause));
      }
    } finally {
      if (!controller.signal.aborted && requestId === requestIdRef.current) setLoading(false);
    }
  }, [symbol, timeframe, startDate, endDate]);

  const candles = useMemo<CandleRow[]>(() => (data?.candles ?? []).map(([time, open, high, low, close, volume]) => ({
    time,
    open,
    high,
    low,
    close,
    volume
  })), [data]);
  const built = useMemo(() => buildElements({ engine: 'legacy', zones: data?.zones ?? [], structureEvents: [] }), [data]);
  const cursorTime = candles[candles.length - 1]?.time ?? 0;
  const cursorPrice = candles[candles.length - 1]?.close ?? null;
  const selection = useMemo(() => selectElements(built.elements, {
    filters: defaultFilters(),
    cursorTime,
    replay: false,
    cursorPrice
  }), [built.elements, cursorTime, cursorPrice]);
  const selected = useMemo(() => built.elements.find((element) => element.id === selectedId) ?? null, [built.elements, selectedId]);
  const dataKey = data
    ? `${data.symbol}|${data.timeframe}|${data.startTime}|${data.endTime}|${data.snapshotTime}|${data.engine}`
    : 'empty';

  return (
    <section className="max-w-[1600px] mx-auto px-3 sm:px-5 py-4 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>الشارت التاريخي — المحرك القديم</h2>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>لقطة ثابتة من بيانات Binance Spot، مع إظهار المناطق التي أعادها المحرك القديم فقط.</p>
        </div>
        <button onClick={onBack} className="px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--surface-1)', color: 'var(--text-2)' }}>العودة إلى مناطق السيولة</button>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void load(); }} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 rounded-xl p-3" style={{ background: 'var(--surface-1)' }}>
        <label className="space-y-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span>العملة</span>
          <input value={symbol} onChange={(event) => setSymbol(event.target.value)} autoCapitalize="characters" className="w-full rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
        </label>
        <label className="space-y-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span>الفاصل الزمني</span>
          <select value={timeframe} onChange={(event) => setTimeframe(event.target.value)} className="w-full rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}>
            {SNAPSHOT_TIMEFRAMES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span>من تاريخ UTC</span>
          <input type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} className="w-full rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
        </label>
        <label className="space-y-1 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span>إلى تاريخ UTC</span>
          <input type="date" value={endDate} max={today()} onChange={(event) => setEndDate(event.target.value)} className="w-full rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }} />
        </label>
        <div className="sm:col-span-2 flex items-end">
          <button type="submit" disabled={loading} className="w-full rounded-lg px-4 py-2 text-[12px] font-bold disabled:opacity-60" style={{ background: 'var(--accent)', color: '#fff' }}>{loading ? 'جارٍ جلب الشموع والحساب…' : 'تحميل اللقطة التاريخية'}</button>
        </div>
      </form>

      {error && <div role="alert" className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>{error}</div>}
      {loading && <div role="status" className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>الشموع والتحديدات قيد التجهيز. قد يستغرق التحميل وقتًا حسب طول الفترة.</div>}

      {data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
            <Summary label="الشموع المكتملة" value={data.bars.toLocaleString('en-US')} />
            <Summary label="مناطق المحرك" value={data.totalZones.toLocaleString('en-US')} />
            <Summary label="الفجوات" value={`${data.quality.gapCount} · ${data.quality.missingBars} شمعة`} />
            <Summary label="شموع غير مكتملة مستبعدة" value={data.quality.incompleteBars.toLocaleString('en-US')} />
            <Summary label="تأكيد البيفوت" value={`rightBars=${data.meta.rightBars}`} />
          </div>
          <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-0)' }}>
            <HistoryChartView
              rows={candles}
              dataKey={dataKey}
              elements={selection.visible}
              style={defaultFilters().appearance}
              replay={false}
              altInReplay={false}
              selectedId={selectedId}
              height={560}
              onSelect={setSelectedId}
              onStats={setStats}
            />
            <div className="absolute top-2 right-2 z-10 rounded-md px-2 py-1 text-[10px] pointer-events-none" style={{ background: 'rgba(10,14,22,.82)', color: '#e2e8f0' }}>
              {data.symbol} · {data.timeframe} · {candles.length.toLocaleString('en-US')} شمعة · {selection.counts.visible}/{selection.counts.total} منطقة مرئية
              {' · '}على الشارت {stats.drawn}
            </div>
            <div className="absolute bottom-1 left-2 z-10 text-[9px] pointer-events-none" style={{ color: 'var(--text-3)' }}>
              مصدر الشموع: {data.source} · نتائج المحرك: {data.engine}
            </div>
          </div>
          {selected && (
            <section className="rounded-xl p-3 space-y-2 text-[11px]" style={{ background: 'var(--surface-1)', border: `1px solid ${selected.color}` }}>
              <div className="flex flex-wrap items-center gap-2">
                <b style={{ color: selected.color }}>{selected.label}</b>
                <span className="num">المستوى: {selected.price ?? selected.high ?? '—'}</span>
                <span>{selected.state ?? '—'}</span>
                <button onClick={() => setSelectedId(null)} className="mr-auto rounded px-2 py-1" style={{ background: 'var(--surface-0)', color: 'var(--text-2)' }}>إغلاق التفاصيل</button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                <Summary label="النشأة" value={formatDateTime(selected.createdAt)} />
                <Summary label="أول معرفة" value={formatDateTime(selected.availableAt)} />
                <Summary label="التأكيد" value={formatDateTime(selected.confirmedAt)} />
                <Summary label="السحب" value={formatDateTime(selected.sweptAt)} />
                <Summary label="الإبطال" value={formatDateTime(selected.invalidatedAt)} />
              </div>
              <details>
                <summary className="cursor-pointer">بيانات المنطقة كما وصلت من المحرك</summary>
                <pre className="mt-2 max-h-72 overflow-auto text-[9px]" style={{ direction: 'ltr', color: 'var(--text-2)' }}>{JSON.stringify(selected.raw, null, 2)}</pre>
              </details>
            </section>
          )}
          <div className="rounded-lg px-3 py-2 text-[10px]" style={{ background: 'var(--surface-1)', color: 'var(--text-3)' }}>
            لقطة UTC عند {formatDateTime(data.snapshotTime / 1000)}؛ النطاق المطلوب {formatDateTime(data.startTime / 1000)} — {formatDateTime(data.endTime / 1000)}. لم تُنشأ شموع بديلة. {data.quality.gapCount > 0 ? 'الفجوات معروضة كفجوات، ولم تُملأ.' : 'لم تُكتشف فجوات بين الشموع المعادة.'}
            {data.cached ? ' · نتيجة محفوظة مطابقة للاستعلام' : ` · الحساب ${data.meta.computeMs}ms`}
          </div>
        </div>
      )}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'var(--surface-1)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="mt-1 font-semibold num" style={{ color: 'var(--text-1)' }}>{value}</div>
    </div>
  );
}
