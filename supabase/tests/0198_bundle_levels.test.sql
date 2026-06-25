-- 0198_bundle_levels.test.sql
-- ============================================================================
-- pgTAP tests: assemble_bundle + distribute_bundle maintain item_stock_levels
-- after migration 0198.
--
-- Plan: 12 assertions
--   ASSEMBLE
--   1-2  assemble happy path: compA and compB placed levels decremented
--   3    assemble happy path: phantom's Staging level = assembled qty
--   4-5  Σ item_stock_levels = quantity_on_hand for compA and compB post-assemble
--   6    Σ item_stock_levels = quantity_on_hand for phantom post-assemble
--   7    assemble blocked when component stock is only in Staging → insufficient_placed_stock
--   DISTRIBUTE
--   8    staging_first round-trip: distribute the just-assembled phantom →
--        phantom Staging level drops back to 0 (drained from Staging, NOT a rack)
--   9    staging_first round-trip: Σ isl = quantity_on_hand for phantom (= 0)
--   10   virtual-portion: distribute past phantom → component rack levels drop
--   11   virtual-portion: Σ isl = quantity_on_hand for both consumed components
--   12   allow_shortage: clamped draw keeps Σ isl = quantity_on_hand (clamped
--        v_draw delta used, not the larger requested amount)
-- ============================================================================

begin;
select plan(12);

-- ===========================================================================
-- Fixture UUIDs — prefix fb98 to avoid collisions with other test files
-- ===========================================================================
\set org    '\'fb980000-0000-0000-0000-000000000001\''
\set usr    '\'fb980000-0000-0000-0000-000000000002\''
\set wh     '\'fb980000-0000-0000-0000-000000000003\''
\set compA  '\'fb980000-0000-0000-0000-000000000004\''
\set compB  '\'fb980000-0000-0000-0000-000000000005\''
\set rack   '\'fb980000-0000-0000-0000-000000000006\''
\set bundle '\'fb980000-0000-0000-0000-000000000007\''

-- ===========================================================================
-- Seed: run as superuser before switching to authenticated role
-- ===========================================================================

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bundle-levels-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Bundle Levels Test Org', 'bundle-levels-test-0198')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;

-- Warehouse — tg_seed_warehouse_locations (0188) auto-creates Staging + Unplaced
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Bundle Levels WH', 'WH-BL98', 'active')
  on conflict (id) do nothing;

-- Rack location (kind='rack') — assemble_bundle draws placed stock from here
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'Rack L-01', 'bin', 'rack')
  on conflict (id) do nothing;

