import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLiquidityZones, adaptiveConfig } from '../liquidity-zones/engine.mjs';
import { detectLiquidityZonesV2 } from '../liquidity-zones/v2/index.mjs';
import { createHistorySerializer } from '../services/liquidityHistorySerialize.mjs';

/**
 * عقد بيانات الشارت التاريخي — يُختبر على **مخرجات المحركين الحقيقية** لا على بيانات يدوية:
 *  1. `availableAt` زمن حقيقي من الشموع (لا ساعة جهاز)، ولا يسبق `createdAt`.
 *  2. اشتقاقه مطابق لقاعدة تأكيد البيفوت المعلنة في المحرك: `time(index + rightBars)`.
 *  3. `confirmedAt` يُمرَّر كما هو (لا يُستبدل بـcreatedAt) — هذا هو جوهر منع التسرب.
 *  4. `sweptAt` و`invalidatedAt` لا يُدمجان.
 *  5. التسلسل حتمي: نفس المدخلات ⇒ نفس المخرجات حرفياً، ولا يُعدّل مخرجات المحرك.
 *  6. v2: أحداث البنية وFVG تُمرَّر مرة واحدة مع أزمنة معرفة حقيقية.
 */

const BASE_TIME = 1_700_000_000;
const MINUTE = 60;

/** شموع 1m اصطناعية تُنتج مناطق فعلية في المحركين (قمم/قيعان متكررة + ميل) */
const makeCandles = (count = 400) => Array.from({ length: count }, (_, i) => {
  const trend = i * 0.05;
  const wave = 100 + trend + Math.sin(i / 7) * 3 + Math.sin(i / 23) * 1.5;
  return {
    time: BASE_TIME + i * MINUTE,
    open: wave,
    high: wave + 1 + (i % 13 === 0 ? 0.6 : 0),
    low: wave - 1 - (i % 17 === 0 ? 0.6 : 0),
    close: wave + (i % 3 === 0 ? 0.5 : -0.5),
    volume: 10
  };
});

const timesOf = (candles) => new Set(candles.map((c) => c.time));

test('legacy: availableAt = زمن تأكيد آخر بيفوت (index + rightBars) وزمن شمعة حقيقي', () => {
  const candles = makeCandles();
  const endIndex = candles.length - 1;
  const zones = detectLiquidityZones({ symbol: 'TESTUSDT', timeframe: '1m', candles, endIndex });
  assert.ok(zones.length > 0, 'البيانات الاصطناعية يجب أن تُنتج مناطق');

  const rightBars = adaptiveConfig(candles, endIndex).rightBars;
  assert.ok(rightBars >= 1 && rightBars <= 12);
  const serializer = createHistorySerializer(candles);
  serializer.setRightBars(rightBars);
  const validTimes = timesOf(candles);

  for (const zone of zones) {
    const out = serializer.serializeZone(zone);
    assert.equal(typeof out.availableAt, 'number', `${zone.id}: availableAt مطلوب`);
    assert.ok(validTimes.has(out.availableAt), `${zone.id}: availableAt يجب أن يكون زمن شمعة حقيقية`);
    assert.ok(out.availableAt >= zone.createdAt, `${zone.id}: لا معرفة قبل النشأة`);

    const lastPivotIndex = Math.max(...zone.touchPoints.map((p) => p.index));
    const expected = candles[Math.min(lastPivotIndex + rightBars, endIndex)].time;
    assert.equal(out.availableAt, expected, `${zone.id}: اشتقاق availableAt من قاعدة المحرك نفسها`);
    assert.equal(out.availableAtBasis, 'pivot_confirm');
    // جوهر منع التسرب: زمن المعرفة يلي زمن آخر بيفوت بمقدار rightBars (بحدود النافذة)
    assert.ok(
      out.availableAt > zone.createdAt || lastPivotIndex + rightBars > endIndex,
      `${zone.id}: createdAt (زمن البيفوت) يسبق المعرفة ولا يصلح بديلاً عنها`
    );
  }
});

