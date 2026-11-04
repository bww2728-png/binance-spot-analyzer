-- =============================================================================
-- ملف تركيب لقاعدة بيانات جديدة — مُولَّد آلياً، لا تُحرّره يدوياً.
-- أعِد توليده بـ: npm run db:bundle
-- الترتيب: 000_full_schema.sql → 001_identity_by_default.sql → 002_health_samples.sql → 007_liquidity_workbench.sql → 008_liquidity_workbench_points.sql → 009_liquidity_workbench_point_time_nullable.sql → 010_liquidity_workbench_anon_write.sql → 011_liquidity_workbench_grants.sql → 012_liquidity_workbench_point_links_service_write.sql → 013_liquidity_workbench_anon_write_convention.sql → 013b_grant_service_role.sql → 014_restrict_anon_privileges.sql
--
-- التنفيذ: Supabase Dashboard ← SQL Editor ← الصق الملف كاملاً ← Run
-- التحقق بعده: السطور المعلَّقة في نهاية القسم الأخير (014).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 000_full_schema.sql
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 001_identity_by_default.sql
-- -----------------------------------------------------------------------------
-- السماح بإدخال المعرّفات الأصلية عند نقل البيانات القديمة (idempotent)
alter table public.events_log alter column id set generated by default;
alter table public.analyses alter column id set generated by default;
alter table public.cases alter column id set generated by default;
alter table public.case_images alter column id set generated by default;


-- -----------------------------------------------------------------------------
-- 002_health_samples.sql
-- -----------------------------------------------------------------------------
-- عيّنات صحة دورية يرصدها الخادم نفسه — دليل التشغيل المستمر (بلا اعتماد على واجهة)
create table if not exists public.health_samples (
  id bigint generated by default as identity primary key,
  ts bigint not null,
  data jsonb not null default '{}'
);
create index if not exists idx_health_ts on public.health_samples (ts desc);

alter table public.health_samples enable row level security;
drop policy if exists "health_samples_all" on public.health_samples;
create policy "health_samples_all" on public.health_samples for all to anon using (true) with check (true);
grant select, insert, update, delete on public.health_samples to anon;


-- -----------------------------------------------------------------------------
-- 007_liquidity_workbench.sql
-- -----------------------------------------------------------------------------
create table if not exists public.liquidity_workbench_candles (
  symbol text not null,
  timeframe text not null,
  open_time bigint not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null default 0,
  close_time bigint not null,
  taker_buy_base numeric not null default 0,
  source text not null,
  updated_at bigint not null,
  primary key (symbol, timeframe, open_time)
);

create index if not exists idx_liquidity_workbench_candles_lookup
  on public.liquidity_workbench_candles (symbol, timeframe, open_time desc);

create table if not exists public.liquidity_workbench_scans (
  engine text not null,
  symbol text not null,
  timeframe text not null,
  candle_open_time bigint not null,
  computed_at bigint not null,
  bar_count integer not null,
  data_source text not null,
  payload jsonb not null default '{}'::jsonb,
  primary key (engine, symbol, timeframe)
);

create index if not exists idx_liquidity_workbench_scans_latest
  on public.liquidity_workbench_scans (symbol, computed_at desc);

