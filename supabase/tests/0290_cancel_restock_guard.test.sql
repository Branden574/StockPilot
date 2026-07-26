-- supabase/tests/0290_cancel_restock_guard.test.sql
-- Proves migration 0290: cancel_order_request restocks quantity_picked ONLY
-- when the order's status says those units are actually out of on_hand.
--
--   A. REOPEN PATH (BUG 2, new with 0289) — pick 10 -> complete_picking
--      (on_hand 0) -> reopen_picking (on_hand 10) -> cancel. on_hand must stay
--      10. The live 0244 body restocked a second time and landed on 20.
--   B. MID-PICK PATH (BUG 1, pre-existing) — part-pick 6 with nothing drawn ->
--      cancel. on_hand must stay 10. The live body invented 6 units (-> 16).
--   C. NO REGRESSION — the ordinary picking_complete -> cancel restock still
--      happens, and still writes its visible movement.
--   D. POST-HAND-OVER — quantity_picked is null on every line, so the loop
--      no-ops and quantity_fulfilled is preserved. Unchanged from today.
--   E. THE RESUMED-BACKORDER COUNTEREXAMPLE — at the time this migration
--      shipped, resume_fulfillment (0247) did not clear picking_completed_at,
--      so a resumed order part-picked with a STALE non-null timestamp and
--      nothing drawn. This is why the guard is on status and not on that
--      timestamp: a timestamp gate would restock here and re-invent the stock
--      BUG 1 is about. resume_fulfillment now clears the field (0291), but the
--      guard never read it either way, so the scenario still proves the same
--      point: cancelling a resumed-then-part-picked order must not restock.
--   F. DRAWN BUT UNTIMESTAMPED — an in_transit order with picking_completed_at
--      NULL still restocks. Same shape as the cancel fixture in
--      0158_returns_invariants.test.sql, which a timestamp gate would break.
--   G/H/I. THE REMAINING DRAWN STATUSES — packing_slip_generated,
--      staged_for_pickup and staged_for_delivery each restock. C and F only
--      cover the two ends of the drawn run; these three sit between them and
--      are reached by real transitions off picking_complete, so an over-narrow
--      guard would lose a full staged batch in the middle of the lifecycle.
--   J. THE MANAGER FLOW END TO END — pick 10 -> complete_picking ->
--      reopen_picking -> correct the line to 8 -> complete_picking -> cancel.
--      This is the sequence 0289 shipped for and the one A and C only touch
--      halves of: the cancel must return the CORRECTED 8, landing on_hand back
--      at 10 — not 12 (reopen's return counted twice) and not 2 (the re-draw
--      never returned).
--   K. EXHAUSTIVENESS — a status the guard does not classify RAISES rather than
--      falling through to "not drawn" and silently destroying the batch. Run
--      with the status CHECK constraint and the transition trigger both
--      disarmed, so cancel_order_request is the only thing that can refuse.
--
-- Lines are picked through partial_pick_line, the real product path —
-- order_request_lines carries an RLS `UPDATE using(false)` policy, so every line
-- write goes through a SECURITY DEFINER RPC. Wrapped in begin/rollback —
-- nothing leaks. Namespace d0290000.

begin;

select plan(54);

\set org   '\'d0290000-0000-0000-0000-000000000001\''
\set mgr   '\'d0290000-0000-0000-0000-000000000002\''
\set wh    '\'d0290000-0000-0000-0000-000000000004\''
\set rack  '\'d0290000-0000-0000-0000-000000000005\''