-- Component items with 20 and 30 units on hand
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:compA, :org, :wh, 'COMP-A-0198', 'Component Alpha 0198', 20, 'active', 'none'),
    (:compB, :org, :wh, 'COMP-B-0198', 'Component Beta 0198',  30, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds Unplaced rows for both components; clear them so all stock
-- sits in the rack for assemble_bundle's placed draw-down.
delete from public.item_stock_levels where item_id in (:compA, :compB);

-- Place all component stock in the rack location so assemble_bundle can consume it
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values
    (:org, :compA, :rack, 20),
    (:org, :compB, :rack, 30)
  on conflict (item_id, location_id) do nothing;

-- Bundle: 1 kit = 2× compA + 3× compB, preassembly_enabled = true
insert into public.bundles
  (id, organization_id, name, sku, is_active, preassembly_enabled)
  values (:bundle, :org, 'Levels Kit 0198', 'BNDL-LVL98', true, true)
  on conflict (id) do nothing;

insert into public.bundle_components (bundle_id, item_id, quantity, is_optional)
  values
    (:bundle, :compA, 2, false),
    (:bundle, :compB, 3, false)
  on conflict (bundle_id, item_id) do nothing;

-- ===========================================================================
-- Switch to authenticated manager context
-- ===========================================================================
set local "request.jwt.claim.sub"  to 'fb980000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ===========================================================================
-- Happy-path: assemble 1 bundle
--   Consumes: 1×2=2 compA, 1×3=3 compB
--   compA: qoh 20→18, rack isl 20→18
--   compB: qoh 30→27, rack isl 30→27
--   phantom: qoh 0→1, Staging isl 0→1
-- ===========================================================================
do $$
begin
  perform public.assemble_bundle(
    'fb980000-0000-0000-0000-000000000007'::uuid,
    1,
    'fb980000-0000-0000-0000-000000000003'::uuid,
    'pgtap-0198-happy'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Assertion 1: compA placed (rack) level decremented by 2 (20 → 18)
-- ---------------------------------------------------------------------------
select is(
  (select quantity from public.item_stock_levels
     where item_id    = 'fb980000-0000-0000-0000-000000000004'::uuid
       and location_id = 'fb980000-0000-0000-0000-000000000006'::uuid),
  18::numeric,
  'assemble: compA rack level decremented by 2 (20 -> 18)'
);

-- ---------------------------------------------------------------------------
-- Assertion 2: compB placed (rack) level decremented by 3 (30 → 27)
-- ---------------------------------------------------------------------------
select is(
  (select quantity from public.item_stock_levels
     where item_id    = 'fb980000-0000-0000-0000-000000000005'::uuid
       and location_id = 'fb980000-0000-0000-0000-000000000006'::uuid),
  27::numeric,
  'assemble: compB rack level decremented by 3 (30 -> 27)'
);

-- ---------------------------------------------------------------------------
-- Assertion 3: phantom assembled qty (1) landed in Staging item_stock_level
-- ---------------------------------------------------------------------------
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
     join public.bundles b   on b.phantom_item_id = isl.item_id
    where b.id = 'fb980000-0000-0000-0000-000000000007'::uuid
      and l.warehouse_id = 'fb980000-0000-0000-0000-000000000003'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  1::numeric,
  'assemble: phantom assembled qty (1) landed in Staging item_stock_levels'
);

-- ---------------------------------------------------------------------------
-- Assertion 4: Σ item_stock_levels = quantity_on_hand for compA
-- ---------------------------------------------------------------------------
select is(
  (select sum(isl.quantity)
     from public.item_stock_levels isl
    where isl.item_id = 'fb980000-0000-0000-0000-000000000004'::uuid),
  (select quantity_on_hand
     from public.inventory_items
    where id = 'fb980000-0000-0000-0000-000000000004'::uuid),
  'assemble: Sigma(isl) = quantity_on_hand for compA after assemble'
);

-- ---------------------------------------------------------------------------
-- Assertion 5: Σ item_stock_levels = quantity_on_hand for compB
-- ---------------------------------------------------------------------------
select is(
  (select sum(isl.quantity)
     from public.item_stock_levels isl
    where isl.item_id = 'fb980000-0000-0000-0000-000000000005'::uuid),
  (select quantity_on_hand
     from public.inventory_items
    where id = 'fb980000-0000-0000-0000-000000000005'::uuid),
  'assemble: Sigma(isl) = quantity_on_hand for compB after assemble'
);

-- ---------------------------------------------------------------------------
-- Assertion 6: Σ item_stock_levels = quantity_on_hand for phantom
-- ---------------------------------------------------------------------------
select is(
  (select sum(isl.quantity)
     from public.item_stock_levels isl
     join public.bundles b on b.phantom_item_id = isl.item_id
    where b.id = 'fb980000-0000-0000-0000-000000000007'::uuid),
  (select ii.quantity_on_hand
     from public.inventory_items ii
     join public.bundles b on b.phantom_item_id = ii.id
    where b.id = 'fb980000-0000-0000-0000-000000000007'::uuid),
  'assemble: Sigma(isl) = quantity_on_hand for phantom after assemble'
);

-- ===========================================================================
-- Assertion 7: assemble blocked when component stock is only in Staging
--
-- Setup: a component with qoh=5 but isl row only in Staging (no placed stock).
-- Migration 0198 adds apply_level_delta('placed') which raises
-- insufficient_placed_stock when placed sum < needed.
-- ===========================================================================
do $$
declare
  v_staging_loc uuid;
  -- Use a distinct UUID prefix so assemble_bundle's phantom SKU
  -- (__BUNDLE__ + substr(bundle_id,1,8)) does not collide with the
  -- main bundle above (both started with 'fb980000', producing the
  -- same 8-char prefix).  'fb981111-...' gives '__BUNDLE__fb981111'.
  v_comp_stg    uuid := 'fb981111-0000-0000-0000-000000000001';
  v_bundle2     uuid := 'fb981111-0000-0000-0000-000000000002';
  v_org         uuid := 'fb980000-0000-0000-0000-000000000001';
  v_wh          uuid := 'fb980000-0000-0000-0000-000000000003';
begin
  -- Resolve auto-created Staging location for our warehouse
  select id into v_staging_loc
    from public.locations
   where warehouse_id = v_wh
     and kind = 'staging'
     and deleted_at is null
   limit 1;

  -- Staging-only component: qoh=5, isl only in Staging
  insert into public.inventory_items
    (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
    values (v_comp_stg, v_org, v_wh, 'COMP-STGONLY-0198', 'Staging-Only 0198', 5, 'active', 'none')
    on conflict (id) do nothing;

  -- 0199 trigger seeds an Unplaced row; clear it so this item has ZERO placed stock.
  delete from public.item_stock_levels where item_id = v_comp_stg;

  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_org, v_comp_stg, v_staging_loc, 5)
    on conflict (item_id, location_id) do nothing;

  -- Bundle2 requires 1× of the staging-only component.
  -- Its phantom SKU will be '__BUNDLE__fb981111' (no collision with main bundle).
  insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled)
    values (v_bundle2, v_org, 'Staging Kit 0198', 'BNDL-STG98', true, true)
    on conflict (id) do nothing;

  insert into public.bundle_components (bundle_id, item_id, quantity, is_optional)
    values (v_bundle2, v_comp_stg, 1, false)
    on conflict (bundle_id, item_id) do nothing;
