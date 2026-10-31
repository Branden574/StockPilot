-- A DO body runs during the migration, so its CREATE, GRANT and REVOKE
-- statements count, after BEGIN, THEN, ELSE, LOOP or a label.
do $$
begin
  if to_regclass('public.lazy_table') is null then
    create table public.lazy_table (id int primary key);
    revoke all on public.lazy_table from anon, authenticated;
    grant select on public.lazy_table to anon, authenticated;
  end if;
end
$$;
revoke all on public.lazy_table from service_role;

do language plpgsql $body$
declare
  n int := 0;
begin
  <<setup>>
  begin
    create view public.lazy_view as select 1 as one;
    revoke all on public.lazy_view from anon, authenticated, service_role;
  end;
  for n in 1..2 loop
    grant select on public.lazy_view to authenticated;
  end loop;
  if n > 5 then
    null;
  else
    grant select on public.lazy_view to anon;
  end if;
  grant select on public.lazy_view to service_role;
end
$body$;