\set item_a '\'d0290000-0000-0000-0000-0000000000a0\''
\set ord_a  '\'d0290000-0000-0000-0000-0000000000a1\''
\set line_a '\'d0290000-0000-0000-0000-0000000000a2\''
\set resv_a '\'d0290000-0000-0000-0000-0000000000a3\''
\set item_b '\'d0290000-0000-0000-0000-0000000000b0\''
\set ord_b  '\'d0290000-0000-0000-0000-0000000000b1\''
\set line_b '\'d0290000-0000-0000-0000-0000000000b2\''
\set resv_b '\'d0290000-0000-0000-0000-0000000000b3\''
\set item_c '\'d0290000-0000-0000-0000-0000000000c0\''
\set ord_c  '\'d0290000-0000-0000-0000-0000000000c1\''
\set line_c '\'d0290000-0000-0000-0000-0000000000c2\''
\set item_d '\'d0290000-0000-0000-0000-0000000000d0\''
\set ord_d  '\'d0290000-0000-0000-0000-0000000000d1\''
\set line_d '\'d0290000-0000-0000-0000-0000000000d2\''
\set item_e '\'d0290000-0000-0000-0000-0000000000e0\''
\set ord_e  '\'d0290000-0000-0000-0000-0000000000e1\''
\set line_e '\'d0290000-0000-0000-0000-0000000000e2\''
\set item_f '\'d0290000-0000-0000-0000-0000000000f0\''
\set ord_f  '\'d0290000-0000-0000-0000-0000000000f1\''
\set line_f '\'d0290000-0000-0000-0000-0000000000f2\''
-- G/H/I/J/K continue the namespace past the hex letters (…01a0 onward).
\set item_g '\'d0290000-0000-0000-0000-0000000001a0\''
\set ord_g  '\'d0290000-0000-0000-0000-0000000001a1\''
\set line_g '\'d0290000-0000-0000-0000-0000000001a2\''
\set item_h '\'d0290000-0000-0000-0000-0000000001b0\''
\set ord_h  '\'d0290000-0000-0000-0000-0000000001b1\''
\set line_h '\'d0290000-0000-0000-0000-0000000001b2\''
\set item_i '\'d0290000-0000-0000-0000-0000000001c0\''
\set ord_i  '\'d0290000-0000-0000-0000-0000000001c1\''
\set line_i '\'d0290000-0000-0000-0000-0000000001c2\''
\set item_j '\'d0290000-0000-0000-0000-0000000001d0\''
\set ord_j  '\'d0290000-0000-0000-0000-0000000001d1\''
\set line_j '\'d0290000-0000-0000-0000-0000000001d2\''
\set item_k '\'d0290000-0000-0000-0000-0000000001e0\''
\set ord_k  '\'d0290000-0000-0000-0000-0000000001e1\''
\set line_k '\'d0290000-0000-0000-0000-0000000001e2\''
-- Only the delivery order (I) needs a charter: order_requests_delivery_target_chk
-- (0110) demands delivery_charter_id when fulfillment_type = 'delivery', and
-- forbids it on 'pickup'.
\set charter '\'d0290000-0000-0000-0000-0000000001f0\''

-- ── Fixtures (as owner, before the role switch) ──────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, 'cancel-0290-mgr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Cancel Guard Org 0290', 'cancel-guard-0290') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Cancel WH', 'WH-CG-0290', 'active') on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'CG-R1', 'shelf', 'rack') on conflict (id) do nothing;
insert into public.charters (id, organization_id, name, status)
  values (:charter, :org, 'CG Delivery Charter', 'active') on conflict (id) do nothing;

