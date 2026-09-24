/* وحدة مسح فرص الدخول الشرائي عبر سويب مناطق SSL — حتمية بالكامل (بلا شبكة)
 *
 * مصدر الحقيقة للمناطق: محرك مناطق السيولة (القمم/القيعان) — لا إعادة بناء لمنطق المناطق.
 * منطق الصفقة (فابيو): تحديد مناطق SSL → انتظار سويب لها → تأكيد بتدفق الأوامر → خطة كاملة.
 *
 * اصطلاحات المنطقة (من engine.mjs):
 *   referenceLevel = وسيط لمسات القيعان (المستوى المرجعي)
 *   liquidityLevel = أسفلها (حيث تتراكم إيقافات المشترين — بركة السيولة البيعية)
 *
 * كل الدوال نقية: نفس المدخلات تعطي نفس المخرجات.
 */

import { checkPlan } from '../backtest/risk.mjs';

export const SWEEP_PHASES = ['idle', 'armed', 'approaching', 'swept', 'reclaimed', 'published', 'invalidated'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** رقم صالح فقط: يرفض null/''/undefined — وإلا فـ Number(null) = 0 يفسد كل الحساب */
const numOrNaN = (v) => (v == null || v === '' ? NaN : Number(v));

/** هندسة المنطقة مقابل السعر الحالي — كل المسافات بـ ATR والنسبة المئوية */
export function zoneGeometry(zone, price, atr) {
  const liq = numOrNaN(zone?.liquidityLevel);
  const ref = numOrNaN(zone?.referenceLevel);
  const p = numOrNaN(price);
  const a = Number(atr) > 0 ? Number(atr) : Math.abs(ref) * 0.005 || 1;
  const finite = Number.isFinite(liq) && Number.isFinite(ref) && Number.isFinite(p) && ref > 0;
  return {
    liquidityLevel: liq,
    referenceLevel: ref,
    atr: a,
    finite,
    distancePct: finite ? ((p - ref) / ref) * 100 : null,
    distanceAtr: finite ? Math.abs(p - ref) / a : null,
    toLiquidityAtr: finite ? (p - liq) / a : null,
    toReferenceAtr: finite ? (p - ref) / a : null,
    belowLiquidity: finite && p <= liq,
    aboveReference: finite && p >= ref
  };
}

/**
 * حالة السويب لمنطقة SSL مقابل السعر — الانتقالات مبنيّة على الحالة السابقة:
 * - invalidated: السعر تحت مستوى السيولة بمسافة > breakAtr×ATR (كسر حقيقي = فشل السويب)
 * - swept:       السعر عند/تحت مستوى السيولة (سحب جارٍ)
 * - reclaimed:   كان مسحوباً وعاد فوق المستوى المرجعي (اكتمل السويب)
 * - approaching: المسافة إلى مستوى السيولة ≤ approachAtr×ATR (تسليح فعّال)
 * - armed:       منطقة نشطة بعيدة — مراقبة
 */
export function sweepPhase({ zone, price, atr, prev = 'armed', approachAtr = 1.5, breakAtr = 0.6 }) {
  const geometry = zoneGeometry(zone, price, atr);
  if (!geometry.finite) return { phase: 'idle', reason: 'مستويات غير صالحة', geometry };
  if (Number(price) < geometry.liquidityLevel - breakAtr * geometry.atr) {
    return {
      phase: 'invalidated',
      reason: `كسر حقيقي — السعر تحت مستوى السيولة بـ ${Math.abs(geometry.toLiquidityAtr).toFixed(2)} ATR`,
      geometry
    };
  }
  if (geometry.belowLiquidity) {
    return { phase: 'swept', reason: 'السعر عبر مستوى السيولة (سويب جارٍ)', geometry };
  }
  if (prev === 'swept' || prev === 'reclaimed') {
    if (geometry.aboveReference) {
      return { phase: 'reclaimed', reason: 'عاد السعر فوق المستوى المرجعي بعد السويب', geometry };
    }
    return { phase: 'swept', reason: 'بانتظار العودة فوق المستوى المرجعي', geometry };
  }
  if (geometry.toLiquidityAtr <= approachAtr) {
    return { phase: 'approaching', reason: `يقترب من مستوى السيولة (${geometry.toLiquidityAtr.toFixed(2)} ATR)`, geometry };
  }
  return { phase: 'armed', reason: 'منطقة نشطة — بانتظار اقتراب', geometry };
}

/** فئة ثقة المنطقة لشريحة المعايرة */
export function confBand(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'b1';
  if (c >= 0.75) return 'b3';
  if (c >= 0.55) return 'b2';
  return 'b1';
}

/** فئة درجة تدفق الأوامر */
export function flowTier(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'low';
  if (s >= 70) return 'high';
  if (s >= 45) return 'mid';
  return 'low';
}

/** مفتاح الشريحة: (فريم × فئة التدفق × فئة الثقة) */
export function segmentKey({ timeframe, flowTier: tier = 'all', confBand: band = 'all' }) {
  return `${timeframe}|${tier}|${band}`;
}

/** تسلسل تراجعي لمفاتيح الشرائح: الأدق أولاً ثم الأعمّ */
export function segmentLookupKeys({ timeframe, flowTier: tier = 'low', confBand: band = 'b1' }) {
  return [
    `${timeframe}|${tier}|${band}`,
    `${timeframe}|${tier}|all`,
    `${timeframe}|all|${band}`,
    `${timeframe}|all|all`
  ];
}

/**
 * درجة تدفق الأوامر (0-100) — أدوات السويب:
 * CVD (25) + فقاعة شراء عدوانية (30) + عدم توازن الدفتر شرائياً (15)
 * + آيسبرغ عند قاع السويب (15) + أوامر وهمية بيعية (15)
 */
export function flowScore({
  cvd = null, bubbles = [], book = null, icebergs = [], spoofs = [],
  sweepLow = null, price = null, atr = null
} = {}) {
  const reasons = [];
  const components = { cvd: 0, bubble: 0, book: 0, iceberg: 0, spoof: 0 };
  const near = (level, ref, pct) => Number.isFinite(Number(level)) && Number.isFinite(Number(ref)) &&
    Math.abs(Number(level) - Number(ref)) / Number(ref) <= pct;

  const ratio = Number(cvd?.buyRatioPct);
  if (Number.isFinite(ratio) && ratio > 50) {
    components.cvd = clamp(((ratio - 50) / 10) * 25, 0, 25);
    reasons.push(`CVD شرائي (${ratio.toFixed(1)}% شراء عدواني)`);
  }

  const anchor = Number.isFinite(Number(sweepLow)) ? Number(sweepLow) : Number(price);
  const buyBubble = (bubbles ?? []).find(b => b?.type === 'aggressive_buy');
  if (buyBubble) {
    const atSweep = Number.isFinite(anchor) && near(buyBubble.price, anchor, 0.004);
    components.bubble = atSweep ? 30 : 18;
    const usd = buyBubble.notional >= 1000 ? `${Math.round(buyBubble.notional / 1000)}k$` : `${Math.round(buyBubble.notional)}$`;
    reasons.push(`فقاعة شراء عدوانية ${atSweep ? 'عند قاع السويب' : 'قريبة'} (${usd})`);
  }

  const imb = Number(book);
  if (Number.isFinite(imb) && imb > 1.0) {
    components.book = clamp(((imb - 1) / 0.6) * 15, 0, 15);
    reasons.push(`عدم توازن الدفتر شرائياً (${imb.toFixed(2)})`);
  }

  const ice = (icebergs ?? []).find(i => Number.isFinite(anchor) && near(i.price, anchor, 0.004));
  if (ice) {
    components.iceberg = 15;
    reasons.push(`آيسبرغ عند قاع السويب (${ice.hits} ضربات)`);
  }

  const spoof = (spoofs ?? []).find(s => Number.isFinite(anchor) && near(s.price, anchor, 0.006));
  if (spoof) {
    components.spoof = 15;
    reasons.push('أوامر بيعية وهمية (Spoof) عند المستوى');
  }

  const score = clamp(Math.round(components.cvd + components.bubble + components.book + components.iceberg + components.spoof), 0, 100);
  return { score, tier: flowTier(score), reasons, components };
}

/**
 * أهداف الشراء وفق فابيو (كلها فوق الدخول، مرتبة تصاعدياً بلا تكرار متقارب):
 * المستوى المرجعي → أقرب سيولة شرائية فوق (BSL) → VAH → POC → قمة اليوم السابق → عقد الحجم المنخفض
 */
export function longTargets({
  entry, atr, referenceLevel = null, bslAbove = [], profile = null,
  prevDayHigh = null, lvnAbove = [], maxTargets = 5, dedupePct = 0.0015
}) {
  const e = Number(entry);
  const a = Number(atr) > 0 ? Number(atr) : Math.abs(e) * 0.005;
  const cands = [];
  const push = (price, kind, label) => {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= e * 1.0008) return;
    cands.push({ price: p, kind, label });
  };
  push(referenceLevel, 'reference', 'المستوى المرجعي للمنطقة');
  for (const p of bslAbove ?? []) push(p, 'bsl', 'سيولة شرائية معلقة فوق');
  if (profile) {
    push(profile.vah, 'vah', 'حافة منطقة القيمة (VAH)');
    push(profile.poc, 'poc', 'نقطة التحكم (POC)');
  }
  push(prevDayHigh, 'prev_day', 'قمة اليوم السابق');
  for (const p of lvnAbove ?? []) push(p, 'lvn', 'عقدة حجم منخفض (مسار بلا احتكاك)');

  const out = [];
  for (const c of cands.sort((x, y) => x.price - y.price)) {
    if (out.some(o => Math.abs(o.price - c.price) / c.price <= dedupePct)) continue;
    out.push(c);
    if (out.length >= maxTargets) break;
  }
  if (!out.length) {
    out.push({ price: e + 2 * Math.max(a, e * 0.004), kind: 'r2', label: 'هدف 2R' });
    out.push({ price: e + 3 * Math.max(a, e * 0.004), kind: 'r3', label: 'هدف 3R' });
  }
  return out;
}

