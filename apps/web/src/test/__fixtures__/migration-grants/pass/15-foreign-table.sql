-- A foreign table in public is a table the Data API roles could reach, so it
-- is decided like one.
create extension if not exists postgres_fdw;
create server d1_fixture_remote foreign data wrapper postgres_fdw options (dbname 'd1_none');
create foreign table public.remote_rows (id int) server d1_fixture_remote;
revoke all on public.remote_rows from anon, authenticated, service_role;
grant select on public.remote_rows to service_role;
