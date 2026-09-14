create table if not exists analyses (
  id serial primary key,
  symbol text not null unique,
  trend_lower text,
  tf_lower text,
  trend_upper text,
  tf_upper text,
  ext_bsl_sweep boolean,
  ext_supply_touch boolean,
  int_bsl_sweep boolean,
  sellers_induced boolean,
  int_ssl_sweep boolean,
  ssl_price numeric,
  bsl_price numeric,
  bsl_touched boolean,
  ssl_touched boolean,
  passed_bsl_after_ssl boolean,
  choch_up text,
  notes text default '',
  notify_enabled boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists coin_flags (
  symbol text primary key,
  halal boolean not null default true,
  barcode boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  quote text not null default 'USDT',
  notify_timeout_min int not null default 30,
  sound_enabled boolean not null default true,
  sort_config text not null default '{}'
);

create table if not exists events_log (
  id serial primary key,
  ts timestamptz not null default now(),
  symbol text not null,
  type text not null,
  message text not null,
  meta text
);
create index if not exists idx_events_ts on events_log(ts);
create index if not exists idx_events_symbol on events_log(symbol);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_analyses_updated on analyses;
create trigger trg_analyses_updated before update on analyses
  for each row execute function set_updated_at();

drop trigger if exists trg_coin_flags_updated on coin_flags;
create trigger trg_coin_flags_updated before update on coin_flags
  for each row execute function set_updated_at();

alter table analyses enable row level security;
alter table coin_flags enable row level security;
alter table settings enable row level security;
alter table events_log enable row level security;

drop policy if exists "anon all analyses" on analyses;
create policy "anon all analyses" on analyses for all to anon using (true) with check (true);
drop policy if exists "anon all coin_flags" on coin_flags;
create policy "anon all coin_flags" on coin_flags for all to anon using (true) with check (true);
drop policy if exists "anon all settings" on settings;
create policy "anon all settings" on settings for all to anon using (true) with check (true);
drop policy if exists "anon all events_log" on events_log;
create policy "anon all events_log" on events_log for all to anon using (true) with check (true);

grant usage on schema public to anon;
grant all on analyses to anon;
grant all on coin_flags to anon;
grant all on settings to anon;
grant all on events_log to anon;
grant usage, select on all sequences in schema public to anon;