/**
 * خطة الشراء الكاملة:
 * - الوقف: تحت أدنى قاع السويب بمقدار «علامة أو اثنتين» (نطاق band أو ربع ATR — الأوسع)
 * - الهدف: أول هدف يحقق R:R ≥ minRR، وإلا الأبعد المتاح
 * - التحقق الدلالي عبر checkPlan (الوقف تحت المستوى المحمي دائماً)
 */
export function buildLongPlan({ entry, sweepLow, atr, bandPct = 0.0025, targets = [], minRR = 2 }) {
  const e = Number(entry);
  if (!Number.isFinite(e) || e <= 0) return { entry: e, stop: null, tp: null, risk: 0, reward: 0, rr: 0, valid: false, violations: ['دخول غير صالح'] };
  const a = Number(atr) > 0 ? Number(atr) : e * 0.005;
  const rawLow = Number(sweepLow);
  const low = Number.isFinite(rawLow) ? Math.min(rawLow, e) : e - Math.max(a, e * 0.004);
  const band = Math.max(Number(bandPct) || 0.0025, 0.0015);
  const stop = low - Math.max(low * band, 0.25 * a);
  const list = (targets ?? [])
    .map(t => (typeof t === 'number' ? { price: t, kind: 'raw', label: 'هدف' } : t))
    .filter(t => Number.isFinite(Number(t?.price)))
    .sort((x, y) => Number(x.price) - Number(y.price));
  const valid = list.filter(t => Number(t.price) > e * 1.002);
  const risk = e - stop;
  if (!valid.length) {
    return { entry: e, stop, tp: null, risk, reward: 0, rr: 0, stopAtr: Number((risk / a).toFixed(3)), targets: list, valid: false, violations: ['لا هدف صالح فوق الدخول'] };
  }
  let chosen = valid[valid.length - 1];
  for (const t of valid) {
    const rr = risk > 0 ? (Number(t.price) - e) / risk : 0;
    if (rr >= minRR) { chosen = t; break; }
  }
  const reward = Number(chosen.price) - e;
  const rr = risk > 0 ? reward / risk : 0;
  const plan = { type: 'BSL', entry: e, stop, tp: Number(chosen.price), risk, reward, rr };
  const check = checkPlan({ plan, protectedPrice: low, zoneType: 'BSL' });
  const violations = [...check.violations];
  // شرط الجودة: لا خطة بأقل من R:R المطلوب (أفضل هدف متاح لم يحققه)
  if (rr < Number(minRR)) violations.push(`أفضل R:R متاح ${rr.toFixed(2)} أقل من الحد ${minRR}`);
  return {
    ...plan,
    rr: Number(rr.toFixed(2)),
    stopAtr: Number((risk / a).toFixed(3)),
    targets: list,
    targetKind: chosen.kind,
    targetLabel: chosen.label,
    valid: violations.length === 0,
    violations
  };
}

