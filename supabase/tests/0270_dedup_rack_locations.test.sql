-- supabase/tests/0270_dedup_rack_locations.test.sql
--
-- Proves migration 0270's public._dedup_rack_locations() merge, exercising
-- ALL 7 FK columns that reference locations.id and BOTH item_stock_levels
-- merge shapes (an item already on the canonical row + items only ever on
-- duplicates), across a 3-way duplicate group (canonical + 2 dups) so the
-- aggregate-before-upsert fix (a naive UPDATE...FROM would silently drop
-- one of two matching duplicate rows) is actually exercised.
--
-- The real unique index (locations_unique_active_name, created by 0270) is
-- already in place from the migration run — we temporarily drop it here so
-- this test's own fixtures can seed duplicates on purpose, then recreate it
-- at the end to prove the merge fully cleared them. Everything is inside
-- begin/rollback, so the drop+recreate never touches the persisted schema.
--
-- Namespace b0270000.

begin;

select plan(15);

-- Seed intentional duplicates for this test — drop the real constraint
-- first or the inserts below would fail immediately.
drop index if exists public.locations_unique_active_name;

\set org     '\'b0270000-0000-0000-0000-000000000001\''
\set wh      '\'b0270000-0000-0000-0000-000000000002\''
\set canon   '\'b0270000-0000-0000-0000-000000000010\''
\set dup1    '\'b0270000-0000-0000-0000-000000000011\''
\set dup2    '\'b0270000-0000-0000-0000-000000000012\''
\set child   '\'b0270000-0000-0000-0000-000000000020\''
\set item_a  '\'b0270000-0000-0000-0000-0000000000a0\''
\set item_b  '\'b0270000-0000-0000-0000-0000000000b0\''
\set item_c  '\'b0270000-0000-0000-0000-0000000000c0\''
\set po_id   '\'b0270000-0000-0000-0000-0000000000d0\''
\set rpt_id  '\'b0270000-0000-0000-0000-0000000000e0\''
\set sm_id   '\'b0270000-0000-0000-0000-0000000000f0\''

insert into public.organizations (id, name, slug)
  values (:org, 'Dedup Rack Org 0270', 'dedup-rack-0270') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Dedup WH', 'WH-DEDUP-0270', 'active') on conflict (id) do nothing;

-- Three non-deleted 'rack' rows, SAME name, SAME warehouse — the exact
-- duplicate shape this migration exists to fix. Explicit created_at makes
-- :canon the OLDEST (and so the canonical winner) deterministically.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at)
  values
    (:canon, :org, :wh, '2-C', 'shelf', 'rack', now() - interval '2 days'),
    (:dup1,  :org, :wh, '2-C', 'shelf', 'rack', now() - interval '1 day'),
    (:dup2,  :org, :wh, '2-c', 'shelf', 'rack', now())
  on conflict (id) do nothing;
-- :dup2 uses a different CASE ('2-c') to also prove the match is
-- case-insensitive (mirrors the lower(name) unique index this fixes).

-- A location parented under a duplicate (:dup1) — proves the self-ref FK
-- (locations.parent_id) gets repointed too, not just sibling rack rows.
insert into public.locations (id, organization_id, warehouse_id, parent_id, name, type, kind)
  values (:child, :org, :wh, :dup1, '2-C Sub-bin', 'bin', 'area')
  on conflict (id) do nothing;

-- NOTE: primary_location_id is left NULL here on purpose. The
-- trg_seed_initial_level AFTER INSERT trigger (0199) auto-seeds an
-- item_stock_levels row from quantity_on_hand + primary_location_id — if we
-- pointed it at :dup1/:canon up front it would race the explicit
-- item_stock_levels inserts below and collide with the UNIQUE(item_id,
-- location_id) constraint. With primary_location_id null, the trigger seeds
-- onto the warehouse's own 'Unplaced' bucket instead, which never touches
-- :canon/:dup1/:dup2 — leaving those free for the explicit fixture rows.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_a, :org, :wh, 'DEDUP-A', 'Item A', 10, 'active', 'none'),
    (:item_b, :org, :wh, 'DEDUP-B', 'Item B', 7,  'active', 'none'),
    (:item_c, :org, :wh, 'DEDUP-C', 'Item C', 10, 'active', 'none')
  on conflict (id) do nothing;

-- FK #2 test target: item_a's primary_location_id -> :dup1, set via a plain
-- UPDATE (not the INSERT above) so the AFTER-INSERT seed trigger never fires
-- against it.
update public.inventory_items set primary_location_id = :dup1 where id = :item_a;

