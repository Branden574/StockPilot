-- 0100_audit_logs_select_manager.sql
-- ============================================================================
-- Align audit_logs SELECT RLS with the role/permission matrix
-- ----------------------------------------------------------------------------
-- The original 0003_rls.sql `audit_logs_select` policy required admin+
-- to read audit_logs, but the role/permission matrix in
-- packages/core/src/constants/permissions.ts grants `activity_logs:read`
-- to manager+. The page-level guard at
-- apps/web/src/app/(dashboard)/dashboard/settings/audit/page.tsx checks
-- hasPermission(role, 'activity_logs:read'), so managers could open the
-- page and then see an empty table because RLS silently denied every
-- row.
--
-- This migration drops and re-creates `audit_logs_select` with the same
-- `public.has_org_role(organization_id, 'manager')` check the
-- activity_logs policy already uses. Result: managers can read the
-- audit log they already have permission to view (per the matrix), and
-- the page UI matches reality.
--
-- INSERT/UPDATE/DELETE on audit_logs remain handled server-side via the
-- service role — no client-write policies are added.
-- ============================================================================

drop policy if exists audit_logs_select on public.audit_logs;

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.has_org_role(organization_id, 'manager'));
