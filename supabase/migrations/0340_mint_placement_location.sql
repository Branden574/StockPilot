-- 0340_mint_placement_location.sql
-- A put-away may mint the rack or crate it is placing INTO, under
-- stock:transfer — a SECURITY DEFINER resolve-or-create scoped to the
-- placement path, with the org and the permission re-checked inside.
--
-- ═══ WHY (owner decision D1, 2026-08-17) ═══
--
-- The book put-away's default destination is now the crate the book's own
-- label already names ("Yellow #6 on rack 38-B"). For 113 of L4L's 124 books
-- that crate exists ONLY as the label — there is no `locations` row — so the
-- put-away must resolve-or-create the row by name (migration 0270's dedupe key)
-- before it can move stock into it. That create ran through
-- LocationsService.create, which asserts `locations:manage`, and the Staff
-- preset holds `stock:transfer` only. Staff therefore saw "needs the Manage
-- locations permission" on every label-only crated book and could only place
-- onto the bare rack — the crate-erasing path (Maus I).
--
-- The owner ruled: putting stock into a crate that the book's own label names
-- (or that the operator names in the four fields) is a STOCK operation, not
-- location administration. It may proceed under `stock:transfer`, and ONLY
-- from the placement path. Ordinary location creation everywhere else keeps
-- `locations:manage`.
--
-- ═══ WHY A SECURITY DEFINER FUNCTION AND NOT A POLICY ═══
--
-- `locations_insert` (0212) is `manager-or-above OR locations:manage, AND
-- warehouse_in_org`. Staff fail it, so the app-layer scoping alone cannot land
-- the row: RLS refuses the insert. Two ways to open it:
--
--   1. Widen the POLICY: `... OR (has_permission(org,'stock:transfer') AND kind
--      IN ('rack','crate'))`. That grants every staff member a DIRECT PostgREST
--      insert of any rack/crate row, from any client, with no placement in
--      sight — wider than the decision, and it makes "staff CANNOT insert a
--      location directly" false for two of the kinds. It would also re-state
--      the whole WITH CHECK (recurring #24: `alter policy ... with check`
--      REPLACES), a second copy of a gate to keep in step.
--
--   2. THIS: a SECURITY DEFINER function the placement path calls after its
--      own gate has run. Runs as the table owner so RLS does not apply to its
--      insert, which is exactly why it re-checks INSIDE, on its own arguments:
--      the caller must be an accepted, non-disabled member of p_org holding
--      stock:transfer (or the manager / locations:manage grant the policy
--      already honours); the kind must be rack or crate; the warehouse must be
--      p_org's; a parent, if given, must be p_org's. Nothing else can reach
--      the insert. A staff member calling it directly gets a rack or crate in
--      their own org's warehouse — the same row a put-away would mint — and
--      nothing else. Direct table inserts stay refused by the unchanged policy.
--
-- ═══ WHAT IT DOES ═══
--
-- Resolve-or-create on 0270's key `(organization_id, warehouse_id,
-- lower(name), kind)`: return the live row if one already carries the name,
-- else insert and return the new one. The insert is wrapped so a concurrent
-- winner's row is REUSED rather than surfacing 23505 (the race
-- InventoryService.findOrCreateRackLocation retries around in TypeScript).
--
-- The NAME is composed by the caller (LocationsService, through
-- crateAwareLocationName / planNewLocation) — this function stores what it is
-- handed and dedupes on it, exactly as the direct insert does. It applies no
-- plan limit: racks and crates never consumed the site limit
-- (LocationsService.create's isSiteLocation branch), and this function refuses
-- every other kind.
--
-- POSTURE: SECURITY DEFINER, search_path pinned, EXECUTE revoked from public
-- and anon, granted to authenticated and service_role (0318 shape).
-- `returns setof ... rows 1` so PostgREST always answers with a JSON array,
-- never an ambiguous bare object.

create or replace function public.mint_placement_location(
  p_org          uuid,
  p_warehouse_id uuid,
  p_kind         text,
  p_name         text,
  p_type         text,
  p_parent_id    uuid,
  p_notes        text,
  p_rack_number  text,
  p_rack_row     text,
  p_crate_color  text,
  p_crate_number text
)
returns setof public.locations
language plpgsql
security definer
set search_path = public
rows 1
as $$
declare
  v_row public.locations;
begin
  -- ── Shape: this function mints RACKS and CRATES inside a warehouse, only ──
  if p_org is null then
    raise exception 'mint_placement_location: organization is required'
      using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('rack', 'crate') then
    raise exception 'mint_placement_location: kind must be rack or crate'
      using errcode = '22023';
  end if;
  if p_warehouse_id is null then
    raise exception 'mint_placement_location: a rack or crate needs a warehouse'
      using errcode = '22023';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'mint_placement_location: name is required'
      using errcode = '22023';
  end if;

  -- ── THE GATE, re-checked here on the function's own arguments ──
  -- has_org_role / has_permission resolve auth.uid()'s ACCEPTED, NON-DISABLED
  -- membership of p_org (0310), so a caller who is not a member of p_org, or
  -- is disabled, or holds none of the three grants, is refused regardless of
  -- what the application layer believed. 42501 = insufficient_privilege.
  if not (
       public.has_org_role(p_org, 'manager')
    or public.has_permission(p_org, 'locations:manage')
    or public.has_permission(p_org, 'stock:transfer')
  ) then
    raise exception 'insufficient_privilege'
      using errcode = '42501',
            hint = 'Placing stock into a new rack or crate needs the Transfer stock permission.';
  end if;

  -- ── Tenant isolation, exactly the checks the insert policy makes ──
  if not public.warehouse_in_org(p_warehouse_id, p_org) then
    raise exception 'insufficient_privilege'
      using errcode = '42501',
            hint = 'The warehouse does not belong to this organization.';
  end if;
  if p_parent_id is not null and not public.location_in_org(p_parent_id, p_org) then
    raise exception 'insufficient_privilege'
      using errcode = '42501',
            hint = 'The parent location does not belong to this organization.';
  end if;

  -- ── Resolve: the live row 0270's index would collide with ──
  select l.* into v_row
    from public.locations l
   where l.organization_id = p_org
     and l.warehouse_id = p_warehouse_id
     and l.kind = p_kind
     and lower(l.name) = lower(p_name)
     and l.deleted_at is null
   limit 1;
  if found then
    return next v_row;
    return;
  end if;

  -- ── Create; on a concurrent winner, reuse its row ──
  begin
    insert into public.locations
      (organization_id, warehouse_id, name, type, parent_id, notes, kind,
       rack_number, rack_row, crate_color, crate_number)
    values
      (p_org, p_warehouse_id, p_name, p_type, p_parent_id, p_notes, p_kind,
       p_rack_number, p_rack_row, p_crate_color, p_crate_number)
    returning * into v_row;
  exception when unique_violation then
    select l.* into v_row
      from public.locations l
     where l.organization_id = p_org
       and l.warehouse_id = p_warehouse_id
       and l.kind = p_kind
       and lower(l.name) = lower(p_name)
       and l.deleted_at is null
     limit 1;
    if not found then
      raise;
    end if;
  end;
  return next v_row;
  return;
end;
$$;

comment on function public.mint_placement_location(uuid, uuid, text, text, text, uuid, text, text, text, text, text) is
  'Resolve-or-create a rack/crate for a put-away under stock:transfer (or manager / locations:manage). '
  'SECURITY DEFINER; org membership, permission, warehouse and parent are re-checked inside. '
  'Called only from the placement path (LocationsService.findOrCreatePlacementDestination); '
  'ordinary location creation keeps locations:manage and the unchanged locations_insert policy.';

revoke all on function public.mint_placement_location(uuid, uuid, text, text, text, uuid, text, text, text, text, text) from public;
revoke all on function public.mint_placement_location(uuid, uuid, text, text, text, uuid, text, text, text, text, text) from anon;
grant execute on function public.mint_placement_location(uuid, uuid, text, text, text, uuid, text, text, text, text, text) to authenticated, service_role;
