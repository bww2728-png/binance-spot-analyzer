/**
 * مناطق السيولة في محرك v2: تجميع اللمسات، الوقف المرجعي المزدوج، خط الاتجاه الحقيقي.
 *
 * هذا الملف يوازي منطق `../engine.mjs` **مع إصلاح ثلاثة عيوب مُثبتة**، ويحفظ تسميات الحالات
 * كما هي (`potential/candidate/confirmed/swept`) ليبقى القياس والمقارنة ممكنين:
 *
 *  1. **التسامح بـATR لا بنسبة ثابتة**: النسبة الثابتة تفشل بين عملة وأخرى وفريم وآخر
 *     (نفس ما تقوله معايير SMC/ICT الحديثة: «تسامح قائم على ATR يجعل الإعداد نفسه صالحاً
 *     على BTC الساعي وعلى زوج هادئ، بلا معايرة يدوية»).
 *  2. **حد اللمسات = ۲**: كان ۳ في المحرك الأول، وتعارض مع تعريف صاحب النظام («تكرّر
 *     عندها السعر مرتين أو أكثر»).
 *  3. **خط الاتجاه بتركيب حقيقي**: كان يأخذ آخر ثلاث نقاط فقط ويسقط خطاً عليها؛ الآن يُركَّب
 *     بأقل المربعات على كل النقاط المرشحة، وتُفحص انحرافات النقاط البينية.
 *
 * ولا يُعدّل هذا الملف المحرك الأول ولا يُغذّي أي قرار منشور.
 */

import { atrAt, normalizeCandles } from '../engine.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = (v) => Number.isFinite(Number(v));
const median = (xs) => {
  const a = xs.filter(fin).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** القيم الافتراضية — كلها قابلة للتمرير، بلا أرقام سحرية مخفية */
export const ZONE_DEFAULTS = {
  toleranceAtr: 0.25,   // تسامح التجميع بوحدات ATR
  minTouches: 2,        // أقل عدد لمسات لتكوين منطقة (تعريف صاحب النظام)
  stopAtrMult: 2,       // ضعف ATR لسعر وقف الريتيل
  atrPeriod: 14,
  trendMinPoints: 3,
  maxDeviationAtr: 1.0,
  minPointProminenceAtr: 0.5,
  nowMs: 0
};

/**
 * تجميع اللمسات بتسامح ATR.
 * كل نقطة تنضم لأقرب تجمّع قائم إن كانت داخل `toleranceAtr × atr`، وإلا تفتح تجمّعاً جديداً.
 * التجمّع يحمل عدّاد لمسات — وهو مقياس القوة (‏«Highs ×3» أقوى من مستوى لم يُختبر).
 */
export function clusterByAtr(points, toleranceAtr = ZONE_DEFAULTS.toleranceAtr, opts = {}) {
  const list = (points ?? []).filter(p => p && fin(p.price) && fin(p.index));
  if (!list.length) return [];
  const clusters = [];
  for (const point of list) {
    const atr = fin(point.atr) ? Math.abs(Number(point.atr)) : 0;
    const tol = Math.max(toleranceAtr * (atr || 1e-12), Number(opts.minToleranceAbs) || 0);
    let target = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      const dist = Math.abs(Number(point.price) - c.price);
      if (dist <= tol && dist < bestDist) { target = c; bestDist = dist; }
    }
    if (target) {
      target.points.push(point);
      target.price = median(target.points.map(x => Number(x.price)));
      target.strength = Math.max(target.strength, Number(point.strength) || 0);
      target.atrUsed = atr || target.atrUsed;
    } else {
      clusters.push({ price: Number(point.price), points: [point], strength: Number(point.strength) || 0, atrUsed: atr });
    }
  }
  return clusters.map((c, i) => ({
    ...c,
    id: `cluster-${c.points[0].kind}-${i}-${Math.round(c.price * 1e8)}`,
    touches: c.points.length,
    firstIndex: Math.min(...c.points.map(x => Number(x.index))),
    lastIndex: Math.max(...c.points.map(x => Number(x.index))),
    lastPoint: c.points[c.points.length - 1]
  }));
}

/**
 * بوابة سلّم اللمسات (نفس قاعدة المشروع بلا تغيير): بعد كل لمسة ينشأ رد فعل
 * (قاع للـBSL / قمة للـSSL)، ويجب أن يُكسر قبل اللمسة التالية — بذيل (low/high) أو بإغلاق.
 */
