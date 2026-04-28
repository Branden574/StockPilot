-- ============================================================================
-- 0006_perf.sql — Performance helpers
-- Single-round-trip dashboard summary + covering index for the inventory list.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- get_dashboard_summary: replaces 4 separate queries (item count,
-- out-of-stock count, low-stock count via low_stock_count, inventory_value
-- via inventory_value) with one index scan that produces all four numbers.
-- ----------------------------------------------------------------------------
create or replace function public.get_dashboard_summary(p_org_id uuid)
returns table (
  item_count          int,
  out_of_stock_count  int,
  low_stock_count     int,
  inventory_value     numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (
      where status = 'active' and deleted_at is null
    )::int as item_count,
    count(*) filter (
      where status = 'active' and deleted_at is null and quantity_on_hand <= 0
    )::int as out_of_stock_count,
    count(*) filter (
      where status = 'active'
        and deleted_at is null
        and reorder_point > 0
        and quantity_on_hand <= reorder_point
    )::int as low_stock_count,
    coalesce(
      sum(unit_cost * quantity_on_hand) filter (
        where status = 'active' and deleted_at is null
      ),
      0
    ) as inventory_value
  from public.inventory_items
  where organization_id = p_org_id
$$;

grant execute on function public.get_dashboard_summary(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Covering index for the inventory list's ORDER BY updated_at DESC.
-- Existing partial index on (organization_id, status) was forcing a sort
-- after the index scan; this one provides the sort order directly.
-- ----------------------------------------------------------------------------
create index if not exists inventory_items_org_updated_idx
  on public.inventory_items (organization_id, updated_at desc)
  where deleted_at is null and status = 'active';
