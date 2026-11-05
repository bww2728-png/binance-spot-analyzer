import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts';
import type { ManualCandle, ManualDrawing, ManualPoint, ManualDrawingType } from '../lib/manualLiquidity';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';

type ChartPoint = { x: number; y: number };
type DraftShape = { type: 'line' | 'break' | 'rectangle'; start: ChartPoint; cursor: ChartPoint };
type HoverCandle = ManualCandle | null;

type Props = {
  candles: ManualCandle[];
  drawings: ManualDrawing[];
  activeTool: ManualDrawingType | 'select';
  activeLiquidity: 'BSL' | 'SSL';
  activeBreakType: 'wick' | 'close';
  activeColor: string;
  onCreate: (drawing: ManualDrawing) => void;
  onSelect: (drawingId: string | null) => void;
  onMoveAnchor: (drawingId: string, anchorIndex: number, point: ManualPoint) => void;
  onMoveEnd: (drawingId: string) => void;
  onHoverCandle: (candle: ManualCandle | null) => void;
  timeframeSeconds: number;
};

const colorFor = (drawing: ManualDrawing) => drawing.color || (drawing.liquidityType === 'SSL' ? '#089981' : drawing.liquidityType === 'BSL' ? '#f23645' : '#94a3b8');
const formatTime = (time?: number) => time ? new Date(time * 1000).toLocaleString('ar') : '—';

function drawingLabel(drawing: ManualDrawing) {
  if (drawing.label) return drawing.label;
  if (drawing.type === 'arrow') return drawing.liquidityType ?? 'سيولة';
  if (drawing.type === 'break') return drawing.breakType === 'close' ? 'كسر إغلاق' : 'كسر ذيل';
  return drawing.type === 'line' ? 'خط يدوي' : drawing.type === 'rectangle' ? 'منطقة' : drawing.type === 'circle' ? 'نقطة' : 'ملاحظة';
}

