-- A GRANT in a comment, a string or a function body decides nothing.
create table public.commented (id int primary key);
-- grant select on public.commented to anon, authenticated, service_role;
/* grant select on public.commented to anon, authenticated, service_role; */
select 'grant select on public.commented to anon, authenticated, service_role';
comment on table public.commented is $$grant select on public.commented to anon$$;
create function public.grant_later() returns void language plpgsql as $f$
begin
  grant select on public.commented to anon, authenticated, service_role;
end;
$f$;
revoke all on function public.grant_later() from public, anon, authenticated;
