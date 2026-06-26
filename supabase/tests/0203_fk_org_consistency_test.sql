-- supabase/tests/0203_fk_org_consistency_test.sql
-- pgTAP proof that migration 0203 closes the FK-not-org-verified class:
-- a caller-supplied warehouse_id or location_id FK must belong to the row's org.
--
-- Covers all FK shapes + null-safety per the brief + the completeness sweep:
--   1. Warehouse-FK direct-org (receipts)           cross-org  → 42501; same-org  → lives
--   2. Location-FK direct-org (purchase_orders)     cross-org  → 42501; same-org  → lives; NULL → lives
--   3. Two-nullable location-FKs (stock_movements)  from/to cross-org → 42501; both NULL → lives; same-org → lives
--   4. inventory_items.primary_location_id          cross-org  → 42501; NULL → lives; same-org → lives
--   5. Complex-org (warehouse_charters, org via charters join) cross-org wh → 42501; same-org → lives
--   6. shipments.source_warehouse_id (NOT NULL)     cross-org  → 42501; same-org  → lives
--   7. procedures.authoring_warehouse_id (nullable) cross-org  → 42501; same-org → lives; NULL → lives
--   8. schedule_events UPDATE (warehouse_id + bundle_warehouse_id) cross-org each → 42501; same-org/NULL → lives
--   9. schedule_events INSERT (bundle_warehouse_id) cross-org  → 42501; NULL → lives
--   NULL-safety regression: explicit lives_ok on NULL FKs (2,3,4,7,8,9)
--
-- Namespace: fc030300 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(24);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — namespace fc030300, never clashes with other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set orgA     '\'fc030300-0000-0000-0000-000000000001\''
\set orgB     '\'fc030300-0000-0000-0000-000000000002\''
\set usr      '\'fc030300-0000-0000-0000-000000000003\''
\set whA      '\'fc030300-0000-0000-0000-000000000004\''
\set whB      '\'fc030300-0000-0000-0000-000000000005\''
\set locA1    '\'fc030300-0000-0000-0000-000000000006\''
\set locB1    '\'fc030300-0000-0000-0000-000000000007\''
\set itemA    '\'fc030300-0000-0000-0000-000000000008\''
\set poA      '\'fc030300-0000-0000-0000-000000000009\''
\set charterA '\'fc030300-0000-0000-0000-00000000000a\''
\set seA      '\'fc030300-0000-0000-0000-00000000000b\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

-- Auth user (member of org A only — org B is the cross-tenant target).
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'fk-org-test@test.local', '{}'::jsonb) on conflict (id) do nothing;

-- Org A + Org B
insert into public.organizations (id, name, slug)
  values (:orgA, 'FK Org Test A', 'fk-org-test-a-0203') on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:orgB, 'FK Org Test B', 'fk-org-test-b-0203') on conflict (id) do nothing;

-- User is a manager of org A only.
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :usr, 'manager', now()) on conflict do nothing;

-- Warehouses (trigger auto-creates Staging + Unplaced locations per mig 0188).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'FK WH A', 'WH-FKA', 'active') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whB, :orgB, 'FK WH B', 'WH-FKB', 'active') on conflict (id) do nothing;

-- One explicit bin location in each org (in addition to auto-created ones).
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values
    (:locA1, :orgA, :whA, 'FK-A-Bin-1', 'bin'),
    (:locB1, :orgB, :whB, 'FK-B-Bin-1', 'bin')
  on conflict (id) do nothing;

-- Item A in org A (warehouse A), used for inventory_items location tests.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:itemA, :orgA, :whA, 'FK-ORG-0203', 'FK Org Test Item', 0, 'active', 'none')
  on conflict (id) do nothing;

-- Purchase order A in org A (needed as FK for receipts).
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:poA, :orgA, 'FK-PO-0203', 'ordered') on conflict (id) do nothing;

-- Charter for org A (needed for warehouse_charters complex-org test).
insert into public.charters (id, organization_id, name, code, status)
  values (:charterA, :orgA, 'FK Charter A', 'FC-0203', 'active') on conflict (id) do nothing;

-- Schedule event in org A, created by usr (so the UPDATE policy's
-- created_by = auth.uid() clause passes for the org-A user). warehouse_id and
-- bundle_warehouse_id start NULL (valid org-A baseline).
-- NOTE: the _enforce_schedule_events_writer BEFORE-INSERT trigger (mig 0084)
-- FORCES created_by := auth.uid(), so we set the JWT sub before seeding (still
-- as superuser → RLS bypassed) so the trigger stamps :usr rather than NULL.
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
insert into public.schedule_events (id, organization_id, title, starts_at, created_by)
  values (:seA, :orgA, 'FK Sched Event A', now(), :usr) on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Become the org-A manager (auth.uid() + has_org_role + RLS now active).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 1: Warehouse-FK, direct org (receipts)
