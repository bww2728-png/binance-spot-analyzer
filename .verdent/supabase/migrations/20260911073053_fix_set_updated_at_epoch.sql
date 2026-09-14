create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = (extract(epoch from now())*1000)::bigint;
  return new;
end;
$$ language plpgsql;