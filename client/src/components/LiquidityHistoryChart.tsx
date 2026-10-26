import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';
import { attachZonePrimitive } from './ZoneBoxesPrimitive';
import { fetchLiquidityHistory, type LiquidityHistoryResponse, type LiquidityHistoryZone } from '../lib/liquidityHistory';

/**
 * الشارت التاريخي (فريم الدقيقة فقط) لمحركي السيولة.
 *
 * يُضمَّن داخل شاشة «مناطق السيولة القديمة» وشاشة «محرك السيولة الجديد» — وليس
 * في المختبر الموحد. يعرض شموع 1m بعمق حتى 120 يوماً مع مناطق المحرك المطلوب
 * وفق كشفه نفسه (لا تعديل على أي قاعدة)، وزر ملء الشاشة، وتمريراً حراً إلى
 * الماضي. المناطق مرسومة على إحداثياتها الزمنية فتتحرك مع الشارت ولا تثبت
 * على الشاشة.
 */

type CandleRow = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Coordinate = { tx: (time: number) => number | null; py: (price: number) => number | null };

const ENGINE_COLORS: Record<string, { up: string; down: string; label: string; dashedRef: boolean }> = {
  legacy: { up: '8,153,129', down: '242,54,69', label: 'المحرك الحالي', dashedRef: false },
  v2: { up: '37,99,235', down: '217,119,6', label: 'محرك v2', dashedRef: true }
};

const DAY_OPTIONS = [30, 60, 90, 120];
const INITIAL_VISIBLE_DAYS = 3;

const timestampSeconds = (value: number | null | undefined) => {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  return time > 1e12 ? Math.floor(time / 1000) : Math.floor(time);
};

