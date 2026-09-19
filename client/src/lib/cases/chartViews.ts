import type { ISeriesApi } from 'lightweight-charts';
import type { Candle } from '../types';

interface RegisteredChart {
  tf: string;
  tfSec: number;
  getCandles: () => Candle[];
}

const charts = new Map<string, RegisteredChart>();

/**
 * سجل الشارتات الحية (كما يُعرض فعلاً):
 * يعتمد على series.data() مباشرة — الذي يتضمن تحديث الشمعة الحية — فتُلتقط
 * عند القرار الصورة الحقيقية أمام المستخدم (لا جلب لاحق، لا استشراف).
 */
export function registerChart(
  symbol: string,
  tf: string,
  tfSec: number,
  seriesRef: { current: ISeriesApi<'Candlestick'> | null }
): () => void {
  const key = `${symbol}:${tf}`;
  charts.set(key, {
    tf,
    tfSec,
    getCandles: () => {
      const out: Candle[] = [];
      for (const d of seriesRef.current?.data() ?? []) {
        if ('open' in d) {
          out.push({
            time: Number(d.time),
            open: Number(d.open),
            high: Number(d.high),
            low: Number(d.low),
            close: Number(d.close)
          });
        }
      }
      return out;
    }
  });
  return () => { charts.delete(key); };
}

export function captureViews(symbol: string): { tf: string; tfSec: number; candles: Candle[] }[] {
  const out: { tf: string; tfSec: number; candles: Candle[] }[] = [];
  for (const [key, r] of charts) {
    if (!key.startsWith(`${symbol}:`)) continue;
    out.push({ tf: r.tf, tfSec: r.tfSec, candles: r.getCandles() });
  }
  return out;
}