import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { detectLiquidityZones } from '../liquidity-zones/engine.mjs';
import { normalizeHistoryKlines } from '../services/liquidityHistoryData.mjs';
import { createLegacyHistorySnapshotService, validateLegacySnapshotQuery } from '../services/liquidityHistorySnapshot.mjs';

const minute = 60_000;
const fixedNow = 1_700_100_000_000;
const startTime = fixedNow - 90 * minute;
const endTime = fixedNow;

const createRows = (start, count) => Array.from({ length: count }, (_, index) => {
  const openTime = start + index * minute;
  const price = 100 + Math.sin(index / 3);
  return [openTime, price, price + 1, price - 1, price + 0.2, 10, openTime + minute - 1];
});

const query = (overrides = {}) => ({
  symbol: 'BTCUSDT',
  timeframe: '1m',
  startTime,
  endTime,
  snapshotTime: endTime,
  ...overrides
});

const computeResult = {
  ok: true,
  bars: 90,
  totalZones: 1,
  rightBars: 3,
  rawZones: [{ id: 'raw-zone', createdAt: startTime / 1000 + 60 }],
  zones: [{ id: 'serialized-zone', availableAt: startTime / 1000 + 180 }],
  computeMs: 5
};

test('query validation requires a supported timeframe, ordered UTC bounds and a non-future snapshot', () => {
  const validated = validateLegacySnapshotQuery(query(), fixedNow);
  assert.equal(validated.symbol, 'BTCUSDT');
  assert.equal(validated.timeframe, '1m');
  assert.equal(validated.calculationStartTime, startTime);
  assert.equal(validated.warmupBars, 0);

  assert.throws(() => validateLegacySnapshotQuery(query({ symbol: 'BTC/USDT' }), fixedNow), /صيغة الرمز/);
  assert.throws(() => validateLegacySnapshotQuery(query({ timeframe: '7m' }), fixedNow), /الفريم/);
  assert.throws(() => validateLegacySnapshotQuery(query({ startTime: endTime }), fixedNow), /بعد تاريخ البداية/);
  assert.throws(() => validateLegacySnapshotQuery(query({ snapshotTime: fixedNow + 1 }), fixedNow), /حتى الوقت الحالي/);
});

test('historical result uses only complete candles through snapshot and retains raw plus serialized engine outputs', async () => {
  const requested = [];
  const service = createLegacyHistorySnapshotService({
    now: () => fixedNow,
    klines: async (...args) => {
      requested.push(args);
      return createRows(startTime, 90);
    },
    compute: async () => computeResult
  });

  const result = await service.getSnapshot(query());
  assert.equal(result.engineKey, 'legacy');
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.timeframe, '1m');
  assert.equal(result.bars, 90);
  assert.equal(result.totalZones, 1);
  assert.deepEqual(result.zones, computeResult.zones);
  assert.deepEqual(result.rawZones, computeResult.rawZones);
  assert.equal(result.candles.length, 90);
  assert.equal(result.candles[0][0], startTime / 1000);
  assert.equal(requested.length, 1);
  assert.equal(requested[0][0], 'BTCUSDT');
  assert.equal(requested[0][1], '1m');
  assert.equal(requested[0][2], 1000);
  assert.equal(requested[0][3], startTime);
  assert.equal(requested[0][4], endTime - 1);
});

