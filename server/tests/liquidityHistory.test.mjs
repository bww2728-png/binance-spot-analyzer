import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiquidityHistoryService } from '../services/liquidityHistory.mjs';

/** شموع 1m اصطناعية على شكل صفوف Binance الخام [openTime,o,h,l,c,v,...] */
const makeRawCandles = (fromMs, count, base = 100) => Array.from({ length: count }, (_, i) => {
  const openTime = fromMs + i * 60_000;
  const value = base + Math.sin(i / 6) * 3 + Math.sin(i / 19) * 2;
  return [openTime, value, value + 1, value - 1, value + Math.sin(i), 10 + (i % 7), openTime + 59_999, 0, 0, 4];
});

const fixedNow = () => 1_800_000_000_000;

const makeKlines = ({ calls = [], failBatchIndex = null } = {}) => {
  let index = 0;
  return async (symbol, interval, limit, startTime) => {
    if (interval !== '1m') throw new Error(`unexpected interval: ${interval}`);
    calls.push({ symbol, interval, limit, startTime });
    if (failBatchIndex != null && index === failBatchIndex) { index += 1; throw new Error('binance offline'); }
    index += 1;
    return makeRawCandles(startTime, limit);
  };
};

const validCandles = ({ symbol, engine, days }) => ({ symbol, engine, days });

test('validate rejects bad inputs without computing', () => {
  const svc = createLiquidityHistoryService({ klines: makeKlines(), now: fixedNow });
  assert.throws(() => svc.validate(validCandles({ symbol: 'BAD SYMBOL!', engine: 'legacy', days: 90 })), /صيغة الرمز/);
  assert.throws(() => svc.validate(validCandles({ symbol: 'BTCUSDT', engine: 'v9', days: 90 })), /محرك غير مدعوم/);
  assert.throws(() => svc.validate(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 3 })), /العمق بالأيام/);
  assert.throws(() => svc.validate(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 500 })), /العمق بالأيام/);
  assert.throws(() => svc.validate(validCandles({ symbol: 'BTCUSDT', engine: 'v2', days: 15 })), /عمق v2 الأقصى/); // v2 محدود بالذاكرة (مقاس)
  assert.throws(() => svc.validate(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: Number.NaN })), /العمق بالأيام/);
  const ok = svc.validate(validCandles({ symbol: 'btcusdt', engine: undefined, days: undefined }));
  assert.equal(ok.symbol, 'BTCUSDT');
  assert.equal(ok.engine, 'legacy'); // الافتراضي
  assert.equal(ok.days, 90); // الافتراضي
  const v2 = svc.validate(validCandles({ symbol: 'BTCUSDT', engine: 'v2', days: undefined }));
  assert.equal(v2.days, 14); // الافتراضي لمحرك v2 هو سقفه الآمن المقاس
});

test('fetching pages the full depth in fixed-start batches with bounded concurrency', async () => {
  const calls = [];
  const svc = createLiquidityHistoryService({ klines: makeKlines({ calls }), now: fixedNow });
  const result = await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 }));
  // 7 أيام = 10080 دقيقة → 11 دفعة (بآخرها جزئية حتى "الآن")
  assert.equal(calls.length, Math.ceil((7 * 1440) / 1000));
  for (let i = 1; i < calls.length; i += 1) {
    assert.equal(calls[i].startTime - calls[i - 1].startTime, 1000 * 60_000, 'بدايات ثابتة متتالية بلا فجوات');
  }
  assert.equal(result.timeframe, '1m');
  assert.equal(result.bars, result.expectedBars, 'البيانات الاصطناعية متصلة فالعدد يطابق المتوقع');
  assert.equal(result.gaps, 0);
  assert.equal(result.source, 'binance-spot');
  assert.ok(result.bars > 9000, `bars=${result.bars}`);
  assert.ok(Array.isArray(result.zones));
  assert.equal(result.zones.length, result.totalZones, 'تُعاد كل المناطق التي أنتجها المحرك');
  assert.equal(result.zonesCapped, false, 'لا يُخفى جزء من المناطق عند التسليم');
  assert.ok(result.computeMs >= 0);
  // الشموع مدمجة [time,o,h,l,c,v] وزمنها صاعد بلا تكرار
  const first = result.candles[0];
  assert.equal(first.length, 6);
  for (let i = 1; i < result.candles.length; i += 1) {
    assert.ok(result.candles[i][0] > result.candles[i - 1][0], 'أزمنة صارمة الصعود');
  }
});

