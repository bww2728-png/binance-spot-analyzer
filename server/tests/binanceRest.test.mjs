import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBinanceRest } from '../services/binanceRest.mjs';

test('Binance REST service preserves request paths, timeouts, query escaping, and numeric prices', async () => {
  const calls = [];
  const rest = createBinanceRest({
    fetchJson: async (path, timeout) => {
      calls.push({ path, timeout });
      if (path.startsWith('/api/v3/exchangeInfo')) return { symbols: [] };
      if (path.startsWith('/api/v3/klines')) return [[1, '100', '101', '99', '100', '4']];
      if (path.startsWith('/api/v3/depth')) return { bids: [], asks: [] };
      return [{ symbol: 'BTCUSDT', price: '68000.50' }];
    }
  });

  await rest.exchangeInfo();
  await rest.klines('BTCUSDT', '1m', 500, 10, 20);
  await rest.depth('BTCUSDT', 3);
  assert.deepEqual(await rest.tickerPrices(['BTCUSDT']), { BTCUSDT: 68000.5 });
  assert.deepEqual(await rest.allTickerPrices(), { BTCUSDT: 68000.5 });

  assert.equal(calls[0].path, '/api/v3/exchangeInfo');
  assert.equal(calls[0].timeout, 30000);
  assert.equal(calls[1].path, '/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500&startTime=10&endTime=20');
  assert.equal(calls[1].timeout, 15000);
  assert.match(calls[2].path, /limit=5$/);
  assert.equal(calls[3].path, '/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22%5D');
  assert.equal(calls[4].path, '/api/v3/ticker/price');
});

test('compatibility export is the same Binance service, not part of database storage', async () => {
  const dbModule = await import(`../db.js?binance-service-boundary=${Date.now()}`);
  const binanceModule = await import('../services/binanceRest.mjs');
  assert.equal(dbModule.default.binance, binanceModule.binanceRest);
});
