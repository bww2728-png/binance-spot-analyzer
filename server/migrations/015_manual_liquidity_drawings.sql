create table if not exists public.liquidity_manual_drawings (
  drawing_id text not null,
  symbol text not null check (symbol ~ '^[A-Z0-9]{3,20}$'),
  timeframe text not null check (timeframe in ('1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w')),
  drawing_type text not null check (drawing_type in ('line','circle','arrow','break','rectangle','text')),
  payload jsonb not null,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (symbol, timeframe, drawing_id)
);

create index if not exists idx_liquidity_manual_drawings_chart
  on public.liquidity_manual_drawings (symbol, timeframe, updated_at desc);

alter table public.liquidity_manual_drawings enable row level security;

grant all on public.liquidity_manual_drawings to service_role;