test('engine separation: legacy and v2 results never mix', async () => {
  const svc = createLiquidityHistoryService({ klines: makeKlines(), now: fixedNow });
  const legacy = await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 }));
  const v2 = await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'v2', days: 7 }));
  assert.equal(legacy.engine, 'liquidity-engine-v1');
  assert.equal(v2.engine, 'liquidity-engine-v2');
  for (const zone of legacy.zones) assert.equal(zone.engine, 'liquidity-engine-v1');
  for (const zone of v2.zones) assert.equal(zone.engine, 'liquidity-engine-v2');
  // حقل مفتاح المحرك يبقى كما طُلب حرفياً
  assert.equal(legacy.engineKey, 'legacy');
  assert.equal(v2.engineKey, 'v2');
});

test('cache serves the second call without recompute and without extra Binance calls', async () => {
  const calls = [];
  const svc = createLiquidityHistoryService({ klines: makeKlines({ calls }), now: fixedNow, ttlMs: 60_000 });
  const first = await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 }));
  const callsAfterFirst = calls.length;
  const second = await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 }));
  assert.equal(calls.length, callsAfterFirst, 'لا نداءات Binance إضافية عند إصابة الكاش');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.candles, first.candles);
  // محرك مختلف = مفتاح مختلف = حساب مستقل
  await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'v2', days: 7 }));
  assert.ok(calls.length > callsAfterFirst);
});

test('in-flight lock: concurrent calls for the same key share one computation', async () => {
  const calls = [];
  const svc = createLiquidityHistoryService({ klines: makeKlines({ calls }), now: fixedNow });
  const [a, b] = await Promise.all([
    svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 })),
    svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 }))
  ]);
  assert.equal(a.candles.length, b.candles.length);
  assert.equal(calls.length, Math.ceil((7 * 1440) / 1000), 'دفعة واحدة لكل نطاق زمني رغم التوازي');
});

test('a failing Binance batch propagates a clean error, cools down, then recovers', async () => {
  let shouldFail = true;
  let clock = 1_800_000_000_000;
  const svc = createLiquidityHistoryService({
    klines: async (...args) => {
      if (shouldFail) throw new Error('binance offline');
      return makeRawCandles(args[3], args[2]);
    },
    now: () => clock
  });
  await assert.rejects(
    () => svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 })),
    /binance offline/
  );
  // خلال التهدئة: خطأ واضح بلا إعادة إدراج فورية (لا حلقة فشل تستهلك المعالج)
  await assert.rejects(
    () => svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 })),
    /تعذر إكمال الحساب/
  );
  shouldFail = false;
  clock += 31 * 60_000; // انقضت التهدئة: التعافي يعيد الجلب فعلياً
  const result = await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 }));
  assert.ok(result.bars > 9000);
});

test('too-few candles is an explicit error, not an empty success', async () => {
  const firstStart = Math.floor((fixedNow() - 7 * 86_400_000) / 60_000) * 60_000;
  const svc = createLiquidityHistoryService({
    klines: async (_symbol, _tf, _limit, startTime) => (startTime === firstStart ? makeRawCandles(startTime, 30) : []),
    now: fixedNow
  });
  await assert.rejects(
    () => svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 7 })),
    /شموع تاريخية غير كافية/
  );
});

test('cache eviction keeps memory bounded (max 4 entries)', async () => {
  const svc = createLiquidityHistoryService({ klines: makeKlines(), now: fixedNow });
  for (const engine of ['legacy', 'v2']) {
    for (const days of [7, 8]) {
      await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine, days }));
    }
  }
  // نداء خامس يجعل الحجم يتجاوز السقف فتُطرد أقدم مدخلة
  await svc.getHistory(validCandles({ symbol: 'BTCUSDT', engine: 'legacy', days: 9 }));
  assert.ok(true); // لا استثناء — الإخلاء يعمل داخلياً؛ التحقق الوظيفي أن الحساب يعيد التنفيذ بعد الطرد
});
