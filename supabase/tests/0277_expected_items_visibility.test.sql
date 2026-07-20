-- supabase/tests/0277_expected_items_visibility.test.sql
-- Proves migration 0277 (expected-items visibility, Unit 1):
--   T1. awaiting_first_receipt defaults to false on insert.
--   T2. Trigger: a flagged item whose quantity_on_hand rises above 0 is
--       cleared (any stock-arrival path).
--   T3. Column-trigger gotcha: a flagged item updated WITH quantity_on_hand
--       in the SET list but still <= 0 (the Edit Item form shape — e.g. a
--       status edit that re-submits quantity unchanged) is NOT cleared.
--   T4. An unflagged item is unaffected by stock arriving (stays false).
--   T5-T8. Backfill predicate semantics, proven by re-running the
--       migration's exact backfill UPDATE against fixtures (the migration's
--       own one-time run already happened at db reset, before these rows
--       existed):
--         T5. phantom (qty 0, ZERO movements, OPEN inbound PO line) → flagged
--         T6. established out-of-stock item (qty 0, HAS a movement) → NOT flagged
--         T7. qty-0, zero-movement item with NO PO line → NOT flagged
--         T8. qty-0, zero-movement item whose only PO line is on a CLOSED
--             (received) PO → NOT flagged (pins the open-status set)
--   T9. public_link_eligible_items EXCLUDES a flagged item (entry present,
--       everything else eligible).
--   T10. …and includes it again once stock arrives and the trigger clears
--        the flag (the real clearing path, not a manual flip).
-- Namespace ab027700. Wrapped in begin/rollback.

begin;

select plan(10);

\set org        '\'ab027700-0000-0000-0000-00000000000a\''
\set wh         '\'ab027700-0000-0000-0000-0000000000e1\''
\set item_def   '\'ab027700-0000-0000-0000-0000000000f0\''
\set item_trig  '\'ab027700-0000-0000-0000-0000000000f1\''
\set item_unfl  '\'ab027700-0000-0000-0000-0000000000f2\''
\set phantom    '\'ab027700-0000-0000-0000-0000000000f3\''
\set establishd '\'ab027700-0000-0000-0000-0000000000f4\''
\set no_po      '\'ab027700-0000-0000-0000-0000000000f5\''
\set closed_po  '\'ab027700-0000-0000-0000-0000000000f6\''
\set po_open    '\'ab027700-0000-0000-0000-0000000000d1\''
\set po_recvd   '\'ab027700-0000-0000-0000-0000000000d2\''
\set link       '\'ab027700-0000-0000-0000-0000000000a1\''

-- ── Fixtures (seeded as the test superuser — RLS bypassed) ─────────────────
insert into public.organizations (id, name, slug)
  values (:org, 'Expected 0277 Org', 'expected-0277')
  on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status, is_public_orderable)
  values (:wh, :org, 'EXP Orderable', 'WH-EXP-0277', 'active', true)
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, item_type)
values
  -- trigger fixtures (flag set/left manually below).
  (:item_trig,  :org, :wh, 'EXP-0277-1', 'EXP Trigger Item',   0, 'active', 'none', 'product'),
  (:item_unfl,  :org, :wh, 'EXP-0277-2', 'EXP Unflagged Item', 0, 'active', 'none', 'product'),
  -- backfill fixtures.
  (:phantom,    :org, :wh, 'EXP-0277-3', 'EXP Phantom Book',   0, 'active', 'none', 'book'),
  (:establishd, :org, :wh, 'EXP-0277-4', 'EXP Established',    0, 'active', 'none', 'product'),
  (:no_po,      :org, :wh, 'EXP-0277-5', 'EXP No PO Line',     0, 'active', 'none', 'product'),
  (:closed_po,  :org, :wh, 'EXP-0277-6', 'EXP Closed PO',      0, 'active', 'none', 'product')
  on conflict (id) do nothing;

-- The established item reached zero THROUGH a movement (it has history).
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity)
values
  (:org, :establishd, 'remove', -10, 10, 0);

-- One OPEN inbound PO (expected_inbound) referencing the phantom; one
-- terminal (received) PO referencing closed_po.
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:po_open,  :org, 'PO-EXP-0277-1', 'expected_inbound'),
  (:po_recvd, :org, 'PO-EXP-0277-2', 'received')
  on conflict (id) do nothing;
