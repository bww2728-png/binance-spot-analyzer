/**
 * قرار الإحياء: هل يُعاد تشغيل هذه الحلقة المعلقة، أم يُنتظر، أم يُتوقف عن المحاولة؟
 *
 * وحدة نقية (بلا مؤقّتات ولا شبكة) ليُختبر منطقها وحده. الغرض من وجودها: التشغيل
 * الطويل بلا مراقب بشري. الكشف وحده لا يكفي — إن علِقت حلقة فالنتيجة توقف كل دورة
 * تالية إلى الأبد.
 *
 * السياسة المقصودة:
 *  - لا إحياء لحلقة تعمل (لا تعليق) — وإسقاط سجلها فور عودتها لتعمل.
 *  - مهلة تهدئة بين المحاولات: إحياء متكرر سريع يقارب الحلقة بمطرقة ويخفي العطل.
 *  - سقف محاولات: بعد استنفادها نكتفي بتحذير صريح كل ساعة. عطل لا يُصلحه إحياء
 *    متكرر يحتاج تدخلاً، وإخفاؤه بإعادة تشغيل بلا نهاية أسوأ من إظهاره.
 */
export const REVIVE_COOLDOWN_MS = 10 * 60 * 1000;
export const REVIVE_MAX = 5;
const WARN_EVERY_MS = 60 * 60 * 1000;

/**
 * @param {{stalled:boolean, sinceCycleMs:number|null}|null} snapshot حالة المحرك
 * @param {{at:number, count:number}|undefined} record سجل المحاولات السابق
 * @param {number} nowMs الزمن الحالي
 * @param {{cooldownMs?:number, max?:number, enabled?:boolean}} opts
 * @returns {{action:'skip'|'idle'|'revive'|'exhausted', record:{at:number,count:number}, warn:boolean}}
 */
export function reviveDecision(snapshot, record, nowMs, opts = {}) {
  const cooldownMs = opts.cooldownMs ?? REVIVE_COOLDOWN_MS;
  const max = opts.max ?? REVIVE_MAX;
  const prev = record ?? { at: 0, count: 0 };
  if (!snapshot?.stalled) return { action: 'idle', record: { at: 0, count: 0 }, warn: false };
  if (opts.enabled === false) return { action: 'skip', record: prev, warn: false };
  const sinceLast = nowMs - prev.at;
  if (prev.count >= max) {
    return { action: 'exhausted', record: prev, warn: sinceLast > WARN_EVERY_MS };
  }
  if (prev.count > 0 && sinceLast < cooldownMs) return { action: 'skip', record: prev, warn: false };
  return { action: 'revive', record: { at: nowMs, count: prev.count + 1 }, warn: false };
}
