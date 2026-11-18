-- 0471: get_request_context() reads the caller's own rows by index, and its
-- answer is exactly what 0413's body answered, under the same row level
-- security, for every kind of caller.
--
-- The reference is 0413's body itself, copied below as a temporary SQL
-- function with the same settings. Every comparison runs both, as the same
-- role with the same claims, in one session that switches between callers,
-- so a plan kept from one caller is shown never to answer for another.
-- Made-up data only.
begin;
select plan(56);

-- ── The reference: 0413's body, verbatim ───────────────────────────────────
create function pg_temp.request_context_0413()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $ref$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'profile', (
      select jsonb_build_object(
               'id', p.id,
               'email', p.email,
               'full_name', p.full_name,
               'avatar_url', p.avatar_url,
               'default_organization_id', p.default_organization_id,
               'disabled_at', p.disabled_at)
        from public.user_profiles p
       where p.id = auth.uid()
    ),
    'memberships', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'organization_id', m.organization_id,
                 'role', m.role,
                 'organization', (
                   select jsonb_build_object(
                            'id', o.id,
                            'name', o.name,
                            'logo_url', o.logo_url,
                            'terminology', o.terminology,
                            'mfa_policy', o.mfa_policy,
                            'timezone', o.timezone,
                            'nav_overrides', o.nav_overrides,
                            'dashboard_layout', o.dashboard_layout,
                            'order_status_config', o.order_status_config,
                            'all_modules_comp', o.all_modules_comp,
                            'order_catalog_last_hide_at', o.order_catalog_last_hide_at)
                     from public.organizations o
                    where o.id = m.organization_id),
                 'role_overrides', coalesce((
                   select jsonb_agg(jsonb_build_object('permission', r.permission, 'granted', r.granted)
                                    order by r.permission)
                     from public.role_permission_overrides r
                    where r.organization_id = m.organization_id
                      and r.role = m.role), '[]'::jsonb),
                 'user_overrides', coalesce((
                   select jsonb_agg(jsonb_build_object('permission', u.permission, 'granted', u.granted)
                                    order by u.permission)
                     from public.user_permission_overrides u
                    where u.organization_id = m.organization_id
                      and u.user_id = m.user_id), '[]'::jsonb),
                 'enabled_modules', coalesce((
                   select jsonb_agg(om.module_id order by om.module_id)
                     from public.organization_modules om
                    where om.organization_id = m.organization_id
                      and om.enabled), '[]'::jsonb)
               )
               order by m.created_at, m.organization_id)
        from public.organization_members m
       where m.user_id = auth.uid()
         and m.accepted_at is not null
    ), '[]'::jsonb)
  );
$ref$;

-- Shared buffer reads of one call of `q`, run as the current role and claims.
create function pg_temp.buffer_hits(q text)
returns integer
language plpgsql
as $hits$
declare
  j json;
