/**
 * مثبّت حلقة الأحداث للاختبارات التي تعتمد على مؤقّتات `unref()`ed.
 *
 * المشكلة المُثبتة: `net/limiter.mjs` و`services/workerPool.mjs` يستدعيان `unref()` على
 * مؤقّتاتهما — وهذا **صحيح للإنتاج** (لا يجوز أن يُبقي مؤقّت داخلي عملية الخادم حيّة).
 * لكن الاختبار الذي ينتظر وعداً يُحلّ بواسطة ذلك المؤقّت يترك حلقة الأحداث بلا أي مقبض
 * مرجعي، فيحكم مشغّل الاختبارات أن الحلقة انتهت ويُلغي الاختبار:
 *
 *   failureType: 'cancelledByParent'
 *   error: 'Promise resolution is still pending but the event loop has already resolved'
 *
 * القياس: على Node 22.23.4 (نسخة الإنتاج المعلنة) تُلغى 10 اختبارات في ملفَّي
 * `rateLimiterPump` و`workerPool` ويعود المشغّل بالرمز 1؛ وعلى Node 24.18 تمرّ.
 * أي أن CI على نسخة الإنتاج لا يستطيع الحكم على المشروع إطلاقاً.
 *
 * الحل: مقبض مرجعي واحد طوال عمر الملف، يُحرَّر في خطّاف `after`. لا يُعدِّل أي تأكيد
 * ولا يُخفِّف أي شرط، ولا يمسّ كود الإنتاج.
 */
export function holdEventLoop({ everyMs = 250 } = {}) {
  const timer = setInterval(() => {}, everyMs);
  return () => clearInterval(timer);
}

export default holdEventLoop;
