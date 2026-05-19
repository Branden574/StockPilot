-- 0127_order_request_top_skus.sql
--
-- Powers the Quick-add row + "Most ordered" sort on the new
-- /dashboard/orders/new v2 picker. Returns the top-N item_ids by
-- order_request_lines count for a given warehouse over the last N
-- days, excluding orders that never produced fulfillment (denied /
-- cancelled).
--
-- Aggregation key: order_request_lines.item_id (NOT sku). SKUs are
-- no longer globally unique within an org after migration 0126;
-- counting by item_id is correct and FK-safe.
--
-- RLS scoping: security invoker — the order_requests select honors
-- the caller's warehouse-access policy automatically, so an end user
-- can't request the freq summary for a warehouse they can't read.

create or replace function public.order_request_top_skus_for_warehouse(
  p_warehouse_id uuid,
  p_days         int,
  p_limit        int
) returns table (
  item_id       uuid,
  request_count bigint
)
language sql
stable
security invoker
as $$
  select orl.item_id,
         count(*)::bigint as request_count
  from public.order_request_lines orl
  join public.order_requests req on req.id = orl.order_request_id
  where req.warehouse_id = p_warehouse_id
    and req.created_at >= now() - (greatest(p_days, 1) || ' days')::interval
    and req.status not in ('denied', 'cancelled')
  group by orl.item_id
  order by request_count desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.order_request_top_skus_for_warehouse(uuid, int, int) from public;
revoke all on function public.order_request_top_skus_for_warehouse(uuid, int, int) from anon;
grant execute on function public.order_request_top_skus_for_warehouse(uuid, int, int) to authenticated;
