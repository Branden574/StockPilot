-- ============================================================================
-- 0054_post_shipment_shipped.sql — atomic shipment posting
-- ============================================================================
-- Fixes two CRITICAL bugs the deep-audit caught in ShipmentsService.markShipped:
--
--   #1 Concurrent click race
--      Two managers click "Mark shipped" simultaneously. Both pass the
--      `if status === 'draft'` JS-side check. Both run every adjust_stock
--      RPC. Only THEN does the status update race — one loses, but stock
--      has already been deducted twice.
--
--   #2 Partial-failure retry
--      Lines 1-2 deduct OK. Line 3 errors with insufficient_stock. The
--      throw aborts the JS loop. Status stays 'draft'. User receives the
--      late stock and clicks Post again. Lines 1-2 deduct a SECOND time.
--
-- Both fail to the same root cause: a multi-step state machine was running
-- in app code outside a transaction. This function does the whole thing
-- atomically — claim the shipment, deduct every line, flip to shipped, all
-- inside one Postgres transaction. If anything throws, everything rolls
-- back. If a second caller races, the row lock (FOR UPDATE) makes them
-- wait, and the status check inside the lock rejects the loser cleanly.
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
begin
  -- 1. Lock the shipment row. Concurrent callers serialize here.
  --    The lock is held until the surrounding transaction commits or
  --    rolls back, so the entire deduction sequence below is atomic
  --    with respect to other Post Shipment calls on this same row.
  select * into v_shipment
  from public.shipments
  where id = p_shipment_id
  for update;

  if not found then
    raise exception 'shipment_not_found' using errcode = 'P0002';
  end if;

  -- 2. Status check inside the lock. A second caller who waited on the
  --    lock will see status='shipped' here and bail cleanly without
  --    re-running deductions.
  if v_shipment.status <> 'draft' then
    raise exception 'shipment_not_draft' using errcode = 'P0001',
      detail = format('Shipment %s is in status %s, expected draft',
                      v_shipment.work_order_number, v_shipment.status);
  end if;

  -- 3. Permission gate. adjust_stock checks 'staff' role internally;
  --    Post Shipment requires manager+, so check that here too as
  --    defense-in-depth (the service layer also checks).
  if not public.has_org_role(v_shipment.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 4. Deduct each line via the existing adjust_stock helper. adjust_stock
  --    runs in the SAME transaction as us (PG functions share the caller's
  --    transaction by default), so any insufficient_stock failure rolls
  --    back the whole sequence INCLUDING the earlier successful deductions.
  --    No more "lines 1-2 deducted, line 3 failed, shipment back at draft,
  --    retry double-deducts lines 1-2."
  for v_line in
    select item_id, qty_shipped
    from public.shipment_lines
    where shipment_id = p_shipment_id
    order by line_order
  loop
    perform public.adjust_stock(
      v_line.item_id,
      -v_line.qty_shipped,              -- negative = remove from on-hand
      'transfer',
      null,                              -- no specific location
      'Shipment ' || v_shipment.work_order_number,
      null
    );

    v_lines := v_lines + 1;
    v_total := v_total + v_line.qty_shipped;
  end loop;

  -- 5. Flip the shipment to 'shipped'. Still inside the same transaction
  --    so a second concurrent caller waiting on the lock will see 'shipped'
  --    when they finally acquire the lock and bail at step 2.
  update public.shipments
  set status = 'shipped',
      updated_at = now()
  where id = p_shipment_id;

  return query select v_lines, v_total;
end;
$$;

grant execute on function public.post_shipment_shipped(uuid) to authenticated;

comment on function public.post_shipment_shipped(uuid) is
  'Atomically transitions a shipment from draft to shipped: locks the row, '
  'verifies draft status, runs adjust_stock for each shipment line (negative '
  'qty, transfer movement), then flips status to shipped. The whole sequence '
  'is one Postgres transaction — any insufficient_stock failure or RLS '
  'rejection rolls back every prior deduction in the same call. Concurrent '
  'callers serialize on the row lock; the second caller sees status=shipped '
  'inside the lock and exits cleanly without double-deducting.';