create table if not exists public.liquidity_workbench_events (
  id bigint generated by default as identity primary key,
  idempotency_key text not null unique,
  engine text not null,
  symbol text not null,
  timeframe text not null,
  zone_id text not null,
  event_type text not null,
  event_at bigint not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_liquidity_workbench_events_zone
  on public.liquidity_workbench_events (engine, symbol, timeframe, zone_id, event_at desc);

create table if not exists public.liquidity_workbench_samples (
  sample_key text primary key,
  symbol text not null,
  timeframe text not null,
  sampled_at bigint not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_liquidity_workbench_samples_time
  on public.liquidity_workbench_samples (sampled_at desc);

alter table public.liquidity_workbench_candles enable row level security;
alter table public.liquidity_workbench_scans enable row level security;
alter table public.liquidity_workbench_events enable row level security;
alter table public.liquidity_workbench_samples enable row level security;

drop policy if exists "liquidity_workbench_candles_all" on public.liquidity_workbench_candles;
drop policy if exists "liquidity_workbench_candles_read" on public.liquidity_workbench_candles;
create policy "liquidity_workbench_candles_read" on public.liquidity_workbench_candles for select to anon using (true);
drop policy if exists "liquidity_workbench_scans_all" on public.liquidity_workbench_scans;
drop policy if exists "liquidity_workbench_scans_read" on public.liquidity_workbench_scans;
create policy "liquidity_workbench_scans_read" on public.liquidity_workbench_scans for select to anon using (true);
drop policy if exists "liquidity_workbench_events_all" on public.liquidity_workbench_events;
drop policy if exists "liquidity_workbench_events_read" on public.liquidity_workbench_events;
create policy "liquidity_workbench_events_read" on public.liquidity_workbench_events for select to anon using (true);
drop policy if exists "liquidity_workbench_samples_all" on public.liquidity_workbench_samples;
drop policy if exists "liquidity_workbench_samples_read" on public.liquidity_workbench_samples;
create policy "liquidity_workbench_samples_read" on public.liquidity_workbench_samples for select to anon using (true);

grant select on public.liquidity_workbench_candles to anon;
grant select on public.liquidity_workbench_scans to anon;
grant select on public.liquidity_workbench_events to anon;
grant select on public.liquidity_workbench_samples to anon;
grant all on public.liquidity_workbench_candles to service_role;
grant all on public.liquidity_workbench_scans to service_role;
grant all on public.liquidity_workbench_events to service_role;
grant all on public.liquidity_workbench_samples to service_role;
grant usage, select on sequence public.liquidity_workbench_events_id_seq to service_role;


-- -----------------------------------------------------------------------------
-- 008_liquidity_workbench_points.sql
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 009_liquidity_workbench_point_time_nullable.sql
-- -----------------------------------------------------------------------------
alter table public.liquidity_workbench_points
  alter column point_time drop not null;


-- -----------------------------------------------------------------------------
-- 010_liquidity_workbench_anon_write.sql
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 011_liquidity_workbench_grants.sql
-- -----------------------------------------------------------------------------
-- جداول المختبر أُنشئت عبر منفّذ ترحيلات لا يطبق الامتيازات الافتراضية،
-- فالسياسات وحدها لا تكفي: يلزم منح صريح لدور anon (نفس نمط جدول cases).
grant select, insert, update, delete on public.liquidity_workbench_candles to anon;
grant select, insert, update, delete on public.liquidity_workbench_scans to anon;
grant select, insert, update, delete on public.liquidity_workbench_events to anon;
grant select, insert, update, delete on public.liquidity_workbench_samples to anon;
grant select, insert, update, delete on public.liquidity_workbench_points to anon;


-- -----------------------------------------------------------------------------
-- 012_liquidity_workbench_point_links_service_write.sql
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 013_liquidity_workbench_anon_write_convention.sql
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 013b_grant_service_role.sql
-- -----------------------------------------------------------------------------
-- =============================================================================
-- AUD-008 — المرحلة 1 (متطلب مسبق): منح service_role ما يحتاجه فعلاً
--
-- ⚠️  لم يُطبَّق. يُنفَّذ **قبل** ضبط `SUPABASE_SERVICE_ROLE_KEY` في البيئة.
--
-- لماذا يلزم ملف مستقل: المنح في هذا المشروع صريحة لا تلقائية. الدليل منقول من
-- `011_liquidity_workbench_grants.sql:1-2`:
--   «جداول المختبر أُنشئت عبر منفّذ ترحيلات لا يطبق الامتيازات الافتراضية، فالسياسات
--    وحدها لا تكفي: يلزم منح صريح لدور anon».
-- وكل منح service_role الموجود في المستودع محصور بجداول المختبر
-- (`007:84-88`، `008:31`، `012:68-74`). لا يوجد أي منح له على الجداول التسعة الأساسية.
--
-- الأثر لو نُفِّذت المرحلة 1 بلا هذا الملف: يعمل الخادم بمفتاح الخدمة بينما المنح غائبة
-- ⇒ كل `rest()` يُرجع 401/403 (المنح تُقيَّم قبل RLS، وتشمل service_role)، بينما
-- `storageConfigured()` يفحص وجود المفتاح فقط ⇒ `/readyz` أخضر مع انقطاع كامل.
-- هذا هو السبب الذي جعل تفعيل الهوية في الكود مشروطاً بإقرار
-- `SUPABASE_SERVICE_ROLE_CONFIRMED=1` (انظر `server/db.js`).
--
-- آمن وقابل للتراجع: إضافة منح لا تسحب شيئاً ولا تغيّر سلوك anon.
-- =============================================================================

begin;

grant usage on schema public to service_role;

-- الجداول الموجودة حالياً
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('grant all on public.%I to service_role', t.tablename);
  end loop;
  for t in
    -- التعداد من الكتالوج لا من `information_schema.sequences`: تلك الواجهة تُسقط تسلسلات
    -- أعمدة identity (وكل تسلسلات هذا المخطط كذلك) فتُرجع صفر صفوف بلا أي خطأ — عيب مُثبت
    -- بالتشغيل على PostgreSQL 16: الهيكل يُنشأ و`information_schema.sequences` = 0 صفوف،
    -- فيبقى service_role بلا USAGE على التسلسل ويفشل كل إدراج يحتاجه.
    select c.relname as sequence_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('grant all on sequence public.%I to service_role', t.sequence_name);
  end loop;
end $$;

grant execute on all routines in schema public to service_role;

-- الجداول المستقبلية (يجب أن يكون المنفّذ هو postgres كما في 014)
alter default privileges for role postgres in schema public grant all on tables    to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;

commit;

-- =============================================================================
-- التحقق قبل ضبط المفتاح (يجب أن يعطي صفر صفوف):
--
--   select tablename from pg_tables t
--   where schemaname = 'public'
--     and not has_table_privilege('service_role', quote_ident(tablename), 'insert');
--   -- النتيجة المتوقعة: 0 صفوف
--
-- ثم اضبط في البيئة: SUPABASE_SERVICE_ROLE_KEY و SUPABASE_SERVICE_ROLE_CONFIRMED=1
-- وأعد النشر، وتحقّق من /readyz → checks.storage.serviceRole = true
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 014_restrict_anon_privileges.sql
-- -----------------------------------------------------------------------------
-- =============================================================================
-- AUD-008 — المرحلة 2: تضييق صلاحيات دور anon على المخطط العام
--
-- ⚠️  لم يُطبَّق. هذا ملف جاهز للتشغيل اليدوي بعد المرحلة 1.
--
-- المتطلبات السابقة (إلزامية — بدونها يتوقف النظام):
--   1) `013b_grant_service_role.sql` نُفِّذ (منح service_role على الجداول التسعة).
--   2) `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_SERVICE_ROLE_CONFIRMED=1` مضبوطان.
--   3) `/readyz` = 200 و`checks.storage.serviceRole` = true.
--   السبب: بعد هذا الترحيل يفقد `anon` صلاحيات الكتابة، فلو كان الخادم ما زال يستخدم
--   المفتاح العام لفشل كل حفظ وكل استعادة.
--
-- الاستثناء المقصود: جداول مختبر السيولة تبقى على `anon`.
--   `server/db.js` (restWorkbench) يكتبها بالمفتاح العام **بالعقد** الموثّق في
--   `010_liquidity_workbench_anon_write.sql` و`013_..._anon_write_convention.sql`،
--   ويوجد اختبار يفرض ذلك (tests/liquidityWorkbenchDb.test.mjs). سحبها هنا يُوقف
--   المختبر بصمت مع بقاء /readyz أخضر — لذلك تُستثنى صراحةً.
--
-- التراجع: 014a_rollback_anon_privileges.sql
-- =============================================================================