test('legacy: confirmedAt يُمرَّر كما هو ولا يُستبدل بـcreatedAt، والسويب منفصل عن الإبطال', () => {
  const candles = makeCandles();
  const zones = detectLiquidityZones({ symbol: 'TESTUSDT', timeframe: '1m', candles, endIndex: candles.length - 1 });
  const serializer = createHistorySerializer(candles);

  // (1) كل مناطق المحرك: التأكيد كما هو حرفياً (وقد يكون null — ولا يُستبدل بزمن النشأة)
  for (const zone of zones) {
    const out = serializer.serializeZone(zone);
    assert.equal(out.confirmedAt, zone.confirmedAt ?? null, `${zone.id}: confirmedAt كما هو من المحرك`);
    assert.equal(out.sweptAt, zone.sweptAt ?? null);
    assert.equal(out.invalidatedAt, null, `${zone.id}: المحرك القديم لا يعطي إبطالاً زمنياً (invalidation نص وصفي)`);
    assert.equal(out.detectedAt, null, 'ساعة الجهاز لا تُمرَّر');
  }

  // (2) منطقة بتأكيد وسويب: تمرير مباشر بلا اشتقاق ولا دمج بين الزمنين
  const handMade = {
    id: 'hand', kind: 'horizontal_bsl', state: 'swept', referenceLevel: 100, liquidityLevel: 101,
    createdAt: candles[10].time, confirmedAt: candles[30].time, sweptAt: candles[45].time,
    touchPoints: [{ index: 10, time: candles[10].time, price: 100 }], trendline: null,
    timeframe: '1m', invalidation: 'فوق Liquidity Level'
  };
  const out = serializer.serializeZone(handMade);
  assert.equal(out.confirmedAt, candles[30].time, 'زمن التأكيد الحقيقي لا زمن النشأة');
  assert.notEqual(out.confirmedAt, out.createdAt);
  assert.equal(out.sweptAt, candles[45].time);
  assert.equal(out.invalidatedAt, null, 'السويب لا يُسمّى إبطالاً');
});

test('التسلسل حتمي ولا يُعدّل مخرجات المحرك', () => {
  const candles = makeCandles();
  const zones = detectLiquidityZones({ symbol: 'TESTUSDT', timeframe: '1m', candles, endIndex: candles.length - 1 });
  const snapshot = JSON.stringify(zones);
  const serializer = createHistorySerializer(candles);
  serializer.setRightBars(5);
  const first = zones.map(serializer.serializeZone);
  const second = zones.map(serializer.serializeZone);
  assert.deepEqual(first, second, 'نفس المدخلات ⇒ نفس المخرجات حرفياً');
  assert.equal(JSON.stringify(zones), snapshot, 'لا تعديل على مخرجات المحرك');
});

test('v2: أحداث البنية تُمرَّر بأزمنة معرفة حقيقية، ولا تتكرر', () => {
  const candles = makeCandles();
  const endIndex = candles.length - 1;
  const zones = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1m', candles, endIndex });
  const serializer = createHistorySerializer(candles);
  serializer.setRightBars(adaptiveConfig(candles, endIndex).rightBars);
  const validTimes = timesOf(candles);

  const events = new Map();
  for (const zone of zones) {
    for (const raw of zone.structureEvents ?? []) {
      const ev = serializer.serializeEvent(raw);
      if (ev) events.set(ev.key, ev);
    }
  }
  assert.ok(events.size > 0, 'v2 يجب أن ينتج أحداث بنية على هذه البيانات');

  for (const ev of events.values()) {
    assert.ok(validTimes.has(ev.time), `${ev.key}: زمن الحدث زمن شمعة حقيقية`);
    assert.ok(ev.availableAt != null, `${ev.key}: availableAt مطلوب`);
    assert.ok(validTimes.has(ev.availableAt), `${ev.key}: availableAt زمن شمعة حقيقية`);
    assert.ok(ev.availableAt >= ev.time, `${ev.key}: لا معرفة قبل وقوع الحدث`);
    if (ev.brokenPivotTime != null) {
      assert.ok(ev.availableAt >= ev.brokenPivotTime, `${ev.key}: لا معرفة قبل تأكيد البيفوت المكسور`);
    }
  }
  assert.equal(events.size, new Set([...events.values()].map((e) => e.key)).size, 'مفتاح لكل حدث بلا تكرار');
});

