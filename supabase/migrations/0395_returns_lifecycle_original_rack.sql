-- 0395_returns_lifecycle_original_rack.sql
--
-- RETURNS AND EXCHANGES, SLICE RX-1 (owner GO 2026-10-02, "implement it safely
-- and properly"; plan stockpilot-work/returns-exchange/plan.md section 4 RX-1;
-- brief sections 1, 9-17, 26, 29-31, 33-35, 42, 43, 45). The migration number
-- is a placeholder taken at push time (plan 1.3); the tag on the restated
-- body's lines is `-- RX-1`, not the number, so no fingerprint recorded here
-- changes when the file is renumbered.
--
-- No existing row is written. Every statement below creates an object, alters
-- a policy, changes a grant or replaces one function body.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. Keys on the return tables: returns (id, organization_id) and
--      return_lines (id, return_id) unique (the composite foreign keys of the
--      new decision log, and of RX-2's exchange table), and one RMA number per
--      organization (6 rows, 6 distinct numbers in production on 2026-10-04).
--   2. public.return_decisions: the append-only decision log (created,
--      approved, denied, received, cancelled, closed, disposition_planned, and
--      the exchange kinds RX-2 writes). Read with returns:read or
--      returns:manage; written only by the functions below.
--   3. notification_preferences.push_return_requested (default on): the staff
--      "new return request" push the service sends for requester returns.
--   4. public.return_overview: the list's one read (security_invoker, so the
--      caller's RLS applies). RX-2 appends columns; it never reorders these.
--   5. The ledger helpers of Original rack (all SECURITY INVOKER, no API
--      EXECUTE): ledger.return_line_sources, return_line_plans_original,
--      return_line_restock_legs, return_restock_original.
--   6. ledger.process_return_disposition restated from its live text (0373,
--      md5(prosrc) 1fc9012a1051d2250d67f864004bc757): the manager-role gate
--      becomes returns:manage plus write access to the order's warehouse, and
--      a restock planned to the original rack goes there in the same
--      transaction instead of Staging. Every other line is byte-identical;
--      every added line ends in `-- RX-1` (the reverse-replace proof is in
--      the pgTAP suite and the production check file).
--   7. The RMA functions (SECURITY DEFINER, gate in the body): create (staff
--      and, for the service role only, requester), approve (optionally
--      receiving in the same transaction: the counter), deny, receive,
--      cancel, plan the dispositions, close, and the restock options read.
--      Four exchange hooks RX-2 fills (here: exchange input is refused with
--      exchange_not_available).
--   8. The write posture (expand): the four write policies follow
--      returns:manage instead of the manager role, AND write access to the
--      warehouse of the RMA's order (user_can_access_inventory(..., 'write'),
--      the rule every RMA function applies, D27), with the order read in the
--      RMA's own organization; anon loses every privilege on both tables;
--      authenticated loses DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN,
--      every UPDATE on return_lines, and every UPDATE on returns except the
--      eight columns today's raw transitions write. Two INVOKER guard
--      triggers hold API-role writes to the old tabs' shapes: an insert only
--      at requested with no stamps, for an order of the RMA's organization
--      in a warehouse the caller writes, a status edge only with its own
--      stamps naming the caller, never into closed, and a line only on a
--      requested RMA, for a line of that RMA's order, never applied. RX-4
--      revokes the remaining INSERT and the eight UPDATE columns.
--
-- ── ORIGINAL RACK (plan 3.5) ───────────────────────────────────────────────
-- A return line's sources are the holdings its order's picks of that item
-- actually drew (stock_movements.draw on the order's stamped pick transfers),
-- minus what earlier closed returns of that order line restored to each
-- location (their return movements with to_location_id). Never bin_location,
-- primary_location_id or the custom_fields rack keys. The line is "not
-- recorded" (case not_recorded) when a pick carries no draw, a Reopen picking
-- movement exists for the item, the order has more than one line for the
-- item, or the drawn total differs from quantity_fulfilled +
-- coalesce(quantity_picked, 0). Otherwise: one location is single_source;
-- several, with this return covering everything still out and every earlier
-- return of the line restored to a recorded source, is full_remainder; any
-- other several is partial (a manager picks one source, capped at what is
-- still out there). A source is valid when it exists in the RMA's
-- organization, is not archived, is a placement (kind rack/crate/area or type
-- shelf/bin, never Staging, Unplaced or a Site), has the kind and warehouse
-- its draws recorded, is organization-level or in the item's warehouse, sits
-- in an active warehouse, and the item is not deleted. The close re-derives
-- the legs under FOR SHARE locks on the locations and their warehouses (so
-- an archive, a move or a deactivation is serialised with the close),
-- re-checks every rule and the remaining quantity, and raises
-- restock_location_unavailable, restock_plan_stale or restock_plan_mismatch
-- rather than falling back: the RMA stays received and nothing moves.
--
-- ── STOCK SEMANTICS KEPT ───────────────────────────────────────────────────
-- Staging restock and scrap are 0373's legs, byte-identical (scrap stays
-- +q return then -q loss drawn staging_first: net zero). The rack leg changes
-- on hand and the rack holding together (ledger.apply_holding_delta) and
-- writes one 'return' movement with to_location_id and the RMA reference, so
-- sum(holdings) = on hand after every close. The budget, the latch, the
-- status gate and the header close are unchanged.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The functions (all plpgsql, which resolves table names at run time) lock no
-- table, so they are created first. Then one NOWAIT prelude (0390's pattern)
-- takes every table lock the rest needs: ACCESS EXCLUSIVE on returns,
-- return_lines (policies, triggers, keys, grants) and notification_preferences
-- (ADD COLUMN, metadata only), SHARE ROW EXCLUSIVE on organizations,
-- inventory_items and order_requests (return_decisions' foreign keys add RI
-- triggers there), and ACCESS EXCLUSIVE on every table
-- supautils.policy_grants lists for this role (supautils 3.4.0 takes those on
-- any CREATE or ALTER POLICY by postgres). A busy table fails one attempt, its
-- subtransaction releases what it took, and the next attempt starts after 50
-- to 150 ms holding nothing, up to 40 attempts; then 55P03 and nothing is
-- applied. No later statement locks a new table, so the file never waits
-- while holding a lock (scripts/db-concurrency/0395_migration_lock_footprint.sh).
-- lock_timeout is 5s for the file and 900ms after the prelude (below the 1s
-- deadlock_timeout), so an unforeseen wait fails this file, never a user's
-- transaction. Push off-peak.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- 42501, P0001, P0002, 22023 and 55P03 only, each with a stable hint the app
-- maps (packages/core/src/returns/return-error-map.ts). No function here
-- raises the two retryable classes PostgREST would re-run forever (0367).

set lock_timeout = '5s';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- The restated body must start from the live text, and the objects it calls
-- must be the ones this file was written against. Anything else is drift:
-- stop before changing anything.
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, v.want_cfg, p.oid as poid,
           md5(p.prosrc) as got_src, p.prosecdef as got_secdef,
           coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
           pg_get_userbyid(p.proowner) as got_owner
      from (values
        -- The body restated below, its frozen wrapper (old tabs call it), and
        -- the explicit-location writer the rack leg calls. The wider frozen set
        -- (plan 1.5) is pinned by the pgTAP suite and the production check.
        ('ledger.process_return_disposition(uuid)',            '1fc9012a1051d2250d67f864004bc757', true,  'search_path=public, extensions'),
        ('public.process_return_disposition(uuid)',            '7ec76cc98b9cefc31707590071ac14d9', false, 'search_path=public'),
        ('ledger.apply_holding_delta(uuid,uuid,numeric)',      'f135bb5c02eb9c919cb8c0d8f8d62faa', true,  'search_path=public')
      ) v(sig, want_src, want_secdef, want_cfg)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_cfg <> r.want_cfg
          or r.got_owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, %s, owner %s);',
                               r.sig, r.got_src, r.got_secdef, r.got_cfg, r.got_owner);
    end if;
  end loop;

  -- The four write policies this file alters, as 0153 wrote them.
  for r in
    select v.tbl, v.pol, v.want, md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) as got
      from (values
        ('returns',      'returns_insert',      '226759b75e7434ed1b3694ce65543997'),
        ('returns',      'returns_update',      'e0386d65cca94c5f8270e29893096404'),
        ('return_lines', 'return_lines_insert', 'ddcafdad7690b306d2e155346fde471c'),
        ('return_lines', 'return_lines_update', '5140d035fd91f85d90cd4b32f12c1eed')
      ) v(tbl, pol, want)
      left join pg_policies p on p.schemaname = 'public' and p.tablename = v.tbl and p.policyname = v.pol
  loop
    if r.got is distinct from r.want then
      v_bad := v_bad || format(' policy %s.%s drifted (%s);', r.tbl, r.pol, coalesce(r.got, 'missing'));
    end if;
  end loop;

  -- Already applied (or half applied by hand): every new name must be free.
  if to_regclass('public.return_decisions') is not null
     or to_regclass('public.return_overview') is not null
     or to_regprocedure('public.close_return(uuid,jsonb,bigint)') is not null
     or to_regprocedure('ledger.return_line_sources(uuid)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'notification_preferences'
                   and column_name = 'push_return_requested') then
    v_bad := v_bad || ' the RX-1 objects already exist;';
  end if;

  if v_bad <> '' then
    raise exception 'rx1_preflight: %', v_bad
      using errcode = '55000', hint = 'rx1_preflight';
  end if;
end
$preflight$;

-- ═══ 1. Functions (plpgsql only: no table lock is taken here) ═════════════

-- ── 1a. Original rack: the ledger helpers (SECURITY INVOKER, no API EXECUTE)
-- They run only inside the SECURITY DEFINER bodies below (as postgres), so
-- they need no grant to any API role and stay off the 0359 census of
-- DEFINER functions in ledger (test 15).

