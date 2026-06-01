-- supabase/tests/0158_returns_invariants.test.sql
-- pgTAP RUNTIME PROOF of the Returns/RMA inventory invariants introduced by
-- migrations 0153 (returns/return_lines + process_return_disposition RPC +
-- returned_quantity durable budget + fulfilled-cap + item-identity triggers),
-- 0154 (status transition guard + RESTRICTIVE no-delete + layer-2 RPC backstop)
-- and 0155 (cancel_order_request honours returned_quantity).
--
-- Run via `supabase test db` (after `supabase start`) or `pg_prove` against a DB
-- with the migrations applied + the `pgtap` extension. Uses the standard
-- begin/rollback pattern so the tests leak NOTHING — every row is rolled back.
--
-- The "fulfilment already decremented on-hand" precondition is SIMULATED by
-- seeding inventory_items.quantity_on_hand at the post-fulfilment level and
-- stamping order_request_lines.quantity_fulfilled > 0 (the deterministic marker
-- complete_picking writes after a successful adjust_stock(-qty)). We then prove,
-- against that seam, each invariant from the 0153/0154/0155 design.
--
-- Each scenario uses its OWN order_request_line + item so the durable budget
-- (returned_quantity) of one test never bleeds into another.

begin;

select plan(27);

-- ─────────────────────────────────────────────────────────────────────
-- Stable UUIDs so assertions are deterministic.
-- ─────────────────────────────────────────────────────────────────────
\set org_id     '\'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\''
\set mgr_id     '\'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\''
\set wh_id      '\'cccccccc-cccc-cccc-cccc-cccccccccccc\''

-- One item per invariant (so on-hand assertions are isolated).
\set item_restock '\'d1111111-1111-1111-1111-111111111111\''
\set item_scrap   '\'d2222222-2222-2222-2222-222222222222\''
\set item_over    '\'d3333333-3333-3333-3333-333333333333\''
\set item_cross   '\'d4444444-4444-4444-4444-444444444444\''
-- item_other is the WRONG item for the cross-item mismatch test. NOTE: the
-- trailing comment MUST live on its own line — psql's \set swallows the rest of
-- the line into the variable value, so an inline comment here would be
-- interpolated into the INSERT and break the VALUES tuple.
\set item_other   '\'d4999999-9999-9999-9999-999999999999\''
\set item_durable '\'d5555555-5555-5555-5555-555555555555\''
\set item_idem    '\'d6666666-6666-6666-6666-666666666666\''
\set item_cancel  '\'d7777777-7777-7777-7777-777777777777\''

\set order_id   '\'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee\''
\set order_cancel '\'ec000000-0000-0000-0000-0000000000ca\''

-- One source order_request_line per invariant.
\set line_restock '\'f1111111-1111-1111-1111-111111111111\''
\set line_scrap   '\'f2222222-2222-2222-2222-222222222222\''
\set line_over    '\'f3333333-3333-3333-3333-333333333333\''
\set line_cross   '\'f4444444-4444-4444-4444-444444444444\''
\set line_durable '\'f5555555-5555-5555-5555-555555555555\''
\set line_idem    '\'f6666666-6666-6666-6666-666666666666\''
\set line_cancel  '\'f7777777-7777-7777-7777-777777777777\''

-- Returns.
\set ret_restock  '\'a1111111-1111-1111-1111-111111111111\''
\set ret_scrap    '\'a2222222-2222-2222-2222-222222222222\''
\set ret_over_a   '\'a3333331-3333-3333-3333-333333333333\''
\set ret_over_b   '\'a3333332-3333-3333-3333-333333333333\''
\set ret_cross    '\'a4444444-4444-4444-4444-444444444444\''
\set ret_durable  '\'a5555551-5555-5555-5555-555555555555\''
\set ret_durable2 '\'a5555552-5555-5555-5555-555555555555\''
\set ret_idem     '\'a6666666-6666-6666-6666-666666666666\''
\set ret_cancel   '\'a7777777-7777-7777-7777-777777777777\''

-- ─────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as the test runner's superuser — RLS not yet engaged).
-- ─────────────────────────────────────────────────────────────────────

-- auth.users insert fires on_auth_user_created → creates the user_profiles row
-- the *_by FKs reference.
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr_id, 'returns-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org_id, 'Returns Test Org', 'returns-test-org')
  on conflict (id) do nothing;

-- Manager role — required by process_return_disposition's has_org_role check
-- and by the returns/return_lines INSERT+UPDATE RLS policies.
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org_id, :mgr_id, 'manager', now())
  on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh_id, :org_id, 'Main', 'WH-RET', 'active')
  on conflict (id) do nothing;

