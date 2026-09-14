-- جداول تطبيق تحليل عملات بينانس السبوت

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
  updated_at bigint not null
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

-- RLS: تطبيق شخصي لمستخدم واحد بدون مصادقة — وصول كامل لدور anon
alter table public.analyses enable row level security;
alter table public.coin_flags enable row level security;
alter table public.settings enable row level security;
alter table public.events_log enable row level security;

drop policy if exists "analyses_all" on public.analyses;
create policy "analyses_all" on public.analyses for all to anon using (true) with check (true);

drop policy if exists "coin_flags_all" on public.coin_flags;
create policy "coin_flags_all" on public.coin_flags for all to anon using (true) with check (true);

drop policy if exists "settings_all" on public.settings;
create policy "settings_all" on public.settings for all to anon using (true) with check (true);

drop policy if exists "events_log_all" on public.events_log;
create policy "events_log_all" on public.events_log for all to anon using (true) with check (true);

-- بذور: صف الإعدادات الافتراضي
insert into public.settings (id, quote, notify_timeout_min, sound_enabled, sort_config)
values (1, 'USDT', 30, true, '{}')
on conflict (id) do nothing;

-- بذور: قائمة الحلال المرجعية (مؤشر قابل للتعديل وليس فتوى)
insert into public.coin_flags (symbol, halal, barcode, updated_at)
values
  ('BTC', true, false, 0), ('ETH', true, false, 0), ('BNB', true, false, 0), ('SOL', true, false, 0),
  ('ADA', true, false, 0), ('DOT', true, false, 0), ('XRP', true, false, 0), ('LTC', true, false, 0),
  ('BCH', true, false, 0), ('LINK', true, false, 0), ('AVAX', true, false, 0), ('MATIC', true, false, 0),
  ('UNI', true, false, 0), ('ATOM', true, false, 0), ('ETC', true, false, 0), ('FIL', true, false, 0),
  ('NEAR', true, false, 0), ('ARB', true, false, 0), ('OP', true, false, 0), ('INJ', true, false, 0),
  ('AAVE', true, false, 0), ('SAND', true, false, 0), ('MANA', true, false, 0), ('GRT', true, false, 0),
  ('ENJ', true, false, 0), ('ANKR', true, false, 0), ('STORJ', true, false, 0), ('SKL', true, false, 0),
  ('CELO', true, false, 0), ('ONE', true, false, 0)
on conflict (symbol) do nothing;
