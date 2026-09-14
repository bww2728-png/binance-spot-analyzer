import { fetchKlines } from './binance';
import { computeTrend, type TrendSuggestion } from './trendCore';

export { computeTrend } from './trendCore';
export type { TrendSuggestion, TrendVal } from './trendCore';

/** الاقتراح الشبكي: جلب الشموع ثم الحساب الحتمي — اقتراح فقط والتعديل اليدوي متاح */
export async function suggestTrend(symbol: string, timeframe: string): Promise<TrendSuggestion> {
  try {
    const candles = await fetchKlines(symbol, timeframe, 100);
    return computeTrend(candles.map(c => c.close));
  } catch {
    return { trend: null, basis: 'تعذر جلب الشموع — حدّد الاتجاه يدوياً', ema20: null, ema50: null, price: null };
  }
}
