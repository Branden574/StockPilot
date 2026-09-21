-- 0355: get_request_context() returns the CALLER's context, and only the caller's.
--
-- Pins the security posture in the catalog (invoker rights, no anon), and the
-- behaviour the application relies on: accepted memberships only, oldest first,
-- each with its own organization's settings, overrides and enabled modules, and
-- nothing from an organization the caller does not belong to.
begin;
select plan(31);

\set org_a  '''c0355000-0000-0000-0000-00000000000a'''
\set org_b  '''c0355000-0000-0000-0000-00000000000b'''
\set org_c  '''c0355000-0000-0000-0000-00000000000c'''
\set u_a    '''c0355000-0000-0000-0000-0000000000a1'''
\set u_b    '''c0355000-0000-0000-0000-0000000000b1'''
\set u_adm  '''c0355000-0000-0000-0000-0000000000ad'''

insert into auth.users (id, email) values
  (:u_a, 'una@test.local'), (:u_b, 'ben@test.local'), (:u_adm, 'ada@test.local');
insert into public.organizations (id, name, slug) values
  (:org_a, 'Org A 0355', 'org-a-0355'),
  (:org_b, 'Org B 0355', 'org-b-0355'),
  (:org_c, 'Org C 0355', 'org-c-0355');
-- una: manager in A (older), viewer in C (newer), INVITED but not accepted in B.
-- ben: staff in B only.
insert into public.organization_members (organization_id, user_id, role, accepted_at, created_at) values
  (:org_a, :u_a, 'manager', now(), now() - interval '2 days'),
  (:org_c, :u_a, 'viewer',  now(), now() - interval '1 day'),
  (:org_b, :u_a, 'admin',   null,  now() - interval '3 days'),
  (:org_b, :u_b, 'staff',   now(), now()),
  -- ada: ADMIN in A. Row level security lets an admin read EVERY member's
  -- override rows in her org, so for her only the function's own predicate
  -- (user_id = the caller) keeps una's grant out of her permission set.
  (:org_a, :u_adm, 'admin', now(), now() - interval '5 days');
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:org_a, 'manager', 'items:delete', false),
  (:org_a, 'staff',   'items:update', false),      -- another ROLE in una's org: not hers
  (:org_b, 'staff',   'orders:approve', true),     -- another ORG: not hers
  (:org_c, 'manager', 'items:create', false),      -- her role in A, but in org C: not hers there
  (:org_c, 'viewer',  'items:export', true);       -- her role in C
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:org_a, :u_a, 'items:delete', true),
  (:org_b, :u_b, 'reports:view', false),
  (:org_c, :u_a, 'items:import', true),
  (:org_a, :u_adm, 'audit:read', true);
update public.organization_modules set enabled = (module_id in ('books', 'orders'))
 where organization_id = :org_a;

-- ── 1. The function, as the catalog sees it ─────────────────────────────────
select ok(
  not (select p.prosecdef from pg_proc p where p.oid = 'public.get_request_context()'::regprocedure),
  'SECURITY INVOKER: it reads under the caller''s row level security, never past it');
select is(
  (select p.provolatile::text from pg_proc p where p.oid = 'public.get_request_context()'::regprocedure),
  's', 'STABLE: PostgREST may serve it from a read-only transaction');
select ok(
  (select exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%pg_temp%')
     from pg_proc p where p.oid = 'public.get_request_context()'::regprocedure),
  'search_path is pinned, pg_temp included');
select ok(not has_function_privilege('anon', 'public.get_request_context()', 'execute'),
  'anon holds no EXECUTE');
select ok(has_function_privilege('authenticated', 'public.get_request_context()', 'execute'),
  'authenticated holds EXECUTE');

-- ── 2. una: her context, nobody else's ──────────────────────────────────────
set local "request.jwt.claim.sub" to 'c0355000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

create temp table una on commit drop as select public.get_request_context() as ctx;

select is((select ctx->>'user_id' from una), 'c0355000-0000-0000-0000-0000000000a1',
  'user_id is the caller');
select is((select ctx->'profile'->>'id' from una), 'c0355000-0000-0000-0000-0000000000a1',
  'profile is the caller''s own row');
select ok((select ctx->'profile' ? 'disabled_at' from una),
  'profile carries disabled_at: the account-status gate reads it from here');
select is((select jsonb_array_length(ctx->'memberships') from una), 2,
  'two memberships: the invitation she has NOT accepted is not one');
select is((select ctx->'memberships'->0->>'organization_id' from una), 'c0355000-0000-0000-0000-00000000000a',
  'oldest membership first');
select is((select ctx->'memberships'->1->>'organization_id' from una), 'c0355000-0000-0000-0000-00000000000c',
  'newer membership second');
