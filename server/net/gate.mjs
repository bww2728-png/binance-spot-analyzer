/**
 * نقطة حقن واحدة لمحدد المعدل الموحّد لكل نداءات بينانس.
 *
 * السبب (إصلاح B6 — الجزء الناقص): المحدد كان موصولاً بـ`server/db.js` وحده، فبقي
 * مساران يخترقانه: عمق السوق (`liquidity/orderbook.mjs`) كان بلا أي تنظيم، والمشتقات
 * (`liquidity/derivatives.mjs`) كان لها فاصل زمني محلي بسيط بلا دلو أوزان ولا أولويات.
 * النتيجة: الانفجار نفسه من نفس العنوان الذي أُصلح في المسار الأول يعود من مسارين آخرين.
 *
 * الفصل في وحدة مستقلة مقصود لتفادي الدورة: `db.js` ← `liquidity/engine.mjs` ←
 * `liquidity/orderbook.mjs`؛ فلو استورد الأخير `db.js` لنشأت دورة استيراد.
 */
const WEIGHTS = {
  '/api/v3/klines': 2,
  '/api/v3/ticker/price': 2,
  '/api/v3/exchangeInfo': 20,
  '/api/v3/depth': 5,
  '/api/v3/aggTrades': 2
};

/** وزن المسار بحسب جدول بينانس الرسمي (الأخفض افتراضاً = الأكثر تحفظاً) */
export function weightOf(path) {
  const p = String(path).split('?')[0];
  return WEIGHTS[p] ?? 2;
}

let limiter = null;

/** حقن المحدد (يُستدعى مرة واحدة من الخادم، وقابل للحقن في الاختبارات) */
export function setRateLimiter(instance) { limiter = instance ?? null; }
export function getRateLimiter() { return limiter; }

/** انتظار الدور قبل أي نداء شبكي — لا نداء بلا دور حين يكون المحدد موصولاً */
export async function gate(priority = 'live', weight = 2) {
  if (!limiter) return;
  await limiter.acquire(priority, Math.max(1, Number(weight) || 1));
}

/** تغذية راجعة عند الرفض (429/418) ليفرض المحدد حظراً بدل تكرار المخالفة */
export function reportRateLimit(status, retryAfterMs = 0) {
  limiter?.report(status, retryAfterMs);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * سقف الانتظار عند 429/418 داخل الطلب نفسه. Retry-After من بينانس قد يكون دقائق
 * (خصوصاً 418)؛ الانتظار الكامل داخل الحلقة الحية يجمّد دورة كاملة. لذلك: ننتظر
 * بقدر ما يسمح السقف، ويبقى الحظر الكامل مفروضاً على **كل** الطلبات اللاحقة في المحدد.
 */
export const RATE_WAIT_CAP_MS = Math.max(0, Number(process.env.BINANCE_RATE_WAIT_CAP_MS ?? 30_000));
