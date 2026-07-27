-- 0296_post_receipt_v2_serial_optional.sql
--
-- SIXTH full-body rewrite of post_receipt_v2 (after 0013, 0015, 0069, 0190,
-- 0231, 0285). Every prior rewrite re-asserted the same rule: a serial item
-- must supply exactly qty_accepted serials. That rule is UNCHANGED here.
--
-- PROVENANCE: the body below was produced mechanically from the LIVE function
-- body dumped with pg_get_functiondef() after `supabase db reset` on the full
-- migration chain. That dump was byte-identical (6464 chars) to 0285's body,
-- so no drift had accumulated. Exactly two hunks were then applied; the diff
-- is recorded in .superpowers/sdd/sports-task-3-report.md.
--
-- THE ONLY BEHAVIOURAL DELTA: a new 'serial_optional' branch that accepts
-- between 0 and qty_accepted serials and persists whichever were supplied.
-- Concretely:
--   * v_tracking = 'none'            -> unchanged (no capture)
--   * v_tracking = 'lot'             -> unchanged (lots required, must sum)
--   * v_tracking = 'serial'          -> unchanged (exact count, serials_required)
--   * v_tracking = 'serial_optional' -> NEW: null/absent is fine; if supplied,
--                                       the count must not EXCEED qty_accepted
--                                       (serial_count_exceeds_quantity), and
--                                       the rows land in serial_registry.
--
-- Why "must not exceed" rather than "must equal": mixed unit-level + quantity
-- receipts must not double-count (requirements, Serial rules). N serials
-- against N accepted units is a fully-tagged receipt; k < N is a partially
-- tagged one; k > N would claim more units than arrived.
--
-- HUNK 2 NOTE (behaviour-preserving for 'serial'): the serial-persist guard
-- gains `and v_line.serials is not null`. For tracking_type='serial' that
-- predicate is already implied -- the validation block above raises
-- serials_required whenever qty_accepted > 0 and serials is null, so the loop
-- was never reachable with a null array. The added conjunct therefore changes
-- nothing for 'serial' and only makes the shared branch safe for
-- 'serial_optional', where a null array is legitimate.
--
-- The over-receipt allowance from 0285 is preserved verbatim (no guard).
-- The grant made in 0013/0190/0231 survives create-or-replace, exactly as it
-- did through 0285; the pgTAP file asserts it.

create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_notes text default null::text
)
returns receipts
language plpgsql
set search_path to 'public', 'extensions'
as $function$
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
    -- Quantity sanity: per-line quantities must be non-negative. Over-receipt
    -- (accepted + already-received > ordered) is ALLOWED (owner decision
    -- 2026-07-21) — vendors over-ship; the receipt Notes record why.
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

    -- (over-receive guard removed 2026-07-21 — see migration header)

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
    elsif v_tracking = 'serial_optional' then
      -- NEW (0296). Serials are WELCOME, never required. A null/absent array
      -- and an empty array are both a legitimate pure-quantity receipt -- this
      -- is the branch that makes fake placeholder serials unnecessary.
      -- The only failure is claiming MORE tagged units than actually arrived,
      -- which would double-count against the quantity posted below.
      if v_line.qty_accepted > 0 and v_line.serials is not null then
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count > v_line.qty_accepted::int then
          raise exception 'serial_count_exceeds_quantity' using errcode = '23514';
        end if;
      end if;
    end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id,
        v_line.qty_accepted,
        'receive_po',
        v_staging,       -- route accepted qty into the warehouse Staging location
        'PO ' || coalesce(v_po.po_number, 'receipt'),
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

    -- Serial persistence. 'serial' is unchanged (its validation block already
    -- guarantees a non-null array whenever qty_accepted > 0). 'serial_optional'
    -- joins it, guarded on a non-null array so the common no-serials case does
    -- no work.
    if v_tracking in ('serial', 'serial_optional')
       and v_line.qty_accepted > 0
       and v_line.serials is not null then
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
$function$;
