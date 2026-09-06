-- 0348_orders_approve_grant_and_push_token_rebind.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Two independent defects, both "the DB gate does not match what the app
-- promises". Grouped in one migration because each is a small, self-contained
-- `create or replace` and they share no objects.
--
-- ═══ PART 1 — the order RPCs now honour an explicit 'orders:approve' grant ═══
--
-- WHAT WAS WRONG. packages/core/src/constants/permissions.ts lists
-- 'orders:approve' in FULLY_GRANTABLE_PERMISSIONS, under the comment "Write
-- paths whose RLS has been migrated to has_permission() … Granting any of
-- these to a role/user is fully effective end-to-end." Only the RLS was
-- migrated: 0212 rewrote order_requests_insert/update to
-- `has_org_role(...,'manager') or has_permission(...,'orders:approve')`. The
-- SECURITY DEFINER RPCs the same feature calls were never touched and still
-- gate on ROLE RANK alone:
--
--   approve_order_request (0121), approve_partial (0246), close_partial (0245),
--   resume_fulfillment (0291), reopen_picking (0289), assign_picking (0239),
--   cancel_order_request (0290)
--
-- all do `if not public.has_org_role(v_req.organization_id, 'manager') then
-- raise exception 'forbidden'`. has_org_role (latest 0310) is a pure rank
-- lookup over organization_members.role; it NEVER consults
-- user_permission_overrides / role_permission_overrides. has_permission (0310)
-- is the only helper that does.
--
-- THE FAILURE. An admin grants staff 'orders:approve' in the role matrix. The
-- matrix shows no "Grant rolling out" warning (that badge is suppressed for
-- anything in FULLY_GRANTABLE_PERMISSIONS), and the order detail page shows
-- the Approve button because `can(ctx,'orders:approve')` is true. Deny works
-- (plain UPDATE, allowed by the 0212 RLS). Approve, Approve partial, Resume,
-- Close partial, Reopen picking, Assign picker and Cancel-someone-else's-order
-- all raise 'forbidden', surfaced as "Only managers can approve requests".
-- A half-working permission with a misleading 403 — recurring pattern #4, the
-- app gate looser than the DB gate.
--
-- THE FIX. Each of the seven gates becomes
--   has_org_role(org,'manager') OR has_permission(org,'orders:approve')
-- The has_org_role term is RETAINED deliberately: a manager who carries an
-- explicit granted=false override for 'orders:approve' keeps today's access,
-- so no existing 0245/0246/0289/0290 role test changes meaning. Only users an
-- admin explicitly granted the permission are added.
--
-- WHY THE WHOLE BODIES ARE RE-STATED. Postgres has no "patch a function body".
-- Every body below was taken VERBATIM from `pg_get_functiondef` on a database
-- at migration head 0347 (2026-09-05) and only the gate lines were edited —
-- the discipline pattern #24 demands, so that re-stating cannot silently
-- revert 0290's restock classification, 0291's stamp clearing or 0289's
-- Unplaced-bucket resolution. search_path headers are preserved per function
-- (reopen_picking and cancel_order_request run with 'public','extensions').
--
-- The staff-floor picking RPCs (partial_pick_line, complete_picking,
-- claim_picking, release_picking) are deliberately NOT touched: their floor is
-- already below manager and 'orders:approve' has no bearing on them.
--
-- ═══ PART 2 — a shared device can rebind its push token to the new user ═════
--
-- WHAT WAS WRONG. POST /api/v1/push/register did
-- `ctx.supabase.from('push_tokens').upsert({...}, { onConflict: 'token' })` on
-- the USER-authed client. push_tokens carries exactly one policy —
-- push_tokens_self (0003_rls.sql:243) `for all to authenticated using (user_id
-- = auth.uid()) with check (user_id = auth.uid())` — and Postgres evaluates
-- ON CONFLICT DO UPDATE against the EXISTING row's UPDATE USING expression. If
-- that row belongs to somebody else the statement ERRORS (42501, "new row
-- violates row-level security policy (USING expression)"); it is not skipped.
-- Reproduced on local Postgres in a rolled-back transaction, 2026-09-05.
--
-- THE FAILURE. Shared warehouse iPad. User A signs in; Expo token T is stored
-- with user_id = A. A signs out — nothing deletes T (the mobile hook never
-- calls the DELETE half of this route). User B signs in on the same device:
-- the upsert hits ON CONFLICT → UPDATE of A's row → RLS refuses → the route
-- answers 500 (the mobile hook just console.warns). T stays bound to A, and
-- the dispatch trigger selects tokens BY user_id with a 120-day window
-- (0028/0313), so for up to four months every push meant for A — order
-- approvals, maintenance notes, low-stock alerts carrying item names — lands
-- on the device B is now holding, while B receives none.
--
-- THE FIX. `register_push_token`, a SECURITY DEFINER RPC that authorizes
-- itself on auth.uid() (0331/0341/0346 gate shape: a null uid is the
-- service/postgres path and is REFUSED here, because there is no service
-- caller — every registration is a signed-in device speaking for itself),
-- drops any binding of that token to a DIFFERENT user, then writes the
-- caller's own row. An Expo token is device-and-install bound and is already
-- the trust anchor for delivery, so "whoever holds the device and is signed in
-- owns the token" is the intended semantics.
--
-- push_tokens RLS is UNCHANGED — push_tokens_self still refuses any direct
-- cross-user write, so this RPC is the single audited rebind path. 0310 left
-- push_tokens_self out of the disabled-account freeze on purpose (registering
-- your own device changes nothing anyone else can see) and 0313 stops the
-- dispatch for disabled users at the trigger, so no disabled_at check is added
-- here — it would change nothing and would fork that decision in two places.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1. Order RPCs: manager-by-role OR an explicit 'orders:approve' grant.
-- Bodies verbatim from pg_get_functiondef at head 0347; only the gate changed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── approve_order_request(uuid) ──
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
    if v_line.quantity_requested >
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

-- ── approve_partial(uuid) ──
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
  if not (public.has_org_role(v_req.organization_id, 'manager')
          or public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
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

-- ── close_partial(uuid) ──
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
  if not (public.has_org_role(v_req.organization_id, 'manager')
          or public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
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

-- ── resume_fulfillment(uuid) ──
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
  if not (public.has_org_role(v_req.organization_id, 'manager')
          or public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
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

-- ── reopen_picking(uuid,text) ──
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
  if not (public.has_org_role(v_req.organization_id, 'manager')
          or public.has_permission(v_req.organization_id, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501';
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

-- ── assign_picking(uuid,uuid) ──
CREATE OR REPLACE FUNCTION public.assign_picking(p_order_id uuid, p_user_id uuid)
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

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  -- Only a manager+ — or a member explicitly granted 'orders:approve'
  -- (0348) — with warehouse write may assign/reassign a picker.
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
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', detail = v_req.status;
  end if;
  -- The target must be an accepted member of the same org…
  if not exists (
    select 1 from public.organization_members
    where organization_id = v_req.organization_id
      and user_id = p_user_id
      and accepted_at is not null
  ) then
    raise exception 'invalid_picker' using errcode = 'P0001';
  end if;
  -- …AND must have write access to the order's warehouse, so we never lock an
  -- order to a picker the pick RPCs would then reject (bricking it for everyone).
  if not public.user_can_access_inventory(p_user_id, v_req.warehouse_id, null, 'write') then
    raise exception 'invalid_picker' using errcode = 'P0001';
  end if;

  update public.order_requests
    set assigned_picker_id = p_user_id,
        picking_claimed_at = now(),
        picking_claimed_by = v_user
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;

-- ── cancel_order_request(uuid,text) ──
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
  v_is_manager := public.has_org_role(v_req.organization_id, 'manager')
                  or public.has_permission(v_req.organization_id, 'orders:approve');
  v_is_owner   := v_req.requester_user_id = v_user;
  if not v_is_manager and not v_is_owner then
    raise exception 'forbidden' using errcode = '42501';
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

-- Re-state the EXECUTE posture for all seven. `create or replace` preserves the
-- existing ACL, so this is belt-and-braces: it pins the posture in the
-- migration that last rewrote the bodies, the way 0329 and 0346 do, and keeps
-- anon out even if a future replace is authored from a bare definition.
revoke all on function public.approve_order_request(uuid)      from public, anon;
revoke all on function public.approve_partial(uuid)            from public, anon;
revoke all on function public.close_partial(uuid)              from public, anon;
revoke all on function public.resume_fulfillment(uuid)         from public, anon;
revoke all on function public.reopen_picking(uuid, text)       from public, anon;
revoke all on function public.assign_picking(uuid, uuid)       from public, anon;
revoke all on function public.cancel_order_request(uuid, text) from public, anon;

grant execute on function public.approve_order_request(uuid)      to authenticated, service_role;
grant execute on function public.approve_partial(uuid)            to authenticated, service_role;
grant execute on function public.close_partial(uuid)              to authenticated, service_role;
grant execute on function public.resume_fulfillment(uuid)         to authenticated, service_role;
grant execute on function public.reopen_picking(uuid, text)       to authenticated, service_role;
grant execute on function public.assign_picking(uuid, uuid)       to authenticated, service_role;
grant execute on function public.cancel_order_request(uuid, text) to authenticated, service_role;

comment on function public.approve_order_request(uuid) is
  'Approve a pending order request. Authorized for a manager+ by role OR for anyone holding an explicit ''orders:approve'' grant (0348) — the app has advertised that permission as fully grantable since 0212.';


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2. register_push_token — the only path that may rebind a device token.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.register_push_token(
  p_token     text,
  p_platform  text,
  p_device_id text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
begin
  -- *** 0348 authorization gate — see the header. ***
  -- Unlike 0331/0341/0346 there is NO service caller for this helper: every
  -- registration is a signed-in device registering ITSELF. A null uid would
  -- mean a token bound to nobody, so it is refused rather than waved through.
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_token is null or length(btrim(p_token)) < 20 then
    raise exception 'invalid_push_token' using errcode = 'P0001';
  end if;
  -- Mirrors the push_tokens platform CHECK so a bad value is a named error
  -- rather than a constraint-violation 500 out of the route.
  if p_platform is null or p_platform not in ('ios', 'android', 'web') then
    raise exception 'invalid_platform' using errcode = 'P0001';
  end if;

  -- THE REBIND. This is the statement RLS made impossible from the route: an
  -- Expo token is per device+install, so a row holding it for ANOTHER user is
  -- a stale binding left by whoever used this device last, never a concurrent
  -- registration. Dropping it is what stops their pushes from following the
  -- hardware to its next holder.
  delete from public.push_tokens
   where token = p_token
     and user_id is distinct from v_user;

  insert into public.push_tokens (user_id, token, platform, device_id, last_used_at)
  values (v_user, p_token, p_platform, p_device_id, now())
  on conflict (token) do update
    set platform     = excluded.platform,
        device_id    = excluded.device_id,
        last_used_at = excluded.last_used_at;
end;
$function$;

revoke all on function public.register_push_token(text, text, text) from public, anon;
grant execute on function public.register_push_token(text, text, text) to authenticated, service_role;

comment on function public.register_push_token(text, text, text) is
  'Bind an Expo push token to the calling user, rebinding it away from a previous owner of the same physical device (0348). Self-authorizing on auth.uid(); push_tokens_self RLS is unchanged, so this is the only path that may rebind.';
