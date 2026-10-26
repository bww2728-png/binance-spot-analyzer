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
import { KIND_COLORS } from './LiquidityV2Chart';
import { attachZonePrimitive } from './ZoneBoxesPrimitive';
import { fetchLiquidityHistory, type LiquidityHistoryResponse, type LiquidityHistoryZone } from '../lib/liquidityHistory';

/**
 * الشارت التاريخي (فريم الدقيقة فقط) لمحركي السيولة.
 *
 * طبقة الرسم هنا **نسخة مطابقة لمنطق شارت كل شاشة** — لا أسلوب مستقل:
 * - engine='legacy': منطق MultiZoneChart — صناديق من نقاط اللمس الحقيقية حتى
 *   شمعة المسح، حد الوقف عند مستوى السيولة، نقاط اللمس على الحافة، وأخضر لSSL
 *   وأحمر لBSL حسب النوع.
 * - engine='v2': منطق LiquidityV2Chart — KIND_COLORS حسب النوع، صناديق
 *   العرض/الطلب المؤكدة بسقف وامتداد محدود، خطوط BSL/SSL بمرجع صلب وسيولة
 *   متقطعة، خطوط اتجاه من نقاطها حتى إسقاطها، خفوت بالأقدمية وتعتيم المسحوبة.
 *
 * مضادات التكدس: سقوف مرسومة معلنة، اقتطاع بنطاق السعر والزمن المرئيين،
 * عدّاد «مرئي/إجمالي»، مفتاح ألوان عربي، وفلاتر (المسحوبة/خطوط الاتجاه/الصناديق).
 * لا تعديل على أي قاعدة كشف في المحركين — عرض فقط.
 */

type CandleRow = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Coordinate = { tx: (time: number) => number | null; py: (price: number) => number | null };

export interface HistoryFilters {
  showSwept: boolean;
  showTrendlines: boolean;
  showBoxes: boolean;
}

const DEFAULT_FILTERS: HistoryFilters = { showSwept: true, showTrendlines: true, showBoxes: true };

// سقوف مطابقة لشارت LiquidityV2Chart (BOX_CAP/LINE_CAP/BOX_MAX_BARS/LINE_MIN_ALPHA)
const BOX_CAP = 30;
const LINE_CAP = 20;
const BOX_MAX_BARS = 80;
const LINE_MIN_ALPHA = 0.4;
const MAX_LABELS = 12;

const stateRank = (s: string) => (s === 'confirmed' ? 0 : s === 'candidate' ? 1 : s === 'swept' ? 2 : 3);
const createdAtSec = (z: LiquidityHistoryZone) => tsSeconds(z.createdAt) ?? 0;

const KIND_SHORT: Record<string, string> = {
  horizontal_bsl: 'BSL',
  horizontal_ssl: 'SSL',
  trendline_bsl: 'خط BSL',
  trendline_ssl: 'خط SSL',
  supply: 'عرض',
  demand: 'طلب'
};

const fmtPrice = (p: number) => new Intl.NumberFormat('en-US', {
  maximumFractionDigits: Math.abs(p) >= 1000 ? 2 : Math.abs(p) >= 1 ? 4 : 6
}).format(p);

const tsSeconds = (value: number | null | undefined) => {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  return time > 1e12 ? Math.floor(time / 1000) : Math.floor(time);
};

/** لون المنطقة حسب النوع فقط — المعيار الثابت في شارتي الشاشتين */
const kindRgb = (kind: string) => (kind.includes('ssl') ? '8,153,129' : '242,54,69');

type DrawPayload = {
  candles: CandleRow[];
  zones: LiquidityHistoryZone[];
  engineKey: 'legacy' | 'v2';
  filters: HistoryFilters;
  chartHeight: number;
  visFrom: number;
  visTo: number;
};

