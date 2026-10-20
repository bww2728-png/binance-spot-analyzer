/**
 * ★3 — قياس أثر عدّ شرائح النتائج الحية (وحدة نقية قابلة للاختبار).
 *
 * العيب المقيس: `trackOutcomes` يزيد `trades` في **كل نداء متابعة** (~5 ثوان) لكل فرصة
 * لم تُحسم بعد. فرصة واحدة تبقى مفتوحة ساعات تعني مئات «الصفقات» الوهمية في شريحتها،
 * فمنطق ترقية الشرائح التجريبية إلى مؤهّلة يعتمد على مدة الانتظار لا على النتائج.
 *
 * هذا القياس يحسب العدّ بالقاعدة الصحيحة (مرة واحدة عند الحسم) بجانب العدّ المنشور،
 * ويعرض الفرق. لا يُقرأ في أي قرار — دليل للقرار فقط.
 */

/**
 * @param {Map<string,{trades:number,wins:number}>} published العدّ المنشور في المحرك
 * @param {Map<string,{trades:number,wins:number}>} decided العدّ الظلّي (عند الحسم فقط)
 * @param {number} minTrades حدّ تأهيل الشريحة (من إعدادات المحرك كما هي)
 */
export function buildSegmentShadowReport(published, decided, minTrades) {
  const pub = published instanceof Map ? published : new Map();
  const dec = decided instanceof Map ? decided : new Map();
  let publishedTotal = 0;
  let decidedTotal = 0;
  let qualifiedPublished = 0;
  let qualifiedDecided = 0;
  const min = Number(minTrades);
  for (const [, s] of pub) {
    const t = Number(s?.trades ?? 0);
    publishedTotal += t;
    if (t >= min) qualifiedPublished += 1;
  }
  for (const [, s] of dec) {
    const t = Number(s?.trades ?? 0);
    decidedTotal += t;
    if (t >= min) qualifiedDecided += 1;
  }
  return {
    keys: pub.size,
    publishedTotal,
    decidedTotal,
    /** كم مرة تضخّم العدّ المنشور عن العدّ الصحيح */
    inflation: publishedTotal === 0 ? null : Number((publishedTotal / Math.max(decidedTotal, 1)).toFixed(2)),
    minSegmentTrades: min,
    /** الشرائح التي تعدّ «مؤهّلة» بالقاعدتين — الفرق هنا هو أثر الإصلاح ★3 */
    qualifiedPublished,
    qualifiedDecided,
    qualifiedDiff: qualifiedPublished - qualifiedDecided
  };
}

/**
 * تسجيل فرصة مرة واحدة عند حسمها (القاعدة الصحيحة)، مع منع العدّ المزدوج لنفس الفرصة.
 * @returns {boolean} هل سُجّلت الآن (false يعني: مفتوحة بعد، أو مُسجَّلة سابقاً)
 */
export function countDecidedOnce(countedIds, segments, id, outcome, segmentKey) {
  if (!segmentKey || !id || !outcome) return false;
  if (countedIds.has(id)) return false;
  countedIds.add(id);
  const s = segments.get(segmentKey) ?? { trades: 0, wins: 0 };
  s.trades += 1;
  if (outcome === 'target') s.wins += 1;
  segments.set(segmentKey, s);
  return true;
}
