-- supabase/tests/0331_ar2_warehouse_scope.test.sql
-- Proves migration 0331 — the AR-2 closure — in BOTH directions:
--
--   • NARROWING: item_stock_levels_select is warehouse-scoped for read-only
--     members. A viewer assigned ONE of two warehouses sees only that
--     warehouse's holdings plus the unscopable null-warehouse holding; a
--     zero-assignment viewer sees only the null-warehouse holding; a manager
--     sees everything; an outsider sees nothing.
--
--     HONEST PIN on staff: item_stock_levels_write (0202) is FOR ALL with a
--     staff USING floor, FOR ALL policies apply to SELECT too, and permissive
--     policies OR — so staff+ keep ORG-WIDE visibility through the write
--     policy. That coupling is what keeps the conditional-write RPC paths
--     working, so it is pinned here as intended behavior, not left implicit.
--
--   • RPC PARITY (the point of the whole change): as a whT1-scoped STAFF
--     caller, an adjust_stock draw that can only be satisfied by consuming
--     holdings in BOTH warehouses succeeds and leaves the literal expected
--     quantities — identical to pre-0331 behavior, because apply_level_delta
--     is now SECURITY DEFINER and its draw-down selection cannot be narrowed
--     by the caller's read scope. transfer_stock FROM a whT2 location (outside
--     the caller's assignment) also still works — its conditional UPDATE runs
--     under the unchanged FOR ALL write policy.
--
--   • STRUCTURE: apply_level_delta is SECURITY DEFINER with a pinned
--     search_path, closed to PUBLIC/anon, open to authenticated; and its
--     self-authorization gate refuses an org OUTSIDER and an in-org member
--     below the staff write floor (both 42501 'forbidden').
--
-- HOW THE ROLES ARE SIMULATED — house convention (0191/0282/0322/0327):
-- `set local role` + request.jwt.claim.sub. Gate assertions that do not
-- depend on RLS set only the jwt claim.
--
-- Namespace: 03310000. Wrapped in begin/rollback — nothing leaks.

begin;

-- Plan hand-count: 1 control + 8 narrowing (2..9) + 8 parity (10..17)
-- + 5 structure (18..22) + 2 gate (23..24) = 24.
select plan(24);

\set orgS    '\'03310000-0000-0000-0000-000000000001\''
\set orgF    '\'03310000-0000-0000-0000-000000000002\''
\set u_mgr   '\'03310000-0000-0000-0000-0000000000a1\''
\set u_vwr   '\'03310000-0000-0000-0000-0000000000a2\''
\set u_stf   '\'03310000-0000-0000-0000-0000000000a3\''
\set u_lone  '\'03310000-0000-0000-0000-0000000000a4\''
\set u_out   '\'03310000-0000-0000-0000-0000000000a5\''
\set whT1    '\'03310000-0000-0000-0000-0000000000b1\''
\set whT2    '\'03310000-0000-0000-0000-0000000000b2\''
\set locW1   '\'03310000-0000-0000-0000-0000000000e1\''
\set locW2   '\'03310000-0000-0000-0000-0000000000e2\''
\set locN    '\'03310000-0000-0000-0000-0000000000e3\''
\set itemA   '\'03310000-0000-0000-0000-0000000000c1\''
\set itemB   '\'03310000-0000-0000-0000-0000000000c2\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgr,  'mgr-0331@test.local',      '{}'::jsonb),
  (:u_vwr,  'viewer-0331@test.local',   '{}'::jsonb),
  (:u_stf,  'staff-0331@test.local',    '{}'::jsonb),
  (:u_lone, 'lone-0331@test.local',     '{}'::jsonb),
  (:u_out,  'outsider-0331@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgS, 'AR2 Scope Org 0331',   'ar2-scope-org-0331'),
  (:orgF, 'AR2 Foreign Org 0331', 'ar2-foreign-org-0331')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgS, :u_mgr,  'manager', now()),
  (:orgS, :u_vwr,  'viewer',  now()),
  (:orgS, :u_stf,  'staff',   now()),
  (:orgS, :u_lone, 'viewer',  now()),
  (:orgF, :u_out,  'manager', now())
on conflict do nothing;

-- The 0188 trigger auto-creates Staging + Unplaced per warehouse; they hold no
-- stock rows here, so every count below is controlled by explicit inserts.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whT1, :orgS, 'AR2 WH One 0331', 'WH1-0331', 'active'),
  (:whT2, :orgS, 'AR2 WH Two 0331', 'WH2-0331', 'active')
on conflict (id) do nothing;

