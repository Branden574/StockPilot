-- Quoted names keep their case and spaces, a quoted lower-case name is the
-- unquoted name, an unquoted name folds to lower case, and schema and role
-- names may be quoted too.
create table "public"."Order Lines" (id int primary key);
grant select on "public"."Order Lines" to "anon", "authenticated", "service_role";

create table "parts" (id int primary key);
grant select on public.parts to anon, authenticated, service_role;

create table Mixed_Case (id int primary key);
grant select on "mixed_case" to ANON, Authenticated, "service_role";

create table "say ""hi""" (id int primary key);
grant select on public."say ""hi""" to anon, authenticated, service_role;