-- The receipts_write WITH CHECK now also checks warehouse_in_org(warehouse_id, organization_id).
-- ─────────────────────────────────────────────────────────────────────────────

-- Test 1a: INSERT receipt with cross-org warehouse_id → 42501
select throws_ok(
  $$ insert into public.receipts
       (organization_id, purchase_order_id, warehouse_id, receipt_number,
        status, received_by, immutable_hash)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000009'::uuid,  -- poA (same org)
       'fc030300-0000-0000-0000-000000000005'::uuid,  -- whB (FOREIGN ORG!)
       'R-FK-CROSS-1', 'posted',
       'fc030300-0000-0000-0000-000000000003'::uuid,  -- usr (received_by)
       'hash-fk-cross-1'
     ) $$,
  '42501', NULL,
  'receipts: INSERT with cross-org warehouse_id raises 42501 (WITH CHECK violation)');

-- Re-assert role (savepoint exit resets SET LOCAL).
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 1b: INSERT receipt with same-org warehouse_id → lives_ok
select lives_ok(
  $$ insert into public.receipts
       (organization_id, purchase_order_id, warehouse_id, receipt_number,
        status, received_by, immutable_hash)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000009'::uuid,  -- poA
       'fc030300-0000-0000-0000-000000000004'::uuid,  -- whA (SAME ORG)
       'R-FK-SAME-1', 'posted',
       'fc030300-0000-0000-0000-000000000003'::uuid,
       'hash-fk-same-1'
     ) $$,
  'receipts: INSERT with same-org warehouse_id lives (no exception)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 2: Location-FK, direct org (purchase_orders) — nullable FK
-- The purchase_orders_write WITH CHECK now also checks location_in_org(destination_location_id, organization_id).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2a: INSERT PO with cross-org destination_location_id → 42501
select throws_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, destination_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK-PO-CROSS-LOC', 'draft',
       'fc030300-0000-0000-0000-000000000007'::uuid   -- locB1 (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'purchase_orders: INSERT with cross-org destination_location_id raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2b: INSERT PO with same-org destination_location_id → lives_ok
select lives_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, destination_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK-PO-SAME-LOC', 'draft',
       'fc030300-0000-0000-0000-000000000006'::uuid   -- locA1 (SAME ORG)
     ) $$,
  'purchase_orders: INSERT with same-org destination_location_id lives');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2c: INSERT PO with NULL destination_location_id → lives_ok (null-safety regression)
select lives_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, destination_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK-PO-NULL-LOC', 'draft',
       NULL                                           -- NULL location (MUST PASS)
     ) $$,
  'purchase_orders: INSERT with NULL destination_location_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 3: Two nullable location FKs (stock_movements)
