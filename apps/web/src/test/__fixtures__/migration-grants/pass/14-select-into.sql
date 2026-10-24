-- A top-level SELECT ... INTO creates a table and is decided like one; a
-- PL/pgSQL SELECT INTO sets a variable, and INSERT INTO creates nothing.
create table public.source_rows (id int primary key);
grant select on public.source_rows to anon, authenticated, service_role;

select id into public.copied_rows from public.source_rows;
grant select on public.copied_rows to anon, authenticated, service_role;

select id into temporary table scratch_copy from public.source_rows;

do $$
declare
  n int;
begin
  select count(*) into n from public.source_rows;
end
$$;

with picked as (select id from public.source_rows)
insert into public.source_rows select id + 100 from picked;
