-- Every privilege the default would decide must be named for each role: under
-- Supabase's new defaults a privilege nothing names is gone, while the local
-- stack and CI still grant it. Each object here has a GRANT or REVOKE for all
-- three roles, and each is decided the way a history migration decided one.
create table public.log_rows (id uuid primary key default gen_random_uuid(), body text);
revoke all on table public.log_rows from public, anon, authenticated; -- as 0111's order_email_log
grant select, insert on table public.log_rows to service_role;

create table public.stats_rows (id int primary key, n int);
revoke insert, update, delete, truncate on public.stats_rows from anon, authenticated; -- as 0230
grant select on public.stats_rows to authenticated;
grant select, insert, update, delete on public.stats_rows to service_role;

create view public.overview with (security_invoker = true) as select id, n from public.stats_rows;
revoke all on public.overview from public, anon, authenticated; -- as 0394's return_overview
grant select on public.overview to authenticated, service_role;

-- Granting only what a role needs leaves the rest to the default.
create table public.read_only (id int primary key);
grant select on public.read_only to anon, authenticated, service_role;

-- A column grant leaves the table-level privilege where it was.
create table public.by_column (id int primary key, note text);
grant select (id), update (note) on public.by_column to anon, authenticated, service_role;
revoke delete on public.by_column from anon, authenticated, service_role;

-- A sequence needs both USAGE and SELECT named.
create sequence public.counter;
grant usage on sequence public.counter to anon, authenticated, service_role;
create sequence public.reader;
grant select on sequence public.reader to anon, authenticated;
revoke all on sequence public.reader from service_role;
