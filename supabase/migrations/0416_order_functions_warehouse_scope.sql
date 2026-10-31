-- 0405_order_functions_warehouse_scope.sql
--
-- Security slice E (docket item S2; stockpilot-work/six/followups.md, SECURITY
-- SLICE E): the order functions that decided an approver's action on
-- orders:approve alone now also ask write access to the order's warehouse,
-- the rule the order update policy applies (0395 L129a) and the app checks
-- first (OrderRequestsService.requireWarehouseAccess 'write').
--
-- Until now a staff member granted orders:approve and assigned to warehouse A
-- could approve, approve partially, cancel, resume or close an order of
-- warehouse B by calling the function directly (PostgREST /rpc, which never
-- passes through the app's check), and reopen one with nothing picked (with
-- units picked, ledger.adjust_stock's location check, 0365, refused the
-- reopen with a bare forbidden). A viewer granted orders:approve could do the
-- same in any warehouse. 0395 closed only the table path (a raw PATCH of
-- order_requests now matches no row). claim_picking,
-- complete_picking, partial_pick_line, release_picking, assign_picking,
-- assign_order_delivery, mark_order_in_transit, generate_order_packing_slips,
-- revise_order_needed_by and hold_order_stock already ask it.
--
--   1. approve_order_request, approve_partial, close_partial,
--      resume_fulfillment and reopen_picking: right after the orders:approve
--      gate, 42501 forbidden (hint warehouse_write) unless
--      user_can_access_warehouse(auth.uid(), the order's warehouse, 'write').
--   2. cancel_order_request: the same term on the approver's path only.
--      Cancelling your own order while it waits for approval is the
--      requester's cancel and asks no warehouse, also for a requester who
--      approves orders (the service's rule). It is decided on the order row
--      the function locks, which closes the race in followups.md (RACE, low):
--      an approver's own order that moved from pending approval to approved
--      between the service's read (which skipped the warehouse check for a
--      pending order of their own) and this call is an approver's cancel here,
--      and is refused outside their warehouses.
--   3. cancel_order_request: an order with no requester account
--      (requester_user_id null: placed through a public link, or the
--      requester's account was deleted, 0388) is nobody's own order. The gate
--      read v_is_owner := requester_user_id = auth.uid(), which is NULL for
--      such an order, and an IF treats NULL as false, so "neither an approver
--      nor the person who placed it" never refused: any signed-in caller, of
--      any organization, who knew the order's id could cancel it while it was
--      pending approval (0395's requester window refused every other status).
--      Found while restating the body; pgTAP C3 and M7 prove it on the
--      unchanged body.
--
-- The term is user_can_access_warehouse(..., 'write') (0310's body), the
-- policy's: true for an owner, admin or manager of the warehouse's
-- organization with no assignment needed, for staff only on an assigned
-- warehouse (the 0280 all-warehouses flag keeps an assignment row per
-- warehouse), never for a viewer, never for a disabled account or an invite
-- not yet accepted. user_can_access_inventory(..., null, 'write'), which the
-- other order functions ask, answers the same for every role the membership
-- check allows (owner, admin, manager, staff, viewer), and so does the app
-- (assertWarehouseAccess 'write'). A viewer granted orders:approve was
-- already refused every one of these actions by the app and the table path;
-- the functions now refuse them too.
--
-- Each body is copied verbatim from its latest definition (named above it),
-- whose md5(prosrc) equals production's (read-only schema dump, 2026-10-24),
-- with the added blocks tagged "Slice E", never with this file's number, so
-- every md5 pin survives a push-time renumber. pgTAP R1-R6 prove that
-- removing the added text gives production's body exactly. Signatures,
-- SECURITY DEFINER, SET clauses, volatility, owner and grants are unchanged
-- (CREATE OR REPLACE keeps the owner and the grants; each header restates
-- production's attributes; P1 pins them). The comments of the three that had
-- one are restated with the new rule; approve_partial, close_partial and
-- resume_fulfillment get their first.
--
-- WHO CHANGES TODAY (not re-read for this file; the PR's release steps carry
-- the read-only queries to re-run before the push): production 2026-10-05
-- (followups.md) had 1 staff member granted orders:approve, 0 open orders
-- outside that member's warehouses and 0 past out-of-scope cancels; the
-- 2026-10-24 docket still counts 1 warehouse-scoped approver. The app already
-- refuses every one of these actions to them, so only a raw call changes.
-- Item 3 changes nothing for anyone the app lets cancel: an approver of the
-- organization still cancels such an order (within their warehouses), and
-- the app never offered its cancel to anyone else.
--
-- LOCKS. No table lock is held to commit, and a call already running
-- finishes on the body it started with. One table lock is taken briefly:
-- checking a body compiles it (check_function_bodies, on by default), each
-- body declares public.order_requests%rowtype, and the first compile in a
-- session loads that row type's description with an AccessShareLock on
-- public.order_requests, released at once (the session keeps the
-- description, so the five bodies after it take none). AccessShareLock
-- conflicts only with ACCESS EXCLUSIVE, so no read, write, row lock or
-- autovacuum waits for it or holds it up. Only an ACCESS EXCLUSIVE on
-- order_requests that is held or queued (an ALTER TABLE, VACUUM FULL,
-- another migration) makes the file wait; lock_timeout 900ms then ends it
-- with 55P03 and nothing applied, and the push can be run again once that
-- statement has finished. COMMENT holds a ShareUpdateExclusiveLock on each
-- of the six functions to commit (only other DDL on the same function waits
-- for it). scripts/db-concurrency/0405_migration_lock_footprint.sh checks
-- each of these (5-8 for the order_requests lock).
--
-- DATA SAFETY: no row changes. The file restates six bodies and their
-- comments.
--
-- ERRORS: the new refusal is 42501 forbidden with hint warehouse_write and
-- detail "This order is in a warehouse you don't work in, so you can't change
-- it. Ask a manager." (core ORDER_WAREHOUSE_WRITE_REFUSED_COPY, the sentence
-- the app says); everything else is as before. Never 40001 or 40P01
-- (PostgREST retries those forever).

set lock_timeout = '900ms';

-- approve_order_request: restated from 0390_approval_follows_permission.sql; md5(prosrc) 7883f466ae2642cbb4664ebc473e571b -> 0fb614dd15db280a97641ae0ac2673b0.
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
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
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

-- approve_partial: restated from 0390_approval_follows_permission.sql; md5(prosrc) 40ca0878733b08a649773fe9b7efd4e0 -> 897c53295f88b0bac7dcc03edd07211f.
CREATE OR REPLACE FUNCTION public.approve_partial(p_id uuid)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req             public.order_requests%rowtype;
  v_line            record;
  v_active_reserved numeric(14,4);
  v_available       numeric(14,4);
  v_reserve         numeric(14,4);
  v_user            uuid := auth.uid();
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
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
  -- 0365: as approve_order_request, an order with no lines is never approved.
  if not exists (select 1 from public.order_request_lines where order_request_id = p_id) then
    raise exception 'order_has_no_lines' using errcode = 'P0001';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
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

    -- Reserve only what's actually available; the rest becomes backorder.
    v_available := greatest(0, v_line.quantity_on_hand - v_active_reserved);
    v_reserve   := least(v_line.quantity_requested, v_available);
    if v_reserve > 0 then
      insert into public.stock_reservations
        (organization_id, item_id, warehouse_id, order_request_id, quantity)
        values (v_req.organization_id, v_line.item_id, v_req.warehouse_id, p_id, v_reserve);
    end if;
  end loop;

  update public.order_requests
    set status      = 'approved',
        approved_by = v_user,
        approved_at = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

-- close_partial: restated from 0390_approval_follows_permission.sql; md5(prosrc) a519c3e58fb577c3ff1b30fb3a6cc0ad -> 44852737eedc1959e887b8621925d157.
CREATE OR REPLACE FUNCTION public.close_partial(p_id uuid)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req  public.order_requests%rowtype;
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
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
  if v_req.status <> 'backordered' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Release any hold on the un-shipped remainder. No stock moves — the shipped
  -- goods already left and quantity_fulfilled stays as the record of what was
  -- provided.
  update public.stock_reservations
    set released_at = now(), released_reason = 'closed_partial'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status       = 'completed',
        completed_at = now(),
        completed_by = v_user
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

-- resume_fulfillment: restated from 0390_approval_follows_permission.sql; md5(prosrc) 2e2d5aab1db5392250879bfa9ff4bccd -> ce593a9203c41c1a7311b1af27d4cbd3.
CREATE OR REPLACE FUNCTION public.resume_fulfillment(p_id uuid)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_req             public.order_requests%rowtype;
  v_user            uuid := auth.uid();
  v_line            record;
  v_active_reserved numeric(14,4);
  v_available       numeric(14,4);
  v_reserve         numeric(14,4);
  v_total_reserved  numeric(14,4) := 0;
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
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
  if v_req.status <> 'backordered' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, ii.warehouse_id as item_warehouse,
           greatest(coalesce(l.quantity_requested, 0) - coalesce(l.quantity_fulfilled, 0), 0) as owed
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    -- Same warehouse guard the approve paths enforce: an item moved to another
    -- warehouse while backordered can't be fulfilled from this order's warehouse.
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;

    -- Fresh pick cycle for the next batch.
    update public.order_request_lines set quantity_picked = null where id = v_line.line_id;

    if v_line.owed > 0 then
      select coalesce(sum(quantity), 0) into v_active_reserved
        from public.stock_reservations
        where item_id = v_line.item_id and released_at is null;
      select quantity_on_hand into v_available
        from public.inventory_items where id = v_line.item_id;
      v_available := greatest(0, coalesce(v_available, 0) - v_active_reserved);
      v_reserve := least(v_line.owed, v_available);
      if v_reserve > 0 then
        insert into public.stock_reservations
          (organization_id, item_id, warehouse_id, order_request_id, quantity)
          values (v_req.organization_id, v_line.item_id, v_req.warehouse_id, p_id, v_reserve);
        v_total_reserved := v_total_reserved + v_reserve;
      end if;
    end if;
  end loop;

  if v_total_reserved <= 0 then
    raise exception 'no_fulfillable_stock' using errcode = 'P0001';
  end if;

  -- Re-open the signature cycle AND release the picker claim so the resumed
  -- batch is a fresh, unassigned pick anyone eligible can take. Also clear the
  -- PREVIOUS cycle's completion stamps: this order has nothing picked yet, so
  -- carrying forward "picking completed at <old timestamp>" from the
  -- superseded cycle is stale data, not history.
  update public.order_requests
    set status                     = 'pick_slip_generated',
        pick_slip_generated_at     = now(),
        pick_slip_generated_by     = v_user,
        assigned_picker_id         = null,
        signed_at                  = null,
        signature_token            = null,
        signature_token_expires_at = null,
        signed_by_name             = null,
        signed_by_email            = null,
        signature_data_url         = null,
        completed_at               = null,
        completed_by               = null,
        picking_completed_at       = null,
        picking_completed_by       = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

-- reopen_picking: restated from 0395_order_stock_guards.sql; md5(prosrc) 14e49293fa670dc2e05a1c1b6930bce5 -> b62fbb68ee0d0eb44a9e641921a757e5.
CREATE OR REPLACE FUNCTION public.reopen_picking(p_id uuid, p_reason text)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_line record;
  v_loc  uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reopen_reason_required' using errcode = 'P0001';
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
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
  -- signed_at is the ONLY correct is-signed predicate (physical signatures
  -- leave signature_data_url NULL). Defence in depth: these statuses are
  -- pre-signature already, but never let a signed order rewind.
  if v_req.signed_at is not null then
    raise exception 'already_signed' using errcode = 'P0001';
  end if;
  if v_req.status not in ('picking_complete', 'packing_slip_generated') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Reverse complete_picking's per-line stock draw. quantity_picked holds the
  -- exact drawn amount (complete_picking sets quantity_picked = v_batch after
  -- adjust_stock(-v_batch)). This writes a visible +movement, the inverse of
  -- the "Order pick" movement.
  --
  -- The units land in the item's Unplaced bucket, NOT the null-location default
  -- (see note (a) at the top): Staging is invisible to the 'placed' draw-down
  -- complete_picking uses, so a Staging reversal makes the order unfinishable.
  for v_line in
    select l.id                as line_id,
           l.item_id           as item_id,
           coalesce(l.quantity_picked, 0) as picked,
           ii.organization_id  as item_org,
           ii.warehouse_id     as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
  loop
    if v_line.picked > 0 then
      v_loc := null;
      if v_line.item_warehouse is not null then
        perform public.ensure_warehouse_placement_locations(v_line.item_warehouse);
        select id into v_loc from public.locations
          where warehouse_id = v_line.item_warehouse
            and kind = 'unplaced'
            and deleted_at is null
          limit 1;
      end if;
      if v_loc is null then
        perform public.ensure_org_placement_locations(v_line.item_org);
        select id into v_loc from public.locations
          where organization_id = v_line.item_org
            and warehouse_id is null
            and kind = 'unplaced'
            and deleted_at is null
          limit 1;
      end if;

      -- Both lookups failed to resolve an Unplaced bucket: refuse instead of
      -- falling through to adjust_stock's null-location default, which would
      -- silently land the reversal in Staging (see note (a) at the top) — the
      -- exact unfinishable-order failure mode this migration exists to prevent.
      if v_loc is null then
        raise exception 'unplaced_location_not_found'
          using errcode = 'P0002', detail = v_line.item_id::text;
      end if;

      perform public.adjust_stock(
        v_line.item_id,
        v_line.picked,
        'transfer',
        v_loc,
        'Reopen picking (order_request ' || p_id::text || ')',
        null
      );
    end if;
  end loop;

  -- S2 (L115): link the movements this call just wrote back to the order,
  -- as cancel_order_request and complete_picking link theirs: this
  -- organization, this transaction's time, a 'transfer' by this caller with
  -- no reference yet, and the reason that names this order. An order leaves
  -- picking_complete once per transaction, so nothing else matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'transfer'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Reopen picking (order_request ' || p_id::text || ')';

  -- Restore the reservations complete_picking released for THIS picking cycle.
  -- Scoped by picking_completed_at (see note (b) at the top) so a previously
  -- superseded generation of holds — left behind by a backorder resume — is not
  -- resurrected on top of the current one.
  update public.stock_reservations
    set released_at = null
    where order_request_id = p_id
      and released_at is not null
      and (v_req.picking_completed_at is null
           or released_at >= v_req.picking_completed_at);

  -- Rewind to picking_in_progress; preserve quantity_picked + assigned_picker_id;
  -- clear the packing-slip / signature-token cycle (voids the packing slip when
  -- reopening from packing_slip_generated; no-op columns are already NULL when
  -- reopening from picking_complete).
  update public.order_requests
    set status                     = 'picking_in_progress',
        picking_completed_at       = null,
        picking_completed_by       = null,
        packing_slip_generated_at  = null,
        packing_slip_generated_by  = null,
        signature_token            = null,
        signature_token_expires_at = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

-- cancel_order_request: restated from 0395_order_stock_guards.sql; md5(prosrc) 535fc49935f15adc8d7dfa78836a06af -> 2f230491b82b32b37f81c3ddbb8caf8e.
CREATE OR REPLACE FUNCTION public.cancel_order_request(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS order_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_req public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_is_manager boolean;
  v_is_owner boolean;
  v_line record;
  v_stock_drawn boolean;
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

  -- *** 0348 grant-aware approval gate — see the migration header. The name
  -- stays v_is_manager (it feeds the manager-or-requester rule below); it now
  -- means "may act on someone else's order", which an explicit
  -- 'orders:approve' grant also confers. ***
  v_is_manager := public.has_permission(v_req.organization_id, 'orders:approve');
  v_is_owner   := v_req.requester_user_id = v_user;
  -- Slice E: an order with no requester account (placed through a public
  -- link, or its requester's account was deleted) is nobody's own order.
  -- The comparison above is NULL for it, and an IF treats NULL as false,
  -- so the rule below refused no one: any signed-in caller could cancel
  -- such an order while it waited for approval.
  v_is_owner := coalesce(v_is_owner, false);
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- S2 (N1): the person who placed the order cancels it only while it is
  -- pending approval. After that only someone who approves orders cancels
  -- it: an approved order holds stock, a picked one has drawn it and an
  -- order in transit is on the truck. The web service already refused this
  -- before calling here; now every caller gets the same answer.
  if not v_is_manager and v_req.status <> 'pending_approval' then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'requester_pending_only',
            detail  = 'Only a pending order can be cancelled by the person who placed it.';
  end if;

  -- Slice E: an approver's cancel asks write access to the order's
  -- warehouse, as every other approver action does (the order update
  -- policy, 0395; the app asks it first). Cancelling your own order while
  -- it waits for approval is the requester's cancel and asks no warehouse.
  -- Decided on the row locked above: an order that moved on from pending
  -- approval after the caller last read it is an approver's cancel here.
  if v_is_manager
     and not (v_is_owner and v_req.status = 'pending_approval')
     and not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;

  -- Are this order's quantity_picked units currently OUT of quantity_on_hand?
  -- See the status table at the top of this migration.
  --
  -- EXHAUSTIVE BY CONSTRUCTION. Every value of order_requests_status_check is
  -- classified explicitly and an unrecognised one RAISES — see the note on
  -- asymmetric failure at the top of this migration.
  case v_req.status
    -- DRAWN. complete_picking is the only writer of 'picking_complete' and it
    -- calls adjust_stock(-batch) in the same transaction; nothing between there
    -- and the signature touches quantity_picked or stock.
    when 'picking_complete', 'packing_slip_generated', 'staged_for_pickup',
         'staged_for_delivery', 'in_transit' then
      v_stock_drawn := true;

    -- NOT DRAWN. pending_confirmation / pending_approval / approved /
    -- pick_slip_generated carry no batch yet, so the loop no-ops regardless.
    -- picking_in_progress is the exclusion that matters: partial_pick_line
    -- never drew, and reopen_picking already gave its draw back. backordered
    -- had quantity_picked nulled at hand-over.
    when 'pending_confirmation', 'pending_approval', 'approved',
         'pick_slip_generated', 'picking_in_progress', 'backordered' then
      v_stock_drawn := false;

    -- completed / denied / cancelled never reach here — the
    -- invalid_status_transition refusal above rejects them first — so this
    -- branch fires only for a status that did not exist when this was written.
    else
      raise exception 'unclassified_order_status_for_restock'
        using errcode = 'P0001',
              detail  = v_req.status,
              hint    = 'order_requests has a status that cancel_order_request '
                        'does not classify. Decide whether an order in this '
                        'status has its quantity_picked units OUT of '
                        'quantity_on_hand, then add it to the drawn or the '
                        'not-drawn branch of the case in cancel_order_request '
                        '(latest definition: supabase/migrations/'
                        '0290_cancel_restock_guard.sql) and cover it in '
                        'supabase/tests/0290_cancel_restock_guard.test.sql. Do '
                        'not let it fall through to the not-drawn branch '
                        'without checking: skipping a restock that was owed '
                        'destroys stock with no stock_movements row.';
  end case;

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
    if v_stock_drawn then
      perform public.adjust_stock(
        v_line.item_id,
        v_line.quantity_picked,
        'return',
        null,
        'Order cancelled (order_request ' || p_id::text || ')',
        null
      );
    end if;
    -- Clear the staged batch so the restock can never be replayed. Runs in BOTH
    -- branches: a cancelled order never carries a live staged batch.
    update public.order_request_lines
      set quantity_picked = null
      where id = v_line.line_id;
  end loop;

  -- S2 (L115): link the restock movements this call just wrote to the
  -- order, as complete_picking links its own. adjust_stock takes no
  -- reference, so the rows are found by what only these restocks share:
  -- this organization, this transaction's time, a 'return' by this caller
  -- with no reference yet, and the reason that names this order. An order
  -- is cancelled once, so nothing else in the transaction matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'return'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Order cancelled (order_request ' || p_id::text || ')';

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

-- ═══ The comments: what each function now enforces ═══

comment on function public.approve_order_request(uuid) is
  'Approve a pending order request. Authorized for anyone whose effective ''orders:approve'' permission is true (has_permission: the owner always; admin and manager by role default; an explicit user or role override wins either way). 0390 removed the manager-by-role term 0348 kept, so a revoked manager is refused here too. Since slice E (0405): only with write access to the order''s warehouse (user_can_access_warehouse write: an owner, admin or manager of the organization, staff assigned to the warehouse, never a viewer), else 42501 forbidden, hint warehouse_write.';

comment on function public.approve_partial(uuid) is
  'Approve a pending order that is knowingly short: holds what is free per line (in item order) and approves; the rest backorders at hand-over. Refuses an order with no lines (order_has_no_lines) or not pending approval (invalid_status_transition). Authorized for the effective ''orders:approve'' permission (0390) with write access to the order''s warehouse (slice E, 0405: user_can_access_warehouse write, else 42501 forbidden, hint warehouse_write).';

comment on function public.close_partial(uuid) is
  'Close a backordered order as delivered-partial (status completed): releases the holds on the unshipped remainder, moves no stock, keeps quantity_fulfilled as the record of what was provided. Authorized for the effective ''orders:approve'' permission (0390) with write access to the order''s warehouse (slice E, 0405: user_can_access_warehouse write, else 42501 forbidden, hint warehouse_write).';

comment on function public.resume_fulfillment(uuid) is
  'Resume a backordered order: holds newly free stock up to what each line still owes and reopens the pick and signature cycle (status pick_slip_generated, picker released); refuses when nothing is free (no_fulfillable_stock). Authorized for the effective ''orders:approve'' permission (0390) with write access to the order''s warehouse (slice E, 0405: user_can_access_warehouse write, else 42501 forbidden, hint warehouse_write).';

comment on function public.reopen_picking(uuid, text) is
  'Manager override: rewind a picked/packed (pre-signature) order to picking_in_progress to fix a miscount. Reverses complete_picking''s stock draw (adjust_stock +quantity_picked into the item''s Unplaced bucket, so the units stay drawable by the re-pick), restores the reservations released by this picking cycle, preserves quantity_picked + assigned_picker_id, clears packing-slip/token fields. Refuses when signed_at is set. Reason required. Since 0395 its movements carry reference_type order_request and the order id. Since slice E (0405): only with write access to the order''s warehouse (user_can_access_warehouse write), else 42501 forbidden, hint warehouse_write.';

comment on function public.cancel_order_request(uuid, text) is
  'Cancel an order request. Restocks the current staged batch (quantity_picked) ONLY when the order status says those units are actually out of quantity_on_hand: picking_complete, packing_slip_generated, staged_for_pickup, staged_for_delivery, in_transit. A mid-pick (picking_in_progress) order has not drawn yet, and a reopen_picking order has already had its draw returned — restocking either would invent stock. quantity_picked is cleared either way; quantity_fulfilled is never restocked. The status classification is exhaustive over order_requests_status_check: an unrecognised status raises unclassified_order_status_for_restock rather than defaulting to skip-the-restock, because a skipped restock destroys stock silently while a refused cancel is retryable. Since 0395: the person who placed the order may cancel it only while it is pending approval (42501 forbidden, hint requester_pending_only); someone with orders:approve cancels it at any open status; the restock movements carry reference_type order_request and the order id. Since slice E (0405): an approver''s cancel asks write access to the order''s warehouse (42501 forbidden, hint warehouse_write); cancelling your own order while it is pending approval asks none; an order with no requester account (public link, deleted account) is nobody''s own order, so only an approver cancels it.';

reset lock_timeout;
