-- 0365_s2_fulfilment_fixes.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 0 S2 (fulfilment). Each finding was re-verified on main (faff59f2) and
-- reproduced locally before this was written; production holds no row any of
-- these changes would have treated differently (2026-09-24: 0 cross-warehouse
-- holdings, 0 duplicate order lines, 0 open orders without lines, 0 rental
-- holds on ordered items, and no cross-warehouse transfer by a non-admin in
-- 120 days).
--
--   1. approve_order_request: two lines for one item each passed the stock
--      check against the same free stock and together held more than exists.
--      It now compares the item's total, and refuses an order with no lines.
--   2. complete_picking: `order_request_id <> p_order_id` dropped every rental
--      hold (order_request_id NULL) from "reserved by others", so a one-click
--      pick could take units reserved for a rental that is out.
--   3. create_order_request: the header and lines in ONE transaction. The
--      service inserted them as two requests and "rolled back" a failed line
--      insert with a DELETE that RLS (0119) never allows, leaving an order with
--      no lines that notified managers and could be approved.
--   4. ledger.distribute_bundle / ledger.assemble_bundle: components are drawn
--      only from the warehouse the kit is built or handed out at (0101 dropped
--      0070's scope); kits pre-assembled in another warehouse are not used.
--   5. ledger.transfer_stock: below manager, both ends must be in warehouses
--      the caller may write.
--
-- Every body below is the live definition (pg_get_functiondef, local = prod
-- at 0364) with only the marked 0365 lines changed. Nothing here is weaker
-- than before, so the live web keeps working when this lands first; the web
-- deploy that calls create_order_request follows it.

set lock_timeout = '5s';

-- ── 1. approve_order_request ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_order_request(p_id uuid)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req public.order_requests%rowtype;
  v_line record;
  v_active_reserved numeric(14,4);
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  -- *** 0348 grant-aware approval gate — see the migration header. ***
  -- has_org_role is a pure ROLE-RANK lookup; it never reads
  -- user_permission_overrides / role_permission_overrides. has_permission is
  -- the only helper that does, so an admin who grants 'orders:approve' to
  -- staff in the matrix reaches this body. The has_org_role term is RETAINED
  -- so a manager with an explicit granted=false override keeps today's
  -- behaviour and no existing role test changes.
  if not (public.has_org_role(v_req.organization_id, 'manager')
          or public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;
  -- 0365: an order with nothing on it is never approved (none exists; a
  -- failed create used to leave one behind).
  if not exists (select 1 from public.order_request_lines where order_request_id = p_id) then
    raise exception 'order_has_no_lines' using errcode = 'P0001';
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand, ii.warehouse_id as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
    select coalesce(sum(quantity), 0) into v_active_reserved
    from public.stock_reservations
    where item_id = v_line.item_id and released_at is null;
    -- 0365: an order may carry several lines for one item. Every check ran
    -- before any hold was written, so each line passed against the same free
    -- stock and together they held more than exists. Compare the item's TOTAL
    -- on this order. (The loop stays per line: it holds the FOR UPDATE locks,
    -- which cannot be combined with GROUP BY; a repeated item repeats the check.)
    if (select sum(l2.quantity_requested) from public.order_request_lines l2
         where l2.order_request_id = p_id and l2.item_id = v_line.item_id) >
       greatest(0, v_line.quantity_on_hand - v_active_reserved) then
      raise exception 'insufficient_stock'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;
  end loop;

  insert into public.stock_reservations (
    organization_id, item_id, warehouse_id, order_request_id, quantity
  )
  select v_req.organization_id, l.item_id, v_req.warehouse_id, p_id, l.quantity_requested
  from public.order_request_lines l
  where l.order_request_id = p_id;

  update public.order_requests
    set status              = 'approved',
        approved_by         = v_user,
        approved_at         = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

revoke all on function public.approve_order_request(uuid) from public, anon;
grant execute on function public.approve_order_request(uuid) to authenticated, service_role;

-- ── 2. complete_picking ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_picking(p_order_id uuid)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  -- Ledger rows that are NOT this call's: everything that already matched the
  -- probe before the first draw, plus every row this call has since claimed.
  v_seen_ids       uuid[];
  v_item_ids       uuid[];
  -- The rows this call created, captured one at a time. Only these get stamped.
  v_mv_ids         uuid[] := '{}'::uuid[];
  v_new_ids        uuid[];
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
  -- the number zero-padded to AT LEAST six. greatest(6, length(...)) is what
  -- makes it padStart() and not truncation — `lpad(n, 6, '0')` would cut
  -- order 1,000,000 down to SO-100000, the label order 100,000 already owns,
  -- in a ledger that cannot be corrected afterwards. A null or non-positive
  -- number gets no label at all and falls back to the pre-0306 text, so the
  -- row stays traceable rather than being labelled 'SO-'.
  v_reason := case
    when coalesce(v_req.order_number, 0) > 0
      then 'Order pick (SO-'
           || lpad(v_req.order_number::text,
                   greatest(6, length(v_req.order_number::text)),
                   '0')
           || ')'
    else 'Order pick (order_request ' || p_order_id::text || ')'
  end;

  select bool_and(quantity_picked is null)
    into v_all_null
    from public.order_request_lines
    where order_request_id = p_order_id;
  v_all_null := coalesce(v_all_null, true);

  -- Every ledger row for this order's items that ALREADY answers to the probe
  -- below. None of them were written by this call — the transaction may have
  -- written a manual transfer for one of these items a statement ago, and it
  -- carries this same transaction timestamp — so they are remembered by id and
  -- excluded. The item ids are materialised into an array first because a
  -- `in (select …)` semi-join costs the planner the (organization_id,
  -- created_at) index and turns a bounded lookup into a seq scan of the whole
  -- ledger; with the array it is an index cond on org + this transaction's
  -- timestamp, which normally matches nothing at all.
  select coalesce(array_agg(item_id), '{}'::uuid[])
    into v_item_ids
    from public.order_request_lines
   where order_request_id = p_order_id;

  select coalesce(array_agg(m.id), '{}'::uuid[])
    into v_seen_ids
    from public.stock_movements m
   where m.organization_id = v_req.organization_id
     and m.created_at      = now()
     and m.item_id         = any(v_item_ids);

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
          -- 0365: IS DISTINCT FROM. A rental's hold has order_request_id
          -- NULL, and `NULL <> p_order_id` is NULL, so every rental hold fell
          -- out of this sum and a one-click pick could take units reserved
          -- for a rental that is out with a borrower.
          and order_request_id is distinct from p_order_id;
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

      -- Capture the ledger row that call just inserted, BY ID. Every column
      -- tested here is a property adjust_stock gives the row it writes (this
      -- item, this transaction's timestamp, 'transfer', auth.uid(), no
      -- reference yet), so the probe can never miss our own row; v_seen_ids is
      -- what turns it from "rows that look like mine" into "the row that was
      -- not there a moment ago".
      select coalesce(array_agg(m.id), '{}'::uuid[])
        into v_new_ids
        from public.stock_movements m
       where m.organization_id = v_req.organization_id
         and m.item_id         = v_line.item_id
         and m.created_at      = now()
         and m.movement_type   = 'transfer'
         and m.user_id         = v_user
         and m.reference_type is null
         and not (m.id = any(v_seen_ids));

      v_seen_ids := v_seen_ids || v_new_ids;
      -- Exactly one new row is the only outcome that identifies OUR row.
      -- Anything else leaves this line unstamped rather than guessing — see
      -- the header.
      if coalesce(array_length(v_new_ids, 1), 0) = 1 then
        v_mv_ids := v_mv_ids || v_new_ids;
      end if;
    end if;

    update public.order_request_lines
      set quantity_picked = v_batch
      where id = v_line.line_id;
  end loop;

  -- Stamp the machine link on exactly the rows captured above, BY ID — the one
  -- predicate that cannot reach a row this call did not write. An empty array
  -- (nothing drawn, or a probe that could not identify its row) matches
  -- nothing. See the header for why this is an UPDATE rather than an
  -- adjust_stock argument.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_order_id
   where id = any(v_mv_ids)
     and organization_id = v_req.organization_id;

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

revoke all on function public.complete_picking(uuid) from public, anon;
grant execute on function public.complete_picking(uuid) to authenticated, service_role;

-- ── 3. create_order_request ─────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: order_requests_insert and
-- order_request_lines_insert still decide who may create what, and the
-- guard, numbering and notification triggers run exactly as for the two
-- inserts it replaces. Any failure rolls back the header (and its
-- notification) with the lines. unit_cost_at_request is not taken from the
-- caller: tg_order_request_lines_guard snapshots it from the item (0363).

create or replace function public.create_order_request(p_header jsonb, p_lines jsonb)
returns public.order_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_req public.order_requests;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A request needs at least one line' using errcode = '22023';
  end if;

  insert into public.order_requests (
    organization_id, warehouse_id, requester_user_id, requester_name, requester_email,
    notes, needed_by, fulfillment_type, requester_phone, delivery_charter_id,
    pickup_location_notes, source, status
  ) values (
    (p_header->>'organization_id')::uuid,
    (p_header->>'warehouse_id')::uuid,
    (p_header->>'requester_user_id')::uuid,
    p_header->>'requester_name',
    p_header->>'requester_email',
    p_header->>'notes',
    (p_header->>'needed_by')::timestamptz,
    p_header->>'fulfillment_type',
    p_header->>'requester_phone',
    (p_header->>'delivery_charter_id')::uuid,
    p_header->>'pickup_location_notes',
    'internal',
    'pending_approval'
  )
  returning * into v_req;

  insert into public.order_request_lines (order_request_id, item_id, quantity_requested, notes)
  select v_req.id, (l->>'item_id')::uuid, (l->>'quantity')::numeric, l->>'notes'
    from jsonb_array_elements(p_lines) with ordinality as e(l, ord)
   order by e.ord;

  return v_req;
end;
$$;

comment on function public.create_order_request(jsonb, jsonb) is
  'An internal order request, header and lines in one transaction (0365). '
  'SECURITY INVOKER: the insert policies and triggers apply as for direct inserts.';

revoke all on function public.create_order_request(jsonb, jsonb) from public, anon;
grant execute on function public.create_order_request(jsonb, jsonb) to authenticated, service_role;

-- ── 4. bundles: components from this warehouse only ─────────────────────────
-- The ledger bodies are INVOKER and run under the public wrappers' flag
-- (0359); CREATE OR REPLACE keeps their grants.

CREATE OR REPLACE FUNCTION ledger.distribute_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_distribution_id uuid;
  v_phantom_qty numeric(14,4) := 0;
  v_phantom_wh uuid;
  v_use_phantom numeric(14,4) := 0;
  v_use_virtual numeric(14,4);
  v_shortage  boolean := false;
  v_user      uuid := auth.uid();
  v_component record;
  v_needed    numeric(14,4);
  v_have      numeric(14,4);
  v_draw      numeric(14,4);
  v_short     numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
  v_existing  public.idempotency_keys%rowtype;
  v_request_hash text;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:distribute`. The service layer's assertWarehouseAccess
  -- adds warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- *** 0347 idempotency — see header. Runs after the role/warehouse checks so
  -- a refused caller cannot probe keys, and before any stock write so the
  -- replay short-circuits with nothing touched. ***
  if p_idempotency_key is not null then
    v_request_hash := md5(
      p_bundle_id::text || '|' || p_quantity::text || '|' || p_warehouse_id::text
      || '|' || coalesce(p_allow_shortage, false)::text
      || '|' || coalesce(p_schedule_event_id::text, '')
    );
    select * into v_existing
      from public.idempotency_keys
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key
       for update;
    if found then
      if v_existing.request_hash = v_request_hash
         and v_existing.status = 'completed'
         and v_existing.resource_id is not null then
        return v_existing.resource_id;
      end if;
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
    insert into public.idempotency_keys
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (v_org, 'bundle_distribution', p_idempotency_key, v_request_hash, 'in_progress', 'bundle_distribution');
  end if;

  -- Phantom allocation
  if v_bundle.phantom_item_id is not null then
    select quantity_on_hand, warehouse_id into v_phantom_qty, v_phantom_wh
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    v_phantom_qty := greatest(0, coalesce(v_phantom_qty, 0));
    -- 0365: pre-assembled kits in another warehouse are not here. They are
    -- left alone and this distribution is built from this warehouse's
    -- components (assemble_bundle already refuses to build into another).
    if v_phantom_wh is not null and v_phantom_wh <> p_warehouse_id then
      v_phantom_qty := 0;
    end if;
  end if;

  v_use_phantom := least(p_quantity, v_phantom_qty);
  v_use_virtual := p_quantity - v_use_phantom;

  -- Drain phantom
  if v_use_phantom > 0 then
    v_prev := v_phantom_qty;
    v_new  := v_prev - v_use_phantom;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_bundle.phantom_item_id;
    -- Maintain levels: pre-assembled stock sat in Staging; drain it there first.
    perform public.apply_level_delta(v_bundle.phantom_item_id, v_new - v_prev, 'staging_first');

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_org, v_bundle.phantom_item_id, 'bundle_distribution', -v_use_phantom,
      v_prev, v_new, 'bundle_distribution', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end if;

  -- Component allocation for the virtual portion
  if v_use_virtual > 0 then
    for v_component in
      select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand,
             ii.warehouse_id as item_wh, ii.deleted_at
      from public.bundle_components bc
      join public.inventory_items ii on ii.id = bc.item_id
      where bc.bundle_id = p_bundle_id
      order by bc.item_id
      for update of ii
    loop
      v_needed := v_component.quantity * v_use_virtual;
      -- 0365: only this warehouse's stock (or a component with no warehouse)
      -- is drawn, and never a deleted item. 0101 dropped 0070's scope, so a
      -- distribution drained the component from whichever building held it
      -- while the preview reported a shortage.
      v_have   := case when v_component.deleted_at is null
                        and coalesce(v_component.item_wh, p_warehouse_id) = p_warehouse_id
                       then greatest(0, v_component.quantity_on_hand) else 0 end;
      v_draw   := least(v_needed, v_have);
      v_short  := v_needed - v_draw;

      if v_draw > 0 then
        v_prev := v_component.quantity_on_hand;
        v_new  := v_prev - v_draw;
        update public.inventory_items
          set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
          where id = v_component.item_id;
        -- Maintain levels: virtual-portion consumption draws from placed stock.
        perform public.apply_level_delta(v_component.item_id, v_new - v_prev, 'placed');

        insert into public.stock_movements (
          organization_id, item_id, movement_type, quantity_change,
          previous_quantity, new_quantity, reason, reference_type,
          reference_id, user_id, notes
        ) values (
          v_org, v_component.item_id, 'bundle_distribution', -v_draw,
          v_prev, v_new, 'bundle_distribution', 'bundle',
          p_bundle_id, v_user, p_notes
        );
      end if;

      if v_short > 0 then
        if not p_allow_shortage and not v_component.is_optional then
          raise exception 'insufficient_stock' using detail = v_component.item_id::text;
        end if;
        if not v_component.is_optional then
          v_shortage := true;
          insert into public.stock_movements (
            organization_id, item_id, movement_type, quantity_change,
            previous_quantity, new_quantity, reason, reference_type,
            reference_id, user_id, notes
          ) values (
            v_org, v_component.item_id, 'bundle_shortage', 0,
            v_component.quantity_on_hand, v_component.quantity_on_hand,
            'no_stock', 'bundle', p_bundle_id, v_user,
            'short ' || v_short::text || ' units during bundle distribution'
          );
        end if;
      end if;
    end loop;
  end if;

  insert into public.bundle_distributions (
    organization_id, bundle_id, warehouse_id, quantity,
    schedule_event_id, notes, shortage_recorded, distributed_by
  ) values (
    v_org, p_bundle_id, p_warehouse_id, p_quantity,
    p_schedule_event_id, p_notes, v_shortage, v_user
  )
  returning id into v_distribution_id;

  if p_idempotency_key is not null then
    update public.idempotency_keys
       set status = 'completed', resource_id = v_distribution_id, updated_at = now()
     where organization_id = v_org
       and scope = 'bundle_distribution'
       and key = p_idempotency_key;
  end if;

  return v_distribution_id;
end;
$function$;

CREATE OR REPLACE FUNCTION ledger.assemble_bundle(p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(phantom_item_id uuid, phantom_qty numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_bundle    public.bundles%rowtype;
  v_org       uuid;
  v_phantom   public.inventory_items%rowtype;
  v_user      uuid := auth.uid();
  v_phantom_sku text;
  v_component record;
  v_needed    numeric(14,4);
  v_prev      numeric(14,4);
  v_new       numeric(14,4);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;

  select * into v_bundle
  from public.bundles where id = p_bundle_id for update;
  if not found then raise exception 'bundle_not_found' using errcode = 'P0002'; end if;
  if not v_bundle.is_active or v_bundle.archived_at is not null then
    raise exception 'bundle_not_active' using errcode = 'P0001';
  end if;
  if not v_bundle.preassembly_enabled then
    raise exception 'preassembly_disabled' using errcode = 'P0001';
  end if;
  v_org := v_bundle.organization_id;

  -- C9: tightened from 'staff' to 'manager' to match service gate
  -- `bundles:manage`. The service layer's assertWarehouseAccess adds
  -- warehouse-scope; this assert is the org-role floor.
  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Verify warehouse belongs to org
  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and organization_id = v_org
  ) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;

  -- Lock or create phantom
  if v_bundle.phantom_item_id is not null then
    select * into v_phantom
    from public.inventory_items
    where id = v_bundle.phantom_item_id for update;
    if v_phantom.warehouse_id is not null and v_phantom.warehouse_id <> p_warehouse_id then
      raise exception 'phantom_warehouse_mismatch' using errcode = 'P0001';
    end if;
  else
    -- SKU is internal, never user-facing. Truncated UUID guarantees
    -- uniqueness without colliding with any real SKU pattern.
    v_phantom_sku := '__BUNDLE__' || substr(p_bundle_id::text, 1, 8);
    insert into public.inventory_items (
      organization_id, sku, name, description, status,
      quantity_on_hand, warehouse_id, is_bundle,
      created_by, updated_by
    ) values (
      v_org, v_phantom_sku, v_bundle.name,
      'Pre-assembled bundle stock for ' || v_bundle.name,
      'active', 0, p_warehouse_id, true, v_user, v_user
    )
    returning * into v_phantom;

    update public.bundles
      set phantom_item_id = v_phantom.id, updated_at = now()
      where id = p_bundle_id;
  end if;

  -- Decrement components in deterministic order to avoid deadlocks
  -- between concurrent assemble/distribute calls.
  for v_component in
    select bc.item_id, bc.quantity, bc.is_optional, ii.quantity_on_hand, ii.id as ii_id,
           ii.warehouse_id as item_wh, ii.deleted_at
    from public.bundle_components bc
    join public.inventory_items ii on ii.id = bc.item_id
    where bc.bundle_id = p_bundle_id
    order by bc.item_id
    for update of ii
  loop
    v_needed := v_component.quantity * p_quantity;
    -- 0365: a kit built here uses this warehouse's components (or ones with
    -- no warehouse), never a deleted item's.
    if v_component.deleted_at is not null
       or coalesce(v_component.item_wh, p_warehouse_id) <> p_warehouse_id
       or v_component.quantity_on_hand < v_needed then
      if not v_component.is_optional then
        raise exception 'insufficient_stock' using detail = v_component.item_id::text;
      else
        continue;
      end if;
    end if;

    v_prev := v_component.quantity_on_hand;
    v_new  := v_prev - v_needed;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_component.item_id;
    -- Maintain levels: consume from placed locations (rack/area/crate).
    -- Raises insufficient_placed_stock if component stock is only in Staging.
    perform public.apply_level_delta(v_component.item_id, v_new - v_prev, 'placed');

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, reason, reference_type,
      reference_id, user_id, notes
    ) values (
      v_org, v_component.item_id, 'bundle_assembly', -v_needed,
      v_prev, v_new, 'bundle_assembly', 'bundle',
      p_bundle_id, v_user, p_notes
    );
  end loop;

  -- Increment phantom
  v_prev := v_phantom.quantity_on_hand;
  v_new  := v_prev + p_quantity;
  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_phantom.id;
  -- Maintain levels: assembled kit lands in Staging.
  perform public.apply_level_delta(v_phantom.id, v_new - v_prev, 'staging');

  insert into public.stock_movements (
    organization_id, item_id, movement_type, quantity_change,
    previous_quantity, new_quantity, reason, reference_type,
    reference_id, user_id, notes
  ) values (
    v_org, v_phantom.id, 'bundle_assembly', p_quantity,
    v_prev, v_new, 'bundle_assembly', 'bundle',
    p_bundle_id, v_user, p_notes
  );

  return query select v_phantom.id, v_new;
end;
$function$;

-- ── 5. transfer_stock: both ends inside the caller's warehouses ─────────────

CREATE OR REPLACE FUNCTION ledger.transfer_stock(p_item_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_notes text DEFAULT NULL::text)
 RETURNS inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item public.inventory_items%rowtype;
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

  -- 0365: below manager, both ends must be in warehouses the caller may write
  -- (the transfer dialog only offers those). A member scoped to warehouse A
  -- could otherwise move stock into or out of warehouse B through the RPC.
  if not public.has_org_role(v_item.organization_id, 'manager') and exists (
       select 1 from public.locations l
        where l.id in (p_from_location_id, p_to_location_id)
          and l.warehouse_id is not null
          and not public.user_can_access_warehouse(auth.uid(), l.warehouse_id, 'write')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Ensure a source row exists (kept from 0191/0201: a touched (item, location)
  -- pair always has a level row; harmless when the guard below refuses,
  -- because the raise aborts the transaction).
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_from_location_id, 0)
  on conflict (item_id, location_id) do nothing;

  -- *** 0327: the guard is IN the draw's predicate. 0231 decremented first and
  -- inspected the RETURNING value second, so the negative existed transiently
  -- and a row CHECK would fire at the UPDATE, turning the intended P0001
  -- 'insufficient_stock' into a raw 23514 check_violation. The conditional
  -- UPDATE never writes a negative: a miss falls through to the same raise
  -- the old post-write check performed. ***
  update public.item_stock_levels
    set quantity = quantity - p_quantity, updated_at = now()
  where item_id = p_item_id and location_id = p_from_location_id
    and quantity >= p_quantity;

  if not found then
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
$function$;

reset lock_timeout;
