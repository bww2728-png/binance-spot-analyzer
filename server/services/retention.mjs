/**
 * سياسة الاحتفاظ بالبيانات — تُنفَّذ دورياً على الخادم.
 *
 * السبب: سجل الأحداث نما إلى 121,507 حدثاً في القاعدة القديمة، وأكثره تشخيصي
 * متكرر (رفض نفس المرشح كل 5 ثوان، ولقطات مناطق ضخمة، وصور تصل إلى 1MB). سعة
 * الخطط محدودة (500MB مجاناً / 2GB للمدفوع)، فبلا سياسة حذف يتوقف الحفظ كلياً.
 *
 * ما يُحذف (موافقة المستخدم على الخطة):
 *  - الأنواع التشخيصية كثيفة الحجم بعد 30 يوماً: live_lifecycle، live_opportunity_rejected.
 *  - لقطات المناطق الآلية: يُبقى آخر 20 لكل رمز.
 *  - صور المناطق الآلية بعد 90 يوماً.
 *
 * ما لا يُحذف أبداً:
 *  - الفرص ونتائجها، والقرارات، والمعايرات، والتحليلات، والتصنيفات الشرعية،
 *    وسجل الاتجاهات، وتغذية التعلم الراجعة. هذه هي ذاكرة النظام وقيمته.
 */
const DIAGNOSTIC_TYPES_30D = ['live_lifecycle', 'live_opportunity_rejected'];
const SNAPSHOT_TYPE = 'auto_zones_snapshot';
const SNAPSHOTS_KEPT_PER_SYMBOL = 20;
const IMAGE_TYPES_90D = [
  'liquidity_zone', 'liquidity_zone_reviewed',
  'live_opportunity', 'live_opportunity_closed', 'live_opportunity_rejected',
  'strategy2_published', 'strategy2_resolved'
];

/** الأنواع المحمية صراحةً — لا تُحذف بحال (حماية مضاعفة عند أي تعديل مستقبلي) */
export const PROTECTED_TYPES = new Set([
  'strategy2_published', 'strategy2_resolved', 'strategy2_calibration',
  'strategy2_feedback', 'strategy2_direction',
  'live_opportunity', 'live_opportunity_closed', 'live_calibration',
  'liquidity_zone_decision', 'shariah_auto_change', 'shariah_researched',
  'barcode_scan', 'symbols_updated', 'zones_changed', 'health_samples',
  /**
   * حالة المحركات الدائمة (تقرير الظل، وانحياز التعلّم، وملخصات الباك تيست) —
   * صف واحد لكل مفتاح ويُحدَّث في مكانه، فلا ينمو ولا يجوز حذفه: حذفه يعني
   * فقدان ذاكرة التعلّم ودليل قياس ★ عند كل إعادة تشغيل.
   */
  'engine_state'
]);

const DAY = 86_400_000;

/** الأنواع المرشحة للحذف بعد المدة (لا يشمل المحمي) */
export function agedDiagnosticTypes(days = 30) {
  return DIAGNOSTIC_TYPES_30D.filter(t => !PROTECTED_TYPES.has(t));
}

/**
 * تنفيذ دورة الاحتفاظ.
 * @param {{db: object, now?: () => number, log?: object, dryRun?: boolean}} deps
 */
