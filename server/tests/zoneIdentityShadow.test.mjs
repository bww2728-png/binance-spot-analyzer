import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idStability, measureIdentityStability, createIdentityCollector } from '../services/zoneIdentityShadow.mjs';

/**
 * ★2: معرّف منطقة السيولة يحمل ترتيب العنقود، فيتغيّر عند ظهور قمة/قاع قبله. القياس
 * هنا تجربة سببية: نفس الشموع بفارق شمعة واحدة في `endIndex`، وكل منطقة مُطابَقة هي
 * نفس المنطقة. اختلاف معرّفها = عدم ثبات. لا يقرأ هذا القياس أي قرار منشور.
 */

const zone = (id, kind, level) => ({ id, kind, referenceLevel: level });

test('هوية ثابتة: نفس المناطق بمعرّف نفسه → لا دوران', () => {
  const prev = [zone('a', 'high', 100), zone('b', 'low', 90)];
  const next = [zone('a', 'high', 100), zone('b', 'low', 90)];
  const r = idStability(prev, next, 0.002);
  assert.equal(r.matched, 2);
  assert.equal(r.churned, 0);
  assert.equal(r.churnRate, 0);
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
});

test('دوران الهوية: نفس المنطقة بمعرّف مختلف تُحتسب مرة واحدة', () => {
  // المنطقة نفسها (سعر مطابق ضمن التحمل) لكن id تغيّر بسبب ترتيب العنقود
  const prev = [zone('cluster-high-0-10000000000', 'high', 100)];
  const next = [zone('cluster-high-1-10000000000', 'high', 100)];
  const r = idStability(prev, next, 0.002);
  assert.equal(r.matched, 1, 'المنطقة ما زالت موجودة مادياً');
  assert.equal(r.churned, 1, 'لكن هويتها تغيّرت');
  assert.equal(r.churnRate, 1);
  assert.equal(r.removed, 0, 'الدوران لا يُحتسب اختفاءً — وإلا انتفخ المؤشر مرتين');
  assert.equal(r.examples[0].before, 'cluster-high-0-10000000000');
  assert.equal(r.examples[0].after, 'cluster-high-1-10000000000');
});

test('لا مطابقة عبر الأنواع ولا خارج نسبة التحمل', () => {
  // نفس السعر لكن نوع مختلف → منطقة أخرى فعلاً
  assert.equal(idStability([zone('a', 'high', 100)], [zone('z', 'low', 100)], 0.002).matched, 0);
  // نفس النوع لكن انزياح 5% وهو أكبر من التحمل 0.2% → منطقة أخرى فعلاً
  const r = idStability([zone('a', 'high', 100)], [zone('b', 'high', 105)], 0.002);
  assert.equal(r.matched, 0);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
});

test('عند وجود مطابقين يختار الأقرب فقط ولا يستهلك أحدهما مرتين', () => {
  const prev = [zone('p1', 'high', 100.0), zone('p2', 'high', 100.1)];
  const next = [zone('n1', 'high', 100.05)];
  const r = idStability(prev, next, 0.002);
  assert.equal(r.matched, 1, 'منطقة واحدة تُطابق مرة واحدة');
  assert.equal(r.removed, 1);
});

test('القياس السببي: تشغيل الكشف مرتين بفارق شمعة عبر دالة مُمرَّرة', () => {
  const detect = ({ endIndex }) => (endIndex === 99
    ? [zone('cluster-high-0-1', 'high', 50), zone('cluster-low-0-1', 'low', 40)]
    : [zone('cluster-high-2-1', 'high', 50), zone('cluster-low-3-1', 'low', 40)]);
  const r = measureIdentityStability({ detect, symbol: 'BTCUSDT', timeframe: '1h', endIndex: 99, tolerancePct: 0.002 });
  assert.equal(r.zonesFull, 2);
  assert.equal(r.matched, 2);
  assert.equal(r.churned, 2);
  assert.equal(r.churnRate, 1);
  assert.equal(r.symbol, 'BTCUSDT');
});

