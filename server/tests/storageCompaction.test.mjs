/**
 * اختبارات ارتدادية لعيوب التخزين والأداء المُثبتة من القياس الإنتاجي:
 *
 *  - O1: `health_samples` كان محمياً حماية مطلقة ويُكتب بحمولة الفحص الكامل (16,016
 *        بايت) كل 5 دقائق ⇒ 4.6MB/يوم بلا سقف أبدي. الحل: ضغط الحمولة **للحفظ فقط**.
 *  - O19: عدّاد `persistWrites` كان غير موصول بأي كاتب فيبقى صفراً دائماً، فتظهر
 *        الصحة وكأن لا حفظ يحدث. الحل: يُحتسب عند نجاح الكتابة مع حجم العيّنة.
 *  - O4: كشف السيولة كان يُنفَّذ ثلاث مرات على نفس الشموع (v1، ثم v1 ثانية داخل
 *        `compareEngines`، ثم v2) ⇒ تأخّر الحلقة p99 إلى 1,229ms. الحل: تمرير مناطق
 *        v1 المحسوبة مسبقاً.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSample } from '../health.mjs';

/** عيّنة تشخيصية تحاكي الشكل الحقيقي: مصفوفات كائنات ثقيلة داخل الأقسام */
function makeSample() {
  const zones = [];
  for (let i = 0; i < 200; i += 1) zones.push({ id: `z${i}`, price: 100 + i, touches: 3, state: 'confirmed' });
  const records = [];
  for (let i = 0; i < 60; i += 1) records.push({ key: `BTCUSDT|1m|${i}`, ms: 12.5, at: 1792445000000 + i });
  return {
    now: 1792445000000,
    loop: { p99Ms: 1229, maxLagMs: 3100 },
    liquidityV2: { parityPct: 71.5, recent: zones },
    shadow: { records, samples: 6000 },
    zones: { live: { count: 429, oldest: 1792444000000 } },
    deployment: { processMemory: 512, containerLimit: 1024 },
    note: 'x'.repeat(900)
  };
}

test('O1: ضغط العيّنة يقصّ الحجم جذرياً (وكانت العيّنة 16KB بلا سقف)', () => {
  const sample = makeSample();
  const full = JSON.stringify(sample).length;
  const compacted = compactSample(sample);
  const saved = JSON.stringify(compacted).length;
  assert.equal(saved < full, true, `الحجم المخزَّن (${saved}) يجب أن يقل عن الحمولة الكاملة (${full})`);
  assert.equal(saved < full * 0.25, true, `التقليص ضعيف: ${(saved / full).toFixed(2)} من الأصل`);
});

test('O1: المصفوفات تُستبدل بعدّاد عند الحفظ (الأمثلة للفحص اللحظي لا للتخزين)', () => {
  const compacted = compactSample(makeSample());
  assert.equal(compacted.liquidityV2.recent.n, 200, 'عدد المناطق محفوظ');
  assert.equal(Array.isArray(compacted.liquidityV2.recent), false, 'لا تُخزَّن الكائنات نفسها');
  assert.equal(compacted.shadow.records.n, 60);
});

/**
 * عيب اكتُشف في الإنتاج **بعد النشر**: الضغط كان يُسقط مصفوفة الكائنات إلى عدّاد
 * وحده، فصار قسم `engines` (أهم قسم تشخيصي: دورات كل محرك وإخفاقاته وتوقفه) `{n:8}`
 * أي 7 بايت بلا أي معلومة. القاعدة الصحيحة: رأس محدود يُحفظ كاملاً، والطول يُذكر.
 */
test('O1-أ: مصفوفة المحركات تُحفظ بتفاصيلها (لا {n} بلا معلومة)', () => {
  const engines = [
    { name: 'liquidity-zones', cycles: 14428, failures: 0, stalled: false, lastError: null },
    { name: 'retention', cycles: 1, failures: 0, stalled: false, lastError: null }
  ];
  const compacted = compactSample({ engines });
  assert.equal(Array.isArray(compacted.engines.head), true, 'رأس المصفوفة محفوظ');
  assert.equal(compacted.engines.n, 2);
  assert.equal(compacted.engines.head[0].name, 'liquidity-zones', 'اسم المحرك محفوظ');
  assert.equal(compacted.engines.head[0].cycles, 14428, 'عدد الدورات محفوظ');
});

test('O1-ب: المصفوفة الطويلة تُقصّ في الرأس مع ذكر الطول الكامل', () => {
  const zones = Array.from({ length: 200 }, (_, i) => ({ id: `z${i}`, state: 'confirmed' }));
  const compacted = compactSample({ liquidityV2: { recent: zones } });
  assert.equal(compacted.liquidityV2.recent.n, 200, 'الطول الكامل مذكور');
  assert.equal(compacted.liquidityV2.recent.head.length, 8, 'رأس محدود فقط');
  assert.equal(compacted.liquidityV2.recent.head[0].state, 'confirmed', 'وتفاصيله محفوظة');
});

test('O1-ج: المصفوفات المتداخلة داخل الرأس تُسقط إلى عدّاد (منع التفخيم)', () => {
  const compacted = compactSample({ rows: [{ id: 'a', deep: [{ x: 1 }, { x: 2 }, { x: 3 }] }] });
  assert.equal(compacted.rows.head[0].deep.n, 3, 'الطول محفوظ');
  assert.equal(compacted.rows.head[0].deep.head, undefined, 'ولا تُوسَّع القائمة المتداخلة');
});

