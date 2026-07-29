-- 0306: pick movements name the ORDER, not the row's uuid.
--
-- THE DEFECT. Every order pick since migration 0111 has written
--
--     Order pick (order_request b3c7390a-b114-4839-a100-a008d3f3fde0)
--
-- into stock_movements.reason. The uuid resolves correctly — that one is
-- SO-000060 — but it is the machine's identifier, not the operator's, and it
-- is sitting in the field a human reads. The reason it looks like this is
-- chronological: order_requests.order_number only arrived in migration 0254,
-- four years of migrations after 0111 wrote this string, so at the time there
-- was nothing else to point at.
--
-- WHAT CHANGES, AND ONLY THIS:
--   1. The reason now reads `Order pick (SO-000060)`, zero-padded to six to
--      match formatOrderNumber() in packages/core/src/orders/order-number.ts
--      so a movement note, the orders list and the mobile order screen cannot
--      disagree about how an order is spelled. order_number is NOT NULL since
--      0254, but a null/non-positive value still falls back to the ORIGINAL
--      text rather than emitting a broken `Order pick (SO-)`.
--   2. The machine link moves into the columns built for it:
--      reference_type='order_request', reference_id=p_order_id. Those columns
--      are what every other RPC that references a record already writes (see
--      0153/0197 returns, 0040 bundles, 0079 cycle counts), and what the
--      web/mobile activity feeds already read to render a clickable source.
--      Pick movements were the outlier that stuffed the link into prose.
--
-- WHAT DOES NOT CHANGE. This function carries the picking claim-lock (0237 /
-- 0238) and the backorder fulfillment accounting (0244 / 0247). The body below
-- was diffed against pg_get_functiondef() of the live function before editing;
-- every guard, the one-click availability clamp, the reservation release and
-- the status/stamp update are byte-identical to 0247. The only edits are the
-- reason string, the variable that holds it, and the reference stamp.
--
-- WHY THE STAMP IS A SEPARATE UPDATE. adjust_stock() is the shared writer for
-- every stock change in the schema and it has no reference parameters. Gaining
-- them would mean DROPping and recreating the hottest function in the database
-- (Postgres cannot add parameters via CREATE OR REPLACE — it would create a
-- second overload and make every existing 6-argument call ambiguous), which is
-- far more blast radius than this defect is worth. So the rows adjust_stock
-- just inserted are stamped here instead. `created_at = now()` is the
-- transaction timestamp and is the column's own DEFAULT, so the predicate
-- matches only rows THIS transaction wrote; combined with the org, the pick's
-- movement_type, the acting user, the still-unstamped filter and this order's
-- own item set, nothing else can be caught by it. The loop above additionally
-- holds `for update of ii` on every item involved, so no concurrent writer can
-- interleave a movement for those items inside this transaction at all.
--
-- HISTORY IS NOT REWRITTEN. The ~99 rows already carrying the uuid form are
-- left exactly as they are: stock_movements is an append-only ledger and the
-- Movements page tells the user so. Those rows are resolved at DISPLAY time
-- instead — packages/core/src/inventory/movement-order-ref.ts parses the id
-- out of the legacy reason and the surfaces batch-resolve it to SO-000060.

-- ---------------------------------------------------------------------------
-- complete_picking — human order number in the reason, machine link in the
-- reference columns. Everything else verbatim from 0247.
-- ---------------------------------------------------------------------------
create or replace function public.complete_picking(p_order_id uuid)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req            public.order_requests%rowtype;
  v_line           record;
  v_user           uuid := auth.uid();
  v_all_null       boolean;
  v_owed           numeric(14,4);
  v_batch          numeric(14,4);
  v_other_reserved numeric(14,4);
  v_available      numeric(14,4);
  v_reason         text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager')
     and v_req.assigned_picker_id is not null
     and v_req.assigned_picker_id <> v_user then
    raise exception 'not_assigned_picker' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- The words a human reads. Mirrors formatOrderNumber() exactly: 'SO-' plus
  -- the number left-padded with zeros to six, and no label at all for a null
  -- or non-positive number — which falls back to the pre-0306 text so the row
  -- is still traceable rather than labelled 'SO-'.
  v_reason := case
    when coalesce(v_req.order_number, 0) > 0
      then 'Order pick (SO-' || lpad(v_req.order_number::text, 6, '0') || ')'
    else 'Order pick (order_request ' || p_order_id::text || ')'
  end;

  select bool_and(quantity_picked is null)
    into v_all_null
    from public.order_request_lines
    where order_request_id = p_order_id;
  v_all_null := coalesce(v_all_null, true);

  for v_line in
    select l.id                  as line_id,
           l.item_id             as item_id,
           l.quantity_picked     as picked,
           l.quantity_requested  as requested,
           l.quantity_fulfilled  as fulfilled,
           ii.quantity_on_hand   as on_hand
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_order_id
    order by l.item_id
    for update of ii
  loop
    v_owed := greatest(coalesce(v_line.requested, 0) - coalesce(v_line.fulfilled, 0), 0);

    if v_all_null then
      -- One-click: stage what's actually available so a short order backorders
      -- the remainder instead of crashing adjust_stock. available = on_hand net
      -- of OTHER orders' active holds (this order's own reservation is its to
      -- draw). Explicit per-line picks (else branch) trust the keyed qty.
      select coalesce(sum(quantity), 0) into v_other_reserved
        from public.stock_reservations
        where item_id = v_line.item_id
          and released_at is null
          and order_request_id <> p_order_id;
      v_available := greatest(0, coalesce(v_line.on_hand, 0) - v_other_reserved);
      v_batch := least(v_owed, v_available);
    else
      v_batch := least(coalesce(v_line.picked, 0), v_owed);
    end if;

    if v_batch > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_batch,
        'transfer',
        null,
        v_reason,
        null
      );
    end if;

    update public.order_request_lines
      set quantity_picked = v_batch
      where id = v_line.line_id;
  end loop;

  -- Stamp the machine link on the movement rows adjust_stock just wrote. See
  -- the header for why this is an UPDATE rather than an adjust_stock argument,
  -- and why the predicate can only match this transaction's own pick draws.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_order_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'transfer'
     and user_id         = v_user
     and reference_type is null
     and item_id in (
       select item_id from public.order_request_lines where order_request_id = p_order_id
     );

  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user,
        assigned_picker_id   = coalesce(assigned_picker_id, v_user)
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;
