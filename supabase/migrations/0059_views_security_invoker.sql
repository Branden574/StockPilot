-- ============================================================================
-- 0059_views_security_invoker.sql
--
-- Supabase security advisor flagged three views as CRITICAL "Security
-- Definer View":
--
--   public.vw_po_reconciliation
--   public.vw_vendor_performance
--   public.vw_warehouse_inbound
--
-- These views were created in 0017_reconciliation_views.sql via plain
-- `CREATE OR REPLACE VIEW ...` without the `WITH (security_invoker = true)`
-- option. In Postgres 15+, the historical default is `security_invoker =
-- false`, which means the view's queries run with the privileges of the
-- view owner (the migration-runner role / postgres), NOT the querying
-- user. RLS policies on the underlying tables (purchase_orders,
-- purchase_order_items, suppliers, locations) are therefore bypassed
-- when reading through the view — anyone with SELECT on the view can
-- see every row across every organization.
--
-- Today the application service layer also filters by organization_id
-- in its WHERE clauses, so this isn't an actively-exploited leak. But
-- treating RLS as the sole defense is the design intent, and a future
-- query path that forgets the explicit org filter would silently leak
-- cross-org data. Defense in depth — fix the view config.
--
-- Fix: flip each view to `security_invoker = true` so the underlying
-- table RLS applies per-querier. Existing SELECT policies on
-- purchase_orders / purchase_order_items / suppliers / locations all
-- gate on is_org_member(organization_id), so each org's user sees
-- only their own rows through the view — same external shape, just
-- now enforced through RLS instead of relying on the service-layer
-- WHERE clause.
--
-- No schema change. No data change. No application-code change needed.
-- ============================================================================

alter view public.vw_po_reconciliation set (security_invoker = true);
alter view public.vw_warehouse_inbound set (security_invoker = true);
alter view public.vw_vendor_performance set (security_invoker = true);
