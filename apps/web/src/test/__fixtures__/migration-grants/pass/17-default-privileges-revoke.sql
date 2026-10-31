-- ALTER DEFAULT PRIVILEGES ... REVOKE is allowed in every form: it only takes
-- privileges out of what later objects get, and a checked file decides each
-- object it creates by name anyway. The first two are Supabase's statements
-- (changelog 45329), which the deferred follow-up needs.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges revoke grant option for all on tables from service_role;
alter default privileges for user postgres revoke usage on types from public;
create schema revoke;
alter default privileges in schema revoke revoke select on tables from anon;
do $$
begin
  alter default privileges in schema public revoke all on sequences from anon;
end
$$;

-- A table created after them is decided as usual.
create table public.after_revokes (id int primary key);
revoke all on public.after_revokes from anon, authenticated, service_role;
grant select on public.after_revokes to authenticated;
