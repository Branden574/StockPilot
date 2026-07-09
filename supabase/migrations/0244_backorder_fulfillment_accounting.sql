-- Backorder accounting — the hand-over fork + shipped/staged split.
--
-- Phase 1 behavioral core of the 2026-07-09 partial-fulfillment spec. Three
-- hardened RPCs change together because they share one accounting model:
--
--   quantity_fulfilled = units PROVIDED to the customer (shipped at hand-over,
--                        cumulative across batches). Was previously written at
--                        complete_picking; now it is written ONLY at hand-over.
--   quantity_picked    = the CURRENT staged batch — hardened off the shelf but
--                        still in the building until hand-over. Restockable on
--                        a pre-hand-over cancel.
--
-- This is the owner's mental model ("only a partial quantity was PROVIDED") and
-- it is the only split that keeps cancel-restock correct across the resume loop
-- without a new column: cancel restocks the staged batch (quantity_picked),
-- never the shipped total (quantity_fulfilled).
--
--   1. complete_picking  — harden the staged batch, clamp to still-owed, write
--                          quantity_picked only (NOT quantity_fulfilled).
--   2. confirm_order_signature — ship the staged batch into quantity_fulfilled,
--                          reset quantity_picked, then fork on owed:
--                          owed > 0 → backordered, else → completed.
--   3. cancel_order_request — restock the STAGED batch (quantity_picked); for a
--                          backordered order there is no staged batch, so it
--                          restocks nothing (shipped goods left the building).
--
-- Returns are unaffected: returns.ts only reads quantity_fulfilled for
-- completed/delivered orders, where fulfilled has always equalled shipped.

-- ---------------------------------------------------------------------------
-- Reconcile in-flight pre-hand-over orders to the new model.
-- Old complete_picking wrote quantity_fulfilled = quantity_picked at pick time.
-- Under the new model those units are STAGED, not shipped, so their shipped
-- total must be 0 until they hand over (quantity_picked already holds the batch).
-- ---------------------------------------------------------------------------
update public.order_request_lines l
   set quantity_fulfilled = 0
  from public.order_requests o
 where l.order_request_id = o.id
   and o.status in ('picking_complete', 'packing_slip_generated',
                    'staged_for_pickup', 'staged_for_delivery', 'in_transit')
   and l.quantity_fulfilled > 0;

-- ---------------------------------------------------------------------------
-- 1. complete_picking — stage the batch (quantity_picked), clamp to owed,
--    never touch quantity_fulfilled. Mirrors the current body (auth, warehouse,
--    picker-lock, status, one-click-all-null path, adjust_stock hardening,
--    reservation release) with the accounting change only.
-- ---------------------------------------------------------------------------
create or replace function public.complete_picking(p_order_id uuid)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req       public.order_requests%rowtype;
  v_line      record;
  v_user      uuid := auth.uid();
  v_all_null  boolean;
  v_owed      numeric(14,4);
  v_batch     numeric(14,4);
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
  -- Picker lock: a non-manager may not complete an order claimed by ANOTHER user.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and v_req.assigned_picker_id is not null
     and v_req.assigned_picker_id <> v_user then
    raise exception 'not_assigned_picker' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- All lines un-keyed → the manager one-click path: stage all remaining owed.
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
           l.quantity_fulfilled  as fulfilled
    from public.order_request_lines l
    where l.order_request_id = p_order_id
    order by l.item_id
  loop
    -- Never stage more than the order still owes on this line.
    v_owed := greatest(coalesce(v_line.requested, 0) - coalesce(v_line.fulfilled, 0), 0);
    if v_all_null then
      v_batch := v_owed;
    else
      v_batch := least(coalesce(v_line.picked, 0), v_owed);
    end if;

    if v_batch > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_batch,
        'transfer',
        null,
        'Order pick (order_request ' || p_order_id::text || ')',
        null
      );
    end if;

    -- Record the staged batch; quantity_fulfilled is written only at hand-over.
    update public.order_request_lines
      set quantity_picked = v_batch
      where id = v_line.line_id;
  end loop;

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

