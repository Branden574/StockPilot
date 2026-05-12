-- ============================================================================
-- 0058_dedupe_shipment_order_other_direction.sql
--
-- 0057 added a guard in deliver_order_request so an order's deliver
-- step skips the stock decrement when its linked shipment was already
-- 'shipped' / 'delivered'. That fixed ONE direction:
--
--     ship shipment → deliver order   ✓ no double-decrement
--
-- But the user discovered the OPPOSITE sequence still double-deducted:
--
--     deliver order → ship shipment   ✗ both flows ran adjust_stock
--
-- post_shipment_shipped had no symmetric check. Whichever flow runs
-- second now needs to detect the first one already touched stock and
-- skip its own decrement. This migration adds the mirror guard in
-- post_shipment_shipped: if the linked order_request is already in
-- 'delivered' status, skip the per-line adjust_stock loop — the
-- physical movement was already recorded by deliver_order_request.
-- Still flips the shipment status to 'shipped' and returns the same
-- (lines_shipped, total_qty_shipped) shape so the calling service /
-- UI toast unchanged.
--
-- After 0057 + 0058 are both applied, the order of operations no
-- longer matters: whichever flow runs first decrements stock, the
-- other one just flips its status.
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

  -- 4. Symmetric dedup with 0057: if this shipment is linked to an
  --    order_request that's already in 'delivered' status, the order
  --    side already ran the per-line stock decrement via
  --    deliver_order_request. Skip our own decrement to avoid the
  --    double-deduction the user saw on the deliver-first-then-ship
  --    flow.
  if v_shipment.order_request_id is not null then
    select (status = 'delivered')
    into v_order_already_delivered
    from public.order_requests
    where id = v_shipment.order_request_id;
  end if;

  if not v_order_already_delivered then
    -- Standard path: ship is the authoritative physical movement.
    -- Deduct each line via adjust_stock (existing pre-0058 behavior).
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
  else
    -- Order already delivered → stock already left on_hand. Just
    -- record line counts for the return value so the calling
    -- service's audit + UI toast still report sensible numbers.
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
  '(unless the linked order_request is already in delivered status, in '
  'which case the order side already decremented and we skip — see '
  'migration 0058), then flips status to shipped. Whole sequence runs '
  'in one transaction so any failure rolls back every prior deduction.';