/** الدرجة المركبة للفرصة (0-100): ثقة المنطقة + تدفق الأوامر + R:R + الجلسة + الموقع + عمق السويب */
export function compositeScore({
  zoneConfidence = 0.5, flow = 0, rr = 0,
  sessionTier = 'normal', locationState = 'balance', sweepDepthAtr = 0
} = {}) {
  let s = 25;
  s += clamp(Number(zoneConfidence) || 0, 0, 1) * 25;
  s += clamp(Number(flow) || 0, 0, 100) * 0.25;
  s += clamp(Number(rr) || 0, 0, 4) * 3.75;
  s += sessionTier === 'prime' ? 6 : sessionTier === 'lull' ? -14 : 0;
  s += locationState === 'imbalance_up' ? 6 : locationState === 'imbalance_down' ? -12 : 2;
  s += clamp(Number(sweepDepthAtr) || 0, 0, 2) * 2;
  return clamp(Math.round(s), 0, 100);
}

/** بوابات النشر: R:R + الجلسة + الموقع + الدرجة المركبة */
export function gates({ rr, sessionTier, locationState, composite, minRR = 2, minComposite = 55 } = {}) {
  const blockers = [];
  if (!(Number(rr) >= minRR)) blockers.push(`R:R ${Number(rr).toFixed(2)} أقل من الحد ${minRR}`);
  if (sessionTier === 'lull') blockers.push('فتكة سيولة آسيوية — لا تداول');
  if (locationState === 'imbalance_down') blockers.push('السوق خارج التوازن هبوطاً — لا شراء');
  if (!(Number(composite) >= minComposite)) blockers.push(`الدرجة المركبة ${composite} أقل من العتبة ${minComposite}`);
  return { pass: blockers.length === 0, blockers };
}

