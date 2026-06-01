-- 0155_cancel_order_respects_returns.sql
--
-- Make cancel_order_request respect the Returns/RMA durable budget so a cancel
-- can never double-restock units that a return already put back (or wrote off).
--
-- Background. cancel_order_request (0137, APPLIED to prod) restores inventory
-- when a cancelled order had stock already pulled: for every order_request_line
-- with quantity_fulfilled > 0 it calls adjust_stock(+quantity_fulfilled,
-- 'return', ...) and then ZEROES quantity_fulfilled. The fulfilment decrement
-- and the cancel restore net to zero.
--
-- The Returns module (0153/0154) adds order_request_lines.returned_quantity: the
-- running total of units already returned against that source line, incremented
-- at apply-time inside process_return_disposition. A returned unit's on-hand was
-- ALREADY reconciled by that return:
--   • RESTOCK return → +qty 'return' (the unit is back on hand already).
--   • SCRAP   return → +qty 'return' then -qty 'loss' (net zero; the unit is
--                      destroyed and must stay destroyed).
-- If cancel then restored the FULL quantity_fulfilled, those returned units would
-- be restocked a SECOND time — inflating on-hand for restocked units and
-- resurrecting destroyed units for scrapped ones.
--
-- Fix: cancel restores only the NOT-YET-RETURNED remainder per line,
--   restore_qty = quantity_fulfilled - returned_quantity   (clamped >= 0),
-- then zeroes quantity_fulfilled as before. Units already returned are left to
-- the return that handled them.
--
-- Defence-in-depth note. createFromOrder requires the order be 'completed' /
-- legacy 'delivered', and this RPC REFUSES to cancel 'completed' (it raises
-- invalid_status_transition for completed/denied/cancelled). So in practice an
-- order can't be both cancellable here AND carry live returns. Honouring
-- returned_quantity is belt-and-suspenders against any future status path that
-- relaxes that mutual exclusion — and it is strictly correct regardless.
--
-- This is an EXACT copy of 0137 except the per-line restore quantity (and the
-- skip of fully-returned lines). search_path stays `public, extensions` —
-- adjust_stock needs digest() via pgcrypto (same trap as 0022 / 0134 / 0137).

create or replace function public.cancel_order_request(
  p_id uuid,
  p_reason text default null
)
returns public.order_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
  v_line record;
  v_restore numeric;
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

  -- Restore any stock that complete_picking already pulled, MINUS whatever a
  -- return already put back (or wrote off). We key off quantity_fulfilled > 0
  -- because that's the column complete_picking writes ONLY after a successful
  -- adjust_stock(-qty) call — the deterministic marker that on-hand was
  -- decremented. returned_quantity (0153) is the durable count of units a return
  -- already reconciled; restoring those again would double-restock restocked
  -- units and resurrect scrapped ones. order by item_id keeps the row-lock order
  -- stable across multiple cancel calls on the same item (matches 0137).
  for v_line in
    select l.id as line_id, l.item_id, l.quantity_fulfilled, l.returned_quantity
    from public.order_request_lines l
    where l.order_request_id = p_id
      and l.quantity_fulfilled > 0
    order by l.item_id
  loop
    v_restore := v_line.quantity_fulfilled - coalesce(v_line.returned_quantity, 0);
    if v_restore > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        v_restore,
        'return',
        null,
        'Order cancelled (order_request ' || p_id::text || ')',
        null
      );
    end if;
    -- Zero out quantity_fulfilled so any future analytics see the cancelled
    -- order as not-fulfilled. Without this, reports that read quantity_fulfilled
    -- would still count the (now-returned) units as shipped.
    update public.order_request_lines
      set quantity_fulfilled = 0
      where id = v_line.line_id;
  end loop;

  update public.stock_reservations
    set released_at = now(), released_reason = 'cancelled'
    where order_request_id = p_id and released_at is null;

  -- I1 from 0077: clear-or-replace. NEVER preserve a prior `denied_reason`
  -- when a later cancel arrives without its own reason — the prior text
  -- is leaked via the public track endpoint otherwise.
  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = p_reason
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;
