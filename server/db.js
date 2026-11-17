/**
 * واجهة توافق تاريخية لمحركات النظام.
 *
 * التنفيذ الفعلي انتقل إلى:
 *   Domain Logic → Storage Contract → SupabaseRestAdapter → Supabase/PostgREST
 *
 * `db.binance` يبقى مؤقتاً حتى تُنقل مستدعواته تدريجياً، لكن تنفيذه في خدمة مستقلة
 * وليس في موصل التخزين.
 */
export {
  setRateLimiter,
  getRateLimiter,
  storageConfigured,
  publicKeyConfigured,
  isUsingServiceRole,
  getPublicSupabaseConfig,
  selectStorageKey,
  selectPublicKey,
  SERVICE_ROLE_OPT_IN_ENV
} from './storage/adapters/supabase-rest.mjs';
export { default } from './storage/index.mjs';