/** أقرب منطقة SSL نشطة تحت السعر — سيناريو «فشل السويب ← تسليح المنطقة التالية تحته» */
export function nextSslBelow(zones, price, { excludeIds = [], maxDistancePct = 0.25 } = {}) {
  const ex = new Set(excludeIds);
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  const rows = (zones ?? [])
    .filter(z => String(z?.kind ?? '').includes('ssl') && !ex.has(z.id) && z.state !== 'swept')
    .map(z => ({ zone: z, level: Number(z.liquidityLevel ?? z.referenceLevel) }))
    .filter(r => Number.isFinite(r.level) && r.level < p)
    .map(r => ({ ...r, distancePct: (p - r.level) / p }))
    .filter(r => r.distancePct <= maxDistancePct)
    .sort((a, b) => a.distancePct - b.distancePct);
  return rows[0]?.zone ?? null;
}

/**
 * محاكاة صفقة سويب تاريخية (للمعايرة — بلا رؤية مستقبلية):
 * سويب → انتظار الاستعادة فوق المستوى المرجعي (نافذة محدودة) → دخول على الإغلاق
 * → وقف تحت أدنى قاع السويب → المشي للأمام حتى الهدف أو الوقف.
 * الأهداف المتاحة لحظتها فقط: أعلى نافذة سابقة + مضاعفات R.
 */