-- The viewer and the staff member are scoped to whT1 ONLY. u_lone has zero
-- assignments. my_warehouse_ids() resolves staff/viewer through exactly these
-- rows (manager+ resolve to every warehouse in the org).
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:orgS, :u_vwr, :whT1),
  (:orgS, :u_stf, :whT1)
on conflict do nothing;

-- All three bins are kind = NULL (the 0292 placed shape). created_at is
-- staggered EXPLICITLY: apply_level_delta's placed loop orders by
-- l.created_at, and now() is transaction-stable, so without this the draw
-- order — and every literal pin below — would be nondeterministic.
-- locN is the DC4 shape: an org-level location with NO warehouse, which the
-- policy's null-warehouse disjunct must keep member-visible.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:locW1, :orgS, :whT1, 'AR2 Bin W1 0331', 'bin',       null, now() - interval '3 minutes'),
  (:locW2, :orgS, :whT2, 'AR2 Bin W2 0331', 'bin',       null, now() - interval '2 minutes'),
  (:locN,  :orgS, null,  'AR2 Site 0331',   'warehouse', null, now() - interval '1 minute')
on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemA, :orgS, :whT1, 'AR2-0331-A', 'Draw Item 0331',     12, 'active', 'none'),
  (:itemB, :orgS, :whT1, 'AR2-0331-B', 'Transfer Item 0331',  6, 'active', 'none')
on conflict (id) do nothing;

-- The 0199 trigger seeds an Unplaced row per item; clear and place explicitly
-- so every quantity below is a literal this file controls.
-- itemA: split across BOTH warehouses plus the null-warehouse Site (5+4+3=12).
-- itemB: its ONLY holding sits in whT2 — outside the staff caller's scope.
delete from public.item_stock_levels where item_id in (:itemA, :itemB);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgS, :itemA, :locW1, 5),
  (:orgS, :itemA, :locW2, 4),
  (:orgS, :itemA, :locN,  3),
  (:orgS, :itemB, :locW2, 6)
on conflict (item_id, location_id) do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 0. CONTROL (superuser): the fixture really holds 3 itemA rows summing 12,
--    so the narrowed counts below are not vacuous.
-- ══════════════════════════════════════════════════════════════════════════

select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int
     from public.item_stock_levels where item_id = :itemA),
  '3/12',
  'CONTROL: itemA holds exactly 3 level rows summing 12 (5 + 4 + 3)'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 1. NARROWING — direct SELECT per principal.
-- ══════════════════════════════════════════════════════════════════════════

-- A viewer assigned whT1 only: the whT1 row and the null-warehouse row.
set local "request.jwt.claim.sub" to :u_vwr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.item_stock_levels where item_id = :itemA),
  2::bigint,
  '0331: a whT1-scoped VIEWER sees exactly 2 of itemA''s 3 holdings (whT1 + null-warehouse)'
);
select is(
  (select sum(quantity) from public.item_stock_levels where item_id = :itemA),
  8::numeric,
  '0331: the scoped viewer''s visible quantities are 5 + 3 = 8 (literal)'
);
select is(
  (select count(*) from public.item_stock_levels
    where item_id = :itemA and location_id = :locW2),
  0::bigint,
  '0331: the sibling warehouse''s holding is INVISIBLE to the scoped viewer'
);
reset role;

-- A manager is not narrowed (the privileged disjunct short-circuits).
set local "request.jwt.claim.sub" to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.item_stock_levels where item_id = :itemA),
  3::bigint,
  '0331: a MANAGER still sees all 3 of itemA''s holdings (not narrowed)'
);
reset role;

-- An outsider sees nothing of the org (the membership conjunct is the floor).
set local "request.jwt.claim.sub" to :u_out;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.item_stock_levels where organization_id = :orgS),
  0::bigint,
  '0331: an org OUTSIDER sees zero of the org''s holdings'
);
reset role;

-- A zero-assignment viewer: only the unscopable null-warehouse holding
-- survives — deliberately, the DC4 shape (20 such rows in production).
set local "request.jwt.claim.sub" to :u_lone;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.item_stock_levels where item_id = :itemA),
  1::bigint,
  '0331: a ZERO-assignment viewer sees exactly 1 holding of itemA'
);
select is(
  (select location_id from public.item_stock_levels where item_id = :itemA),
  :locN::uuid,
  '0331: that surviving holding is the null-warehouse Site row (the DC4 shape)'
);
reset role;

