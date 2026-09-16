/* المعايرة التكيفية + قياس الدقة
 * - مطابقة المناطق الآلية بمناطق المستخدم المعلّمة (المرجع الذهبي).
 * - استخراج/تحديث العتبات (حد الدني للدرجة) من التغذية الراجعة.
 * - التخزين بنمط النظام: حدث zone_calibration في events_log — الأحدث يفوز.
 */

/** مطابقة منطقتين: نفس النوع + ضمن tolerancePct */
export function zonesMatch(a, b, tolerancePct = 0.003) {
  if (a.type !== b.type) return false;
  return Math.abs(a.price - b.price) / b.price <= tolerancePct;
}

/**
 * تقرير الدقة: precision = من الآلي الصحيح / كله، recall = من اليدوي المُغطى / كله.
 * مقياس الزمن: المنطقة الآلية أنشئت بعد مرساة اليدوي أو قريبة منه (اليدوي مرجع تاريخي مسموح).
 */
export function matchZones(manualZones, autoZones, tolerancePct = 0.003) {
  const matchedAuto = autoZones.filter(z => manualZones.some(m => zonesMatch(z, m, tolerancePct)));
  const matchedManual = manualZones.filter(m => autoZones.some(z => zonesMatch(z, m, tolerancePct)));
  return {
    manualCount: manualZones.length,
    autoCount: autoZones.length,
    matchedAuto: matchedAuto.length,
    matchedManual: matchedManual.length,
    precision: autoZones.length ? matchedAuto.length / autoZones.length : null,
    recall: manualZones.length ? matchedManual.length / manualZones.length : null
  };
}

export const DEFAULT_CALIBRATION = {
  minScore: 50,
  eqhTolerancePct: 0.002,
  matchTolerancePct: 0.003,
  updated_at: 0
};

/**
 * قاعدة التكيف الحتمية:
 * - دقة منخفضة (<0.6) → ارفع حد الدني للدرجة (أقل ضجيج).
 * - تغطية منخفضة (<0.6) → أنزل الحد (لا تفوت مناطق).
 * - تعديل تدريجي ±5 ضمن حدود [35, 80].
 */
export function adaptCalibration(cal, report) {
  const next = { ...cal };
  if (report.precision !== null && report.precision < 0.6) {
    next.minScore = Math.min(80, cal.minScore + 5);
  }
  if (report.recall !== null && report.recall < 0.6) {
    next.minScore = Math.max(35, cal.minScore - 5);
  }
  next.updated_at = Date.now();
  return next;
}

/** قراءة المعايرة من أحداث events_log (meta JSON) */
export function latestCalibration(events) {
  for (const e of events) {
    try {
      const c = JSON.parse(e.meta || 'null');
      if (c && typeof c.minScore === 'number') return { ...DEFAULT_CALIBRATION, ...c };
    } catch { /* تجاهل التالف */ }
  }
  return { ...DEFAULT_CALIBRATION };
}
