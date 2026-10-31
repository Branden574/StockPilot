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
-- pins those places. No function that anon or authenticated may execute inserts
-- an organization either.
begin;
select plan(6);

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

-- No function a caller of the Data API may execute inserts an organization:
-- a SECURITY DEFINER one would get past RLS, and a SECURITY INVOKER one would
-- only be refused today because of the policy pinned above.
select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and p.prosrc ~* 'insert\s+into\s+("?public"?\s*\.\s*)?"?organizations\M'
        and (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute')) $$,
  'no function anon or authenticated may execute inserts into public.organizations'
);

select * from finish();
rollback;
