import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { createLiquidityWorkbench, findLiquidityMatchCandidates, describeZone } from '../services/liquidityWorkbench.mjs';
import { createLiquidityWorkbenchRouter } from '../routes/liquidityWorkbenchRouter.mjs';

const timeframes = ['1m', '5m'];
const intervalMs = { '1m': 60_000, '5m': 300_000 };

const mockRepository = () => {
  const scans = new Map();
  const candles = new Map();
  const events = new Map();
  const samples = new Map();
  let failRead = false;
  let failWrite = false;
  return {
    scans,
    candles,
    events,
    samples,
    set failRead(value) { failRead = value; },
    set failWrite(value) { failWrite = value; },
    async listScans() { if (failRead) throw new Error('read failure'); return [...scans.values()]; },
    async listEvents(symbol, limit = 200) { if (failRead) throw new Error('read failure'); return [...events.values()].filter((event) => event.symbol === symbol).sort((a, b) => b.event_at - a.event_at).slice(0, limit); },
    async listCandles(symbol, timeframe) { if (failRead) throw new Error('read failure'); return candles.get(`${symbol}|${timeframe}`) ?? []; },
    async upsertCandles(rows) {
      if (failWrite) throw new Error('write failure');
      for (const row of rows) {
        const key = `${row.symbol}|${row.timeframe}`;
        const next = new Map((candles.get(key) ?? []).map((item) => [item.open_time, item]));
        next.set(row.open_time, row);
        candles.set(key, [...next.values()].sort((a, b) => a.open_time - b.open_time));
      }
    },
    async upsertScan(row) { if (failWrite) throw new Error('write failure'); scans.set(`${row.engine}|${row.symbol}|${row.timeframe}`, row); },
    async insertZoneEvent(row) { if (failWrite) throw new Error('write failure'); events.set(row.idempotency_key, row); },
    async insertSample(row) { if (failWrite) throw new Error('write failure'); samples.set(row.sample_key, row); },
    async pruneRaw() { if (failWrite) throw new Error('write failure'); return 0; }
  };
};

const makeCandles = (count = 500, base = 1_700_000_000_000, interval = 60_000) => {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const openTime = base + index * interval;
    const value = 100 + Math.sin(index / 6) * 3 + Math.sin(index / 19) * 2;
    rows.push([openTime, value, value + 1, value - 1, value + Math.sin(index), 10 + index % 7, openTime + interval - 1, 0, 0, 4]);
  }
  return rows;
};

const mockMarket = ({ price = 100, priceAt = 1_700_000_000_000 } = {}) => {
  const handlers = new Set();
  const subscriptions = { klines: new Map(), trades: new Map() };
  return {
    getFreshPrice: () => price,
    getPriceAt: () => priceAt,
    flowSnapshot: () => ({ trades: 3, buyQty: 1, sellQty: 2 }),
    setKlineSubscriptions(keys, tenant) { subscriptions.klines.set(tenant, keys); },
    setAggTradeSubscriptions(keys, tenant) { subscriptions.trades.set(tenant, keys); },
    onKlineUpdate(callback) { handlers.add(callback); return () => handlers.delete(callback); },
    emitKline(event) { for (const callback of handlers) callback(event); },
    subscriptions
  };
};

const makeWorkbench = ({ repository = mockRepository(), market = mockMarket(), now = () => 1_800_000_000_000, fetchCount = 500, fetchKlines } = {}) => {
  const service = createLiquidityWorkbench({
    repository,
    market,
    fetchKlines: fetchKlines ?? (async (_symbol, timeframe) => makeCandles(fetchCount, now() - ((fetchCount + 1) * intervalMs[timeframe]), intervalMs[timeframe])),
    fetchDepth: async () => ({ bids: [['99', '2']], asks: [['101', '3']], at: now() }),
    timeframes,
    timeframeMs: intervalMs,
    tickSizeFor: async () => 0.01,
    now,
    engineOptions: () => ({})
  });
  return { service, repository, market };
};

const waitFor = async (predicate, timeoutMs = 1000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
};

test('recovery blocks startup on failed storage read and accepts a truly empty read', async () => {
  const failedRepository = mockRepository();
  failedRepository.failRead = true;
  const failed = makeWorkbench({ repository: failedRepository });
  await assert.rejects(failed.service.start(), /read failure/);
  assert.equal(failed.service.status().recovery, 'failed');
  assert.equal(failed.market.subscriptions.klines.size, 0);

  const empty = makeWorkbench();
  const status = await empty.service.start();
  assert.equal(status.recovery, 'ready');
  assert.equal(status.seeded, timeframes.length);
  assert.equal(empty.repository.candles.get('BTCUSDT|1m').length, 500);
  empty.service.stop();
});

test('truncated history does not seed or start market subscriptions', async () => {
  const repository = mockRepository();
  const workbench = makeWorkbench({ repository, fetchCount: 499 });
  await assert.rejects(workbench.service.start(), /499\/500/);
  assert.equal(workbench.market.subscriptions.klines.size, 0);
  assert.equal(workbench.service.status().recovery, 'failed');
});

