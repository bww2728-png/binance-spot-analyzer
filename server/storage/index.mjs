import { binanceRest } from '../services/binanceRest.mjs';
import { assertStorageContract } from './contract/storage-contract.mjs';
import supabaseRestAdapter, { supabaseRestAdapter as namedSupabaseRestAdapter } from './adapters/supabase-rest.mjs';

export const DATABASE_PROVIDERS = Object.freeze({
  SUPABASE_REST: 'supabase-rest',
  POSTGRES: 'postgres'
});

export function selectedDatabaseProvider(env = process.env) {
  return String(env.DATABASE_PROVIDER || DATABASE_PROVIDERS.SUPABASE_REST).trim();
}

export function createStorage({ provider = selectedDatabaseProvider(), adapters = {} } = {}) {
  const byProvider = {
    [DATABASE_PROVIDERS.SUPABASE_REST]: adapters.supabaseRest ?? supabaseRestAdapter
  };
  const adapter = byProvider[provider];
  if (!adapter) throw new Error(`DATABASE_PROVIDER غير مدعوم: ${provider}`);
  return assertStorageContract(adapter);
}

const storage = createStorage();

/** Entry point التوافق: المحركات الحالية تستورد db.js، بينما التخزين أصبح عقداً مستقلاً. */
const legacyDb = {
  ...storage,
  binance: binanceRest
};

export { storage, supabaseRestAdapter, namedSupabaseRestAdapter };
export default legacyDb;
