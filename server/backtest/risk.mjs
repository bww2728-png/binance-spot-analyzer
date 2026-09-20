/* وحدة المخاطر والتحقق الشكلي (حتمية بالكامل — نفس المدخلات تعطي نفس المخرجات)
 * - حجم مقترح بمعادلة كلي المجزأ (Kelly / Fractional Kelly) — إرشادي بالعرض فقط.
 * - مدقق دلالات القواعد (لا Z3 — نفس الدلالات دون تبعية ثقيلة):
 *     1. SL تحت القاع المحمي (شراء) أو فوق القمة المحمي (بيع) — دائماً.
 *     2. SL لا يُوسَّط أبداً (ثابت لكل منطقة).
 *     3. R:R محسوب صح (اتجاه + مسافات).
 */

/** كلي المجزأ: f* = (p·b - (1-p)) / p — المخاطرة النظرية كنسبة من رأس المال.
 *  b = (TP - Entry) / (Entry - SL) — الـ payoff في المعادلة المنشورة. */
export function kellyF(p, b) {
  if (!(p > 0 && p < 1) || !(b > 0)) return 0;
  const f = (p * b - (1 - p)) / p;
  return Math.max(0, f);
}

/** التجزئة: عامل مجزأ افتراضي 0.25 مع سقف 2% من رأس المال (حماية من التوسع المفرط). */
export function fractionalKelly(f, factor = 0.25, capF = 0.02) {
  return Math.min(capF, Math.max(0, f * factor));
}

/** حجم مقترح (وحدات): المخاطرة بالمال / مسافة المخاطرة لكل وحدة. */
export function positionUnits(capital, f, entry, stop) {
  const riskMoney = capital * f;
  const perUnit = Math.abs(entry - stop);
  if (perUnit <= 0 || riskMoney <= 0) return 0;
  return riskMoney / perUnit;
}

/** هدف مُنتقي: أقرب هدف في الاتجاه الصحيح فوق/تحت الدخول (اتجاه المنطقة). */
export function pickTarget({ zoneType, entry, targets }) {
  const valid = (targets ?? []).filter(v => Number.isFinite(v) && v > 0)
    .filter(v => zoneType === 'BSL' ? v > entry * 1.002 : v < entry * 0.998);
  if (!valid.length) return null;
  return valid.reduce((best, v) =>
    Math.abs(v - entry) < Math.abs(best - entry) ? v : best);
}

/** بناء خطة كاملة لفرصة:
 *  - entry = سعر المنطقة (الدخول عند اللمس أو المرساة الحالية).
 *  - stop = تحت القاع المحمي (شراء/BSL) أو فوق القمة المحمي (بيع/SSL) — منطق النظام الحالي حرفياً.
 *  - tp = أقرب هدف صالح؛ وإلا null (لا خطة دون هدف).
 */
export function buildPlan({ zoneType, entry, protectedPrice, bandPct = 0.0025, targets }) {
  const band = Math.max(Number(bandPct) || 0.0025, 0.0015);
  const stop = zoneType === 'BSL'
    ? protectedPrice * (1 - band) // شراء: SL تحت القاع المحمي
    : protectedPrice * (1 + band); // بيع: SL فوق القمة المحمي
  const tp = pickTarget({ zoneType, entry, targets });
  const risk = Math.abs(entry - stop);
  const reward = tp ? Math.abs(tp - entry) : 0;
  const rr = risk > 0 && reward > 0 ? reward / risk : 0;
  return { type: zoneType, entry, stop, tp, risk, reward, rr: Number(rr.toFixed(2)) };
}

/** مدقق دلالات القواعد (التحقق الشكلي الخفيف):
 *  - ok=true ⇒ SL على الجانب الآمن من القاع المحمي، لا اتساع، R:R متسق.
 *  - violations: قائمة نصوص أسباب الفشل — أي قائمة غير فارغة ⇒ رفض الخطة قبل العرض.
 */
export function checkPlan({ plan, protectedPrice, zoneType }) {
  const v = [];
  if (!plan || !Number.isFinite(plan.entry) || plan.entry <= 0) v.push('entry غير صالح');
  if (!Number.isFinite(plan.stop) || plan.stop <= 0) v.push('stop غير صالح');
  if (!Number.isFinite(protectedPrice) || protectedPrice <= 0) v.push('قاع المحمي غير صالح');
  const long = zoneType === 'BSL';
  if (long && !(plan.stop < protectedPrice)) v.push('شراء: SL ليس تحت القاع المحمي');
  if (!long && !(plan.stop > protectedPrice)) v.push('بيع: SL ليس فوق القمة المحمي');
  if (plan.tp != null) {
    const consistent = long
      ? plan.tp > plan.entry && plan.stop < plan.entry
      : plan.tp < plan.entry && plan.stop > plan.entry;
    if (!consistent) v.push('R:R غير متسق مع الاتجاه');
    const calcRR = Math.abs(plan.tp - plan.entry) / Math.abs(plan.entry - plan.stop);
    if (Math.abs(calcRR - plan.rr) > 0.05) v.push('قيمة R:R لا تطابق الحساب');
  }
  return { ok: v.length === 0, violations: v };
}
