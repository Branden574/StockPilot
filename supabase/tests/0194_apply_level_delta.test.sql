-- supabase/tests/0194_apply_level_delta.test.sql
-- End-to-end pgTAP proof that apply_level_delta routes null-location
-- adjust_stock calls into the correct item_stock_levels rows after mig 0194.
--
-- Seeds: org + auth user + organization_members (manager, accepted_at) +
-- warehouse (trigger auto-creates Staging/Unplaced) + rack location +
-- inventory_item (warehouse_id set, quantity_on_hand=6) + item_stock_levels
-- rack row = 6.
--
-- Calls:
--   adjust_stock(item, +4, 'add',    null, ...) -- positive -> Staging
--   adjust_stock(item, -5, 'remove', null, ...) -- negative placed -> rack(6->1)
--
-- Asserts (7):
--   1. Staging level = 4  (+4 landed there)
--   2. Rack level = 1     (-5 drew from placed rack 6->1)
--   3. quantity_on_hand = 5  (6 +4 -5)
--   4. Sigma item_stock_levels = 5  (= on_hand)
--   5. throws_ok: adjust_stock(item, -100, 'remove', null, ...) raises P0001
--   6. staging_first mode: -3 drains Staging (4->1)
--   7. staging_first mode: placed rack left untouched (still 6)
--
-- Wrapped in begin/rollback -- nothing leaks.

begin;

select plan(7);

\set org   '\'ff940000-0000-0000-0000-000000000001\''
\set usr   '\'ff940000-0000-0000-0000-000000000002\''
\set wh    '\'ff940000-0000-0000-0000-000000000003\''
\set item  '\'ff940000-0000-0000-0000-000000000004\''
\set rack  '\'ff940000-0000-0000-0000-000000000005\''
\set item2 '\'ff940000-0000-0000-0000-000000000006\''
\set rack2 '\'ff940000-0000-0000-0000-000000000007\''

-- ── Fixtures (seeded as superuser before role switch) ─────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'ald-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'ALD Test Org', 'ald-test-org-0194') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

-- Warehouse -- trigger auto-creates Staging + Unplaced locations (mig 0188).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'ALD Test WH', 'WH-ALD', 'active') on conflict (id) do nothing;

-- A rack location within the warehouse (kind='rack').
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'R1', 'shelf', 'rack') on conflict (id) do nothing;

-- Item must have warehouse_id so user_can_access_inventory RLS passes.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'ALD-0194', 'Level Delta Item', 6, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; clear it so we can place all stock in the rack.
delete from public.item_stock_levels where item_id = :item;

-- Seed rack level = 6 (the item's entire on-hand is on the rack).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item, :rack, 6)
  on conflict (item_id, location_id) do nothing;

-- ── Fixture for the staging_first case (assertion 6) ──────────────────────────
-- A second item in the same warehouse with BOTH a Staging level (4) and a placed
-- rack level (6), quantity_on_hand=10. staging_first should drain Staging first.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack2, :org, :wh, 'R2', 'shelf', 'rack') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item2, :org, :wh, 'ALD-0194-B', 'Staging-First Item', 10, 'active', 'none')
  on conflict (id) do nothing;

-- 0199 trigger seeds an Unplaced row; clear it so we can place stock exactly as needed.
delete from public.item_stock_levels where item_id = :item2;

-- Seed item2: rack=6 + Staging=4 (Staging = the warehouse's auto-created staging loc).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item2, :rack2, 6)
  on conflict (item_id, location_id) do nothing;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item2, l.id, 4
    from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null
   limit 1
  on conflict (item_id, location_id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────────
set local "request.jwt.claim.sub" to 'ff940000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Calls ─────────────────────────────────────────────────────────────────────
do $$
begin
  -- +4 null-location -> should land in Staging
  perform public.adjust_stock(
    'ff940000-0000-0000-0000-000000000004'::uuid,
    4, 'add', null, 'pgtap-pos', null
  );
  -- -5 null-location placed mode -> should draw from rack (6 -> 1)
  perform public.adjust_stock(
    'ff940000-0000-0000-0000-000000000004'::uuid,
    -5, 'remove', null, 'pgtap-neg', null
  );
  -- item2: -3 null-location staging_first -> should drain Staging (4 -> 1), rack stays 6
  perform public.adjust_stock(
    'ff940000-0000-0000-0000-000000000006'::uuid,
    -3, 'remove', null, 'stgfirst', null, 'staging_first'
  );
end$$;

-- ── Assertions ────────────────────────────────────────────────────────────────

-- 1. +4 landed in the warehouse Staging level
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff940000-0000-0000-0000-000000000004'::uuid
      and l.warehouse_id = 'ff940000-0000-0000-0000-000000000003'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  4::numeric,
  '+4 null-location add landed in Staging (level = 4)');

-- 2. -5 drew from placed rack (6 -> 1)
select is(
  (select quantity from public.item_stock_levels
    where item_id   = 'ff940000-0000-0000-0000-000000000004'::uuid
      and location_id = 'ff940000-0000-0000-0000-000000000005'::uuid),
  1::numeric,
  '-5 null-location remove drew from placed rack (6 -> 1)');

-- 3. quantity_on_hand = 6 + 4 - 5 = 5
select is(
  (select quantity_on_hand from public.inventory_items
    where id = 'ff940000-0000-0000-0000-000000000004'::uuid),
  5::numeric,
  'quantity_on_hand = 6 + 4 - 5 = 5');

-- 4. Sigma item_stock_levels = on_hand = 5
select is(
  (select coalesce(sum(quantity), 0)
     from public.item_stock_levels
    where item_id = 'ff940000-0000-0000-0000-000000000004'::uuid),
  5::numeric,
  'Sigma item_stock_levels = quantity_on_hand = 5');

-- 5. Over-draw raises insufficient_placed_stock (P0001).
-- Boost quantity_on_hand (superuser) so the on_hand < 0 guard in adjust_stock
-- won't fire before apply_level_delta gets to run its placed-stock check.
-- After the two prior ops: rack=1, staging=4, on_hand=5.
-- We set on_hand=200 so (200-100)=100>=0 clears the guard, but placed stock=1
-- is far short of 100, so apply_level_delta raises insufficient_placed_stock.
reset role;
update public.inventory_items
  set quantity_on_hand = 200
  where id = 'ff940000-0000-0000-0000-000000000004'::uuid;

set local "request.jwt.claim.sub" to 'ff940000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  $$ select public.adjust_stock(
       'ff940000-0000-0000-0000-000000000004'::uuid,
       -100, 'remove', null, 'pgtap-overdraw', null) $$,
  'P0001', 'insufficient_placed_stock',
  'over-draw raises insufficient_placed_stock (P0001)');

-- 6a. staging_first drained the Staging level (4 -> 1).
select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff940000-0000-0000-0000-000000000006'::uuid
      and l.warehouse_id = 'ff940000-0000-0000-0000-000000000003'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  1::numeric,
  'staging_first: -3 drained Staging (4 -> 1)');

-- 6b. and left the placed rack untouched (still 6).
select is(
  (select quantity from public.item_stock_levels
    where item_id   = 'ff940000-0000-0000-0000-000000000006'::uuid
      and location_id = 'ff940000-0000-0000-0000-000000000007'::uuid),
  6::numeric,
  'staging_first: placed rack untouched (still 6)');

select * from finish();
rollback;
