import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { fetchKlines } from '../lib/binance';
import type { Candle, LiquidityDetection } from '../lib/types';
import {
  createChart, createSeriesMarkers, CandlestickSeries, LineSeries,
  type IChartApi, type ISeriesApi, type UTCTimestamp
} from 'lightweight-charts';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close
});

const WINDOW = 90;

/** حجم الفريم بالثواني — لتنقية نافذة العرض إلى النطاق المطلوب بالضبط */
const tfSeconds = (tf: string) => {
  const n = parseInt(tf, 10) || 1;
  const u = tf.replace(/[0-9]/g, '');
  return n * ({ m: 60, h: 3600, d: 86400, w: 604800 }[u] ?? 3600);
};

/** لحظة الاكتشاف بالثواني (تقبل صيغتي ثوانٍ/ملي ثانية) */
const anchorSec = (z: LiquidityDetection) => {
  const v = Math.max(z.confirmedAt || 0, z.createdAt || 0, z.detectedAt || 0);
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
};

/** شارت شموع تفاعلي حقيقي (وليس صورة) — بنفس مكوّن عمود الشارت في لوحة التحليل:
 * lightweight-charts + شموع جوفاء بخلفية بيضاء — بنافذة الزمن الحقيقي للتحديد
 * (عند الكشف: تنتهي عند لحظة الاكتشاف / بعد الكشف: من لحظة الاكتشاف حتى الآن حية)
 * + علامة دائرة عند مكان سعر السيولة على شمعة الاكتشاف
 */
const ZoneChart = memo(function ZoneChart({ zone, phase, height = 360 }: { zone: LiquidityDetection; phase: 'at' | 'after'; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const subscribeKline = useStore(s => s.subscribeKline);

  const bullish = zone.kind.includes('ssl');
  const zoneColor = bullish ? '#089981' : '#f23645';

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 10 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, vertLine: { color: CHART_COLORS.crosshair, style: 3, labelBackgroundColor: '#334155' }, horzLine: { color: CHART_COLORS.crosshair, style: 3, labelBackgroundColor: '#334155' } }
    });
    const series = chart.addSeries(CandlestickSeries, { ...HOLLOW_CANDLES });
    chartRef.current = chart;
    seriesRef.current = series;
    setReady(true);

    let disposed = false;
    const sec = anchorSec(zone);
    const secMs = sec * 1000;
    const lowerSec = sec - WINDOW * tfSeconds(zone.timeframe);
    let lastSec = 0;

    void (async () => {
      try {
        const raw = phase === 'at'
          ? await fetchKlines(zone.symbol, zone.timeframe, WINDOW, undefined, secMs)
          : await fetchKlines(zone.symbol, zone.timeframe, WINDOW, secMs);
        if (disposed) return;
        // تنقية النافذة بالضبط (الكاش يوحّد النوافذ المتتالية لنفس العملة/الفريم)
        const candles = (phase === 'at'
          ? raw.filter(c => c.time >= lowerSec && c.time <= sec)
          : raw.filter(c => c.time >= sec));
        if (!candles.length) { setFailed(true); setLoading(false); return; }
        series.setData(candles.map(toBar));
        lastSec = candles[candles.length - 1].time;
        // علامة دائرة عند مكان سعر السيولة على شمعة الاكتشاف (أقرب شمعة إلى اللحظة)
        let nearest = 0;
        for (let i = 1; i < candles.length; i += 1) {
          if (Math.abs(candles[i].time - sec) < Math.abs(candles[nearest].time - sec)) nearest = i;
        }
        if (Number.isFinite(zone.liquidityLevel)) {
          createSeriesMarkers(series, [{
            time: candles[nearest].time as UTCTimestamp,
            price: zone.liquidityLevel,
            position: bullish ? 'atPriceBottom' as const : 'atPriceTop' as const,
            shape: 'circle' as const,
            color: zoneColor,
            size: 2,
            text: 'الاكتشاف'
          }]);
        }
        // خطوط المستويات فوق السعر الحقيقي
        if (Number.isFinite(zone.referenceLevel)) {
          series.createPriceLine({ price: zone.referenceLevel, color: '#64748b', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'المرجع' });
        }
        if (Number.isFinite(zone.liquidityLevel)) {
          series.createPriceLine({ price: zone.liquidityLevel, color: zoneColor, lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'السيولة' });
        }
        if (Number.isFinite(zone.retailStop)) {
          series.createPriceLine({ price: zone.retailStop, color: '#d97706', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'وقف Retail' });
        }
        // خط الاتجاه إن وجد — من نقاطه الفعلية داخل النافذة
        const tp = zone.trendline?.points ?? [];
        if (tp.length >= 2) {
          const pts = tp
            .filter(p => p.time >= candles[0].time && p.time <= lastSec)
            .sort((a, b) => a.time - b.time)
            .map(p => ({ time: p.time as UTCTimestamp, value: p.price }));
          if (pts.length >= 2) {
            const line = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2 });
            line.setData(pts);
          }
        }
        chart.timeScale().fitContent();
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    const unsub = subscribeKline(zone.symbol, zone.timeframe, (c: Candle) => {
      if (disposed || phase !== 'after' || c.time < lastSec) return;
      series.update(toBar(c));
      lastSec = c.time;
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      unsub();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setReady(false);
    };
  }, [zone, zone.symbol, zone.timeframe, zone.kind, zone.referenceLevel, zone.liquidityLevel, zone.retailStop, zone.trendline, phase, height, subscribeKline]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height, minHeight: height }} />
      {loading && !failed && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>تحميل الشموع من بينانس…</div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>تعذر جلب الشموع لهذه النافذة</div>
      )}
      {ready && !loading && (
        <div className="absolute top-1 left-1 z-10 num text-[10px] rounded px-1.5 py-0.5" style={{ background: 'rgba(10,14,22,.75)', color: '#e2e8f0', border: '1px solid var(--border-1)' }}>
          {zone.symbol} · {zone.timeframe}
        </div>
      )}
    </div>
  );
});

export default ZoneChart;
