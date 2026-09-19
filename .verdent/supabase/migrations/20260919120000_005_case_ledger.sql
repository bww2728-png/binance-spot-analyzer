-- 005: سجل القرارات (Case Ledger) — أرشيف مستقل لكل قرار تحليل.
-- كل صف = قرار واحد (منطقة يدوية / تغذية راجعة آلية / تعديل تحليل / إضافة-إزالة عملة)
-- وpayload يحتوي الشموع المعروضة لحظة القرار + المناطق + مناخ السوق.
-- لا يُشتق منه أي قرار مستقبلي — لقطة مصنّفة للتعلم اللاحق فقط.

create table if not exists public.cases (
  id bigint generated always as identity primary key,
  symbol text not null,
  actor text not null,
  decided_at bigint not null,
  payload text not null default '{}'
);

create index if not exists idx_cases_symbol on public.cases (symbol);
create index if not exists idx_cases_decided on public.cases (decided_at desc);
create index if not exists idx_cases_actor on public.cases (actor);

alter table public.cases enable row level security;

drop policy if exists "cases_all" on public.cases;
create policy "cases_all" on public.cases for all to anon using (true) with check (true);