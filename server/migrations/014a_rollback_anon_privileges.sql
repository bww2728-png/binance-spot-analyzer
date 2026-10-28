-- =============================================================================
-- AUD-008 — تراجع ترحيل تضييق anon (014_restrict_anon_privileges.sql)
--
-- استخدمه فقط إذا فشل التحقق بعد الترحيل (مسار قراءة/كتابة توقّف).
--
-- ⚠️  حدّان صريحان:
--   1) هذا يعيد **الامتيازات** لا **السياسات** التي أسقطها 014.
--   2) قائمة إعادة إنشاء السياسات الكاملة (بالترتيب) هي:
--        000_full_schema.sql              ← السياسات الأساسية
--        002_health_samples.sql           ← health_samples_all
--        007/008/010/011/012/013_*        ← سياسات ومنح مختبر السيولة
--      (`012_liquidity_workbench_point_links_service_write.sql` يُنشئ
--       liquidity_workbench_point_zone_links_read — كان يسقط من قائمة قديمة.)
--
-- ملاحظة: إعادة المنح لـanon تُعيد الثقب الأمني كما كان بالضبط — أي أن التراجع يعيد
-- الوضع المعروف غير الآمن، وهو أفضل من خدمة متوقفة عند الحاجة.
-- =============================================================================

begin;

set local lock_timeout = '5s';

do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('grant all on public.%I to anon', t.tablename);
  end loop;
  for t in select sequence_name from information_schema.sequences where sequence_schema = 'public' loop
    execute format('grant all on sequence public.%I to anon', t.sequence_name);
  end loop;
end $$;

-- ملاحظة: EXECUTE على الدوال لا يُعاد منحه لـPUBLIC عمداً — إن احتاجه مسار فعلي
-- فأعد منحه صراحةً لذلك الدور فقط (grant execute on function ... to anon).

alter default privileges for role postgres in schema public grant all on tables    to anon;
alter default privileges for role postgres in schema public grant all on sequences to anon;

commit;

-- التحقق: يجب أن يعود true
--   select has_table_privilege('anon', 'public.events_log', 'insert');
-- وتذكير: السياسات ما زالت مسقطة حتى تُعيد تنفيذ ملفات الترحيل أعلاه.
