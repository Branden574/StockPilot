-- 0371_holdings_staff_scope.sql
-- ============================================================================
-- Staff see holdings (item_stock_levels) only in their own warehouses, plus
-- holdings at locations with no warehouse, exactly as 0331 already scoped
-- viewers. DB-only; no data changes.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
-- item_stock_levels_write (0202) is FOR ALL TO authenticated with
-- USING (has_org_role(org, 'staff')). A FOR ALL policy also applies to SELECT,
-- and permissive policies OR together, so every staff+ member read the
-- holdings of EVERY warehouse in the org, while item_stock_levels_select
-- (0331) is warehouse-scoped. 0331 kept this on purpose (its header, and its
-- test 9 pinned it): ledger.adjust_stock and ledger.transfer_stock are
-- SECURITY INVOKER, and their conditional UPDATEs and ON CONFLICT upserts
-- read the row, so Postgres also requires it to pass a SELECT policy.
-- Narrowing SELECT for staff would have made a draw outside the caller's
-- SELECT scope match 0 rows (a wrong P0001 'insufficient_stock') or an
-- upsert raise a raw 42501 'new row violates row-level security policy'.
--
-- ── WHY 0331'S REASON NO LONGER HOLDS ───────────────────────────────────────
-- 0365 added caller_can_write_location to both INVOKER bodies: below
-- manager, every location adjust_stock or transfer_stock can touch is in a
-- warehouse the caller may write, or has no warehouse. That is inside the
-- 0331 SELECT scope (a rolled-back probe found 0 writable-but-hidden
-- locations for every staff persona). A policy split alone would therefore
-- pass today. It is not enough on its own: correctness would rest on two
-- separate helper chains agreeing (caller_can_write_location via
-- user_can_access_warehouse, and the SELECT predicate via my_warehouse_ids).
-- They already differ on one edge (my_warehouse_ids requires
-- user_warehouse_assignments.organization_id to equal the member's org;
-- user_can_access_warehouse does not), and any future divergence would
-- surface only as the WRONG error. So, as AR-2 prescribes: first make every
-- holdings statement independent of what the caller can SELECT, then narrow.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
--   1. ledger.apply_holding_delta(item, location, delta): SECURITY DEFINER,
--      in the unexposed ledger schema, gated in its body. It runs the only
--      two holdings statements that still executed as the caller: the
--      explicit-location upsert (delta >= 0) and the conditional draw
--      (delta < 0; a miss raises P0001 'insufficient_stock').
--   2. ledger.adjust_stock and ledger.transfer_stock stay SECURITY INVOKER and
--      are restated from their live text. The only changes: their holdings
--      statements become calls to (1), and transfer_stock's dead source seed
--      (INSERT ... ON CONFLICT DO NOTHING of a 0 row) is dropped. The item
--      lock (SELECT inventory_items ... FOR UPDATE under the caller's RLS),
--      every gate, the on-hand UPDATE and the stock_movements INSERT still run
--      as the caller, exactly as before.
--   3. item_stock_levels_write (FOR ALL) is replaced by item_stock_levels_insert
--      (FOR INSERT) and item_stock_levels_update (FOR UPDATE), both with
--      0202's predicates verbatim. Neither grants SELECT. No DELETE policy:
--      0364 revoked the DELETE grant. item_stock_levels_select (0331) is not
--      touched, so 0322's verbatim pin and the 0370 mirror predicates hold.
--   4. Two gated SECURITY DEFINER read helpers, so no screen presents a
--      narrowed view as complete:
--        * item_holdings_elsewhere(item ids): per item the caller can read,
--          the Staging / Unplaced / placed totals OUTSIDE the caller's SELECT
--          scope, and the ids of the placed locations holding them. Never a
--          per-location quantity. Managers and above get no rows.
--        * location_stock_census(location): the holding count and total
--          quantity at one location across the whole org, including items the
--          caller cannot read. Manager, or locations:manage (the
--          locations_update floor).
--   5. The table comment is replaced.
--
-- ── WHY A HELPER, NOT SECURITY DEFINER LEDGER BODIES ────────────────────────
-- The bodies' first statement, SELECT inventory_items ... FOR UPDATE under the
-- caller's RLS, IS the per-item authorization: warehouse, charter and
-- category read scope plus the inventory_items_update policy (staff, and
-- manager or warehouse write). It is why another warehouse's item answers
-- P0002 'item_not_found'. DEFINER bodies would have to re-implement both
-- inventory_items policies by hand (any drift silently widens writes), the
-- on-hand UPDATE would escape the 0359 inventory_items guard (keyed on
-- current_user), and the stock_movements INSERT would escape its RLS WITH
-- CHECK. The helper confines privilege to the two statements that need it,
-- the 0331 precedent (apply_level_delta, _cycle_count_org_stock_sum).
--
-- ── S1 LEDGER, 0367, INV-25 ─────────────────────────────────────────────────
-- * tg_ledger_only_guard fires only when current_user is authenticated or
--   anon. A write inside a DEFINER body runs as the owner, so the helper
--   enforces ledger.active() itself for user callers, as 0359 did for
--   apply_level_delta. The public wrappers stay the only flag carriers (the
--   0359 census of exactly eight holds); the helper has no dynamic SQL.
-- * Direct writes still hit the guard (42501 ledger_only). A direct PATCH of
--   a holding a staff member cannot see now matches 0 rows instead.
-- * The helper lives in ledger, which PostgREST does not expose (public and
--   graphql_public only), and is still fully gated in its body (the 0346
--   lesson: a DEFINER writer needs its own gate).
-- * All three new functions raise only 22023, 42501, P0001 and P0002. Never
--   40001/40P01 (0367).
-- * Lock order is unchanged: the item row FOR UPDATE, then the source
--   holding, then the destination.
-- * The two public read helpers carry auth.uid() and has_org_role /
--   has_permission in their bodies (INV-25). INV-31 extends that sweep to the
--   ledger schema; INV-33 asserts that no API-executable SECURITY INVOKER
--   function in public or ledger references item_stock_levels any more;
--   INV-35 asserts that no permissive FOR ALL policy sits on a table whose
--   SELECT is warehouse-scoped (allowlist: warehouses, purchase_orders).
--
-- ── ERROR CODES (unchanged for every app path) ──────────────────────────────
--   adjust_stock / transfer_stock, as before:
--     P0002 item_not_found        item hidden by inventory_items RLS
--     P0002 item_deleted          (transfer) item soft-deleted
--     42501 forbidden             below staff, or (0365) a location the caller
--                                 cannot write, below manager
--     42501 location_org_mismatch location in another org
--     P0001 insufficient_stock    on-hand total, or the per-location draw
--                                 (including a transfer source with no row)
--     22023 quantity_must_be_positive / same_location (transfer)
--   One degenerate input changes: a caller that passes a NULL transfer source
--   or destination and passes the gates (a manager, or the service path) used
--   to hit a raw 23502 not_null_violation on item_stock_levels.location_id; it
--   now gets 22023 'location_required' from the helper. No app path passes a
--   null (the service and the /api/v1 route require both ids). Staff still get
--   42501 'forbidden' there, from the 0365 gate.
--   ledger.apply_holding_delta (reached only from the two bodies):
--     22023 location_required, 42501 ledger_only / forbidden /
--     location_org_mismatch, P0002 item_not_found, P0001 insufficient_stock.
--   item_holdings_elsewhere: 22023 too_many_items (more than 500 ids).
--   location_stock_census: 42501 forbidden.
--
-- ── FROZEN, NOT TOUCHED ─────────────────────────────────────────────────────
-- start_cycle_count, ledger.post_cycle_count, tg_cycle_count_line_rebase_
-- expected, apply_level_delta and apply_cycle_count_location_delta are not
-- modified. post_cycle_count never calls adjust_stock or transfer_stock.
-- Consequence, deliberately kept (owner decision Q1, a follow-up): a
-- null-location draw (phone quick -1, manual removal 'any', complete_picking)
-- still draws through apply_level_delta from ANY warehouse.
--
-- ── PRODUCTION FACTS (2026-09-25) ───────────────────────────────────────────
-- No staff-role member in any org, so shipping this narrows nobody's view in
-- production today. L4L has 10 viewers, all warehouse-assigned (already
-- narrowed by 0331; unchanged). Managers and above are unchanged. Before the
-- push, the prod preflight confirms the adjust_stock / transfer_stock bodies
-- are md5-identical to the pre-0371 local text, and that no
-- user_warehouse_assignments row has an organization_id different from its
-- warehouse's org.
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) ledger.apply_holding_delta: the two holdings statements, privileged.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE GATE (user callers, auth.uid() not null), in this order:
--   * ledger.active(), else 42501 'ledger_only' (the 0359 rule for
--     apply_level_delta: only from inside a ledger RPC);
--   * a staff+ member of the org that OWNS the item (v_org is read off the
--     item row, never taken from the caller), else 42501 'forbidden';
--   * the location belongs to that org, else 42501 'location_org_mismatch';
--   * manager+, or caller_can_write_location(location), else 42501
--     'forbidden' (the 0365 rule).
-- These duplicate the checks both bodies make before calling, so no
-- legitimate path changes; they exist so DEFINER status grants nothing on its
-- own. A null subject is the service path, as in apply_level_delta: anon and
-- PUBLIC hold no EXECUTE, and every authenticated request carries a sub.
-- The location-in-org check runs for the service path too: it is an
-- integrity rule (the 0202 WITH CHECK no longer applies to a DEFINER write),
-- and both bodies already assert it for every caller.
create function ledger.apply_holding_delta(
  p_item_id     uuid,
  p_location_id uuid,
  p_delta       numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_location_id is null or p_delta is null then
    raise exception 'location_required' using errcode = '22023';
  end if;

  -- No lock here: every caller already holds the item row FOR UPDATE.
  select organization_id into v_org
    from public.inventory_items
   where id = p_item_id;

  if auth.uid() is not null then
    if not ledger.active() then
      raise exception 'ledger_only' using errcode = '42501';
    end if;
    if v_org is null or not public.has_org_role(v_org, 'staff') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_org is null then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if not public.location_in_org(p_location_id, v_org) then
    raise exception 'location_org_mismatch' using errcode = '42501';
  end if;

  if auth.uid() is not null
     and not public.has_org_role(v_org, 'manager')
     and not public.caller_can_write_location(p_location_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_delta >= 0 then
    -- The 0365 explicit-location upsert (e.g. receiving into Staging).
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_org, p_item_id, p_location_id, p_delta)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  else
    -- The 0327 conditional draw. The guard is IN the predicate, so the row
    -- lock re-evaluates it and two concurrent draws cannot both pass against
    -- the same stock; nothing negative is ever written. A miss (row absent OR
    -- short) raises the same error as the callers' total guard.
    update public.item_stock_levels
      set quantity = quantity + p_delta,
          updated_at = now()
    where item_id = p_item_id
      and location_id = p_location_id
      and quantity + p_delta >= 0;
    if not found then
      raise exception 'insufficient_stock' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

revoke all on function ledger.apply_holding_delta(uuid, uuid, numeric) from public, anon;
-- authenticated keeps EXECUTE: the INVOKER ledger bodies call it as the user.
grant execute on function ledger.apply_holding_delta(uuid, uuid, numeric)
  to authenticated, service_role;

comment on function ledger.apply_holding_delta(uuid, uuid, numeric) is
  '0371: the explicit-location holdings write for ledger.adjust_stock and ledger.transfer_stock. delta >= 0 upserts; delta < 0 is the conditional draw (a miss raises P0001 insufficient_stock). SECURITY DEFINER so the write does not depend on which holdings the caller can SELECT. Gated in its body for user callers: ledger.active() (42501 ledger_only), staff+ of the item''s org (42501 forbidden), location in that org (42501 location_org_mismatch, all callers), manager+ or caller_can_write_location (42501 forbidden). Null location or delta: 22023 location_required. Missing item: P0002 item_not_found. Not RPC-reachable (ledger schema is not exposed).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) ledger.adjust_stock, restated from its live text (0365). SECURITY INVOKER.
--    Only the explicit-location branch changes: the 0365 upsert and the 0327
--    conditional draw become one call to ledger.apply_holding_delta. The
--    null-location branch still calls public.apply_level_delta (frozen).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ledger.adjust_stock(p_item_id uuid, p_quantity_change numeric, p_movement_type text, p_location_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_mode text DEFAULT 'placed'::text)
 RETURNS public.inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item public.inventory_items%rowtype;
  v_prev numeric;
  v_new  numeric;
  v_user uuid := auth.uid();
begin
  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify the caller-supplied location_id belongs to the item's org ***
  perform public.assert_location_in_org(p_location_id, v_item.organization_id);

  -- 0365: an explicit location must be one the caller may write, below
  -- manager. Without it, "-3 here, +3 at a rack in another warehouse" did
  -- what transfer_stock now refuses.
  if p_location_id is not null
     and not public.has_org_role(v_item.organization_id, 'manager')
     and not public.caller_can_write_location(p_location_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + p_quantity_change;
  if v_new < 0 then raise exception 'insufficient_stock' using errcode = 'P0001'; end if;

  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
  where id = p_item_id
  returning * into v_item;

  -- Per-location maintenance:
  if p_location_id is not null then
    -- *** 0371: the explicit-location write runs in ledger.apply_holding_delta
    -- (SECURITY DEFINER), so it no longer depends on which holdings the caller
    -- can SELECT. It is the same two statements: for a delta >= 0 the upsert
    -- (e.g. receiving into Staging); for a delta < 0 the 0327 conditional
    -- draw, whose miss (row absent OR insufficient quantity) raises the SAME
    -- P0001 'insufficient_stock' as the total guard above. ***
    perform ledger.apply_holding_delta(p_item_id, p_location_id, p_quantity_change);
  else
    -- Null location: auto-allocate. + -> Staging, - -> draw-down by p_mode
    -- ('placed' for picks/ships; 'staging_first' for reversals/scrap write-offs).
    perform public.apply_level_delta(p_item_id, p_quantity_change, p_mode);
  end if;

  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, reason, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, p_movement_type,
    p_quantity_change, v_prev, v_new,
    case when p_quantity_change < 0 then p_location_id else null end,
    case when p_quantity_change > 0 then p_location_id else null end,
    p_reason, p_notes, v_user
  );

  return v_item;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) ledger.transfer_stock, restated from its live text (0365). SECURITY
