-- supabase/tests/0206_recurring_po_templates_write_test.sql
-- pgTAP proof that migration 0206 adds the missing write RLS policies to
-- recurring_po_templates. The table was created by 0180 with RLS enabled but
-- only a SELECT policy — every authenticated INSERT/UPDATE/DELETE was denied.
-- 0206 adds INSERT/UPDATE/DELETE policies scoped to managers, with FK-org-
-- consistency guards on destination_location_id and supplier_id.
--
-- Covers:
--   1. Manager in org A INSERT valid template            → lives_ok  (core fix)
--   2. Non-manager (staff) in org A INSERT               → throws_ok 42501
--   3. Manager INSERT cross-org supplier_id              → throws_ok 42501
--   4. Manager INSERT cross-org destination_location_id  → throws_ok 42501
--   5a. Manager UPDATE own template (name change)        → lives_ok
--   5b. Manager UPDATE setting supplier_id=cross-org     → throws_ok 42501
--   6a. Manager DELETE own template                      → lives_ok
--   6b. Non-manager DELETE                               → throws_ok 42501
--   7. Org-A member SELECT still works (regression)      → returns the row
--
-- Namespace: fc020600 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(9);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — namespace fc020600, never clashes with other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set orgA    '\'fc020600-0000-0000-0000-000000000001\''
\set orgB    '\'fc020600-0000-0000-0000-000000000002\''
\set mgr     '\'fc020600-0000-0000-0000-000000000003\''
\set staff   '\'fc020600-0000-0000-0000-000000000004\''
\set whA     '\'fc020600-0000-0000-0000-000000000005\''
\set whB     '\'fc020600-0000-0000-0000-000000000006\''
\set supA    '\'fc020600-0000-0000-0000-000000000007\''
\set supB    '\'fc020600-0000-0000-0000-000000000008\''
\set locA    '\'fc020600-0000-0000-0000-000000000009\''
\set locB    '\'fc020600-0000-0000-0000-000000000010\''
\set tmplA   '\'fc020600-0000-0000-0000-000000000011\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

-- Auth users — the on_auth_user_created trigger auto-creates user_profiles rows.
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr,   'rpt-mgr@test.local',   '{}'::jsonb) on conflict (id) do nothing;
insert into auth.users (id, email, raw_user_meta_data)
  values (:staff, 'rpt-staff@test.local', '{}'::jsonb) on conflict (id) do nothing;

-- Org A + Org B
insert into public.organizations (id, name, slug)
  values (:orgA, 'RPT Test Org A', 'rpt-test-a-0206') on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:orgB, 'RPT Test Org B', 'rpt-test-b-0206') on conflict (id) do nothing;

-- mgr = manager of org A; staff = member (viewer) of org A; neither in org B.
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :mgr,   'manager', now()) on conflict do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :staff, 'viewer',  now()) on conflict do nothing;

-- Warehouses (needed for locations FK).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'RPT WH A', 'RPT-WHA', 'active') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whB, :orgB, 'RPT WH B', 'RPT-WHB', 'active') on conflict (id) do nothing;

-- Suppliers: A in orgA, B in orgB — the cross-tenant pair.
insert into public.suppliers (id, organization_id, name)
  values (:supA, :orgA, 'RPT Supplier A') on conflict (id) do nothing;
insert into public.suppliers (id, organization_id, name)
  values (:supB, :orgB, 'RPT Supplier B') on conflict (id) do nothing;

-- Locations: locA in orgA, locB in orgB.
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values (:locA, :orgA, :whA, 'RPT-LOC-A', 'bin') on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values (:locB, :orgB, :whB, 'RPT-LOC-B', 'bin') on conflict (id) do nothing;

-- Seed a pre-existing template (as superuser) for UPDATE/DELETE/SELECT tests.
-- This bypasses RLS — we're testing the policies, not the seed path.
insert into public.recurring_po_templates
  (id, organization_id, supplier_id, destination_location_id,
   name, cadence, send_mode, line_items, next_run_at,
   created_by, updated_by)
  values (
    :tmplA, :orgA, :supA, :locA,
    'RPT Seed Template 0206', 'monthly', 'draft', '[]'::jsonb,
    now() + interval '30 days',
    :mgr, :mgr
  ) on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 1: Manager INSERT valid template → lives_ok  (THE CORE FIX)
