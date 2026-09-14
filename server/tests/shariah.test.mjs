import test from 'node:test';
import assert from 'node:assert/strict';

// استيراد ديناميكي بنمط sorting.test.mjs (Node 22+ strip-types)
const { evaluateShariah, EVIDENCE, DEFAULT_FACTS } = await import('../../client/src/lib/shariah.ts');

/** محرك قواعد حتمي: tidy runs */
function run(facts, symbol = 'TESTUSDT') {
  return evaluateShariah(facts, symbol);
}

test('memecoin بلا منفعة → حرام (ميسر/غرر)', () => {
  const r = run({ has_utility: false, is_memecoin: true, has_lending_interest: false, has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: null, pure_speculation: true, privacy_concern: false });
  assert.equal(r.verdict, 'haram');
  assert.ok(r.reasons.some(x => x.includes('ميم') || x.includes('ميسر')), 'يجب أن يذكر سبباً حول الميسر');
  assert.ok(r.evidence.some(e => e.id === 'q-maidah-90'), 'يستدل بآية المائدة 90');
});

test('إقراض بفائدة (Lending) → حرام (ربا)', () => {
  const r = run({ has_utility: true, is_memecoin: false, has_lending_interest: true, has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: null, pure_speculation: false, privacy_concern: false });
  assert.equal(r.verdict, 'haram');
  assert.ok(r.reasons.some(x => x.includes('ربا')), 'يجب أن يذكر الربا');
  assert.ok(r.evidence.some(e => e.id === 'q-baqarah-275'), 'يستدل بآية البقرة 275');
});

test('عائد مضمون ثابت (staking) → شبهة/للتحقق مع خلاف فقهي', () => {
  const r = run({ has_utility: true, is_memecoin: false, has_lending_interest: false, has_fixed_yield: true, linked_haram_activity: false, is_asset_backed: null, pure_speculation: false, privacy_concern: false });
  assert.equal(r.verdict, 'uncertain');
  assert.ok(r.fiqh_dispute !== null, 'يجب توثيق الخلاف الفقهي');
  assert.ok(r.evidence.some(e => e.id === 'h-tirmidhi-2518'), 'يستدل بـ«دع ما يريبك»');
});

test('عملة منفعة PoW بلا محرم → حلال بضوابط', () => {
  const r = run({ has_utility: true, is_memecoin: false, has_lending_interest: false, has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: null, pure_speculation: false, privacy_concern: false });
  assert.equal(r.verdict, 'halal');
  assert.ok(r.evidence.some(e => e.id === 'q-nisa-29'), 'يستدل بآية النساء 29 (تجارة عن تراض)');
});

test('عملة مستقرة مغطاة بأصل حقيقي → حلال بضوابط', () => {
  const r = run({ has_utility: false, is_memecoin: false, has_lending_interest: false, has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: true, pure_speculation: false, privacy_concern: false });
  assert.equal(r.verdict, 'halal');
  assert.ok(r.headline.includes('مغطاة'), 'يجب الإشارة للتغطية');
});

test('ارتباط بأنشطة محرمة → حرام', () => {
  const r = run({ has_utility: true, is_memecoin: false, has_lending_interest: false, has_fixed_yield: false, linked_haram_activity: true, is_asset_backed: null, pure_speculation: false, privacy_concern: false });
  assert.equal(r.verdict, 'haram');
  assert.ok(r.evidence.some(e => e.id === 'q-maidah-2'), 'يستدل بـ«ولا تعاونوا على الإثم»');
});

test('خصوصية/إخفاء → للتحقق (غرر) من غير خلاف', () => {
  const r = run({ has_utility: true, is_memecoin: false, has_lending_interest: false, has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: null, pure_speculation: false, privacy_concern: true });
  assert.equal(r.verdict, 'uncertain');
  assert.ok(r.reasons.some(x => x.includes('إخفاء')), 'يجب ذكر طابع الإخفاء');
});

test('كل سبب مرتبط بدليل موجود في قاعدة الأدلة', () => {
  const ids = new Set(EVIDENCE.map(e => e.id));
  for (const f of Object.values(DEFAULT_FACTS)) {
    const r = evaluateShariah(f, 'SYMUSDT');
    for (const ev of r.evidence) {
      assert.ok(ids.has(ev.id), `دليل غير معروف: ${ev.id}`);
      assert.ok(ev.ref && ev.ref.length > 0, 'مرجع غير فارغ');
      assert.ok(ev.grade && ev.grade.length > 0, 'درجة صحة غير فارغة');
      assert.ok(ev.text && ev.text.length > 0, 'نص الدليل غير فارغ');
    }
  }
});

test('لا يقبل الكتالوج المبدئي أي دليل مختلق (نصوص مثبتة فقط)', () => {
  const validRefs = ['البقرة', 'النساء', 'المائدة', 'الروم', 'رواه مسلم', 'رواه الترمذي', 'رواه أبو داود', 'رواه النسائي', 'متفق عليه', 'البخاري'];
  for (const ev of EVIDENCE) {
    assert.ok(validRefs.some(v => ev.ref.includes(v)), `مرجع خارج النطاق المعتمد: ${ev.ref}`);
  }
});

test('النتيجة حتمية: نفس الحقائق → نفس النتيجة', () => {
  const f = { has_utility: true, is_memecoin: true, has_lending_interest: false, has_fixed_yield: false, linked_haram_activity: false, is_asset_backed: null, pure_speculation: true, privacy_concern: false };
  const a = run(f, 'X');
  const b = run(f, 'X');
  assert.equal(a.verdict, b.verdict);
  assert.deepEqual(a.reasons, b.reasons);
  assert.deepEqual(a.evidence.map(e => e.id), b.evidence.map(e => e.id));
});