-- ALTER DEFAULT PRIVILEGES ... GRANT fails in every form: database-wide (no
-- IN SCHEMA, which covers public too), in another schema, with its options in
-- either order, FOR USER, on any kind of object, and in a DO block. A schema
-- named revoke is a name. Nothing here creates a public object.
create schema d1_other;
create schema revoke;
alter default privileges grant select on tables to anon;
alter default privileges in schema d1_other grant select on tables to anon;
alter default privileges in schema public for role postgres grant usage on sequences to anon;
alter default privileges for user postgres in schema d1_other, public
  grant execute on functions to anon;
alter default privileges in schema revoke grant select on tables to anon;
alter default privileges grant usage on schemas to anon;
alter default privileges in schema public grant usage on types to anon;
alter default privileges grant execute on routines to anon with grant option;
do $$
begin
  alter default privileges in schema public grant select on tables to anon;
end
$$;