-- Items. quantity_on_hand is the POST-fulfilment level (units already shipped).
-- warehouse_id is REQUIRED for visibility: inventory_items_select (0129/0140)
-- gates reads on user_can_access_inventory(auth.uid(), warehouse_id, ...), which
-- resolves the org THROUGH the warehouse. A NULL warehouse_id means the manager
-- (whose access derives from org membership via that warehouse) can't see the
-- row, so the quantity_on_hand readbacks would return NULL under the
-- authenticated role even though the inventory math is correct.
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status)
  values
    (:item_restock, :org_id, :wh_id, 'Restock Widget', 'SKU-RESTOCK', 100, 'active'),
    (:item_scrap,   :org_id, :wh_id, 'Scrap Widget',   'SKU-SCRAP',   100, 'active'),
    (:item_over,    :org_id, :wh_id, 'Over Widget',    'SKU-OVER',    100, 'active'),
    (:item_cross,   :org_id, :wh_id, 'Cross Widget',   'SKU-CROSS',   100, 'active'),
    (:item_other,   :org_id, :wh_id, 'Other Widget',   'SKU-OTHER',   100, 'active'),
    (:item_durable, :org_id, :wh_id, 'Durable Widget', 'SKU-DURABLE', 100, 'active'),
    (:item_idem,    :org_id, :wh_id, 'Idem Widget',    'SKU-IDEM',    100, 'active'),
    (:item_cancel,  :org_id, :wh_id, 'Cancel Widget',  'SKU-CANCEL',  100, 'active')
  on conflict (id) do nothing;

-- A fulfilled order_request. The current status CHECK (0120 superseded the
-- 0044 set — 'ready_for_delivery'/'delivered' were RENAMED away) admits
-- 'in_transit' as a post-fulfilment, still-live state. We use 'in_transit' for
-- the lines that only need a parent, and a SEPARATE order for the cancel test
-- (so cancelling it can't disturb the other invariants). 'in_transit' is a
-- legal source for the cancel test because cancel_order_request only refuses
-- 'completed'/'denied'/'cancelled' (0155) and the order_requests transition
-- guard (0120) allows in_transit -> cancelled.
-- fulfillment_type='pickup' is required: it defaults to 'delivery' (0109) and
-- order_requests_delivery_target_chk (0110) then demands a delivery_charter_id.
-- A returns test doesn't care about delivery, so 'pickup' (which the check
-- requires to have NO charter) is the minimal valid choice.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values (:order_id, :org_id, :wh_id, 'in_transit', :mgr_id, 'internal', 'pickup')
  on conflict (id) do nothing;

insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values (:order_cancel, :org_id, :wh_id, 'in_transit', :mgr_id, 'internal', 'pickup')
  on conflict (id) do nothing;

-- Source lines. quantity_fulfilled simulates the fulfilment decrement; the
-- return budget = quantity_fulfilled - returned_quantity.
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled)
  values
    (:line_restock, :order_id, :item_restock, 10, 5),
    (:line_scrap,   :order_id, :item_scrap,   10, 5),
    (:line_over,    :order_id, :item_over,    10, 5),
    (:line_cross,   :order_id, :item_cross,   10, 5),
    (:line_durable, :order_id, :item_durable, 10, 5),
    (:line_idem,    :order_id, :item_idem,    10, 5),
    (:line_cancel,  :order_cancel, :item_cancel, 10, 5)
  on conflict (id) do nothing;

-- Become the manager so auth.uid() resolves inside the SECURITY DEFINER RPC and
-- RLS write policies pass. Mirrors 0027's "become this user" idiom.
set local "request.jwt.claim.sub" to 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 1 — RESTOCK conserves: a return that restocks N raises
-- quantity_on_hand by exactly N (once) and returned_quantity by N.
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_restock, :org_id, :order_id, 'received');
insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_restock, :org_id, :line_restock, :item_restock, 3, 'restock');

do $$ begin perform public.process_return_disposition('a1111111-1111-1111-1111-111111111111'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_restock),
  103::numeric(14,4),
  'RESTOCK adds exactly N to quantity_on_hand (100 -> 103)'
);

select is(
  (select returned_quantity from public.order_request_lines where id = :line_restock),
  3::numeric(14,4),
  'RESTOCK increments the source line returned_quantity by N'
);

select is(
  (select count(*)::int from public.stock_movements
    where reference_type = 'return' and reference_id = :ret_restock
      and movement_type = 'return'),
  1,
  'RESTOCK records exactly one ''return'' stock movement'
);

