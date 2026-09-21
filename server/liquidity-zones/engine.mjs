import { detectVisualZones } from './visual.mjs';

/**
 * محرك مستقل لمناطق السيولة وفق تعريف المشروع:
 * Reference level منفصل عن Liquidity/Stop level.
 * لا يستخدم بيانات مستقبلية عند إنشاء الحالة التاريخية؛ pivot لا يدخل إلا بعد rightBars.
 */

export const LIQUIDITY_KINDS = ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl'];
export const ZONE_STATES = ['potential', 'candidate', 'confirmed', 'swept'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (xs) => {
  const a = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function normalizeCandles(raw) {
  return (raw ?? []).map((k, i) => Array.isArray(k)
    ? { time: Number(k[0]) / 1000, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5] ?? 0), index: i }
    : { ...k, time: Number(k.time), index: i });
}

export function atrAt(candles, index, period = 14) {
  const from = Math.max(1, index - period + 1);
  const trs = [];
  for (let i = from; i <= index; i += 1) {
    const p = candles[i - 1]?.close ?? candles[i].open;
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - p), Math.abs(candles[i].low - p)));
  }
  return median(trs) || (candles[index]?.close || 1) * 0.005;
}

export function adaptiveConfig(candles, index = candles.length - 1) {
  const atr = atrAt(candles, index);
  const price = candles[index]?.close || 1;
  const ratio = atr / price;
  return {
    atr,
    rightBars: clamp(Math.round(3 + ratio * 900), 3, 12),
    leftBars: clamp(Math.round(3 + ratio * 600), 3, 12),
    tolerancePct: clamp(ratio * 2.5, 0.0005, 0.012),
    reactionAtr: 1,
    prominenceAtr: clamp(0.8 + ratio * 60, 0.8, 3.5)
  };
}

export function findPivots(candles, options = {}) {
  const out = [];
  const end = options.endIndex ?? candles.length - 1;
  const base = adaptiveConfig(candles, Math.max(0, end));
  const leftBars = options.leftBars ?? base.leftBars;
  const rightBars = options.rightBars ?? base.rightBars;
  for (let i = leftBars; i <= end - rightBars; i += 1) {
    const c = candles[i];
    const left = candles.slice(i - leftBars, i);
    const right = candles.slice(i + 1, i + rightBars + 1);
    const highPivot = left.every(x => c.high >= x.high) && right.every(x => c.high >= x.high);
    const lowPivot = left.every(x => c.low <= x.low) && right.every(x => c.low <= x.low);
    if (!highPivot && !lowPivot) continue;
    const baseHigh = Math.max(...left.map(x => x.high), ...right.map(x => x.high));
    const baseLow = Math.min(...left.map(x => x.low), ...right.map(x => x.low));
    const prominence = highPivot ? c.high - baseLow : baseHigh - c.low;
    const atr = atrAt(candles, i);
    const kind = highPivot && (!lowPivot || prominence >= atr) ? 'high' : 'low';
    out.push({
      index: i, time: c.time, price: kind === 'high' ? c.high : c.low, kind,
      atr, prominenceAtr: prominence / Math.max(atr, 1e-12), confirmedAt: candles[i + rightBars]?.time ?? null,
      strength: clamp((prominence / Math.max(atr, 1e-12)) / 3, 0, 1)
    });
  }
  return out;
}

function clusterPoints(points, tolerancePct) {
  const clusters = [];
  for (const point of points) {
    const cluster = clusters.find(c => Math.abs(point.price - c.price) / Math.max(c.price, 1e-12) <= tolerancePct);
    if (cluster) {
      cluster.points.push(point);
      cluster.price = median(cluster.points.map(x => x.price));
      cluster.strength = Math.max(cluster.strength, point.strength);
    } else {
      clusters.push({ price: point.price, points: [point], strength: point.strength });
    }
  }
  return clusters.map((c, i) => ({
    ...c,
    id: `cluster-${c.points[0].kind}-${i}-${Math.round(c.price * 1e8)}`,
    touches: c.points.length,
    firstIndex: Math.min(...c.points.map(x => x.index)),
    lastIndex: Math.max(...c.points.map(x => x.index)),
    lastPoint: c.points[c.points.length - 1]
  }));
}

