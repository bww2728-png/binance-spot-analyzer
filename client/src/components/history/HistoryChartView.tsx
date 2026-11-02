import { useCallback, useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp
} from 'lightweight-charts';
import {
  hitTest,
  layoutElements,
  type HistoryAppearance,
  type HistoryElement,
  type HistoryLayout
} from '../../../../shared/historyModel.mjs';
import { CHART_COLORS, HOLLOW_CANDLES } from '../MiniChart';
import { attachZonePrimitive } from '../ZoneBoxesPrimitive';
import { drawHighlight, drawLayout } from './historyCanvas';

export type CandleRow = { time: number; open: number; high: number; low: number; close: number; volume: number };

interface Props {
  /** الشموع المعروضة — مقتطعة عند مؤشر التتبع (لا شمعة مستقبلية) */
  rows: CandleRow[];
  /** مفتاح هوية البيانات (رمز/محرك/عمق/نطاق) — يمنع بقاء شموع رمز سابق */
  dataKey: string;
  /** العناصر المؤهلة بعد الفلاتر (نفس مجموعة لوحة التفاصيل) */
  elements: HistoryElement[];
  style: HistoryAppearance;
  replay: boolean;
  /** السماح بعرض المرجع البديل (بلا زمن تكوّن) في وضع التتبع */
  altInReplay: boolean;
  selectedId: string | null;
  height: number;
  onSelect: (id: string | null) => void;
  onStats: (stats: { drawn: number; culled: number; labelSkips: number }) => void;
}

/**
 * الشارت التاريخي: شموع + طبقة رسم مخصصة (primitive) + طبقة إبراز منفصلة.
 *
 * دقة الإحداثيات: كل التحويلات تمر عبر `timeScale().timeToCoordinate` و
 * `series.priceToCoordinate` الرسميين، ولا توجد إزاحات بصرية تقريبية.
 * لا تُعاد هندسة العناصر في كل إطار: تُحسب مرة واحدة لكل (بيانات/فلاتر/مؤشر)
 * داخل دالة الرسم، وتُخزَّن لإعادة استخدامها في اختبار النقر والإبراز.
 */
