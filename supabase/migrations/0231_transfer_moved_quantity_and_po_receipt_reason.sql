-- 0231_transfer_moved_quantity_and_po_receipt_reason.sql
--
-- Two field-reported ledger-display fixes, zero behavioral change to on-hand math:
--
-- (1) "Stock transferred 0": transfer_stock (0191, re-created 0201) writes its
--     stock_movements row with quantity_change = 0 — CORRECT, and load-bearing:
--     ledger rows sum to quantity_on_hand and the 0230 snapshot rollups depend
--     on it — but it dropped p_quantity entirely, so every display surface
--     showed "0". Fix: new nullable stock_movements.moved_quantity column
--     (metadata-only ADD COLUMN — instant, no table rewrite) + re-create
--     transfer_stock with moved_quantity = p_quantity on the insert.
--     quantity_change stays 0. Old transfer rows keep moved_quantity = null
--     (display layers show no number instead of 0).
--
-- (2) Receipts referenced as "receipt_line": post_receipt_v2 (0069, re-created
--     0190) calls adjust_stock with p_reason = 'receipt_line' — an internal
--     label that leaked into every activity feed. Fix: re-create post_receipt_v2
--     with p_reason = 'PO ' || po_number (the PO row is already loaded as v_po).
--     p_notes stays the receipt id — InventoryService.stagedWorklist CONSUMES
--     notes to resolve the source receipt; do not change it. Verified: no code
--     keys on reason = 'receipt_line' as a sentinel (grep across apps/ +
--     supabase/ 2026-07-07 — only the historical migration bodies write it);
--     old rows are handled at the display layer (reason='receipt_line' →
--     resolve notes → receipts → po_number).
--
-- Function bodies are verbatim copies of the current definitions (transfer_stock
-- from 0201, post_receipt_v2 from 0190) with ONLY the deltas called out below.
-- Signatures, security modes, search_path pins and grants are identical.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1a) stock_movements.moved_quantity — nullable, no default, no backfill.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.stock_movements
  add column if not exists moved_quantity numeric;

comment on column public.stock_movements.moved_quantity is
  'Physical quantity moved by a net-zero movement (transfers). quantity_change '
  'stays 0 for transfers so the ledger still sums to quantity_on_hand; this '
  'column exists purely so displays can show how much moved. NULL on rows '
  'written before migration 0231 and on non-transfer movements.';

-- ─────────────────────────────────────────────────────────────────────────────
-- (1b) transfer_stock — body verbatim from 0201.
--      Delta: the stock_movements insert also writes moved_quantity = p_quantity.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.transfer_stock(
  p_item_id           uuid,
  p_from_location_id  uuid,
  p_to_location_id    uuid,
  p_quantity          numeric,
  p_notes             text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_from_qty numeric;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_item.deleted_at is not null then raise exception 'item_deleted' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify both location IDs belong to the item's org ***
  perform public.assert_location_in_org(p_from_location_id, v_item.organization_id);
  perform public.assert_location_in_org(p_to_location_id,   v_item.organization_id);

  -- Decrement source (create the row at 0 first so the guard can fire).
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_from_location_id, 0)
  on conflict (item_id, location_id) do nothing;

  update public.item_stock_levels
    set quantity = quantity - p_quantity, updated_at = now()
  where item_id = p_item_id and location_id = p_from_location_id
  returning quantity into v_from_qty;

  if v_from_qty < 0 then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;

  -- Increment destination.
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_to_location_id, p_quantity)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  -- Net-zero on quantity_on_hand: only the location changed.
  -- *** 0231: also record the physical qty moved (moved_quantity) so displays
  --     can show "Stock transferred N" — quantity_change stays 0. ***
  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    moved_quantity,
    from_location_id, to_location_id, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, 'transfer',
    0, v_item.quantity_on_hand, v_item.quantity_on_hand,
    p_quantity,
    p_from_location_id, p_to_location_id, p_notes, auth.uid()
  );

  return v_item;
end;
$$;

grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) post_receipt_v2 — body verbatim from 0190.
--     Delta: the adjust_stock call's p_reason changes from 'receipt_line' to
--     'PO ' || po_number (coalesced to 'PO receipt' if a PO ever lacks a
--     number). p_notes stays receipt.id — stagedWorklist consumes it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id      uuid,
  p_lines             jsonb,
  p_idempotency_key   text,
  p_request_hash      text,
  p_notes             text default null
)
returns public.receipts
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_receipt       public.receipts%rowtype;
  v_existing      public.idempotency_keys%rowtype;
  v_line          record;
  v_po            public.purchase_orders%rowtype;
  v_org           uuid;
  v_item_id       uuid;
  v_tracking      text;
  v_inserted_line uuid;
  v_lot           record;
  v_serial        text;
  v_lot_sum       numeric;
  v_serial_count  int;
  v_po_line       record;
  v_staging       uuid;