function breakAfterReject(candles, cluster, direction) {
  const p = cluster.lastPoint;
  const after = candles.slice(p.index + 1);
  if (!after.length) return null;
  if (direction === 'down') {
    let reactionLow = Infinity;
    for (let i = 0; i < after.length; i += 1) {
      if (i > 0 && (after[i].low < reactionLow || after[i].close < reactionLow)) {
        return { breakIndex: p.index + 1 + i, reactionPrice: reactionLow };
      }
      reactionLow = Math.min(reactionLow, after[i].low);
    }
  } else {
    let reactionHigh = -Infinity;
    for (let i = 0; i < after.length; i += 1) {
      if (i > 0 && (after[i].high > reactionHigh || after[i].close > reactionHigh)) {
        return { breakIndex: p.index + 1 + i, reactionPrice: reactionHigh };
      }
      reactionHigh = Math.max(reactionHigh, after[i].high);
    }
  }
  return null;
}

/**
 * بوابة السلّم (بحرية المشروع): بعد كل لمسة ينشأ رد فعل (قاع BSL / قمه SSL)،
 * ويجب أن يُكسر بعد اللمسة التالية وقبل التي تليها — بذيل (low/high) أو إغلاق (close).
 * كل اللمسات بلا استثناء يتبعها كسر؛ والكسر الأخير (آلية breakAfterReject بدون تعديل) = لحظة التأكيد.
 */
function perIterationStaircase(candles, touchIndices, direction, endIndex) {
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
        breaks.push({ index: k, time: c.time, reactionPrice });
        hit = true;
        break;
      }
    }
    if (!hit) return { valid: false, breaks, missingAt: i };
  }
  return { valid: true, breaks, missingAt: -1 };
}

function stateFor(cluster, candles, direction, endIndex) {
  const p = cluster.lastPoint;
  const relevant = candles.slice(p.index + 1, endIndex + 1);
  const atr = p.atr;
  const liquidity = direction === 'down'
    ? Math.max(...cluster.points.map(x => x.price), p.price + atr * 2)
    : Math.min(...cluster.points.map(x => x.price), p.price - atr * 2);
  const swept = direction === 'down'
    ? relevant.findIndex(c => c.high >= liquidity)
    : relevant.findIndex(c => c.low <= liquidity);
  const reaction = breakAfterReject(candles.slice(0, endIndex + 1), cluster, direction);
  const staircase = perIterationStaircase(candles.slice(0, endIndex + 1), cluster.points.map(x => x.index), direction, endIndex);
  const hasBreak = Boolean(reaction) && staircase.valid;
  return {
    state: swept >= 0 ? 'swept' : hasBreak ? 'confirmed' : cluster.touches >= 3 ? 'candidate' : 'potential',
    sweptAt: swept >= 0 ? relevant[swept].time : null,
    reaction,
    staircase,
    liquidity,
    atr
  };
}

function premiumContext(candles, index) {
  const pivots = findPivots(candles, { endIndex: index });
  const highs = pivots.filter(p => p.kind === 'high' && p.index <= index);
  const lows = pivots.filter(p => p.kind === 'low' && p.index <= index);
  const high = highs.at(-1)?.price;
  const low = lows.at(-1)?.price;
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  const price = candles[index]?.close ?? high;
  const position = (price - low) / (high - low);
  return { low, high, position, premium: position > 0.5, fib: { low, high, midpoint: (low + high) / 2 } };
}

