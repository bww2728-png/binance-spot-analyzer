-- توحيد صلاحيات جداول مختبر السيولة مع عرف المشروع: الخادم يكتب بمفتاح anon
-- (نفس نمط analyses/cases/barcode_scans) مع بقاء RLS مفعلًا.
drop policy if exists "liquidity_workbench_candles_read" on public.liquidity_workbench_candles;
drop policy if exists "liquidity_workbench_scans_read" on public.liquidity_workbench_scans;
drop policy if exists "liquidity_workbench_events_read" on public.liquidity_workbench_events;
drop policy if exists "liquidity_workbench_samples_read" on public.liquidity_workbench_samples;
drop policy if exists "liquidity_workbench_points_read" on public.liquidity_workbench_points;

create policy "liquidity_workbench_candles_all" on public.liquidity_workbench_candles for all to anon using (true) with check (true);
create policy "liquidity_workbench_scans_all" on public.liquidity_workbench_scans for all to anon using (true) with check (true);
create policy "liquidity_workbench_events_all" on public.liquidity_workbench_events for all to anon using (true) with check (true);
create policy "liquidity_workbench_samples_all" on public.liquidity_workbench_samples for all to anon using (true) with check (true);
create policy "liquidity_workbench_points_all" on public.liquidity_workbench_points for all to anon using (true) with check (true);
