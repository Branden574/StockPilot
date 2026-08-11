-- supabase/tests/0322_quantity_guards_avatar_scope_override_clears.test.sql
-- Proves migration 0322 — Wave C2 — in BOTH directions for every change: the
-- attack is refused AND the legitimate caller still works. The second half is
-- what prevents an outage, so it is not optional; several assertions exist only
-- to prove a refusal was not vacuous.
--
-- HOW THE ROLES ARE SIMULATED
--   House convention (0142/0201/0310/0321): `set local role` into the real
--   Postgres role PostgREST switches to, plus request.jwt.claim.sub so
--   auth.uid() resolves. The default role for the rest of the file is the
--   test's superuser, which BYPASSES RLS — that is what makes the privileged
--   "control" assertions possible.
--
-- THE VACUITY PROBLEM, AND HOW THIS FILE AVOIDS IT
--   A cross-boundary RLS test whose target id is looked up INLINE while the
--   attacker role is active proves nothing: the lookup is itself RLS-blinded,
--   returns no row, and "attacker sees 0 rows" passes even against a wide-open
--   policy. This repo has hit that trap twice. So every target id here is
--   resolved from the PRIVILEGED (superuser) connection with \gset BEFORE any
--   role switch, by a real PROPERTY lookup rather than by restating the literal
--   — which also catches a fixture that silently failed to link up. Each
--   negative is paired with a privileged control proving the row genuinely
--   EXISTS (or, for writes, that the forged row is genuinely absent) and with a
--   sibling positive proving the same actor CAN do the legal version, so a
--   refusal can never be credited to a missing role or a typo'd fixture.
--
-- FIXTURES
--   Org A: two warehouses (A1, A2). One PO per warehouse, plus one PO with NO
--          destination and one whose destination is an org-level location with
--          warehouse_id IS NULL (the L4L "DC4" shape).
--   Org B: one warehouse, one PO — the cross-tenant control.
--   Users:
--     u_staff  org A staff, assigned warehouse A1 ONLY -> the scoped member.
--     u_mgr    org A manager -> hasAllAccess, must NOT be narrowed.
--     u_norev  org A staff, assigned A1, with purchase_orders:read REVOKED via
--              a user override -> proves the permission conjunct bites.
--     u_lone   org A staff with NO assignments -> the empty-set edge.
--     u_aadmin org A admin -> the MED-14 attacker AND legitimate writer.
--     u_owner  org A owner -> the MED-14 escape hatch.
--     u_badmin org B admin -> the cross-tenant control.
--   `all_warehouses` is left false on every membership: 0280's
--   trg_warehouses_all_warehouse_access would otherwise auto-assign EVERY
--   warehouse and silently destroy the warehouse-scoping assertions.
--
-- Run via `supabase test db` after `supabase db reset`. Wrapped in
-- begin/rollback — nothing leaks.

begin;

select plan(53);

