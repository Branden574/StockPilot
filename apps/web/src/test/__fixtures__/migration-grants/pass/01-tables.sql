-- Tables with an explicit public. name, an unqualified name (schema public),
-- UNLOGGED and CREATE TABLE AS, each decided for the three roles after it.
create table public.widgets (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
grant select on public.widgets to anon;
grant select, insert, update, delete on table public.widgets to authenticated, service_role;

create table gadgets (id bigint primary key, label text);
grant select on gadgets to anon, authenticated;
revoke all on public.gadgets from service_role;

create unlogged table public.fast_rows (id int);
grant select on public.fast_rows to anon, authenticated, service_role;

create table public.widget_names as select name from public.widgets;
grant select on public.widget_names to anon, authenticated, service_role;

create table public.pairs (a, b) as select 1, 2;
revoke all on public.pairs from anon, authenticated, service_role;
