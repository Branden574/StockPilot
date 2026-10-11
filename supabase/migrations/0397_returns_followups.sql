-- 0397_returns_followups.sql
--
-- RETURNS AND EXCHANGES, SLICE RX-4 (part 1 of 2): the follow-ups the RX-2
-- and RX-3 reviews assigned to a migration (owner GO 2026-10-02; plan
-- stockpilot-work/returns-exchange/plan.md sections 3.3.1, 3.3.5, 3.6.10,
-- 3.7 and 4 RX-4; RX3-NOTES "(a) Close the rest, the AMENDED PROPOSAL",
-- option (i); RX-3 security desk check findings 1 and 2; RX-3 stock desk
-- check F5). The migration number is a placeholder fixed at push time (plan
-- 1.3): no function body names it. Lines this file adds to a 0396 body end
-- in `-- RX-4`; every other line of a restated body is 0396's, byte for byte
-- (the pgTAP file proves it by stripping the tagged lines and comparing md5).
--
-- No existing row is written. Every statement below creates a function,
-- replaces one of two 0396 bodies, or widens return_decisions' kind CHECK by
-- one value and adds one CHECK every existing row satisfies.
--
-- ── WHAT IT CHANGES ────────────────────────────────────────────────────────
--   1. "Close the rest" (RX-2 verification V3; completeness C-6):
--      public.close_return_replacement_rest(return, expected revision,
--      reason, shown status). A replacement handed over in part whose rest
--      is on backorder, under an RMA already received or closed, had no way
--      to end: the header guard refuses close_partial outside an RMA
--      function, cancel_return needs a requested or approved RMA, and the
--      replacement cancel and change refuse anything handed over. This
--      function closes it as delivered-partial from the RMA (close_partial,
--      unchanged, under the transaction-bound exchange flag, raised by the
--      internal helper _return_replacement_close_partial, which no API role
--      may execute: security review F-5): every hold on
--      the rest released, nothing moved, what was handed over kept as the
--      record. It appends a NON-HEAD decision 'replacement_closed' (reason
--      and order, no revision): the RMA's revision does not move, so no head
--      kind list anywhere changes. Out of scope, stated: a rest already
--      resumed into picking (replacement_not_backordered; the order's own
--      paths end it).
--   2. The requester token lookup by POST (RX-3 security review, finding 1):
--      public.order_id_for_return_token(token), SECURITY DEFINER, EXECUTE for
--      service_role only. The web resolved a return token with a PostgREST
--      GET whose query string carried the raw token into the API gateway's
--      logs; an RPC carries it in a POST body.
--   3. The requester tier's lock set (RX-3 security review, finding 2):
--      _return_exchange_create key-shared EVERY item id a requester body
--      named, before eligibility was known. For a requester (token, portal,
--      member) it now key-shares only an item that is one of that line's own
--      options, still in id order; any other id is never locked and still
--      answers the one generic exchange_item_not_eligible.
--   4. Used-up lines (RX-3 stock desk check F5): return_exchange_options left
--      sizes on a line whose exchange budget was used up (a replacement
--      handed over under a cancelled RMA), so a requester picked a size and
--      was refused exchange_already_sent. Such a line is now left out, so
--      sizes are never offered there.
--
-- ── STOCK SEMANTICS ────────────────────────────────────────────────────────
-- Nothing here moves stock. close_partial releases the backorder's holds and
-- moves the order to completed (0390's body, pinned below); quantity_fulfilled
-- stays the record of what was handed over. sum(holdings) = stock on record is
-- untouched (no movement is written).
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- close_return_replacement_rest: (1) the RMA row FOR UPDATE, (2) the live
-- replacement FOR UPDATE (plan X-2; INV-C7), then close_partial re-takes the
-- order row (held) and updates its reservations. It names no item (the
-- decision row carries no item), so it takes no item lock. resume_fulfillment
-- and complete_picking take the order and then items, never the RMA; the
-- return-first gate reads the RMA without a lock: no cycle.
--
-- The functions (all plpgsql) lock no table, so they come first. Then one
-- NOWAIT prelude (0390's, RX-1's and RX-2's pattern) takes the only table
-- lock the rest needs: ACCESS EXCLUSIVE on return_decisions (DROP and ADD
-- CONSTRAINT; the new CHECKs scan its rows, 5 in production on 2026-10-11).
-- No policy is created or altered, so supautils takes nothing more. A busy
-- table fails one attempt, its subtransaction releases what it took, and the
-- next attempt starts after 50 to 150 ms holding nothing, up to 40 attempts;
-- then 55P03 and nothing is applied
-- (scripts/db-concurrency/0397_migration_lock_footprint.sh). lock_timeout is
-- 5s for the file and 900ms after the prelude.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- 42501, P0001, P0002, 22023 and 55P03 only, each with a stable hint the app
-- maps (packages/core/src/returns/return-error-map.ts; this file adds
-- replacement_not_backordered). No function here raises the two retryable
-- classes PostgREST would re-run forever (0367).

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- Every body this file replaces, and every body the new functions call, must
-- be the one this file was written against: the two replaced bodies as 0396
-- built them (in production since 2026-10-11), close_partial and the gates
-- as production has them (read-only, 2026-10-11), and the order_requests
-- trigger bodies the close relies on when close_partial moves a replacement
-- from backordered to completed (fix round 1, desk check stock S2: the
-- requester's ping, the replacement status rule, the transition table and
-- the workflow guard; production matched every value on 2026-10-11).
-- Anything else is drift: stop before changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        -- The two 0396 bodies this file replaces.
        ('public._return_exchange_create(uuid,uuid,jsonb,jsonb)',              '7d70d30499d6c5f0cfca77dd77749eb0', false),
        ('public.return_exchange_options(uuid)',                               '7935b669804dcc975f049327ec7a2759', true),
        -- The 0396 helpers the new and restated bodies call, unchanged.
        ('public._return_exchange_requester_options(uuid,boolean)',            'c9a8b3ff98fa7e53e1befaeb39b52c55', false),
        ('public._return_exchange_item_ok(uuid,uuid,text,uuid)',               '60a9e392712860018a5c3d814aa285eb', false),
        ('public._return_exchange_line_budget(uuid,uuid)',                     'a19c4994d724a227dfbb5d35b7f0d7c0', false),
        ('public._return_exchange_reason(text,integer)',                       '163dda67663e57bf0f7a7f680deae8dd', false),
        ('public._return_replacement_class(uuid)',                             'fb118357c2024c55f80c095f783c68f1', false),
        -- The header guard that admits backordered -> completed only under the
        -- exchange flag (security review F-1), and the RMA cancel's sibling.
        ('public.tg_order_requests_replacement_header()',                      'b7220c36c4f78792f698adfbd8da79ea', false),
        ('public.cancel_return_replacement(uuid,integer,text,text)',           '9e42b480d4a77b1ccde60f10fc858d44', true),
        -- The order function the close calls, unchanged (0390's body,
        -- production's since; the 0396 preflight pins the same value).
        ('public.close_partial(uuid)',                                         'a519c3e58fb577c3ff1b30fb3a6cc0ad', true),
        -- The gates, as production has them (plan 3.12).
        ('public.has_permission(uuid,text)',                                   'cc0accdad7e2fdf4f88aa82aa887e85f', true),
        ('public.user_can_access_inventory(uuid,uuid,uuid,text)',              '8a214b77e32a052ca3bf07a2be39a8ae', true),
        ('public.is_org_member(uuid)',                                         '76492a6556e9f6a7c33d942aa9726f9f', true),
        ('public.module_enabled(uuid,text)',                                   'df3260cbcd15f986798e5377d1e95dce', true),
        -- The order_requests trigger bodies close_partial fires on a
        -- replacement (backordered -> completed), as production has them.
        ('public._notify_replacement_order_changes()',                         '543131721dbd9c04bb954b447e389972', true),
        ('public.tg_order_requests_replacement_status()',                      '38b9236c6e628e63f39eac5d8d1c83ff', true),
        ('public._validate_order_request_status_transition()',                 'dee8cd4782ec83abdb31a2b48fcd4ef2', false),
        ('public.tg_order_requests_workflow_guard()',                          '55bceafc13d599f8d77d6a4180c28140', false)
      ) v(sig, want_src, want_secdef)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  -- RX-2 (0396) comes first: its exchange table and the link column.
  if to_regclass('public.return_exchange_lines') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'order_requests'
                       and column_name = 'replacement_for_return_id') then
    v_bad := v_bad || ' the RX-2 objects are missing (push 0396 first);';
  end if;

  -- The kind CHECK this file widens, as 0394 wrote it (14 kinds).
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'public.return_decisions'::regclass and c.conname = 'return_decisions_kind_check')
     is distinct from 'CHECK ((kind = ANY (ARRAY[''created''::text, ''approved''::text, ''denied''::text, ''received''::text, '
                      || '''cancelled''::text, ''closed''::text, ''disposition_planned''::text, ''exchange_requested''::text, '
                      || '''exchange_approved''::text, ''exchange_declined''::text, ''replacement_issued''::text, '
                      || '''replacement_changed''::text, ''replacement_cancelled''::text, ''released_early''::text])))' then
    v_bad := v_bad || ' return_decisions_kind_check is not 0394''s;';
  end if;

  -- Already applied (or half applied by hand): every new name must be free.
  if to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)') is not null
     or to_regprocedure('public.order_id_for_return_token(uuid)') is not null
     or to_regprocedure('public._return_replacement_close_partial(uuid)') is not null
     or exists (select 1 from pg_constraint c
                 where c.conrelid = 'public.return_decisions'::regclass
                   and c.conname = 'return_decisions_replacement_closed_chk') then
    v_bad := v_bad || ' the RX-4 follow-up objects already exist;';
  end if;

  if v_bad <> '' then
    raise exception 'rx4_followups_preflight: %', v_bad
      using errcode = '55000', hint = 'rx4_followups_preflight';
  end if;
end
$preflight$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═════════════

-- ── 1a. The requester tier's lock set (RX-3 security review, finding 2) ───
-- 0396's hook body with the tagged lines added: for a requester the item
-- key-shares are limited to items that are one of the naming line's own
-- options (_return_exchange_requester_options, the same predicate
-- _return_exchange_item_ok asks a moment later), still in id order, still
-- before the budget lock (0396 A12). A non-sibling or foreign id is never
-- locked and still answers exchange_item_not_eligible.
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
  v_room  numeric;
  v_note  text;
  v_xl    uuid;
  l       jsonb;
  x       jsonb;
  v_lockable uuid[];  -- RX-4
begin
  if jsonb_typeof(p_actor->'userId') = 'string' and (p_actor->>'userId') ~ c_uuid then
    v_actor := (p_actor->>'userId')::uuid;
  end if;
  select r.organization_id into v_org from public.returns r where r.id = p_return_id;

  -- Review S1: when any line asks for an exchange, the requested items
  -- key-shared in id order (the lock the exchange rows' foreign keys take
  -- anyway, taken first so no writer waits for an item while holding a
  -- budget lock), then the budget lock of every original line of this RMA.
  if exists (select 1 from jsonb_array_elements(coalesce(p_request->'lines', '[]'::jsonb)) as y
              where jsonb_typeof(y) = 'object' and coalesce(y->'exchange', 'null'::jsonb) <> 'null'::jsonb) then
    -- RX-4 (RX-3 security review, finding 2): a requester key-shares only an  -- RX-4
    -- item that is one of the naming line's own options (the canonical body  -- RX-4
    -- carries each line id lowercased; uuid::text is lowercase too).  -- RX-4
    if v_tier = 'requester' then  -- RX-4
      v_lockable := array(select o.item_id  -- RX-4
                            from public._return_exchange_requester_options(p_order_id, false) o  -- RX-4
                           where o.order_request_line_id::text || ':' || o.item_id::text = any (array(  -- RX-4
                                   select (y->>'orderRequestLineId') || ':' || lower(y->'exchange'->>'itemId')  -- RX-4
                                     from jsonb_array_elements(coalesce(p_request->'lines', '[]'::jsonb)) as y  -- RX-4
                                    where jsonb_typeof(y) = 'object' and jsonb_typeof(y->'exchange') = 'object'  -- RX-4
                                      and jsonb_typeof(y->'exchange'->'itemId') = 'string')));  -- RX-4
    end if;  -- RX-4
    perform 1
       from public.inventory_items ii
      where ii.organization_id = v_org
        and ii.id = any (array(
              select (y->'exchange'->>'itemId')::uuid
                from jsonb_array_elements(coalesce(p_request->'lines', '[]'::jsonb)) as y
               where jsonb_typeof(y) = 'object' and jsonb_typeof(y->'exchange') = 'object'
                 and jsonb_typeof(y->'exchange'->'itemId') = 'string' and (y->'exchange'->>'itemId') ~ c_uuid))
        and (v_tier = 'staff' or ii.id = any (coalesce(v_lockable, '{}'::uuid[])))  -- RX-4
      order by ii.id
        for key share;
    perform public._return_lock_exchange_budget(
      array(select rl.order_request_line_id from public.return_lines rl where rl.return_id = p_return_id));
  end if;

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
    -- Review S1: never more than the original line has left to exchange.
    v_room := least(v_rl.quantity, greatest(public._return_exchange_line_budget(p_return_id, v_rl.order_request_line_id), 0));
    if v_qty > v_room then
      raise exception 'exchange_already_sent' using errcode = 'P0001', hint = 'exchange_already_sent',
        detail = jsonb_build_object('quantity', trim_scale(v_qty), 'available', trim_scale(v_room))::text;
    end if;
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

-- ── 1b. Used-up lines (RX-3 stock desk check F5) ──────────────────────────
-- 0396's body with the tagged lines added: a line whose exchange budget is
-- used up is left out, so its sizes are never offered. The budget is the one
-- the create applies to a new RMA (_return_exchange_line_budget counts every
-- RMA but the one it is given; the nil uuid names no RMA, so every live RMA
-- counts, exactly the room a new request's create finds), read once per
-- order line.
create or replace function public.return_exchange_options(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare  -- RX-4
  v_open uuid[];  -- RX-4
begin
  v_open := array(select l.id from public.order_request_lines l  -- RX-4
                   where l.order_request_id = p_order_id  -- RX-4
                     and public._return_exchange_line_budget('00000000-0000-0000-0000-000000000000'::uuid, l.id) > 0);  -- RX-4
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
             where o.order_request_line_id = any (v_open)  -- RX-4
             group by o.order_request_line_id, o.returned_item_id) g), '[]'::jsonb);
end;
$$;

-- ── 1c. The requester token lookup by POST (RX-3 security review, 1) ──────
-- The order a requester return token opens, read from the service-only
-- side table (every return token lives there since 0392). The web calls it
-- with .rpc(), a POST, so the token never travels in a URL or a query string
-- the API gateway logs. Service role only: the token path has no JWT, and the
-- caller (the web's admin client) has already rate-limited and shape-checked
-- the token. Null for an unknown token.
create function public.order_id_for_return_token(p_token uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
begin
  if p_token is null then
    return null;
  end if;
  select s.order_request_id into v_order
    from public.order_request_secrets s
   where s.return_token = p_token;
  return v_order;
end;
$$;

-- ── 1d. The flag around close_partial (an internal helper) ────────────────
-- Close the rest's one flagged call, the twin of _return_replacement_cancel_order:
-- SECURITY INVOKER with EXECUTE for nobody (it runs inside the DEFINER
-- function below, as postgres), so no API-callable function sets the
-- exchange flag itself (security review F-5). It raises the flag with this
-- transaction's id, calls close_partial (unchanged: releases the backorder's
-- holds, backordered -> completed, which the header guard admits only under
-- the flag) and restores the previous value.
create function public._return_replacement_close_partial(p_order_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_prev text := current_setting('stockpilot.return_exchange', true);
begin
  perform set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
  perform public.close_partial(p_order_id);
  perform set_config('stockpilot.return_exchange', coalesce(v_prev, ''), true);
end;
$$;

-- ── 1e. Close the rest (RX-2 verification V3; RX3-NOTES option (i)) ───────
-- A replacement handed over in part, with the rest on backorder, under an
-- RMA already received or closed: close it as delivered-partial from the RMA.
-- Gates in the 3.3.1 order before any lock: signed in; the RMA read without
-- a lock (missing and foreign answer alike, P0002 return_not_found); the
-- Returns and Orders modules; returns:manage; orders:approve; write access to
-- the original order's warehouse. Then a reason (1 to 1,000 characters) and
-- the revision the caller saw. Then the RMA row FOR UPDATE and the live
-- replacement FOR UPDATE, and write access to the REPLACEMENT's warehouse too
-- (RX-2 verification V-1: the two are the same unless the original order was
-- moved by a raw PATCH; checked under the lock, so it costs nothing in the
-- common case). The revision (head kinds, unchanged) must be the one the
-- caller saw (P0001 return_changed). A replacement already completed by an
-- earlier "Close the rest" answers {changed: false, replay: true} and writes
-- nothing. p_shown_status, when given, is the replacement's status as the
-- caller's screen showed it: a different live status is return_changed (RX-2
-- fix round 1's convention). The RMA must be received or closed (an approved
-- RMA keeps cancel_return's own close; P0001 invalid_status_transition), and
-- the live replacement backordered with something handed over (P0001
-- replacement_not_backordered, detail its status or 'none'; a rest resumed
-- into picking is out of scope). Then close_partial, unchanged, under the
-- transaction-bound flag the header guard asks for, raised and restored by
-- _return_replacement_close_partial: every hold on the rest released,
-- backordered -> completed, nothing moved.
-- Appends 'replacement_closed' (reason, the order; no revision: the RMA's
-- revision does not move). The replacement's own notify trigger tells its
-- requester (the part-never-sent completion words); the app adds the order's
-- trail (order.closed_partial, order.completed, the broadcast, the return
-- prompt). Never 40001 or 40P01; a lock wait past 5 s is 55P03.
create function public.close_return_replacement_rest(p_return_id uuid, p_expected_revision integer, p_reason text,
                                                     p_shown_status text default null)
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
  v_live    record;
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
  v_reason := public._return_exchange_reason(p_reason, 1000);
  if p_expected_revision is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'expectedRevision';
  end if;

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  select o.id, o.status, o.warehouse_id, o.order_number into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
     for update;
  if v_live.id is not null and v_live.warehouse_id is distinct from v_wh
     and not public.user_can_access_inventory(v_user, v_live.warehouse_id, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;

  select coalesce(max(d.revision), 0) into v_rev
    from public.return_decisions d
   where d.return_id = p_return_id
     and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled');
  if v_rev <> p_expected_revision then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
  end if;
  if v_status not in ('received', 'closed') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_status;
  end if;

  -- Already closed by an earlier "Close the rest" (a resend after a lost
  -- answer, or a second click that waited on the RMA lock): nothing to do.
  if v_live.id is not null and v_live.status = 'completed'
     and exists (select 1 from public.return_decisions d
                  where d.return_id = p_return_id and d.kind = 'replacement_closed'
                    and d.order_request_id = v_live.id) then
    return jsonb_build_object('changed', false, 'replay', true, 'returnId', p_return_id, 'status', v_status,
                              'revision', v_rev, 'closedOrderId', v_live.id, 'orderNumber', v_live.order_number);
  end if;

  if p_shown_status is not null and v_live.status is distinct from p_shown_status then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
  end if;
  if v_live.id is null or v_live.status <> 'backordered'
     or public._return_replacement_class(v_live.id) <> 'handed_over' then
    raise exception 'replacement_not_backordered' using errcode = 'P0001', hint = 'replacement_not_backordered',
      detail = coalesce(v_live.status, 'none');
  end if;

  -- The header guard admits backordered -> completed only under this
  -- transaction's flag (security review F-1): the internal helper raises it
  -- around close_partial and restores it.
  perform public._return_replacement_close_partial(v_live.id);

  insert into public.return_decisions (organization_id, return_id, kind, channel, order_request_id, reason,
                                       actor_user_id, actor_kind)
  values (v_org, p_return_id, 'replacement_closed', 'staff', v_live.id, v_reason, v_user, 'staff');

  return jsonb_build_object('changed', true, 'replay', false, 'returnId', p_return_id, 'status', v_status,
                            'revision', v_rev, 'closedOrderId', v_live.id, 'orderNumber', v_live.order_number);
end;
$$;

revoke all on function public._return_exchange_create(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.return_exchange_options(uuid) from public, anon, authenticated, service_role;
grant execute on function public.return_exchange_options(uuid) to service_role;
revoke all on function public.order_id_for_return_token(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_id_for_return_token(uuid) to service_role;
revoke all on function public._return_replacement_close_partial(uuid) from public, anon, authenticated, service_role;
revoke all on function public.close_return_replacement_rest(uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.close_return_replacement_rest(uuid, integer, text, text) to authenticated;

comment on function public._return_exchange_create(uuid, uuid, jsonb, jsonb) is
  'RX-2 hook body (plan 3.3.6), lock set narrowed by RX-4: a create line carrying exchange {itemId?, quantity?, note?} gets its return_exchange_lines row in the create''s transaction; its exchange_requested decision follows the created decision (tg_return_decisions_exchange_requested, desk check F9). Staff tier for a staff create; the requester tier for a token, portal or member create, where any miss is P0001 exchange_item_not_eligible whatever the cause. No item is "the warehouse will review" and needs a note (1 to 500 characters). Quantity defaults to, and is capped by, the line''s return quantity, and by what the original line has left to exchange (review S1: P0001 exchange_already_sent, detail {quantity, available}; _return_exchange_line_budget under the lines'' budget lock, taken after the requested items are key-shared in id order). RX-4 (RX-3 security review, finding 2): for a requester only an item that is one of its line''s own options is key-shared, so a body naming any other id locks nothing of it. SECURITY INVOKER, no API EXECUTE.';
comment on function public.return_exchange_options(uuid) is
  'RX-2 (plan 3.6.10), used-up lines left out by RX-4: the requester tier''s options for an order, per line with return budget AND exchange budget left (RX-3 stock desk check F5: a line whose units were already replaced under a cancelled RMA offers no sizes): [{orderRequestLineId, returnedItemId, options: [{itemId, variantKey, free}]}]. The server resolves the token, portal principal or member first and projects availability to two states (the count never leaves it). STABLE, SECURITY DEFINER, EXECUTE to service_role only.';
comment on function public.order_id_for_return_token(uuid) is
  'RX-4 (RX-3 security review, finding 1): the order a requester return token opens, from order_request_secrets; null for an unknown token. Called by the web''s admin client with .rpc() (a POST), so the raw token never reaches a URL or the API gateway''s query-string logs. STABLE, SECURITY DEFINER, EXECUTE to service_role only.';
comment on function public._return_replacement_close_partial(uuid) is
  'RX-4: Close the rest''s one flagged call: raises stockpilot.return_exchange with this transaction''s id, calls the unchanged close_partial (the header guard admits backordered -> completed only under the flag) and restores the previous value. The twin of _return_replacement_cancel_order. SECURITY INVOKER, no EXECUTE for any role: only close_return_replacement_rest (DEFINER, as postgres) calls it, so no API-callable function sets the flag itself (security review F-5).';
comment on function public.close_return_replacement_rest(uuid, integer, text, text) is
  'RX-4 "Close the rest" (RX-2 verification V3): a replacement handed over in part with the rest on backorder, under an RMA received or closed, is closed as delivered-partial (close_partial under the transaction-bound exchange flag): holds on the rest released, nothing moved, the handed-over record kept. Gates before any lock: signed in, member (P0002 return_not_found), Returns and Orders modules (P0001 module_disabled), returns:manage (42501 returns_manage), orders:approve (42501 orders_approve), write access to the original order''s warehouse (42501 warehouse_write); a reason of 1 to 1,000 characters (P0001 reason_required); the revision the caller saw (22023 return_invalid when missing). Locks the RMA, then the live replacement (and asks write access to its warehouse too, verification V-1). Stale revision or a shown status that is no longer the replacement''s: P0001 return_changed. RMA not received or closed: P0001 invalid_status_transition. Nothing on backorder handed over in part: P0001 replacement_not_backordered (detail its status). A replacement already closed this way replays {changed: false}. Appends the non-head decision replacement_closed (reason, order). Never 40001 or 40P01.';

-- ═══ 2. The lock prelude (see LOCKS above) ════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level LOCK
-- TABLE refuses there, as 0373 found); the lock lasts until the batch commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.return_decisions in access exclusive mode nowait;
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

-- ═══ 3. The decision log learns 'replacement_closed' ══════════════════════
-- A non-head kind (the RMA's revision does not move), so no head-kind list
-- changes: return_decisions_revision_uniq, return_decisions_kind_shape_chk,
-- return_exchange_flags and every function's revision read stay as they are.
alter table public.return_decisions
  drop constraint return_decisions_kind_check,
  add constraint return_decisions_kind_check check (kind in (
    'created', 'approved', 'denied', 'received', 'cancelled', 'closed',
    'disposition_planned',
    'exchange_requested', 'exchange_approved', 'exchange_declined',
    'replacement_issued', 'replacement_changed', 'replacement_cancelled',
    'released_early',
    'replacement_closed')),
  add constraint return_decisions_replacement_closed_chk check (
    kind <> 'replacement_closed'
    or (reason is not null and order_request_id is not null and revision is null and return_line_id is null));

comment on table public.return_decisions is
  'RX-1: the append-only RMA decision log (created, approved, denied, received, cancelled, closed, disposition_planned; RX-2 adds the exchange kinds; RX-4 adds replacement_closed, a non-head kind: "Close the rest" closed a part-handed-over replacement''s backorder, with its reason and order and no revision). A line''s live plan is its highest-seq disposition_planned row; the RMA''s revision is the highest revision over approved, replacement_changed, replacement_cancelled and cancelled. Written only by the RMA functions; no row is ever updated (trigger) and authenticated holds SELECT only. Read with returns:read or returns:manage: reasons and racks are staff information. location_id has no foreign key (draws carry none); actor_user_id has none (account deletion never fails).';

reset lock_timeout;
