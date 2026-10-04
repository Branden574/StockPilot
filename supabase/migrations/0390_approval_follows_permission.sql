-- 0390_approval_follows_permission.sql
--
-- Security slice D (sec-orders plan section 5): approving an order, and
-- everything else the approve permission allows, follows the permission.
--
-- Until now the database decided these with
--   has_org_role(org, 'manager') OR has_permission(org, 'orders:approve').
-- 0348 kept the role term on purpose, so a manager whose orders:approve an
-- admin had revoked still approved, cancelled other people's orders, held
-- stock, reopened, resumed and closed orders, assigned pickers, changed
-- needed-by dates, saw other pending demand, created orders on someone's
-- behalf, added lines to other people's orders and wrote the order row
-- through the user client. The web app refused them; the database did not.
-- After 0390 has_permission decides alone: the owner always passes, admin and
-- manager pass by role default, and an explicit user or role override wins
-- either way (the app's effectivePermissions precedence).
--
-- 1. Two writers shared order_requests_update with the approve rule, so they
--    move to SECURITY DEFINER functions with their own gates first, and the
--    policy can become approve-only without breaking them:
--      assign_order_delivery(p_id, p_driver): orders:assign_delivery AND
--        orders:approve, write access to the order's warehouse, status
--        staged_for_delivery, and a driver who is an accepted member of the
--        order's organization. Both permissions, because that is what
--        assigning took before 0390 once the role term is gone: the app asked
--        orders:assign_delivery and the update policy asked a manager or
--        orders:approve. Without orders:approve here, a member holding only
--        orders:assign_delivery (whom the policy refused) would gain the
--        action, and a manager whose orders:approve was revoked could make
--        themself the driver and then hand the order over as the driver.
--      mark_order_in_transit(p_id): write access, a delivery order, status
--        staged_for_delivery read under the row lock (compare-and-set), a
--        driver assigned, and orders:approve. Owner decision O3, default:
--        an assigned staff driver without orders:approve is refused, which is
--        what the database already did (production 2026-10-03: no order has
--        ever had a staff driver; all 47 in-transit marks were by managers
--        or above).
--    Both lock only the order row (FOR NO KEY UPDATE, the lock their UPDATE
--    takes anyway), run with lock_timeout 5s (55P03, which PostgREST does not
--    retry) and raise only 42501, P0001 and P0002: never 40001 or 40P01.
--
-- 2. The ten approval functions: exactly one mechanical edit each. The role
--    term `public.has_org_role(<x>, 'manager')<newline, indent>or ` is
--    removed, so `public.has_permission(<x>, 'orders:approve')` remains, with
--    <x> v_req.organization_id or v_org. Each is restated verbatim from its
--    latest definition (named above it), whose md5(prosrc) equals
--    production's; nothing else in a body changes. Six bodies still carry
--    the 0348 comment that says the role term is RETAINED: that sentence now
--    describes the rule this migration replaced, and is left so the body
--    stays byte-identical apart from the gate (pgTAP R1-R10 prove it: put the
--    role term back and each body is production's pre-0390 one exactly).
--    Signature, SECURITY DEFINER, SET clauses, volatility, owner and grants
--    are unchanged: each header restates production's SET clauses and
--    volatility, and CREATE OR REPLACE keeps the owner, grants and comment.
--
-- 3. Three function comments that stated the old rule are corrected
--    (approve_order_request, hold_order_stock, revise_order_needed_by).
--
-- 4. The three policies, each with the role term removed and every other
--    term kept as 0212 and 0363 wrote them: order_requests_update (USING and
--    WITH CHECK), order_requests_insert (the on-behalf branch) and
--    order_request_lines_insert (lines on another member's order).
--
-- WHO CHANGES TODAY: nobody loses anything. Production 2026-10-03: 0 managers
-- with orders:approve revoked, 0 role overrides on any orders permission, and
-- 0 members who hold orders:assign_delivery without orders:approve. The one
-- staff member granted orders:approve keeps what the database already let
-- them do.
--
-- WHAT STILL GOES BY ROLE (unchanged here, on purpose): finishing or
-- releasing picking that someone else claimed (complete_picking,
-- partial_pick_line, release_picking: a manager by role overrides the
-- picker), recording a paper signature (confirm_physical_signature: a
-- manager by role or the assigned driver), order attachments, and the
-- shortfall purchase-order drafter (a manager by role with
-- purchase_orders:manage). A manager whose orders:approve is revoked keeps
-- those.
--
-- LOCKS. The functions, grants and comments take no table lock. ALTER POLICY
-- takes ACCESS EXCLUSIVE on its table, held until the file commits, and no
-- order of the two tables is safe by itself: partial_pick_line locks a line
-- and then its order, while cancel_order_request and confirm_order_signature
-- lock the order and then its lines. A file that held one table and waited
-- for the other could close a cycle with either, and Postgres would end one
-- side with 40P01, which could be a person's cancel or signature. On this
-- platform ALTER POLICY run by postgres also takes ACCESS EXCLUSIVE on the
-- 23 auth, storage and realtime tables in supautils.policy_grants (supautils
-- 3.4.0; see the prelude in part 4), so a wait there could close a cycle with
-- a sign-in or an account deletion. So before the first ALTER POLICY the file
-- takes every table lock the three statements need in one prelude, all
-- NOWAIT: it never waits for a table lock, so it is never part of a wait
-- cycle. If any session holds one of those tables at that instant (a short
-- request, or Realtime's poll of realtime.subscription), that attempt fails
-- at once with 55P03; its subtransaction rolls back, which releases every
-- lock the attempt took, and the prelude tries again after a short pause
-- holding no table lock, up to 40 attempts (about 2 to 6 seconds in all).
-- Only if every attempt meets a busy table does the file fail with 55P03,
-- apply nothing, and need a re-run (the 0373 pattern). The locks are held
-- from the successful attempt to commit, a few milliseconds, during which
-- sign-ins, storage and realtime requests and order reads wait. The
-- policies are altered lines first (the order that also avoids the
-- partial_pick_line cycle by itself). lock_timeout 900ms, below
-- deadlock_timeout (1s), bounds any other wait the file could meet.
-- Push off-peak.
--
-- ERRORS: 42501, P0001, P0002 and 55P03 only. No function here raises 40001
-- or 40P01 (PostgREST retries those forever).

set lock_timeout = '900ms';

-- ═══ 1. The two delivery writers, as SECURITY DEFINER functions ═══════════

create or replace function public.assign_order_delivery(p_id uuid, p_driver uuid)
returns public.order_requests
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_row public.order_requests%rowtype;
begin
  -- Gate 1: a signed-in caller.
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gate 2: the order exists and the caller is an accepted, enabled member of
  -- its org. One answer for both, so a foreign order looks missing. Read
  -- without a lock: a caller who may not assign never queues on the row.
  select o.organization_id into v_org
    from public.order_requests o
   where o.id = p_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 3: the Orders module.
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- Gate 4: the permission the app checks for this action.
  if not public.has_permission(v_org, 'orders:assign_delivery') then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_assign_delivery';
  end if;

  -- Gate 5: orders:approve, which the update policy asked of every
  -- assignment before 0390 (with the role term gone). A member holding only
  -- orders:assign_delivery stays refused, and a manager whose orders:approve
  -- was revoked cannot make themself the driver.
  if not public.has_permission(v_org, 'orders:approve') then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_approve';
  end if;

  -- The order row, locked: two assignments serialize and the last one wins.
  select * into v_row
    from public.order_requests o
   where o.id = p_id
     for no key update;
  if not found or v_row.organization_id is distinct from v_org then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 6: write access to the order's warehouse.
  if not public.user_can_access_inventory(v_uid, v_row.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  if v_row.status <> 'staged_for_delivery' then
    raise exception 'delivery_not_assignable'
      using errcode = 'P0001', hint = 'not_staged_for_delivery', detail = v_row.status;
  end if;

  -- The driver: an accepted member of the order's organization (the rule
  -- OrderRequestsService.assignDelivery checks before it calls this).
  if p_driver is null or not exists (
       select 1
         from public.organization_members m
        where m.organization_id = v_org
          and m.user_id = p_driver
          and m.accepted_at is not null) then
    raise exception 'driver_not_member' using errcode = 'P0001', hint = 'driver_not_member';
  end if;

  update public.order_requests
     set assigned_delivery_user_id = p_driver,
         assigned_delivery_by      = v_uid,
         assigned_delivery_at      = now()
   where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.mark_order_in_transit(p_id uuid)
returns public.order_requests
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_row public.order_requests%rowtype;
begin
  -- Gate 1: a signed-in caller.
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gate 2: the order exists and the caller is an accepted, enabled member of
  -- its org. One answer for both. Read without a lock.
  select o.organization_id into v_org
    from public.order_requests o
   where o.id = p_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 3: the Orders module.
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- The order row, locked, so the status check below and the update read the
  -- same row: a second mark, a phone retry or a cancel that got in first is
  -- refused, never written twice (SP-069).
  select * into v_row
    from public.order_requests o
   where o.id = p_id
     for no key update;
  if not found or v_row.organization_id is distinct from v_org then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 4: write access to the order's warehouse.
  if not public.user_can_access_inventory(v_uid, v_row.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  if v_row.fulfillment_type <> 'delivery' then
    raise exception 'not_a_delivery' using errcode = 'P0001', hint = 'not_a_delivery';
  end if;
  if v_row.status <> 'staged_for_delivery' then
    raise exception 'order_status_changed'
      using errcode = 'P0001', hint = 'status_changed', detail = v_row.status;
  end if;
  if v_row.assigned_delivery_user_id is null then
    raise exception 'no_driver' using errcode = 'P0001', hint = 'no_driver';
  end if;

  -- Gate 5, owner decision O3 (default): orders:approve, which is the rule
  -- the database already applied (the update policy) once the role term is
  -- gone. An assigned staff driver without it is refused. On the owner's yes
  -- to O3 the driver passes too:
  --   if v_row.assigned_delivery_user_id is distinct from v_uid
  --      and not public.has_permission(v_org, 'orders:approve') then
  if not public.has_permission(v_org, 'orders:approve') then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_approve';
  end if;

  update public.order_requests
     set status        = 'in_transit',
         in_transit_at = now(),
         in_transit_by = v_uid
   where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.assign_order_delivery(uuid, uuid) from public, anon, service_role;
revoke all on function public.mark_order_in_transit(uuid) from public, anon, service_role;
grant execute on function public.assign_order_delivery(uuid, uuid) to authenticated;
grant execute on function public.mark_order_in_transit(uuid) to authenticated;

comment on function public.assign_order_delivery(uuid, uuid) is
  'Slice D (0390): assigns the delivery driver of a staged-for-delivery order '
  '(assigned_delivery_user_id, _by = the caller, _at = now()) and returns the '
  'row. Gates in its body: signed in (42501), member of the order''s org (P0002 '
  'order_request_not_found, the same for a missing order), the orders module '
  '(P0001 module_disabled), orders:assign_delivery (42501, hint '
  'orders_assign_delivery), orders:approve (42501, hint orders_approve: what '
  'the update policy asked before 0390), write access to the order''s warehouse (42501, hint '
  'warehouse_write), status staged_for_delivery (P0001 delivery_not_assignable, '
  'hint not_staged_for_delivery, detail = the status), and a driver who is an '
  'accepted member of the order''s org (P0001 driver_not_member). Locks the '
  'order row (FOR NO KEY UPDATE); two calls serialize and the last one wins. '
  'Never raises 40001/40P01. SECURITY DEFINER, lock_timeout 5s, EXECUTE to '
  'authenticated only.';

comment on function public.mark_order_in_transit(uuid) is
  'Slice D (0390): moves a delivery order from staged_for_delivery to '
  'in_transit (in_transit_at = now(), in_transit_by = the caller) and returns '
  'the row. Gates in its body: signed in (42501), member of the order''s org '
  '(P0002 order_request_not_found, the same for a missing order), the orders '
  'module (P0001 module_disabled), write access to the order''s warehouse '
  '(42501, hint warehouse_write), a delivery order (P0001 not_a_delivery), '
  'status staged_for_delivery read under the row lock (P0001 '
  'order_status_changed, hint status_changed, detail = the status), a driver '
  'assigned (P0001 no_driver) and orders:approve (42501, hint orders_approve; '
  'owner decision O3: an assigned driver without it is refused). Locks the '
  'order row (FOR NO KEY UPDATE). Never raises 40001/40P01. SECURITY DEFINER, '
  'lock_timeout 5s, EXECUTE to authenticated only.';

-- ═══ 2. The ten approval functions: the role term removed, nothing else ════

-- approve_order_request: restated from 0365_s2_fulfilment_fixes.sql:45; md5(prosrc) 96e5f7c8b4cdd6b7e4ffcc994c9ed642 -> 7883f466ae2642cbb4664ebc473e571b.
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

-- approve_partial: restated from 0365_s2_fulfilment_fixes.sql:952; md5(prosrc) 64bb847ffc8681adeed4b881c1b6a4ab -> 40ca0878733b08a649773fe9b7efd4e0.
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

-- assign_picking: restated from 0348_orders_approve_grant_and_push_token_rebind.sql:549; md5(prosrc) 44ebd4558995a343aa878ca47c5a9b8f -> d6e8dc7c2f92863a88ed381dc883637c.
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
  if not (public.has_permission(v_req.organization_id, 'orders:approve')) then
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

-- cancel_order_request: restated from 0348_orders_approve_grant_and_push_token_rebind.sql:613; md5(prosrc) 7a2302dec888970054738b0dad420fd3 -> 47cabcd1fe4f52fb7b2b6b6b64b68da1.
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

-- close_partial: restated from 0348_orders_approve_grant_and_push_token_rebind.sql:256; md5(prosrc) 2d873a049a5584df7d3a168fb2b45e34 -> a519c3e58fb577c3ff1b30fb3a6cc0ad.
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

-- hold_order_stock: restated from 0378_order_hold_stock.sql:131; md5(prosrc) c38fe9b12af77fdaa2d372f4fd324a43 -> 3b0691d604823164daaa7f248616f00f.
create or replace function public.hold_order_stock(p_order_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_org2   uuid;
  v_wh     uuid;
  v_status text;
  v_items  uuid[];
  v_item   record;
  v_owed   numeric;
  v_own    numeric;
  v_all    numeric;
  v_need   numeric;
  v_free   numeric;
  v_add    numeric;
  v_held   jsonb := '[]'::jsonb;
  v_short  jsonb := '[]'::jsonb;
  v_hidden_held  integer := 0;
  v_hidden_short integer := 0;
begin
  -- Gate 1: a signed-in caller.
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gate 2: the order exists and the caller is an accepted, enabled member of
  -- its org. One answer for both. Read WITHOUT a lock: a caller who may not
  -- hold must not queue on (or hold) the order row.
  select o.organization_id into v_org
    from public.order_requests o
   where o.id = p_order_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 3: the Orders module.
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- Gate 4: the approve gate (0348), so whoever may approve may hold.
  if not (public.has_permission(v_org, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_approve';
  end if;

  -- LOCK 1 of 2: the order row (approve_order_request's first lock).
  select o.organization_id, o.warehouse_id, o.status
    into v_org2, v_wh, v_status
    from public.order_requests o
   where o.id = p_order_id
     for update;
  if v_org2 is null or v_org2 is distinct from v_org then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 5: write access to the order's warehouse.
  if not public.user_can_access_inventory(v_uid, v_wh, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  -- Gate 6: only where holds mean something. Read under the lock, so a
  -- concurrent pick completion (which releases every hold) cannot slip in
  -- between the check and the holds.
  if v_status not in ('approved', 'pick_slip_generated', 'picking_in_progress') then
    raise exception 'hold_not_applicable'
      using errcode = 'P0001', hint = 'hold_not_applicable', detail = v_status;
  end if;

  -- The order's items, read after the order lock. An array, not a semi-join
  -- (the 0365 note: `= any` keeps the item lookup on its primary key).
  select coalesce(array_agg(distinct l.item_id), '{}'::uuid[])
    into v_items
    from public.order_request_lines l
   where l.order_request_id = p_order_id;

  -- LOCK 2 of 2: the items, in id order (approve_order_request's order).
  -- Deleted items, items of another warehouse and items of another org are
  -- neither locked nor held. A row that stops matching while this call waits
  -- for its lock (moved, deleted) is re-checked and skipped (READ COMMITTED
  -- re-evaluates the WHERE on the locked row version).
  for v_item in
    select ii.id, ii.quantity_on_hand
      from public.inventory_items ii
     where ii.id = any(v_items)
       and ii.organization_id = v_org
       and ii.warehouse_id = v_wh
       and ii.deleted_at is null
     order by ii.id
       for update
  loop
    -- What the item's lines still owe (lineOwedUnits per line, floored per
    -- line so an over-receipt on one line never eats a sibling's share).
    select coalesce(sum(greatest(coalesce(l.quantity_requested, 0)
                                 - coalesce(l.quantity_fulfilled, 0), 0)), 0)
      into v_owed
      from public.order_request_lines l
     where l.order_request_id = p_order_id
       and l.item_id = v_item.id;

    -- This order's active holds on the item, and every active hold on it
    -- (other orders' and rentals' included). By (organization_id, item_id),
    -- so stock_reservations_active_idx serves the read.
    select coalesce(sum(r.quantity) filter (where r.order_request_id = p_order_id), 0),
           coalesce(sum(r.quantity), 0)
      into v_own, v_all
      from public.stock_reservations r
     where r.organization_id = v_org
       and r.item_id = v_item.id
       and r.released_at is null;

    v_need := v_owed - v_own;
    if v_need > 0 then
      v_free := greatest(0, coalesce(v_item.quantity_on_hand, 0) - v_all);
      v_add  := least(v_need, v_free);
      if v_add > 0 then
        insert into public.stock_reservations
          (organization_id, item_id, warehouse_id, order_request_id, quantity)
        values (v_org, v_item.id, v_wh, p_order_id, v_add);
      end if;
      -- Numbers only where the caller can read the item (see the header): an
      -- item they cannot read is held all the same, and only counted.
      if public.caller_can_read_item(v_item.id) then
        if v_add > 0 then
          v_held := v_held || jsonb_build_array(
            jsonb_build_object('itemId', v_item.id, 'added', v_add));
        end if;
        if v_need - v_add > 0 then
          v_short := v_short || jsonb_build_array(
            jsonb_build_object('itemId', v_item.id, 'quantity', v_need - v_add));
        end if;
      else
        if v_add > 0 then
          v_hidden_held := v_hidden_held + 1;
        end if;
        if v_need - v_add > 0 then
          v_hidden_short := v_hidden_short + 1;
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object('held', v_held, 'stillShort', v_short,
                            'hiddenHeldItems', v_hidden_held,
                            'hiddenShortItems', v_hidden_short);
end;
$$;

-- order_readiness_facts: restated from 0377_order_readiness_facts.sql:199; md5(prosrc) 5ac332d439117e498096fc9b1098cf04 -> 2f3fb057bacda8143377ecd9c2c5e6e2.
create or replace function public.order_readiness_facts(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_org        uuid;
  v_wh         uuid;
  v_status     text;
  v_order      jsonb;
  v_phase      text;
  v_lines_n    integer;
  v_lines      jsonb;
  v_items      jsonb;
  v_approver   boolean;
  v_po_module  boolean;
  v_all        uuid[];
  v_visible    uuid[];
begin
  -- Gate 1: a signed-in caller.
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gate 2: the order exists and the caller is an accepted, enabled member of
  -- its org. One answer for both, so a foreign order is indistinguishable
  -- from a missing one.
  select o.organization_id,
         o.warehouse_id,
         o.status,
         jsonb_build_object(
           'id',              o.id,
           'orderNumber',     o.order_number,
           'status',          o.status,
           'warehouseId',     o.warehouse_id,
           'neededBy',        o.needed_by,
           'fulfillmentType', o.fulfillment_type,
           'timeZone',        (select g.timezone from public.organizations g
                                where g.id = o.organization_id))
    into v_org, v_wh, v_status, v_order
    from public.order_requests o
   where o.id = p_order_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 3: the Orders module.
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  v_phase := case
    when v_status in ('pending_approval', 'approved', 'pick_slip_generated',
                      'picking_in_progress', 'backordered') then 'to_pick'
    when v_status in ('picking_complete', 'packing_slip_generated', 'staged_for_pickup',
                      'staged_for_delivery', 'in_transit') then 'picked'
    else 'closed'
  end;

  -- Gate 4: at most 200 lines. Past it, nothing but the order and the flag:
  -- never a partial answer.
  select count(*)::integer into v_lines_n
    from public.order_request_lines l
   where l.order_request_id = p_order_id;
  if v_lines_n > 200 then
    return jsonb_build_object(
      'v', 1, 'observedAt', now(), 'phase', v_phase, 'linesCapped', true,
      'order', v_order, 'lines', '[]'::jsonb, 'items', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'lineId',    l.id,
           'itemId',    l.item_id,
           'requested', l.quantity_requested,
           'fulfilled', l.quantity_fulfilled,
           'picked',    l.quantity_picked,
           'createdAt', l.created_at)
           order by l.created_at, l.id), '[]'::jsonb)
    into v_lines
    from public.order_request_lines l
   where l.order_request_id = p_order_id;

  -- Gate 5: only the to_pick phase reads stock. Picked orders are judged from
  -- their lines alone (lineUnpickedUnits); closed orders show nothing.
  if v_phase <> 'to_pick' then
    return jsonb_build_object(
      'v', 1, 'observedAt', now(), 'phase', v_phase, 'linesCapped', false,
      'order', v_order, 'lines', v_lines, 'items', '[]'::jsonb);
  end if;

  v_approver  := public.has_permission(v_org, 'orders:approve');
  v_po_module := public.module_enabled(v_org, 'purchase_orders');

  -- The order's items, and those the caller may see numbers for: in the
  -- order's org and readable by the caller (caller_can_read_item, the
  -- inventory_items_select predicate), asked once per item. Every read below
  -- filters on this array (`= any`), which the planner can serve from each
  -- table's item index (a semi-join on a CTE hid the item count from it and
  -- chose a full scan of purchase_order_items).
  select coalesce(array_agg(d.item_id order by d.item_id), '{}'::uuid[]),
         coalesce(array_agg(d.item_id order by d.item_id) filter (where d.readable), '{}'::uuid[])
    into v_all, v_visible
    from (select x.item_id,
                 (i.id is not null and public.caller_can_read_item(i.id)) as readable
            from (select distinct l.item_id
                    from public.order_request_lines l
                   where l.order_request_id = p_order_id) x
            left join public.inventory_items i
              on i.id = x.item_id
             and i.organization_id = v_org) d;

  with itm as materialized (
    select d.item_id,
           (d.item_id = any (v_visible)) as visible,
           i.name,
           i.sku,
           i.supplier_id,
           i.warehouse_id                   as item_wh,
           i.deleted_at is not null         as deleted,
           coalesce(i.status = 'archived', false) as archived,
           coalesce(i.is_bundle, false)     as is_bundle,
           coalesce(i.quantity_on_hand, 0)  as on_hand
      from unnest(v_all) d(item_id)
      left join public.inventory_items i
        on i.id = d.item_id
       and i.organization_id = v_org
  ),
  holds as (
    select r.item_id,
           coalesce(sum(r.quantity) filter (
             where r.order_request_id = p_order_id), 0)                 as own,
           coalesce(sum(r.quantity) filter (
             where r.order_request_id is distinct from p_order_id
               and r.order_request_id is not null), 0)                  as other_orders,
           -- IS DISTINCT FROM, as complete_picking (0365): a rental's hold
           -- has no order, and `null <> p_order_id` is null.
           coalesce(sum(r.quantity) filter (
             where r.order_request_id is distinct from p_order_id
               and r.order_request_id is null), 0)                      as rentals
      from public.stock_reservations r
     where r.organization_id = v_org
       and r.item_id = any (v_visible)
       and r.released_at is null
     group by r.item_id
  ),
  lv as materialized (
    select s.item_id,
           s.location_id,
           s.quantity,
           l.kind,
           (l.warehouse_id is null or l.warehouse_id = v_wh) as here
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = any (v_visible)
       and s.quantity > 0
  ),
  lv_sum as (
    select x.item_id,
           coalesce(sum(x.quantity) filter (
             where x.here and x.kind is not null
               and x.kind <> 'staging' and x.kind <> 'unplaced'), 0)    as here_rack,
           -- kind NULL is a Site (0292).
           coalesce(sum(x.quantity) filter (where x.here and x.kind is null), 0)     as here_site,
           coalesce(sum(x.quantity) filter (where x.here and x.kind = 'unplaced'), 0) as here_unplaced,
           coalesce(sum(x.quantity) filter (where x.here and x.kind = 'staging'), 0)  as here_staging,
           -- IS DISTINCT FROM: a NULL-kind Site elsewhere is pickable there.
           coalesce(sum(x.quantity) filter (
             where not x.here and x.kind is distinct from 'staging'), 0) as else_pickable,
           coalesce(sum(x.quantity) filter (where not x.here and x.kind = 'staging'), 0) as else_staging
      from lv x
     group by x.item_id
  ),
  stg as (
    select y.item_id,
           coalesce(jsonb_agg(jsonb_build_object('locationId', y.location_id, 'quantity', y.quantity)
                              order by y.quantity desc, y.location_id)
                      filter (where y.shown), '[]'::jsonb)           as sources,
           coalesce(sum(y.quantity) filter (where not y.shown), 0)  as hidden
      from (select x.item_id, x.location_id, x.quantity,
                   public.location_holdings_visible(x.location_id) as shown
              from lv x
             where x.here and x.kind = 'staging') y
     group by y.item_id
  ),
  pend as (
    select l.item_id,
           count(distinct o.id)::integer                                    as orders,
           coalesce(sum(greatest(l.quantity_requested - l.quantity_fulfilled, 0)), 0) as units
      from public.order_request_lines l
      join public.order_requests o on o.id = l.order_request_id
     where v_approver
       and l.item_id = any (v_visible)
       and o.organization_id = v_org
       and o.status = 'pending_approval'
       and o.id <> p_order_id
     group by l.item_id
  ),
  cmt_orders as (
    select l.item_id,
           o.id     as order_id,
           o.status,
           sum(greatest(l.quantity_requested - l.quantity_fulfilled, 0)) as owed,
           sum(greatest(greatest(l.quantity_requested - l.quantity_fulfilled, 0)
                        - coalesce(l.quantity_picked, 0), 0))             as unpicked
      from public.order_request_lines l
      join public.order_requests o on o.id = l.order_request_id
     where l.item_id = any (v_visible)
       and o.organization_id = v_org
       and o.id <> p_order_id
       and o.status in ('approved', 'pick_slip_generated', 'picking_in_progress', 'backordered',
                        'picking_complete', 'packing_slip_generated', 'staged_for_pickup',
                        'staged_for_delivery', 'in_transit')
     group by l.item_id, o.id, o.status
  ),
  cmt as (
    select c.item_id,
           sum(case
                 when c.status in ('approved', 'pick_slip_generated', 'picking_in_progress', 'backordered')
                   then greatest(c.owed - coalesce((
                          select sum(r.quantity)
                            from public.stock_reservations r
                           where r.organization_id = v_org
                             and r.item_id = c.item_id
                             and r.order_request_id = c.order_id
                             and r.released_at is null), 0), 0)
                 else c.unpicked
               end) as shortfall
      from cmt_orders c
     group by c.item_id
  ),
  po as (
    select poi.item_id,
           p.id          as po_id,
           p.po_number,
           p.status,
           p.expected_at,
           (p.status = 'draft') as is_draft,
           sum(greatest(poi.quantity_ordered - coalesce(poi.quantity_received, 0), 0)) as remaining
      from public.purchase_order_items poi
      join public.purchase_orders p on p.id = poi.purchase_order_id
     where v_po_module
       and poi.item_id = any (v_visible)
       and p.organization_id = v_org
       and p.status in ('draft', 'expected_inbound', 'ordered', 'partially_received')
     group by poi.item_id, p.id, p.po_number, p.status, p.expected_at
    having sum(greatest(poi.quantity_ordered - coalesce(poi.quantity_received, 0), 0)) > 0
  ),
  po_shown as (
    select q.*, public.purchase_order_visible(q.po_id) as shown
      from po q
  ),
  po_ranked as (
    select q.*,
           row_number() over (partition by q.item_id, q.is_draft, q.shown
                              order by q.expected_at asc nulls last, q.po_number, q.po_id) as rn
      from po_shown q
  ),
  inbound as (
    select q.item_id,
           coalesce(jsonb_agg(jsonb_build_object(
                      'poId', q.po_id, 'poNumber', q.po_number, 'status', q.status,
                      'expectedAt', q.expected_at, 'remaining', q.remaining)
                      order by q.rn)
                      filter (where q.shown and q.rn <= 10), '[]'::jsonb)          as rows_,
           coalesce(sum(q.remaining) filter (where not q.shown), 0)                as hidden,
           coalesce(bool_or(q.shown and q.rn > 10), false)                         as truncated,
           coalesce(sum(q.remaining) filter (where q.shown and q.rn > 10), 0)      as truncated_remaining
      from po_ranked q
     where not q.is_draft
     group by q.item_id
  ),
  drafts as (
    select q.item_id,
           coalesce(jsonb_agg(jsonb_build_object(
                      'poId', q.po_id, 'poNumber', q.po_number, 'remaining', q.remaining)
                      order by q.rn)
                      filter (where q.shown and q.rn <= 10), '[]'::jsonb)          as rows_,
           coalesce(sum(q.remaining) filter (where not q.shown), 0)                as hidden,
           coalesce(bool_or(q.shown and q.rn > 10), false)                         as truncated,
           coalesce(sum(q.remaining) filter (where q.shown and q.rn > 10), 0)      as truncated_remaining
      from po_ranked q
     where q.is_draft
     group by q.item_id
  )
  select coalesce(jsonb_agg(
           case
             when not t.visible then
               jsonb_build_object('itemId', t.item_id, 'visible', false)
             else jsonb_build_object(
               'itemId',          t.item_id,
               'visible',         true,
               'name',            t.name,
               'sku',             t.sku,
               'supplierId',      t.supplier_id,
               'itemWarehouseId', t.item_wh,
               'deleted',         t.deleted,
               'archived',        t.archived,
               'isBundle',        t.is_bundle,
               'onHand',          t.on_hand,
               'heldOwn',         coalesce(h.own, 0),
               'heldOtherOrders', coalesce(h.other_orders, 0),
               'heldRentals',     coalesce(h.rentals, 0),
               'here', jsonb_build_object(
                 'rack',     coalesce(s.here_rack, 0),
                 'site',     coalesce(s.here_site, 0),
                 'unplaced', coalesce(s.here_unplaced, 0),
                 'staging',  coalesce(s.here_staging, 0)),
               'elsewhere', jsonb_build_object(
                 'pickable', coalesce(s.else_pickable, 0),
                 'staging',  coalesce(s.else_staging, 0)),
               'stagingSources',   coalesce(g.sources, '[]'::jsonb),
               'stagingHiddenQty', coalesce(g.hidden, 0),
               'pendingOthers',
                 case when v_approver
                      then jsonb_build_object('orders', coalesce(pn.orders, 0),
                                              'units',  coalesce(pn.units, 0))
                 end,
               'committedOtherShortfall', coalesce(c.shortfall, 0),
               'inbound',
                 case when v_po_module
                      then jsonb_build_object(
                             'rows',               coalesce(ib.rows_, '[]'::jsonb),
                             'hiddenRemaining',    coalesce(ib.hidden, 0),
                             'truncated',          coalesce(ib.truncated, false),
                             'truncatedRemaining', coalesce(ib.truncated_remaining, 0))
                 end,
               'drafts',
                 case when v_po_module
                      then jsonb_build_object(
                             'rows',               coalesce(dr.rows_, '[]'::jsonb),
                             'hiddenRemaining',    coalesce(dr.hidden, 0),
                             'truncated',          coalesce(dr.truncated, false),
                             'truncatedRemaining', coalesce(dr.truncated_remaining, 0))
                 end)
           end
           order by t.item_id), '[]'::jsonb)
    into v_items
    from itm t
    left join holds   h  on h.item_id  = t.item_id and t.visible
    left join lv_sum  s  on s.item_id  = t.item_id and t.visible
    left join stg     g  on g.item_id  = t.item_id and t.visible
    left join pend    pn on pn.item_id = t.item_id and t.visible
    left join cmt     c  on c.item_id  = t.item_id and t.visible
    left join inbound ib on ib.item_id = t.item_id and t.visible
    left join drafts  dr on dr.item_id = t.item_id and t.visible;

  return jsonb_build_object(
    'v', 1, 'observedAt', now(), 'phase', v_phase, 'linesCapped', false,
    'order', v_order, 'lines', v_lines, 'items', v_items);
end;
$$;

-- reopen_picking: restated from 0348_orders_approve_grant_and_push_token_rebind.sql:414; md5(prosrc) a7fabd5fb3d07467135006b56581e46c -> 293ce0e76d195bb13105cfd1c067de82.
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

-- resume_fulfillment: restated from 0348_orders_approve_grant_and_push_token_rebind.sql:308; md5(prosrc) e0f2ae5d7d3564cdad3b36ba4cf5aa8c -> 2e2d5aab1db5392250879bfa9ff4bccd.
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

-- revise_order_needed_by: restated from 0383_revise_order_needed_by.sql:153; md5(prosrc) c2ce20a076301c95b2b9ef968db1b206 -> dd11c6a10d4ec6fe3543e86680130347.
create or replace function public.revise_order_needed_by(
  p_id                 uuid,
  p_needed_by          timestamptz,
  p_expected_needed_by timestamptz,
  p_reason             text,
  p_event_details      text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid           uuid := auth.uid();
  v_org           uuid;
  v_org2          uuid;
  v_wh            uuid;
  v_status        text;
  v_current       timestamptz;
  v_reason        text;
  v_details       text;
  v_event_id      uuid;
  v_event_status  text;
  v_event_details text;
  v_event_updated boolean := false;
  v_at            integer;
  v_old_sentence  text;
begin
  -- Gate 1: a signed-in caller.
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gate 2: the order exists and the caller is an accepted, enabled member of
  -- its org. One answer for both. Read WITHOUT a lock: a caller who may not
  -- revise must not queue on (or hold) the order row.
  select o.organization_id into v_org
    from public.order_requests o
   where o.id = p_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 3: the Orders module.
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- Gate 4: the approve gate (0348): whoever may approve may change the date.
  if not (public.has_permission(v_org, 'orders:approve')) then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_approve';
  end if;

  -- LOCK 1 of 2: the order row.
  select o.organization_id, o.warehouse_id, o.status, o.needed_by
    into v_org2, v_wh, v_status, v_current
    from public.order_requests o
   where o.id = p_id
     for update;
  if v_org2 is null or v_org2 is distinct from v_org then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  -- Gate 5: write access to the order's warehouse.
  if not public.user_can_access_inventory(v_uid, v_wh, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  -- Closed orders keep their date.
  if v_status in ('pending_confirmation', 'completed', 'denied', 'cancelled') then
    raise exception 'order_closed'
      using errcode = 'P0001', hint = 'order_closed', detail = v_status;
  end if;

  -- The arguments.
  if p_needed_by is null then
    raise exception 'needed_by_required' using errcode = '22023', hint = 'needed_by_required';
  end if;
  if p_needed_by <= now() then
    raise exception 'needed_by_in_past' using errcode = '22023', hint = 'needed_by_in_past';
  end if;
  if not isfinite(p_needed_by) or p_needed_by > now() + interval '5 years' then
    raise exception 'needed_by_out_of_range' using errcode = '22023', hint = 'needed_by_out_of_range';
  end if;
  v_reason := regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g');
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'reason_required' using errcode = '22023', hint = 'reason_required';
  end if;
  -- Only core's own date sentence is taken (DESCRIPTION, in the header).
  v_details := btrim(regexp_replace(coalesce(p_event_details, ''), '[[:cntrl:]]', '', 'g'));
  if v_details !~ '^Auto-created from order (SO-[0-9]{6,}|[0-9A-F]{8})\. Needed by [^.]{1,64}\.$' then
    v_details := null;
  end if;

  -- Stale version: the caller must have seen the value it is replacing.
  if v_current is distinct from p_expected_needed_by then
    raise exception 'needed_by_changed'
      using errcode = 'P0001', hint = 'needed_by_changed',
            detail = coalesce(to_jsonb(v_current) #>> '{}', '');
  end if;

  -- LOCK 2 of 2: the order's event (at most one), when it has one.
  select e.id, e.status, e.details
    into v_event_id, v_event_status, v_event_details
    from public.schedule_events e
   where e.order_request_id = p_id
     and e.organization_id = v_org
     for update;

  -- An equal value writes nothing.
  if p_needed_by = v_current then
    return jsonb_build_object('changed', false, 'previous', v_current, 'neededBy', v_current,
                              'eventId', v_event_id, 'eventUpdated', false,
                              'eventStatus', v_event_status, 'status', v_status);
  end if;

  update public.order_requests
     set needed_by = p_needed_by
   where id = p_id;

  if v_event_id is not null and v_event_status in ('scheduled', 'in_progress') then
    -- The description: the date sentence is replaced where it sits, and
    -- everything a person wrote around it stays; one rewritten by hand (no
    -- such sentence) is kept whole; an empty one gets the sentence.
    if v_details is not null then
      if v_event_details is null or btrim(v_event_details) = '' then
        v_event_details := v_details;
      else
        v_at := regexp_instr(v_event_details, 'Auto-created from order [^.\n]*\. Needed by [^.\n]*\.');
        if v_at > 0 then
          v_old_sentence := regexp_substr(v_event_details, 'Auto-created from order [^.\n]*\. Needed by [^.\n]*\.');
          v_event_details := left(v_event_details, v_at - 1) || v_details
                             || substr(v_event_details, v_at + char_length(v_old_sentence));
        end if;
      end if;
    end if;
    update public.schedule_events e
       set starts_at       = p_needed_by,
           ends_at         = case when e.ends_at is null then null
                                  else p_needed_by + (e.ends_at - e.starts_at) end,
           details         = v_event_details,
           reminded_24h_at = null,
           reminded_1h_at  = null,
           updated_by      = v_uid
     where e.id = v_event_id;
    v_event_updated := true;
  end if;

  return jsonb_build_object('changed', true, 'previous', v_current, 'neededBy', p_needed_by,
                            'eventId', v_event_id, 'eventUpdated', v_event_updated,
                            'eventStatus', v_event_status, 'status', v_status);
end;
$$;

-- ═══ 3. The comments that stated the old rule ══════════════════════════════

comment on function public.approve_order_request(uuid) is
  'Approve a pending order request. Authorized for anyone whose effective ''orders:approve'' permission is true (has_permission: the owner always; admin and manager by role default; an explicit user or role override wins either way). 0390 removed the manager-by-role term 0348 kept, so a revoked manager is refused here too.';

comment on function public.hold_order_stock(uuid) is
  'F2-2 (0378): tops an approved or picking order''s holds up to what its lines '
  'still owe, as far as free stock allows: per item (item id order), need = '
  'owed - this order''s active holds, one new hold of least(need, max(0, '
  'on_hand - every active hold)). Deleted, moved and other-org items are '
  'skipped. Returns {held:[{itemId, added}], stillShort:[{itemId, quantity}], '
  'hiddenHeldItems, hiddenShortItems}: quantities only for items the caller '
  'can read (caller_can_read_item); an item they cannot read is held the same '
  'and only counted. '
  'Never refuses for want of stock, never shrinks or releases a hold, never '
  'moves stock; a second call adds 0. Gates in its body: signed in (42501), '
  'member of the order''s org (P0002 order_request_not_found, the same for a '
  'missing order), the orders module (P0001 module_disabled), '
  'orders:approve, decided by has_permission alone since 0390 (42501, hint orders_approve), write access to the order''s '
  'warehouse (42501, hint warehouse_write), status approved, '
  'pick_slip_generated or picking_in_progress (P0001 hold_not_applicable). '
  'Locks the order row, then the items in id order (approve_order_request''s '
  'order: no deadlock). SECURITY DEFINER, lock_timeout 5s.';

comment on function public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text) is
  'F2-4 (0383): changes an open order''s needed-by and moves its Schedule event '
  'with it, in one transaction. Refuses a closed order (P0001 order_closed), a '
  'needed-by that is null, not in the future, infinity or later than five years '
  'from now (22023 needed_by_required, needed_by_in_past, needed_by_out_of_range), '
  'a reason that is empty or over 500 characters after '
  'trimming (22023 reason_required), and a stale edit: the order''s needed-by '
  'must be p_expected_needed_by (P0001 needed_by_changed, detail = the current '
  'value). An equal value writes nothing. The order''s scheduled or in-progress '
  'event gets starts_at = the new needed-by, ends_at shifted by the same amount, '
  'the date sentence in its description replaced by p_event_details (taken only '
  'when it is core''s sentence "Auto-created from order SO-…. Needed by …."; any '
  'text a person wrote around it is kept) and both reminder stamps cleared, so its reminders '
  'go out again for the new time; a completed or cancelled event is untouched and '
  'a missing one is not created here (autoScheduleFromOrder is the one writer of '
  'new events). Returns {changed, previous, neededBy, eventId, eventUpdated, '
  'eventStatus, status}. Gates in its body: signed in (42501), member of the order''s org '
  '(P0002 order_request_not_found, the same for a missing order), the orders '
  'module (P0001 module_disabled), orders:approve, decided by has_permission alone since 0390 (42501, hint '
  'orders_approve), write access to the order''s warehouse (42501, hint '
  'warehouse_write). Locks the order row, then its event. Never notifies or '
  'emails; never raises 40001/40P01. SECURITY DEFINER (schedule_events_update is '
  'creator-or-manager), lock_timeout 5s, EXECUTE to authenticated only.';

-- ═══ 4. The three policies ═════════════════════════════════════════════════

-- The lock prelude (see LOCKS above): every table lock the three ALTER POLICY
-- statements take, at once and without waiting. Inside DO because the CLI
-- batch is not a transaction block (a top-level LOCK TABLE refuses there, as
-- 0373 found); the locks last until the batch commits.
--   * inventory_items: ACCESS SHARE, read by the lines policy's expression
--     (no order or stock write conflicts with it).
--   * order_request_lines and order_requests: ACCESS EXCLUSIVE (ALTER POLICY).
--   * every table supautils.policy_grants lists for this role: supautils
--     before 3.4.4 (production and the local stack run image 17.6.1.166,
--     supautils 3.4.0) takes ACCESS EXCLUSIVE on each of them, to commit,
--     whenever this role runs ALTER POLICY on any table (fixed upstream in
--     supautils #228). Taken here first, ONLY the parent of a partitioned
--     table (realtime.messages) as supautils does, and only those that exist
--     (supautils skips a missing one).
-- Each attempt is a subtransaction (BEGIN ... EXCEPTION): a busy table fails
-- it at once, the rollback releases whatever it had taken, and the next
-- attempt starts after a pause of 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is (never 40001/40P01) and
-- nothing in the file is applied. A successful attempt's locks pass to the
-- file's transaction and are kept to commit.
-- No statement after this block takes a new table lock, so the file never
-- waits while holding one: scripts/db-concurrency/0390_migration_lock_footprint.sh.
do $lock$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.inventory_items in access share mode nowait;
      lock table only public.order_request_lines, public.order_requests in access exclusive mode nowait;
      if v_grants is not null then
        for v_name in
          select jsonb_array_elements_text(coalesce(v_grants::jsonb -> current_user::text, '[]'::jsonb))
        loop
          v_rel := to_regclass(v_name);
          if v_rel is not null then
            execute format('lock table only %s in access exclusive mode nowait', v_rel);
          end if;
        end loop;
      end if;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

alter policy order_request_lines_insert on public.order_request_lines
  with check (
    exists (
      select 1
        from public.order_requests r
        join public.inventory_items ii
          on ii.id = order_request_lines.item_id
         and ii.organization_id = r.organization_id
       where r.id = order_request_lines.order_request_id
         and ((r.requester_user_id = (select auth.uid()))
              or (select public.has_permission(r.organization_id, 'orders:approve')))
         and ii.warehouse_id = r.warehouse_id
         -- 0363: the service's ship gate (loadEditableOrderHeader).
         and r.status not in ('in_transit', 'completed', 'denied', 'cancelled')
    )
  );

alter policy order_requests_insert on public.order_requests
  with check (
    ( SELECT public.is_org_member(order_requests.organization_id) )
    and (source = 'internal')
    and (
      (requester_user_id = ( SELECT auth.uid() ))
      or (
        (requester_user_id IS NULL) and (requester_email IS NOT NULL)
        and ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
      )
    )
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) )
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id) )
  );

alter policy order_requests_update on public.order_requests
  using (
    ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
  )
  with check (
    ( SELECT public.has_permission(order_requests.organization_id, 'orders:approve') )
    and ( SELECT public.warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) )
    and ( SELECT public.charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id) )
  );

reset lock_timeout;
