import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { createLiquidityWorkbench, deriveZonePoints, findLiquidityMatchCandidates, describeZone } from '../services/liquidityWorkbench.mjs';
import { createLiquidityWorkbenchRouter } from '../routes/liquidityWorkbenchRouter.mjs';

const timeframes = ['1m', '5m'];
const intervalMs = { '1m': 60_000, '5m': 300_000 };

const mockRepository = () => {
  const scans = new Map();
  const candles = new Map();
  const events = new Map();
  const samples = new Map();
  const points = new Map();
  const pointLinks = new Map();
  let failRead = false;
  let failWrite = false;
  return {
    scans,
    candles,
    events,
    samples,
    points,
    pointLinks,
    set failRead(value) { failRead = value; },
    set failWrite(value) { failWrite = value; },
    async listScans() { if (failRead) throw new Error('read failure'); return [...scans.values()]; },
    async listEvents(symbol, limit = 200) { if (failRead) throw new Error('read failure'); return [...events.values()].filter((event) => event.symbol === symbol).sort((a, b) => b.event_at - a.event_at).slice(0, limit); },
    async listPoints({ symbol, timeframe, engine, zoneId, pointIds }) {
      if (failRead) throw new Error('read failure');
      return [...points.values()].filter((point) => point.symbol === symbol && point.timeframe === timeframe && point.engine === engine && (zoneId ? point.zone_id === zoneId : !pointIds || pointIds.includes(point.point_id)));
    },
    async listPointLinks({ symbol, timeframe, engine, zoneId, pointIds }) {
      if (failRead) throw new Error('read failure');
      return [...pointLinks.values()].filter((link) => link.symbol === symbol && link.timeframe === timeframe && link.engine === engine && (zoneId ? link.zone_id === zoneId : !pointIds || pointIds.includes(link.point_id)));
    },
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
    async upsertPoints(rows) {
      if (failWrite) throw new Error('write failure');
      for (const { zone_links = [], ...row } of rows) {
        points.set(row.point_id, row);
        for (const link of zone_links) pointLinks.set(`${link.point_id}|${link.zone_id}|${link.relation_role}`, link);
      }
    },
    async upsertPointLinks(rows) { if (failWrite) throw new Error('write failure'); for (const row of rows) pointLinks.set(`${row.point_id}|${row.zone_id}|${row.relation_role}`, row); },
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
    fetchKlines: fetchKlines ?? (async (_symbol, timeframe, limit, startTime, endTime) => {
      const rows = makeCandles(fetchCount, now() - ((fetchCount + 1) * intervalMs[timeframe]), intervalMs[timeframe]);
      return rows.filter((row) => (startTime == null || row[0] >= startTime) && (endTime == null || row[0] <= endTime)).slice(0, limit);
    }),
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

test('truncated history below the detection minimum does not seed or start market subscriptions', async () => {
  const repository = mockRepository();
  const workbench = makeWorkbench({ repository, fetchCount: 59 });
  await assert.rejects(workbench.service.start(), /59\/60/);
  assert.equal(workbench.market.subscriptions.klines.size, 0);
  assert.equal(workbench.service.status().recovery, 'failed');
});

test('history shorter than 500 but above the minimum (real 1w case: 479 bars) seeds and starts', async () => {
  const repository = mockRepository();
  const workbench = makeWorkbench({ repository, fetchCount: 479 });
  const status = await workbench.service.start();
  assert.equal(status.recovery, 'ready');
  assert.equal(status.seeded, timeframes.length);
  assert.equal(repository.candles.get('BTCUSDT|1m').length, 479);
  assert.deepEqual(workbench.market.subscriptions.klines.get('liquidity-workbench'), ['BTCUSDT|1m', 'BTCUSDT|5m']);
  workbench.service.stop();
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

test('point ledger preserves source anchors and leaves missing timestamps unknown', () => {
  const candles = [{ time: 1_700_000_000 }, { time: 1_700_003_600 }, { time: 1_700_007_200 }];
  const zone = {
    id: 'supply-a', symbol: 'BTCUSDT', timeframe: '1h', kind: 'supply', state: 'candidate', form: 'A',
    touchPoints: [{ index: 0, price: 101 }, { index: 3, price: 100 }],
    trendline: { points: [{ index: 1, time: 1_700_003_600, price: 102 }] },
    fvgs: [{ index: 2, kind: 'bullish', top: 105, bottom: 103 }],
    structureEvents: [{ type: 'BOS_up', index: 2, price: 106 }]
  };
  const points = deriveZonePoints('liquidity-engine-v2', [zone], candles, 1_800_000_000_000);
  assert.deepEqual(points.map((point) => point.point_type), ['origin_candle', 'liquidity_touch', 'trendline_anchor', 'fvg', 'structure_BOS_up']);
  assert.equal(points[0].point_time, 1_700_000_000_000);
  assert.equal(points[1].point_time, null);
  assert.equal(points[1].candle_index, 3);
  assert.equal(points[0].payload.form, 'A');
  assert.equal(new Set(points.map((point) => point.point_id)).size, points.length);
});

test('point ledger collapses pooled duplicates and window-wide structure events across zones', () => {
  const candles = Array.from({ length: 6 }, (_, i) => ({ time: 1_700_000_000 + i * 3_600 }));
  const structureEvents = [
    { type: 'BOS_up', index: 2, price: 106 },
    { type: 'IDM', index: 1, price: 104 }
  ];
  const clusterZone = (id, price) => ({
    id, symbol: 'BTCUSDT', timeframe: '1h', kind: 'horizontal_bsl', state: 'confirmed',
    touchPoints: [{ index: 2, price }, { index: 2, price }, { index: 2, price }],
    structureEvents
  });
  const points = deriveZonePoints('liquidity-engine-v2', [clusterZone('z-a', 105), clusterZone('z-b', 105)], candles, 1_800_000_000_000);
  assert.equal(new Set(points.map((point) => point.point_id)).size, points.length);
  assert.equal(points.filter((point) => point.point_type === 'liquidity_touch').length, 2);
  assert.equal(points.filter((point) => point.role === 'cluster_touch' && point.zone_id === 'z-a').length, 1);
  assert.ok(points.filter((point) => point.point_type === 'liquidity_touch').every((point) => point.zone_links.length === 2));
  assert.equal(points.filter((point) => point.point_type === 'structure_BOS_up').length, 1);
  assert.equal(points.filter((point) => point.point_type === 'structure_IDM').length, 1);
  assert.deepEqual(points.find((point) => point.point_type === 'structure_BOS_up')?.zone_links.map((link) => link.zone_id).sort(), ['z-a', 'z-b']);
});

test('point identity remains stable when a source candle moves within the rolling scan window', () => {
  const sourceTime = 1_700_000_000_000;
  const pointAt = (index) => deriveZonePoints('liquidity-engine-v1', [{
    id: 'zone-1', symbol: 'BTCUSDT', timeframe: '1m', kind: 'horizontal_bsl', state: 'candidate',
    touchPoints: [{ time: sourceTime, index, price: 100 }]
  }], [], 1_800_000_000_000)[0];
  const first = pointAt(50);
  const shifted = pointAt(51);
  assert.equal(first.point_time, shifted.point_time);
  assert.equal(first.point_id, shifted.point_id);
  assert.notEqual(first.candle_index, shifted.candle_index);
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

test('restart replays every stored closed candle after the durable cursor in order', async () => {
  const now = () => 1_800_000_000_000;
  const repository = mockRepository();
  const interval = intervalMs['1m'];
  const history = makeCandles(500, now() - (501 * interval), interval);
  const storedRows = history.map((row) => ({
    symbol: 'BTCUSDT', timeframe: '1m', open_time: row[0], open: row[1], high: row[2], low: row[3],
    close: row[4], volume: row[5], close_time: row[6], taker_buy_base: row[9], source: 'test', updated_at: now()
  }));
  repository.candles.set('BTCUSDT|1m', storedRows);
  const cursorIndex = 496;
  const cursor = history[cursorIndex][0];
  repository.scans.set('combined|BTCUSDT|1m', {
    engine: 'combined', symbol: 'BTCUSDT', timeframe: '1m', candle_open_time: cursor,
    payload: { zones: { legacy: [], v2: [] } }, updated_at: now()
  });
  const scanned = [];
  const upsertScan = repository.upsertScan.bind(repository);
  repository.upsertScan = async (row) => { scanned.push(row.candle_open_time); return upsertScan(row); };
  const workbench = makeWorkbench({ repository, now });
  await workbench.service.start();
  assert.deepEqual(scanned.filter((openTime) => openTime > cursor), history.slice(cursorIndex + 1).map((row) => row[0]));
  assert.equal(workbench.service.status().recovery, 'ready');
  assert.ok(workbench.service.status().lastGapRepairedAt);
  workbench.service.stop();
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

test('point retrieval follows durable zone links even when a shared point was first saved under another zone', async () => {
  const workbench = makeWorkbench();
  const pointId = 'c'.repeat(64);
  const point = {
    point_id: pointId, engine: 'liquidity-engine-v2', symbol: 'BTCUSDT', timeframe: '1m', zone_id: 'zone-a',
    point_type: 'structure_BOS_up', role: 'confirmation_or_structure', point_time: 1_700_000_000_000,
    candle_index: 10, price: 101, price_low: null, price_high: null, zone_state: 'confirmed',
    confirmed_at: null, last_reviewed_at: 1_800_000_000_000, rules_version: 'liquidity-engine-v2', payload: {}
  };
  workbench.repository.points.set(pointId, point);
  for (const zoneId of ['zone-a', 'zone-b']) {
    const link = {
      point_id: pointId, engine: point.engine, symbol: point.symbol, timeframe: point.timeframe,
      zone_id: zoneId, relation_role: 'confirmation_or_structure', zone_kind: zoneId === 'zone-a' ? 'supply' : 'demand',
      zone_state: 'confirmed', last_seen_at: point.last_reviewed_at
    };
    workbench.repository.pointLinks.set(`${pointId}|${zoneId}|${link.relation_role}`, link);
  }
  const result = await workbench.service.listPoints({ timeframe: '1m', engine: point.engine, zoneId: 'zone-b' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].zone_links.map((link) => link.zone_id).sort(), ['zone-a', 'zone-b']);
});

test('workbench context is explicitly read-only and never claims unsupported symbol matches', () => {
  const workbench = makeWorkbench();
  const monitored = workbench.service.context('BTCUSDT', '1m');
  assert.equal(monitored.available, true);
  assert.equal(monitored.contextOnly, true);
  assert.equal(monitored.affectsOpportunityDecisions, false);
  assert.equal(workbench.service.context('ETHUSDT', '1m').reason, 'symbol_not_monitored');
  assert.equal(workbench.service.context('BTCUSDT', '4h').reason, 'unsupported_timeframe');
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
  const invalidPointEngine = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench/points?timeframe=1m&engine=other&zoneId=test`);
  assert.equal(invalidPointEngine.status, 400);
  const points = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench/points?timeframe=1m&engine=liquidity-engine-v1&zoneId=test`);
  assert.equal(points.status, 200);
  const context = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench/context?symbol=BTCUSDT&timeframe=1m`);
  assert.equal(context.status, 200);
  assert.equal((await context.json()).affectsOpportunityDecisions, false);
  const unmonitoredContext = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench/context?symbol=ETHUSDT&timeframe=1m`);
  assert.equal((await unmonitoredContext.json()).reason, 'symbol_not_monitored');
  const invalidContext = await fetch(`http://127.0.0.1:${address.port}/api/liquidity-workbench/context?symbol=BTCUSDT&timeframe=4h`);
  assert.equal(invalidContext.status, 400);
  await new Promise((resolve) => server.close(resolve));
});
