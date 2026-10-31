-- A grant counts only after the CREATE: this table is dropped and made again,
-- and the new table never gets one.
create table public.rebuilt (id int primary key);
grant select on public.rebuilt to anon, authenticated, service_role;
drop table public.rebuilt;
create table public.rebuilt (id int primary key, note text);
