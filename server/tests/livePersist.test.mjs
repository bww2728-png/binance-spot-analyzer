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
