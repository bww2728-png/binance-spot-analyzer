create table if not exists public.liquidity_workbench_point_zone_links (
  point_id text not null references public.liquidity_workbench_points(point_id) on delete cascade,
  engine text not null,
  symbol text not null,
  timeframe text not null,
  zone_id text not null,
  relation_role text not null,
  zone_kind text not null,
  zone_state text,
  last_seen_at bigint not null,
  primary key (point_id, engine, symbol, timeframe, zone_id, relation_role)
);

create index if not exists idx_liquidity_workbench_point_links_zone
  on public.liquidity_workbench_point_zone_links (engine, symbol, timeframe, zone_id, last_seen_at desc);

create index if not exists idx_liquidity_workbench_point_links_point
  on public.liquidity_workbench_point_zone_links (point_id);

insert into public.liquidity_workbench_point_zone_links (
  point_id, engine, symbol, timeframe, zone_id, relation_role, zone_kind, zone_state, last_seen_at
)
select
  point_id, engine, symbol, timeframe, zone_id, role,
  coalesce(payload ->> 'zoneKind', 'unknown'), zone_state, last_reviewed_at
from public.liquidity_workbench_points
on conflict (point_id, engine, symbol, timeframe, zone_id, relation_role) do update
set zone_kind = excluded.zone_kind,
    zone_state = excluded.zone_state,
    last_seen_at = greatest(public.liquidity_workbench_point_zone_links.last_seen_at, excluded.last_seen_at);

alter table public.liquidity_workbench_point_zone_links enable row level security;
drop policy if exists "liquidity_workbench_point_zone_links_read" on public.liquidity_workbench_point_zone_links;
create policy "liquidity_workbench_point_zone_links_read"
  on public.liquidity_workbench_point_zone_links for select to anon using (true);

drop policy if exists "liquidity_workbench_candles_all" on public.liquidity_workbench_candles;
drop policy if exists "liquidity_workbench_scans_all" on public.liquidity_workbench_scans;
drop policy if exists "liquidity_workbench_events_all" on public.liquidity_workbench_events;
drop policy if exists "liquidity_workbench_samples_all" on public.liquidity_workbench_samples;
drop policy if exists "liquidity_workbench_points_all" on public.liquidity_workbench_points;
drop policy if exists "liquidity_workbench_candles_read" on public.liquidity_workbench_candles;
drop policy if exists "liquidity_workbench_scans_read" on public.liquidity_workbench_scans;
drop policy if exists "liquidity_workbench_events_read" on public.liquidity_workbench_events;
drop policy if exists "liquidity_workbench_samples_read" on public.liquidity_workbench_samples;
drop policy if exists "liquidity_workbench_points_read" on public.liquidity_workbench_points;

create policy "liquidity_workbench_candles_read" on public.liquidity_workbench_candles for select to anon using (true);
create policy "liquidity_workbench_scans_read" on public.liquidity_workbench_scans for select to anon using (true);
create policy "liquidity_workbench_events_read" on public.liquidity_workbench_events for select to anon using (true);
create policy "liquidity_workbench_samples_read" on public.liquidity_workbench_samples for select to anon using (true);
create policy "liquidity_workbench_points_read" on public.liquidity_workbench_points for select to anon using (true);

revoke all on public.liquidity_workbench_candles from anon;
revoke all on public.liquidity_workbench_scans from anon;
revoke all on public.liquidity_workbench_events from anon;
revoke all on public.liquidity_workbench_samples from anon;
revoke all on public.liquidity_workbench_points from anon;
revoke all on public.liquidity_workbench_point_zone_links from anon;

grant select on public.liquidity_workbench_candles to anon;
grant select on public.liquidity_workbench_scans to anon;
grant select on public.liquidity_workbench_events to anon;
grant select on public.liquidity_workbench_samples to anon;
grant select on public.liquidity_workbench_points to anon;
grant select on public.liquidity_workbench_point_zone_links to anon;

grant all on public.liquidity_workbench_candles to service_role;
grant all on public.liquidity_workbench_scans to service_role;
grant all on public.liquidity_workbench_events to service_role;
grant all on public.liquidity_workbench_samples to service_role;
grant all on public.liquidity_workbench_points to service_role;
grant all on public.liquidity_workbench_point_zone_links to service_role;
grant usage, select on sequence public.liquidity_workbench_events_id_seq to service_role;
revoke usage, select on sequence public.liquidity_workbench_events_id_seq from anon;