select is((select ctx->'memberships'->0->>'role' from una), 'manager', 'her role in org A');
select is((select ctx->'memberships'->0->'organization'->>'name' from una), 'Org A 0355',
  'the organization row is org A''s');
select is((select ctx->'memberships'->0->'role_overrides' from una),
  '[{"granted": false, "permission": "items:delete"}]'::jsonb,
  'role overrides: her ROLE in that org only (the staff override is not hers)');
select is((select ctx->'memberships'->0->'user_overrides' from una),
  '[{"granted": true, "permission": "items:delete"}]'::jsonb,
  'user overrides: her own');
select is((select ctx->'memberships'->0->'enabled_modules' from una), '["books", "orders"]'::jsonb,
  'enabled modules only, for that org');
select is((select ctx->'memberships'->1->'role_overrides' from una),
  '[{"granted": true, "permission": "items:export"}]'::jsonb,
  'org C: the overrides of her role THERE (viewer), not of her role in A');
select is((select ctx->'memberships'->1->'user_overrides' from una),
  '[{"granted": true, "permission": "items:import"}]'::jsonb,
  'org C: her own user override in C, and only that one');
select is(
  (select array_agg(k order by k) from jsonb_object_keys((select ctx->'memberships'->0->'organization' from una)) k),
  array['all_modules_comp','dashboard_layout','id','logo_url','mfa_policy','name','nav_overrides','order_status_config','terminology','timezone'],
  'the organization object has exactly these ten keys: no billing column, and mfa_policy is there');
select is(
  (select array_agg(k order by k) from jsonb_object_keys((select ctx->'profile' from una)) k),
  array['avatar_url','default_organization_id','disabled_at','email','full_name','id'],
  'the profile object has exactly these six keys');
select ok((select ctx::text not like '%c0355000-0000-0000-0000-00000000000b%' from una),
  'nothing about org B, where she is only invited');
select ok((select ctx::text not like '%orders:approve%' and ctx::text not like '%reports:view%' from una),
  'no other organization''s overrides, and no other user''s');

-- ── 2b. ada, an ADMIN: RLS shows her every member's overrides; the function must not ──
set local role to postgres;
set local "request.jwt.claim.sub" to 'c0355000-0000-0000-0000-0000000000ad';
set local role to 'authenticated';

select ok(
  (select count(*) from public.user_permission_overrides
    where organization_id = 'c0355000-0000-0000-0000-00000000000a') >= 2,
  'fixture: as an admin ada CAN read una''s override row (RLS does not isolate per user here)');
select is((public.get_request_context()->'memberships'->0->'user_overrides'),
  '[{"granted": true, "permission": "audit:read"}]'::jsonb,
  'yet her context holds ONLY her own user override: una''s grant is not merged into an admin');
select is((public.get_request_context()->'memberships'->0->'role_overrides'), '[]'::jsonb,
  'a role with no overrides gives an empty list, not null');

-- ── 2c. accepted_at is the FUNCTION's predicate, not only RLS's ─────────────
-- service_role bypasses row level security, so the pending invitation in org B
-- is visible to it. Only the function's own filter can keep it out.
set local role to postgres;
set local "request.jwt.claim.sub" to 'c0355000-0000-0000-0000-0000000000a1';
set local role to 'service_role';
select is((select jsonb_array_length(public.get_request_context()->'memberships')), 2,
  'with RLS out of the way una still has two memberships: the unaccepted invitation is excluded by the function');

-- ── 3. ben: the mirror image ────────────────────────────────────────────────
set local role to postgres;
set local "request.jwt.claim.sub" to 'c0355000-0000-0000-0000-0000000000b1';
set local role to 'authenticated';

select is(
  (select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0355000-0000-0000-0000-00000000000b"]'::jsonb,
  'ben sees org B and nothing else');
select is(
  (public.get_request_context()->'memberships'->0->'user_overrides'),
  '[{"granted": false, "permission": "reports:view"}]'::jsonb,
  'ben''s own user override');

-- ── 4. a disabled account still reads its own disabled_at ───────────────────
set local role to postgres;
update public.user_profiles set disabled_at = now() where id = :u_b;
set local role to 'authenticated';
select isnt((public.get_request_context()->'profile'->>'disabled_at'), null,
  'a disabled user''s context says so: the application gate depends on reading it');

-- ── 5. nobody signed in ─────────────────────────────────────────────────────
set local role to postgres;
set local "request.jwt.claim.sub" to '';
set local role to 'authenticated';
select is((public.get_request_context()->'profile'), 'null'::jsonb,
  'no caller: no profile');
select is((public.get_request_context()->'memberships'), '[]'::jsonb,
  'no caller: no memberships');

set local role to postgres;
select * from finish();
rollback;
