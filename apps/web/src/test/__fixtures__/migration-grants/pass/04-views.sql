-- Views, CREATE OR REPLACE views, recursive views and materialized views.
create table public.base_rows (id int primary key, org uuid);
grant select on public.base_rows to anon, authenticated, service_role;

create view public.base_view as select id from public.base_rows;
grant select on public.base_view to authenticated, service_role;
revoke all on public.base_view from anon;

create or replace view public.replaced_view with (security_invoker = true) as
  select id, org from public.base_rows;
grant select on table public.replaced_view to anon, authenticated, service_role;

-- Replacing it again keeps the view and its grants: it is the same object.
create or replace view public.replaced_view with (security_invoker = true) as
  select id, org from public.base_rows;

create materialized view public.base_totals as select count(*) as n from public.base_rows;
grant select on public.base_totals to service_role;
revoke all on public.base_totals from anon, authenticated;

create materialized view if not exists public.base_totals_2 as
  select count(*) as n from public.base_rows
  with no data;
revoke all on public.base_totals_2 from anon, authenticated, service_role;

create recursive view public.counting (n) as
  select 1 union all select n + 1 from counting where n < 3;
grant select on public.counting to anon, authenticated, service_role;
