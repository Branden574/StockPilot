-- supabase/tests/0310_rls_blocks_disabled_accounts.test.sql
-- Proves migration 0310: a disabled account is refused by RLS itself, so a
-- still-valid access token cannot read or write through PostgREST.
--
-- WHY THIS TEST EXISTS
--   0308 added user_profiles.disabled_at and 0309 pinned it, but NO RLS policy
--   consulted it. The membership gate helpers keyed only on
--   organization_members.accepted_at, so for as long as a disabled user's JWT
--   stayed signature-valid (supabase/config.toml jwt_expiry = 3600 locally) they
--   could POST/PATCH/DELETE straight at /rest/v1 and RLS would authorize it.
--   The app-layer chokepoints never see that traffic — PostgREST is not the
--   Next.js server. This file is the regression gate on the DB-side close.
--
-- WHAT IS ACTUALLY COVERED, and why it is more than two functions
--   The adversarial finding named is_org_member and has_org_role. Those two do
--   carry the most policies (133 and 72 here), but they are NOT the whole gate:
--     - has_permission (43 policies) is an independent membership gate;
--     - inventory_items_select does not reference any of the three — the read
--       path runs entirely through rls_inv_read_* / rls_cat_*;
--     - user_can_access_warehouse is the SOLE gate on all four verbs of
--       `rentals` and `rental_lines`.
--   Guarding only the two named helpers would have left SELECT on the largest
--   table in the product, and full CRUD on rentals, wide open. Every STABLE
--   membership helper is therefore asserted here one at a time.
--
-- HOW THE ROLES ARE SIMULATED
--   Same convention as 0309: `set local role` to the real Postgres role
--   PostgREST switches into, plus request.jwt.claim.sub so auth.uid() resolves.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(65);

\set org     '\'03100000-0000-0000-0000-000000000001\''
\set wh      '\'03100000-0000-0000-0000-0000000000b1\''
\set u_mgr   '\'03100000-0000-0000-0000-0000000000a1\''
\set u_peer  '\'03100000-0000-0000-0000-0000000000a2\''
\set item    '\'03100000-0000-0000-0000-0000000000c1\''
\set rental  '\'03100000-0000-0000-0000-0000000000e1\''
\set sview   '\'03100000-0000-0000-0000-0000000000f1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgr,  'mgr@ad10.test',  '{"full_name":"Disable Subject"}'::jsonb),
  (:u_peer, 'peer@ad10.test', '{"full_name":"Unaffected Peer"}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan)
values (:org, 'AD10 Org', 'ad10-org', 'UTC', 'USD', 'pro');

insert into public.warehouses (id, organization_id, name, code, status)
values (:wh, :org, 'AD10 WH', 'AD10', 'active');

-- The subject is an ADMIN, not a manager: inventory_items_delete requires
-- has_org_role(admin) or the items:delete permission, and `manager` holds
-- neither by default. A manager subject would fail the ACTIVE-DELETE assertion
-- for a reason that has nothing to do with this migration, and would hide
-- whether 0310 actually changed DELETE behaviour. The peer is left a manager on
-- purpose, so the unaffected-colleague check also covers a second role.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :u_mgr,  'admin',   now()),
  (:org, :u_peer, 'manager', now());

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name)
values (:item, :org, :wh, 'AD10-SKU-1', 'AD10 Item');

insert into public.rentals
  (id, organization_id, warehouse_id, borrower_name, checked_out_at, expected_return_at, status)
values (:rental, :org, :wh, 'AD10 Borrower', now(), now() + interval '7 days', 'out');

-- ── 1. Structure: the helper is STABLE, SECURITY DEFINER, search_path pinned ─
-- Volatility is load-bearing, not cosmetic. A VOLATILE helper cannot be folded
-- or cached by the planner and would be re-executed in contexts a STABLE one is
-- not, which is the difference between a cheap check and a per-row disaster.
select has_function('public', 'account_is_disabled', array['uuid'],
  'account_is_disabled(uuid) exists');