begin;

-- قفل قصير: الإسقاط يأخذ ACCESS EXCLUSIVE على كل جدول. نفّذه في نافذة هدوء.
set local lock_timeout = '5s';

-- 0) حاجز: لا تُسحب صلاحيات anon إن كان service_role نفسه بلا منح — وإلا انقطعت
--    القراءة والكتابة كلياً بعد commit بلا إمكانية إصلاح تلقائي.
do $$
begin
  if not has_table_privilege('service_role', 'public.events_log', 'insert')
     or not has_table_privilege('service_role', 'public.symbols', 'insert') then
    raise exception 'service_role بلا منح كافية — نفّذ 013b_grant_service_role.sql أولاً';
  end if;
end $$;

-- 1) إسقاط كل السياسات في المخطط العام **عدا جداول المختبر**.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename not like 'liquidity_workbench%'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- 2) سحب الامتيازات عن anon من الجداول والتسلسلات **عدا جداول المختبر**.
do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'liquidity_workbench%'
  loop
    execute format('revoke all on public.%I from anon', t.tablename);
  end loop;
  for t in
    -- نفس سبب 013b: `information_schema.sequences` تُسقط تسلسلات أعمدة identity (وكل
    -- تسلسلات هذا المخطط كذلك) فتُرجع صفر صفوف ⇒ يبقى anon محتفظاً بـnextval().
    select c.relname as sequence_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence public.%I from anon', t.sequence_name);
  end loop;
