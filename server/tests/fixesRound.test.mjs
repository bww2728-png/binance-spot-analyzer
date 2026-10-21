/**
 * اختبارات الإصلاحات المنفَّذة في هذه الدفعة (كلها **بلا أي تغيير على أي شرط تداول**):
 *
 *  1) B6 — نقطة الحقن الموحّدة لمحدد المعدل: كل نداء يحصل على دور قبل الشبكة،
 *     والمسار الذي ليس له دور لا يمرّ.
 *  2) A5/★5 — قياس فرق المعايرة عن الحي: يقيس الفرق ولا يغيّر أي نتيجة منشورة.
 *  3) B1 — جلب الأحكام بأسماء وأحكام فقط (بلا نصوص الأدلة الضخمة).
 *  4) المرحلة 0 — `/api/health/deep` يعرض كل الأقسام المسجَّلة (كان يعرض قائمة تُنسى).
 *  5) التكاليف — الصافي بعد الرسوم والانزلاق يُحسب ويُعرض بجانب الإجمالي.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setRateLimiter, getRateLimiter, gate, weightOf, reportRateLimit, RATE_WAIT_CAP_MS } from '../net/gate.mjs';
import { createRateLimiter } from '../net/limiter.mjs';
import { sweepModeParity } from '../live-opportunities/scanner.mjs';
import { summarizeSegments } from '../live-opportunities/scanner.mjs';
import { createHealth } from '../health.mjs';
import { normalizeCandles } from '../liquidity-zones/engine.mjs';
import { createTwoTierCache } from '../services/twoTierCache.mjs';
import { createLiveOpportunityEngine } from '../live-opportunities/loop.mjs';

test('B6: كل وزن مسار له قيمة مُعرَّفة والافتراضي محافظ (2)', () => {
  assert.equal(weightOf('/api/v3/klines?symbol=BTCUSDT&limit=500'), 2, 'يتجاهل الاستعلام');
  assert.equal(weightOf('/api/v3/depth?symbol=BTCUSDT'), 5, 'دفتر الأوامر أثقل');
  assert.equal(weightOf('/api/v3/exchangeInfo'), 20, 'أثقل نداء متاح');
  assert.equal(weightOf('/api/v3/something-unknown'), 2, 'مجهول ⇒ الأكثر تحفظاً');
});

test('B6: بلا محدد مُحقون لا يتعطّل شيء (البوابات اختيارية)', async () => {
  setRateLimiter(null);
  await gate('live', 2); // لا رمي
  reportRateLimit(429, 1000); // لا رمي
  assert.equal(getRateLimiter(), null);
});

test('B6: كل نداء يمرّ عبر المحدد بأولويته ووزنه', async () => {
  const calls = [];
  const fake = {
    acquire: async (priority, weight) => { calls.push([priority, weight]); },
    report: (status, retryAfterMs) => calls.push(['report', status, retryAfterMs]),
    stats: () => ({})
  };
  setRateLimiter(fake);
  try {
    await gate('live', weightOf('/api/v3/depth'));
    await gate('history', 1);
    reportRateLimit(418, 5000);
    assert.deepEqual(calls[0], ['live', 5], 'الأولوية والوزن من المسار نفسه');
    assert.deepEqual(calls[1], ['history', 1]);
    assert.deepEqual(calls[2], ['report', 418, 5000], 'الرفض يُبلَّغ للمحدد ليحظر البقية');
    assert.equal(getRateLimiter(), fake);
  } finally {
    setRateLimiter(null);
  }
});

test('B6: وزناً أقل من 1 لا يُخفَّض إلى صفر (لا تجاوز للمحاسبة)', async () => {
  const seen = [];
  setRateLimiter({ acquire: async (p, w) => seen.push(w), report: () => {}, stats: () => ({}) });
  try {
    await gate('live', 0);
    await gate('live', -3);
    assert.deepEqual(seen, [1, 1]);
  } finally { setRateLimiter(null); }
});

test('B6: سقف الانتظار داخل الطلب موجود وصريح (لا تعليق الحلقة الحية)', () => {
  assert.ok(Number.isFinite(RATE_WAIT_CAP_MS));
  assert.ok(RATE_WAIT_CAP_MS > 0, 'افتراضي معقول: انتظار محدود ثم مضيف آخر');
});

test('B6: المحدد الحقيقي يقبل أولوية حي/معايرة/تاريخي بلا خطأ', async () => {
  const limiter = createRateLimiter({ minuteBudget: 100, pumpMs: 20, log: { warn() {}, error() {}, info() {} } });
  setRateLimiter(limiter);
  try {
    await gate('live', 5);
    await gate('calibration', 2);
    await gate('history', 2);
    assert.equal(limiter.stats().total, 3, 'كل النداءات مرّت ومحسوبة');
  } finally { setRateLimiter(null); }
});

// ---------- ★5 قياس فرق المعايرة عن الحي ----------

const mkCandles = (n, base = 100) => normalizeCandles(Array.from({ length: n }, (_, i) => ({
  time: 1_700_000_000_000 + i * 3_600_000,
  open: base + i * 0.1,
  high: base + i * 0.1 + 1,
  low: base + i * 0.1 - 1,
  close: base + i * 0.1 + 0.2,
  volume: 100 + i
})));

test('★5: القياس بلا مناطق يُعيد صفراً صريحاً لا نتيجة مُفبركة', () => {
  const r = sweepModeParity({ candles: mkCandles(50), zones: [], timeframe: '1h' });
  assert.deepEqual(r, { pairs: [], compared: 0, diffs: 0 });
});

test('★5: نفس السويبات تُقاس بالمعاملتين ونتيجتها منظمة ومحسوبة', () => {
  const candles = mkCandles(200);
  const sweepIndex = 120;
  const zone = {
    id: 'z1',
    symbol: 'BTCUSDT',
    kind: 'horizontal_ssl',
    state: 'swept',
    sweptAt: candles[sweepIndex].time,
    atr: 2,
    liquidityLevel: candles[sweepIndex].low
  };
  const r = sweepModeParity({ candles, zones: [zone], timeframe: '1h', limit: 5 });
  assert.equal(r.compared, 1, 'سويب واحد مطابَق بالزمن');
  assert.equal(r.pairs.length, 1);
  const p = r.pairs[0];
  assert.ok('published' in p && 'live' in p, 'الطرفان موجودان');
  assert.equal(typeof p.same, 'boolean');
  assert.equal(p.symbol, 'BTCUSDT');
  assert.equal(p.timeframe, '1h');
  assert.equal(r.diffs, p.same ? 0 : 1);
});

test('★5: منطقة غير مسحوبة لا تدخل القياس (لا تضخيم للعيّنة)', () => {
  const candles = mkCandles(200);
  const r = sweepModeParity({
    candles,
    zones: [{ id: 'z', symbol: 'X', kind: 'horizontal_ssl', state: 'confirmed', sweptAt: null, atr: 2, liquidityLevel: 99 }],
    timeframe: '1h'
  });
  assert.equal(r.compared, 0);
});

test('★5: سقف العيّنة مطبَّق (الكلفة محدودة صراحةً)', () => {
  const candles = mkCandles(300);
  const zones = Array.from({ length: 40 }, (_, i) => ({
    id: `z${i}`, symbol: 'BTCUSDT', kind: 'horizontal_ssl', state: 'swept',
    sweptAt: candles[200 + i]?.time ?? candles[250].time, atr: 2, liquidityLevel: candles[200].low
  }));
  const r = sweepModeParity({ candles, zones, timeframe: '1h', limit: 7 });
  assert.ok(r.compared <= 7, `المقيس ${r.compared} لا يتجاوز السقف`);
});

// ---------- التكاليف: الصافي بجانب الإجمالي ----------

test('التكاليف: الشرائح تعرض الصافي بعد الرسوم والانزلاق بجانب الإجمالي', () => {
  const trades = [
    { segmentKey: 'k', rr: 2, win: 1, netRr: 1.75, durationMs: 1000 },
    { segmentKey: 'k', rr: -1, win: 0, netRr: -1.2, durationMs: 1000 },
    { segmentKey: 'k', rr: 2, win: 1, netRr: 1.7, durationMs: 1000 }
  ];
  const rows = summarizeSegments(trades, { targetWinRate: 0.7, minTrades: 1 });
  const row = rows.find(r => r.key === 'k') ?? rows[0];
  assert.equal(row.winRate, 0.667, 'الإجمالي كما كان: قراره السعر لا التكاليف');
  assert.equal(row.netTrades, 3);
  assert.equal(row.netWinRate, 0.667);
  assert.equal(row.avgNetRr, 0.75, 'متوسط الصافي محسوب فعلاً (1.75-1.2+1.7)/3');
  assert.notEqual(row.avgRR, row.avgNetRr, 'الفرق ظاهر — لا ادّعاء');
});

test('التكاليف: شرائح بلا صافي لا تُنتج أرقاماً وهمية', () => {
  const rows = summarizeSegments([{ segmentKey: 'k', rr: 2, win: 1, durationMs: 10 }], { targetWinRate: 0.7, minTrades: 1 });
  const row = rows.find(r => r.key === 'k') ?? rows[0];
  assert.equal(row.netTrades, 0);
  assert.equal(row.avgNetRr, null, 'لا صافي ⇒ null لا صفر مضلّل');
  assert.equal(row.netWinRate, null);
});

// ---------- دمج أقسام الصحة ----------

test('المرحلة 0: كل قسم مُسجَّل يظهر في الرد (بما فيه المسجَّل متأخراً)', () => {
  const health = createHealth({ version: 'test', startedAt: Date.now(), log: { warn() {}, error() {}, log() {} } });
  health.addSection('market', () => ({ ok: 1 }));
  health.addSection('liquidityV2', () => ({ zones: 213, parityPct: 91.2 }));
  health.addSection('broken', () => { throw new Error('قياس فشل'); });
  const sections = health.sections();
  assert.deepEqual(Object.keys(sections).sort(), ['broken', 'liquidityV2', 'market']);
  assert.equal(sections.liquidityV2.zones, 213);
  assert.match(sections.broken.error, /قياس فشل/, 'فشل قسم واحد يُعرض ولا يُسقط الفحص');
});

// ---------- B2: كاش بطبقتين لبيانات المناطق ----------

test('B2: الطبقة الآلية الثقيلة لا تُجلب كل 30 ثانية كما كان', async () => {
  let clock = 1_000_000;
  let manualFetches = 0;
  let autoFetches = 0;
  const cache = createTwoTierCache({
    fetchManual: async () => { manualFetches += 1; return [{ id: 'm' }]; },
    fetchAuto: async () => { autoFetches += 1; return [{ id: 'a' }]; },
    manualMs: 5_000,
    autoMs: 120_000,
    now: () => clock
  });
  // 20 قراءة بفاصل 30 ثانية = 10 دقائق (سلوك المراقب الفعلي)
  for (let i = 0; i < 20; i += 1) {
    const rows = await cache.get();
    assert.equal(rows.length, 2);
    clock += 30_000;
  }
  // قبل الإصلاح: 20 جلباً ثقيلاً للطبقة الآلية. بعده: 5 أو 6 فقط (كل دقيقتين).
  assert.ok(autoFetches <= 6, `الجلب الثقيل ${autoFetches} مرة في 10 دقائق بدل 20`);
  // الطبقة اليدوية أخفّ، ونافذتها أقصر — لكنها لا تُجلب 20 مرة أيضاً لأن الطلبين يتشاركان النافذة
  assert.ok(manualFetches >= autoFetches, 'اليدوي يُجلب على الأقل بعدد الآلي');
});

test('B2: الكتابة اليدوية تُبطل فوراً، والكتابة الآلية لا تُهدِر كاش اليدوي', async () => {
  let manualFetches = 0;
  let autoFetches = 0;
  const cache = createTwoTierCache({
    fetchManual: async () => { manualFetches += 1; return [1]; },
    fetchAuto: async () => { autoFetches += 1; return [2]; },
    manualMs: 60_000,
    autoMs: 120_000,
    now: () => 1_000_000
  });
  await cache.get();
  await cache.get();
  assert.equal(manualFetches, 1, 'الكاش يمنع التكرار داخل النافذة');
  assert.equal(autoFetches, 1);
  cache.invalidateAuto();
  await cache.get();
  assert.equal(manualFetches, 1, 'إبطال الآلي لا يُهدِر اليدوي');
  assert.equal(autoFetches, 2);
  cache.invalidate();
  await cache.get();
  assert.equal(manualFetches, 2, 'الإبطال الكامل يُعيد الجلب');
  assert.equal(autoFetches, 3);
});

test('B2: عدّادات الجلب هي الدليل — تُعرض ولا تُدَّعى', async () => {
  let clock = 0;
  const cache = createTwoTierCache({
    fetchManual: async () => [1],
    fetchAuto: async () => [2],
    manualMs: 1_000,
    autoMs: 10_000,
    now: () => clock
  });
  await cache.get();
  clock += 500;
  await cache.get();
  clock += 5_000;
  await cache.get();
  const s = cache.stats();
  assert.equal(s.manualFetches, 2, 'الجلب مرتين: أول مرة ثم بعد انتهاء النافذة');
  assert.equal(s.autoFetches, 1, 'الطبقة الآلية بقيت مخزّنة');
  assert.equal(s.hitBoth, 1, 'إصابة كاملة مرتين (كاش)+واحدة جزئية');
  assert.ok(s.lastGapMs >= 5_000, 'الفجوة المقيسة بين الجلبتين مسجّلة');
  assert.equal(s.manualMs, 1_000);
});

test('B2: فشل الجلب يُعدّ ولا يُبتلع صامتاً', async () => {
  const cache = createTwoTierCache({
    fetchManual: async () => { throw new Error('db down'); },
    fetchAuto: async () => [2],
    now: () => 0
  });
  await assert.rejects(() => cache.get(), /db down/);
  const s = cache.stats();
  assert.equal(s.errors, 1);
  assert.equal(s.manualAttempts, 1, 'المحاولة معدودة');
  assert.equal(s.manualFetches, 0, 'لا جلب ناجح — والفرق بين الرقمين هو الدليل');
  assert.ok(s.lastErrorAt >= 0, 'وقت آخر خطأ مسجّل');
});

// ---------- ★5: الواجهة تُصعِّد قياس الفرق (وليس القياس الصامت) ----------

test('★5: قسم المعايرة يحمل قياس الفرق بين المعايرة والحي قبل أي تشغيل', () => {
  const engine = createLiveOpportunityEngine({
    fetchPrices: async () => ({}),
    fetchBookSignals: async () => null,
    fetchRawKlines: async () => [],
    zoneSource: () => [],
    resolveTargets: async () => [],
    log: { warn() {}, error() {}, log() {}, info() {} },
    config: { calibration: { parityStride: 12, parityLimit: 40 } }
  });
  const cal = engine.getCalibration();
  assert.ok(cal.parity, 'قياس الفرق مُصعَّد في قسم المعايرة');
  assert.equal(cal.parity.compared, 0);
  assert.equal(cal.parity.diffs, 0);
  assert.equal(cal.parity.diffRate, null, 'بلا عيّنات: null لا صفر مضلّل');
  assert.equal(cal.parity.publishedWindow, 12, 'نافذة المعايرة المنشورة ظاهرة');
  assert.equal(cal.parity.liveWindow, 3, 'نافذة المحرك الحي ظاهرة — الفرق مصرَّح به لا مخفي');
  assert.deepEqual(cal.parity.samples, []);
  assert.equal(engine.getCalibration().targetWinRate > 0, true, 'بقية الحقول كما كانت');
});

test('★5: بلا جمّاع ظل لا يتعطّل المحرك (القياس اختياري)', () => {
  const engine = createLiveOpportunityEngine({
    fetchPrices: async () => ({}),
    fetchBookSignals: async () => null,
    fetchRawKlines: async () => [],
    zoneSource: () => [],
    resolveTargets: async () => [],
    log: { warn() {}, error() {}, log() {}, info() {} }
    // shadow غير مُمرَّر
  });
  assert.ok(engine.getCalibration().parity, 'القياس يعمل بلا جمّاع ظل');
  assert.equal(typeof engine.start, 'function');
});

test('B2: عند فشل القاعدة لا تُضرب بلا سقف — كاش سلبي قصير يعيد نفس الخطأ', async () => {
  let clock = 1_000;
  let calls = 0;
  const cache = createTwoTierCache({
    fetchManual: async () => { calls += 1; throw new Error('db down'); },
    fetchAuto: async () => [2],
    negativeMs: 3_000,
    now: () => clock
  });
  await assert.rejects(() => cache.get(), /db down/);
  const afterFirst = calls;
  // عاصفة قراءات خلال نافذة الكاش السلبي: لا محاولات جديدة على القاعدة المتعثّرة
  for (let i = 0; i < 20; i += 1) {
    clock += 100;
    await assert.rejects(() => cache.get(), /db down/);
  }
  assert.equal(calls, afterFirst, `لا محاولة جديدة داخل النافذة (المحاولات: ${calls})`);
  const s = cache.stats();
  assert.equal(s.negativeHits, 20, 'القراءات المخدومة من الكاش السلبي معدودة');
  // بعد انتهاء النافذة: محاولة جديدة (الشفاء ممكن بلا إعادة تشغيل)
  clock += 5_000;
  await assert.rejects(() => cache.get(), /db down/);
  assert.equal(calls, afterFirst + 1, 'محاولة واحدة بعد انتهاء النافذة');
});

test('B2: كتابة ناجحة تُسقط الكاش السلبي فوراً', async () => {
  let clock = 0;
  let failing = true;
  const cache = createTwoTierCache({
    fetchManual: async () => { if (failing) throw new Error('down'); return [1]; },
    fetchAuto: async () => [2],
    negativeMs: 60_000,
    now: () => clock
  });
  await assert.rejects(() => cache.get(), /down/);
  failing = false;
  cache.invalidate(); // إبطال صريح بعد كتابة
  const rows = await cache.get();
  assert.deepEqual(rows, [1, 2], 'الشفاء فوري بلا انتظار النافذة');
  assert.equal(cache.stats().negativeHits, 0);
});
