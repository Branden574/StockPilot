-- ============================================================================
-- 0123_inventory_list_composite_indexes.sql
-- ============================================================================
-- The inventory + books list pages query inventory_items with a
-- predicable shape:
--
--   WHERE organization_id = ?
--     AND deleted_at IS NULL
--     AND item_type = ?     -- products tab vs books tab
--     AND status = ?        -- usually 'active'
--   ORDER BY updated_at DESC | name ASC | sku ASC
--   LIMIT 50
--
-- Existing indexes cover the org-wide variants of these queries:
--   • inventory_items_org_updated_idx (0006) — (org, updated_at desc)
--     WHERE deleted_at is null AND status='active' — supports the default
--     sort BUT the planner still post-filters by item_type after the
--     index scan, and the partial WHERE excludes the archived/all views.
--   • inventory_items_org_name_idx  (0039) — (org, name)
--     WHERE status='active' AND deleted_at is null
--   • inventory_items_org_sku_idx   (0039) — (org, sku)
--     WHERE status='active' AND deleted_at is null
--   • inventory_items_item_type_idx (0020) — (org, item_type)
--     WHERE deleted_at is null
--
-- Adding item_type as a leading column on the sort indexes lets
-- Postgres scan a contiguous range of rows that match the active tab
-- (products vs books vs other) without a post-filter — meaningful on
-- orgs that have a large catalog mixed across item types.
--
-- All indexes are partial on `deleted_at IS NULL`. NOT-CONCURRENTLY
-- because Supabase migrations run inside a transaction; creating
-- concurrently would require running the migration outside a txn.
-- Creation is fast for current catalog sizes; if needed in the future
-- the indexes can be dropped + rebuilt concurrently via a follow-up.
-- ============================================================================

-- Default tab sort: updated_at desc, scoped by item_type.
-- Covers products tab + books tab + any other typed listings, across
-- all statuses (active / archived / discontinued / all).
create index if not exists inventory_items_org_type_updated_idx
  on public.inventory_items(organization_id, item_type, updated_at desc)
  where deleted_at is null;

-- Name sort, scoped by item_type. Covers the products/books tabs
-- across all statuses (the existing org_name_idx is active-only).
create index if not exists inventory_items_org_type_name_idx
  on public.inventory_items(organization_id, item_type, name)
  where deleted_at is null;

-- SKU sort, scoped by item_type. Same reasoning as name.
create index if not exists inventory_items_org_type_sku_idx
  on public.inventory_items(organization_id, item_type, sku)
  where deleted_at is null;

-- The status filter is the only "always present" predicate when the
-- user picks the archived / discontinued / all view (instead of the
-- default 'active'). Add a covering index for that case so the
-- planner doesn't fall back to a full org scan.
create index if not exists inventory_items_org_type_status_updated_idx
  on public.inventory_items(organization_id, item_type, status, updated_at desc)
  where deleted_at is null;
