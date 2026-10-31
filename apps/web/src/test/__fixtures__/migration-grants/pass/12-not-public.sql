-- Objects outside public need no decision here: ones in another schema,
-- temporary ones, and the elements of a CREATE SCHEMA.
create schema if not exists d1_private;
create table d1_private.secrets (id int primary key);
create view d1_private.secret_view as select id from d1_private.secrets;
create sequence d1_private.secret_seq;
create table "d1_private"."Quoted" (id serial);
create materialized view d1_private.secret_totals as select count(*) as n from d1_private.secrets;

create temporary table scratch_rows (id int);
create temp view scratch_view as select 1 as one;
create temp sequence scratch_seq;
create local temporary table scratch_local (id int);
create global temporary table scratch_global (id int);
create table pg_temp.scratch_pg_temp (id int);

create schema d1_elements
  create table element_table (id int)
  create view element_view as select 1 as one;
