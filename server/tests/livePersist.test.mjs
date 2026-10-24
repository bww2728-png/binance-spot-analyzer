import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveOpportunityEngine } from '../live-opportunities/loop.mjs';

function makeEngine({ persistResult = 'ok', persistError = null } = {}) {
  const notes = [];
  const persistCalls = [];
  let price = 101;
  const zone = {
    symbol: 'BTCUSDT', timeframe: '5m', id: 'z1', kind: 'ssl',
    liquidityLevel: 98, referenceLevel: 100, atr: 1,
    level: 98, stop: 96, tp: 105, entry: 99, composite: 0.9, rr: 2, confidence: 0.8
  };
  const engine = createLiveOpportunityEngine({
    now: () => 1_000_000,
    broadcast: () => {},
    persist: async (row) => {
      persistCalls.push(row);
      if (persistResult === 'fail') throw persistError || new Error('persist failed');
      return { ok: true };
    },
    notePersist: (r) => notes.push(r),
    zoneSource: () => [zone],
    resolveTargets: async () => ['BTCUSDT'],
    fetchPrices: async () => ({ BTCUSDT: price }),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    readCalibration: async () => null,
    config: { cycleMs: 10_000 }
  });
  return { engine, notes, persistCalls, setPrice: (p) => { price = p; }, status: () => engine.getStatus() };
}

test('persist: نجاح تسجيل حدث دورة حياة (سويب) يُبلّغ notePersist', async () => {
  const { engine, notes, setPrice, status } = makeEngine({ persistResult: 'ok' });
  engine.rehydrate([], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 0 } });
  setPrice(97.5); // يُحدث سويب SSL
  await engine.runCycle();
  const successes = notes.filter(n => n.ok);
  assert.ok(successes.length >= 1, 'يجب تسجيل نجاح حفظ واحد على الأقل');
  assert.ok(successes.some(n => n.key === 'live_lifecycle'));
  assert.equal(status().persist.failures, 0);
});

test('persist: فشل الحفظ لا يُخفى — notePersist يتلقى الخطأ وعداد الفشل يزيد', async () => {
  const { engine, notes, setPrice, status } = makeEngine({ persistResult: 'fail', persistError: new Error('db down') });
  engine.rehydrate([], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 0 } });
  setPrice(97.5);
  await engine.runCycle();
  const failures = notes.filter(n => !n.ok);
  assert.ok(failures.length >= 1, 'يجب تسجيل فشل حفظ واحد على الأقل');
  assert.ok(failures.some(n => n.error === 'db down'));
  assert.ok(status().persist.failures >= 1);
});

test('persist: قيمة false لا تُسجل نجاحاً مؤكداً للحفظ', async () => {
  const notes = [];
  let price = 101;
  const engine = createLiveOpportunityEngine({
    persist: async () => false,
    notePersist: value => notes.push(value),
    zoneSource: () => [{ symbol: 'BTCUSDT', timeframe: '5m', id: 'z1', kind: 'ssl', liquidityLevel: 98, referenceLevel: 100, atr: 1 }],
    resolveTargets: async () => ['BTCUSDT'],
    fetchPrices: async () => ({ BTCUSDT: price }),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    readCalibration: async () => null,
    log: { warn() {}, error() {}, log() {} }
  });
  engine.rehydrate([], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 0 } });
  price = 97.5;
  await engine.runCycle();
  assert.equal(engine.getStatus().persist.writes, 0);
  assert.ok(engine.getStatus().persist.failures >= 1);
  assert.ok(notes.some(note => !note.ok));
});

test('persist: النتيجة تُحفظ فور حسمها لا بعد مؤقت العرض', async () => {
  const { engine, persistCalls, setPrice } = makeEngine({ persistResult: 'ok' });
  const op = {
    symbol: 'BTCUSDT', timeframe: '5m', zoneId: 'z1', kind: 'ssl',
    level: 98, referenceLevel: 100, stop: 96, tp: 105, entry: 99,
    composite: 0.9, rr: 2, confidence: 0.8, direction: 'up', id: 'btc-5m-z1',
    detectedAt: 900_000, outcome: null
  };
  engine.rehydrate([
    { type: 'live_opportunity', symbol: 'BTCUSDT', ts: 900_000, meta: JSON.stringify({ opportunity: op }) }
  ], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 1 } });
  // فرصة منشورة بلا نتيجة، السعر يصيب الهدف فوراً
  setPrice(106);
  await engine.runCycle();
  const outcomeSaves = persistCalls.filter(r => r.closed === true);
  assert.ok(outcomeSaves.length >= 1, 'يجب حفظ النتيجة فور حسمها');
});

test('calibration: إشعار الاكتمال لا يؤكد الحفظ دون نتيجة تخزين صريحة ويُرسل مرة', async () => {
  const broadcasts = [];
  const engine = createLiveOpportunityEngine({
    now: () => 2_000_000,
    persist: async () => false,
    broadcast: message => broadcasts.push(message),
    resolveTargets: async () => [],
    fetchPrices: async () => ({}),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    zoneSource: () => [],
    readCalibration: async () => null,
    log: { log() {}, warn() {}, error() {} }
  });
  const result = await engine.runCalibration();
  const done = broadcasts.filter(message => message.type === 'live_calibration_done');
  assert.equal(result.persisted, false);
  assert.equal(done.length, 1);
  assert.equal(done[0].at, 2_000_000);
  assert.equal(done[0].persisted, false);
  engine.stop();
});

