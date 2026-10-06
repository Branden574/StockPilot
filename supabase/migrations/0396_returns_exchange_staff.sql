-- 0396_returns_exchange_staff.sql
--
-- RETURNS AND EXCHANGES, SLICE RX-2: exchanges for staff and the counter
-- (owner GO 2026-10-02, "implement it safely and properly"; plan
-- stockpilot-work/returns-exchange/plan.md sections 3.1.3, 3.1.4, 3.3, 3.6,
-- 3.7, 3.10 and 4 RX-2; brief sections 2, 4, 5, 7, 8, 9, 18-25, 29, 33, 34,
-- 36, 41-43). The migration number is a placeholder fixed at push time
-- (plan 1.3): no function body names it, so no fingerprint recorded here
-- changes when the file is renumbered. Lines this file adds to an RX-1 body
-- end in `-- RX-2`.
--
-- No existing row is written. Every statement below creates an object, adds
-- a nullable column, adds a constraint every existing row satisfies, replaces
-- an RX-1 hook body, replaces the list view with columns appended, or
-- replaces one trigger's definition (a WHEN clause; its function is
-- byte-identical).
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. public.return_exchange_lines: one row per returned line that asks for
--      a replacement (the request, written once and never changed, and the
--      current decision: requested, approved, declined, cancelled). Read by
--      every member (the returns posture); written only by the functions
--      below. return_decisions gains exchange_line_id and a shape check for
--      the exchange kinds.
--   2. order_requests.replacement_for_return_id: the RMA a replacement order
--      replaces items for, keyed to (returns.id, organization_id). At most one
--      live (not cancelled or denied) replacement per RMA. Server-owned: no
--      API role holds INSERT or UPDATE on it, a link guard refuses it on an
--      API insert, and nobody may change it once written.
--   3. The replacement order, built by _return_replacement_issue (SECURITY
--      DEFINER, no EXECUTE for anyone: the exchange functions call it as
--      their owner). It applies the rules of the order insert policy and both
--      order guards itself, copies the original's context, stamps each line's
--      cost from its item, and hands reservation to the unchanged
--      approve_partial in the same transaction. One replacement per approved
--      exchange revision: the RMA row lock, the revision check, the
--      idempotency key <rma>:<revision>, and the partial unique index.
--   4. The return-first gate (trg_order_requests_zz_replacement_status, WHEN
--      the order is a replacement): into pick_slip_generated only once the
--      RMA is received or closed, or a manager released it early with a
--      reason; into cancelled or denied only from an RMA function (the
--      transaction-bound stockpilot.return_exchange flag). It reads the RMA
--      and the release by key and takes no row lock.
--   5. A replacement's lines are fixed (an API-role line insert is refused).
--   6. The notify split: trg_order_requests_notify fires only for ordinary
--      orders (WHEN replacement_for_return_id is null; the function is
--      unchanged), and _notify_replacement_order_changes words the requester
--      pings of a replacement (silent on insert, approval, cancellation and
--      the picking statuses; at the counter only the hand-over speaks).
--   7. The exchange functions: change_return_replacement (substitution, and
--      a new replacement after a replacement cancel), cancel_return_replacement
--      (including a picked, staged or in-transit one: the picked batch goes
--      back to Staging through cancel_order_request's own drawn branch),
--      decline_return_replacement ("Close as return only" after a
--      replacement cancel, desk check F9), release_return_replacement_early
--      (it names the order the caller saw, F7), return_exchange_candidates (staff
--      search under the caller's RLS), return_exchange_options (the requester
--      tier, service role only), return_exchange_flags (the release and
--      counter facts the list view needs, for any member).
--   8. The RX-1 hooks get their bodies (create, approve, deny, cancel,
--      replay); the RX-1 returns API guard refuses a raw status change on an
--      RMA that carries an exchange. No gated public RX-1 body changes (the
--      preflight pins each one).
--   9. return_overview is replaced with the exchange columns appended after
--      deleted_users and the exchange status as one CASE between the
--      `-- exchange-status:begin/end` markers (core deep-equals its codes).
--
-- ── STOCK SEMANTICS ────────────────────────────────────────────────────────
-- Nothing here moves stock. Approval, substitution and early release only
-- create, hold, cancel or release orders through the unchanged order
-- functions: approve_partial holds least(requested, on hand minus every
-- active hold) and never goes negative; cancel_order_request releases every
-- hold and, for a picked batch not yet handed over, restocks exactly that
-- batch to Staging (0348). complete_picking draws the replacement with its
-- provenance. The returned unit still moves only at the RX-1 close.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- Lock order of every exchange function: (1) the RMA row FOR UPDATE, (2)
-- the live replacement order FOR UPDATE, classified only under that lock
-- (plan X-2), (3) when it will insert an order, the organization's
-- order-number advisory lock (assign_order_request_number's), (4) every item
-- it will name, FOR UPDATE in id order, BEFORE the first row naming one
-- (_return_lock_items, desk check F4: key-share locks from foreign-key checks
-- taken before approve_partial's FOR UPDATE would deadlock two writers), and
-- items in id order again inside approve_partial or cancel_order_request
-- (already held). The gate trigger reads the RMA without a lock
-- (generatePickSlip holds the order while an RMA cancel takes the RMA and
-- then the order). complete_picking takes the order and then items, never
-- the RMA: no cycle.
--
-- The functions (all plpgsql) lock no table, so they come first. Then one
-- NOWAIT prelude (0390's and RX-1's pattern) takes every table lock the rest
-- needs: ACCESS EXCLUSIVE on order_requests (ADD COLUMN), return_decisions
-- (ADD COLUMN, ADD CONSTRAINT) and the view return_overview (CREATE OR
-- REPLACE VIEW; locking a view also locks the tables it reads), SHARE ROW
-- EXCLUSIVE on organizations, returns, return_lines, inventory_items and
-- order_request_lines (the new foreign keys and triggers), ACCESS SHARE on
-- stock_reservations (the new view reads it; the mode blocks no reader or
-- writer), and ACCESS EXCLUSIVE on every table supautils.policy_grants lists
-- for this role (supautils takes those on any CREATE POLICY by postgres). A
-- busy table fails one attempt, its subtransaction releases what it took,
-- and the next attempt starts after 50 to 150 ms holding nothing, up to 40
-- attempts; then 55P03 and nothing is applied. No later statement locks a
-- table the prelude did not, so the file never waits while holding a lock
-- (scripts/db-concurrency/0396_migration_lock_footprint.sh). lock_timeout is
-- 5s for the file and 900ms after the prelude. Push off-peak: order readers
-- wait for the few milliseconds the file holds order_requests.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- 42501, P0001, P0002, 22023 and 55P03 only, each with a stable hint the app
-- maps (packages/core/src/returns/return-error-map.ts). No function here
-- raises the two retryable classes PostgREST would re-run forever (0367).

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- RX-2 replaces only RX-1's hook bodies and its returns API guard, and calls
-- the order functions unchanged. Every body it relies on, or replaces, must
-- be the one this file was written against (production head 0394,
-- 2026-10-05). Anything else is drift: stop before changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        -- The RX-1 gated public bodies (never restated here; they call the hooks).
        ('public.create_return_request(uuid,jsonb,uuid)',                    '36596e93f472b0f831a6a43bb316a294', true),
        ('public.create_requester_return_request(uuid,jsonb,uuid,jsonb)',     '157aebbe26a7baff32dd56755ab9025d', true),
        ('public.approve_return(uuid,integer,jsonb,boolean)',                 'edf25c49264c74d8597fa87d6260112b', true),
        ('public.deny_return(uuid,text)',                                     'f94e717d62b1e24df5e46fb83f305e1c', true),
        ('public.receive_return(uuid)',                                       'c44f3942d4ae1028ed86e6ad305866d0', true),
        ('public.cancel_return(uuid,integer,text)',                           '11e8be3e7f3fe7899c6c919311fbf9c1', true),
        ('public.plan_return_dispositions(uuid,jsonb)',                       'ba1399f851f4882a3e66b8f4c8763743', true),
        ('public.close_return(uuid,jsonb,bigint)',                            'dfdb2be52dfb3be08b42b0cdb6ca2d6e', true),
        ('public.return_restock_options(uuid)',                               '22f0eef799df683558507a42ea45a8d8', true),
        ('public._return_create_core(uuid,uuid,jsonb,text,uuid,text,text,text,text,uuid,jsonb)', '1240192080941e750bdf988a6ea37338', false),
        ('public._return_normalize_request(jsonb,text)',                      '8fd707818f66c9e7a7e8c69b41a4302e', false),
        ('public._return_plan_lines(uuid,uuid,jsonb,uuid,text,boolean,boolean)', 'ea001ac17ceb80e5b8383c6176b05648', false),
        ('ledger.process_return_disposition(uuid)',                           '69e46c8163600cb55ae70246ca3a85d3', true),
        ('public.process_return_disposition(uuid)',                           '7ec76cc98b9cefc31707590071ac14d9', false),
        -- The RX-1 bodies this file replaces (the hooks and the API guard).
        ('public._return_exchange_create(uuid,uuid,jsonb,jsonb)',             'a1b83c7a7af3bebcabb4f76d207171c3', false),
        ('public._return_exchange_approve(uuid,jsonb,uuid,integer)',          'be03f283bef9510f378f1ab9652086f0', false),
        ('public._return_exchange_on_deny(uuid,uuid)',                        'aea5a71ee0e7e1af429646c6daa78104', false),
        ('public._return_exchange_on_cancel(uuid,uuid,text)',                 '7c90077f509dd4acbe966b5c9ff0eb5d', false),
        ('public._return_exchange_replay(uuid,integer)',                      '30a3a0b41500ded40148cd068e47feb7', false),
        ('public.tg_returns_api_guard()',                                     '939caf073462bbaf237bcdc4f6f9dc9a', false),
        -- The order bodies the exchange functions call or rely on, unchanged.
        ('public._notify_order_request_changes()',                            'a223ae83810149728156b8e299c7425e', true),
        ('public._validate_order_request_status_transition()',                'dee8cd4782ec83abdb31a2b48fcd4ef2', false),
        ('public.create_order_request(jsonb,jsonb)',                          '4d65cef6c569a8c2c699fd9d5c8b77d5', false),
        ('public.tg_order_requests_insert_guard()',                           'caf69f8a23d03b9bfa6ea87a9cf94077', false),
        ('public.tg_order_request_lines_guard()',                             'd899924c0f8fc1dfae4e8be7bd4c5cad', false),
        ('public.tg_order_requests_workflow_guard()',                         '55bceafc13d599f8d77d6a4180c28140', false),
        ('public.approve_partial(uuid)',                                      '40ca0878733b08a649773fe9b7efd4e0', true),
        ('public.cancel_order_request(uuid,text)',                            '47cabcd1fe4f52fb7b2b6b6b64b68da1', true),
        ('public.complete_picking(uuid)',                                     'b8f1ef1fb01efa5c04c916c178129541', true),
        ('public.order_items_orderable(uuid,uuid[])',                         'b4df95d74e32850923a430769f96f246', false),
        ('public.caller_can_read_item(uuid)',                                 '80523d2cc0fafe7fc6b3599903d7f014', true)
      ) v(sig, want_src, want_secdef)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  -- The notify trigger this file gives a WHEN clause, as 0265 left it.
  if (select md5(pg_get_triggerdef(t.oid)) from pg_trigger t
       where t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'trg_order_requests_notify')
     is distinct from '8c7961ae9a724879f759cb412f283510' then
    v_bad := v_bad || ' trigger trg_order_requests_notify drifted;';
  end if;

  -- RX-1 (0394) comes first: its view, its decision log and its keys.
  if to_regclass('public.return_decisions') is null or to_regclass('public.return_overview') is null
     or to_regclass('public.returns_id_org_key') is null or to_regclass('public.return_lines_id_return_key') is null then
    v_bad := v_bad || ' the RX-1 objects are missing (push 0394 first);';
  end if;

  -- Already applied (or half applied by hand): every new name must be free.
  if to_regclass('public.return_exchange_lines') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'order_requests'
                   and column_name = 'replacement_for_return_id')
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'return_decisions'
                   and column_name = 'exchange_line_id')
     or to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)') is not null
     or to_regprocedure('public._return_replacement_issue(uuid,jsonb,integer,jsonb)') is not null then
    v_bad := v_bad || ' the RX-2 objects already exist;';
  end if;

  if v_bad <> '' then
    raise exception 'rx2_preflight: %', v_bad
      using errcode = '55000', hint = 'rx2_preflight';
  end if;
end
$preflight$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═════════════

-- ── 1a. Shared internals (SECURITY INVOKER, no API EXECUTE: they run inside
-- the DEFINER functions below, as postgres).

