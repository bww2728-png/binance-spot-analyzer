-- مخطط كامل موحّد (أعمدة الزمن bigint epoch-ms كما يكتبها الخادم) — idempotent

create table if not exists public.analyses (
  id bigint generated always as identity primary key,
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
  bsl_touched boolean default false not null,
  ssl_touched boolean default false not null,
  passed_bsl_after_ssl boolean default false not null,
  choch_up text,
  notes text default '' not null,
  notify_enabled boolean default true not null,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.coin_flags (
  symbol text primary key,
  halal boolean not null default true,
  barcode boolean not null default false,
  updated_at bigint not null default 0
);

create table if not exists public.settings (
  id integer primary key check (id = 1),
  quote text not null default 'USDT',
  notify_timeout_min integer not null default 30,
  sound_enabled boolean not null default true,
  sort_config text not null default '{}'
);

create table if not exists public.events_log (
  id bigint generated always as identity primary key,
  ts bigint not null,
  symbol text not null,
  type text not null,
  message text not null,
  meta text
);
create index if not exists idx_events_ts on public.events_log (ts);
create index if not exists idx_events_symbol on public.events_log (symbol);
create index if not exists idx_events_type_ts on public.events_log (type, ts desc);

create table if not exists public.symbols (
  symbol text primary key,
  base text not null,
  quote text not null,
  tick_size double precision not null default 0.01,
  status text not null default 'TRADING',
  updated_at bigint not null
);
create index if not exists idx_symbols_base on public.symbols (base);
create index if not exists idx_symbols_quote on public.symbols (quote);

create table if not exists public.coin_shariah (
  symbol text primary key,
  verdict text not null default 'uncertain' check (verdict in ('halal', 'haram', 'uncertain')),
  facts jsonb not null default '{}',
  reasons jsonb not null default '[]',
  evidence jsonb not null default '[]',
  source text,
  notes text,
  updated_at bigint not null default 0
);

create table if not exists public.barcode_scans (
  symbol text primary key,
  is_barcode boolean not null default false,
  score numeric not null default 0,
  gap_count integer not null default 0,
  big_wick_count integer not null default 0,
  candles_count integer not null default 0,
  threshold numeric not null default 35,
  reason text not null default '',
  status text not null default 'success' check (status in ('success', 'failed')),
  source text,
  scanned_at bigint not null
);

create table if not exists public.cases (
  id bigint generated always as identity primary key,
  symbol text not null,
  actor text not null,
  decided_at bigint not null,
  payload text not null default '{}'
);
create index if not exists idx_cases_symbol on public.cases (symbol);
create index if not exists idx_cases_decided on public.cases (decided_at desc);

create table if not exists public.case_images (
  id bigint generated always as identity primary key,
  case_id bigint not null references public.cases(id) on delete cascade,
  tf text not null default '',
  data_url text not null,
  captured_at bigint not null default 0
);
create index if not exists idx_case_images_case on public.case_images (case_id);

-- RLS: أداة شخصية بلا مصادقة — الخادم يصل بدور anon
alter table public.analyses enable row level security;
drop policy if exists "analyses_all" on public.analyses;
create policy "analyses_all" on public.analyses for all to anon using (true) with check (true);
grant select, insert, update, delete on public.analyses to anon;
alter table public.coin_flags enable row level security;
drop policy if exists "coin_flags_all" on public.coin_flags;
create policy "coin_flags_all" on public.coin_flags for all to anon using (true) with check (true);
grant select, insert, update, delete on public.coin_flags to anon;
alter table public.settings enable row level security;
drop policy if exists "settings_all" on public.settings;
create policy "settings_all" on public.settings for all to anon using (true) with check (true);
grant select, insert, update, delete on public.settings to anon;
alter table public.events_log enable row level security;
drop policy if exists "events_log_all" on public.events_log;
create policy "events_log_all" on public.events_log for all to anon using (true) with check (true);
grant select, insert, update, delete on public.events_log to anon;
alter table public.symbols enable row level security;
drop policy if exists "symbols_all" on public.symbols;
create policy "symbols_all" on public.symbols for all to anon using (true) with check (true);
grant select, insert, update, delete on public.symbols to anon;
alter table public.coin_shariah enable row level security;
drop policy if exists "coin_shariah_all" on public.coin_shariah;
create policy "coin_shariah_all" on public.coin_shariah for all to anon using (true) with check (true);
grant select, insert, update, delete on public.coin_shariah to anon;
alter table public.barcode_scans enable row level security;
drop policy if exists "barcode_scans_all" on public.barcode_scans;
create policy "barcode_scans_all" on public.barcode_scans for all to anon using (true) with check (true);
grant select, insert, update, delete on public.barcode_scans to anon;
alter table public.cases enable row level security;
drop policy if exists "cases_all" on public.cases;
create policy "cases_all" on public.cases for all to anon using (true) with check (true);
grant select, insert, update, delete on public.cases to anon;
alter table public.case_images enable row level security;
drop policy if exists "case_images_all" on public.case_images;
create policy "case_images_all" on public.case_images for all to anon using (true) with check (true);
grant select, insert, update, delete on public.case_images to anon;
grant usage on schema public to anon;
grant usage, select on all sequences in schema public to anon;

insert into public.settings (id, quote, notify_timeout_min, sound_enabled, sort_config)
values (1, 'USDT', 30, true, '{}')
on conflict (id) do nothing;
