/* أدوات أرشيف المناطق — نقية وقابلة للاختبار بلا شبكة.
 * أحداث events_log (نوع liquidity_zone) هي سجل إلحاقي: كل إنشاء/تعديل/حذف
 * يضيف نسخة كاملة. groupZoneHistory يعيد سلاسل النسخ لكل منطقة مع تمييز
 * الإجراء (إنشاء/تعديل/حذف) واكتشاف المناطق المحذوفة — دون افتراض أي ترتيب معين.
 */

/** تغيير من chunk الحقول إلى حزام منسق */
export function parseZoneMeta(event) {
  if (!event || typeof event.meta !== 'string') return null;
  try {
    const z = JSON.parse(event.meta);
    if (!z || typeof z.id !== 'string' || z.source === 'auto') return null;
    return z;
  } catch {
    return null;
  }
}

/**
 * يُجمّع الأحداث (أي ترتيب) حسب zone.id مع الحفاظ على الترتيب الزمني داخل كل سلسلة.
 * - action: 'create' للنسخة الأولى، 'edit' للنسخ الوسطية، 'delete' آخر نسخة غير فعّالة.
 * - deleted: ما إذا كانت آخر نسخة للمنطقة active === false.
 * الناتج مرتّب حسب زمن آخر نسخة تنازلياً.
 */
export function groupZoneHistory(rawEvents) {
  const groups = new Map();
  for (const e of rawEvents ?? []) {
    const zone = parseZoneMeta(e);
    if (!zone) continue;
    const ts = Number(e.ts ?? 0);
    const chain = groups.get(zone.id) ?? [];
    chain.push({ eventId: Number(e.id ?? 0), ts, zone });
    groups.set(zone.id, chain);
  }

  const out = [];
  for (const [zoneId, chain] of groups) {
    chain.sort((a, b) => a.ts - b.ts || a.eventId - b.eventId);
    const versions = chain.map((v, i) => {
      const action = i === 0 ? 'create' : (v.zone.active === false ? 'delete' : 'edit');
      return { eventId: v.eventId, ts: v.ts, zone: v.zone, action };
    });
    const last = versions[versions.length - 1];
    out.push({
      zoneId,
      symbol: String(last.zone.symbol ?? '').toUpperCase(),
      versions,
      deleted: last.zone.active === false,
      lastVersion: last
    });
  }

  out.sort((a, b) => (b.lastVersion.ts - a.lastVersion.ts) || (b.lastVersion.eventId - a.lastVersion.eventId));
  return out;
}