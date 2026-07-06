-- 0223_inventory_trend_buckets_rpc.sql
--
-- ONE SQL aggregate for the Items/Books trend sparklines' cold fill
-- (cold-start plan item 2).
--
-- Before: loadInventoryTrendBucketsUncached (apps/web/src/server/loaders/
-- inventory-list.ts) dumped EVERY org stock_movements row in the 14-day
-- window through sequential 1000-row PostgREST pages (an active org pays
-- 2-5+ round trips + full row transfer) and bucketed them in JS
-- (lib/item-trends.ts bucketTrendMovements). The aggregate is tiny
-- (≤ items × 14 rows) — only the raw transfer was expensive, so it moves
-- into Postgres.
--
-- The output reproduces bucketTrendMovements' math EXACTLY, one row per
-- (item, day-bucket) that has movements:
--   • window anchor  = now() − p_days × 24h  (JS: Date.now() − 14 d in ms;
--     '24 hours' — not make_interval(days ⇒ …) — so the arithmetic is pure
--     ms like the JS, immune to any session-timezone DST day length),
--   • day_index      = floor(epoch(created_at − anchor) / 86400),
--     clamped into [0, p_days−1] exactly like the JS clamp (the lower
--     clamp only fires on the boundary row, the upper on future-dated
--     created_at values),
--   • quantity_change = sum(quantity_change), move_count = count(*).
-- Same filter semantics as the JS path: organization_id + created_at
-- window ONLY — deliberately no movement_type / is_rental / item_type /
-- deleted-item narrowing, because the buckets are org-wide and the
-- consumer (deriveItemTrend) looks up only the item ids the current view
-- surfaced. NOTE the JS path carried a 100 000-row transfer safety cap
-- (disclosed truncation); the SQL aggregate reads all window rows —
-- strictly more accurate, and the cap's transfer concern no longer
-- exists because only the aggregate leaves the database.
--
-- WHO MAY CALL: the service-role client ONLY (the org-scoped cached
-- loader behind canUseSharedInventoryCaches). EXECUTE is revoked from
-- public/anon/authenticated so a user-facing client can never turn this
-- into a cross-org aggregate oracle by passing someone else's org id —
-- it is SECURITY INVOKER, so even if a grant leaked back, RLS on
-- stock_movements would still bind a non-bypassrls caller.

create or replace function public.inventory_trend_buckets(
  p_organization_id uuid,
  p_days int default 14
)
returns table (
  item_id uuid,
  day_index int,
  quantity_change numeric,
  move_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      greatest(p_days, 1) as days,
      now() - greatest(p_days, 1) * interval '24 hours' as start_at
  )
  select
    sm.item_id,
    least(
      params.days - 1,
      greatest(
        0,
        (floor(extract(epoch from (sm.created_at - params.start_at)) / 86400))::int
      )
    ) as day_index,
    sum(coalesce(sm.quantity_change, 0))::numeric as quantity_change,
    count(*)::bigint as move_count
  from public.stock_movements sm, params
  where sm.organization_id = p_organization_id
    and sm.created_at >= params.start_at
  group by 1, 2
$$;

-- Service-role-only: user clients must never reach an org-id-parameterized
-- aggregate directly (cross-org oracle). revoke from public strips the
-- default PUBLIC execute grant; anon/authenticated listed explicitly so a
-- later blanket re-grant to public can't silently re-open them without
-- this migration showing up in the blame.
revoke all on function public.inventory_trend_buckets(uuid, int) from public;
revoke all on function public.inventory_trend_buckets(uuid, int) from anon;
revoke all on function public.inventory_trend_buckets(uuid, int) from authenticated;
grant execute on function public.inventory_trend_buckets(uuid, int) to service_role;

comment on function public.inventory_trend_buckets(uuid, int) is
  'Org-wide per-item per-day movement aggregates for the 14-day list sparklines '
  '(sum(quantity_change) + count(*) per (item_id, day bucket)); reproduces '
  'lib/item-trends.ts bucketTrendMovements exactly. Service-role only — called by '
  'the cached loadInventoryTrendBuckets loader (inventory-list.ts); EXECUTE revoked '
  'from anon/authenticated so it cannot become a cross-org aggregate oracle.';
