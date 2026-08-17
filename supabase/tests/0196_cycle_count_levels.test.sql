-- supabase/tests/0196_cycle_count_levels.test.sql
-- pgTAP gate for migration 0196: post_cycle_count now calls
-- apply_level_delta so item_stock_levels stays in sync with quantity_on_hand.
--
-- Three scenarios:
--   A) Negative variance (counted=7, expected=10, v_diff=−3), no drift:
--      • quantity_on_hand = 7
--      • rack level decremented to 7  (placed draw-down)
--      • no staging row created
--      • Σ item_stock_levels = quantity_on_hand
--      • cycle_count marked completed
--
--   B) Positive variance (counted=13, expected=10, v_diff=+3), no drift:
--      • quantity_on_hand = 13
--      • rack level stays at 10  (surplus goes to Staging, not rack)
--      • Staging level = 3
--      • Σ item_stock_levels = quantity_on_hand
--
--   C) DRIFT (live qty ≠ snapshot): on_hand=11 and rack level=11 going in
--      (Σ=on_hand holds), but the count's snapshot expected_quantity=10 and
--      counted=7 → new on_hand = 7. This is the case the naive
--      `apply_level_delta(v_diff)` got WRONG: it would draw only 3 off
--      the live 11 levels → Σ=8 ≠ on_hand 7. The reconcile-to-new-on-hand
--      fix draws 11−7 = 4 so Σ = on_hand = 7. We assert on_hand=7, rack=7,
--      and Σ item_stock_levels = 7 (the assertion that fails under the old
--      code and proves the invariant holds even under drift).
--      0339 NOTE: the fixture inserts the line already counted, so the rebase
--      trigger stamps expected_at_start=10 and rebases expected to the live
--      11; v4 then applies (7 − 11) on top of 11 → the same on_hand 7 with a
--      chained ledger row (previous 11, change −4). See tests/0339.
--
-- Scenarios A/B use a clean initial state (expected=on_hand=rack=10) so the
-- reconcile delta equals v_diff. Scenario C deliberately seeds drift.
--
-- Namespace: 0xcc99 — distinct from all other test files.
--
-- Wrapped in begin/rollback — nothing leaks to the shared schema.

begin;

select plan(16);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — use a distinct namespace (0xcc99) so they never clash with
-- other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set org       '\'cc990000-0000-0000-0000-000000000001\''
\set usr       '\'cc990000-0000-0000-0000-000000000002\''
\set wh        '\'cc990000-0000-0000-0000-000000000003\''
\set item      '\'cc990000-0000-0000-0000-000000000004\''
\set rack      '\'cc990000-0000-0000-0000-000000000005\''
\set cc_neg    '\'cc990000-0000-0000-0000-000000000006\''
\set cc_pos    '\'cc990000-0000-0000-0000-000000000007\''
\set item_d    '\'cc990000-0000-0000-0000-000000000008\''
\set rack_d    '\'cc990000-0000-0000-0000-000000000009\''
\set cc_drift  '\'cc990000-0000-0000-0000-00000000000a\''
\set item_stg  '\'cc990000-0000-0000-0000-00000000000b\''
\set cc_stg    '\'cc990000-0000-0000-0000-00000000000c\''

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

-- 0199 trigger seeds an Unplaced row; clear it so all stock sits in the rack.
delete from public.item_stock_levels where item_id = :item;

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

-- ── DRIFT scenario item (Scenario C) ─────────────────────────────────────────
-- A fresh item whose LIVE on_hand (11) drifted above the count snapshot (10).
-- Σlevels = on_hand = 11 going in, so the invariant holds before posting.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack_d, :org, :wh, 'Rack-D1', 'bin', 'rack')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item_d, :org, :wh, 'CYC-0196-D', 'Cycle Drift Widget', 11, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; clear it so all drift-item stock sits in rack_d.
delete from public.item_stock_levels where item_id = :item_d;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item_d, :rack_d, 11)
  on conflict (item_id, location_id) do nothing;

-- Cycle count C: snapshot expected=10 (BELOW the live 11 → drift), counted=7
-- → v_diff = −3, new on_hand = expected + v_diff = 7.
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at)
  values (:cc_drift, :org, :wh, 'in_progress', 'warehouse', :usr, now())
  on conflict (id) do nothing;

insert into public.cycle_count_lines
  (cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id)
  values (:cc_drift, :item_d, 10, 7, :wh)
  on conflict do nothing;

-- ── STAGING-ONLY scenario item (Scenario D) ──────────────────────────────────
-- An item whose ENTIRE stock sits in Staging (freshly received, not yet placed).
-- quantity_on_hand=100, ALL 100 in Staging. Cycle count expected=100, counted=50
-- → v_diff=−50, new on_hand=50. With the old 'placed' mode this would raise
-- insufficient_placed_stock (0 placed stock). With 'staging_first' it drains
-- from Staging and succeeds.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item_stg, :org, :wh, 'CYC-0196-STG', 'Staging-Only Widget', 100, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; delete it so ALL stock is in Staging only.
delete from public.item_stock_levels where item_id = :item_stg;

