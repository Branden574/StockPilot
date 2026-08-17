-- supabase/tests/0340_mint_placement_location.test.sql
-- Proves migration 0340: `mint_placement_location` — the put-away's
-- resolve-or-create of the rack/crate it places INTO, under stock:transfer.
--
-- Owner decision D1 (2026-08-17): putting stock into a crate the book's own
-- label names is a STOCK operation, so the placement path may mint the row
-- under stock:transfer; ordinary location creation keeps locations:manage.
-- Because `locations_insert` (0212) refuses staff, the exception is a
-- SECURITY DEFINER function that re-checks org + permission inside — and this
-- file proves BOTH halves of that decision, literally:
--
--   A. STAFF CAN MINT VIA THE PLACEMENT PATH. A staff member (role rank 40,
--      holds stock:transfer by the Staff preset and NOT locations:manage) mints
--      "Yellow #6 on rack 38-B" through the function: the row lands ONCE with
--      the columns as given; a second identical call REUSES it (same id, no
--      second row); the reuse is case-insensitive (0270's lower(name) key);
--      a same-name RACK is a distinct row from the crate (kind is part of the
--      key).
--
--   B. STAFF STILL CANNOT INSERT A LOCATION DIRECTLY. The same staff member's
--      direct `insert into locations` is refused by the unchanged
--      `locations_insert` policy — for a crate, for a rack, and for a site.
--      This is the pin that a POLICY-widening implementation would have
--      failed, and why the function exists instead.
--
--   C. THE FUNCTION'S OWN GATE. Inside the SECURITY DEFINER body: a viewer
--      (no stock:transfer, no locations:manage) is refused 42501; a manager of
--      ANOTHER org is refused 42501 for this org; a staff member cannot mint
--      into a warehouse that is not this org's; the kind is restricted to
--      rack/crate (a 'site'/'area' request is refused 22023, so this can never
--      become a back door for site creation); a null warehouse is refused.
--      Every refusal leaves the locations table exactly as it was.
--
--   D. MANAGER UNCHANGED. A manager mints through the same function (the
--      placement path is one path for everyone) AND still inserts directly.
--
--   E. POSTURE. SECURITY DEFINER, search_path=public pinned, exactly one
--      overload, authenticated + service_role hold EXECUTE, anon and PUBLIC
--      hold none.
--
-- HOW THE ROLES ARE SIMULATED — house convention (0191/0282/0327): `set local
-- role authenticated` + request.jwt.claim.sub. Fixtures inserted as postgres.
-- Namespace: 03400000. begin/rollback — nothing leaks.
--
-- PLAN: hand-counted 35 — control: 1, A: 11, B: 4, C: 9, D: 3, E: 7.

begin;

select plan(35);

\set orgA    '\'03400000-0000-0000-0000-000000000001\''
\set orgB    '\'03400000-0000-0000-0000-000000000002\''
\set a_stf   '\'03400000-0000-0000-0000-0000000000a1\''
\set a_mgr   '\'03400000-0000-0000-0000-0000000000a2\''
\set a_vwr   '\'03400000-0000-0000-0000-0000000000a3\''
\set b_mgr   '\'03400000-0000-0000-0000-0000000000a4\''
\set whA     '\'03400000-0000-0000-0000-0000000000b1\''
\set whB     '\'03400000-0000-0000-0000-0000000000b2\''
\set locB    '\'03400000-0000-0000-0000-0000000000e1\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:a_stf, 'staff-0340@test.local',    '{}'::jsonb),
  (:a_mgr, 'manager-0340@test.local',  '{}'::jsonb),
  (:a_vwr, 'viewer-0340@test.local',   '{}'::jsonb),
  (:b_mgr, 'outsider-0340@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Mint Org A 0340', 'mint-org-a-0340'),
  (:orgB, 'Mint Org B 0340', 'mint-org-b-0340')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :a_stf, 'staff',   now()),
  (:orgA, :a_mgr, 'manager', now()),
  (:orgA, :a_vwr, 'viewer',  now()),
  (:orgB, :b_mgr, 'manager', now())
on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'Mint WH A 0340', 'WH-0340-A', 'active'),
  (:whB, :orgB, 'Mint WH B 0340', 'WH-0340-B', 'active')