-- Before 0206 this raised 42501; now it must succeed.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ insert into public.recurring_po_templates
       (organization_id, supplier_id, destination_location_id,
        name, cadence, send_mode, line_items, next_run_at,
        created_by, updated_by)
     values (
       'fc020600-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc020600-0000-0000-0000-000000000007'::uuid,  -- supA (same org)
       'fc020600-0000-0000-0000-000000000009'::uuid,  -- locA (same org)
       'RPT Manager Insert Test', 'monthly', 'draft', '[]'::jsonb,
       now() + interval '30 days',
       'fc020600-0000-0000-0000-000000000003'::uuid,  -- mgr
       'fc020600-0000-0000-0000-000000000003'::uuid   -- mgr
     ) $$,
  'manager INSERT valid template lives (core fix: 0206 restores write path)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 2: Non-manager (staff/viewer) INSERT → 42501
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000004';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ insert into public.recurring_po_templates
       (organization_id, name, cadence, send_mode, line_items, next_run_at,
        created_by, updated_by)
     values (
       'fc020600-0000-0000-0000-000000000001'::uuid,  -- orgA
       'RPT Staff Insert Test', 'monthly', 'draft', '[]'::jsonb,
       now() + interval '30 days',
       'fc020600-0000-0000-0000-000000000004'::uuid,
       'fc020600-0000-0000-0000-000000000004'::uuid
     ) $$,
  '42501', NULL,
  'non-manager (viewer) INSERT raises 42501');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 3: Manager INSERT with cross-org supplier_id → 42501
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ insert into public.recurring_po_templates
       (organization_id, supplier_id,
        name, cadence, send_mode, line_items, next_run_at,
        created_by, updated_by)
     values (
       'fc020600-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc020600-0000-0000-0000-000000000008'::uuid,  -- supB (FOREIGN ORG!)
       'RPT Cross-Supplier Insert', 'monthly', 'draft', '[]'::jsonb,
       now() + interval '30 days',
       'fc020600-0000-0000-0000-000000000003'::uuid,
       'fc020600-0000-0000-0000-000000000003'::uuid
     ) $$,
  '42501', NULL,
  'manager INSERT with cross-org supplier_id raises 42501');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 4: Manager INSERT with cross-org destination_location_id → 42501
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ insert into public.recurring_po_templates
       (organization_id, destination_location_id,
        name, cadence, send_mode, line_items, next_run_at,
        created_by, updated_by)
     values (
       'fc020600-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc020600-0000-0000-0000-000000000010'::uuid,  -- locB (FOREIGN ORG!)
       'RPT Cross-Location Insert', 'monthly', 'draft', '[]'::jsonb,
       now() + interval '30 days',
       'fc020600-0000-0000-0000-000000000003'::uuid,
       'fc020600-0000-0000-0000-000000000003'::uuid
     ) $$,
  '42501', NULL,
  'manager INSERT with cross-org destination_location_id raises 42501');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 5a: Manager UPDATE own template (name change) → lives_ok
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ update public.recurring_po_templates
        set name = 'RPT Seed Template 0206 (updated)'
      where id = 'fc020600-0000-0000-0000-000000000011'::uuid $$,
  'manager UPDATE own template (name change) lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 5b: Manager UPDATE setting supplier_id = cross-org supplier → 42501
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ update public.recurring_po_templates
        set supplier_id = 'fc020600-0000-0000-0000-000000000008'::uuid  -- supB (FOREIGN ORG!)
      where id = 'fc020600-0000-0000-0000-000000000011'::uuid $$,
  '42501', NULL,
  'manager UPDATE setting supplier_id to cross-org raises 42501');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 6a: Manager DELETE own template → lives_ok
-- We need a separate row to delete (tmplA is still present after tests 5a/5b).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ delete from public.recurring_po_templates
      where id = 'fc020600-0000-0000-0000-000000000011'::uuid $$,
  'manager DELETE own template lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 6b: Non-manager (staff) DELETE → row survives (RLS USING denial is silent)
-- RLS USING-clause denial on DELETE silently returns 0 rows, NOT a 42501 error.
-- We verify the row still exists after the attempt.
-- Insert a fresh row as superuser first, then switch to staff.
-- ─────────────────────────────────────────────────────────────────────────────
reset role;

insert into public.recurring_po_templates
  (id, organization_id, name, cadence, send_mode, line_items, next_run_at,
   created_by, updated_by)
  values (
    'fc020600-0000-0000-0000-000000000012'::uuid,
    'fc020600-0000-0000-0000-000000000001'::uuid,  -- orgA
    'RPT Non-Manager Delete Target', 'monthly', 'draft', '[]'::jsonb,
    now() + interval '30 days',
    'fc020600-0000-0000-0000-000000000003'::uuid,
    'fc020600-0000-0000-0000-000000000003'::uuid
  ) on conflict (id) do nothing;

set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000004';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- The DELETE runs but the USING clause hides the row from the non-manager
-- (viewer has no DELETE policy at all), so 0 rows are deleted — no exception.
-- Immediately after, verify the row is still there (switch back to manager).
do $$ begin
  delete from public.recurring_po_templates
    where id = 'fc020600-0000-0000-0000-000000000012'::uuid;
end $$;

-- Re-assert manager to check the row survived.
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select results_eq(
  $$ select count(*)::int from public.recurring_po_templates
      where id = 'fc020600-0000-0000-0000-000000000012'::uuid $$,
  ARRAY[1],
  'non-manager DELETE is silently denied: row still exists after attempt');

-- ─────────────────────────────────────────────────────────────────────────────
-- Test 7: Org-A member SELECT still works (regression check)
-- The original SELECT policy from 0180 must remain intact.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc020600-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select results_eq(
  $$ select count(*)::int from public.recurring_po_templates
      where organization_id = 'fc020600-0000-0000-0000-000000000001'::uuid $$,
  ARRAY[2],
  'org-A member can SELECT templates (SELECT policy regression check)');

select * from finish();
rollback;