-- Place all 100 in the warehouse Staging location.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item_stg, l.id, 100
    from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null
   limit 1
  on conflict (item_id, location_id) do nothing;

-- Cycle count D: expected=100, counted=50 → v_diff=−50, new on_hand=50.
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at)
  values (:cc_stg, :org, :wh, 'in_progress', 'warehouse', :usr, now())
  on conflict (id) do nothing;

insert into public.cycle_count_lines
  (cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id)
  values (:cc_stg, :item_stg, 100, 50, :wh)
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

-- 3. No staging ROW created (negative variance must not touch Staging at all)
select ok(
  (select count(*)
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id    = 'cc990000-0000-0000-0000-000000000004'::uuid
      and l.kind         = 'staging') = 0,
  'negative variance: no staging row created'
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

-- ═════════════════════════════════════════════════════════════════════════════
-- SCENARIO C — DRIFT: live on_hand=11 + rack=11, snapshot expected=10,
-- counted=7 → v_diff=−3, new on_hand = expected + v_diff = 7.
-- The naive apply_level_delta(v_diff=−3) would draw 3 off the live 11 → Σ=8 ≠ 7.
-- The reconcile-to-new-on-hand fix draws 11−7=4 → Σ = on_hand = 7.
-- Manager context is still active from Scenario B's re-assert above.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  perform public.post_cycle_count('cc990000-0000-0000-0000-00000000000a'::uuid);
end$$;

-- 10. quantity_on_hand = 7. Under 0196/0327 this was snapshot + v_diff =
--     10 + (−3). Since 0339 the line is REBASED when counted (expected 10 →
--     live 11, start kept in expected_at_start) and the variance 7 − 11 = −4
--     is applied on top of the live 11: 11 − 4 = 7. Same on-hand, truthful
--     ledger (previous 11, change −4). Under either arithmetic this test pins
--     that on-hand lands on the counted 7, never on 8.
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-000000000008'::uuid),
  7::numeric,
  'drift: quantity_on_hand = 7 (0339: live 11 + (7 − rebased 11) = 7; not live 11 − 3 = 8)'
);

-- 11. Σ item_stock_levels = quantity_on_hand even under drift (the core fix).
--     Old v_diff-only code would leave Σ=8 here; reconcile makes it 7.
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc990000-0000-0000-0000-000000000008'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-000000000008'::uuid),
  'drift: Σ item_stock_levels = quantity_on_hand (invariant holds under drift)'
);

-- 12. Rack level reconciled to 7 (drew the full 11 − 7 = 4, not just v_diff 3)
select is(
  (select quantity from public.item_stock_levels
    where item_id    = 'cc990000-0000-0000-0000-000000000008'::uuid
      and location_id = 'cc990000-0000-0000-0000-000000000009'::uuid),
  7::numeric,
  'drift: rack level reconciled to 7 (drew 11 − 7 = 4)'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- SCENARIO D — STAGING-ONLY STOCK: all 100 units in Staging, no placed stock.
-- counted=50, expected=100 → v_diff=−50, new on_hand=50.
-- With old 'placed' mode: find 0 placed stock → raise insufficient_placed_stock.
-- With 'staging_first' mode: drains Staging 100→50 → SUCCEEDS.
-- This scenario FAILS with the old 'placed' mode and proves the Fix 1 change.
-- Manager context is still active from Scenario C above.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  perform public.post_cycle_count('cc990000-0000-0000-0000-00000000000c'::uuid);
end$$;

-- 13. post_cycle_count succeeds and on_hand = 50.
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-00000000000b'::uuid),
  50::numeric,
  'staging-only: post_cycle_count succeeds and on_hand = 50'
);

-- 14. Σ item_stock_levels = on_hand = 50 (invariant).
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'cc990000-0000-0000-0000-00000000000b'::uuid),
  (select quantity_on_hand from public.inventory_items
    where id = 'cc990000-0000-0000-0000-00000000000b'::uuid),
  'staging-only: Σ item_stock_levels = quantity_on_hand = 50'
);

-- 15. Staging level drained to 50 (not 0 — the reconcile only removes the delta).
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id     = 'cc990000-0000-0000-0000-00000000000b'::uuid
      and l.warehouse_id  = 'cc990000-0000-0000-0000-000000000003'::uuid
      and l.kind          = 'staging'
      and l.deleted_at    is null
    limit 1),
  50::numeric,
  'staging-only: Staging level drained to 50'
);

-- 16. Cycle count is completed.
select is(
  (select status from public.cycle_counts
    where id = 'cc990000-0000-0000-0000-00000000000c'::uuid),
  'completed',
  'staging-only: cycle count marked completed'
);

select * from finish();
rollback;
