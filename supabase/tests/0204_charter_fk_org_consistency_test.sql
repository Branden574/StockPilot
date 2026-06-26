-- supabase/tests/0204_charter_fk_org_consistency_test.sql
-- pgTAP proof that migration 0204 closes the charter FK-not-org-verified class:
-- a caller-supplied charter_id / *_charter_id FK must belong to the row's org.
--
-- Covers all 6 tables + null-safety per the brief:
--   1. purchase_orders.charter_id      cross-org → 42501; same-org → lives; NULL → lives
--   2. shipments.destination_charter_id (NOT NULL)  cross-org → 42501; same-org → lives
--   3. inventory_items.charter_id (ins) cross-org → 42501; NULL → lives; same-org → lives
--   4. inventory_items.charter_id (upd) cross-org → 42501; NULL → lives; same-org → lives
--   5. organization_invites.charter_id  cross-org → 42501; NULL → lives; same-org → lives
--   6. user_warehouse_assignments.charter_id cross-org → 42501; NULL → lives; same-org → lives
--
-- Namespace: fc030400 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(19);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — namespace fc030400, never clashes with other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set orgA       '\'fc030400-0000-0000-0000-000000000001\''
\set orgB       '\'fc030400-0000-0000-0000-000000000002\''
\set usr        '\'fc030400-0000-0000-0000-000000000003\''
\set whA        '\'fc030400-0000-0000-0000-000000000004\''
\set whB        '\'fc030400-0000-0000-0000-000000000005\''
\set locA1      '\'fc030400-0000-0000-0000-000000000006\''
\set itemA      '\'fc030400-0000-0000-0000-000000000007\''
\set charterA   '\'fc030400-0000-0000-0000-000000000008\''
\set charterB   '\'fc030400-0000-0000-0000-000000000009\''
\set inviteAdmn '\'fc030400-0000-0000-0000-00000000000a\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

-- Auth user (will be admin of org A; org B is the cross-tenant target).
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'charter-fk-test@test.local', '{}'::jsonb) on conflict (id) do nothing;

-- Org A + Org B
insert into public.organizations (id, name, slug)
  values (:orgA, 'Charter FK Test Org A', 'charter-fk-test-a-0204') on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:orgB, 'Charter FK Test Org B', 'charter-fk-test-b-0204') on conflict (id) do nothing;

-- User is an admin of org A only (admin required for organization_invites and user_warehouse_assignments).
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgA, :usr, 'admin', now()) on conflict do nothing;

-- Warehouses (trigger auto-creates Staging + Unplaced locations per mig 0188).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :orgA, 'Charter FK WH A', 'WH-CFA', 'active') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whB, :orgB, 'Charter FK WH B', 'WH-CFB', 'active') on conflict (id) do nothing;

-- Charter A (orgA) and Charter B (orgB) — the cross-tenant pair under test.
insert into public.charters (id, organization_id, name, code, status)
  values (:charterA, :orgA, 'Charter FK A', 'CFK-A', 'active') on conflict (id) do nothing;
insert into public.charters (id, organization_id, name, code, status)
  values (:charterB, :orgB, 'Charter FK B', 'CFK-B', 'active') on conflict (id) do nothing;

-- One explicit bin location in org A (used for inventory_items tests).
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values (:locA1, :orgA, :whA, 'CFK-A-Bin-1', 'bin')
  on conflict (id) do nothing;

-- Item A in org A (warehouse A) — used for inventory_items update tests.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:itemA, :orgA, :whA, 'CFK-ORG-0204', 'Charter FK Test Item', 0, 'active', 'none')
  on conflict (id) do nothing;

-- Junction row linking whA ↔ charterA (required by inventory_items_warehouse_charter_fk
-- and uwa_warehouse_charter_fk when both warehouse_id AND charter_id are non-null).
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
  values (:orgA, :whA, :charterA) on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Become the org-A admin (auth.uid() + has_org_role + RLS now active).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 1: purchase_orders.charter_id (NULL-able, manager+ required)
-- The purchase_orders_write WITH CHECK now also checks charter_in_org(charter_id, organization_id).
-- ─────────────────────────────────────────────────────────────────────────────

-- Test 1a: INSERT PO with cross-org charter_id → 42501
select throws_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'CFK-PO-CROSS-CHARTER', 'draft',
       'fc030400-0000-0000-0000-000000000009'::uuid   -- charterB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'purchase_orders: INSERT with cross-org charter_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 1b: INSERT PO with same-org charter_id → lives_ok
select lives_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'CFK-PO-SAME-CHARTER', 'draft',
       'fc030400-0000-0000-0000-000000000008'::uuid   -- charterA (SAME ORG)
     ) $$,
  'purchase_orders: INSERT with same-org charter_id lives');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 1c: INSERT PO with NULL charter_id → lives_ok (null-safety regression)
