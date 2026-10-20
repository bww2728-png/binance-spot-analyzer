/* محدد معدل الطلبات الموحّد — نقطة اختناق واحدة لكل نداءات بينانس REST
 *
 * المشكلة: عدة محركات (سيولة حية/تاريخية، فرص حية، استراتيجية 2، معايرة، باك تيست)
 * تتنافس على نفس حدود REST بلا تنظيم موحد → 429/418 وفشل بيانات صامت.
 *
 * التصميم:
 *  - دلو أوزان: كل نداء بوزن بينانس الرسمي للمسار، وسقف وزن/دقيقة قابل للضبط
 *    (الحد الافتراضي 6000/د — نشغّل عند 70% كحد أمان).
 *  - صفوف أولويات: live (فرص/محركات حية) > calibration (معايرة) > history (باك تيست/تاريخي).
 *    الأولوية الأعلى تُخدم أولاً عند التنافس، والأدنى ينتظر.
 *  - backoff: عند 429/418 يُفرض انتظار على كل الصفوف (احترام Retry-After إن وُجد).
 *
 * الاستخدام:
 *   const gate = limiter('live', 10);      // أولوية live، وزن 10
 *   await gate;                            // انتظار الدور
 *   ... النداء ...
 *   limiter.report(429, retryAfterMs);     // تغذية راجعة عند الرفض
 */

const WEIGHTS = {
  // أوزان بينانس الرسمية للمسارات المستخدمة في النظام
  '/api/v3/klines': 2,
  '/api/v3/ticker/price': 2,        // لكل رمز في الطلب (بدون symbols = 4)
  '/api/v3/exchangeInfo': 20,
  '/api/v3/depth': 5,
  '/api/v3/aggTrades': 2
};

const PRIORITIES = ['live', 'calibration', 'history'];