on conflict (id) do nothing;

-- A site in orgB, by FIXED id: the foreign-parent probe below must name a row
-- that exists, and RLS hides orgB's rows from orgA's staff, so a subquery run
-- as the staff member would resolve to NULL and vacuously pass.
insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:locB, :orgB, :whB, 'Foreign Room 0340', 'room')
on conflict (id) do nothing;

-- CONTROL: the Staff preset really is "stock:transfer without locations:manage"
-- (role_default_permissions is the SQL mirror of ROLE_PERMISSIONS, 0207). If
-- either half of this changes, every A/B assertion below changes meaning.
select is(
  (select array_agg(permission order by permission)
     from public.role_default_permissions
    where role = 'staff' and permission in ('stock:transfer', 'locations:manage')),
  array['stock:transfer']::text[],
  'CONTROL: staff holds stock:transfer and NOT locations:manage'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- A. STAFF CAN MINT VIA THE PLACEMENT PATH.
-- ═══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :a_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 2. The label-only crate becomes a row, minted by staff.
select lives_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'crate', 'Yellow #6 on rack 38-B', 'bin', null, null, '38', 'B', 'yellow', '6')$$,
         :orgA, :whA),
  'A: staff mints "Yellow #6 on rack 38-B" through the placement path'
);
-- 3. Exactly one row.
select is(
  (select count(*) from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and lower(name) = lower('Yellow #6 on rack 38-B') and deleted_at is null),
  1::bigint,
  'A: the crate row exists exactly once'
);
-- 4. Columns stored as given (the caller composed name + normalised columns).
select is(
  (select array[type, kind, rack_number, rack_row, crate_color, crate_number]
     from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and name = 'Yellow #6 on rack 38-B' and deleted_at is null),
  array['bin', 'crate', '38', 'B', 'yellow', '6']::text[],
  'A: type/kind/rack pair/crate pair stored as handed in'
);
-- 5. The function's return value IS the stored row (the id the caller places into).
select is(
  (select id from public.mint_placement_location(:orgA, :whA, 'crate', 'Yellow #6 on rack 38-B', 'bin', null, null, '38', 'B', 'yellow', '6')),
  (select id from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and name = 'Yellow #6 on rack 38-B' and deleted_at is null),
  'A: a second identical call returns the SAME row id (reuse, not mint)'
);
-- 6. ...and did not add a row.
select is(
  (select count(*) from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and lower(name) = lower('Yellow #6 on rack 38-B') and deleted_at is null),
  1::bigint,
  'A: still exactly one crate row after the second put-away'
);
-- 7. Case-insensitive reuse — 0270's key is lower(name).
select is(
  (select id from public.mint_placement_location(:orgA, :whA, 'crate', 'yellow #6 ON RACK 38-b', 'bin', null, null, '38', 'B', 'yellow', '6')),
  (select id from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and name = 'Yellow #6 on rack 38-B' and deleted_at is null),
  'A: a differently-cased name resolves to the same row'
);
-- 8. Reuse keeps the ORIGINAL spelling (the row is returned, not rewritten).
select is(
  (select count(*) from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and name = 'Yellow #6 on rack 38-B' and deleted_at is null),
  1::bigint,
  'A: the reused row keeps its original name byte-for-byte'
);
-- 9. Staff mints a bare RACK too (the rack half of the same placement path).
select lives_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'rack', '38-B', 'shelf', null, null, '38', 'B', null, null)$$,
         :orgA, :whA),
  'A: staff mints rack "38-B" through the placement path'
);
-- 10. Kind is part of the key: the rack and the crate are two rows.
select is(
  (select count(*) from public.locations
    where organization_id = :orgA and warehouse_id = :whA
      and kind in ('rack', 'crate') and deleted_at is null),
  2::bigint,
  'A: one crate row + one rack row (kind is part of the dedupe key)'
);
-- 11. The minted rows are visible to the staff member under RLS (locations_select
--     is is_org_member) — the put-away can read back what it placed into.
select is(
  (select count(*) from public.locations
    where organization_id = :orgA and warehouse_id = :whA
      and kind in ('rack', 'crate') and deleted_at is null),
  2::bigint,
  'A: staff can SELECT the rows it minted (RLS read unchanged)'
);
-- 12. A crate WITHOUT a position (legacy shape, "Blue #Shelf") mints too.
select lives_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'crate', 'Blue #Shelf', 'bin', null, null, null, null, 'blue', 'Shelf')$$,
         :orgA, :whA),
  'A: a position-less crate (rack pair null) is a legitimate mint'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. STAFF STILL CANNOT INSERT A LOCATION DIRECTLY.