export function perIterationStaircase(candles, touchIndices, direction, endIndex) {
  const n = touchIndices.length;
  const breaks = [];
  if (n < 2) return { valid: true, breaks, missingAt: -1 };
  for (let i = 0; i < n - 1; i += 1) {
    const t = touchIndices[i];
    const nextT = touchIndices[i + 1];
    let reactionPrice = direction === 'down' ? Infinity : -Infinity;
    let hasReaction = false;
    for (let k = t + 1; k < nextT && k <= endIndex; k += 1) {
      const c = candles[k];
      if (!c) continue;
      hasReaction = true;
      reactionPrice = direction === 'down' ? Math.min(reactionPrice, c.low) : Math.max(reactionPrice, c.high);
    }
    if (!hasReaction) return { valid: false, breaks, missingAt: i };
    const afterNext = touchIndices[i + 2] != null ? touchIndices[i + 2] : endIndex + 1;
    let hit = false;
    for (let k = nextT + 1; k < afterNext && k <= endIndex; k += 1) {
      const c = candles[k];
      if (!c) continue;
      const broke = direction === 'down'
        ? (c.low < reactionPrice || c.close < reactionPrice)
        : (c.high > reactionPrice || c.close > reactionPrice);
      if (broke) {
        breaks.push({ index: k, time: c.time, reactionPrice: Number(reactionPrice) });
        hit = true;
        break;
      }
    }
    if (!hit) return { valid: false, breaks, missingAt: i };
  }
  return { valid: true, breaks, missingAt: -1 };
}

/**
 * تركيب خط اتجاه بأقل المربعات على نقاط مرشحة (قمم للهابط، قيعان للصاعد حصراً).
 * يرفض الخط إن كان أي نقطة تشذّ بأكثر من `maxDeviationAtr`، أو إن كان الإسقاط سالباً.
 */
export function fitTrendline(points, candles, endIndex, opts = {}) {
  const cfg = { ...ZONE_DEFAULTS, ...opts };
  const list = (points ?? []).filter(p => p && fin(p.price) && fin(p.index));
  if (list.length < cfg.trendMinPoints) return null;
  // ترتيب زمني ثم أخذ أقصى نافذة (بلا نظرة مستقبلية)
  const sorted = list.slice().sort((a, b) => a.index - b.index);
  const n = sorted.length;
  const meanX = sorted.reduce((a, p) => a + p.index, 0) / n;
  const meanY = sorted.reduce((a, p) => a + Number(p.price), 0) / n;
  let num = 0;
  let den = 0;
  for (const p of sorted) {
    num += (p.index - meanX) * (Number(p.price) - meanY);
    den += (p.index - meanX) ** 2;
  }
  if (!den) return null; // كل النقاط في الشمعة نفسها — لا خط
  const slope = num / den;
  const intercept = meanY - slope * meanX;
  const end = Math.max(endIndex ?? n - 1, sorted[n - 1].index);
  const projected = slope * end + intercept;
  if (!Number.isFinite(projected) || projected <= 0) return null;

  const endIdx = endIndex ?? Math.max(...sorted.map(p => p.index));
  const deviations = sorted.map((p) => {
    const atr = fin(p.atr) ? Math.abs(Number(p.atr)) : atrAt(candles ?? [], p.index);
    const dev = Math.abs(Number(p.price) - (slope * p.index + intercept));
    return dev / Math.max(atr, 1e-12);
  });
  const maxDeviationAtr = Math.max(...deviations);
  const errorAtr = median(deviations);
  if (maxDeviationAtr > cfg.maxDeviationAtr) return null;

  return {
    slope,
    intercept,
    projected: Number(projected),
    points: sorted.map(p => ({ index: p.index, time: p.time, price: Number(p.price) })),
    errorAtr: Number(errorAtr.toFixed(3)),
    maxDeviationAtr: Number(maxDeviationAtr.toFixed(3)),
    endIndex: endIdx
  };
}

