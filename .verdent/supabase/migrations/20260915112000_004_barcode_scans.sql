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

alter table public.barcode_scans enable row level security;
drop policy if exists "barcode_scans_all" on public.barcode_scans;
create policy "barcode_scans_all" on public.barcode_scans for all to anon using (true) with check (true);

insert into public.barcode_scans
  (symbol, is_barcode, score, candles_count, threshold, reason, status, source, scanned_at)
select symbol, barcode, 0, 0, 35,
  case when barcode then 'نتيجة باركود قديمة من الأعلام الآلية' else 'نتيجة قديمة تحتاج إعادة فحص' end,
  'success', 'migrated from coin_flags', updated_at
from public.coin_flags
where barcode = true
on conflict (symbol) do nothing;