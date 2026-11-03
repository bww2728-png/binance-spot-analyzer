/**
 * منطق الشارت التاريخي الإضافي (مستقل عن أي شارت آخر).
 *
 * كل ما هنا دوال خالصة بلا شبكة ولا حالة: تُغذّى بحمولة `/api/liquidity-history`
 * المخزّنة وتُخرج أرقاماً جاهزة للرسم. الفصل مقصود كي تُختبر القواعد التالية
 * بلا متصفح:
 *  - «أكثر من مرتين» = لمسات ≥ 3.
 *  - الخط الأفقي من أول لمسة إلى آخر لمسة (لا يمتد إلى فراغ).
 *  - نقطة الوقف = `liquidityLevel` (أعلى لمسة + 2×ATR للـBSL، أدنى لمسة − 2×ATR للـSSL).
 *  - خط الاتجاه من 3 نقاط أو أكثر.
 *  - أي قيمة غير منتهية أو غير موجبة تُستبعد، فلا يصل إلى SVG أي NaN.
 */

export type CandleTuple = readonly [number, number, number, number, number, number];

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface LevelItem {
  id: string;
  kind: string;
  side: 'bsl' | 'ssl';
  /** السعر الذي تكرر عنده السعر (وسيط أسعار اللمسات كما يخرجه المحرك) */
  ref: number;
  /** منطقة وقف الخسارة/السيولة */
  stop: number | null;
  /** أزمنة اللمسات داخل نطاق الشارت (ثوانٍ) */
  touchTimes: number[];
  /** أسعار اللمسات الفعلية داخل النطاق — للتحقق البصري من مطابقة الخط */
  touchPrices: number[];
  touches: number;
  state: string;
  atr: number | null;
  confidence: number | null;
  /** كم منطقة محرك اندمجت في هذا الخط (1 = بلا دمج) */
  mergedCount: number;
}

export interface TrendItem {
  id: string;
  kind: string;
  side: 'bsl' | 'ssl';
  points: Array<{ t: number; p: number }>;
  state: string;
}

export interface Scale {
  t0: number;
  t1: number;
  hi: number;
  lo: number;
  x: (t: number) => number;
}

/** عدد اللمسات الذي يبدأ عنده اعتبار المستوى «أكثر من مرتين» */
export const MIN_TOUCHES = 3;
/** أقل عدد نقاط لاعتبار الخط خط اتجاه */
export const MIN_TREND_POINTS = 3;
/** تسامح دمج المستويات المتطابقة للعرض — نفس تسامح هوية المخزون الحيّ (0.02%) */
export const LEVEL_MERGE_TOLERANCE_PCT = 0.0002;

const num = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const isHorizontal = (kind: string) => kind.startsWith('horizontal');
const isTrend = (kind: string) => kind.startsWith('trendline');
const sideOf = (kind: string): 'bsl' | 'ssl' => (kind.includes('ssl') ? 'ssl' : 'bsl');

/** دمج الشموع لأعمدة قابلة للرسم مع الحفاظ على أعلى/أدنى سعر حقيقي في كل عمود */
export function aggregateCandles(candles: readonly CandleTuple[] | undefined | null, target = 1500): Bar[] {
  const raw = candles ?? [];
  if (!raw.length) return [];
  const step = Math.max(1, Math.ceil(raw.length / Math.max(1, target)));
  const out: Bar[] = [];
  for (let i = 0; i < raw.length; i += step) {
    const end = Math.min(raw.length, i + step);
    let h = -Infinity;
    let l = Infinity;
    for (let j = i; j < end; j += 1) {
      const hi = num(raw[j]?.[2]);
      const lo = num(raw[j]?.[3]);
      if (hi != null && hi > h) h = hi;
      if (lo != null && lo < l) l = lo;
    }
    const open = num(raw[i]?.[1]);
    const close = num(raw[end - 1]?.[4]);
    const time = num(raw[i]?.[0]);
    if (open == null || close == null || time == null || !Number.isFinite(h) || !Number.isFinite(l)) continue;
    out.push({ t: time, o: open, h, l, c: close });
  }
  return out;
}