insert into public.purchase_order_items
  (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
values
  (:org, :po_open,  :phantom,   5, 1),
  (:org, :po_recvd, :closed_po, 5, 1);

-- Public link with an explicit catalog entry for the phantom: every OTHER
-- 0261 eligibility condition holds, so only awaiting_first_receipt decides.
insert into public.public_request_links
  (id, organization_id, name, token, active, books_enabled, items_enabled,
   include_public_pool)
values
  (:link, :org, 'EXP link',
   'ab027700token0000000000000000000000000000000000000000000000001',
   true, true, false, false)
  on conflict (id) do nothing;
insert into public.public_link_catalog_entries (link_id, item_id)
  values (:link, :phantom)
  on conflict do nothing;

-- ── T1: default false on insert ─────────────────────────────────────────────
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status)
values
  (:item_def, :org, :wh, 'EXP-0277-0', 'EXP Default Item', 0, 'active');
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :item_def),
  false, 'T1: awaiting_first_receipt defaults to false on insert');

-- ── T2: flag cleared when stock arrives (qty rises above 0) ────────────────
-- Flag set directly (no quantity_on_hand in the SET list → trigger not
-- involved), then stock arrives.
update public.inventory_items set awaiting_first_receipt = true
  where id = :item_trig;
update public.inventory_items set quantity_on_hand = 3
  where id = :item_trig;
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :item_trig),
  false, 'T2: qty rising above 0 clears awaiting_first_receipt');

-- ── T3: SET-list presence with qty still <= 0 does NOT clear ───────────────
-- Re-flag with qty back at 0, then mimic the Edit Item form: a status edit
-- that re-submits quantity_on_hand unchanged (still 0) in the SET list. The
-- column trigger FIRES (presence), but the VALUE guard must keep the flag.
update public.inventory_items
   set awaiting_first_receipt = true, quantity_on_hand = 0
 where id = :item_trig;
update public.inventory_items set status = 'active', quantity_on_hand = 0
  where id = :item_trig;
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :item_trig),
  true, 'T3: update including quantity_on_hand still <= 0 does NOT clear the flag');

-- ── T4: unflagged item unaffected by stock arriving ─────────────────────────
update public.inventory_items set quantity_on_hand = 7
  where id = :item_unfl;
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :item_unfl),
  false, 'T4: unflagged item stays false when stock arrives');

-- ── T5-T8: backfill predicate (the migration''s exact UPDATE, re-run) ───────
update public.inventory_items i
   set awaiting_first_receipt = true
 where i.quantity_on_hand <= 0
   and not exists (
     select 1 from public.stock_movements m
      where m.item_id = i.id
   )
   and exists (
     select 1
       from public.purchase_order_items poi
       join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.item_id = i.id
        and po.status in ('draft', 'ordered', 'expected_inbound', 'partially_received')
   );

select is(
  (select awaiting_first_receipt from public.inventory_items where id = :phantom),
  true, 'T5: backfill flags the phantom (qty 0, zero movements, open PO line)');
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :establishd),
  false, 'T6: backfill skips the established out-of-stock item (has movement history)');
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :no_po),
  false, 'T7: backfill skips a zero-movement item with no PO line');
select is(
  (select awaiting_first_receipt from public.inventory_items where id = :closed_po),
  false, 'T8: backfill skips an item whose only PO line is on a received (closed) PO');

-- ── T9: public predicate excludes the flagged phantom ───────────────────────
select is(
  (select count(*)::int from public.public_link_eligible_items(
     'ab027700-0000-0000-0000-0000000000a1', 'ab027700-0000-0000-0000-0000000000e1')
   where item_id = 'ab027700-0000-0000-0000-0000000000f3'),
  0, 'T9: public_link_eligible_items excludes an awaiting_first_receipt item');

-- ── T10: first receipt clears the flag AND restores public eligibility ──────
update public.inventory_items set quantity_on_hand = 5
  where id = :phantom;
select is(
  (select count(*)::int from public.public_link_eligible_items(
     'ab027700-0000-0000-0000-0000000000a1', 'ab027700-0000-0000-0000-0000000000e1')
   where item_id = 'ab027700-0000-0000-0000-0000000000f3'),
  1, 'T10: once stock arrives (trigger clears the flag) the item is eligible again');

select * from finish();
rollback;
