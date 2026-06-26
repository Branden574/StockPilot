-- supabase/tests/0205_supplier_fk_org_consistency_test.sql
-- pgTAP proof that migration 0205 closes the supplier FK-not-org-verified class:
-- a caller-supplied supplier_id / vendor_id FK must belong to the row's org.
--
-- Covers all 4 tables per the brief:
--   1. purchase_orders.supplier_id          cross-org → 42501; same-org → lives; NULL → lives
--   2. vendor_item_mappings.vendor_id       cross-org → 42501; same-org → lives
--      (vendor_id NOT NULL; item_id required — use itemA seeded in orgA)
--   3. inventory_items.supplier_id (INSERT)  cross-org → 42501; same-org → lives; NULL → lives
--   4. inventory_items.supplier_id (UPDATE)  cross-org → 42501; NULL → lives; same-org → lives
--   5. po_imports.vendor_id (INSERT)         cross-org → 42501; same-org → lives
--
-- Namespace: fc030500 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(13);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — namespace fc030500, never clashes with other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set orgA       '\'fc030500-0000-0000-0000-000000000001\''
\set orgB       '\'fc030500-0000-0000-0000-000000000002\''
\set usr        '\'fc030500-0000-0000-0000-000000000003\''
\set whA        '\'fc030500-0000-0000-0000-000000000004\''
\set supplierA  '\'fc030500-0000-0000-0000-000000000005\''
\set supplierB  '\'fc030500-0000-0000-0000-000000000006\''
\set itemA      '\'fc030500-0000-0000-0000-000000000007\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

-- Auth user (will be manager of org A; org B is the cross-tenant target).
-- The on_auth_user_created trigger auto-creates a user_profiles row.
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'supplier-fk-test@test.local', '{}'::jsonb) on conflict (id) do nothing;

-- Org A + Org B
insert into public.organizations (id, name, slug)
  values (:orgA, 'Supplier FK Test Org A', 'supplier-fk-test-a-0205') on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:orgB, 'Supplier FK Test Org B', 'supplier-fk-test-b-0205') on conflict (id) do nothing;

-- User is a manager of org A only (manager required for purchase_orders, po_imports, vim).
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :usr, 'manager', now()) on conflict do nothing;

-- Warehouse A in org A (needed for inventory_items warehouse context).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'Supplier FK WH A', 'WH-SFA', 'active') on conflict (id) do nothing;

-- Supplier A in org A, Supplier B in org B — the cross-tenant pair under test.
insert into public.suppliers (id, organization_id, name)
  values (:supplierA, :orgA, 'Supplier FK A') on conflict (id) do nothing;
insert into public.suppliers (id, organization_id, name)
  values (:supplierB, :orgB, 'Supplier FK B') on conflict (id) do nothing;

-- Item A in org A (warehouse A), no supplier yet — used for:
--   * inventory_items UPDATE supplier_id tests
--   * vendor_item_mappings.item_id (NOT NULL) FK
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:itemA, :orgA, :whA, 'SFK-ORG-0205', 'Supplier FK Test Item', 0, 'active', 'none')
  on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Become the org-A manager (auth.uid() + has_org_role + RLS now active).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 1: purchase_orders.supplier_id (nullable, manager required)
-- The purchase_orders_write WITH CHECK now also checks supplier_in_org(supplier_id, organization_id).
-- ─────────────────────────────────────────────────────────────────────────────

-- Test 1a: INSERT PO with cross-org supplier_id → 42501
select throws_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, supplier_id)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'SFK-PO-CROSS-SUP', 'draft',
       'fc030500-0000-0000-0000-000000000006'::uuid   -- supplierB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'purchase_orders: INSERT with cross-org supplier_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 1b: INSERT PO with same-org supplier_id → lives_ok
select lives_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, supplier_id)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'SFK-PO-SAME-SUP', 'draft',
       'fc030500-0000-0000-0000-000000000005'::uuid   -- supplierA (SAME ORG)
     ) $$,
  'purchase_orders: INSERT with same-org supplier_id lives');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 1c: INSERT PO with NULL supplier_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, supplier_id)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'SFK-PO-NULL-SUP', 'draft',
       NULL                                           -- NULL supplier (MUST PASS)
     ) $$,
  'purchase_orders: INSERT with NULL supplier_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 2: vendor_item_mappings.vendor_id (NOT NULL, manager required)
-- The vim_admin_write WITH CHECK now also checks supplier_in_org(vendor_id, organization_id).
-- item_id (NOT NULL) references an inventory_item in orgA.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2a: INSERT vendor_item_mapping with cross-org vendor_id → 42501
select throws_ok(
  $$ insert into public.vendor_item_mappings
       (organization_id, vendor_id, item_id, match_source)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000006'::uuid,  -- supplierB (FOREIGN ORG!)
       'fc030500-0000-0000-0000-000000000007'::uuid,  -- itemA (same-org — isolates vendor guard)
       'manual'
     ) $$,
  '42501', NULL,
  'vendor_item_mappings: INSERT with cross-org vendor_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2b: INSERT vendor_item_mapping with same-org vendor_id → lives_ok