\set orgA     '\'03220000-0000-0000-0000-000000000001\''
\set orgB     '\'03220000-0000-0000-0000-000000000002\''
\set whA1     '\'03220000-0000-0000-0000-0000000000b1\''
\set whA2     '\'03220000-0000-0000-0000-0000000000b2\''
\set whB1     '\'03220000-0000-0000-0000-0000000000b3\''
\set u_staff  '\'03220000-0000-0000-0000-0000000000a1\''
\set u_mgr    '\'03220000-0000-0000-0000-0000000000a2\''
\set u_norev  '\'03220000-0000-0000-0000-0000000000a3\''
\set u_lone   '\'03220000-0000-0000-0000-0000000000a4\''
\set u_aadmin '\'03220000-0000-0000-0000-0000000000a5\''
\set u_owner  '\'03220000-0000-0000-0000-0000000000a6\''
\set u_badmin '\'03220000-0000-0000-0000-0000000000a7\''
\set locA1    '\'03220000-0000-0000-0000-0000000000e1\''
\set locA2    '\'03220000-0000-0000-0000-0000000000e2\''
\set locOrg   '\'03220000-0000-0000-0000-0000000000e3\''
\set locB1    '\'03220000-0000-0000-0000-0000000000e4\''
\set itemA1   '\'03220000-0000-0000-0000-0000000000c1\''
\set poA1     '\'03220000-0000-0000-0000-0000000000d1\''
\set poA2     '\'03220000-0000-0000-0000-0000000000d2\''
\set poNoDest '\'03220000-0000-0000-0000-0000000000d3\''
\set poOrgLoc '\'03220000-0000-0000-0000-0000000000d4\''
\set poB1     '\'03220000-0000-0000-0000-0000000000d5\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_staff,  'staff@wc0322.test',  '{"full_name":"Scoped Staff"}'::jsonb),
  (:u_mgr,    'mgr@wc0322.test',    '{"full_name":"Org A Manager"}'::jsonb),
  (:u_norev,  'norev@wc0322.test',  '{"full_name":"Read Revoked"}'::jsonb),
  (:u_lone,   'lone@wc0322.test',   '{"full_name":"Unassigned Staff"}'::jsonb),
  (:u_aadmin, 'aadmin@wc0322.test', '{"full_name":"Org A Admin"}'::jsonb),
  (:u_owner,  'aowner@wc0322.test', '{"full_name":"Org A Owner"}'::jsonb),
  (:u_badmin, 'badmin@wc0322.test', '{"full_name":"Org B Admin"}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan) values
  (:orgA, 'WC0322 Org A', 'wc0322-org-a', 'UTC', 'USD', 'pro'),
  (:orgB, 'WC0322 Org B', 'wc0322-org-b', 'UTC', 'USD', 'pro');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_staff,  'staff',   now()),
  (:orgA, :u_mgr,    'manager', now()),
  (:orgA, :u_norev,  'staff',   now()),
  (:orgA, :u_lone,   'staff',   now()),
  (:orgA, :u_aadmin, 'admin',   now()),
  (:orgA, :u_owner,  'owner',   now()),
  (:orgB, :u_badmin, 'admin',   now());

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'WC0322 A1', 'W322A1', 'active'),
  (:whA2, :orgA, 'WC0322 A2', 'W322A2', 'active'),
  (:whB1, :orgB, 'WC0322 B1', 'W322B1', 'active');

-- The scoped members hold warehouse A1 and nothing else. u_lone gets NO row.
insert into public.user_warehouse_assignments
  (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :u_staff, :whA1, null, true),
  (:orgA, :u_norev, :whA1, null, true);

-- purchase_orders:read is a role DEFAULT for staff (0207), so the only way to
-- create a member who lacks it is an explicit user-level REVOKE override.
insert into public.user_permission_overrides
  (organization_id, user_id, permission, granted) values
  (:orgA, :u_norev, 'purchase_orders:read', false);

-- locOrg is the "DC4 shape": an org-level location with NO warehouse_id.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locA1,  :orgA, :whA1, 'WC0322 Bin A1',  'bin',       null),
  (:locA2,  :orgA, :whA2, 'WC0322 Bin A2',  'bin',       null),
  (:locOrg, :orgA, null,  'WC0322 Org Site','warehouse', null),
  (:locB1,  :orgB, :whB1, 'WC0322 Bin B1',  'bin',       null);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemA1, :orgA, :whA1, 'WC0322-A1', 'Item in warehouse A1', 10, 'active', 'none');

insert into public.purchase_orders
  (id, organization_id, po_number, destination_location_id, status, subtotal, tax, shipping, total) values
  (:poA1,     :orgA, 'WC0322-PO-A1',     :locA1,  'ordered', 10, 0, 0, 10),
  (:poA2,     :orgA, 'WC0322-PO-A2',     :locA2,  'ordered', 20, 0, 0, 20),
  (:poNoDest, :orgA, 'WC0322-PO-NODEST', null,    'ordered', 30, 0, 0, 30),
  (:poOrgLoc, :orgA, 'WC0322-PO-ORGLOC', :locOrg, 'ordered', 40, 0, 0, 40),
  (:poB1,     :orgB, 'WC0322-PO-B1',     :locB1,  'ordered', 50, 0, 0, 50);

-- Override rows for the MED-14 assertions. The RESTRICTION is the escalation
-- target: deleting it would hand the permission back.
insert into public.role_permission_overrides
  (organization_id, role, permission, granted) values
  (:orgA, 'admin', 'billing:manage', false),   -- restriction on the admin ROLE
  (:orgA, 'staff', 'stock:adjust',   true);    -- a GRANT, safe to delete
insert into public.user_permission_overrides
  (organization_id, user_id, permission, granted) values
  (:orgA, :u_aadmin, 'billing:manage', false), -- owner-applied restriction on SELF
  (:orgA, :u_staff,  'stock:transfer', true);  -- a GRANT, safe to delete


