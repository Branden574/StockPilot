-- Statements that create a public object without starting with CREATE need
-- their decisions like any other.
(select 1 as x into public.paren_rows);
explain (analyze, costs off, timing off, summary off) create table public.explained_rows as select 1 as x;
explain analyse verbose select 1 as x into public.explained_into;
create table U&"\0070ublic".uni_rows (id int);
create table public.U&"d!0061t!+000061" uescape '!' (id int);
do E'begin\n  create table public.escaped_rows (id int);\nend';
-- Moved out of public and back, a table is a public object again.
create schema if not exists d1_staging;
create table public.round_trip (id int);
alter table public.round_trip set schema d1_staging;
alter table d1_staging.round_trip set schema public;
