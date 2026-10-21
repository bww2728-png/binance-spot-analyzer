/**
 * ترميز لقطة المناطق الآلية بلا فقدان — يُطبَّق على حدود القاعدة فقط.
 *
 * القياس (عيّنة إنتاجية حقيقية): اللقطة الواحدة 100 منطقة ≈ 60 كيلوبايت، و`reasons`
 * وحدها 20–25 كيلوبايت أي **40%** من الحجم، لأن نصوص الأسباب قوالب متكررة حرفياً بين
 * المناطق (‏«منطقة القيمة اليومية»، «عقدة حجم منخفض» …). وكذلك `id` يحمل بادئة طويلة
 * تتكرر في كل منطقة (`SYMBOL-TF-kind-...`).
 *
 * الحل خالٍ من أي خسارة معلومة:
 *  - قاموس مشترك لنصوص الأسباب مرة واحدة في اللقطة، وكل منطقة تحمل فهارسها.
 *  - بادئة المعرّف تُخزَّن قاموساً كذلك، ويُحفظ ذيله فقط في المنطقة.
 *  - **بقية الحقول تُترك كما هي حرفياً** (بما فيها `null` والقيم الفارغة) حتى يعيد
 *    الفكّ الكائن الأصلي مطابقاً تماماً، فلا ينكسر أي مستهلك ولا يضيع أي حقل.
 *
 * كل مسارات القراءة (`listAuto`، `getAutoSnapshot`، `flattenSnapshots`) تفكّ الترميز
 * عبر `expandSnapshotMeta`، واللقطات القديمة غير المرمَّزة تُقرأ كما هي (توافق خلفي).
 */

/** مفتاح النسخة: غيابه يعني لقطة قديمة مباشرة تُقرأ بلا فكّ */
export const SNAPSHOT_CODEC_VERSION = 1;

const ID_PREFIX_RE = /^([A-Z0-9]{2,20}-[0-9a-zA-Z]{1,5})-(.+)$/s;

export function compactSnapshot(snap) {
  if (!snap || !Array.isArray(snap.zones) || !snap.zones.length) return snap;
  const reasonDict = [];
  const reasonIndex = new Map();
  const prefixDict = [];
  const prefixIndex = new Map();

  const compactZone = (z) => {
    const out = {};
    for (const [k, v] of Object.entries(z)) {
      if (k === 'reasons') {
        // القاموس يعمل فقط إذا كانت مصفوفة نصوص؛ وإلا يبقى الحقل كما هو
        if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
          out.reasons = v.map((r) => {
            let ri = reasonIndex.get(r);
            if (ri === undefined) { ri = reasonDict.push(r) - 1; reasonIndex.set(r, ri); }
            return ri;
          });
          continue;
        }
        out.reasons = v;
        continue;
      }
      if (k === 'id' && typeof v === 'string') {
        const m = ID_PREFIX_RE.exec(v);
        if (m) {
          let pi = prefixIndex.get(m[1]);
          if (pi === undefined) { pi = prefixDict.push(m[1]) - 1; prefixIndex.set(m[1], pi); }
          out.id = m[2];
          out.id_p = pi;
          continue;
        }
      }
      out[k] = v;
    }
    return out;
  };

  return {
    ...snap,
    zones: snap.zones.map(compactZone),
    __c: SNAPSHOT_CODEC_VERSION,
    ...(reasonDict.length ? { rd: reasonDict } : {}),
    ...(prefixDict.length ? { pd: prefixDict } : {})
  };
}

export function expandSnapshot(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  if (meta.__c !== SNAPSHOT_CODEC_VERSION || !Array.isArray(meta.zones)) return meta;
  const rd = meta.rd ?? [];
  const pd = meta.pd ?? [];
  const zones = meta.zones.map((z) => {
    const out = {};
    for (const [k, v] of Object.entries(z)) {
      if (k === 'id_p') continue;
      if (k === 'id' && z.id_p !== undefined) {
        const prefix = pd[Number(z.id_p)];
        out.id = prefix != null ? `${prefix}-${v}` : v;
        continue;
      }
      if (k === 'reasons' && Array.isArray(v)) {
        out.reasons = v.map(i => rd[Number(i)] ?? i);
        continue;
      }
      out[k] = v;
    }
    // ترتيب المفاتيح الأصلي يُعاد: المعرّف ثم بقية الحقول كما وردت
    if (z.id_p !== undefined && out.id !== undefined) {
      const { id, ...rest } = out;
      return { id, ...rest };
    }
    return out;
  });
  const { __c, rd: _rd, pd: _pd, ...rest } = meta;
  return { ...rest, zones };
}

/** فكّ لقطة محفوظة نصاً (meta) مع تحمّل التالف — تعيد `null` بدل الانفجار */
export function expandSnapshotMeta(rawMeta) {
  if (rawMeta == null) return null;
  try {
    return expandSnapshot(typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta);
  } catch {
    return null;
  }
}
