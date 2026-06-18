-- Inventory-valuation rollup views — the dashboard home page rendered its
-- category/warehouse breakdown by pulling EVERY active item into Node and
-- summing in JS on every load (reports.ts inventoryValuation + fetchAllRows),
-- so its DB cost grew with org size (the per-org-size amplifier in the capacity
-- review). These views push the SUM/GROUP BY into Postgres, so the dashboard
-- reads ≤ a few dozen pre-aggregated rows instead of all items.
--
-- SECURITY: `security_invoker = true` (PG15+) makes the view execute with the
-- QUERYING user's privileges, so the RLS policies on inventory_items /
-- warehouses / categories apply BEFORE aggregation — each org sees only its own
-- rows, no cross-tenant leak and no service-role bypass. Mirrors the exact
-- filter the report uses: non-deleted, active, non-rental items.

create or replace view public.vw_inventory_valuation_by_warehouse
with (security_invoker = true) as
select
  i.organization_id,
  i.warehouse_id,
  w.name as warehouse_name,
  coalesce(sum(i.quantity_on_hand * i.unit_cost), 0) as value,
  coalesce(sum(i.quantity_on_hand), 0) as units,
  count(*) as item_count
from public.inventory_items i
left join public.warehouses w on w.id = i.warehouse_id
where i.deleted_at is null
  and i.status = 'active'
  and i.is_rental = false
group by i.organization_id, i.warehouse_id, w.name;

create or replace view public.vw_inventory_valuation_by_category
with (security_invoker = true) as
select
  i.organization_id,
  i.category_id,
  c.name as category_name,
  coalesce(sum(i.quantity_on_hand * i.unit_cost), 0) as value,
  coalesce(sum(i.quantity_on_hand), 0) as units,
  count(*) as item_count
from public.inventory_items i
left join public.categories c on c.id = i.category_id
where i.deleted_at is null
  and i.status = 'active'
  and i.is_rental = false
group by i.organization_id, i.category_id, c.name;

-- Authenticated users read these (RLS on the base tables does the org scoping).
grant select on public.vw_inventory_valuation_by_warehouse to authenticated;
grant select on public.vw_inventory_valuation_by_category to authenticated;