-- The stock_movements_insert WITH CHECK now checks both from_location_id and to_location_id.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3a: INSERT stock_movement with cross-org from_location_id → 42501
select throws_ok(
  $$ insert into public.stock_movements
       (organization_id, item_id, movement_type, quantity_change,
        previous_quantity, new_quantity, from_location_id, to_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000008'::uuid,  -- itemA
       'transfer', -5, 10, 5,
       'fc030300-0000-0000-0000-000000000007'::uuid,  -- locB1 (FOREIGN ORG from_loc!)
       'fc030300-0000-0000-0000-000000000006'::uuid   -- locA1 (same-org to_loc)
     ) $$,
  '42501', NULL,
  'stock_movements: INSERT with cross-org from_location_id raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3b: INSERT stock_movement with both location FKs NULL → lives_ok (null-safety)
select lives_ok(
  $$ insert into public.stock_movements
       (organization_id, item_id, movement_type, quantity_change,
        previous_quantity, new_quantity, from_location_id, to_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000008'::uuid,  -- itemA
       'adjust', 5, 0, 5,
       NULL, NULL                                     -- BOTH NULL (MUST PASS)
     ) $$,
  'stock_movements: INSERT with both location FKs NULL lives (null-safe guard)');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3c: INSERT stock_movement with same-org locations → lives_ok
select lives_ok(
  $$ insert into public.stock_movements
       (organization_id, item_id, movement_type, quantity_change,
        previous_quantity, new_quantity, from_location_id, to_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000008'::uuid,  -- itemA
       'transfer', -3, 5, 2,
       'fc030300-0000-0000-0000-000000000006'::uuid,  -- locA1 (same org from)
       'fc030300-0000-0000-0000-000000000006'::uuid   -- locA1 (same org to)
     ) $$,
  'stock_movements: INSERT with same-org location FKs lives');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3d: INSERT stock_movement with cross-org to_location_id (same-org from) → 42501
-- (fidelity: the second of the two location guards must also fire)
select throws_ok(
  $$ insert into public.stock_movements
       (organization_id, item_id, movement_type, quantity_change,
        previous_quantity, new_quantity, from_location_id, to_location_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000008'::uuid,  -- itemA
       'transfer', -5, 10, 5,
       'fc030300-0000-0000-0000-000000000006'::uuid,  -- locA1 (same-org from_loc)
       'fc030300-0000-0000-0000-000000000007'::uuid   -- locB1 (FOREIGN ORG to_loc!)
     ) $$,
  '42501', NULL,
  'stock_movements: INSERT with cross-org to_location_id raises 42501');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 4: inventory_items.primary_location_id (nullable, complex existing WITH CHECK)
-- The inventory_items_update WITH CHECK now also checks location_in_org(primary_location_id, organization_id).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4a: UPDATE item's primary_location_id to cross-org location → 42501
select throws_ok(
  $$ update public.inventory_items
        set primary_location_id = 'fc030300-0000-0000-0000-000000000007'::uuid  -- locB1 (FOREIGN ORG!)
      where id = 'fc030300-0000-0000-0000-000000000008'::uuid $$,
  '42501', NULL,
  'inventory_items: UPDATE primary_location_id to cross-org location raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4b: UPDATE item's primary_location_id to NULL → lives_ok (null-safe)
select lives_ok(
  $$ update public.inventory_items
        set primary_location_id = NULL
      where id = 'fc030300-0000-0000-0000-000000000008'::uuid $$,
  'inventory_items: UPDATE primary_location_id to NULL lives (null-safe guard)');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4c: UPDATE item's primary_location_id to same-org location → lives_ok
select lives_ok(
  $$ update public.inventory_items
        set primary_location_id = 'fc030300-0000-0000-0000-000000000006'::uuid  -- locA1 (SAME ORG)
      where id = 'fc030300-0000-0000-0000-000000000008'::uuid $$,
  'inventory_items: UPDATE primary_location_id to same-org location lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 6: shipments.source_warehouse_id (warehouse-FK, NOT NULL, direct org)
-- The shipments_write WITH CHECK now also checks warehouse_in_org(source_warehouse_id, organization_id).
-- (org-A user is a manager — required by shipments_write.)
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 6a: INSERT shipment with cross-org source_warehouse_id → 42501
-- (destination is a charter, not a warehouse, in the live schema; use orgA charterA)
select throws_ok(
  $$ insert into public.shipments
       (organization_id, source_warehouse_id, destination_charter_id, work_order_number)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000005'::uuid,  -- whB (FOREIGN ORG source!)
       'fc030300-0000-0000-0000-00000000000a'::uuid,  -- charterA (same-org dest)
       'FK-SHIP-CROSS-1'
     ) $$,
  '42501', NULL,
  'shipments: INSERT with cross-org source_warehouse_id raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 6b: INSERT shipment with same-org source_warehouse_id → lives_ok
select lives_ok(
  $$ insert into public.shipments
       (organization_id, source_warehouse_id, destination_charter_id, work_order_number)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000004'::uuid,  -- whA (SAME ORG source)
       'fc030300-0000-0000-0000-00000000000a'::uuid,  -- charterA (same-org dest)
       'FK-SHIP-SAME-1'
     ) $$,
  'shipments: INSERT with same-org source_warehouse_id lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 7: procedures.authoring_warehouse_id (warehouse-FK, nullable, direct org)
-- The procedures_write WITH CHECK now also checks warehouse_in_org(authoring_warehouse_id, organization_id).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 7a: INSERT procedure with cross-org authoring_warehouse_id → 42501
select throws_ok(
  $$ insert into public.procedures (organization_id, title, authoring_warehouse_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK Proc Cross',
       'fc030300-0000-0000-0000-000000000005'::uuid   -- whB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'procedures: INSERT with cross-org authoring_warehouse_id raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 7b: INSERT procedure with same-org authoring_warehouse_id → lives_ok
select lives_ok(
  $$ insert into public.procedures (organization_id, title, authoring_warehouse_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK Proc Same',
       'fc030300-0000-0000-0000-000000000004'::uuid   -- whA (SAME ORG)
     ) $$,
  'procedures: INSERT with same-org authoring_warehouse_id lives');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 7c: INSERT procedure with NULL authoring_warehouse_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.procedures (organization_id, title, authoring_warehouse_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK Proc Null',
       NULL                                           -- NULL warehouse (MUST PASS)
     ) $$,
  'procedures: INSERT with NULL authoring_warehouse_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 8: schedule_events UPDATE (TWO warehouse FKs: warehouse_id + bundle_warehouse_id)
-- The schedule_events_update WITH CHECK now checks BOTH warehouse_in_org guards.
-- Event seA was seeded as org-A, created_by=usr (satisfies the existing
-- created_by = auth.uid() clause). Both warehouse FKs start NULL.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 8a: UPDATE warehouse_id to cross-org warehouse → 42501
select throws_ok(
  $$ update public.schedule_events
        set warehouse_id = 'fc030300-0000-0000-0000-000000000005'::uuid  -- whB (FOREIGN ORG!)
      where id = 'fc030300-0000-0000-0000-00000000000b'::uuid $$,
  '42501', NULL,
  'schedule_events: UPDATE warehouse_id to cross-org warehouse raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 8b: UPDATE bundle_warehouse_id to cross-org warehouse → 42501
select throws_ok(
  $$ update public.schedule_events
        set bundle_warehouse_id = 'fc030300-0000-0000-0000-000000000005'::uuid  -- whB (FOREIGN ORG!)
      where id = 'fc030300-0000-0000-0000-00000000000b'::uuid $$,
  '42501', NULL,
  'schedule_events: UPDATE bundle_warehouse_id to cross-org warehouse raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 8c: UPDATE both warehouse FKs to same-org / NULL → lives_ok
select lives_ok(
  $$ update public.schedule_events
        set warehouse_id        = 'fc030300-0000-0000-0000-000000000004'::uuid,  -- whA (SAME ORG)
            bundle_warehouse_id = NULL                                           -- NULL (null-safe)
      where id = 'fc030300-0000-0000-0000-00000000000b'::uuid $$,
  'schedule_events: UPDATE warehouse_id same-org + bundle_warehouse_id NULL lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 9: schedule_events INSERT (bundle_warehouse_id guard)
-- The schedule_events_insert WITH CHECK now also checks warehouse_in_org(bundle_warehouse_id, organization_id).
-- Existing clause: created_by = auth.uid() AND (warehouse_id IS NULL OR access).
-- Leave warehouse_id NULL to isolate the new bundle_warehouse_id guard.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 9a: INSERT schedule_event with cross-org bundle_warehouse_id → 42501
select throws_ok(
  $$ insert into public.schedule_events
       (organization_id, title, starts_at, created_by, warehouse_id, bundle_warehouse_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK Sched Cross', now(),
       'fc030300-0000-0000-0000-000000000003'::uuid,  -- usr (created_by = auth.uid())
       NULL,                                          -- warehouse_id NULL (isolate the bundle guard)
       'fc030300-0000-0000-0000-000000000005'::uuid   -- whB bundle (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'schedule_events: INSERT with cross-org bundle_warehouse_id raises 42501');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 9b: INSERT schedule_event with NULL bundle_warehouse_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.schedule_events
       (organization_id, title, starts_at, created_by, warehouse_id, bundle_warehouse_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'FK Sched Null', now(),
       'fc030300-0000-0000-0000-000000000003'::uuid,  -- usr (created_by = auth.uid())
       NULL,                                          -- warehouse_id NULL
       NULL                                           -- bundle NULL (MUST PASS)
     ) $$,
  'schedule_events: INSERT with NULL bundle_warehouse_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 5: Complex-org (warehouse_charters — org derived from charters parent)
-- The wc_admin_write WITH CHECK now also checks warehouse_in_org(warehouse_id, org_from_charter).
-- User must be admin to write warehouse_charters.
-- ─────────────────────────────────────────────────────────────────────────────

-- Elevate to admin for this section.
reset role;
update public.organization_members
   set role = 'admin'
 where organization_id = 'fc030300-0000-0000-0000-000000000001'::uuid
   and user_id = 'fc030300-0000-0000-0000-000000000003'::uuid;

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5a: INSERT warehouse_charters with cross-org warehouse_id → 42501
-- (charter belongs to orgA, but warehouse belongs to orgB)
select throws_ok(
  $$ insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA (denormalized)
       'fc030300-0000-0000-0000-000000000005'::uuid,  -- whB (FOREIGN ORG!)
       'fc030300-0000-0000-0000-00000000000a'::uuid   -- charterA (orgA)
     ) $$,
  '42501', NULL,
  'warehouse_charters: INSERT with cross-org warehouse_id raises 42501 (complex-org guard)');

set local "request.jwt.claim.sub" to 'fc030300-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5b: INSERT warehouse_charters with same-org warehouse_id → lives_ok
select lives_ok(
  $$ insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
     values (
       'fc030300-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030300-0000-0000-0000-000000000004'::uuid,  -- whA (SAME ORG)
       'fc030300-0000-0000-0000-00000000000a'::uuid   -- charterA (orgA)
     ) $$,
  'warehouse_charters: INSERT with same-org warehouse_id lives (complex-org guard)');

select * from finish();
rollback;
