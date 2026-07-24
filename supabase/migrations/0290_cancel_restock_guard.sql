-- cancel_order_request must restock ONLY units that were actually drawn.
--
-- The live body (0244) restocks every line's quantity_picked whenever it is
-- greater than zero, on the assumption "quantity_picked > 0 means those units
-- were pulled off the shelf". That assumption is false in two reachable states,
-- and each one invents phantom stock on cancel:
--
--   BUG 1 — MID-PICK (pre-existing). partial_pick_line (0238) writes
--     quantity_picked as the picker keys each line; it draws NOTHING. Stock is
--     drawn only by complete_picking (0247), which calls adjust_stock(-v_batch)
--     and then sets quantity_picked = v_batch. Cancelling a part-picked order
--     therefore returns units that never left the shelf: on_hand 10 -> pick 6
--     -> cancel -> on_hand 16.
--
--   BUG 2 — AFTER A REOPEN (new in 0289). reopen_picking already returns the
--     drawn units (adjust_stock +quantity_picked into Unplaced) and DELIBERATELY
--     preserves quantity_picked so the manager can see and correct the counts.
--     Cancelling there restocks the same units a second time: pick 10 ->
--     complete_picking (on_hand 0) -> reopen_picking (on_hand 10) -> cancel ->
--     on_hand 20.
--
-- THE GUARD IS ON STATUS, NOT ON picking_completed_at.
--
-- `picking_completed_at is not null` reads like the deterministic "the draw
-- happened" marker, and for a simple single-cycle order it is. It is NOT
-- sufficient in general, for two independently-proved reasons:
--
--   a. resume_fulfillment (0247) does NOT clear picking_completed_at. A resumed
--      backorder therefore sits at pick_slip_generated carrying a STALE
--      picking_completed_at from the superseded cycle, with quantity_picked
--      reset to null. The picker then keys partial_pick_line -> quantity_picked
--      > 0, status picking_in_progress, nothing drawn, picking_completed_at
--      still non-null. A timestamp-gated cancel restocks that batch and invents
--      the stock all over again — i.e. it does not actually fix BUG 1 for any
--      order that has been through a backorder resume. Verified against the
--      live bodies on the local stack at migration 0289.
--
--   b. 0158_returns_invariants.test.sql cancels an order fixtured directly at
--      'in_transit' with picking_completed_at left NULL, and asserts the staged
--      batch of 3 is restocked (102 -> 105). A timestamp gate silently skips
--      that restock. Correct behaviour there is to restock: in_transit goods
--      are drawn, still-unsigned goods.
--
-- The load-bearing question is "does quantity_picked currently represent units
-- that are OUT of quantity_on_hand?", and status answers it exactly:
--
--   picking_complete / packing_slip_generated / staged_for_pickup /
--   staged_for_delivery / in_transit
--     -> DRAWN. complete_picking is the only writer of 'picking_complete' and
--        it draws in the same transaction; nothing between there and the
--        signature touches quantity_picked or stock. RESTOCK, exactly as today.
--
--   pending_confirmation / pending_approval / approved / pick_slip_generated
--     -> the pick RPCs are unreachable or have not written a batch yet;
--        quantity_picked is null/0 and the loop already no-ops.
--
--   picking_in_progress
--     -> NOT drawn, by both routes into it: partial_pick_line (never drew) and
--        reopen_picking (drew, then gave it back). This single exclusion is what
--        fixes BUG 1 and BUG 2.
--
--   backordered
--     -> confirm_order_signature (0244) nulls quantity_picked at hand-over, so
--        the loop no-ops; quantity_fulfilled is preserved as the record of what
--        the customer received and is NEVER restocked. Unchanged.
--
--   completed / denied / cancelled
--     -> refused by the invalid_status_transition guard above the loop.
--
-- THE CLASSIFICATION IS EXHAUSTIVE, NOT A MEMBERSHIP TEST.
--
-- Written as `v_stock_drawn := status in (…the drawn five…)` the table above
-- would be true today and quietly wrong tomorrow: the implicit default for any
-- value not in the list is FALSE, i.e. "skip the restock". The two failure
-- directions are not symmetric.
--
--   restocking when the units were NOT drawn -> phantom stock. Visible: an
--     adjust_stock 'return' movement row is written, on_hand climbs, a cycle
--     count catches it, and the row says which order to blame.
--   skipping a restock that WAS owed -> the units are gone. NOTHING is written.
--     on_hand simply never comes back, there is no movement row to trace, and
--     the order is terminal so the restock can never be replayed. Nobody finds
--     this except as unexplained shrink weeks later.
--
-- So a future `staged_for_freight` added to order_requests_status_check must
-- not be allowed to inherit the silent-skip default. Every constraint value is
-- enumerated in a `case` and the `else` RAISES. A cancel that refuses is a
-- support ticket and a one-line follow-up migration; a cancel that silently
-- eats a picked batch is unrecoverable. The case is shaped to mirror
-- _validate_order_request_status_transition (0289), the other place a new
-- status has to be wired in, so the two read as a pair.
--
-- The exception is proved by case K of 0290_cancel_restock_guard.test.sql,
-- which admits an unknown status and asserts cancel refuses rather than
-- dropping the batch.
--
-- quantity_picked IS STILL CLEARED WHEN THE RESTOCK IS SKIPPED. The clear sits
-- OUTSIDE the guard on purpose, so the bookkeeping is byte-for-byte what the
-- live body does and the ONLY behavioural difference in this migration is that
-- adjust_stock is conditional. Rationale: cancelled is terminal (the 0289
-- transition trigger has `when 'cancelled' then false`), so a cancelled order
-- must not carry a live staged batch that analytics would read as goods sitting
-- on the pack bench, and no future reader can mistake it for a replayable
-- restock. The keyed count is not lost as audit — picked_at / picked_by survive,
-- and no stock_movements row is owed because no stock moved.
--
-- Everything else is an exact copy of the live 0244 body: auth/role gate
-- (manager or requester), the completed/denied/cancelled refusal, order by
-- item_id for a stable lock order, reservation release with
-- released_reason = 'cancelled', and the 0077 I1 clear-or-replace of
-- denied_reason. search_path stays `public, extensions` — adjust_stock needs
-- digest() via pgcrypto (the 0022 / 0134 / 0137 trap).

