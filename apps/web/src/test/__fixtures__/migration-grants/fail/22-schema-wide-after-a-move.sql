-- A schema-wide statement on another schema reaches whatever is in it when
-- it runs. This file moves a public table into one and back, and renames
-- public, so each such statement here can reach public objects and fails like
-- one on public. Every public object is decided.
create schema d1_stash;
create table public.stash_rows (id int primary key);
revoke all on public.stash_rows from anon, authenticated, service_role;
grant select on public.stash_rows to authenticated;
alter table public.stash_rows set schema d1_stash;
grant select on all tables in schema d1_stash to anon;
alter table d1_stash.stash_rows set schema public;

alter schema public rename to d1_public_renamed;
revoke all on all sequences in schema d1_public_renamed from anon;
alter schema d1_public_renamed rename to public;
