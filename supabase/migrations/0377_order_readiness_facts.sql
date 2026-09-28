-- 0377_order_readiness_facts.sql
--
-- F2-1 (Order Readiness, lean): "readiness you can see". Read-only: no table,
-- no column, no index, no data change, no stock or hold written. Two functions,
-- their grants and their comments.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. purchase_order_visible(po): whether the caller could open that purchase
--      order, i.e. purchase_orders_select (0208/0331) restated for one row:
--      a member of the PO's org, the org in
--      rls_orgs_with_permission('purchase_orders:read'), and (manager, or no
--      destination, or a destination location with no warehouse or with a
--      warehouse in my_warehouse_ids()). The nested read of the destination
--      location restates locations_select as well (is_org_member of the
--      location's org), so the answer is the same whether this runs as the
--      caller or inside a SECURITY DEFINER body. The location_holdings_visible
--      (0374) pattern; pgTAP 0377 holds it equal to the policy for every
--      persona and PO of its fixture.
--
--   2. order_readiness_facts(order): the raw facts behind an order's
--      readiness, for one order, as ONE jsonb value. Judgement is not here:
--      packages/core/src/orders/readiness.ts turns these facts into line
--      states, numbers and words, and the web server and the phone run that
--      same core function. Nothing is stored; every answer carries observedAt.
--
-- ── THE ANSWER (v 1; later changes are additive only) ──────────────────────
--   { v, observedAt, phase, linesCapped,
--     order: { id, orderNumber, status, warehouseId, neededBy, fulfillmentType,
--              timeZone },
--     lines: [ { lineId, itemId, requested, fulfilled, picked, createdAt } ]
--            in (created_at, id) order,
--     items: [ { itemId, visible:false }
--            | { itemId, visible:true, name, sku, supplierId, itemWarehouseId,
--                deleted, archived, isBundle,
--                onHand, heldOwn, heldOtherOrders, heldRentals,
--                here:      { rack, site, unplaced, staging },
--                elsewhere: { pickable, staging },
--                stagingSources: [ { locationId, quantity } ], stagingHiddenQty,
--                pendingOthers: { orders, units } | null,
--                committedOtherShortfall,
--                inbound: { rows: [ { poId, poNumber, status, expectedAt, remaining } ],
--                           hiddenRemaining, truncated, truncatedRemaining } | null,
--                drafts:  { rows: [ { poId, poNumber, remaining } ],
--                           hiddenRemaining, truncated, truncatedRemaining } | null } ] }
--
-- One value, never a set, so PostgREST's max_rows cannot cut it short.
--
-- ── PHASES (core orderReadinessPhase is the twin) ──────────────────────────
--   to_pick: pending_approval, approved, pick_slip_generated,
--            picking_in_progress, backordered. Facts are read.
--   picked:  picking_complete, packing_slip_generated, staged_for_pickup,
--            staged_for_delivery, in_transit (core PICKING_SETTLED_STATUSES).
--            order and lines only.
--   closed:  everything else (pending_confirmation, completed, denied,
--            cancelled, and any legacy value). order and lines only.
--
-- ── THE FACTS ──────────────────────────────────────────────────────────────
--   visible            caller_can_read_item(item), and the item is in the
--                      order's org. A hidden item carries NO numeric key.
--   heldOwn            active holds (released_at is null) of THIS order.
--   heldOtherOrders    active holds of any other order.
--   heldRentals        active holds with no order (rentals).
--                      heldOtherOrders + heldRentals is exactly the
--                      `order_request_id IS DISTINCT FROM p_order_id` term
--                      complete_picking nets out (0365). Holds are read by
--                      (organization_id, item_id) so stock_reservations_active_idx
--                      serves them.
--   here               holdings (quantity > 0) at locations whose warehouse is
--                      the order's warehouse, or none (org level: a NULL
--                      warehouse is never foreign, 0343). Split by kind:
--                      'staging' -> staging, 'unplaced' -> unplaced, kind NULL
--                      -> site (a NULL kind IS a Site, 0292: never
--                      `kind <> 'staging'`, which leaves it out), every other kind
--                      (rack, crate, area) -> rack.
--   elsewhere          holdings in any other warehouse, as two numbers only
--                      (pickable = every kind but Staging, and staging). Never
--                      supply here (the 0371 "N in other warehouses" rule).
--   stagingSources     the here-Staging holdings, one row per location, only
--                      where location_holdings_visible(location) (0374); the
--                      rest is summed into stagingHiddenQty.
--   pendingOthers      other pending_approval orders wanting the item: how
--                      many, and their owed units. Only for a manager or an
--                      orders:approve holder; null for everyone else. No
--                      identities.
--   committedOtherShortfall
--                      per other open order, then summed: at approved,
--                      pick_slip_generated, picking_in_progress or backordered,
--                      max(0, owed - that order's active holds on the item); at
--                      the picking-settled statuses, the sum over its lines of
--                      max(0, owed - picked). Pending and pending_confirmation
--                      orders are not committed and are left out.
--   inbound            null when the purchase_orders module is off. Otherwise
--                      per PO in expected_inbound, ordered or
--                      partially_received, the item's remaining =
--                      sum(greatest(ordered - received, 0)) over its lines (an
--                      over-received line floors at 0); POs with nothing
--                      remaining are left out. Rows (at most 10, earliest
--                      expected_at first, no date last) only where
--                      purchase_order_visible(po); `truncated` and
--                      `truncatedRemaining` disclose visible rows past 10;
--                      hidden POs add to hiddenRemaining (a quantity only).
--   drafts             the same over 'draft' POs. Drafts are never supply.
--   onHand             inventory_items.quantity_on_hand.
--   order.timeZone     organizations.timezone of the order's org: the zone the
--                      needed-by's calendar day is read in. A PO's expected_at
--                      is a calendar date (the PO form saves the typed day as
--                      midnight UTC), so core compares the PO's UTC day with
--                      the needed-by's day in this zone, never the instants.
--
-- ── WHO MAY CALL, AND WHY SECURITY DEFINER ─────────────────────────────────
-- The facts are aggregates over rows a caller may not read row by row:
-- holdings in other warehouses (item_stock_levels_select, 0371), other orders'
-- holds and lines, and POs they cannot open. A SECURITY INVOKER version would
-- silently return partial sums for a warehouse-scoped member, and a partial
-- sum is a wrong answer that looks right. So it is SECURITY DEFINER with its
-- gates in its own body (the 0346 class, INV-25), in this order:
--   1. auth.uid() null: 42501 unauthenticated.
--   2. the order missing, or the caller not an accepted, enabled member of its
--      org (is_org_member): P0002 order_request_not_found. The same answer for
--      both, so existence is not disclosed.
--   3. module_enabled(org, 'orders') false: P0001 module_disabled (hint
--      module_disabled).
--   4. more than 200 lines: { ..., linesCapped: true, lines: [], items: [] }.
--      Never a partial answer.
--   5. phase not to_pick: order and lines only.
-- Per field: numbers only for items the caller can read (caller_can_read_item,
-- the inventory_items_select predicate); PO numbers, statuses and dates only
-- where purchase_order_visible; other pending demand only for approvers;
-- other warehouses' stock as totals only, never per location.
-- EXECUTE to authenticated and service_role (a service-role call has no
-- auth.uid() and gets 42501).
--
-- STABLE: every statement shares the caller's snapshot, so the facts are one
-- consistent moment. It never raises 40001 or 40P01 (0367).
--
-- ── FROZEN ─────────────────────────────────────────────────────────────────
-- approve_order_request, approve_partial, resume_fulfillment, close_partial,
-- complete_picking, partial_pick_line, reopen_picking, cancel_order_request,
-- confirm_order_signature, confirm_physical_signature, create_order_request,
-- save_purchase_order_draft, next_po_number, post_receipt_v2,
-- ledger.apply_level_delta_for, ledger.adjust_stock, ledger.transfer_stock,
-- tg_order_requests_insert_guard, tg_order_request_lines_guard,
-- caller_can_read_item, location_holdings_visible and every policy are
-- untouched (pgTAP 0377 pins their md5). Both functions are new; nothing calls
-- them but the new app code.
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- CREATE FUNCTION, COMMENT, GRANT and REVOKE only: catalog-only, no table
-- lock. lock_timeout makes the push fail fast instead of queueing (retry is
-- the remedy).

-- PLAIN `set`, not `set local` (0303/0358/0370/0374). Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. purchase_order_visible
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.purchase_order_visible(p_po_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((
    select public.is_org_member(po.organization_id)
       and po.organization_id in (select public.rls_orgs_with_permission('purchase_orders:read'))
       and (public.has_org_role(po.organization_id, 'manager')
            or po.destination_location_id is null
            or exists (
                 select 1
                   from public.locations l
                  where l.id = po.destination_location_id
                    -- locations_select, which the policy's own read of the
                    -- location is subject to when it runs as the caller.
                    and public.is_org_member(l.organization_id)
                    and (l.warehouse_id is null
                         or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw))))
      from public.purchase_orders po
     where po.id = p_po_id), false);
$$;

revoke all on function public.purchase_order_visible(uuid) from public, anon;
grant execute on function public.purchase_order_visible(uuid) to authenticated, service_role;

comment on function public.purchase_order_visible(uuid) is
  'F2-1 (0377): whether the caller could open this purchase order: '
  'purchase_orders_select restated for one row (member of its org, the org in '
  'rls_orgs_with_permission(''purchase_orders:read''), and manager, or no '
  'destination, or a destination location with no warehouse or a warehouse in '
  'my_warehouse_ids()). False for an unknown or foreign PO or no caller. '
  'SECURITY INVOKER; answers as the caller inside a SECURITY DEFINER body too. '
  'pgTAP 0377 holds it equal to the policy for every persona and PO of its '
  'fixture.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. order_readiness_facts
-- ═══════════════════════════════════════════════════════════════════════════
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

  v_approver  := public.has_org_role(v_org, 'manager')
                 or public.has_permission(v_org, 'orders:approve');
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

revoke all on function public.order_readiness_facts(uuid) from public, anon;
grant execute on function public.order_readiness_facts(uuid) to authenticated, service_role;

comment on function public.order_readiness_facts(uuid) is
  'F2-1 (0377): the raw facts behind one order''s readiness as one jsonb value '
  '(v 1, additive changes only): the order (with its org''s time zone), its '
  'lines in (created_at, id) '
  'order, and per item on hand, holds (own, other orders, rentals), holdings '
  'here by kind (NULL kind = Site) and elsewhere as numbers only, Staging '
  'sources the caller''s holdings scope covers, other pending demand (approvers '
  'only), other committed orders'' shortfall, and open and draft PO remaining '
  '(purchase_orders module only; PO references only where '
  'purchase_order_visible). Items the caller cannot read carry no numbers. '
  'Gates in its body: signed in (42501), member of the order''s org (P0002 '
  'order_request_not_found, the same for a missing order), the orders module '
  '(P0001 module_disabled); more than 200 lines returns linesCapped with no '
  'lines; outside the to_pick phase, order and lines only. SECURITY DEFINER, '
  'STABLE, read-only. Judgement lives in packages/core/src/orders/readiness.ts.';

reset lock_timeout;
