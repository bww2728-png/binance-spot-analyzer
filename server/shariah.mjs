/**
 * حساب الحكم الشرعي على الخادم — إصلاح العلة الجذرية «لا تحليل بلا متصفح».
 *
 * قبل الإصلاح: الخادم كان يحفظ نص الحكم كما يصل من الواجهة، والواجهة وحدها هي
 * التي تحسبه. فإذا لم يفتح أحدٌ التطبيق، ظلّ الحكم `uncertain` ورفضت
 * resolveTargets كل العملات، فلم تعمل أي محرك — رغم أن المنطق كله حتمي ومحلي.
 *
 * الآن: المنطق نفسه (shared/shariahCore.mjs) يعمل داخل الخادم دورياً، بنفس
 * أولويات الحقائق التي تستخدمها الواجهة: الحقائق المحفوظة في القاعدة ← قاعدة
 * المعرفة المدمجة ← لا بيانات (غير محسوم). لا نسخة ثانية من القواعد.
 */
import { evaluateShariah, factsForSymbol, DEFAULT_FACTS } from '../shared/shariahCore.mjs';

/** حقائق محفوظة في الصف المخزَّن إن وُجدت */
function storedFacts(row) {
  if (!row?.facts) return null;
  if (typeof row.facts === 'string') {
    try { return JSON.parse(row.facts); } catch { return null; }
  }
  return row.facts;
}

/** هل الحقائق كلها null (لا معلومة واحدة)؟ */
export function factsAreEmpty(facts) {
  if (!facts) return true;
  return Object.values(facts).every(v => v === null || v === undefined);
}

/**
 * يحدّد الحقائق المستخدمة لرمز: المحفوظة أولاً ثم المعرفة المدمجة.
 * @returns {{ facts: object, source: 'stored'|'builtin'|'none', symbol: string }}
 */
export function resolveFacts(symbol, storedRow = null) {
  const sym = String(symbol ?? '').toUpperCase();
  const stored = storedFacts(storedRow);
  if (stored && !factsAreEmpty(stored)) {
    // دمج: ما لم يُوثَّق في الصف المخزَّن يُكمَل من قاعدة المعرفة المدمجة
    const base = factsForSymbol(sym);
    const merged = { ...base };
    for (const [k, v] of Object.entries(stored)) if (v !== null && v !== undefined) merged[k] = v;
    return { facts: merged, source: 'stored', symbol: sym };
  }
  const builtin = factsForSymbol(sym);
  if (!factsAreEmpty(builtin)) return { facts: builtin, source: 'builtin', symbol: sym };
  return { facts: factsForSymbol(sym), source: 'none', symbol: sym };
}

/**
 * يحسب الحكم لرمز واحد ويعيد صفاً جاهزاً للحفظ في coin_shariah.
 * لا يكتب شيئاً بنفسه — الكتابة قرار الطبقة المستدعية (كشف التغيّر).
 */
export function buildVerdictRow(symbol, storedRow = null, { now = Date.now(), previous = null } = {}) {
  const { facts, source } = resolveFacts(symbol, storedRow);
  const assessment = evaluateShariah(facts, String(symbol).toUpperCase());
  const evidence = assessment.evidence.map(({ topic, ...rest }) => rest); // نفس شكل الصف المخزَّن
  const prior = previous ?? storedRow?.verdict ?? null;
  return {
    symbol: String(symbol).toUpperCase(),
    verdict: assessment.verdict,
    facts,
    reasons: assessment.reasons,
    evidence,
    source: `server:${source}`,
    notes: assessment.headline,
    updated_at: now,
    /** للاستدعاء الداخلي فقط — لا يُكتب */
    _changed: prior !== null && prior !== assessment.verdict,
    _from: prior,
    _factsSource: source
  };
}

/** أسماء المشاريع المعروفة في قاعدة المعرفة المدمجة (للبذر الأول) */
export function builtinBases() {
  return Object.keys(DEFAULT_FACTS);
}