function makeZone(symbol, timeframe, kind, cluster, state, candles, endIndex, extra = {}) {
  const p = cluster.lastPoint;
  const reference = cluster.price;
  const liquidity = state.liquidity;
  const distance = Math.abs(liquidity - reference);
  const confidence = clamp(
    0.25 + Math.min(cluster.touches, 5) * 0.1 + Math.min(p.prominenceAtr, 4) * 0.08
      + (state.state === 'confirmed' ? 0.2 : 0) + (extra.trendline ? 0.12 : 0),
    0, 0.99
  );
  return {
    id: `${symbol}-${timeframe}-${kind}-${cluster.id}`,
    symbol, timeframe, kind,
    referenceLevel: reference,
    liquidityLevel: liquidity,
    retailStop: liquidity,
    state: state.state,
    createdAt: p.time,
    confirmedAt: state.state === 'confirmed' ? state.reaction?.breakIndex != null ? candles[state.reaction.breakIndex]?.time : null : null,
    sweptAt: state.sweptAt,
    confidence: Number(confidence.toFixed(4)),
    touches: cluster.touches,
    touchPoints: cluster.points.map(x => ({ index: x.index, time: x.time, price: x.price })),
    prominenceAtr: Number(p.prominenceAtr.toFixed(3)),
    atr: Number(state.atr.toPrecision(8)),
    distanceAtr: Number((distance / Math.max(state.atr, 1e-12)).toFixed(3)),
    reasons: [
      `${cluster.touches} لمسات متقاربة`,
      `بروز ${p.prominenceAtr.toFixed(2)} ATR`,
      state.state === 'confirmed'
        ? 'كسر بعد كل تكرار — سلسلة مكتملة'
        : state.staircase && !state.staircase.valid
          ? 'سلسلة الكسور بعد كل تكرار غير مكتملة'
          : 'بانتظار كسر الرد فعل الناشئ بعد كل تكرار',
      ...(extra.trendline ? ['ثلاث نقاط أو أكثر على خط اتجاه'] : []),
      ...(extra.premium?.premium ? ['داخل Premium فوق 0.5'] : [])
    ],
    premium: extra.premium ?? null,
    trendline: extra.trendline ?? null,
    invalidation: kind.includes('bsl') ? 'فوق Liquidity Level' : 'تحت Liquidity Level',
    lastPrice: candles[endIndex]?.close ?? null,
    detectedAt: Date.now(),
    source: 'liquidity-engine-v1'
  };
}

