import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveOpportunityEngine } from '../live-opportunities/loop.mjs';

/** اختبار §7.5: فشل حفظ النتيجة لا يُخفى ولا يُسوّى بصمت — تُعاد المحاولة في الدورة التالية */
function makeEngine({ failFirst = 1 } = {}) {
  const persistCalls = [];
  let failuresLeft = failFirst;
  let price = 100;
  let clock = 1_000_000;
  const engine = createLiveOpportunityEngine({
    now: () => clock,
    broadcast: () => {},
    persist: async (row) => {
      persistCalls.push(row);
      if (row.closed && failuresLeft > 0) { failuresLeft -= 1; throw new Error('db down'); }
      return { ok: true };
    },
    zoneSource: () => [],
    resolveTargets: async () => ['BTCUSDT'],
    fetchPrices: async () => ({ BTCUSDT: price }),
    fetchBookSignals: async () => ({}),
    fetchRawKlines: async () => [],
    readCalibration: async () => null,
    log: { warn() {}, error() {}, log() {}, info() {} },
    config: { publishLimit: 10, trackOverflowLimit: 20 }
  });
  return { engine, persistCalls, setPrice: (p) => { price = p; }, status: () => engine.getStatus(), advance: (ms) => { clock += ms; } };
}

const mkOp = (id, detectedAt) => ({
  id, symbol: 'BTCUSDT', timeframe: '5m', zoneId: `z-${id}`, kind: 'ssl',
  level: 98, referenceLevel: 100, stop: 96, tp: 105, entry: 99,
  composite: 0.9, rr: 2, confidence: 0.8, direction: 'up',
  detectedAt, outcome: null
});

test('§7.5: فشل حفظ النتيجة يُسجل ويُعاد المحاولة حتى النجاح', async () => {
  const { engine, persistCalls, setPrice, status } = makeEngine({ failFirst: 1 });
  engine.rehydrate(
    [{ type: 'live_opportunity', symbol: 'BTCUSDT', ts: 900_000, meta: JSON.stringify({ opportunity: mkOp('o1', 800_000) }) }],
    { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 1 } }
  );
  setPrice(106); // حسم بالهدف
  await engine.runCycle();
  // المحاولة الأولى فشلت: العداد يُظهرها ولا تُعلن نجاحاً
  const st1 = status();
  assert.ok(st1.persist.failures >= 1, 'الفشل معدود في status.persist');
  assert.equal(st1.persist.lastError, 'db down');
  // الدورة التالية: إعادة المحاولة تنجح
  await engine.runCycle();
  const closedOk = persistCalls.filter(r => r.closed === true);
  assert.ok(closedOk.length >= 2, `محاولتان على الأقل (حصلنا على ${closedOk.length})`);
  const st2 = status();
  // lastError يبقى كسجل تدقيق — دليل التعافي هو نجاح لاحق بوقت أحدث من الفشل
  assert.ok(st2.persist.writes >= 1, 'نجاح الحفظ معدود');
  assert.ok(st2.persist.lastOk, 'يوجد آخر نجاح حفظ');
  assert.ok(st2.persist.lastOk.at >= st2.persist.lastErrorAt, 'النجاح لاحق للفشل (تعافي مثبت)');
});

test('§7.5: نجاح الحفظ لا يُكرر — النتيجة تُحفظ مرة واحدة', async () => {
  const { engine, persistCalls, setPrice } = makeEngine({ failFirst: 0 });
  engine.rehydrate(
    [{ type: 'live_opportunity', symbol: 'BTCUSDT', ts: 900_000, meta: JSON.stringify({ opportunity: mkOp('o1', 800_000) }) }],
    { lifecycle: { ok: true, count: 0 }, opportunities: { ok: true, count: 1 } }
  );
  setPrice(106);
  await engine.runCycle();
  await engine.runCycle();
  await engine.runCycle();
  const closedSaves = persistCalls.filter(r => r.closed === true);
  assert.equal(closedSaves.length, 1, `حفظ نتيجة واحد بالضبط (حصلنا على ${closedSaves.length})`);
});