-- ══════════════════════════════════════════════════════════════════════════
-- PRIVILEGED TARGET RESOLUTION (\gset, before any role switch)
-- Resolved by PROPERTY, not by restating the literal id, and run as superuser
-- so RLS cannot blind them.
-- ══════════════════════════════════════════════════════════════════════════

-- The PO in the warehouse the scoped staff does NOT hold.
select po.id as sibling_po_id
  from public.purchase_orders po
  join public.locations l on l.id = po.destination_location_id
 where po.organization_id = :orgA
   and l.warehouse_id = :whA2
\gset

-- The PO whose destination has no warehouse at all (the unscopable shape).
select po.id as orgloc_po_id
  from public.purchase_orders po
  join public.locations l on l.id = po.destination_location_id
 where po.organization_id = :orgA
   and l.warehouse_id is null
\gset

-- The other tenant's PO.
select po.id as foreign_po_id
  from public.purchase_orders po
 where po.organization_id = :orgB
\gset

-- Controls: each target really exists, so a later "0 rows" is meaningful.
select is(
  (select count(*) from public.purchase_orders where id = :'sibling_po_id'),
  1::bigint,
  'CONTROL: the sibling-warehouse PO exists (a later 0-row read is not vacuous)'
);
select is(
  (select count(*) from public.purchase_orders where id = :'orgloc_po_id'),
  1::bigint,
  'CONTROL: the no-warehouse-destination PO exists'
);
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA),
  4::bigint,
  'CONTROL: org A holds exactly 4 purchase orders'
);


-- ══════════════════════════════════════════════════════════════════════════
-- 1. MED-11 — non-negative quantity constraints on inventory_items.
-- ══════════════════════════════════════════════════════════════════════════

-- The three constraints exist and are now VALIDATED.
--
-- They were added NOT VALID so the deploy could not fail on legacy rows, and
-- this test originally pinned `convalidated = false` to force any promotion to
-- be deliberate rather than a drive-by "cleanup". That guard worked as
-- designed: 0324 promotes them, and only after production was queried first —
-- 516 inventory_items rows with zero negative quantity_on_hand, reorder_point
-- or reorder_quantity. `validate constraint` takes SHARE UPDATE EXCLUSIVE, so
-- it permits concurrent reads and writes; it is not the ACCESS EXCLUSIVE
-- full-scan that adding a validating constraint would have caused.
--
-- Why the assertion is now "validated" rather than "not valid": pg_constraint
-- cannot distinguish a constraint ADDED as validating from one added NOT VALID
-- and later promoted — both end at convalidated = true. So the original intent
-- (never ADD a validating constraint to a populated table) is not expressible
-- as catalog state and lives in the migration headers and
-- docs/security/destructive-actions.md instead. Asserting "validated" is the
-- stronger security claim anyway: the invariant now holds for EVERY row, not
-- only for rows written since the constraint appeared.
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.inventory_items'::regclass
      and contype = 'c'
      and conname in ('inventory_items_quantity_on_hand_nonneg',
                      'inventory_items_reorder_point_nonneg',
                      'inventory_items_reorder_quantity_nonneg')),
  3::bigint,
  'MED-11: all three non-negative CHECK constraints exist on inventory_items'
);
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.inventory_items'::regclass
      and conname in ('inventory_items_quantity_on_hand_nonneg',
                      'inventory_items_reorder_point_nonneg',
                      'inventory_items_reorder_quantity_nonneg')
      and convalidated = true),
  3::bigint,
  'MED-11: all three are VALIDATED by 0324 (production checked first: 516 rows, zero negatives), so the invariant holds for every existing row and not just new writes'
);

-- ATTACKER BLOCKED: the direct PostgREST-shaped write is refused. NOT VALID
-- constrains new writes, which is the entire attack surface.
select throws_ok(
  format('update public.inventory_items set quantity_on_hand = -5000 where id = %L', :itemA1),
  '23514',
  null,
  'MED-11 attack: a negative quantity_on_hand UPDATE is refused (check_violation)'
);
select throws_ok(
  format('update public.inventory_items set reorder_point = -1 where id = %L', :itemA1),
  '23514',
  null,
  'MED-11 attack: a negative reorder_point UPDATE is refused'
);
select throws_ok(
  format($$insert into public.inventory_items
            (organization_id, sku, name, quantity_on_hand, status, tracking_type)
          values (%L, 'WC0322-NEG', 'Negative on insert', -1, 'active', 'none')$$, :orgA),
  '23514',
  null,
  'MED-11 attack: a negative quantity_on_hand INSERT is refused'
);