-- Every item starts at on_hand 10, fully PLACED in the rack: complete_picking
-- draws PLACED stock, so the Unplaced level auto-seeded by
-- trg_seed_initial_level (0199) is replaced with an explicit rack level (same
-- pattern as 0244 / 0289) to keep Sum(levels) = on_hand.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_a, :org, :wh, 'CG-A', 'Item A', 10, 'active', 'none'),
    (:item_b, :org, :wh, 'CG-B', 'Item B', 10, 'active', 'none'),
    (:item_c, :org, :wh, 'CG-C', 'Item C', 10, 'active', 'none'),
    (:item_d, :org, :wh, 'CG-D', 'Item D', 10, 'active', 'none'),
    (:item_e, :org, :wh, 'CG-E', 'Item E', 10, 'active', 'none'),
    (:item_f, :org, :wh, 'CG-F', 'Item F', 10, 'active', 'none'),
    (:item_g, :org, :wh, 'CG-G', 'Item G', 10, 'active', 'none'),
    (:item_h, :org, :wh, 'CG-H', 'Item H', 10, 'active', 'none'),
    (:item_i, :org, :wh, 'CG-I', 'Item I', 10, 'active', 'none'),
    (:item_j, :org, :wh, 'CG-J', 'Item J', 10, 'active', 'none'),
    (:item_k, :org, :wh, 'CG-K', 'Item K', 10, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels
  where item_id in (:item_a, :item_b, :item_c, :item_d, :item_e, :item_f,
                    :item_g, :item_h, :item_i, :item_j, :item_k);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values
    (:org, :item_a, :rack, 10),
    (:org, :item_b, :rack, 10),
    (:org, :item_c, :rack, 10),
    (:org, :item_d, :rack, 10),
    (:org, :item_e, :rack, 10),
    (:org, :item_f, :rack, 10),
    (:org, :item_g, :rack, 10),
    (:org, :item_h, :rack, 10),
    (:org, :item_i, :rack, 10),
    (:org, :item_j, :rack, 10),
    (:org, :item_k, :rack, 10);

-- Orders (INSERT bypasses the UPDATE-only transition trigger).
--   A/B/C: live pick cycles.
--   D: a backordered order past hand-over — quantity_picked already nulled by
--      confirm_order_signature, quantity_fulfilled is the record of what shipped.
--   E: a backordered order about to be RESUMED. picking_completed_at is stamped
--      from the superseded cycle and resume_fulfillment never clears it.
--   F: drawn goods out for delivery, but picking_completed_at deliberately NULL
--      (the 0158 fixture shape) — status alone must decide.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type,
   delivery_charter_id, picking_completed_at, picking_completed_by, signed_at)
  values
    (:ord_a, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', null, null, null, null),
    (:ord_b, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', null, null, null, null),
    (:ord_c, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', null, null, null, null),
    (:ord_d, :org, :wh, 'backordered',         :mgr, 'internal', 'pickup', null,
     now() - interval '2 hours', :mgr, now() - interval '1 hour'),
    (:ord_e, :org, :wh, 'backordered',         :mgr, 'internal', 'pickup', null,
     now() - interval '2 hours', :mgr, now() - interval '1 hour'),
    (:ord_f, :org, :wh, 'in_transit',          :mgr, 'internal', 'pickup', null, null, null, null),
    --   G/H/J: live pick cycles driven forward into the drawn statuses.
    --   I: same, but fulfillment_type 'delivery' — the 0109 trigger refuses
    --      staged_for_delivery on anything else, and 0110 then requires a charter.
    (:ord_g, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup',   null,     null, null, null),
    (:ord_h, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup',   null,     null, null, null),
    (:ord_i, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'delivery', :charter, null, null, null),
    (:ord_j, :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup',   null,     null, null, null)
  on conflict (id) do nothing;
-- ord_k is inserted in section K — its status does not exist yet.

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_a, :ord_a, :item_a, 10,  0, null),
    (:line_b, :ord_b, :item_b, 10,  0, null),
    (:line_c, :ord_c, :item_c, 10,  0, null),
    (:line_d, :ord_d, :item_d, 10,  4, null),
    (:line_e, :ord_e, :item_e, 20,  4, null),
    (:line_f, :ord_f, :item_f, 10,  0, 3),
    (:line_g, :ord_g, :item_g, 10,  0, null),
    (:line_h, :ord_h, :item_h, 10,  0, null),
    (:line_i, :ord_i, :item_i, 10,  0, null),
    (:line_j, :ord_j, :item_j, 10,  0, null)
  on conflict (id) do nothing;

insert into public.stock_reservations
  (id, organization_id, item_id, warehouse_id, order_request_id, quantity, released_at)
  values
    (:resv_a, :org, :item_a, :wh, :ord_a, 10, null),
    (:resv_b, :org, :item_b, :wh, :ord_b, 10, null)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────────
set local "request.jwt.claim.sub" to 'd0290000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- A — BUG 2: pick -> complete -> reopen -> cancel must NOT restock again
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000000a2'::uuid, 10); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000000a1'::uuid); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  0::numeric(14,4),
  'A: complete_picking drew on_hand 10 -> 0');

do $$ begin perform public.reopen_picking('d0290000-0000-0000-0000-0000000000a1'::uuid,
  'Miscount, recount the line'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  10::numeric(14,4),
  'A: reopen_picking already returned the units (0 -> 10)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_a),
  10::numeric(14,4),
  'A: reopen_picking preserved quantity_picked (the cancel trap)');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000000a1'::uuid,
  'cancelled after reopen'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  10::numeric(14,4),
  'A: cancel after reopen leaves on_hand 10 — NOT the double-restocked 20');
select is(
  (select status from public.order_requests where id = :ord_a),
  'cancelled',
  'A: order is cancelled');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_a),
  null,
  'A: quantity_picked cleared even though the restock was skipped');