function drawZones(ctx: CanvasRenderingContext2D, coordinate: Coordinate, zones: LiquidityHistoryZone[], candleRange: { first: number; last: number }, palette: { up: string; down: string; dashedRef: boolean }) {
  for (const zone of zones) {
    const reference = Number(zone.referenceLevel);
    const liquidity = Number(zone.liquidityLevel);
    const boxHigh = Number(zone.zoneBox?.high);
    const boxLow = Number(zone.zoneBox?.low);
    const high = Number.isFinite(boxHigh) ? boxHigh : Math.max(reference, liquidity);
    const low = Number.isFinite(boxLow) ? boxLow : Math.min(reference, liquidity);
    if (![high, low].every(Number.isFinite) || high <= 0 || low <= 0) continue;
    const detected = timestampSeconds(zone.createdAt) ?? candleRange.first;
    const startTime = Math.min(candleRange.last, Math.max(candleRange.first, detected));
    const xStart = coordinate.tx(startTime);
    const xEnd = coordinate.tx(candleRange.last);
    const yHigh = coordinate.py(high);
    const yLow = coordinate.py(low);
    if (xStart == null || xEnd == null || yHigh == null || yLow == null) continue;
    const up = zone.direction === 'up' || String(zone.kind).endsWith('ssl');
    const color = up ? palette.up : palette.down;
    const alpha = zone.state === 'confirmed' ? 0.16 : zone.state === 'swept' ? 0.06 : 0.1;
    ctx.fillStyle = `rgba(${color},${alpha})`;
    ctx.strokeStyle = `rgba(${color},${zone.state === 'confirmed' ? 0.8 : 0.45})`;
    ctx.lineWidth = zone.state === 'confirmed' ? 1.5 : 1;
    ctx.fillRect(xStart, yHigh, Math.max(2, xEnd - xStart), Math.max(1, yLow - yHigh));
    ctx.strokeRect(xStart, yHigh, Math.max(2, xEnd - xStart), Math.max(1, yLow - yHigh));
    if (Number.isFinite(reference)) {
      const yReference = coordinate.py(reference);
      if (yReference != null) {
        if (palette.dashedRef) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xStart, yReference);
        ctx.lineTo(xEnd, yReference);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

function HistoryChart({ data, height }: { data: LiquidityHistoryResponse; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dataRef = useRef<{ candles: CandleRow[]; zones: LiquidityHistoryZone[]; engineKey: 'legacy' | 'v2' }>({ candles: [], zones: [], engineKey: 'legacy' });
  const hasViewedRef = useRef(false);

  const candles = useMemo<CandleRow[]>(() => data.candles.map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume
  })), [data]);
  const palette = ENGINE_COLORS[data.engineKey] ?? ENGINE_COLORS.legacy;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = createChart(element, {
      width: element.clientWidth,
      height,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 11 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    });
    const candleSeries = chart.addSeries(CandlestickSeries, { ...HOLLOW_CANDLES });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    attachZonePrimitive(candleSeries, 'bottom', (context, coordinate) => {
      const { candles: rows, zones } = dataRef.current;
      if (!rows.length) return;
      drawZones(context, coordinate, zones, { first: rows[0].time, last: rows[rows.length - 1].time }, ENGINE_COLORS[dataRef.current.engineKey] ?? ENGINE_COLORS.legacy);
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    const observer = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      hasViewedRef.current = false;
    };
  }, [height]);

  useEffect(() => {
    dataRef.current = { candles, zones: data.zones, engineKey: data.engineKey };
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || !candles.length) return;
    candleSeries.setData(candles.map((c) => ({ ...c, time: Math.floor(c.time) as UTCTimestamp })));
    volumeSeries.setData(candles.map((c) => ({
      time: Math.floor(c.time) as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(8,153,129,.3)' : 'rgba(242,54,69,.3)'
    })));
    if (!hasViewedRef.current) {
      // أول عرض: آخر 3 أيام تقريباً — والتمرير إلى الماضي متاح حتى بداية النطاق
      const visible = INITIAL_VISIBLE_DAYS * 1440;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - visible),
        to: candles.length + 10
      });
      hasViewedRef.current = true;
    }
  }, [candles, data]);

  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-0)' }}>
      <div ref={containerRef} style={{ height, minHeight: height }} />
      <div className="absolute top-2 right-2 z-10 flex flex-wrap gap-2 rounded-md px-2 py-1 text-[10px]" style={{ background: 'rgba(10,14,22,.8)', color: '#e2e8f0' }}>
        <span><b style={{ color: `rgb(${palette.up})` }}>▬</b> {ENGINE_COLORS[data.engineKey]?.label}</span>
        <span><b style={{ color: `rgb(${palette.down})` }}>▬</b> الجهة المقابلة</span>
        {palette.dashedRef && <span><b style={{ color: '#94a3b8' }}>┄</b> مستوى المرجع</span>}
      </div>
      <div className="absolute top-2 left-2 z-10 rounded px-2 py-1 text-[10px] font-semibold" style={{ background: 'rgba(10,14,22,.8)', color: '#fff' }}>
        {data.symbol} · 1m · {data.days} يوماً · {data.bars.toLocaleString('en-US')} شمعة
        {data.gaps > 0 && <span style={{ color: '#fbbf24' }}> · فجوات: {data.gaps.toLocaleString('en-US')}</span>}
        {data.zonesCapped && <span style={{ color: '#fbbf24' }}> · مناطق معروضة {data.zones.length}/{data.totalZones}</span>}
      </div>
      <div className="absolute bottom-1 left-2 z-10 text-[9px]" style={{ color: 'var(--text-3)' }}>
        مصدر البيانات: Binance Spot · {data.engine} · حساب {data.computeMs.toLocaleString('en-US')}ms · للعرض والتحقق اليدوي فقط
      </div>
    </div>
  );
}