select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'account_is_disabled'),
  's',
  'account_is_disabled is STABLE (not VOLATILE) so the planner may evaluate it once'
);

select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'account_is_disabled'),
  'account_is_disabled is SECURITY DEFINER — it must read user_profiles past RLS'
);

select ok(
  (select p.proconfig::text like '%search_path%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'account_is_disabled'),
  'account_is_disabled pins search_path'
);

-- A null user id is NOT disabled. This is what keeps service_role — which has no
-- request.jwt.claim.sub, so auth.uid() is null — out of the guard entirely.
select ok(
  not public.account_is_disabled(null),
  'account_is_disabled(null) is FALSE — service_role and anon are never caught by the guard'
);

-- Absence of a profile row is an ONBOARDING state, not a disable. Collapsing the
-- two would lock out every user between signup and profile creation.
select ok(
  not public.account_is_disabled('03100000-0000-0000-0000-00000000dead'),
  'a user with no profile row reads ACTIVE, not disabled'
);

-- ── 1b. Nobody request-facing may call the predicate DIRECTLY ──────────────
-- The first cut granted EXECUTE to authenticated, anon and service_role, which
-- (because Postgres also grants EXECUTE to PUBLIC on every new function, and a
-- later GRANT does not subtract that) left an UNAUTHENTICATED per-uuid oracle:
-- anyone holding the publishable key that ships in the web bundle and the mobile
-- binary could POST /rest/v1/rpc/account_is_disabled and read a named person's
-- disable timeline, against a table whose every policy is `to authenticated`.
--
-- Both halves are asserted: the direct call is refused, AND section 2 below —
-- which runs after this revoke — proves every guarded helper still answers
-- correctly for an authenticated caller. The helpers are SECURITY DEFINER owned
-- by postgres, so the nested call is checked against the DEFINER, not the
-- request role. That inheritance is the thing this revoke depends on, so it is
-- proven rather than assumed.
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.account_is_disabled(uuid)'::regprocedure
      and a.grantee = 0            -- grantee 0 is PUBLIC
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC holds no EXECUTE on account_is_disabled — the implicit grant was revoked'
);
select ok(
  not has_function_privilege('anon', 'public.account_is_disabled(uuid)', 'EXECUTE'),
  'anon holds no EXECUTE on account_is_disabled'
);
select ok(
  not has_function_privilege('authenticated', 'public.account_is_disabled(uuid)', 'EXECUTE'),
  'authenticated holds no EXECUTE either — the same call answers for uuids outside the caller''s orgs'
);
select ok(
  has_function_privilege('service_role', 'public.account_is_disabled(uuid)', 'EXECUTE'),
  'service_role keeps EXECUTE, for operator SQL'
);

-- DO NOT turn the next two into `throws_ok(..., '42501')`. On the Supabase CLI
-- local image (postgres 17, CLI 2.98.2) ANY function-permission denial raised
-- under a `set local role` SEGFAULTS the backend — `signal 11` in the container
-- log, the whole cluster restarts, and every later test file in the run dies
-- with "the database system is in recovery mode". Verified to be an image bug
-- and nothing to do with this migration: it reproduces identically on
-- rls_member_org_ids() (which anon has never held EXECUTE on, untouched by this
-- branch) and on a freshly created plain SQL function with its PUBLIC grant
-- revoked. So the refusal is asserted through the privilege system itself,
-- evaluated from INSIDE each role, which is the same authority Postgres uses at
-- call time and does not crash.
set local role to 'anon';
select ok(
  not has_function_privilege(current_user, 'public.account_is_disabled(uuid)', 'EXECUTE'),
  'anon, asked as itself, is NOT permitted to call the oracle'
);
reset role;

set local "request.jwt.claim.sub" to '03100000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(
  not has_function_privilege(current_user, 'public.account_is_disabled(uuid)', 'EXECUTE'),
  'an authenticated caller, asked as itself, is NOT permitted to probe an arbitrary uuid'
);
reset role;