-- (still `authenticated` as a_stf)
-- ═══════════════════════════════════════════════════════════════════════════

-- 13. Direct crate insert: refused by locations_insert (42501).
select throws_ok(
  format($$insert into public.locations (organization_id, warehouse_id, name, type, kind, crate_color, crate_number)
           values (%L, %L, 'Red #4 on rack 38-C', 'bin', 'crate', 'red', '4')$$, :orgA, :whA),
  '42501',
  null,
  'B: staff direct INSERT of a crate row is refused by RLS'
);
-- 14. Direct rack insert: refused.
select throws_ok(
  format($$insert into public.locations (organization_id, warehouse_id, name, type, kind, rack_number, rack_row)
           values (%L, %L, '38-C', 'shelf', 'rack', '38', 'C')$$, :orgA, :whA),
  '42501',
  null,
  'B: staff direct INSERT of a rack row is refused by RLS'
);
-- 15. Direct site insert: refused.
select throws_ok(
  format($$insert into public.locations (organization_id, warehouse_id, name, type)
           values (%L, %L, 'Back Room 0340', 'room')$$, :orgA, :whA),
  '42501',
  null,
  'B: staff direct INSERT of a site is refused by RLS'
);
-- 16. None of the three landed.
select is(
  (select count(*) from public.locations
    where organization_id = :orgA and deleted_at is null
      and name in ('Red #4 on rack 38-C', '38-C', 'Back Room 0340')),
  0::bigint,
  'B: none of the refused direct inserts left a row'
);

reset role;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. THE FUNCTION'S OWN GATE.
-- ═══════════════════════════════════════════════════════════════════════════

-- viewer: member of orgA, no stock:transfer, no locations:manage
set local "request.jwt.claim.sub" to :a_vwr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 17
select throws_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'crate', 'Green #2 on rack 39-A', 'bin', null, null, '39', 'A', 'green', '2')$$,
         :orgA, :whA),
  '42501',
  'insufficient_privilege',
  'C: a viewer (no stock:transfer, no locations:manage) is refused'
);
reset role;

-- outsider: manager of orgB, calling for orgA
set local "request.jwt.claim.sub" to :b_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 18
select throws_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'crate', 'Green #2 on rack 39-A', 'bin', null, null, '39', 'A', 'green', '2')$$,
         :orgA, :whA),
  '42501',
  'insufficient_privilege',
  'C: a manager of ANOTHER org is refused for this org (membership is re-checked inside)'
);
reset role;

-- staff of orgA, pointing at orgB's warehouse
set local "request.jwt.claim.sub" to :a_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 19
select throws_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'crate', 'Green #2 on rack 39-A', 'bin', null, null, '39', 'A', 'green', '2')$$,
         :orgA, :whB),
  '42501',
  'insufficient_privilege',
  'C: a warehouse outside the org is refused (warehouse_in_org re-checked inside)'
);
-- 20. Not a back door for sites: kind is rack/crate only.
select throws_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'area', 'Receiving Area 0340', 'other', null, null, null, null, null, null)$$,
         :orgA, :whA),
  '22023',
  null,
  'C: kind "area" is refused (rack/crate only)'
);
-- 21
select throws_ok(
  format($$select * from public.mint_placement_location(%L, %L, null, 'Back Room 0340', 'room', null, null, null, null, null, null)$$,
         :orgA, :whA),
  '22023',
  null,
  'C: a null kind (a site shape) is refused'
);
-- 22. A rack/crate needs a warehouse (the dedupe key and the scope).
select throws_ok(
  format($$select * from public.mint_placement_location(%L, null, 'rack', '40-A', 'shelf', null, null, '40', 'A', null, null)$$,
         :orgA),
  '22023',
  null,
  'C: a null warehouse is refused'
);
-- 23. A parent outside the org is refused.
select throws_ok(
  format($$select * from public.mint_placement_location(%L, %L, 'rack', '40-A', 'shelf', %L, null, '40', 'A', null, null)$$,
         :orgA, :whA, :locB),
  '42501',
  'insufficient_privilege',
  'C: a parent location outside the org is refused (location_in_org re-checked inside)'
);
reset role;

