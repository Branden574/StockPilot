-- 0136_orders_org_status_fulfillment_idx.sql
--
-- Adds a composite BTREE index on order_requests covering the now-common
-- list-page filter combo: status + fulfillment_type, sorted newest-first.
--
-- Why: the orders list page filters by `status` (often) and `fulfillment_type`
-- (when staff narrow to pickup vs delivery tabs). The existing
-- `order_requests_org_status_idx(organization_id, status, created_at desc)`
-- handles the status case well but does an in-memory filter on fulfillment_type.
-- The new index lets the planner pick a single tighter scan when both
-- filters are present.
--
-- Write cost: minimal. order_requests gets ~1 insert per submitted order
-- and a handful of updates per status transition. Adding one more BTREE
-- on three small columns is cheap.
--
-- Existing fulfillment-typed partial indexes (0119) cover the
-- fulfillment-only filter case; this composite covers status+fulfillment
-- together.

create index if not exists order_requests_org_status_fulfillment_idx
  on public.order_requests (
    organization_id,
    status,
    fulfillment_type,
    created_at desc
  );
