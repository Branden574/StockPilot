-- 0130_user_category_assignments_composite_index.sql
--
-- The user_can_see_item_category RPC (migration 0129) and the
-- service-layer getAccessibleCategoryIds query both filter by
-- (user_id, organization_id) — but 0128 only created single-column
-- indexes on user_id and category_id separately. For a viewer with
-- assignments in multiple orgs (cross-org membership is allowed) the
-- planner uses the user_id index and then heap-filters on
-- organization_id. Fine for tiny grant sets, wasteful when the same
-- check fires on every row scan of inventory_items for restricted
-- viewers (RLS policy invokes the RPC per-row).
--
-- Add a composite index on (user_id, organization_id) so the org
-- scope is part of the index lookup. Existing single-column user_id
-- index is left in place since it still serves the team-page query
-- patterns (`select grants where user_id IN (...)`).

create index if not exists user_category_assignments_user_org_idx
  on public.user_category_assignments(user_id, organization_id);
