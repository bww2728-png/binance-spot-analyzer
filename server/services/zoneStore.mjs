/**
 * سياسة تخزين مخزون مناطق السيولة (ذاكرة).
 *
 * القياس على التشغيل الحقيقي: حجم المنطقة الواحدة ~2.5KB JSON. ودورة الفحص الكاملة
 * (429 زوجاً × 14 فريماً) تنتج ~27 ألف منطقة حيّة و~357 ألف منطقة تاريخية (~700MB)،
 * أي أن الخادم يقتل نفسه بالـOOM قبل إكمال أي تشغيل طويل على حاوية حدّها 1GB.
 *
 * الفصل هنا جوهري:
 *  - **التاريخي**: بيانات عرض ومراجعة فقط (لا محرك قرار يقرأها). فيُحفظ لكل
 *    (رمز، فريم) أحدث مسح فقط، مع سقف كلي يُسقط الأقدم. هذا يطابق سياسة الاحتفاظ
 *    المعتمدة (الاحتفاظ بأحدث اللقطات لكل رمز لا بكل التاريخ).
 *  - **الحي**: يقرأه محرك الفرص (`zoneSource`)، فلا يُحذف منه شيء داخل هذه الوحدة.
 *    الحماية الوحيدة المتاحة بلا تغيير سلوكي هي إيقاف **بدء** دورة جديدة عند بلوغ
 *    السقف، مع تصريح ظاهر في الصحة، بدل النمو المستمر حتى موت الحاوية.
 */

/** سقف المخزون التاريخي (عرض فقط): 40 ألف منطقة ≈ 100MB في الذاكرة */
export const DEFAULT_HISTORY_MAX_ZONES = 40_000;
/** سقف المخزون الحي: عنده تُؤجَّل الدورة الجديدة، ولا يُحذف أي منطقة */
export const DEFAULT_LIVE_MAX_ZONES = 40_000;

/** نفس دلالات `mergeLiquidityResults` الأصلية: مفتاح (رمز|فريم|معرّف)، ترتيب بالثقة */
export function mergeZones(rows, incoming) {
  const map = new Map(rows.map(r => [`${r.symbol}|${r.timeframe}|${r.id}`, r]));
  for (const zone of incoming) map.set(`${zone.symbol}|${zone.timeframe}|${zone.id}`, zone);
  return [...map.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

/**
 * كتابة مناطق زوج/فريم مع استبدال مسحه السابق.
 * الغرض: منع تراكم مسح قديم بجانب مسح جديد لنفس الزوج والفريم (نفس السبب في كل دورة).
 */
export function replacePairScan(rows, symbol, timeframe, zones) {
  const rest = rows.filter(r => !(r.symbol === symbol && r.timeframe === timeframe));
  return mergeZones(rest, zones);
}

/**
 * كتابة مناطق رمز كامل (كل فريماته) دفعة واحدة مع استبدال مسحه السابق.
 *
 * السبب: الاستبدال لكل فريم يعني فرز وتصفية 40 ألف صف × 14 فريماً × 429 زوجاً في كل
 * دورة، أي دقائق من CPU على نواة واحدة. تجميعه لكل زوج يجعل الكلفة مرة واحدة لكل زوج
 * (429 مرة في الدورة) بلا أي فرق في الناتج.
 */
export function replaceSymbolScan(rows, symbol, timeframes, zones) {
  const tfSet = new Set(timeframes);
  const rest = rows.filter(r => !(r.symbol === symbol && tfSet.has(r.timeframe)));
  return mergeZones(rest, zones);
}

/** إسقاط الأقدم عند تجاوز السقف (الأحدث أولاً بالاحتفاظ) */
export function boundByNewest(rows, cap) {
  if (!Number.isFinite(cap) || cap <= 0 || rows.length <= cap) return rows;
  const score = (r) => Number(r.detectedAt ?? r.at ?? r.confirmedAt ?? 0) || 0;
  return [...rows].sort((a, b) => score(b) - score(a)).slice(0, cap);
}

/** هل يُسمح ببدء دورة جديدة؟ (سقف <= 0 يعني بلا سقف) */
export function shouldStartRotation(currentCount, cap) {
  if (!Number.isFinite(cap) || cap <= 0) return true;
  return currentCount < cap;
}

/** الفحص الكامل للسياسة: يعني أن السقف مُفعَّل وأن المخزون بلغه */
export function capState(count, cap) {
  const bounded = Number.isFinite(cap) && cap > 0;
  return {
    capped: bounded && count >= cap,
    cap: bounded ? cap : null,
    count,
    usagePct: bounded ? Math.round((count / cap) * 100) : null
  };
}
