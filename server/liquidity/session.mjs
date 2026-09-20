/* بعد الجلسة — ترجمة فلتر فابيو (نيويورك الأفضل / تجنب فتكة لندن) إلى صيغة كريبتو
 * السوق يعمل 24/7 لكن الأدلة الموثقة (Su et al. 2022 — اكتشاف السعر يهيمن عليه تداخل
 * لندن-نيويورك؛ Time-of-Day Periodicities — أدنى حجم عند H04 وأعلاه عند H15 UTC؛
 * Quantpedia — أقوى العوائد الساعية 21:00–23:00 UTC) تحدد ثلاث فئات ندرة:
 * prime / normal / lull — مُعدِّل وزن وليس فلتر صارم. جدول UTC قابل للضبط.
 */

export const SESSION_WINDOWS = {
  prime: [[12, 17], [21, 23]],   // تداخل لندن-نيويورك + بعد ظهر نيويورك
  lull: [[1, 6]]                  // فتكة السيولة الآسيوية
};

/** فئة الجلسة من وقت معين (UTC). tier ∈ {prime, normal, lull} */
export function sessionFactor(timestamp = Date.now(), windows = SESSION_WINDOWS) {
  const d = new Date(timestamp);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  for (const [start, end] of windows.prime ?? []) {
    if (hour >= start && hour < end) return { tier: 'prime', start, end };
  }
  for (const [start, end] of windows.lull ?? []) {
    if (hour >= start && hour < end) return { tier: 'lull', start, end };
  }
  return { tier: 'normal', start: null, end: null };
}
