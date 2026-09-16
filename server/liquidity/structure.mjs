/* الطبقة 1: الهيكل الكلاسيكي — حتمية بالكامل وقابلة للاختبار بدون شبكة
 * Pivot highs/lows → مرشحات BSL/SSL، عناقيد EQH/EQL، السحب (Sweep)، فجوات FVG، الـInducement.
 * كل الدوال تأخذ شموعاً {time, open, high, low, close} وتعيد نتائج مرتبة زمنياً.
 */

/** قوة الـPivot الافتراضية لكل فريم — الفريم الأكبر يحتاج تأكيداً أطول */
export const PIVOT_STRENGTH = {
  '1m': 2, '3m': 2, '5m': 3, '15m': 3, '30m': 4, '1h': 4,
  '2h': 5, '4h': 5, '6h': 6, '8h': 6, '12h': 7, '1d': 7, '3d': 8, '1w': 9
};

export const pivotStrengthFor = (tf) => PIVOT_STRENGTH[tf] ?? 3;

/** قمم/قيعان السوينغ: قمة = أعلى من strength شموع على الجانبين (التماثل حتمي) */
export function findPivots(candles, strength = 3) {
  const out = [];
  for (let i = strength; i < candles.length - strength; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, time: candles[i].time, price: candles[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, time: candles[i].time, price: candles[i].low, kind: 'low' });
  }
  return out;
}

/** عناقيد القمم/القيعان المتساوية (EQH/EQL) — كل عنقود بنقطتين فأكثر ضمن التسامح = بركة سيولة أقوى */
export function clusterEquals(pivots, tolerancePct = 0.002) {
  const clusters = [];
  for (const p of pivots) {
    const c = clusters.find(c => c.kind === p.kind && Math.abs(p.price - c.price) / c.price <= tolerancePct);
    if (c) {
      c.count += 1;
      c.indexes.push(p.index);
      // سعر العنقود = متوسط أسعاره (حتمي)
      c.price = (c.price * (c.count - 1) + p.price) / c.count;
    } else {
      clusters.push({ kind: p.kind, price: p.price, count: 1, indexes: [p.index], lastIndex: p.index });
    }
  }
  return clusters;
}

/** السحب: ذيل يخترق المستوى ثم إغلاق داخله (الإغلاق هو الحكم — لا الذيل) */
export function detectSweeps(candles, pivots, { strength = 3, tolerancePct = 0.0005 } = {}) {
  const sweeps = [];
  for (const p of pivots) {
    const confirmAt = p.index + strength;
    for (let i = confirmAt; i < candles.length; i += 1) {
      const c = candles[i];
      if (p.kind === 'high') {
        if (c.high > p.price * (1 + tolerancePct) && c.close < p.price) {
          sweeps.push({ pivotIndex: p.index, level: p.price, kind: 'BSL', time: c.time, index: i });
          break;
        }
        // قبول الاختراق (إغلاق فوق المستوى) يلغي هذا الـpivot كسحب مستقبلي
        if (c.close > p.price * (1 + tolerancePct)) break;
      } else {
        if (c.low < p.price * (1 - tolerancePct) && c.close > p.price) {
          sweeps.push({ pivotIndex: p.index, level: p.price, kind: 'SSL', time: c.time, index: i });
          break;
        }
        if (c.close < p.price * (1 - tolerancePct)) break;
      }
    }
  }
  return sweeps;
}

/** فجوات القيمة العادلة: فرق ثلاثي الشموع بين شمعة i وشمعة i-2 */
export function detectFVGs(candles) {
  const out = [];
  for (let i = 2; i < candles.length; i += 1) {
    const a = candles[i - 2];
    const c = candles[i];
    if (c.low > a.high) out.push({ time: c.time, index: i, top: c.low, bottom: a.high, dir: 'bull' });
    else if (c.high < a.low) out.push({ time: c.time, index: i, top: a.low, bottom: c.high, dir: 'bear' });
  }
  return out;
}

/**
 * مرشحات المناطق من آخر pivotsLimit قمة/قاع:
 * كل قمة سوينغ → BSL مرشحة، كل قاع → SSL، مُثراة بعدد عنقودها وسحبها وتوافق FVG.
 */
export function candidateZones(candles, {
  strength = 3,
  eqhTolerancePct = 0.002,
  pivotsLimit = 10,
  now = Date.now()
} = {}) {
  const pivots = findPivots(candles, strength);
  const clusters = clusterEquals(pivots, eqhTolerancePct);
  const sweeps = detectSweeps(candles, pivots, { strength });
  const fvgs = detectFVGs(candles);

  const clusterOf = (p) => clusters.find(c => c.kind === p.kind && Math.abs(p.price - c.price) / c.price <= eqhTolerancePct);
  const sweepOf = (p) => sweeps.find(s => s.pivotIndex === p.index);
  const fvgNear = (price) => fvgs.some(f =>
    (price >= f.bottom * 0.995 && price <= f.top * 1.005));

  // آخر N قمم + آخر N قيعان (الأحدث أولاً)
  const highs = pivots.filter(p => p.kind === 'high').slice(-pivotsLimit);
  const lows = pivots.filter(p => p.kind === 'low').slice(-pivotsLimit);

  const zones = [];
  for (const p of [...highs, ...lows]) {
    const cl = clusterOf(p);
    const sw = sweepOf(p);
    zones.push({
      type: p.kind === 'high' ? 'BSL' : 'SSL',
      price: p.price,
      anchorIndex: p.index,
      anchorTime: p.time,
      clusterCount: cl ? cl.count : 1,
      swept: Boolean(sw),
      sweptAt: sw ? sw.time : null,
      fvgNear: fvgNear(p.price)
    });
  }
  return { zones, pivots, clusters, sweeps, fvgs, computedAt: now };
}

/** المستويات المرجعية: قمة/قاع آخر 24 ساعة (أو النافذة المتاحة) + الأرقام المستديرة */
export function referenceLevels(candles) {
  if (!candles.length) return null;
  const window = candles.slice(-96); // ~24 شمعة ساعة أو ما يقابلها
  const high = Math.max(...window.map(c => c.high));
  const low = Math.min(...window.map(c => c.low));
  return { high, low };
}

/** هل السعر قرب رقم مستدير (1، 10، 100...) ضمن 0.05%؟ */
export function isRoundNumber(price, tolerancePct = 0.0005) {
  const mag = Math.pow(10, Math.floor(Math.log10(price)));
  for (const m of [mag, mag * 5]) {
    if (Math.abs(price - m) / m <= tolerancePct) return true;
  }
  return false;
}