-- HONEST PIN: staff are NOT narrowed on direct SELECT. item_stock_levels_write
-- (0202) is FOR ALL with USING (has_org_role staff); FOR ALL policies apply to
-- SELECT and permissive policies OR, so the write floor grants staff+ org-wide
-- visibility. This same coupling is what lets the conditional-write RPC paths
-- below reach rows outside the caller's assignments — pinned so nobody
-- "fixes" one half without understanding the other.
set local "request.jwt.claim.sub" to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.item_stock_levels where item_id = :itemA),
  3::bigint,
  '0331: a whT1-scoped STAFF member still sees all 3 holdings (the FOR ALL write policy ORs into SELECT)'
);
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. RPC PARITY as the whT1-scoped STAFF caller — the point of the change.
-- ══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- A draw of 9 can only be satisfied by consuming holdings in BOTH warehouses
-- (5 in whT1 + 4 in whT2). If apply_level_delta's selection were ever scoped
-- to the caller again, this exact call would either raise
-- insufficient_placed_stock or silently consume the null-warehouse Site row
-- instead of the whT2 holding — both pinned against below.
select lives_ok(
  format($$select public.adjust_stock(%L, -9, 'remove', null, 'ar2 parity draw')$$,
         :itemA),
  '0331 parity: a staff draw spanning BOTH warehouses succeeds (identical to pre-0331)'
);

reset role;

-- Literal end-state, read as superuser. Draw order is created_at: locW1 (take
-- 5), then locW2 (take 4) — locN untouched.
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemA and location_id = :locW1),
  0::numeric,
  '0331 parity: the whT1 holding drained 5 -> 0'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemA and location_id = :locW2),
  0::numeric,
  '0331 parity: the whT2 holding — HIDDEN from the caller''s SELECT scope — drained 4 -> 0'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemA and location_id = :locN),
  3::numeric,
  '0331 parity: the null-warehouse Site holding stayed untouched at 3 (draw stopped at 9)'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemA),
  3::numeric,
  '0331 parity: on-hand 12 -> 3 (Σ levels = on-hand invariant holds)'
);

-- transfer_stock FROM a whT2 location (outside the caller's assignment): the
-- conditional draw runs under the UNCHANGED FOR ALL write policy, so it still
-- sees the source row.
set local "request.jwt.claim.sub" to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.transfer_stock(%L, %L, %L, 4, 'ar2 parity move')$$,
         :itemB, :locW2, :locW1),
  '0331 parity: staff transfer FROM a whT2 source still works (write policy untouched)'
);
reset role;

select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemB and location_id = :locW2),
  2::numeric,
  '0331 parity: the whT2 source decremented 6 -> 2'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemB and location_id = :locW1),
  4::numeric,
  '0331 parity: the whT1 destination incremented 0 -> 4'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. STRUCTURE — apply_level_delta's definer conversion and grant posture.
-- ══════════════════════════════════════════════════════════════════════════

select ok(
  (select p.prosecdef from pg_proc p
    where p.oid = 'public.apply_level_delta(uuid, numeric, text)'::regprocedure),
  '0331: apply_level_delta is SECURITY DEFINER (draw-down selection immune to the caller''s read scope)'
);
select ok(
  (select p.proconfig::text like '%search_path=public%' from pg_proc p
    where p.oid = 'public.apply_level_delta(uuid, numeric, text)'::regprocedure),
  '0331: apply_level_delta pins search_path=public (secdef hygiene)'
);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.apply_level_delta(uuid, numeric, text)'::regprocedure
      and a.grantee = 0                 -- grantee 0 is PUBLIC
      and a.privilege_type = 'EXECUTE'
  ),
  '0331: PUBLIC holds no EXECUTE on apply_level_delta'
);
select ok(
  not has_function_privilege('anon', 'public.apply_level_delta(uuid, numeric, text)', 'execute'),
  '0331: anon holds no EXECUTE on apply_level_delta (the over-grant is closed)'
);
select ok(
  has_function_privilege('authenticated', 'public.apply_level_delta(uuid, numeric, text)', 'execute'),
  '0331: authenticated RETAINS EXECUTE (every calling RPC is SECURITY INVOKER and reaches it as the user)'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. THE GATE — definer status cannot be reached cross-org or from below the
--    staff write floor. Gate assertions do not depend on RLS: jwt claim only.
-- ══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :u_out;
select throws_ok(
  format($$select public.apply_level_delta(%L, -1, 'placed')$$, :itemA),
  '42501',
  'forbidden',
  '0331: an org OUTSIDER calling apply_level_delta on the org''s item is refused (forbidden)'
);

set local "request.jwt.claim.sub" to :u_vwr;
select throws_ok(
  format($$select public.apply_level_delta(%L, -1, 'placed')$$, :itemA),
  '42501',
  'forbidden',
  '0331: an in-org VIEWER (below the staff write floor) is refused — definer status grants no new write'
);

select * from finish();
rollback;
