import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { fetchKlines } from '../lib/binance';
import type { Candle } from '../lib/types';
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close
});

/* ألوان الشموع والشبكة وفق هوية TradingView */
export const CHART_COLORS = {
  up: '#089981',
  down: '#f23645',
  bg: '#0f1522',
  text: '#94a3b8',
  grid: '#1c2940'
};

interface Props {
  symbol: string;
  timeframe: string;
  zones: { price: number; color: string; title: string }[];
  height?: number;
}

/** شارت شموع مصغر حي مع خطوط المناطق */
export default function MiniChart({ symbol, timeframe, zones, height = 120 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [ready, setReady] = useState(false);
  const subscribeKline = useStore(s => s.subscribeKline);
  const livePrice = useStore(s => s.prices[symbol]);
  const barcodeScan = useStore(s => s.barcodeScans[symbol]);
  const isBarcode = barcodeScan?.status === 'success' && barcodeScan.is_barcode;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 9 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: 0 }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up, downColor: CHART_COLORS.down,
      borderVisible: false, wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down
    });
    chartRef.current = chart;
    seriesRef.current = series;
    setReady(true);

    let disposed = false;
    let lastBarTime = 0;
    void fetchKlines(symbol, timeframe, 120).then(candles => {
      if (disposed || candles.length === 0) return;
      series.setData(candles.map(toBar));
      lastBarTime = candles[candles.length - 1].time;
      chart.timeScale().fitContent();
    }).catch(() => { /* ignore */ });

    const unsub = subscribeKline(symbol, timeframe, (c: Candle) => {
      if (disposed) return;
      if (c.time >= lastBarTime) {
        series.update(toBar(c));
        lastBarTime = c.time;
      }
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      unsub();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
      setReady(false);
    };
  }, [symbol, timeframe, height, subscribeKline]);

  // خطوط المناطق
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !ready) return;
    for (const pl of priceLinesRef.current) {
      try { series.removePriceLine(pl); } catch { /* ignore */ }
    }
    priceLinesRef.current = zones
      .filter(z => Number.isFinite(z.price))
      .map(z => series.createPriceLine({
        price: z.price, color: z.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: z.title
      }));
  }, [zones, ready]);

  const zonesKey = useMemo(() => JSON.stringify(zones), [zones]);

  return (
    <div className="relative">
      <div ref={containerRef} style={{ height }} className="rounded overflow-hidden" data-zones={zonesKey} />
      {isBarcode && (
        <div
          className="absolute bottom-1 left-1 text-[9.5px] font-semibold rounded px-1.5 py-0.5"
          style={{ background: 'rgba(245, 158, 11, 0.18)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.4)' }}
          title={`شموع الدقيقة متقطعة/غير مستقرة — الدرجة ${barcodeScan.score} — الشارت قد يكون مضللاً`}
        >
          باركود
        </div>
      )}
      {livePrice !== undefined && (
        <div
          className="num absolute top-1 left-1 text-[10px] rounded px-1.5 py-0.5"
          style={{ background: 'rgba(10, 14, 22, 0.75)', color: 'var(--text-1)', border: '1px solid var(--border-1)' }}
        >
          {livePrice}
        </div>
      )}
    </div>
  );
}
