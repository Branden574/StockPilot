-- A partitioned table and its partitions, each decided.
create table public.readings (
  id bigint not null,
  taken_at date not null,
  value numeric
) partition by range (taken_at);
grant select, insert on public.readings to authenticated, service_role;
revoke all on public.readings from anon;

create table public.readings_2026 partition of public.readings
  for values from ('2026-01-01') to ('2027-01-01');
revoke all on public.readings_2026 from anon, authenticated, service_role;

create table public.readings_default partition of public.readings default;
revoke all on public.readings_default from anon, authenticated, service_role;