-- service_role is a real call, not a catalog question: the keep-grant has to
-- actually work for operator SQL.
set local role to 'service_role';
select lives_ok(
  $$select public.account_is_disabled('03100000-0000-0000-0000-0000000000a1')$$,
  'service_role can still call it'
);
reset role;

-- ── 2. ACTIVE user: every gate helper answers exactly as it did before ───────
set local "request.jwt.claim.sub" to '03100000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select ok(public.is_org_member(:org),                     'ACTIVE: is_org_member true');
select ok(public.has_org_role(:org, 'staff'),             'ACTIVE: has_org_role(staff) true');
select ok(public.has_permission(:org, 'items:create'),    'ACTIVE: has_permission true');
select is(public.user_org_role(:org), 'admin',            'ACTIVE: user_org_role returns the role');
select ok(public.user_can_access_warehouse(:u_mgr, :wh, 'write'),
                                                          'ACTIVE: user_can_access_warehouse true');
select ok(exists(select 1 from public.rls_member_org_ids() x where x = :org),
                                                          'ACTIVE: rls_member_org_ids includes the org');
select ok(exists(select 1 from public.rls_manager_org_ids() x where x = :org),
                                                          'ACTIVE: rls_manager_org_ids includes the org');
select ok(exists(select 1 from public.rls_orgs_with_permission('items:read') x where x = :org),
                                                          'ACTIVE: rls_orgs_with_permission includes the org');
select ok(exists(select 1 from public.rls_inv_read_full_warehouse_ids() x where x = :wh),
                                                          'ACTIVE: rls_inv_read_full_warehouse_ids includes the warehouse');
select ok(exists(select 1 from public.rls_cat_unrestricted_org_ids() x where x = :org),
                                                          'ACTIVE: rls_cat_unrestricted_org_ids includes the org');
select ok(exists(select 1 from public.my_warehouse_ids() x where x = :wh),
                                                          'ACTIVE: my_warehouse_ids includes the warehouse');
reset role;

-- ── 3. ACTIVE user: all four verbs work end to end ──────────────────────────
set local role to 'authenticated';
select is((select count(*) from public.inventory_items where id = :item), 1::bigint,
  'ACTIVE: SELECT sees the item');
select lives_ok(
  $$insert into public.inventory_items (organization_id, warehouse_id, sku, name)
    values ('03100000-0000-0000-0000-000000000001','03100000-0000-0000-0000-0000000000b1',
            'AD10-ACTIVE-INS','Active Insert')$$,
  'ACTIVE: INSERT is allowed');
update public.inventory_items set name = 'Renamed While Active' where id = :item;
select is((select name from public.inventory_items where id = :item), 'Renamed While Active',
  'ACTIVE: UPDATE applied');
delete from public.inventory_items where sku = 'AD10-ACTIVE-INS';
select is((select count(*) from public.inventory_items where sku = 'AD10-ACTIVE-INS'), 0::bigint,
  'ACTIVE: DELETE applied');
select is((select count(*) from public.rentals where id = :rental), 1::bigint,
  'ACTIVE: SELECT on rentals (user_can_access_warehouse sole gate) sees the row');

-- saved_views reaches NO membership helper on its own — its write policies were
-- a bare `user_id = auth.uid()`, so guarding the fifteen helpers did not touch
-- it. 0037's is_shared makes a row visible to the WHOLE org, so this is not a
-- private preferences table; 0310 now ANDs is_org_member(organization_id) into
-- all three write policies. Active behaviour must be unchanged.
select lives_ok(
  $$insert into public.saved_views (id, organization_id, user_id, name, scope, is_shared)
    values ('03100000-0000-0000-0000-0000000000f1','03100000-0000-0000-0000-000000000001',
            '03100000-0000-0000-0000-0000000000a1','AD10 Shared View','inventory',true)$$,
  'ACTIVE: INSERT of an org-shared saved_view is allowed');
