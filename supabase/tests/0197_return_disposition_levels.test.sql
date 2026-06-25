-- supabase/tests/0197_return_disposition_levels.test.sql
-- pgTAP gate for migration 0197: process_return_disposition now calls
-- apply_level_delta so item_stock_levels stays in sync with quantity_on_hand.
--
-- Two scenarios:
--   A) RESTOCK (disposition='restock', qty R=3):
--      • quantity_on_hand rose by R (100 → 103)
--      • item_stock_levels[Staging] rose by R (100 → 103)
--      • Σ item_stock_levels = quantity_on_hand
--      • returned_quantity incremented on source line
--      • return status flipped to 'closed'
--
--   B) SCRAP (disposition='scrap', qty S=4):
--      • quantity_on_hand net unchanged (net-zero: +4 then −4 → still 100)
--      • item_stock_levels[Staging] net unchanged (staging_first drains: +4 then −4 → still 100)
--      • No stranded Staging unit (Staging level = 100, not 104)
--      • Placed rack level UNTOUCHED (scrap uses staging_first, not placed)
--      • Σ item_stock_levels = quantity_on_hand
--      • returned_quantity incremented on source line
--      • return status flipped to 'closed'
--
-- Namespace: 0xee97 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks to the shared schema.

begin;

select plan(12);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixed UUIDs — namespace 0xee97 so they never clash with other test files.
-- ─────────────────────────────────────────────────────────────────────────────
\set org_id      '\'ee970000-0000-0000-0000-000000000001\''
\set mgr_id      '\'ee970000-0000-0000-0000-000000000002\''
\set wh_id       '\'ee970000-0000-0000-0000-000000000003\''
\set item_rst    '\'ee970000-0000-0000-0000-000000000011\''
\set item_scr    '\'ee970000-0000-0000-0000-000000000012\''
\set rack_scr    '\'ee970000-0000-0000-0000-000000000013\''
\set order_id    '\'ee970000-0000-0000-0000-000000000021\''
\set line_rst    '\'ee970000-0000-0000-0000-000000000031\''
\set line_scr    '\'ee970000-0000-0000-0000-000000000032\''
\set ret_rst     '\'ee970000-0000-0000-0000-000000000041\''
\set ret_scr     '\'ee970000-0000-0000-0000-000000000042\''

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED (runs as superuser — before the role switch)
-- ─────────────────────────────────────────────────────────────────────────────

-- auth.users row — fires on_auth_user_created → creates user_profiles row
-- that *_by FKs reference (same gotcha as 0158 line 76 and 0196 test).
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr_id, 'rtn-0197-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org_id, 'RTN 0197 Test Org', 'rtn-0197-test-org')
  on conflict (id) do nothing;

-- Manager role — required by process_return_disposition's has_org_role('manager')
-- check and by returns/return_lines INSERT+UPDATE RLS (0153).
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org_id, :mgr_id, 'manager', now())
  on conflict do nothing;

-- Warehouse — the 0188 trigger auto-creates Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh_id, :org_id, 'RTN 0197 WH', 'WH-R97', 'active')
  on conflict (id) do nothing;

-- Items: quantity_on_hand = 100 represents post-fulfilment level (the units
-- already left on-hand when they were fulfilled; process_return_disposition
-- re-adds them back).
-- warehouse_id is NOT NULL for user_can_access_inventory RLS.
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values
    (:item_rst, :org_id, :wh_id, 'Restock RTN 0197', 'SKU-R97-RST', 100, 'active', 'none'),
    (:item_scr, :org_id, :wh_id, 'Scrap RTN 0197',   'SKU-R97-SCR', 100, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds Unplaced rows for both items (quantity_on_hand=100 each);
-- clear them now so we can place all stock explicitly in Staging below.
delete from public.item_stock_levels
  where item_id in (
    'ee970000-0000-0000-0000-000000000011'::uuid,
    'ee970000-0000-0000-0000-000000000012'::uuid
  );

-- Seed Staging item_stock_levels so Σ=on_hand holds BEFORE we call the RPC.
-- Both items: all 100 units already in Staging (realistic for just-received stock).
-- The RESTOCK test will add +3 to this; the SCRAP test will add +4 then −4 (net 0).
do $$
declare
  v_staging uuid;
begin
  -- Staging location is auto-created by the 0188 trigger when the warehouse was
  -- inserted above. Look it up by warehouse + kind.
  select id into v_staging
    from public.locations
   where warehouse_id = 'ee970000-0000-0000-0000-000000000003'::uuid
     and kind = 'staging'
     and deleted_at is null
   limit 1;

  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values
      ('ee970000-0000-0000-0000-000000000001'::uuid,
       'ee970000-0000-0000-0000-000000000011'::uuid, v_staging, 100),
      ('ee970000-0000-0000-0000-000000000001'::uuid,
       'ee970000-0000-0000-0000-000000000012'::uuid, v_staging, 100)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;
end$$;

-- Scrap item also has some placed stock in a rack so we can assert the rack is
-- UNTOUCHED by the scrap write-off (which must use staging_first, not placed).
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack_scr, :org_id, :wh_id, 'Rack-R97-Scrap', 'bin', 'rack')
  on conflict (id) do nothing;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org_id, :item_scr, :rack_scr, 20)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

-- Update item_scr on_hand to reflect the total (Staging 100 + rack 20 = 120).
update public.inventory_items
  set quantity_on_hand = 120
  where id = :item_scr;