begin
  execute 'explain (analyze, buffers, format json) ' || q into j;
  return (j -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::integer;
end
$hits$;

-- ── Fixture ────────────────────────────────────────────────────────────────
-- Organizations: A..F, N (every nullable setting null, comped), and L, which
-- gets 300 members in section 7 (a whole-table read is then easy to see).
insert into public.organizations (id, name, slug, logo_url, nav_overrides, dashboard_layout, order_status_config, mfa_policy, all_modules_comp) values
  ('c0471000-0000-0000-0000-00000000000a', 'Org A 0471', 'org-a-0471', 'https://example.test/a.png',
     '{"v": 1, "hidden": ["/dashboard/reports"], "labels": {"/dashboard/inventory": "Stock"}}',
     '{"v": 1, "widgets": [{"id": "stat-row"}, {"id": "analytics", "hidden": true}]}',
     '{"pending": {"label": "Waiting", "color": "#aa5500", "sortOrder": 1}}', 'admins_required', false),
  ('c0471000-0000-0000-0000-00000000000b', 'Org B 0471', 'org-b-0471', null, null, null, null, 'optional', false),
  ('c0471000-0000-0000-0000-00000000000c', 'Org C 0471', 'org-c-0471', null, null, null, null, 'all_required', false),
  ('c0471000-0000-0000-0000-00000000000d', 'Org D 0471', 'org-d-0471', null, '{"v": 1}', null, null, 'optional', false),
  ('c0471000-0000-0000-0000-00000000000e', 'Org E 0471', 'org-e-0471', null, null, null, null, 'optional', false),
  ('c0471000-0000-0000-0000-00000000000f', 'Org F 0471', 'org-f-0471', null, null, null, null, 'optional', false),
  ('c0471000-0000-0000-0000-0000000000ee', 'Org N 0471', 'org-n-0471', null, null, null, null, 'optional', true),
  ('c0471000-0000-0000-0000-0000000000ff', 'Org L 0471', 'org-l-0471', null, null, null, null, 'optional', false);
update public.organizations set order_catalog_last_hide_at = '2026-11-01T10:00:00Z'
 where id = 'c0471000-0000-0000-0000-00000000000a';

insert into auth.users (id, email) values
  ('c0471000-0000-0000-0000-0000000000a1', 'una-0471@example.test'),
  ('c0471000-0000-0000-0000-0000000000b1', 'ben-0471@example.test'),
  ('c0471000-0000-0000-0000-0000000000ad', 'ada-0471@example.test'),
  ('c0471000-0000-0000-0000-0000000000d1', 'dee-0471@example.test'),
  ('c0471000-0000-0000-0000-0000000000c1', 'sam-0471@example.test'),
  ('c0471000-0000-0000-0000-0000000000e1', 'nia-0471@example.test'),
  ('c0471000-0000-0000-0000-0000000000f1', 'tia-0471@example.test'),
  ('c0471000-0000-0000-0000-000000000001', 'noa-0471@example.test'),
  ('c0471000-0000-0000-0000-000000000002', 'gus-0471@example.test');
-- gus has a sign-in account and no profile row.
delete from public.user_profiles where id = 'c0471000-0000-0000-0000-000000000002';
update public.user_profiles set default_organization_id = 'c0471000-0000-0000-0000-00000000000c',
                                full_name = 'Una Example', avatar_url = 'https://example.test/una.png'
 where id = 'c0471000-0000-0000-0000-0000000000a1';

insert into public.organization_members (organization_id, user_id, role, accepted_at, created_at, impersonation_expires_at) values
  -- una: manager in A (oldest), viewer in C, staff in D; invited to B, not accepted.
  ('c0471000-0000-0000-0000-00000000000a', 'c0471000-0000-0000-0000-0000000000a1', 'manager', now(), now() - interval '3 days', null),
  ('c0471000-0000-0000-0000-00000000000c', 'c0471000-0000-0000-0000-0000000000a1', 'viewer',  now(), now() - interval '2 days', null),
  ('c0471000-0000-0000-0000-00000000000d', 'c0471000-0000-0000-0000-0000000000a1', 'staff',   now(), now() - interval '1 day', null),
  ('c0471000-0000-0000-0000-00000000000b', 'c0471000-0000-0000-0000-0000000000a1', 'admin',   null,  now() - interval '4 days', null),
  -- ben: staff in B only.
  ('c0471000-0000-0000-0000-00000000000b', 'c0471000-0000-0000-0000-0000000000b1', 'staff',   now(), now(), null),
  -- ada: admin in A (row level security shows her every member's override rows there).
  ('c0471000-0000-0000-0000-00000000000a', 'c0471000-0000-0000-0000-0000000000ad', 'admin',   now(), now() - interval '5 days', null),
  -- dee: an accepted member of A whose account is disabled.
  ('c0471000-0000-0000-0000-00000000000a', 'c0471000-0000-0000-0000-0000000000d1', 'manager', now(), now() - interval '5 days', null),
  -- sam: plain member of F; an Act-as seat in E that is still live, one in C that has expired.
  ('c0471000-0000-0000-0000-00000000000f', 'c0471000-0000-0000-0000-0000000000c1', 'viewer',  now(), now() - interval '6 days', null),
  ('c0471000-0000-0000-0000-00000000000e', 'c0471000-0000-0000-0000-0000000000c1', 'admin',   now(), now() - interval '7 days', now() + interval '1 hour'),
  ('c0471000-0000-0000-0000-00000000000c', 'c0471000-0000-0000-0000-0000000000c1', 'admin',   now(), now() - interval '8 days', now() - interval '1 hour'),
  -- nia: owner of N (every nullable setting null, comped).
  ('c0471000-0000-0000-0000-0000000000ee', 'c0471000-0000-0000-0000-0000000000e1', 'owner',   now(), now(), null),
  -- tia: two memberships made at the same moment; the organization id breaks the tie.
  ('c0471000-0000-0000-0000-00000000000f', 'c0471000-0000-0000-0000-0000000000f1', 'staff',   now(), '2026-10-01T00:00:00Z', null),
  ('c0471000-0000-0000-0000-00000000000e', 'c0471000-0000-0000-0000-0000000000f1', 'viewer',  now(), '2026-10-01T00:00:00Z', null);

insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  ('c0471000-0000-0000-0000-00000000000a', 'manager', 'items:delete', false),
  ('c0471000-0000-0000-0000-00000000000a', 'manager', 'items:export', true),
  ('c0471000-0000-0000-0000-00000000000a', 'staff',   'items:update', false),
  ('c0471000-0000-0000-0000-00000000000b', 'staff',   'orders:approve', true),
  ('c0471000-0000-0000-0000-00000000000c', 'viewer',  'items:export', true),
  ('c0471000-0000-0000-0000-00000000000c', 'admin',   'audit:read', false),
  ('c0471000-0000-0000-0000-00000000000e', 'admin',   'items:import', true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  ('c0471000-0000-0000-0000-00000000000a', 'c0471000-0000-0000-0000-0000000000a1', 'items:delete', true),
  ('c0471000-0000-0000-0000-00000000000a', 'c0471000-0000-0000-0000-0000000000a1', 'audit:read', false),
  ('c0471000-0000-0000-0000-00000000000a', 'c0471000-0000-0000-0000-0000000000ad', 'reports:view', true),
  ('c0471000-0000-0000-0000-00000000000b', 'c0471000-0000-0000-0000-0000000000b1', 'reports:view', false),
  ('c0471000-0000-0000-0000-00000000000c', 'c0471000-0000-0000-0000-0000000000a1', 'items:import', true),
  ('c0471000-0000-0000-0000-00000000000e', 'c0471000-0000-0000-0000-0000000000c1', 'items:export', true),
  ('c0471000-0000-0000-0000-0000000000ee', 'c0471000-0000-0000-0000-0000000000e1', 'items:export', false);
update public.organization_modules set enabled = (module_id in ('books', 'orders'))
 where organization_id = 'c0471000-0000-0000-0000-00000000000a';
update public.organization_modules set enabled = false
 where organization_id = 'c0471000-0000-0000-0000-00000000000d';
update public.user_profiles set disabled_at = now() where id = 'c0471000-0000-0000-0000-0000000000d1';

-- ── 1. The function, as the catalog sees it ─────────────────────────────────
select ok(not (select prosecdef from pg_proc where oid = 'public.get_request_context()'::regprocedure),
  'SECURITY INVOKER: it reads under the caller''s row level security');
select is((select provolatile::text from pg_proc where oid = 'public.get_request_context()'::regprocedure), 's',
  'STABLE: PostgREST may serve it from a read-only transaction');
select is((select l.lanname::text from pg_proc p join pg_language l on l.oid = p.prolang
            where p.oid = 'public.get_request_context()'::regprocedure), 'plpgsql',
  'PL/pgSQL: its plan is kept for the connection');
select is((select array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_request_context()'::regprocedure),
  'search_path=public, pg_temp', 'search_path is pinned to public, pg_temp');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.get_request_context()'::regprocedure),
  'postgres', 'owned by postgres');
select ok(not has_function_privilege('public', 'public.get_request_context()', 'execute'), 'public holds no EXECUTE');
select ok(not has_function_privilege('anon', 'public.get_request_context()', 'execute'), 'anon holds no EXECUTE');
select ok(has_function_privilege('authenticated', 'public.get_request_context()', 'execute'), 'authenticated holds EXECUTE');
select ok(has_function_privilege('service_role', 'public.get_request_context()', 'execute'), 'service_role holds EXECUTE');
select is((select pg_get_function_result(oid) from pg_proc where oid = 'public.get_request_context()'::regprocedure),
  'jsonb', 'returns jsonb, takes no argument');

-- ── 2. anon is refused ──────────────────────────────────────────────────────
set local role to anon;
select throws_ok('select public.get_request_context()', '42501', null, 'anon cannot call it');
set local role to postgres;

-- ── 3. The same answer as 0413's body, caller after caller ─────────────────
-- Callers are named as PostgREST names them (request.jwt.claims), with one
-- case through the older request.jwt.claim.sub. This file runs in its own
-- session, and the first calls of get_request_context() in it are made as
-- service_role and as postgres (both bypass row level security), so the
-- first plan the session keeps is one made without the policies. The calls
-- as authenticated that follow must still be held to them, and a plan kept
-- in this session serves every caller after that.
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000c1", "role": "authenticated"}';
set local role to service_role;
select is((select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000c", "c0471000-0000-0000-0000-00000000000e", "c0471000-0000-0000-0000-00000000000f"]'::jsonb,
  'first call of the session, as service_role (no policies): sam''s expired Act-as seat in C is there');
select is(public.get_request_context(), pg_temp.request_context_0413(), 'as service_role: same answer as 0413''s body');
set local role to postgres;
select is(public.get_request_context(), pg_temp.request_context_0413(), 'as postgres (no policies): same answer as 0413''s body');
set local role to authenticated;
select is((select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000e", "c0471000-0000-0000-0000-00000000000f"]'::jsonb,
  'then as authenticated in the same session: the policy hides the expired seat again');
select is(public.get_request_context(), pg_temp.request_context_0413(), 'as authenticated after them: same answer as 0413''s body');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'una (three organizations, one invitation not accepted, overrides, a default organization): same answer');
set local role to postgres;
set local "request.jwt.claims" to '';
set local "request.jwt.claim.sub" to 'c0471000-0000-0000-0000-0000000000b1';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'ben (one organization), named by the older request.jwt.claim.sub: same answer');
set local role to postgres;
set local "request.jwt.claim.sub" to '';
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000ad", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'ada (an admin who can read other members'' override rows): same answer');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000d1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'dee (disabled account): same answer');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000c1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'sam (a live Act-as seat and an expired one): same answer');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000e1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'nia (an organization with every nullable setting null): same answer');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000f1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'tia (two memberships made at the same moment): same answer');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-000000000001", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'noa (no membership): same answer');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-000000000002", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(),
  'gus (no profile row): same answer');
set local role to postgres;
set local "request.jwt.claims" to '';
set local role to authenticated;
select is(public.get_request_context(), pg_temp.request_context_0413(), 'nobody signed in: same answer');
select is(public.get_request_context(),
  '{"user_id": null, "profile": null, "memberships": []}'::jsonb, 'nobody signed in: no profile and no membership');

-- ── 4. What the answer says, read directly ──────────────────────────────────
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
set local role to authenticated;
create temp table una on commit drop as select public.get_request_context() as ctx;
select is((select jsonb_agg(m->>'organization_id') from una, jsonb_array_elements(ctx->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000a", "c0471000-0000-0000-0000-00000000000c", "c0471000-0000-0000-0000-00000000000d"]'::jsonb,
  'una: her three accepted memberships, oldest first; the invitation to B is not one');
select is((select array_agg(k) from una, jsonb_object_keys(ctx) k), array['profile', 'user_id', 'memberships'],
  'the top level keys, in jsonb order');
select is((select array_agg(k) from una, jsonb_object_keys(ctx->'memberships'->0) k),
  array['role', 'organization', 'role_overrides', 'user_overrides', 'enabled_modules', 'organization_id'],
  'a membership''s keys');
select is((select ctx->'memberships'->0->'role_overrides' from una),
  '[{"granted": false, "permission": "items:delete"}, {"granted": true, "permission": "items:export"}]'::jsonb,
  'una in A: the overrides of her role there, ordered by permission');
select is((select ctx->'memberships'->0->'user_overrides' from una),
  '[{"granted": false, "permission": "audit:read"}, {"granted": true, "permission": "items:delete"}]'::jsonb,
  'una in A: her own overrides, ordered by permission');
select is((select ctx->'memberships'->0->'enabled_modules' from una), '["books", "orders"]'::jsonb,
  'una in A: the enabled modules, ordered');
select is((select ctx->'memberships'->2->'enabled_modules' from una), '[]'::jsonb,
  'una in D: no module enabled gives an empty list');
select is((select ctx->'memberships'->0->'organization'->>'order_catalog_last_hide_at' from una),
  '2026-11-01T10:00:00+00:00', 'the hide mark of A');
select ok((select ctx::text not like '%c0471000-0000-0000-0000-00000000000b%' and ctx::text not like '%reports:view%'
             and ctx::text not like '%orders:approve%' from una),
  'nothing of B, and no other member''s override');

-- ── 5. Row level security still decides ─────────────────────────────────────
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000d1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context()->'memberships', '[]'::jsonb,
  'dee: her accepted membership is hidden by row level security (disabled account)');
select isnt(public.get_request_context()->'profile'->>'disabled_at', null,
  'dee: her own profile still says she is disabled');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000c1", "role": "authenticated"}';
set local role to authenticated;
select is((select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000e", "c0471000-0000-0000-0000-00000000000f"]'::jsonb,
  'sam: the expired Act-as seat in C is hidden by row level security; the live seat in E is not');
set local role to service_role;
select is((select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000c", "c0471000-0000-0000-0000-00000000000e", "c0471000-0000-0000-0000-00000000000f"]'::jsonb,
  'the same call as service_role, which bypasses row level security, also returns C: it is the policy that hides it (invoker rights)');
select is(public.get_request_context(), pg_temp.request_context_0413(), 'as service_role: same answer as 0413''s body');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000c1", "role": "authenticated"}';
set local role to authenticated;
select is((select jsonb_array_length(public.get_request_context()->'memberships')), 2,
  'back as authenticated in the same session, the policy applies again (no plan kept across roles)');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000ad", "role": "authenticated"}';
set local role to authenticated;
select ok((select count(*) from public.user_permission_overrides
            where organization_id = 'c0471000-0000-0000-0000-00000000000a'
              and user_id <> 'c0471000-0000-0000-0000-0000000000ad') >= 2,
  'fixture: as an admin, ada can read una''s override rows');
select is(public.get_request_context()->'memberships'->0->'user_overrides',
  '[{"granted": true, "permission": "reports:view"}]'::jsonb,
  'yet ada''s context holds only her own user override');
set local role to postgres;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
set local role to authenticated;
select is((select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000b"]'::jsonb, 'ben: B only, never another member''s memberships');

-- ── 6. Read afresh on every call: a change bites on the next one ───────────
set local role to postgres;
set local "request.jwt.claims" to '';
update public.organization_members set role = 'staff'
 where organization_id = 'c0471000-0000-0000-0000-00000000000a' and user_id = 'c0471000-0000-0000-0000-0000000000a1';
delete from public.organization_members
 where organization_id = 'c0471000-0000-0000-0000-00000000000c' and user_id = 'c0471000-0000-0000-0000-0000000000a1';
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
set local role to authenticated;
select is(public.get_request_context()->'memberships'->0->>'role', 'staff', 'una''s new role in A, on the next call');
select is(public.get_request_context()->'memberships'->0->'role_overrides',
  '[{"granted": false, "permission": "items:update"}]'::jsonb, 'and the overrides of her new role');
select is((select jsonb_agg(m->>'organization_id') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '["c0471000-0000-0000-0000-00000000000a", "c0471000-0000-0000-0000-00000000000d"]'::jsonb,
  'her removal from C, on the next call');
select is(public.get_request_context(), pg_temp.request_context_0413(), 'after the changes: same answer as 0413''s body');

-- A policy change made by another role while this session keeps its plan:
-- org_modules_read is narrowed to nothing, then put back as it was. The next
-- call after each change follows it (a policy change replaces a kept plan).
set local role to postgres;
create temp table modules_policy on commit drop as
  select qual from pg_policies
   where schemaname = 'public' and tablename = 'organization_modules' and policyname = 'org_modules_read';
alter policy org_modules_read on public.organization_modules using (false);
set local role to authenticated;
select is((select jsonb_agg(m->'enabled_modules') from jsonb_array_elements(public.get_request_context()->'memberships') m),
  '[[], []]'::jsonb, 'with the module policy narrowed to nothing, the next call shows no enabled module');
select is(public.get_request_context(), pg_temp.request_context_0413(), 'narrowed: same answer as 0413''s body');
set local role to postgres;
do $restore_policy$
begin
  execute format('alter policy org_modules_read on public.organization_modules using (%s)',
                 (select qual from modules_policy));
end
$restore_policy$;
set local role to authenticated;
select is(public.get_request_context()->'memberships'->0->'enabled_modules', '["books", "orders"]'::jsonb,
  'with the policy put back, the next call shows A''s enabled modules again');
select is(public.get_request_context(), pg_temp.request_context_0413(), 'put back: same answer as 0413''s body');

-- ── 7. Her own rows by index, not every member's row through the policy ────
-- una joins L, with 300 other members. Reading every membership and
-- profile row through the policies costs thousands of buffer reads; reading
-- her own rows by index costs a few hundred. The tables are analyzed, as
-- autovacuum keeps them. The 0471 body is measured warm, the least of three
-- calls (a call that plans again after a cache invalidation reads the
-- catalog too); 0413's body plans on every call, and is measured once.
set local role to postgres;
set local "request.jwt.claims" to '';
insert into auth.users (id, email)
select ('c0471000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid, 'filler-' || g || '-0471@example.test'
  from generate_series(1, 300) g;
insert into public.organization_members (organization_id, user_id, role, accepted_at, created_at)
select 'c0471000-0000-0000-0000-0000000000ff', ('c0471000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid,
       'staff', now(), now() - (g || ' minutes')::interval
  from generate_series(1, 300) g;
insert into public.organization_members (organization_id, user_id, role, accepted_at, created_at)
values ('c0471000-0000-0000-0000-0000000000ff', 'c0471000-0000-0000-0000-0000000000a1', 'viewer', now(), now());
analyze public.organization_members, public.user_profiles;
set local "request.jwt.claims" to '{"sub": "c0471000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
set local role to authenticated;
create temp table hits on commit drop as
select (select min(pg_temp.buffer_hits('select public.get_request_context()')) from generate_series(1, 3)) as new_body,
       pg_temp.buffer_hits('select pg_temp.request_context_0413()') as reference;
select diag('buffers per call: 0471 body ' || new_body || ', 0413 body ' || reference) from hits;
select cmp_ok((select new_body from hits), '<', 1000,
  'una''s context reads under 1,000 buffers with 300 other members in one of her organizations');
select cmp_ok((select reference from hits), '>', (select 5 * new_body from hits),
  'the same answer through 0413''s body reads over five times as many (the measure tells the two apart)');
select cmp_ok((select reference from hits), '>', 6000,
  'and over 6,000: every member''s row went through the policy');

set local role to postgres;
select * from finish();
rollback;
