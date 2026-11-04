import assert from 'node:assert/strict';
import { test } from 'node:test';

test('manual drawing repository uses scoped Supabase REST calls and idempotent upsert', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.SUPABASE_URL = 'https://supabase-test.invalid';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, text: async () => options.method === 'POST' ? '[{"payload":{"drawing_id":"d1"}}]' : '[]' };
  };
  try {
    const { default: db } = await import(`../db.js?manual-liquidity-repository-test=${Date.now()}`);
    await db.manualLiquidityDrawings.list({ symbol: 'BTCUSDT', timeframe: '15m' });
    await db.manualLiquidityDrawings.upsert({ drawing_id: 'd1', symbol: 'BTCUSDT', timeframe: '15m', drawing_type: 'line', payload: {}, created_at: 1, updated_at: 2 });
    await db.manualLiquidityDrawings.remove({ symbol: 'BTCUSDT', timeframe: '15m', drawingId: 'd1' });
    assert.equal(requests.length, 3);
    assert.match(requests[0].url, /symbol=eq\.BTCUSDT/);
    assert.match(requests[0].url, /timeframe=eq\.15m/);
    assert.match(requests[1].url, /on_conflict=symbol,timeframe,drawing_id/);
    assert.match(requests[2].url, /drawing_id=eq\.d1/);
    assert.match(requests[2].url, /symbol=eq\.BTCUSDT/);
    assert.equal(requests[1].options.headers.apikey, 'test-anon-key');
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('manual drawings honor explicitly enabled service-role storage without changing shared workbench credentials', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_CONFIRMED'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.SUPABASE_URL = 'https://supabase-test.invalid';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_SERVICE_ROLE_CONFIRMED = '1';
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, text: async () => options.method === 'POST' ? '[{"payload":{"drawing_id":"d1"}}]' : '[]' };
  };
  try {
    const { default: db } = await import(`../db.js?manual-liquidity-service-role-test=${Date.now()}-${Math.random()}`);
    await db.manualLiquidityDrawings.list({ symbol: 'BTCUSDT', timeframe: '15m' });
    await db.manualLiquidityDrawings.upsert({ drawing_id: 'd1', symbol: 'BTCUSDT', timeframe: '15m', drawing_type: 'line', payload: {}, created_at: 1, updated_at: 2 });
    await db.manualLiquidityDrawings.remove({ symbol: 'BTCUSDT', timeframe: '15m', drawingId: 'd1' });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.options.headers.apikey, 'test-service-role-key');
      assert.equal(request.options.headers.Authorization, 'Bearer test-service-role-key');
    }
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
