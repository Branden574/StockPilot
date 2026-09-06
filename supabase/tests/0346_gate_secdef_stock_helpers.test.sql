-- supabase/tests/0346_gate_secdef_stock_helpers.test.sql
-- Proves migration 0346: the three SECURITY DEFINER stock helpers that
-- `authenticated` must be able to execute now authorize themselves.
--
-- WHY THIS TEST EXISTS
--   On the 0345 head a VIEWER in a different org — is_org_member(victim) = f,
--   RLS SELECT of the holding = 0 rows — could call
--   apply_cycle_count_location_delta at POST /rest/v1/rpc and inflate a victim
--   rack 10 -> 5010, then drain it to 0, with quantity_on_hand untouched and
--   ZERO stock_movements rows (reproduced 2026-09-02 in a rolled-back
--   transaction). Assertions 5, 7, 8, 9, 18, 22 and 24 FAIL on that head and
--   pass after 0346. The legitimate paths (manager posting, service callers,
--   the 0188 warehouse trigger) are pinned so the gate cannot regress them.
--
-- HOW THE ROLES ARE SIMULATED
--   Gate assertions depend only on auth.uid(), never on RLS, so they run as the
--   test superuser with `set local "request.jwt.claim.sub"` — the same form
--   0331 uses; `set local role authenticated` + throws_ok is avoided (it
--   segfaulted local Postgres 17 during the 0345 work). An EMPTY sub claim
--   makes auth.uid() null, i.e. the service_role / postgres path.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(27);

\set orgA      '\'03460000-0000-0000-0000-00000000000a\''
\set orgB      '\'03460000-0000-0000-0000-00000000000b\''
\set u_vwr     '\'03460000-0000-0000-0000-0000000000a1\''
\set u_stf     '\'03460000-0000-0000-0000-0000000000a2\''
\set u_mgr     '\'03460000-0000-0000-0000-0000000000a3\''
\set u_out     '\'03460000-0000-0000-0000-0000000000b1\''
\set u_mgrB    '\'03460000-0000-0000-0000-0000000000b2\''
\set whA       '\'03460000-0000-0000-0000-0000000000c1\''
\set rackA     '\'03460000-0000-0000-0000-0000000000c2\''
\set itemA     '\'03460000-0000-0000-0000-0000000000c3\''
\set whNew     '\'03460000-0000-0000-0000-0000000000c4\''
\set whMissing '\'03460000-0000-0000-0000-0000000000ff\''

-- ── Fixtures (superuser: RLS bypassed) ──────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_vwr,  'vwr-0346@test.local',  '{}'::jsonb),
  (:u_stf,  'stf-0346@test.local',  '{}'::jsonb),
  (:u_mgr,  'mgr-0346@test.local',  '{}'::jsonb),
  (:u_out,  'out-0346@test.local',  '{}'::jsonb),
  (:u_mgrB, 'mgrb-0346@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Gate Org A 0346', 'gate-org-a-0346'),
  (:orgB, 'Gate Org B 0346', 'gate-org-b-0346')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_vwr,  'viewer',  now()),
  (:orgA, :u_stf,  'staff',   now()),
  (:orgA, :u_mgr,  'manager', now()),
  (:orgB, :u_out,  'viewer',  now()),
  (:orgB, :u_mgrB, 'manager', now())
on conflict do nothing;

-- 0188 trigger seeds Staging + Unplaced for the warehouse (superuser here).
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'Gate WH A 0346', 'WH-0346-A', 'active')
on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rackA, :orgA, :whA, 'Rack A 0346', 'bin', 'rack')
on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, item_type) values
  (:itemA, :orgA, :whA, 'GATE-0346-A', 'Gated item', 10, 'active', 'none', 'product')
on conflict (id) do nothing;

-- 0199 seeds an Unplaced row; replace it with a literal rack holding of 10.
delete from public.item_stock_levels where item_id = :itemA;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :itemA, :rackA, 10);

-- ── 1. Structure: EXECUTE posture unchanged, gate present in the body ──────
select ok(
  has_function_privilege('authenticated', 'public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric)', 'execute'),
  '0346/1: authenticated RETAINS EXECUTE on apply_cycle_count_location_delta (post_cycle_count is SECURITY INVOKER and reaches it as the user)');
select ok(
  not has_function_privilege('anon', 'public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric)', 'execute'),
  '0346/2: anon holds no EXECUTE on apply_cycle_count_location_delta');
select ok(
  has_function_privilege('authenticated', 'public.ensure_org_placement_locations(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.ensure_warehouse_placement_locations(uuid)', 'execute'),
  '0346/3: authenticated RETAINS EXECUTE on both ensure_* helpers (apply_level_delta and receiving reach them as the user)');
select ok(
  (select p.prosrc ~* 'has_org_role' and p.prosrc ~* 'item_in_org' and p.prosrc ~* 'location_in_org'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_cycle_count_location_delta'),
  '0346/4: the delta helper gates on role AND proves item/location membership in its own body');

-- ── 2. apply_cycle_count_location_delta: outsiders and under-floor callers ─
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, 5000)$$, :itemA, :rackA, :orgA),
  '42501', 'forbidden',
  '0346/5: a viewer in ANOTHER org cannot inflate a victim rack (the reproduced attack)');
