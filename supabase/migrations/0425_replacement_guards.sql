-- 0425_replacement_guards.sql
--
-- RETURNS AND EXCHANGES, HARDENING (docket item S7, slice S7a): the guard on
-- a replacement order's lines now holds for every role, and every RMA
-- function that acts on a replacement asks write access to the
-- replacement's own warehouse, before its first row lock. The migration
-- number is provisional, fixed when the kit starts (the next free number,
-- never ahead of a queued kit): no function body names it. Every line this
-- file adds to a restated body ends in `-- S7`; every other line is the
-- latest body's, byte for byte (the pgTAP file proves it by stripping the
-- tagged lines and comparing md5, R1). The lines guard is rewritten and
-- pinned by its full md5 (R2), and so is the new parent read it asks.
--
-- No row is written. Every statement below creates two functions (the gate
-- helper and the lines guard's parent read), replaces six function bodies
-- and two trigger function bodies, restates their comments, revokes and one
-- grant, and replaces two trigger definitions with CREATE OR REPLACE TRIGGER
-- (never DROP: neither trigger is ever absent).
--
-- ── WHAT IT CHANGES ────────────────────────────────────────────────────────
--   1. A replacement's lines, for every role (review V7). The 0396 guard
--      (tg_order_request_lines_replacement_guard) returned at once for any
--      writer but anon and authenticated (0396:2385-2387), and its trigger
--      fired BEFORE INSERT only (0396:3002-3004). So the service role and
--      every SECURITY DEFINER order function (running as postgres) could add
--      a line to an approved replacement, and nobody's UPDATE was guarded:
--      a line's item, quantity or cost could change, a line could move into
--      or out of a replacement, and what was handed over could go down
--      (which reopens Cancel and Change and lets a re-issue send the same
--      units again). The trigger now fires BEFORE INSERT OR UPDATE (same
--      name, same sort position) and the guard asks, in order:
--        a. an UPDATE that changes only the workflow columns (quantity_picked,
--           picked_at, picked_by, quantity_packed, packed_at, packed_by,
--           quantity_fulfilled, returned_quantity) and keeps their six value
--           rules (quantity_fulfilled and returned_quantity never go down;
--           quantity_fulfilled <= quantity_requested; returned_quantity <=
--           quantity_fulfilled; quantity_picked <= quantity_requested;
--           quantity_packed <= quantity_picked), with nothing picked or
--           packed going down, passes at once: every role, every order, no
--           lookup. The one exception to "never down" is the hand-over, which
--           moves what was picked into what was handed over: both signatures
--           write quantity_fulfilled + quantity_picked and then
--           quantity_picked null (confirm_order_signature 0248:69-72,
--           confirm_physical_signature 0395:478-481). It compares
--           to_jsonb(new) minus that list with to_jsonb(old) minus it, so a
--           column added later is guarded;
--        b. the RMA flag (item 4) passes, for postgres or the superuser
--           only;
--        c. the line's order (an insert's, or both of an update's) is read
--           through _replacement_line_parents, SECURITY DEFINER, only in the
--           row's own organization (the line's current order on an update,
--           the order an insert names) and, for any writer but postgres,
--           supabase_admin and service_role, only in an organization the
--           writer is a member of; it fails closed: an order not found there
--           (none, or another organization's) is 42501
--           replacement_lines_fixed, whatever that order is. Until this
--           round the guard read it under the writer's RLS, so an order the
--           writer could not read counted as ordinary. A line of an ordinary
--           order passes, as before (its item is not asked: a line whose
--           item is another organization's is the insert policy's to refuse,
--           and the 0377 to 0379 suites keep such rows as defence in depth);
--        d. an INSERT by postgres or the superuser while the replacement is
--           still pending_approval passes: only _return_replacement_issue
--           does that, as postgres, in the transaction that creates and
--           approves the replacement;
--        e. an update of (a)'s columns within its value rules that lowers
--           what was picked or packed passes while the replacement is
--           picking_in_progress: reopen_picking rewinds a picked order there
--           keeping quantity_picked (0416:637-642), and the re-pick
--           (partial_pick_line, complete_picking) may lower it;
--        f. anything else: 42501 replacement_lines_fixed.
--      Every function that writes order_request_lines (12, pgTAP V7-9's
--      census) writes a replacement's lines only through (a), (b), (d) or
--      (e). No DELETE arm: return_exchange_lines' foreign key already refuses
--      deleting a line it names, for every role.
--   2. The replacement's warehouse (review V-1). Cancel replacement, Release
--      early, Change replacement and the RMA cancel gated on the ORIGINAL
--      order's warehouse only (cancel_return_replacement 0396:1803 and
--      :1818, release_return_replacement_early 0396:1997 and :2012,
--      change_return_replacement 0413:2046 and :2061, cancel_return 0394:1788
--      and :1800). A replacement is issued in the original's warehouse and
--      the header guard keeps it there, but the original is not pinned:
--      someone who writes both warehouses (an owner, admin or manager, or
--      staff with orders:approve assigned to both) can move a completed
--      original with a raw PATCH. Staff of the new warehouse alone could then
--      release early a replacement in a warehouse they do not work in
--      (pgTAP V-1-1); since slice E (0416) Cancel replacement and the RMA
--      cancel were refused only inside cancel_order_request, after both row
--      locks (V-1-2, V-1-4), and Change for the wrong reason, an item no
--      longer orderable there (V-1-3). One helper,
--      _return_replacement_warehouse_gate(return, user), now raises 42501
--      warehouse_write unless the user may write the live replacement's own
--      warehouse. Each function calls it before its first row lock (a
--      refusal never waits on a lock) and again under the replacement's row
--      lock (the RMA cancel in its exchange hook): one implementation for
--      every copy. The original's gates stay, so after a move every action on
--      the replacement needs both warehouses (fail closed); without a move
--      they are the same warehouse and nobody who can act today is refused.
--   3. Close the rest (S4, returns plan 13.18): close_return_replacement_rest
--      asked about the replacement's warehouse only after locking the RMA and
--      the replacement (0397:458-466), so a caller who may not act waited on
--      both rows first. It now asks before any lock too; its own check under
--      the lock stays.
--   4. The RMA flag asks the role. stockpilot.return_exchange holding this
--      transaction's id lets an RMA function do what the guards refuse
--      everyone else: cancel or close a replacement, change its header, and
--      now write its lines. Exactly three INVOKER helpers with no EXECUTE set
--      it (_return_replacement_cancel_order, _return_replacement_close_partial
--      and the cancel hook), always inside a SECURITY DEFINER RMA function,
--      so always as postgres. The flag now counts only when current_user is
--      postgres (the RMA functions' owner) or supabase_admin (the
--      superuser): an allowlist, as 0413's guards keep, never a list of the
--      roles to refuse. Any other writer that set it is refused like anyone
--      else: an API role (anon, authenticated, service_role), the API's own
--      login role (authenticator) and any role added later. Both guards that
--      ask are SECURITY INVOKER, where current_user is the writer: the header
--      guard (0396:2478) and the lines guard. The status gate
--      (tg_order_requests_replacement_status, 0396:2442) is SECURITY
--      DEFINER, where current_user is always postgres, so a role test there
--      would refuse no one; instead the header trigger's WHEN now also
--      covers a move into cancelled or denied, and the INVOKER header guard,
--      which sorts before the gate ("header" before "status"), asks first
--      and refuses with the gate's own error and detail. The gate's body is
--      unchanged.
--
-- ── WHAT STAYS (recorded in INV-C7) ────────────────────────────────────────
--   * The original order's warehouse is not pinned (owner question Q4, kept
--     by decision a.21): the RMA's own scope (receive, close, a new
--     replacement) follows the original's current warehouse, and stock moves
--     at close stay gated on each item's own warehouse.
--   * The helper's first read takes no lock (time of check against time of
--     use); the call under the replacement's lock keeps it fail closed, and
--     the header guard pins the replacement's warehouse.
--   * The lines guard reads the line's order with no lock, as it did before
--     (a lock there would wait behind the order functions, which lock the
--     order and then write its lines). A writer racing a status change can
--     therefore be judged on the status just before it: only the
--     pending_approval and picking_in_progress exemptions read the status.
--   * No role tells a flag an RMA function raised from one an API session
--     raised before calling a SECURITY DEFINER function: inside that function
--     both run as postgres. There the flag rests on no API role being able to
--     set it: the Data API runs one statement per request and exposes no
--     set_config, and no exposed function sets it from caller input.
--   * A data fix that touches a replacement's header, status or lines runs as
--     postgres (SET ROLE postgres first when the session logs in as another
--     role) and raises the flag inside its own transaction first:
--       select set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
--     The header guard has asked for the flag since 0396; the lines guard
--     now does too, and both ask the role.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The functions (all plpgsql, none declaring a table's row type), their
-- comments and the revokes lock no table, so they come first. Then one
-- NOWAIT prelude takes the only table locks the file needs, SHARE ROW
-- EXCLUSIVE on order_requests and order_request_lines, for the two CREATE OR
-- REPLACE TRIGGER statements (never ACCESS EXCLUSIVE). That mode pauses
-- writes to the two tables, never reads, until the batch commits a few
-- milliseconds later. A busy table fails one attempt, its subtransaction
-- releases what it took, and the next attempt starts after 50 to 150 ms
-- holding nothing, up to 40 attempts; then 55P03 and nothing is applied
-- (scripts/db-concurrency/0425_migration_lock_footprint.sh). lock_timeout is
-- 900ms for the whole file. A call already running finishes on the body it
-- started with.
--
-- Each function's own lock order is unchanged: the RMA row, then the live
-- replacement row. The helper locks nothing: its first call reads the
-- replacement by its link before any lock, its second runs under the
-- replacement's lock
-- (scripts/db-concurrency/0425_replacement_warehouse_gate_race.sh).
--
-- Cost: the lines guard now runs on every UPDATE of an order line (two
-- to_jsonb calls), and an insert, a non-workflow update or one that lowers
-- what was picked reads the line's order by primary key, twice, and for an
-- API writer its membership (through _replacement_line_parents), ordinary
-- orders included.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- 42501 warehouse_write and 42501 replacement_lines_fixed (both mapped,
-- packages/core/src/returns/return-error-map.ts), 42501
-- replacement_cancel_via_return as before, and 55P03 from the prelude.
-- _replacement_line_parents called other than from a trigger (an API RPC)
-- answers 42501 trigger_only and nothing else. No function here raises the
-- two retryable classes PostgREST would re-run forever (0367).

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- Every body this file replaces, and every body its guards and gates rely
-- on, must be the one this file was written against: the six RMA bodies and
-- both guards as 0394, 0396, 0397 and 0413 left them (unchanged since), the
-- three flag setters and the issue, the status gate, the access check, and
-- the order functions the RMA paths call as slice E (0416) left them. Both
-- trigger definitions must be 0396's. Anything else is drift: stop before
-- changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        -- The bodies this file replaces.
        ('public.cancel_return_replacement(uuid,integer,text,text)',              '9e42b480d4a77b1ccde60f10fc858d44', true),
        ('public.release_return_replacement_early(uuid,uuid,text)',               'c125bab4cea1572430b53b7bb5bd3ceb', true),
        ('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)', 'b19cb3718a8e51b74caaecc1281b7aaa', true),
        ('public.close_return_replacement_rest(uuid,integer,text,text)',          '9a0a83770e971f617777b9231a7eb0ca', true),
        ('public.cancel_return(uuid,integer,text)',                               '11e8be3e7f3fe7899c6c919311fbf9c1', true),
        ('public._return_exchange_on_cancel(uuid,uuid,text)',                     'a4ed07269153c41f8203d375ab2f7acc', false),
        ('public.tg_order_requests_replacement_header()',                         'b7220c36c4f78792f698adfbd8da79ea', false),
        ('public.tg_order_request_lines_replacement_guard()',                     '63027b8532d411eb1b4f03cc2d1fde9d', false),
        -- The flag's other two setters, the issue (the one pending_approval
        -- line writer) and the classifier, unchanged.
        ('public._return_replacement_cancel_order(uuid,text,text)',               'f4e237f84530faf8dbf56d232e1d6693', false),
        ('public._return_replacement_close_partial(uuid)',                        'dc2f85bf25c32a0015d6c5d57659671f', false),
        ('public._return_replacement_issue(uuid,jsonb,integer,jsonb)',            '51ade3e8e81354580ce0be9d944f79e2', true),
        ('public._return_replacement_class(uuid)',                                'fb118357c2024c55f80c095f783c68f1', false),
        -- The status gate, whose flagged edge the header guard now asks first,
        -- and the transition table that admits that edge.
        ('public.tg_order_requests_replacement_status()',                         '38b9236c6e628e63f39eac5d8d1c83ff', true),
        ('public._validate_order_request_status_transition()',                    'dee8cd4782ec83abdb31a2b48fcd4ef2', false),
        -- The access check the helper asks.
        ('public.user_can_access_inventory(uuid,uuid,uuid,text)',                 '8a214b77e32a052ca3bf07a2be39a8ae', true),
        -- The order functions the RMA paths call, and whose line writes the
        -- lines guard must admit, as slice E (0416) left them.
        ('public.cancel_order_request(uuid,text)',                                'dfbd31ed1083df82ae6de3cbb13b6c27', true),
        ('public.close_partial(uuid)',                                            '44852737eedc1959e887b8621925d157', true),
        ('public.approve_partial(uuid)',                                          '897c53295f88b0bac7dcc03edd07211f', true),
        ('public.resume_fulfillment(uuid)',                                       'ce593a9203c41c1a7311b1af27d4cbd3', true)
      ) v(sig, want_src, want_secdef)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s);', r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  -- Both trigger definitions as 0396 created them (the function name is
  -- printed qualified or not by search_path, so that prefix is dropped).
  if (select regexp_replace(pg_get_triggerdef(t.oid), 'FUNCTION (public\.)?', 'FUNCTION ')
        from pg_trigger t
       where t.tgrelid = 'public.order_request_lines'::regclass
         and t.tgname = 'trg_zz_order_request_lines_replacement_guard')
     is distinct from 'CREATE TRIGGER trg_zz_order_request_lines_replacement_guard BEFORE INSERT ON public.order_request_lines '
                      || 'FOR EACH ROW EXECUTE FUNCTION tg_order_request_lines_replacement_guard()' then
    v_bad := v_bad || ' trg_zz_order_request_lines_replacement_guard is not 0396''s;';
  end if;
  if (select regexp_replace(pg_get_triggerdef(t.oid), 'FUNCTION (public\.)?', 'FUNCTION ')
        from pg_trigger t
       where t.tgrelid = 'public.order_requests'::regclass
         and t.tgname = 'trg_order_requests_zz_replacement_header')
     is distinct from 'CREATE TRIGGER trg_order_requests_zz_replacement_header BEFORE UPDATE ON public.order_requests '
                      || 'FOR EACH ROW WHEN (((new.replacement_for_return_id IS NOT NULL) AND '
                      || '((old.warehouse_id IS DISTINCT FROM new.warehouse_id) OR '
                      || '(old.delivery_charter_id IS DISTINCT FROM new.delivery_charter_id) OR '
                      || '(old.created_at IS DISTINCT FROM new.created_at) OR '
                      || '((old.status = ''backordered''::text) AND (new.status = ''completed''::text))))) '
                      || 'EXECUTE FUNCTION tg_order_requests_replacement_header()' then
    v_bad := v_bad || ' trg_order_requests_zz_replacement_header is not 0396''s;';
  end if;

  -- Already applied (or half applied by hand): both new names must be free.
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = '_return_replacement_warehouse_gate') then
    v_bad := v_bad || ' _return_replacement_warehouse_gate already exists;';
  end if;
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = '_replacement_line_parents') then
    v_bad := v_bad || ' _replacement_line_parents already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'replacement_guards_preflight: %', v_bad
      using errcode = '55000', hint = 'replacement_guards_preflight';
  end if;
