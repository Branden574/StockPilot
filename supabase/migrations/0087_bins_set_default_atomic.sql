-- 0087_bins_set_default_atomic.sql
-- ─────────────────────────────────────────────────────────────────────
-- B3: replace the two-step "clear-others then set-default" in the
-- application service with a single SECURITY DEFINER function so the
-- two writes are atomic. Without this, a second concurrent caller
-- could observe the moment between the UPDATE that clears all
-- defaults and the INSERT/UPDATE that sets the new one — leaving the
-- (warehouse, bin_type) pair with zero defaults, or worse, two if the
-- partial unique index races against a concurrent transaction.
--
-- The function runs as the table owner (security definer) but
-- gates the call on `has_org_role('manager')` so callers without
-- the appropriate role get rejected even though RLS is bypassed
-- inside the function body. Default search_path is locked to
-- public to mitigate search-path attacks.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

create or replace function public.set_default_bin(
  p_organization_id uuid,
  p_warehouse_id    uuid,
  p_bin_type        text,
  p_bin_id          uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Permission gate: caller must be at least a manager for this org.
  -- has_org_role itself reads from organization_members using auth.uid()
  -- so this is safe to call from RLS-bypassed contexts.
  if not public.has_org_role(p_organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- B7: only clear `is_default` on ACTIVE rows. Archived rows are
  -- already excluded from the (warehouse_id, bin_type) WHERE-default
  -- unique index anyway, but the service used to clear them too and
  -- would write a no-op UPDATE on archived rows. Scoping the clear to
  -- 'active' is the correct semantics.
  update public.bins
     set is_default = false,
         updated_at = now()
   where organization_id = p_organization_id
     and warehouse_id    = p_warehouse_id
     and bin_type        = p_bin_type
     and is_default      = true
     and status          = 'active'
     and id              <> p_bin_id;

  -- Set the requested bin as default. Idempotent.
  update public.bins
     set is_default = true,
         updated_at = now()
   where organization_id = p_organization_id
     and id              = p_bin_id
     and warehouse_id    = p_warehouse_id
     and bin_type        = p_bin_type
     and status          = 'active';
end;
$$;

revoke all on function public.set_default_bin(uuid, uuid, text, uuid) from public;
grant execute on function public.set_default_bin(uuid, uuid, text, uuid) to authenticated;
