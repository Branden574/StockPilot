-- 0385_order_shortfall_po.sql
--
-- F2-5 (Order Readiness, lean): "Draft a PO for the short lines only". Four
-- functions, their grants and their comments. No table, column, index,
-- policy or data change.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- Readiness (0377, core readiness.ts) already says, per item of an order, how
-- much of what it owes is short: not covered by stock, and not already on an
-- open PO or a draft. A buyer who wanted to order exactly that had to copy the
-- numbers into a new PO by hand, one supplier at a time, and nothing stopped
-- two buyers (or a buyer and the daily auto-reorder) from ordering the same
-- shortfall twice.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. order_line_owed(requested, fulfilled) and
--      order_available_to_order(on hand, held for others): the two floors
--      core uses (lineOwedUnits; stockAvailability's available), as SQL:
--      greatest(coalesce(a, 0) - coalesce(b, 0), 0). IMMUTABLE.
--   2. order_shortfall_draftable(facts): per item of one
--      order_readiness_facts answer, how much may be drafted, core's
--      `draftable` (readiness.ts itemQuantities) restated:
--        D  = sum of order_line_owed over the item's lines
--        A  = order_available_to_order(onHand, heldOtherOrders + heldRentals)
--             (this order's own hold is supply)
--        short0    = D - least(D, A)
--        inbound   = sum(inbound.rows.remaining) + inbound.truncatedRemaining
--                    + inbound.hiddenRemaining
--        drafts    = the same over drafts
--        C         = committedOtherShortfall
--        draftable = greatest(short0 - greatest(inbound + drafts - C, 0), 0)
--      and 0 with a refusal for an item that may not be drafted: not_visible
--      (the caller cannot read it), item_deleted, item_moved (it belongs to
--      another warehouse than the order), kit_stock (a kit's pre-assembled
--      stock), po_module_off (no inbound facts). Pure: it reads nothing but
--      its argument. The shared fixture (packages/core/src/orders/
--      readiness-parity-cases.json) holds it equal to core (pgTAP 0385 P).
--   3. draft_order_shortfall_pos(order, lines, idempotency key): drafts
--      purchase orders for exactly the quantities asked, one per supplier
--      plus one with no supplier, all or nothing (below).
--
-- ── draft_order_shortfall_pos ──────────────────────────────────────────────
-- p_lines: [{item_id: uuid string, quantity: JSON number}], 1 to 200 lines,
-- one per item. Each quantity is taken on the quantity columns' grid
-- (round(q, 4)) and must be above 0.
--
-- Steps:
--   1. FLOORS, in its own body, in this order:
--        signed in, else 42501 unauthenticated;
--        the order readable under RLS (order_requests_select) and the caller
--        an accepted, enabled member of its org (is_org_member), else P0002
--        order_request_not_found (a missing and a foreign order read the same);
--        module_enabled for orders AND purchase_orders, else P0001
--        module_disabled (detail: the module);
--        has_org_role(org, 'manager') (idempotency_keys_write is manager-only:
--        pattern #4), else 42501 forbidden, hint manager_required;
--        has_permission(org, 'purchase_orders:manage'), else 42501 forbidden,
--        hint purchase_orders_manage;
--        user_can_access_inventory(caller, order warehouse, null, 'write'),
--        else 42501 forbidden, hint warehouse_write. (Today it answers true
--        for every manager of the org whatever their assignment rows, as
--        0383 G12 pins: there is no warehouse-scoped manager. Kept as the
--        floor the service asserts too.)
--   2. ARGUMENTS: the key is required and at most 200 characters (22023
--      idempotency_key_required / idempotency_key_too_long); p_lines as above
--      (22023 line_invalid: not an array, empty, more than 200, a line that is
--      not an object, an item that is not a uuid string, a quantity that is
--      not a JSON number or not above 0 after rounding, an item twice).
--   3. IDEMPOTENCY (the 0372 pattern), scope order_shortfall_po, request
--      hash = md5 of the order id and the item:quantity pairs in item order.
--      INSERT ... ON CONFLICT DO NOTHING, so a second call with the same key
--      waits for the first and then reads its committed row: the same hash
--      and completed returns the stored answer with replay: true; another
--      hash, or a key not completed, is P0001 idempotency_conflict. The key
--      row commits or rolls back with the drafts.
--   4. THE REORDER LOCK: pg_advisory_xact_lock(hashtextextended(
--      'save_purchase_order_draft:reorder:' || org, 0)), the very lock the
--      reorder drafts take (0366: the button, the AI tool and the daily
--      auto-reorder). Shortfall drafts and reorder drafts of one
--      organization therefore run one at a time, and each sees the lines the
--      one before it committed. lock_timeout 5s: past it, 55P03 (retryable).
--   5. RECOMPUTE, in statements that start after the lock is granted (so in
--      snapshots that see what the run before committed):
--      order_readiness_facts(order), then order_shortfall_draftable of it.
--        phase not to_pick, or more than 200 lines: P0001
--        readiness_not_applicable (detail: the order's status);
--        an item not on the order: 22023 line_not_on_order (detail: the item);
--        an item that may not be drafted (not visible, deleted, moved, kit):
--        P0001 item_not_draftable (detail: {item: refusal});
--        ANY quantity above its draftable: P0001 shortfall_changed, detail =
--        the current draftable of every item on the order the caller can
--        read, as JSON ({item: number}). NEVER CLAMPED: a buyer who asked for
--        12 when 8 is draftable gets nothing and the new numbers, not 8.
--   6. THE DRAFTS: the lines grouped by the item's supplier (supplier_id and
--      unit_cost read under the caller's RLS in one statement; an item that
--      read does not return is item_not_draftable), in supplier-id order,
--      the items with no supplier last as one draft. For each group:
--      next_po_number(org) and save_purchase_order_draft(org, null, number,
--      supplier, no destination, no charter, no expected date,
--      'Short on SO-000123 when drafted', lines {item_id, quantity_ordered,
--      unit_cost = the item's cost}, no custom items, no actor (auth.uid()
--      is recorded), p_skip_items_on_open_po false: this function has
--      already decided under the same lock). Drafts are never sent.
--   7. The key is marked completed with the answer.
--
-- Answer: {orderId, orderNumber, created: [{purchaseOrderId, poNumber,
-- supplierId, lineCount, units, lines: [{itemId, quantity}]}], replay}.
-- The stored answer is the same without `replay`. Ids and numbers only: no
-- cost, no name.
--
-- ALL OR NOTHING. No exception is caught here. Any refusal from
-- save_purchase_order_draft (po_line_bundle, po_line_deleted, po_not_in_org,
-- po_line_invalid), a PO number taken meanwhile (23505:
-- next_po_number counts), a lock wait past 5 s (55P03) or the role's
-- statement_timeout (57014) aborts the call: every draft of this call and
-- the key roll back, so a retry with the same key is safe.
-- It never raises 40001 or 40P01 (0367; PostgREST retries 40001 forever).
-- Nothing is emailed or notified here: a PO create sends nothing (the web
-- service dispatches the po.created integration event per PO, as every
-- other draft create does).
--
-- SECURITY INVOKER, so purchase_orders_write, purchase_order_items_write,
-- idempotency_keys_write and the 0359/0360/0364 PO guards (a new PO is a
-- draft, lines only into a draft, the database records the creator) apply
-- exactly as for PurchaseOrdersService.create(). Its body never names the
-- holdings table (INV-33): every stock number comes from
-- order_readiness_facts (SECURITY DEFINER, gated in its own body).
-- EXECUTE to authenticated only (a service-role call has no auth.uid()).
--
-- ── FROZEN ─────────────────────────────────────────────────────────────────
-- approve_order_request, approve_partial, resume_fulfillment, close_partial,
-- complete_picking, partial_pick_line, reopen_picking, cancel_order_request,
-- hold_order_stock, order_readiness_facts, revise_order_needed_by,
-- save_purchase_order_draft, next_po_number, post_receipt_v2 (public and
-- ledger), ledger.*, caller_can_read_item, the PO guards of 0359/0360/0364,
-- the 0366 reorder functions, the 0380/0381/0382/0384 objects and every
-- policy are untouched (pgTAP 0385 Z pins them).
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- CREATE FUNCTION, COMMENT, GRANT and REVOKE only: catalog-only, no table
-- lock. lock_timeout makes the push fail fast instead of queueing (retry is
-- the remedy). Nothing calls the new functions but the new app code.

-- PLAIN `set`, not `set local` (0303/0358/0370/0374/0377/0378/0383). Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The floors core uses
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.order_line_owed(p_requested numeric, p_fulfilled numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = public
as $$
  select greatest(coalesce(p_requested, 0) - coalesce(p_fulfilled, 0), 0)
$$;

revoke all on function public.order_line_owed(numeric, numeric) from public, anon;
grant execute on function public.order_line_owed(numeric, numeric) to authenticated, service_role;

comment on function public.order_line_owed(numeric, numeric) is
  'F2-5 (0385): what an order line still owes, greatest(requested - fulfilled, 0) with nulls as 0. '
  'The SQL twin of core lineOwedUnits. IMMUTABLE.';

create or replace function public.order_available_to_order(p_on_hand numeric, p_held_for_others numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = public
as $$
  select greatest(coalesce(p_on_hand, 0) - coalesce(p_held_for_others, 0), 0)
$$;

revoke all on function public.order_available_to_order(numeric, numeric) from public, anon;
grant execute on function public.order_available_to_order(numeric, numeric) to authenticated, service_role;

comment on function public.order_available_to_order(numeric, numeric) is
  'F2-5 (0385): what is available to one order, greatest(on hand - held for other orders and rentals, 0) '
  'with nulls as 0 (the order''s own hold is supply). The SQL twin of core readiness A. IMMUTABLE.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. order_shortfall_draftable: core's draftable, over one facts answer
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.order_shortfall_draftable(p_facts jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = public
as $$
  with lines as (
    select l->>'itemId' as item_id,
           public.order_line_owed((l->>'requested')::numeric, (l->>'fulfilled')::numeric) as owed
      from jsonb_array_elements(
             case when jsonb_typeof(p_facts->'lines') = 'array' then p_facts->'lines' else '[]'::jsonb end) l
  ),
  demand as (
    select x.item_id, sum(x.owed) as d
      from lines x
     group by x.item_id
  ),
  items as (
    select it->>'itemId' as item_id, it
      from jsonb_array_elements(
             case when jsonb_typeof(p_facts->'items') = 'array' then p_facts->'items' else '[]'::jsonb end) it
  ),
  judged as (
    select i.item_id,
           i.it,
           coalesce(dm.d, 0) as d,
           case
             when (i.it->'visible') is distinct from 'true'::jsonb then 'not_visible'
             when (i.it->'deleted') = 'true'::jsonb then 'item_deleted'
             when (i.it->>'itemWarehouseId') is distinct from (p_facts->'order'->>'warehouseId') then 'item_moved'
             when (i.it->'isBundle') = 'true'::jsonb then 'kit_stock'
             when jsonb_typeof(i.it->'inbound') is distinct from 'object'
               or jsonb_typeof(i.it->'drafts') is distinct from 'object' then 'po_module_off'
           end as refusal
      from items i
      left join demand dm on dm.item_id = i.item_id
  ),
  numbers as (
    select j.item_id,
           j.refusal,
           case when j.refusal = 'not_visible' then null else j.it->>'supplierId' end as supplier_id,
           case when j.refusal is not null then 0::numeric else
             greatest(
               (j.d - least(j.d, public.order_available_to_order(
                                   (j.it->>'onHand')::numeric,
                                   coalesce((j.it->>'heldOtherOrders')::numeric, 0)
                                     + coalesce((j.it->>'heldRentals')::numeric, 0))))
               - greatest(
                   (select coalesce(sum((r->>'remaining')::numeric), 0)
                      from jsonb_array_elements(j.it->'inbound'->'rows') r)
                   + coalesce((j.it->'inbound'->>'truncatedRemaining')::numeric, 0)
                   + coalesce((j.it->'inbound'->>'hiddenRemaining')::numeric, 0)
                   + (select coalesce(sum((r->>'remaining')::numeric), 0)
                        from jsonb_array_elements(j.it->'drafts'->'rows') r)
                   + coalesce((j.it->'drafts'->>'truncatedRemaining')::numeric, 0)
                   + coalesce((j.it->'drafts'->>'hiddenRemaining')::numeric, 0)
                   - coalesce((j.it->>'committedOtherShortfall')::numeric, 0),
                   0),
               0)
           end as draftable
      from judged j
  )
  select coalesce(jsonb_object_agg(n.item_id, jsonb_build_object(
           'draftable',  trim_scale(n.draftable),
           'supplierId', n.supplier_id,
           'refusal',    n.refusal)), '{}'::jsonb)
    from numbers n
   where n.item_id is not null
$$;

revoke all on function public.order_shortfall_draftable(jsonb) from public, anon;
grant execute on function public.order_shortfall_draftable(jsonb) to authenticated, service_role;

comment on function public.order_shortfall_draftable(jsonb) is
  'F2-5 (0385): per item of one order_readiness_facts answer, what may be drafted for the order: core '
  'draftable restated (greatest(short - greatest(open PO + draft remaining - other orders'' committed '
  'shortfall, 0), 0), short = owed - least(owed, on hand - holds of other orders and rentals)), as '
  '{itemId: {draftable, supplierId, refusal}}; refusal not_visible | item_deleted | item_moved | kit_stock | '
  'po_module_off gives draftable 0. Pure (reads only its argument). pgTAP 0385 holds it equal to core over '
  'the shared readiness fixture.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. draft_order_shortfall_pos
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.draft_order_shortfall_pos(
  p_order_id        uuid,
  p_lines           jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_scope     constant text    := 'order_shortfall_po';
  c_max_lines constant integer := 200;
  v_uid       uuid := auth.uid();
  v_key       text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_org       uuid;
  v_wh        uuid;
  v_order_no  bigint;
  v_lines     jsonb;
  v_n         integer;
  v_hash      text;
  v_key_id    uuid;
  v_prev      record;
  v_facts     jsonb;
  v_calc      jsonb;
  v_bad       text;
  v_detail    jsonb;
  v_items     jsonb;
  v_so        text;
  v_notes     text;
  v_group     record;
  v_no        text;
  v_saved     jsonb;
  v_created   jsonb := '[]'::jsonb;
  v_result    jsonb;
begin
  -- ── 1. Floors ────────────────────────────────────────────────────────────
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Read under the caller's RLS (order_requests_select: members). A missing
  -- order and another org's order read the same.
  select o.organization_id, o.warehouse_id, o.order_number
    into v_org, v_wh, v_order_no
    from public.order_requests o
   where o.id = p_order_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;

  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled', detail = 'orders';
  end if;
  if not public.module_enabled(v_org, 'purchase_orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled', detail = 'purchase_orders';
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501', hint = 'manager_required';
  end if;
  if not public.has_permission(v_org, 'purchase_orders:manage') then
    raise exception 'forbidden' using errcode = '42501', hint = 'purchase_orders_manage';
  end if;
  if not public.user_can_access_inventory(v_uid, v_wh, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;

  -- ── 2. Arguments ─────────────────────────────────────────────────────────
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;
  if char_length(v_key) > 200 then
    raise exception 'idempotency_key_too_long' using errcode = '22023', hint = 'idempotency_key_too_long';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > c_max_lines then
    raise exception 'line_invalid' using errcode = '22023', hint = 'line_invalid';
  end if;
  -- Shape first, each cast behind its type test (CASE, not OR: OR does not
  -- promise evaluation order).
  if exists (
    select 1
      from jsonb_array_elements(p_lines) as e(l)
     where case
             when jsonb_typeof(l) <> 'object' then true
             when jsonb_typeof(l->'item_id') is distinct from 'string'
               or (l->>'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then true
             when jsonb_typeof(l->'quantity') is distinct from 'number' then true
             else round((l->>'quantity')::numeric, 4) <= 0
           end
  ) then
    raise exception 'line_invalid' using errcode = '22023', hint = 'line_invalid';
  end if;

  -- One line per item, in item order, each quantity on the columns' grid.
  select coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'quantity', x.qty) order by x.item_id), '[]'::jsonb),
         count(distinct x.item_id)
    into v_lines, v_n
    from (select (l->>'item_id')::uuid as item_id,
                 trim_scale(round((l->>'quantity')::numeric, 4)) as qty
            from jsonb_array_elements(p_lines) as e(l)) x;
  if v_n <> jsonb_array_length(p_lines) then
    raise exception 'line_invalid' using errcode = '22023', hint = 'line_invalid';
  end if;

  -- ── 3. Idempotency (the 0372 pattern) ────────────────────────────────────
  select md5(c_scope || '|' || p_order_id::text || '|'
             || string_agg((l->>'item_id') || ':' || (l->>'quantity'), ',' order by l->>'item_id'))
    into v_hash
    from jsonb_array_elements(v_lines) as e(l);

  insert into public.idempotency_keys as k
    (organization_id, scope, key, request_hash, status, resource_type, resource_id)
  values
    (v_org, c_scope, v_key, v_hash, 'in_progress', 'order_request', p_order_id)
  on conflict (organization_id, scope, key) do nothing
  returning k.id into v_key_id;

  if v_key_id is null then
    -- A new statement: it sees the row the other call committed.
    select k.request_hash, k.status, k.response
      into v_prev
      from public.idempotency_keys k
     where k.organization_id = v_org
       and k.scope = c_scope
       and k.key = v_key;
    if not found
       or v_prev.request_hash is distinct from v_hash
       or v_prev.status is distinct from 'completed'
       or jsonb_typeof(v_prev.response) is distinct from 'object' then
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    return v_prev.response || jsonb_build_object('replay', true);
  end if;

  -- ── 4. The reorder drafts' lock (0366), held to commit ───────────────────
  perform pg_advisory_xact_lock(
    hashtextextended('save_purchase_order_draft:reorder:' || v_org::text, 0));

  -- ── 5. Recompute, after the lock ─────────────────────────────────────────
  v_facts := public.order_readiness_facts(p_order_id);

  if v_facts->>'phase' is distinct from 'to_pick' or (v_facts->'linesCapped') = 'true'::jsonb then
    raise exception 'readiness_not_applicable'
      using errcode = 'P0001', hint = 'readiness_not_applicable',
            detail = coalesce(v_facts->'order'->>'status', '');
  end if;

  select l->>'item_id'
    into v_bad
    from jsonb_array_elements(v_lines) as e(l)
   where not exists (select 1
                       from jsonb_array_elements(v_facts->'lines') as f(fl)
                      where (fl->>'itemId')::uuid = (l->>'item_id')::uuid)
   order by 1
   limit 1;
  if v_bad is not null then
    raise exception 'line_not_on_order' using errcode = '22023', hint = 'line_not_on_order', detail = v_bad;
  end if;

  v_calc := public.order_shortfall_draftable(v_facts);

  if exists (select 1 from jsonb_array_elements(v_lines) as e(l)
              where v_calc->(l->>'item_id')->>'refusal' = 'po_module_off') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled', detail = 'purchase_orders';
  end if;

  select jsonb_object_agg(l->>'item_id', coalesce(v_calc->(l->>'item_id')->>'refusal', 'not_visible'))
    into v_detail
    from jsonb_array_elements(v_lines) as e(l)
   where (v_calc->(l->>'item_id')->>'refusal') is not null
      or (v_calc->(l->>'item_id')) is null;
  if v_detail is not null then
    raise exception 'item_not_draftable'
      using errcode = 'P0001', hint = 'item_not_draftable', detail = v_detail::text;
  end if;

  -- Over the limit: refused with the current numbers, never clamped.
  if exists (select 1 from jsonb_array_elements(v_lines) as e(l)
              where (l->>'quantity')::numeric > (v_calc->(l->>'item_id')->>'draftable')::numeric) then
    select coalesce(jsonb_object_agg(c.key, c.value->'draftable'), '{}'::jsonb)
      into v_detail
      from jsonb_each(v_calc) c
     where c.value->>'refusal' is distinct from 'not_visible';
    raise exception 'shortfall_changed'
      using errcode = 'P0001', hint = 'shortfall_changed', detail = v_detail::text;
  end if;

  -- ── 6. The drafts ────────────────────────────────────────────────────────
  -- Each item's supplier and cost, under the caller's RLS, in one statement.
  select coalesce(jsonb_object_agg(i.id::text, jsonb_build_object(
           'supplierId', i.supplier_id, 'unitCost', coalesce(i.unit_cost, 0))), '{}'::jsonb)
    into v_items
    from public.inventory_items i
   where i.organization_id = v_org
     and i.id in (select (l->>'item_id')::uuid from jsonb_array_elements(v_lines) as e(l));

  select jsonb_object_agg(l->>'item_id', 'not_visible')
    into v_detail
    from jsonb_array_elements(v_lines) as e(l)
   where (v_items->(l->>'item_id')) is null;
  if v_detail is not null then
    raise exception 'item_not_draftable'
      using errcode = 'P0001', hint = 'item_not_draftable', detail = v_detail::text;
  end if;

  -- The order's handle as core prints it (formatOrderNumber: at least six
  -- digits, never cut; the id's first 8 characters when it has no number).
  v_so := case
            when coalesce(v_order_no, 0) > 0
              then 'SO-' || case when char_length(v_order_no::text) >= 6 then v_order_no::text
                                 else lpad(v_order_no::text, 6, '0') end
            else upper(left(p_order_id::text, 8))
          end;
  v_notes := 'Short on ' || v_so || ' when drafted';

  for v_group in
    select g.supplier_id,
           jsonb_agg(jsonb_build_object(
             'item_id',          g.item_id,
             'quantity_ordered', g.qty,
             'unit_cost',        g.unit_cost) order by g.item_id) as save_lines,
           jsonb_agg(jsonb_build_object('itemId', g.item_id, 'quantity', g.qty) order by g.item_id) as out_lines,
           count(*)::integer as line_count,
           trim_scale(sum(g.qty)) as units
      from (select (l->>'item_id')::uuid as item_id,
                   (l->>'quantity')::numeric as qty,
                   (v_items->(l->>'item_id')->>'supplierId')::uuid as supplier_id,
                   (v_items->(l->>'item_id')->>'unitCost')::numeric as unit_cost
              from jsonb_array_elements(v_lines) as e(l)) g
     group by g.supplier_id
     order by g.supplier_id nulls last
  loop
    -- A new statement per draft: it counts the draft made just before.
    v_no := public.next_po_number(v_org);
    v_saved := public.save_purchase_order_draft(
      v_org, null, v_no, v_group.supplier_id, null, null, null, v_notes,
      v_group.save_lines, '{}'::uuid[], null, false);
    if v_saved->>'id' is null then
      raise exception 'draft_order_shortfall_pos_internal: no purchase order was written'
        using errcode = 'P0001', hint = 'shortfall_po_internal';
    end if;
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'purchaseOrderId', v_saved->>'id',
      'poNumber',        v_no,
      'supplierId',      v_group.supplier_id,
      'lineCount',       v_group.line_count,
      'units',           v_group.units,
      'lines',           v_group.out_lines));
  end loop;

  -- ── 7. The key answers with this call's answer from now on ───────────────
  v_result := jsonb_build_object(
    'orderId',     p_order_id,
    'orderNumber', v_order_no,
    'created',     v_created);

  update public.idempotency_keys
     set status      = 'completed',
         response    = v_result,
         resource_id = p_order_id,
         updated_at  = now()
   where organization_id = v_org
     and scope = c_scope
     and key = v_key;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'draft_order_shortfall_pos_internal: idempotency key not recorded'
      using errcode = 'P0001', hint = 'shortfall_po_internal';
  end if;

  return v_result || jsonb_build_object('replay', false);
end;
$$;

revoke all on function public.draft_order_shortfall_pos(uuid, jsonb, text) from public, anon, service_role;
grant execute on function public.draft_order_shortfall_pos(uuid, jsonb, text) to authenticated;

comment on function public.draft_order_shortfall_pos(uuid, jsonb, text) is
  'F2-5 (0385): drafts purchase orders for exactly the quantities asked of an order''s shortfall, one per '
  'supplier plus one with no supplier, all or nothing. p_lines [{item_id, quantity}], 1 to 200, one per '
  'item. Floors in its body: signed in (42501), the order readable and the caller a member (P0002 '
  'order_request_not_found), the orders and purchase_orders modules (P0001 module_disabled), manager AND '
  'purchase_orders:manage AND write access to the order''s warehouse (42501 forbidden, hints '
  'manager_required, purchase_orders_manage, warehouse_write). Idempotent on p_idempotency_key (scope '
  'order_shortfall_po; replay returns the stored answer with replay true; another request with the key: '
  'P0001 idempotency_conflict). Takes the reorder drafts'' advisory lock (0366), then recomputes from '
  'order_readiness_facts: phase to_pick (P0001 readiness_not_applicable), items on the order (22023 '
  'line_not_on_order), draftable items (P0001 item_not_draftable), and every quantity at most its '
  'draftable (P0001 shortfall_changed, detail = current draftable per item; never clamped). Drafts via '
  'next_po_number and save_purchase_order_draft (no destination, charter or expected date; the item''s cost; '
  'notes "Short on SO-… when drafted"). Returns {orderId, orderNumber, created: [{purchaseOrderId, poNumber, '
  'supplierId, lineCount, units, lines}], replay}. SECURITY INVOKER (RLS and the PO guards apply), '
  'lock_timeout 5s, never 40001/40P01, EXECUTE to authenticated only.';

reset lock_timeout;
