-- ============================================================================
-- 0073_release_reservations_on_shipped.sql
--
-- C1 from the Shipments hunter report: post_shipment_shipped never releases
-- the soft-hold stock_reservations rows that were created when the linked
-- order_request was approved/packed. The order side's deliver_order_request
-- (0044, refined 0055/0057) DOES release on its own path, but if shipping
-- runs first (ship → deliver order), the reservation row for the order
-- stayed `released_at = NULL` forever. That makes
-- `available = on_hand - sum(reservations.quantity)` under-report for the
-- rest of the row's life and inflates the dashboard's "reserved" hero.
--
-- Fix: inside the "this shipment is the authoritative physical movement"
-- branch (the one that actually decrements on_hand via adjust_stock), also
-- mark every active reservation for the linked order_request as released.
-- We use 'shipped' as the released_reason so audit history can distinguish
-- ship-first releases from the existing deliver-first releases.
--
-- Idempotent: `released_at is null` filters out anything already released
-- by a prior deliver_order_request call (the other-direction flow).
--
-- Composition: only the symmetric-dedup branch (not the
-- already-delivered branch) needs the release — when the order is already
-- in 'delivered' status, deliver_order_request already released the rows.
-- ============================================================================

create or replace function public.post_shipment_shipped(
  p_shipment_id uuid
)
returns table (
  lines_shipped int,
  total_qty_shipped numeric
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_shipment public.shipments%rowtype;
  v_line     record;
  v_lines    int := 0;
  v_total    numeric := 0;
  v_order_already_delivered boolean := false;
begin
  -- 1. Lock the shipment row. Concurrent callers serialize here.
  select * into v_shipment
  from public.shipments
  where id = p_shipment_id
  for update;

  if not found then
    raise exception 'shipment_not_found' using errcode = 'P0002';
  end if;

  -- 2. Status check inside the lock.
  if v_shipment.status <> 'draft' then
    raise exception 'shipment_not_draft' using errcode = 'P0001',
      detail = format('Shipment %s is in status %s, expected draft',
                      v_shipment.work_order_number, v_shipment.status);
  end if;

  -- 3. Permission gate.
  if not public.has_org_role(v_shipment.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 4. Symmetric dedup with 0057.
  if v_shipment.order_request_id is not null then
    select (status = 'delivered')
    into v_order_already_delivered
    from public.order_requests
    where id = v_shipment.order_request_id;
  end if;

  if not v_order_already_delivered then
    -- Standard path: ship is the authoritative physical movement.
    for v_line in
      select item_id, qty_shipped
      from public.shipment_lines
      where shipment_id = p_shipment_id
      order by line_order
    loop
      perform public.adjust_stock(
        v_line.item_id,
        -v_line.qty_shipped,
        'transfer',
        null,
        'Shipment ' || v_shipment.work_order_number,
        null
      );
      v_lines := v_lines + 1;
      v_total := v_total + v_line.qty_shipped;
    end loop;

    -- 0073: release the soft holds that backed the order request. If the
    -- ship runs first (this branch), deliver_order_request never gets to
    -- release them — and the order's "available" math under-reports for
    -- the life of the row. Idempotent: the `released_at is null` filter
    -- skips reservations a prior deliver_order_request already released.
    if v_shipment.order_request_id is not null then
      update public.stock_reservations
      set released_at = now(),
          released_reason = 'shipped'
      where order_request_id = v_shipment.order_request_id
        and released_at is null;
    end if;
  else
    -- Order already delivered → stock already left on_hand. Just record
    -- line counts for the return value. Reservations were already
    -- released by deliver_order_request.
    select count(*)::int, coalesce(sum(qty_shipped), 0)::numeric
    into v_lines, v_total
    from public.shipment_lines
    where shipment_id = p_shipment_id;
  end if;

  -- 5. Flip shipment to 'shipped' in both branches.
  update public.shipments
  set status = 'shipped', updated_at = now()
  where id = p_shipment_id;

  return query select v_lines, v_total;
end;
$$;

comment on function public.post_shipment_shipped(uuid) is
  'Atomically transitions a shipment from draft to shipped. Locks the '
  'row, verifies draft status, deducts stock per line via adjust_stock '
  '(unless the linked order_request is already in delivered status), '
  'releases any soft-hold stock_reservations rows backing the order '
  '(0073), then flips status to shipped. Whole sequence runs in one '
  'transaction so any failure rolls back every prior deduction.';