--    INVOKER. The dead source seed is dropped; the draw and the destination
--    upsert become two calls to ledger.apply_holding_delta, in the same order.
--    The public wrappers (0359) are not touched: they remain the flag
--    carriers.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ledger.transfer_stock(p_item_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_notes text DEFAULT NULL::text)
 RETURNS public.inventory_items
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item public.inventory_items%rowtype;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_item.deleted_at is not null then raise exception 'item_deleted' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify both location IDs belong to the item's org ***
  perform public.assert_location_in_org(p_from_location_id, v_item.organization_id);
  perform public.assert_location_in_org(p_to_location_id,   v_item.organization_id);

  -- 0365: below manager, both ends must be in warehouses the caller may write
  -- (the transfer dialog only offers those). A member scoped to warehouse A
  -- could otherwise move stock into or out of warehouse B through the RPC.
  if not public.has_org_role(v_item.organization_id, 'manager')
     and not (public.caller_can_write_location(p_from_location_id)
              and public.caller_can_write_location(p_to_location_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0371: the 0191/0201 source seed (a 0 row, ON CONFLICT DO NOTHING) is
  -- gone. It could only create a row that the draw below then failed on, and
  -- that raise aborts the transaction, so the row never persisted. A source
  -- with no row still raises P0001 'insufficient_stock' from the draw. ***

  -- *** 0327: the guard is IN the draw's predicate. 0231 decremented first and
  -- inspected the RETURNING value second, so the negative existed transiently
  -- and a row CHECK would fire at the UPDATE, turning the intended P0001
  -- 'insufficient_stock' into a raw 23514 check_violation. The conditional
  -- UPDATE never writes a negative: a miss falls through to the same raise
  -- the old post-write check performed. ***
  -- *** 0371: the draw and the destination upsert run in
  -- ledger.apply_holding_delta (SECURITY DEFINER), so neither depends on which
  -- holdings the caller can SELECT. Same order: source, then destination. ***
  perform ledger.apply_holding_delta(p_item_id, p_from_location_id, -p_quantity);

  -- Increment destination.
  perform ledger.apply_holding_delta(p_item_id, p_to_location_id, p_quantity);

  -- Net-zero on quantity_on_hand: only the location changed.
  -- *** 0231: also record the physical qty moved (moved_quantity) so displays
  --     can show "Stock transferred N" — quantity_change stays 0. ***
  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    moved_quantity,
    from_location_id, to_location_id, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, 'transfer',
    0, v_item.quantity_on_hand, v_item.quantity_on_hand,
    p_quantity,
    p_from_location_id, p_to_location_id, p_notes, auth.uid()
  );

  return v_item;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4) The policy split. item_stock_levels_write (FOR ALL) granted SELECT to
