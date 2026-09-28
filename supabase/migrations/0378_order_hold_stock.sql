-- 0378_order_hold_stock.sql
--
-- F2-2 (Order Readiness, lean): "Held, and caught before it leaves". One
-- function, its grants and its comment. No table, column, index, policy or
-- data change. The only rows it writes are holds (stock_reservations):
-- commitments, not stock. It never moves stock, never shrinks a hold and never
-- releases one.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- Holds are minted only by approve_order_request, approve_partial and
-- resume_fulfillment. A line ADDED to an approved order (the web and phone
-- "Add items", OrderRequestsService.addLines) or RAISED on one
-- (updateLineQuantity) was never held: generatePickSlip only moves the status,
-- and the service's comment said the slip "reserves" them, which nothing did.
-- Production, 2026-09-27: L4L SO-60 (559 + 151 units) and SO-77 (5) were added
-- after approval and never held; Demo Co SO-4 has 8 + 4 added after approval
-- and 0 held. Unheld units read as free to every other order and to the
-- storefront, so the same units could be promised twice.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
-- hold_order_stock(order) tops the order's holds up to what its lines still
-- owe, as far as free stock allows. Per item on the order, in item id order:
--     need      = sum over the item's lines of max(0, requested - fulfilled)
--                 (core lineOwedUnits, floored per line) minus this order's
--                 own active holds on the item
--     available = max(0, on_hand - EVERY active hold on the item: this
--                 order's, other orders' and rentals')
--     when need > 0: one new hold of least(need, available), when that is > 0.
-- An item that is deleted, belongs to another warehouse or is not this
-- organization's is skipped: neither locked nor held (approve refuses a moved
-- item; a deleted one is removed from the order; readiness says which).
--
-- Returns
--   { held:       [ {itemId, added} ],        -- holds this call inserted
--     stillShort: [ {itemId, quantity} ] }    -- need left after it (no free stock)
-- item ids ascending, non-zero entries only. It never refuses for want of
-- stock (F2 decision D16: adding a line must not fail because stock is short;
-- readiness shows the rest as short). Idempotent by convergence: a second call
-- adds 0 (the need is met, or nothing is free).
--
-- The arithmetic is approve_partial's and resume_fulfillment's (0348),
-- min(owed, on_hand - active holds), applied to the gap: the order's own holds
-- are active holds too, so a line never takes stock its own earlier holds
-- already took.
--
-- ── GATES, IN ITS OWN BODY (SECURITY DEFINER, INV-25) ──────────────────────
--   1. auth.uid() null: 42501 unauthenticated.
--   2. the order missing, or the caller not an accepted, enabled member of its
--      organization (is_org_member): P0002 order_request_not_found, the same
--      answer for both (existence is not disclosed).
--   3. module_enabled(org, 'orders') false: P0001 module_disabled.
--   4. has_org_role(org, 'manager') or has_permission(org, 'orders:approve'),
--      the 0348 approve gate word for word (a staff member with an
--      orders:approve override passes, as approve lets them): else 42501
--      forbidden, hint orders_approve.
--   5. user_can_access_inventory(caller, order warehouse, null, 'write'):
--      else 42501 forbidden, hint warehouse_write. (Owners, admins and
--      managers write every warehouse; staff only their assigned ones;
--      viewers none, even with an orders:approve override.)
--   6. status approved, pick_slip_generated or picking_in_progress (the hold
--      statuses: approve minted the holds, complete_picking releases them):
--      else P0001 hold_not_applicable, detail = the status. Pending orders
--      are held by approve, backordered ones by resume_fulfillment.
-- Gates 2 to 4 are answered from an UNLOCKED read of the order, before any
-- lock is taken: a caller who may not hold never waits on, or holds, the
-- order row (and cannot tell a locked order from a missing one by a
-- lock_timeout). The order row is then locked, and gates 5 and 6 read the
-- warehouse and the status under that lock.
-- Refusals are P0001, P0002 or 42501 only. It never raises 40001 or 40P01
-- (0367): PostgREST retries 40001 forever.
--
-- ── LOCK ORDER (no deadlock) ───────────────────────────────────────────────
-- The order row FOR UPDATE first, then the order's items FOR UPDATE in item
-- id order: the order approve_order_request, approve_partial,
-- resume_fulfillment and complete_picking take them in (0365/0348: the order
-- row, then `order by l.item_id ... for update of ii`). Two holds on
-- different orders that share items, or a hold racing an approval, queue on
-- the first shared item and never cross. The item lock is also what keeps two
-- orders from holding the same last units: the second waits, then reads the
-- first's hold (every statement of a VOLATILE function takes a new snapshot).
-- scripts/db-concurrency/0378_hold_race.sh proves both with two sessions.
-- lock_timeout 5s: a caller waits at most 5 s, then gets 55P03 (the web
-- service says "try again").
--
-- ── WHO CALLS IT ───────────────────────────────────────────────────────────
-- OrderRequestsService.holdStock (the "Hold available stock" action, web and
-- phone), and the automatic top-up after an approver adds or raises a line at
-- a hold status. A requester who is not an approver never reaches it: their
-- added line stays "Not held" until an approver holds it (a non-approver must
-- not create commitments, D15).
--
-- ── FROZEN ─────────────────────────────────────────────────────────────────
-- approve_order_request, approve_partial, resume_fulfillment, close_partial,
-- complete_picking, partial_pick_line, reopen_picking, cancel_order_request,
-- confirm_order_signature, confirm_physical_signature, create_order_request,
-- save_purchase_order_draft, next_po_number, post_receipt_v2 (public and
-- ledger), ledger.apply_level_delta_for, ledger.adjust_stock,
-- ledger.transfer_stock, tg_order_requests_insert_guard,
-- tg_order_request_lines_guard, caller_can_read_item,
-- location_holdings_visible, order_readiness_facts and every policy are
-- untouched (pgTAP 0377 Z1 and 0378 Z1 pin their md5).
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- CREATE FUNCTION, COMMENT, GRANT and REVOKE only: catalog-only, no table
-- lock. lock_timeout makes the push fail fast instead of queueing (retry is
-- the remedy).

