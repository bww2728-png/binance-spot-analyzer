/* اختبارات محرك «الفرص الحية» — حتمية بالكامل، بلا شبكة
 *
 * تغطي: هندسة المنطقة · حالة السويب والانتقالات · درجة التدفق · الأهداف والخطة ·
 * البوابات · الشريحة التالية تحتها · محاكاة الصفقة · الشرائح والمعايرة ·
 * آلة الحالة (سويب → استعادة → نشر / إبطال) · ترتيب الفريمات من 1m · منع التكرار.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneGeometry, sweepPhase, confBand, flowTier, segmentKey, segmentLookupKeys,
  flowScore, longTargets, buildLongPlan, compositeScore, gates, nextSslBelow,
  simulateSweep, calibrateSweeps, summarizeSegments, SWEEP_PHASES
} from '../live-opportunities/scanner.mjs';
import {
  TF_ORDER, tfRank, tfSeconds, trackerKey, initTracker, advanceTracker,
  markPublished, canPublish, publishKeyFor, pickWatchlist, pruneTrackers
} from '../live-opportunities/tracker.mjs';

const zone = (over = {}) => ({
  id: 'z1', symbol: 'BTCUSDT', timeframe: '15m', kind: 'horizontal_ssl',
  referenceLevel: 100, liquidityLevel: 99, atr: 1, confidence: 0.7, touches: 4,
  state: 'candidate', ...over
});

// ═══ هندسة المنطقة ═══

test('zoneGeometry: المسافات بـ ATR والنسبة المئوية', () => {
  const g = zoneGeometry(zone(), 102, 1);
  assert.equal(g.distancePct, 2);
  assert.equal(g.distanceAtr, 2);
  assert.equal(g.toLiquidityAtr, 3);
  assert.equal(g.belowLiquidity, false);
  assert.equal(g.aboveReference, true);
});

test('zoneGeometry: ATR غير صالح → احتياطي 0.5% من المرجع', () => {
  const g = zoneGeometry(zone(), 100, 0);
  assert.equal(g.atr, 0.5);
});

test('zoneGeometry: مستويات غير صالحة → finite=false بلا انفجار', () => {
  const g = zoneGeometry({ referenceLevel: null, liquidityLevel: null }, 100, 1);
  assert.equal(g.finite, false);
  assert.equal(g.distancePct, null);
});

// ═══ حالة السويب ═══

test('sweepPhase: منطقة بعيدة → armed', () => {
  const r = sweepPhase({ zone: zone(), price: 110, atr: 1 });
  assert.equal(r.phase, 'armed');
});

test('sweepPhase: داخل 1.5 ATR من مستوى السيولة → approaching', () => {
  const r = sweepPhase({ zone: zone(), price: 100.2, atr: 1 });
  assert.equal(r.phase, 'approaching');
});

test('sweepPhase: السعر عند مستوى السيولة → swept', () => {
  const r = sweepPhase({ zone: zone(), price: 99, atr: 1 });
  assert.equal(r.phase, 'swept');
});

test('sweepPhase: السعر تحت مستوى السيولة بـ > 0.6 ATR → invalidated (فشل السويب)', () => {
  const r = sweepPhase({ zone: zone(), price: 98.3, atr: 1 });
  assert.equal(r.phase, 'invalidated');
});

test('sweepPhase: كان مسحوباً وعاد فوق المرجع → reclaimed', () => {
  const r = sweepPhase({ zone: zone(), price: 100.5, atr: 1, prev: 'swept' });
  assert.equal(r.phase, 'reclaimed');
});

test('sweepPhase: مسحوب ولم يعد بعد → swept (انتظار)', () => {
  const r = sweepPhase({ zone: zone(), price: 99.2, atr: 1, prev: 'swept' });
  assert.equal(r.phase, 'swept');
});

test('SWEEP_PHASES: يشمل كل الحالات المستخدمة في آلة الحالة', () => {
  for (const p of ['armed', 'approaching', 'swept', 'reclaimed', 'invalidated']) {
    assert.ok(SWEEP_PHASES.includes(p), `ينقص ${p}`);
  }
});

// ═══ درجة تدفق الأوامر ═══

test('flowScore: كل الأدوات شرائية → درجة عالية مع أسباب', () => {
  const r = flowScore({
    cvd: { buyRatioPct: 60 },
    bubbles: [{ type: 'aggressive_buy', price: 99, notional: 50000 }],
    book: 1.6,
    icebergs: [{ price: 99, hits: 5 }],
    spoofs: [{ price: 99 }],
    sweepLow: 99, price: 99, atr: 1
  });
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'high');
  assert.ok(r.reasons.length >= 5);
});

test('flowScore: بلا أي إشارة → صفر', () => {
  const r = flowScore({ cvd: { buyRatioPct: 50 }, sweepLow: 99, price: 99 });
  assert.equal(r.score, 0);
  assert.equal(r.tier, 'low');
});

test('flowScore: CVD بيعي لا يضيف شيئاً', () => {
  const r = flowScore({ cvd: { buyRatioPct: 40 }, sweepLow: 99, price: 99 });
  assert.equal(r.components.cvd, 0);
});

test('flowScore: فقاعة شراء عند قاع السويب أقوى من بعيدة', () => {
  const atSweep = flowScore({ bubbles: [{ type: 'aggressive_buy', price: 99, notional: 5000 }], sweepLow: 99, price: 99 });
  const far = flowScore({ bubbles: [{ type: 'aggressive_buy', price: 95, notional: 5000 }], sweepLow: 99, price: 99 });
  assert.equal(atSweep.components.bubble, 30);
  assert.equal(far.components.bubble, 18);
});

test('flowScore: فقاعة بيعية لا تُحتسب', () => {
  const r = flowScore({ bubbles: [{ type: 'aggressive_sell', price: 99, notional: 90000 }], sweepLow: 99, price: 99 });
  assert.equal(r.components.bubble, 0);
});

test('flowTier: عتبات الفئات', () => {
  assert.equal(flowTier(80), 'high');
  assert.equal(flowTier(50), 'mid');
  assert.equal(flowTier(10), 'low');
});

// ═══ الشرائح ═══

test('confBand: فئات الثقة', () => {
  assert.equal(confBand(0.9), 'b3');
  assert.equal(confBand(0.6), 'b2');
  assert.equal(confBand(0.3), 'b1');
});

test('segmentKey: الصيغة فريم|تدفق|ثقة', () => {
  assert.equal(segmentKey({ timeframe: '5m', flowTier: 'high', confBand: 'b3' }), '5m|high|b3');
});

test('segmentLookupKeys: الأدق أولاً ثم الأعمّ', () => {
  const keys = segmentLookupKeys({ timeframe: '5m', flowTier: 'high', confBand: 'b3' });
  assert.deepEqual(keys, ['5m|high|b3', '5m|high|all', '5m|all|b3', '5m|all|all']);
});

// ═══ الأهداف والخطة ═══

test('longTargets: يستبعد ما دون الدخول ويرتّب تصاعدياً', () => {
  const t = longTargets({
    entry: 100, atr: 1, referenceLevel: 101,
    bslAbove: [105, 99], profile: { vah: 103, poc: 102 }, prevDayHigh: 104
  });
  assert.ok(t.every(x => x.price > 100));
  const prices = t.map(x => x.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('longTargets: يدمج المستويات المتقاربة (بلا تكرار)', () => {
  const t = longTargets({ entry: 100, atr: 1, bslAbove: [105, 105.02, 105.05] });
  assert.equal(t.length, 1);
});

test('longTargets: بلا أي هدف → أهداف R احتياطية', () => {
  const t = longTargets({ entry: 100, atr: 1 });
  assert.equal(t.length, 2);
  assert.ok(t.every(x => x.price > 100));
});

test('buildLongPlan: الوقف تحت أدنى قاع السويب + الهدف يحقق R:R المطلوب', () => {
  const p = buildLongPlan({
    entry: 100, sweepLow: 98, atr: 1, bandPct: 0.0025,
    targets: [{ price: 101.5 }, { price: 105 }], minRR: 2
  });
  assert.ok(p.stop < 98, 'الوقف تحت قاع السويب');
  assert.equal(p.tp, 105, 'اختار أول هدف يحقق 2R');
  assert.ok(p.rr >= 2);
  assert.equal(p.valid, true, p.violations?.join(' · '));
});

test('buildLongPlan: R:R غير كافٍ → خطة غير صالحة بسبب صريح', () => {
  const p = buildLongPlan({ entry: 100, sweepLow: 99, atr: 1, targets: [{ price: 101 }], minRR: 3 });
  assert.ok(p.rr < 3);
  assert.equal(p.valid, false);
  assert.ok(p.violations.some(v => v.includes('R:R')));
});

test('buildLongPlan: لا هدف فوق الدخول → غير صالحة بسبب واضح', () => {
  const p = buildLongPlan({ entry: 100, sweepLow: 99, atr: 1, targets: [{ price: 99 }], minRR: 2 });
  assert.equal(p.valid, false);
  assert.ok(p.violations.some(v => v.includes('هدف')));
});

test('buildLongPlan: دخول غير صالح → مرفوض', () => {
  const p = buildLongPlan({ entry: 0, sweepLow: 99, atr: 1 });
  assert.equal(p.valid, false);
});

// ═══ الدرجة المركبة والبوابات ═══

test('compositeScore: أعلى مع ثقة عالية وتدفق عالٍ وجلسة prime', () => {
  const high = compositeScore({ zoneConfidence: 0.9, flow: 90, rr: 3, sessionTier: 'prime', locationState: 'imbalance_up', sweepDepthAtr: 1.5 });
  const low = compositeScore({ zoneConfidence: 0.2, flow: 5, rr: 0.5, sessionTier: 'lull', locationState: 'imbalance_down', sweepDepthAtr: 0 });
  assert.ok(high > 80);
  assert.ok(low < 25);
});

test('gates: تمرير كامل', () => {
  const g = gates({ rr: 2.5, sessionTier: 'prime', locationState: 'balance', composite: 70 });
  assert.equal(g.pass, true);
  assert.equal(g.blockers.length, 0);
});

test('gates: تمنع R:R منخفض والجلسة الهادئة والانحياز الهبوطي والدرجة الضعيفة', () => {
  const g = gates({ rr: 1, sessionTier: 'lull', locationState: 'imbalance_down', composite: 30 });
  assert.equal(g.pass, false);
  assert.equal(g.blockers.length, 4);
});

// ═══ المنطقة التالية تحتها (سيناريو فشل السويب) ═══

test('nextSslBelow: أقرب منطقة SSL نشطة تحت السعر', () => {
  const zones = [
    zone({ id: 'a', liquidityLevel: 95, state: 'candidate' }),
    zone({ id: 'b', liquidityLevel: 90, state: 'candidate' }),
    zone({ id: 'c', liquidityLevel: 99, state: 'candidate' })
  ];
  assert.equal(nextSslBelow(zones, 100).id, 'c', 'الأقرب إلى السعر');
});

test('nextSslBelow: عند تمرير قاع السويب يُختار المستوى التالي تحته (سيناريو فشل السويب)', () => {
  const zones = [
    zone({ id: 'a', liquidityLevel: 95, state: 'candidate' }),
    zone({ id: 'b', liquidityLevel: 90, state: 'candidate' }),
    zone({ id: 'c', liquidityLevel: 99, state: 'candidate' })
  ];
  assert.equal(nextSslBelow(zones, 98.5).id, 'a', 'تحت قاع السويب الفاشل مباشرةً');
});

test('nextSslBelow: يستبعد المسحوبة والمستبعدة صراحةً', () => {
  const zones = [
    zone({ id: 'a', liquidityLevel: 95, state: 'swept' }),
    zone({ id: 'b', liquidityLevel: 90, state: 'candidate' })
  ];
  assert.equal(nextSslBelow(zones, 100).id, 'b');
  assert.equal(nextSslBelow(zones, 100, { excludeIds: ['b'] }), null);
});

test('nextSslBelow: يتجاهل مناطق BSL ويحترم حد المسافة', () => {
  const zones = [
    zone({ id: 'bsl', kind: 'horizontal_bsl', liquidityLevel: 95 }),
    zone({ id: 'far', liquidityLevel: 50 })
  ];
  assert.equal(nextSslBelow(zones, 100), null);
});

// ═══ آلة الحالة ═══

test('tfRank: الترتيب من 1m صعوداً (المطلوب: يبدأ من الدقيقة)', () => {
  assert.equal(TF_ORDER[0], '1m');
  assert.ok(tfRank('1m') < tfRank('5m'));
  assert.ok(tfRank('5m') < tfRank('1h'));
  assert.ok(tfRank('1h') < tfRank('1d'));
});

test('tfSeconds: ثواني الفريم', () => {
  assert.equal(tfSeconds('1m'), 60);
  assert.equal(tfSeconds('15m'), 900);
  assert.equal(tfSeconds('4h'), 14400);
  assert.equal(tfSeconds('1d'), 86400);
});

test('trackerKey: مفتاح فريد لكل (زوج × فريم × منطقة)', () => {
  assert.equal(trackerKey('BTCUSDT', '15m', 'z1'), 'BTCUSDT|15m|z1');
});

test('initTracker: منطقة نشطة → armed', () => {
  const st = initTracker(zone(), 1_000_000);
  assert.equal(st.phase, 'armed');
  assert.equal(st.attempts, 0);
});

test('initTracker: منطقة مسحوبة حديثاً → swept مع حفظ وقت السويب', () => {
  const now = 1_700_000_000_000;
  const st = initTracker(zone({ state: 'swept', sweptAt: now / 1000 - 300 }), now);
  assert.equal(st.phase, 'swept');
  assert.equal(st.staleSweep, false);
  assert.equal(st.sweepObservedAt, (now / 1000 - 300) * 1000);
});

test('initTracker: منطقة مسحوبة قديماً → armed مع وسم staleSweep (لا فرصة على سويب قديم)', () => {
  const now = 1_700_000_000_000;
  const st = initTracker(zone({ state: 'swept', sweptAt: now / 1000 - 900 * 200 }), now);
  assert.equal(st.staleSweep, true);
  assert.notEqual(st.phase, 'swept');
});

test('advanceTracker: اقتراب → سويب → استعادة (المسار الكامل)', () => {
  const now = 1_700_000_000_000;
  let st = initTracker(zone(), now);
  st = advanceTracker(st, { zone: zone(), price: 100.2, atr: 1, now }).next;
  assert.equal(st.phase, 'approaching');
  const swept = advanceTracker(st, { zone: zone(), price: 99, atr: 1, now: now + 60_000 });
  assert.equal(swept.next.phase, 'swept');
  assert.ok(swept.events.some(e => e.type === 'sweep'));
  const rec = advanceTracker(swept.next, { zone: zone(), price: 100.5, atr: 1, now: now + 120_000 });
  assert.equal(rec.next.phase, 'reclaimed');
  assert.ok(rec.events.some(e => e.type === 'reclaim'));
});

test('advanceTracker: كسر حقيقي → invalidated + زيادة عدّاد المحاولات', () => {
  const now = 1_700_000_000_000;
  const st = initTracker(zone(), now);
  const r = advanceTracker(st, { zone: zone(), price: 98, atr: 1, now: now + 60_000 });
  assert.equal(r.next.phase, 'invalidated');
  assert.equal(r.next.attempts, 1);
  assert.ok(r.events.some(e => e.type === 'invalidated'));
});

test('advanceTracker: السويب يُسجَّل مرة واحدة فقط ولو تكررت الدورات', () => {
  const now = 1_700_000_000_000;
  let st = advanceTracker(initTracker(zone(), now), { zone: zone(), price: 99, atr: 1, now }).next;
  const again = advanceTracker(st, { zone: zone(), price: 98.9, atr: 1, now: now + 60_000 });
  assert.equal(again.next.phase, 'swept');
  assert.equal(again.events.filter(e => e.type === 'sweep').length, 0, 'لا تكرار لحدث السويب');
  assert.equal(again.next.sweepLow, 98.9, 'يحدّث أدنى قاع');
});

test('advanceTracker: انتهاء نافذة النضارة بلا استعادة → إبطال (فشل السويب)', () => {
  const now = 1_700_000_000_000;
  let st = advanceTracker(initTracker(zone(), now), { zone: zone(), price: 99, atr: 1, now }).next;
  // نافذة النضارة = 6 شموع × 15 دقيقة = 5400 ثانية
  const late = advanceTracker(st, { zone: zone(), price: 99.5, atr: 1, now: now + 5_500_000 });
  assert.equal(late.next.phase, 'invalidated');
  assert.ok(late.events.some(e => e.type === 'expired'));
  assert.equal(late.next.attempts, 1);
});

test('canPublish: يُسمح فقط بعد الاستعادة مع سويب طازج', () => {
  const now = 1_700_000_000_000;
  const armed = initTracker(zone(), now);
  assert.equal(canPublish(armed, publishKeyFor(armed)), false);
  let st = advanceTracker(armed, { zone: zone(), price: 99, atr: 1, now }).next;
  assert.equal(canPublish(st, publishKeyFor(st)), false, 'السويب وحده لا يكفي — لا دخول بلا استعادة');
  st = advanceTracker(st, { zone: zone(), price: 100.5, atr: 1, now: now + 60_000 }).next;
  assert.equal(canPublish(st, publishKeyFor(st)), true);
});

test('canPublish: لا نشر مرتين لنفس السويب', () => {
  const now = 1_700_000_000_000;
  let st = advanceTracker(initTracker(zone(), now), { zone: zone(), price: 99, atr: 1, now }).next;
  st = advanceTracker(st, { zone: zone(), price: 100.5, atr: 1, now: now + 60_000 }).next;
  const key = publishKeyFor(st);
  st = markPublished(st, key, now + 70_000);
  assert.equal(canPublish(st, key), false);
});

test('canPublish: منطقة بسويب قديم (staleSweep) لا تُنشر', () => {
  const now = 1_700_000_000_000;
  const st = { ...initTracker(zone(), now), phase: 'reclaimed', staleSweep: true, sweepObservedAt: now };
  assert.equal(canPublish(st, publishKeyFor(st)), false);
});

test('pickWatchlist: الفريم الأدق أولاً ثم الأقرب مسافةً', () => {
  const zones = [
    zone({ id: 'h1', timeframe: '1h', liquidityLevel: 99.5 }),
    zone({ id: 'm1', timeframe: '1m', liquidityLevel: 90 }),
    zone({ id: 'm2', timeframe: '1m', liquidityLevel: 99 })
  ];
  const rows = pickWatchlist(zones, 100, { maxDistancePct: 0.5 });
  assert.deepEqual(rows.map(r => r.zone.id), ['m2', 'm1', 'h1']);
});

test('pickWatchlist: يستبعد BSL والبعيدة والمستبعدة', () => {
  const zones = [
    zone({ id: 'bsl', kind: 'horizontal_bsl' }),
    zone({ id: 'far', liquidityLevel: 10 }),
    zone({ id: 'ok' })
  ];
  const rows = pickWatchlist(zones, 100, { maxDistancePct: 0.3, excludeIds: ['ok'] });
  assert.equal(rows.length, 0);
});

test('pruneTrackers: يحذف ما خرج من المخزون فقط', () => {
  const now = 1_700_000_000_000;
  const map = new Map();
  const keyA = trackerKey('BTCUSDT', '15m', 'a');
  const keyB = trackerKey('BTCUSDT', '15m', 'b');
  map.set(keyA, initTracker(zone({ id: 'a' }), now));
  map.set(keyB, initTracker(zone({ id: 'b' }), now));
  const removed = pruneTrackers(map, new Set([keyA]), now);
  assert.deepEqual(removed, [keyB]);
  assert.equal(map.size, 1);
  assert.ok(map.has(keyA));
});

// ═══ محاكاة الصفقة والمعايرة ═══

const buildCandles = (rows) => rows.map(([time, o, h, l, c], i) => ({ time, open: o, high: h, low: l, close: c, volume: 100, index: i }));

test('simulateSweep: سويب ثم استعادة ثم وصول الهدف → win=1', () => {
  const candles = buildCandles([
    [1, 105, 106, 104, 105], [2, 105, 106, 104, 105], [3, 105, 106, 104, 105],
    [4, 105, 106, 104, 105], [5, 105, 106, 104, 105], [6, 105, 106, 104, 105],
    [7, 105, 106, 104, 105], [8, 105, 106, 104, 105], [9, 105, 106, 104, 105],
    [10, 105, 106, 104, 105], [11, 105, 106, 104, 105], [12, 105, 106, 104, 105],
    [13, 105, 106, 104, 105], [14, 105, 106, 104, 105], [15, 105, 106, 104, 105],
    [16, 105, 106, 104, 105], [17, 105, 106, 104, 105], [18, 105, 106, 104, 105],
    [19, 105, 106, 104, 105], [20, 105, 106, 104, 105], [21, 105, 106, 104, 105],
    [22, 105, 106, 104, 105], [23, 105, 106, 104, 105], [24, 105, 106, 104, 105],
    [25, 105, 106, 104, 105], [26, 105, 106, 104, 105], [27, 105, 106, 104, 105],
    [28, 105, 106, 104, 105], [29, 105, 106, 104, 105], [30, 105, 106, 104, 105],
    [31, 100, 101, 98.5, 99.2],       // شمعة السويب: تلامس 98.5 تحت مستوى السيولة 99
    [32, 99.4, 101, 99.0, 100.6],     // الاستعادة فوق المرجع 100 → دخول
    [33, 100.6, 103, 100.4, 102.8],
    [34, 102.8, 107, 102.5, 106.5]    // وصول الهدف (أعلى نافذة سابقة 106)
  ]);
  const sim = simulateSweep({
    candles, sweepIndex: 30, zone: zone({ referenceLevel: 100, liquidityLevel: 99 }), atr: 1, minRR: 2
  });
  assert.equal(sim.outcome, 'decided');
  assert.equal(sim.win, 1);
  assert.ok(sim.entry > 100);
});

test('simulateSweep: ضرب الوقف قبل الهدف → win=0', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push([i + 1, 105, 106, 104, 105]);
  rows.push([31, 100, 101, 98.5, 99.2]);
  rows.push([32, 99.4, 101, 99.0, 100.6]);
  rows.push([33, 100.6, 100.8, 96, 96.5]); // هبوط حاد تحت الوقف
  const candles = buildCandles(rows);
  const sim = simulateSweep({
    candles, sweepIndex: 30, zone: zone({ referenceLevel: 100, liquidityLevel: 99 }), atr: 1, minRR: 2
  });
  assert.equal(sim.outcome, 'decided');
  assert.equal(sim.win, 0);
});

test('simulateSweep: لا استعادة خلال النافذة → no_entry', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push([i + 1, 105, 106, 104, 105]);
  rows.push([31, 100, 101, 98.5, 99.0]);
  for (let i = 32; i < 42; i += 1) rows.push([i, 99, 99.5, 97.5, 98.2]); // يبقى تحت المرجع
  const candles = buildCandles(rows);
  const sim = simulateSweep({
    candles, sweepIndex: 30, zone: zone({ referenceLevel: 100, liquidityLevel: 99 }), atr: 1, maxReclaimBars: 4
  });
  assert.equal(sim.outcome, 'no_entry');
  assert.ok(sim.reason.includes('استعادة'));
});

test('simulateSweep: مدخلات ناقصة → no_entry بلا انفجار', () => {
  assert.equal(simulateSweep({ candles: [], sweepIndex: 0, zone: zone() }).outcome, 'no_entry');
  assert.equal(simulateSweep({ candles: buildCandles([[1, 1, 1, 1, 1]]), sweepIndex: 0, zone: zone() }).outcome, 'no_entry');
});

test('calibrateSweeps: يحوّل مناطق SSL المسحوبة إلى صفقات مصنّفة', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push([i + 1, 105, 106, 104, 105]);
  rows.push([31, 100, 101, 98.5, 99.2]);
  rows.push([32, 99.4, 101, 99.0, 100.6]);
  rows.push([33, 100.6, 103, 100.4, 102.8]);
  rows.push([34, 102.8, 107, 102.5, 106.5]);
  const candles = buildCandles(rows);
  const zones = [
    { id: 's1', kind: 'horizontal_ssl', state: 'swept', sweptAt: 31, referenceLevel: 100, liquidityLevel: 99, atr: 1, confidence: 0.8 },
    { id: 'b1', kind: 'horizontal_bsl', state: 'swept', sweptAt: 31, referenceLevel: 100, liquidityLevel: 101, atr: 1 }
  ];
  const { trades } = calibrateSweeps({ candles, zones, timeframe: '15m', rrGrid: [2] });
  assert.equal(trades.length, 1, 'منطقة BSL تُستبعد — المحرك شرائي فقط');
  assert.equal(trades[0].win, 1);
  assert.equal(trades[0].band, 'b3');
  assert.equal(trades[0].minRR, 2);
});

test('calibrateSweeps: شبكة R:R تُنتج صفقة لكل هدف (الهدف الأقرب أسهل)', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push([i + 1, 105, 106, 104, 105]);
  rows.push([31, 100, 101, 98.5, 99.2]);
  rows.push([32, 99.4, 101, 99.0, 100.6]);
  rows.push([33, 100.6, 103, 100.4, 102.8]);
  rows.push([34, 102.8, 107, 102.5, 106.5]);
  const candles = buildCandles(rows);
  const zones = [{ id: 's1', kind: 'horizontal_ssl', state: 'swept', sweptAt: 31, referenceLevel: 100, liquidityLevel: 99, atr: 1, confidence: 0.8 }];
  const { trades } = calibrateSweeps({ candles, zones, timeframe: '15m', rrGrid: [1.2, 2, 3] });
  // هدف 3R بعد اتساع نطاق الوقف يعطي أقل من 3R فعلياً → يُرفض (بوابة الجودة)، والباقيان يُقرَّران
  assert.equal(trades.length, 2, 'الأهداف القابلة للتحقيق فقط');
  assert.deepEqual(trades.map(t => t.minRR), [1.2, 2]);
});

test('calibrateSweeps: منطقة بلا sweptAt مطابق تُتخطى', () => {
  const candles = buildCandles(Array.from({ length: 40 }, (_, i) => [i + 1, 100, 101, 99, 100]));
  const zones = [{ id: 's1', kind: 'horizontal_ssl', state: 'swept', sweptAt: 999, referenceLevel: 100, liquidityLevel: 99, atr: 1 }];
  assert.equal(calibrateSweeps({ candles, zones, timeframe: '5m' }).trades.length, 0);
});

test('calibrateSweeps: سويب ضحل جداً يُرفض بسبب صريح (بوابة الجودة)', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push([i + 1, 105, 106, 104, 105]);
  rows.push([31, 100, 101, 99.95, 99.98]);  // لمسة سطحية لمستوى السيولة 99
  rows.push([32, 99.98, 101, 99.9, 100.6]);
  rows.push([33, 100.6, 103, 100.4, 102.8]);
  const candles = buildCandles(rows);
  const zones = [{ id: 's1', kind: 'horizontal_ssl', state: 'swept', sweptAt: 31, referenceLevel: 100, liquidityLevel: 99, atr: 1, confidence: 0.8 }];
  const { trades, rejected } = calibrateSweeps({ candles, zones, timeframe: '5m', minDepthAtr: 0.15 });
  assert.equal(trades.length, 0);
  assert.ok(Object.keys(rejected).some(k => k.includes('ضحل')), `أسباب الرفض: ${JSON.stringify(rejected)}`);
});

test('calibrateSweeps: فلترة الجلسة تُطبَّق عند تمريرها', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push([i + 1, 105, 106, 104, 105]);
  rows.push([31, 100, 101, 98.5, 99.2]);
  rows.push([32, 99.4, 101, 99.0, 100.6]);
  rows.push([33, 100.6, 103, 100.4, 102.8]);
  rows.push([34, 102.8, 107, 102.5, 106.5]);
  const candles = buildCandles(rows);
  const zones = [{ id: 's1', kind: 'horizontal_ssl', state: 'swept', sweptAt: 31, referenceLevel: 100, liquidityLevel: 99, atr: 1, confidence: 0.8 }];
  const lull = calibrateSweeps({ candles, zones, timeframe: '5m', rrGrid: [2], sessionTierOf: () => 'lull' });
  assert.equal(lull.trades.length, 0);
  assert.ok(Object.keys(lull.rejected).some(k => k.includes('فتكة')));
  const prime = calibrateSweeps({ candles, zones, timeframe: '5m', rrGrid: [2], sessionTierOf: () => 'prime' });
  assert.equal(prime.trades.length, 1);
  const primeOnly = calibrateSweeps({ candles, zones, timeframe: '5m', rrGrid: [2], sessionTierOf: () => 'normal', requireSessionPrime: true });
  assert.equal(primeOnly.trades.length, 0, 'مع requireSessionPrime تُرفض الجلسات العادية');
});

test('summarizeSegments: نسبة نجاح + تمليس بايزي + بناء الشريحة العامة', () => {
  const trades = [
    { timeframe: '5m', band: 'b3', win: 1, rr: 2, minRR: 2 },
    { timeframe: '5m', band: 'b3', win: 1, rr: 2.5, minRR: 2 },
    { timeframe: '5m', band: 'b3', win: 0, rr: 2, minRR: 2 }
  ];
  const rows = summarizeSegments(trades, { minTrades: 2 });
  const exact = rows.find(r => r.key === '5m|all|b3');
  const general = rows.find(r => r.key === '5m|all|all');
  assert.equal(exact.trades, 3);
  assert.equal(exact.wins, 2);
  assert.equal(exact.winRate, 0.667);
  assert.ok(exact.smoothedWinRate < exact.winRate, 'التمليس يسحب العينة الصغيرة نحو السابق');
  assert.ok(general, 'الشريحة العامة مبنية أيضاً');
});

test('summarizeSegments: تختار الأعلى R:R بين المؤهَّلة (≥60% وعيّنة كافية)', () => {
  // هدف قريب 1.2R: نسبة عالية · هدف بعيد 2.5R: نسبة عالية أيضاً → يُختار الأبعد (أفضل عائد)
  const trades = [];
  for (let i = 0; i < 20; i += 1) {
    trades.push({ timeframe: '1h', band: 'b3', win: i < 15 ? 1 : 0, rr: 1.2, minRR: 1.2 }); // 75%
    trades.push({ timeframe: '1h', band: 'b3', win: i < 14 ? 1 : 0, rr: 2.5, minRR: 2.5 }); // 70%
  }
  const seg = summarizeSegments(trades, { minTrades: 12, targetWinRate: 0.6 }).find(r => r.key === '1h|all|b3');
  assert.equal(seg.minRR, 2.5, 'اختار الهدف الأبعد لأنه ما زال مؤهَّلاً');
  assert.ok(seg.smoothedWinRate >= 0.6);
});

test('summarizeSegments: الهدف البعيد غير المؤهَّل يُستبعد لصالح الأقرب المؤهَّل', () => {
  const trades = [];
  for (let i = 0; i < 20; i += 1) {
    trades.push({ timeframe: '1h', band: 'b2', win: i < 16 ? 1 : 0, rr: 1.2, minRR: 1.2 }); // 80%
    trades.push({ timeframe: '1h', band: 'b2', win: i < 4 ? 1 : 0, rr: 2.5, minRR: 2.5 });  // 20%
  }
  const seg = summarizeSegments(trades, { minTrades: 12, targetWinRate: 0.6 }).find(r => r.key === '1h|all|b2');
  assert.equal(seg.minRR, 1.2, 'الأبعد غير مؤهَّل → الأقرب المؤهَّل');
  assert.ok(seg.smoothedWinRate >= 0.6);
});

test('summarizeSegments: بلا أي هدف مؤهَّل → يُختار الأقوى نسبةً ويُوسَم غير مؤهَّل', () => {
  const trades = [];
  for (let i = 0; i < 20; i += 1) {
    trades.push({ timeframe: '4h', band: 'b1', win: i < 6 ? 1 : 0, rr: 1.2, minRR: 1.2 }); // 30%
    trades.push({ timeframe: '4h', band: 'b1', win: i < 2 ? 1 : 0, rr: 2, minRR: 2 });    // 10%
  }
  const seg = summarizeSegments(trades, { minTrades: 12, targetWinRate: 0.6 }).find(r => r.key === '4h|all|b1');
  assert.equal(seg.qualified, false);
  assert.equal(seg.minRR, 1.2, 'اختار الأقوى نسبةً');
  assert.ok(seg.smoothedWinRate < 0.6);
});

test('summarizeSegments: يتجاهل الصفقات غير المحسومة', () => {
  const rows = summarizeSegments([{ timeframe: '5m', band: 'b1', win: null }]);
  assert.equal(rows.length, 0);
});
