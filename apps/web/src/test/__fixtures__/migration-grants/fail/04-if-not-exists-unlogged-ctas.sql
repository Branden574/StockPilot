-- IF NOT EXISTS, UNLOGGED and CREATE TABLE AS create tables like any other.
create table if not exists public.cache_rows (k text primary key);

create unlogged table public.fast_rows (id int);
grant all on public.fast_rows to anon, authenticated;

create table public.copied as select k from public.cache_rows;
revoke all on public.copied from anon;