export default function LiquidityHistorySection({ engine, symbol }: { engine: 'legacy' | 'v2'; symbol: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(90);
  const [data, setData] = useState<LiquidityHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (depthDays = days) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchLiquidityHistory({ symbol, engine, days: depthDays, signal: controller.signal });
      setData(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(String((e as Error)?.message ?? e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [symbol, engine, days]);

  // الفتح الأول يشغّل التحميل تلقائياً (العمق الافتراضي 90 يوماً)
  useEffect(() => {
    if (open && !data && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const onFsChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  };

  const lastCandle = data?.candles.length ? new Date(data.candles[data.candles.length - 1][0] * 1000).toLocaleString('ar') : '';

  return (
    <section className="rounded-xl p-3 sm:p-4 space-y-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>
            الشارت التاريخي — فريم الدقيقة فقط {symbol ? `· ${symbol}` : ''}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            شموع 1m بعمق حتى 120 يوماً ومناطق المحرك {engine === 'legacy' ? 'الحالي' : 'v2'} وفق كشفه نفسه — التمرير إلى الماضي متاح، والمناطق مثبتة على أزمنتها. أول تحميل قد يستغرق نحو دقيقة (جلب ~130 ألف شمعة وحساب المناطق).
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={days}
            onChange={e => { const v = Number(e.target.value); setDays(v); if (open) void load(v); }}
            className="px-2.5 py-1.5 rounded-lg text-[12px]"
            style={{ background: 'var(--surface-0)', border: '1px solid var(--border-1)', color: 'var(--text-1)' }}
            title="عمق التاريخ بالأيام"
          >
            {DAY_OPTIONS.map(d => <option key={d} value={d}>{d} يوماً</option>)}
          </select>
          <button
            onClick={() => setOpen(o => !o)}
            className="px-3 py-2 rounded-lg text-[12px] font-semibold"
            style={{ background: open ? 'var(--surface-0)' : 'var(--accent-soft)', color: open ? 'var(--text-2)' : 'var(--accent)', border: '1px solid var(--border-1)' }}
          >
            {open ? 'إخفاء الشارت' : 'إظهار الشارت التاريخي'}
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-3 py-2 rounded-lg text-[12px] font-semibold"
            style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'يجهّز…' : 'تحديث'}
          </button>
          {data && (
            <button
              onClick={toggleFullscreen}
              className="px-3 py-2 rounded-lg text-[12px] font-semibold"
              style={{ background: 'var(--surface-0)', color: 'var(--text-2)', border: '1px solid var(--border-1)' }}
            >
              {fullscreen ? 'إنهاء ملء الشاشة' : 'ملء الشاشة'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-center justify-between gap-2" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>
          <span>{error}</span>
          <button onClick={() => void load()} className="px-2 py-1 rounded" style={{ background: 'var(--surface-0)', color: 'var(--text-1)' }}>إعادة المحاولة</button>
        </div>
      )}
      {loading && (
        <div className="rounded-lg px-3 py-3 text-[12px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          جارٍ تجهيز الشارت التاريخي: جلب شموع الدقيقة من Binance دفعةً بعد دفعة ثم حساب مناطق المحرك — قد يستغرق ذلك نحو دقيقة في أول تشغيل…
        </div>
      )}

      <div ref={wrapRef} style={fullscreen ? { background: 'var(--surface-0)', padding: 8 } : undefined}>
        {open && data && (
          <>
            <HistoryChart data={data} height={fullscreen ? Math.max(480, window.innerHeight - 120) : 560} />
            <div className="text-[10.5px] px-1 pt-1" style={{ color: 'var(--text-3)' }}>
              آخر شمعة: {lastCandle} · النطاق من {new Date(data.from * 1000).toLocaleDateString('ar')} إلى {new Date(data.to * 1000).toLocaleDateString('ar')}
              {' '}· إجمالي المناطق {data.totalZones} {data.zonesCapped ? `(معروض ${data.zones.length})` : ''}
              {data.cached ? ' · نتيجة مخزنة (آخر حساب خلال 15 دقيقة)' : ' · حساب جديد'}
            </div>
          </>
        )}
        {open && !data && !loading && !error && (
          <div className="rounded-lg py-10 text-center text-[12px]" style={{ color: 'var(--text-3)', background: 'var(--surface-0)' }}>
            اضغط «تحديث» لجلب التاريخ وحساب المناطق
          </div>
        )}
      </div>
    </section>
  );
}
