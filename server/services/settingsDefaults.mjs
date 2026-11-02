/**
 * ضمان صف الإعدادات الوحيد (`id = 1`).
 *
 * سبب الوجود: كان `ensureSettings()` يُستدعى في `/api/settings` بلا تعريف
 * (`server/index.js`)، فكان المسار يعيد 500 دائماً ويظهر في السجل
 * `[api] ensureSettings is not defined`. الوحدة هنا تجعل السلوك قابلاً للاختبار
 * بلا تشغيل خادم.
 *
 * القواعد:
 *  - الصف موجود ⇒ يُعاد كما هو (لا كتابة، لا تعديل صامت على إعدادات المستخدم).
 *  - الصف غائب ⇒ يُنشأ بالقيم الافتراضية المطابقة للمخطط (`000_full_schema.sql`).
 *  - سباق إنشاء (طلب متزامن) ⇒ يُقرأ الصف الذي أنشأه الآخر بدل إرجاع 500.
 *  - أي خطأ آخر يُرمى كما هو (لا نُخفي عطلاً حقيقياً).
 */

/** القيم الافتراضية مطابقة لأعمدة `public.settings` في `server/migrations/000_full_schema.sql`. */
export const DEFAULT_SETTINGS = Object.freeze({
  id: 1,
  quote: 'USDT',
  notify_timeout_min: 30,
  sound_enabled: true,
  sort_config: '{}'
});

const isDuplicate = (e) => /duplicate key|23505|settings_pkey/i.test(String(e?.message ?? ''));

/**
 * @param {{ get: () => Promise<object[]>, create: (row: object) => Promise<object[]> }} repo
 *   مستودع `settings` (اسمه `db.settings` في `server/db.js`).
 * @returns {() => Promise<object>} دالة `ensureSettings`
 */
export function createEnsureSettings(repo) {
  if (!repo || typeof repo.get !== 'function' || typeof repo.create !== 'function') {
    throw new TypeError('createEnsureSettings: repo.get/create مطلوبان');
  }
  return async function ensureSettings() {
    const rows = await repo.get();
    if (Array.isArray(rows) && rows[0]) return rows[0];

    try {
      const created = await repo.create({ ...DEFAULT_SETTINGS });
      if (Array.isArray(created) && created[0]) return created[0];
      // PostgREST قد يعيد صفاً بلا تمثيل عند غياب `Prefer: return=representation`
      const again = await repo.get();
      return (Array.isArray(again) && again[0]) || { ...DEFAULT_SETTINGS };
    } catch (e) {
      if (isDuplicate(e)) {
        const again = await repo.get();
        if (Array.isArray(again) && again[0]) return again[0];
      }
      throw e;
    }
  };
}