end $$;

-- 3) الدوال: صلاحية EXECUTE تُمنح لـPUBLIC افتراضياً، فسحبها من anon وحده لا يغلق شيئاً.
revoke execute on all routines in schema public from public;
revoke execute on all routines in schema public from anon;

-- 4) منع الامتيازات الافتراضية مستقبلاً — `for role postgres` صريح لأن الشكل المجرّد
--    يستهدف دور المنفّذ فقط، وقد يكون غير الدور الذي يُنشئ الجداول.
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- 5) تفعيل RLS يبقى كما هو (مفعّل أصلاً في 000_full_schema.sql). مع صفر سياسات
--    وRLS مفعّل، النتيجة هي **المنع الافتراضي** لدور anon (PostgreSQL 18 §5.9).
--    service_role يتجاوز RLS بحكم صلاحياته فلا يحتاج سياسات.

commit;

-- =============================================================================
-- التحقق بعد التنفيذ — كل الأسطر التالية إلزامية:
--
--   -- 1) لا سياسات على الجداول غير المختبرية
--   select count(*) from pg_policies where schemaname='public'
--     and tablename not like 'liquidity_workbench%';                          -- 0
--
--   -- 2) anon ممنوع على الجداول الأساسية
--   select has_table_privilege('anon','public.events_log','insert');           -- false
--   select has_table_privilege('anon','public.events_log','select');           -- false
--
--   -- 3) service_role ممنوح (وإلا فشل كل شيء)
--   select has_table_privilege('service_role','public.events_log','insert');   -- true
--
--   -- 4) المختبر ما زال يعمل بـanon (استثناء مقصود)
--   select has_table_privilege('anon','public.liquidity_workbench_candles','select'); -- true
--
-- ثم اختبار حي على الخادم:
--   POST /api/symbols/sync                        ⇒ 200
--   GET  /readyz                                  ⇒ 200 (ready أو degraded)
--   GET  /api/liquidity-workbench/...             ⇒ 200 وليس 401/403
--   و`/api/health/deep` → liquidityWorkbench.persistenceMode = 'supabase' (لا 'unavailable')
--
-- ثم اختبار سلبي بمفتاح anon مباشرة على PostgREST:
--   GET /rest/v1/events_log?select=id&limit=1     ⇒ [] فارغة أو 401/403
-- =============================================================================