-- The requester tier (plan 3.6.10): for each source line of a handed-over
-- order whose item sits in a live product group of the order's organization,
-- the other variants a requester may ask for. A candidate is in the same
-- group and organization, a different variant (D3), in the order's
-- warehouse, in the same ownership charter, orderable (active, not deleted,
-- not awaiting its first receipt, not a rental, not a kit), not hidden (D4:
-- internal_only is offered), and for a portal order on the customer's
-- catalog with the customer active. Several rows of one variant collapse to
-- the one with the most free stock (then id). p_check_budget keeps only
-- lines with return budget left (the options read); the create checks the
-- line it has just written, whose own quantity already took that budget.
-- Never name matching, sizes from custom fields or size-run helpers.
create function public._return_exchange_requester_options(p_order_id uuid, p_check_budget boolean)
returns table (order_request_line_id uuid, returned_item_id uuid, item_id uuid, variant_key text, free numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org      uuid;
  v_wh       uuid;
  v_status   text;
  v_source   text;
  v_customer uuid;
  v_portal   boolean := false;
begin
  select o.organization_id, o.warehouse_id, o.status, o.source, o.customer_id
    into v_org, v_wh, v_status, v_source, v_customer
    from public.order_requests o where o.id = p_order_id;
  if v_org is null or v_status not in ('completed', 'delivered') then
    return;
  end if;
  if v_source = 'portal' then
    if v_customer is null or not exists (select 1 from public.customers c
                                          where c.id = v_customer and c.organization_id = v_org and c.status = 'active') then
      return;
    end if;
    v_portal := true;
  end if;

  return query
  with src as (
    select l.id as line_id, ri.id as rid, ri.group_id, ri.variant_key as rkey, ri.charter_id as rcharter
      from public.order_request_lines l
      join public.inventory_items ri on ri.id = l.item_id
      join public.product_groups g on g.id = ri.group_id
     where l.order_request_id = p_order_id
       and g.organization_id = v_org and g.deleted_at is null and g.status = 'active'
       and (not p_check_budget
            or coalesce(l.quantity_fulfilled, 0) - coalesce(l.returned_quantity, 0)
               - coalesce((select sum(rl.quantity) from public.return_lines rl
                             join public.returns r on r.id = rl.return_id
                            where rl.order_request_line_id = l.id and not rl.applied
                              and r.status not in ('cancelled', 'denied')), 0) > 0)
  ), cand as (
    select s.line_id, s.rid, c.id as cid, c.variant_key as ckey,
           c.quantity_on_hand - coalesce((select sum(sr.quantity) from public.stock_reservations sr
                                           where sr.item_id = c.id and sr.released_at is null), 0) as cfree
      from src s
      join public.inventory_items c on c.group_id = s.group_id
     where c.organization_id = v_org
       and c.id <> s.rid
       and c.variant_key is distinct from s.rkey
       and c.warehouse_id = v_wh
       and c.charter_id is not distinct from s.rcharter
       and c.deleted_at is null
       and c.status = 'active'
       and not coalesce(c.awaiting_first_receipt, false)
       and not coalesce(c.is_rental, false)
       and not coalesce(c.is_bundle, false)
       and c.public_visibility <> 'hidden'
       and (not v_portal or exists (select 1 from public.customer_catalog cc
                                     where cc.customer_id = v_customer and cc.item_id = c.id))
  )
  select distinct on (cand.line_id, coalesce(cand.ckey, cand.cid::text))
         cand.line_id, cand.rid, cand.cid, cand.ckey, cand.cfree
    from cand
   order by cand.line_id, coalesce(cand.ckey, cand.cid::text), cand.cfree desc, cand.cid;
end;
$$;

-- One helper for both tiers, used by the screens' reads and by the writes,
-- so what is offered is what is accepted (plan 3.6.2, 3.6.10). Staff: the
-- item is in the order's organization, orderable in the order's warehouse
-- (order_items_orderable, phone ordering's one rule; called as postgres, so
-- its not_visible reason never fires) and readable by the caller
-- (caller_can_read_item, which asks as auth.uid()). Requester: one of the
-- line's options. Any other tier answers false.
create function public._return_exchange_item_ok(
  p_order_id uuid, p_item_id uuid, p_tier text, p_order_line_id uuid default null)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_wh  uuid;
begin
  if p_order_id is null or p_item_id is null then
    return false;
  end if;
  select o.organization_id, o.warehouse_id into v_org, v_wh
    from public.order_requests o where o.id = p_order_id;
  if v_org is null then
    return false;
  end if;
  if p_tier = 'staff' then
    if not exists (select 1 from public.inventory_items ii where ii.id = p_item_id and ii.organization_id = v_org) then
      return false;
    end if;
    if public.order_items_orderable(v_wh, array[p_item_id]) <> '{}'::jsonb then
      return false;
    end if;
    return coalesce(public.caller_can_read_item(p_item_id), false);
  elsif p_tier = 'requester' then
    return p_order_line_id is not null and exists (
      select 1 from public._return_exchange_requester_options(p_order_id, false) o
       where o.order_request_line_id = p_order_line_id and o.item_id = p_item_id);
  end if;
  return false;
end;
$$;

-- A replacement order as the exchange screens and an approval replay show
-- it: number, status, and per line what was asked for and what is held now.
create function public._return_replacement_summary(p_order_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
           'orderId', o.id,
           'orderNumber', o.order_number,
           'status', o.status,
           'lines', coalesce(x.lines, '[]'::jsonb),
           'short', coalesce(x.short, false))
    into v
    from public.order_requests o
    left join lateral (
      select jsonb_agg(jsonb_build_object('itemId', l.item_id, 'orderLineId', l.id,
                                          'requested', trim_scale(l.quantity_requested),
                                          'held', trim_scale(h.held))
                       order by l.item_id, l.id) as lines,
             bool_or(h.held < l.quantity_requested - coalesce(l.quantity_fulfilled, 0)) as short
        from public.order_request_lines l
        cross join lateral (
          select coalesce(sum(sr.quantity), 0)::numeric as held
            from public.stock_reservations sr
           where sr.order_request_id = o.id and sr.item_id = l.item_id and sr.released_at is null) h
       where l.order_request_id = o.id) x on true
   where o.id = p_order_id;
  return v;
end;
$$;

-- What a live replacement is, read under the caller's row lock (plan 3.3.5):
-- undrawn (nothing picked out of stock and nothing handed over: approved,
-- pick slip, picking, a backorder that handed nothing over), drawn (picked
-- and not handed over: cancel_order_request's drawn branch restocks it to
-- Staging), or handed_over (completed, or ANY status once something was
-- handed over: a backorder, or one resumed into picking again; desk check
-- F2). A replacement that handed anything over is never cancelled or
-- changed from its RMA: a new replacement would send those units again.
create function public._return_replacement_class(p_order_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status    text;
  v_fulfilled numeric;
begin
  select o.status into v_status from public.order_requests o where o.id = p_order_id;
  select coalesce(sum(l.quantity_fulfilled), 0) into v_fulfilled
    from public.order_request_lines l where l.order_request_id = p_order_id;
  return case
    when v_status is null or v_status in ('cancelled', 'denied') then 'none'
    when v_status = 'completed' then 'handed_over'
    when v_fulfilled > 0 then 'handed_over'
    when v_status in ('picking_complete', 'packing_slip_generated', 'staged_for_pickup',
                      'staged_for_delivery', 'in_transit') then 'drawn'
    when v_status in ('pending_approval', 'approved', 'pick_slip_generated', 'picking_in_progress',
                      'backordered') then 'undrawn'
    else 'none'
  end;
end;
$$;

-- The units each exchange line already had handed over by this RMA's
-- replacements, live or cancelled (desk check F2). A replacement order
-- carries one line per item (the create merge rule), so the units its line
-- handed over are shared out among the exchange lines that order carried for
-- that item, in exchange-line id order, each up to what it was approved for
-- in that order (its exchange_approved decision). A re-issue sends only what
-- is left of the returned quantity after these units.
create function public._return_exchange_fulfilled(p_return_id uuid)
returns table (exchange_line_id uuid, fulfilled numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  return query
  with appr as (
    select distinct on (d.exchange_line_id, d.order_request_id)
           d.exchange_line_id, d.order_request_id, d.item_id, d.quantity
      from public.return_decisions d
     where d.return_id = p_return_id and d.kind = 'exchange_approved'
     order by d.exchange_line_id, d.order_request_id, d.seq desc
  ), shared as (
    select a.exchange_line_id, a.quantity,
           coalesce(l.quantity_fulfilled, 0) as line_fulfilled,
           coalesce(sum(a.quantity) over (partition by a.order_request_id, a.item_id
                                          order by a.exchange_line_id
                                          rows between unbounded preceding and 1 preceding), 0) as taken_before
      from appr a
      left join public.order_request_lines l on l.order_request_id = a.order_request_id and l.item_id = a.item_id
  )
  select s.exchange_line_id, coalesce(sum(greatest(0, least(s.quantity, s.line_fulfilled - s.taken_before))), 0)::numeric
    from shared s
   group by s.exchange_line_id;
end;
$$;

-- Cancel a replacement through the unchanged cancel_order_request, under the
-- exchange flag (plan 3.3.1): the flag holds THIS transaction's id only for
-- the one call, so the gate lets exactly this cancel through, and a value
-- left in a pooled session never matches a later transaction. The order's
-- cancel note is a fixed sentence: the staff reason stays in the decision
-- log, never on an order a requester can read (brief 28).
create function public._return_replacement_cancel_order(p_order_id uuid, p_return_number text, p_why text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_prev text := current_setting('stockpilot.return_exchange', true);
begin
  perform set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
  perform public.cancel_order_request(
    p_order_id,
    case p_why when 'changed' then 'Replacement changed in ' || coalesce(p_return_number, 'its RMA') || '.'
               when 'return_cancelled' then 'Return ' || coalesce(p_return_number, '') || ' was cancelled.'
               else 'Replacement cancelled in ' || coalesce(p_return_number, 'its RMA') || '.' end);
  perform set_config('stockpilot.return_exchange', coalesce(v_prev, ''), true);
end;
$$;

-- A reason as the exchange functions take it: trimmed, required, at most
-- p_max characters.
create function public._return_exchange_reason(p_reason text, p_max integer)
returns text
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v text := nullif(regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if v is null then
    raise exception 'reason_required' using errcode = 'P0001', hint = 'reason_required';
  end if;
  if length(v) > p_max then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'reason';
  end if;
  return v;
end;
$$;

-- A replacement quantity: a JSON number, whole, at least 1, at most the
-- returned quantity (brief 4: "Return 1, exchange for 5" is impossible; no
-- privileged exception). Null takes the default.
create function public._return_exchange_quantity(p_value jsonb, p_default numeric, p_max numeric)
returns numeric
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  if p_value is null or p_value = 'null'::jsonb then
    v := p_default;
  elsif jsonb_typeof(p_value) <> 'number' then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'quantity';
  else
    v := (p_value #>> '{}')::numeric;
  end if;
  if v is null or v <> trunc(v) or v < 1 then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'quantity';
  end if;
  if v > p_max then
    raise exception 'exchange_quantity_exceeds_return' using errcode = 'P0001', hint = 'exchange_quantity_exceeds_return',
      detail = jsonb_build_object('quantity', v, 'returned', trim_scale(p_max))::text;
  end if;
  return v;
end;
$$;

-- The lock order of every exchange function that writes a row naming an
-- item (desk check F4): the RMA row, the live replacement's row, then, when
-- it will insert an order, the organization's order-number lock (the
-- advisory lock assign_order_request_number takes at every order insert,
-- 0254: 'order_number:' || organization), then every item it names, FOR
-- UPDATE in id order, and only then the inserts. A foreign-key check takes a
-- key-share lock on each item a new row names, and approve_partial then
-- takes FOR UPDATE on them: two writers that both took key-share on one
-- item before either asked for FOR UPDATE would deadlock (40P01). Taking
-- the order-number lock first keeps create_order_request (which takes it,
-- then key-share on its items) and every exchange issuer in one order per
-- organization, as order numbers already are. Items of another
-- organization are never locked (the caller refuses them afterwards).
create function public._return_lock_items(p_org uuid, p_items uuid[], p_issues_order boolean)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_issues_order then
    perform pg_advisory_xact_lock(hashtext('order_number:' || p_org::text));
  end if;
  perform 1
     from public.inventory_items ii
    where ii.id = any (coalesce(p_items, '{}'::uuid[])) and ii.organization_id = p_org
    order by ii.id
      for update;
end;
$$;

-- ── 1b. The replacement order (plan 3.6.1-3.6.3) ──────────────────────────
-- SECURITY DEFINER on purpose, with EXECUTE for nobody: it inserts order
-- rows as postgres, which the insert guard and the insert policy do not
-- hold, so it applies their rules here itself, and only the exchange
-- functions (owned by postgres) call it. It is on the 0387 AL9d census of
-- DEFINER order inserters on purpose (critic K11).
--
-- p_lines [{itemId, quantity}] (merged per item here); p_options
-- {whenShort: refuse|backorder, fulfillmentType?, deliveryCharterId?}.
-- Header: the original's organization, warehouse, requester context and
-- fulfilment (or the approver's override); a portal original keeps its
-- customer and portal user (order_requests_identity_chk); a member requester
-- who is no longer an accepted, enabled member becomes an email-only
-- requester with their profile's name and email (D7). Never copied: notes,
-- internal notes, needed-by (D8), every workflow, token and signature
-- column. Lines: the line guard's rules (deleted, rental, awaiting first
-- receipt, kit; whole positive quantities) through the staff tier, the cost
-- stamped from the item (a DEFINER insert skips the line guard's snapshot),
-- price 0 for a portal order (D9). Then approve_partial, unchanged, in this
-- transaction (it runs only from pending_approval, so it holds once). Short
-- under whenShort refuse: P0001 replacement_unavailable, detail
-- [{itemId, needed, available}], and the caller's whole transaction rolls
-- back.
create function public._return_replacement_issue(
  p_return_id uuid, p_lines jsonb, p_revision integer, p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_user     uuid := auth.uid();
  v_org      uuid;
  v_ret_no   text;
  v_orig     public.order_requests%rowtype;
  v_when     text;
  v_ftype    text;
  v_site     uuid;
  v_site_st  text;
  v_source   text := 'internal';
  v_customer uuid;
  v_req_user uuid;
  v_name     text;
  v_email    text;
  v_deleted  timestamptz;
  v_merged   jsonb;
  v_id       uuid;
  v_short    jsonb;
  v_cname    text;
  l          record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select r.organization_id, r.return_number into v_org, v_ret_no
    from public.returns r where r.id = p_return_id;
  select o.* into v_orig
    from public.returns r
    join public.order_requests o on o.id = r.order_request_id and o.organization_id = r.organization_id
   where r.id = p_return_id;
  if v_org is null or v_orig.id is null then
    raise exception 'return_not_found' using errcode = 'P0002', hint = 'return_not_found';
  end if;

  -- Options.
  if p_options is not null and jsonb_typeof(p_options) not in ('object', 'null') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'replacement';
  end if;
  v_when := coalesce(nullif(p_options->>'whenShort', ''), 'refuse');
  if v_when not in ('refuse', 'backorder') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'whenShort';
  end if;
  v_ftype := coalesce(nullif(p_options->>'fulfillmentType', ''), v_orig.fulfillment_type, 'pickup');
  if v_ftype not in ('pickup', 'delivery') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'fulfillmentType';
  end if;
  if coalesce(p_options->'deliveryCharterId', 'null'::jsonb) <> 'null'::jsonb then
    if jsonb_typeof(p_options->'deliveryCharterId') <> 'string' or (p_options->>'deliveryCharterId') !~ c_uuid then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'deliveryCharterId';
    end if;
    v_site := (p_options->>'deliveryCharterId')::uuid;
  else
    v_site := v_orig.delivery_charter_id;
  end if;
  if v_ftype = 'delivery' then
    -- A delivery needs a site this warehouse serves, active
    -- (order_requests_delivery_target_chk; the pair is checked here because
    -- the database does not enforce it for orders). Five legacy deliveries
    -- have no site: the approver chooses one.
    select c.status into v_site_st
      from public.warehouse_charters wc
      join public.charters c on c.id = wc.charter_id
     where wc.warehouse_id = v_orig.warehouse_id and wc.charter_id = v_site and wc.organization_id = v_org;
    if v_site is null or v_site_st is distinct from 'active' then
      raise exception 'replacement_site_not_available' using errcode = 'P0001', hint = 'replacement_site_not_available',
        detail = case when v_site is null then 'no_site' when v_site_st is null then 'not_serviced' else 'inactive' end;
    end if;
  else
    v_site := null;
  end if;

  -- The requester (plan 3.6.2; judge B-1). A portal original whose customer
  -- is still active keeps its customer and its portal user (the portal shows
  -- the customer's orders; order_requests_identity_chk wants the portal user
  -- or the deletion stamp). A member requester stays while still an accepted,
  -- enabled member; one who left becomes an email-only requester with the
  -- profile's name and email (D7). A requester whose account was deleted
  -- (0388/0393) stays deleted: the stamp is carried over and nobody is
  -- written to (the order keeps no person, and its emails never go out).
  v_name  := v_orig.requester_name;
  v_email := v_orig.requester_email::text;
  if v_orig.source = 'portal' and v_orig.customer_id is not null
     and exists (select 1 from public.customers c
                  where c.id = v_orig.customer_id and c.organization_id = v_org and c.status = 'active') then
    v_source := 'portal';
    v_customer := v_orig.customer_id;
    v_req_user := v_orig.requester_user_id;
  elsif v_orig.requester_user_id is not null
        and exists (select 1 from public.organization_members m
                      join public.user_profiles p on p.id = m.user_id
                     where m.organization_id = v_org and m.user_id = v_orig.requester_user_id
                       and m.accepted_at is not null and p.disabled_at is null and p.deleted_at is null) then
    v_req_user := v_orig.requester_user_id;
  elsif v_orig.requester_user_id is not null then
    select coalesce(v_name, p.full_name), coalesce(v_email, p.email::text) into v_name, v_email
      from public.user_profiles p where p.id = v_orig.requester_user_id;
  end if;
  if v_req_user is null then
    v_deleted := v_orig.requester_deleted_at;
  end if;
  if v_req_user is null and v_deleted is null and (v_email is null or v_source = 'portal') then
    raise exception 'replacement_requester_unavailable' using errcode = 'P0001', hint = 'replacement_requester_unavailable';
  end if;

  -- Lines, merged per item (the create merge rule), each through the staff
  -- tier (the line guard's rules and the caller's item scope).
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0
     or exists (select 1 from jsonb_array_elements(p_lines) as x
                 where jsonb_typeof(x) <> 'object' or jsonb_typeof(x->'itemId') is distinct from 'string'
                    or (x->>'itemId') !~ c_uuid or jsonb_typeof(x->'quantity') is distinct from 'number') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'lines';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('itemId', m.item_id, 'quantity', m.qty) order by m.item_id), '[]'::jsonb)
    into v_merged
    from (select (x->>'itemId')::uuid as item_id, sum((x->>'quantity')::numeric) as qty
            from jsonb_array_elements(p_lines) as x
           group by 1) m;
  for l in select (x->>'itemId')::uuid as item_id, (x->>'quantity')::numeric as qty
             from jsonb_array_elements(v_merged) as x loop
    if l.qty is null or l.qty <> trunc(l.qty) or l.qty < 1 then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'quantity';
    end if;
    if not public._return_exchange_item_ok(v_orig.id, l.item_id, 'staff') then
      raise exception 'exchange_item_not_eligible' using errcode = 'P0001', hint = 'exchange_item_not_eligible';
    end if;
  end loop;

  -- The order-number lock, then every item FOR UPDATE in id order, before
  -- the order and lines are written (desk check F4; see _return_lock_items).
  perform public._return_lock_items(
    v_org, array(select (x->>'itemId')::uuid from jsonb_array_elements(v_merged) as x), true);

  begin
    insert into public.order_requests (
      organization_id, warehouse_id, source, customer_id, status,
      requester_user_id, requester_name, requester_email, requester_phone, requester_org_label, requester_deleted_at,
      fulfillment_type, delivery_charter_id, pickup_location_notes,
      replacement_for_return_id)
    values (
      v_org, v_orig.warehouse_id, v_source, v_customer, 'pending_approval',
      v_req_user, v_name, v_email, v_orig.requester_phone, v_orig.requester_org_label, v_deleted,
      v_ftype, v_site, case when v_ftype = 'pickup' then v_orig.pickup_location_notes end,
      p_return_id)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_cname = constraint_name;
    if v_cname = 'order_requests_live_replacement_uniq' then
      -- Another live replacement exists for this RMA: another decision won.
      raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed';
    end if;
    raise;
  end;

  insert into public.order_request_lines (order_request_id, item_id, quantity_requested, unit_cost_at_request, unit_price_at_request)
  select v_id, ii.id, (x->>'quantity')::numeric, coalesce(ii.unit_cost, 0),
         case when v_source = 'portal' then 0 end
    from jsonb_array_elements(v_merged) as x
    join public.inventory_items ii on ii.id = (x->>'itemId')::uuid
   order by ii.id;

  -- Reservation: approve_partial, called, not copied. Its own gate
  -- (orders:approve, as auth.uid()) applies.
  perform public.approve_partial(v_id);

  select coalesce(jsonb_agg(jsonb_build_object('itemId', l2.item_id, 'needed', trim_scale(l2.quantity_requested),
                                               'available', trim_scale(l2.held)) order by l2.item_id), '[]'::jsonb)
    into v_short
    from (select orl.item_id, orl.quantity_requested,
                 coalesce((select sum(sr.quantity) from public.stock_reservations sr
                            where sr.order_request_id = v_id and sr.item_id = orl.item_id and sr.released_at is null), 0) as held
            from public.order_request_lines orl where orl.order_request_id = v_id) l2
   where l2.held < l2.quantity_requested;
  if v_short <> '[]'::jsonb and v_when = 'refuse' then
    raise exception 'replacement_unavailable' using errcode = 'P0001', hint = 'replacement_unavailable',
      detail = v_short::text;
  end if;

  return public._return_replacement_summary(v_id) || jsonb_build_object('revision', p_revision);
end;
$$;

-- ── 1c. The RX-1 hooks, with their RX-2 bodies (plan 3.3.7). Same names,
-- signatures, return types, SECURITY INVOKER and search_path as RX-1; the
-- gated public bodies that call them are unchanged (preflight above).

-- Create (plan 3.3.6): a line carrying `exchange: {itemId?, quantity?, note?}`
-- gets its exchange row in the create's own transaction; its
-- exchange_requested decision is written right after the RMA's created
-- decision by tg_return_decisions_exchange_requested (desk check F9: the log
-- reads created first; _return_create_core, frozen, calls this hook before
-- it appends created). Staff tier for a staff create; the requester tier for a
-- token, portal or member create, where any miss answers the same
-- exchange_item_not_eligible whatever the cause (no oracle). No item means
-- "the warehouse will review" and needs a note. The quantity defaults to,
-- and is capped by, the line's return quantity.
create or replace function public._return_exchange_create(
  p_return_id uuid, p_order_id uuid, p_request jsonb, p_actor jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_org   uuid;
  v_tier  text := case when p_actor->>'kind' = 'staff' then 'staff' else 'requester' end;
  v_kind  text := case p_actor->>'kind' when 'staff' then 'staff' when 'portal_customer' then 'portal_customer' else 'requester' end;
  v_actor uuid;
  v_rl    record;
  v_item  uuid;
  v_qty   numeric;
  v_note  text;
  v_xl    uuid;
  l       jsonb;
  x       jsonb;
begin
  if jsonb_typeof(p_actor->'userId') = 'string' and (p_actor->>'userId') ~ c_uuid then
    v_actor := (p_actor->>'userId')::uuid;
  end if;
  select r.organization_id into v_org from public.returns r where r.id = p_return_id;

  for l in select y from jsonb_array_elements(coalesce(p_request->'lines', '[]'::jsonb)) as y
            where jsonb_typeof(y) = 'object' and coalesce(y->'exchange', 'null'::jsonb) <> 'null'::jsonb
            order by y->>'orderRequestLineId' loop
    x := l->'exchange';
    if jsonb_typeof(x) <> 'object'
       or exists (select 1 from jsonb_object_keys(x) k where k not in ('itemId', 'quantity', 'note')) then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchange';
    end if;
    select rl.id, rl.quantity, rl.order_request_line_id into v_rl
      from public.return_lines rl
     where rl.return_id = p_return_id and rl.order_request_line_id = (l->>'orderRequestLineId')::uuid;
    if not found then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'orderRequestLineId';
    end if;

    v_item := null;
    if coalesce(x->'itemId', 'null'::jsonb) <> 'null'::jsonb then
      if jsonb_typeof(x->'itemId') <> 'string' or (x->>'itemId') !~ c_uuid then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchange.itemId';
      end if;
      v_item := (x->>'itemId')::uuid;
    end if;
    v_note := null;
    if coalesce(x->'note', 'null'::jsonb) <> 'null'::jsonb then
      if jsonb_typeof(x->'note') <> 'string' then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchange.note';
      end if;
      v_note := nullif(regexp_replace(x->>'note', '^\s+|\s+$', '', 'g'), '');
      if length(v_note) > 500 then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchange.note';
      end if;
    end if;
    if v_item is null and v_note is null then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchange.note';
    end if;
    v_qty := public._return_exchange_quantity(x->'quantity', v_rl.quantity, v_rl.quantity);
    if v_item is not null and not public._return_exchange_item_ok(p_order_id, v_item, v_tier, v_rl.order_request_line_id) then
      raise exception 'exchange_item_not_eligible' using errcode = 'P0001', hint = 'exchange_item_not_eligible';
    end if;

    insert into public.return_exchange_lines (organization_id, return_id, return_line_id, requested_item_id,
                                              requested_quantity, request_note, requested_by_kind, requested_by)
    values (v_org, p_return_id, v_rl.id, v_item, v_qty, v_note, v_kind, v_actor)
    returning id into v_xl;
  end loop;
end;
$$;

-- Approve (plan 3.3.3 step 6). p_decision.exchange:
--   {exchangeLineId, action: 'approve', itemId?, quantity?, reason?}
--   {exchangeLineId, action: 'decline', reason}
--   {returnLineId,   action: 'add', itemId, quantity?, reason?}      (G9)
-- Every requested exchange line gets exactly one decision. Approve takes
-- the requested item unless staff choose another; a choice that differs
-- from a requested item is a substitution and needs a reason (kept with the
-- previous item). Every approved item passes the staff tier; every quantity
-- is whole, from 1 to the returned quantity. When anything is approved, ONE
-- replacement order carries every approved line (_return_replacement_issue:
-- created, held by approve_partial, short checked) at revision p_revision + 1.
-- The caller (approve_return) checked orders:approve before locking.
create or replace function public._return_exchange_approve(
  p_return_id uuid, p_decision jsonb, p_user uuid, p_revision integer)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_org     uuid;
  v_order   uuid;
  v_entries jsonb := '[]'::jsonb;
  v_seen    uuid[] := '{}';
  v_seen_rl uuid[] := '{}';
  v_approve jsonb := '[]'::jsonb;
  v_repl    jsonb;
  v_reason  text;
  v_item    uuid;
  v_qty     numeric;
  v_prev    uuid;
  v_xl      record;
  v_rl      record;
  v_new_xl  uuid;
  v_lock    uuid[];
  e         jsonb;
  a         jsonb;
begin
  if jsonb_typeof(p_decision->'exchange') = 'array' then
    v_entries := p_decision->'exchange';
  end if;
  select r.organization_id, r.order_request_id into v_org, v_order from public.returns r where r.id = p_return_id;

  -- Shape, ownership, one decision per line.
  for e in select x from jsonb_array_elements(v_entries) as x loop
    if jsonb_typeof(e) <> 'object' or coalesce(e->>'action', '') not in ('approve', 'decline', 'add') then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchange';
    end if;
    if e->>'action' in ('approve', 'decline') then
      if jsonb_typeof(e->'exchangeLineId') is distinct from 'string' or (e->>'exchangeLineId') !~ c_uuid then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchangeLineId';
      end if;
      if (e->>'exchangeLineId')::uuid = any (v_seen) then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'duplicate_line';
      end if;
      v_seen := v_seen || (e->>'exchangeLineId')::uuid;
      if not exists (select 1 from public.return_exchange_lines xl
                      where xl.id = (e->>'exchangeLineId')::uuid and xl.return_id = p_return_id
                        and xl.status = 'requested') then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchangeLineId';
      end if;
    else
      if jsonb_typeof(e->'returnLineId') is distinct from 'string' or (e->>'returnLineId') !~ c_uuid then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'returnLineId';
      end if;
      if (e->>'returnLineId')::uuid = any (v_seen_rl) then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'duplicate_line';
      end if;
      v_seen_rl := v_seen_rl || (e->>'returnLineId')::uuid;
      if not exists (select 1 from public.return_lines rl
                      where rl.id = (e->>'returnLineId')::uuid and rl.return_id = p_return_id)
         or exists (select 1 from public.return_exchange_lines xl where xl.return_line_id = (e->>'returnLineId')::uuid) then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'returnLineId';
      end if;
    end if;
  end loop;
  if exists (select 1 from public.return_exchange_lines xl
              where xl.return_id = p_return_id and xl.status = 'requested' and not (xl.id = any (v_seen))) then
    raise exception 'return_decision_incomplete' using errcode = 'P0001', hint = 'return_decision_incomplete';
  end if;

  -- Every item a row below names (approved, added, declined or replaced
  -- items), FOR UPDATE in id order, after the order-number lock when an order
  -- will be issued, before the first insert (desk check F4).
  select coalesce(array_agg(distinct t.item_id), '{}'::uuid[]) into v_lock
    from (select (x->>'itemId')::uuid as item_id
            from jsonb_array_elements(v_entries) as x
           where x->>'action' in ('approve', 'add') and jsonb_typeof(x->'itemId') = 'string' and (x->>'itemId') ~ c_uuid
          union
          select xl.requested_item_id
            from public.return_exchange_lines xl
           where xl.return_id = p_return_id and xl.status = 'requested' and xl.requested_item_id is not null) t;
  perform public._return_lock_items(
    v_org, v_lock, exists (select 1 from jsonb_array_elements(v_entries) as x where x->>'action' in ('approve', 'add')));

  for e in select x from jsonb_array_elements(v_entries) as x
            order by coalesce(x->>'exchangeLineId', x->>'returnLineId'), x::text loop
    if e->>'action' = 'decline' then
      v_reason := public._return_exchange_reason(e->>'reason', 1000);
      update public.return_exchange_lines
         set status = 'declined'
       where id = (e->>'exchangeLineId')::uuid
      returning id, return_line_id, requested_item_id, requested_quantity into v_xl;
      insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                           item_id, quantity, reason, actor_user_id, actor_kind)
      values (v_org, p_return_id, v_xl.return_line_id, v_xl.id, 'exchange_declined', 'staff',
              v_xl.requested_item_id, v_xl.requested_quantity, v_reason, p_user, 'staff');

    elsif e->>'action' = 'add' then
      select rl.id, rl.quantity into v_rl from public.return_lines rl where rl.id = (e->>'returnLineId')::uuid;
      if jsonb_typeof(e->'itemId') is distinct from 'string' or (e->>'itemId') !~ c_uuid then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'itemId';
      end if;
      v_item := (e->>'itemId')::uuid;
      v_qty := public._return_exchange_quantity(e->'quantity', v_rl.quantity, v_rl.quantity);
      if not public._return_exchange_item_ok(v_order, v_item, 'staff') then
        raise exception 'exchange_item_not_eligible' using errcode = 'P0001', hint = 'exchange_item_not_eligible';
      end if;
      v_reason := case when nullif(regexp_replace(coalesce(e->>'reason', ''), '^\s+|\s+$', '', 'g'), '') is null then null
                       else public._return_exchange_reason(e->>'reason', 1000) end;
      insert into public.return_exchange_lines (organization_id, return_id, return_line_id, requested_item_id,
                                                requested_quantity, requested_by_kind, requested_by)
      values (v_org, p_return_id, v_rl.id, v_item, v_qty, 'staff', p_user)
      returning id into v_new_xl;
      insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                           item_id, quantity, actor_user_id, actor_kind)
      values (v_org, p_return_id, v_rl.id, v_new_xl, 'exchange_requested', 'staff', v_item, v_qty, p_user, 'staff');
      v_approve := v_approve || jsonb_build_array(jsonb_build_object(
        'exchangeLineId', v_new_xl, 'returnLineId', v_rl.id, 'itemId', v_item, 'quantity', v_qty,
        'previousItemId', null, 'reason', v_reason));

    else
      select xl.id, xl.return_line_id, xl.requested_item_id, xl.requested_quantity, rl.quantity as returned
        into v_xl
        from public.return_exchange_lines xl
        join public.return_lines rl on rl.id = xl.return_line_id
       where xl.id = (e->>'exchangeLineId')::uuid;
      if coalesce(e->'itemId', 'null'::jsonb) <> 'null'::jsonb then
        if jsonb_typeof(e->'itemId') <> 'string' or (e->>'itemId') !~ c_uuid then
          raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'itemId';
        end if;
        v_item := (e->>'itemId')::uuid;
      else
        v_item := v_xl.requested_item_id;
      end if;
      if v_item is null then
        -- "The warehouse will review": staff choose the item.
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'itemId';
      end if;
      v_qty := public._return_exchange_quantity(e->'quantity', v_xl.requested_quantity, v_xl.returned);
      v_prev := null;
      if v_xl.requested_item_id is not null and v_item <> v_xl.requested_item_id then
        -- A substitution (brief 22): a reason, and both items are kept.
        v_reason := public._return_exchange_reason(e->>'reason', 1000);
        v_prev := v_xl.requested_item_id;
      else
        v_reason := case when nullif(regexp_replace(coalesce(e->>'reason', ''), '^\s+|\s+$', '', 'g'), '') is null then null
                         else public._return_exchange_reason(e->>'reason', 1000) end;
      end if;
      if not public._return_exchange_item_ok(v_order, v_item, 'staff') then
        raise exception 'exchange_item_not_eligible' using errcode = 'P0001', hint = 'exchange_item_not_eligible';
      end if;
      v_approve := v_approve || jsonb_build_array(jsonb_build_object(
        'exchangeLineId', v_xl.id, 'returnLineId', v_xl.return_line_id, 'itemId', v_item, 'quantity', v_qty,
        'previousItemId', v_prev, 'reason', v_reason));
    end if;
  end loop;

  if jsonb_array_length(v_approve) = 0 then
    return null;
  end if;

  v_repl := public._return_replacement_issue(
    p_return_id,
    (select jsonb_agg(jsonb_build_object('itemId', y->'itemId', 'quantity', y->'quantity')) from jsonb_array_elements(v_approve) as y),
    p_revision + 1,
    case when jsonb_typeof(p_decision->'replacement') = 'object' then p_decision->'replacement' end);

  for a in select y from jsonb_array_elements(v_approve) as y order by y->>'exchangeLineId' loop
    update public.return_exchange_lines xl
       set status = 'approved',
           approved_item_id = (a->>'itemId')::uuid,
           approved_quantity = (a->>'quantity')::numeric,
           approved_by = p_user,
           approved_at = now(),
           replacement_order_request_id = (v_repl->>'orderId')::uuid,
           replacement_order_line_id = (select l.id from public.order_request_lines l
                                         where l.order_request_id = (v_repl->>'orderId')::uuid
                                           and l.item_id = (a->>'itemId')::uuid),
           revision = p_revision + 1
     where xl.id = (a->>'exchangeLineId')::uuid;
    insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                         item_id, previous_item_id, quantity, order_request_id, reason,
                                         actor_user_id, actor_kind)
    values (v_org, p_return_id, (a->>'returnLineId')::uuid, (a->>'exchangeLineId')::uuid, 'exchange_approved', 'staff',
            (a->>'itemId')::uuid, (a->>'previousItemId')::uuid, (a->>'quantity')::numeric, (v_repl->>'orderId')::uuid,
            a->>'reason', p_user, 'staff');
  end loop;
  insert into public.return_decisions (organization_id, return_id, kind, channel, revision, order_request_id,
                                       actor_user_id, actor_kind)
  values (v_org, p_return_id, 'replacement_issued', 'staff', p_revision + 1, (v_repl->>'orderId')::uuid, p_user, 'staff');

  return v_repl;
end;
$$;

-- Deny: every requested exchange line is declined with the RMA (the denial's
-- reason is on the denied decision). No order exists before approval.
create or replace function public._return_exchange_on_deny(p_return_id uuid, p_user uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_xl record;
begin
  -- The requested items the decisions below name, FOR UPDATE in id order
  -- before the first of them (desk check F4).
  perform public._return_lock_items(
    (select r.organization_id from public.returns r where r.id = p_return_id),
    array(select xl.requested_item_id from public.return_exchange_lines xl
           where xl.return_id = p_return_id and xl.status = 'requested' and xl.requested_item_id is not null),
    false);
  for v_xl in
    update public.return_exchange_lines
       set status = 'declined'
     where return_id = p_return_id and status = 'requested'
    returning id, organization_id, return_line_id, requested_item_id, requested_quantity
  loop
    insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                         item_id, quantity, actor_user_id, actor_kind)
    values (v_xl.organization_id, p_return_id, v_xl.return_line_id, v_xl.id, 'exchange_declined', 'staff',
            v_xl.requested_item_id, v_xl.requested_quantity, p_user, 'staff');
  end loop;
end;
$$;

-- Cancel the RMA (plan 3.3.5, the cancel_return row; X-1, X-2). Called by
-- cancel_return after its RMA row lock, status and revision checks. Once an
-- exchange was approved: orders:approve (42501 orders_approve) and a reason
-- (P0001 reason_required); the live replacement is locked FOR UPDATE and
-- classified under that lock: not handed over (undrawn, or picked and not
-- handed over, which cancel_order_request restocks to Staging) is cancelled
-- in this transaction. Handed over in full keeps its history and nothing
-- moves (brief 34, D11). Handed over in part (desk check F3): a backorder is
-- closed as delivered-partial (close_partial, unchanged: the record kept,
-- every hold released, nothing moves), and a remainder already resumed into
-- picking is cancelled (cancel_order_request keeps quantity_fulfilled as the
-- record and restocks only a picked batch, to Staging), so nothing more ships
-- for a cancelled return. Requested lines are cancelled with the RMA.
create or replace function public._return_exchange_on_cancel(p_return_id uuid, p_user uuid, p_reason text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org     uuid;
  v_no      text;
  v_live    uuid;
  v_class   text;
  v_ostatus text;
begin
  if not exists (select 1 from public.return_exchange_lines xl where xl.return_id = p_return_id) then
    return;
  end if;
  select r.organization_id, r.return_number into v_org, v_no from public.returns r where r.id = p_return_id;

  if exists (select 1 from public.return_exchange_lines xl
              where xl.return_id = p_return_id and xl.approved_item_id is not null)
     or exists (select 1 from public.order_requests o where o.replacement_for_return_id = p_return_id) then
    -- Anything that touches a replacement needs the orders module (plan
    -- 3.3.1 step 3) and order approval, as the other exchange functions.
    if not public.module_enabled(v_org, 'orders') then
      raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
    end if;
    if not public.has_permission(v_org, 'orders:approve') then
      raise exception 'orders_approve' using errcode = '42501', hint = 'orders_approve';
    end if;
    if nullif(regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g'), '') is null then
      raise exception 'reason_required' using errcode = 'P0001', hint = 'reason_required';
    end if;
    select o.id into v_live
      from public.order_requests o
     where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
       for update;
    if v_live is not null then
      v_class := public._return_replacement_class(v_live);
      select o.status into v_ostatus from public.order_requests o where o.id = v_live;
      if v_class in ('undrawn', 'drawn') then
        perform public._return_replacement_cancel_order(v_live, v_no, 'return_cancelled');
        update public.return_exchange_lines
           set status = 'cancelled'
         where return_id = p_return_id and status = 'approved';
      elsif v_ostatus = 'backordered' then
        -- Handed over in part, the rest on backorder: closed as delivered-partial.
        perform public.close_partial(v_live);
      elsif v_ostatus <> 'completed' then
        -- Handed over in part, the rest resumed into picking: the rest is cancelled.
        perform public._return_replacement_cancel_order(v_live, v_no, 'return_cancelled');
        update public.return_exchange_lines
           set status = 'cancelled'
         where return_id = p_return_id and status = 'approved';
      end if;
    end if;
  end if;

  update public.return_exchange_lines
     set status = 'cancelled'
   where return_id = p_return_id and status = 'requested';
end;
$$;

-- An approval (or replacement change) replay's replacement: the order issued
-- at that revision, read from what the exchange functions wrote (the
-- replacement_issued decision), never from a stored key response.
create or replace function public._return_exchange_replay(p_return_id uuid, p_revision integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
begin
  select d.order_request_id into v_order
    from public.return_decisions d
   where d.return_id = p_return_id and d.kind = 'replacement_issued' and d.revision = p_revision
   order by d.seq desc
   limit 1;
  if v_order is null then
    return null;
  end if;
  return public._return_replacement_summary(v_order) || jsonb_build_object('revision', p_revision);
end;
$$;

-- ── 1d. The exchange functions (SECURITY DEFINER; gate in the body; plan
-- 3.3.1: signed in, the RMA read without a lock (missing and foreign answer
-- alike), the returns and orders modules, returns:manage, orders:approve,
-- write access to the original order's warehouse, and only then the RMA row
-- lock and, right after it, the live replacement's).

-- Substitution, and a new replacement after a replacement cancel (plan
-- 3.3.5; brief 22; C-1). p_lines [{exchangeLineId, itemId?, quantity?}]
-- changes some lines; the others keep their item and quantity.
--   Live replacement undrawn: it is cancelled (every hold released, nothing
--   restocked) and a new one is created and held, in one transaction, at the
--   next revision; another session sees the whole change or nothing.
--   Picked (drawn), or anything handed over: refused (P0001
--   replacement_already_drawn / replacement_handed_over).
--   No live replacement, lines cancelled by a replacement cancel, RMA
--   approved, received or closed: a new replacement (the re-issue).
-- Every line sends at most what is left of its returned quantity after what
-- this RMA's replacements already handed over for it (desk check F2).
-- Idempotent on (RMA, expected revision) in scope return_replacement_change;
-- a different change at the same revision P0001 return_changed.
create function public.change_return_replacement(
  p_return_id uuid, p_expected_revision integer, p_lines jsonb, p_reason text, p_when_short text,
  p_replacement jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_scope   constant text := 'return_replacement_change';
  c_uuid    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_order   uuid;
  v_no      text;
  v_status  text;
  v_rev     integer;
  v_reason  text;
  v_when    text := coalesce(nullif(p_when_short, ''), 'refuse');
  v_canon   jsonb;
  v_hash    text;
  v_key     text;
  v_key_id  uuid;
  v_prev    record;
  v_live    record;
  v_ftype   text;
  v_site    uuid;
  v_class   text;
  v_mode    text;
  v_seen    uuid[] := '{}';
  v_set     jsonb := '[]'::jsonb;
  v_changed boolean := false;
  v_spent   integer := 0;
  v_item    uuid;
  v_qty     numeric;
  v_repl    jsonb;
  v_opts    jsonb;
  x         record;
  e         jsonb;
  a         jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select r.organization_id, o.warehouse_id, o.id, r.return_number into v_org, v_wh, v_order, v_no
    from public.returns r join public.order_requests o on o.id = r.order_request_id
   where r.id = p_return_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'return_not_found' using errcode = 'P0002', hint = 'return_not_found';
  end if;
  if not public.module_enabled(v_org, 'returns') or not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not public.has_permission(v_org, 'returns:manage') then
    raise exception 'returns_manage' using errcode = '42501', hint = 'returns_manage';
  end if;
  if not public.has_permission(v_org, 'orders:approve') then
    raise exception 'orders_approve' using errcode = '42501', hint = 'orders_approve';
  end if;
  if not public.user_can_access_inventory(v_user, v_wh, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;
  v_reason := public._return_exchange_reason(p_reason, 1000);
  if v_when not in ('refuse', 'backorder') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'whenShort';
  end if;
  if p_expected_revision is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'expectedRevision';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) not in ('array', 'null') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'lines';
  end if;
  if p_replacement is not null and jsonb_typeof(p_replacement) not in ('object', 'null') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'replacement';
  end if;

  select r.status into v_status from public.returns r where r.id = p_return_id for update;

  -- Idempotency: one key per (RMA, revision); the hash is the change.
  select jsonb_build_object(
           'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                       'exchangeLineId', lower(y->>'exchangeLineId'),
                                       'itemId', coalesce(y->'itemId', 'null'::jsonb),
                                       'quantity', coalesce(y->'quantity', 'null'::jsonb))
                                     order by lower(y->>'exchangeLineId'), y::text)
                                from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) as y),
                             '[]'::jsonb),
           'reason', v_reason,
           'whenShort', v_when,
           'replacement', coalesce(p_replacement, 'null'::jsonb))
    into v_canon;
  v_hash := md5(c_scope || ':v1|' || v_canon::text);
  v_key := p_return_id::text || ':' || p_expected_revision::text;

  insert into public.idempotency_keys as k (organization_id, scope, key, request_hash, status, resource_type, resource_id)
  values (v_org, c_scope, v_key, v_hash, 'in_progress', 'return', p_return_id)
  on conflict (organization_id, scope, key) do nothing
  returning k.id into v_key_id;
  -- A key row this function did not complete is taken over, never trusted
  -- (the RX-1 F11 rule): every change it completes appends the
  -- replacement_changed decision at the next revision, under the RMA lock.
  if v_key_id is null
     and not exists (select 1 from public.return_decisions d
                      where d.return_id = p_return_id and d.kind = 'replacement_changed'
                        and d.revision = p_expected_revision + 1) then
    update public.idempotency_keys k
       set request_hash = v_hash, status = 'in_progress', response = null,
           resource_type = 'return', resource_id = p_return_id, updated_at = now()
     where k.organization_id = v_org and k.scope = c_scope and k.key = v_key
    returning k.id into v_key_id;
  end if;
  if v_key_id is null then
    select k.request_hash, k.status into v_prev
      from public.idempotency_keys k
     where k.organization_id = v_org and k.scope = c_scope and k.key = v_key;
    if not found or v_prev.request_hash is distinct from v_hash or v_prev.status is distinct from 'completed' then
      raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed';
    end if;
    return jsonb_build_object('changed', false, 'replay', true, 'returnId', p_return_id,
                              'revision', p_expected_revision + 1, 'status', v_status,
                              'replacement', coalesce(public._return_exchange_replay(p_return_id, p_expected_revision + 1), 'null'::jsonb));
  end if;

  if v_status not in ('approved', 'received', 'closed') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_status;
  end if;
  select coalesce(max(d.revision), 0) into v_rev
    from public.return_decisions d
   where d.return_id = p_return_id
     and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled');
  if v_rev <> p_expected_revision then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
  end if;

  -- The live replacement, locked right after the RMA, then classified.
  select o.id, o.status, o.fulfillment_type, o.delivery_charter_id into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
     for update;
  if v_live.id is not null then
    v_class := public._return_replacement_class(v_live.id);
    if v_class = 'handed_over'
       or exists (select 1 from public.order_request_lines l
                   where l.order_request_id = v_live.id and coalesce(l.quantity_fulfilled, 0) > 0) then
      raise exception 'replacement_handed_over' using errcode = 'P0001', hint = 'replacement_handed_over';
    end if;
    if v_class = 'drawn' then
      raise exception 'replacement_already_drawn' using errcode = 'P0001', hint = 'replacement_already_drawn';
    end if;
    v_mode := 'substitute';
  else
    v_mode := 'reissue';
  end if;

  -- The lines this change carries: every approved line (substitution) or
  -- every line a replacement cancel left cancelled (re-issue). Each line may
  -- send at most what is left of its returned quantity after the units this
  -- RMA's replacements already handed over for it (desk check F2: a forced
  -- or legacy cancel of a partly handed-over replacement never lets a new one
  -- send those units again); a line with nothing left is not re-issued.
  for x in
    select xl.id, xl.return_line_id, xl.approved_item_id, xl.approved_quantity,
           rl.quantity - coalesce(f.fulfilled, 0) as room
      from public.return_exchange_lines xl
      join public.return_lines rl on rl.id = xl.return_line_id
      left join public._return_exchange_fulfilled(p_return_id) f on f.exchange_line_id = xl.id
     where xl.return_id = p_return_id
       and xl.status = case v_mode when 'substitute' then 'approved' else 'cancelled' end
       and xl.approved_item_id is not null
     order by xl.id
  loop
    if x.room < 1 then
      if v_mode = 'substitute' then
        raise exception 'replacement_handed_over' using errcode = 'P0001', hint = 'replacement_handed_over';
      end if;
      v_spent := v_spent + 1;
      continue;
    end if;
    v_set := v_set || jsonb_build_array(jsonb_build_object(
      'exchangeLineId', x.id, 'returnLineId', x.return_line_id, 'itemId', x.approved_item_id,
      'quantity', least(x.approved_quantity, x.room), 'returned', x.room, 'previousItemId', null));
  end loop;
  if jsonb_array_length(v_set) = 0 then
    if v_spent > 0 then
      raise exception 'replacement_handed_over' using errcode = 'P0001', hint = 'replacement_handed_over';
    end if;
    if v_mode = 'reissue' and exists (select 1 from public.return_exchange_lines xl
                                       where xl.return_id = p_return_id and xl.status = 'declined'
                                         and xl.approved_item_id is not null) then
      -- Kept as a return only since this screen was drawn (desk check F9).
      raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed';
    end if;
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'no_exchange_lines';
  end if;

  for e in select y from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) as y loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'exchangeLineId') is distinct from 'string'
       or (e->>'exchangeLineId') !~ c_uuid then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchangeLineId';
    end if;
    if (e->>'exchangeLineId')::uuid = any (v_seen) then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'duplicate_line';
    end if;
    v_seen := v_seen || (e->>'exchangeLineId')::uuid;
    select y into a from jsonb_array_elements(v_set) as y where (y->>'exchangeLineId')::uuid = (e->>'exchangeLineId')::uuid;
    if a is null then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'exchangeLineId';
    end if;
    v_item := (a->>'itemId')::uuid;
    if coalesce(e->'itemId', 'null'::jsonb) <> 'null'::jsonb then
      if jsonb_typeof(e->'itemId') <> 'string' or (e->>'itemId') !~ c_uuid then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'itemId';
      end if;
      v_item := (e->>'itemId')::uuid;
    end if;
    v_qty := public._return_exchange_quantity(e->'quantity', (a->>'quantity')::numeric, (a->>'returned')::numeric);
    if v_item <> (a->>'itemId')::uuid or v_qty <> (a->>'quantity')::numeric then
      v_changed := true;
    end if;
    select coalesce(jsonb_agg(case when (y->>'exchangeLineId')::uuid = (e->>'exchangeLineId')::uuid
                                   then y || jsonb_build_object('itemId', v_item, 'quantity', v_qty,
                                                                'previousItemId', case when v_item <> (y->>'itemId')::uuid then y->'itemId' end)
                                   else y end), '[]'::jsonb)
      into v_set
      from jsonb_array_elements(v_set) as y;
    a := null;
  end loop;
  if v_mode = 'substitute' and not v_changed then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'no_change';
  end if;
  for a in select y from jsonb_array_elements(v_set) as y loop
    if not public._return_exchange_item_ok(v_order, (a->>'itemId')::uuid, 'staff') then
      raise exception 'exchange_item_not_eligible' using errcode = 'P0001', hint = 'exchange_item_not_eligible';
    end if;
  end loop;

  -- The new order inherits the replaced one's fulfilment (or, for a re-issue,
  -- the last cancelled replacement's), unless the approver overrides it.
  if v_live.id is not null then
    v_ftype := v_live.fulfillment_type;
    v_site := v_live.delivery_charter_id;
  else
    select o.fulfillment_type, o.delivery_charter_id into v_ftype, v_site
      from public.order_requests o
     where o.replacement_for_return_id = p_return_id
     order by o.created_at desc, o.id desc
     limit 1;
  end if;
  v_opts := jsonb_build_object(
    'whenShort', v_when,
    'fulfillmentType', coalesce(p_replacement->>'fulfillmentType', v_ftype),
    'deliveryCharterId', case when coalesce(p_replacement ? 'deliveryCharterId', false) then p_replacement->'deliveryCharterId'
                              else to_jsonb(v_site) end);

  -- The order-number lock, then every item a row below names (the new items
  -- and the ones they replace), FOR UPDATE in id order (desk check F4).
  perform public._return_lock_items(
    v_org,
    array(select (y->>'itemId')::uuid from jsonb_array_elements(v_set) as y
          union
          select xl.approved_item_id from public.return_exchange_lines xl
           where xl.return_id = p_return_id and xl.approved_item_id is not null),
    true);

  -- Never both reservations: the old order is cancelled first (every hold
  -- released, nothing restocked: it was not picked), then the new one is
  -- created and held, all in this transaction.
  if v_live.id is not null then
    perform public._return_replacement_cancel_order(v_live.id, v_no, 'changed');
  end if;
  v_repl := public._return_replacement_issue(
    p_return_id,
    (select jsonb_agg(jsonb_build_object('itemId', y->'itemId', 'quantity', y->'quantity')) from jsonb_array_elements(v_set) as y),
    p_expected_revision + 1, v_opts);

  insert into public.return_decisions (organization_id, return_id, kind, channel, revision, order_request_id, reason,
                                       actor_user_id, actor_kind)
  values (v_org, p_return_id, 'replacement_changed', 'staff', p_expected_revision + 1, (v_repl->>'orderId')::uuid, v_reason,
          v_user, 'staff');
  for a in select y from jsonb_array_elements(v_set) as y order by y->>'exchangeLineId' loop
    update public.return_exchange_lines xl
       set status = 'approved',
           approved_item_id = (a->>'itemId')::uuid,
           approved_quantity = (a->>'quantity')::numeric,
           approved_by = v_user,
           approved_at = now(),
           replacement_order_request_id = (v_repl->>'orderId')::uuid,
           replacement_order_line_id = (select l.id from public.order_request_lines l
                                         where l.order_request_id = (v_repl->>'orderId')::uuid
                                           and l.item_id = (a->>'itemId')::uuid),
           revision = p_expected_revision + 1
     where xl.id = (a->>'exchangeLineId')::uuid;
    insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                         item_id, previous_item_id, quantity, order_request_id, reason,
                                         actor_user_id, actor_kind)
    values (v_org, p_return_id, (a->>'returnLineId')::uuid, (a->>'exchangeLineId')::uuid, 'exchange_approved', 'staff',
            (a->>'itemId')::uuid, (a->>'previousItemId')::uuid, (a->>'quantity')::numeric, (v_repl->>'orderId')::uuid,
            v_reason, v_user, 'staff');
  end loop;
  insert into public.return_decisions (organization_id, return_id, kind, channel, revision, order_request_id,
                                       actor_user_id, actor_kind)
  values (v_org, p_return_id, 'replacement_issued', 'staff', p_expected_revision + 1, (v_repl->>'orderId')::uuid, v_user, 'staff');

  update public.idempotency_keys
     set status = 'completed', resource_id = p_return_id,
         response = jsonb_build_object('returnId', p_return_id, 'revision', p_expected_revision + 1),
         updated_at = now()
   where id = v_key_id;

  return jsonb_build_object('changed', true, 'replay', false, 'returnId', p_return_id,
                            'revision', p_expected_revision + 1, 'status', v_status, 'mode', v_mode,
                            'cancelledOrderId', v_live.id, 'replacement', v_repl);
