-- Statements that name no object, or none of the three roles, decide nothing.
create table public.broad (id int primary key);
-- Schema-wide grants name no object, and each fails on its own (fail/16 on).
grant select on all tables in schema public to anon, authenticated, service_role;
grant usage on all sequences in schema public to anon, authenticated, service_role;

create table public.via_public (id int primary key);
-- PUBLIC is not anon, authenticated or service_role, either way.
grant select on public.via_public to public;
revoke all on public.via_public from public;

create table public.option_only (id int primary key);
grant all on public.option_only to anon, authenticated;
-- Revoking only the grant option leaves the privilege where it was.
revoke grant option for all on public.option_only from service_role;

-- Default privileges change later objects, not this one; the GRANT fails too.
create table public.defaults_only (id int primary key);
alter default privileges in schema public grant select on tables to anon, authenticated, service_role;
