-- An object created and dropped in the same file needs no decision, a renamed
-- one is decided under any of its names, and one moved out of public needs
-- none.
create table public.staging_rows (id int);
insert into public.staging_rows values (1);
drop table public.staging_rows;

create table public.draft_name (id serial);
grant select on public.draft_name to anon;
alter table public.draft_name rename to final_name;
grant select on public.final_name to authenticated, service_role;
-- The serial's sequence keeps the name it was given.
grant usage on sequence public.draft_name_id_seq to anon, authenticated, service_role;

create schema if not exists d1_archive;
create table public.moving (id serial);
alter table public.moving set schema d1_archive;

create view public.short_view as select 1 as one;
drop view if exists public.short_view;

create sequence public.short_lived;
drop sequence public.short_lived;

create table public.with_owned (id int);
create sequence public.with_owned_counter owned by public.with_owned.id;
drop table public.with_owned;

create table public.with_serial (id serial);
drop table public.with_serial cascade;
