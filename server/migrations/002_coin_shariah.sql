-- جدول التصنيف الشرعي لكل عملة
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

alter table public.coin_shariah enable row level security;

drop policy if exists "coin_shariah_all" on public.coin_shariah;
create policy "coin_shariah_all" on public.coin_shariah for all to anon using (true) with check (true);

grant all on public.coin_shariah to anon, authenticated;