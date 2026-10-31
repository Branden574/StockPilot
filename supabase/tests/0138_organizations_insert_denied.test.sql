-- pgTAP: no signed-in or anonymous caller creates an organization (docket S20,
-- owner decision b.9). The database half of "only a platform admin creates a
-- workspace".
--
-- 0138 dropped the only INSERT policy on public.organizations (0003's
-- `with check (auth.uid() is not null)`) and never made another, so with RLS on,
-- a PostgREST or GraphQL insert is refused with 42501 even though anon and
-- authenticated still hold the table INSERT privilege (0402's explicit grants).
-- Workspaces are created only by app code on the service role, behind the
-- platform-admin check; apps/web/src/server/organization-create-sites.guard.test.ts
-- pins those places. Nothing in the database creates one either: no function
-- (whoever may run it), no trigger, and no view or rewrite rule a caller of the
-- Data API can write through.
begin;
select plan(9);

\set org   '\'0138a000-0000-4000-8000-0000000000a1\''
\set owner '\'0138b000-0000-4000-8000-0000000000b1\''
\set loner '\'0138c000-0000-4000-8000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:owner, 'owner@orgs0138.test', '{}'::jsonb),
  (:loner, 'loner@orgs0138.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values (:org, 'Insert Guard Org', 'insert-guard-org-0138');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :owner, 'owner', now());

select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.organizations'::regclass),
  'RLS is enabled on public.organizations'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'organizations' and cmd in ('INSERT', 'ALL')),
  0,
  'public.organizations has no INSERT or ALL policy (0138 dropped the only one)'
);

-- An account that belongs to no workspace (a removed member, a portal user).
set local "request.jwt.claim.sub" to '0138c000-0000-4000-8000-0000000000c1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.organizations (name, slug) values ('Made Without A Seat', 'made-without-a-seat-0138') $$,
  '42501',
  'new row violates row-level security policy for table "organizations"',
  'an account with no membership cannot insert an organization'
);
reset role;

-- The owner of another workspace.
set local "request.jwt.claim.sub" to '0138b000-0000-4000-8000-0000000000b1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.organizations (name, slug) values ('Made By An Owner', 'made-by-an-owner-0138') $$,
  '42501',
  'new row violates row-level security policy for table "organizations"',
  'the owner of another organization cannot insert one'
);
reset role;

-- No session at all.
set local "request.jwt.claim.sub" to '';
set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select throws_ok(
  $$ insert into public.organizations (name, slug) values ('Made By Anon', 'made-by-anon-0138') $$,
  '42501',
  'new row violates row-level security policy for table "organizations"',
  'anon cannot insert an organization'
);
reset role;

-- What creates an organization in a function body: an INSERT or a MERGE into
-- the table, or dynamic SQL (EXECUTE) that names it anywhere, since no pattern
-- can follow a statement built at run time (format('insert into %I.%I', ...)).
-- Comments are dropped first, so a comment that names the table does not count.
-- A SQL-standard body (BEGIN ATOMIC) keeps no source text, so its deparsed
-- definition is read instead.
create function pg_temp.creates_organizations(p_fn oid) returns boolean
language sql stable as $$
  select s ~* '\m(insert|merge)\s+into\s+("?public"?\s*\.\s*)?"?organizations\M'
      or (s ~* '\mexecute\M' and s ~* '\morganizations\M')
    from (
      select regexp_replace(
               regexp_replace(
                 case when p.prosqlbody is not null then pg_get_functiondef(p.oid)
                      else coalesce(p.prosrc, '') end,
                 '/\*.*?\*/', ' ', 'g'),
               '--[^\n]*', ' ', 'g') as s
        from pg_proc p
       where p.oid = p_fn
    ) src
$$;

-- No function a caller of the Data API may execute creates an organization:
-- a SECURITY DEFINER one would get past RLS, and a SECURITY INVOKER one would
-- only be refused today because of the policy pinned above.
select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname !~ '^pg_(temp|toast)'
        and p.prokind in ('f', 'p')
        and pg_temp.creates_organizations(p.oid)
        and (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute')) $$,
  'no function anon or authenticated may execute creates an organization (an INSERT or MERGE into it, or dynamic SQL that names it)'
);

-- Nor does any trigger: a trigger function runs for whoever fires its trigger,
-- whatever EXECUTE it grants, so one on a table a member may write would create
-- organizations past both checks above.
select is_empty(
  $$ select t.tgrelid::regclass::text || ' ' || t.tgname
       from pg_trigger t
      where not t.tgisinternal
        and pg_temp.creates_organizations(t.tgfoid) $$,
  'no trigger runs a function that creates an organization'
);

-- Nor any other function, whoever may run it: a SECURITY DEFINER function the
-- Data API may call runs the functions it calls as its owner, whatever EXECUTE
-- they grant, and app code can call a service-role function with .rpc(), which
-- the app's own guard does not see as a write to organizations.
select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname !~ '^pg_(temp|toast)'
        and p.prokind in ('f', 'p')
        and pg_temp.creates_organizations(p.oid) $$,
  'no function at all, whoever may run it, creates an organization'
);

-- Nor a view or a rewrite rule: an insert into a view runs against its table
-- as the view's owner, past RLS, and a rule's actions run as the owner of the
-- table it is on.
select is_empty(
  $$ select 'view ' || c.oid::regclass::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v'
        and n.nspname not in ('pg_catalog', 'information_schema')
        and pg_get_viewdef(c.oid) ~* '\morganizations\M'
        and (has_table_privilege('anon', c.oid, 'insert')
             or has_table_privilege('authenticated', c.oid, 'insert'))
     union all
     select 'rule ' || r.schemaname || '.' || r.tablename || ' ' || r.rulename
       from pg_rules r
      where r.definition ~* '\morganizations\M' $$,
  'no view a caller of the Data API may insert into, and no rewrite rule, names public.organizations'
);

select * from finish();
rollback;