test('v2: FVG يُعرف عند الشمعة التالية للفجوة، وعرض/طلب عند تكون فجوته', () => {
  const candles = makeCandles(120);
  const serializer = createHistorySerializer(candles);

  const fvg = serializer.serializeFvg({ index: 10, time: candles[10].time, kind: 'bullish', top: 105, bottom: 104, invalidatedAt: null });
  assert.equal(fvg.availableAt, candles[11].time, 'النمط الثلاثي لا يكتمل قبل الشمعة التالية');
  assert.ok(fvg.availableAt > fvg.time);

  const zone = {
    id: 'x', kind: 'supply', state: 'confirmed', direction: 'down',
    referenceLevel: 105, referenceAlt: null, liquidityLevel: 106, retailStop: 107,
    zoneBox: { high: 106, low: 104 }, bodyBox: null,
    createdAt: candles[9].time, confirmedAt: candles[20].time, sweptAt: null, invalidatedAt: null,
    confidence: 0.5, touches: 1, timeframe: '1m',
    touchPoints: [{ index: 9, time: candles[9].time, price: 105 }],
    trendline: null, atr: 0.5, distanceAtr: 0, prominenceAtr: 3, reasons: [], premium: null,
    form: 'A',
    fvgs: [{ index: 10, time: candles[10].time, kind: 'bearish', top: 106, bottom: 104, invalidatedAt: null }],
    structureEvents: []
  };
  const out = serializer.serializeZone(zone);
  assert.equal(out.availableAtBasis, 'fvg_formed');
  assert.equal(out.availableAt, candles[11].time, 'المنطقة تُعرف عند تكون فجوتها لا قبلها');
  assert.equal(out.touchPoints[0].availableAt, out.availableAt, 'لمسة منطقة العرض/طلب تُعرف مع تكونها');
  assert.equal(out.fvgs[0].availableAt, candles[11].time);
});

test('منطقة بلا أزمنة: availableAt = null بدل اختلاق قيمة', () => {
  const candles = makeCandles(60);
  const serializer = createHistorySerializer(candles);
  const out = serializer.serializeZone({
    id: 'no-time', kind: 'horizontal_bsl', state: 'candidate', referenceLevel: 100,
    liquidityLevel: 101, createdAt: null, confirmedAt: null, sweptAt: null,
    touchPoints: [], fvgs: [], trendline: null, timeframe: '1m'
  });
  assert.equal(out.availableAt, null);
  assert.equal(out.availableAtBasis, 'created');
  assert.equal(out.confirmedAt, null);
});

test('v2: availableAt لحدث بنيوي لا يسبق تأكيد أي بيفوت يعتمد عليه (منع تسرب حقيقي)', () => {
  const candles = makeCandles();
  const endIndex = candles.length - 1;
  const zones = detectLiquidityZonesV2({ symbol: 'TESTUSDT', timeframe: '1m', candles, endIndex });
  const rightBars = adaptiveConfig(candles, endIndex).rightBars;
  const serializer = createHistorySerializer(candles);
  serializer.setRightBars(rightBars);
  const lastIndex = candles.length - 1;
  const timeAt = (i) => candles[Math.min(Math.max(i, 0), lastIndex)].time;

  const events = new Map();
  for (const zone of zones) {
    for (const raw of zone.structureEvents ?? []) {
      const ev = serializer.serializeEvent(raw);
      if (ev) events.set(ev.key, ev);
    }
  }
  assert.ok(events.size > 0);

  let leakFree = 0;
  for (const ev of events.values()) {
    if (ev.type === 'idm') continue;
    const pivots = [ev.brokenPivotIndex, ev.evidence?.high1, ev.evidence?.low1].filter((i) => typeof i === 'number');
    const latestConfirm = Math.max(...pivots.map((i) => timeAt(i + rightBars)));
    assert.ok(
      ev.availableAt >= latestConfirm,
      `${ev.key}: availableAt (${ev.availableAt}) يسبق تأكيد بيفوته الأخير (${latestConfirm})`
    );
    // الأحداث تُعرض فقط عند/بعد لحظة إمكان معرفتها
    assert.ok(ev.availableAt >= ev.time);
    leakFree += 1;
  }
  assert.ok(leakFree > 0, 'وُجدت أحداث غير IDM لاختبارها');
});

