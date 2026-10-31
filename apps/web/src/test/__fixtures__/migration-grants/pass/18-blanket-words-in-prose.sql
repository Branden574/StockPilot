-- Comments, strings, quoted identifiers and function bodies that spell out a
-- schema-wide GRANT or REVOKE, or ALTER DEFAULT PRIVILEGES ... GRANT, run
-- nothing during the migration, so none of them fails.
-- grant select on all tables in schema public to anon;
/* revoke all on all sequences in schema public from anon;
   /* nested: alter default privileges grant all on tables to anon; */
   grant execute on all functions in schema public to anon; */

create function public.open_everything() returns void
language plpgsql
set search_path = ''
as $fn$
begin
  -- A function body runs when the function is called, never during the migration.
  grant select on all tables in schema public to anon;
  alter default privileges in schema public grant select on tables to anon;
end;
$fn$;
revoke all on function public.open_everything() from public, anon, authenticated;

comment on function public.open_everything() is
  'Never call it: grant select on all tables in schema public to anon;';

select 'grant select on all tables in schema public to anon' as standard_string,
       E'revoke all on all sequences in schema public from anon \'; still a string' as escape_string,
       $q$alter default privileges grant all on tables to anon$q$ as dollar_string,
       U&'grant execute on all routines in schema public to anon' as unicode_string,
       1 as "grant all on all tables in schema public to anon";

do $$
begin
  raise notice 'grant select on all tables in schema public to anon';
  perform 'alter default privileges grant select on tables to anon';
end
$$;