export function simulateSweep({
  candles, sweepIndex, zone, atr, bandPct = 0.0025,
  maxReclaimBars = 6, maxBars = 96, minRR = 2, priorWindow = 30,
  maxStopAtr = 3, minDepthAtr = 0.15, maxDepthAtr = 3,
  maxRangePos = 0.8, minBuyRatioPct = 48,
  sessionTierOf = null, requireSessionPrime = false, takerBuy = null,
  entryMode = 'close', retestTolAtr = 0.3, retestWindow = 12
} = {}) {
  if (!Array.isArray(candles) || candles.length < 30) return { outcome: 'no_entry', reason: 'شموع غير كافية' };
  const i0 = Number(sweepIndex);
  if (!Number.isFinite(i0) || i0 < 1 || i0 >= candles.length - 1) return { outcome: 'no_entry', reason: 'مؤشر السويب غير صالح' };
  const ref = Number(zone?.referenceLevel);
  if (!Number.isFinite(ref)) return { outcome: 'no_entry', reason: 'مستوى مرجعي غير صالح' };

  let entryIdx = -1;
  const limit = Math.min(candles.length - 1, i0 + Math.max(1, maxReclaimBars));
  for (let i = i0; i <= limit; i += 1) {
    if (Number(candles[i].close) >= ref) { entryIdx = i; break; }
  }
  if (entryIdx < 0) return { outcome: 'no_entry', reason: 'لم تُستعد المنطقة خلال نافذة الاستعادة' };

  // دخول إعادة الاختبار (فابيو): بعد الاستعادة ننتظر عودة السعر قرب المستوى المرجعي
  // فندخل أقرب إلى الوقف — الهدف نفسه يصبح أقرب بالـR وترتفع نسبة النجاح.
  // بلا إعادة اختبار خلال النافذة → دخول على إغلاق الاستعادة (احتياطي).
  if (entryMode === 'retest') {
    const fallbackAtr = Math.abs(Number(candles[entryIdx].close)) * 0.005;
    const tol = retestTolAtr * (Number(atr) > 0 ? Number(atr) : fallbackAtr);
    const rLimit = Math.min(candles.length - 1, entryIdx + Math.max(1, retestWindow));
    for (let i = entryIdx + 1; i <= rLimit; i += 1) {
      const c = candles[i];
      if (Number(c.low) <= ref + tol && Number(c.close) >= ref) { entryIdx = i; break; }
      if (Number(c.close) < ref - 0.5 * (Number(atr) || 1)) break; // انهار تحت المرجع — لا دخول
    }
  }

  let sweepLow = Infinity;
  for (let i = i0; i <= entryIdx; i += 1) sweepLow = Math.min(sweepLow, Number(candles[i].low));
  if (!Number.isFinite(sweepLow)) sweepLow = Number(candles[entryIdx].low);
  const entry = Number(candles[entryIdx].close);
  const a = Number(atr) > 0 ? Number(atr) : Math.abs(entry) * 0.005;

  // فلترة عمق السويب: ضحل جداً = بلا سيولة مسحوبة، عميق جداً = كسر لا سويب
  const depthAtr = (Number(zone?.liquidityLevel) - sweepLow) / a;
  if (Number.isFinite(depthAtr)) {
    if (depthAtr < minDepthAtr) return { outcome: 'no_entry', reason: `سويب ضحل (${depthAtr.toFixed(2)} ATR)` };
    if (depthAtr > maxDepthAtr) return { outcome: 'no_entry', reason: `سويب عميق جداً (${depthAtr.toFixed(2)} ATR) — كسر` };
  }

  const win0 = candles.slice(Math.max(0, i0 - priorWindow), i0);
  const priorHigh = win0.length ? Math.max(...win0.map(c => Number(c.high))) : null;
  const priorLow = win0.length ? Math.min(...win0.map(c => Number(c.low))) : null;

  // فلترة الموقع: لا شراء في أعلى النطاق السابق (مطاردة سعرية)
  if (Number.isFinite(priorHigh) && Number.isFinite(priorLow) && priorHigh > priorLow) {
    const pos = (entry - priorLow) / (priorHigh - priorLow);
    if (pos > maxRangePos) return { outcome: 'no_entry', reason: `دخول في أعلى النطاق السابق (${(pos * 100).toFixed(0)}%)` };
  }

  // فلترة الجلسة (تُمرَّر من الخارج — تُتجاهل في الاختبارات)
  if (typeof sessionTierOf === 'function') {
    const tier = sessionTierOf(candles[entryIdx].time);
    if (tier === 'lull') return { outcome: 'no_entry', reason: 'فتكة سيولة' };
    if (requireSessionPrime && tier !== 'prime') return { outcome: 'no_entry', reason: `جلسة ${tier}` };
  }

  // فلترة تدفق تاريخي: نسبة الشراء العدواني في الشموع قبل الدخول (إن توفرت)
  if (Array.isArray(takerBuy) && takerBuy.length === candles.length) {
    let buy = 0, tot = 0;
    for (let i = Math.max(0, entryIdx - 20); i <= entryIdx; i += 1) {
      buy += Number(takerBuy[i]) || 0;
      tot += Number(candles[i].volume) || 0;
    }
    const ratio = tot > 0 ? (buy / tot) * 100 : null;
    if (ratio != null && ratio < minBuyRatioPct) {
      return { outcome: 'no_entry', reason: `تدفق شرائي ضعيف (${ratio.toFixed(1)}%)` };
    }
  }

  // الوقف: قاعدة السويب العميق (أقرب قاع لحركة الاستعادة) — نفس منطق المحرك الحي
  const reclaimLow = Math.min(...candles.slice(Math.max(0, entryIdx - 2), entryIdx + 1).map(c => Number(c.low)));
  const protectedLow = (entry - sweepLow) / a > maxStopAtr
    ? Math.min(Math.max(reclaimLow, sweepLow), entry - 0.5 * a)
    : sweepLow;

  const rUnit = Math.max(entry - protectedLow, 0.25 * a);
  const targets = [];
  if (priorHigh != null && priorHigh > entry) targets.push({ price: priorHigh, kind: 'prior_high', label: 'أعلى نافذة سابقة' });
  targets.push({ price: entry + 2 * rUnit, kind: 'r2', label: 'هدف 2R' });
  targets.push({ price: entry + 3 * rUnit, kind: 'r3', label: 'هدف 3R' });

  const plan = buildLongPlan({ entry, sweepLow: protectedLow, atr: a, bandPct, targets, minRR });
  if (!plan.tp || !plan.valid) return { outcome: 'no_entry', reason: plan.violations?.join(' · ') || 'R:R دون الحد', rr: plan.rr };
  const { stop, tp } = plan;
  for (let i = entryIdx + 1; i < Math.min(entryIdx + maxBars, candles.length); i += 1) {
    const c = candles[i];
    if (Number(c.low) <= stop) return { outcome: 'decided', win: 0, exit: stop, bars: i - entryIdx, rr: plan.rr, entry, stop, tp, entryTime: candles[entryIdx].time };
    if (Number(c.high) >= tp) return { outcome: 'decided', win: 1, exit: tp, bars: i - entryIdx, rr: plan.rr, entry, stop, tp, entryTime: candles[entryIdx].time };
  }
  return { outcome: 'undecided', entry, stop, tp, rr: plan.rr, entryTime: candles[entryIdx].time };
}

