-- 0202_item_stock_levels_location_org_check.sql
-- Close the direct-write counterpart of the 0201 hole: item_stock_levels is
-- writable by `authenticated` via PostgREST, and its RLS WITH CHECK validated
-- only the row's org, never that location_id belongs to that org. A staff user
-- could thus POST a level row in their own org pointing at a foreign-org
-- location (cross-tenant integrity write; cascade-delete drift). This adds a
-- location<->org consistency check to the write policy's WITH CHECK, which also
-- backstops the security-invoker stock RPCs (they run under the caller's RLS).

-- ── 1. Boolean SECURITY DEFINER helper ───────────────────────────────────────

create or replace function public.location_in_org(p_location_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.locations
    where id = p_location_id and organization_id = p_org_id
  );
$$;

grant execute on function public.location_in_org(uuid, uuid) to authenticated;

-- ── 2. Augment item_stock_levels_write WITH CHECK ─────────────────────────────
-- USING clause reproduced verbatim from 0140:362-366 (unchanged).
-- WITH CHECK is augmented: adds location_in_org on top of the existing
-- has_org_role check.  USING is deliberately NOT changed (it governs which
-- existing rows can be read/updated/deleted; constraining it could block
-- remediation of an already-corrupt row).

drop policy if exists item_stock_levels_write on public.item_stock_levels;
create policy item_stock_levels_write on public.item_stock_levels
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'staff')))
  with check (
    (SELECT public.has_org_role(organization_id, 'staff'))
    and (SELECT public.location_in_org(location_id, organization_id))
  );

-- ── 3. Add null p_org_id guard to assert_location_in_org (from 0201) ─────────
-- Keeps body identical to 0201 except for the new null-org guard block.

create or replace function public.assert_location_in_org(
  p_location_id uuid,
  p_org_id      uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_location_id is null then
    return;
  end if;
  if p_org_id is null then
    raise exception 'org_id_required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.locations
    where id = p_location_id
      and organization_id = p_org_id
  ) then
    raise exception 'location_org_mismatch' using errcode = '42501';
  end if;
end;
$$;

grant execute on function public.assert_location_in_org(uuid, uuid) to authenticated;
