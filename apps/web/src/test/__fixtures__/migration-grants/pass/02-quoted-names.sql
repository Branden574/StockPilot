-- Quoted names keep their case and spaces, a quoted lower-case name is the
-- unquoted name, an unquoted name folds to lower case, and schema, role and
-- (lower-case) privilege names may be quoted too.
create table "public"."Order Lines" (id int primary key);
grant all on "public"."Order Lines" to "anon", "authenticated", "service_role";

create table "parts" (id int primary key);
revoke all on public.parts from anon, authenticated, service_role;
grant select on public.parts to anon, authenticated, service_role;

create table Mixed_Case (id int primary key);
revoke all on "mixed_case" from ANON, Authenticated, "service_role";

create table "say ""hi""" (id int primary key);
grant "select", "insert", "update", "delete" on public."say ""hi""" to anon, authenticated, service_role;