test('O1: الأرقام والبنية تبقى كما هي (لا ينكسر أي مستهلك يتوقّع مفتاحاً)', () => {
  const compacted = compactSample(makeSample());
  assert.equal(compacted.loop.p99Ms, 1229, 'المقياس الحاسم يُحفظ كما هو');
  assert.equal(compacted.loop.maxLagMs, 3100);
  assert.equal(compacted.liquidityV2.parityPct, 71.5);
  assert.equal(compacted.zones.live.count, 429, 'المفتاح المتداخل يبقى بنفس المسار');
  assert.equal(compacted.deployment.processMemory, 512);
});

test('O1: النصوص الطويلة تُقصّ وتُعلَّم (لا نص تشخيصي بلا حد)', () => {
  const compacted = compactSample(makeSample(), { maxString: 40 });
  assert.equal(compacted.note.length <= 41, true, 'النص الطويل يُقصّ');
  assert.equal(compacted.note.endsWith('…'), true, 'ويُعلَّم بالقصّ');
  assert.equal(compacted.now, 1792445000000, 'الطوابع الزمنية أرقام لا تتأثر');
});

test('O1: مصفوفة قيم أولية صغيرة تبقى كاملة (لا تُفقد معلومة مفيدة)', () => {
  const compacted = compactSample({ p95: [1, 2, 3, 4, 5] });
  assert.deepEqual(compacted.p95, [1, 2, 3, 4, 5], 'مصفوفة قصيرة تُحفظ كما هي');
});

test('O1: العمق المفرط يُقصّ بمفاتيح معلومة بدل الانفجار', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  const compacted = compactSample(deep, { maxDepth: 3 });
  assert.equal(JSON.stringify(compacted).includes('"g"'), false, 'الأعمق من الحد يُختصر');
  assert.equal(typeof compacted.a.b.c, 'object', 'والمستويات المسموحة تبقى');
});

test('O1: القيم الخاصة (null/undefined/منطقية) تمرّ بلا انفجار', () => {
  const compacted = compactSample({ a: null, b: undefined, c: true, d: 0, e: '' });
  assert.equal(compacted.a, null);
  assert.equal(compacted.b, undefined);
  assert.equal(compacted.c, true);
  assert.equal(compacted.d, 0, 'الصفر يبقى صفراً لا يُسقط');
});

test('O1: العيّنة الكاملة المحفوظة تبقى JSON صالحاً قابلاً للقراءة', () => {
  const json = JSON.stringify(compactSample(makeSample()));
  const back = JSON.parse(json);
  assert.equal(back.loop.p99Ms, 1229);
  assert.equal(typeof back.liquidityV2.recent.n, 'number');
});

/**
 * O4: إزالة الكشف المكرر. كان `compareEngines` يعيد تشغيل المحرك الأول على نفس
 * الشموع رغم أن المستدعي (index.js) شغّله للتوّ، فيصير الكشف ثلاث مرات على نفس
 * المدخل. الاختبار يثبت أن المناطق المُمرَّرة **تُستعمل كما هي** بلا كشف ثانٍ:
 * نُمرّر منطقة بقيمة حارسة لا يمكن أن ينتجها الكشف الطبيعي.
 */
function longCandles(n = 120) {
  return Array.from({ length: n }, (_, i) => {
    const o = 100 + i * 0.1;
    return { time: 1_700_000_000_000 + i * 60_000, open: o, high: o + 0.5, low: o - 0.5, close: o + 0.2, volume: 10 };
  });
}

test('O4: المناطق المحسوبة مسبقاً تُستعمل كما هي (لا كشف ثانٍ)', async () => {
  const { compareEngines } = await import('../services/liquidityShadowV2.mjs');
  const candles = longCandles();
  const sentinel = [{ id: 'sentinel-zone-1', key: 'sentinel-zone-1', referenceLevel: 999_999_999, state: 'confirmed', kind: 'horizontal_bsl' }];
  const withPre = compareEngines({ symbol: 'T', timeframe: '1m', candles, endIndex: candles.length - 1, oldZones: sentinel });
  assert.equal(withPre.old.length, 1, 'استُعملت المناطق المُمرَّرة');
  assert.equal(withPre.old[0].id, 'sentinel-zone-1');

  // وبلا تمرير يبقى السلوك القديم (كشف ذاتي) توافقاً خلفياً للاختبارات والسكربتات
  const selfDetect = compareEngines({ symbol: 'T', timeframe: '1m', candles, endIndex: candles.length - 1 });
  assert.equal(selfDetect.old.some(z => z.id === 'sentinel-zone-1'), false, 'لا وجود للمنطقة الحارسة بلا تمرير');
});

test('O4: المدخل القصير لا يُشغّل أي كشف (حارس الحجم قبل العمل)', async () => {
  const { compareEngines } = await import('../services/liquidityShadowV2.mjs');
  const r = compareEngines({ symbol: 'T', timeframe: '1m', candles: longCandles(20), endIndex: 19, oldZones: [{ id: 'x' }] });
  assert.deepEqual(r.old, [], 'الشموع القليلة تُعاد بلا كشف');
  assert.equal(r.match.matched, 0);
});

test('O4: `oldZones` غير مصفوفة يُعامل كعدم تمرير (تحمّل مدخل خاطئ)', async () => {
  const { compareEngines } = await import('../services/liquidityShadowV2.mjs');
  const candles = longCandles();
  const r = compareEngines({ symbol: 'T', timeframe: '1m', candles, endIndex: candles.length - 1, oldZones: null });
  assert.equal(Array.isArray(r.old), true, 'يعود بمصفوفة دائماً');
});
