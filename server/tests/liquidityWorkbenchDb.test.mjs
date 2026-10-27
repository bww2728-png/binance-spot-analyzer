import assert from 'node:assert/strict';
import { test } from 'node:test';

test('liquidity workbench writes with the public key per the project anon-write convention', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.SUPABASE_URL = 'https://supabase-test.invalid';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, text: async () => '[]' };
  };

  try {
    const { default: db } = await import(`../db.js?liquidity-workbench-anon-fallback-test=${Date.now()}`);
    await db.liquidityWorkbench.listCandles('BTCUSDT', '1h');
    await db.liquidityWorkbench.upsertCandles([]);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.headers.apikey, 'test-anon-key');
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.headers.apikey, 'test-anon-key');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer test-anon-key');
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('liquidity workbench routes all operations through the public key regardless of service key presence', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.SUPABASE_URL = 'https://supabase-test.invalid';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, text: async () => '[]' };
  };

  try {
    const { default: db } = await import(`../db.js?liquidity-workbench-key-routing-test=${Date.now()}`);
    await db.liquidityWorkbench.listCandles('BTCUSDT', '1h');
    await db.liquidityWorkbench.upsertCandles([]);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.headers.apikey, 'test-anon-key');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-anon-key');
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.headers.apikey, 'test-anon-key');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer test-anon-key');
    requests.length = 0;
    await db.liquidityWorkbench.upsertPoints([{
      point_id: 'a'.repeat(64), engine: 'liquidity-engine-v2', symbol: 'BTCUSDT', timeframe: '1h',
      zone_id: 'first-zone', point_type: 'structure_BOS_up', role: 'confirmation_or_structure',
      point_time: 1_700_000_000_000, candle_index: 1, price: 100, price_low: null, price_high: null,
      zone_state: 'confirmed', confirmed_at: null, last_reviewed_at: 1_700_000_000_001,
      rules_version: 'liquidity-engine-v2', payload: {},
      zone_links: [{ point_id: 'a'.repeat(64), engine: 'liquidity-engine-v2', symbol: 'BTCUSDT', timeframe: '1h', zone_id: 'second-zone', relation_role: 'confirmation_or_structure', zone_kind: 'demand', zone_state: 'confirmed', last_seen_at: 1_700_000_000_001 }]
    }]);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /liquidity_workbench_points/);
    assert.equal(Object.hasOwn(JSON.parse(requests[0].options.body)[0], 'zone_links'), false);
    assert.match(requests[1].url, /liquidity_workbench_point_zone_links/);
    assert.equal(JSON.parse(requests[1].options.body)[0].zone_id, 'second-zone');
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
