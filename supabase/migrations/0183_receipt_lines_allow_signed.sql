-- 0183_receipt_lines_allow_signed.sql
--
-- Make receipt REVERSAL actually work. It was never functional: reverse_receipt
-- records a reversal as a sibling receipt (status='reversal') whose lines carry
-- NEGATIVE quantities (a signed-ledger entry; the real stock decrement happens
-- via adjust_stock(-qty) and the PO line's quantity_received is decremented
-- directly). Several things blocked or corrupted that flow:
--
--   1. receipt_lines had per-column `>= 0` CHECKs that rejected negative rows.
--   2. receipt_lines_check ((acc + rej) <= received) is NOT sign-symmetric:
--      negating an under-attributed row (received=10, accepted=8) produces
--      -8 <= -9.9999 = FALSE, so reversal still failed for any receipt with
--      unaccounted units.
--   3. reverse_receipt never freed lot/serial provenance, so reversing a
--      serial-tracked receipt left serial_registry rows 'available' with no
--      backing stock — and the unique(org,item,serial) lock meant those serials
--      could NEVER be received again.
--   4. recompute_po_status only rolled FORWARD, so a fully-reversed PO stayed
--      'received' (with received_at set) and couldn't accept new receipts.
--
-- Forward receipts stay protected: post_receipt_v2 (0069) is the sole forward
-- inserter and already raises 'negative_quantity' on any negative input.

-- 1 + 2 ── constraints ──────────────────────────────────────────────────────
alter table public.receipt_lines drop constraint if exists receipt_lines_qty_received_base_check;
alter table public.receipt_lines drop constraint if exists receipt_lines_qty_accepted_base_check;
alter table public.receipt_lines drop constraint if exists receipt_lines_qty_rejected_base_check;

-- Sign-symmetric relationship invariant: dispositions can't exceed received,
-- for both forward (+) and reversal (−) rows. Holds for 10/8/0 → −10/−8/0
-- (abs: 8 <= 10.0001) and still rejects a bad forward row like 10/8/5.
alter table public.receipt_lines drop constraint if exists receipt_lines_check;
alter table public.receipt_lines add constraint receipt_lines_check
  check (abs(qty_accepted_base) + abs(qty_rejected_base) <= abs(qty_received_base) + 0.0001);

-- 4 ── recompute_po_status now rolls BACKWARD too ───────────────────────────
create or replace function public.recompute_po_status(p_po_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total_ordered  numeric;
  v_total_received numeric;
begin
  select coalesce(sum(quantity_ordered), 0),
         coalesce(sum(quantity_received), 0)
    into v_total_ordered, v_total_received
    from public.purchase_order_items
    where purchase_order_id = p_po_id;

  if v_total_received <= 0 then
    -- Nothing received (or fully reversed): roll back to the open 'ordered'
    -- state and clear received_at, so the PO reflects reality and can accept
    -- fresh receipts again. Never touch draft/cancelled POs.
    update public.purchase_orders
      set status = 'ordered', received_at = null
      where id = p_po_id and status not in ('draft', 'cancelled');
    return 'ordered';
  elsif v_total_received >= v_total_ordered then
    update public.purchase_orders
      set status = 'received', received_at = coalesce(received_at, now())
      where id = p_po_id and status not in ('cancelled');
    return 'received';
  else
    -- Partially received: clear any stale full-receipt timestamp (e.g. after a
    -- reversal dropped it below complete).
    update public.purchase_orders
      set status = 'partially_received', received_at = null
      where id = p_po_id and status not in ('cancelled');
    return 'partially_received';
  end if;
end$$;

grant execute on function public.recompute_po_status(uuid) to authenticated;

-- 3 ── reverse_receipt frees lot/serial provenance for the reversed lines ────
-- (search_path = public, extensions preserved from migration 0134 — digest()).
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
  v_orig public.receipts%rowtype;
  v_rev  public.receipts%rowtype;
  v_line public.receipt_lines%rowtype;
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
