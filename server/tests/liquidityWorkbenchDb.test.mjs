import assert from 'node:assert/strict';
import { test } from 'node:test';

test('liquidity workbench writes fall back to the publishable key when no service-role key is configured', async () => {
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
    assert.equal(requests[0].options.headers.apikey, 'test-anon-key');
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

test('liquidity workbench reads with the public key and writes only with the service-role key', async () => {
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
    assert.equal(requests[1].options.headers.apikey, 'test-service-role-key');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer test-service-role-key');
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
