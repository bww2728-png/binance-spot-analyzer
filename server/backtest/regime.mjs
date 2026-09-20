/* وحدة البواب (حتمية بالكامل):
 * - اختبار التكامل المشترك (زوج عملة مقابل مرساة BTC — Engle-Granger مبسّط على الانتشار).
 * - معيار الانحراف الرياضي (Z-Score) لزناد الدخول وتوحيد الانتشار.
 * - بواب النظام: لا تُعرض صفقة ألت عندما يتشتت الانتشار.
 * - انحياز أفيلانيدا-ستويكوف (المُبسّط) يوسم التوقيت.
 */

/** Z-Score للقيمة الأخيرة مقابل نافذة. */
export function zScore(values, period = 100) {
  if (values.length < period || period < 2) return null;
  const win = values.slice(-period);
  const mean = win.reduce((a, v) => a + v, 0) / win.length;
  const std = Math.sqrt(win.reduce((a, v) => a + (v - mean) ** 2, 0) / win.length);
  if (!(std > 0)) return 0;
  const last = win[win.length - 1];
  return (last - mean) / std;
}

/** انتشار اللوغاريتمي: spread = ln(alt) - β·ln(anchor)،
 *  β = σ_alt / σ_anchor (نسبة التقلب — استقرار الـ β دون تبعية خارجية). */
export function betaSpread(altPrices, anchorPrices, period = 200) {
  const n = Math.min(period, altPrices.length, anchorPrices.length);
  if (n < 30) return null;
  const alt = altPrices.slice(-n);
  const anc = anchorPrices.slice(-n);
  const mean = (arr) => arr.reduce((a, v) => a + v, 0) / arr.length;
  const std = (arr) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length);
  };
  const sAlt = std(alt);
  const sAnc = std(anc);
  const beta = sAnc > 0 ? sAlt / sAnc : 1;
  return { beta, spread: alt.map((v, i) => Math.log(v) - beta * Math.log(anc[i])) };
}

/** اختبار التكامل المشترك المُبسّط (Engle-Granger مبسّط على الانتشار):
 *  ratio = std(النصف الأول) / std(النصف الثاني) قريب من 1.0 ⇒ الانتشار ثابت التقلب.
 *  بعيد عن 1.0 بكثير ⇒ تشتت (non-stationary) ⇒ بواب مرفوض. */
export function cointegrationCheck(altPrices, anchorPrices, { period = 200, tol = 0.35 } = {}) {
  const bs = betaSpread(altPrices, anchorPrices, period);
  if (!bs) return { stationary: null, ratio: null, reason: 'لا انتشار كافٍ' };
  const s = bs.spread;
  if (s.length < 30) return { stationary: null, ratio: null, reason: 'نافذة قصيرة' };
  const std = (arr) => {
    const m = arr.reduce((a, v) => a + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length);
  };
  const half = Math.floor(s.length / 2);
  const s1 = std(s.slice(0, half));
  const s2 = std(s.slice(half));
  if (!(s2 > 0)) return s1 > 0
    ? { stationary: false, ratio: null, reason: 'تشتت (تقلب صفري في النصف الثاني)' }
    : { stationary: true, ratio: 1, reason: 'انتشار صفري — سلسلتان متطابقتان (stationary تافهاً)' };
  const ratio = s1 / s2;
  const stationary = Math.abs(ratio - 1) <= tol;
  return { stationary, ratio: Number(ratio.toFixed(3)), reason: stationary ? 'الانتشار ثابت التقلب' : 'تشتت الانتشار — بواب مرفوض' };
}

/** انحياز المخزون المُبسّط (أفيلانيدا-ستويكوف مبسّط):
 *  bias = (mu - gamma·sigma²)·T / gamma بأوساط متحركة من العوائد. */
export function inventoryBiasSimple({ prices = [], vol = 0, horizonMin = 30, gamma = 0.3 }) {
  const T = horizonMin / 1440;
  if (gamma <= 0) return 0;
  let mu = 0;
  if (prices.length >= 20) {
    const rets = prices.slice(-20).map((v, i, arr) => (i === 0 ? 0 : Math.log(v / arr[i - 1]))).slice(1);
    mu = rets.reduce((a, v) => a + v, 0) / rets.length;
  }
  const sigma = vol > 0 ? vol : 0;
  return (mu - gamma * sigma * sigma) * T / gamma;
}

/** قرار البواب الكامل:
 *  - بواب زوج عملة مقابل المرساة (BTC) — تشتت الانتشار ⇒ رفض.
 *  - Z-Score شاذ (|z|>4) ⇒ رفض.
 *  - انحياز المخزون شاذ (|bias|>3) ⇒ رفض.
 */
export function regimeGate({ altPrices = [], anchorPrices = [], altVol = 0, horizonMin = 30 } = {}, cfg = {}) {
  const out = { pass: true, reasons: [], z: null, coint: null, bias: null };
  const coint = cointegrationCheck(altPrices, anchorPrices, cfg);
  out.coint = coint;
  if (coint.stationary === false) {
    out.pass = false;
    out.reasons.push(coint.reason);
  }
  const z = zScore(altPrices, cfg?.zPeriod ?? 200);
  out.z = z != null ? Number(z.toFixed(2)) : null;
  if (z != null && Math.abs(z) > 4) {
    out.pass = false;
    out.reasons.push(`Z-Score شاذ (${out.z}) — انتظار`);
  }
  out.bias = Number(inventoryBiasSimple({ prices: anchorPrices.length >= altPrices.length ? altPrices : anchorPrices, vol: altVol, horizonMin }).toFixed(3));
  if (Math.abs(out.bias) > 3) {
    out.pass = false;
    out.reasons.push(`انحياز المخزون شاذ (${out.bias})`);
  }
  return out;
}
