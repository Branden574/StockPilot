-- 0085_vendor_item_mappings_hardening.sql
-- ─────────────────────────────────────────────────────────────────────
-- V2: The RLS policy `vim_admin_write` was tightened to `admin` in
-- 0046_rls_with_check_hardening.sql, but the application service uses
-- `assertPermission('purchase_orders:manage')` which is granted to
-- managers as well as admins/owners. Result: a manager who has the
-- in-app permission gets their UPSERT silently rejected by RLS.
--
-- Service behaviour is the canonical truth (manager+ can manage
-- vendor mappings), so we loosen RLS back to `manager` to match.
-- This is the V2 fix from the vendor/uom/bins bug hunt.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

drop policy if exists vim_admin_write on public.vendor_item_mappings;
create policy vim_admin_write on public.vendor_item_mappings
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));