-- CONTROL that the refusals above were not vacuous.
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemA1),
  10::numeric(14,4),
  'MED-11 control: the refused writes left quantity_on_hand untouched at 10'
);

-- LEGITIMATE CASE STILL WORKS — the outage half.
select lives_ok(
  format('update public.inventory_items set quantity_on_hand = 0 where id = %L', :itemA1),
  'MED-11 legit: driving quantity_on_hand to exactly 0 (sold out) still works'
);
select lives_ok(
  format('update public.inventory_items set quantity_on_hand = 7, reorder_point = 0, reorder_quantity = 0 where id = %L', :itemA1),
  'MED-11 legit: a normal positive write and zero reorder settings still work'
);

-- adjust_stock keeps raising ITS OWN error, not a check violation: the RPC's
-- guard fires before the UPDATE, so the constraint never changes the error the
-- app maps. This is the assertion that would catch a regression to a bare
-- validating constraint on the wrong column.
set local "request.jwt.claim.sub" to :u_staff;
select throws_ok(
  format($$select public.adjust_stock(%L, -9999, 'correction', null, 'wc0322 overdraw', null, 'placed')$$, :itemA1),
  'P0001',
  'insufficient_stock',
  'MED-11 legit: adjust_stock still reports insufficient_stock (P0001), NOT a check violation'
);

-- 0327 INVERSION of the second half of this pin: the explicit-location branch
-- is now guarded too. Seed a real holding THROUGH the RPC, then over-draw it
-- while the item TOTAL stays >= 0 — exactly the case that used to COMMIT a
-- durable negative row (0322 s.1 reproduced it locally: -8 against a location
-- holding 0 succeeded).
select lives_ok(
  format($$select public.adjust_stock(%L, 5, 'add', %L, 'wc0322 seed', null, 'placed')$$, :itemA1, :locA1),
  '0327 legit: a positive explicit-location adjustment still lands in the location'
);
-- On-hand is now 12 (7 + 5); the locA1 holding is 5. Drawing 6 PASSES the item
-- TOTAL guard (12 - 6 >= 0) and must now be refused by the per-location guard
-- with the SAME error the app already maps.
select throws_ok(
  format($$select public.adjust_stock(%L, -6, 'remove', %L, 'wc0322 overdraw', null, 'placed')$$, :itemA1, :locA1),
  'P0001',
  'insufficient_stock',
  '0327 attack: an explicit-location over-draw raises insufficient_stock (P0001) instead of committing a negative row'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemA1 and location_id = :locA1),
  5::numeric,
  '0327: the refused over-draw left the holding untouched at 5'
);
select is(
  (select count(*) from public.item_stock_levels
    where item_id = :itemA1 and quantity < 0),
  0::bigint,
  '0327: NO negative item_stock_levels row exists after the refused over-draw'
);
-- The outage half: a covered draw still works, down to the exact boundary math.
select lives_ok(
  format($$select public.adjust_stock(%L, -3, 'remove', %L, 'wc0322 draw', null, 'placed')$$, :itemA1, :locA1),
  '0327 legit: a covered explicit-location draw-down still works'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemA1 and location_id = :locA1),
  2::numeric,
  '0327: the legitimate draw left the holding at exactly 2'
);

