-- supabase/tests/0183_receipt_reversal.test.sql
-- pgTAP RUNTIME PROOF that receipt REVERSAL works after migration 0183
-- (signed-ledger constraints + lot/serial cleanup + recompute_po_status rolls
-- backward). Guards the exact regressions the adversarial review caught:
--   * a reversal writes NEGATIVE receipt_lines (the dropped >=0 checks + the
--     abs() form of receipt_lines_check must allow them),
--   * it works even when received > accepted+rejected (under-attributed lines —
--     the case the kept inequality would have rejected),
--   * stock is decremented, the original is flipped to 'reversed', a sibling
--     'reversal' receipt is created, and the PO rolls back received -> ordered
--     with received_at cleared (so it can be received again),
--   * re-reversing an already-reversed receipt is rejected.
--
-- Run via `supabase test db`. begin/rollback so nothing leaks.

begin;

select plan(9);

\set org     '\'aaaa0000-0000-0000-0000-000000000001\''
\set mgr     '\'bbbb0000-0000-0000-0000-000000000001\''
\set wh      '\'cccc0000-0000-0000-0000-000000000001\''
-- Scenario 1 — fully attributed (received == accepted == 10).
\set item1   '\'d1110000-0000-0000-0000-000000000001\''
\set po1     '\'e1110000-0000-0000-0000-000000000001\''
\set poline1 '\'f1110000-0000-0000-0000-000000000001\''
\set rcpt1   '\'a1110000-0000-0000-0000-000000000001\''
\set rline1  '\'b1110000-0000-0000-0000-000000000001\''
-- Scenario 2 — under attributed (received 10 > accepted 8). The abs() case.
\set item2   '\'d2220000-0000-0000-0000-000000000002\''
\set po2     '\'e2220000-0000-0000-0000-000000000002\''
\set poline2 '\'f2220000-0000-0000-0000-000000000002\''
\set rcpt2   '\'a2220000-0000-0000-0000-000000000002\''
\set rline2  '\'b2220000-0000-0000-0000-000000000002\''

-- ── Fixtures (seeded as the test superuser; RLS engaged after the role switch).
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, 'rev-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Reversal Test Org', 'reversal-test-org') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Main', 'WH-REV', 'active') on conflict (id) do nothing;

-- Items at POST-receipt on-hand (the received qty is already on hand).
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status)
  values
    (:item1, :org, :wh, 'Rev Widget 1', 'SKU-REV1', 10, 'active'),
    (:item2, :org, :wh, 'Rev Widget 2', 'SKU-REV2', 10, 'active')
  on conflict (id) do nothing;

-- POs already 'received' so we can prove the backward status roll.
insert into public.purchase_orders (id, organization_id, po_number, status, received_at)
  values
    (:po1, :org, 'REV-PO-1', 'received', now()),
    (:po2, :org, 'REV-PO-2', 'received', now())
  on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values
    (:poline1, :org, :po1, :item1, 10, 10, 5),
    (:poline2, :org, :po2, :item2, 10, 10, 5)
  on conflict (id) do nothing;

insert into public.receipts
  (id, organization_id, purchase_order_id, warehouse_id, receipt_number, status, received_by, immutable_hash)
  values
    (:rcpt1, :org, :po1, :wh, 'R-REV-1', 'posted', :mgr, 'hash-rev-1'),
    (:rcpt2, :org, :po2, :wh, 'R-REV-2', 'posted', :mgr, 'hash-rev-2')
  on conflict (id) do nothing;

-- Line 1 fully attributed (10/10/0); line 2 under attributed (10/8/0).
insert into public.receipt_lines
  (id, receipt_id, purchase_order_line_id, item_id, qty_received_base, qty_accepted_base, qty_rejected_base, base_uom, unit_cost)
  values
    (:rline1, :rcpt1, :poline1, :item1, 10, 10, 0, 'EA', 5),
    (:rline2, :rcpt2, :poline2, :item2, 10, 8,  0, 'EA', 5)
  on conflict (id) do nothing;

-- Seed item_stock_levels so reverse_receipt (staging_first) has levels to drain.
-- Stock is in the Unplaced location (simulating pre-staging-era receipt).
-- The warehouse insert above fires trg_seed_warehouse_locations so the Unplaced
-- location already exists; we just need to link the item qty to it.
-- INVARIANT: each item's seeded level MUST equal its quantity_on_hand
-- (Σlevels = on_hand). Both item1 and item2 have quantity_on_hand = 10 above,
-- so both levels are seeded at 10. (item2's accepted/received is 8/10 on the
-- receipt line, but its on_hand is 10 — the reversal draws 8 off, 10 → 2.)
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :org, :item1, l.id, 10  -- = item1 quantity_on_hand
  from public.locations l
 where l.warehouse_id = :wh and l.kind = 'unplaced' and l.deleted_at is null
 limit 1
on conflict (item_id, location_id) do update set quantity = excluded.quantity;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :org, :item2, l.id, 10  -- = item2 quantity_on_hand
  from public.locations l
 where l.warehouse_id = :wh and l.kind = 'unplaced' and l.deleted_at is null
 limit 1
on conflict (item_id, location_id) do update set quantity = excluded.quantity;

-- Become the manager (auth.uid() + has_org_role + RLS).
set local "request.jwt.claim.sub" to 'bbbb0000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ═══ Scenario 1 — fully-attributed reversal ═══
do $$ begin perform public.reverse_receipt('a1110000-0000-0000-0000-000000000001', 'pgtap full'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item1),
  0::numeric(14,4),
  'on_hand decremented to 0 after reversing accepted=10'
);
select is(
  (select status from public.receipts where id = :rcpt1),
  'reversed',
  'original receipt flipped posted -> reversed'
);
select is(
  (select count(*)::int from public.receipts where reversed_receipt_id = :rcpt1 and status = 'reversal'),
  1,
  'a sibling reversal receipt was created'
);
select is(
  (select coalesce(sum(qty_accepted_base), 999) from public.receipt_lines rl
     join public.receipts r on r.id = rl.receipt_id
     where r.reversed_receipt_id = :rcpt1),
  -10::numeric(18,4),
  'reversal line carries the NEGATIVE accepted qty (signed ledger allowed)'
);
select is(
  (select status from public.purchase_orders where id = :po1),
  'ordered',
  'PO rolls back received -> ordered after full reversal'
);
select ok(
  (select received_at is null from public.purchase_orders where id = :po1),
  'PO received_at cleared on full reversal (re-receivable)'
);

-- ═══ Scenario 2 — under-attributed reversal (received 10 > accepted 8) ═══
-- Pre-0183 this failed on receipt_lines_check (-8 <= -9.9999 is false). The
-- abs() form must let it through.
select lives_ok(
  $$ do $x$ begin perform public.reverse_receipt('a2220000-0000-0000-0000-000000000002', 'pgtap under'); end $x$ $$,
  'reversal succeeds when received > accepted+rejected (sign-symmetric constraint)'
);
select is(
  (select status from public.receipts where id = :rcpt2),
  'reversed',
  'under-attributed original flipped to reversed'
);

-- ═══ Scenario 3 — re-reversing an already-reversed receipt is rejected ═══
select throws_ok(
  $$ select public.reverse_receipt('a1110000-0000-0000-0000-000000000001', 'again') $$,
  '22023',
  'receipt_already_reversed',
  'reversing an already-reversed receipt throws receipt_already_reversed'
);

select * from finish();
rollback;
