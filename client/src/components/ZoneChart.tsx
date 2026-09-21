import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { fetchKlines } from '../lib/binance';
import type { Candle, LiquidityDetection } from '../lib/types';
import {
  createChart, createSeriesMarkers, CandlestickSeries, LineSeries,
  type IChartApi, type UTCTimestamp
} from 'lightweight-charts';
import { CHART_COLORS, HOLLOW_CANDLES } from './MiniChart';

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close
});

const BEFORE = 80;
const AFTER = 200;

/** حجم الفريم بالثواني — لحساب هامش التكبير بعدها */
const tfSeconds = (tf: string) => {
  const n = parseInt(tf, 10) || 1;
  const u = tf.replace(/[0-9]/g, '');
  return n * ({ m: 60, h: 3600, d: 86400, w: 604800 }[u] ?? 3600);
};

/** مرتكز التحديد على زمن المحور (ثوانٍ) — زمن محور القمة أولاً ولا يُستخدم ساعة الحائط أبداً */
const anchorSec = (z: LiquidityDetection) => {
  const v = z.createdAt || z.confirmedAt || 0;
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
};

/** شارت شموع تفاعلي حقيقي (وليس صورة) — بنفس مكوّن عمود الشارت في لوحة التحليل:
 * lightweight-charts + شموع جوفاء بخلفية بيضاء.
 * البيانات تُحمَّل مرة واحدة عند التركيب: 60+ شمعة قبل لحظة التحديد و200 بعد لحظة التحديد
 * (بزمن المحور الحقيقي) — وتبديل (عند التحديد/بعد التحديد) مجال رؤية فقط فوق نفس البيانات
 * بدون إعادة تركيب وبدون fetch — فلا يختفي الشارت أبداً.
 * + علامة دائرة عند سعر السيولة على شمعة التحديد + خطوط المستويات فوق السعر الحقيقي.
 */