select is(
  (select count(*)::int from public.stock_movements
    where reference_type = 'return' and reference_id = :ret_restock
      and movement_type = 'loss'),
  0,
  'RESTOCK records NO ''loss'' movement (it is a pure add)'
);

select is(
  (select status from public.returns where id = :ret_restock),
  'closed',
  'A processed return is atomically flipped received -> closed'
);

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 2 — SCRAP is net-zero: quantity_on_hand UNCHANGED (the +return
-- then -loss legs net to zero); returned_quantity += N; a 'loss' and a
-- 'return' movement are both recorded.
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_scrap, :org_id, :order_id, 'received');
insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_scrap, :org_id, :line_scrap, :item_scrap, 4, 'scrap');

do $$ begin perform public.process_return_disposition('a2222222-2222-2222-2222-222222222222'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_scrap),
  100::numeric(14,4),
  'SCRAP leaves quantity_on_hand UNCHANGED (+return then -loss net to zero)'
);

select is(
  (select returned_quantity from public.order_request_lines where id = :line_scrap),
  4::numeric(14,4),
  'SCRAP still consumes the durable budget (returned_quantity += N)'
);

select is(
  (select count(*)::int from public.stock_movements
    where reference_type = 'return' and reference_id = :ret_scrap
      and movement_type = 'return'),
  1,
  'SCRAP records the +qty ''return'' receive leg'
);

select is(
  (select count(*)::int from public.stock_movements
    where reference_type = 'return' and reference_id = :ret_scrap
      and movement_type = 'loss'),
  1,
  'SCRAP records the -qty ''loss'' write-off leg'
);

select is(
  (select coalesce(sum(quantity_change), 999) from public.stock_movements
    where reference_type = 'return' and reference_id = :ret_scrap),
  0::numeric(14,4),
  'SCRAP movement legs sum to zero (audit trail is net-zero)'
);

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 3 — Over-return blocked: the cumulative return for one source
-- line cannot exceed quantity_fulfilled - returned_quantity, ACROSS returns.
-- fulfilled=5. First return claims 5 (the whole budget); a second pending
-- return claiming even 1 more must be rejected by the cap trigger.
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_over_a, :org_id, :order_id, 'received');
insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_over_a, :org_id, :line_over, :item_over, 5, 'restock');

-- A single line over the whole fulfilled qty is rejected outright.
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_over_b, :org_id, :order_id, 'requested');
select throws_ok(
  $$insert into public.return_lines
      (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
    values ('a3333332-3333-3333-3333-333333333333',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'f3333333-3333-3333-3333-333333333333',
            'd3333333-3333-3333-3333-333333333333', 1, 'restock')$$,
  'P0001',
  'return_exceeds_fulfilled',
  'Over-return is rejected: pending 5 + 1 > fulfilled 5 (cross-return cap)'
);

-- Now APPLY the first return (consumes the budget durably), then prove a fresh
-- return for even 1 unit is still rejected — budget is gone.
do $$ begin perform public.process_return_disposition('a3333331-3333-3333-3333-333333333333'); end $$;

select is(
  (select returned_quantity from public.order_request_lines where id = :line_over),
  5::numeric(14,4),
  'Over-return setup: applied return consumed the full fulfilled budget'
);

select throws_ok(
  $$insert into public.return_lines
      (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
    values ('a3333332-3333-3333-3333-333333333333',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'f3333333-3333-3333-3333-333333333333',
            'd3333333-3333-3333-3333-333333333333', 1, 'restock')$$,
  'P0001',
  'return_exceeds_fulfilled',
  'After budget fully consumed (returned 5 = fulfilled 5), another unit is rejected'
);

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 4 — Cross-item blocked: a return_line whose item_id != the source
-- order_request_line.item_id throws 'return_item_mismatch'.
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_cross, :org_id, :order_id, 'requested');
select throws_ok(
  $$insert into public.return_lines
      (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
    values ('a4444444-4444-4444-4444-444444444444',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'f4444444-4444-4444-4444-444444444444',
            'd4999999-9999-9999-9999-999999999999', 1, 'restock')$$,
  'P0001',
  'return_item_mismatch',
  'Cross-item return rejected: line item != source order_request_line item'
);

-- The correct item on the same source line is accepted (control).
select lives_ok(
  $$insert into public.return_lines
      (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
    values ('a4444444-4444-4444-4444-444444444444',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'f4444444-4444-4444-4444-444444444444',
            'd4444444-4444-4444-4444-444444444444', 1, 'restock')$$,
  'Matching item on the same source line is accepted (control for the mismatch)'
);

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 5 — Status-flip / DELETE cannot inflate: once a return is applied
-- (returned_quantity incremented), DELETE is RESTRICTIVE-denied and the durable
-- budget survives, so a fresh full return is still rejected.
-- fulfilled=5; apply a return for all 5; then attempt DELETE + a fresh return.
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_durable, :org_id, :order_id, 'received');
insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_durable, :org_id, :line_durable, :item_durable, 5, 'restock');

do $$ begin perform public.process_return_disposition('a5555551-5555-5555-5555-555555555555'); end $$;

select is(
  (select returned_quantity from public.order_request_lines where id = :line_durable),
  5::numeric(14,4),
  'Durable-budget setup: returned_quantity = 5 after apply'
);

-- DELETE of the applied return is denied by the RESTRICTIVE no-delete policy:
-- the statement affects ZERO rows (RLS filters it out), so the return survives.
delete from public.returns where id = :ret_durable;
select is(
  (select count(*)::int from public.returns where id = :ret_durable),
  1,
  'RESTRICTIVE no-delete policy prevents DELETEing an applied return'
);

select is(
  (select returned_quantity from public.order_request_lines where id = :line_durable),
  5::numeric(14,4),
  'Durable budget is unaffected by the (denied) DELETE attempt'
);

-- A fresh full return for the same source line is still rejected — budget is
-- durable on the immutable source line, not freed by deleting/flipping a return.
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_durable2, :org_id, :order_id, 'requested');
select throws_ok(
  $$insert into public.return_lines
      (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
    values ('a5555552-5555-5555-5555-555555555555',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'f5555555-5555-5555-5555-555555555555',
            'd5555555-5555-5555-5555-555555555555', 1, 'restock')$$,
  'P0001',
  'return_exceeds_fulfilled',
  'A fresh return after a fully-applied one is still rejected (budget is durable)'
);

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 6 — apply-once idempotency: calling process_return_disposition a
-- second time does not double-apply (returned_quantity + on_hand unchanged).
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_idem, :org_id, :order_id, 'received');
insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_idem, :org_id, :line_idem, :item_idem, 2, 'restock');