-- 0327 INVERSION of the MED-11 deferral: both RPC writers are fixed in 0327
-- (adjust_stock's explicit-location draw is conditional; transfer_stock tests
-- sufficiency IN the draw), so item_stock_levels.quantity now carries EXACTLY
-- ONE CHECK constraint, pinned by NAME, and it is VALIDATED. A second stray
-- quantity constraint, a rename, or a silent drop all fail here.
select is(
  (select array_agg(c.conname order by c.conname)
     from pg_constraint c
    where c.conrelid = 'public.item_stock_levels'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%quantity%'),
  array['item_stock_levels_quantity_nonneg']::name[],
  '0327: exactly one quantity CHECK constraint exists on item_stock_levels, named item_stock_levels_quantity_nonneg'
);
select is(
  (select c.convalidated from pg_constraint c
    where c.conrelid = 'public.item_stock_levels'::regclass
      and c.conname = 'item_stock_levels_quantity_nonneg'),
  true,
  '0327: item_stock_levels_quantity_nonneg is VALIDATED (production verified zero negative rows 2026-08-11)'
);


-- ══════════════════════════════════════════════════════════════════════════
-- 2. MED-13 — user-avatars SELECT is scoped to the owning user's folder.
-- ══════════════════════════════════════════════════════════════════════════
-- Exercised END TO END against storage.objects, not just as policy text: two
-- real objects are planted in two different users' folders and each user is
-- asked what they can see. Policy-text assertions alone would not catch a
-- predicate that is present but wrong.

insert into storage.objects (bucket_id, name, owner_id) values
  ('user-avatars', :u_staff  || '/wc0322-staff.png',  :u_staff),
  ('user-avatars', :u_aadmin || '/wc0322-aadmin.png', :u_aadmin);

-- The bucket STAYS PUBLIC. Flipping it private would blank every avatar in both
-- apps (all render sites are unauthenticated public-URL GETs and there is no
-- signed-URL plumbing), so this must not silently change.
select is(
  (select public from storage.buckets where id = 'user-avatars'),
  true,
  'MED-13: user-avatars bucket is still public (render sites depend on the public URL)'
);

-- CONTROL: both objects genuinely exist, so the 1-row reads below are real.
select is(
  (select count(*) from storage.objects where bucket_id = 'user-avatars' and name like '%wc0322%'),
  2::bigint,
  'MED-13 control: both planted avatar objects exist'
);

-- ATTACKER BLOCKED: the enumeration. u_staff must not see u_aadmin's path.
set local "request.jwt.claim.sub" to :u_staff;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*) from storage.objects
    where bucket_id = 'user-avatars' and name like '%wc0322%'),
  1::bigint,
  'MED-13 attack: an authenticated user listing the bucket sees ONLY their own folder'
);
select is(
  (select count(*) from storage.objects
    where bucket_id = 'user-avatars' and name like :u_aadmin || '%'),
  0::bigint,
  'MED-13 attack: listing another user''s folder directly returns nothing'
);

-- LEGITIMATE CASE STILL WORKS: the owner reads their own object. This is what
-- keeps profile.ts remove([key]) and any owner-scoped read working.
select is(
  (select name from storage.objects
    where bucket_id = 'user-avatars' and name like :u_staff || '%'),
  :u_staff || '/wc0322-staff.png',
  'MED-13 legit: a user still reads their OWN avatar object'
);

reset role;

-- And the other user sees the mirror image — proving the predicate keys on the
-- CALLER, not on a fixed id.
set local "request.jwt.claim.sub" to :u_aadmin;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select name from storage.objects
    where bucket_id = 'user-avatars' and name like '%wc0322%'),
  :u_aadmin || '/wc0322-aadmin.png',
  'MED-13 legit: the second user sees only their own object (predicate follows auth.uid())'
);
reset role;


-- ══════════════════════════════════════════════════════════════════════════
-- 3. MED-14 — clearing an override is gated by anti-escalation.
-- ══════════════════════════════════════════════════════════════════════════

-- ATTACKER BLOCKED: org A's admin tries to delete the owner-applied RESTRICTION
-- on their own account for a permission they do not hold. RLS refuses silently
-- (a DELETE whose USING is false deletes 0 rows, it does not raise), so the
-- assertion is on the surviving row, which is the only honest form.
set local "request.jwt.claim.sub" to :u_aadmin;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

delete from public.user_permission_overrides
 where organization_id = :orgA and user_id = :u_aadmin and permission = 'billing:manage';

delete from public.role_permission_overrides
 where organization_id = :orgA and role = 'admin' and permission = 'billing:manage';

-- LEGITIMATE CASE STILL WORKS, in the same role, before we drop back: deleting
-- a GRANT is a de-escalation and must remain allowed. Doing this here proves
-- the two refusals above are not just "this admin can delete nothing".
delete from public.user_permission_overrides
 where organization_id = :orgA and user_id = :u_staff and permission = 'stock:transfer';
delete from public.role_permission_overrides
 where organization_id = :orgA and role = 'staff' and permission = 'stock:adjust';

reset role;

