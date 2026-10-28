-- =============================================================================
-- AUD-008 — المرحلة 2: تضييق صلاحيات دور anon على المخطط العام
--
-- ⚠️  لم يُطبَّق. هذا ملف جاهز للتشغيل اليدوي بعد المرحلة 1.
--
-- المتطلبات السابقة (إلزامية — بدونها يتوقف النظام):
--   1) `013b_grant_service_role.sql` نُفِّذ (منح service_role على الجداول التسعة).
--   2) `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_SERVICE_ROLE_CONFIRMED=1` مضبوطان.
--   3) `/readyz` = 200 و`checks.storage.serviceRole` = true.
--   السبب: بعد هذا الترحيل يفقد `anon` صلاحيات الكتابة، فلو كان الخادم ما زال يستخدم
--   المفتاح العام لفشل كل حفظ وكل استعادة.
--
-- الاستثناء المقصود: جداول مختبر السيولة تبقى على `anon`.
--   `server/db.js` (restWorkbench) يكتبها بالمفتاح العام **بالعقد** الموثّق في
--   `010_liquidity_workbench_anon_write.sql` و`013_..._anon_write_convention.sql`،
--   ويوجد اختبار يفرض ذلك (tests/liquidityWorkbenchDb.test.mjs). سحبها هنا يُوقف
--   المختبر بصمت مع بقاء /readyz أخضر — لذلك تُستثنى صراحةً.
--
-- التراجع: 014a_rollback_anon_privileges.sql
-- =============================================================================

begin;

-- قفل قصير: الإسقاط يأخذ ACCESS EXCLUSIVE على كل جدول. نفّذه في نافذة هدوء.
set local lock_timeout = '5s';

-- 0) حاجز: لا تُسحب صلاحيات anon إن كان service_role نفسه بلا منح — وإلا انقطعت
--    القراءة والكتابة كلياً بعد commit بلا إمكانية إصلاح تلقائي.
do $$
begin
  if not has_table_privilege('service_role', 'public.events_log', 'insert')
     or not has_table_privilege('service_role', 'public.symbols', 'insert') then
    raise exception 'service_role بلا منح كافية — نفّذ 013b_grant_service_role.sql أولاً';
  end if;
end $$;

-- 1) إسقاط كل السياسات في المخطط العام **عدا جداول المختبر**.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename not like 'liquidity_workbench%'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- 2) سحب الامتيازات عن anon من الجداول والتسلسلات **عدا جداول المختبر**.
do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'liquidity_workbench%'
  loop
    execute format('revoke all on public.%I from anon', t.tablename);
  end loop;
  for t in
    select sequence_name from information_schema.sequences where sequence_schema = 'public'
  loop
    execute format('revoke all on sequence public.%I from anon', t.sequence_name);
  end loop;
end $$;

-- 3) الدوال: صلاحية EXECUTE تُمنح لـPUBLIC افتراضياً، فسحبها من anon وحده لا يغلق شيئاً.
revoke execute on all routines in schema public from public;
revoke execute on all routines in schema public from anon;

-- 4) منع الامتيازات الافتراضية مستقبلاً — `for role postgres` صريح لأن الشكل المجرّد
--    يستهدف دور المنفّذ فقط، وقد يكون غير الدور الذي يُنشئ الجداول.
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- 5) تفعيل RLS يبقى كما هو (مفعّل أصلاً في 000_full_schema.sql). مع صفر سياسات
--    وRLS مفعّل، النتيجة هي **المنع الافتراضي** لدور anon (PostgreSQL 18 §5.9).
--    service_role يتجاوز RLS بحكم صلاحياته فلا يحتاج سياسات.

commit;

-- =============================================================================
-- التحقق بعد التنفيذ — كل الأسطر التالية إلزامية:
--
--   -- 1) لا سياسات على الجداول غير المختبرية
--   select count(*) from pg_policies where schemaname='public'
--     and tablename not like 'liquidity_workbench%';                          -- 0
--
--   -- 2) anon ممنوع على الجداول الأساسية
--   select has_table_privilege('anon','public.events_log','insert');           -- false
--   select has_table_privilege('anon','public.events_log','select');           -- false
--
--   -- 3) service_role ممنوح (وإلا فشل كل شيء)
--   select has_table_privilege('service_role','public.events_log','insert');   -- true
--
--   -- 4) المختبر ما زال يعمل بـanon (استثناء مقصود)
--   select has_table_privilege('anon','public.liquidity_workbench_candles','select'); -- true
--
-- ثم اختبار حي على الخادم:
--   POST /api/symbols/sync                        ⇒ 200
--   GET  /readyz                                  ⇒ 200 (ready أو degraded)
--   GET  /api/liquidity-workbench/...             ⇒ 200 وليس 401/403
--   و`/api/health/deep` → liquidityWorkbench.persistenceMode = 'supabase' (لا 'unavailable')
--
-- ثم اختبار سلبي بمفتاح anon مباشرة على PostgREST:
--   GET /rest/v1/events_log?select=id&limit=1     ⇒ [] فارغة أو 401/403
-- =============================================================================