--    every staff+ member of the org. It becomes an INSERT policy and an
--    UPDATE policy with 0202's predicates verbatim; neither applies to
--    SELECT. No DELETE policy: 0364 revoked DELETE from authenticated and
--    anon. item_stock_levels_select (0331) is not touched.
-- ═══════════════════════════════════════════════════════════════════════════
drop policy item_stock_levels_write on public.item_stock_levels;

create policy item_stock_levels_insert on public.item_stock_levels
  for insert to authenticated
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (SELECT public.location_in_org(location_id, organization_id))
  );

create policy item_stock_levels_update on public.item_stock_levels
  for update to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (SELECT public.location_in_org(location_id, organization_id))
  );

comment on policy item_stock_levels_insert on public.item_stock_levels is
  '0371 (split from the 0202 FOR ALL policy, predicates verbatim): grants no SELECT. No ledger body writes holdings as the user any more (ledger.apply_holding_delta and the other writers are SECURITY DEFINER), and tg_ledger_only_guard refuses direct writes; kept as defence in depth.';
comment on policy item_stock_levels_update on public.item_stock_levels is
  '0371 (split from the 0202 FOR ALL policy, predicates verbatim): an UPDATE also needs the row to pass item_stock_levels_select, so this grants no read. No ledger body writes holdings as the user any more, and tg_ledger_only_guard refuses direct writes; kept as defence in depth.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5) public.item_holdings_elsewhere: what a scoped member cannot see, as
