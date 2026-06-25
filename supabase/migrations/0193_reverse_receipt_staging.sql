-- 0193_reverse_receipt_staging.sql
--
-- Fix: reverse_receipt was NOT decrementing the Staging stock level when
-- reversing a receipt, breaking the invariant Σ item_stock_levels = quantity_on_hand.
-- post_receipt_v2 (mig 0190) routes accepted qty into the warehouse Staging location
-- via adjust_stock(item, +qty, 'receive_po', v_staging, ...). The inverse operation,
-- reverse_receipt, was still calling adjust_stock with a NULL location arg, so it
-- decremented quantity_on_hand but left item_stock_levels[item, Staging] untouched —
-- leaving phantom staged stock and a broken Σ invariant.
--
-- Fix: resolve the Staging location from the ORIGINAL receipt's warehouse (mirroring
-- exactly what 0190 added to post_receipt_v2) and pass it as the location arg to the
-- adjust_stock(-qty) call, so reversal is symmetric with receive.
--
-- Diff vs 0183 body (exactly 3 surgical deltas, nothing else):
--   1. v_staging uuid;  added to DECLARE block
--   2. ensure_warehouse_placement_locations + staging-id SELECT added after the
--      has_org_role check and before the receipt_lines loop
--   3. null location arg in adjust_stock call replaced with v_staging

create or replace function public.reverse_receipt(
  p_receipt_id uuid,
  p_reason     text
)
returns public.receipts
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_orig    public.receipts%rowtype;
  v_rev     public.receipts%rowtype;
  v_line    public.receipt_lines%rowtype;
  v_staging uuid;
begin
  select * into v_orig from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'receipt_not_found' using errcode = 'P0002'; end if;
  if v_orig.status <> 'posted' then
    raise exception 'receipt_already_reversed' using errcode = '22023';
  end if;
  if not public.has_org_role(v_orig.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Resolve the warehouse Staging location for symmetric stock-level decrement.
  -- Mirrors the staging-resolution block added to post_receipt_v2 in mig 0190.
  perform public.ensure_warehouse_placement_locations(v_orig.warehouse_id);
  select id into v_staging from public.locations
    where warehouse_id = v_orig.warehouse_id and kind = 'staging' and deleted_at is null
    limit 1;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    status, reversed_receipt_id, reversal_reason,
    received_by, immutable_hash, notes
  ) values (
    v_orig.organization_id, v_orig.purchase_order_id, v_orig.warehouse_id,
    v_orig.receipt_number || '-REV',
    'reversal', v_orig.id, p_reason,
    auth.uid(),
    encode(digest('reversal:' || v_orig.id::text, 'sha256'), 'hex'),
    'Reversal of ' || v_orig.receipt_number
  ) returning * into v_rev;

  for v_line in select * from public.receipt_lines where receipt_id = v_orig.id loop
    -- adjust_stock raises 'insufficient_stock' if on-hand would go negative
    -- (stock already shipped/consumed) — that aborts the whole reversal BEFORE
    -- we delete any serials, so we only ever free provenance for stock that is
    -- still on hand.
    if v_line.qty_accepted_base > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_line.qty_accepted_base,
        'correction',
        v_staging,
        'receipt_reversal',
        v_rev.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_rev.id, v_line.purchase_order_line_id, v_line.item_id,
      -v_line.qty_received_base, -v_line.qty_accepted_base, -v_line.qty_rejected_base,
      v_line.unit_cost, 'Reversal of original receipt line'
    );

    -- Free lot/serial provenance attached to the ORIGINAL line. Reaching here
    -- means the accepted stock was still fully on hand (else adjust_stock above
    -- aborted), so deleting these is safe: it releases the unique(org,item,
    -- serial) lock so the corrected shipment can be re-received, and drops the
    -- now-meaningless lot/aging rows. The original receipt_line itself is kept
    -- (status='reversed') for audit.
    delete from public.serial_registry where receipt_line_id = v_line.id;
    delete from public.receipt_line_lots where receipt_line_id = v_line.id;

    update public.purchase_order_items
      set quantity_received = greatest(0, quantity_received - v_line.qty_accepted_base)
      where id = v_line.purchase_order_line_id;
  end loop;

  update public.receipts set status = 'reversed' where id = v_orig.id;

  perform public.recompute_po_status(v_orig.purchase_order_id);

  return v_rev;
end$$;

grant execute on function public.reverse_receipt(uuid, text) to authenticated;