create function ledger.return_line_sources(p_return_line_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_line      record;
  v_rma_ids   uuid[];
  v_reason    text;
  v_dup       integer;
  v_drawn     numeric(14,4);
  v_expected  numeric(14,4);
  v_count     integer := 0;
  v_restored  numeric(14,4) := 0;
  v_remaining numeric(14,4) := 0;
  v_sources   jsonb := '[]'::jsonb;
  v_case      text;
  v_all_valid boolean := true;
  v_offer_src jsonb := '[]'::jsonb;
  v_offer_org boolean := false;
  v_problem   text;
  s           record;
begin
  select rl.id, rl.return_id, rl.organization_id, rl.item_id, rl.quantity, rl.applied,
         rl.order_request_line_id, r.order_request_id,
         orl.quantity_fulfilled, orl.quantity_picked, orl.returned_quantity,
         ii.warehouse_id as item_warehouse_id, ii.deleted_at as item_deleted_at
    into v_line
    from public.return_lines rl
    join public.returns r on r.id = rl.return_id
    join public.order_request_lines orl on orl.id = rl.order_request_line_id
    join public.inventory_items ii on ii.id = rl.item_id
   where rl.id = p_return_line_id;
  if not found then
    return null;
  end if;

  -- Not recorded: any one of the four rules (plan 3.5.1).
  select count(*) into v_dup
    from public.order_request_lines
   where order_request_id = v_line.order_request_id
     and item_id = v_line.item_id;
  if v_dup > 1 then
    v_reason := 'duplicate_line';
  end if;

  -- Only a ledger row counts (desk check F9): a member may insert a movement
  -- directly (via_ledger false) with any reason text, and that must not
  -- change what the provenance proves.
  if v_reason is null and exists (
       select 1 from public.stock_movements m
        where m.item_id = v_line.item_id
          and m.organization_id = v_line.organization_id
          and m.reason = 'Reopen picking (order_request ' || v_line.order_request_id::text || ')'
          and m.via_ledger) then
    v_reason := 'reopened';
  end if;

  if v_reason is null and exists (
       select 1 from public.stock_movements m
        where m.reference_id = v_line.order_request_id
          and m.reference_type = 'order_request'
          and m.organization_id = v_line.organization_id
          and m.item_id = v_line.item_id
          and m.movement_type = 'transfer'
          and m.quantity_change < 0
          and m.via_ledger
          and m.draw is null) then
    v_reason := 'no_draw';
  end if;

  select coalesce(-sum(h.quantity), 0) into v_drawn
    from public.stock_movements m
    cross join lateral unnest((m.draw).holdings) as h
   where m.reference_id = v_line.order_request_id
     and m.reference_type = 'order_request'
     and m.organization_id = v_line.organization_id
     and m.item_id = v_line.item_id
     and m.movement_type = 'transfer'
     and m.quantity_change < 0
     and m.via_ledger
     and h.quantity < 0;
  v_expected := coalesce(v_line.quantity_fulfilled, 0) + coalesce(v_line.quantity_picked, 0);
  if v_reason is null and v_drawn <> v_expected then
    v_reason := 'drawn_mismatch';
  end if;

  if v_reason is null then
    -- The other returns of this order: their rack legs are what was restored.
    select coalesce(array_agg(r2.id), '{}'::uuid[]) into v_rma_ids
      from public.returns r2
     where r2.organization_id = v_line.organization_id
       and r2.order_request_id = v_line.order_request_id;

    for s in
      with held as (
        select h.location_id, h.quantity, h.location_kind, h.location_warehouse_id
          from public.stock_movements m
          cross join lateral unnest((m.draw).holdings) as h
         where m.reference_id = v_line.order_request_id
           and m.reference_type = 'order_request'
           and m.organization_id = v_line.organization_id
           and m.item_id = v_line.item_id
           and m.movement_type = 'transfer'
           and m.quantity_change < 0
           and m.via_ledger
           and h.quantity < 0
      ),
      d as (
        select location_id,
               -sum(quantity) as drawn,
               array_agg(distinct coalesce(location_kind, '')) as kinds_at_draw,
               array_agg(distinct coalesce(location_warehouse_id::text, '')) as whs_at_draw
          from held
         group by location_id
      ),
      rr as (
        select m.to_location_id as location_id, sum(m.quantity_change) as restored
          from public.stock_movements m
         where m.reference_id = any (v_rma_ids)
           and m.reference_type = 'return'
           and m.movement_type = 'return'
           and m.organization_id = v_line.organization_id
           and m.item_id = v_line.item_id
           and m.to_location_id is not null
           and m.via_ledger
         group by m.to_location_id
      )
      select d.location_id, d.drawn, coalesce(rr.restored, 0) as restored,
             d.drawn - coalesce(rr.restored, 0) as remaining,
             d.kinds_at_draw, d.whs_at_draw,
             l.id as l_id, l.organization_id as l_org, l.deleted_at as l_deleted_at,
             l.kind as l_kind, l.type as l_type, l.warehouse_id as l_wh, l.name as l_name,
             w.status as w_status
        from d
        left join rr on rr.location_id = d.location_id
        left join public.locations l on l.id = d.location_id
        left join public.warehouses w on w.id = l.warehouse_id
       order by d.location_id
    loop
      -- Validity, now (plan 3.5.2 rules 1-8; rule 9 is the remaining quantity).
      -- The placement test mirrors core isRackShelfLocation
      -- (location-groups.ts): not a system bucket, and a placement kind or type.
      -- A NULL kind or type reads as '' (core's `?? ''`): without the coalesce
      -- a NULL-kind Site gives NULL here, the CASE skips it, and the Site
      -- would be offered as an original rack (D12; test stage, pgTAP H6).
      v_problem := case
        when s.l_id is null or s.l_org <> v_line.organization_id then 'missing'
        when s.l_deleted_at is not null then 'archived'
        when not (coalesce(s.l_kind, '') not in ('staging', 'unplaced')
                  and (coalesce(s.l_kind, '') in ('rack', 'crate', 'area')
                       or coalesce(s.l_type, '') in ('shelf', 'bin')))
          then 'not_a_placement'
        when s.kinds_at_draw <> array[coalesce(s.l_kind, '')] then 'not_a_placement'
        when s.whs_at_draw <> array[coalesce(s.l_wh::text, '')] then 'moved_warehouse'
        when s.l_wh is not null and s.l_wh is distinct from v_line.item_warehouse_id then 'moved_warehouse'
        when s.l_wh is not null and s.w_status is distinct from 'active' then 'warehouse_inactive'
        when v_line.item_deleted_at is not null then 'item_deleted'
        else null
      end;
      if v_problem is not null then
        v_all_valid := false;
      end if;
      v_count := v_count + 1;
      v_restored := v_restored + s.restored;
      v_remaining := v_remaining + s.remaining;
      v_sources := v_sources || jsonb_build_array(jsonb_build_object(
        'locationId', s.location_id,
        'name',       s.l_name,
        'kind',       s.l_kind,
        'type',       s.l_type,
        'drawn',      trim_scale(s.drawn),
        'restored',   trim_scale(s.restored),
        'remaining',  trim_scale(s.remaining),
        'valid',      v_problem is null,
        'reason',     v_problem));
      if v_problem is null and s.remaining >= v_line.quantity then
        v_offer_src := v_offer_src || to_jsonb(s.location_id::text);
      end if;
    end loop;

    if v_count = 0 then
      v_reason := 'drawn_mismatch';
    end if;
  end if;

  if v_reason is not null then
    v_case := 'not_recorded';
    v_sources := '[]'::jsonb;
    v_offer_src := '[]'::jsonb;
  elsif v_count = 1 then
    v_case := 'single_source';
    v_offer_org := v_all_valid and v_remaining >= v_line.quantity;
    v_offer_src := '[]'::jsonb;
  elsif v_restored = coalesce(v_line.returned_quantity, 0) and v_line.quantity = v_remaining then
    v_case := 'full_remainder';
    v_offer_org := v_all_valid;
    v_offer_src := '[]'::jsonb;
  else
    v_case := 'partial';
  end if;

  return jsonb_build_object(
    'returnLineId',      v_line.id,
    'itemId',            v_line.item_id,
    'quantity',          trim_scale(v_line.quantity),
    'case',              v_case,
    'notRecordedReason', v_reason,
    'fulfilled',         trim_scale(v_line.quantity_fulfilled),
    'returnedApplied',   trim_scale(v_line.returned_quantity),
    'drawnTotal',        trim_scale(v_drawn),
    'sources',           v_sources,
    'offerOriginal',     v_offer_org,
    'offerSourceIds',    v_offer_src);
end;
$$;

create function ledger.return_line_plans_original(p_return_line_id uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_target text;
begin
  select d.restock_target into v_target
    from public.return_decisions d
   where d.return_line_id = p_return_line_id
     and d.kind = 'disposition_planned'
   order by d.seq desc
   limit 1;
  return coalesce(v_target in ('original', 'source'), false);
end;
$$;

create function ledger.return_line_restock_legs(p_return_line_id uuid)
returns table (location_id uuid, quantity numeric, remaining numeric, valid boolean, problem text)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_plan record;
  v_src  jsonb;
  v_qty  numeric(14,4);
  e      jsonb;
begin
  select d.disposition, d.restock_target, d.location_id
    into v_plan
    from public.return_decisions d
   where d.return_line_id = p_return_line_id
     and d.kind = 'disposition_planned'
   order by d.seq desc
   limit 1;
  if not found or v_plan.disposition is distinct from 'restock'
     or v_plan.restock_target not in ('original', 'source') then
    raise exception 'restock_plan_stale' using errcode = 'P0001', hint = 'restock_plan_stale';
  end if;

  v_src := ledger.return_line_sources(p_return_line_id);
  if v_src is null or v_src->>'case' = 'not_recorded' then
    raise exception 'restock_plan_stale' using errcode = 'P0001', hint = 'restock_plan_stale';
  end if;
  v_qty := (v_src->>'quantity')::numeric;

  if v_plan.restock_target = 'original' then
    if v_src->>'case' = 'single_source' then
      e := v_src->'sources'->0;
      return query select (e->>'locationId')::uuid, v_qty, (e->>'remaining')::numeric,
                          (e->>'valid')::boolean, e->>'reason';
    elsif v_src->>'case' = 'full_remainder' then
      return query
        select (x->>'locationId')::uuid, (x->>'remaining')::numeric, (x->>'remaining')::numeric,
               (x->>'valid')::boolean, x->>'reason'
          from jsonb_array_elements(v_src->'sources') as x
         where (x->>'remaining')::numeric > 0;
    else
      raise exception 'restock_plan_stale' using errcode = 'P0001', hint = 'restock_plan_stale';
    end if;
  else
    select x into e
      from jsonb_array_elements(v_src->'sources') as x
     where (x->>'locationId')::uuid = v_plan.location_id;
    if e is null then
      raise exception 'restock_plan_stale' using errcode = 'P0001', hint = 'restock_plan_stale';
    end if;
    return query select v_plan.location_id, v_qty, (e->>'remaining')::numeric,
                        (e->>'valid')::boolean, e->>'reason';
  end if;
end;
$$;

-- The rack leg. The caller (ledger.process_return_disposition) holds the RMA,
-- the source order line and the item FOR UPDATE and runs inside the wrapper's
-- ledger transaction, so apply_holding_delta's own gates (ledger.active(),
-- staff or above, the location in the organization, manager or write access
-- to the location) hold for the signed-in caller.
create function ledger.return_restock_original(
  p_return_id uuid, p_line_id uuid, p_item_id uuid, p_quantity numeric, p_user uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org  uuid;
  v_prev numeric;
  v_new  numeric;
  v_sum  numeric := 0;
  v_leg  record;
  v_locs uuid[];
begin
  select organization_id into v_org from public.inventory_items where id = p_item_id;

  -- Lock the planned locations FOR SHARE, in id order, then derive the legs
  -- again under those locks: an archive or a move that commits first is seen;
  -- one that comes later waits for this close.
  select coalesce(array_agg(g.location_id), '{}'::uuid[]) into v_locs
    from ledger.return_line_restock_legs(p_line_id) g;
  perform 1
     from public.locations l
    where l.id = any (v_locs)
    order by l.id
      for share of l;
  -- And their warehouses (desk check F8): a deactivation updates the
  -- warehouse row, not the location, so the location lock alone does not hold
  -- it off. A status change that commits first is seen by the derivation
  -- below; a later one waits for this close. Locations, then warehouses, each
  -- in id order; nothing locks a warehouse row and then a location (a
  -- warehouse update is a single row, and a location's foreign key takes KEY
  -- SHARE, which FOR SHARE does not block).
  perform 1
     from public.warehouses w
    where w.id in (select l.warehouse_id from public.locations l where l.id = any (v_locs))
    order by w.id
      for share of w;

  for v_leg in
    select g.location_id, g.quantity, g.remaining, g.valid, g.problem
      from ledger.return_line_restock_legs(p_line_id) g
     order by g.location_id
  loop
    if not v_leg.valid then
      raise exception 'restock_location_unavailable'
        using errcode = 'P0001', hint = 'restock_location_unavailable',
              detail = jsonb_build_object('rule', v_leg.problem, 'locationId', v_leg.location_id)::text;
    end if;
    if v_leg.quantity > v_leg.remaining then
      raise exception 'restock_location_unavailable'
        using errcode = 'P0001', hint = 'restock_location_unavailable',
              detail = jsonb_build_object('rule', 'remaining', 'locationId', v_leg.location_id)::text;
    end if;
    if v_leg.quantity <= 0 then
      continue;
    end if;
    -- apply_holding_delta below refuses a signed-in caller below manager who
    -- may not write this location, with a bare token. The same test, first,
    -- with a hint the app maps (desk check F7): the rack sits in a warehouse
    -- the closer may not stock, which is not a missing permission to manage
    -- returns.
    if auth.uid() is not null and not public.has_org_role(v_org, 'manager')
       and not public.caller_can_write_location(v_leg.location_id) then
      raise exception 'restock_location_forbidden'
        using errcode = '42501', hint = 'restock_location_forbidden',
              detail = jsonb_build_object('rule', 'location_write', 'locationId', v_leg.location_id)::text;
    end if;

    select quantity_on_hand into v_prev from public.inventory_items where id = p_item_id;
    v_new := v_prev + v_leg.quantity;
    update public.inventory_items
       set quantity_on_hand = v_new, updated_at = now(), updated_by = p_user
     where id = p_item_id;
    perform ledger.apply_holding_delta(p_item_id, v_leg.location_id, v_leg.quantity);
    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      to_location_id, reason, reference_type, reference_id, user_id
    ) values (
      v_org, p_item_id, 'return',
      v_leg.quantity, v_prev, v_new,
      v_leg.location_id, 'Return restock (return ' || p_return_id::text || ')', 'return', p_return_id, p_user
    );
    v_sum := v_sum + v_leg.quantity;
  end loop;

  if v_sum <> p_quantity then
    raise exception 'restock_plan_mismatch'
      using errcode = 'P0001', hint = 'restock_plan_mismatch',
            detail = jsonb_build_object('planned', v_sum, 'returned', p_quantity)::text;
  end if;
end;
$$;

-- ── 1b. The restated body (plan 3.4): 0373's live text, ten lines tagged
-- `-- RX-1` (the manager-role gate becomes returns:manage plus warehouse write;
-- a restock planned to the original rack takes the rack leg). Header, owner,
-- ACL and comment unchanged; the public wrapper is untouched.
CREATE OR REPLACE FUNCTION ledger.process_return_disposition(p_return_id uuid)
 RETURNS public.returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_return  public.returns%rowtype;
  v_user    uuid := auth.uid();
  v_line    record;
  v_item    public.inventory_items%rowtype;
  v_prev    numeric;
  v_new     numeric;
  v_fulfilled numeric(14,4);
  v_returned  numeric(14,4);
  v_prov      public.stock_draw;  -- 0373
  v_wh        uuid;  -- RX-1
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Lock the header so concurrent receive/close calls on the same return
  -- serialize; the applied latch on each line is the per-line guard.
  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'return_not_found' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_return.organization_id, 'returns:manage') then  -- RX-1
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select o.warehouse_id into v_wh from public.order_requests o where o.id = v_return.order_request_id;  -- RX-1
  if not public.user_can_access_inventory(v_user, v_wh, null, 'write') then  -- RX-1
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';  -- RX-1
  end if;  -- RX-1

  -- Status gate: inventory only moves for a return that has actually been
  -- received. A return still in 'requested'/'approved' (never received) or in
  -- 'denied'/'cancelled' must never push stock — that would let a manager skip
  -- the approval/receipt workflow. 'closed' is already settled (this RPC moved
  -- it there); re-calling on a closed return is a no-op because every line's
  -- applied latch is true, but we still reject the transition explicitly so the
  -- received->closed move is the only path that mutates inventory. Mirrors
  -- cancel_order_request's invalid_status_transition guard (0137).
  if v_return.status <> 'received' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_return.status;
  end if;

  -- order by item_id keeps the per-item row-lock order stable across concurrent
  -- calls touching the same item (matches complete_picking / cancel_order_request).
  for v_line in
    select rl.id as line_id, rl.item_id, rl.quantity, rl.disposition,
           rl.order_request_line_id
    from public.return_lines rl
    where rl.return_id = p_return_id
      and rl.applied = false
    order by rl.item_id
  loop
    -- ── Layer-2 backstop (0154): re-assert the DURABLE budget for this source
    -- line BEFORE moving any stock. Lock the source line FOR UPDATE so concurrent
    -- dispositions for the same line serialise, then refuse if consuming this
    -- line's quantity would push returned_quantity past quantity_fulfilled. If it
    -- would, a header status was forged past the transition trigger / INSERT cap
    -- (e.g. a cancel→revive). Reading the durable returned_quantity (not a SUM
    -- over mutable return rows) means a revive cannot trick this check. Applies to
    -- scrap lines too — over-claiming a line at all is inconsistent, reject
    -- regardless of disposition.
    select orl.quantity_fulfilled, orl.returned_quantity
      into v_fulfilled, v_returned
    from public.order_request_lines orl
    where orl.id = v_line.order_request_line_id
    for update;
    if not found then
      raise exception 'order_request_line_not_found'
        using errcode = 'P0002', detail = v_line.order_request_line_id::text;
    end if;

    if v_returned + v_line.quantity > v_fulfilled then
      raise exception 'return_exceeds_fulfilled'
        using errcode = 'P0001',
              detail = format(
                'order_request_line %s: returned %s + %s exceeds fulfilled %s',
                v_line.order_request_line_id, v_returned, v_line.quantity, v_fulfilled
              );
    end if;

    -- Lock the item once for the whole (possibly two-movement) disposition.
    select * into v_item
    from public.inventory_items
    where id = v_line.item_id
    for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    -- Defence in depth: the line's item must belong to the return's org.
    if v_item.organization_id <> v_return.organization_id then
      raise exception 'cross_org_item' using errcode = '42501';
    end if;
    if v_line.disposition = 'restock' and ledger.return_line_plans_original(v_line.line_id) then  -- RX-1
      perform ledger.return_restock_original(p_return_id, v_line.line_id, v_line.item_id, v_line.quantity, v_user);  -- RX-1
    else  -- RX-1

    -- INVENTORY MODEL: the returned unit already left on-hand at fulfilment.
    --   RESTOCK → +qty 'return' (re-enters sellable stock; net vs fulfilment = 0).
    --   SCRAP   → +qty 'return' THEN -qty 'loss' (NET-ZERO receive-then-write-off;
    --             a bare -qty would DOUBLE-DECREMENT a unit already gone).
    v_prev := v_item.quantity_on_hand;
    v_new  := v_prev + v_line.quantity;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_line.item_id;
    -- 0373: drawn before the insert (0197 drew after it), so this row carries its own draw.
    v_prov := ledger.apply_level_delta_for(v_line.item_id, v_line.quantity, 'staging', true, v_user);  -- 0373
    insert into public.stock_movements (
      draw,  -- 0373
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_prov,  -- 0373
      v_return.organization_id, v_line.item_id, 'return',
      v_line.quantity, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );
    -- 0197: returned unit lands in Staging (+delta mirrors the on_hand increment above).

    -- SCRAP: immediately write the received unit off as a 'loss' so the net
    -- effect on on-hand is zero (the unit is destroyed, it was never sellable).
    if v_line.disposition = 'scrap' then
      v_prev := v_new;
      v_new  := v_prev - v_line.quantity;
      if v_new < 0 then
        raise exception 'insufficient_stock' using errcode = 'P0001';
      end if;
      update public.inventory_items
        set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_line.item_id;
      -- 0373: drawn before the insert (0197 drew after it), so this row carries its own draw.
      v_prov := ledger.apply_level_delta_for(v_line.item_id, -v_line.quantity, 'staging_first', true, v_user);  -- 0373
      insert into public.stock_movements (
        draw,  -- 0373
        organization_id, item_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, reference_type, reference_id, user_id
      ) values (
        v_prov,  -- 0373
        v_return.organization_id, v_line.item_id, 'loss',
        -v_line.quantity, v_prev, v_new,
        'Return scrap write-off (return ' || p_return_id::text || ')',
        'return', p_return_id, v_user
      );
      -- 0197: scrap loss drains Staging first (staging_first) so the unit that
      -- just landed in Staging is removed — net Staging change = 0 (no stranded unit).
    end if;
    end if;  -- RX-1

    -- Consume the durable budget (idempotent via the applied latch below).
    update public.order_request_lines
      set returned_quantity = returned_quantity + v_line.quantity
    where id = v_line.order_request_line_id;

    -- One-way latch: never apply a disposition twice.
    update public.return_lines
      set applied = true
      where id = v_line.line_id;
  end loop;

  -- Make the received->closed transition atomic with the inventory write: once
  -- stock has moved the return is settled, so close it in the same transaction.
  -- (The status guard above ensures we only ever reach here from 'received'.)
  update public.returns
    set status    = 'closed',
        closed_by = v_user,
        closed_at = now()
  where id = p_return_id;

  select * into v_return from public.returns where id = p_return_id;
  return v_return;
end;
$function$;

-- ── 1c. The exchange hooks (RX-2 replaces only these bodies; the gated public
-- bodies keep this file's md5, which RX-2's preflight pins). PL/pgSQL
-- resolves the calls at run time, so each hook keeps its signature.

create function public._return_exchange_create(
  p_return_id uuid, p_order_id uuid, p_request jsonb, p_actor jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from jsonb_array_elements(coalesce(p_request->'lines', '[]'::jsonb)) as l
              where jsonb_typeof(l) = 'object' and coalesce(l->'exchange', 'null'::jsonb) <> 'null'::jsonb) then
    raise exception 'exchange_not_available' using errcode = 'P0001', hint = 'exchange_not_available';
  end if;
end;
$$;

create function public._return_exchange_approve(
  p_return_id uuid, p_decision jsonb, p_user uuid, p_revision integer)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(p_decision->'exchange') = 'array' and jsonb_array_length(p_decision->'exchange') > 0 then
    raise exception 'exchange_not_available' using errcode = 'P0001', hint = 'exchange_not_available';
  end if;
  return null;
end;
$$;

create function public._return_exchange_on_deny(p_return_id uuid, p_user uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- RX-1: a return has no exchange lines to decline.
  return;
end;
$$;

create function public._return_exchange_on_cancel(p_return_id uuid, p_user uuid, p_reason text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- RX-1: a return has no replacement to cancel.
  return;
end;
$$;

-- ── 1d. Shared internals (SECURITY INVOKER, no API EXECUTE; they run inside
-- the DEFINER functions below, as postgres).

-- The request, checked and in one canonical shape (lines sorted by source
-- line). p_tier 'staff' or 'requester': a requester's lines are always
-- restock, and only staff send itemIsHere.
create function public._return_normalize_request(p_request jsonb, p_tier text)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_notes text;
  v_lines jsonb := '[]'::jsonb;
  v_seen  text[] := '{}';
  v_total numeric := 0;
  v_qty   numeric;
  v_disp  text;
  l       jsonb;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'request';
  end if;
  if coalesce(p_request->'reasonCode', 'null'::jsonb) <> 'null'::jsonb
     and (jsonb_typeof(p_request->'reasonCode') <> 'string'
          or p_request->>'reasonCode' not in ('damaged', 'wrong_item', 'end_of_year', 'overage', 'other')) then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'reasonCode';
  end if;
  if coalesce(p_request->'notes', 'null'::jsonb) <> 'null'::jsonb then
    if jsonb_typeof(p_request->'notes') <> 'string' then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'notes';
    end if;
    v_notes := nullif(regexp_replace(p_request->>'notes', '^\s+|\s+$', '', 'g'), '');
    if length(v_notes) > 2000 then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'notes';
    end if;
  end if;
  if jsonb_typeof(p_request->'lines') is distinct from 'array'
     or jsonb_array_length(p_request->'lines') < 1
     or jsonb_array_length(p_request->'lines') > 100 then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'lines';
  end if;
  if coalesce(p_request->'itemIsHere', 'null'::jsonb) <> 'null'::jsonb
     and jsonb_typeof(p_request->'itemIsHere') <> 'boolean' then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'itemIsHere';
  end if;

  for l in select x from jsonb_array_elements(p_request->'lines') as x loop
    if jsonb_typeof(l) <> 'object' or jsonb_typeof(l->'orderRequestLineId') is distinct from 'string'
       or (l->>'orderRequestLineId') !~ c_uuid then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'orderRequestLineId';
    end if;
    if lower(l->>'orderRequestLineId') = any (v_seen) then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'duplicate_line';
    end if;
    v_seen := v_seen || lower(l->>'orderRequestLineId');
    if jsonb_typeof(l->'quantity') is distinct from 'number' then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'quantity';
    end if;
    v_qty := (l->>'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > 10000 then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'quantity';
    end if;
    v_total := v_total + v_qty;
    if p_tier = 'requester' then
      v_disp := 'restock';
    else
      v_disp := coalesce(l->>'disposition', 'restock');
      if (coalesce(l->'disposition', 'null'::jsonb) <> 'null'::jsonb and jsonb_typeof(l->'disposition') <> 'string')
         or v_disp not in ('restock', 'scrap') then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'disposition';
      end if;
    end if;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('orderRequestLineId', lower(l->>'orderRequestLineId'),
                         'quantity', v_qty, 'disposition', v_disp)
      || case when coalesce(l->'exchange', 'null'::jsonb) <> 'null'::jsonb
              then jsonb_build_object('exchange', l->'exchange') else '{}'::jsonb end);
  end loop;

  if p_tier = 'requester' and v_total > 10000 then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'quantity';
  end if;

  select coalesce(jsonb_agg(x order by x->>'orderRequestLineId'), '[]'::jsonb) into v_lines
    from jsonb_array_elements(v_lines) as x;

  return jsonb_build_object(
    'reasonCode', p_request->'reasonCode',
    'notes',      v_notes,
    'itemIsHere', case when p_tier = 'staff' then coalesce((p_request->>'itemIsHere')::boolean, false) else false end,
    'lines',      v_lines);
end;
$$;

-- One create, whatever the path: the order's state, each line against its
-- source line and the durable budget (the cap trigger stays authoritative),
-- the header with a unique RMA number, the lines in item order (the order the
-- close locks source lines in), the exchange hook, and the created decision.
create function public._return_create_core(
  p_org uuid, p_order_id uuid, p_canon jsonb, p_source text, p_requested_by uuid,
  p_requester_name text, p_requester_email text, p_channel text, p_actor_kind text,
  p_actor_user uuid, p_actor jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status  text;
  v_id      uuid;
  v_number  text;
  v_try     integer := 0;
  v_cname   text;
  v_line    record;
  v_pending numeric(14,4);
  v_msg     text;
  v_hint    text;
  v_detail  text;
  l         jsonb;
begin
  select o.status into v_status
    from public.order_requests o
   where o.id = p_order_id and o.organization_id = p_org;
  if v_status is null then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
  end if;
  if v_status not in ('completed', 'delivered') then
    raise exception 'order_not_returnable' using errcode = 'P0001', hint = 'order_not_returnable',
      detail = v_status;
  end if;

  -- Each line: on this order, fulfilled, within the durable budget less the
  -- pending (unapplied, live) demand, exactly the number the cap trigger uses.
  for l in select x from jsonb_array_elements(p_canon->'lines') as x loop
    select orl.id, orl.order_request_id, orl.item_id, orl.quantity_fulfilled, orl.returned_quantity
      into v_line
      from public.order_request_lines orl
     where orl.id = (l->>'orderRequestLineId')::uuid;
    if not found or v_line.order_request_id <> p_order_id then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid',
        detail = 'orderRequestLineId';
    end if;
    select coalesce(sum(rl.quantity), 0) into v_pending
      from public.return_lines rl
      join public.returns r on r.id = rl.return_id
     where rl.order_request_line_id = v_line.id
       and rl.applied = false
       and r.status not in ('cancelled', 'denied');
    if (l->>'quantity')::numeric > coalesce(v_line.quantity_fulfilled, 0) - coalesce(v_line.returned_quantity, 0) - v_pending then
      raise exception 'return_exceeds_fulfilled' using errcode = 'P0001', hint = 'return_exceeds_fulfilled',
        detail = jsonb_build_object(
          'orderRequestLineId', v_line.id,
          'remaining', greatest(coalesce(v_line.quantity_fulfilled, 0) - coalesce(v_line.returned_quantity, 0) - v_pending, 0),
          'requested', (l->>'quantity')::numeric)::text;
    end if;
  end loop;

  -- The header, with today's RMA number format; a collision on the
  -- per-organization key is retried, five times at most.
  loop
    v_try := v_try + 1;
    v_number := 'RMA-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-'
                || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    begin
      insert into public.returns (organization_id, order_request_id, return_number, status, source,
                                  reason_code, notes, requested_by, requester_name, requester_email)
      values (p_org, p_order_id, v_number, 'requested', p_source,
              p_canon->>'reasonCode', p_canon->>'notes', p_requested_by, p_requester_name, p_requester_email)
      returning id into v_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_cname = constraint_name;
      if v_cname is distinct from 'returns_org_number_uniq' then
        raise;
      end if;
      if v_try >= 5 then
        raise exception 'return_number_unavailable' using errcode = 'P0001', hint = 'return_number_unavailable';
      end if;
    end;
  end loop;

  begin
    insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
    select v_id, p_org, orl.id, orl.item_id, (x->>'quantity')::numeric, x->>'disposition'
      from jsonb_array_elements(p_canon->'lines') as x
      join public.order_request_lines orl on orl.id = (x->>'orderRequestLineId')::uuid
     order by orl.item_id, orl.id;
  exception when raise_exception then
    -- 0153's cap trigger (frozen) raises a bare token. It fires here only when
    -- a concurrent create took the budget after the check above (its source
    -- line lock serialises the two); answer with the hint the app maps (desk
    -- check F7). Anything else propagates unchanged.
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    if coalesce(v_hint, '') = '' and v_msg = 'return_exceeds_fulfilled' then
      raise exception 'return_exceeds_fulfilled'
        using errcode = 'P0001', hint = 'return_exceeds_fulfilled', detail = coalesce(v_detail, '');
    end if;
    raise;
  end;

  perform public._return_exchange_create(v_id, p_order_id, p_canon, p_actor);

  insert into public.return_decisions (organization_id, return_id, kind, channel, actor_user_id, actor_kind)
  values (p_org, v_id, 'created', p_channel, p_actor_user, p_actor_kind);

  return jsonb_build_object('returnId', v_id, 'returnNumber', v_number);
end;
$$;

-- Validate and append disposition plans (approval, the planner and the
-- close share this one implementation). A restock target is checked against
-- the resolver NOW: original only for single_source / full_remainder with
-- every source valid; source only for a valid proven source of a partial line
-- with room for the whole line. A location outside that set gets one generic
-- answer that never says why. p_always appends even an unchanged plan (the
-- approval records every line's decision); otherwise a plan equal to the live
-- one (or to the legacy default when there is none) appends nothing.
create function public._return_plan_lines(
  p_return_id uuid, p_org uuid, p_lines jsonb, p_user uuid, p_channel text,
  p_require_all boolean, p_always boolean)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_seen   uuid[] := '{}';
  v_line   record;
  v_live   record;
  v_disp   text;
  v_target text;
  v_loc    uuid;
  v_basis  text;
  v_src    jsonb;
  v_count  integer := 0;
  e        jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'lines';
  end if;

  for e in select x from jsonb_array_elements(p_lines) as x loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'returnLineId') is distinct from 'string'
       or (e->>'returnLineId') !~ c_uuid then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'returnLineId';
    end if;
    if (e->>'returnLineId')::uuid = any (v_seen) then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'duplicate_line';
    end if;
    v_seen := v_seen || (e->>'returnLineId')::uuid;

    select rl.id, rl.disposition, rl.applied into v_line
      from public.return_lines rl
     where rl.id = (e->>'returnLineId')::uuid and rl.return_id = p_return_id;
    if not found or v_line.applied then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'returnLineId';
    end if;

    v_disp := e->>'disposition';
    if jsonb_typeof(e->'disposition') is distinct from 'string' or v_disp not in ('restock', 'scrap') then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'disposition';
    end if;

    v_target := null; v_loc := null; v_basis := null;
    if v_disp = 'scrap' then
      -- Scrap carries no destination (brief 10).
      if coalesce(e->'restock', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'restock';
      end if;
    else
      if coalesce(e->'restock', 'null'::jsonb) <> 'null'::jsonb and jsonb_typeof(e->'restock') <> 'object' then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'restock';
      end if;
      v_target := coalesce(e->'restock'->>'target', 'staging');
      if v_target not in ('staging', 'original', 'source') then
        raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'restock';
      end if;
      if v_target <> 'staging' then
        v_src := ledger.return_line_sources(v_line.id);
        if v_target = 'original' then
          if not coalesce((v_src->>'offerOriginal')::boolean, false) then
            raise exception 'restock_location_not_offered' using errcode = 'P0001', hint = 'restock_location_not_offered';
          end if;
          v_basis := v_src->>'case';
        else
          if jsonb_typeof(e->'restock'->'locationId') is distinct from 'string'
             or (e->'restock'->>'locationId') !~ c_uuid
             or not coalesce(v_src->'offerSourceIds', '[]'::jsonb) ? lower(e->'restock'->>'locationId') then
            raise exception 'restock_location_not_offered' using errcode = 'P0001', hint = 'restock_location_not_offered';
          end if;
          v_loc := (e->'restock'->>'locationId')::uuid;
          v_basis := 'manager_choice';
        end if;
      end if;
    end if;

    if not p_always then
      select d.disposition, d.restock_target, d.location_id into v_live
        from public.return_decisions d
       where d.return_line_id = v_line.id and d.kind = 'disposition_planned'
       order by d.seq desc
       limit 1;
      if not found then
        -- No plan yet: the live behaviour is the line's disposition, and a
        -- restock lands in Staging (today's close).
        select v_line.disposition as disposition,
               case when v_line.disposition = 'restock' then 'staging' end as restock_target,
               null::uuid as location_id
          into v_live;
      end if;
      if v_live.disposition = v_disp and v_live.restock_target is not distinct from v_target
         and v_live.location_id is not distinct from v_loc then
        continue;
      end if;
    end if;

    if v_disp is distinct from v_line.disposition then
      update public.return_lines set disposition = v_disp where id = v_line.id;
    end if;
    insert into public.return_decisions (organization_id, return_id, return_line_id, kind, channel,
                                         disposition, restock_target, location_id, basis,
                                         actor_user_id, actor_kind)
    values (p_org, p_return_id, v_line.id, 'disposition_planned', p_channel,
            v_disp, v_target, v_loc, v_basis, p_user, 'staff');
    v_count := v_count + 1;
  end loop;

  if p_require_all and exists (
       select 1 from public.return_lines rl
        where rl.return_id = p_return_id and not rl.applied and not (rl.id = any (v_seen))) then
    raise exception 'return_decision_incomplete' using errcode = 'P0001', hint = 'return_decision_incomplete';
  end if;
  return v_count;
end;
$$;

-- ── 1e. The RMA functions (SECURITY DEFINER; gate in the body; plan 3.3.1:
-- signed in, then the RMA read without a lock (missing and foreign answer
-- alike), then the module, then the permission and warehouse write, and only
-- then the row lock, so a caller who may not act never queues on a row).

create function public.create_return_request(p_order_id uuid, p_request jsonb, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_scope  constant text := 'return_create';
  c_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_user   uuid := auth.uid();
  v_org    uuid;
  v_wh     uuid;
  v_canon  jsonb;
  v_hash   text;
  v_key    text;
  v_key_id uuid;
  v_prev   record;
  v_core   jsonb;
  v_status text;
  v_number text;
  v_chan   text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;

  select o.organization_id, o.warehouse_id into v_org, v_wh
    from public.order_requests o where o.id = p_order_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
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
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;

  v_canon := public._return_normalize_request(p_request, 'staff');
  v_chan := case when (v_canon->>'itemIsHere')::boolean then 'counter' else 'staff' end;
  v_hash := md5(c_scope || ':v1|' || p_order_id::text || '|' || v_canon::text);
  v_key := v_user::text || ':' || p_key::text;

  insert into public.idempotency_keys as k (organization_id, scope, key, request_hash, status, resource_type)
  values (v_org, c_scope, v_key, v_hash, 'in_progress', 'return')
  on conflict (organization_id, scope, key) do nothing
  returning k.id into v_key_id;

  if v_key_id is null then
    select k.request_hash, k.status, k.response into v_prev
      from public.idempotency_keys k
     where k.organization_id = v_org and k.scope = c_scope and k.key = v_key;
    if not found or v_prev.request_hash is distinct from v_hash or v_prev.status is distinct from 'completed'
       or jsonb_typeof(v_prev.response->'returnId') is distinct from 'string'
       or (v_prev.response->>'returnId') !~ c_uuid then
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    -- The stored answer must name an RMA of this organization and this order
    -- (desk check F11): idempotency_keys is writable by managers through the
    -- API, so a row this function did not write could name any RMA. Anything
    -- else is a conflict, never a replay.
    select r.status, r.return_number into v_status, v_number
      from public.returns r
     where r.id = (v_prev.response->>'returnId')::uuid
       and r.organization_id = v_org
       and r.order_request_id = p_order_id;
    if not found then
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('changed', false, 'replay', true,
                              'returnId', v_prev.response->>'returnId', 'returnNumber', v_number,
                              'status', v_status, 'channel', v_chan);
  end if;

  v_core := public._return_create_core(
    v_org, p_order_id, v_canon, 'internal', v_user, null, null, v_chan, 'staff', v_user,
    jsonb_build_object('kind', 'staff', 'userId', v_user, 'channel', v_chan));

  update public.idempotency_keys
     set status = 'completed', resource_id = (v_core->>'returnId')::uuid,
         response = jsonb_build_object('returnId', v_core->>'returnId'), updated_at = now()
   where id = v_key_id;

  return jsonb_build_object('changed', true, 'replay', false,
                            'returnId', v_core->>'returnId', 'returnNumber', v_core->>'returnNumber',
                            'status', 'requested', 'channel', v_chan);
end;
$$;

-- The requester paths (token, B2B portal, member): the SERVER resolved the
-- order and the actor before calling (service role only). Disposition is
-- always restock; the requester's name and email come from the order.
create function public.create_requester_return_request(
  p_order_id uuid, p_request jsonb, p_key uuid, p_actor jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_scope  constant text := 'return_create';
  c_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_org    uuid;
  v_name   text;
  v_email  text;
  v_chan   text;
  v_kind   text;
  v_actor  uuid;
  v_canon  jsonb;
  v_hash   text;
  v_key    text;
  v_key_id uuid;
  v_prev   record;
  v_core   jsonb;
  v_status text;
  v_number text;
begin
  -- A missing or null channel is refused here too (desk check F10): NOT IN
  -- over a NULL is NULL, which would have let the call through to a NOT NULL
  -- failure later.
  if p_actor is null or jsonb_typeof(p_actor) <> 'object'
     or coalesce(p_actor->>'channel', '') not in ('token', 'portal', 'member') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'actor';
  end if;
  v_chan := p_actor->>'channel';
  v_kind := case v_chan when 'portal' then 'portal_customer' else 'requester' end;
  if coalesce(p_actor->'userId', 'null'::jsonb) <> 'null'::jsonb then
    if jsonb_typeof(p_actor->'userId') <> 'string' or (p_actor->>'userId') !~ c_uuid then
      raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'actor';
    end if;
    v_actor := (p_actor->>'userId')::uuid;
  end if;
  if v_chan <> 'token' and v_actor is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'actor';
  end if;
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023', hint = 'idempotency_key_required';
  end if;

  select o.organization_id, o.requester_name, o.requester_email::text into v_org, v_name, v_email
    from public.order_requests o where o.id = p_order_id;
  if v_org is null then
    raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
  end if;
  if not public.module_enabled(v_org, 'returns') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  v_canon := public._return_normalize_request(p_request, 'requester');
  v_hash := md5(c_scope || ':v1|' || p_order_id::text || '|' || v_chan || '|' || v_canon::text);
  v_key := coalesce(v_actor::text, 'anon') || ':' || p_key::text;

  insert into public.idempotency_keys as k (organization_id, scope, key, request_hash, status, resource_type)
  values (v_org, c_scope, v_key, v_hash, 'in_progress', 'return')
  on conflict (organization_id, scope, key) do nothing
  returning k.id into v_key_id;

  if v_key_id is null then
    select k.request_hash, k.status, k.response into v_prev
      from public.idempotency_keys k
     where k.organization_id = v_org and k.scope = c_scope and k.key = v_key;
    if not found or v_prev.request_hash is distinct from v_hash or v_prev.status is distinct from 'completed'
       or jsonb_typeof(v_prev.response->'returnId') is distinct from 'string'
       or (v_prev.response->>'returnId') !~ c_uuid then
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    -- Only an RMA of this organization and this order is replayed (desk
    -- check F11; see create_return_request).
    select r.status, r.return_number into v_status, v_number
      from public.returns r
     where r.id = (v_prev.response->>'returnId')::uuid
       and r.organization_id = v_org
       and r.order_request_id = p_order_id;
    if not found then
      raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('changed', false, 'replay', true, 'organizationId', v_org,
                              'returnId', v_prev.response->>'returnId', 'returnNumber', v_number,
                              'status', v_status);
  end if;

  -- requested_by names a member account only (the member path); the token
  -- path is anonymous and a portal principal is recorded on the decision.
  v_core := public._return_create_core(
    v_org, p_order_id, v_canon, 'requester',
    case when v_chan = 'member' then v_actor end,
    v_name, v_email, v_chan, v_kind, v_actor,
    jsonb_build_object('kind', v_kind, 'userId', v_actor, 'channel', v_chan));

  update public.idempotency_keys
     set status = 'completed', resource_id = (v_core->>'returnId')::uuid,
         response = jsonb_build_object('returnId', v_core->>'returnId'), updated_at = now()
   where id = v_key_id;

  return jsonb_build_object('changed', true, 'replay', false, 'organizationId', v_org,
                            'returnId', v_core->>'returnId', 'returnNumber', v_core->>'returnNumber',
                            'status', 'requested');
end;
$$;

create function public.approve_return(
  p_return_id uuid, p_expected_revision integer, p_decision jsonb, p_receive_now boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  c_scope   constant text := 'return_approval';
  v_user    uuid := auth.uid();
  v_org     uuid;
  v_wh      uuid;
  v_status  text;
  v_rev     integer;
  v_canon   jsonb;
  v_hash    text;
  v_key     text;
  v_key_id  uuid;
  v_prev    record;
  v_repl    jsonb;
  v_exch    jsonb := '[]'::jsonb;
  v_chan    text := case when coalesce(p_receive_now, false) then 'counter' else 'staff' end;
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
  if p_decision is null or jsonb_typeof(p_decision) <> 'object'
     or (coalesce(p_decision->'exchange', 'null'::jsonb) <> 'null'::jsonb
         and jsonb_typeof(p_decision->'exchange') <> 'array') then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'decision';
  end if;
  if jsonb_typeof(p_decision->'exchange') = 'array' then
    v_exch := p_decision->'exchange';
  end if;
  -- An exchange approved or added touches a replacement order: the orders
  -- module and orders:approve (security slice D's precedence), checked here
  -- so the refusal is clean before any row is locked.
  if exists (select 1 from jsonb_array_elements(v_exch) as x where x->>'action' in ('approve', 'add')) then
    if not public.module_enabled(v_org, 'orders') then
      raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
    end if;
    if not public.has_permission(v_org, 'orders:approve') then
      raise exception 'orders_approve' using errcode = '42501', hint = 'orders_approve';
    end if;
  end if;
  if p_expected_revision is null then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'expectedRevision';
  end if;

  select r.status into v_status from public.returns r where r.id = p_return_id for update;

  -- Idempotency: one key per (RMA, revision); the hash is the decision.
  select jsonb_build_object(
           'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                       'returnLineId', lower(x->>'returnLineId'),
                                       'disposition', x->'disposition',
                                       'target', coalesce(x->'restock'->'target', 'null'::jsonb),
                                       'locationId', coalesce(x->'restock'->'locationId', 'null'::jsonb))
                                     order by lower(x->>'returnLineId'))
                                from jsonb_array_elements(case when jsonb_typeof(p_decision->'lines') = 'array'
                                                              then p_decision->'lines' else '[]'::jsonb end) as x), '[]'::jsonb),
           'exchange', coalesce((select jsonb_agg(x order by coalesce(x->>'exchangeLineId', x->>'returnLineId', ''), x::text)
                                   from jsonb_array_elements(v_exch) as x), '[]'::jsonb),
           'replacement', coalesce(p_decision->'replacement', 'null'::jsonb),
           'receiveNow', coalesce(p_receive_now, false))
    into v_canon;
  v_hash := md5(c_scope || ':v1|' || v_canon::text);
  v_key := p_return_id::text || ':' || p_expected_revision::text;

  insert into public.idempotency_keys as k (organization_id, scope, key, request_hash, status, resource_type, resource_id)
  values (v_org, c_scope, v_key, v_hash, 'in_progress', 'return', p_return_id)
  on conflict (organization_id, scope, key) do nothing
  returning k.id into v_key_id;

  -- A key row this function did not complete is not trusted (desk check
  -- F11). Every approval it completes appends the approved decision at the
  -- next revision in the same transaction, and it holds the RMA row lock, so
  -- no approval of this RMA is in flight now: a key row with no such
  -- decision was written by someone else (idempotency_keys is writable by
  -- managers through the API) and would wedge this approval (return_changed)
  -- or fake its replay. Take it over and approve normally. return_decisions
  -- has no API write path, so the decision cannot be planted.
  if v_key_id is null
     and not exists (select 1 from public.return_decisions d
                      where d.return_id = p_return_id and d.kind = 'approved'
                        and d.revision = p_expected_revision + 1) then
    update public.idempotency_keys k
       set request_hash = v_hash, status = 'in_progress', response = null,
           resource_type = 'return', resource_id = p_return_id, updated_at = now()
     where k.organization_id = v_org and k.scope = c_scope and k.key = v_key
    returning k.id into v_key_id;
  end if;

  if v_key_id is null then
    select k.request_hash, k.status, k.response into v_prev
      from public.idempotency_keys k
     where k.organization_id = v_org and k.scope = c_scope and k.key = v_key;
    if not found or v_prev.request_hash is distinct from v_hash or v_prev.status is distinct from 'completed' then
      raise exception 'return_changed' using errcode = 'P0001', hint = 'return_changed';
    end if;
    return jsonb_build_object('changed', false, 'replay', true, 'returnId', p_return_id,
                              'revision', (v_prev.response->>'revision')::integer,
                              'status', v_status,
                              'replacement', coalesce(v_prev.response->'replacement', 'null'::jsonb));
  end if;

  if v_status <> 'requested' then
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

  -- Every line has its decision (no silent default); targets are validated
  -- against the resolver now. Approval moves no stock.
  perform public._return_plan_lines(p_return_id, v_org,
                                    case when jsonb_typeof(p_decision->'lines') = 'array'
                                         then p_decision->'lines' else null end,
                                    v_user, v_chan, true, true);

  v_repl := public._return_exchange_approve(p_return_id, p_decision, v_user, p_expected_revision);

  update public.returns
     set status = 'approved', approved_by = v_user, approved_at = now()
   where id = p_return_id;
  insert into public.return_decisions (organization_id, return_id, kind, channel, revision, actor_user_id, actor_kind)
  values (v_org, p_return_id, 'approved', v_chan, p_expected_revision + 1, v_user, 'staff');

  if coalesce(p_receive_now, false) then
    -- The counter (G1): approve and receive in one transaction. The switch is
    -- off by default on every screen.
    update public.returns
       set status = 'received', received_by = v_user, received_at = now()
     where id = p_return_id;
    insert into public.return_decisions (organization_id, return_id, kind, channel, actor_user_id, actor_kind)
    values (v_org, p_return_id, 'received', 'counter', v_user, 'staff');
  end if;

  update public.idempotency_keys
     set status = 'completed',
         response = jsonb_build_object('returnId', p_return_id, 'revision', p_expected_revision + 1,
                                       'replacement', coalesce(v_repl, 'null'::jsonb)),
         updated_at = now()
   where id = v_key_id;

  return jsonb_build_object('changed', true, 'replay', false, 'returnId', p_return_id,
                            'revision', p_expected_revision + 1,
                            'status', case when coalesce(p_receive_now, false) then 'received' else 'approved' end,
                            'replacement', coalesce(v_repl, 'null'::jsonb));
end;
$$;

create function public.deny_return(p_return_id uuid, p_reason text)
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
  v_row    record;
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

  select r.status, r.denied_by, r.denied_at into v_row
    from public.returns r where r.id = p_return_id for update;
  if v_row.status = 'denied' then
    return jsonb_build_object('changed', false, 'status', 'denied',
                              'deniedBy', v_row.denied_by, 'deniedAt', v_row.denied_at);
  end if;
  if v_row.status <> 'requested' then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_row.status;
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'P0001', hint = 'reason_required';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'reason';
  end if;

  perform public._return_exchange_on_deny(p_return_id, v_user);

  update public.returns
     set status = 'denied', denied_by = v_user, denied_at = now(), denial_reason = v_reason
   where id = p_return_id;
  insert into public.return_decisions (organization_id, return_id, kind, channel, reason, actor_user_id, actor_kind)
  values (v_org, p_return_id, 'denied', 'staff', v_reason, v_user, 'staff');

  return jsonb_build_object('changed', true, 'status', 'denied', 'deniedBy', v_user, 'deniedAt', now());
end;
$$;

create function public.receive_return(p_return_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
  v_wh   uuid;
  v_row  record;
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

  select r.status, r.received_by, r.received_at into v_row
    from public.returns r where r.id = p_return_id for update;
  if v_row.status in ('received', 'closed') then
    return jsonb_build_object('changed', false, 'status', v_row.status,
                              'receivedBy', v_row.received_by, 'receivedAt', v_row.received_at);
  end if;
  if v_row.status <> 'approved' then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_row.status;
  end if;

  update public.returns
     set status = 'received', received_by = v_user, received_at = now()
   where id = p_return_id;
  insert into public.return_decisions (organization_id, return_id, kind, channel, actor_user_id, actor_kind)
  values (v_org, p_return_id, 'received', 'staff', v_user, 'staff');

  return jsonb_build_object('changed', true, 'status', 'received', 'receivedBy', v_user, 'receivedAt', now());
end;
$$;

create function public.cancel_return(p_return_id uuid, p_expected_revision integer, p_reason text)
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

create function public.plan_return_dispositions(p_return_id uuid, p_lines jsonb)
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
  v_n      integer;
  v_seq    bigint;
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

  select r.status into v_status from public.returns r where r.id = p_return_id for update;
  if v_status not in ('approved', 'received') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_status;
  end if;

  v_n := public._return_plan_lines(p_return_id, v_org, p_lines, v_user, 'staff', false, false);

  select coalesce(max(d.seq), 0) into v_seq
    from public.return_decisions d
   where d.return_id = p_return_id and d.kind = 'disposition_planned';
  return jsonb_build_object('changed', v_n > 0, 'appended', v_n, 'planSeq', v_seq);
end;
$$;

create function public.close_return(p_return_id uuid, p_lines jsonb default null, p_expected_plan_seq bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_user  uuid := auth.uid();
  v_org   uuid;
  v_wh    uuid;
  v_row   record;
  v_seq   bigint;
  v_legs  jsonb;
  v_lines jsonb;
  v_ret   public.returns;
  v_state text;
  v_msg   text;
  v_hint  text;
  v_detail text;
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

  select r.status, r.closed_by, r.closed_at into v_row
    from public.returns r where r.id = p_return_id for update;
  if v_row.status = 'closed' then
    return jsonb_build_object('changed', false, 'status', 'closed',
                              'closedBy', v_row.closed_by, 'closedAt', v_row.closed_at);
  end if;
  if v_row.status <> 'received' then
    raise exception 'invalid_status_transition' using errcode = 'P0001', hint = 'invalid_status_transition',
      detail = v_row.status;
  end if;

  if p_expected_plan_seq is not null then
    select coalesce(max(d.seq), 0) into v_seq
      from public.return_decisions d
     where d.return_id = p_return_id and d.kind = 'disposition_planned';
    if v_seq <> p_expected_plan_seq then
      raise exception 'return_plan_changed' using errcode = 'P0001', hint = 'return_plan_changed',
        detail = v_seq::text;
    end if;
  end if;

  -- A destination changed at processing commits with the stock move (C-9).
  if p_lines is not null then
    perform public._return_plan_lines(p_return_id, v_org, p_lines, v_user, 'staff', false, false);
  end if;

  -- The frozen INVOKER wrapper raises the ledger flag and calls the restated
  -- body: on hand, holdings, movements, the budget, the latch and the header
  -- close commit together, or nothing does (and the RMA stays received).
  -- The body's own refusals are 0373's text, a bare token with no hint; the
  -- ones the app maps are raised again here with their hint, the same
  -- SQLSTATE, message and detail (desk check F7: map by hint only). A bare
  -- 'forbidden' there is the body's returns:manage line (the rack leg answers
  -- restock_location_forbidden itself). Everything else propagates as is.
  begin
    v_ret := public.process_return_disposition(p_return_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    if coalesce(v_hint, '') = '' and v_msg in ('unauthenticated', 'return_not_found', 'forbidden',
                                               'invalid_status_transition', 'return_exceeds_fulfilled',
                                               'insufficient_stock') then
      raise exception using message = v_msg, errcode = v_state,
        hint = case when v_msg = 'forbidden' then 'returns_manage' else v_msg end,
        detail = coalesce(v_detail, '');
    end if;
    raise;
  end;

  insert into public.return_decisions (organization_id, return_id, kind, channel, actor_user_id, actor_kind)
  values (v_org, p_return_id, 'closed', 'staff', v_user, 'staff');

  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', m.item_id,
           'locationId', coalesce(m.to_location_id, (((m.draw).holdings)[1]).location_id),
           'quantity', trim_scale(m.quantity_change),
           'destination', case when m.to_location_id is not null then 'rack' else 'staging' end)
           order by m.item_id, m.created_at, m.id), '[]'::jsonb)
    into v_legs
    from public.stock_movements m
   where m.reference_id = p_return_id
     and m.reference_type = 'return'
     and m.movement_type = 'return'
     and m.organization_id = v_org;

  -- Per line (plan 3.3.4 step 7): its disposition, the destination it was
  -- planned to, and the legs of its item (a line's movements carry its item,
  -- not its id; two lines of one item on one order are not_recorded, so they
  -- always went to Staging together).
  select coalesce(jsonb_agg(jsonb_build_object(
           'returnLineId', rl.id,
           'itemId', rl.item_id,
           'quantity', trim_scale(rl.quantity),
           'disposition', rl.disposition,
           'target', case when rl.disposition = 'restock' then coalesce(p.restock_target, 'staging') end,
           'locationId', p.location_id,
           'legs', case when rl.disposition = 'scrap' then '[]'::jsonb
                        else coalesce((select jsonb_agg(g) from jsonb_array_elements(v_legs) g
                                        where g->>'itemId' = rl.item_id::text), '[]'::jsonb) end)
           order by rl.item_id, rl.id), '[]'::jsonb)
    into v_lines
    from public.return_lines rl
    left join lateral (
      select d.restock_target, d.location_id
        from public.return_decisions d
       where d.return_line_id = rl.id and d.kind = 'disposition_planned'
       order by d.seq desc
       limit 1) p on true
   where rl.return_id = p_return_id;

  return jsonb_build_object('changed', true, 'status', v_ret.status,
                            'closedBy', v_ret.closed_by, 'closedAt', v_ret.closed_at,
                            'legs', v_legs, 'lines', v_lines);
end;
$$;

-- The workbench's destination read: per line the case, the sources and
-- whether each is valid now, what may be offered, and the live plan. One call
-- per RMA (brief 44). Staff only (returns:read or returns:manage, and read
-- access to the order's warehouse); never reachable from a requester route.
create function public.return_restock_options(p_return_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_org    uuid;
  v_wh     uuid;
  v_status text;
  v_lines  jsonb := '[]'::jsonb;
  v_seq    bigint;
  v_src    jsonb;
  v_plan   jsonb;
  l        record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  select r.organization_id, o.warehouse_id, r.status into v_org, v_wh, v_status
    from public.returns r join public.order_requests o on o.id = r.order_request_id
   where r.id = p_return_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'return_not_found' using errcode = 'P0002', hint = 'return_not_found';
  end if;
  if not (public.has_permission(v_org, 'returns:read') or public.has_permission(v_org, 'returns:manage')) then
    raise exception 'returns_read' using errcode = '42501', hint = 'returns_read';
  end if;
  if not public.user_can_access_inventory(v_user, v_wh, null, 'read') then
    raise exception 'warehouse_read' using errcode = '42501', hint = 'warehouse_read';
  end if;

  for l in
    select rl.id, rl.item_id, rl.quantity, rl.disposition, rl.applied
      from public.return_lines rl
     where rl.return_id = p_return_id
     order by rl.created_at, rl.id
  loop
    select jsonb_build_object('disposition', d.disposition, 'target', d.restock_target,
                              'locationId', d.location_id, 'basis', d.basis, 'seq', d.seq)
      into v_plan
      from public.return_decisions d
     where d.return_line_id = l.id and d.kind = 'disposition_planned'
     order by d.seq desc
     limit 1;
    v_src := case when l.applied then null else ledger.return_line_sources(l.id) end;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'returnLineId',      l.id,
      'itemId',            l.item_id,
      'quantity',          trim_scale(l.quantity),
      'disposition',       l.disposition,
      'applied',           l.applied,
      'plan',              v_plan,
      'case',              v_src->>'case',
      'notRecordedReason', v_src->>'notRecordedReason',
      'sources',           coalesce(v_src->'sources', '[]'::jsonb),
      'offerOriginal',     coalesce((v_src->>'offerOriginal')::boolean, false),
      'offerSourceIds',    coalesce(v_src->'offerSourceIds', '[]'::jsonb),
      'preselect',         case when coalesce((v_src->>'offerOriginal')::boolean, false) then 'original' else 'staging' end));
  end loop;

  select coalesce(max(d.seq), 0) into v_seq
    from public.return_decisions d
   where d.return_id = p_return_id and d.kind = 'disposition_planned';

  return jsonb_build_object('returnId', p_return_id, 'status', v_status, 'planSeq', v_seq, 'lines', v_lines);
end;
$$;

-- ── 1f. The guard triggers (SECURITY INVOKER: current_user is the role doing
-- the write; a DEFINER function runs as postgres, the server as service_role,
-- a foreign-key action as the table owner, and none of them is held here).

create function public.tg_returns_api_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order_org uuid;
  v_wh        uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- The old tab's create: requested, internal, no stamps (G2).
    if new.status is distinct from 'requested' or new.source is distinct from 'internal'
       or new.approved_by is not null or new.approved_at is not null
       or new.received_by is not null or new.received_at is not null
       or new.closed_by is not null or new.closed_at is not null
       or new.denied_by is not null or new.denied_at is not null
       or new.denial_reason is not null then
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
    select o.organization_id, o.warehouse_id into v_order_org, v_wh
      from public.order_requests o where o.id = new.order_request_id;
    if v_order_org is null or v_order_org is distinct from new.organization_id then
      raise exception 'order_not_found' using errcode = 'P0002', hint = 'order_not_found';
    end if;
    if not public.user_can_access_inventory(auth.uid(), v_wh, null, 'write') then
      raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
    end if;
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

create function public.tg_return_lines_api_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org        uuid;
  v_status     text;
  v_order      uuid;
  v_line_order uuid;
  v_wh         uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.applied then
    raise exception 'return_line_insert_through_rpc' using errcode = '42501', hint = 'return_line_insert_through_rpc';
  end if;
  -- Read as the caller (RLS): an RMA the caller cannot see is refused too.
  select r.organization_id, r.status, r.order_request_id into v_org, v_status, v_order
    from public.returns r where r.id = new.return_id;
  if v_org is null or v_org is distinct from new.organization_id or v_status is distinct from 'requested' then
    raise exception 'return_line_insert_through_rpc' using errcode = '42501', hint = 'return_line_insert_through_rpc';
  end if;
  -- The source line is a line of the RMA's own order (the create functions'
  -- rule): a line of another order would take that order's return budget.
  select orl.order_request_id into v_line_order
    from public.order_request_lines orl where orl.id = new.order_request_line_id;
  if v_line_order is distinct from v_order then
    raise exception 'return_invalid' using errcode = '22023', hint = 'return_invalid', detail = 'orderRequestLineId';
  end if;
  -- And the caller writes the order's warehouse (as the insert policy).
  select o.warehouse_id into v_wh
    from public.order_requests o where o.id = v_order and o.organization_id = v_org;
  if not public.user_can_access_inventory(auth.uid(), v_wh, null, 'write') then
    raise exception 'warehouse_write' using errcode = '42501', hint = 'warehouse_write';
  end if;
  return new;
end;
$$;

create function public.tg_return_decisions_append_only()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'return_decisions_append_only' using errcode = '42501', hint = 'return_decisions_append_only';
end;
$$;

-- ── 1g. Posture: EXECUTE for authenticated on the public RPCs only, the
-- requester create for the service role only, nothing anywhere else.
revoke all on function ledger.return_line_sources(uuid) from public, anon, authenticated, service_role;
revoke all on function ledger.return_line_plans_original(uuid) from public, anon, authenticated, service_role;
revoke all on function ledger.return_line_restock_legs(uuid) from public, anon, authenticated, service_role;
revoke all on function ledger.return_restock_original(uuid, uuid, uuid, numeric, uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_create(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_approve(uuid, jsonb, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_on_deny(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._return_exchange_on_cancel(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._return_normalize_request(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public._return_create_core(uuid, uuid, jsonb, text, uuid, text, text, text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._return_plan_lines(uuid, uuid, jsonb, uuid, text, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.tg_returns_api_guard() from public, anon, authenticated, service_role;
revoke all on function public.tg_return_lines_api_guard() from public, anon, authenticated, service_role;
revoke all on function public.tg_return_decisions_append_only() from public, anon, authenticated, service_role;

revoke all on function public.create_return_request(uuid, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_requester_return_request(uuid, jsonb, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.approve_return(uuid, integer, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.deny_return(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.receive_return(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_return(uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.plan_return_dispositions(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.close_return(uuid, jsonb, bigint) from public, anon, authenticated, service_role;
revoke all on function public.return_restock_options(uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_return_request(uuid, jsonb, uuid) to authenticated;
grant execute on function public.create_requester_return_request(uuid, jsonb, uuid, jsonb) to service_role;
grant execute on function public.approve_return(uuid, integer, jsonb, boolean) to authenticated;
grant execute on function public.deny_return(uuid, text) to authenticated;
grant execute on function public.receive_return(uuid) to authenticated;
grant execute on function public.cancel_return(uuid, integer, text) to authenticated;
grant execute on function public.plan_return_dispositions(uuid, jsonb) to authenticated;
grant execute on function public.close_return(uuid, jsonb, bigint) to authenticated;
grant execute on function public.return_restock_options(uuid) to authenticated;

comment on function ledger.return_line_sources(uuid) is
  'RX-1 (plan 3.5): a return line''s proven sources from draw provenance only (the order''s stamped pick transfers of the item, minus earlier returns of the order restored to each location), the case (single_source, full_remainder, partial, not_recorded with its reason), each source''s validity now with its reason (missing, archived, not_a_placement, moved_warehouse, warehouse_inactive, item_deleted), and what may be offered (offerOriginal, offerSourceIds). Never reads bin_location, primary_location_id or custom_fields. SECURITY INVOKER, STABLE, no API EXECUTE: called by the DEFINER RMA functions as postgres.';
comment on function ledger.return_line_plans_original(uuid) is
  'RX-1: true when the return line''s live plan (highest-seq disposition_planned) restocks to the original rack or one proven source. SECURITY INVOKER, no API EXECUTE.';
comment on function ledger.return_line_restock_legs(uuid) is
  'RX-1: the live original-rack plan re-derived now: single_source gives one leg (the whole line), full_remainder one leg per location (what is still out there), source one leg at the chosen proven location; anything else raises P0001 restock_plan_stale. Rows carry the remaining quantity and validity for the caller to enforce. SECURITY INVOKER, no API EXECUTE.';
comment on function ledger.return_restock_original(uuid, uuid, uuid, numeric, uuid) is
  'RX-1: the rack leg of ledger.process_return_disposition. Locks the planned locations FOR SHARE in id order, then their warehouses FOR SHARE in id order (a deactivation is serialised with the close), re-derives the legs under those locks, refuses an invalid or over-remaining leg (P0001 restock_location_unavailable, detail {rule, locationId}) and a leg on a location a signed-in caller below manager may not write (42501 restock_location_forbidden, detail {rule location_write, locationId}: apply_holding_delta''s own gate, answered with a hint), then per leg: on hand +q, ledger.apply_holding_delta(item, location, +q), one return movement with to_location_id and the RMA reference. The legs must sum to the line (P0001 restock_plan_mismatch). SECURITY INVOKER, no API EXECUTE; runs inside the wrapper''s ledger transaction.';
comment on function public._return_exchange_create(uuid, uuid, jsonb, jsonb) is
  'RX-1 hook stub: refuses any line carrying an exchange (P0001 exchange_not_available). RX-2 replaces the body (exchange lines). SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_approve(uuid, jsonb, uuid, integer) is
  'RX-1 hook stub: refuses an approval carrying exchange decisions (P0001 exchange_not_available) and returns null. RX-2 replaces the body (the replacement order). SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_on_deny(uuid, uuid) is
  'RX-1 hook stub: no-op. RX-2 declines the exchange lines. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_exchange_on_cancel(uuid, uuid, text) is
  'RX-1 hook stub: no-op. RX-2 locks, classifies and cancels a live replacement. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_normalize_request(jsonb, text) is
  'RX-1: the create request checked (22023 return_invalid, detail the field) and in canonical form, lines sorted by source line. Requester tier forces restock and caps the total at 10,000. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_create_core(uuid, uuid, jsonb, text, uuid, text, text, text, text, uuid, jsonb) is
  'RX-1: one create for every path: order completed or delivered (P0001 order_not_returnable), lines on the order (22023 return_invalid) and within the durable budget less pending demand (P0001 return_exceeds_fulfilled; the cap trigger stays authoritative), the header with a unique RMA number (five tries, then P0001 return_number_unavailable), lines in item order, the exchange hook and the created decision. SECURITY INVOKER, no API EXECUTE.';
comment on function public._return_plan_lines(uuid, uuid, jsonb, uuid, text, boolean, boolean) is
  'RX-1: validates and appends disposition plans for approval, the planner and the close. Restock targets are checked against the resolver now (P0001 restock_location_not_offered, one answer whatever the cause); scrap carries no destination; with p_require_all every unapplied line needs a decision (P0001 return_decision_incomplete). SECURITY INVOKER, no API EXECUTE.';
comment on function public.create_return_request(uuid, jsonb, uuid) is
  'RX-1: the staff create, header and lines and the created decision in one transaction. Gates: signed in (42501 unauthenticated); order in a member organization (P0002 order_not_found); returns module (P0001 module_disabled); returns:manage (42501 returns_manage); write access to the order''s warehouse (42501 warehouse_write); key required (22023 idempotency_key_required). Idempotent on (caller, key): the same request replays the RMA (only an RMA of this organization and this order), another gets P0001 idempotency_conflict. Exchange input: P0001 exchange_not_available until RX-2. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.create_requester_return_request(uuid, jsonb, uuid, jsonb) is
  'RX-1: the requester create (token, B2B portal, member) after the SERVER resolved the order and the actor; disposition always restock, requester name and email from the order, channel recorded on the created decision. Idempotent on (actor or anon, key). Never raises a retryable class (0367). SECURITY DEFINER, EXECUTE to service_role only.';
comment on function public.approve_return(uuid, integer, jsonb, boolean) is
  'RX-1: requested to approved with every line''s disposition and destination (restock to Staging, the original rack or one proven source, or scrap), validated against the resolver now; optionally received in the same transaction (p_receive_now, channel counter). Moves no stock. Gates as create, plus orders module and orders:approve (42501 orders_approve) for an exchange approved or added. Idempotent on (RMA, expected revision): a replay answers the stored result, another decision P0001 return_changed; a key row with no approved decision at the next revision was not written by this function and is taken over, never trusted; a stale revision P0001 return_changed; another status P0001 invalid_status_transition. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.deny_return(uuid, text) is
  'RX-1: requested to denied with a reason of 1 to 1,000 characters (P0001 reason_required). Already denied answers changed false. Gates as approve. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.receive_return(uuid) is
  'RX-1: approved to received. Already received or closed answers changed false with who and when. Moves no stock. Gates as approve. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.cancel_return(uuid, integer, text) is
  'RX-1: requested or approved to cancelled, reason optional (1 to 1,000 characters); an expected revision that is stale gives P0001 return_changed. Already cancelled answers changed false. Gates as approve. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.plan_return_dispositions(uuid, jsonb) is
  'RX-1: while approved or received, appends a disposition plan for each changed unapplied line (an identical plan appends nothing) and keeps return_lines.disposition equal. Gates as approve. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.close_return(uuid, jsonb, bigint) is
  'RX-1: received to closed in one transaction: optional changed plans (C-9), then the frozen wrapper public.process_return_disposition (Staging, original rack or scrap per line, revalidated under lock), then the closed decision. Already closed answers changed false with who and when; a plan changed since the screen loaded gives P0001 return_plan_changed; a failed revalidation raises and nothing moves; the restated body''s bare refusals are raised again with their hint (returns_manage for its forbidden). Gates as approve. Never raises a retryable class (0367). SECURITY DEFINER, lock_timeout 5s, EXECUTE to authenticated only.';
comment on function public.return_restock_options(uuid) is
  'RX-1: the destination read for the workbench: per line the case, sources, validity now, offers and live plan, in one call. Gates: signed in, member (P0002 return_not_found), returns:read or returns:manage (42501 returns_read), read access to the order''s warehouse (42501 warehouse_read). STABLE, SECURITY DEFINER, EXECUTE to authenticated only; never called from a requester route.';
comment on function public.tg_returns_api_guard() is
  'RX-1 guard (BEFORE INSERT OR UPDATE on returns, API roles only): an insert only at requested, source internal, with no stamps, requested_by the caller, for an order of the RMA''s own organization the caller can see (P0002 order_not_found) in a warehouse the caller may write (42501 warehouse_write); a status edge only with its own stamps, naming the caller, at now(); never into closed (42501 return_close_through_rpc); otherwise 42501 return_insert_through_rpc or return_stamp_forged. The update policy already limits an edge to returns:manage and write access to the order''s warehouse. RX-2 adds the exchange clause. SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_return_lines_api_guard() is
  'RX-1 guard (BEFORE INSERT on return_lines, API roles only): never applied, and only on a requested RMA of the same organization the caller can see (42501 return_line_insert_through_rpc), for a source line of that RMA''s own order (22023 return_invalid, detail orderRequestLineId), by a caller who may write the order''s warehouse (42501 warehouse_write). SECURITY INVOKER, no EXECUTE.';
comment on function public.tg_return_decisions_append_only() is
  'RX-1: return_decisions rows never change, for any role (42501 return_decisions_append_only). SECURITY INVOKER, no EXECUTE.';

-- ═══ 2. The lock prelude (see LOCKS above) ════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level LOCK
-- TABLE refuses there, as 0373 found); the locks last until the batch commits.
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
      lock table only public.returns, public.return_lines, public.notification_preferences
        in access exclusive mode nowait;
      lock table only public.organizations, public.inventory_items, public.order_requests
        in share row exclusive mode nowait;
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

-- ═══ 3. Keys (plan 3.1.1) ══════════════════════════════════════════════════
-- The RMA number key builds only over distinct numbers (6 of 6 in production
-- on 2026-10-04). Checked here, after the prelude, so the preflight above
-- reads catalogs only and the file holds no table lock before the prelude.
do $numbers$
begin
  if exists (select 1 from public.returns where return_number is not null
              group by organization_id, return_number having count(*) > 1) then
    raise exception 'rx1_preflight: duplicate RMA numbers exist in one organization'
      using errcode = '55000', hint = 'rx1_preflight';
  end if;
end
$numbers$;
create unique index returns_id_org_key on public.returns (id, organization_id);
create unique index return_lines_id_return_key on public.return_lines (id, return_id);
create unique index returns_org_number_uniq on public.returns (organization_id, return_number)
  where return_number is not null;

-- ═══ 4. The decision log (plan 3.1.2) ══════════════════════════════════════
create table public.return_decisions (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity unique,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  return_id        uuid not null,
  return_line_id   uuid,
  kind             text not null check (kind in (
                     'created', 'approved', 'denied', 'received', 'cancelled', 'closed',
                     'disposition_planned',
                     'exchange_requested', 'exchange_approved', 'exchange_declined',
                     'replacement_issued', 'replacement_changed', 'replacement_cancelled',
                     'released_early')),
  channel          text not null check (channel in ('staff', 'counter', 'token', 'portal', 'member', 'system')),
  revision         integer check (revision is null or revision >= 1),
  disposition      text check (disposition in ('restock', 'scrap')),
  restock_target   text check (restock_target in ('staging', 'original', 'source')),
  location_id      uuid,
  basis            text check (basis in ('single_source', 'full_remainder', 'manager_choice')),
  item_id          uuid references public.inventory_items(id),
  previous_item_id uuid references public.inventory_items(id),
  quantity         numeric(14,4) check (quantity is null or quantity > 0),
  order_request_id uuid references public.order_requests(id),
  reason           text check (reason is null or length(btrim(reason)) between 1 and 1000),
  actor_user_id    uuid,
  actor_kind       text not null check (actor_kind in ('staff', 'requester', 'portal_customer', 'system')),
  created_at       timestamptz not null default now(),
  constraint return_decisions_return_fkey foreign key (return_id, organization_id)
    references public.returns (id, organization_id) on delete cascade,
  constraint return_decisions_line_fkey foreign key (return_line_id, return_id)
    references public.return_lines (id, return_id) on delete cascade,
  -- Plan columns only on a plan; a plan names its line and disposition, a
  -- target exactly for a restock, a location exactly for a proven source, and
  -- the basis that matches its target.
  constraint return_decisions_plan_shape_chk check (
    case when kind = 'disposition_planned' then
           return_line_id is not null and disposition is not null
           and (disposition = 'restock') = (restock_target is not null)
           and (coalesce(restock_target, '') = 'source') = (location_id is not null)
           and (coalesce(restock_target, '') in ('original', 'source')) = (basis is not null)
           and (basis is null
                or (restock_target = 'original' and basis in ('single_source', 'full_remainder'))
                or (restock_target = 'source' and basis = 'manager_choice'))
         else disposition is null and restock_target is null and location_id is null and basis is null
    end),
  -- The head kinds carry the revision they made; the reasoned kinds a reason.
  constraint return_decisions_kind_shape_chk check (
    (kind not in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled') or revision is not null)
    and (kind not in ('denied', 'released_early', 'replacement_changed', 'replacement_cancelled') or reason is not null)
    and (kind <> 'released_early' or order_request_id is not null))
);
create index return_decisions_return_idx on public.return_decisions (return_id, seq);
create index return_decisions_line_plan_idx on public.return_decisions (return_line_id, seq desc)
  where kind = 'disposition_planned';
create index return_decisions_release_idx on public.return_decisions (order_request_id)
  where kind = 'released_early';
create unique index return_decisions_revision_uniq on public.return_decisions (return_id, revision)
  where kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled');

create trigger trg_return_decisions_append_only
  before update on public.return_decisions
  for each row execute function public.tg_return_decisions_append_only();

alter table public.return_decisions enable row level security;
create policy return_decisions_select on public.return_decisions
  for select to authenticated
  using ((select public.has_permission(organization_id, 'returns:read'))
         or (select public.has_permission(organization_id, 'returns:manage')));
revoke all on public.return_decisions from public, anon, authenticated;
grant select on public.return_decisions to authenticated;
grant all on public.return_decisions to service_role;

comment on table public.return_decisions is
  'RX-1: the append-only RMA decision log (created, approved, denied, received, cancelled, closed, disposition_planned; RX-2 adds the exchange kinds). A line''s live plan is its highest-seq disposition_planned row; the RMA''s revision is the highest revision over approved, replacement_changed, replacement_cancelled and cancelled. Written only by the RMA functions; no row is ever updated (trigger) and authenticated holds SELECT only. Read with returns:read or returns:manage: reasons and racks are staff information. location_id has no foreign key (draws carry none); actor_user_id has none (account deletion never fails).';

-- ═══ 5. The staff push preference (plan 3.1.5) ═════════════════════════════
alter table public.notification_preferences
  add column push_return_requested boolean not null default true;
comment on column public.notification_preferences.push_return_requested is
  'RX-1: push and in-app for a new return or exchange request from a requester, to people who manage returns for the order''s warehouse. Default on; read fail-open.';

-- ═══ 6. The list read (plan 3.1.6) ═════════════════════════════════════════
-- security_invoker: the caller's RLS applies. Every member reads returns,
-- return_lines and order_requests, so every member gets the same answer; the
-- service gates the list on returns:read or returns:manage. RX-2 appends
-- columns after waiting_days and never reorders these (pgTAP pins the order).
create view public.return_overview with (security_invoker = true) as
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
            then floor(extract(epoch from (now() - r.approved_at)) / 86400)::integer end as waiting_days
  from public.returns r
  left join public.order_requests o on o.id = r.order_request_id;
revoke all on public.return_overview from public, anon, authenticated;
grant select on public.return_overview to authenticated, service_role;
comment on view public.return_overview is
  'RX-1: one row per RMA for the returns list (security_invoker: the caller''s RLS applies). Lines carry ids, quantities and dispositions only; item names, costs and locations come from the batched item read. waiting_days counts days since approval while approved. RX-2 appends exchange columns after waiting_days.';

-- ═══ 7. The write posture (plan 3.8, expand) ═══════════════════════════════
-- returns:manage is fully grantable (G1), so the warehouse bounds it: a raw
-- write needs write access to the warehouse of the RMA's order, read in the
-- RMA's own organization (an order of another organization gives no
-- warehouse, so no access). The same rule every RMA function applies (D27).
alter policy returns_insert on public.returns
  with check ((select public.has_permission(organization_id, 'returns:manage'))
              and public.user_can_access_inventory(
                    (select auth.uid()),
                    (select o.warehouse_id from public.order_requests o
                      where o.id = returns.order_request_id and o.organization_id = returns.organization_id),
                    null, 'write'));
alter policy returns_update on public.returns
  using ((select public.has_permission(organization_id, 'returns:manage'))
         and public.user_can_access_inventory(
               (select auth.uid()),
               (select o.warehouse_id from public.order_requests o
                 where o.id = returns.order_request_id and o.organization_id = returns.organization_id),
               null, 'write'))
  with check ((select public.has_permission(organization_id, 'returns:manage'))
              and public.user_can_access_inventory(
                    (select auth.uid()),
                    (select o.warehouse_id from public.order_requests o
                      where o.id = returns.order_request_id and o.organization_id = returns.organization_id),
                    null, 'write'));
alter policy return_lines_insert on public.return_lines
  with check ((select public.has_permission(organization_id, 'returns:manage'))
              and public.user_can_access_inventory(
                    (select auth.uid()),
                    (select o.warehouse_id from public.returns r
                       join public.order_requests o on o.id = r.order_request_id and o.organization_id = r.organization_id
                      where r.id = return_lines.return_id and r.organization_id = return_lines.organization_id),
                    null, 'write'));
alter policy return_lines_update on public.return_lines
  using ((select public.has_permission(organization_id, 'returns:manage'))
         and public.user_can_access_inventory(
               (select auth.uid()),
               (select o.warehouse_id from public.returns r
                  join public.order_requests o on o.id = r.order_request_id and o.organization_id = r.organization_id
                 where r.id = return_lines.return_id and r.organization_id = return_lines.organization_id),
               null, 'write'))
  with check ((select public.has_permission(organization_id, 'returns:manage'))
              and public.user_can_access_inventory(
                    (select auth.uid()),
                    (select o.warehouse_id from public.returns r
                       join public.order_requests o on o.id = r.order_request_id and o.organization_id = r.organization_id
                      where r.id = return_lines.return_id and r.organization_id = return_lines.organization_id),
                    null, 'write'));

revoke all on public.returns, public.return_lines from public, anon;
revoke delete, truncate, trigger, references, maintain on public.returns, public.return_lines from authenticated;
revoke update on public.return_lines from authenticated;
revoke update on public.returns from authenticated;
grant update (status, approved_by, approved_at, received_by, received_at, denied_by, denied_at, denial_reason)
  on public.returns to authenticated;

create trigger trg_returns_zz_api_guard
  before insert or update on public.returns
  for each row execute function public.tg_returns_api_guard();
create trigger trg_return_lines_zz_api_guard
  before insert on public.return_lines
  for each row execute function public.tg_return_lines_api_guard();

reset lock_timeout;