create or replace function public.cancel_order_request(p_id uuid, p_reason text default null::text)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
  v_line record;
  v_stock_drawn boolean;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('completed', 'denied', 'cancelled') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  v_is_manager := public.has_org_role(v_req.organization_id, 'manager');
  v_is_owner   := v_req.requester_user_id = v_user;
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Are this order's quantity_picked units currently OUT of quantity_on_hand?
  -- See the status table at the top of this migration.
  --
  -- EXHAUSTIVE BY CONSTRUCTION. Every value of order_requests_status_check is
  -- classified explicitly and an unrecognised one RAISES — see the note on
  -- asymmetric failure at the top of this migration.
  case v_req.status
    -- DRAWN. complete_picking is the only writer of 'picking_complete' and it
    -- calls adjust_stock(-batch) in the same transaction; nothing between there
    -- and the signature touches quantity_picked or stock.
    when 'picking_complete', 'packing_slip_generated', 'staged_for_pickup',
         'staged_for_delivery', 'in_transit' then
      v_stock_drawn := true;

    -- NOT DRAWN. pending_confirmation / pending_approval / approved /
    -- pick_slip_generated carry no batch yet, so the loop no-ops regardless.
    -- picking_in_progress is the exclusion that matters: partial_pick_line
    -- never drew, and reopen_picking already gave its draw back. backordered
    -- had quantity_picked nulled at hand-over.
    when 'pending_confirmation', 'pending_approval', 'approved',
         'pick_slip_generated', 'picking_in_progress', 'backordered' then
      v_stock_drawn := false;

    -- completed / denied / cancelled never reach here — the
    -- invalid_status_transition refusal above rejects them first — so this
    -- branch fires only for a status that did not exist when this was written.
    else
      raise exception 'unclassified_order_status_for_restock'
        using errcode = 'P0001',
              detail  = v_req.status,
              hint    = 'order_requests has a status that cancel_order_request '
                        'does not classify. Decide whether an order in this '
                        'status has its quantity_picked units OUT of '
                        'quantity_on_hand, then add it to the drawn or the '
                        'not-drawn branch of the case in cancel_order_request '
                        '(latest definition: supabase/migrations/'
                        '0290_cancel_restock_guard.sql) and cover it in '
                        'supabase/tests/0290_cancel_restock_guard.test.sql. Do '
                        'not let it fall through to the not-drawn branch '
                        'without checking: skipping a restock that was owed '
                        'destroys stock with no stock_movements row.';
  end case;

  -- Restock the CURRENT staged batch (quantity_picked) — units complete_picking
  -- pulled off the shelf that are still in the building. quantity_fulfilled
  -- (already handed to the customer across prior batches) is NEVER restocked and
  -- is preserved as the record of what was provided. A backordered order has
  -- quantity_picked = null on every line, so this loop no-ops for it — the
  -- backorder-aware branch the spec calls for, expressed by the column split.
  for v_line in
    select l.id as line_id, l.item_id, l.quantity_picked
    from public.order_request_lines l
    where l.order_request_id = p_id
      and coalesce(l.quantity_picked, 0) > 0
    order by l.item_id
  loop
    if v_stock_drawn then
      perform public.adjust_stock(
        v_line.item_id,
        v_line.quantity_picked,
        'return',
        null,
        'Order cancelled (order_request ' || p_id::text || ')',
        null
      );
    end if;
    -- Clear the staged batch so the restock can never be replayed. Runs in BOTH
    -- branches: a cancelled order never carries a live staged batch.
    update public.order_request_lines
      set quantity_picked = null
      where id = v_line.line_id;
  end loop;

  update public.stock_reservations
    set released_at = now(), released_reason = 'cancelled'
    where order_request_id = p_id and released_at is null;

  -- I1 from 0077: clear-or-replace. NEVER preserve a prior denied_reason when a
  -- later cancel arrives without its own reason — the prior text is leaked via
  -- the public track endpoint otherwise.
  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = p_reason
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

comment on function public.cancel_order_request(uuid, text) is
  'Cancel an order request. Restocks the current staged batch (quantity_picked) '
  'ONLY when the order status says those units are actually out of '
  'quantity_on_hand: picking_complete, packing_slip_generated, '
  'staged_for_pickup, staged_for_delivery, in_transit. A mid-pick '
  '(picking_in_progress) order has not drawn yet, and a reopen_picking order '
  'has already had its draw returned — restocking either would invent stock. '
  'quantity_picked is cleared either way; quantity_fulfilled is never restocked. '
  'The status classification is exhaustive over order_requests_status_check: an '
  'unrecognised status raises unclassified_order_status_for_restock rather than '
  'defaulting to skip-the-restock, because a skipped restock destroys stock '
  'silently while a refused cancel is retryable.';