end $$;

-- Re-assert authenticated context (do blocks may reset SET LOCAL)
set local "request.jwt.claim.sub"  to 'fb980000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ select public.assemble_bundle(
       'fb981111-0000-0000-0000-000000000002'::uuid,
       1,
       'fb980000-0000-0000-0000-000000000003'::uuid,
       'pgtap-0198-staged-only'
     ) $$,
  'P0001', 'insufficient_placed_stock',
  'assemble: blocked when component stock is only in Staging (insufficient_placed_stock)'
);

-- ###########################################################################
-- DISTRIBUTE section
--
-- State at this point (from the assemble happy path, tests 1-6):
--   phantom (of main bundle fb98...07): qoh=1, Staging isl=1
--   compA: qoh=18, rack isl=18      compB: qoh=27, rack isl=27
-- ###########################################################################

-- Re-assert authenticated manager context (do blocks above may have reset it)
set local "request.jwt.claim.sub"  to 'fb980000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ===========================================================================
-- DISTRIBUTE A: staging_first round-trip.
--   Distribute 1 unit of the main bundle. Since phantom qoh=1, the whole
--   distribution is satisfied from the phantom (v_use_phantom=1, v_use_virtual=0).
--   The phantom drain uses mode 'staging_first', so the kit must leave Staging,
--   NOT a rack.
--   Expected: phantom Staging isl 1→0, phantom qoh 1→0, components UNTOUCHED.
-- ===========================================================================
do $$
begin
  perform public.distribute_bundle(
    'fb980000-0000-0000-0000-000000000007'::uuid,  -- p_bundle_id (main bundle)
    1,                                              -- p_quantity
    'fb980000-0000-0000-0000-000000000003'::uuid,  -- p_warehouse_id
    false,                                          -- p_allow_shortage
    null,                                           -- p_schedule_event_id
    'pgtap-0198-distribute-phantom'                 -- p_notes
  );
end $$;

-- ---------------------------------------------------------------------------
-- Assertion 8: phantom Staging level drained back to 0 (staging_first).
--   If the phantom drain used the wrong mode (e.g. 'placed') it would have
--   tried to draw from a rack and left Staging at 1 — this catches that.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(sum(isl.quantity), 0)
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
     join public.bundles b   on b.phantom_item_id = isl.item_id
    where b.id = 'fb980000-0000-0000-0000-000000000007'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null),
  0::numeric,
  'distribute: phantom Staging level drained 1 -> 0 via staging_first'
);

-- ---------------------------------------------------------------------------
-- Assertion 9: Σ isl = quantity_on_hand for phantom after the round-trip (= 0).
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(sum(isl.quantity), 0)
     from public.item_stock_levels isl
     join public.bundles b on b.phantom_item_id = isl.item_id
    where b.id = 'fb980000-0000-0000-0000-000000000007'::uuid),
  (select ii.quantity_on_hand
     from public.inventory_items ii
     join public.bundles b on b.phantom_item_id = ii.id
    where b.id = 'fb980000-0000-0000-0000-000000000007'::uuid),
  'distribute: Sigma(isl) = quantity_on_hand for phantom after staging_first round-trip'
);

