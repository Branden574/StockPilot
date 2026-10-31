-- A partition is a table of its own: the parent's grants do not reach it.
create table public.readings (
  id bigint not null,
  taken_at date not null
) partition by range (taken_at);
grant all on public.readings to anon, authenticated, service_role;

create table public.readings_2026 partition of public.readings
  for values from ('2026-01-01') to ('2027-01-01');

create table public.by_list (k text) partition by list (k);
