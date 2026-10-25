import { DatabaseSync } from 'node:sqlite';
import { createLiquidityWorkbench } from '../services/liquidityWorkbench.mjs';

const [mode, databasePath] = process.argv.slice(2);
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS scans (
    engine TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    candle_open_time INTEGER NOT NULL,
    computed_at INTEGER NOT NULL,
    bar_count INTEGER NOT NULL,
    data_source TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (engine, symbol, timeframe)
  );
  CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    close_time INTEGER NOT NULL,
    taker_buy_base REAL NOT NULL,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, timeframe, open_time)
  );
  CREATE TABLE IF NOT EXISTS events (
    idempotency_key TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS samples (
    sample_key TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    sampled_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

const parseRows = (rows) => rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
const repository = {
  async listScans(symbol) {
    return parseRows(database.prepare('SELECT * FROM scans WHERE symbol = ? ORDER BY computed_at DESC').all(symbol));
  },
  async listEvents(symbol, limit = 200) {
    return parseRows(database.prepare('SELECT * FROM events WHERE symbol = ? ORDER BY event_at DESC, rowid DESC LIMIT ?').all(symbol, limit));
  },
  async listCandles(symbol, timeframe, limit = 500) {
    return database.prepare('SELECT * FROM (SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?) ORDER BY open_time ASC').all(symbol, timeframe, limit);
  },
  async upsertCandles(rows) {
    const insert = database.prepare(`INSERT INTO candles (symbol, timeframe, open_time, open, high, low, close, volume, close_time, taker_buy_base, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume, close_time=excluded.close_time, taker_buy_base=excluded.taker_buy_base, source=excluded.source, updated_at=excluded.updated_at`);
    for (const row of rows) insert.run(row.symbol, row.timeframe, row.open_time, row.open, row.high, row.low, row.close, row.volume, row.close_time, row.taker_buy_base, row.source, row.updated_at);
  },
  async upsertScan(row) {
    database.prepare(`INSERT INTO scans (engine, symbol, timeframe, candle_open_time, computed_at, bar_count, data_source, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (engine, symbol, timeframe) DO UPDATE SET candle_open_time=excluded.candle_open_time, computed_at=excluded.computed_at, bar_count=excluded.bar_count, data_source=excluded.data_source, payload=excluded.payload`)
      .run(row.engine, row.symbol, row.timeframe, row.candle_open_time, row.computed_at, row.bar_count, row.data_source, JSON.stringify(row.payload));
  },
  async insertZoneEvent(row) {
    database.prepare('INSERT OR IGNORE INTO events (idempotency_key, engine, symbol, timeframe, zone_id, event_type, event_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.idempotency_key, row.engine, row.symbol, row.timeframe, row.zone_id, row.event_type, row.event_at, JSON.stringify(row.payload));
  },
  async insertSample(row) {
    database.prepare('INSERT OR IGNORE INTO samples (sample_key, symbol, timeframe, sampled_at, source, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.sample_key, row.symbol, row.timeframe, row.sampled_at, row.source, JSON.stringify(row.payload));
  },
  async pruneRaw(cutoff) {
    const candles = database.prepare('DELETE FROM candles WHERE close_time < ?').run(cutoff).changes;
    const samples = database.prepare('DELETE FROM samples WHERE sampled_at < ?').run(cutoff).changes;
    return candles + samples;
  }
};

const timeframes = ['1m', '5m'];
const timeframeMs = { '1m': 60_000, '5m': 300_000 };
const now = () => 1_800_000_000_000;
const makeCandles = (count, base, interval) => Array.from({ length: count }, (_, index) => {
  const openTime = base + index * interval;
  const close = 100 + Math.sin(index / 6) * 3 + Math.sin(index / 19) * 2;
  return [openTime, close, close + 1, close - 1, close + Math.sin(index), 10 + index % 7, openTime + interval - 1, 0, 0, 4];
});
const listeners = new Set();
const market = {
  getFreshPrice: () => 100,
  getPriceAt: () => now() - 1000,
  flowSnapshot: () => ({ trades: 2, buyQty: 1, sellQty: 1 }),
  setKlineSubscriptions() {},
  setAggTradeSubscriptions() {},
  onKlineUpdate(callback) { listeners.add(callback); return () => listeners.delete(callback); }
};
const service = createLiquidityWorkbench({
  repository,
  market,
  fetchKlines: async (_symbol, timeframe, limit) => makeCandles(limit, now() - ((limit + 1) * timeframeMs[timeframe]), timeframeMs[timeframe]),
  fetchDepth: async () => ({ bids: [['99', '2']], asks: [['101', '3']], at: now() }),
  timeframes,
  timeframeMs,
  tickSizeFor: async () => 0.01,
  now,
  engineOptions: () => ({})
});

const status = await service.start();
if (mode === 'seed-crash') {
  await repository.insertZoneEvent({
    idempotency_key: 'process-recovery-fixture-event',
    engine: 'liquidity-engine-v1',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    zone_id: 'process-recovery-fixture-zone',
    event_type: 'discovered',
    event_at: now() - 1000,
    payload: { previousState: null, zone: { id: 'process-recovery-fixture-zone', state: 'candidate' } }
  });
  console.log(JSON.stringify({ recovery: status.recovery, seeded: status.seeded, storedCandles: status.storedCandles }));
  process.exit(73);
}

const snapshot = service.snapshot('1m');
console.log(JSON.stringify({
  recovery: status.recovery,
  seeded: status.seeded,
  storedCandles: status.storedCandles,
  candleCount: snapshot.candles.length,
  latestScan: snapshot.latestScan,
  restoredEventKeys: snapshot.recentEvents.map((event) => event.idempotency_key),
  scanRows: database.prepare('SELECT COUNT(*) AS count FROM scans').get().count,
  candleRows: database.prepare('SELECT COUNT(*) AS count FROM candles').get().count,
  eventRows: database.prepare('SELECT COUNT(*) AS count FROM events').get().count
}));
service.stop();
database.close();