select ok(
  not exists (
    select 1 from public.stock_movements
     where item_id = :item_a
       and reason like 'Order cancelled (order_request %'
  ),
  'A: no phantom restock movement was written');

-- ════════════════════════════════════════════════════════════════════════════
-- B — BUG 1: part-pick (nothing drawn) -> cancel must NOT restock
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000000b2'::uuid, 6); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_b),
  10::numeric(14,4),
  'B: partial_pick_line draws nothing (on_hand still 10)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_b),
  6::numeric(14,4),
  'B: the picker keyed 6 onto the line');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000000b1'::uuid,
  'cancelled mid-pick'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_b),
  10::numeric(14,4),
  'B: cancel mid-pick leaves on_hand 10 — NOT the invented 16');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_b),
  null,
  'B: quantity_picked cleared (a cancelled order carries no staged batch)');
select is(
  (select status from public.order_requests where id = :ord_b),
  'cancelled',
  'B: order is cancelled');
-- Preserved 0244 behaviour: reservations are released with a reason, and the
-- 0077 clear-or-replace writes denied_reason.
select isnt(
  (select released_at from public.stock_reservations where id = :resv_b),
  null,
  'B: the active reservation was released');
select is(
  (select released_reason from public.stock_reservations where id = :resv_b),
  'cancelled',
  'B: released_reason = cancelled (unchanged from 0244)');
select is(
  (select denied_reason from public.order_requests where id = :ord_b),
  'cancelled mid-pick',
  'B: denied_reason carries the cancel reason (0077 clear-or-replace intact)');

-- ════════════════════════════════════════════════════════════════════════════
-- C — NO REGRESSION: picking_complete -> cancel still restocks
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000000c2'::uuid, 4); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000000c1'::uuid); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_c),
  6::numeric(14,4),
  'C: complete_picking drew 4 (10 -> 6)');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000000c1'::uuid,
  'cancelled after picking'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_c),
  10::numeric(14,4),
  'C: cancel from picking_complete restocks the drawn batch (6 -> 10)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_c),
  null,
  'C: quantity_picked cleared so the restock can never be replayed');
select ok(
  exists (
    select 1 from public.stock_movements
     where item_id = :item_c
       and organization_id = :org
       and quantity_change = 4::numeric(14,4)
       and reason like 'Order cancelled (order_request %'
  ),
  'C: the restock wrote its visible + stock_movements row');

-- ════════════════════════════════════════════════════════════════════════════
-- D — POST-HAND-OVER: quantity_picked null everywhere, loop no-ops
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000000d1'::uuid,
  'cancelled after hand-over'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_d),
  10::numeric(14,4),
  'D: nothing is restocked when quantity_picked is null (on_hand untouched)');
select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_d),
  4::numeric(14,4),
  'D: quantity_fulfilled preserved — goods the customer took are never un-shipped');
select is(
  (select status from public.order_requests where id = :ord_d),
  'cancelled',
  'D: order is cancelled');

-- ════════════════════════════════════════════════════════════════════════════
-- E — THE COUNTEREXAMPLE that rules out a picking_completed_at gate.
--     At the time this migration shipped, resume_fulfillment left the
--     superseded cycle's picking_completed_at in place, so a resumed order
--     part-picked with a stale non-null timestamp and nothing drawn — this is
--     precisely why the guard above is on status, not on that timestamp.
--     0291_resume_fulfillment_clear_picking_stamps.sql has since fixed
--     resume_fulfillment to null the field out, but the guard was never
--     reading it either way, so a resumed-then-part-picked order must still
--     go uncharged on cancel regardless of what picking_completed_at holds.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.resume_fulfillment('d0290000-0000-0000-0000-0000000000e1'::uuid); end $$;

select is(
  (select picking_completed_at from public.order_requests where id = :ord_e),
  null,
  'E: resume_fulfillment clears picking_completed_at (0291) — the status guard '
  || 'above never depended on this field either way');

do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000000e2'::uuid, 6); end $$;

select is(
  (select status from public.order_requests where id = :ord_e),
  'picking_in_progress',
  'E: the resumed order is mid-pick again');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_e),
  10::numeric(14,4),
  'E: still nothing drawn (on_hand 10)');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000000e1'::uuid,
  'cancelled mid-pick on a resumed backorder'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_e),
  10::numeric(14,4),
  'E: cancel leaves on_hand 10 — a status guard correctly skips the restock');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_e),
  null,
  'E: quantity_picked cleared');
