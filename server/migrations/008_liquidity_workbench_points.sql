create table if not exists public.liquidity_workbench_points (
  point_id text primary key,
  engine text not null,
  symbol text not null,
  timeframe text not null,
  zone_id text not null,
  point_type text not null,
  role text not null,
  point_time bigint not null,
  candle_index integer,
  price numeric,
  price_low numeric,
  price_high numeric,
  zone_state text,
  confirmed_at bigint,
  last_reviewed_at bigint not null,
  rules_version text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_liquidity_workbench_points_zone
  on public.liquidity_workbench_points (engine, symbol, timeframe, zone_id, point_time);

create index if not exists idx_liquidity_workbench_points_lookup
  on public.liquidity_workbench_points (symbol, timeframe, point_time desc);

alter table public.liquidity_workbench_points enable row level security;
drop policy if exists "liquidity_workbench_points_read" on public.liquidity_workbench_points;
create policy "liquidity_workbench_points_read" on public.liquidity_workbench_points for select to anon using (true);
grant select on public.liquidity_workbench_points to anon;
grant all on public.liquidity_workbench_points to service_role;