export function createRateLimiter({
  minuteBudget = 4200,          // ~70% من حد بينانس 6000 وزن/دقيقة
  now = () => Date.now(),
  pumpMs = 250,                 // دورية تحرير المنتظرين
  log = console
} = {}) {
  const queues = new Map(PRIORITIES.map(p => [p, []])); // p → [{resolve, weight}]
  const waiters = new Map(PRIORITIES.map(p => [p, 0]));
  let usedInWindow = 0;
  let windowStart = now();
  let blockedUntil = 0;         // backoff عند 429/418
  let statsTotal = 0, statsWaited = 0, statsBlocked = 0;

  function refillIfNeeded() {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      usedInWindow = 0;
    }
  }

  function available() {
    refillIfNeeded();
    return now() >= blockedUntil && usedInWindow < minuteBudget;
  }

  /**
   * تحرير المنتظرين.
   *
   * عطل مُثبت ومُقاس: `pump` كانت مُعرَّفة ولا يُستدعى لها أحد، فلا يُحرَّر أي طلب يدخل
   * الصف أبداً. ظهر أثره عملياً عند بذر مخزن الشموع: توقّف البذر عند 3,102 مفتاح من
   * 6,006، و`waiting: 104` ثابتة أربع دقائق مع `usedInWindow: 26` من 4,200 — أي أن
   * السعة كانت متاحة والمنتظرون موقوفون. كان العطل كامناً لأن النظام سابقاً لم يبلغ
   * ضغطاً كافياً يدخل به مسار الانتظار.
   */
  function pump() {
    if (!available()) return;
    // أعلى أولوية أولاً
    for (const p of PRIORITIES) {
      const q = queues.get(p);
      while (q.length && available()) {
        // لا نبدأ نداءً لن نستطيع تغذيته كاملاً — ينتظر النافذة التالية
        if (usedInWindow + q[0].weight > minuteBudget) return;
        usedInWindow += q[0].weight;
        statsTotal += 1;
        const job = q.shift();
        job.resolve();
      }
      if (q.length) return; // الأولوية الأعلى ليست فارغة — الأدنى ينتظر
    }
  }

  /**
   * نبضة دورية + نبضة عند دخول أول منتظر.
   * الدورية وحدها لا تكفي: قد يمتلئ الوزن داخل النافذة ثم يتحرّر بعد أقل من ثانية،
   * فالدورية تلحق ذلك. ودخول منتظر يستدعي pump فوراً لتفادي انتظار دورة كاملة.
   * المؤقّت `unref` كي لا يمنع خروج العملية.
   */
  let pumpTimer = null;
  function ensurePumpTimer() {
    if (pumpTimer) return;
    pumpTimer = setInterval(() => {
      try { pump(); } catch (e) { log.warn?.(`[rate-limiter] pump failed: ${e?.message ?? e}`); }
      if (PRIORITIES.every(p => (queues.get(p)?.length ?? 0) === 0)) {
        clearInterval(pumpTimer);
        pumpTimer = null;
      }
    }, pumpMs);
    if (pumpTimer.unref) pumpTimer.unref();
  }

  /** الحصول على دور لنداء بوزن معين وبأولوية معينة */
  async function acquire(priority = 'live', weight = 2) {
    const w = Math.max(1, Math.min(Number(weight) || 1, 1200));
    refillIfNeeded();
    if (available() && usedInWindow + w <= minuteBudget) {
      const p = String(priority);
      // عدالة: لا تقفز الصف إذا صف أعلى أولوية فيه منتظرون
      const hi = PRIORITIES.indexOf(String(priority));
      let jump = false;
      for (let i = 0; i < hi; i++) if (waiters.get(PRIORITIES[i]) > 0) { jump = true; break; }
      if (!jump) {
        usedInWindow += w;
        statsTotal += 1;
        return;
      }
    }
    const p = String(priority);
    statsWaited += 1;
    waiters.set(p, (waiters.get(p) ?? 0) + 1);
    /**
     * الأولوية المجهولة تُسقَط إلى 'live' بدل الوصول إلى `undefined.push`.
     * بلا هذا كان أي اسم أولوية غير معروف يُنتج خطأً يُبتلع في `guard`، فلا يُنفَّذ
     * النداء ولا يظهر سببه في أي سجل ولا في الصحة.
     */
    const queue = queues.get(p) ?? queues.get('live');
    ensurePumpTimer();
    await new Promise(resolve => queue.push({ resolve, weight: w }));
    waiters.set(p, Math.max(0, (waiters.get(p) ?? 1) - 1));
    // نبضة بعد الخروج: تُفسح للصفوف الأدنى بالاستفادة من السعة المتبقية
    try { pump(); } catch { /* لا يعطّل النداء */ }
  }

  /** تغذية راجعة عند رفض الشبكة */
  function report(status, retryAfterMs = 0) {
    const s = Number(status);
    if (s === 429 || s === 418) {
      const wait = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : (s === 418 ? 120_000 : 20_000);
      blockedUntil = Math.max(blockedUntil, now() + wait);
      usedInWindow = Math.max(usedInWindow, minuteBudget * 0.5); // تهدئة إجبارية
      statsBlocked += 1;
      log.warn?.(`[rate-limiter] ${s} — block ${Math.round(wait / 1000)}s`);
      // المنتظرون يجب أن يستيقظوا بعد انتهاء الحظر، لا أن يبقوا معلّقين للأبد
      ensurePumpTimer();
    }
  }

  function stats() {
    refillIfNeeded();
    return {
      usedInWindow,
      minuteBudget,
      utilization: Number((usedInWindow / minuteBudget).toFixed(3)),
      blockedUntil: blockedUntil > now() ? blockedUntil : null,
      total: statsTotal,
      waited: statsWaited,
      blocked: statsBlocked,
      waiting: PRIORITIES.reduce((a, p) => a + (queues.get(p)?.length ?? 0), 0)
    };
  }

  /** حزمة مساعدة: نداء محمي كامل */
  async function guard(path, fn, { priority = 'live' } = {}) {
    const weight = Object.entries(WEIGHTS).find(([p]) => path.startsWith(p))?.[1] ?? 2;
    await acquire(priority, weight);
    try {
      return await fn();
    } catch (e) {
      const status = e?.status ?? e?.response?.status;
      if (status === 429 || status === 418) report(status);
      throw e;
    }
  }

  return { acquire, report, stats, guard, _queues: queues };
}
