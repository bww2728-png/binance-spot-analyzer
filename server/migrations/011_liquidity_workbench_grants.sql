-- جداول المختبر أُنشئت عبر منفّذ ترحيلات لا يطبق الامتيازات الافتراضية،
-- فالسياسات وحدها لا تكفي: يلزم منح صريح لدور anon (نفس نمط جدول cases).
grant select, insert, update, delete on public.liquidity_workbench_candles to anon;
grant select, insert, update, delete on public.liquidity_workbench_scans to anon;
grant select, insert, update, delete on public.liquidity_workbench_events to anon;
grant select, insert, update, delete on public.liquidity_workbench_samples to anon;
grant select, insert, update, delete on public.liquidity_workbench_points to anon;