/**
 * معايرة زوج/فريم واحد: مناطق SSL التاريخية المسحوبة → محاكاة صفقة لكل سويب.
 * تُطبّق نفس بوابات المحرك الحي (عمق السويب · الموقع · الجلسة · التدفق · R:R) —
 * لذا الشرائح الناتجة أمينة وقابلة للنشر، وتُسجَّل أسباب الرفض للشفافية.
 *
 * تُشغَّل على شبكة من أهداف R:R (rrGrid): نسبة النجاح تعتمد جوهرياً على بُعد الهدف،
 * فتختار الشرائح لاحقاً أنسب R:R يحقق الهدف المطلوب — بدل تثبيت هدف واحد للجميع.
 *
 * حتمية بالكامل — المدخل شموع + مناطق، والمخرج صفقات مصنّفة بشرائح.
 */
export function calibrateSweeps({
  candles, zones, timeframe, raw = null,
  bandPct = 0.0025, maxBars = 96, maxReclaimBars = 6, rrGrid = [1.2, 1.5, 2, 2.5],
  maxStopAtr = 3, minDepthAtr = 0.15, maxDepthAtr = 3,
  maxRangePos = 0.8, minBuyRatioPct = 48,
  sessionTierOf = null, requireSessionPrime = false,
  entryMode = 'retest', retestTolAtr = 0.3, retestWindow = 12
}) {
  const trades = [];
  const rejected = {};
  const bump = (reason) => {
    const key = String(reason).split('(')[0].trim();
    rejected[key] = (rejected[key] ?? 0) + 1;
  };
  const byTime = new Map();
  candles.forEach((c, i) => byTime.set(Number(c.time), i));
  const takerBuy = Array.isArray(raw) && raw.length === candles.length
    ? raw.map(k => Number(k?.[9]))
    : null;

  for (const zone of zones ?? []) {
    if (!String(zone?.kind ?? '').includes('ssl')) continue;
    if (zone.state !== 'swept' || !zone.sweptAt) continue;
    const sweepIndex = byTime.get(Number(zone.sweptAt));
    if (sweepIndex == null) continue;
    for (const minRR of rrGrid) {
      const sim = simulateSweep({
        candles, sweepIndex, zone, atr: zone.atr, bandPct, maxBars, minRR, maxReclaimBars,
        maxStopAtr, minDepthAtr, maxDepthAtr, maxRangePos, minBuyRatioPct,
        sessionTierOf, requireSessionPrime, takerBuy,
        entryMode, retestTolAtr, retestWindow
      });
      if (sim.outcome !== 'decided') { if (minRR === rrGrid[0]) bump(sim.reason ?? 'غير محسوم'); continue; }
      trades.push({
        timeframe,
        band: confBand(zone.confidence),
        minRR,
        win: sim.win,
        rr: sim.rr,
        bars: sim.bars,
        ts: Number(zone.sweptAt)
      });
    }
  }
  return { trades, rejected };
}

