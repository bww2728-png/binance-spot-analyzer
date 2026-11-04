import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { test } from 'node:test';
import { createManualLiquidityRouter } from '../routes/manualLiquidityRouter.mjs';
import { createManualLiquidityService } from '../services/manualLiquidity.mjs';

const MINUTE = 60_000;
const fixedNow = Date.UTC(2026, 10, 4, 12, 0, 0);
const candle = (openTime, values = [100, 102, 99, 101, 4]) => [openTime, ...values, openTime + MINUTE - 1];
const validRepository = () => {
  const rows = new Map();
  return {
    rows,
    listManualDrawings: async ({ symbol, timeframe }) => [...rows.values()].filter((row) => row.symbol === symbol && row.timeframe === timeframe),
    upsertManualDrawing: async (row) => { rows.set(row.drawing_id, row); return [row]; },
    deleteManualDrawing: async ({ drawingId, symbol, timeframe }) => {
      const row = rows.get(drawingId);
      if (row?.symbol === symbol && row?.timeframe === timeframe) rows.delete(drawingId);
    }
  };
};

test('fetches historical pages, sorts and validates candles, marks the active candle and memoizes', async () => {
  const repository = validRepository();
  const calls = [];
  const now = fixedNow;
  const service = createManualLiquidityService({
    repository,
    now: () => now,
    klines: async (symbol, timeframe, limit, startTime, endTime) => {
      calls.push({ symbol, timeframe, limit, startTime, endTime });
      const first = Math.floor(startTime / MINUTE) * MINUTE;
      if (calls.length === 1) return [candle(first + MINUTE), candle(first), candle(first + 2 * MINUTE, [100, 99, 99, 100, 2]), candle(Math.floor(now / MINUTE) * MINUTE)];
      return [];
    }
  });
  const result = await service.candles({ symbol: 'btcusdt', timeframe: '1m' });
  assert.equal(result.source, 'binance-spot');
  assert.equal(result.days, 90);
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.bars, 3);
  assert.equal(result.duplicateRows, 0);
  assert.equal(result.invalidRows, 1);
  assert.ok(result.candles[0].time < result.candles[1].time);
  assert.equal(result.candles.at(-1).complete, false);
  assert.equal((await service.candles({ symbol: 'BTCUSDT', timeframe: '1m' })).cached, true);
  assert.equal(calls.length, 1);
});

test('reports temporal gaps and rejects invalid request or source results', async () => {
  const repository = validRepository();
  const service = createManualLiquidityService({
    repository,
    now: () => fixedNow,
    klines: async (_symbol, _timeframe, _limit, startTime) => {
      const first = Math.ceil(startTime / MINUTE) * MINUTE;
      return [candle(first), candle(first + 3 * MINUTE)];
    }
  });
  await assert.rejects(() => service.candles({ symbol: 'BTC USDT', timeframe: '1m' }), /صيغة الرمز/);
  await assert.rejects(() => service.candles({ symbol: 'BTCUSDT', timeframe: '2m' }), /الفريم الزمني/);
  const result = await service.candles({ symbol: 'BTCUSDT', timeframe: '1m' });
  assert.ok(result.gaps > 0);
  const broken = createManualLiquidityService({ repository, now: () => fixedNow, klines: async () => null });
  await assert.rejects(() => broken.candles({ symbol: 'BTCUSDT', timeframe: '1m' }), /استجابة غير صالحة/);
});

test('manual drawings persist independently by symbol and timeframe with idempotent upsert and scoped deletion', async () => {
  const repository = validRepository();
  const service = createManualLiquidityService({ repository, now: () => fixedNow, klines: async () => [] });
  const drawing = { id: 'draw-1', type: 'arrow', liquidityType: 'BSL', symbol: 'BTCUSDT', timeframe: '15m', anchors: [{ time: 1_700_000_000, price: 70_000 }], color: '#f23645', label: 'BSL' };
  await service.saveDrawing(drawing);
  await service.saveDrawing({ ...drawing, label: 'BSL updated' });
  assert.equal((await service.listDrawings({ symbol: 'BTCUSDT', timeframe: '15m' })).length, 1);
  assert.equal((await service.listDrawings({ symbol: 'BTCUSDT', timeframe: '1h' })).length, 0);
  assert.equal((await service.listDrawings({ symbol: 'ETHUSDT', timeframe: '15m' })).length, 0);
  assert.equal((await service.listDrawings({ symbol: 'BTCUSDT', timeframe: '15m' }))[0].label, 'BSL updated');
  await service.deleteDrawing({ symbol: 'BTCUSDT', timeframe: '1h', drawingId: 'draw-1' });
  assert.equal(repository.rows.size, 1);
  await service.deleteDrawing({ symbol: 'BTCUSDT', timeframe: '15m', drawingId: 'draw-1' });
  assert.equal(repository.rows.size, 0);
});

test('drawing validation rejects malformed anchors and unsupported classifications', async () => {
  const service = createManualLiquidityService({ repository: validRepository(), now: () => fixedNow, klines: async () => [] });
  await assert.rejects(() => service.saveDrawing({ symbol: 'BTCUSDT', timeframe: '1m', id: 'bad', type: 'line', anchors: [{ time: 1, price: -1 }, { time: 2, price: 2 }] }), /سعر نقطة الرسم/);
  await assert.rejects(() => service.saveDrawing({ symbol: 'BTCUSDT', timeframe: '1m', id: 'bad', type: 'arrow', liquidityType: 'unknown', anchors: [{ time: 1, price: 100 }] }), /BSL أو SSL/);
  await assert.rejects(() => service.saveDrawing({ symbol: 'BTCUSDT', timeframe: '1m', id: 'bad', type: 'line', anchors: [{ time: 1, price: 100 }] }), /نقاط الرسم/);
});

test('HTTP routes report storage failures and serve saved data without treating errors as empty', async () => {
  const service = {
    candles: async () => ({ source: 'binance-spot', candles: [] }),
    listDrawings: async () => { throw new Error('database offline'); },
    saveDrawing: async (drawing) => drawing,
    deleteDrawing: async ({ drawingId }) => ({ ok: true, drawingId })
  };
  const app = express();
  app.use(express.json());
  app.use('/api/manual-liquidity', createManualLiquidityRouter({ getService: () => service }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/manual-liquidity`;
  try {
    const candles = await fetch(`${base}/candles?symbol=BTCUSDT&timeframe=1m`);
    assert.equal(candles.status, 200);
    const error = await fetch(`${base}/drawings?symbol=BTCUSDT&timeframe=1m`);
    assert.equal(error.status, 503);
    assert.match((await error.json()).error, /database offline/);
    const saved = await fetch(`${base}/drawings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'BTCUSDT', timeframe: '1m' }) });
    assert.equal(saved.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
