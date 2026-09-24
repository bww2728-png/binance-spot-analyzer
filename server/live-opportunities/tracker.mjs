/* آلة حالة الفرص الحية — تتبع مستمر بلا انقطاع لكل (زوج × فريم × منطقة SSL)
 *
 * الفكرة: المخزون الحي لمحرك مناطق السيولة يُحدَّث تلقائياً، فنُشغّل عليه آلة حالة
 * سريعة تعتمد على الانتقالات (لا على لقطة واحدة) — وهذا يمنع الالتباس بين سويب جديد
 * وسويب قديم، ويكشف لحظة الاستعادة بدقة.
 *
 * حتمية بالكامل: نفس (الحالة السابقة + الملاحظة) تعطي نفس (الحالة التالية + الأحداث).
 */

import { sweepPhase } from './scanner.mjs';

/** ترتيب الفريمات المعتمد: من الأدق إلى الأكبر (يبدأ من الدقيقة كما هو مطلوب) */
export const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'];

export const tfRank = (tf) => {
  const i = TF_ORDER.indexOf(String(tf));
  return i < 0 ? TF_ORDER.length : i;
};

/** ثواني الفريم الواحد */
export const tfSeconds = (tf) => {
  const s = String(tf);
  const n = parseInt(s, 10) || 1;
  const unit = s.replace(/[0-9]/g, '');
  const mult = { m: 60, h: 3600, d: 86400, w: 604800 }[unit] || 3600;
  return n * mult;
};

export const trackerKey = (symbol, timeframe, zoneId) => `${symbol}|${timeframe}|${zoneId}`;

/**
 * تهيئة حالة منطقة:
 * - منطقة مسحوبة حديثاً (sweptAt ضمن نافذة النضارة) → swept مباشرة مع حفظ وقت السويب
 * - منطقة مسحوبة قديماً → armed مع وسم staleSweep (لا تُنشر فرصة على سويب قديم)
 * - غير ذلك → armed
 */
export function initTracker(zone, now, { freshnessBars = 6 } = {}) {
  const tfSec = tfSeconds(zone?.timeframe);
  const sweptAtSec = Number(zone?.sweptAt);
  const ageSec = Number.isFinite(sweptAtSec) ? now / 1000 - sweptAtSec : null;
  const fresh = ageSec != null && ageSec >= 0 && ageSec <= freshnessBars * tfSec;
  const isSwept = zone?.state === 'swept';
  return {
    key: trackerKey(zone?.symbol, zone?.timeframe, zone?.id),
    symbol: zone?.symbol ?? null,
    timeframe: zone?.timeframe ?? null,
    zoneId: zone?.id ?? null,
    kind: zone?.kind ?? null,
    referenceLevel: Number(zone?.referenceLevel),
    liquidityLevel: Number(zone?.liquidityLevel),
    phase: isSwept && fresh ? 'swept' : 'armed',
    staleSweep: Boolean(isSwept && !fresh),
    sweepObservedAt: isSwept && fresh ? sweptAtSec * 1000 : null,
    sweepLow: isSwept && fresh ? Number(zone?.liquidityLevel) : null,
    attempts: 0,
    publishedKey: null,
    invalidatedAt: null,
    createdAt: now,
    updatedAt: now,
    geometry: null,
    lastReason: null
  };
}

/**
 * تقدّم الحالة خطوة واحدة:
 * - swept جديد → تسجيل وقت السويب وأدنى قاع
 * - انتهاء نافذة النضارة بلا استعادة → إبطال (فشل السويب) مع زيادة عدّاد المحاولات
 * - كسر حقيقي → إبطال فوري (سيناريو: يُسلَّح ما تحته)
 * - reclaimed → حدث استعادة (مرشح للتأكيد والخطة)
 */
