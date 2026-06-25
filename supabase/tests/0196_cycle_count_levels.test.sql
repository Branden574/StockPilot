-- supabase/tests/0196_cycle_count_levels.test.sql
-- pgTAP gate for migration 0196: post_cycle_count now calls
-- apply_level_delta so item_stock_levels stays in sync with quantity_on_hand.
--
-- Two scenarios:
--   A) Negative variance (counted=7, expected=10, v_diff=−3):
--      • quantity_on_hand = 7
--      • rack level decremented to 7  (placed draw-down)
--      • no entry in Staging
--      • Σ item_stock_levels = quantity_on_hand
--      • cycle_count marked completed
--
--   B) Positive variance (counted=13, expected=10, v_diff=+3):
--      • quantity_on_hand = 13
--      • rack level stays at 10  (surplus goes to Staging, not rack)
--      • Staging level = 3
--      • Σ item_stock_levels = quantity_on_hand
--
-- NOTE: both scenarios use a clean initial state (expected=on_hand=10,
-- rack=10) so there is no drift between live qty and the snapshot.
-- Drift (live qty ≠ expected at post time) is the SAME divergence the
-- function intentionally surfaces in the stock_movements drift note; the
-- Σ invariant still holds because apply_level_delta uses v_diff (the
-- snapshot-based variance), not the live qty.
--
-- Namespace: 0xcc99 — distinct from all other test files.
--
-- Wrapped in begin/rollback — nothing leaks to the shared schema.

begin;

select plan(9);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — use a distinct namespace (0xcc99) so they never clash with
-- other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set org     '\'cc990000-0000-0000-0000-000000000001\''
\set usr     '\'cc990000-0000-0000-0000-000000000002\''
\set wh      '\'cc990000-0000-0000-0000-000000000003\''
\set item    '\'cc990000-0000-0000-0000-000000000004\''
\set rack    '\'cc990000-0000-0000-0000-000000000005\''
\set cc_neg  '\'cc990000-0000-0000-0000-000000000006\''
\set cc_pos  '\'cc990000-0000-0000-0000-000000000007\''

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED (runs as superuser — before the role switch)
-- ─────────────────────────────────────────────────────────────────────────────

-- Auth user
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'cycle-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

-- Org
insert into public.organizations (id, name, slug)
  values (:org, 'Cycle Test Org', 'cycle-test-org-0196')
  on conflict (id) do nothing;

-- Manager membership (accepted_at NOT NULL — has_org_role requires it)
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;

-- Warehouse — the 0188 trigger auto-creates Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Cycle Test WH', 'WH-CYC', 'active')
  on conflict (id) do nothing;

-- Rack location inside the warehouse (kind='rack' from 0188 column addition)
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'Rack-A1', 'bin', 'rack')
  on conflict (id) do nothing;

-- Item — warehouse_id is required by user_can_access_inventory RLS.
-- Starts with quantity_on_hand = 10.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'CYC-0196', 'Cycle Widget', 10, 'active', 'none')
  on conflict (id) do nothing;

-- Per-location stock level: all 10 units sit in the rack.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item, :rack, 10)
  on conflict (item_id, location_id) do nothing;

-- ── Cycle count A: negative variance (counted 7, expected 10 → variance −3) ──
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at)
  values (:cc_neg, :org, :wh, 'in_progress', 'warehouse', :usr, now())
  on conflict (id) do nothing;

insert into public.cycle_count_lines
  (cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id)
  values (:cc_neg, :item, 10, 7, :wh)
  on conflict do nothing;

-- ── Cycle count B: positive variance (counted 13, expected 10 → variance +3) ──
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at)
  values (:cc_pos, :org, :wh, 'in_progress', 'warehouse', :usr, now())
  on conflict (id) do nothing;

insert into public.cycle_count_lines
  (cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id)
  values (:cc_pos, :item, 10, 13, :wh)
  on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Become the manager (auth.uid() drives has_org_role + RLS)
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'cc990000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ═════════════════════════════════════════════════════════════════════════════
-- SCENARIO A — NEGATIVE VARIANCE: counted=7, expected=10 → v_diff=−3
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  perform public.post_cycle_count('cc990000-0000-0000-0000-000000000006'::uuid);
end$$;