-- PLAIN `set`, not `set local` (0303/0358/0370/0374/0377). Reset at the end.
set lock_timeout = '5s';

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
  if not (public.has_org_role(v_org, 'manager')
          or public.has_permission(v_org, 'orders:approve')) then
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
        v_held := v_held || jsonb_build_array(
          jsonb_build_object('itemId', v_item.id, 'added', v_add));
      end if;
      if v_need - v_add > 0 then
        v_short := v_short || jsonb_build_array(
          jsonb_build_object('itemId', v_item.id, 'quantity', v_need - v_add));
      end if;
    end if;
  end loop;

  return jsonb_build_object('held', v_held, 'stillShort', v_short);
end;
$$;

revoke all on function public.hold_order_stock(uuid) from public, anon;
grant execute on function public.hold_order_stock(uuid) to authenticated, service_role;

comment on function public.hold_order_stock(uuid) is
  'F2-2 (0378): tops an approved or picking order''s holds up to what its lines '
  'still owe, as far as free stock allows: per item (item id order), need = '
  'owed - this order''s active holds, one new hold of least(need, max(0, '
  'on_hand - every active hold)). Deleted, moved and other-org items are '
  'skipped. Returns {held:[{itemId, added}], stillShort:[{itemId, quantity}]}. '
  'Never refuses for want of stock, never shrinks or releases a hold, never '
  'moves stock; a second call adds 0. Gates in its body: signed in (42501), '
  'member of the order''s org (P0002 order_request_not_found, the same for a '
  'missing order), the orders module (P0001 module_disabled), manager or '
  'orders:approve (42501, hint orders_approve), write access to the order''s '
  'warehouse (42501, hint warehouse_write), status approved, '
  'pick_slip_generated or picking_in_progress (P0001 hold_not_applicable). '
  'Locks the order row, then the items in id order (approve_order_request''s '
  'order: no deadlock). SECURITY DEFINER, lock_timeout 5s.';

reset lock_timeout;
