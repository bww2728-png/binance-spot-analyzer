/* السجل التاريخي للتحديد الآلي (منطق فابيو) — قراءة عميقة من أحداث auto_zones_snapshot.
 * دوال حتمية قابلة للاختبار بلا شبكة:
 * - isFabioZone: هل المنطقة وُلدت من منطق المزاد (فابيو)؟ meta أولاً ثم الأسباب (للتاريخ القديم).
 * - flattenSnapshots: تفكيك لقطات الصفحات إلى صفوف جدول مسطحة مع الفلاتر.
 * - zoneKeyOf: مفتاح مستقر لربط صورة الشارت بالمنطقة عبر اللقطات.
 */

/** ماركرات منطق المزاد في نص الأسباب — نفس قائمة فحص الحيوية المستخدمة في النشر */
export const FABIO_REASON_MARKERS = [
  'منطقة القيمة', 'عقدة حجم منخفض', 'اليوم السابق',
  'ندرة حادة', 'فتكة سيولة', 'إعادة اختبار', 'فقاعة'
];

const FABIO_META = new Set(['profile_edge', 'profile_edge_retest', 'profile_lvn', 'prev_day']);

/** هل المنطقة من منطق المزاد (فابيو)؟ */
export function isFabioZone(zone) {
  if (!zone) return false;
  if (FABIO_META.has(zone.meta)) return true;
  const text = (zone.reasons ?? []).join(' ');
  return FABIO_REASON_MARKERS.some(m => text.includes(m));
}

/** مفتاح مستقر: نفس المنطقة عبر اللقطات المتتالية تعطي نفس المفتاح
 * الشبكة مشتركة (مثبتة عشرياً): تقريب إلى 4 أرقام معنوية ≈ دقة 0.05% لأي magnitude،
 * فانزياح السعر الطفيف بين الجولات يبقى داخل نفس السلة، ومفتاح حدود الشبكة نادر ومقبول.
 */
export function zoneKeyOf(zone) {
  const p = Number(zone.price);
  const bucket = p > 0 ? String(Number(p.toPrecision(4))) : String(zone.price);
  return `${zone.symbol}|${zone.timeframe ?? ''}|${zone.type}|${bucket}`;
}

/**
 * تفكيك أحداث auto_zones_snapshot إلى صفوف مسطحة للجدول.
 * filters: { symbol, timeframe, type, minScore, from, to, fabioOnly }
 * كل صف: snapshotTs + كل حقول المنطقة + zoneKey. التنسيق تنازلي بالزمن.
 */
export function flattenSnapshots(rawEvents, filters = {}) {
  const { symbol, timeframe, type, minScore, from, to, fabioOnly = true } = filters;
  const rows = [];
  for (const e of rawEvents ?? []) {
    const snap = tryParse(e?.meta);
    if (!snap?.zones?.length) continue;
    const snapshotTs = Number(e.ts ?? snap.ts ?? 0);
    const snapSymbol = String(e.symbol ?? snap.symbol ?? '').toUpperCase();
    if (symbol && snapSymbol !== symbol.toUpperCase()) continue;
    if (from && snapshotTs < Number(from)) continue;
    if (to && snapshotTs > Number(to)) continue;
    for (const z of snap.zones) {
      if (timeframe && (z.timeframe ?? '') !== timeframe) continue;
      if (type && z.type !== type) continue;
      if (minScore != null && Number(z.score ?? 0) < Number(minScore)) continue;
      if (fabioOnly && !isFabioZone(z)) continue;
      rows.push({
        zoneKey: zoneKeyOf({ ...z, symbol: snapSymbol }),
        snapshotTs,
        computedAt: Number(snap.ts ?? snapshotTs),
        eventId: Number(e.id ?? 0),
        symbol: snapSymbol,
        id: z.id,
        type: z.type,
        price: z.price,
        timeframe: z.timeframe ?? '',
        score: z.score,
        reasons: z.reasons ?? [],
        clusterCount: z.clusterCount,
        swept: Boolean(z.swept),
        sweptAt: z.sweptAt ?? null,
        bandPct: z.bandPct,
        anchorTime: z.anchorTime,
        feedback: z.feedback ?? null,
        note: z.note ?? '',
        created_at: z.created_at,
        meta: z.meta ?? 'structural',
        side: z.side ?? null
      });
    }
  }
  rows.sort((a, b) => b.snapshotTs - a.snapshotTs || b.eventId - a.eventId);
  return rows;
}

function tryParse(s) {
  try { return JSON.parse(s ?? 'null'); } catch { return null; }
}

/**
 * دمج الصفوف حسب zoneKey: لكل منطقة أبقَ أحدث ظهور مع firstSeen/lastSeen/عدد الظهورات.
 * يحول تدفقاً زمنياً من اللقطات إلى سجل حي لكل منطقة — أغنى معلومةاً وأخف حجماً بكثير.
 * الإدخال تنازلي بالزمن (ناتج flattenSnapshots): أول ظهور في اللف هو الأحدث.
 */
export function dedupeByZoneKey(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const existing = byKey.get(r.zoneKey);
    if (!existing) {
      byKey.set(r.zoneKey, { ...r, firstSeen: r.snapshotTs, lastSeen: r.snapshotTs, appearances: 1 });
    } else {
      existing.appearances += 1;
      existing.firstSeen = r.snapshotTs;
      if (r.swept && !existing.swept) existing.swept = true;
      if (r.feedback && !existing.feedback) existing.feedback = r.feedback;
      if (!existing.note && r.note) existing.note = r.note;
      if (r.sweptAt && !existing.sweptAt) existing.sweptAt = r.sweptAt;
    }
  }
  return [...byKey.values()];
}

/** حد أقصى آمن للصفحة */
export function clampPage(limit, offset, maxLimit = 500) {
  return {
    limit: Math.min(Math.max(1, Number(limit) || 200), maxLimit),
    offset: Math.max(0, Number(offset) || 0)
  };
}
