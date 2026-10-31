-- Every kind of view asks for its own decision; the base table's does not
-- reach it.
create table public.base_rows (id int primary key);
revoke all on public.base_rows from anon, authenticated, service_role;

create view public.plain_view as select id from public.base_rows;

create or replace view public.replaced_view as select id from public.base_rows;

create materialized view public.totals as select count(*) as n from public.base_rows;

create materialized view if not exists public.totals_again as
  select count(*) as n from public.base_rows;

create recursive view public.counting (n) as
  select 1 union all select n + 1 from counting where n < 3;
