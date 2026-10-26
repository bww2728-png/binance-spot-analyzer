import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDurablePersistence } from '../services/liquidityWorkbenchRepository.mjs';

const candleRow = (openTime) => ({
  symbol: 'BTCUSDT', timeframe: '1h', open_time: openTime, open: 1, high: 2, low: 0.5,
  close: 1.5, volume: 10, close_time: openTime + 3_600_000 - 1, taker_buy_base: 1, source: 'test', updated_at: openTime
});

const repositoryStub = () => {
  const candles = new Map();
  const events = new Map();
  const points = new Map();
  let unavailable = false;
  return {
    candles,
    events,
    points,
    set unavailable(value) { unavailable = value; },
    async listScans() { if (unavailable) throw new Error('storage read failed'); return []; },
    async listEvents() { if (unavailable) throw new Error('storage read failed'); return [...events.values()]; },
    async listPoints({ zoneId }) { if (unavailable) throw new Error('storage read failed'); return [...points.values()].filter((row) => !zoneId || row.zone_id === zoneId); },
    async listCandles() { if (unavailable) throw new Error('storage read failed'); return [...candles.values()]; },
    async upsertCandles(rows) { if (unavailable) throw new Error('storage write failed'); for (const row of rows) candles.set(row.open_time, row); },
    async upsertScan() { if (unavailable) throw new Error('storage write failed'); },
    async upsertPoints(rows) { if (unavailable) throw new Error('storage write failed'); for (const row of rows) points.set(row.point_id, row); },
    async insertZoneEvent(row) { if (unavailable) throw new Error('storage write failed'); events.set(row.idempotency_key, row); },
    async insertSample() { if (unavailable) throw new Error('storage write failed'); },
    async pruneRaw() { if (unavailable) throw new Error('storage write failed'); }
  };
};

test('storage read/write failures are surfaced and do not become successful in-memory persistence', async () => {
  const base = repositoryStub();
  base.unavailable = true;
  const repository = withDurablePersistence(base);
  await assert.rejects(repository.listCandles('BTCUSDT', '1h'), /storage read failed/);
  assert.equal(repository.persistenceMode, 'unavailable');
  assert.match(repository.persistenceStatus().lastError, /storage read failed/);
  await assert.rejects(repository.upsertCandles([candleRow(1000)]), /storage write failed/);
  assert.equal(base.candles.size, 0);
  assert.equal(repository.persistenceMode, 'unavailable');
});

test('a truly empty successful durable read stays empty', async () => {
  const repository = withDurablePersistence(repositoryStub());
  assert.deepEqual(await repository.listCandles('BTCUSDT', '1h'), []);
  assert.deepEqual(await repository.listEvents('BTCUSDT'), []);
  assert.equal(repository.persistenceMode, 'supabase');
});

test('repository recovers when durable storage becomes available again', async () => {
  const base = repositoryStub();
  base.unavailable = true;
  const repository = withDurablePersistence(base);
  await assert.rejects(repository.upsertCandles([candleRow(1000)]), /storage write failed/);
  base.unavailable = false;
  await repository.upsertCandles([candleRow(1000)]);
  assert.equal(repository.persistenceMode, 'supabase');
  assert.equal((await repository.listCandles('BTCUSDT', '1h')).length, 1);
});

test('zone event idempotency is delegated to the durable repository', async () => {
  const base = repositoryStub();
  const repository = withDurablePersistence(base);
  const event = {
    idempotency_key: 'discovered-zone-1', engine: 'liquidity-engine-v1', symbol: 'BTCUSDT',
    timeframe: '1h', zone_id: 'zone-1', event_type: 'discovered', event_at: 1000, payload: {}
  };
  await repository.insertZoneEvent(event);
  await repository.insertZoneEvent(event);
  assert.equal(base.events.size, 1);
  assert.equal((await repository.listEvents('BTCUSDT')).length, 1);
});