select is((select count(*) from public.saved_views where id = :sview), 1::bigint,
  'ACTIVE: the shared saved_view exists');
reset role;

-- ── 4. Disable the account, exactly the way the service does ────────────────
set local role to 'service_role';
update public.user_profiles
   set disabled_at = now(), disabled_reason = 'policy_violation'
 where id = :u_mgr;
reset role;

-- ── 5. DISABLED user: every gate helper now refuses ─────────────────────────
set local role to 'authenticated';   -- still request.jwt.claim.sub = u_mgr

select ok(not public.is_org_member(:org),                  'DISABLED: is_org_member false');
select ok(not public.has_org_role(:org, 'staff'),          'DISABLED: has_org_role false');
select ok(not public.has_permission(:org, 'items:create'), 'DISABLED: has_permission false');
select is(public.user_org_role(:org), null,                'DISABLED: user_org_role returns null');
select ok(not public.user_can_access_warehouse(:u_mgr, :wh, 'write'),
                                                           'DISABLED: user_can_access_warehouse false');
select is((select count(*) from public.rls_member_org_ids()), 0::bigint,
                                                           'DISABLED: rls_member_org_ids is empty');
select is((select count(*) from public.rls_manager_org_ids()), 0::bigint,
                                                           'DISABLED: rls_manager_org_ids is empty');
select is((select count(*) from public.rls_orgs_with_permission('items:read')), 0::bigint,
                                                           'DISABLED: rls_orgs_with_permission is empty');
select is((select count(*) from public.rls_inv_read_full_warehouse_ids()), 0::bigint,
                                                           'DISABLED: rls_inv_read_full_warehouse_ids is empty');
select is((select count(*) from public.rls_cat_unrestricted_org_ids()), 0::bigint,
                                                           'DISABLED: rls_cat_unrestricted_org_ids is empty');
select is((select count(*) from public.my_warehouse_ids()), 0::bigint,
                                                           'DISABLED: my_warehouse_ids is empty');

-- ── 6. DISABLED user: all four verbs are refused ────────────────────────────
-- SELECT/UPDATE/DELETE fail by matching ZERO rows (that is how RLS refuses a
-- read-side qual); INSERT fails loudly, because a WITH CHECK violation raises.
select is((select count(*) from public.inventory_items where id = :item), 0::bigint,
  'DISABLED: SELECT returns nothing');

select throws_ok(
  $$insert into public.inventory_items (organization_id, warehouse_id, sku, name)
    values ('03100000-0000-0000-0000-000000000001','03100000-0000-0000-0000-0000000000b1',
            'AD10-DISABLED-INS','Disabled Insert')$$,
  '42501',
  null,
  'DISABLED: INSERT is refused by RLS'
);

update public.inventory_items set name = 'Renamed While Disabled' where id = :item;
delete from public.inventory_items where id = :item;
select is((select count(*) from public.rentals where id = :rental), 0::bigint,
  'DISABLED: SELECT on rentals is refused — the sole-gate helper is guarded too');

-- The org-visible write class. A disabled user planting or re-sharing a
-- saved_view reaches every colleague's view list with a token the rest of the
-- product now refuses.
select throws_ok(
  $$insert into public.saved_views (organization_id, user_id, name, scope, is_shared)
    values ('03100000-0000-0000-0000-000000000001','03100000-0000-0000-0000-0000000000a1',
            'AD10 Planted View','inventory',true)$$,
  '42501', null,
  'DISABLED: planting an org-shared saved_view is refused');
update public.saved_views set name = 'Renamed While Disabled', is_shared = false
 where id = '03100000-0000-0000-0000-0000000000f1';
delete from public.saved_views where id = '03100000-0000-0000-0000-0000000000f1';
reset role;

