-- A table created in a DO block needs its decision like any other, and a
-- grant run as a string (EXECUTE) cannot be seen, so it does not count.
do $$
begin
  if to_regclass('public.lazy_table') is null then
    create table public.lazy_table (id int primary key);
  end if;
  execute 'grant select on public.lazy_table to anon, authenticated, service_role';
end
$$;
