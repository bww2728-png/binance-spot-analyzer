-- إعادة اصطفاف صلاحيات جداول مختبر السيولة مع اصطلاح المشروع الثابت: الكتابة الآلية بمفتاح النشر العام عبر RLS
-- (012 حصر الكتابة بـservice_role، لكن منصة الاستضافة المُدارة لا تتيح هذا المفتاح للمستخدم؛
--  الجداول الست بيانات سوق آلية بلا بيانات مستخدمين، والقراءة العامة تبقى كما هي)

grant insert, update, delete on public.liquidity_workbench_candles to anon;
grant insert, update, delete on public.liquidity_workbench_scans to anon;
grant insert, update, delete on public.liquidity_workbench_events to anon;
grant insert, update, delete on public.liquidity_workbench_samples to anon;
grant insert, update, delete on public.liquidity_workbench_points to anon;
grant insert, update, delete on public.liquidity_workbench_point_zone_links to anon;

drop policy if exists "liquidity_workbench_anon_insert" on public.liquidity_workbench_candles;
create policy "liquidity_workbench_anon_insert" on public.liquidity_workbench_candles for insert to anon with check (true);
drop policy if exists "liquidity_workbench_anon_update" on public.liquidity_workbench_candles;
create policy "liquidity_workbench_anon_update" on public.liquidity_workbench_candles for update to anon using (true) with check (true);
drop policy if exists "liquidity_workbench_anon_delete" on public.liquidity_workbench_candles;
create policy "liquidity_workbench_anon_delete" on public.liquidity_workbench_candles for delete to anon using (true);

drop policy if exists "liquidity_workbench_anon_insert" on public.liquidity_workbench_scans;
create policy "liquidity_workbench_anon_insert" on public.liquidity_workbench_scans for insert to anon with check (true);
drop policy if exists "liquidity_workbench_anon_update" on public.liquidity_workbench_scans;
create policy "liquidity_workbench_anon_update" on public.liquidity_workbench_scans for update to anon using (true) with check (true);
drop policy if exists "liquidity_workbench_anon_delete" on public.liquidity_workbench_scans;
create policy "liquidity_workbench_anon_delete" on public.liquidity_workbench_scans for delete to anon using (true);

drop policy if exists "liquidity_workbench_anon_insert" on public.liquidity_workbench_events;
create policy "liquidity_workbench_anon_insert" on public.liquidity_workbench_events for insert to anon with check (true);
drop policy if exists "liquidity_workbench_anon_update" on public.liquidity_workbench_events;
create policy "liquidity_workbench_anon_update" on public.liquidity_workbench_events for update to anon using (true) with check (true);
drop policy if exists "liquidity_workbench_anon_delete" on public.liquidity_workbench_events;
create policy "liquidity_workbench_anon_delete" on public.liquidity_workbench_events for delete to anon using (true);

drop policy if exists "liquidity_workbench_anon_insert" on public.liquidity_workbench_samples;
create policy "liquidity_workbench_anon_insert" on public.liquidity_workbench_samples for insert to anon with check (true);
drop policy if exists "liquidity_workbench_anon_update" on public.liquidity_workbench_samples;
create policy "liquidity_workbench_anon_update" on public.liquidity_workbench_samples for update to anon using (true) with check (true);
drop policy if exists "liquidity_workbench_anon_delete" on public.liquidity_workbench_samples;
create policy "liquidity_workbench_anon_delete" on public.liquidity_workbench_samples for delete to anon using (true);

drop policy if exists "liquidity_workbench_anon_insert" on public.liquidity_workbench_points;
create policy "liquidity_workbench_anon_insert" on public.liquidity_workbench_points for insert to anon with check (true);
drop policy if exists "liquidity_workbench_anon_update" on public.liquidity_workbench_points;
create policy "liquidity_workbench_anon_update" on public.liquidity_workbench_points for update to anon using (true) with check (true);
drop policy if exists "liquidity_workbench_anon_delete" on public.liquidity_workbench_points;
create policy "liquidity_workbench_anon_delete" on public.liquidity_workbench_points for delete to anon using (true);

drop policy if exists "liquidity_workbench_anon_insert" on public.liquidity_workbench_point_zone_links;
create policy "liquidity_workbench_anon_insert" on public.liquidity_workbench_point_zone_links for insert to anon with check (true);
drop policy if exists "liquidity_workbench_anon_update" on public.liquidity_workbench_point_zone_links;
create policy "liquidity_workbench_anon_update" on public.liquidity_workbench_point_zone_links for update to anon using (true) with check (true);
drop policy if exists "liquidity_workbench_anon_delete" on public.liquidity_workbench_point_zone_links;
create policy "liquidity_workbench_anon_delete" on public.liquidity_workbench_point_zone_links for delete to anon using (true);

grant usage, select on sequence public.liquidity_workbench_events_id_seq to anon;