select is(
  (select count(*) from public.user_permission_overrides
    where organization_id = :orgA and user_id = :u_aadmin
      and permission = 'billing:manage' and granted = false),
  1::bigint,
  'MED-14 attack: admin CANNOT clear the owner-applied user restriction on themselves'
);
select is(
  (select count(*) from public.role_permission_overrides
    where organization_id = :orgA and role = 'admin'
      and permission = 'billing:manage' and granted = false),
  1::bigint,
  'MED-14 attack: admin CANNOT clear the restriction on their own ROLE'
);
select is(
  (select count(*) from public.user_permission_overrides
    where organization_id = :orgA and user_id = :u_staff and permission = 'stock:transfer'),
  0::bigint,
  'MED-14 legit: admin CAN still clear a user GRANT (de-escalation)'
);
select is(
  (select count(*) from public.role_permission_overrides
    where organization_id = :orgA and role = 'staff' and permission = 'stock:adjust'),
  0::bigint,
  'MED-14 legit: admin CAN still clear a role GRANT (de-escalation)'
);

-- THE OWNER-LOCKOUT ESCAPE HATCH: the owner must always be able to fix a bad
-- state, including deleting the very restriction an admin could not. This works
-- because has_permission() short-circuits to true for role = 'owner'.
set local "request.jwt.claim.sub" to :u_owner;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
delete from public.user_permission_overrides
 where organization_id = :orgA and user_id = :u_aadmin and permission = 'billing:manage';
delete from public.role_permission_overrides
 where organization_id = :orgA and role = 'admin' and permission = 'billing:manage';
reset role;

select is(
  (select count(*) from public.user_permission_overrides
    where organization_id = :orgA and user_id = :u_aadmin and permission = 'billing:manage'),
  0::bigint,
  'MED-14 escape hatch: the OWNER can clear a restriction (user level)'
);
select is(
  (select count(*) from public.role_permission_overrides
    where organization_id = :orgA and role = 'admin' and permission = 'billing:manage'),
  0::bigint,
  'MED-14 escape hatch: the OWNER can clear a restriction (role level)'
);

-- The 0215 INSERT/UPDATE rule this mirrors is still in place — the DELETE fix
-- must not have been achieved by loosening its siblings.
select matches(
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'user_permission_overrides'
      and policyname = 'user_permission_overrides_delete'),
  'has_permission',
  'MED-14: the user-override DELETE policy is has_permission-guarded'
);
select matches(
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'role_permission_overrides'
      and policyname = 'role_permission_overrides_delete'),
  'has_org_role',
  'MED-14: the role-override DELETE policy retained its 0207 admin floor'
);


-- ══════════════════════════════════════════════════════════════════════════
-- 4. MED-16 — purchase_orders SELECT: warehouse scope + read permission.
-- ══════════════════════════════════════════════════════════════════════════

-- ATTACKER BLOCKED (warehouse): the scoped staff member holds A1 only.
set local "request.jwt.claim.sub" to :u_staff;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*) from public.purchase_orders where id = :'sibling_po_id'),
  0::bigint,
  'MED-16 attack: warehouse-scoped staff cannot read the SIBLING warehouse''s PO'
);
select is(
  (select count(*) from public.purchase_orders where id = :'foreign_po_id'),
  0::bigint,
  'MED-16 attack: warehouse-scoped staff cannot read another TENANT''s PO'
);

-- LEGITIMATE CASE STILL WORKS: their own warehouse's PO, the PO with no
-- destination, and the PO whose destination has no warehouse. The last two are
-- the outage this policy was shaped to avoid (the "DC4" shape).
select is(
  (select count(*) from public.purchase_orders where id = :poA1),
  1::bigint,
  'MED-16 legit: scoped staff still reads the PO in their OWN warehouse'
);
select is(
  (select count(*) from public.purchase_orders where id = :poNoDest),
  1::bigint,
  'MED-16 legit: a PO with NO destination_location_id stays visible (unscopable)'
);
select is(
  (select count(*) from public.purchase_orders where id = :'orgloc_po_id'),
  1::bigint,
  'MED-16 legit: a PO whose destination has warehouse_id IS NULL stays visible (the DC4 shape)'
);
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA),
  3::bigint,
  'MED-16 legit: scoped staff sees exactly 3 of org A''s 4 POs (all but the sibling warehouse)'
);
reset role;

-- LEGITIMATE CASE STILL WORKS (the other direction): a MANAGER is not narrowed.
-- getWarehouseAccess gives manager+ hasAllAccess, and this must match.
set local "request.jwt.claim.sub" to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA),
  4::bigint,
  'MED-16 legit: a MANAGER still reads ALL FOUR of the org''s POs (not narrowed)'
);
select is(
  (select count(*) from public.purchase_orders where id = :'foreign_po_id'),
  0::bigint,
  'MED-16: even a manager cannot read the other tenant''s PO (org floor intact)'
);
reset role;

