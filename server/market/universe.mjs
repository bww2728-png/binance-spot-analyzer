/* نطاق العمل المحدود (working universe) — حدّ أعلى قابل للضبط لرموز التحليل.
 *
 * العلة الجذرية التي يُصلحها هذا الملف (OOM إنتاجي مثبت بالسجلات):
 * `resolveTargets()` بلا سقف كانت تُعيد **كل** العملات الحلال المتداولة (~1200+)،
 * و`warmUniverseAtBoot` يبذرها × 14 فريماً ≈ 16,800 مفتاح في المخزن المجمّع عند
 * الإقلاع. وكل مفتاح يحجز `Float64Array` بسعة `LIQUIDITY_AGGREGATE_CAPACITY` × 64
 * بايت مقدماً (16,800 × 500 × 64 ≈ 537MB)، فيبلغ الـheap حدّه فيموت V8 عند
 * ~594MB/640MB. السقف هنا يقيّد النطاق قبل البذر فلا تُبنى القنبلة أصلاً.
 *
 * المقايضة المعلنة (لا صامتة): تغطية أقل مقابل استقرار الحاوية على حدّ 1GB. لا يمسّ
 * أي عتبة قرار/دخول/خروج/هدف/وقف — يحدّ عدد الرموز المُحلَّلة فقط.
 *
 * ترتيب الأفضلية: لا يتوفر حالياً حقل «حجم يومي» في طبقة البيانات (القاعدة تحمل
 * الحكم الشرعي والسعر لا الحجم)، فالسقف **صريح وموثّق** ويحفظ ترتيب المصدر. العميل
 * يمكنه رفعه عبر `LIVE_UNIVERSE_LIMIT` ضمن المدى الآمن [150, 600].
 */

/** أدنى سقف: تحته تنقص التغطية بلا داعٍ (يكفي ~150 رمزاً لتشغيل كل المحركات). */
export const UNIVERSE_MIN = 150;
/** أقصى سقف: فوقه يتجاوز مخزن الشموع ميزانية ذاكرة الحاوية (انظر العلاقة في .env.example). */
export const UNIVERSE_MAX = 600;
/**
 * الافتراضي 300: يُبقي المخزن المجمّع الآمن.
 * العلاقة: keys = 300 × 14 فريماً = 4,200 مفتاح، وbytes = keys × capacity × 64B.
 * بسعة 500 ⇒ ~134MB، وبسعة 400 ⇒ ~107MB — ضمن ميزانية heap 640MB بأريحية.
 */
export const UNIVERSE_DEFAULT = 300;

/**
 * يقرأ سقف نطاق العمل من البيئة ويقيّده ضمن [UNIVERSE_MIN, UNIVERSE_MAX].
 * قيمة غائبة/غير صالحة/غير موجبة ⇒ الافتراضي المتحفظ (لا تعطيل، لا انفجار).
 * @param {Record<string,string|undefined>} [env]
 * @returns {number}
 */
export function universeLimitFromEnv(env = process.env) {
  const raw = Number(env?.LIVE_UNIVERSE_LIMIT);
  if (!Number.isFinite(raw) || raw <= 0) return UNIVERSE_DEFAULT;
  return Math.max(UNIVERSE_MIN, Math.min(UNIVERSE_MAX, Math.floor(raw)));
}

/**
 * يقتصر قائمة الرموز على السقف بترتيب حتمي (يحفظ ترتيب المصدر لا يخلطه).
 * `limit` غير صالح (NaN/سالب) ⇒ بلا قص (سلوك احتياطي محافظ لا يُخفي شيئاً بصمت).
 * @template T
 * @param {T[]} symbols
 * @param {number} limit
 * @returns {T[]}
 */
export function capUniverse(symbols, limit) {
  const list = Array.isArray(symbols) ? symbols : [];
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : list.length;
  return cap >= list.length ? list.slice() : list.slice(0, cap);
}