-- ===========================================================================
-- DISTRIBUTE B: virtual-portion / component-consume path.
--   Phantom is now 0, so distributing 1 more unit makes v_use_phantom=0 and
--   v_use_virtual=1 → the component loop runs and draws from PLACED (rack).
--   Expected: compA rack 18→16 (needs 2), compB rack 27→24 (needs 3).
-- ===========================================================================
do $$
begin
  perform public.distribute_bundle(
    'fb980000-0000-0000-0000-000000000007'::uuid,
    1,
    'fb980000-0000-0000-0000-000000000003'::uuid,
    false,
    null,
    'pgtap-0198-distribute-virtual'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Assertion 10: component rack (placed) levels dropped for the virtual portion.
-- ---------------------------------------------------------------------------
select is(
  array[
    (select quantity from public.item_stock_levels
       where item_id    = 'fb980000-0000-0000-0000-000000000004'::uuid
         and location_id = 'fb980000-0000-0000-0000-000000000006'::uuid),
    (select quantity from public.item_stock_levels
       where item_id    = 'fb980000-0000-0000-0000-000000000005'::uuid
         and location_id = 'fb980000-0000-0000-0000-000000000006'::uuid)
  ],
  array[16::numeric, 24::numeric],
  'distribute: virtual portion drew compA rack 18->16 and compB rack 27->24 (placed)'
);

-- ---------------------------------------------------------------------------
-- Assertion 11: Σ isl = quantity_on_hand for both components after virtual draw.
-- ---------------------------------------------------------------------------
select is(
  array[
    (select sum(quantity) from public.item_stock_levels
       where item_id = 'fb980000-0000-0000-0000-000000000004'::uuid),
    (select sum(quantity) from public.item_stock_levels
       where item_id = 'fb980000-0000-0000-0000-000000000005'::uuid)
  ],
  array[
    (select quantity_on_hand from public.inventory_items
       where id = 'fb980000-0000-0000-0000-000000000004'::uuid),
    (select quantity_on_hand from public.inventory_items
       where id = 'fb980000-0000-0000-0000-000000000005'::uuid)
  ],
  'distribute: Sigma(isl) = quantity_on_hand for compA and compB after virtual draw'
);

-- ===========================================================================
-- DISTRIBUTE C: allow_shortage clamped path.
--   Fresh bundle whose component has only 1 placed unit but the distribution
--   needs more. With p_allow_shortage=true the loop clamps v_draw to v_have
--   (1) and records a shortage for the remainder. The apply_level_delta must
--   use the CLAMPED v_draw (= 1), not the requested amount — otherwise Σ isl
--   would diverge from quantity_on_hand.
--
--   Component fb98...0c: qoh=1, rack isl=1. Bundle fb982222 needs 5 per kit.
--   Distribute 1 kit (needs 5), allow_shortage=true:
--     v_have=1, v_draw=least(5,1)=1, v_short=4 → qoh 1→0, rack isl 1→0.
-- ===========================================================================
do $$
declare
  v_rack2     uuid := 'fb982222-0000-0000-0000-000000000001';
  v_comp_sh   uuid := 'fb982222-0000-0000-0000-00000000000c';
  v_bundle3   uuid := 'fb982222-0000-0000-0000-000000000003';  -- phantom SKU '__BUNDLE__fb982222'
  v_org       uuid := 'fb980000-0000-0000-0000-000000000001';
  v_wh        uuid := 'fb980000-0000-0000-0000-000000000003';
begin
  -- A second rack location for clarity (any placed location works).
  insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
    values (v_rack2, v_org, v_wh, 'Rack L-02', 'bin', 'rack')
    on conflict (id) do nothing;

  -- Shortage component: qoh=1, all placed.
  insert into public.inventory_items
    (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
    values (v_comp_sh, v_org, v_wh, 'COMP-SHORT-0198', 'Shortage Component 0198', 1, 'active', 'none')
    on conflict (id) do nothing;

  -- 0199 trigger seeds an Unplaced row; clear it so the only placed stock is rack2=1.
  delete from public.item_stock_levels where item_id = v_comp_sh;

  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_org, v_comp_sh, v_rack2, 1)
    on conflict (item_id, location_id) do nothing;

  -- Bundle needs 5 of the shortage component per kit (no preassembly needed
  -- for distribute, but set true for consistency).
  insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled)
    values (v_bundle3, v_org, 'Shortage Kit 0198', 'BNDL-SHORT98', true, true)
    on conflict (id) do nothing;

  insert into public.bundle_components (bundle_id, item_id, quantity, is_optional)
    values (v_bundle3, v_comp_sh, 5, false)
    on conflict (bundle_id, item_id) do nothing;
end $$;

set local "request.jwt.claim.sub"  to 'fb980000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

do $$
begin
  perform public.distribute_bundle(
    'fb982222-0000-0000-0000-000000000003'::uuid,  -- shortage bundle
    1,                                              -- 1 kit, needs 5 of comp
    'fb980000-0000-0000-0000-000000000003'::uuid,
    true,                                           -- p_allow_shortage = TRUE
    null,
    'pgtap-0198-distribute-shortage'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Assertion 12: clamped allow_shortage draw keeps Σ isl = quantity_on_hand.
--   Both should equal 0 (the 1 placed unit was drawn; the other 4 short).
--   If apply_level_delta had used the requested -5 instead of the clamped -1,
--   Σ isl would be -4 while qoh is 0 → this assertion catches it.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels
     where item_id = 'fb982222-0000-0000-0000-00000000000c'::uuid),
  (select quantity_on_hand from public.inventory_items
     where id = 'fb982222-0000-0000-0000-00000000000c'::uuid),
  'distribute: allow_shortage clamped draw keeps Sigma(isl) = quantity_on_hand'
);

select * from finish();
rollback;