--    totals.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- For each requested item the caller can read (caller_can_read_item, the
-- inventory_items_select predicate), the positive holdings that fall OUTSIDE
-- the caller's item_stock_levels_select scope, summed into three buckets:
-- Staging, Unplaced, and placed (every other kind, NULL included: 0292,
-- pattern #23), plus the ids of the placed locations holding them. Locations
-- are readable org-wide already, and the item-level rack summary names them.
-- Never a per-location quantity: one row per item.
--
-- The hidden set is the exact complement of 0331's predicate for a member who
-- can read the item: not manager+, the location has a warehouse, and that
-- warehouse is not in my_warehouse_ids(). NOT EXISTS rather than NOT IN, so a
-- null in the set could never hide everything. Visible sum + hidden sum =
-- the item's total for every caller who can read the item.
--
-- Managers and above get no rows (they see everything; the app skips the
-- call). A null subject or a null array gets no rows. More than 500 ids:
-- 22023 'too_many_items'. An item the caller cannot read, or one in another
-- org, gets no row.
create function public.item_holdings_elsewhere(p_item_ids uuid[])
returns table (
  item_id             uuid,
  staged              numeric,
  unplaced            numeric,
  placed              numeric,
  placed_location_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_item_ids is null then
    return;
  end if;
  if cardinality(p_item_ids) > 500 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  return query
  with readable as (
    select i.id, i.organization_id
      from public.inventory_items i
     where i.id = any (p_item_ids)
       and public.caller_can_read_item(i.id)
       and not public.has_org_role(i.organization_id, 'manager')
  ),
  mine as materialized (
    select mw.warehouse_id from public.my_warehouse_ids() mw
  )
  select s.item_id,
         coalesce(sum(s.quantity) filter (where l.kind = 'staging'), 0)::numeric,
         coalesce(sum(s.quantity) filter (where l.kind = 'unplaced'), 0)::numeric,
         coalesce(sum(s.quantity) filter (where l.kind is distinct from 'staging'
                                            and l.kind is distinct from 'unplaced'), 0)::numeric,
         coalesce(array_agg(distinct s.location_id order by s.location_id)
                    filter (where l.kind is distinct from 'staging'
                              and l.kind is distinct from 'unplaced'), '{}'::uuid[])
    from readable r
    join public.item_stock_levels s
      on s.item_id = r.id
     and s.organization_id = r.organization_id
    join public.locations l
      on l.id = s.location_id
   where s.quantity > 0
     and l.warehouse_id is not null
     and not exists (select 1 from mine m where m.warehouse_id = l.warehouse_id)
   group by s.item_id;
end;
$$;

revoke all on function public.item_holdings_elsewhere(uuid[]) from public, anon;
grant execute on function public.item_holdings_elsewhere(uuid[]) to authenticated, service_role;

comment on function public.item_holdings_elsewhere(uuid[]) is
  '0371: per readable item, the Staging / Unplaced / placed totals of positive holdings OUTSIDE the caller''s item_stock_levels_select scope, and the placed location ids holding them. Never a per-location quantity. Managers+ and null subjects get no rows; unreadable or foreign-org items get no row; more than 500 ids raises 22023 too_many_items. Visible sum + hidden sum = the item''s total.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 6) public.location_stock_census: is this location empty, across the org?
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The count and total of positive holdings at one location, across the whole
-- org and including items the caller cannot read. The location archive guard
-- needs the complete answer; a read through the user client is narrowed by
-- warehouse (staff) and by item visibility (the inventory_items!inner embed),
-- which already left a manager blind to warehouse-less items.
--
-- Gate: manager+, or has_permission('locations:manage'), in the location's
-- own org (the locations_update floor), else 42501 'forbidden'. A null
-- subject, an unknown location and a foreign location all get the same
-- 42501 (no existence oracle). Aggregates only.
create function public.location_stock_census(p_location_id uuid)
returns table (holding_rows int, total_quantity numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select l.organization_id into v_org
    from public.locations l
   where l.id = p_location_id;

  if auth.uid() is null
     or v_org is null
     or not (public.has_org_role(v_org, 'manager')
             or public.has_permission(v_org, 'locations:manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select count(*)::int,
         coalesce(sum(s.quantity), 0)::numeric
    from public.item_stock_levels s
   where s.location_id = p_location_id
     and s.organization_id = v_org
     and s.quantity > 0;
end;
$$;

revoke all on function public.location_stock_census(uuid) from public, anon;
grant execute on function public.location_stock_census(uuid) to authenticated, service_role;

comment on function public.location_stock_census(uuid) is
  '0371: holding count and total quantity (positive holdings) at one location across its whole org, including items the caller cannot read. For the location archive guard. Manager+ or locations:manage in the location''s org; anything else (null subject, unknown or foreign location) raises 42501 forbidden.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 7) The table comment (replaces 0331's).
-- ═══════════════════════════════════════════════════════════════════════════
comment on table public.item_stock_levels is
  'Per-location holdings. SELECT (0331, item_stock_levels_select) requires org membership AND either manager+ or the holding''s location sitting in one of the caller''s warehouses (my_warehouse_ids); holdings at locations with no warehouse stay member-visible. Since 0371 that scope applies to EVERY role below manager, staff included: the INSERT and UPDATE policies (split from the 0202 FOR ALL policy) grant no SELECT. Writes happen only through SECURITY DEFINER code: ledger.apply_holding_delta (adjust_stock / transfer_stock), apply_level_delta, apply_cycle_count_location_delta, tg_seed_initial_level and compensate_opening_stock; tg_ledger_only_guard refuses direct API writes and DELETE is revoked (0364). Charter-blind by design. Scoped members read what they cannot see as totals through item_holdings_elsewhere; location_stock_census answers "is this location empty" org-wide.';
