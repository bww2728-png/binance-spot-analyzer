import test from 'node:test';
import assert from 'node:assert/strict';

const { toLifecycleRow, rehydrateState, LIFECYCLE_TYPE } = await import('../live-opportunities/lifecycle.mjs');

const T0 = 1_700_000_000_000;
const tfSecondsOf = (tf) => (tf === '5m' ? 300 : 60);

test('صف حدث دورة حياة: النوع والربط السببي', () => {
  const row = toLifecycleRow('sweep', { symbol: 'btcusdt', timeframe: '5m', zoneId: 'z', key: 'K', at: T0, payload: { sweepLow: 99 } });
  assert.equal(row.type, LIFECYCLE_TYPE);
  assert.equal(row.symbol, 'BTCUSDT');
  assert.equal(row.key, 'K');
});

test('إعادة بناء السلسلة الكاملة: sweep→reclaim→published→closed', () => {
  const key = 'S|5m|z';
  const op = { id: key + '|t1', symbol: 'S', timeframe: '5m', zoneId: 'z', outcome: null };
  const evs = [
    { kind: 'sweep', symbol: 'S', timeframe: '5m', zoneId: 'z', key, at: T0, payload: { kind: 'ssl', referenceLevel: 100, liquidityLevel: 99, sweepLow: 98.9 } },
    { kind: 'reclaim', symbol: 'S', timeframe: '5m', zoneId: 'z', key, at: T0 + 120_000, payload: { elapsedMs: 120000, elapsedBars: 0.67 } },
    { kind: 'published', symbol: 'S', timeframe: '5m', zoneId: 'z', key, at: T0 + 180_000, payload: { opportunity: op } }
  ];
  const r1 = rehydrateState(evs, { nowMs: T0 + 200_000, tfSecondsOf });
  assert.equal(r1.trackers.length, 1);
  assert.equal(r1.trackers[0].phase, 'published');
  assert.equal(r1.trackers[0].reclaimElapsedMs, 120000);
  assert.equal(r1.opportunities.length, 1);
  // ثم الحسم: الفرصة تخرج من النشطة
  const r2 = rehydrateState([...evs, { kind: 'closed', symbol: 'S', timeframe: '5m', zoneId: 'z', key, at: T0 + 400_000, payload: { opportunity: { ...op, outcome: 'target' } } }], { nowMs: T0 + 500_000, tfSecondsOf });
  assert.equal(r2.opportunities.length, 0);
  assert.equal(r2.trackers[0].phase, 'invalidated');
});

test('السويب الميت زمنيا لا يُحيَا عند الاستعادة', () => {
  const key = 'S|5m|z';
  const r = rehydrateState(
    [{ kind: 'sweep', symbol: 'S', timeframe: '5m', zoneId: 'z', key, at: T0, payload: {} }],
    { nowMs: T0 + 10 * 3600_000, tfSecondsOf } // بعد 10 ساعات — تجاوز نافذة 6×5m
  );
  assert.equal(r.trackers[0].phase, 'invalidated');
  assert.equal(r.trackers[0].staleSweep, true);
});

test('قتل قسري مع 5 نشطة → عودة الخمس', () => {
  const evs = [];
  for (let i = 0; i < 5; i += 1) {
    const key = `S${i}|5m|z${i}`;
    const op = { id: key + '|t', symbol: `S${i}`, timeframe: '5m', zoneId: `z${i}`, outcome: null };
    evs.push({ kind: 'sweep', symbol: `S${i}`, timeframe: '5m', zoneId: `z${i}`, key, at: T0, payload: {} });
    evs.push({ kind: 'published', symbol: `S${i}`, timeframe: '5m', zoneId: `z${i}`, key, at: T0 + 60_000, payload: { opportunity: op } });
  }
  const r = rehydrateState(evs, { nowMs: T0 + 120_000, tfSecondsOf });
  assert.equal(r.trackers.length, 5);
  assert.equal(r.opportunities.length, 5);
});
