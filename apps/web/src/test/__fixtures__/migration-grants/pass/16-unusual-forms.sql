-- Statements that create a public object without starting with CREATE, or
-- look as if they do and do not, and objects that leave in other ways.
-- A parenthesized SELECT INTO creates its table like the bare one.
(select 1 as x into public.paren_rows);
revoke all on public.paren_rows from anon, authenticated, service_role;

-- EXPLAIN ANALYZE runs the statement, so it creates what the statement does.
explain (analyze, costs off, timing off, summary off) create table public.explained_rows as select 1 as x;
revoke all on public.explained_rows from anon, authenticated, service_role;
explain analyze select 1 as x into public.explained_into;
revoke all on public.explained_into from anon, authenticated, service_role;
explain (analyze true, costs off) create materialized view public.explained_totals as select 1 as n;
revoke all on public.explained_totals from anon, authenticated, service_role;

-- Without ANALYZE, or with it off, the statement is only planned and creates
-- nothing (the last ANALYZE option counts).
explain create table public.only_planned as select 1 as x;
explain (analyze false) create table public.only_planned_2 as select 1 as x;
explain (analyze, analyze off) select 1 as x into public.only_planned_3;

-- A U& identifier is decoded before it names anything.
create table U&"\0070ublic".uni_rows (id int);
revoke all on public.uni_rows from anon, authenticated, service_role;
create table public.U&"d!0061t!+000061" uescape '!' (id int);
revoke all on public."data" from anon, authenticated, service_role;

-- A DO body written as an escape string is decoded too.
do E'begin\n  create table public.escaped_rows (id int);\n  revoke all on public.escaped_rows from anon, authenticated, service_role;\nend';

-- Moved out of public and back it is the same object, decided by what was
-- granted or revoked while it was out, and its serial's sequence goes along.
create schema if not exists d1_staging;
create table public.round_trip (id serial);
alter table public.round_trip set schema d1_staging;
revoke all on d1_staging.round_trip from anon, authenticated, service_role;
grant usage, select on sequence d1_staging.round_trip_id_seq to anon, authenticated, service_role;
alter table d1_staging.round_trip set schema public;

-- Dropping a serial column drops its sequence, dropping a partitioned table
-- drops its partitions, and DROP SCHEMA ... CASCADE drops what it holds.
create table public.with_counter (id int, n serial);
revoke all on public.with_counter from anon, authenticated, service_role;
alter table public.with_counter drop column n;
create table public.by_month (d date) partition by range (d);
create table public.by_month_2026 partition of public.by_month
  for values from ('2026-01-01') to ('2027-01-01');
drop table public.by_month;
create schema d1_scratch;
create table public.parked (id int);
alter table public.parked set schema d1_scratch;
drop schema d1_scratch cascade;

-- A table attached as a partition is a partition from then on.
create table public.events_by_kind (k text) partition by list (k);
revoke all on public.events_by_kind from anon, authenticated, service_role;
create table public.events_kind_a (k text);
alter table public.events_by_kind attach partition public.events_kind_a for values in ('a');
revoke all on public.events_kind_a from anon, authenticated, service_role;