end
$preflight$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═════════════

-- ── 1a. The replacement-warehouse gate (V-1; S4) ──────────────────────────
-- The live replacement (not cancelled or denied; order_requests_live_
-- replacement_uniq allows at most one) is read by its link with no lock.
-- With none there is nothing to ask. SECURITY INVOKER: its callers are
-- SECURITY DEFINER, so it reads as postgres; no role may execute it.
create function public._return_replacement_warehouse_gate(p_return_id uuid, p_user uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_wh uuid;
begin
  select o.warehouse_id into v_wh
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied');
  if v_wh is not null and not public.user_can_access_inventory(p_user, v_wh, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;
end;
$$;

-- ── 1a'. The lines guard's parent read (V7; decisions round R1) ──────────
-- The lines guard is SECURITY INVOKER, so that current_user is the writer
-- (the role test, item 4), and so its own reads run under the writer's RLS.
-- It reads the line's order here instead: SECURITY DEFINER, so what the
-- writer may read does not decide. It answers only for the row's own
-- organization: that of p_order_ids[1], the line's current order on an
-- update and the order an insert names; every other order named (a move's
-- new order) must be in it. For a writer the guard scopes (p_scoped: any
-- role but postgres, supabase_admin and service_role, the roles that read
-- every order anyway), only when that organization is one the writer is a
-- member of (is_org_member, as the insert policy's orders:approve and
-- requester terms need), so another organization's order is never answered
-- and its class cannot be learned from the refusal. An order not found is
-- left to the guard, which refuses the line (fail closed). o_found is how
-- many of p_order_ids were found, o_replacement whether any is a
-- replacement, o_status the order's status when exactly one was found. No
-- lock (see WHAT STAYS). Every writer of order_request_lines calls it
-- through the guard, so the two API roles that write lines hold EXECUTE
-- (authenticated through create_order_request and the insert policy,
-- service_role through the admin client); called other than from a trigger
-- it answers 42501 trigger_only and nothing else, so an RPC learns nothing
-- and cannot pass p_scoped false.
create function public._replacement_line_parents(p_order_ids uuid[], p_scoped boolean,
                                                 out o_found integer, out o_replacement boolean, out o_status text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if pg_trigger_depth() < 1 then
    raise exception 'trigger_only' using errcode = '42501', hint = 'trigger_only';
  end if;
  select o.organization_id into v_org from public.order_requests o where o.id = p_order_ids[1];
  if p_scoped and not coalesce(public.is_org_member(v_org), false) then
    v_org := null;
  end if;
  select count(*)::integer,
         coalesce(bool_or(o.replacement_for_return_id is not null), false),
         case when count(*) = 1 then min(o.status) end
    into o_found, o_replacement, o_status
    from public.order_requests o
   where o.id = any (p_order_ids)
     and o.organization_id = v_org;
end;
$$;

-- ── 1b. The five RMA functions and the cancel hook ────────────────────────
-- Each is its latest body with the helper's calls added (`-- S7` lines): in
-- the five, right after their gates and argument checks, before the RMA's
-- row lock; in release early, cancel and change also right after the live
-- replacement's row lock; in the cancel hook, as the first statement once
-- the live replacement is locked. Close the rest keeps its own check under
-- its lock (0397). Signatures, SECURITY mode, SET clauses, owner and grants
-- are unchanged (CREATE OR REPLACE keeps the owner and the grants; each
-- header restates the attributes; pgTAP P2 pins them).

-- cancel_return_replacement: restated from 0396_returns_exchange_staff.sql:1781; md5(prosrc) 9e42b480d4a77b1ccde60f10fc858d44 -> 18760fd58c4f2445acaa930d2896ea33.
create or replace function public.cancel_return_replacement(p_return_id uuid, p_expected_revision integer, p_reason text,
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
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  select o.id, o.status into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
     for update;
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: under the replacement's lock
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
  -- Picked or on its way since the caller's screen showed it (review V1):
  -- 0 not picked, 1 picked and in the building, 2 on its way.
  if p_shown_status is not null
     and (case when v_live.status = 'in_transit' then 2 when v_class = 'drawn' then 1 else 0 end)
       > (case when p_shown_status = 'in_transit' then 2
               when p_shown_status in ('picking_complete', 'packing_slip_generated', 'staged_for_pickup',
                                       'staged_for_delivery') then 1
               else 0 end) then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
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

-- release_return_replacement_early: restated from 0396_returns_exchange_staff.sql:1978; md5(prosrc) c125bab4cea1572430b53b7bb5bd3ceb -> 00fcc95f02e36c7be40db0deedd2c691.
create or replace function public.release_return_replacement_early(p_return_id uuid, p_order_id uuid, p_reason text)
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
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  select o.id, o.status into v_live
    from public.order_requests o
   where o.replacement_for_return_id = p_return_id and o.status not in ('cancelled', 'denied')
     for update;
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: under the replacement's lock
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

-- change_return_replacement: restated from 0413_order_catalog_visibility.sql:2000; md5(prosrc) b19cb3718a8e51b74caaecc1281b7aaa -> eb49035fe40a6f441fde039e0f0ecc18.
CREATE OR REPLACE FUNCTION public.change_return_replacement(p_return_id uuid, p_expected_revision integer, p_lines jsonb, p_reason text, p_when_short text, p_replacement jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
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
  v_room    numeric;
  v_kept    text;
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
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock

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
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: under the replacement's lock
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
           rl.quantity - coalesce(f.fulfilled, 0) as room, rl.quantity as qty, coalesce(f.fulfilled, 0) as sent,
           rl.order_request_line_id as order_line
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
      'quantity', least(x.approved_quantity, x.room), 'returned', x.room, 'previousItemId', null,
      'qty', x.qty, 'sent', x.sent, 'orderLine', x.order_line));
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
  -- 0413 (review fix round, D1 item 4): an item hidden from ordering passes
  -- only as the approved item of the very line kept here (a re-issue, or an
  -- unchanged line of a substitution), so each line is checked with the
  -- transaction-bound flag naming that line alone, or no line when its item
  -- changed (a new selection). _return_exchange_item_ok reads the flag.
  v_kept := current_setting('stockpilot.exchange_kept_lines', true);
  for a in select y from jsonb_array_elements(v_set) as y loop
    perform set_config('stockpilot.exchange_kept_lines',
      pg_current_xact_id()::text || '|'
      || case when a->>'previousItemId' is null then a->>'exchangeLineId' else '' end, true);
    if not public._return_exchange_item_ok(v_order, (a->>'itemId')::uuid, 'staff') then
      raise exception 'exchange_item_not_eligible' using errcode = 'P0001', hint = 'exchange_item_not_eligible';
    end if;
  end loop;
  perform set_config('stockpilot.exchange_kept_lines', coalesce(v_kept, ''), true);

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
  -- Review S1: under the budget lock of every original line in the change,
  -- no line sends more than its original line has left to exchange, less
  -- what this RMA's replacements already handed over for it.
  perform public._return_lock_exchange_budget(
    array(select (y->>'orderLine')::uuid from jsonb_array_elements(v_set) as y));
  for a in select y from jsonb_array_elements(v_set) as y loop
    v_room := least((a->>'qty')::numeric,
                    greatest(public._return_exchange_line_budget(p_return_id, (a->>'orderLine')::uuid), 0))
              - (a->>'sent')::numeric;
    if (a->>'quantity')::numeric > v_room then
      raise exception 'exchange_already_sent' using errcode = 'P0001', hint = 'exchange_already_sent',
        detail = jsonb_build_object('quantity', trim_scale((a->>'quantity')::numeric),
                                    'available', trim_scale(greatest(v_room, 0)))::text;
    end if;
  end loop;

  -- Never both reservations: the old order is cancelled first (every hold
  -- released, nothing restocked: it was not picked), then the new one is
  -- created and held, all in this transaction.
  if v_live.id is not null then
    perform public._return_replacement_cancel_order(v_live.id, v_no, 'changed');
  end if;
  -- The issue re-checks every item of the merged set: the kept lines are named
  -- for it (a changed line's new item was refused above when hidden).
  perform set_config('stockpilot.exchange_kept_lines',
    pg_current_xact_id()::text || '|'
    || coalesce((select string_agg(y->>'exchangeLineId', ',') from jsonb_array_elements(v_set) as y
                  where y->>'previousItemId' is null), ''), true);
  v_repl := public._return_replacement_issue(
    p_return_id,
    (select jsonb_agg(jsonb_build_object('itemId', y->'itemId', 'quantity', y->'quantity')) from jsonb_array_elements(v_set) as y),
    p_expected_revision + 1, v_opts);
  perform set_config('stockpilot.exchange_kept_lines', coalesce(v_kept, ''), true);

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
$function$;

-- close_return_replacement_rest: restated from 0397_returns_followups.sql:415; md5(prosrc) 9a0a83770e971f617777b9231a7eb0ca -> 6b0a7f57789b7adcd03233e9bf98c058.
create or replace function public.close_return_replacement_rest(p_return_id uuid, p_expected_revision integer, p_reason text,
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
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock

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

-- cancel_return: restated from 0394_returns_lifecycle_original_rack.sql:1770; md5(prosrc) 11e8be3e7f3fe7899c6c919311fbf9c1 -> d3c2d9348a85d9be74aa55b8a8c5f783.
create or replace function public.cancel_return(p_return_id uuid, p_expected_revision integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_user   uuid := auth.uid();
  v_org    uuid;
  v_wh     uuid;
  v_status text;
  v_rev    integer;
  v_reason text := nullif(regexp_replace(coalesce(p_reason, ''), '^\s+|\s+$', '', 'g'), '');
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
  if v_reason is not null and length(v_reason) > 1000 then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'reason';
  end if;
  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  if v_status = 'cancelled' then
    return jsonb_build_object('changed', false, 'status', 'cancelled');
  end if;
  if v_status not in ('requested', 'approved') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_status;
  end if;
  select coalesce(max(d.revision), 0) into v_rev
    from public.return_decisions d
   where d.return_id = p_return_id
     and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled');
  if p_expected_revision is not null and v_rev <> p_expected_revision then
    raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed', detail = v_rev::text;
  end if;

  -- RX-2: a replacement is locked (after this RMA), classified under that
  -- lock and cancelled here, with the reason it then requires.
  perform public._return_exchange_on_cancel(p_return_id, v_user, v_reason);

  update public.returns set status = 'cancelled' where id = p_return_id;
  insert into public.return_decisions (organization_id, return_id, kind, channel, revision, reason, actor_user_id, actor_kind)
  values (v_org, p_return_id, 'cancelled', 'staff', v_rev + 1, v_reason, v_user, 'staff');

  return jsonb_build_object('changed', true, 'status', 'cancelled', 'revision', v_rev + 1);
end;
$$;

-- _return_exchange_on_cancel: restated from 0396_returns_exchange_staff.sql:1308; md5(prosrc) a4ed07269153c41f8203d375ab2f7acc -> 01835cfd5a07a666afb26eb203cb9ff4.
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
  v_prev    text := current_setting('stockpilot.return_exchange', true);
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
      perform public._return_replacement_warehouse_gate(p_return_id, p_user);  -- S7: under the replacement's lock
      v_class := public._return_replacement_class(v_live);
      select o.status into v_ostatus from public.order_requests o where o.id = v_live;
      if v_ostatus in ('picking_complete', 'packing_slip_generated', 'staged_for_pickup',
                       'staged_for_delivery', 'in_transit') then
        raise exception 'replacement_in_progress' using errcode = 'P0001', hint = 'replacement_in_progress',
          detail = v_ostatus;
      end if;
      if v_class in ('undrawn', 'drawn') then
        perform public._return_replacement_cancel_order(v_live, v_no, 'return_cancelled');
        update public.return_exchange_lines
           set status = 'cancelled'
         where return_id = p_return_id and status = 'approved';
      elsif v_ostatus = 'backordered' then
        -- Handed over in part, the rest on backorder: closed as delivered-partial,
        -- under the exchange flag (the header guard refuses it anywhere else).
        perform set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
        perform public.close_partial(v_live);
        perform set_config('stockpilot.return_exchange', coalesce(v_prev, ''), true);
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

-- ── 1c. The guards ────────────────────────────────────────────────────────
-- The lines guard, rewritten (item 1). Its trigger is replaced in section 3.
-- tg_order_request_lines_replacement_guard: rewritten (was 0396_returns_exchange_staff.sql:2378); md5(prosrc) 63027b8532d411eb1b4f03cc2d1fde9d -> cb62201f9028436e5e54fe43252fa82f.
create or replace function public.tg_order_request_lines_replacement_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- The workflow columns: picking, packing, the hand-over and the return
  -- budget. The order functions write nothing else on a replacement's line.
  c_flow   constant text[] := array['quantity_picked', 'picked_at', 'picked_by', 'quantity_packed',
                                    'packed_at', 'packed_by', 'quantity_fulfilled', 'returned_quantity'];
  -- The roles RMA definer code runs as: postgres, its owner, and the
  -- superuser. An allowlist, as 0413's: no other role, an API role least of
  -- all, is ever one of them.
  v_owner  constant boolean := current_user in ('postgres', 'supabase_admin');
  -- The roles that read every order anyway hear about any order; every
  -- other writer only about its own organization's (the parent read).
  v_scoped constant boolean := current_user not in ('postgres', 'supabase_admin', 'service_role');
  v_rules  boolean := false;
  v_kept   boolean := false;
  v_ids    uuid[];
  v_found  integer;
  v_repl   boolean;
  v_status text;
begin
  -- 1. An update of the workflow columns only, within their six rules (what
  -- was handed over and what came back never go down; handed over stays
  -- within the quantity requested, came back within handed over; picked
  -- stays within the quantity requested, packed within picked), with
  -- nothing picked or packed going down: every role, every order, no
  -- lookup. The hand-over is the one way down: it moves what was picked
  -- into what was handed over (quantity_fulfilled + quantity_picked, then
  -- quantity_picked null, as both signatures write it). A column added later
  -- is not a workflow column.
  if tg_op = 'UPDATE' and (to_jsonb(new) - c_flow) = (to_jsonb(old) - c_flow) then
    v_rules := new.quantity_fulfilled >= old.quantity_fulfilled
           and new.quantity_fulfilled <= new.quantity_requested
           and new.returned_quantity >= old.returned_quantity
           and new.returned_quantity <= new.quantity_fulfilled
           and coalesce(new.quantity_picked, 0) <= new.quantity_requested
           and coalesce(new.quantity_packed, 0) <= coalesce(new.quantity_picked, 0);
    v_kept := coalesce(new.quantity_packed, 0) >= coalesce(old.quantity_packed, 0)
          and (coalesce(new.quantity_picked, 0) >= coalesce(old.quantity_picked, 0)
               or (new.quantity_picked is null
                   and new.quantity_fulfilled = old.quantity_fulfilled + coalesce(old.quantity_picked, 0)));
    if v_rules and v_kept then
      return new;
    end if;
  end if;
  -- 2. Under the RMA flag (this transaction's id), for postgres or the
  -- superuser only: the header guard's rule, the one path for a data fix.
  if v_owner and coalesce(current_setting('stockpilot.return_exchange', true), '') = pg_current_xact_id()::text then
    return new;
  end if;
  -- 3. The order (an insert) or both orders (an update; the line's current
  -- order first), read as their owner in the row's own organization, and
  -- fail closed: every one must be found there before the line counts as an
  -- ordinary order's, which passes as before, value rules included.
  v_ids := array[new.order_request_id];
  if tg_op = 'UPDATE' then
    if old.order_request_id is distinct from new.order_request_id then
      v_ids := array[old.order_request_id, new.order_request_id];
    end if;
  end if;
  select p.o_found, p.o_replacement, p.o_status into v_found, v_repl, v_status
    from public._replacement_line_parents(v_ids, v_scoped) p;
  if coalesce(v_found, 0) < cardinality(v_ids) then
    raise exception 'replacement_lines_fixed' using errcode = '42501', hint = 'replacement_lines_fixed';
  end if;
  if not v_repl then
    return new;
  end if;
  -- 4. The replacement's own lines: _return_replacement_issue inserts them as
  -- postgres while the new order is still pending approval, in the
  -- transaction that approves it.
  if tg_op = 'INSERT' and v_status = 'pending_approval' and v_owner then
    return new;
  end if;
  -- 5. Picking again: reopen_picking rewinds a picked replacement to
  -- picking_in_progress keeping what was picked, and the re-pick may lower
  -- it (partial_pick_line, complete_picking), within the value rules.
  if v_rules and v_status = 'picking_in_progress' then
    return new;
  end if;
  raise exception 'replacement_lines_fixed' using errcode = '42501', hint = 'replacement_lines_fixed';
end;
$$;

-- The header guard: 0396's body with the role term on the flag (item 4).
-- Its trigger's WHEN gains the status gate's flagged edge in section 3.
-- tg_order_requests_replacement_header: restated from 0396_returns_exchange_staff.sql:2469; md5(prosrc) b7220c36c4f78792f698adfbd8da79ea -> 558b94ffe1cfd0f6278f2c9117ba9e91.
create or replace function public.tg_order_requests_replacement_header()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_no text;
begin
  -- S7: the flag counts only for postgres, as which an RMA function raises
  -- it (SECURITY DEFINER), or the superuser: an allowlist. Any other writer
  -- that set it, an API role above all, is refused like anyone else.
  if coalesce(current_setting('stockpilot.return_exchange', true), '') = pg_current_xact_id()::text
     and current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  select r.return_number into v_no from public.returns r where r.id = new.replacement_for_return_id;
  raise exception 'replacement_cancel_via_return' using errcode = '42501', hint = 'replacement_cancel_via_return',
    detail = coalesce(v_no, '');
end;
$$;

revoke all on function public._return_replacement_warehouse_gate(uuid, uuid) from public, anon, authenticated, service_role;
-- The lines guard runs as the writer and calls the parent read, so the two
-- API roles that write order lines need EXECUTE on it (anon writes none).
revoke all on function public._replacement_line_parents(uuid[], boolean) from public, anon, authenticated, service_role;
grant execute on function public._replacement_line_parents(uuid[], boolean) to authenticated, service_role;
revoke all on function public._return_exchange_on_cancel(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.tg_order_request_lines_replacement_guard() from public, anon, authenticated, service_role;
revoke all on function public.tg_order_requests_replacement_header() from public, anon, authenticated, service_role;

-- ═══ 2. Comments ═══════════════════════════════════════════════════════════
comment on function public._return_replacement_warehouse_gate(uuid, uuid) is
  'S7 (review V-1; S4): the replacement''s own warehouse. Reads the RMA''s live replacement (not cancelled or denied) by its link, with no lock, and raises 42501 warehouse_write unless p_user may write its warehouse (user_can_access_inventory, write); with no live replacement it asks nothing. Release early, Cancel replacement, Change replacement, Close the rest and the RMA cancel call it before their first row lock, so a caller who may not act never waits on one; release, cancel and change call it again under the replacement''s row lock, the RMA cancel in its hook. The original''s warehouse is asked as well, so after an original moves the caller needs both warehouses. SECURITY INVOKER (its callers are SECURITY DEFINER), EXECUTE for nobody.';
comment on function public._replacement_line_parents(uuid[], boolean) is
  'S7 (review V7; decisions round R1): the parent read of tg_order_request_lines_replacement_guard. Answers only for the row''s own organization, that of p_order_ids[1] (the line''s current order on an update, the order an insert names), and when p_scoped (the guard passes it for any writer but postgres, supabase_admin and service_role) only if the caller is a member of that organization (is_org_member). Counts the orders of p_order_ids found there (o_found), says whether any is a replacement (o_replacement) and, when exactly one was found, its status (o_status). SECURITY DEFINER, so what the line''s writer may read does not decide; an order of another organization, or none, is not found, and the guard then refuses the line (fail closed), so the refusal says nothing about another organization''s order. No lock. Only from inside a trigger (pg_trigger_depth() >= 1); any other call is 42501 trigger_only and answers nothing. EXECUTE to authenticated and service_role only, because the guard runs as the writer and those two API roles write order lines; never anon or PUBLIC.';
comment on function public.cancel_return_replacement(uuid, integer, text, text) is
  'RX-2 (plan 3.3.5; X-1, X-2): keep the return, cancel the live replacement, reason 1 to 1,000 characters (P0001 reason_required). Locked after the RMA and classified under that lock: undrawn or picked-not-handed-over is cancelled through cancel_order_request under the exchange flag (every hold released; a picked batch goes back to Staging on record); handed over, in full or in part (a resumed backorder included), gives P0001 replacement_handed_over; none answers changed false. The expected revision is required (22023 return_invalid without it); a stale one gives P0001 return_changed (desk check F7). p_shown_status is the replacement status the caller''s screen showed (review V1): a replacement picked or on its way since then gives P0001 return_changed (the screen reloads into its Staging and driver warnings); null is not checked. The answer carries drawn and inTransit. The lines read cancelled; the RMA itself does not change. Gates as change_return_replacement, the replacement''s own warehouse included (S7). Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.release_return_replacement_early(uuid, uuid, text) is
  'RX-2 (brief 24; plan 3.3.5): a manager releases the live replacement for picking before the returned item arrives, with a reason of 1 to 500 characters (P0001 reason_required), only while the RMA is approved and the replacement approved (P0001 replacement_not_waiting otherwise). p_order_id is the replacement the caller saw (null: none); any other live replacement is P0001 return_changed (desk check F7). Appends released_early naming that order (a substituted order needs its own release, D10). An existing release of the live order replays; an RMA already received or closed answers changed false, reason not_needed. Gates as change_return_replacement, the replacement''s own warehouse included (S7). Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.change_return_replacement(uuid, integer, jsonb, text, text, jsonb) is
  'RX-2 (plan 3.3.5; brief 22; C-1): substitution, or a new replacement after a replacement cancel. p_lines [{exchangeLineId, itemId?, quantity?}] changes approved lines (the others keep theirs); p_reason 1 to 1,000 characters (P0001 reason_required); p_when_short refuse or backorder; p_replacement {fulfillmentType?, deliveryCharterId?} overrides the fulfilment. RMA approved, received or closed (P0001 invalid_status_transition); revision current (P0001 return_changed). The live replacement is locked after the RMA and classified: undrawn is cancelled (holds released, nothing restocked) and a new order created and held in one transaction; drawn gives P0001 replacement_already_drawn; handed over (anything handed over, a resumed backorder included) P0001 replacement_handed_over; none, with lines cancelled by a replacement cancel, issues a new one. Every line sends at most its returned quantity minus what this RMA''s replacements already handed over for it (_return_exchange_fulfilled; desk check F2): the default quantity is capped there, a larger one is P0001 exchange_quantity_exceeds_return, a line with nothing left is not re-issued, and when nothing is left at all P0001 replacement_handed_over; and at most what the original line has left to exchange (review S1: P0001 exchange_already_sent, under the lines'' budget lock after the item locks). Gates: signed in (42501 unauthenticated), member (P0002 return_not_found), returns and orders modules (P0001 module_disabled), returns:manage (42501 returns_manage), orders:approve (42501 orders_approve), write access to the original order''s warehouse (42501 warehouse_write), and S7 (review V-1): write access to the live replacement''s own warehouse, asked before the RMA''s row lock and again under the replacement''s (42501 warehouse_write; _return_replacement_warehouse_gate), so after an original moves the caller needs both warehouses. Idempotent on (RMA, expected revision), scope return_replacement_change: the same change replays, another P0001 return_changed. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.close_return_replacement_rest(uuid, integer, text, text) is
  'RX-4 "Close the rest" (RX-2 verification V3): a replacement handed over in part with the rest on backorder, under an RMA received or closed, is closed as delivered-partial (close_partial under the transaction-bound exchange flag): holds on the rest released, nothing moved, the handed-over record kept. Gates before any lock: signed in, member (P0002 return_not_found), Returns and Orders modules (P0001 module_disabled), returns:manage (42501 returns_manage), orders:approve (42501 orders_approve), write access to the original order''s warehouse (42501 warehouse_write); a reason of 1 to 1,000 characters (P0001 reason_required); the revision the caller saw (22023 return_invalid when missing); and since S7 (S4, plan 13.18) write access to the live replacement''s own warehouse (42501 warehouse_write; _return_replacement_warehouse_gate), so a caller who may not act never waits on a lock. Locks the RMA, then the live replacement, and asks write access to its warehouse again under that lock (verification V-1). Stale revision or a shown status that is no longer the replacement''s: P0001 return_changed. RMA not received or closed: P0001 invalid_status_transition. Nothing on backorder handed over in part: P0001 replacement_not_backordered (detail its status). A replacement already closed this way replays {changed: false}. Appends the non-head decision replacement_closed (reason, order). Never 40001 or 40P01.';
comment on function public.cancel_return(uuid, integer, text) is
  'RX-1: requested or approved to cancelled, reason optional (1 to 1,000 characters); an expected revision that is stale gives P0001 return_changed. Already cancelled answers changed false. Gates as approve; since S7 (review V-1) also write access to the live replacement''s own warehouse before the RMA''s row lock (42501 warehouse_write; _return_replacement_warehouse_gate), asked again by the exchange hook under the replacement''s lock, so after an original moves the caller needs both warehouses. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public._return_exchange_on_cancel(uuid, uuid, text) is
  'RX-2 hook body (plan 3.3.5, cancel_return row; X-1, X-2): once an exchange was approved, cancelling the RMA needs the orders module (P0001 module_disabled), orders:approve (42501 orders_approve) and a reason (P0001 reason_required); the live replacement is locked FOR UPDATE after the RMA, its own warehouse is asked under that lock (S7, review V-1: 42501 warehouse_write; _return_replacement_warehouse_gate), and it is classified under that lock: picked, being packed, staged or in transit refuses the cancel (review S2: P0001 replacement_in_progress, detail its status; Cancel replacement is the path there); otherwise not handed over is cancelled in this transaction (every hold released, nothing restocked); handed over in full keeps its history and nothing moves (brief 34, D11); handed over in part is closed as delivered-partial when on backorder (close_partial under the exchange flag the header guard asks for) and its remainder cancelled when resumed into picking and not yet picked (desk check F3), so nothing more ships for a cancelled return. Requested lines are cancelled with the RMA. SECURITY INVOKER, no API EXECUTE.';
comment on function public.tg_order_request_lines_replacement_guard() is
  'RX-2 (plan 3.6.6), every role since S7 (review V7), BEFORE INSERT OR UPDATE on order_request_lines: a replacement''s lines come from its RMA. An UPDATE that changes only the workflow columns (quantity_picked, picked_at, picked_by, quantity_packed, packed_at, packed_by, quantity_fulfilled, returned_quantity), keeps their value rules (quantity_fulfilled and returned_quantity never go down, quantity_fulfilled <= quantity_requested, returned_quantity <= quantity_fulfilled, quantity_picked <= quantity_requested, quantity_packed <= quantity_picked) and lowers neither quantity_picked nor quantity_packed (except the hand-over, which moves quantity_picked into quantity_fulfilled and leaves quantity_picked null) passes for every order with no lookup. So does any write under the transaction-bound stockpilot.return_exchange flag when current_user is postgres or supabase_admin (an allowlist: an API role, authenticator or any other role that set the flag is refused), the one path for a data fix. Otherwise the line''s order (both orders of an update) is read through _replacement_line_parents (SECURITY DEFINER, only in the row''s own organization, and for any writer but postgres, supabase_admin and service_role only in an organization the writer is a member of) and the guard fails closed: an order not found there is 42501 replacement_lines_fixed. A line of an ordinary order passes as before; an insert by postgres or supabase_admin while the replacement is still pending_approval passes (only _return_replacement_issue, in the transaction that creates and approves it); and an update within the value rules that lowers what was picked or packed passes while the replacement is picking_in_progress (reopen_picking keeps quantity_picked and the re-pick may lower it). Anything else on a replacement''s line, or moving a line into or out of one, is 42501 replacement_lines_fixed. SECURITY INVOKER (current_user is the writer), no EXECUTE.';
comment on function public.tg_order_requests_replacement_header() is
  'RX-2 (security review F-1), BEFORE UPDATE on order_requests WHEN a replacement''s warehouse_id, delivery_charter_id or created_at changes, it goes from backordered to completed (close_partial), or since S7 it moves into cancelled or denied (the status gate''s flagged edge, asked here first because the gate is SECURITY DEFINER and cannot ask the role): allowed only under the transaction-bound stockpilot.return_exchange flag an RMA function raises (the RMA cancel closes a part-handed-over backorder that way), and since S7 only when current_user is postgres or supabase_admin (an allowlist: an API role, authenticator or any other role that set the flag itself is refused); otherwise, for every role, 42501 replacement_cancel_via_return, detail the RMA number. Internal notes, needed-by, the pick slip, picking, staging and the hand-over are not guarded. SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_order_requests_replacement_status() is
  'RX-2 (plan 3.6.5; C-5), the return-first gate and the cancel guard for replacement orders: into pick_slip_generated never while the RMA is cancelled or denied (P0001 replacement_return_cancelled, detail the RMA number; desk check F3), otherwise only when the RMA is received or closed or a released_early decision names this order (P0001 replacement_waiting_for_return, detail the RMA number); into cancelled or denied only under the transaction-bound stockpilot.return_exchange flag (42501 replacement_cancel_via_return). Since S7 the header guard (trg_order_requests_zz_replacement_header, SECURITY INVOKER, sorted before this gate) asks that flagged edge first and also refuses any writer but postgres or supabase_admin that set the flag itself; this body, which runs as postgres and so cannot ask the role, is unchanged. Reads the RMA and the release by key and takes NO row lock (an RMA cancel holds the RMA and then waits for the order; generatePickSlip holds the order). SECURITY DEFINER (a picker without returns access is judged by the same facts), EXECUTE for nobody.';

-- ═══ 3. The lock prelude and the two triggers (see LOCKS above) ═══════════
-- Inside DO because the CLI batch is not a transaction block (a top-level LOCK
-- TABLE refuses there, as 0373 found); the locks last until the batch commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.order_requests, public.order_request_lines in share row exclusive mode nowait;
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

-- The lines guard fires on UPDATE too (item 1). Same name, so it keeps its
-- place: after trg_zz_order_request_lines_guard (0363) and before the
-- ordering-visibility gates (0413).
create or replace trigger trg_zz_order_request_lines_replacement_guard
  before insert or update on public.order_request_lines
  for each row execute function public.tg_order_request_lines_replacement_guard();

-- The header guard also covers a replacement's move into cancelled or denied
-- (item 4). It sorts before trg_order_requests_zz_replacement_status, so it
-- asks the role before the gate asks the flag; both raise the same error.
create or replace trigger trg_order_requests_zz_replacement_header
  before update on public.order_requests
  for each row
  when (new.replacement_for_return_id is not null
        and (old.warehouse_id is distinct from new.warehouse_id
             or old.delivery_charter_id is distinct from new.delivery_charter_id
             or old.created_at is distinct from new.created_at
             or (old.status = 'backordered' and new.status = 'completed')
             or (old.status is distinct from new.status and new.status in ('cancelled', 'denied'))))
  execute function public.tg_order_requests_replacement_header();

reset lock_timeout;
