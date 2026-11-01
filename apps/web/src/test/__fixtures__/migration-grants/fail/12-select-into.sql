-- A top-level SELECT ... INTO creates a table.
create table public.source_rows (id int primary key);
grant all on public.source_rows to anon, authenticated, service_role;

select id into public.copied_rows from public.source_rows;

select id into unlogged table moved_rows from public.source_rows;
grant all on moved_rows to service_role;
