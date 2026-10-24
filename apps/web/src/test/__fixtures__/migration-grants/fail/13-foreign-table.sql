-- A foreign table in public needs its decision like any table.
create extension if not exists postgres_fdw;
create server d1_fixture_remote foreign data wrapper postgres_fdw options (dbname 'd1_none');
create foreign table if not exists public.remote_rows (id int) server d1_fixture_remote;
grant select on public.remote_rows to authenticated;