test('same query deduplicates concurrent work and uses only an exact-query cache entry', async () => {
  let fetchCalls = 0;
  let computeCalls = 0;
  const service = createLegacyHistorySnapshotService({
    now: () => fixedNow,
    klines: async (symbol, timeframe, limit, from, to) => {
      fetchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return createRows(from, 90);
    },
    compute: async () => {
      computeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return computeResult;
    }
  });

  const [first, second] = await Promise.all([service.getSnapshot(query()), service.getSnapshot(query())]);
  assert.equal(first.totalZones, 1);
  assert.equal(second.totalZones, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(computeCalls, 1);

  const cached = service.request(query());
  assert.equal(cached.kind, 'ready');
  assert.equal(cached.value.cached, true);
  assert.equal(service.request(query({ startTime: startTime - minute })).kind, 'computing');
});

test('missing, duplicate, malformed, and insufficient historical candles fail rather than returning an empty success', async () => {
  const duplicateRows = createRows(startTime, 90);
  duplicateRows[3] = duplicateRows[2];
  const duplicateService = createLegacyHistorySnapshotService({
    now: () => fixedNow,
    klines: async () => duplicateRows,
    compute: async () => computeResult
  });
  await assert.rejects(duplicateService.getSnapshot(query()), /مكررة/);

  const shortService = createLegacyHistorySnapshotService({
    now: () => fixedNow,
    klines: async () => createRows(startTime, 20),
    compute: async () => computeResult
  });
  await assert.rejects(shortService.getSnapshot(query()), /كافية/);
});

test('failed jobs return a retryable error state rather than an empty result', async () => {
  const service = createLegacyHistorySnapshotService({
    now: () => fixedNow,
    klines: async () => { throw new Error('Binance unavailable'); },
    compute: async () => computeResult
  });
  await assert.rejects(service.getSnapshot(query()), /Binance unavailable/);
  const state = service.request(query());
  assert.equal(state.kind, 'error');
  assert.equal(state.statusCode, 503);
  assert.match(state.message, /Binance unavailable/);
});

const stripGeneratedAt = (value) => Array.isArray(value)
  ? value.map(stripGeneratedAt)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'detectedAt')
      .map(([key, nested]) => [key, stripGeneratedAt(nested)]))
    : value;

test('real worker output matches the legacy golden fixture before serialization', async () => {
  const fixtureStart = 1_700_000_000_000;
  const fixtureBars = 400;
  const fixtureEnd = fixtureStart + fixtureBars * minute;
  const rows = Array.from({ length: fixtureBars }, (_, index) => {
    const trend = index * 0.05;
    const wave = 100 + trend + Math.sin(index / 7) * 3 + Math.sin(index / 23) * 1.5;
    const openTime = fixtureStart + index * minute;
    return [
      openTime,
      wave,
      wave + 1 + (index % 13 === 0 ? 0.6 : 0),
      wave - 1 - (index % 17 === 0 ? 0.6 : 0),
      wave + (index % 3 === 0 ? 0.5 : -0.5),
      10,
      openTime + minute - 1
    ];
  });
  const candles = normalizeHistoryKlines(rows, {
    timeframe: '1m',
    startTime: fixtureStart,
    endTime: fixtureEnd,
    snapshotTime: fixtureEnd
  }).candles;
  const expectedRawZones = detectLiquidityZones({
    symbol: 'TESTUSDT',
    timeframe: '1m',
    candles,
    endIndex: candles.length - 1
  });
  const expectedHash = 'd06953cdfe4e55d7d14ce218b045399226d27d73aed0cc7da021130301ebb7ee';
  const expectedStable = stripGeneratedAt(expectedRawZones);
  assert.equal(createHash('sha256').update(JSON.stringify(expectedStable)).digest('hex'), expectedHash);

  const service = createLegacyHistorySnapshotService({
    now: () => fixedNow,
    klines: async () => rows
  });
  const actual = await service.getSnapshot(query({
    symbol: 'TESTUSDT',
    startTime: fixtureStart,
    endTime: fixtureEnd,
    snapshotTime: fixtureEnd
  }));
  assert.deepEqual(stripGeneratedAt(actual.rawZones), expectedStable);
  assert.equal(actual.totalZones, 2);
  assert.equal(actual.zones.length, expectedRawZones.length);
  assert.equal(actual.zones[0].id, actual.rawZones[0].id);
  assert.equal(Object.hasOwn(actual.zones[0], 'raw'), false);
  assert.ok(Object.hasOwn(actual.zones[0], 'availableAt'));
});
