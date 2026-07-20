-- 0276_realtime_po_imports.sql
--
-- Add po_imports to the supabase_realtime publication so open web pages
-- live-refresh when an import changes from ANOTHER surface — specifically a
-- MOBILE approve/cancel/re-parse via the new Bearer routes
-- (/api/v1/po-imports/[id]/*, shipped 2026-07-18). The web dashboard already
-- mounts InventoryRealtime (postgres_changes → debounced router.refresh) for
-- inventory_items / stock_movements / purchase_orders / rentals (mig 0024,
-- 0132); po_imports was never published, so a mobile approve only appeared
-- on web after a manual refresh. An approve DOES insert a purchase_orders
-- row (already published → POs list refreshed), but cancel / re-parse /
-- scan-status transitions touch ONLY po_imports and were invisible live.
--
-- RLS applies to realtime: po_imports has org-scoped SELECT (0010), so
-- events for foreign orgs are filtered by Postgres before delivery —
-- same posture as every other published table here.
--
-- Idempotent: guarded on membership like 0117/0209 (42710 on re-add).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'po_imports'
  ) then
    alter publication supabase_realtime add table public.po_imports;
  end if;
end$$;