select is((select quantity from public.item_stock_levels where item_id = :itemA and location_id = :rackA), 10::numeric,
  '0346/6: the victim holding is untouched');
select throws_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, -5)$$, :itemA, :rackA, :orgA),
  '42501', 'forbidden',
  '0346/7: nor drain it');

set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, 5)$$, :itemA, :rackA, :orgA),
  '42501', 'forbidden',
  '0346/8: same-org STAFF is below the manager floor post_cycle_count itself enforces');

-- A manager of org B claiming p_org_id = B against org A''s item and rack: the
-- role check passes for B, so the membership conjuncts must refuse it.
set local "request.jwt.claim.sub" to :u_mgrB;
select throws_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, 5)$$, :itemA, :rackA, :orgB),
  '42501', 'cross_org',
  '0346/9: a manager of another org cannot pass their own org id against a foreign item/location');
select is((select count(*)::int from public.item_stock_levels where item_id = :itemA and organization_id = :orgB), 0,
  '0346/10: no holding tagged with the attacker org was written');

-- ── 3. The legitimate caller (a manager of the item''s org) still works ────
set local "request.jwt.claim.sub" to :u_mgr;
select lives_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, 5)$$, :itemA, :rackA, :orgA),
  '0346/11: a MANAGER of the org applies a positive delta');
select is((select quantity from public.item_stock_levels where item_id = :itemA and location_id = :rackA), 15::numeric,
  '0346/12: ... and the holding grew by 5');
select is(public.apply_cycle_count_location_delta(:itemA, :rackA, :orgA, -3), 0::numeric,
  '0346/13: a negative delta the location can absorb returns 0 (fully absorbed)');
select is((select quantity from public.item_stock_levels where item_id = :itemA and location_id = :rackA), 12::numeric,
  '0346/14: ... and the holding shrank by 3');
select is(public.apply_cycle_count_location_delta(:itemA, null, :orgA, 5), 5::numeric,
  '0346/15: the 0342 contract is unchanged — a null location returns the delta unapplied for the caller to route');

-- ── 4. Service / postgres callers (auth.uid() null) keep the historical path ─
set local "request.jwt.claim.sub" to '';
select lives_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, 1)$$, :itemA, :rackA, :orgA),
  '0346/16: a service connection (no sub claim) is not gated');
select is((select quantity from public.item_stock_levels where item_id = :itemA and location_id = :rackA), 13::numeric,
  '0346/17: ... and applied its delta');

-- ── 5. ensure_org_placement_locations ─────────────────────────────────────
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(
  format($$select public.ensure_org_placement_locations(%L)$$, :orgA),
  '42501', 'forbidden',
  '0346/18: an outsider cannot seed org-level buckets into a foreign org');
select is((select count(*)::int from public.locations where organization_id = :orgA and warehouse_id is null and kind in ('staging','unplaced')), 0,
  '0346/19: ... and nothing was written');
set local "request.jwt.claim.sub" to :u_vwr;
select lives_ok(
  format($$select public.ensure_org_placement_locations(%L)$$, :orgA),
  '0346/20: any accepted member (even a viewer) may seed them');
select is((select count(*)::int from public.locations where organization_id = :orgA and warehouse_id is null and kind in ('staging','unplaced')), 2,
  '0346/21: ... Staging + Unplaced now exist at org level');

-- ── 6. ensure_warehouse_placement_locations ───────────────────────────────
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(
  format($$select public.ensure_warehouse_placement_locations(%L)$$, :whA),
  '42501', 'forbidden',
  '0346/22: an outsider cannot seed buckets into a foreign warehouse');
set local "request.jwt.claim.sub" to :u_vwr;
select lives_ok(
  format($$select public.ensure_warehouse_placement_locations(%L)$$, :whA),
  '0346/23: a member may (idempotent — the 0188 trigger already seeded this warehouse)');
select throws_ok(
  format($$select public.ensure_warehouse_placement_locations(%L)$$, :whMissing),
  '42501', 'forbidden',
  '0346/24: NO EXISTENCE ORACLE — an unknown warehouse id is indistinguishable from a foreign one for a user');
set local "request.jwt.claim.sub" to '';
select lives_ok(
  format($$select public.ensure_warehouse_placement_locations(%L)$$, :whMissing),
  '0346/25: a service caller keeps the historical silent no-op for an unknown id');

-- ── 7. The 0188 warehouse trigger still seeds when a real member creates one ─
set local "request.jwt.claim.sub" to :u_mgr;
select lives_ok(
  format($$insert into public.warehouses (id, organization_id, name, code, status) values (%L, %L, 'Gate WH New 0346', 'WH-0346-N', 'active')$$, :whNew, :orgA),
  '0346/26: a manager creating a warehouse is not refused by the gate inside the trigger');
select is((select count(*)::int from public.locations where warehouse_id = :whNew and kind in ('staging','unplaced')), 2,
  '0346/27: ... and its Staging + Unplaced were seeded');

select * from finish();
rollback;