select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_e),
  4::numeric(14,4),
  'E: the earlier shipped batch is still recorded as fulfilled');

-- ════════════════════════════════════════════════════════════════════════════
-- F — DRAWN BUT UNTIMESTAMPED: in_transit with picking_completed_at NULL still
--     restocks (the 0158_returns_invariants cancel fixture shape).
-- ════════════════════════════════════════════════════════════════════════════
select is(
  (select picking_completed_at from public.order_requests where id = :ord_f),
  null,
  'F: precondition — in_transit order carries NO picking_completed_at');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000000f1'::uuid,
  'cancelled in transit'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_f),
  13::numeric(14,4),
  'F: the drawn in_transit batch of 3 is restocked (10 -> 13)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_f),
  null,
  'F: quantity_picked cleared');

-- ════════════════════════════════════════════════════════════════════════════
-- G — packing_slip_generated is a DRAWN status: cancel must restock. Printing
--     the slip is paperwork; complete_picking already pulled the units and
--     nothing between there and the signature puts them back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000001a2'::uuid, 5); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000001a1'::uuid); end $$;
update public.order_requests
   set status                    = 'packing_slip_generated',
       packing_slip_generated_at = now(),
       packing_slip_generated_by = :mgr
 where id = :ord_g;

select is(
  (select status from public.order_requests where id = :ord_g),
  'packing_slip_generated',
  'G: the order advanced onto the pack bench');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_g),
  5::numeric(14,4),
  'G: precondition — complete_picking drew 5 (10 -> 5)');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000001a1'::uuid,
  'cancelled after the packing slip printed'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_g),
  10::numeric(14,4),
  'G: cancel from packing_slip_generated restocks the drawn batch (5 -> 10)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_g),
  null,
  'G: quantity_picked cleared');
select ok(
  exists (
    select 1 from public.stock_movements
     where item_id = :item_g
       and organization_id = :org
       and quantity_change = 5::numeric(14,4)
       and reason like 'Order cancelled (order_request %'
  ),
  'G: the restock wrote its stock_movements row');

-- ════════════════════════════════════════════════════════════════════════════
-- H — staged_for_pickup is a DRAWN status. The batch is sitting on the pickup
--     shelf, out of on_hand, and the customer never signed for it.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000001b2'::uuid, 6); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000001b1'::uuid); end $$;
update public.order_requests
   set status                    = 'packing_slip_generated',
       packing_slip_generated_at = now(),
       packing_slip_generated_by = :mgr
 where id = :ord_h;
update public.order_requests set status = 'staged_for_pickup' where id = :ord_h;

select is(
  (select status from public.order_requests where id = :ord_h),
  'staged_for_pickup',
  'H: the order is staged on the pickup shelf');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_h),
  4::numeric(14,4),
  'H: precondition — complete_picking drew 6 (10 -> 4)');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000001b1'::uuid,
  'customer never collected'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_h),
  10::numeric(14,4),
  'H: cancel from staged_for_pickup restocks the staged batch (4 -> 10)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_h),
  null,
  'H: quantity_picked cleared');

-- ════════════════════════════════════════════════════════════════════════════
-- I — staged_for_delivery is a DRAWN status. Same as H on the delivery fork,
--     one step before the in_transit case F already covers.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000001c2'::uuid, 7); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000001c1'::uuid); end $$;
update public.order_requests
   set status                    = 'packing_slip_generated',
       packing_slip_generated_at = now(),
       packing_slip_generated_by = :mgr
 where id = :ord_i;
update public.order_requests set status = 'staged_for_delivery' where id = :ord_i;

select is(
  (select status from public.order_requests where id = :ord_i),
  'staged_for_delivery',
  'I: the order is staged for the van');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_i),
  3::numeric(14,4),
  'I: precondition — complete_picking drew 7 (10 -> 3)');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000001c1'::uuid,
  'delivery cancelled before it left'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_i),
  10::numeric(14,4),
  'I: cancel from staged_for_delivery restocks the staged batch (3 -> 10)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_i),
  null,
  'I: quantity_picked cleared');

