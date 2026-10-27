import { useEffect, useRef } from 'react';
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
import type { LiquidityWorkbenchZone } from '../lib/liquidityWorkbench';

type WorkbenchCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type ChartData = { candles: WorkbenchCandle[]; zones: LiquidityWorkbenchZone[]; pointsVisible: boolean };
type Coordinate = { tx: (time: number) => number | null; py: (price: number) => number | null };
type DrawPoint = { type: string; time?: number; index?: number; price?: number; low?: number; high?: number };

const timestampSeconds = (value: number | null | undefined) => {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  return time > 1e12 ? Math.floor(time / 1000) : Math.floor(time);
};

function drawZones(ctx: CanvasRenderingContext2D, coordinate: Coordinate, data: ChartData) {
  if (!data.candles.length) return;
  const first = data.candles[0].time;
  const last = data.candles[data.candles.length - 1].time;
  for (const zone of data.zones) {
    const reference = Number(zone.referenceLevel);
    const liquidity = Number(zone.liquidityLevel);
    const boxHigh = Number(zone.zoneBox?.high);
    const boxLow = Number(zone.zoneBox?.low);
    const high = Number.isFinite(boxHigh) ? boxHigh : Math.max(reference, liquidity);
    const low = Number.isFinite(boxLow) ? boxLow : Math.min(reference, liquidity);
    if (![high, low].every(Number.isFinite) || high <= 0 || low <= 0) continue;
    const detected = timestampSeconds(zone.createdAt) ?? first;
    const startTime = Math.min(last, Math.max(first, detected));
    const xStart = coordinate.tx(startTime);
    const xEnd = coordinate.tx(last);
    const yHigh = coordinate.py(high);
    const yLow = coordinate.py(low);
    if (xStart == null || xEnd == null || yHigh == null || yLow == null) continue;
    const isV2 = zone.engine === 'liquidity-engine-v2';
    const up = zone.direction === 'up' || zone.kind.endsWith('ssl') || zone.kind === 'demand';
    const color = isV2 ? (up ? '37,99,235' : '217,119,6') : (up ? '8,153,129' : '242,54,69');
    ctx.fillStyle = `rgba(${color},${zone.state === 'confirmed' ? 0.16 : 0.08})`;
    ctx.strokeStyle = `rgba(${color},${zone.state === 'confirmed' ? 0.82 : 0.5})`;
    ctx.lineWidth = zone.state === 'confirmed' ? 1.5 : 1;
    ctx.fillRect(xStart, yHigh, Math.max(2, xEnd - xStart), Math.max(1, yLow - yHigh));
    ctx.strokeRect(xStart, yHigh, Math.max(2, xEnd - xStart), Math.max(1, yLow - yHigh));
    if (Number.isFinite(reference)) {
      const yReference = coordinate.py(reference);
      if (yReference != null) {
        ctx.setLineDash(isV2 ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(xStart, yReference);
        ctx.lineTo(xEnd, yReference);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

function drawPoints(ctx: CanvasRenderingContext2D, coordinate: Coordinate, data: ChartData) {
  if (!data.pointsVisible || !data.candles.length) return;
  const candlesByIndex = data.candles;
  for (const zone of data.zones) {
    const points: DrawPoint[] = [
      ...(zone.touchPoints ?? []).map((point) => ({ type: zone.kind.startsWith('trendline_') ? 'trendline_anchor' : zone.kind === 'supply' || zone.kind === 'demand' ? 'origin_candle' : 'liquidity_touch', time: point.time, index: point.index, price: point.price })),
      ...(zone.trendline?.points ?? []).map((point) => ({ type: 'trendline_anchor', time: point.time, index: point.index, price: point.price })),
      ...(zone.fvgs ?? []).map((point) => ({ type: 'fvg', index: point.index, price: (Number(point.top) + Number(point.bottom)) / 2, low: point.bottom, high: point.top })),
      ...(zone.structureEvents ?? []).map((point) => ({ type: `structure_${point.type}`, time: point.time, index: point.index, price: point.price ?? point.brokenLevel }))
    ];
    const color = zone.engine === 'liquidity-engine-v2' ? '#2563eb' : '#089981';
    for (const point of points) {
      const sourceTime = timestampSeconds(point.time) ?? candlesByIndex[Number(point.index)]?.time;
      if (sourceTime == null || point.price == null || !Number.isFinite(Number(point.price))) continue;
      const x = coordinate.tx(sourceTime);
      const y = coordinate.py(Number(point.price));
      if (x == null || y == null) continue;
      if (point.type === 'fvg' && Number.isFinite(Number(point.high)) && Number.isFinite(Number(point.low))) {
        const yHigh = coordinate.py(Number(point.high));
        const yLow = coordinate.py(Number(point.low));
        if (yHigh == null || yLow == null) continue;
        ctx.fillStyle = zone.engine === 'liquidity-engine-v2' ? 'rgba(217,119,6,.15)' : 'rgba(8,153,129,.12)';
        ctx.strokeStyle = zone.engine === 'liquidity-engine-v2' ? 'rgba(217,119,6,.75)' : 'rgba(8,153,129,.65)';
        ctx.fillRect(x - 3, yHigh, 6, Math.max(2, yLow - yHigh));
        ctx.strokeRect(x - 3, yHigh, 6, Math.max(2, yLow - yHigh));
      } else if (point.type.startsWith('structure_')) {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x - 4, y + 3);
        ctx.lineTo(x + 4, y + 3);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, point.type === 'origin_candle' ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

export default function LiquidityWorkbenchChart({ candles, zones, dataSource, height = 460, pointsVisible = false }: {
  candles: WorkbenchCandle[];
  zones: LiquidityWorkbenchZone[];
  dataSource: string;
  height?: number;
  pointsVisible?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const dataRef = useRef<ChartData>({ candles: [], zones: [], pointsVisible: false });
  const hasFittedRef = useRef(false);
  const isSynthetic = /synthetic|fixture|mock|test/i.test(dataSource);
  const sourceLabel = isSynthetic
    ? 'بيانات اصطناعية للاختبار — ليست سوقًا حيًا'
    : dataSource === 'binance-spot'
      ? 'مصدر البيانات: Binance Spot'
      : `مصدر البيانات: ${dataSource || 'غير محدد'}`;

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
      drawZones(context, coordinate, dataRef.current);
      drawPoints(context, coordinate, dataRef.current);
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    const observer = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      hasFittedRef.current = false;
    };
  }, [height]);

  useEffect(() => {
    dataRef.current = { candles, zones, pointsVisible };
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;
    candleSeries.setData(candles.map((candle) => ({ ...candle, time: Math.floor(candle.time) as UTCTimestamp })));
    volumeSeries.setData(candles.map((candle) => ({
      time: Math.floor(candle.time) as UTCTimestamp,
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(8,153,129,.35)' : 'rgba(242,54,69,.35)'
    })));
    if (candles.length && !hasFittedRef.current) {
      chart.timeScale().fitContent();
      hasFittedRef.current = true;
    }
  }, [candles, zones, pointsVisible]);

  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-0)' }}>
      <div ref={containerRef} style={{ height, minHeight: height }} />
      {!candles.length && (
        <div className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: 'var(--text-3)' }}>
          بانتظار استعادة بيانات الشموع من الخادم
        </div>
      )}
      <div className="absolute top-2 right-2 z-10 flex flex-wrap gap-2 rounded-md px-2 py-1 text-[10px]" style={{ background: 'rgba(10,14,22,.8)', color: '#e2e8f0' }}>
        <span><b style={{ color: '#089981' }}>▬</b> المحرك الحالي</span>
        <span><b style={{ color: '#2563eb' }}>▬</b> v2</span>
        <span><b style={{ color: '#94a3b8' }}>┄</b> مستوى المرجع</span>
        {pointsVisible && <span><b style={{ color: '#f59e0b' }}>▲</b> بنية · <b style={{ color: '#089981' }}>●</b> نقاط · <b style={{ color: '#d97706' }}>▧</b> فجوات</span>}
      </div>
      <div className="absolute top-2 left-2 z-10 rounded px-2 py-1 text-[10px] font-semibold" style={{ background: isSynthetic ? 'rgba(180,83,9,.92)' : 'rgba(10,14,22,.8)', color: '#fff' }}>{sourceLabel}</div>
      <div className="absolute bottom-1 left-2 z-10 text-[9px]" style={{ color: 'var(--text-3)' }}>{isSynthetic ? 'معاينة ببيانات اختبار اصطناعية · لا تمثل أسعار السوق' : `${sourceLabel} · للعرض والتحقق اليدوي فقط`}</div>
    </div>
  );
}
