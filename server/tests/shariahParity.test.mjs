/**
 * تكافؤ محرك التصنيف الشرعي بعد نقله إلى shared/shariahCore.mjs:
 * النسخة المنقولة (يعمل بها الخادم والواجهة) يجب أن تعطي نفس نتائج النسخة الأصلية
 * حرفياً — نفس البيانات ونفس الحكم ونفس الأسباب ونفس الأدلة.
 *
 * ملاحظة: استيراد .ts هنا يعمل على Node 22+ (strip-types) وهو للتحقق فقط؛
 * زمن التشغيل يستورد .mjs وحده.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const original = await import('../../client/src/lib/shariah.ts');
const core = await import('../../shared/shariahCore.mjs');

test('قاعدة الأدلة مُنقلة حرفياً (المعرّف والنص والمرجع والدرجة والموضوع)', () => {
  assert.deepEqual(core.EVIDENCE, original.EVIDENCE);
  assert.ok(core.EVIDENCE.length >= 15, 'كل الأدلة موجودة');
});

test('أسئلة التوثيق مُنقلة حرفياً', () => {
  assert.deepEqual(core.FACT_QUESTIONS, original.FACT_QUESTIONS);
});

test('قاعدة المعرفة (DEFAULT_FACTS) مُنقلة حرفياً — كل مفتاح وكل حقل', () => {
  const a = original.DEFAULT_FACTS;
  const b = core.DEFAULT_FACTS;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  assert.deepEqual(kb, ka, 'نفس المفاتيح تماماً');
  for (const k of ka) assert.deepEqual(b[k], a[k], `حقائق ${k}`);
});

test('factsForSymbol يعطي نفس الحقائق لكل مشروع معروف ولكل رمز', () => {
  const symbols = [...Object.keys(original.DEFAULT_FACTS).map(s => `${s}USDT`), 'ZZZUSDT', 'BTCUSDC', 'ABC'];
  for (const s of symbols) {
    assert.deepEqual(core.factsForSymbol(s), original.factsForSymbol(s), `حقائق ${s}`);
  }
});

test('الحكم متطابق على كل توليفات الحقائق الممكنة (3^8)', () => {
  const keys = ['has_utility', 'is_memecoin', 'has_lending_interest', 'has_fixed_yield',
    'linked_haram_activity', 'is_asset_backed', 'pure_speculation', 'privacy_concern'];
  const values = [true, false, null];
  let checked = 0;
  const build = (idxs) => {
    const f = {};
    keys.forEach((k, i) => { f[k] = values[idxs[i]]; });
    return f;
  };
  const idxs = new Array(keys.length).fill(0);
  const total = values.length ** keys.length;
  for (let n = 0; n < total; n += 1) {
    let rest = n;
    for (let i = keys.length - 1; i >= 0; i -= 1) { idxs[i] = rest % values.length; rest = Math.floor(rest / values.length); }
    const facts = build(idxs);
    const a = original.evaluateShariah(facts, 'BTCUSDT');
    const b = core.evaluateShariah(facts, 'BTCUSDT');
    assert.equal(b.verdict, a.verdict, `الحكم عند ${JSON.stringify(facts)}`);
    assert.equal(b.headline, a.headline, `العنوان عند ${JSON.stringify(facts)}`);
    assert.deepEqual(b.reasons, a.reasons, `الأسباب عند ${JSON.stringify(facts)}`);
    assert.deepEqual(b.evidence, a.evidence, `الأدلة عند ${JSON.stringify(facts)}`);
    assert.deepEqual(b.hits, a.hits, `المعايير عند ${JSON.stringify(facts)}`);
    assert.equal(b.fiqh_dispute, a.fiqh_dispute);
    assert.equal(b.disclaimer, a.disclaimer);
    checked += 1;
  }
  assert.equal(checked, total);
});

test('الحكم متطابق على كل المشاريع المعروفة', () => {
  for (const base of Object.keys(original.DEFAULT_FACTS)) {
    const symbol = `${base}USDT`;
    const facts = core.factsForSymbol(symbol);
    const a = original.evaluateShariah(facts, symbol);
    const b = core.evaluateShariah(facts, symbol);
    assert.equal(b.verdict, a.verdict, `حكم ${symbol}`);
  }
});

test('factsFromAnswers متطابق', () => {
  const answers = { has_utility: true, is_memecoin: null, has_lending_interest: false, privacy_concern: true };
  assert.deepEqual(core.factsFromAnswers(answers), original.factsFromAnswers(answers));
});
