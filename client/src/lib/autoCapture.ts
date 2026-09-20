/** الالتقاط التلقائي لصور الشارت لحظة التحديد الآلي.
 * عند بث zones_auto_updated: تُجلب المناطق الجديدة، تُرسم شموع الفريم في Chart خارج الشاشة
 * مع خط المنطقة ونطاقها، تُلتقط PNG وتُخزَّن عبر /api/auto-history/screenshots.
 * كل الفشل صامت — الالتقاط ترفيهي ولا يجب أن يكسر المراقبة.
 */
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { fetchKlines } from './binance';
import { captureChartPng } from './cases/png';
import { api } from './api';
import type { AutoZoneScreenshot, Candle, LiquidityZone } from './types';

/* ألوان الشارت — نفس ثوابت MiniChart (تُضمَّن محلياً لقطع أي استيراد دائري عبر useStore) */
const CHART_COLORS = {
  up: '#089981',
  down: '#f23645',
  bg: '#ffffff',
  text: '#334155',
  grid: '#e5e7eb',
  crosshair: '#9ca3af'
} as const;

const HOLLOW_CANDLES = {
  upColor: 'rgba(0,0,0,0)',
  downColor: '#f23645',
  borderVisible: true,
  borderUpColor: '#089981',
  borderDownColor: '#f23645',
  wickUpColor: '#089981',
  wickDownColor: '#f23645'
} as const;

/** ماركرات منطق المزاد — نفس قائمة الخادم (liquidity/autoHistory.mjs) */
const FABIO_MARKERS = [
  'منطقة القيمة', 'عقدة حجم منخفض', 'اليوم السابق',
  'ندرة حادة', 'فتكة سيولة', 'إعادة اختبار', 'فقاعة'
];

const isFabio = (z: LiquidityZone) =>
  ['profile_edge', 'profile_edge_retest', 'profile_lvn', 'prev_day'].includes((z as { meta?: string }).meta ?? '')
  || (z.reasons ?? []).some(r => FABIO_MARKERS.some(m => r.includes(m)));

/** خنق: لقطة واحدة لكل رمز كل 8 دقائق + منع التزامن */
const lastCapture = new Map<string, number>();
const inFlight = new Set<string>();
const MIN_INTERVAL_MS = 8 * 60_000;
const MAX_ZONES_PER_ROUND = 2;

/** نقطة التعليق من بث useStore — تُستدعى عند zones_auto_updated */
export function queueZoneCapture(symbol: string) {
  const now = Date.now();
  const last = lastCapture.get(symbol) ?? 0;
  if (now - last < MIN_INTERVAL_MS || inFlight.has(symbol)) return;
  lastCapture.set(symbol, now);
  inFlight.add(symbol);
  void captureZones(symbol).catch(() => { /* صامت */ }).finally(() => inFlight.delete(symbol));
}

async function captureZones(symbol: string) {
  const { zones } = await api.getZones(symbol);
  const fabio = zones.filter(isFabio).slice(0, MAX_ZONES_PER_ROUND);
  if (!fabio.length) return;
  const shots: AutoZoneScreenshot[] = [];
  for (const z of fabio) {
    const dataUrl = await drawZoneChart(symbol, z);
    if (!dataUrl) continue;
    shots.push({
      zoneKey: `${symbol}|${z.timeframe}|${z.type}|${Number(z.price.toPrecision(4))}`,
      symbol,
      timeframe: z.timeframe,
      type: z.type,
      price: z.price,
      dataUrl,
      capturedAt: Date.now()
    });
  }
  if (shots.length) void api.postAutoScreenshots(shots).catch(() => { /* صامت */ });
}

/** يرسم شارت الشموع للفريم مع خط المنطقة ونطاقها خارج الشاشة ويلتقطه dataURL */
async function drawZoneChart(symbol: string, z: LiquidityZone): Promise<string | null> {
  let chart: IChartApi | null = null;
  let host: HTMLDivElement | null = null;
  let lines: IPriceLine[] = [];
  try {
    const candles: Candle[] = await fetchKlines(symbol, z.timeframe, 250);
    if (!candles.length) return null;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:900px;height:220px;visibility:hidden;';
    document.body.appendChild(host);
    chart = createChart(host, {
      width: 900,
      height: 220,
      layout: { background: { color: CHART_COLORS.bg }, textColor: CHART_COLORS.text, fontSize: 10 },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: 0 }
    });
    const series: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, { ...HOLLOW_CANDLES });
    series.setData(candles.map(c => ({
      time: c.time as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close
    })));
    const color = z.type === 'BSL' ? '#f23645' : '#089981';
    lines.push(series.createPriceLine({ price: z.price, color, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: z.type }));
    const bandPct = (z as { bandPct?: number | null }).bandPct;
    if (Number.isFinite(bandPct) && bandPct! > 0) {
      for (const edge of [z.price * (1 - bandPct! / 100), z.price * (1 + bandPct! / 100)]) {
        lines.push(series.createPriceLine({ price: edge, color, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' }));
      }
    }
    chart.timeScale().fitContent();
    // مهلة إطارين: يضمن اكتمال رسم canvas قبل الالتقاط
    await new Promise(r => setTimeout(r, 140));
    return captureChartPng(host);
  } catch {
    return null;
  } finally {
    try { chart?.remove(); } catch { /* ignore */ }
    host?.remove();
  }
}
