-- 0135_audit_logs_entity_id_idx.sql
--
-- Adds a BTREE expression index on audit_logs(metadata->>'entity_id')
-- scoped by organization_id and ordered by created_at desc.
--
-- Why: the item-detail Activity tab and several other detail-page
-- timelines query audit_logs with `metadata @> {entity_id: <uuid>}`
-- to gather per-item / per-order events. Without this index that
-- scans every audit row for the org, then filters in memory — fine
-- for new tables, painful for ~6 months of audit growth.
--
-- The index supports both the JSONB containment pattern (we'll
-- rewrite the activity query to use the extracted text path so it
-- can use this index — `metadata->>'entity_id' = '<uuid>'`) and
-- ordering by created_at desc, which is the universal sort for
-- timelines.
--
-- Partial on `metadata->>'entity_id' IS NOT NULL` keeps the index
-- compact — login-failure events, generic system rows, and other
-- non-entity audit events don't carry entity_id and would just
-- bloat the index otherwise.

create index if not exists audit_logs_org_entity_created_idx
  on public.audit_logs (
    organization_id,
    ((metadata->>'entity_id')),
    created_at desc
  )
  where metadata ? 'entity_id';
