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
  CREATE TABLE IF NOT EXISTS points (
    point_id TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    point_type TEXT NOT NULL,
    role TEXT NOT NULL,
    point_time INTEGER NOT NULL,
    candle_index INTEGER,
    price REAL,
    price_low REAL,
    price_high REAL,
    zone_state TEXT,
    confirmed_at INTEGER,
    last_reviewed_at INTEGER NOT NULL,
    rules_version TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS point_zone_links (
    point_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    relation_role TEXT NOT NULL,
    zone_kind TEXT NOT NULL,
    zone_state TEXT,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (point_id, engine, symbol, timeframe, zone_id, relation_role)
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
  async listPoints({ symbol, timeframe, engine, zoneId, pointIds }) {
    if (pointIds?.length) {
      const placeholders = pointIds.map(() => '?').join(', ');
      return database.prepare(`SELECT * FROM points WHERE symbol = ? AND timeframe = ? AND engine = ? AND point_id IN (${placeholders}) ORDER BY point_time ASC`).all(symbol, timeframe, engine, ...pointIds).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    }
    return database.prepare('SELECT * FROM points WHERE symbol = ? AND timeframe = ? AND engine = ? AND zone_id = ? ORDER BY point_time ASC').all(symbol, timeframe, engine, zoneId).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  },
  async listPointLinks({ symbol, timeframe, engine, zoneId, pointIds }) {
    if (pointIds?.length) {
      const placeholders = pointIds.map(() => '?').join(', ');
      return database.prepare(`SELECT * FROM point_zone_links WHERE symbol = ? AND timeframe = ? AND engine = ? AND point_id IN (${placeholders})`).all(symbol, timeframe, engine, ...pointIds);
    }
    return database.prepare('SELECT * FROM point_zone_links WHERE symbol = ? AND timeframe = ? AND engine = ? AND zone_id = ?').all(symbol, timeframe, engine, zoneId);
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
  async upsertPoints(rows) {
    const insert = database.prepare(`INSERT INTO points (point_id, engine, symbol, timeframe, zone_id, point_type, role, point_time, candle_index, price, price_low, price_high, zone_state, confirmed_at, last_reviewed_at, rules_version, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (point_id) DO UPDATE SET zone_state=excluded.zone_state, confirmed_at=excluded.confirmed_at, last_reviewed_at=excluded.last_reviewed_at, payload=excluded.payload`);
    const linkInsert = database.prepare(`INSERT INTO point_zone_links (point_id, engine, symbol, timeframe, zone_id, relation_role, zone_kind, zone_state, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (point_id, engine, symbol, timeframe, zone_id, relation_role) DO UPDATE SET zone_kind=excluded.zone_kind, zone_state=excluded.zone_state, last_seen_at=excluded.last_seen_at`);
    for (const { zone_links = [], ...row } of rows) {
      insert.run(row.point_id, row.engine, row.symbol, row.timeframe, row.zone_id, row.point_type, row.role, row.point_time, row.candle_index, row.price, row.price_low, row.price_high, row.zone_state, row.confirmed_at, row.last_reviewed_at, row.rules_version, JSON.stringify(row.payload));
      for (const link of zone_links) linkInsert.run(link.point_id, link.engine, link.symbol, link.timeframe, link.zone_id, link.relation_role, link.zone_kind, link.zone_state, link.last_seen_at);
    }
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
  await repository.upsertPoints([{
    point_id: 'b'.repeat(64), engine: 'liquidity-engine-v2', symbol: 'BTCUSDT', timeframe: '1m',
    zone_id: 'process-recovery-zone-a', point_type: 'structure_BOS_up', role: 'confirmation_or_structure',
    point_time: now() - 60_000, candle_index: 12, price: 101, price_low: null, price_high: null,
    zone_state: 'confirmed', confirmed_at: now() - 60_000, last_reviewed_at: now(),
    rules_version: 'liquidity-engine-v2', payload: { zoneKind: 'supply' },
    zone_links: [
      { point_id: 'b'.repeat(64), engine: 'liquidity-engine-v2', symbol: 'BTCUSDT', timeframe: '1m', zone_id: 'process-recovery-zone-a', relation_role: 'confirmation_or_structure', zone_kind: 'supply', zone_state: 'confirmed', last_seen_at: now() },
      { point_id: 'b'.repeat(64), engine: 'liquidity-engine-v2', symbol: 'BTCUSDT', timeframe: '1m', zone_id: 'process-recovery-zone-b', relation_role: 'confirmation_or_structure', zone_kind: 'demand', zone_state: 'confirmed', last_seen_at: now() }
    ]
  }]);
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
const restoredLinkedPoints = await service.listPoints({ timeframe: '1m', engine: 'liquidity-engine-v2', zoneId: 'process-recovery-zone-b' });
console.log(JSON.stringify({
  recovery: status.recovery,
  seeded: status.seeded,
  storedCandles: status.storedCandles,
  candleCount: snapshot.candles.length,
  latestScan: snapshot.latestScan,
  restoredEventKeys: snapshot.recentEvents.map((event) => event.idempotency_key),
  scanRows: database.prepare('SELECT COUNT(*) AS count FROM scans').get().count,
  candleRows: database.prepare('SELECT COUNT(*) AS count FROM candles').get().count,
  pointRows: database.prepare('SELECT COUNT(*) AS count FROM points').get().count,
  restoredPointIds: restoredLinkedPoints.map((point) => point.point_id),
  restoredPointZoneIds: restoredLinkedPoints.flatMap((point) => point.zone_links.map((link) => link.zone_id)).sort(),
  eventRows: database.prepare('SELECT COUNT(*) AS count FROM events').get().count
}));
service.stop();
database.close();