/** مقياس الزمن/السعر مع هامش 4% أعلى وأسفل */
export function makeScale(
  candles: readonly CandleTuple[],
  bars: readonly Bar[],
  width: number,
  height: number,
  pad: { top: number; right: number; bottom: number; left: number }
): Scale | null {
  if (!candles.length || !bars.length) return null;
  const t0 = num(candles[0]?.[0]);
  const t1 = num(candles[candles.length - 1]?.[0]);
  if (t0 == null || t1 == null || t1 <= t0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const bar of bars) {
    if (bar.h > hi) hi = bar.h;
    if (bar.l < lo) lo = bar.l;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  const padP = (hi - lo) * 0.04;
  const top = hi + padP;
  const bottom = lo - padP;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  if (!(plotW > 0) || !(plotH > 0)) return null;
  const x = (t: number) => pad.left + ((t - t0) / (t1 - t0)) * plotW;
  return { t0, t1, hi: top, lo: bottom, x };
}

/** يرسم y أيضاً: يعيد دالة منفصلة كي تبقى الواجهة صريحة */
export function makeY(scale: Scale, height: number, pad: { top: number; bottom: number }) {
  const plotH = height - pad.top - pad.bottom;
  const span = scale.hi - scale.lo;
  if (!(span > 0) || !(plotH > 0)) return (_p: number) => pad.top;
  return (p: number) => pad.top + ((scale.hi - p) / span) * plotH;
}

/**
 * المستويات الأفقية: لمسات ≥ 3، والخط من أول لمسة إلى آخرها داخل نطاق الشارت.
 *
 * الدمج للعرض فقط: مسار التاريخ ينتج نسخاً لنفس المستوى بأزمنة `createdAt`
 * مختلفة، فتُرسم خطوطاً متراكبة على السعر نفسه. ندمجها بتسامح 0.02% (نفس تسامح
 * هوية المخزون الحيّ) ونأخذ الأقوى (لمسات أكثر ثم ثقة أعلى) كصاحب المستوى
 * والوقف، مع اتحاد اللمسات ليكون امتداد الخط صحيحاً. لا يتغيّر أي رقم في
 * المحرك أو في شاشة التاريخ — الدمج داخل هذا الشارت وحده.
 *
 * الدمج جشع وغير متعدٍّ: يُقارن كل مرشح بسعر مالك المجموعة لا بسلسلة، فقد
 * ينضم A وC إلى مجموعة واحدة وإن تجاوز الفرق بينهما التسامح. هذا حتمي ومقصود
 * (كل خط يبقى ضمن 0.02% من سعره المعروض).
 */
export function buildLevels(
  zones: readonly any[] | undefined | null,
  opts: { t0: number; t1: number; minTouches?: number; mergeTolerancePct?: number }
): LevelItem[] {
  const minTouches = opts.minTouches ?? MIN_TOUCHES;
  const tol = Math.min(5e-3, Math.max(1e-9, opts.mergeTolerancePct ?? LEVEL_MERGE_TOLERANCE_PCT));
  const candidates: LevelItem[] = [];
  const seen = new Set<string>();

  for (const zone of zones ?? []) {
    if (!zone) continue;
    const kind = String(zone.kind ?? '');
    if (!isHorizontal(kind)) continue;
    const ref = num(zone.referenceLevel);
    if (ref == null || ref <= 0) continue;
    const touches = num(zone.touches) ?? 0;
    if (touches < minTouches) continue;
    const times: number[] = [];
    const prices: number[] = [];
    for (const point of Array.isArray(zone.touchPoints) ? zone.touchPoints : []) {
      const t = num(point?.time);
      if (t == null || t < opts.t0 || t > opts.t1) continue;
      const p = num(point?.price);
      times.push(t);
      prices.push(p != null && p > 0 ? p : ref);
    }
    if (times.length < minTouches) continue;
    // ترتيب زمني صريح: «أول لمسة» و«آخر لمسة» لا يعتمدان على ترتيب المحرك
    const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b] || a - b);
    const sortedTimes = order.map((i) => times[i]);
    const sortedPrices = order.map((i) => prices[i]);
    const stop = num(zone.liquidityLevel);
    const atr = num(zone.atr);
    const confidence = num(zone.confidence);
    const id = String(zone.id ?? `${kind}-${ref}-${times[0]}`);
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({
      id,
      kind,
      side: sideOf(kind),
      ref,
      stop: stop != null && stop > 0 ? stop : null,
      touchTimes: sortedTimes,
      touchPrices: sortedPrices,
      touches: sortedTimes.length,
      state: String(zone.state ?? ''),
      atr: atr != null && atr > 0 ? atr : null,
      confidence,
      mergedCount: 1
    });
  }

  // الأقوى أولاً: لمسات أكثر ← ثقة أعلى ← سعر أعلى ← معرّف (حسم حتمي بلا locale)
  candidates.sort((a, b) =>
    b.touches - a.touches
    || (b.confidence ?? 0) - (a.confidence ?? 0)
    || b.ref - a.ref
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const groups: LevelItem[] = [];
  for (const candidate of candidates) {
    const group = groups.find((g) => Math.abs(candidate.ref - g.ref) / Math.max(g.ref, 1e-12) <= tol);
    if (!group) {
      groups.push({ ...candidate, touchTimes: [...candidate.touchTimes], touchPrices: [...candidate.touchPrices] });
      continue;
    }
    const byTime = new Map<number, number>();
    for (let i = 0; i < group.touchTimes.length; i += 1) byTime.set(group.touchTimes[i], group.touchPrices[i]);
    for (let i = 0; i < candidate.touchTimes.length; i += 1) {
      if (!byTime.has(candidate.touchTimes[i])) byTime.set(candidate.touchTimes[i], candidate.touchPrices[i]);
    }
    const mergedTimes = [...byTime.keys()].sort((a, b) => a - b);
    group.touchTimes = mergedTimes;
    group.touchPrices = mergedTimes.map((t) => byTime.get(t) as number);
    group.touches = mergedTimes.length;
    group.mergedCount += 1;
  }

  return groups.sort((a, b) => b.ref - a.ref);
}

/** خطوط الاتجاه: 3 نقاط أو أكثر، وكل نقطة داخل نطاق الشارت */
export function buildTrends(
  zones: readonly any[] | undefined | null,
  opts: { t0: number; t1: number; minPoints?: number }
): TrendItem[] {
  const minPoints = opts.minPoints ?? MIN_TREND_POINTS;
  const out: TrendItem[] = [];
  for (const zone of zones ?? []) {
    if (!zone) continue;
    const kind = String(zone.kind ?? '');
    if (!isTrend(kind)) continue;
    const rawPoints = Array.isArray(zone.trendline?.points) ? zone.trendline.points : [];
    const points: Array<{ t: number; p: number }> = [];
    for (const point of rawPoints) {
      const t = num(point?.time);
      const p = num(point?.price);
      if (t == null || p == null || p <= 0) continue;
      if (t < opts.t0 || t > opts.t1) continue;
      points.push({ t, p });
    }
    points.sort((a, b) => a.t - b.t);
    if (points.length < minPoints) continue;
    out.push({
      id: String(zone.id ?? `${kind}-${points[0].t}`),
      kind,
      side: sideOf(kind),
      points,
      state: String(zone.state ?? '')
    });
  }
  return out;
}
