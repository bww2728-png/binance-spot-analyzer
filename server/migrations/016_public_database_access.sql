set local lock_timeout = '5s';

grant usage on schema public to anon;

alter table public.analyses enable row level security;
revoke all on table public.analyses from anon;
grant select, insert, update, delete on table public.analyses to anon;
drop policy if exists public_anon_full_access on public.analyses;
create policy public_anon_full_access on public.analyses for all to anon using (true) with check (true);

alter table public.barcode_scans enable row level security;
revoke all on table public.barcode_scans from anon;
grant select, insert, update, delete on table public.barcode_scans to anon;
drop policy if exists public_anon_full_access on public.barcode_scans;
create policy public_anon_full_access on public.barcode_scans for all to anon using (true) with check (true);

alter table public.case_images enable row level security;
revoke all on table public.case_images from anon;
grant select, insert, update, delete on table public.case_images to anon;
drop policy if exists public_anon_full_access on public.case_images;
create policy public_anon_full_access on public.case_images for all to anon using (true) with check (true);

alter table public.cases enable row level security;
revoke all on table public.cases from anon;
grant select, insert, update, delete on table public.cases to anon;
drop policy if exists public_anon_full_access on public.cases;
create policy public_anon_full_access on public.cases for all to anon using (true) with check (true);

alter table public.coin_flags enable row level security;
revoke all on table public.coin_flags from anon;
grant select, insert, update, delete on table public.coin_flags to anon;
drop policy if exists public_anon_full_access on public.coin_flags;
create policy public_anon_full_access on public.coin_flags for all to anon using (true) with check (true);

alter table public.coin_shariah enable row level security;
revoke all on table public.coin_shariah from anon;
grant select, insert, update, delete on table public.coin_shariah to anon;
drop policy if exists public_anon_full_access on public.coin_shariah;
create policy public_anon_full_access on public.coin_shariah for all to anon using (true) with check (true);

alter table public.events_log enable row level security;
revoke all on table public.events_log from anon;
grant select, insert, update, delete on table public.events_log to anon;
drop policy if exists public_anon_full_access on public.events_log;
create policy public_anon_full_access on public.events_log for all to anon using (true) with check (true);

alter table public.health_samples enable row level security;
revoke all on table public.health_samples from anon;
grant select, insert, update, delete on table public.health_samples to anon;
drop policy if exists public_anon_full_access on public.health_samples;
create policy public_anon_full_access on public.health_samples for all to anon using (true) with check (true);

alter table public.liquidity_manual_drawings enable row level security;
revoke all on table public.liquidity_manual_drawings from anon;
grant select, insert, update, delete on table public.liquidity_manual_drawings to anon;
drop policy if exists public_anon_full_access on public.liquidity_manual_drawings;
create policy public_anon_full_access on public.liquidity_manual_drawings for all to anon using (true) with check (true);

alter table public.liquidity_workbench_candles enable row level security;
revoke all on table public.liquidity_workbench_candles from anon;
grant select, insert, update, delete on table public.liquidity_workbench_candles to anon;
drop policy if exists public_anon_full_access on public.liquidity_workbench_candles;
create policy public_anon_full_access on public.liquidity_workbench_candles for all to anon using (true) with check (true);

alter table public.liquidity_workbench_events enable row level security;
revoke all on table public.liquidity_workbench_events from anon;
grant select, insert, update, delete on table public.liquidity_workbench_events to anon;
drop policy if exists public_anon_full_access on public.liquidity_workbench_events;
create policy public_anon_full_access on public.liquidity_workbench_events for all to anon using (true) with check (true);

alter table public.liquidity_workbench_point_zone_links enable row level security;
revoke all on table public.liquidity_workbench_point_zone_links from anon;
grant select, insert, update, delete on table public.liquidity_workbench_point_zone_links to anon;
drop policy if exists public_anon_full_access on public.liquidity_workbench_point_zone_links;
create policy public_anon_full_access on public.liquidity_workbench_point_zone_links for all to anon using (true) with check (true);

alter table public.liquidity_workbench_points enable row level security;
revoke all on table public.liquidity_workbench_points from anon;
grant select, insert, update, delete on table public.liquidity_workbench_points to anon;
drop policy if exists public_anon_full_access on public.liquidity_workbench_points;
create policy public_anon_full_access on public.liquidity_workbench_points for all to anon using (true) with check (true);

alter table public.liquidity_workbench_samples enable row level security;
revoke all on table public.liquidity_workbench_samples from anon;
grant select, insert, update, delete on table public.liquidity_workbench_samples to anon;
drop policy if exists public_anon_full_access on public.liquidity_workbench_samples;
create policy public_anon_full_access on public.liquidity_workbench_samples for all to anon using (true) with check (true);

alter table public.liquidity_workbench_scans enable row level security;
revoke all on table public.liquidity_workbench_scans from anon;
grant select, insert, update, delete on table public.liquidity_workbench_scans to anon;
drop policy if exists public_anon_full_access on public.liquidity_workbench_scans;
create policy public_anon_full_access on public.liquidity_workbench_scans for all to anon using (true) with check (true);

alter table public.settings enable row level security;
revoke all on table public.settings from anon;
grant select, insert, update, delete on table public.settings to anon;
drop policy if exists public_anon_full_access on public.settings;
create policy public_anon_full_access on public.settings for all to anon using (true) with check (true);

alter table public.symbols enable row level security;
revoke all on table public.symbols from anon;
grant select, insert, update, delete on table public.symbols to anon;
drop policy if exists public_anon_full_access on public.symbols;
create policy public_anon_full_access on public.symbols for all to anon using (true) with check (true);

grant select, insert, update, delete on all tables in schema public to anon;
grant usage, select on all sequences in schema public to anon;

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon;

alter table public.liquidity_manual_drawings
  drop constraint if exists liquidity_manual_drawings_payload_valid;
alter table public.liquidity_manual_drawings
  add constraint liquidity_manual_drawings_payload_valid check (
    drawing_id ~ '^[A-Za-z0-9_-]{1,80}$'
    and jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 16384
    and payload->>'id' = drawing_id
    and payload->>'type' = drawing_type
    and case
      when jsonb_typeof(payload->'anchors') = 'array' then
        jsonb_array_length(payload->'anchors') between
          case when drawing_type in ('line', 'break', 'rectangle') then 2 else 1 end
          and 8
        and not jsonb_path_exists(
          payload,
          '$.anchors[*] ? (@.time.type() != "number" || @.price.type() != "number" || @.time <= 0 || @.time % 1 != 0 || @.time > 9007199254740991 || @.price <= 0 || @.price > 1000000000000)'
        )
      else false
    end
    and (drawing_type <> 'arrow' or payload->>'liquidityType' in ('BSL', 'SSL'))
    and (drawing_type <> 'break' or payload->>'breakType' in ('wick', 'close'))
    and (drawing_type <> 'text' or coalesce(nullif(payload->>'label', ''), nullif(payload->>'note', '')) is not null)
    and length(coalesce(payload->>'label', '')) <= 240
    and length(coalesce(payload->>'note', '')) <= 2000
    and coalesce(payload->>'color', '') ~ '^#[0-9A-Fa-f]{6}$'
  );