function drawZones(ctx: CanvasRenderingContext2D, coordinate: Coordinate, payload: DrawPayload, counter?: { current: HTMLSpanElement | null }) {
  const { candles, zones, engineKey, filters, chartHeight, visFrom, visTo } = payload;
  if (counter?.current) counter.current.textContent = '…';
  if (!candles.length) return;
  const firstTime = candles[0].time;
  const lastTime = candles[candles.length - 1].time;
  const timeSpan = Math.max(1, lastTime - firstTime);
  let drawn = 0;
  const total = zones.length;
  const offscreen = (yA: number | null, yB: number | null) => {
    const vals = [yA, yB].filter((v): v is number => v != null);
    if (!vals.length) return true;
    return vals.every(v => v < -40) || vals.every(v => v > chartHeight + 40);
  };

  // ---- مسار v2: منطق LiquidityV2Chart حرفياً ----
  if (engineKey === 'v2') {
    const shown = zones.filter(z => filters.showSwept || z.state !== 'swept');
    const boxZones = shown
      .filter(z => (z.kind === 'supply' || z.kind === 'demand') && z.zoneBox && (z.state === 'confirmed' || z.state === 'swept'))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, BOX_CAP);
    const lineZones = shown
      .filter(z => z.kind === 'horizontal_bsl' || z.kind === 'horizontal_ssl' || z.kind.startsWith('trendline'))
      .filter(z => !z.kind.startsWith('trendline') || filters.showTrendlines)
      .sort((a, b) =>
        stateRank(a.state) - stateRank(b.state) ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        createdAtSec(b) - createdAtSec(a))
      .slice(0, LINE_CAP);

    // صناديق العرض/الطلب: من وقت الاكتشاف بامتداد محدود (80 شمعة × دقيقة)
    for (const z of boxZones) {
      if (!filters.showBoxes) break;
      const col = KIND_COLORS[z.kind];
      const created = tsSeconds(z.createdAt);
      if (created == null || created > visTo) continue;
      const yTop = coordinate.py(z.zoneBox!.high);
      const yBot = coordinate.py(z.zoneBox!.low);
      if (offscreen(yTop, yBot) || yTop == null || yBot == null) continue;
      const xFrom = coordinate.tx(Math.max(created, visFrom));
      const xTo = coordinate.tx(Math.min(lastTime, created + BOX_MAX_BARS * 60));
      if (xFrom == null || xTo == null || xTo <= xFrom) continue;
      const alpha = z.state === 'swept' ? 0.10 : 0.14 + Math.min(z.confidence, 0.99) * 0.18;
      const rgb = z.kind === 'supply' ? '249,115,22' : '59,130,246';
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.fillRect(xFrom, yTop, xTo - xFrom, Math.max(yBot - yTop, 1));
      ctx.strokeStyle = col.line;
      ctx.globalAlpha = z.state === 'swept' ? 0.4 : 0.85;
      ctx.lineWidth = 1;
      ctx.strokeRect(xFrom, yTop, xTo - xFrom, Math.max(yBot - yTop, 1));
      ctx.globalAlpha = 1;
      const yBodyTop = coordinate.py(z.bodyBox?.high ?? NaN);
      const yBodyBot = coordinate.py(z.bodyBox?.low ?? NaN);
      if (z.bodyBox && z.bodyBox.high > z.bodyBox.low && yBodyTop != null && yBodyBot != null) {
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.strokeRect(xFrom, yBodyTop, xTo - xFrom, Math.max(yBodyBot - yBodyTop, 1));
        ctx.setLineDash([]);
      }
      drawn += 1;
    }

    // خطوط BSL/SSL وخطوط الاتجاه
    let labels = 0;
    for (const z of lineZones) {
      const col = KIND_COLORS[z.kind] ?? { line: '#94a3b8', fill: '', label: '' };
      const created = tsSeconds(z.createdAt);
      if (created == null || created > visTo) continue;
      const xEnd = coordinate.tx(lastTime);
      const xStart = coordinate.tx(Math.max(created, visFrom));
      if (xEnd == null || xStart == null) continue;
      const lifeAlpha = LINE_MIN_ALPHA + (1 - LINE_MIN_ALPHA) * Math.min(1, Math.max(0, (created - firstTime) / timeSpan));

      if (z.kind.startsWith('trendline')) {
        const pts = z.trendline?.points ?? [];
        if (pts.length < 2 || !z.trendline) continue;
        const p0 = coordinate.py(pts[0].price);
        const pProj = coordinate.py(z.trendline.projected);
        if (offscreen(p0, pProj) || p0 == null || pProj == null) continue;
        const x0 = coordinate.tx(tsSeconds(pts[0].time) ?? created);
        if (x0 == null) continue;
        ctx.strokeStyle = col.line;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = lifeAlpha * (z.state === 'swept' ? 0.35 : 0.9);
        ctx.beginPath();
        ctx.moveTo(x0, p0);
        ctx.lineTo(xEnd, pProj);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.fillStyle = col.line;
        for (const p of pts) {
          const xp = coordinate.tx(tsSeconds(p.time) ?? created);
          const yp = coordinate.py(p.price);
          if (xp != null && yp != null) ctx.fillRect(xp - 1.5, yp - 1.5, 3, 3);
        }
        drawn += 1;
        continue;
      }

      // BSL/SSL الأفقية: مرجع صلب + سيولة متقطعة + الخط الفرعي عند اختلافه المعنوي
      const yRef = coordinate.py(z.referenceLevel);
      const yLiq = coordinate.py(z.liquidityLevel);
      if (yRef == null && yLiq == null) continue;
      if (offscreen(yRef, yLiq)) continue;
      const alpha = lifeAlpha * (z.state === 'swept' ? 0.35 : 0.95);
      if (yRef != null) {
        ctx.strokeStyle = col.line;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(xStart, yRef);
        ctx.lineTo(xEnd, yRef);
        ctx.stroke();
      }
      if (yLiq != null) {
        ctx.setLineDash([5, 4]);
        ctx.globalAlpha = alpha * 0.8;
        ctx.beginPath();
        ctx.moveTo(xStart, yLiq);
        ctx.lineTo(xEnd, yLiq);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const alt = z.referenceAlt;
      if (Number.isFinite(alt as number) && Math.abs((alt as number) - z.referenceLevel) > Math.abs(z.referenceLevel) * 0.001) {
        const yAlt = coordinate.py(alt as number);
        if (yAlt != null) {
          ctx.setLineDash([2, 4]);
          ctx.globalAlpha = alpha * 0.5;
          ctx.beginPath();
          ctx.moveTo(xStart, yAlt);
          ctx.lineTo(xEnd, yAlt);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1;
      if (labels < MAX_LABELS && yRef != null) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = col.line;
        ctx.globalAlpha = Math.max(0.55, alpha);
        ctx.fillText(`${KIND_SHORT[z.kind] ?? z.kind} ${fmtPrice(z.referenceLevel)}`, xStart + 3, yRef - 4);
        ctx.globalAlpha = 1;
        labels += 1;
      }
      drawn += 1;
    }
  } else {
    // ---- مسار legacy: منطق MultiZoneChart حرفياً ----
    // صندوق لكل منطقة من أول لمسة إلى آخر لمسة (أو شمعة المسح)، حد الوقف عند
    // مستوى السيولة، ونقاط اللمس على الحافة. المنطقة بلا لمسات كافية تُتخطى
    // كما في شارت الشاشة نفسه.
    const ordered = zones
      .filter(z => filters.showSwept || z.state !== 'swept')
      .sort((a, b) => stateRank(a.state) - stateRank(b.state) || createdAtSec(b) - createdAtSec(a))
      .slice(0, 120);
    for (const z of ordered) {
      const touches = (z.touchPoints ?? []).filter(p => p.time >= visFrom && p.time <= visTo);
      if (touches.length < 2) continue;
      const bullish = z.kind.includes('ssl');
      const rgb = kindRgb(z.kind);
      const confirmed = z.state === 'confirmed';
      const sweptTime = z.state === 'swept' && z.sweptAt ? tsSeconds(z.sweptAt) : null;
      const timeEnd = sweptTime ?? touches[touches.length - 1].time;
      if (timeEnd <= touches[0].time) continue;
      const xStart = coordinate.tx(touches[0].time);
      const xEnd = coordinate.tx(timeEnd);
      if (xStart == null || xEnd == null || xEnd <= xStart) continue;
      const stop = Number.isFinite(z.liquidityLevel) ? z.liquidityLevel : (bullish ? Math.min(...touches.map(p => p.price)) : Math.max(...touches.map(p => p.price)));
      const prices = touches.map(p => p.price);
      const priceLow = bullish ? Math.min(...prices) : Math.min(...prices, stop);
      const priceHigh = bullish ? Math.max(...prices, stop) : Math.max(...prices);
      const yTop = coordinate.py(priceHigh);
      const yBot = coordinate.py(priceLow);
      if (offscreen(yTop, yBot) || yTop == null || yBot == null) continue;
      const alpha = confirmed ? 0.16 : 0.10;
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.fillRect(xStart, yTop, xEnd - xStart, Math.max(yBot - yTop, 1));
      ctx.strokeStyle = `rgba(${rgb},${confirmed ? 0.9 : 0.55})`;
      ctx.lineWidth = confirmed ? 2 : 1;
      ctx.globalAlpha = z.state === 'swept' ? 0.4 : 1;
      ctx.strokeRect(xStart, yTop, xEnd - xStart, Math.max(yBot - yTop, 1));
      // حد الوقف: متقطع عند مستوى السيولة داخل الصندوق
      const yStop = coordinate.py(stop);
      if (yStop != null) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = `rgba(${rgb},0.7)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xStart, yStop);
        ctx.lineTo(xEnd, yStop);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // نقاط اللمس على الحافة
      ctx.fillStyle = `rgba(${rgb},${confirmed ? 0.95 : 0.7})`;
      for (const p of touches) {
        const xp = coordinate.tx(p.time);
        const yp = coordinate.py(p.price);
        if (xp != null && yp != null) ctx.fillRect(xp - 1.5, yp - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
      drawn += 1;
    }
  }

  if (counter?.current) counter.current.textContent = `${drawn}/${total}`;
}

function HistoryChart({ data, height, filters }: { data: LiquidityHistoryResponse; height: number; filters: HistoryFilters }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dataRef = useRef<DrawPayload>({
    candles: [], zones: [], engineKey: data.engineKey, filters, chartHeight: height,
    visFrom: 0, visTo: Number.POSITIVE_INFINITY
  });
  const counterRef = useRef<HTMLSpanElement | null>(null);
  const hasViewedRef = useRef(false);
  const candleRows = useMemo<CandleRow[]>(() => data.candles.map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume
  })), [data]);

  // مفتاح يعيد الرسم عند تغيير الفلاتر (الرسم داخل primitive يحدث مع إعادة رسم الشارت)
  const rowsKey = `${filters.showSwept}|${filters.showTrendlines}|${filters.showBoxes}`;

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
      // نطاق الرؤية الزمني لحظياً لتخطي المناطق خارج النافذة المعروضة
      try {
        const vr = chart.timeScale().getVisibleRange();
        if (vr) {
          dataRef.current.visFrom = Number(vr.from);
          dataRef.current.visTo = Number(vr.to);
        }
      } catch { /* النطاق غير جاهز بعد */ }
      drawZones(context, coordinate, dataRef.current, counterRef);
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
        dataRef.current.chartHeight = containerRef.current.clientHeight;
      }
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
    dataRef.current = {
      candles: candleRows,
      zones: data.zones,
      engineKey: data.engineKey,
      filters,
      chartHeight: dataRef.current.chartHeight || height,
      visFrom: dataRef.current.visFrom,
      visTo: dataRef.current.visTo
    };
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || !candleRows.length) return;
    candleSeries.setData(candleRows.map((c) => ({ ...c, time: Math.floor(c.time) as UTCTimestamp })));
    volumeSeries.setData(candleRows.map((c) => ({
      time: Math.floor(c.time) as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(8,153,129,.3)' : 'rgba(242,54,69,.3)'
    })));
    if (!hasViewedRef.current) {
      const visible = 3 * 1440; // آخر 3 أيام تقريباً — والتمرير إلى الماضي متاح
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candleRows.length - visible),
        to: candleRows.length + 10
      });
      hasViewedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleRows, data, rowsKey]);

  const isV2 = data.engineKey === 'v2';
  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-0)' }}>
      <div ref={containerRef} style={{ height, minHeight: height }} />
      <div className="absolute top-2 right-2 z-10 flex flex-wrap gap-x-2.5 gap-y-0.5 max-w-[80%] rounded-md px-2 py-1 text-[10px]" style={{ background: 'rgba(10,14,22,.8)', color: '#e2e8f0' }}>
        <span><b style={{ color: '#f23645' }}>▬</b> BSL</span>
        <span><b style={{ color: '#089981' }}>▬</b> SSL</span>
        {isV2 && <span><b style={{ color: '#f97316' }}>▬</b> عرض</span>}
        {isV2 && <span><b style={{ color: '#3b82f6' }}>▬</b> طلب</span>}
        <span><b style={{ color: '#94a3b8' }}>┄</b> مستوى السيولة</span>
        <span style={{ opacity: 0.75 }}>شفاف = مسحوبة</span>
      </div>
      <div className="absolute top-2 left-2 z-10 rounded px-2 py-1 text-[10px] font-semibold" style={{ background: 'rgba(10,14,22,.8)', color: '#fff' }}>
        {data.symbol} · 1m · {data.days} يوماً · {data.bars.toLocaleString('en-US')} شمعة · مناطق مرئية <span ref={counterRef}>—</span> / {data.totalZones}
        {data.gaps > 0 && <span style={{ color: '#fbbf24' }}> · فجوات: {data.gaps.toLocaleString('en-US')}</span>}
        {data.zonesCapped && <span style={{ color: '#fbbf24' }}> · مُرسلة {data.zones.length}</span>}
      </div>
      <div className="absolute bottom-1 left-2 z-10 text-[9px]" style={{ color: 'var(--text-3)' }}>
        مصدر البيانات: Binance Spot · {data.engine} · للعرض والتحقق اليدوي فقط
      </div>
    </div>
  );
}

export default function LiquidityHistorySection({ engine, symbol }: { engine: 'legacy' | 'v2'; symbol: string }) {
  // مفتوح افتراضياً: الخادم يُسخّن نتائج العمق الافتراضي عند الإقلاع، والكاش يجعل
  // الفتح شبه فوري — وعند بارد تظهر حالة تجهيز واضحة مع استطلاع تلقائي.
  const [open, setOpen] = useState(true);
  const [days, setDays] = useState(90);
  const [data, setData] = useState<LiquidityHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
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

  const filterChip = (key: keyof HistoryFilters, label: string) => (
    <button
      onClick={() => setFilters(f => ({ ...f, [key]: !f[key] }))}
      className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold"
      style={{
        background: filters[key] ? 'var(--accent-soft)' : 'var(--surface-0)',
        color: filters[key] ? 'var(--accent)' : 'var(--text-3)',
        border: '1px solid var(--border-1)'
      }}
    >
      {filters[key] ? '✓ ' : '✕ '}{label}
    </button>
  );

  return (
    <section className="rounded-xl p-3 sm:p-4 space-y-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-bold" style={{ color: 'var(--text-1)' }}>
            الشارت التاريخي — فريم الدقيقة فقط {symbol ? `· ${symbol}` : ''}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            مناطق المحرك {engine === 'legacy' ? 'الحالي' : 'v2'} مرسومة بمنطق شارت هذه الشاشة نفسه (الألوان بالنوع: BSL أحمر / SSL أخضر{engine === 'v2' ? '، عرض برتقالي / طلب أزرق' : ''}). التمرير إلى الماضي متاح والمناطق مثبتة على أزمنتها. أول حساب لعمق 90 يوماً يستغرق {engine === 'v2' ? 'حتى ساعة' : 'دقائق'} ثم تُخزَّن النتيجة على الخادم.
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
            {[30, 60, 90, 120].map(d => <option key={d} value={d}>{d} يوماً</option>)}
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

      <div className="flex flex-wrap items-center gap-2">
        {filterChip('showSwept', 'المسحوبة')}
        {filterChip('showTrendlines', 'خطوط الاتجاه')}
        {engine === 'v2' && filterChip('showBoxes', 'صناديق العرض/الطلب')}
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-center justify-between gap-2" style={{ background: 'var(--down-soft)', color: 'var(--down)' }}>
          <span>{error}</span>
          <button onClick={() => void load()} className="px-2 py-1 rounded" style={{ background: 'var(--surface-0)', color: 'var(--text-1)' }}>إعادة المحاولة</button>
        </div>
      )}
      {loading && (
        <div className="rounded-lg px-3 py-3 text-[12px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          جارٍ تجهيز الشارت التاريخي: جلب شموع الدقيقة من Binance دفعةً بعد دفعة ثم حساب مناطق المحرك على خيط منفصل{engine === 'v2' ? ' — أول حساب لعمق 90 يوماً لمحرك v2 قد يستغرق حتى ساعة على خادم النشر، ثم تُخزَّن النتيجة ليوم كامل وتُحدَّث في الخلفية' : ' — أول حساب يستغرق دقائق ثم تُخزَّن النتيجة'}. يمكنك ترك الصفحة مفتوحة حتى الاكتمال.
        </div>
      )}

      <div ref={wrapRef} style={fullscreen ? { background: 'var(--surface-0)', padding: 8 } : undefined}>
        {open && data && (
          <>
            <HistoryChart data={data} height={fullscreen ? Math.max(480, window.innerHeight - 140) : 560} filters={filters} />
            <div className="text-[10.5px] px-1 pt-1" style={{ color: 'var(--text-3)' }}>
              آخر شمعة: {lastCandle} · النطاق من {new Date(data.from * 1000).toLocaleDateString('ar')} إلى {new Date(data.to * 1000).toLocaleDateString('ar')}
              {' '}· إجمالي المناطق {data.totalZones}
              {data.cached ? ' · نتيجة مخزنة' : ' · حساب جديد'}
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