select lives_ok(
  $$ insert into public.vendor_item_mappings
       (organization_id, vendor_id, item_id, match_source)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000005'::uuid,  -- supplierA (SAME ORG)
       'fc030500-0000-0000-0000-000000000007'::uuid,  -- itemA
       'manual'
     ) $$,
  'vendor_item_mappings: INSERT with same-org vendor_id lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 3: inventory_items.supplier_id (nullable, INSERT path, staff+ required)
-- The inventory_items_insert WITH CHECK now also checks supplier_in_org(supplier_id, organization_id).
-- Manager (our user) satisfies has_org_role('staff').
-- primary_location_id left NULL to avoid triggering the 0203 location guard.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3a: INSERT inventory_item with cross-org supplier_id → 42501
select throws_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, supplier_id)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000004'::uuid,  -- whA (same-org wh)
       'SFK-ITEM-CROSS', 'Cross-Supplier Item', 0, 'active', 'none',
       'fc030500-0000-0000-0000-000000000006'::uuid   -- supplierB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'inventory_items INSERT: cross-org supplier_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3b: INSERT inventory_item with same-org supplier_id → lives_ok
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, supplier_id)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000004'::uuid,  -- whA
       'SFK-ITEM-SAME-SUP', 'Same-Supplier Item', 0, 'active', 'none',
       'fc030500-0000-0000-0000-000000000005'::uuid   -- supplierA (SAME ORG)
     ) $$,
  'inventory_items INSERT: same-org supplier_id lives');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3c: INSERT inventory_item with NULL supplier_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, supplier_id)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000004'::uuid,  -- whA
       'SFK-ITEM-NULL-SUP', 'Null-Supplier Item', 0, 'active', 'none',
       NULL                                           -- NULL supplier (MUST PASS)
     ) $$,
  'inventory_items INSERT: NULL supplier_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 4: inventory_items.supplier_id (UPDATE path)
-- The inventory_items_update WITH CHECK now also checks supplier_in_org(supplier_id, organization_id).
-- itemA was seeded in orgA/whA with supplier_id=NULL.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4a: UPDATE item's supplier_id to cross-org supplier → 42501
select throws_ok(
  $$ update public.inventory_items
        set supplier_id = 'fc030500-0000-0000-0000-000000000006'::uuid  -- supplierB (FOREIGN ORG!)
      where id = 'fc030500-0000-0000-0000-000000000007'::uuid $$,
  '42501', NULL,
  'inventory_items UPDATE: supplier_id to cross-org supplier raises 42501');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4b: UPDATE item's supplier_id to NULL → lives_ok (null-safe)
select lives_ok(
  $$ update public.inventory_items
        set supplier_id = NULL
      where id = 'fc030500-0000-0000-0000-000000000007'::uuid $$,
  'inventory_items UPDATE: supplier_id to NULL lives (null-safe guard)');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4c: UPDATE item's supplier_id to same-org supplier → lives_ok
select lives_ok(
  $$ update public.inventory_items
        set supplier_id = 'fc030500-0000-0000-0000-000000000005'::uuid  -- supplierA (SAME ORG)
      where id = 'fc030500-0000-0000-0000-000000000007'::uuid $$,
  'inventory_items UPDATE: supplier_id to same-org supplier lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 5: po_imports.vendor_id (nullable, INSERT path, manager required)
-- The po_imports_insert WITH CHECK now also checks supplier_in_org(vendor_id, organization_id).
-- warehouse_id is nullable; leave NULL to keep warehouse guard passing.
-- uploaded_by must reference a valid user_profiles row — use usr (auto-created
-- by the on_auth_user_created trigger when we inserted into auth.users above).
-- po_imports requires: file_name, file_mime_type, file_size, storage_path, sha256.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5a: INSERT po_import with cross-org vendor_id → 42501
select throws_ok(
  $$ insert into public.po_imports
       (organization_id, uploaded_by, source_type, vendor_id, warehouse_id,
        file_name, file_mime_type, file_size, storage_path, sha256)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000003'::uuid,  -- usr (uploaded_by)
       'manual',
       'fc030500-0000-0000-0000-000000000006'::uuid,  -- supplierB (FOREIGN ORG!)
       NULL,                                          -- warehouse_id NULL (isolates vendor guard)
       'test-cross.pdf', 'application/pdf', 1024,
       'po-imports/cross-supplier-0205.pdf',
       'sha256-cross-supplier-0205-unique-hash'
     ) $$,
  '42501', NULL,
  'po_imports: INSERT with cross-org vendor_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030500-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5b: INSERT po_import with same-org vendor_id → lives_ok
select lives_ok(
  $$ insert into public.po_imports
       (organization_id, uploaded_by, source_type, vendor_id, warehouse_id,
        file_name, file_mime_type, file_size, storage_path, sha256)
     values (
       'fc030500-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030500-0000-0000-0000-000000000003'::uuid,  -- usr (uploaded_by)
       'manual',
       'fc030500-0000-0000-0000-000000000005'::uuid,  -- supplierA (SAME ORG)
       NULL,                                          -- warehouse_id NULL
       'test-same.pdf', 'application/pdf', 1024,
       'po-imports/same-supplier-0205.pdf',
       'sha256-same-supplier-0205-unique-hash'
     ) $$,
  'po_imports: INSERT with same-org vendor_id lives');

select * from finish();
rollback;