-- Fulfilled order_request (status 'in_transit', fulfillment_type 'pickup' —
-- see 0158 line 120 for why these are the minimal valid choices).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values (:order_id, :org_id, :wh_id, 'in_transit', :mgr_id, 'internal', 'pickup')
  on conflict (id) do nothing;

-- Source order lines: quantity_fulfilled > 0 (fulfillment already happened);
-- returned_quantity starts at 0 (no prior returns applied).
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled)
  values
    (:line_rst, :order_id, :item_rst, 10, 5),
    (:line_scr, :order_id, :item_scr, 10, 5)
  on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Become the manager (auth.uid() drives has_org_role + RLS write policies).
-- Mirrors 0027's "become this user" idiom (0158 line 151).
-- ─────────────────────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub"  to 'ee970000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ═════════════════════════════════════════════════════════════════════════════
-- SCENARIO A — RESTOCK
-- Return 3 units of item_rst as 'restock'.
-- Expected (0197):
--   quantity_on_hand:           100 → 103  (+3)
--   item_stock_levels[Staging]: 100 → 103  (+3, apply_level_delta +3)
--   Σ item_stock_levels = quantity_on_hand = 103
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_rst, :org_id, :order_id, 'received');

insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_rst, :org_id, :line_rst, :item_rst, 3, 'restock');

do $$ begin perform public.process_return_disposition('ee970000-0000-0000-0000-000000000041'); end $$;

-- A1: quantity_on_hand rose by 3 (return leg)
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_rst),
  103::numeric(14,4),
  'RESTOCK 0197: quantity_on_hand incremented 100 → 103'
);

-- A2: Staging level rose by 3 (apply_level_delta +3 → Staging)
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id    = :item_rst
      and l.warehouse_id = :wh_id
      and l.kind         = 'staging'
      and l.deleted_at is null
    limit 1),
  103::numeric,
  'RESTOCK 0197: item_stock_levels[Staging] incremented 100 → 103'
);

-- A3: Σ item_stock_levels = quantity_on_hand (no leaked units in other buckets)
select is(
  (select coalesce(sum(isl.quantity), 0)::numeric
     from public.item_stock_levels isl
    where isl.item_id = :item_rst),
  (select quantity_on_hand from public.inventory_items where id = :item_rst),
  'RESTOCK 0197: Σ item_stock_levels = quantity_on_hand'
);

-- A4: returned_quantity incremented on source line (durable budget)
select is(
  (select returned_quantity from public.order_request_lines where id = :line_rst),
  3::numeric(14,4),
  'RESTOCK 0197: returned_quantity on source line incremented to 3'
);

-- A5: return status moved to closed
select is(
  (select status from public.returns where id = :ret_rst),
  'closed',
  'RESTOCK 0197: return status received → closed'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- SCENARIO B — SCRAP (net-zero)
-- Return 4 units of item_scr as 'scrap'.
-- item_scr starts with: on_hand=120, Staging=100, rack=20.
-- Expected (0197):
--   quantity_on_hand:           120 → 120  (net zero: +4 then −4)
--   item_stock_levels[Staging]: 100 → 100  (staging_first: +4 then −4, net 0)
--   item_stock_levels[rack]:     20 →  20  (rack UNTOUCHED — staging_first not placed)
--   Σ item_stock_levels = quantity_on_hand = 120
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_scr, :org_id, :order_id, 'received');

insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_scr, :org_id, :line_scr, :item_scr, 4, 'scrap');

do $$ begin perform public.process_return_disposition('ee970000-0000-0000-0000-000000000042'); end $$;

-- B1: quantity_on_hand net unchanged (net-zero scrap)
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_scr),
  120::numeric(14,4),
  'SCRAP 0197: quantity_on_hand net unchanged (net-zero, still 120)'
);

-- B2: Staging level net unchanged — staging_first drained the +4 right back out
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id    = :item_scr
      and l.warehouse_id = :wh_id
      and l.kind         = 'staging'
      and l.deleted_at is null
    limit 1),
  100::numeric,
  'SCRAP 0197: item_stock_levels[Staging] net unchanged (staging_first drained +4, no stranded unit)'
);

-- B3: Rack level untouched — staging_first only drains Staging; placed rack is safe
select is(
  (select quantity from public.item_stock_levels where item_id = :item_scr and location_id = :rack_scr),
  20::numeric,
  'SCRAP 0197: rack level untouched (staging_first does not touch placed rack)'
);

-- B4: Σ item_stock_levels = quantity_on_hand (Staging 100 + rack 20 = 120)
select is(
  (select coalesce(sum(isl.quantity), 0)::numeric
     from public.item_stock_levels isl
    where isl.item_id = :item_scr),
  (select quantity_on_hand from public.inventory_items where id = :item_scr),
  'SCRAP 0197: Σ item_stock_levels = quantity_on_hand'
);

-- B5: returned_quantity incremented even for scrap (durable budget still consumed)
select is(
  (select returned_quantity from public.order_request_lines where id = :line_scr),
  4::numeric(14,4),
  'SCRAP 0197: returned_quantity on source line incremented to 4'
);

-- B6: net stock_movements quantity_change = 0 (return +4 + loss −4)
select is(
  (select coalesce(sum(quantity_change), 999)
     from public.stock_movements
    where reference_id = :ret_scr),
  0::numeric(14,4),
  'SCRAP 0197: +return and −loss movement legs sum to zero (net-zero)'
);

-- B7: return status moved to closed
select is(
  (select status from public.returns where id = :ret_scr),
  'closed',
  'SCRAP 0197: return status received → closed'
);

select * from finish();
rollback;
