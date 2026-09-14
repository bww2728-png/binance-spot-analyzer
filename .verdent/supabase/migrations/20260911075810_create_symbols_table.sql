create table if not exists symbols (
  symbol text primary key,
  base text not null,
  quote text not null,
  tick_size double precision not null default 0.01,
  status text not null default 'TRADING',
  updated_at bigint not null
);
create index if not exists idx_symbols_base on symbols(base);
create index if not exists idx_symbols_quote on symbols(quote);
alter table symbols enable row level security;
create policy "symbols_all" on symbols for all to anon using (true) with check (true);