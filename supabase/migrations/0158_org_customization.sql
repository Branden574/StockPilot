-- ============================================================================
-- 0158_org_customization.sql
-- ============================================================================
-- Per-org customization for dashboard nav + landing layout. Both ride the
-- existing organizations row (alongside `terminology`) so they load for FREE
-- on every dashboard render via getOrgRowForRequest — no new query, no new
-- table, no new RLS. organizations RLS already governs reads; the WRITE path
-- is an admin-gated server action (mirrors the org name / terminology editors).
--
-- Both columns are nullable with NO default: a NULL value means "use the
-- derived/default nav + the default widget layout" and the pure apply
-- functions in @stockpilot/core fail-closed to that on null/garbage. The
-- override layer can only hide/rename/reorder items resolveSurface already
-- returned (plus append validated custom links) — it can NEVER surface nav for
-- a module the org has not enabled.
-- ============================================================================

alter table public.organizations
  add column if not exists nav_overrides jsonb,
  add column if not exists dashboard_layout jsonb;

comment on column public.organizations.nav_overrides is
  'Per-org sidebar customization (NavOverrides v1: hidden/labels/order/custom). NULL = derived nav unchanged. Applied AFTER resolveSurface; can only hide/rename/reorder resolved items + append validated custom links — never surfaces a disabled module.';

comment on column public.organizations.dashboard_layout is
  'Per-org dashboard widget layout (DashboardLayout v1: ordered widgets + hidden flags). NULL = default catalog order, all visible. Unknown ids dropped; newly-shipped widgets append visible.';
