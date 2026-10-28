-- =============================================================================
-- تدقيق قاعدة البيانات الحية — قراءة فقط (AUD-008)
--
-- ⚠️  SELECT-only. لا DDL، لا DML، لا كتابة، ولا أخذ أقفال حصرية.
--     آمن للتشغيل على قاعدة الإنتاج أثناء العمل.
--
-- كيف يُستخدم:
--   1. Supabase Dashboard → SQL Editor → New query
--   2. الصق الملف كاملاً → Run
--   3. انسخ الناتج (7 صفوف، كل صف JSON) وألصقه في المحادثة
--
-- الناتج لا يحتوي أي مفتاح أو سر: أسماء جداول وسياسات وأرقام فقط.
--
-- لماذا يلزم: لا يوجد migrations ledger في المستودع، وأرقام ملفات الترحيل متعارضة
-- (001 ×2، 002 ×2، 003 ×2)، فحالة القاعدة الحية لا تُستنتج من الكود. هذا السكربت
-- يجيب: ما الموجود؟ ما مُفعَّل عليه RLS؟ من يملك ماذا؟ أي ترحيل نُفِّذ فعلاً؟
-- =============================================================================

with
rl as (
  select
    exists (select 1 from pg_roles where rolname = 'anon')          as has_anon,
    exists (select 1 from pg_roles where rolname = 'authenticated') as has_auth,
    exists (select 1 from pg_roles where rolname = 'service_role')  as has_service
),
rel as (
  select c.oid, c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forced,
         c.reltuples::bigint as est_rows, pg_total_relation_size(c.oid) as bytes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
pol as (
  select tablename, policyname, cmd, roles::text as roles,
         (qual is not null) as using_expr, (with_check is not null) as check_expr,
         left(regexp_replace(coalesce(qual::text, ''), '\s+', ' ', 'g'), 50) as qual_preview
  from pg_policies
  where schemaname = 'public'
),
fn as (
  -- PUBLIC ليس دوراً حقيقياً، فلا يصلح مع has_function_privilege (يرمي role does not exist).
  -- الطريقة الصحيحة: فحص الـACL مباشرة — grantee = 0 يعني PUBLIC.
  select p.oid, p.proname::text as proname,
         exists (
           select 1
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ) as public_exec
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
dacl as (
  select defaclobjtype as objtype,
         pg_get_userbyid(defaclrole) as grantor,
         coalesce(array_to_string(defaclacl, ' | '), '') as acl
  from pg_default_acl
  where defaclnamespace = 'public'::regnamespace
),
expected as (
  -- الجداول التي يفترضها المستودع (server/migrations) — وجودها يثبت أن ترحيلها نُفِّذ
  select unnest(array[
    'analyses', 'events_log', 'settings', 'coin_flags', 'coin_shariah',
    'cases', 'case_images', 'barcode_scans', 'health_samples', 'symbols',
    'liquidity_workbench_candles', 'liquidity_workbench_points',
    'liquidity_workbench_point_zone_links'
  ]::text[]) as name
)
select 'meta' as section,
       jsonb_build_array(
         jsonb_build_object('item', 'pg_version',   'value', version()),
         jsonb_build_object('item', 'current_user', 'value', current_user),
         jsonb_build_object('item', 'db_size',      'value', pg_size_pretty(pg_database_size(current_database()))),
         jsonb_build_object('item', 'public_tables',    'value', (select count(*) from rel)),
         jsonb_build_object('item', 'public_policies',  'value', (select count(*) from pol)),
         jsonb_build_object('item', 'public_functions', 'value', (select count(*) from fn)),
         jsonb_build_object('item', 'roles_present', 'value', jsonb_build_object(
            'anon', (select has_anon from rl),
            'authenticated', (select has_auth from rl),
            'service_role', (select has_service from rl)))
       ) as payload

union all
select 'roles',
       coalesce(jsonb_agg(jsonb_build_object(
         'role', r.rolname, 'super', r.rolsuper, 'bypassrls', r.rolbypassrls, 'canlogin', r.rolcanlogin
       ) order by r.rolname), '[]'::jsonb)
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')

union all
select 'tables',
       coalesce(jsonb_agg(jsonb_build_object(
         'table', rel.relname,
         'rls', rel.rls, 'forced', rel.rls_forced,
         'policies', (select count(*) from pol where pol.tablename = rel.relname),
         'anon_select', case when (select has_anon from rl)
                        then has_table_privilege('anon', rel.oid, 'SELECT') else null end,
         'anon_insert', case when (select has_anon from rl)
                        then has_table_privilege('anon', rel.oid, 'INSERT') else null end,
         'anon_update', case when (select has_anon from rl)
                        then has_table_privilege('anon', rel.oid, 'UPDATE') else null end,
         'anon_delete', case when (select has_anon from rl)
                        then has_table_privilege('anon', rel.oid, 'DELETE') else null end,
         'authenticated_insert', case when (select has_auth from rl)
                        then has_table_privilege('authenticated', rel.oid, 'INSERT') else null end,
         'service_role_insert', case when (select has_service from rl)
                        then has_table_privilege('service_role', rel.oid, 'INSERT') else null end,
         'est_rows', rel.est_rows,
         'kb', (rel.bytes / 1024)
       ) order by rel.relname), '[]'::jsonb)
from rel

union all
select 'policies',
       coalesce(jsonb_agg(jsonb_build_object(
         'table', pol.tablename, 'policy', pol.policyname, 'cmd', pol.cmd, 'roles', pol.roles,
         'using', pol.using_expr, 'check', pol.check_expr, 'qual', pol.qual_preview
       ) order by pol.tablename, pol.policyname), '[]'::jsonb)
from pol

union all
select 'functions_executable_by_public',
       coalesce(jsonb_agg(jsonb_build_object(
         'fn', fn.proname,
         'public', fn.public_exec,
         'anon', case when (select has_anon from rl)
                 then has_function_privilege('anon', fn.oid, 'EXECUTE') else null end
       ) order by fn.proname), '[]'::jsonb)
from fn
where fn.public_exec

union all
select 'default_acl',
       coalesce(jsonb_agg(jsonb_build_object(
         'objtype', dacl.objtype, 'grantor', dacl.grantor, 'acl', dacl.acl
       ) order by dacl.objtype), '[]'::jsonb)
from dacl

union all
select 'fingerprint',
       coalesce(jsonb_agg(jsonb_build_object(
         'expected_table', e.name,
         'exists', to_regclass('public.' || quote_ident(e.name)) is not null,
         'analyses_id_identity', case when e.name = 'analyses' then (
             select case a.attidentity
                      when 'a' then 'always'
                      when 'd' then 'by_default'   -- 001_identity_by_default نُفِّذ
                      else a.attidentity::text end
             from pg_attribute a
             where a.attrelid = to_regclass('public.analyses') and a.attname = 'id'
           ) else null end
       ) order by e.name), '[]'::jsonb)
from expected e;
