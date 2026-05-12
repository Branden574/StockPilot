-- ============================================================================
-- 0057_dedupe_shipment_order_stock_deduction.sql
--
-- Critical bug: when a packing-slip shipment is generated from an order
-- request and BOTH flows are completed, stock is decremented twice.
--
--   1. User approves order             → reservations created (no decrement)
--   2. User generates packing slip     → shipment row with order_request_id
--   3. User marks shipment 'shipped'   → post_shipment_shipped decrements
--                                         quantity_on_hand per line
--                                         (movement_type='transfer')
--   4. User marks order 'delivered'    → deliver_order_request decrements
--                                         AGAIN per line
--                                         (movement_type='remove',
--                                          reason='order_delivered')
--
-- Both server-side functions are individually atomic, but neither one
-- knows the other has run. They each look at `quantity_on_hand` and
-- subtract `quantity_requested`/`qty_shipped` independently. Net effect
-- on a 1-unit order line: one physical movement, two stock_movements
-- rows, on_hand off by 1.
--
-- The fix lives in deliver_order_request. The shipment side is already
-- the authoritative record of physical movement (it has movement_type
-- 'transfer' + a Shipment WO# reference); the order side's deduction
-- exists for the legacy / direct-deliver path where there is no
-- shipment at all. So: check whether a linked shipment in 'shipped' or
-- 'delivered' status already exists. If yes, skip the per-line
-- inventory_items update + stock_movements insert. Reservations are
-- still released and the order still flips to 'delivered' so the
-- request closes cleanly.
--
-- Backwards compatible: orders WITHOUT a linked shipment still
-- decrement on deliver, same as before. Existing data is not modified
-- by this migration — users with already-double-deducted test orders
-- need to add the missing units back via Adjust Stock manually.
-- ============================================================================

create or replace function public.deliver_order_request(p_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_user uuid := auth.uid();
  v_prev numeric(14,4);
  v_new  numeric(14,4);
  v_shipment_already boolean;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('approved', 'packaging', 'ready_for_delivery') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Has a linked shipment already removed the stock?
  -- Any shipment in 'shipped' or 'delivered' state for this order
  -- means post_shipment_shipped already ran adjust_stock per line.
  select exists (
    select 1
    from public.shipments
    where order_request_id = p_id
      and status in ('shipped', 'delivered')
  ) into v_shipment_already;

  if not v_shipment_already then
    -- Direct-deliver path: no shipment in play, so this is the moment
    -- physical stock leaves on-hand. Existing pre-0057 behavior.
    for v_line in
      select l.id as line_id, l.item_id, l.quantity_requested,
             ii.quantity_on_hand
      from public.order_request_lines l
      join public.inventory_items ii on ii.id = l.item_id
      where l.order_request_id = p_id
      order by l.item_id
      for update of ii
    loop
      if v_line.quantity_requested > v_line.quantity_on_hand then
        raise exception 'insufficient_stock'
          using errcode = 'P0001', detail = v_line.item_id::text;
      end if;
      v_prev := v_line.quantity_on_hand;
      v_new  := v_prev - v_line.quantity_requested;
      update public.inventory_items
        set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
        where id = v_line.item_id;
      insert into public.stock_movements (
        organization_id, item_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, reference_type, reference_id, user_id
      ) values (
        v_req.organization_id, v_line.item_id, 'remove',
        -v_line.quantity_requested, v_prev, v_new,
        'order_delivered', 'order_request', p_id, v_user
      );
      update public.order_request_lines
        set quantity_fulfilled = v_line.quantity_requested
        where id = v_line.line_id;
    end loop;
  else
    -- Shipment-driven path: stock has already left on-hand via
    -- post_shipment_shipped. DO NOT decrement again. Still mark the
    -- order lines as fulfilled so the order detail UI shows correct
    -- fulfilled qtys.
    update public.order_request_lines
      set quantity_fulfilled = quantity_requested
      where order_request_id = p_id;
  end if;

  -- Release reservations in both branches. They were created at
  -- approval and must go away once the order closes, regardless of
  -- which path decremented the stock.
  update public.stock_reservations
    set released_at = now(), released_reason = 'delivered'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status = 'delivered', delivered_at = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$$;