/** سياق البريميوم (فوق 0.5) — معلوماتي عند صاحب النظام لا شرط */
function premiumContext(candles, index) {
  const end = Math.min(index, (candles?.length ?? 1) - 1);
  let high = -Infinity;
  let low = Infinity;
  for (let i = Math.max(0, end - 60); i <= end; i += 1) {
    const c = candles?.[i];
    if (!c || !fin(c.high) || !fin(c.low)) continue;
    high = Math.max(high, Number(c.high));
    low = Math.min(low, Number(c.low));
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  const price = fin(candles?.[end]?.close) ? Number(candles[end].close) : high;
  const position = (price - low) / (high - low);
  return { low, high, position: Number(position.toFixed(4)), premium: position > 0.5, fib: { low, high, midpoint: (low + high) / 2 } };
}

/**
 * الوقف المرجعي المزدوج:
 *  - `retailStop` = أقصى سعر للتجمّع + 2×ATR (والعكس للـSSL) — القاعدة الحسابية.
 *  - `referenceAlt` = القمة/القاع الفرعي التالي للمنطقة مباشرة (القاعدة السعرية).
 * كلاهما يُعاد؛ والقرار يستخدم `retailStop` كما في المحرك الأول ليبقى القياس متسقاً.
 */
function dualStop(cluster, candles, endIndex, direction, opts) {
  const p = cluster.lastPoint;
  const atr = fin(p.atr) ? Math.abs(Number(p.atr)) : atrAt(candles, p.index, opts.atrPeriod);
  const extreme = direction === 'down'
    ? Math.max(...cluster.points.map(x => Number(x.price)))
    : Math.min(...cluster.points.map(x => Number(x.price)));
  const retailStop = direction === 'down' ? extreme + atr * opts.stopAtrMult : extreme - atr * opts.stopAtrMult;
  const liquidity = direction === 'down'
    ? Math.max(extreme, Number(p.price) + atr * opts.stopAtrMult)
    : Math.min(extreme, Number(p.price) - atr * opts.stopAtrMult);
  return { atr, extreme, retailStop, liquidity };
}

function makeZone({ symbol, timeframe, kind, cluster, direction, candles, endIndex, opts, extra = {} }) {
  const p = cluster.lastPoint;
  const { atr, retailStop, liquidity } = dualStop(cluster, candles, endIndex, direction, opts);
  const touchIndices = cluster.points.map(x => Number(x.index));
  const staircase = perIterationStaircase(candles, touchIndices, direction, endIndex);
  const relevant = candles.slice(Number(p.index) + 1, endIndex + 1);
  const sweptAtIdx = direction === 'down'
    ? relevant.findIndex(c => c && fin(c.high) && Number(c.high) >= liquidity)
    : relevant.findIndex(c => c && fin(c.low) && Number(c.low) <= liquidity);
  const state = sweptAtIdx >= 0
    ? 'swept'
    : staircase.valid && cluster.touches >= 2
      ? 'confirmed'
      : cluster.touches >= opts.minTouches ? 'candidate' : 'potential';
  const confidence = clamp(
    0.25 + Math.min(cluster.touches, 5) * 0.1 + Math.min(Number(p.prominenceAtr) || 0, 4) * 0.08
      + (state === 'confirmed' ? 0.2 : 0) + (extra.trendline ? 0.12 : 0),
    0, 0.99
  );
  return {
    id: `${symbol}-${timeframe}-${kind}-${cluster.id}`,
    symbol,
    timeframe,
    kind,
    referenceLevel: Number(cluster.price),
    referenceAlt: extra.referenceAlt ?? null,
    liquidityLevel: Number(liquidity),
    retailStop: Number(retailStop),
    state,
    createdAt: p.time ?? null,
    confirmedAt: state === 'confirmed' && staircase.breaks.length
      ? (candles[staircase.breaks[staircase.breaks.length - 1].index]?.time ?? null)
      : null,
    sweptAt: sweptAtIdx >= 0 ? (relevant[sweptAtIdx]?.time ?? null) : null,
    confidence: Number(confidence.toFixed(4)),
    touches: cluster.touches,
    touchPoints: cluster.points.map(x => ({ index: Number(x.index), time: x.time ?? null, price: Number(x.price) })),
    staircase,
    finalBreak: staircase.breaks.length
      ? { breakTime: candles[staircase.breaks[staircase.breaks.length - 1].index]?.time ?? null, reactionPrice: staircase.breaks[staircase.breaks.length - 1].reactionPrice }
      : null,
    breakSteps: staircase.breaks.map(b => ({ index: b.index, time: b.time ?? null, reactionPrice: b.reactionPrice })),
    prominenceAtr: Number((Number(p.prominenceAtr) || 0).toFixed(3)),
    atr: Number(atr.toPrecision(8)),
    distanceAtr: Number((Math.abs(liquidity - cluster.price) / Math.max(atr, 1e-12)).toFixed(3)),
    reasons: [
      `${cluster.touches} لمسات متقاربة بتسامح ${opts.toleranceAtr}×ATR`,
      `بروز ${(Number(p.prominenceAtr) || 0).toFixed(2)} ATR`,
      state === 'confirmed' ? 'كسر بعد كل تكرار — سلسلة مكتملة'
        : staircase.valid === false ? 'سلسلة الكسور بعد كل تكرار غير مكتملة'
          : 'بانتظار كسر رد الفعل الناشئ بعد كل تكرار',
      ...(extra.trendline ? ['خط اتجاه مركَّب على 3 نقاط أو أكثر'] : []),
      ...(extra.premium?.premium ? ['داخل Premium فوق 0.5'] : []),
      ...(extra.structureReasons ?? [])
    ],
    premium: extra.premium ?? null,
    trendline: extra.trendline ?? null,
    zoneBox: direction === 'down'
      ? { high: Number(Math.max(cluster.price, retailStop)), low: Number(Math.min(cluster.price, retailStop)) }
      : { high: Number(Math.max(cluster.price, retailStop)), low: Number(Math.min(cluster.price, retailStop)) },
    invalidation: state === 'swept'
      ? { reason: 'سُحبت السيولة عند بلوغ سعر الوقف المرجعي', at: sweptAtIdx >= 0 ? (relevant[sweptAtIdx]?.time ?? null) : null }
      : null,
    structureEvents: extra.structureEvents ?? [],
    idm: extra.idm ?? null,
    lastPrice: fin(candles?.[endIndex]?.close) ? Number(candles[endIndex].close) : null,
    detectedAt: opts.nowMs ?? 0,
    source: 'liquidity-engine-v2'
  };
}

/** منطقة أفقية (BSL/SSL) من تجمّع لمسات */
export function buildHorizontalZone({ symbol, timeframe, cluster, candles, endIndex, opts = {} }) {
  const cfg = { ...ZONE_DEFAULTS, ...opts };
  const kind = cluster.points[0]?.kind === 'high' ? 'horizontal_bsl' : 'horizontal_ssl';
  const direction = kind === 'horizontal_bsl' ? 'down' : 'up';
  const referenceAlt = cfg.referenceAltFor?.(cluster, direction) ?? null;
  return makeZone({
    symbol, timeframe, kind, cluster, direction, candles, endIndex, opts: cfg,
    extra: { referenceAlt, premium: premiumContext(candles, endIndex), structureEvents: cfg.structureEvents ?? [] }
  });
}

/** منطقة خط اتجاه (لين BSL/SSL) من خط مُركَّب */
export function buildTrendlineZone({ symbol, timeframe, fitted, cluster, candles, endIndex, kind, opts = {} }) {
  const cfg = { ...ZONE_DEFAULTS, ...opts };
  const direction = kind === 'trendline_bsl' ? 'down' : 'up';
  const points = fitted.points.map(p => ({ ...p, kind: direction === 'down' ? 'high' : 'low', atr: atrAt(candles, p.index, cfg.atrPeriod) }));
  const trendCluster = {
    ...cluster,
    id: cluster?.id ?? `trendline-${kind}-${Math.round(fitted.projected * 1e8)}`,
    price: fitted.projected,
    points: points.length ? points : (cluster?.points ?? []),
    touches: Math.max(points.length, cluster?.touches ?? points.length),
    lastPoint: points[points.length - 1] ?? cluster?.lastPoint
  };
  return makeZone({
    symbol, timeframe, kind, cluster: trendCluster, direction, candles, endIndex, opts: cfg,
    extra: {
      trendline: {
        points: fitted.points,
        slope: fitted.slope,
        errorAtr: fitted.errorAtr,
        maxDeviationAtr: fitted.maxDeviationAtr,
        projected: fitted.projected
      },
      premium: premiumContext(candles, endIndex),
      structureEvents: cfg.structureEvents ?? []
    }
  });
}