select lives_ok(
  $$ insert into public.purchase_orders
       (organization_id, po_number, status, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'CFK-PO-NULL-CHARTER', 'draft',
       NULL                                           -- NULL charter (MUST PASS)
     ) $$,
  'purchase_orders: INSERT with NULL charter_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 2: shipments.destination_charter_id (NOT NULL, manager+ required)
-- The shipments_write WITH CHECK now also checks charter_in_org(destination_charter_id, organization_id).
-- source_warehouse_id must be in orgA (reuses whA from 0203 pattern; orgA user is admin).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2a: INSERT shipment with cross-org destination_charter_id → 42501
-- (source_warehouse_id is in orgA, only the charter is foreign)
select throws_ok(
  $$ insert into public.shipments
       (organization_id, source_warehouse_id, destination_charter_id, work_order_number)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (same-org source — isolates charter guard)
       'fc030400-0000-0000-0000-000000000009'::uuid,  -- charterB (FOREIGN ORG destination!)
       'CFK-SHIP-CROSS-CHARTER'
     ) $$,
  '42501', NULL,
  'shipments: INSERT with cross-org destination_charter_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 2b: INSERT shipment with same-org destination_charter_id → lives_ok
select lives_ok(
  $$ insert into public.shipments
       (organization_id, source_warehouse_id, destination_charter_id, work_order_number)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (SAME ORG source)
       'fc030400-0000-0000-0000-000000000008'::uuid,  -- charterA (SAME ORG destination)
       'CFK-SHIP-SAME-CHARTER'
     ) $$,
  'shipments: INSERT with same-org destination_charter_id lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 3: inventory_items.charter_id (nullable, INSERT path)
-- The inventory_items_insert WITH CHECK now also checks charter_in_org(charter_id, organization_id).
-- Staff+ required; admin (our user) satisfies has_org_role('staff').
-- primary_location_id must be in orgA or NULL (from mig 0203 guard).
-- Use locA1 so the 0203 location guard passes and ONLY the charter guard is new.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3a: INSERT inventory_item with cross-org charter_id → 42501
select throws_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, primary_location_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (same-org wh)
       'CFK-ITEM-CROSS', 'Cross-Charter Item', 0, 'active', 'none',
       'fc030400-0000-0000-0000-000000000006'::uuid,  -- locA1 (same-org loc — isolates charter)
       'fc030400-0000-0000-0000-000000000009'::uuid   -- charterB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'inventory_items INSERT: cross-org charter_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3b: INSERT inventory_item with NULL charter_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, primary_location_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA
       'CFK-ITEM-NULL-CHR', 'Null-Charter Item', 0, 'active', 'none',
       'fc030400-0000-0000-0000-000000000006'::uuid,  -- locA1
       NULL                                           -- NULL charter (MUST PASS)
     ) $$,
  'inventory_items INSERT: NULL charter_id lives (null-safe guard)');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 3c: INSERT inventory_item with same-org charter_id → lives_ok
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, primary_location_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA
       'CFK-ITEM-SAME-CHR', 'Same-Charter Item', 0, 'active', 'none',
       'fc030400-0000-0000-0000-000000000006'::uuid,  -- locA1
       'fc030400-0000-0000-0000-000000000008'::uuid   -- charterA (SAME ORG)
     ) $$,
  'inventory_items INSERT: same-org charter_id lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 4: inventory_items.charter_id (UPDATE path)