-- ════════════════════════════════════════════════════════════════════════════
-- J — THE MANAGER FLOW, END TO END. The sequence 0289 shipped for, run through
--     the real RPCs: pick 10 -> complete -> reopen -> correct to 8 -> complete
--     -> cancel. Three stock writes happen (-10, +10, -8) and the cancel owes
--     exactly the last one back. on_hand must land on 10: 12 means reopen's
--     return was counted a second time (BUG 2 back), 2 means the corrected
--     re-draw was never returned (the stock-loss direction of the guard).
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000001d2'::uuid, 10); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000001d1'::uuid); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_j),
  0::numeric(14,4),
  'J: the first complete_picking drew the keyed 10 (10 -> 0)');

do $$ begin perform public.reopen_picking('d0290000-0000-0000-0000-0000000001d1'::uuid,
  'Recount — the shelf label was wrong'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_j),
  10::numeric(14,4),
  'J: reopen handed the draw back (0 -> 10)');

-- The manager corrects the miscount through the real pick RPC and re-completes.
do $$ begin perform public.partial_pick_line('d0290000-0000-0000-0000-0000000001d2'::uuid, 8); end $$;
do $$ begin perform public.complete_picking('d0290000-0000-0000-0000-0000000001d1'::uuid); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_j),
  2::numeric(14,4),
  'J: the corrected re-pick drew 8, not the original 10 (10 -> 2)');
select is(
  (select status from public.order_requests where id = :ord_j),
  'picking_complete',
  'J: the order is back at picking_complete — a DRAWN status');

do $$ begin perform public.cancel_order_request('d0290000-0000-0000-0000-0000000001d1'::uuid,
  'customer cancelled after the recount'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_j),
  10::numeric(14,4),
  'J: cancel returns exactly the corrected 8 (2 -> 10) — not 12, not 2');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_j),
  null,
  'J: quantity_picked cleared');
select is(
  (select count(*)::int from public.stock_movements
    where item_id = :item_j
      and organization_id = :org
      and reason like 'Order cancelled (order_request %'),
  1,
  'J: exactly one cancel restock movement across the whole reopen cycle');

-- ════════════════════════════════════════════════════════════════════════════
-- K — EXHAUSTIVENESS. The guard classifies every value of
--     order_requests_status_check; a value it does not know must RAISE.
--
--     This is the asymmetry the guard's shape exists for. Restocking wrongly
--     invents stock but writes a movement row that a cycle count will catch;
--     SKIPPING a restock that was owed writes nothing, and because cancelled is
--     terminal the batch can never be recovered. So an unrecognised status must
--     never inherit a silent "not drawn" default.
--
--     Simulating the regression: a future migration adds a value to
--     order_requests_status_check and does not revisit cancel_order_request.
--     The constraint is dropped so such a value can be admitted here —
--     cancel_order_request must not care where the value came from.
--
--     trg_order_requests_validate_transition is disabled for the same reason.
--     A real migration adding a status wires it into BOTH the constraint and
--     _validate_order_request_status_transition (0243 is the worked example),
--     so the transition trigger would NOT object to the new value. Leaving the
--     trigger armed here would let its own `else false` refuse the cancel and
--     the test would pass without cancel_order_request having guarded anything.
--     Disabled, the ONLY thing that can refuse is the guard under test.
--
--     Both need table ownership, hence the role round-trip; the outer rollback
--     puts the constraint and the trigger back.
-- ════════════════════════════════════════════════════════════════════════════
reset role;

alter table public.order_requests drop constraint order_requests_status_check;
alter table public.order_requests disable trigger trg_order_requests_validate_transition;

insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type,
   picking_completed_at, picking_completed_by, signed_at)
  values
    (:ord_k, :org, :wh, 'staged_for_freight', :mgr, 'internal', 'pickup',
     now(), :mgr, null);
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values (:line_k, :ord_k, :item_k, 10, 0, 5);

set local role to 'authenticated';

select throws_like(
  $$ select public.cancel_order_request('d0290000-0000-0000-0000-0000000001e1'::uuid,
       'cancelled from a status this migration never saw') $$,
  '%unclassified_order_status_for_restock%',
  'K: with every other guard disarmed, cancel itself refuses an unclassified status');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_k),
  5::numeric(14,4),
  'K: fail-closed — the staged batch survives, nothing was silently destroyed');
select is(
  (select status from public.order_requests where id = :ord_k),
  'staged_for_freight',
  'K: the order is NOT cancelled, so the restock stays replayable once classified');

reset role;
select * from finish();
rollback;
