import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, databasePath, sourceRoot] = process.argv.slice(2);
const database = new DatabaseSync(databasePath);
const now = 1_700_000_000_000;

if (mode === 'seed' || mode === 'crash-after-commit') {
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, symbol TEXT NOT NULL, ts INTEGER NOT NULL, meta TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO events (id, type, symbol, ts, meta) VALUES (?, ?, ?, ?, ?)');
  const active = {
    id: 'BTCUSDT|5m|active-zone|1700000000', symbol: 'BTCUSDT', timeframe: '5m', zoneId: 'active-zone',
    entry: 100, stop: 96, tp: 108, detectedAt: now - 60_000, outcome: null
  };
  const closed = {
    id: 'ETHUSDT|5m|closed-zone|1700000000', symbol: 'ETHUSDT', timeframe: '5m', zoneId: 'closed-zone',
    entry: 100, stop: 96, tp: 108, detectedAt: now - 60_000, outcome: 'target', outcomeAt: now - 10_000
  };
  const rows = [
    [1, 'live_lifecycle', 'BTCUSDT', now - 30_000, JSON.stringify({ kind: 'sweep', timeframe: '5m', zoneId: active.zoneId, key: 'BTCUSDT|5m|active-zone', payload: { referenceLevel: 101, liquidityLevel: 100, sweepLow: 99 } })],
    [2, 'live_opportunity', active.symbol, now - 20_000, JSON.stringify({ opportunity: active })],
    [3, 'live_lifecycle', 'ETHUSDT', now - 30_000, JSON.stringify({ kind: 'sweep', timeframe: '5m', zoneId: closed.zoneId, key: 'ETHUSDT|5m|closed-zone', payload: { referenceLevel: 101, liquidityLevel: 100, sweepLow: 99 } })],
    [4, 'live_opportunity', closed.symbol, now - 20_000, JSON.stringify({ opportunity: { ...closed, outcome: null } })],
    [5, 'live_opportunity_closed', closed.symbol, now - 10_000, JSON.stringify({ opportunity: closed })]
  ];
  database.exec('BEGIN');
  try {
    for (const row of rows) insert.run(...row);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  if (mode === 'crash-after-commit') process.exit(73);
  database.close();
  process.exit(0);
}

if (mode === 'inspect') {
  const count = (type) => database.prepare('SELECT COUNT(*) AS count FROM events WHERE type = ?').get(type).count;
  const result = {
    lifecycle: count('live_lifecycle'),
    published: count('live_opportunity'),
    closed: count('live_opportunity_closed'),
    total: database.prepare('SELECT COUNT(*) AS count FROM events').get().count
  };
  database.close();
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (mode !== 'recover') throw new Error(`Unsupported fixture mode: ${mode}`);

const [{ createLiveOpportunityEngine }, { createLiveOpportunityRecovery }] = await Promise.all([
  import(pathToFileURL(path.join(sourceRoot, 'live-opportunities/loop.mjs'))),
  import(pathToFileURL(path.join(sourceRoot, 'live-opportunities/recovery.mjs')))
]);
const rowsFor = (types) => {
  const placeholders = types.map(() => '?').join(', ');
  return database.prepare(`SELECT id, type, symbol, ts, meta FROM events WHERE type IN (${placeholders}) ORDER BY id ASC`).all(...types);
};
let listenerCount = 0;
const market = {
  onCandleClose() { listenerCount += 1; return () => { listenerCount -= 1; }; },
  connected: () => true,
  getPrices: () => ({ BTCUSDT: 101 }),
  getPrice: () => 101,
  setKlineSubscriptions() {},
  setAggTradeSubscriptions() {},
  stats: () => ({ connected: true })
};
const engine = createLiveOpportunityEngine({
  now: () => now,
  market,
  zoneSource: () => [],
  resolveTargets: async () => ['BTCUSDT'],
  fetchPrices: async () => ({ BTCUSDT: 101 }),
  fetchBookSignals: async () => ({}),
  fetchRawKlines: async () => [],
  readCalibration: async () => null,
  log: { log() {}, warn() {}, error() {} },
  config: { recoveryRequired: true, cycleMs: 60_000, tickMs: 60_000, calibrationMs: 60_000 }
});
const recovery = createLiveOpportunityRecovery({
  engine,
  readLifecycle: async () => ({ rows: rowsFor(['live_lifecycle']), pages: 1, truncated: false }),
  readOpportunities: async () => ({ rows: rowsFor(['live_opportunity', 'live_opportunity_closed']), pages: 1, truncated: false }),
  log: { log() {}, error() {} }
});
try {
  const result = await recovery.runNow();
  assert.equal(result.ok, true);
  assert.equal(engine.getStatus().recovery.state, 'ready');
  assert.deepEqual(engine.getFeed().opportunities.map(opportunity => opportunity.id), ['BTCUSDT|5m|active-zone|1700000000']);
  assert.equal(engine.findOpportunity('ETHUSDT|5m|closed-zone|1700000000'), null);
  const tracker = engine.getTracker('BTCUSDT|5m|active-zone');
  const closedTracker = engine.getTracker('ETHUSDT|5m|closed-zone');
  assert.equal(tracker?.phase, 'published');
  assert.equal(tracker?.publishedKey, 'BTCUSDT|5m|active-zone|1700000000');
  assert.equal(closedTracker?.phase, 'invalidated');
  assert.equal(listenerCount, 1);
  process.stdout.write(JSON.stringify({
    recovery: engine.getStatus().recovery.state,
    activeIds: engine.getFeed().opportunities.map(opportunity => opportunity.id),
    closedIds: rowsFor(['live_opportunity_closed']).map(row => JSON.parse(row.meta).opportunity.id),
    trackerPhase: tracker?.phase,
    trackerPublishedKey: tracker?.publishedKey,
    listenerCount
  }));
} finally {
  engine.stop();
  recovery.stop();
  database.close();
}
process.exit(0);
