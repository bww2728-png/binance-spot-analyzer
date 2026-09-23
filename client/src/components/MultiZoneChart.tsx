import { memo, useEffect, useRef } from 'react';
import type { LiquidityDetection } from '../lib/types';
import {
  createChart, createSeriesMarkers, CandlestickSeries, LineSeries,
  type UTCTimestamp
} from 'lightweight-charts';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';

/** الشارت المستقل للجولة المخصصة: شموع النافذة كاملة + تراكيب كل المناطق المختارة:
 * دوائر اللمسات (نقاط البناء) بلون النوع، خط الوقف عند مستوى السيولة (وقف الخسائر)
 * — أفقي solid / خط اتجاه dashed — وخط الاتجاه الفعلي وإسقاطه لكل منطقة اتجاه.
 * الرسم التكيفي: عندما تكون المناطق كثيفة (>8) يُخفى التراكيب التحليلية الثقيلة
 * (Premium/المرجع) ليبقى الشارت مقروءاً، وتبقى خطوط الوقف واللمسات والاتجاه دائماً.
 */
const MultiZoneChart = memo(function MultiZoneChart({ candles, zones, height = 420 }: {
  candles: Array<[number, number, number, number, number]>;
  zones: LiquidityDetection[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const adaptive = zones.length > 8;

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

    let markerCount = 0;
    const MARKER_CAP = 2000;

    for (const zone of zones) {
      if (markerCount >= MARKER_CAP) break;
      const bullish = zone.kind.includes('ssl');
      const color = bullish ? '#089981' : '#f23645';
      const trendKind = zone.kind.startsWith('trendline');
      const anchorSec = (() => {
        const v = zone.createdAt || zone.confirmedAt || 0;
        const s = v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
        if (s >= from && s <= to) return s;
        return null;
      })();

      // دوائر اللمسات: نقاط البناء الفعلية (داخل النافذة)
      const touches = (zone.touchPoints ?? [])
        .filter(p => inRange(p.time))
        .map(p => ({
          time: p.time as UTCTimestamp,
          price: p.price,
          position: bullish ? 'atPriceBottom' as const : 'atPriceTop' as const,
          shape: 'circle' as const,
          color,
          size: 1,
          text: ''
        }));
      if (touches.length && markerCount < MARKER_CAP) {
        createSeriesMarkers(series, touches);
        markerCount += touches.length;
      }

      // خط الوقف عند مستوى السيولة — الأذكى والبارز دائماً (نمط الأفقي solid / الاتجاه dashed)
      if (Number.isFinite(zone.liquidityLevel)) {
        series.createPriceLine({
          price: zone.liquidityLevel,
          color,
          lineWidth: 3,
          lineStyle: trendKind ? 2 : 0,
          axisLabelVisible: true,
          title: `وقف ${zone.kind.startsWith('trendline') ? 'اتجاه' : 'أفقي'} ${bullish ? 'SSL' : 'BSL'}`
        });
      }

      // خط الاتجاه الفعلي + إسقاطه المتقطع إلى لحظة الكشف
      const tp = zone.trendline?.points ?? [];
      if (tp.length >= 2) {
        const pts = [...tp]
          .filter(p => inRange(p.time))
          .sort((a, b) => a.time - b.time)
          .map(p => ({ time: p.time as UTCTimestamp, value: p.price }));
        if (pts.length >= 2) {
          const line = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: trendKind ? 2 : 1, lineStyle: trendKind ? 0 : 2 });
          line.setData(pts);
          if (anchorSec !== null) {
            const proj = zone.trendline?.projected;
            if (Number.isFinite(proj) && anchorSec >= pts[pts.length - 1].time) {
              const projLine = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, lineStyle: 2 });
              projLine.setData([{ time: pts[pts.length - 1].time, value: tp[tp.length - 1].price }, { time: anchorSec as UTCTimestamp, value: proj }]);
            }
          }
        }
      }

      // التراكيب التحليلية الثقيلة فقط عند القلة (<9 مناطق) لضمان القراءة
      if (!adaptive) {
        const pr = zone.premium;
        if (pr && Number.isFinite(pr.low) && Number.isFinite(pr.high)) {
          series.createPriceLine({ price: pr.high, color: '#7c3aed', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
          series.createPriceLine({ price: pr.low, color: '#7c3aed', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
        }
        if (Number.isFinite(zone.referenceLevel)) {
          series.createPriceLine({ price: zone.referenceLevel, color: '#64748b', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
        }
        // علامة الاكتشاف عند سعر السيولة على شمعة الكشف
        if (anchorSec !== null && Number.isFinite(zone.liquidityLevel) && markerCount < MARKER_CAP) {
          createSeriesMarkers(series, [{
            time: anchorSec as UTCTimestamp,
            price: zone.liquidityLevel,
            position: bullish ? 'atPriceBottom' as const : 'atPriceTop' as const,
            shape: 'circle' as const,
            color,
            size: 2,
            text: ''
          }]);
          markerCount += 1;
        }
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
  }, [candles, zones, height]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height, minHeight: height }} />
      {!candles.length && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>شغّل جولة أولاً لعرض الشارت</div>
      )}
      {!!candles.length && (
        <div className="absolute top-1 right-1 z-10 pointer-events-none flex flex-wrap justify-end gap-x-2.5 gap-y-0.5 max-w-[75%] text-[9px] leading-tight rounded px-1.5 py-1" style={{ background: 'rgba(10,14,22,.72)', border: '1px solid var(--border-1)', color: '#e2e8f0' }}>
          <span><span style={{ color: '#f23645' }}>═</span> وقف BSL</span>
          <span><span style={{ color: '#089981' }}>═</span> وقف SSL</span>
          <span><span style={{ color: '#f23645' }}>●</span> <span style={{ color: '#089981' }}>●</span> لمسات (نقاط البناء)</span>
          <span><span style={{ color: '#f59e0b' }}>━</span> خط اتجاه + إسقاط</span>
          {!adaptive && <span><span style={{ color: '#7c3aed' }}>– –</span> Premium</span>}
          {!adaptive && <span><span style={{ color: '#64748b' }}>– –</span> المرجع</span>}
        </div>
      )}
    </div>
  );
});

export default MultiZoneChart;