export function detectLiquidityZones({ symbol, timeframe, candles: input, endIndex, tolerancePct, biasPerKind = {} } = {}) {
  const candles = input ?? [];
  const end = endIndex ?? candles.length - 1;
  if (candles.length < 40 || end < 20) return [];
  const cfg = adaptiveConfig(candles, end);
  // ائتلاف الوسائط البصرية: رندر + CNN + GAF/MTF + تضمين + BOCPD — حتمي
  let visual = null;
  try {
    visual = detectVisualZones({ candles: candles.slice(0, end + 1), closes: candles.slice(0, end + 1).map(c => c.close), biasPerKind });
  } catch { /* الوسائط البصرية اختيارية — لا تكسر المحاكاة */ }
  const pivots = findPivots(candles, { endIndex: end });
  const tol = tolerancePct ?? cfg.tolerancePct;
  const zones = [];
  for (const kind of ['high', 'low']) {
    const points = pivots.filter(p => p.kind === kind && p.index <= end);
    for (const cluster of clusterPoints(points, tol)) {
      if (cluster.touches < 3) continue;
      const direction = kind === 'high' ? 'down' : 'up';
      const state = stateFor(cluster, candles, direction, end);
      const premium = premiumContext(candles, end);
      const baseKind = kind === 'high' ? 'horizontal_bsl' : 'horizontal_ssl';
      zones.push(makeZone(symbol, timeframe, baseKind, cluster, state, candles, end, { premium }));
    }
  }
  // Trendline مستقل: نحتاج ثلاث نقاط مؤكدة، ونقيس ميلها وتسامحها بالنسبة إلى ATR.
  const highs = pivots.filter(p => p.kind === 'high' && p.index <= end).slice(-12);
  const lows = pivots.filter(p => p.kind === 'low' && p.index <= end).slice(-12);
  const addTrendline = (points, kind) => {
    if (points.length < 3) return;
    const chosen = points.slice(-3);
    const slope = (chosen[2].price - chosen[0].price) / Math.max(chosen[2].index - chosen[0].index, 1);
    const descending = kind === 'trendline_bsl' ? slope < 0 : slope > 0;
    if (!descending) return;
    const lineAt = (i) => chosen[0].price + slope * (i - chosen[0].index);
    const error = median(chosen.map(p => Math.abs(p.price - lineAt(p.index)) / Math.max(p.atr, 1e-12)));
    if (error > 1.5) return;
    const cluster = { price: lineAt(end), points: chosen, touches: 3, lastPoint: chosen[2], strength: 0.8 };
    const state = stateFor(cluster, candles, kind === 'trendline_bsl' ? 'down' : 'up', end);
    const trendline = { points: chosen.map(p => ({ time: p.time, price: p.price })), slope, errorAtr: Number(error.toFixed(3)), projected: lineAt(end) };
    zones.push(makeZone(symbol, timeframe, kind, cluster, state, candles, end, { trendline, premium: premiumContext(candles, end) }));
  };
  addTrendline(highs, 'trendline_bsl');
  addTrendline(lows, 'trendline_ssl');
  return zones
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
    .map(z => {
      if (!visual?.perKind?.[z.kind]) return { ...z, confidence: Number(z.confidence.toFixed(4)) };
      const en = visual.perKind[z.kind];
      const visualConf = en.confidence * 0.35 + (en.gafDiag ?? 0) * 0.1 + (en.mtfMean ?? 0) * 0.05;
      const blended = z.confidence * 0.65 + Math.min(visualConf, 0.99) * 0.35; // الائتلاف يثري ولا يستبدل
      return {
        ...z,
        confidence: Number(Math.min(blended, 0.999).toFixed(4)),
        visual: {
          confidence: en.confidence,
          bestPrice: en.bestPrice,
          bestRow: en.bestRow,
          gafDiag: en.gafDiag,
          mtfMean: en.mtfMean,
          ts2vec: en.ts2vec,
          segments: visual.segments,
          regimeChanges: visual.changes
        }
      };
    });
}

export function scanHistory({ symbol, timeframe, candles: input, step = 1, maxZones = 500, biasPerKind = {} } = {}) {
  const candles = input ?? [];
  const out = [];
  for (let end = 40; end < candles.length; end += step) {
    const current = detectLiquidityZones({ symbol, timeframe, candles, endIndex: end, biasPerKind });
    for (const zone of current) {
      if (zone.state !== 'confirmed' && zone.state !== 'swept') continue;
      const key = `${zone.kind}|${zone.referenceLevel.toPrecision(10)}|${zone.createdAt}`;
      if (!out.some(x => x.key === key)) out.push({ key, zone: { ...zone, detectedAt: candles[end].time } });
      if (out.length >= maxZones) return out.map(x => x.zone);
    }
  }
  return out.map(x => x.zone);
}

export function feedbackToAdjustment(events = [], base = {}) {
  const accepted = events.filter(e => e.verdict === 'accept' || e.verdict === 'confirm');
  const rejected = events.filter(e => e.verdict === 'reject');
  const all = accepted.length + rejected.length;
  const rejectRate = all ? rejected.length / all : 0;
  const tolerancePct = clamp(Number(base.tolerancePct ?? 0.002) * (1 + (rejectRate - 0.5) * 0.2), 0.0005, 0.02);
  return {
    ...base,
    tolerancePct,
    accepted,
    rejected,
    examples: all,
    updatedAt: Date.now()
  };
}