-- 24. Every refusal above left the table exactly as A left it: 2 positioned
--     rows + 1 position-less crate in whA, nothing in whB, no area/site rows.
select is(
  (select count(*) from public.locations
    where organization_id in (:orgA, :orgB) and deleted_at is null
      and kind in ('rack', 'crate', 'area')),
  3::bigint,
  'C: no refused call left a row behind (still the 3 rows section A minted)'
);
-- 25. ...and specifically nothing landed in orgB's warehouse.
select is(
  (select count(*) from public.locations
    where warehouse_id = :whB and kind in ('rack', 'crate') and deleted_at is null),
  0::bigint,
  'C: nothing was minted into the foreign warehouse'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. MANAGER UNCHANGED.
-- ═══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :a_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 26. The manager's put-away goes through the same function and REUSES the
--     staff-minted crate — one row per crate regardless of who placed first.
select is(
  (select id from public.mint_placement_location(:orgA, :whA, 'crate', 'Yellow #6 on rack 38-B', 'bin', null, null, '38', 'B', 'yellow', '6')),
  (select id from public.locations
    where organization_id = :orgA and warehouse_id = :whA and kind = 'crate'
      and name = 'Yellow #6 on rack 38-B' and deleted_at is null),
  'D: the manager reuses the staff-minted crate through the same function'
);
-- 27. And the manager still creates directly (locations_insert unchanged).
select lives_ok(
  format($$insert into public.locations (organization_id, warehouse_id, name, type, kind, rack_number, rack_row)
           values (%L, %L, '41-C', 'shelf', 'rack', '41', 'C')$$, :orgA, :whA),
  'D: a manager still inserts a rack directly (locations_insert unchanged)'
);
-- 28
select lives_ok(
  format($$insert into public.locations (organization_id, warehouse_id, name, type)
           values (%L, %L, 'Manager Room 0340', 'room')$$, :orgA, :whA),
  'D: a manager still inserts a site directly'
);
reset role;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. POSTURE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 29. Exactly one overload (PostgREST cannot go ambiguous; 0329's list-integrity
--     counts stay valid).
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mint_placement_location'),
  1,
  'E: exactly one overload of mint_placement_location'
);
-- 30. SECURITY DEFINER — the whole point (RLS refuses the staff insert).
select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mint_placement_location'),
  'E: SECURITY DEFINER'
);
-- 31. search_path pinned.
select ok(
  (select 'search_path=public' = any(p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mint_placement_location'),
  'E: search_path=public pinned'
);
-- 32. authenticated holds EXECUTE (outage guard).
select ok(
  has_function_privilege('authenticated',
    'public.mint_placement_location(uuid, uuid, text, text, text, uuid, text, text, text, text, text)', 'execute'),
  'E: authenticated holds EXECUTE'
);
-- 33. anon does not.
select ok(
  not has_function_privilege('anon',
    'public.mint_placement_location(uuid, uuid, text, text, text, uuid, text, text, text, text, text)', 'execute'),
  'E: anon holds no EXECUTE'
);
-- 34. No PUBLIC grant survives in the ACL.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'mint_placement_location'
       and exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)),
  'E: no PUBLIC grant in the ACL'
);
-- 35. And the body gates on the authorization predicates (INV-2 shape), so a
--     future edit that drops the check fails here before it ships.
select ok(
  (select p.prosrc ~ 'has_permission\(p_org, ''stock:transfer''\)'
      and p.prosrc ~ 'has_org_role\(p_org, ''manager''\)'
      and p.prosrc ~ 'warehouse_in_org\(p_warehouse_id, p_org\)'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mint_placement_location'),
  'E: the body re-checks stock:transfer / manager / warehouse_in_org on its own arguments'
);

select * from finish();
rollback;