-- item_stock_levels — the FK with a UNIQUE(item_id, location_id) constraint
-- that forces a quantity-merge instead of a plain repoint:
--   item_a: already has a row at the canonical (5) AND both dups (3 + 2)
--           -> expect canonical ends at 10, both dup rows gone.
--   item_b: only ever on :dup1 (7), no canonical row yet
--           -> expect a NEW canonical row at 7.
--   item_c: split across BOTH :dup1 (4) and :dup2 (6), no canonical row
--           -> expect a NEW canonical row at 10 (proves the aggregate-
--              before-upsert fix; a naive per-dup UPDATE would only apply
--              one of the two matching dup rows).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values
    (:org, :item_a, :canon, 5),
    (:org, :item_a, :dup1,  3),
    (:org, :item_a, :dup2,  2),
    (:org, :item_b, :dup1,  7),
    (:org, :item_c, :dup1,  4),
    (:org, :item_c, :dup2,  6)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

-- stock_movements — plain repoint, both from/to columns, both dups.
insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
   from_location_id, to_location_id)
  values (:sm_id, :org, :item_a, 'transfer', 0, 10, 10, :dup2, :dup1);

-- purchase_orders.destination_location_id -> :dup1
insert into public.purchase_orders (id, organization_id, po_number, destination_location_id)
  values (:po_id, :org, 'PO-DEDUP-0270', :dup1);

-- recurring_po_templates.destination_location_id -> :dup2
insert into public.recurring_po_templates
  (id, organization_id, destination_location_id, name, cadence, next_run_at)
  values (:rpt_id, :org, :dup2, 'Dedup RPT', 'monthly', now() + interval '30 days');

-- ════════════════════════════════════════════════════════════════════════════
-- Run the merge
-- ════════════════════════════════════════════════════════════════════════════
select is(
  public._dedup_rack_locations(),
  2,
  'first call reports 2 duplicate rows merged (dup1 + dup2)'
);

select is(
  (select deleted_at is null from public.locations where id = :canon),
  true,
  'canonical row (:canon) stays active'
);
select is(
  (select count(*)::int from public.locations where id in (:dup1, :dup2) and deleted_at is not null),
  2,
  'both duplicates are soft-deleted'
);

-- FK #3 — item_stock_levels (merged quantities, dup rows gone)
select is(
  (select quantity from public.item_stock_levels where item_id = :item_a and location_id = :canon),
  10::numeric(14,4),
  'item_a: canonical quantity = 5 (own) + 3 (dup1) + 2 (dup2) = 10'
);
select is(
  (select count(*)::int from public.item_stock_levels where item_id = :item_a and location_id in (:dup1, :dup2)),
  0,
  'item_a: no stock rows remain on either duplicate'
);
select is(
  (select quantity from public.item_stock_levels where item_id = :item_b and location_id = :canon),
  7::numeric(14,4),
  'item_b: new canonical row created at 7 (had no prior canonical row)'
);
select is(
  (select quantity from public.item_stock_levels where item_id = :item_c and location_id = :canon),
  10::numeric(14,4),
  'item_c: new canonical row = 4 (dup1) + 6 (dup2) = 10 — proves aggregate-before-upsert'
);

-- FK #4/#5 — stock_movements
select is(
  (select from_location_id from public.stock_movements where id = :sm_id),
  :canon::uuid,
  'stock_movements.from_location_id repointed to canonical'
);
select is(
  (select to_location_id from public.stock_movements where id = :sm_id),
  :canon::uuid,
  'stock_movements.to_location_id repointed to canonical'
);

-- FK #2 — inventory_items.primary_location_id
select is(
  (select primary_location_id from public.inventory_items where id = :item_a),
  :canon::uuid,
  'inventory_items.primary_location_id repointed to canonical'
);

-- FK #6 — purchase_orders.destination_location_id
select is(
  (select destination_location_id from public.purchase_orders where id = :po_id),
  :canon::uuid,
  'purchase_orders.destination_location_id repointed to canonical'
);

-- FK #7 — recurring_po_templates.destination_location_id
select is(
  (select destination_location_id from public.recurring_po_templates where id = :rpt_id),
  :canon::uuid,
  'recurring_po_templates.destination_location_id repointed to canonical'
);

-- FK #1 — locations.parent_id (self-ref)
select is(
  (select parent_id from public.locations where id = :child),
  :canon::uuid,
  'locations.parent_id repointed to canonical'
);

-- ════════════════════════════════════════════════════════════════════════════
-- Idempotency — a second call finds nothing left to merge
-- ════════════════════════════════════════════════════════════════════════════
select is(
  public._dedup_rack_locations(),
  0,
  'second call is a no-op (0 duplicates — already merged)'
);

-- ════════════════════════════════════════════════════════════════════════════
-- The unique index would now hold — recreate it and prove it succeeds
-- ════════════════════════════════════════════════════════════════════════════
select lives_ok(
  $$ create unique index locations_unique_active_name
       on public.locations (organization_id, warehouse_id, lower(name))
       where deleted_at is null and kind in ('rack', 'crate') $$,
  'unique index creation succeeds post-merge (no active dup names remain)'
);

select * from finish();
rollback;
