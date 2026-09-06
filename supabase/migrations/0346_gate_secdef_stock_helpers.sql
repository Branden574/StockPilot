-- 0346_gate_secdef_stock_helpers.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Close an authorization hole in three SECURITY DEFINER helpers that any
-- signed-in user could execute directly at POST /rest/v1/rpc/<name>.
--
-- WHAT WAS WRONG (reproduced 2026-09-02 on the 0345 head, in a rolled-back
-- transaction — see supabase/tests/0346_gate_secdef_stock_helpers.test.sql):
--
--   * apply_cycle_count_location_delta(item, location, org, delta) — 0342.
--     Written as the arithmetic core of post_cycle_count, which is SECURITY
--     INVOKER and calls it as the posting user, so `authenticated` had to hold
--     EXECUTE. The body went straight to `insert ... on conflict do update` /
--     `update ... set quantity = quantity - v_take` on item_stock_levels with
--     NO auth.uid() / has_org_role / item_in_org / location_in_org check.
--     A VIEWER in a different org (is_org_member(victim) = false, RLS SELECT of
--     the holding = 0 rows) inflated a victim rack 10 -> 5010 and then drained
--     it to 0, leaving inventory_items.quantity_on_hand at 10 and ZERO
--     stock_movements rows. Cross-org stock corruption with no ledger trail.
--
--   * ensure_org_placement_locations(org) / ensure_warehouse_placement_locations(wh)
--     — 0188/0194. Definer helpers that seed the Staging + Unplaced system
--     buckets so staff-level stock paths need not hold locations INSERT.
--     Callable by any authenticated user for ANY org / warehouse id: an
--     outsider could create rows in a victim org's locations table (and
--     probe which warehouse uuids exist).
--
-- WHY THE GATE LIVES IN THE BODY (same reasoning as 0331 for apply_level_delta
-- and 0341 for publish_outbox): the legitimate callers run these as the user,
-- so EXECUTE cannot be revoked from `authenticated`; the function must
-- authorize itself. auth.uid() IS NULL means a service_role / postgres
-- connection (anon and PUBLIC hold no EXECUTE) and keeps the historical
-- behaviour; every authenticated request carries a sub claim and is checked.
--
-- FLOORS. apply_cycle_count_location_delta: 'manager' — post_cycle_count's own
-- floor (0343:52), its only caller. It ALSO proves the item and the location
-- belong to p_org_id, because a role check on the CALLER-SUPPLIED org alone
-- would still let a manager of org B write a row tagged org B against org A's
-- item and rack. ensure_*: any accepted, active member ('viewer' rank) — the
-- write is two idempotent system buckets, and the callers (0188 warehouse
-- trigger, receiving, reverse-receipt, apply_level_delta after its own staff
-- gate) all run as members. An unknown warehouse id raises for an
-- authenticated caller instead of returning silently, so the helper cannot be
-- used to probe which uuids exist; service callers keep the silent no-op.
--
-- WHAT DOES NOT CHANGE. post_cycle_count already refuses a line whose
-- location is in another org (cycle_count_location_out_of_org, 0343:127)
-- before it reaches the helper, so the new conjuncts cannot newly refuse a
-- legitimate post. The 0188 trigger wraps its call in `exception when others`,
-- so a refused gate can never fail a warehouse insert. _cycle_count_location_
-- facts is deliberately NOT gated: reading past RLS is its documented purpose
-- (0342) — a foreign location must be seen so the post refuses LOUDLY.
--
-- Regression guard for the whole class: supabase/tests/security_invariants
-- .test.sql INV-25/26 now sweep every authenticated-EXECUTE SECURITY DEFINER
-- function in `public` and require an in-body gate or a defended allowlist
-- entry — the same discipline INV-1..3 already applied to anon.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. apply_cycle_count_location_delta: manager of p_org_id + item/location ∈ org ──
create or replace function public.apply_cycle_count_location_delta(
  p_item_id     uuid,
  p_location_id uuid,
  p_org_id      uuid,
  p_delta       numeric
) returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_have numeric;
  v_take numeric;
begin
  -- A zero delta or a null location writes nothing — the caller routes it.
  -- Kept ahead of the gate so this contract (0342 tests) is unchanged.
  if p_delta = 0 or p_delta is null or p_location_id is null then
    return coalesce(p_delta, 0);
  end if;

  -- *** 0346 authorization gate — see header. ***
  if auth.uid() is not null then
    if p_org_id is null or p_item_id is null
       or not public.has_org_role(p_org_id, 'manager') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  -- item_in_org / location_in_org are null-tolerant by design (FK-guard
  -- semantics), which is why p_item_id null is refused above for users.
  if not public.item_in_org(p_item_id, p_org_id)
     or not public.location_in_org(p_location_id, p_org_id) then
    raise exception 'cross_org' using errcode = '42501';
  end if;

  if p_delta > 0 then
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (p_org_id, p_item_id, p_location_id, p_delta)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return 0;
  end if;

  select quantity into v_have
    from public.item_stock_levels
   where item_id = p_item_id and location_id = p_location_id
   for update;
  if not found or coalesce(v_have, 0) <= 0 then
    return p_delta;                       -- nothing here; caller handles it all
  end if;

  v_take := least(v_have, -p_delta);      -- never below zero at this location
  update public.item_stock_levels
     set quantity = quantity - v_take, updated_at = now()
   where item_id = p_item_id and location_id = p_location_id;

  return p_delta + v_take;                -- 0 when fully absorbed
end;
$function$;

revoke all on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) to authenticated, service_role;

-- ── 2. ensure_org_placement_locations: any accepted member of that org ──
create or replace function public.ensure_org_placement_locations(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then return; end if;
  -- *** 0346 authorization gate — see header. ***
  if auth.uid() is not null and not public.has_org_role(p_org, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (p_org, null, 'Staging', 'other', 'staging') on conflict do nothing;
  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (p_org, null, 'Unplaced', 'other', 'unplaced') on conflict do nothing;
end; $$;

revoke all on function public.ensure_org_placement_locations(uuid) from public, anon;
grant execute on function public.ensure_org_placement_locations(uuid) to authenticated, service_role;

-- ── 3. ensure_warehouse_placement_locations: any accepted member of the warehouse's org ──
create or replace function public.ensure_warehouse_placement_locations(p_warehouse_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.warehouses where id = p_warehouse_id;

  -- *** 0346 authorization gate — see header. Runs BEFORE the not-found
  -- return so an authenticated caller cannot tell an unknown warehouse from a
  -- foreign one (both 42501); service callers keep the silent no-op. ***
  if auth.uid() is not null then
    if v_org is null or not public.has_org_role(v_org, 'viewer') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  if v_org is null then return; end if;

  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (v_org, p_warehouse_id, 'Staging', 'other', 'staging')
  on conflict do nothing;

  insert into public.locations (organization_id, warehouse_id, name, type, kind)
  values (v_org, p_warehouse_id, 'Unplaced', 'other', 'unplaced')
  on conflict do nothing;
end;
$$;

revoke all on function public.ensure_warehouse_placement_locations(uuid) from public, anon;
grant execute on function public.ensure_warehouse_placement_locations(uuid) to authenticated, service_role;

comment on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) is
  'Cycle-count reconciliation arithmetic on one (item, location) holding. Self-authorizing (0346): user callers must be a manager of p_org_id and both ids must belong to it; service callers (auth.uid() null) pass.';