export default function HistoryChartView({
  rows, dataKey, elements, style, replay, altInReplay, selectedId, height, onSelect, onStats
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const layoutRef = useRef<HistoryLayout | null>(null);
  const prevRowsRef = useRef<CandleRow[]>([]);
  const prevKeyRef = useRef('');
  const initializedRef = useRef(false);
  const stateRef = useRef({ elements, style, replay, altInReplay, selectedId, rows });
  const onSelectRef = useRef(onSelect);
  const onStatsRef = useRef(onStats);

  stateRef.current = { elements, style, replay, altInReplay, selectedId, rows };
  onSelectRef.current = onSelect;
  onStatsRef.current = onStats;

  /** إعادة رسم طبقة الإبراز فقط — لا تمس بيانات الشارت ولا محاوره */
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const layout = layoutRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const id = stateRef.current.selectedId;
    if (!id || !layout) return;
    const el = stateRef.current.elements.find((e) => e.id === id);
    drawHighlight(ctx, layout, id, el?.color ?? '#e2e8f0');
  }, []);

  // ---- إنشاء الشارت مرة واحدة
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

    const primitive = attachZonePrimitive(candleSeries, 'bottom', (context, coordinate) => {
      const { elements: els, style: st, replay: rp, altInReplay: alt, rows: rs, selectedId: sel } = stateRef.current;
      if (!rs.length) { layoutRef.current = null; return; }
      // النطاق المرئي الحقيقي: اقتصاص العناصر الممتدة من خارجه بدل استبعادها
      const range = chart.timeScale().getVisibleLogicalRange();
      const viewStartIndex = range ? Math.max(0, Math.floor(range.from)) : null;
      const viewEndIndex = range ? Math.min(rs.length - 1, Math.ceil(range.to)) : null;
      const viewStartTime = viewStartIndex != null && rs[viewStartIndex] ? rs[viewStartIndex].time : null;
      const viewEndTime = viewEndIndex != null && rs[viewEndIndex] ? rs[viewEndIndex].time : null;
      const layout = layoutElements({
        elements: els,
        tx: coordinate.tx,
        py: coordinate.py,
        timeAtIndex: (i) => (rs[i] ? rs[i].time : null),
        indexAtTime: (t) => {
          // بحث ثنائي: زمن الشموع مرتب تصاعدياً
          if (t <= rs[0].time) return 0;
          const last = rs.length - 1;
          if (t >= rs[last].time) return last;
          let lo = 0;
          let hi = last;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (rs[mid].time === t) return mid;
            if (rs[mid].time < t) lo = mid + 1;
            else hi = mid - 1;
          }
          return Math.max(0, Math.min(last, lo));
        },
        width: chart.paneSize().width,
        height,
        cursorTime: rs[rs.length - 1].time,
        cursorIndex: rs.length - 1,
        style: st,
        replay: rp,
        altAllowed: alt,
        viewStartTime,
        viewEndTime,
        selectedId: sel
      });
      layoutRef.current = layout;
      drawLayout(context, layout);
      onStatsRef.current({ drawn: layout.drawn, culled: layout.culled, labelSkips: layout.labelSkips });
    });

    const onClick = (param: MouseEventParams) => {
      if (!param.point) { onSelectRef.current(null); return; }
      const id = hitTest(layoutRef.current, { x: param.point.x, y: param.point.y }, 8);
      onSelectRef.current(id);
    };
    chart.subscribeClick(onClick);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const observer = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      drawOverlay();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      chart.unsubscribeClick(onClick);
      try { candleSeries.detachPrimitive(primitive); } catch { /* already detached */ }
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      layoutRef.current = null;
      prevRowsRef.current = [];
      prevKeyRef.current = '';
      initializedRef.current = false;
    };
  }, [drawOverlay]);

  // ---- تغيير الارتفاع (ملء الشاشة) لا يعيد إنشاء الشارت.
  // إعادة الإنشاء كانت تُفرغ الرسم لأن تغذية الشموع في effect آخر لا يعتمد الارتفاع،
  // فتظهر نافذة جديدة بلا بيانات حتى يتحرك المؤشر.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({ height });
    drawOverlay();
  }, [height, drawOverlay]);

  // ---- تغذية البيانات: إلحاق عند التقدم (سريع) وsetData عند القفز/الرجوع/تغيّر الهوية
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || !rows.length) return;

    const prev = prevRowsRef.current;
    const sameIdentity = prevKeyRef.current === dataKey && prev.length > 0;
    const appendCount = rows.length - prev.length;
    // إلحاق فقط إذا كانت البيانات الجديدة امتداداً لنفس البادئة (نفس أول شمعة
    // ونفس آخر شمعة سابقة). المقارنة بـrows[prev.length-1] لا بآخر صف جديد،
    // وإلا فشل الشرط في كل خطوة تتبع وأُعيد setData لـ129 ألف شمعة كل 60ms.
    const canAppend = sameIdentity
      && appendCount > 0
      && appendCount <= 50
      && prev[0].time === rows[0].time
      && prev[prev.length - 1].time === rows[prev.length - 1].time;

    if (canAppend) {
      for (let i = prev.length; i < rows.length; i += 1) {
        const c = rows[i];
        candleSeries.update({ time: Math.floor(c.time) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
        volumeSeries.update({
          time: Math.floor(c.time) as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(8,153,129,.3)' : 'rgba(242,54,69,.3)'
        });
      }
    } else {
      candleSeries.setData(rows.map((c) => ({
        time: Math.floor(c.time) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close
      })));
      volumeSeries.setData(rows.map((c) => ({
        time: Math.floor(c.time) as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(8,153,129,.3)' : 'rgba(242,54,69,.3)'
      })));
    }

    if (!initializedRef.current || !sameIdentity) {
      const visible = 3 * 1440; // آخر 3 أيام تقريباً — والتمرير إلى الماضي متاح
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, rows.length - visible),
        to: rows.length + 10
      });
      initializedRef.current = true;
    } else if (replay && (canAppend || rows.length < prev.length)) {
      // في وضع التتبع يتبع العرض المؤشر: عند التقدم خطوة أو القفز للخلف
      chart.timeScale().scrollToRealTime();
    }
    prevRowsRef.current = rows;
    prevKeyRef.current = dataKey;
  }, [rows, dataKey, replay]);

  // ---- إعادة الرسم عند تغيّر الفلاتر/التحديد: نفس النطاق المرئي بلا قفز
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    drawOverlay();
  }, [elements, style, selectedId, replay, altInReplay, drawOverlay]);

  // ---- مؤشر اليد عند المرور على عنصر قابل للنقر
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const id = hitTest(layoutRef.current, { x: e.clientX - rect.left, y: e.clientY - rect.top }, 8);
    e.currentTarget.style.cursor = id ? 'pointer' : 'default';
  };

  return (
    <div className="relative" style={{ height }} onPointerMove={onPointerMove}>
      <div ref={containerRef} style={{ height, minHeight: height }} />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