export default function ManualLiquidityChart({ candles, drawings, activeTool, activeLiquidity, activeBreakType, activeColor, onCreate, onSelect, onMoveAnchor, onMoveEnd, onHoverCandle, timeframeSeconds }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const propsRef = useRef({ activeTool, activeLiquidity, activeBreakType, activeColor, onCreate, onSelect, onMoveAnchor, onMoveEnd, onHoverCandle });
  const candlesRef = useRef(candles);
  const chartSizeRef = useRef({ width: 0, height: 0 });
  const clickPointsRef = useRef<ManualPoint[]>([]);
  const draftRef = useRef<DraftShape | null>(null);
  const dragRef = useRef<{ drawingId: string; anchorIndex: number; pointerId: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawingDraft, setDrawingDraft] = useState<DraftShape | null>(null);
  const [hover, setHover] = useState<{ candle: HoverCandle; price: number | null }>({ candle: null, price: null });
  const [, redraw] = useState(0);

  propsRef.current = { activeTool, activeLiquidity, activeBreakType, activeColor, onCreate, onSelect, onMoveAnchor, onMoveEnd, onHoverCandle };
  candlesRef.current = candles;

  const updateDrawingDraft = useCallback((draft: DraftShape | null) => {
    draftRef.current = draft;
    setDrawingDraft(draft);
  }, []);

  useEffect(() => {
    clickPointsRef.current = [];
    updateDrawingDraft(null);
  }, [activeTool, updateDrawingDraft]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 11 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderVisible: false, autoScale: true, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 8 },
      crosshair: { mode: 0, vertLine: { color: '#64748b', style: 3 }, horzLine: { color: '#64748b', style: 3 } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true, axisDoubleClickReset: true }
    });
    const candlesSeries = chart.addSeries(CandlestickSeries, { ...HOLLOW_CANDLES });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candleSeriesRef.current = candlesSeries;
    volumeSeriesRef.current = volumeSeries;
    chartSizeRef.current = { width: host.clientWidth, height: host.clientHeight };

    const observer = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      chartSizeRef.current = { width, height };
      chart.applyOptions({ width, height });
      redraw((value) => value + 1);
    });
    observer.observe(host);

    const crosshair = (param: Parameters<Parameters<IChartApi['subscribeCrosshairMove']>[0]>[0]) => {
      const point = param.point;
      const time = param.time == null ? null : Number(param.time);
      const row = time == null ? null : candlesRef.current.find((candle) => candle.time === time) ?? null;
      const price = point ? candlesSeries.coordinateToPrice(point.y) : null;
      propsRef.current.onHoverCandle(row);
      setHover({ candle: row, price: price == null ? null : Number(price) });
      const draft = draftRef.current;
      if (draft && point) updateDrawingDraft({ ...draft, cursor: { x: point.x, y: point.y } });
    };
    chart.subscribeCrosshairMove(crosshair);

    const handleClick = (param: Parameters<Parameters<IChartApi['subscribeClick']>[0]>[0]) => {
      const state = propsRef.current;
      if (!param.point || !state.activeTool || state.activeTool === 'select') return;
      const time = chart.timeScale().coordinateToTime(param.point.x);
      const price = candlesSeries.coordinateToPrice(param.point.y);
      if (time == null || price == null || !Number.isFinite(Number(price))) return;
      const point = { time: Math.floor(Number(time)), price: Number(price) };
      const needsTwo = ['line', 'break', 'rectangle'].includes(state.activeTool);
      clickPointsRef.current = [...clickPointsRef.current, point];
      if (needsTwo && clickPointsRef.current.length < 2) {
        const draftPoint = { x: param.point.x, y: param.point.y };
        updateDrawingDraft({ type: state.activeTool as DraftShape['type'], start: draftPoint, cursor: draftPoint });
        return;
      }
      const anchors = clickPointsRef.current.slice(0, needsTwo ? 2 : 1);
      clickPointsRef.current = [];
      updateDrawingDraft(null);
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      const color = state.activeTool === 'arrow' ? (state.activeLiquidity === 'BSL' ? '#f23645' : '#089981')
        : state.activeTool === 'break' ? (state.activeBreakType === 'wick' ? '#f59e0b' : '#2563eb')
          : state.activeColor;
      state.onCreate({
        id,
        type: state.activeTool,
        anchors,
        color,
        label: state.activeTool === 'arrow' ? state.activeLiquidity : state.activeTool === 'break' ? (state.activeBreakType === 'wick' ? 'كسر ذيل' : 'كسر إغلاق') : '',
        note: '',
        liquidityType: state.activeTool === 'arrow' ? state.activeLiquidity : undefined,
        breakType: state.activeTool === 'break' ? state.activeBreakType : undefined,
        created_at: Date.now()
      });
    };
    chart.subscribeClick(handleClick);

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(crosshair);
      chart.unsubscribeClick(handleClick);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !series || !volumeSeries) return;
    const wasEmpty = series.data().length === 0;
    const previousFirstTime = Number(series.data()[0]?.time ?? 0);
    const previousRange = chart.timeScale().getVisibleLogicalRange();
    const prependedBars = previousFirstTime > 0 ? candles.filter((candle) => candle.time < previousFirstTime).length : 0;
    series.setData(candles.map((candle) => ({ time: Math.floor(candle.time) as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close })));
    volumeSeries.setData(candles.map((candle) => ({
      time: Math.floor(candle.time) as UTCTimestamp,
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(8,153,129,.3)' : 'rgba(242,54,69,.3)'
    })));
    if (wasEmpty && candles.length) {
      const visible = Math.min(240, candles.length);
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - visible), to: candles.length + 8 });
    } else if (prependedBars > 0 && previousRange) {
      chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + prependedBars, to: previousRange.to + prependedBars });
    }
    redraw((value) => value + 1);
  }, [candles]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;
    const update = () => redraw((value) => value + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(update);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(update);
  }, []);

  const xFor = (time: number) => chartRef.current?.timeScale().timeToCoordinate(time as UTCTimestamp) ?? null;
  const yFor = (price: number) => candleSeriesRef.current?.priceToCoordinate(price) ?? null;
  const pointFor = (point: ManualPoint): ChartPoint | null => {
    const x = xFor(point.time);
    const y = yFor(point.price);
    return x == null || y == null ? null : { x, y };
  };
  const plotWidth = Math.max(0, chartSizeRef.current.width - 72);
  const plotHeight = Math.max(0, chartSizeRef.current.height - 30);

  const beginAnchorDrag = (event: React.PointerEvent<SVGCircleElement>, drawingId: string, anchorIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { drawingId, anchorIndex, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(drawingId);
    propsRef.current.onSelect(drawingId);
  };
  const moveAnchorDrag = (event: React.PointerEvent<SVGCircleElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const host = hostRef.current;
    if (!chart || !series || !host) return;
    const bounds = host.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const time = chart.timeScale().coordinateToTime(localX);
    const price = series.coordinateToPrice(localY);
    if (time == null || price == null || !Number.isFinite(Number(price))) return;
    propsRef.current.onMoveAnchor(drag.drawingId, drag.anchorIndex, { time: Math.floor(Number(time)), price: Number(price) });
  };
  const endAnchorDrag = (event: React.PointerEvent<SVGCircleElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      const drawingId = dragRef.current.drawingId;
      dragRef.current = null;
      propsRef.current.onMoveEnd(drawingId);
    }
  };

  const renderDrawing = (drawing: ManualDrawing) => {
    const points = drawing.anchors.map(pointFor);
    if (points.some((point) => point == null)) return null;
    const anchors = points as ChartPoint[];
    const color = colorFor(drawing);
    const selected = selectedId === drawing.id;
    const interactive = activeTool === 'select';
    const title = `${drawingLabel(drawing)}${drawing.note ? ` · ${drawing.note}` : ''}`;
    const select = (event: React.PointerEvent<SVGElement>) => {
      event.stopPropagation();
      setSelectedId(drawing.id);
      onSelect(drawing.id);
    };
    let shape: React.ReactNode = null;
    if (drawing.type === 'line' || drawing.type === 'break') {
      const a = anchors[0];
      const b = anchors[1];
      shape = <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={drawing.type === 'break' ? 2 : 2.5} strokeDasharray={drawing.type === 'break' ? '5 4' : undefined} pointerEvents={interactive ? 'stroke' : 'none'} onPointerDown={interactive ? select : undefined} />;
    } else if (drawing.type === 'rectangle') {
      const a = anchors[0];
      const b = anchors[1];
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      shape = <rect x={x} y={y} width={Math.max(2, Math.abs(a.x - b.x))} height={Math.max(2, Math.abs(a.y - b.y))} fill={color} fillOpacity={drawing.fillOpacity ?? 0.18} stroke={color} strokeWidth={2} pointerEvents={interactive ? 'all' : 'none'} onPointerDown={interactive ? select : undefined} />;
    } else if (drawing.type === 'circle') {
      const p = anchors[0];
      const radius = Math.max(6, xFor(drawing.anchors[0].time + (drawing.radiusBars ?? 4) * timeframeSeconds) != null ? Math.abs((xFor(drawing.anchors[0].time + (drawing.radiusBars ?? 4) * timeframeSeconds) ?? p.x) - p.x) / 2 : 8);
      shape = <circle cx={p.x} cy={p.y} r={radius} fill="none" stroke={color} strokeWidth={2.5} pointerEvents={interactive ? 'stroke' : 'none'} onPointerDown={interactive ? select : undefined} />;
    } else if (drawing.type === 'arrow') {
      const p = anchors[0];
      const up = drawing.liquidityType === 'BSL';
      const tipY = p.y;
      const baseY = up ? p.y + 38 : p.y - 38;
      const label = drawingLabel(drawing);
      shape = <g pointerEvents={interactive ? 'all' : 'none'} onPointerDown={interactive ? select : undefined}>
        <line x1={p.x} y1={baseY} x2={p.x} y2={tipY} stroke={color} strokeWidth={2.5} />
        <path d={up ? `M ${p.x - 7} ${tipY + 11} L ${p.x} ${tipY} L ${p.x + 7} ${tipY + 11}` : `M ${p.x - 7} ${tipY - 11} L ${p.x} ${tipY} L ${p.x + 7} ${tipY - 11}`} fill="none" stroke={color} strokeWidth={2.5} />
        <text x={p.x + 7} y={baseY} fill={color} fontSize="11" fontWeight="bold">{label}</text>
      </g>;
    } else if (drawing.type === 'text') {
      const p = anchors[0];
      shape = <text x={p.x + 5} y={p.y - 6} fill={color} stroke="#0b1220" strokeWidth="3" paintOrder="stroke" fontSize="13" pointerEvents={interactive ? 'all' : 'none'} onPointerDown={interactive ? select : undefined}>{drawing.label || drawing.note}</text>;
    }
    return <g key={drawing.id}>
      <title>{title}</title>
      {shape}
      {selected && anchors.map((p, index) => <circle key={`${drawing.id}-${index}`} cx={p.x} cy={p.y} r="5" fill="#fff" stroke={color} strokeWidth="2" className="manual-drawing-handle" onPointerDown={(event) => beginAnchorDrag(event, drawing.id, index)} onPointerMove={moveAnchorDrag} onPointerUp={endAnchorDrag} onPointerCancel={endAnchorDrag} />)}
    </g>;
  };
  const draftColor = drawingDraft?.type === 'break' ? (activeBreakType === 'wick' ? '#f59e0b' : '#2563eb') : activeColor;

  return <div className="relative h-[520px] min-h-[420px] w-full overflow-hidden rounded-xl" style={{ background: 'var(--surface-0)' }}>
    <div ref={hostRef} className="absolute inset-0" />
    <svg className="manual-chart-overlay" width="100%" height="100%" viewBox={`0 0 ${chartSizeRef.current.width} ${chartSizeRef.current.height}`} style={{ pointerEvents: 'none', zIndex: 2 }}>
      <defs><clipPath id="manual-chart-clip"><rect x="0" y="0" width={plotWidth} height={plotHeight} /></clipPath></defs>
      <g clipPath="url(#manual-chart-clip)" style={{ pointerEvents: 'none' }}>
        {drawings.map(renderDrawing)}
        {drawingDraft && <>
          {drawingDraft.type === 'rectangle'
            ? <rect x={Math.min(drawingDraft.start.x, drawingDraft.cursor.x)} y={Math.min(drawingDraft.start.y, drawingDraft.cursor.y)} width={Math.max(2, Math.abs(drawingDraft.start.x - drawingDraft.cursor.x))} height={Math.max(2, Math.abs(drawingDraft.start.y - drawingDraft.cursor.y))} fill={draftColor} fillOpacity={0.12} stroke={draftColor} strokeWidth={2} strokeDasharray="5 4" />
            : <line x1={drawingDraft.start.x} y1={drawingDraft.start.y} x2={drawingDraft.cursor.x} y2={drawingDraft.cursor.y} stroke={draftColor} strokeWidth={2.5} strokeDasharray={drawingDraft.type === 'break' ? '5 4' : undefined} />}
          <circle cx={drawingDraft.start.x} cy={drawingDraft.start.y} r={4} fill={draftColor} stroke="#fff" strokeWidth={1.5} />
        </>}
      </g>
      {selectedId && <g style={{ pointerEvents: 'all' }}>{drawings.filter((drawing) => drawing.id === selectedId).map(renderDrawing)}</g>}
    </svg>
    <div className="absolute bottom-8 left-2 z-10 rounded bg-slate-950/80 px-2 py-1 text-[10px] text-slate-100" dir="ltr">
      {hover.candle ? `${formatTime(hover.candle.time)} · O ${hover.candle.open} H ${hover.candle.high} L ${hover.candle.low} C ${hover.candle.close} · ${hover.candle.complete ? 'مغلقة' : 'جارية'}` : 'حرّك المؤشر لعرض الشمعة والسعر'}
      {hover.price != null && ` · ${hover.price.toPrecision(8)}`}
    </div>
    <div className="absolute top-2 right-2 z-10 rounded bg-slate-950/80 px-2 py-1 text-[10px] text-slate-100" dir="rtl">
      {drawingDraft ? 'تم تحديد النقطة الأولى — حرّك المؤشر ثم انقر لتثبيت الطرف الثاني' : activeTool === 'select' ? 'تحديد/تحريك' : `أداة الرسم: ${activeTool} · انقر الشارت${['line', 'break', 'rectangle'].includes(activeTool) ? ' مرتين لتحديد الطرفين' : ''}`}
    </div>
  </div>;
}