test('stop during startup cancels pending history fetch without subscribing or saving scans', async () => {
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const heldFetch = new Promise((resolve) => { releaseFetch = resolve; });
  const now = () => 1_800_000_000_000;
  const workbench = makeWorkbench({
    now,
    fetchKlines: async (_symbol, timeframe) => {
      markFetchStarted();
      await heldFetch;
      return makeCandles(500, now() - (501 * intervalMs[timeframe]), intervalMs[timeframe]);
    }
  });
  const starting = workbench.service.start();
  await fetchStarted;
  workbench.service.stop();
  releaseFetch();
  const result = await starting;
  assert.equal(result.recovery, 'idle');
  assert.equal(workbench.service.status().recovery, 'idle');
  assert.deepEqual(workbench.market.subscriptions.klines.get('liquidity-workbench'), []);
  assert.equal(workbench.repository.scans.size, 0);
});

test('subscriptions are established only after every timeframe restores and stop removes them', async () => {
  const workbench = makeWorkbench();
  await workbench.service.start();
  assert.deepEqual(workbench.market.subscriptions.klines.get('liquidity-workbench'), ['BTCUSDT|1m', 'BTCUSDT|5m']);
  assert.deepEqual(workbench.market.subscriptions.trades.get('liquidity-workbench'), ['BTCUSDT']);
  workbench.service.stop();
  assert.deepEqual(workbench.market.subscriptions.klines.get('liquidity-workbench'), []);
});

test('zone matching reports candidate only within one tick, timeframe, direction, and bar', () => {
  const legacy = [{ id: 'old-a', symbol: 'BTCUSDT', timeframe: '1m', kind: 'horizontal_bsl', referenceLevel: 100, createdAt: 1700000000 }];
  const v2 = [{ id: 'new-a', symbol: 'BTCUSDT', timeframe: '1m', kind: 'horizontal_bsl', direction: 'down', referenceLevel: 100.01, createdAt: 1700000000 }];
  assert.equal(findLiquidityMatchCandidates(legacy, v2, { tickSize: 0.01, timeframeMs: 60000 }).length, 1);
  assert.equal(findLiquidityMatchCandidates(legacy, [{ ...v2[0], referenceLevel: 100.02 }], { tickSize: 0.01, timeframeMs: 60000 }).length, 0);
  assert.equal(findLiquidityMatchCandidates(legacy, [{ ...v2[0], timeframe: '5m' }], { tickSize: 0.01, timeframeMs: 60000 }).length, 0);
  assert.equal(findLiquidityMatchCandidates(legacy, [{ ...v2[0], direction: 'up' }], { tickSize: 0.01, timeframeMs: 60000 }).length, 0);
});

test('descriptive observation reports distance and age without an invented score', () => {
  const result = describeZone({ referenceLevel: 100 }, { price: 110, priceAt: 1000, now: 2000 });
  assert.equal(result.distance, 10);
  assert.equal(result.distancePct, 100 / 11);
  assert.equal(result.priceAgeMs, 1000);
  assert.equal('confidence' in result, false);
  assert.equal('probability' in result, false);
});

test('a new process restores scan state and does not duplicate persisted events', async () => {
  const first = makeWorkbench();
  await first.service.start();
  const eventCount = first.repository.events.size;
  const expectedEventKeys = [...first.repository.events.values()].filter((event) => event.timeframe === '1m').map((event) => event.idempotency_key).sort();
  assert.equal(first.repository.scans.size, timeframes.length);
  first.service.stop();
  const second = makeWorkbench({ repository: first.repository });
  await second.service.start();
  assert.equal(second.service.status().seeded, timeframes.length);
  assert.equal(second.repository.events.size, eventCount);
  assert.deepEqual(second.service.snapshot('1m').recentEvents.map((event) => event.idempotency_key).sort(), expectedEventKeys);
  assert.equal(second.service.status().recovery, 'ready');
  second.service.stop();
});

test('closed kline messages update persisted scans once per bar', async () => {
  const workbench = makeWorkbench();
  await workbench.service.start();
  const openTime = 1_800_000_000_000 - 60_000;
  workbench.market.emitKline({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    kline: { t: openTime, T: openTime + 59_999, o: '101', h: '104', l: '99', c: '103', v: '15', V: '8', x: true }
  });
  await waitFor(() => workbench.repository.scans.get('combined|BTCUSDT|1m')?.candle_open_time === openTime);
  const scan = workbench.repository.scans.get('combined|BTCUSDT|1m');
  assert.equal(scan.candle_open_time, openTime);
  assert.equal(workbench.repository.candles.get('BTCUSDT|1m').length, 501);
  workbench.service.stop();
});

test('persistence failure degrades state and prevents false success', async () => {
  const repository = mockRepository();
  const workbench = makeWorkbench({ repository });
  await workbench.service.start();
  repository.failWrite = true;
  const openTime = 1_800_000_000_000 - 60_000;
  workbench.market.emitKline({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    kline: { t: openTime, T: openTime + 59_999, o: '101', h: '104', l: '99', c: '103', v: '15', V: '8', x: true }
  });
  await waitFor(() => workbench.service.status().recovery === 'degraded');
  workbench.service.stop();
});

test('read-only router serves status and rejects unsupported timeframes', async () => {
  const workbench = makeWorkbench();
  const app = express();
  app.use('/api/liquidity-workbench', createLiquidityWorkbenchRouter({ getWorkbench: () => workbench.service, timeframes }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const status = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench/status`);
  assert.equal(status.status, 200);
  const invalid = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench?timeframe=1M`);
  assert.equal(invalid.status, 400);
  await new Promise((resolve) => server.close(resolve));
});
