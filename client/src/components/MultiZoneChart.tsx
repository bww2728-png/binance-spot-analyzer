import { memo, useEffect, useRef } from 'react';
import type { LiquidityDetection } from '../lib/types';
import {
  createChart, CandlestickSeries, LineSeries,
  type UTCTimestamp
} from 'lightweight-charts';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';
import { attachZonePrimitive, type ZoneBox } from './ZoneBoxesPrimitive';

/** الشارت المستقل للجولة المخصصة — الرسم الاحترافي القياسي (TradingView/SMC):
 * كل منطقة = مستطيل مظلل من أول لمسة حتى آخر لمسة/المسح، حدّ الوقف ضلعه المواجه،
 * نقاط اللمس دوائر على الحافة، مقطع خط الاتجاه يربط نقاطه فقط (بلا إسقاط لا نهائي).
 * Premium/المرجع غير مرسومين هنا (في تفاصيل المنطقة). سعر الوقف يظهر على محور السعر
 * عبر علامة ملونة لأعلى N ثقة (بلا خطوط ممتدة — عبر نقطة سلسلة مخفية الخط).
 */
const MultiZoneChart = memo(function MultiZoneChart({ candles, zones, height = 420, showStopPrices = true, stopPriceTop = 12 }: {
  candles: Array<[number, number, number, number, number]>;
  zones: LiquidityDetection[];
  height?: number;
  showStopPrices?: boolean;
  stopPriceTop?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !candles.length) return;
    const chart = createChart(el, {
      height,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 10 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, vertLine: { color: CHART_COLORS.crosshair, style: 3, labelBackgroundColor: '#334155' }, horzLine: { color: CHART_COLORS.crosshair, style: 3, labelBackgroundColor: '#334155' } }
    });
    const series = chart.addSeries(CandlestickSeries, { ...HOLLOW_CANDLES });
    series.setData(candles.map(c => ({
      time: c[0] as UTCTimestamp,
      open: c[1], high: c[2], low: c[3], close: c[4]
    })));

    const from = candles[0][0];
    const to = candles[candles.length - 1][0];
    const inRange = (t: number) => t >= from && t <= to;

    // بنية الصناديق: الامتداد الزمني من أول لمسة إلى آخر لمسة، والمسحوبة حتى شمعة مسحها
    const boxes: ZoneBox[] = [];
    const DOTS_CAP = 3000;
    let dots = 0;
    for (const zone of zones) {
      const touches = (zone.touchPoints ?? []).filter(p => inRange(p.time));
      if (touches.length < 2) continue;
      const bullish = zone.kind.includes('ssl');
      const rgb = bullish ? '8,153,129' : '242,54,69';
      const confirmed = zone.state === 'confirmed';
      const alpha = confirmed ? 0.16 : 0.10;
      const prices = touches.map(p => p.price);
      const sweptTime = zone.state === 'swept' && zone.sweptAt ? (() => { const s = zone.sweptAt > 1e12 ? Math.floor(zone.sweptAt / 1000) : Math.floor(zone.sweptAt); return inRange(s) ? s : null; })() : null;
      const timeEnd = sweptTime ?? touches[touches.length - 1].time;
      if (timeEnd <= touches[0].time) continue;
      // حد الوقف: مستوى السيولة إن توفر وإلا أقصى/أدنى لمسة
      const stop = Number.isFinite(zone.liquidityLevel) ? (zone.liquidityLevel as number) : (bullish ? Math.min(...prices) : Math.max(...prices));
      const priceLow = bullish ? Math.min(...prices) : Math.min(...prices, stop);
      const priceHigh = bullish ? Math.max(...prices, stop) : Math.max(...prices);
      const touchDots = [];
      for (const p of touches) {
        if (dots >= DOTS_CAP) break;
        touchDots.push({ time: p.time, price: p.price });
        dots++;
      }
      const tl = zone.kind.startsWith('trendline') ? [...(zone.trendline?.points ?? [])].filter(p => inRange(p.time)).sort((a, b) => a.time - b.time).map(p => ({ time: p.time, price: p.price })) : undefined;
      boxes.push({
        timeStart: touches[0].time,
        timeEnd,
        priceLow,
        priceHigh,
        stopPrice: stop,
        fill: `rgba(${rgb},${alpha})`,
        edge: `rgba(${rgb},${confirmed ? 0.9 : 0.55})`,
        edgeWidth: confirmed ? 2 : 1,
        touches: touchDots,
        trendline: tl && tl.length >= 2 ? tl : undefined
      });
    }

    // الطبقة السفلية: تظليل الصناديق خلف الشموع
    attachZonePrimitive(series, 'bottom', (ctx, conv) => {
      for (const b of boxes) {
        const x1 = conv.tx(b.timeStart);
        const x2 = conv.tx(b.timeEnd);
        const y1 = conv.py(b.priceHigh);
        const y2 = conv.py(b.priceLow);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        ctx.fillStyle = b.fill;
        ctx.fillRect(x1, y1, Math.max(2, x2 - x1), Math.max(1, y2 - y1));
      }
    });

    // الطبقة العلوية: حافة الوقف + نقاط اللمس + مقاطع خط الاتجاه
    attachZonePrimitive(series, 'top', (ctx, conv) => {
      ctx.lineJoin = 'round';
      for (const b of boxes) {
        const x1 = conv.tx(b.timeStart);
        const x2 = conv.tx(b.timeEnd);
        const yStop = conv.py(b.stopPrice);
        if (x1 == null || x2 == null || yStop == null) continue;
        // حد الوقف على ضلع الصندوق المواجه
        ctx.strokeStyle = b.edge;
        ctx.lineWidth = b.edgeWidth;
        ctx.beginPath();
        ctx.moveTo(x1, yStop);
        ctx.lineTo(x2, yStop);
        ctx.stroke();
        // نقاط اللمس
        ctx.fillStyle = b.edge;
        for (const p of b.touches) {
          const px = conv.tx(p.time);
          const py = conv.py(p.price);
          if (px == null || py == null) continue;
          ctx.beginPath();
          ctx.arc(px, py, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        // مقطع خط الاتجاه: يربط نقاطه فقط — منتهٍ
        if (b.trendline) {
          ctx.strokeStyle = 'rgba(245,158,11,.85)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          let started = false;
          for (const p of b.trendline) {
            const px = conv.tx(p.time);
            const py = conv.py(p.price);
            if (px == null || py == null) continue;
            if (!started) { ctx.moveTo(px, py); started = true; }
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
    });

    // أسعار الوقف على محور السعر: نقطة سلسلة مخفية الخط (لا خط ممتد) لأعلى N ثقة
    if (showStopPrices) {
      const top = [...zones]
        .filter(z => Number.isFinite(z.liquidityLevel))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, stopPriceTop);
      for (const z of top) {
        const bullish = z.kind.includes('ssl');
        const marker = chart.addSeries(LineSeries, {
          color: bullish ? '#089981' : '#f23645',
          lineWidth: 1,
          lineVisible: false,
          lastValueVisible: true,
          priceLineVisible: false
        });
        marker.setData([{ time: to as UTCTimestamp, value: z.liquidityLevel as number }]);
      }
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles, zones, height, showStopPrices, stopPriceTop]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height, minHeight: height }} />
      {!candles.length && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>شغّل جولة أولاً لعرض الشارت</div>
      )}
      {!!candles.length && (
        <div className="absolute top-1 right-1 z-10 pointer-events-none flex flex-wrap justify-end gap-x-2.5 gap-y-0.5 max-w-[75%] text-[9px] leading-tight rounded px-1.5 py-1" style={{ background: 'rgba(10,14,22,.72)', border: '1px solid var(--border-1)', color: '#e2e8f0' }}>
          <span><span style={{ color: '#f23645' }}>▬</span> BSL</span>
          <span><span style={{ color: '#089981' }}>▬</span> SSL</span>
          <span>● نقطة لمس</span>
          <span><span style={{ color: '#f59e0b' }}>—</span> مقطع اتجاه</span>
        </div>
      )}
    </div>
  );
});

export default MultiZoneChart;