-- 1. quantity_on_hand updated to snapshot + variance = 10 + (−3) = 7
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-000000000004'::uuid),
  7::numeric,
  'negative variance: quantity_on_hand = 7 (10 − 3)'
);

-- 2. Rack level decremented by |variance| = 10 − 3 = 7
select is(
  (select quantity from public.item_stock_levels
    where item_id    = 'cc990000-0000-0000-0000-000000000004'::uuid
      and location_id = 'cc990000-0000-0000-0000-000000000005'::uuid),
  7::numeric,
  'negative variance: rack level decremented to 7 (10 − 3)'
);

-- 3. No surplus in Staging (negative variance must not create a staging entry)
select is(
  (select coalesce(
     (select isl.quantity
        from public.item_stock_levels isl
        join public.locations l on l.id = isl.location_id
       where isl.item_id    = 'cc990000-0000-0000-0000-000000000004'::uuid
         and l.warehouse_id = 'cc990000-0000-0000-0000-000000000003'::uuid
         and l.kind         = 'staging'
       limit 1),
     0)),
  0::numeric,
  'negative variance: no entry in Staging location'
);

-- 4. Σ item_stock_levels = quantity_on_hand (invariant)
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc990000-0000-0000-0000-000000000004'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-000000000004'::uuid),
  'negative variance: Σ item_stock_levels = quantity_on_hand'
);

-- 5. Cycle count is now completed
select is(
  (select status from public.cycle_counts
    where id = 'cc990000-0000-0000-0000-000000000006'::uuid),
  'completed',
  'cycle count (negative) marked completed'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- SCENARIO B — POSITIVE VARIANCE: counted=13, expected=10 → v_diff=+3
-- Reset item + stock levels to the same initial state before running cc_pos.
-- ═════════════════════════════════════════════════════════════════════════════

-- Elevate to postgres for direct table writes (clean-slate reset).
set local role to 'postgres';

update public.inventory_items
  set quantity_on_hand = 10
  where id = 'cc990000-0000-0000-0000-000000000004'::uuid;

update public.item_stock_levels
  set quantity = 10
  where item_id    = 'cc990000-0000-0000-0000-000000000004'::uuid
    and location_id = 'cc990000-0000-0000-0000-000000000005'::uuid;

-- Remove any staging row that may have been created (clean slate).
delete from public.item_stock_levels
  where item_id = 'cc990000-0000-0000-0000-000000000004'::uuid
    and location_id in (
      select l.id from public.locations l
       where l.warehouse_id = 'cc990000-0000-0000-0000-000000000003'::uuid
         and l.kind = 'staging'
    );

-- Re-assert manager context for the second RPC call.
set local "request.jwt.claim.sub"  to 'cc990000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

do $$
begin
  perform public.post_cycle_count('cc990000-0000-0000-0000-000000000007'::uuid);
end$$;

-- 6. quantity_on_hand = 10 + 3 = 13
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-000000000004'::uuid),
  13::numeric,
  'positive variance: quantity_on_hand = 13 (10 + 3)'
);

-- 7. Rack level unchanged (surplus goes to Staging, not back to rack)
select is(
  (select quantity from public.item_stock_levels
    where item_id    = 'cc990000-0000-0000-0000-000000000004'::uuid
      and location_id = 'cc990000-0000-0000-0000-000000000005'::uuid),
  10::numeric,
  'positive variance: rack level stays at 10 (surplus not added to rack)'
);

-- 8. Surplus +3 landed in Staging
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id    = 'cc990000-0000-0000-0000-000000000004'::uuid
      and l.warehouse_id = 'cc990000-0000-0000-0000-000000000003'::uuid
      and l.kind         = 'staging'
      and l.deleted_at   is null
    limit 1),
  3::numeric,
  'positive variance: surplus (+3) landed in Staging location'
);

-- 9. Σ item_stock_levels = quantity_on_hand (invariant)
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc990000-0000-0000-0000-000000000004'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-000000000004'::uuid),
  'positive variance: Σ item_stock_levels = quantity_on_hand'
);

select * from finish();
rollback;