do $$ begin perform public.process_return_disposition('a6666666-6666-6666-6666-666666666666'); end $$;

-- First apply: on_hand 100 -> 102, returned_quantity 0 -> 2.
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_idem),
  102::numeric(14,4),
  'Idempotency: first apply restocks N (100 -> 102)'
);

-- Second call: the return is now 'closed', so the status guard rejects it. The
-- key invariant is that NOTHING moves a second time — assert via the no-change.
select throws_ok(
  $$select public.process_return_disposition('a6666666-6666-6666-6666-666666666666')$$,
  'P0001',
  'invalid_status_transition',
  'Second call on a closed return is rejected by the status guard'
);

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_idem),
  102::numeric(14,4),
  'Idempotency: on_hand UNCHANGED after the second call (no double-restock)'
);

select is(
  (select returned_quantity from public.order_request_lines where id = :line_idem),
  2::numeric(14,4),
  'Idempotency: returned_quantity UNCHANGED after the second call'
);

-- ═════════════════════════════════════════════════════════════════════
-- INVARIANT 7 — cancel-after-return: cancel_order_request restocks only
-- quantity_fulfilled - returned_quantity (no double-restock of returned units).
-- order_cancel line: fulfilled=5, item on_hand=100. Apply a return for 2 first
-- (on_hand 100 -> 102, returned_quantity=2). Then cancel: should restore only
-- 5 - 2 = 3 (on_hand 102 -> 105), NOT the full 5.
-- ═════════════════════════════════════════════════════════════════════
insert into public.returns (id, organization_id, order_request_id, status)
  values (:ret_cancel, :org_id, :order_cancel, 'received');
insert into public.return_lines
  (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
  values (:ret_cancel, :org_id, :line_cancel, :item_cancel, 2, 'restock');

do $$ begin perform public.process_return_disposition('a7777777-7777-7777-7777-777777777777'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_cancel),
  102::numeric(14,4),
  'Cancel-after-return setup: return of 2 restocked (100 -> 102)'
);

do $$ begin perform public.cancel_order_request('ec000000-0000-0000-0000-0000000000ca', 'test cancel'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_cancel),
  105::numeric(14,4),
  'Cancel restores only fulfilled - returned (3), not the full 5 (102 -> 105)'
);

select is(
  (select status from public.order_requests where id = :order_cancel),
  'cancelled',
  'cancel_order_request moves the order to cancelled'
);

select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_cancel),
  0::numeric(14,4),
  'cancel_order_request zeroes quantity_fulfilled on the cancelled line'
);

select * from finish();
rollback;
