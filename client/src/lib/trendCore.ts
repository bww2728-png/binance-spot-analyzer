export type TrendVal = 'up' | 'down';

export interface TrendSuggestion {
  trend: TrendVal | null;
  /** وصف موجز لأساس الاقتراح */
  basis: string;
  ema20: number | null;
  ema50: number | null;
  price: number | null;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** هبوط/صعود إضافي: هل آخر 30 شمعة تصنع قمماً وقيعاناً صاعدة؟ */
function swingStructure(closes: number[]): 'up' | 'down' | null {
  const n = closes.length;
  if (n < 40) return null;
  const highs = [Math.max(...closes.slice(0, 10)), Math.max(...closes.slice(10, 20)), Math.max(...closes.slice(20, 30))];
  const lows = [Math.min(...closes.slice(0, 10)), Math.min(...closes.slice(10, 20)), Math.min(...closes.slice(20, 30))];
  const hh = highs[2] > highs[1] && highs[1] > highs[0];
  const hl = lows[2] > lows[1] && lows[1] > lows[0];
  const lh = highs[2] < highs[1] && highs[1] < highs[0];
  const ll = lows[2] < lows[1] && lows[1] < lows[0];
  if (hh && hl) return 'up';
  if (lh && ll) return 'down';
  return null;
}

/**
 * الحساب الحتمي لاقتراح الاتجاه من سلسلة إغلاقات (بدون شبكة — قابل للاختبار).
 * EMA20/EMA50 + الموقع + بنية السوينغ.
 */
export function computeTrend(closes: number[]): TrendSuggestion {
  if (closes.length < 60) {
    return { trend: null, basis: 'بيانات غير كافية للاقتراح', ema20: null, ema50: null, price: closes[closes.length - 1] ?? null };
  }
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const last = closes[closes.length - 1];
  const swing = swingStructure(closes);
  const aboveCross = e20 !== null && e50 !== null && e20 > e50 && last > e50;
  const belowCross = e20 !== null && e50 !== null && e20 < e50 && last < e50;

  if (aboveCross) {
    const basis = swing === 'up'
      ? `EMA20 أعلى EMA50 + قمم وقيعان صاعدة`
      : `EMA20 أعلى EMA50 والسعر فوق EMA50`;
    return { trend: 'up', basis, ema20: e20, ema50: e50, price: last };
  }
  if (belowCross) {
    const basis = swing === 'down'
      ? `EMA20 أدنى EMA50 + قمم وقيعان هابطة`
      : `EMA20 أدنى EMA50 والسعر تحت EMA50`;
    return { trend: 'down', basis, ema20: e20, ema50: e50, price: last };
  }
  return {
    trend: null,
    basis: swing === 'up' ? 'متقاطعات متداخلة لكن بنية السوينغ صاعدة' : swing === 'down' ? 'متقاطعات متداخلة لكن بنية السوينغ هابطة' : 'اتجاه غير حاسم — حدّده يدوياً',
    ema20: e20, ema50: e50, price: last
  };
}
