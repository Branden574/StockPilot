-- Comments, strings, quoted identifiers and function bodies that mention
-- CREATE create nothing now, so nothing here needs a decision.
-- create table public.ghost_line (id int);
/* create table public.ghost_block (id int);
   /* nested: create view public.ghost_nested as select 1; */
   create sequence public.ghost_after_nested; */

create function public.make_ghost_table() returns void
language plpgsql
set search_path = ''
as $fn$
begin
  -- A function body runs when the function is called, never during the migration.
  create table public.ghost_in_function (id int);
  execute 'create table public.ghost_dynamic (id int)';
end;
$fn$;
revoke all on function public.make_ghost_table() from public, anon, authenticated;

comment on function public.make_ghost_table() is
  'Says create table public.ghost_in_comment (id int); and creates nothing.';

select 'create table public.ghost_in_string (id int)' as standard_string,
       E'create view public.ghost_in_escape_string as select 1 \'; still a string' as escape_string,
       $q$create materialized view public.ghost_in_dollar as select 1$q$ as dollar_string,
       U&'create sequence public.ghost_unicode' as unicode_string,
       1 as "create table public.ghost_ident (id int)";

do $$
begin
  raise notice 'create table public.ghost_in_notice (id int)';
  perform 'create sequence public.ghost_in_perform';
end
$$;
