-- =============================================================================
-- AUD-008 — المرحلة 1 (متطلب مسبق): منح service_role ما يحتاجه فعلاً
--
-- ⚠️  لم يُطبَّق. يُنفَّذ **قبل** ضبط `SUPABASE_SERVICE_ROLE_KEY` في البيئة.
--
-- لماذا يلزم ملف مستقل: المنح في هذا المشروع صريحة لا تلقائية. الدليل منقول من
-- `011_liquidity_workbench_grants.sql:1-2`:
--   «جداول المختبر أُنشئت عبر منفّذ ترحيلات لا يطبق الامتيازات الافتراضية، فالسياسات
--    وحدها لا تكفي: يلزم منح صريح لدور anon».
-- وكل منح service_role الموجود في المستودع محصور بجداول المختبر
-- (`007:84-88`، `008:31`، `012:68-74`). لا يوجد أي منح له على الجداول التسعة الأساسية.
--
-- الأثر لو نُفِّذت المرحلة 1 بلا هذا الملف: يعمل الخادم بمفتاح الخدمة بينما المنح غائبة
-- ⇒ كل `rest()` يُرجع 401/403 (المنح تُقيَّم قبل RLS، وتشمل service_role)، بينما
-- `storageConfigured()` يفحص وجود المفتاح فقط ⇒ `/readyz` أخضر مع انقطاع كامل.
-- هذا هو السبب الذي جعل تفعيل الهوية في الكود مشروطاً بإقرار
-- `SUPABASE_SERVICE_ROLE_CONFIRMED=1` (انظر `server/db.js`).
--
-- آمن وقابل للتراجع: إضافة منح لا تسحب شيئاً ولا تغيّر سلوك anon.
-- =============================================================================

begin;

grant usage on schema public to service_role;

-- الجداول الموجودة حالياً
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('grant all on public.%I to service_role', t.tablename);
  end loop;
  for t in select sequence_name from information_schema.sequences where sequence_schema = 'public' loop
    execute format('grant all on sequence public.%I to service_role', t.sequence_name);
  end loop;
end $$;

grant execute on all routines in schema public to service_role;

-- الجداول المستقبلية (يجب أن يكون المنفّذ هو postgres كما في 014)
alter default privileges for role postgres in schema public grant all on tables    to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;

commit;

-- =============================================================================
-- التحقق قبل ضبط المفتاح (يجب أن يعطي صفر صفوف):
--
--   select tablename from pg_tables t
--   where schemaname = 'public'
--     and not has_table_privilege('service_role', quote_ident(tablename), 'insert');
--   -- النتيجة المتوقعة: 0 صفوف
--
-- ثم اضبط في البيئة: SUPABASE_SERVICE_ROLE_KEY و SUPABASE_SERVICE_ROLE_CONFIRMED=1
-- وأعد النشر، وتحقّق من /readyz → checks.storage.serviceRole = true
-- =============================================================================
