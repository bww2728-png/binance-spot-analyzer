import test from 'node:test';
import assert from 'node:assert/strict';

const { FACT_QUESTIONS, factsFromAnswers, evaluateShariah } =
  await import('../../client/src/lib/shariah.ts');

test('أسئلة التوثيق تغطي حقائق المحرك الثمانية بلا نقص أو زيادة', () => {
  const keys = FACT_QUESTIONS.map(q => q.key).sort();
  assert.deepEqual([...new Set(keys)], keys);
  assert.equal(keys.length, 8);
  for (const q of FACT_QUESTIONS) {
    assert.ok(q.label.length > 2);
    assert.ok(q.hint.length > 5);
  }
});

test('factsFromAnswers يحول إجابات النموذج إلى حقائق كاملة وغير المُجاب يبقى مجهولاً', () => {
  const facts = factsFromAnswers({ has_utility: true, is_memecoin: false });
  assert.equal(facts.has_utility, true);
  assert.equal(facts.is_memecoin, false);
  assert.equal(facts.has_lending_interest, null);
  assert.equal(facts.privacy_concern, null);
  assert.equal(Object.keys(facts).length, 8);
});

test('مشروع موثق نظيفاً (منفعة وبلا محرمات) يحكم حلالاً ويفتح الإدراج', () => {
  const facts = factsFromAnswers({
    has_utility: true, is_memecoin: false, has_lending_interest: false,
    has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: false,
    pure_speculation: false, privacy_concern: false
  });
  const res = evaluateShariah(facts, 'TESTUSDT');
  assert.equal(res.verdict, 'halal');
  assert.ok(res.evidence.length > 0);
});

test('توثيق إقراض بفائدة يمنع الإدراج بحكم حرام', () => {
  const facts = factsFromAnswers({ has_utility: true, has_lending_interest: true });
  const res = evaluateShariah(facts, 'LENDUSDT');
  assert.equal(res.verdict, 'haram');
});

test('بلا إجابات إطلاقاً يبقى للتحقق — لا حكم بالتخمين', () => {
  const res = evaluateShariah(factsFromAnswers({}), 'UNKNOWN');
  assert.equal(res.verdict, 'uncertain');
});

test('توثيق عملة ميم بلا منفعة يحكم حراماً (ميسر/غرر)', () => {
  const facts = factsFromAnswers({ has_utility: false, is_memecoin: true, pure_speculation: true });
  const res = evaluateShariah(facts, 'MEMEUSDT');
  assert.equal(res.verdict, 'haram');
});
