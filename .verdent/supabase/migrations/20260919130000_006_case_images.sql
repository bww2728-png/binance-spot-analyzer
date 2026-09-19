-- 006: صور سجل القرارات (Case Images) — لقطة PNG حقيقية للشارت لحظة كل قرار.
-- تُخزَّن منفصلة عن payload لتبقى قائمة القرارات خفيفة، وتُحمَّل كسولاً عند عرض التفاصيل.

create table if not exists public.case_images (
  id bigint generated always as identity primary key,
  case_id bigint not null references public.cases(id) on delete cascade,
  tf text not null default '',
  data_url text not null,
  captured_at bigint not null default 0
);

create index if not exists idx_case_images_case on public.case_images (case_id);

alter table public.case_images enable row level security;

drop policy if exists "case_images_all" on public.case_images;
create policy "case_images_all" on public.case_images for all to anon using (true) with check (true);