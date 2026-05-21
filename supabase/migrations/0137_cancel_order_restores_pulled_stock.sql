-- 0137_cancel_order_restores_pulled_stock.sql
--
-- Restores inventory when a cancelled order had stock already pulled.
--
-- Before this fix, `cancel_order_request` only released open
-- stock_reservations and flipped the status to 'cancelled'. That's
-- correct for cancels that happen BEFORE picking — reservations are a
-- soft hold and don't touch quantity_on_hand.
--
-- But once picking finishes, `complete_picking` calls `adjust_stock`
-- per line with `-quantity_picked`, which HARDENS the deduction:
-- quantity_on_hand drops and a stock_movements row is written. From
-- that point on, a cancel left the inventory short — the user pulled
-- 100, cancelled, and the on-hand stayed -100 from where it should
-- be.
--
-- Fix: in the RPC, after releasing reservations and BEFORE flipping
-- the row to 'cancelled', scan order_request_lines for any rows with
-- `quantity_fulfilled > 0` (the marker complete_picking writes when it
-- successfully decremented stock) and call adjust_stock(+qty, 'return',
-- ...) to put the units back. That also writes a stock_movements audit
-- row so the cancel is fully traceable.
--
-- Picked-but-not-yet-completed orders (status =
-- picking_in_progress with `quantity_picked > 0` but
-- `quantity_fulfilled = 0`) are NOT restored — their stock was never
-- decremented from quantity_on_hand in the first place. The
-- reservation release is enough.
--
-- Side effects preserved:
--   • stock_movements gains a per-line 'return' row with the order id
--     in the reason. Audit log unchanged (the cancel.order audit event
--     still fires from the service layer).
--   • complete_picking still writes its 'transfer' row when picking
--     completes. Net inventory effect of pick + cancel = zero, with
--     two stock_movements rows recording the round trip.
--
-- search_path: keep `public, extensions` — adjust_stock needs digest()
-- via pgcrypto (same trap as migrations 0022 / 0134).

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

  -- Restore any stock that complete_picking already pulled. We key off
  -- quantity_fulfilled > 0 because that's the column complete_picking
  -- writes ONLY after a successful adjust_stock(-qty) call — so it's
  -- the deterministic marker that on-hand was actually decremented.
  -- order by item_id keeps the row-lock order stable across multiple
  -- cancel calls on the same item, matching complete_picking's pattern.
  for v_line in
    select l.id as line_id, l.item_id, l.quantity_fulfilled
    from public.order_request_lines l
    where l.order_request_id = p_id
      and l.quantity_fulfilled > 0
    order by l.item_id
  loop
    perform public.adjust_stock(
      v_line.item_id,
      v_line.quantity_fulfilled,
      'return',
      null,
      'Order cancelled (order_request ' || p_id::text || ')',
      null
    );
    -- Zero out quantity_fulfilled so any future analytics see the
    -- cancelled order as not-fulfilled. Without this, reports that
    -- read quantity_fulfilled would still count the (now-returned)
    -- units as shipped.
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