end;
$$;

-- Keep the return, drop the replacement (plan 3.3.5; X-1, X-2). The live
-- replacement is locked right after the RMA and classified under that lock:
-- undrawn, or picked and not handed over (cancel_order_request's drawn
-- branch restocks exactly the picked batch to Staging and releases every
-- hold: "The picked items go back to Staging on record"), is cancelled;
-- handed over, in full or in part (a backorder, or one resumed into picking
-- again: desk check F2), is refused (P0001 replacement_handed_over). No live
-- replacement: {changed: false}. The RMA itself does not change; its lines
-- read cancelled, and the workbench offers a new replacement or the return
-- alone.
create function public.cancel_return_replacement(p_return_id uuid, p_expected_revision integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_no      text;
  v_status  text;
  v_rev     integer;
  v_reason  text;
  v_live    record;
  v_class   text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select r.organization_id, o.warehouse_id, r.return_number into v_org, v_wh, v_no
    from public.returns r join public.order_requests o on o.id = r.order_request_id
   where r.id = p_return_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'return_not_found' using errcode = 'P0002', hint = 'return_not_found';
  end if;
  if not public.module_enabled(v_org, 'returns') or not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not public.has_permission(v_org, 'returns:manage') then
    raise exception 'returns_manage' using errcode = '42501', hint = 'returns_manage';
  end if;
  if not public.has_permission(v_org, 'orders:approve') then
    raise exception 'orders_approve' using errcode = '42501', hint = 'orders_approve';
  end if;
  if not public.user_can_access_inventory(v_user, v_wh, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;
  v_reason := public._return_exchange_reason(p_reason, 1000);
  -- The revision the caller saw is required (desk check F7): after a
  -- substitution or a re-issue a stale tab gets return_changed, never a
  -- cancel of a replacement its user has not seen.
  if p_expected_revision is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'expectedRevision';
  end if;

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  select o.id, o.status into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
     for update;
  if v_live.id is null then
    return jsonb_build_object('changed', false, 'returnId', p_return_id, 'status', v_status, 'replacement', 'none');
  end if;

  select coalesce(max(d.revision), 0) into v_rev
    from public.return_decisions d
   where d.return_id = p_return_id
     and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled');
  if v_rev <> p_expected_revision then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
  end if;

  v_class := public._return_replacement_class(v_live.id);
  if v_class not in ('undrawn', 'drawn') then
    raise exception 'replacement_handed_over' using errcode = 'P0001', hint = 'replacement_handed_over';
  end if;

  perform public._return_replacement_cancel_order(v_live.id, v_no, 'cancelled');
  update public.return_exchange_lines
     set status = 'cancelled'
   where return_id = p_return_id and status = 'approved';
  insert into public.return_decisions (organization_id, return_id, kind, channel, revision, order_request_id, reason,
                                       actor_user_id, actor_kind)
  values (v_org, p_return_id, 'replacement_cancelled', 'staff', v_rev + 1, v_live.id, v_reason, v_user, 'staff');

  return jsonb_build_object('changed', true, 'returnId', p_return_id, 'status', v_status, 'revision', v_rev + 1,
                            'cancelledOrderId', v_live.id, 'drawn', v_class = 'drawn',
                            'inTransit', v_live.status = 'in_transit');
end;
$$;

-- Keep the return only, after a replacement cancel (desk check F9): every
-- exchange line a replacement cancel left cancelled is declined for good, so
-- an RMA (closed or not) stops inviting "Issue a new replacement". Only the
-- status moves: each line keeps its last approved item and the cancelled
-- replacement it named, for display (return_exchange_lines_unapproved_chk
-- refuses a replacement on a requested line only). A reason
-- of 1 to 1,000 characters is recorded on each exchange_declined decision.
-- The RMA approved, received or closed (P0001 invalid_status_transition);
-- the revision the caller saw is required (22023 return_invalid without it,
-- P0001 return_changed when stale). No cancelled line answers {changed:
-- false}. Moves nothing; no order is touched, so the returns gates apply
-- (returns:manage and write access to the order's warehouse), as for
-- declining an exchange at approval.
create function public.decline_return_replacement(p_return_id uuid, p_expected_revision integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_status  text;
  v_rev     integer;
  v_reason  text;
  v_count   integer := 0;
  v_xl      record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select r.organization_id, o.warehouse_id into v_org, v_wh
    from public.returns r join public.order_requests o on o.id = r.order_request_id
   where r.id = p_return_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'return_not_found' using errcode = 'P0002', hint = 'return_not_found';
  end if;
  if not public.module_enabled(v_org, 'returns') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not public.has_permission(v_org, 'returns:manage') then
    raise exception 'returns_manage' using errcode = '42501', hint = 'returns_manage';
  end if;
  if not public.user_can_access_inventory(v_user, v_wh, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;
  v_reason := public._return_exchange_reason(p_reason, 1000);
  if p_expected_revision is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'expectedRevision';
  end if;

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  if v_status not in ('approved', 'received', 'closed') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_status;
  end if;
  select coalesce(max(d.revision), 0) into v_rev
    from public.return_decisions d
   where d.return_id = p_return_id
     and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled');
  if v_rev <> p_expected_revision then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
  end if;

  -- The items the decisions below name, FOR UPDATE in id order (desk check F4).
  perform public._return_lock_items(
    v_org,
    array(select coalesce(xl.approved_item_id, xl.requested_item_id) from public.return_exchange_lines xl
           where xl.return_id = p_return_id and xl.status = 'cancelled'),
    false);
  for v_xl in
    select xl.id, xl.return_line_id, coalesce(xl.approved_item_id, xl.requested_item_id) as item_id,
           coalesce(xl.approved_quantity, xl.requested_quantity) as quantity
      from public.return_exchange_lines xl
     where xl.return_id = p_return_id and xl.status = 'cancelled'
     order by xl.id
  loop
    update public.return_exchange_lines set status = 'declined' where id = v_xl.id;
    insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                         item_id, quantity, reason, actor_user_id, actor_kind)
    values (v_org, p_return_id, v_xl.return_line_id, v_xl.id, 'exchange_declined', 'staff',
            v_xl.item_id, v_xl.quantity, v_reason, v_user, 'staff');
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('changed', v_count > 0, 'returnId', p_return_id, 'status', v_status,
                            'revision', v_rev, 'declined', v_count);
end;
$$;

-- Release the replacement for picking before the returned item arrives
-- (brief 24; plan 3.3.5): only while the live replacement is approved (not
-- yet on a pick slip) and the RMA is approved, with a reason of 1 to 500
-- characters. Appends released_early naming the order, which opens the gate
-- for that order only (a substituted order needs its own release, D10). An
-- existing release of the live order replays; an RMA already received or
-- closed answers {changed: false, reason: 'not_needed'}; otherwise P0001
-- replacement_not_waiting. p_order_id is the replacement the caller saw
-- (null: none): a different live replacement (a substitution or a re-issue
-- since) is P0001 return_changed, so a stale tab never releases an order its
-- user has not seen (desk check F7; D10).
create function public.release_return_replacement_early(p_return_id uuid, p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_status  text;
  v_reason  text;
  v_live    record;
  v_at      timestamptz;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select r.organization_id, o.warehouse_id into v_org, v_wh
    from public.returns r join public.order_requests o on o.id = r.order_request_id
   where r.id = p_return_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'return_not_found' using errcode = 'P0002', hint = 'return_not_found';
  end if;
  if not public.module_enabled(v_org, 'returns') or not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not public.has_permission(v_org, 'returns:manage') then
    raise exception 'returns_manage' using errcode = '42501', hint = 'returns_manage';
  end if;
  if not public.has_permission(v_org, 'orders:approve') then
    raise exception 'orders_approve' using errcode = '42501', hint = 'orders_approve';
  end if;
  if not public.user_can_access_inventory(v_user, v_wh, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;
  v_reason := public._return_exchange_reason(p_reason, 500);

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  select o.id, o.status into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
     for update;
  if v_live.id is distinct from p_order_id then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed';
  end if;

  if v_status in ('received', 'closed') then
    return jsonb_build_object('changed', false, 'returnId', p_return_id, 'status', v_status, 'reason', 'not_needed');
  end if;
  if v_live.id is not null then
    select d.created_at into v_at
      from public.return_decisions d
     where d.return_id = p_return_id and d.kind = 'released_early' and d.order_request_id = v_live.id
     order by d.seq
     limit 1;
    if v_at is not null then
      return jsonb_build_object('changed', false, 'replay', true, 'returnId', p_return_id, 'status', v_status,
                                'orderId', v_live.id, 'releasedAt', v_at);
    end if;
  end if;
  if v_status <> 'approved' or v_live.id is null or v_live.status <> 'approved' then
    raise exception 'replacement_not_waiting' using errcode = 'P0001', hint = 'replacement_not_waiting',
      detail = coalesce(v_live.status, 'none');
  end if;

  insert into public.return_decisions (organization_id, return_id, kind, channel, order_request_id, reason,
                                       actor_user_id, actor_kind)
  values (v_org, p_return_id, 'released_early', 'staff', v_live.id, v_reason, v_user, 'staff');

  return jsonb_build_object('changed', true, 'replay', false, 'returnId', p_return_id, 'status', v_status,
                            'orderId', v_live.id, 'releasedAt', now());
end;
$$;

-- ── 1e. Reads ──────────────────────────────────────────────────────────────

-- The staff replacement search (plan 3.3.2): SECURITY INVOKER, so items,
-- holds and the order are read under the caller's RLS (item scope
-- included). The returned item's product-group siblings come first (the
-- same size too: a staff swap of a damaged unit), then name and SKU matches
-- from two characters over items orderable in the order's warehouse; 30 at
-- most. Free stock = on hand minus every active hold (the rule
-- approve_partial uses). Gate: signed in, the order readable, returns:manage.
-- Never reads holdings by location.
create function public.return_exchange_candidates(
  p_order_id uuid, p_order_request_line_id uuid, p_query text default null, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_item    uuid;
  v_group   uuid;
  v_q       text := nullif(btrim(coalesce(p_query, '')), '');
  v_like    text;
  v_limit   integer := least(greatest(coalesce(p_limit, 30), 1), 30);
  v_sib     jsonb;
  v_hits    jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select o.organization_id, o.warehouse_id into v_org, v_wh from public.order_requests o where o.id = p_order_id;
  if v_org is null then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
  end if;
  if not public.has_permission(v_org, 'returns:manage') then
    raise exception 'returns_manage' using errcode = '42501', hint = 'returns_manage';
  end if;
  select l.item_id into v_item
    from public.order_request_lines l
   where l.id = p_order_request_line_id and l.order_request_id = p_order_id;
  if v_item is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'orderRequestLineId';
  end if;
  select ii.group_id into v_group
    from public.inventory_items ii
    join public.product_groups g on g.id = ii.group_id
   where ii.id = v_item and g.organization_id = v_org and g.deleted_at is null and g.status = 'active';

  with c as (
    select ii.id, ii.name, ii.sku, ii.variant_size, ii.variant_key, ii.group_id, ii.quantity_on_hand,
           coalesce((select sum(sr.quantity) from public.stock_reservations sr
                      where sr.item_id = ii.id and sr.released_at is null), 0) as held
      from public.inventory_items ii
     where v_group is not null and ii.group_id = v_group and ii.organization_id = v_org
       and ii.warehouse_id = v_wh and ii.deleted_at is null and ii.status = 'active'
       and not coalesce(ii.is_rental, false) and not coalesce(ii.awaiting_first_receipt, false)
       and not coalesce(ii.is_bundle, false)
     order by ii.variant_size nulls last, ii.name, ii.id
     limit 60)
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', c.id, 'name', c.name, 'sku', c.sku, 'variantSize', c.variant_size, 'variantKey', c.variant_key,
           'groupId', c.group_id, 'sibling', true, 'isReturnedItem', c.id = v_item,
           'onHand', trim_scale(c.quantity_on_hand), 'held', trim_scale(c.held),
           'free', trim_scale(greatest(c.quantity_on_hand - c.held, 0)))), '[]'::jsonb)
    into v_sib
    from c;

  if v_q is not null and length(v_q) >= 2 then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    with c as (
      select ii.id, ii.name, ii.sku, ii.variant_size, ii.variant_key, ii.group_id, ii.quantity_on_hand,
             coalesce((select sum(sr.quantity) from public.stock_reservations sr
                        where sr.item_id = ii.id and sr.released_at is null), 0) as held
        from public.inventory_items ii
       where ii.organization_id = v_org and ii.warehouse_id = v_wh
         and ii.deleted_at is null and ii.status = 'active'
         and not coalesce(ii.is_rental, false) and not coalesce(ii.awaiting_first_receipt, false)
         and not coalesce(ii.is_bundle, false)
         and (ii.name ilike v_like or ii.sku ilike v_like)
         and (v_group is null or ii.group_id is distinct from v_group)
       order by ii.name, ii.id
       limit v_limit)
    select coalesce(jsonb_agg(jsonb_build_object(
             'itemId', c.id, 'name', c.name, 'sku', c.sku, 'variantSize', c.variant_size, 'variantKey', c.variant_key,
             'groupId', c.group_id, 'sibling', false, 'isReturnedItem', c.id = v_item,
             'onHand', trim_scale(c.quantity_on_hand), 'held', trim_scale(c.held),
             'free', trim_scale(greatest(c.quantity_on_hand - c.held, 0)))), '[]'::jsonb)
      into v_hits
      from c;
  end if;

  return jsonb_build_object('orderId', p_order_id, 'orderRequestLineId', p_order_request_line_id,
                            'returnedItemId', v_item, 'groupId', v_group,
                            'siblings', v_sib, 'matches', v_hits);
end;
$$;

-- The requester tier's options for an order (plan 3.6.10), service role
-- only: the server resolves the token, the portal principal or the member
-- first, then asks. Ids, variant keys and free counts; the server projects
-- availability to two states (the count never leaves it). RX-3 uses it.
create function public.return_exchange_options(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('orderRequestLineId', g.order_request_line_id,
                                        'returnedItemId', g.returned_item_id,
                                        'options', g.options)
                     order by g.order_request_line_id)
      from (select o.order_request_line_id, o.returned_item_id,
                   jsonb_agg(jsonb_build_object('itemId', o.item_id, 'variantKey', o.variant_key,
                                                'free', trim_scale(greatest(o.free, 0)))
                             order by o.variant_key nulls last, o.item_id) as options
              from public._return_exchange_requester_options(p_order_id, true) o
             group by o.order_request_line_id, o.returned_item_id) g), '[]'::jsonb);