test('المجمّع: معدّل مرجّح بعدد المناطق المُطابَقة لا بمتوسط نسب العيّنات', () => {
  const collector = createIdentityCollector();
  // عيّنة كبيرة بلا دوران: 100 مطابقة، 0 دوران
  collector.add({ matched: 100, churned: 0, zonesFull: 120, examples: [] });
  // عيّنة صغيرة بدوران كامل: 1 مطابقة، دوران واحد
  collector.add({ matched: 1, churned: 1, zonesFull: 1, examples: [{ before: 'a', after: 'b' }] });
  const s = collector.summary();
  assert.equal(s.samples, 2);
  assert.equal(s.matched, 101);
  assert.equal(s.churned, 1);
  // المتوسط الحسابي للنسب كان سيعطي 0.5 — المرجّح يعطي الحقيقة 0.0099
  assert.equal(s.churnRate, 0.0099);
  assert.equal(s.zones, 121);
});

test('المجمّع بلا مطابقات: churnRate = null ولا قسمة على صفر', () => {
  const collector = createIdentityCollector();
  collector.add({ matched: 0, churned: 0, zonesFull: 3, examples: [] });
  const s = collector.summary();
  assert.equal(s.churnRate, null);
  assert.equal(s.samples, 1);
});

/**
 * نافذة المقارنة: قياس حقيقي على بيانات السوق أعطى 22.1% عند شمعة واحدة و37.6% عند
 * أربع. النافذة الافتراضية يجب أن تكون الفجوة الواقعية (4) لا شمعة واحدة، وإلا بُخّس
 * حجم العيب. والاتجاه أمامي: نبحث عن المنطقة في الحالة **الأقدم** ونقارن بمعرّفها الآن.
 */
test('النافذة الافتراضية 4 شموع والاتجاه أمامي (الأقدم ← الأحدث)', () => {
  const calls = [];
  const detect = ({ endIndex }) => {
    calls.push(endIndex);
    // عند النهاية الأقدم معرّف قديم، وعند النهاية الأحدث معرّف جديد لنفس السعر
    return [zone(endIndex === 96 ? 'cluster-high-9-10000000000' : 'cluster-high-0-10000000000', 'high', 100)];
  };
  const r = measureIdentityStability({ detect, symbol: 'BTCUSDT', timeframe: '15m', endIndex: 100, tolerancePct: 0.002 });
  assert.deepEqual(calls, [100, 96], 'المقارنة على فارق 4 شموع افتراضاً');
  assert.equal(r.lookbackBars, 4);
  assert.equal(r.matched, 1, 'المنطقة نفسها بالسعر نفسه');
  assert.equal(r.churned, 1, 'لكن معرّفها تغيّر → دوران');
});

test('نافذة مخصّصة تُحترم، ونافذة تتجاوز بداية السلسلة لا تُنتج قياساً كاذباً', () => {
  const seen = [];
  const detect = ({ endIndex }) => { seen.push(endIndex); return [zone('z', 'high', 100)]; };
  const custom = measureIdentityStability({ detect, symbol: 'A', timeframe: '1h', endIndex: 100, tolerancePct: 0.002, lookbackBars: 8 });
  assert.deepEqual(seen, [100, 92], 'النافذة المخصّصة 8');
  assert.equal(custom.lookbackBars, 8);
  // نافذة أكبر من المتاح: تتوقف بلا قياس بدل أن تقارن بلا بيانات
  const short = measureIdentityStability({ detect, symbol: 'A', timeframe: '1h', endIndex: 22, tolerancePct: 0.002, lookbackBars: 8 });
  assert.equal(short.matched, 0);
  assert.equal(short.churnRate, null, 'لا نسبة من صفر مطابقات');
  assert.equal(short.lookbackBars, 8);
});
