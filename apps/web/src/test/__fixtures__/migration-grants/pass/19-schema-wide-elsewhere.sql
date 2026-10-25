-- A schema-wide GRANT or REVOKE on another schema changes only what is in
-- that schema when it runs, never a public object, so it passes in a file that
-- moves no object between schemas and renames none. "Public" in quotes is
-- another schema, as Postgres reads it.
create schema d1_private;
create table d1_private.secrets (id int primary key);
create sequence d1_private.secret_numbers;
create function d1_private.peek() returns int language sql as 'select 1';
grant select on all tables in schema d1_private to authenticated;
revoke all on all sequences in schema d1_private from anon;
grant execute on all functions in schema d1_private to service_role;
revoke execute on all routines in schema d1_private from public;
create schema "Public";
grant select on all tables in schema "Public" to anon;
create schema d1_elements
  create table element_rows (id int)
  grant select on all tables in schema d1_elements to authenticated;

-- A public table, decided as usual.
create table public.visible_rows (id int primary key);
revoke all on public.visible_rows from anon, authenticated, service_role;
grant select on public.visible_rows to anon, authenticated;
