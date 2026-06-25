-- 0195_reverse_receipt_staging_first.sql
--
-- Fix: reverse_receipt must drain Staging-first, then placed, so that receipts
-- can be reversed even after Phase 2b allows stock to be placed out of Staging.
--
-- Previously (0193) the reversal resolved the Staging location explicitly and
-- passed it as the location arg to adjust_stock(-qty). That worked only when all
-- accepted stock was still sitting in Staging. Phase 2b lets receivers transfer
-- stock from Staging onto racks, so at reversal time the stock may be split
-- across Staging + rack locations. The old explicit-Staging path would try to
-- remove the full qty from Staging alone (which may only hold a subset) → negative
-- level / incorrect state.
--
-- Fix: delete the Phase-1 explicit-Staging resolution block and pass a null
-- location with the new 'staging_first' mode (mig 0194), which calls
-- apply_level_delta(item, -qty, 'staging_first'). That helper drains the item's
-- Staging level(s) first, then draws down placed locations (racks first, Unplaced
-- last) — correct whether or not stock has been placed out.
--
-- Note: the reversal stock_movement's from_location_id is null (null-location
-- correction); the per-location decrement is carried by item_stock_levels via
-- apply_level_delta('staging_first'), which is now the per-location source of truth.
--
-- Diff vs 0193 body (exactly two surgical deltas, nothing else):
--   1. Removed: v_staging uuid; declaration from DECLARE block
--              + ensure_warehouse_placement_locations + staging-id SELECT block
--   2. Changed: adjust_stock call from
--                 adjust_stock(item, -qty, 'correction', v_staging, 'receipt_reversal', rev_id)
--              to
--                 adjust_stock(item, -qty, 'correction', null, 'receipt_reversal', rev_id, 'staging_first')

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
begin
  select * into v_orig from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'receipt_not_found' using errcode = 'P0002'; end if;
  if v_orig.status <> 'posted' then
    raise exception 'receipt_already_reversed' using errcode = '22023';
  end if;
  if not public.has_org_role(v_orig.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

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
        null,
        'receipt_reversal',
        v_rev.id::text,
        'staging_first'
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
