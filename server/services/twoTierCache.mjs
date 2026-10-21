/**
 * كاش بطبقتين لبيانات تُقرأ كثيراً وتتغيّر بوتيرتين مختلفتين (مناطق السيولة).
 *
 * العيب المؤكد (B2): مراقب المناطق يعمل كل 30 ثانية، وكان يقرأ `listAll` كاملة في كل
 * مرة — أي حتى 5000 حدث مناطق + 60 لقطة آلية + 1000 تغذية راجعة كل نصف دقيقة. والكاش
 * الموجود (نافذة 5 ثوانٍ) لا يحمي شيئاً لأن 30 ثانية أكبر من 5.
 *
 * الحل: فصل الطبقة اليدوية (يكتبها المستخدم؛ نافذة قصيرة + إبطال فوري عند الكتابة)
 * عن الطبقة الآلية (يكتبها الفحص الدوري كل دقائق؛ نافذة أطول + إبطال بعد كل كتابة).
 * والنتيجة **تُقاس**: عدّادات الجلب الفعلي لكل طبقة تُعرض في الفحص الصحي، فلا يكون
 * التخفيف ادّعاءً.
 *
 * وحدة نقية بلا شبكة: تُختبر بزمن مُحقون.
 */

export function createTwoTierCache({ fetchManual, fetchAuto, manualMs = 5000, autoMs = 120_000, now = () => Date.now() } = {}) {
  const state = { manual: null, manualTs: -1, auto: null, autoTs: -1 };
  /** عدّادات الجلب الفعلي (الطبقة الثقيلة أولاً في العرض) */
  /**
   * العدّادات تفصل **المحاولة** عن **النجاح**: `manualAttempts` يزيد قبل الشبكة،
   * و`manualFetches` يزيد عند وصول بيانات فعلية. بلا هذا الفصل يظهر «صفر جلب» عند
   * تعذّر القاعدة، فيُقرأ الرقم كأنه تخفيف ناجح بينما الحقيقة فشل متكرر.
   */
  const stats = { manualAttempts: 0, autoAttempts: 0, manualFetches: 0, autoFetches: 0, combined: 0, hitBoth: 0, errors: 0, lastErrorAt: null, lastGapMs: null, lastManualAt: null, lastAutoAt: null };
  let lastManualFetchAt = null;

  /**
   * «طازج» تعني: قيمتها موجودة فعلاً **ووقت تخزينها صالح**. الشرط `ts >= 0` لا `ts > 0`:
   * زمن مُحقون يبدأ من الصفر (كما في الاختبارات) كان يجعل الكاش يُعتبر بائتاً أبداً.
   */
  const fresh = (value, ts, windowMs) => value !== null && ts >= 0 && now() - ts < windowMs;

  async function get() {
    const manualFresh = fresh(state.manual, state.manualTs, manualMs);
    const autoFresh = fresh(state.auto, state.autoTs, autoMs);
    if (manualFresh && autoFresh) { stats.hitBoth += 1; return [...state.manual, ...state.auto]; }
    const t = now();
    const [manual, auto] = await Promise.all([
      manualFresh ? Promise.resolve(state.manual) : (stats.manualAttempts += 1, fetchManual().then((rows) => {
        stats.manualFetches += 1;
        /**
         * الفجوة الزمنية بين جلبتين متتاليتين للطبقة اليدوية: هي الدليل المقيس على
         * أن الكاش يمنع التكرار فعلاً (بلا هذا فنحن ندّعي التخفيف).
         */
        if (lastManualFetchAt != null) stats.lastGapMs = t - lastManualFetchAt;
        lastManualFetchAt = t;
        stats.lastManualAt = t;
        return rows;
      }).catch((e) => { stats.errors += 1; stats.lastErrorAt = now(); throw e; })),
      autoFresh ? Promise.resolve(state.auto) : (stats.autoAttempts += 1, fetchAuto().then((rows) => {
        stats.autoFetches += 1;
        stats.lastAutoAt = t;
        return rows;
      }).catch((e) => { stats.errors += 1; stats.lastErrorAt = now(); throw e; }))
    ]);
    if (!manualFresh) { state.manual = manual; state.manualTs = t; }
    if (!autoFresh) { state.auto = auto; state.autoTs = t; }
    stats.combined += 1;
    return [...state.manual, ...state.auto];
  }

  return {
    get,
    /** إبطال كامل — عند أي كتابة يدوية (تغيير فوري) */
    invalidate() { state.manual = null; state.manualTs = -1; state.auto = null; state.autoTs = -1; },
    /** إبطال الطبقة الآلية وحدها — لا يُهدِر كاش اليدوي */
    invalidateAuto() { state.auto = null; state.autoTs = -1; },
    stats: () => ({ ...stats, manualMs, autoMs, manualCached: fresh(state.manual, state.manualTs, manualMs), autoCached: fresh(state.auto, state.autoTs, autoMs) })
  };
}

export default createTwoTierCache;