-- Verified with RLS off: the UPDATE and DELETE above must have been no-ops, not
-- silently-applied writes. Asserting from inside the authenticated role would
-- prove nothing, because that role can no longer see the row either way.
select is((select name from public.inventory_items where id = :item), 'Renamed While Active',
  'DISABLED: the UPDATE changed NOTHING — the row still holds its pre-disable value');
select is((select count(*) from public.inventory_items where id = :item), 1::bigint,
  'DISABLED: the DELETE removed NOTHING — the row survives');
select is((select count(*) from public.inventory_items where sku = 'AD10-DISABLED-INS'), 0::bigint,
  'DISABLED: no row was inserted');

select is((select name from public.saved_views where id = :sview), 'AD10 Shared View',
  'DISABLED: the saved_view UPDATE changed NOTHING — it could not be renamed or un-shared');
select is((select count(*) from public.saved_views where id = :sview), 1::bigint,
  'DISABLED: the saved_view DELETE removed NOTHING');
select is((select count(*) from public.saved_views where name = 'AD10 Planted View'), 0::bigint,
  'DISABLED: no org-visible saved_view was planted');

-- ── 7. An unrelated ACTIVE member of the SAME org is untouched ──────────────
-- The guard must key on the CALLER, not on the org. If disabling one member
-- degraded their colleagues, this migration would be an outage.
set local "request.jwt.claim.sub" to '03100000-0000-0000-0000-0000000000a2';
set local role to 'authenticated';
select ok(public.is_org_member(:org),   'PEER: an active colleague still passes is_org_member');
select is((select count(*) from public.inventory_items where id = :item), 1::bigint,
  'PEER: an active colleague still SELECTs the item');
select lives_ok(
  $$update public.inventory_items set name = 'Peer Edit'
     where id = '03100000-0000-0000-0000-0000000000c1'$$,
  'PEER: an active colleague can still UPDATE');
reset role;
select is((select name from public.inventory_items where id = :item), 'Peer Edit',
  'PEER: the colleague''s UPDATE actually applied');

-- ── 8. service_role bypasses the guard entirely ─────────────────────────────
-- This is what keeps re-enable possible: the disable service writes
-- user_profiles through createAdminClient WHILE the user is disabled.
set local role to 'service_role';
select is((select count(*) from public.inventory_items where id = :item), 1::bigint,
  'SERVICE_ROLE: still reads the disabled user''s org data');
select lives_ok(
  $$update public.user_profiles set disabled_reason = 'reviewed'
     where id = '03100000-0000-0000-0000-0000000000a1'$$,
  'SERVICE_ROLE: can still write the disabled user''s profile');
reset role;

-- ── 9. Re-enable restores access ────────────────────────────────────────────
set local role to 'service_role';
update public.user_profiles
   set disabled_at = null, disabled_reason = null, disabled_by = null
 where id = :u_mgr;
reset role;

set local "request.jwt.claim.sub" to '03100000-0000-0000-0000-0000000000a1';
set local role to 'authenticated';
select ok(public.is_org_member(:org),                  'RE-ENABLED: is_org_member true again');
select ok(public.has_permission(:org, 'items:create'), 'RE-ENABLED: has_permission true again');
select is((select count(*) from public.inventory_items where id = :item), 1::bigint,
  'RE-ENABLED: SELECT works again');
select lives_ok(
  $$update public.inventory_items set name = 'Back In Business'
     where id = '03100000-0000-0000-0000-0000000000c1'$$,
  'RE-ENABLED: UPDATE works again');
select is((select count(*) from public.rentals where id = :rental), 1::bigint,
  'RE-ENABLED: the sole-gate rentals path works again');
select lives_ok(
  $$delete from public.saved_views where id = '03100000-0000-0000-0000-0000000000f1'$$,
  'RE-ENABLED: the owner can delete their own saved_view again');
reset role;
select is((select name from public.inventory_items where id = :item), 'Back In Business',
  'RE-ENABLED: the UPDATE actually applied');

select * from finish();
rollback;