end;
$$;

-- The three exchange facts the list view needs from the staff-only decision
-- log, for any member of the RMA's organization (the view is security
-- invoker, and return_decisions is readable only with returns:read or
-- returns:manage, so without this a member would read another exchange
-- status than a manager): whether the LIVE replacement was released early,
-- whether the unit was received at the counter, and the RMA's revision. No
-- reason, no name, no rack.
create function public.return_exchange_flags(p_return_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org  uuid;
  v_live uuid;
begin
  select r.organization_id into v_org from public.returns r where r.id = p_return_id;
  if v_org is null or not (public.is_org_member(v_org) or coalesce(auth.role(), '') = 'service_role') then
    return null;
  end if;
  select o.id into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
   limit 1;
  return jsonb_build_object(
    'releasedEarly', v_live is not null and exists (
       select 1 from public.return_decisions d
        where d.return_id = p_return_id and d.kind = 'released_early' and d.order_request_id = v_live),
    'counter', exists (
       select 1 from public.return_decisions d
        where d.return_id = p_return_id and d.kind = 'received' and d.channel = 'counter'),
    'revision', (select coalesce(max(d.revision), 0) from public.return_decisions d
                  where d.return_id = p_return_id
                    and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled')));
end;
$$;

-- ── 1f. Triggers (functions only; the triggers follow the prelude) ────────

-- return_exchange_lines (plan 3.1.3): every role, defence in depth (only the
-- DEFINER functions write the table). Same organization for the items, the
-- RMA and the line; quantities at most the returned quantity; the request
-- fields never change; status edges requested -> approved, declined or
-- cancelled; approved -> approved (a newer revision) or cancelled;
-- cancelled -> approved (a new replacement, C-1) only while the RMA is
-- approved, received or closed, or declined (kept as a return only after a
-- replacement cancel, desk check F9); declined is final; a replacement named
-- is this RMA's, and its line carries the approved item. The decision (the
-- approved item, quantity, approver, replacement order and line, revision)
-- changes only on a move into approved: a cancelled line, and one declined
-- after a replacement cancel, keeps the last it had for display, and a line
-- never approved keeps none (with return_exchange_lines_unapproved_chk:
-- only a line that was approved once can name a replacement).
create function public.tg_return_exchange_lines_validate()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_returned numeric;
  v_rma      text;
begin
  select rl.quantity into v_returned
    from public.return_lines rl
   where rl.id = new.return_line_id and rl.return_id = new.return_id and rl.organization_id = new.organization_id;
  if v_returned is null then
    raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'return_line';
  end if;
  if new.requested_item_id is not null and not exists (
       select 1 from public.inventory_items ii where ii.id = new.requested_item_id and ii.organization_id = new.organization_id) then
    raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'requested_item';
  end if;
  if new.approved_item_id is not null and not exists (
       select 1 from public.inventory_items ii where ii.id = new.approved_item_id and ii.organization_id = new.organization_id) then
    raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'approved_item';
  end if;
  if new.requested_quantity > v_returned or coalesce(new.approved_quantity, 0) > v_returned then
    raise exception 'exchange_quantity_exceeds_return' using errcode = 'P0001', hint = 'exchange_quantity_exceeds_return';
  end if;
  if new.replacement_order_request_id is not null then
    if not exists (select 1 from public.order_requests o
                    where o.id = new.replacement_order_request_id
                      and o.replacement_for_return_id = new.return_id
                      and o.organization_id = new.organization_id) then
      raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'replacement_order';
    end if;
    if new.replacement_order_line_id is null or not exists (
         select 1 from public.order_request_lines l
          where l.id = new.replacement_order_line_id
            and l.order_request_id = new.replacement_order_request_id
            and l.item_id = new.approved_item_id) then
      raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'replacement_line';
    end if;
  elsif new.replacement_order_line_id is not null then
    raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'replacement_line';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'status';
    end if;
    new.revision := 0;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- The request is written once (brief 22: the original request is kept).
  if (new.organization_id, new.return_id, new.return_line_id, new.requested_item_id, new.requested_quantity,
      new.request_note, new.requested_by_kind, new.requested_by, new.requested_at, new.created_at)
     is distinct from
     (old.organization_id, old.return_id, old.return_line_id, old.requested_item_id, old.requested_quantity,
      old.request_note, old.requested_by_kind, old.requested_by, old.requested_at, old.created_at) then
    raise exception 'exchange_request_immutable' using errcode = '42501', hint = 'exchange_request_immutable';
  end if;
  if not (
       (old.status = 'requested' and new.status in ('approved', 'declined', 'cancelled'))
    or (old.status = 'approved' and new.status = 'approved' and new.revision > old.revision)
    or (old.status = 'approved' and new.status = 'cancelled')
    or (old.status = 'cancelled' and new.status in ('approved', 'declined'))) then
    raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid',
      detail = format('status %s -> %s', old.status, new.status);
  end if;
  if new.status <> 'approved'
     and (new.approved_item_id, new.approved_quantity, new.approved_by, new.approved_at,
          new.replacement_order_request_id, new.replacement_order_line_id, new.revision)
         is distinct from
         (old.approved_item_id, old.approved_quantity, old.approved_by, old.approved_at,
          old.replacement_order_request_id, old.replacement_order_line_id, old.revision) then
    raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'decision';
  end if;
  if old.status = 'cancelled' and new.status = 'approved' then
    select r.status into v_rma from public.returns r where r.id = new.return_id;
    if coalesce(v_rma, '') not in ('approved', 'received', 'closed') then
      raise exception 'exchange_line_invalid' using errcode = 'P0001', hint = 'exchange_line_invalid', detail = 'reissue_status';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- The exchange requests of a new RMA, logged right after its created
-- decision (desk check F9): AFTER INSERT on return_decisions WHEN kind is
-- created. One exchange_requested decision per exchange line the create
-- wrote and the log does not name yet, in the order of the lines' order
-- lines, with the created decision's channel and actor (the create passes
-- the same ones to both). Only the RX-1 create writes a created decision
-- (no API role writes the log), so this fires once per RMA.
create function public.tg_return_decisions_exchange_requested()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.return_decisions (organization_id, return_id, return_line_id, exchange_line_id, kind, channel,
                                       item_id, quantity, actor_user_id, actor_kind)
  select xl.organization_id, xl.return_id, xl.return_line_id, xl.id, 'exchange_requested', new.channel,
         xl.requested_item_id, xl.requested_quantity, new.actor_user_id, new.actor_kind
    from public.return_exchange_lines xl
    join public.return_lines rl on rl.id = xl.return_line_id
   where xl.return_id = new.return_id and xl.status = 'requested'
     and not exists (select 1 from public.return_decisions d
                      where d.exchange_line_id = xl.id and d.kind = 'exchange_requested')
   order by rl.order_request_line_id, xl.id;
  return null;
end;
$$;

-- The link column's guard (plan 3.6.4): an API-role insert naming it is
-- refused (no API role holds INSERT on the column either: column grants are
-- per column since 0388), and nobody may change it once written, whatever
-- the role (no foreign-key action ever writes it: the key is NO ACTION).
create function public.tg_order_requests_replacement_link()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('authenticated', 'anon') then
      raise exception 'replacement_link_server_only' using errcode = '42501', hint = 'replacement_link_server_only';
    end if;
    return new;
  end if;
  raise exception 'replacement_link_immutable' using errcode = '42501', hint = 'replacement_link_immutable';
end;
$$;

-- A replacement's lines are fixed (plan 3.6.6): its items come from its
-- RMA. An API-role line insert on such an order is refused (the order read
-- by key under the caller's RLS). The admin client's line edits are gated in
-- the service (loadEditableOrderHeader).
create function public.tg_order_request_lines_replacement_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if exists (select 1 from public.order_requests o
              where o.id = new.order_request_id and o.replacement_for_return_id is not null) then
    raise exception 'replacement_lines_fixed' using errcode = '42501', hint = 'replacement_lines_fixed';
  end if;
  return new;
end;
$$;

-- The return-first gate and the cancel guard (plan 3.6.5; C-5), for
-- replacement orders only (the trigger's WHEN clause). SECURITY DEFINER so
-- a picker without returns access is judged by the same facts (the release
-- lives in the staff-only decision log); EXECUTE for nobody (a trigger
-- needs none). It reads the RMA and the release by key and takes no row
-- lock: generatePickSlip holds the order row while an RMA cancel holds the
-- RMA and then waits for the order, so a lock here would deadlock.
--   Into pick_slip_generated (the pick slip, and resume from backorder):
--   never while the RMA is cancelled or denied, released or not (P0001
--   replacement_return_cancelled; desk check F3); otherwise only when the
--   RMA is received or closed, or a released_early decision names this
--   order; otherwise P0001 replacement_waiting_for_return.
--   Into cancelled or denied: only inside an RMA function, whose
--   transaction-bound flag holds this transaction's id; otherwise 42501
--   replacement_cancel_via_return (a requester's own cancel, a manager on
--   the order page).
--   Every other edge passes.
create function public.tg_order_requests_replacement_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_no     text;
begin
  if new.status = 'pick_slip_generated' then
    select r.status, r.return_number into v_status, v_no
      from public.returns r where r.id = new.replacement_for_return_id;
    if v_status in ('cancelled', 'denied') then
      raise exception 'replacement_return_cancelled' using errcode = 'P0001', hint = 'replacement_return_cancelled',
        detail = coalesce(v_no, '');
    end if;
    if v_status in ('received', 'closed')
       or exists (select 1 from public.return_decisions d
                   where d.order_request_id = new.id and d.kind = 'released_early'
                     and d.return_id = new.replacement_for_return_id) then
      return new;
    end if;
    raise exception 'replacement_waiting_for_return' using errcode = 'P0001', hint = 'replacement_waiting_for_return',
      detail = coalesce(v_no, '');
  end if;
  if new.status in ('cancelled', 'denied') then
    if coalesce(current_setting('stockpilot.return_exchange', true), '') = pg_current_xact_id()::text then
      return new;
    end if;
    select r.return_number into v_no from public.returns r where r.id = new.replacement_for_return_id;
    raise exception 'replacement_cancel_via_return' using errcode = '42501', hint = 'replacement_cancel_via_return',
      detail = coalesce(v_no, '');
  end if;
  return new;
end;
$$;

-- The requester pings of a replacement order (plan 3.6.7; G11, D24): the
-- same type strings, link and preference gates as
-- _notify_order_request_changes (0265), reworded, with the RMA in the
-- metadata. Silent on the insert, the approval (the exchange-approved
-- message covers it, so never "Order approved" plus "Exchange approved"),
-- cancellation (the RMA function's service sends one explaining message),
-- the picking statuses, and, for a unit received at the counter, ready for
-- pickup. Staff are never pinged for a replacement. A replacement completed
-- with something never sent (closed as delivered-partial) says so in plain
-- words (desk check F9).
create function public._notify_replacement_order_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient uuid;
  v_title     text;
  v_body      text;
  v_pref_ok   boolean;
  v_rma       record;
  v_counter   boolean;
begin
  if tg_op = 'INSERT' or old.status is not distinct from new.status then
    return new;
  end if;
  if new.status not in ('staged_for_pickup', 'staged_for_delivery', 'in_transit', 'backordered', 'completed') then
    return new;
  end if;
  v_recipient := new.requester_user_id;
  if v_recipient is null then
    return new;
  end if;
  select r.id, r.return_number, r.status into v_rma from public.returns r where r.id = new.replacement_for_return_id;
  -- At the counter the requester is standing there: "ready for pickup" is
  -- noise (plan 3.6.7, G11). A delivery still says it is ready or on its way.
  v_counter := exists (select 1 from public.return_decisions d
                        where d.return_id = new.replacement_for_return_id and d.kind = 'received' and d.channel = 'counter');
  if v_counter and new.status = 'staged_for_pickup' then
    return new;
  end if;

  case new.status
    when 'staged_for_pickup' then
      select coalesce(np.email_order_status_changed, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Your replacement is ready';
      v_body := 'Ready for pickup.';
    when 'staged_for_delivery' then
      select coalesce(np.email_order_status_changed, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Your replacement is ready';
      v_body := 'Ready for delivery.';
    when 'in_transit' then
      select coalesce(np.email_order_in_transit, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Your replacement is on the way';
      v_body := 'It''s out for delivery.';
    when 'backordered' then
      select coalesce(np.email_order_status_changed, true) into v_pref_ok
        from public.notification_preferences np where np.user_id = v_recipient;
      v_title := 'Part of your replacement was handed over';
      v_body := 'The rest will follow.';
    else
      -- completed: ungated, as the original body's completion ping. Closed
      -- with something never sent (delivered-partial; desk check F9) says so.
      v_pref_ok := true;
      if exists (select 1 from public.order_request_lines l
                  where l.order_request_id = new.id
                    and coalesce(l.quantity_requested, 0) > coalesce(l.quantity_fulfilled, 0)) then
        v_title := 'Your replacement order was closed';
        v_body := 'Part of it was handed over. The rest will not be sent.';
      elsif v_rma.status = 'closed' then
        v_title := 'Your exchange is complete';
        v_body := 'Your replacement was handed over and your return is done.';
      else
        v_title := 'Your replacement was handed over';
        v_body := 'Pickup or delivery is finalized.';
      end if;
  end case;
  if not coalesce(v_pref_ok, true) then
    return new;
  end if;

  insert into public.notifications (organization_id, user_id, type, title, body, link, metadata)
  values (new.organization_id, v_recipient, 'order_request.' || new.status, v_title, v_body,
          '/dashboard/orders/' || new.id::text,
          jsonb_build_object('order_request_id', new.id, 'warehouse_id', new.warehouse_id, 'source', new.source,
                             'requester_user_id', new.requester_user_id, 'requester_email', new.requester_email,
                             'return_id', v_rma.id, 'return_number', v_rma.return_number,
                             'replacement', true));
  return new;
end;
$$;

-- The RX-1 returns API guard, restated (plan 3.3.7, 3.8; C-4): an API-role
-- status change on an RMA that carries an exchange is refused (42501
-- return_exchange_through_rpc): an old tab never moves an exchange outside
-- the functions that keep its replacement in step. It reads
-- return_exchange_lines directly (every member reads it) and calls no
-- helper. Every other line is RX-1's (the lines added end in `-- RX-2`).
create or replace function public.tg_returns_api_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order_org uuid;
  v_wh        uuid;
  v_ostatus   text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- The old tab's create: requested, internal, no stamps (G2), and no
    -- requester identity (an internal RMA has none; the review found a raw
    -- insert could name any requester for the list to show).
    if new.status is distinct from 'requested' or new.source is distinct from 'internal'
       or new.approved_by is not null or new.approved_at is not null
       or new.received_by is not null or new.received_at is not null
       or new.closed_by is not null or new.closed_at is not null
       or new.denied_by is not null or new.denied_at is not null
       or new.denial_reason is not null
       or new.requester_name is not null or new.requester_email is not null then
      raise exception 'return_insert_through_rpc' using errcode = '42501', hint = 'return_insert_through_rpc';
    end if;
    if new.requested_by is null then
      new.requested_by := auth.uid();
    elsif new.requested_by is distinct from auth.uid() then
      raise exception 'return_stamp_forged' using errcode = '42501', hint = 'return_stamp_forged';
    end if;
    -- The RMA belongs to its order's organization, and the caller writes
    -- that order's warehouse (the functions' rule, D27). Read as the caller:
    -- an order the caller cannot see answers like a missing one. The insert
    -- policy holds the same two rules; this answers them with a hint.
    select o.organization_id, o.warehouse_id, o.status into v_order_org, v_wh, v_ostatus
      from public.order_requests o where o.id = new.order_request_id;
    if v_order_org is null or v_order_org is distinct from new.organization_id then
      raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
    end if;
    if not public.user_can_access_inventory(auth.uid(), v_wh, null, 'write') then
      raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
    end if;
    -- Only a handed-over order is returnable (the create functions' rule and
    -- the old service's; review fix): picks of an order still in flight are
    -- not units that left the building.
    if coalesce(v_ostatus, '') not in ('completed', 'delivered') then
      raise exception 'order_not_returnable' using errcode = 'P0001', hint = 'order_not_returnable',
        detail = v_ostatus;
    end if;
    -- The RMA number is the server's, in today's format (the old tab sends
    -- one; any value it sends is replaced, never trusted for display).
    new.return_number := 'RMA-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-'
                         || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    new.created_at := now();
    return new;
  end if;

  -- An update reaches this trigger only for a row the update policy let
  -- through: returns:manage and write access to the order's warehouse.

  if new.status is not distinct from old.status then
    -- No edge: none of the stamps may change.
    if (new.approved_by, new.approved_at, new.received_by, new.received_at,
        new.denied_by, new.denied_at, new.denial_reason)
       is distinct from
       (old.approved_by, old.approved_at, old.received_by, old.received_at,
        old.denied_by, old.denied_at, old.denial_reason) then
      raise exception 'return_stamp_forged' using errcode = '42501', hint = 'return_stamp_forged';
    end if;
    return new;
  end if;

  if exists (select 1 from public.return_exchange_lines xl where xl.return_id = old.id) then  -- RX-2
    raise exception 'return_exchange_through_rpc' using errcode = '42501', hint = 'return_exchange_through_rpc';  -- RX-2
  end if;  -- RX-2
  if new.status = 'closed' then
    raise exception 'return_close_through_rpc' using errcode = '42501', hint = 'return_close_through_rpc';
  end if;

  -- One edge, its own stamps only, naming the caller; the time is now().
  if new.status = 'approved' then
    if new.approved_by is distinct from auth.uid()
       or (new.received_by, new.received_at, new.denied_by, new.denied_at, new.denial_reason)
          is distinct from (old.received_by, old.received_at, old.denied_by, old.denied_at, old.denial_reason) then
      raise exception 'return_stamp_forged' using errcode = '42501', hint = 'return_stamp_forged';
    end if;
    new.approved_at := now();
  elsif new.status = 'received' then
    if new.received_by is distinct from auth.uid()
       or (new.approved_by, new.approved_at, new.denied_by, new.denied_at, new.denial_reason)
          is distinct from (old.approved_by, old.approved_at, old.denied_by, old.denied_at, old.denial_reason) then
      raise exception 'return_stamp_forged' using errcode = '42501', hint = 'return_stamp_forged';
    end if;
    new.received_at := now();
  elsif new.status = 'denied' then
    if new.denied_by is distinct from auth.uid()
       or (new.approved_by, new.approved_at, new.received_by, new.received_at)
          is distinct from (old.approved_by, old.approved_at, old.received_by, old.received_at) then
      raise exception 'return_stamp_forged' using errcode = '42501', hint = 'return_stamp_forged';
    end if;
    new.denied_at := now();
  elsif new.status = 'cancelled' then
    if (new.approved_by, new.approved_at, new.received_by, new.received_at,
        new.denied_by, new.denied_at, new.denial_reason)
       is distinct from
       (old.approved_by, old.approved_at, old.received_by, old.received_at,
        old.denied_by, old.denied_at, old.denial_reason) then
      raise exception 'return_stamp_forged' using errcode = '42501', hint = 'return_stamp_forged';
    end if;
  end if;
  return new;
end;
$$;

-- ── 1g. Posture: EXECUTE for authenticated on the staff RPCs and the list
-- view's flags read, the requester options for the service role only, and
-- nothing anywhere else (the internals run inside the DEFINER functions as
-- postgres; a trigger function needs no EXECUTE to fire). CREATE OR REPLACE
-- keeps the RX-1 hooks' and guard's ACLs; they are revoked again so the
-- posture is stated in one place.
revoke all on function public._return_exchange_requester_options(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_item_ok(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_replacement_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_replacement_class(uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_fulfilled(uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_lock_items(uuid, uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public._return_replacement_cancel_order(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_reason(text, integer) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_quantity(jsonb, numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function public._return_replacement_issue(uuid, jsonb, integer, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_create(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_approve(uuid, jsonb, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_on_deny(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_on_cancel(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_replay(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.tg_return_exchange_lines_validate() from public, anon, authenticated, service_role;
revoke all on function public.tg_return_decisions_exchange_requested() from public, anon, authenticated, service_role;
revoke all on function public.tg_order_requests_replacement_link() from public, anon, authenticated, service_role;
revoke all on function public.tg_order_request_lines_replacement_guard() from public, anon, authenticated, service_role;
revoke all on function public.tg_order_requests_replacement_status() from public, anon, authenticated, service_role;
revoke all on function public._notify_replacement_order_changes() from public, anon, authenticated, service_role;
revoke all on function public.tg_returns_api_guard() from public, anon, authenticated, service_role;

revoke all on function public.change_return_replacement(uuid, integer, jsonb, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.cancel_return_replacement(uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.release_return_replacement_early(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.decline_return_replacement(uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.return_exchange_candidates(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.return_exchange_options(uuid) from public, anon, authenticated, service_role;
revoke all on function public.return_exchange_flags(uuid) from public, anon, authenticated, service_role;
grant execute on function public.change_return_replacement(uuid, integer, jsonb, text, text, jsonb) to authenticated;
grant execute on function public.cancel_return_replacement(uuid, integer, text) to authenticated;
grant execute on function public.release_return_replacement_early(uuid, uuid, text) to authenticated;
grant execute on function public.decline_return_replacement(uuid, integer, text) to authenticated;
grant execute on function public.return_exchange_candidates(uuid, uuid, text, integer) to authenticated;
grant execute on function public.return_exchange_options(uuid) to service_role;
grant execute on function public.return_exchange_flags(uuid) to authenticated, service_role;

comment on function public._return_exchange_requester_options(uuid, boolean) is
  'RX-2 (plan 3.6.10): the requester tier. For each source line of a completed or delivered order whose item sits in a live, active product group of the order''s organization, the other variants a requester may ask for: same group and organization, another variant key (D3), the order''s warehouse, the same ownership charter, orderable (active, not deleted, not awaiting first receipt, not a rental, not a kit), not hidden (internal_only is offered, D4), and for a portal order on the active customer''s catalog. One row per variant key (most free stock, then id). p_check_budget keeps only lines with return budget left. Never name matching or sizes from custom fields. SECURITY INVOKER, STABLE, no API EXECUTE.';
comment on function public._return_exchange_item_ok(uuid, uuid, text, uuid) is
  'RX-2 (plan 3.6.2): whether an item may be a replacement for a line of this order. staff: the order''s organization, order_items_orderable in the order''s warehouse, and caller_can_read_item (the caller''s item scope). requester: one of the line''s requester options. Anything else false. One helper for the reads and the writes, so what is offered is what is accepted. SECURITY INVOKER, STABLE, no API EXECUTE.';
comment on function public._return_replacement_summary(uuid) is
  'RX-2: a replacement order as the exchange screens and a replay show it: id, number, status, and per line the item, the requested quantity and the active hold, plus short. SECURITY INVOKER, STABLE, no API EXECUTE.';
comment on function public._return_replacement_class(uuid) is
  'RX-2 (plan 3.3.5): a live replacement''s class, read under the caller''s row lock: undrawn (approved, pick slip, picking, or a backorder, with nothing handed over), drawn (picking_complete through in_transit, nothing handed over: cancel_order_request restocks the picked batch to Staging), handed_over (completed, or any status once anything was handed over, a resumed backorder included: desk check F2, never cancelled or changed from the RMA). SECURITY INVOKER, STABLE, no API EXECUTE.';
comment on function public._return_lock_items(uuid, uuid[], boolean) is
  'RX-2 (desk check F4): the lock order of every exchange writer, before the first row naming an item: the organization''s order-number advisory lock when an order will be issued (the one assign_order_request_number takes, 0254), then the items of the organization FOR UPDATE in id order. Two writers that both took key-share locks on one item (foreign-key checks) before approve_partial''s FOR UPDATE would deadlock; this order also matches create_order_request (order-number lock, then its items). SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_fulfilled(uuid) is
  'RX-2 (desk check F2): per exchange line, the units this RMA''s replacements (live or cancelled) already handed over for it: each replacement line''s quantity_fulfilled shared out among the exchange lines that order carried for that item (exchange_approved decisions), in exchange-line id order, each up to its approved quantity there. change_return_replacement caps every line at its returned quantity minus these units. SECURITY INVOKER, STABLE, no API EXECUTE.';
comment on function public._return_replacement_cancel_order(uuid, text, text) is
  'RX-2: cancels a replacement through the unchanged cancel_order_request with the transaction-bound stockpilot.return_exchange flag raised for that one call (the gate trigger lets exactly this cancel through; a pooled value never matches a later transaction). The order''s cancel note is a fixed sentence naming the RMA; staff reasons stay in return_decisions. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_reason(text, integer) is
  'RX-2: a reason trimmed and required (P0001 reason_required), at most p_max characters (22023 return_invalid, detail reason). SECURITY INVOKER, IMMUTABLE, no API EXECUTE.';
comment on function public._return_exchange_quantity(jsonb, numeric, numeric) is
  'RX-2: a replacement quantity: a JSON number, whole, at least 1 (22023 return_invalid, detail quantity), at most the returned quantity (P0001 exchange_quantity_exceeds_return; brief 4, no privileged exception). Null takes the default. SECURITY INVOKER, IMMUTABLE, no API EXECUTE.';
comment on function public._return_replacement_issue(uuid, jsonb, integer, jsonb) is
  'RX-2 (plan 3.6.1-3.6.3): creates the replacement order for an RMA as postgres, applying the order insert policy''s and both order guards'' rules itself: the original''s organization, warehouse, requester context and fulfilment (or the approver''s override; a delivery needs an active site the warehouse serves, P0001 replacement_site_not_available), a portal original''s active customer and portal user, a departed member as an email-only requester (D7), a deleted requester''s stamp carried; never notes, needed-by, workflow, token or signature columns; lines merged per item through the staff tier (P0001 exchange_item_not_eligible), cost stamped from the item, price 0 for a portal order (D9). Then the unchanged approve_partial in the same transaction (holds once), and under whenShort refuse a short line raises P0001 replacement_unavailable (detail [{itemId, needed, available}]) and the caller''s transaction rolls back. A second live replacement for the RMA gives P0001 return_changed. On the 0387 AL9d census of DEFINER order inserters on purpose. SECURITY DEFINER, lock_timeout 5s, EXECUTE for nobody.';
comment on function public._return_exchange_create(uuid, uuid, jsonb, jsonb) is
  'RX-2 hook body (plan 3.3.6): a create line carrying exchange {itemId?, quantity?, note?} gets its return_exchange_lines row in the create''s transaction; its exchange_requested decision follows the created decision (tg_return_decisions_exchange_requested, desk check F9). Staff tier for a staff create; the requester tier for a token, portal or member create, where any miss is P0001 exchange_item_not_eligible whatever the cause. No item is "the warehouse will review" and needs a note (1 to 500 characters). Quantity defaults to, and is capped by, the line''s return quantity. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_approve(uuid, jsonb, uuid, integer) is
  'RX-2 hook body (plan 3.3.3 step 6): every requested exchange line gets one decision (P0001 return_decision_incomplete): approve (the requested item or a staff choice; a choice differing from a requested item is a substitution and needs a reason, kept with the previous item), decline (reason required), or add (G9: a staff exchange on a return-only line). Every approved item passes the staff tier; every quantity is whole, 1 to the returned quantity. When anything is approved, one replacement order carries every approved line at revision p_revision + 1 (_return_replacement_issue: created, held by approve_partial, short checked), and exchange_approved and replacement_issued decisions are appended. approve_return checked the orders module and orders:approve before its row lock. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_on_deny(uuid, uuid) is
  'RX-2 hook body: a denied RMA declines every requested exchange line (exchange_declined decisions; the denial''s reason is on the denied decision). No replacement exists before approval. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_on_cancel(uuid, uuid, text) is
  'RX-2 hook body (plan 3.3.5, cancel_return row; X-1, X-2): once an exchange was approved, cancelling the RMA needs the orders module (P0001 module_disabled), orders:approve (42501 orders_approve) and a reason (P0001 reason_required); the live replacement is locked FOR UPDATE after the RMA and classified under that lock: undrawn or picked-not-handed-over is cancelled in this transaction (every hold released; a picked batch back to Staging through cancel_order_request''s own branch); handed over in full keeps its history and nothing moves (brief 34, D11); handed over in part is closed as delivered-partial when on backorder (close_partial) and its remainder cancelled when resumed into picking (desk check F3), so nothing more ships for a cancelled return. Requested lines are cancelled with the RMA. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_replay(uuid, integer) is
  'RX-2 hook body: a replay''s replacement answer is the order the replacement_issued decision of that revision names, read now; never the stored key response (managers can edit it). SECURITY INVOKER, STABLE, no API EXECUTE.';
comment on function public.change_return_replacement(uuid, integer, jsonb, text, text, jsonb) is
  'RX-2 (plan 3.3.5; brief 22; C-1): substitution, or a new replacement after a replacement cancel. p_lines [{exchangeLineId, itemId?, quantity?}] changes approved lines (the others keep theirs); p_reason 1 to 1,000 characters (P0001 reason_required); p_when_short refuse or backorder; p_replacement {fulfillmentType?, deliveryCharterId?} overrides the fulfilment. RMA approved, received or closed (P0001 invalid_status_transition); revision current (P0001 return_changed). The live replacement is locked after the RMA and classified: undrawn is cancelled (holds released, nothing restocked) and a new order created and held in one transaction; drawn gives P0001 replacement_already_drawn; handed over (anything handed over, a resumed backorder included) P0001 replacement_handed_over; none, with lines cancelled by a replacement cancel, issues a new one. Every line sends at most its returned quantity minus what this RMA''s replacements already handed over for it (_return_exchange_fulfilled; desk check F2): the default quantity is capped there, a larger one is P0001 exchange_quantity_exceeds_return, a line with nothing left is not re-issued, and when nothing is left at all P0001 replacement_handed_over. Gates: signed in (42501 unauthenticated), member (P0002 return_not_found), returns and orders modules (P0001 module_disabled), returns:manage (42501 returns_manage), orders:approve (42501 orders_approve), write access to the original order''s warehouse (42501 warehouse_write). Idempotent on (RMA, expected revision), scope return_replacement_change: the same change replays, another P0001 return_changed. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.cancel_return_replacement(uuid, integer, text) is
  'RX-2 (plan 3.3.5; X-1, X-2): keep the return, cancel the live replacement, reason 1 to 1,000 characters (P0001 reason_required). Locked after the RMA and classified under that lock: undrawn or picked-not-handed-over is cancelled through cancel_order_request under the exchange flag (every hold released; a picked batch goes back to Staging on record); handed over, in full or in part (a resumed backorder included), gives P0001 replacement_handed_over; none answers changed false. The expected revision is required (22023 return_invalid without it); a stale one gives P0001 return_changed (desk check F7). The lines read cancelled; the RMA itself does not change. Gates as change_return_replacement. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.decline_return_replacement(uuid, integer, text) is
  'RX-2 (desk check F9): keep the return only after a replacement cancel: every exchange line a replacement cancel left cancelled is declined for good (exchange_declined decisions with the reason, 1 to 1,000 characters, P0001 reason_required), so the RMA stops inviting a new replacement; each line keeps its last approved item and the cancelled replacement it named, for display; no cancelled line answers changed false. RMA approved, received or closed (P0001 invalid_status_transition); the expected revision is required (22023 return_invalid) and must be current (P0001 return_changed). Moves nothing and touches no order. Gates: signed in (42501 unauthenticated), member (P0002 return_not_found), the returns module (P0001 module_disabled), returns:manage (42501 returns_manage), write access to the original order''s warehouse (42501 warehouse_write). Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.release_return_replacement_early(uuid, uuid, text) is
  'RX-2 (brief 24; plan 3.3.5): a manager releases the live replacement for picking before the returned item arrives, with a reason of 1 to 500 characters (P0001 reason_required), only while the RMA is approved and the replacement approved (P0001 replacement_not_waiting otherwise). p_order_id is the replacement the caller saw (null: none); any other live replacement is P0001 return_changed (desk check F7). Appends released_early naming that order (a substituted order needs its own release, D10). An existing release of the live order replays; an RMA already received or closed answers changed false, reason not_needed. Gates as change_return_replacement. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.return_exchange_candidates(uuid, uuid, text, integer) is
  'RX-2 (plan 3.3.2): the staff replacement search for one line of an order, under the caller''s RLS (SECURITY INVOKER): the returned item''s product-group siblings first (the same size too), then name or SKU matches from two characters over active, orderable items in the order''s warehouse, 30 at most; free stock per item = on hand minus every active hold. Gates: signed in (42501 unauthenticated), the order readable (P0002 order_not_found), returns:manage (42501 returns_manage). STABLE, EXECUTE to authenticated only.';
comment on function public.return_exchange_options(uuid) is
  'RX-2 (plan 3.6.10): the requester tier''s options for an order, per line with budget left: [{orderRequestLineId, returnedItemId, options: [{itemId, variantKey, free}]}]. The server resolves the token, portal principal or member first and projects availability to two states (the count never leaves it). STABLE, SECURITY DEFINER, EXECUTE to service_role only.';
comment on function public.return_exchange_flags(uuid) is
  'RX-2: the exchange facts the list view reads from the staff-only decision log, for any member of the RMA''s organization (or the service role): releasedEarly (the live replacement), counter (received at the counter), revision. No reason, name or rack. Null for anyone else. STABLE, SECURITY DEFINER, EXECUTE to authenticated and service_role.';
comment on function public.tg_return_exchange_lines_validate() is
  'RX-2 (plan 3.1.3), BEFORE INSERT OR UPDATE on return_exchange_lines, every role (defence in depth: only the RX-2 functions write it): items, RMA and line in one organization; quantities at most the returned quantity (P0001 exchange_quantity_exceeds_return); the request fields never change (42501 exchange_request_immutable); status edges requested -> approved, declined or cancelled, approved -> approved at a newer revision or cancelled, cancelled -> approved only while the RMA is approved, received or closed, or cancelled -> declined (kept as a return only, desk check F9); a replacement named is this RMA''s and its line carries the approved item; the decision (approved item, quantity, approver, replacement order and line, revision) changes only on a move into approved, so a cancelled or declined line keeps the last it had and a line never approved names none (P0001 exchange_line_invalid). SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_return_decisions_exchange_requested() is
  'RX-2 (desk check F9), AFTER INSERT on return_decisions WHEN kind = created: logs the new RMA''s exchange_requested decisions right after its created decision (one per requested exchange line the log does not name yet, in order-line order, with the created decision''s channel and actor), so the log reads created first; _return_create_core (RX-1, frozen) runs the exchange hook before it appends created. SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_order_requests_replacement_link() is
  'RX-2 (plan 3.6.4): an API-role insert naming replacement_for_return_id is refused (42501 replacement_link_server_only), and nobody changes the column once written (42501 replacement_link_immutable). SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_order_request_lines_replacement_guard() is
  'RX-2 (plan 3.6.6): an API-role line insert on a replacement order is refused (42501 replacement_lines_fixed): a replacement''s items come from its RMA. SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_order_requests_replacement_status() is
  'RX-2 (plan 3.6.5; C-5), the return-first gate and the cancel guard for replacement orders: into pick_slip_generated never while the RMA is cancelled or denied (P0001 replacement_return_cancelled, detail the RMA number; desk check F3), otherwise only when the RMA is received or closed or a released_early decision names this order (P0001 replacement_waiting_for_return, detail the RMA number); into cancelled or denied only under the transaction-bound stockpilot.return_exchange flag (42501 replacement_cancel_via_return). Reads the RMA and the release by key and takes NO row lock (an RMA cancel holds the RMA and then waits for the order; generatePickSlip holds the order). SECURITY DEFINER (a picker without returns access is judged by the same facts), EXECUTE for nobody.';
comment on function public._notify_replacement_order_changes() is
  'RX-2 (plan 3.6.7): the requester pings of a replacement order, with _notify_order_request_changes'' type strings, link and preference gates, reworded, and the RMA in the metadata: staged for pickup or delivery, in transit, backordered, completed ("Your exchange is complete" once the RMA is closed; "Your replacement order was closed" with "the rest will not be sent" when it closed with something never sent, desk check F9). Silent on insert, approval, cancellation, denial and the picking statuses, and on ready for pickup after a counter receipt. Staff are never pinged for a replacement. SECURITY DEFINER, no EXECUTE.';
comment on function public.tg_returns_api_guard() is
  'RX-1 guard (BEFORE INSERT OR UPDATE on returns, API roles only): an insert only at requested, source internal, with no stamps and no requester name or email, requested_by the caller, for an order of the RMA''s own organization the caller can see (P0002 order_not_found) in a warehouse the caller may write (42501 warehouse_write), completed or delivered (P0001 order_not_returnable); the RMA number is the server''s; a status edge only with its own stamps, naming the caller, at now(); never on an RMA that carries an exchange (42501 return_exchange_through_rpc, RX-2); never into closed (42501 return_close_through_rpc); otherwise 42501 return_insert_through_rpc or return_stamp_forged. The update policy already limits an edge to returns:manage and write access to the order''s warehouse. SECURITY INVOKER, no EXECUTE.';

-- ═══ 2. The lock prelude (see LOCKS above) ════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level LOCK
-- TABLE refuses there, as 0373 found); the locks last until the batch commits.
-- Locking the view locks the tables its definition reads (returns,
-- order_requests, return_lines) in the same mode. The replaced view also
-- reads stock_reservations: parsing it takes ACCESS SHARE there, so the
-- prelude takes that too and nothing below waits for a lock.
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
      lock table only public.order_requests, public.return_decisions
        in access exclusive mode nowait;
      lock table public.return_overview in access exclusive mode nowait;
      lock table only public.organizations, public.returns, public.return_lines,
                      public.inventory_items, public.order_request_lines
        in share row exclusive mode nowait;
      lock table only public.stock_reservations in access share mode nowait;
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

-- Every lock the rest needs is held; nothing below may wait.
set lock_timeout = '900ms';

-- ═══ 3. return_exchange_lines (plan 3.1.3) ═════════════════════════════════
create table public.return_exchange_lines (
  id                           uuid primary key default gen_random_uuid(),
  organization_id              uuid not null references public.organizations(id) on delete cascade,
  return_id                    uuid not null,
  return_line_id               uuid not null unique,
  -- The request: written once, never changed (the validation trigger).
  requested_item_id            uuid references public.inventory_items(id),
  requested_quantity           numeric(14,4) not null
                                 check (requested_quantity > 0 and requested_quantity = trunc(requested_quantity)),
  request_note                 text check (request_note is null or length(btrim(request_note)) between 1 and 500),
  requested_by_kind            text not null check (requested_by_kind in ('staff', 'requester', 'portal_customer')),
  requested_by                 uuid,
  requested_at                 timestamptz not null default now(),
  -- The current decision (its history lives in return_decisions).
  status                       text not null default 'requested'
                                 check (status in ('requested', 'approved', 'declined', 'cancelled')),
  approved_item_id             uuid references public.inventory_items(id),
  approved_quantity            numeric(14,4)
                                 check (approved_quantity is null
                                        or (approved_quantity > 0 and approved_quantity = trunc(approved_quantity))),
  approved_by                  uuid,
  approved_at                  timestamptz,
  replacement_order_request_id uuid references public.order_requests(id),
  replacement_order_line_id    uuid references public.order_request_lines(id),
  revision                     integer not null default 0 check (revision >= 0),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint return_exchange_lines_request_chk check (requested_item_id is not null or request_note is not null),
  constraint return_exchange_lines_approved_chk check (
    status <> 'approved' or (approved_item_id is not null and approved_quantity is not null
                             and replacement_order_request_id is not null)),
  -- A requested line names no replacement. A cancelled line, and one declined
  -- after a replacement cancel ("Close as return only", desk check F9), keeps
  -- the last it had: the validation trigger changes a line's decision only on
  -- a move into approved, so a declined line names a replacement only when
  -- it was approved, then cancelled.
  constraint return_exchange_lines_unapproved_chk check (
    status <> 'requested' or replacement_order_request_id is null),
  constraint return_exchange_lines_id_return_key unique (id, return_id),
  constraint return_exchange_lines_return_fkey foreign key (return_id, organization_id)
    references public.returns (id, organization_id) on delete cascade,
  constraint return_exchange_lines_line_fkey foreign key (return_line_id, return_id)
    references public.return_lines (id, return_id) on delete cascade
);
create index return_exchange_lines_return_idx on public.return_exchange_lines (return_id);
create index return_exchange_lines_replacement_idx on public.return_exchange_lines (replacement_order_request_id)
  where replacement_order_request_id is not null;
create index return_exchange_lines_requested_item_idx on public.return_exchange_lines (requested_item_id)
  where requested_item_id is not null;
create index return_exchange_lines_approved_item_idx on public.return_exchange_lines (approved_item_id)
  where approved_item_id is not null;
create index return_exchange_lines_replacement_line_idx on public.return_exchange_lines (replacement_order_line_id)
  where replacement_order_line_id is not null;

create trigger trg_return_exchange_lines_validate
  before insert or update on public.return_exchange_lines
  for each row execute function public.tg_return_exchange_lines_validate();

alter table public.return_exchange_lines enable row level security;
-- Every member reads it, as every member reads returns (0279 posture): items,
-- quantities and statuses only; staff reasons live in return_decisions.
create policy return_exchange_lines_select on public.return_exchange_lines
  for select to authenticated
  using ((select public.is_org_member(organization_id)));
revoke all on public.return_exchange_lines from public, anon, authenticated;
grant select on public.return_exchange_lines to authenticated;
grant all on public.return_exchange_lines to service_role;

comment on table public.return_exchange_lines is
  'RX-2: one row per returned line that asks for a replacement (a return-only line has none). The request (requested item or "the warehouse will review" note, quantity, who asked) is written once and never changes; the current decision (requested, approved, declined, cancelled; the approved item, quantity, replacement order and line, revision) changes only through the RX-2 functions, and its history is in return_decisions. A cancelled row, and one declined after a replacement cancel, keeps its last approved item and order for display (the decision changes only on a move into approved; a requested row names no order). Read by every member; written only by SECURITY DEFINER functions (authenticated holds SELECT only). requested_by and approved_by have no foreign key (account deletion never fails).';

-- The decision log learns which exchange line an exchange decision is about.
alter table public.return_decisions
  add column exchange_line_id uuid,
  add constraint return_decisions_exchange_line_fkey foreign key (exchange_line_id, return_id)
    references public.return_exchange_lines (id, return_id) on delete cascade,
  add constraint return_decisions_exchange_shape_chk check (
    (kind in ('exchange_requested', 'exchange_approved', 'exchange_declined')) = (exchange_line_id is not null)
    and (kind not in ('exchange_requested', 'exchange_approved', 'exchange_declined') or return_line_id is not null)
    and (kind <> 'exchange_approved' or (item_id is not null and quantity is not null and order_request_id is not null))
    and (kind not in ('replacement_issued', 'replacement_changed', 'replacement_cancelled')
         or (revision is not null and order_request_id is not null)));
create index return_decisions_exchange_line_idx on public.return_decisions (exchange_line_id)
  where exchange_line_id is not null;
create trigger trg_return_decisions_exchange_requested
  after insert on public.return_decisions
  for each row
  when (new.kind = 'created')
  execute function public.tg_return_decisions_exchange_requested();
comment on column public.return_decisions.exchange_line_id is
  'RX-2: the return_exchange_lines row an exchange_requested, exchange_approved or exchange_declined decision is about (and only those kinds carry one).';

-- ═══ 4. The link column (plan 3.1.4) ═══════════════════════════════════════
alter table public.order_requests
  add column replacement_for_return_id uuid,
  add constraint order_requests_replacement_return_fkey foreign key (replacement_for_return_id, organization_id)
    references public.returns (id, organization_id);
create unique index order_requests_live_replacement_uniq on public.order_requests (replacement_for_return_id)
  where replacement_for_return_id is not null and status not in ('cancelled', 'denied');
create index order_requests_replacement_idx on public.order_requests (replacement_for_return_id)
  where replacement_for_return_id is not null;
comment on column public.order_requests.replacement_for_return_id is
  'RX-2: the RMA this order replaces items for (an exchange replacement). Written only by the exchange functions, as postgres. authenticated holds no INSERT or UPDATE on it (column grants since 0388 and 0384); trg_zz_order_requests_replacement_link_ins refuses it on an API-role insert and trg_zz_order_requests_replacement_link_upd refuses any change for every role. At most one live (not cancelled or denied) replacement per RMA (order_requests_live_replacement_uniq).';

-- ═══ 5. Triggers (plan 3.6.4-3.6.7) ════════════════════════════════════════
create trigger trg_zz_order_requests_replacement_link_ins
  before insert on public.order_requests
  for each row
  when (new.replacement_for_return_id is not null)
  execute function public.tg_order_requests_replacement_link();
create trigger trg_zz_order_requests_replacement_link_upd
  before update on public.order_requests
  for each row
  when (old.replacement_for_return_id is distinct from new.replacement_for_return_id)
  execute function public.tg_order_requests_replacement_link();

-- The gate sorts after trg_order_requests_validate_transition and
-- trg_order_requests_workflow_guard, so an illegal edge or a forbidden
-- caller is reported first. Ordinary orders never call it.
create trigger trg_order_requests_zz_replacement_status
  before update of status on public.order_requests
  for each row
  when (new.replacement_for_return_id is not null and old.status is distinct from new.status)
  execute function public.tg_order_requests_replacement_status();

create trigger trg_zz_order_request_lines_replacement_guard
  before insert on public.order_request_lines
  for each row execute function public.tg_order_request_lines_replacement_guard();

-- The notify split: ordinary orders keep _notify_order_request_changes,
-- byte-identical (a223ae83...); replacements get their own words. CREATE OR
-- REPLACE, never DROP: the trigger is never absent.
create or replace trigger trg_order_requests_notify
  after insert or update on public.order_requests
  for each row
  when (new.replacement_for_return_id is null)
  execute function public._notify_order_request_changes();
create trigger trg_order_requests_notify_replacement
  after insert or update on public.order_requests
  for each row
  when (new.replacement_for_return_id is not null)
  execute function public._notify_replacement_order_changes();

-- ═══ 6. The list read, exchange columns appended (plan 3.1.6, 3.10) ═══════
-- RX-1's columns keep their order and types; RX-2's follow deleted_users.
-- kind, the exchange lines and their counts, the newest replacement (the live
-- one when there is one), what it owes and holds, the flags from the
-- decision log (return_exchange_flags: the same answer for every member) and
-- the exchange status as ONE CASE, first match wins, in the order of core's
-- EXCHANGE_STATUSES (a vitest deep-equals the codes between the markers).
create or replace view public.return_overview with (security_invoker = true) as
select r.id,
       r.organization_id,
       r.return_number,
       r.status,
       r.source,
       r.reason_code,
       r.order_request_id,
       o.order_number,
       o.warehouse_id,
       coalesce(r.requester_name, o.requester_name) as requester_name,
       coalesce(r.requester_email, o.requester_email) as requester_email,
       o.requester_user_id,
       r.created_at,
       r.approved_at,
       r.received_at,
       r.closed_at,
       (select count(*)::integer from public.return_lines rl where rl.return_id = r.id) as line_count,
       (select coalesce(sum(rl.quantity), 0) from public.return_lines rl where rl.return_id = r.id) as unit_count,
       (select coalesce(jsonb_agg(jsonb_build_object(
                  'line_id', rl.id, 'item_id', rl.item_id, 'quantity', rl.quantity,
                  'disposition', rl.disposition, 'applied', rl.applied)
                order by rl.created_at, rl.id), '[]'::jsonb)
          from public.return_lines rl where rl.return_id = r.id) as lines,
       case when r.status = 'approved' and r.approved_at is not null
            then floor(extract(epoch from (now() - r.approved_at)) / 86400)::integer end as waiting_days,
       r.requested_by,
       r.deleted_users,
       case when coalesce(x.n, 0) > 0 then 'exchange' else 'return' end as kind,
       coalesce((f.flags->>'revision')::integer, 0) as exchange_revision,
       coalesce(x.lines, '[]'::jsonb) as exchange_lines,
       coalesce(x.any_requested, false) as any_requested,
       coalesce(x.n > 0 and x.n = x.declined, false) as all_declined,
       coalesce(x.requested_short, false) as requested_short,
       rep.id as replacement_order_id,
       rep.order_number as replacement_order_number,
       rep.status as replacement_status,
       rep.owed as replacement_owed,
       rep.held as replacement_held,
       coalesce((f.flags->>'releasedEarly')::boolean, false) as released_early,
       coalesce((f.flags->>'counter')::boolean, false) as counter,
       -- exchange-status:begin
       case
         when coalesce(x.n, 0) = 0 then 'none'
         when r.status = 'cancelled' and (rep.status = 'completed' or rep.fulfilled > 0)
           then 'handed_over_return_cancelled'
         when r.status in ('cancelled', 'denied') then 'cancelled'
         when r.status = 'requested' and x.any_requested then 'requested'
         when r.status in ('approved', 'received', 'closed') and x.n = x.declined then 'declined'
         when rep.status = 'completed' and r.status = 'closed' then 'completed'
         when rep.status = 'completed' then 'handed_over_return_open'
         when rep.status = 'backordered' then 'partly_handed_over'
         when rep.status in ('staged_for_delivery', 'in_transit') then 'out_for_delivery'
         when rep.status = 'staged_for_pickup' then 'ready_for_pickup'
         when rep.status in ('pick_slip_generated', 'picking_in_progress', 'picking_complete', 'packing_slip_generated')
           then 'in_progress'
         when (rep.id is null or rep.status in ('cancelled', 'denied')) and x.cancelled > 0
              and r.status in ('approved', 'received', 'closed') then 'replacement_cancelled'
         when rep.status = 'approved' and rep.held < rep.owed then 'unavailable'
         when rep.status = 'approved' and r.status = 'approved'
              and not coalesce((f.flags->>'releasedEarly')::boolean, false) then 'waiting_for_return'
         when rep.status = 'approved' then 'ready_to_pick'
       end as exchange_status
       -- exchange-status:end
  from public.returns r
  left join public.order_requests o on o.id = r.order_request_id
  left join lateral (
    select count(*)::integer as n,
           (count(*) filter (where xl.status = 'declined'))::integer as declined,
           (count(*) filter (where xl.status = 'cancelled'))::integer as cancelled,
           bool_or(xl.status = 'requested') as any_requested,
           bool_or(xl.status = 'requested' and xl.requested_item_id is not null
                   and xl.requested_quantity > ri.quantity_on_hand
                       - coalesce((select sum(sr.quantity) from public.stock_reservations sr
                                    where sr.item_id = ri.id and sr.released_at is null), 0)) as requested_short,
           jsonb_agg(jsonb_build_object(
             'id', xl.id, 'return_line_id', xl.return_line_id, 'status', xl.status,
             'requested_item_id', xl.requested_item_id, 'requested_quantity', xl.requested_quantity,
             'approved_item_id', xl.approved_item_id, 'approved_quantity', xl.approved_quantity)
             order by xl.created_at, xl.id) as lines
      from public.return_exchange_lines xl
      left join public.inventory_items ri on ri.id = xl.requested_item_id
     where xl.return_id = r.id
  ) x on true
  left join lateral (
    select o2.id, o2.order_number, o2.status,
           (select coalesce(sum(l.quantity_requested - l.quantity_fulfilled), 0)
              from public.order_request_lines l where l.order_request_id = o2.id) as owed,
           (select coalesce(sum(l.quantity_fulfilled), 0)
              from public.order_request_lines l where l.order_request_id = o2.id) as fulfilled,
           (select coalesce(sum(sr.quantity), 0)
              from public.stock_reservations sr where sr.order_request_id = o2.id and sr.released_at is null) as held
      from public.order_requests o2
     where o2.replacement_for_return_id = r.id
     order by (o2.status not in ('cancelled', 'denied')) desc, o2.created_at desc, o2.id desc
     limit 1
  ) rep on true
  left join lateral (
    select public.return_exchange_flags(r.id) as flags
     where coalesce(x.n, 0) > 0
  ) f on true;
revoke all on public.return_overview from public, anon, authenticated;
grant select on public.return_overview to authenticated, service_role;
comment on view public.return_overview is
  'RX-1, columns appended by RX-2: one row per RMA for the returns list (security_invoker: the caller''s RLS applies). Lines carry ids, quantities and dispositions only; item names, costs and locations come from the batched item read. waiting_days counts days since approval while approved. requested_by and deleted_users (0393) let the list name a requester who deleted their account "Deleted user". RX-2: kind (return or exchange), exchange_revision, exchange_lines, any_requested, all_declined, requested_short (advice: a requested item''s free stock is below its quantity, under the caller''s item scope), the newest replacement (the live one when there is one: id, number, status, owed, held), released_early and counter (return_exchange_flags, the same for every member), and exchange_status, one CASE between the exchange-status markers in core''s EXCHANGE_STATUSES order.';

reset lock_timeout;
