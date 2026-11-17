import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STORAGE_GROUPS,
  STORAGE_METHODS,
  assertStorageContract,
  StorageContractError
} from '../storage/contract/storage-contract.mjs';
import { createStorage } from '../storage/index.mjs';
import supabaseRestAdapter from '../storage/adapters/supabase-rest.mjs';
import legacyDb from '../db.js';

test('Supabase REST adapter implements every operation used by current consumers', () => {
  assert.doesNotThrow(() => assertStorageContract(supabaseRestAdapter));
  for (const group of STORAGE_GROUPS) {
    assert.ok(supabaseRestAdapter[group], `missing group ${group}`);
    for (const method of STORAGE_METHODS[group]) {
      assert.equal(typeof supabaseRestAdapter[group][method], 'function', `${group}.${method}`);
    }
  }
});

test('storage selection is explicit and unsupported providers fail closed', () => {
  assert.equal(createStorage({ provider: 'supabase-rest' }), supabaseRestAdapter);
  assert.throws(() => createStorage({ provider: 'automatic-fallback' }), /غير مدعوم/);
});

test('incomplete adapters fail with the exact missing methods', () => {
  assert.throws(() => assertStorageContract({}), (error) => {
    assert.ok(error instanceof StorageContractError);
    assert.match(error.message, /analyses/);
    return true;
  });
  const incomplete = {
    ...supabaseRestAdapter,
    events: { ...supabaseRestAdapter.events, liveLifecyclePage: undefined }
  };
  assert.throws(() => assertStorageContract(incomplete), /events\.liveLifecyclePage/);
});

test('legacy db entry point exposes storage methods and Binance compatibility separately', async () => {
  const { binanceRest } = await import('../services/binanceRest.mjs');
  assert.equal(legacyDb.binance, binanceRest);
  assert.equal(legacyDb.analyses, supabaseRestAdapter.analyses);
  assert.equal(legacyDb.events, supabaseRestAdapter.events);
  assert.equal(Object.hasOwn(supabaseRestAdapter, 'binance'), false);
});
