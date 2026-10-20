/**
 * «وضع الظل» — قياس إصلاحات تُغيّر عدد الفرص أو نتائجها، بلا أي أثر على النشر.
 *
 * القاعدة الملزمة (من الخطة المعتمدة): لا يُفعَّل أي إصلاح يغيّر سلوك الاستراتيجية
 * إلا بعد عرض الدليل وموافقة المستخدم. حتى ذلك الحين يعمل المنطق القديم كما هو،
 * ويعمل الجديد بالتوازي **للقياس فقط**، وتُسجَّل الفروق.
 *
 * التصميم:
 *  - كل إصلاح له مفتاح (shadow key) وحالة: معطّل (افتراضي) أو قياس-فقط.
 *  - `compare()` يُنتج سجلاً موحّداً: عدد القرارات القديمة/الجديدة، والفرق، وأمثلة.
 *  - لا يُعيد وضع الظل أي قرار للاستخدام — يُستخدم للتقارير فقط.
 *  - التقرير تراكمي في ملف JSON محلي + متاح عبر API.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** الإصلاحات المرشحة (★) — كلها معطّلة افتراضياً ولا تؤثر على النشر */
export const SHADOW_FIXES = {
  's2-closed-bars-only': 'استراتيجيتي تحلل الشموع المكتملة فقط بدل الجارية',
  'liquidity-stable-zone-id': 'معرّف ثابت لمنطقة السيولة + استبدال النتائج بدل تراكمها',
  'segments-decided-only': 'إحصاء الشرائح يُحدّث عند حسم الفرصة فقط',
  'scanhistory-swept-transition': 'تسجيل انتقال المنطقة إلى «مسحوبة» في فحص التاريخ',
  'fabio-expiry-and-hilo': 'انتهاء فرصة Fabio بعد 96 شمعة + النتيجة من أعلى/أدنى الشمعة',
  'calibration-live-parity': 'تقرير فرق المعايرة عن الحي (قياس فقط)'
};

export function createShadow({ dir = null, log = console } = {}) {
  /** هل القياس مُفعَّل؟ يُفعَّل بالمتغير SHADOW_MODE=1 (افتراضياً مُفعَّل للقياس فقط) */
  const enabled = String(process.env.SHADOW_MODE ?? '1') !== '0';
  const records = new Map();
  const file = dir ? path.join(dir, 'shadow-report.json') : null;

  if (file && !existsSync(path.dirname(file))) {
    try { mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  }

  function bucket(key) {
    if (!records.has(key)) {
      records.set(key, {
        key,
        label: SHADOW_FIXES[key] ?? key,
        samples: 0, agree: 0, diff: 0,
        examples: [],
        firstAt: Date.now(), lastAt: null
      });
    }
    return records.get(key);
  }

  /**
   * مقارنة قرارين: القديم (المُنشَر فعلاً) والجديد (في الظل).
   * @param {string} key مفتاح الإصلاح
   * @param {any} legacy النتيجة التي يعمل بها النظام الآن
   * @param {any} candidate النتيجة بالإصلاح الجديد
   * @param {(a:any,b:any)=>boolean} [equal] دالة تساوٍ مخصّصة
   * @param {object} [context] سياق للتشخيص (رمز/فريم/مرجع)
   */
  function compare(key, legacy, candidate, equal = null, context = null) {
    const b = bucket(key);
    b.samples += 1;
    b.lastAt = Date.now();
    const same = equal ? equal(legacy, candidate) : JSON.stringify(legacy) === JSON.stringify(candidate);
    if (same) b.agree += 1;
    else {
      b.diff += 1;
      // نحتفظ بعيّنات قليلة فقط (منع تضخّم الذاكرة)
      if (b.examples.length < 25) {
        b.examples.push({ at: Date.now(), context, legacy, candidate });
      }
    }
    if (b.samples % 200 === 0) persist();
    return same;
  }

  function summary() {
    const out = [];
    for (const [key, b] of records) {
      out.push({
        key,
        label: b.label,
        samples: b.samples,
        agree: b.agree,
        diff: b.diff,
        diffRate: b.samples ? Number((b.diff / b.samples).toFixed(4)) : null,
        firstAt: b.firstAt,
        lastAt: b.lastAt,
        examples: b.examples.slice(-8)
      });
    }
    return {
      enabled,
      fixes: SHADOW_FIXES,
      records: out,
      /** ملاحظة صريحة: هذه قياسات لا قرارات — لا شيء منها منشور */
      note: 'قياس فقط: لم يُفعَّل أي إصلاح ★ على النشر. التفعيل يتطلب موافقة صريحة بعد عرض هذا الدليل.'
    };
  }

  function persist() {
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(summary(), null, 2)); } catch (e) { log.warn?.('[shadow] تعذّر الحفظ:', e.message); }
  }

  /** قراءة تقرير محفوظ (للنشر المستمر عبر إعادات التشغيل) */
  function load() {
    if (!file || !existsSync(file)) return null;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      absorb(data);
      return data;
    } catch { return null; }
  }

  /** دمج تقرير سابق في التراكم الحالي (يُستخدم لملف القرص ولسجل القاعدة معاً) */
  function absorb(data) {
    for (const r of data?.records ?? []) {
      const b = bucket(r.key);
      // غير المحسوب: مفتاح قديم للمحرك بشروط قديمة
      b.samples += r.samples ?? 0;
      b.agree += r.agree ?? 0;
      b.diff += r.diff ?? 0;
      if (!b.firstAt) b.firstAt = r.firstAt ?? Date.now();
      b.lastAt = r.lastAt ?? b.lastAt;
      b.examples.push(...(r.examples ?? []).slice(-8));
    }
    return data;
  }

  /**
   * حفظ في القاعدة (مخزن حالة المحركات) — لأن ملف الحاوية يضيع مع كل نشر جديد،
   * فقياس ★ كان يبدأ من صفر في كل مرة ويصعب بلوغ عيّنات كافية للحكم.
   */
  async function persistDb(db) {
    if (!db?.engineState?.put) return false;
    try { await db.engineState.put('shadow_report', summary()); return true; } catch (e) { log.warn?.('[shadow] تعذّر الحفظ في القاعدة:', e.message); return false; }
  }

  async function loadDb(db) {
    if (!db?.engineState?.get) return null;
    try {
      const data = await db.engineState.get('shadow_report');
      if (!data?.records?.length) return null;
      absorb(data);
      return data;
    } catch { return null; }
  }

  return { enabled, compare, summary, persist, load, absorb, persistDb, loadDb, clear: () => records.clear() };
}

export default createShadow;
