import assert from 'node:assert/strict';
import { test } from 'node:test';

const envNames = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];

function saveEnvironment() {
  return new Map(envNames.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(previous) {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('missing Supabase URL fails clearly before making a relative fetch', async () => {
  const previous = saveEnvironment();
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.SUPABASE_URL = '';
  delete process.env.VITE_SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch should not be called'); };
  try {
    const { default: db, storageConfigured } = await import(`../db.js?missing-supabase-url=${Date.now()}-${Math.random()}`);
    assert.equal(storageConfigured(), false);
    await assert.rejects(
      db.manualLiquidityDrawings.list({ symbol: 'BTCUSDT', timeframe: '15m' }),
      /عنوان Supabase غير مُهيّأ أو غير صالح/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});

test('public Supabase config exposes only the URL and anon key and rejects missing anon configuration', async () => {
  const previous = saveEnvironment();
  try {
    process.env.SUPABASE_URL = 'https://supabase-test.invalid/';
    process.env.SUPABASE_ANON_KEY = 'public-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'must-never-be-returned';
    const { getPublicSupabaseConfig } = await import(`../db.js?public-supabase-config=${Date.now()}-${Math.random()}`);
    assert.deepEqual(getPublicSupabaseConfig(), { url: 'https://supabase-test.invalid', anonKey: 'public-anon-key' });
    delete process.env.SUPABASE_ANON_KEY;
    assert.throws(() => getPublicSupabaseConfig(), /مفتاح Supabase العام غير مُهيّأ/);
  } finally {
    restoreEnvironment(previous);
  }
});

test('server REST calls accept injected VITE Supabase URL and remove trailing slashes', async () => {
  const previous = saveEnvironment();
  const previousFetch = globalThis.fetch;
  const requestedUrls = [];
  process.env.SUPABASE_URL = '';
  process.env.VITE_SUPABASE_URL = 'https://supabase-test.invalid/project/';
  process.env.SUPABASE_ANON_KEY = '';
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return { ok: true, text: async () => '[]' };
  };
  try {
    const { default: db, storageConfigured } = await import(`../db.js?vite-supabase-url=${Date.now()}-${Math.random()}`);
    assert.equal(storageConfigured(), true);
    await db.manualLiquidityDrawings.list({ symbol: 'BTCUSDT', timeframe: '15m' });
    assert.equal(
      requestedUrls[0],
      'https://supabase-test.invalid/project/rest/v1/liquidity_manual_drawings?symbol=eq.BTCUSDT&timeframe=eq.15m&select=*&order=updated_at.asc%2Cdrawing_id.asc&limit=5000'
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previous);
  }
});