-- ---------------------------------------------------------------------------
-- 2. confirm_order_signature — the hand-over fork. Ship the staged batch, then
--    branch on owed. Guarded lock first so an invalid/expired/replayed
--    signature ships nothing and is a no-op (returns null), exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_order_signature(
  p_id uuid,
  p_signature_token text,
  p_signer_name text,
  p_signer_email text,
  p_signature_data_url text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org        uuid;
  v_owed       numeric(14,4);
  v_new_status text;
begin
  if p_id is null
     or coalesce(length(p_signature_token), 0) = 0
     or coalesce(length(trim(p_signer_name)), 0) = 0
     or coalesce(length(trim(p_signer_email)), 0) = 0
     or coalesce(length(p_signature_data_url), 0) = 0
  then
    return null;
  end if;

  -- Validate + lock in one step. Same guards as the prior single-UPDATE: right
  -- token, not already signed, a hand-over status, not expired. No match → no-op.
  select organization_id
    into v_org
    from public.order_requests
    where id = p_id
      and signature_token = p_signature_token
      and signed_at is null
      and status in ('staged_for_pickup', 'in_transit')
      and (signature_token_expires_at is null or signature_token_expires_at > now())
    for update;

  if v_org is null then
    return null;
  end if;

  -- Ship the staged batch: the customer takes quantity_picked now.
  update public.order_request_lines
    set quantity_fulfilled = coalesce(quantity_fulfilled, 0) + coalesce(quantity_picked, 0),
        quantity_picked    = null
    where order_request_id = p_id;

  -- Owed after this hand-over decides the fork.
  select coalesce(sum(greatest(coalesce(quantity_requested, 0) - coalesce(quantity_fulfilled, 0), 0)), 0)
    into v_owed
    from public.order_request_lines
    where order_request_id = p_id;

  v_new_status := case when v_owed > 0 then 'backordered' else 'completed' end;

  update public.order_requests
     set status              = v_new_status,
         signed_by_name      = p_signer_name,
         signed_by_email     = p_signer_email,
         signature_data_url  = p_signature_data_url,
         signed_at           = now(),
         completed_at        = case when v_new_status = 'completed' then now() else null end,
         completed_by        = null
   where id = p_id;

  return v_org;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. cancel_order_request — restock the STAGED batch only. A backordered order
--    has already handed its shipped goods to the customer (quantity_picked is
--    null there), so it restocks nothing and preserves quantity_fulfilled as
--    the record of what was provided. Mirrors the current body's auth/role,
--    reservation release, and clear-or-replace denied_reason.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_order_request(p_id uuid, p_reason text default null::text)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
  v_line record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status in ('completed', 'denied', 'cancelled') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  v_is_manager := public.has_org_role(v_req.organization_id, 'manager');
  v_is_owner   := v_req.requester_user_id = v_user;
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Restock the CURRENT staged batch (quantity_picked) — units complete_picking
  -- pulled off the shelf that are still in the building. quantity_fulfilled
  -- (already handed to the customer across prior batches) is NEVER restocked and
  -- is preserved as the record of what was provided. A backordered order has
  -- quantity_picked = null on every line, so this loop no-ops for it — the
  -- backorder-aware branch the spec calls for, expressed by the column split.
  for v_line in
    select l.id as line_id, l.item_id, l.quantity_picked
    from public.order_request_lines l
    where l.order_request_id = p_id
      and coalesce(l.quantity_picked, 0) > 0
    order by l.item_id
  loop
    perform public.adjust_stock(
      v_line.item_id,
      v_line.quantity_picked,
      'return',
      null,
      'Order cancelled (order_request ' || p_id::text || ')',
      null
    );
    -- Clear the staged batch so the restock can never be replayed.
    update public.order_request_lines
      set quantity_picked = null
      where id = v_line.line_id;
  end loop;

  update public.stock_reservations
    set released_at = now(), released_reason = 'cancelled'
    where order_request_id = p_id and released_at is null;

  -- I1 from 0077: clear-or-replace. NEVER preserve a prior denied_reason when a
  -- later cancel arrives without its own reason — the prior text is leaked via
  -- the public track endpoint otherwise.
  update public.order_requests
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_user,
        denied_reason = p_reason
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;