test('rehydrate: البيانات الوصفية تُحفظ في الحالة وتظهر حالة الاستعلامات', () => {
  const { engine, status } = makeEngine();
  const meta = {
    lifecycle: { ok: true, count: 12 },
    opportunities: { ok: false, count: 0, error: 'timeout' }
  };
  engine.rehydrate([], meta);
  assert.deepEqual(status().rehydrateMeta, meta);
  assert.equal(status().rehydrated.inputRows, 0);
});

test('rehydrate: الأحداث المكررة لا تُنشئ فرصًا مكررة', () => {
  const { engine, status } = makeEngine();
  const op = {
    symbol: 'BTCUSDT', timeframe: '5m', zoneId: 'z1', kind: 'ssl',
    level: 98, referenceLevel: 100, stop: 96, tp: 105, entry: 99,
    composite: 0.8, rr: 2, confidence: 0.9, direction: 'up', id: 'btc-5m-z1'
  };
  const rows = [
    { type: 'live_opportunity', symbol: 'BTCUSDT', ts: 1000, meta: JSON.stringify({ opportunity: op }) },
    { type: 'live_opportunity', symbol: 'BTCUSDT', ts: 1001, meta: JSON.stringify({ opportunity: op }) }
  ];
  engine.rehydrate(rows, { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 2 } });
  assert.ok(status().rehydrated.opportunities <= 1, `توقع فرصة واحدة لكن استُعيد ${status().rehydrated.opportunities}`);
});

test('recoveryRequired: يمنع المسح والمعايرة حتى الاستعادة الكاملة، ويقبل السجل الفارغ الحقيقي', async () => {
  let targetReads = 0;
  const engine = createLiveOpportunityEngine({
    persist: async () => ({ ok: true }),
    resolveTargets: async () => { targetReads += 1; return []; },
    fetchPrices: async () => ({}),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    zoneSource: () => [],
    readCalibration: async () => null,
    config: { recoveryRequired: true, cycleMs: 60_000, tickMs: 60_000, calibrationMs: 60_000 },
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  assert.equal(engine.getStatus().recovery.state, 'pending');
  assert.deepEqual(await engine.runCycle(), { skipped: true, recovery: 'pending' });
  assert.deepEqual(await engine.runCalibration(), { skipped: true, recovery: 'pending' });
  assert.deepEqual(engine.start(), { skipped: true, recovery: 'pending' });
  assert.equal(targetReads, 0);
  const failed = engine.rehydrate([], { lifecycle: { ok: false, error: 'read failed' }, opportunities: { ok: true, count: 0 } });
  assert.equal(failed.skipped, true);
  assert.equal(engine.getStatus().recovery.state, 'failed');
  assert.deepEqual(await engine.runCycle(), { skipped: true, recovery: 'failed' });
  const recovered = engine.rehydrate([], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 0 } });
  assert.equal(recovered.inputRows, 0);
  assert.equal(engine.getStatus().recovery.state, 'ready');
  engine.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    await engine.runCycle();
  } finally {
    engine.stop();
  }
  assert.equal(targetReads, 2);
});

test('recoveryRequired: صفوف الفرص التالفة تمنع الاستعادة الجزئية', () => {
  const engine = createLiveOpportunityEngine({
    persist: async () => ({ ok: true }),
    resolveTargets: async () => [],
    fetchPrices: async () => ({}),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    zoneSource: () => [],
    config: { recoveryRequired: true },
    log: { log: () => {}, warn: () => {}, error: () => {} }
  });
  const result = engine.rehydrate([
    { type: 'live_opportunity', symbol: 'BTCUSDT', ts: 1, meta: '{malformed' }
  ], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 1 } });
  assert.equal(result.skipped, true);
  assert.equal(result.invalidRows, 1);
  assert.equal(engine.getStatus().recovery.state, 'failed');
  assert.deepEqual(engine.start(), { skipped: true, recovery: 'failed' });
  engine.stop();
});

test('persist: تستمر إعادة محاولة النتيجة بعد انتقال الفرصة إلى التاريخ', async () => {
  let currentTime = 1_000_000;
  let persistCalls = 0;
  const engine = createLiveOpportunityEngine({
    now: () => currentTime,
    persist: async row => {
      if (!row.closed) return { ok: true };
      persistCalls += 1;
      return persistCalls < 3 ? { ok: false, error: 'temporary database failure' } : { ok: true };
    },
    resolveTargets: async () => ['BTCUSDT'],
    fetchPrices: async () => ({ BTCUSDT: 106 }),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    zoneSource: () => [],
    log: { log() {}, warn() {}, error() {} }
  });
  const opportunity = {
    id: 'btc-5m-z1', symbol: 'BTCUSDT', timeframe: '5m', zoneId: 'z1',
    entry: 99, stop: 96, tp: 105, composite: 0.9, rr: 2,
    detectedAt: 900_000, outcome: null
  };
  engine.rehydrate([
    { type: 'live_opportunity', symbol: 'BTCUSDT', ts: 900_000, meta: JSON.stringify({ opportunity }) }
  ], { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 1 } });

  await engine.runCycle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(persistCalls, 1);

  currentTime += 180_001;
  await engine.runCycle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.getFeed().total, 0);
  assert.equal(engine.getHistory().total, 1);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await engine.runCycle();
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(persistCalls, 3);
  assert.equal(engine.getHistory().opportunities[0].outcomeSaved, true);
  engine.stop();
});
