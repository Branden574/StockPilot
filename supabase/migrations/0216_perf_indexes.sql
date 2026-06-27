-- 0216_perf_indexes.sql
-- Two supporting indexes for hot query paths found in the perf sweep.

-- P7: PurchaseOrdersService.list() orders by (created_at desc, id) within an org.
-- The only prior index is (organization_id, status), so the ORDER BY forced a
-- sort over the whole org slice. This composite satisfies the order via an index
-- scan.
create index if not exists purchase_orders_org_created_idx
  on public.purchase_orders (organization_id, created_at desc);

-- P8: three report queries filter stock_movements by (organization_id,
-- movement_type) over a created_at range (shrinkage = 'adjust', bundle
-- distribution/shortage). Without movement_type in an index the planner scanned
-- the full org date-range. This makes them index-range scans.
create index if not exists stock_movements_org_type_created_idx
  on public.stock_movements (organization_id, movement_type, created_at desc);