export function advanceTracker(prev, {
  zone, price, atr, now, freshnessBars = 6, approachAtr = 1.5, breakAtr = 0.6
} = {}) {
  const base = prev ?? initTracker(zone, now, { freshnessBars });
  const events = [];
  const res = sweepPhase({ zone, price, atr, prev: base.phase, approachAtr, breakAtr });
  const tfSec = tfSeconds(zone?.timeframe ?? base.timeframe);

  const next = {
    ...base,
    kind: zone?.kind ?? base.kind,
    referenceLevel: Number(zone?.referenceLevel ?? base.referenceLevel),
    liquidityLevel: Number(zone?.liquidityLevel ?? base.liquidityLevel),
    phase: res.phase,
    geometry: res.geometry,
    lastReason: res.reason,
    updatedAt: now
  };

  if (res.phase === 'swept') {
    if (base.phase !== 'swept') {
      next.sweepObservedAt = now;
      next.sweepLow = Number(price);
      next.staleSweep = false;
      events.push({ type: 'sweep', at: now, price: Number(price) });
    } else {
      next.sweepLow = Math.min(Number(base.sweepLow ?? price), Number(price));
    }
    const ageSec = next.sweepObservedAt ? (now - next.sweepObservedAt) / 1000 : 0;
    if (next.sweepObservedAt && ageSec > freshnessBars * tfSec) {
      next.phase = 'invalidated';
      next.invalidatedAt = now;
      next.attempts = (base.attempts ?? 0) + 1;
      next.lastReason = 'انتهت نافذة السويب بلا استعادة — إبطال';
      events.push({ type: 'expired', at: now });
    }
  } else if (res.phase === 'invalidated') {
    next.invalidatedAt = now;
    next.attempts = (base.attempts ?? 0) + 1;
    events.push({ type: 'invalidated', at: now, price: Number(price) });
  } else if (res.phase === 'reclaimed') {
    if (base.phase !== 'reclaimed' && base.phase !== 'published') {
      events.push({ type: 'reclaim', at: now, price: Number(price) });
    }
    next.staleSweep = false;
  }

  return { next, events };
}

/** وسم الفرصة كمنشورة (يمنع التكرار لنفس السويب) */
export function markPublished(state, publishKey, now) {
  return { ...state, phase: 'published', publishedKey: publishKey, publishedAt: now, updatedAt: now };
}

/** هل يمكن نشر فرصة من هذه الحالة؟ (استعادة مكتملة + سويب طازج + غير منشورة لنفس السويب) */
export function canPublish(state, publishKey) {
  if (!state) return false;
  if (state.staleSweep) return false;
  if (state.phase !== 'reclaimed') return false;
  if (!state.sweepObservedAt) return false;
  return state.publishedKey !== publishKey;
}

/** مفتاح النشر: نفس المنطقة + نفس لحظة السويب = فرصة واحدة فقط */
export const publishKeyFor = (state) => `${state.key}|${state.sweepObservedAt ?? 0}`;

/**
 * قائمة المراقبة: مناطق SSL مرتبة بـ (الفريم تصاعدياً ← المسافة إلى مستوى السيولة تصاعدياً).
 * تُستبعد: المناطق البعيدة أكثر من maxDistancePct، والمُبطَلة، والمستبعدة صراحةً.
 */
export function pickWatchlist(zones, price, {
  limit = 120, excludeIds = [], maxDistancePct = 0.3, includeSwept = true
} = {}) {
  const ex = new Set(excludeIds);
  const p = Number(price);
  const rows = [];
  for (const zone of zones ?? []) {
    if (!String(zone?.kind ?? '').includes('ssl')) continue;
    if (ex.has(zone.id)) continue;
    if (!includeSwept && zone.state === 'swept') continue;
    const liq = Number(zone.liquidityLevel ?? zone.referenceLevel);
    if (!Number.isFinite(liq)) continue;
    const distancePct = Number.isFinite(p) && p > 0 ? Math.abs(p - liq) / p : Number.POSITIVE_INFINITY;
    if (distancePct > maxDistancePct) continue;
    rows.push({
      zone,
      distancePct,
      distanceAtr: Number.isFinite(Number(zone.atr)) && Number(zone.atr) > 0 ? Math.abs(p - liq) / Number(zone.atr) : null
    });
  }
  rows.sort((a, b) =>
    tfRank(a.zone.timeframe) - tfRank(b.zone.timeframe) ||
    a.distancePct - b.distancePct);
  return rows.slice(0, limit);
}

/** تنظيف الحالات الميتة (مناطق خرجت من المخزون أو مضى عليها زمن طويل) */
export function pruneTrackers(trackers, liveKeys, now, { maxAgeMs = 6 * 3600_000 } = {}) {
  const removed = [];
  for (const [key, st] of trackers) {
    const live = liveKeys.has(key);
    const stale = now - (st.updatedAt ?? 0) > maxAgeMs;
    if (!live || (stale && st.phase !== 'published')) {
      trackers.delete(key);
      removed.push(key);
    }
  }
  return removed;
}