const ZoneChart = memo(function ZoneChart({ zone, phase, height = 360 }: { zone: LiquidityDetection; phase: 'at' | 'after'; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const rangeRef = useRef<{ from: number; at: number; to: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const subscribeKline = useStore(s => s.subscribeKline);

  const bullish = zone.kind.includes('ssl');
  const zoneColor = bullish ? '#089981' : '#f23645';
  // مفتاح بدائي لخط الاتجاه — يمنع الدمار مع تغيّر هوية الكائن في كل استقصاء
  const trendKey = zone.trendline?.points?.map(p => `${p.time}:${p.price}`).join(',') ?? '';

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
    setLoaded(false);
    setFailed(false);
    setLoading(true);

    let disposed = false;
    const pivot = anchorSec(zone);
    const pivotMs = pivot * 1000;
    let lastSec = 0;

    // جلب مع محاولات بتأخير متزايد — تجنب سقوط إعادة المحاولة تحت حدود بينانس (429)
    const fetchRetry = async (limit: number, startTime?: number, endTime?: number): Promise<Candle[]> => {
      const delays = [0, 700, 2000];
      let lastError: unknown = null;
      for (const d of delays) {
        if (d > 0) await new Promise(r => setTimeout(r, d));
        try {
          return await fetchKlines(zone.symbol, zone.timeframe, limit, startTime, endTime);
        } catch (e) { lastError = e; }
      }
      throw lastError ?? new Error('klines unavailable');
    };

    void (async () => {
      try {
        // قبل: ينظر للخلف من لحظة التحديد / بعد: من لحظة التحديد للأمام (أحدث بيانات)
        const settled = await Promise.allSettled([
          fetchRetry(BEFORE, undefined, pivotMs),
          fetchRetry(AFTER, pivotMs)
        ]);
        if (disposed) return;
        const before = settled[0].status === 'fulfilled' ? settled[0].value : [];
        const after = settled[1].status === 'fulfilled' ? settled[1].value : [];
        // نافذة متصلة (proven): كاش العميل قد يحفظ نوافذ متباعدة لنفس المفتاح —
        // المشي المتصل من المحك (شمعة شمعة، توقف عند أول فراغ) يضمن اتصال المحور الزمني
        // ولا يمتد عبر فجوة (لا شموع ممتدة عبر نوافذ متباعدة)
        const tfSec = tfSeconds(zone.timeframe);
        const walkBack = (raw: Candle[], pivot: number, limit: number): Candle[] => {
          const byTime = new Map(raw.filter(c => c.time <= pivot).map(c => [c.time, c] as const));
          const run: Candle[] = [];
          let t = pivot;
          while (run.length < limit) {
            const c = byTime.get(t);
            if (!c) break;
            run.unshift(c);
            t -= tfSec;
          }
          return run;
        };
        const walkForward = (raw: Candle[], pivot: number, limit: number): Candle[] => {
          const byTime = new Map(raw.filter(c => c.time >= pivot).map(c => [c.time, c] as const));
          const run: Candle[] = [];
          let t = pivot;
          while (run.length < limit) {
            const c = byTime.get(t);
            if (!c) break;
            run.push(c);
            t += tfSec;
          }
          return run;
        };
        const beforeWin = walkBack(before, pivot, BEFORE);
        const afterWin = walkForward(after, pivot, AFTER);
        const map = new Map<number, Candle>();
        for (const c of beforeWin) map.set(c.time, c);
        for (const c of afterWin) map.set(c.time, c);
        const candles = Array.from(map.values()).sort((a, b) => a.time - b.time);
        if (!candles.length) { setFailed(true); setLoading(false); return; }
        series.setData(candles.map(toBar));
        lastSec = candles[candles.length - 1].time;
        // شمعة التحديد: أقرب شمعة إلى لحظة التحديد
        let nearest = 0;
        for (let i = 1; i < candles.length; i += 1) {
          if (Math.abs(candles[i].time - pivot) < Math.abs(candles[nearest].time - pivot)) nearest = i;
        }
        rangeRef.current = { from: candles[0].time, at: candles[nearest].time, to: lastSec };
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
        if (!disposed) { setLoaded(true); setLoading(false); }
      } catch {
        if (!disposed) { setFailed(true); setLoading(false); }
      }
    })();

    const unsub = subscribeKline(zone.symbol, zone.timeframe, (c: Candle) => {
      if (disposed || c.time < lastSec) return;
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
    };
  }, [zone.id, zone.symbol, zone.timeframe, zone.kind, zone.referenceLevel, zone.liquidityLevel, zone.retailStop, trendKey, height, subscribeKline]);

  // تبديل الطور = مجال رؤية فقط فوق نفس البيانات — بدون rebuild وبدون fetch
  useEffect(() => {
    const chart = chartRef.current;
    const info = rangeRef.current;
    if (!chart || !info || !loaded) return;
    const ts = chart.timeScale();
    if (phase === 'after') {
      ts.setVisibleRange({ from: info.from as UTCTimestamp, to: info.to as UTCTimestamp });
    } else {
      const span = info.to - info.at;
      const to = info.at + Math.max(Math.round(span * 0.15), tfSeconds(zone.timeframe));
      ts.setVisibleRange({ from: info.from as UTCTimestamp, to: Math.min(to, info.to) as UTCTimestamp });
    }
  }, [phase, loaded, zone.timeframe]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height, minHeight: height }} />
      {loading && !failed && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>تحميل الشموع من بينانس…</div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-3)' }}>تعذر جلب الشموع لهذه النافذة</div>
      )}
      {loaded && (
        <div className="absolute top-1 left-1 z-10 num text-[10px] rounded px-1.5 py-0.5" style={{ background: 'rgba(10,14,22,.75)', color: '#e2e8f0', border: '1px solid var(--border-1)' }}>
          {zone.symbol} · {zone.timeframe}
        </div>
      )}
    </div>
  );
});

export default ZoneChart;