begin
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;

  select * into v_existing
    from public.idempotency_keys
    where organization_id = v_org
      and scope = 'receipt'
      and key = p_idempotency_key
    for update;
  if found then
    if v_existing.request_hash = p_request_hash then
      select * into v_receipt from public.receipts where id = v_existing.resource_id;
      return v_receipt;
    else
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status not in ('draft','expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Resolve (creating if needed) the warehouse Staging location.
  perform public.ensure_warehouse_placement_locations(p_warehouse_id);
  select id into v_staging from public.locations
    where warehouse_id = p_warehouse_id and kind = 'staging' and deleted_at is null
    limit 1;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    received_by, idempotency_key, immutable_hash, notes
  ) values (
    v_org, v_po.id, p_warehouse_id,
    'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6),
    auth.uid(), p_idempotency_key,
    encode(digest(p_request_hash, 'sha256'), 'hex'),
    p_notes
  ) returning * into v_receipt;

  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text,
    lots jsonb, serials jsonb
  ) loop
    -- Quantity sanity (from 0069): all per-line quantities must be
    -- non-negative AND qty_received + already-received must not exceed
    -- qty_ordered. Vendor surprises require an explicit PO amendment.
    if coalesce(v_line.qty_received, 0) < 0
       or coalesce(v_line.qty_accepted, 0) < 0
       or coalesce(v_line.qty_rejected, 0) < 0 then
      raise exception 'negative_quantity' using errcode = '23514';
    end if;

    select id, item_id, quantity_received, quantity_ordered
      into v_po_line
      from public.purchase_order_items
      where id = v_line.po_line_id
        and purchase_order_id = v_po.id
      for update;
    if not found then
      raise exception 'po_line_not_found' using errcode = 'P0002';
    end if;
    v_item_id := v_po_line.item_id;

    if v_po_line.quantity_received + coalesce(v_line.qty_accepted, 0) > v_po_line.quantity_ordered then
      raise exception 'over_receive_blocked' using errcode = '23514';
    end if;

    select tracking_type into v_tracking
      from public.inventory_items where id = v_item_id;

    -- Validate tracking-type-specific inputs BEFORE doing any writes.
    if v_tracking = 'lot' then
      if v_line.qty_accepted > 0 then
        if v_line.lots is null or jsonb_array_length(v_line.lots) = 0 then
          raise exception 'lot_required' using errcode = '23514';
        end if;
        select coalesce(sum((elem->>'qty_base')::numeric), 0) into v_lot_sum
          from jsonb_array_elements(v_line.lots) elem;
        if abs(v_lot_sum - v_line.qty_accepted) > 0.0001 then
          raise exception 'lot_qty_mismatch' using errcode = '23514';
        end if;
      end if;
    elsif v_tracking = 'serial' then
      if v_line.qty_accepted > 0 then
        if v_line.serials is null then
          raise exception 'serials_required' using errcode = '23514';
        end if;
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count <> v_line.qty_accepted::int then
          raise exception 'serial_count_mismatch' using errcode = '23514';
        end if;
      end if;
    end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id,
        v_line.qty_accepted,
        'receive_po',
        v_staging,       -- route accepted qty into the warehouse Staging location
        'PO ' || coalesce(v_po.po_number, 'receipt'),  -- *** 0231: was 'receipt_line' ***
        v_receipt.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_receipt.id, v_line.po_line_id, v_item_id,
      v_line.qty_received, v_line.qty_accepted, coalesce(v_line.qty_rejected, 0),
      coalesce(v_line.unit_cost, 0), v_line.notes
    ) returning id into v_inserted_line;

    -- Persist lot rows (only when tracking_type='lot' and qty_accepted > 0)
    if v_tracking = 'lot' and v_line.qty_accepted > 0 then
      for v_lot in select * from jsonb_to_recordset(v_line.lots) as x(
        lot_number text, expiration_date date, qty_base numeric
      ) loop
        insert into public.receipt_line_lots(
          receipt_line_id, lot_number, expiration_date, qty_base
        ) values (
          v_inserted_line, v_lot.lot_number, v_lot.expiration_date, v_lot.qty_base
        );
      end loop;
    end if;

    if v_tracking = 'serial' and v_line.qty_accepted > 0 then
      for v_serial in select * from jsonb_array_elements_text(v_line.serials) loop
        insert into public.serial_registry(
          organization_id, item_id, serial_number, warehouse_id, receipt_line_id
        ) values (
          v_org, v_item_id, v_serial, p_warehouse_id, v_inserted_line
        );
      end loop;
    end if;

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  perform public.recompute_po_status(v_po.id);

  insert into public.idempotency_keys(
    organization_id, scope, key, request_hash, status, resource_type, resource_id
  ) values (
    v_org, 'receipt', p_idempotency_key, p_request_hash, 'completed',
    'receipt', v_receipt.id
  );

  return v_receipt;
end;
$$;

grant execute on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  to authenticated;