test('v2: invalidation.at المساوي لـsweptAt لا يُعرض إبطالاً مستقلاً', () => {
  const candles = makeCandles(60);
  const serializer = createHistorySerializer(candles);
  const base = {
    id: 'z1', kind: 'supply', state: 'swept', referenceLevel: 105, referenceAlt: null,
    liquidityLevel: 106, retailStop: 107, zoneBox: { high: 106, low: 104 }, bodyBox: null,
    createdAt: candles[5].time, confirmedAt: candles[20].time,
    confidence: 0.5, touches: 1, timeframe: '1m',
    touchPoints: [{ index: 5, time: candles[5].time, price: 105 }],
    trendline: null, atr: 0.5, distanceAtr: 0, prominenceAtr: 3, reasons: [], premium: null,
    form: 'A', fvgs: [], structureEvents: []
  };
  // (1) المحرك v2: invalidation.at === sweptAt ⇒ لا إبطال مستقل (يُعلن فجوة)
  const same = serializer.serializeZone({
    ...base,
    sweptAt: candles[40].time,
    invalidation: { reason: 'سُحبت السيولة', at: candles[40].time }
  });
  assert.equal(same.sweptAt, candles[40].time);
  assert.equal(same.invalidatedAt, null, 'نفس الزمن لا يُسمّى إبطالاً منفصلاً');

  // (2) منطقة بإبطال زمني مستقل فعلاً ⇒ يُمرَّر كما هو
  const distinct = serializer.serializeZone({
    ...base,
    state: 'invalidated',
    sweptAt: null,
    invalidation: { reason: 'انتهاء الصلاحية', at: candles[30].time }
  });
  assert.equal(distinct.invalidatedAt, candles[30].time);
  assert.equal(distinct.sweptAt, null, 'الإبطال لا يُسمّى سويباً');
});

test('v2: fvg.invalidatedAt يُمرَّر كما وصل ولا يُخترع عند غيابه', () => {
  const candles = makeCandles(60);
  const serializer = createHistorySerializer(candles);
  const withTime = serializer.serializeFvg({
    index: 10, time: candles[10].time, kind: 'bullish', top: 105, bottom: 104, invalidatedAt: candles[25].time
  });
  assert.equal(withTime.invalidatedAt, candles[25].time, 'الزمن الواصل يُمرَّر');
  const without = serializer.serializeFvg({
    index: 10, time: candles[10].time, kind: 'bullish', top: 105, bottom: 104
  });
  assert.equal(without.invalidatedAt, null, 'لا يُخترع زمن إبطال');
});

test('rightBars يُضبط من adaptiveConfig ويؤثر في availableAt (لا قيمة مخفية)', () => {
  const candles = makeCandles(200);
  const serializer = createHistorySerializer(candles);
  const touch = { index: 100, time: candles[100].time, price: 100 };
  serializer.setRightBars(3);
  assert.equal(serializer.serializeTouch(touch).availableAt, candles[103].time);
  serializer.setRightBars(12);
  assert.equal(serializer.serializeTouch(touch).availableAt, candles[112].time);
  // لا يتجاوز آخر شمعة متاحة
  serializer.setRightBars(12);
  assert.equal(serializer.serializeTouch({ index: 195, time: candles[195].time, price: 100 }).availableAt, candles[199].time);
});