/**
 * تجميع صفقات إلى شرائح (فريم × فئة الثقة) مع تمليس بايزي (سابق 0.5 بوزن 4).
 *
 * لكل شريحة تُشغَّل شبكة R:R، ويُختار **أنسب R:R** لها:
 *   1) الأعلى R:R بين المؤهَّلة (نسبة مُعايَرة ≥ targetWinRate وعيّنة كافية) — أفضل عائد مقبول
 *   2) وإلا الأعلى نسبة نجاح (لتُعرض الشريحة كما هي وتُستبعد من النشر)
 * هذا يجعل الشرائح المنشورة قابلة للتحقق تاريخياً بدل تثبيت هدف واحد لكل الأسواق.
 */
export function summarizeSegments(trades, {
  prior = 0.5, priorWeight = 4, targetWinRate = 0.6, minTrades = 12
} = {}) {
  const map = new Map();
  for (const t of trades ?? []) {
    if (t.win !== 0 && t.win !== 1) continue;
    const rrKey = Number.isFinite(Number(t.minRR)) ? Number(t.minRR) : 2;
    for (const key of [`${t.timeframe}|all|${t.band}`, `${t.timeframe}|all|all`]) {
      if (!map.has(key)) map.set(key, new Map());
      const byRR = map.get(key);
      const row = byRR.get(rrKey) ?? { trades: 0, wins: 0, rrSum: 0, rrCount: 0 };
      row.trades += 1;
      if (t.win === 1) row.wins += 1;
      if (Number.isFinite(t.rr)) { row.rrSum += t.rr; row.rrCount += 1; }
      byRR.set(rrKey, row);
    }
  }

  const out = [];
  for (const [key, byRR] of map) {
    const variants = [...byRR.entries()].map(([minRR, r]) => {
      const raw = r.trades ? r.wins / r.trades : null;
      const smoothed = (r.wins + prior * priorWeight) / (r.trades + priorWeight);
      return {
        minRR,
        trades: r.trades,
        wins: r.wins,
        winRate: raw == null ? null : Number(raw.toFixed(3)),
        smoothedWinRate: Number(smoothed.toFixed(3)),
        avgRR: r.rrCount ? Number((r.rrSum / r.rrCount).toFixed(2)) : null,
        qualified: smoothed >= targetWinRate && r.trades >= minTrades
      };
    });
    // المؤهَّلة: الأعلى R:R (أفضل عائد محقَّق تاريخياً) — وإلا الأقوى نسبةً
    const qualified = variants.filter(v => v.qualified).sort((a, b) => b.minRR - a.minRR);
    const chosen = qualified[0] ?? variants.sort((a, b) => b.smoothedWinRate - a.smoothedWinRate)[0];
    if (!chosen) continue;
    out.push({ key, ...chosen, variants: variants.length });
  }
  return out.sort((a, b) => b.trades - a.trades);
}