-- The inventory_items_update WITH CHECK now also checks charter_in_org(charter_id, organization_id).
-- itemA was seeded in orgA/whA with charter_id=NULL.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4a: UPDATE item's charter_id to cross-org charter → 42501
select throws_ok(
  $$ update public.inventory_items
        set charter_id = 'fc030400-0000-0000-0000-000000000009'::uuid  -- charterB (FOREIGN ORG!)
      where id = 'fc030400-0000-0000-0000-000000000007'::uuid $$,
  '42501', NULL,
  'inventory_items UPDATE: charter_id to cross-org raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4b: UPDATE item's charter_id to NULL → lives_ok (null-safe)
select lives_ok(
  $$ update public.inventory_items
        set charter_id = NULL
      where id = 'fc030400-0000-0000-0000-000000000007'::uuid $$,
  'inventory_items UPDATE: charter_id to NULL lives (null-safe guard)');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 4c: UPDATE item's charter_id to same-org charter → lives_ok
select lives_ok(
  $$ update public.inventory_items
        set charter_id = 'fc030400-0000-0000-0000-000000000008'::uuid  -- charterA (SAME ORG)
      where id = 'fc030400-0000-0000-0000-000000000007'::uuid $$,
  'inventory_items UPDATE: charter_id to same-org lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 5: organization_invites.charter_id (nullable, admin required)
-- The organization_invites_insert WITH CHECK now also checks charter_in_org(charter_id, organization_id).
-- warehouse_id must be in orgA or NULL (from 0203 guard). Use NULL to isolate charter guard.
-- invited_by must reference a valid user_profiles row — use usr.
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5a: INSERT organization_invite with cross-org charter_id → 42501
select throws_ok(
  $$ insert into public.organization_invites
       (organization_id, email, role, token, expires_at, invited_by, warehouse_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'invite-cross@test.local', 'staff',
       'tok-cross-charter-0204',
       now() + interval '7 days',
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr (invited_by)
       NULL,                                          -- warehouse_id NULL (isolates charter guard)
       'fc030400-0000-0000-0000-000000000009'::uuid   -- charterB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'organization_invites: INSERT with cross-org charter_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5b: INSERT organization_invite with same-org charter_id → lives_ok
select lives_ok(
  $$ insert into public.organization_invites
       (organization_id, email, role, token, expires_at, invited_by, warehouse_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'invite-same@test.local', 'staff',
       'tok-same-charter-0204',
       now() + interval '7 days',
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr
       NULL,                                          -- warehouse_id NULL
       'fc030400-0000-0000-0000-000000000008'::uuid   -- charterA (SAME ORG)
     ) $$,
  'organization_invites: INSERT with same-org charter_id lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 6: user_warehouse_assignments.charter_id (nullable, admin required)
-- The uwa_admin_write WITH CHECK now also checks charter_in_org(charter_id, organization_id).
-- warehouse_id must be in orgA (from 0203 guard — already enforced). Use whA.
-- user_id must reference a valid user_profiles row — use usr itself (self-assign fine for test).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 6a: INSERT user_warehouse_assignment with cross-org charter_id → 42501
select throws_ok(
  $$ insert into public.user_warehouse_assignments
       (organization_id, user_id, warehouse_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (same-org — isolates charter guard)
       'fc030400-0000-0000-0000-000000000009'::uuid   -- charterB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'user_warehouse_assignments: INSERT with cross-org charter_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 6b: INSERT user_warehouse_assignment with NULL charter_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.user_warehouse_assignments
       (organization_id, user_id, warehouse_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA
       NULL                                           -- NULL charter (MUST PASS)
     ) $$,
  'user_warehouse_assignments: INSERT with NULL charter_id lives (null-safe guard)');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 6c: INSERT user_warehouse_assignment with same-org charter_id → lives_ok
select lives_ok(
  $$ insert into public.user_warehouse_assignments
       (organization_id, user_id, warehouse_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr (already has NULL row; new row fine)
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (same-org)
       'fc030400-0000-0000-0000-000000000008'::uuid   -- charterA (SAME ORG)
     ) $$,
  'user_warehouse_assignments: INSERT with same-org charter_id lives');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 5c: organization_invites.charter_id = NULL (null-safe branch, previously untested)
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 5c: INSERT organization_invite with NULL charter_id → lives_ok (null-safe)
select lives_ok(
  $$ insert into public.organization_invites
       (organization_id, email, role, token, expires_at, invited_by, warehouse_id, charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'invite-null-charter@test.local', 'staff',
       'tok-null-charter-0204',
       now() + interval '7 days',
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr (invited_by)
       NULL,                                          -- warehouse_id NULL
       NULL                                           -- NULL charter (MUST PASS)
     ) $$,
  'organization_invites: INSERT with NULL charter_id lives (null-safe guard)');

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape 7: order_requests.delivery_charter_id (nullable, INSERT policy)
-- Policy requires: is_org_member + source='internal' + requester_user_id=auth.uid()
--   + warehouse_in_org(warehouse_id) + charter_in_org(delivery_charter_id).
-- fulfillment_type defaults to 'delivery'; check constraint (NOT VALID, mig 0110)
--   requires delivery_charter_id IS NOT NULL when fulfillment_type='delivery', so
--   supply a non-null value to isolate the org-guard (not the check constraint).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 7a: INSERT order_request with cross-org delivery_charter_id → 42501
select throws_ok(
  $$ insert into public.order_requests
       (organization_id, warehouse_id, source, requester_user_id,
        fulfillment_type, delivery_charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (same-org — isolates charter guard)
       'internal',
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr = auth.uid()
       'delivery',
       'fc030400-0000-0000-0000-000000000009'::uuid   -- charterB (FOREIGN ORG!)
     ) $$,
  '42501', NULL,
  'order_requests: INSERT with cross-org delivery_charter_id raises 42501');

set local "request.jwt.claim.sub"  to 'fc030400-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Test 7b: INSERT order_request with same-org delivery_charter_id → lives_ok
select lives_ok(
  $$ insert into public.order_requests
       (organization_id, warehouse_id, source, requester_user_id,
        fulfillment_type, delivery_charter_id)
     values (
       'fc030400-0000-0000-0000-000000000001'::uuid,  -- orgA
       'fc030400-0000-0000-0000-000000000004'::uuid,  -- whA (SAME ORG)
       'internal',
       'fc030400-0000-0000-0000-000000000003'::uuid,  -- usr = auth.uid()
       'delivery',
       'fc030400-0000-0000-0000-000000000008'::uuid   -- charterA (SAME ORG)
     ) $$,
  'order_requests: INSERT with same-org delivery_charter_id lives');

select * from finish();
rollback;