-- ATTACKER BLOCKED (permission): same role, same warehouse assignment as
-- u_staff, but purchase_orders:read explicitly revoked. Proves conjunct 2 bites
-- independently of the warehouse conjunct — u_staff above read poA1 with the
-- identical assignment.
set local "request.jwt.claim.sub" to :u_norev;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.purchase_orders where id = :poA1),
  0::bigint,
  'MED-16 attack: a member whose purchase_orders:read is REVOKED reads no PO in their own warehouse'
);
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA),
  0::bigint,
  'MED-16 attack: revoking purchase_orders:read hides the whole table'
);
reset role;

-- THE EMPTY-SET EDGE: staff with zero assignments. Warehouse-scoped POs vanish
-- (matching PurchaseOrdersService.list, which returns [] for this member), but
-- the two unscopable POs remain — deliberately, so managers' view is unchanged.
set local "request.jwt.claim.sub" to :u_lone;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.purchase_orders where id = :poA1),
  0::bigint,
  'MED-16: staff with NO warehouse assignment reads no warehouse-scoped PO'
);
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA),
  2::bigint,
  'MED-16: staff with NO assignment still sees the 2 unscopable POs (no destination / no warehouse)'
);
reset role;

-- item_stock_levels is DEFERRED, and that is asserted so the deferral is
-- visible in CI rather than only in a report. post_cycle_count derives its
-- delta from Sigma(item_stock_levels) under the caller's RLS, so narrowing this
-- policy silently corrupts stock. When that is fixed, update this assertion in
-- the same change that narrows the policy.
select is(
  (select qual from pg_policies
    where schemaname = 'public' and tablename = 'item_stock_levels'
      and policyname = 'item_stock_levels_select'),
  '( SELECT is_org_member(item_stock_levels.organization_id) AS is_org_member)',
  'MED-16 deferred: item_stock_levels_select is still org-only (see 0322 s.4 for the prerequisite)'
);


-- ══════════════════════════════════════════════════════════════════════════
-- 5. my_warehouse_ids() grant hygiene — BOTH directions.
-- ══════════════════════════════════════════════════════════════════════════
-- Asserted via aclexplode/has_function_privilege rather than by CALLING the
-- function as anon: 0310's test file documents that an actually-denied call
-- under `set local role` can SEGFAULT the local Supabase CLI image.

select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.my_warehouse_ids()'::regprocedure
      and a.grantee = 0                 -- grantee 0 is PUBLIC
      and a.privilege_type = 'EXECUTE'
  ),
  'Finding 5: PUBLIC holds no EXECUTE on my_warehouse_ids()'
);
select ok(
  not has_function_privilege('anon', 'public.my_warehouse_ids()', 'EXECUTE'),
  'Finding 5: anon holds no EXECUTE on my_warehouse_ids()'
);

-- THE OUTAGE HALF (0318's hazard, and the reason this file exists): RLS is
-- evaluated with the QUERYING role's privileges, and my_warehouse_ids() is
-- named inside stock_movements_select (0321) AND purchase_orders_select (0322).
-- Revoking authenticated would take down the movements ledger and the PO list
-- for every warehouse-scoped member. A future "revoke everything" sweep must
-- fail HERE, in CI.
select ok(
  has_function_privilege('authenticated', 'public.my_warehouse_ids()', 'EXECUTE'),
  'Finding 5: authenticated RETAINS EXECUTE on my_warehouse_ids() (0321 + 0322 policies call it)'
);
select ok(
  has_function_privilege('service_role', 'public.my_warehouse_ids()', 'EXECUTE'),
  'Finding 5: service_role RETAINS EXECUTE on my_warehouse_ids()'
);

-- The two other helpers this migration's new policy text depends on must also
-- stay callable by authenticated, for the same reason.
select ok(
  has_function_privilege('authenticated', 'public.rls_orgs_with_permission(text)', 'EXECUTE'),
  'Finding 5: authenticated RETAINS EXECUTE on rls_orgs_with_permission (purchase_orders_select calls it)'
);
select ok(
  has_function_privilege('authenticated', 'public.has_permission(uuid, text)', 'EXECUTE'),
  'Finding 5: authenticated RETAINS EXECUTE on has_permission (the override DELETE policies call it)'
);

select * from finish();
rollback;