export async function runRetention({ db, now = () => Date.now(), log = console, dryRun = false, diagnosticDays = null, imageDays = null } = {}) {
  const t = now();
  const report = { at: t, dryRun, deleted: {}, errors: [], skipped: [] };
  /**
   * المُدد تُقرأ من البيئة (مع الافتراضيين 30 و90 يوماً) لأنها سياسة تشغيل لا ثابت
   * برمجي: قد يحتاج المشرف تقصيرها عند ضيق السعة أو إطالتها عند التحقيق في حادث.
   */
  const diagDays = Number(diagnosticDays ?? process.env.RETENTION_DIAGNOSTIC_DAYS ?? 30) || 30;
  const imgDays = Number(imageDays ?? process.env.RETENTION_IMAGE_DAYS ?? 90) || 90;

  // 1) الأنواع التشخيصية بعد المدة المحددة
  for (const type of agedDiagnosticTypes(diagDays)) {
    const before = t - diagDays * DAY;
    if (dryRun) { report.skipped.push({ type, action: 'delete-before', before }); continue; }
    try {
      const n = await db.events.deleteBefore(type, before);
      report.deleted[type] = n ?? 0;
    } catch (e) {
      report.errors.push({ type, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // 2) لقطات المناطق: آخر 20 لكل رمز
  try {
    const rows = await db.events.listByType(SNAPSHOT_TYPE, { select: 'id,symbol' });
    const counts = new Map();
    const toDelete = [];
    for (const r of rows ?? []) {          // مرتبة تنازلياً بالزمن
      const sym = String(r.symbol ?? '?');
      const n = (counts.get(sym) ?? 0) + 1;
      counts.set(sym, n);
      if (n > SNAPSHOTS_KEPT_PER_SYMBOL) toDelete.push(r.id);
    }
    if (!dryRun && toDelete.length) {
      report.deleted[SNAPSHOT_TYPE] = await db.events.deleteByIds(toDelete);
    } else if (dryRun) {
      report.skipped.push({ type: SNAPSHOT_TYPE, action: 'delete-ids', count: toDelete.length });
    }
  } catch (e) {
    report.errors.push({ type: SNAPSHOT_TYPE, error: String(e?.message ?? e).slice(0, 200) });
  }

  // 3) صور المناطق الآلية بعد المدة المحددة (الصور أثقل بكثير من النصوص)
  for (const type of IMAGE_TYPES_90D) {
    if (PROTECTED_TYPES.has(type)) continue;
    const before = t - imgDays * DAY;
    try {
      if (dryRun) { report.skipped.push({ type, action: 'clear-images-before', before }); continue; }
      const n = await db.events.clearImagesBefore(type, before);
      if (n) report.deleted[`${type}:images`] = n;
    } catch (e) {
      report.errors.push({ type: `${type}:images`, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  report.totalDeleted = Object.values(report.deleted).reduce((a, b) => a + (Number(b) || 0), 0);
  if (report.errors.length) log.warn?.('[retention] أخطاء:', JSON.stringify(report.errors).slice(0, 400));
  log.log?.(`[retention] حُذف ${report.totalDeleted} صفاً/صورة`);
  return report;
}

/**
 * جدولة دورية: مرة كل 12 ساعة (الحذف ليس عملاً حساساً للوقت).
 *
 * `onRun` مُمرَّر من الخادم ليُبلّغ قياس الصحة بعد كل دورة. بدونه بقيت دورات الاحتفاظ
 * صفراً في الصحة أبداً (كان العيب مُقاساً: 0 دورات بعد 30 دقيقة تشغيل)، فيبدو أن سياسة
 * الاحتفاظ لا تعمل بينما هي تعمل — وهذا يُفقد دليل سعة التخزين في حكم التشغيل المستمر.
 */
export function startRetention({ db, intervalMs = 12 * 3600_000, log = console, now = () => Date.now(), onRun = null }) {
  let lastReport = null;
  const tick = () => {
    const startedAt = now();
    void runRetention({ db, log, now })
      .then((report) => {
        lastReport = report;
        try { onRun?.({ ms: now() - startedAt, extra: { deleted: report?.totalDeleted ?? 0, errors: report?.errors?.length ?? 0 } }); } catch { /* القياس لا يعطّل الاحتفاظ */ }
      })
      .catch((e) => {
        try { onRun?.({ ms: now() - startedAt, error: e }); } catch { /* ignore */ }
        log.error?.('[retention] فشل:', e.message);
      });
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  // أول تنفيذ بعد 5 دقائق من الإقلاع (لا نزاحم بدء التشغيل)
  const first = setTimeout(tick, 5 * 60_000);
  if (first.unref) first.unref();
  return { stop: () => { clearInterval(timer); clearTimeout(first); }, run: tick, lastReport: () => lastReport };
}

export default runRetention;
