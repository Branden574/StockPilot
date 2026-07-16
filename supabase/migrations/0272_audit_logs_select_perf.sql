-- 0272_audit_logs_select_perf.sql
-- ============================================================================
-- Perf fix for the item Activity feed's audit_logs read (2026-07-16 owner
-- "system feels slow" investigation — EXPLAIN ANALYZE against prod at real
-- org scale):
--
-- 1. audit_logs_select was `(select has_org_role(organization_id,'manager'))`
--    — a CORRELATED per-row subplan. On a 2,140-row org the planner executed
--    it 2,136 times → 67ms for a feed read that should be ~1ms (recurring-bug
--    pattern #19: RLS row-correlated fns run per-row). Replaced with the
--    hashed-set pattern already used by stock_movements/inventory_items:
--    `organization_id in (select rls_manager_org_ids())` executes ONCE and
--    hash-probes per row. rls_manager_org_ids() (mig 0230, SECURITY DEFINER,
--    SETOF uuid) is precisely "orgs where I'm manager+" — same gate, same
--    visibility, no behavior change.
--
-- 2. audit_logs_org_entity_created_idx (mig 0135) has NEVER been used
--    (pg_stat_user_indexes.idx_scan = 0 since creation): its partial
--    predicate `WHERE metadata ? 'entity_id'` cannot be proven from the
--    feed's `(metadata->>'entity_id') = $x` filter, so the planner ignores
--    it and seq-scans. Recreate WITHOUT the partial predicate so the exact
--    query shape ActivityService.forItem issues can use it. NULL entity_id
--    rows index a NULL key — negligible bloat next to an index that
--    actually gets scanned.
-- ============================================================================

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select
  using (organization_id in (select public.rls_manager_org_ids()));

drop index if exists public.audit_logs_org_entity_created_idx;
create index audit_logs_org_entity_created_idx
  on public.audit_logs (organization_id, ((metadata ->> 'entity_id')), created_at desc);
