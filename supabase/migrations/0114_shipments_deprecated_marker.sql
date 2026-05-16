-- 0114_shipments_deprecated_marker.sql
--
-- Phase 6 of the orders workflow refactor: marks the shipments
-- table as deprecated. New outbound work flows through
-- order_requests now. Existing shipment rows stay readable forever
-- (the /dashboard/shipments routes go read-only with a banner in
-- the same PR that ships this migration); this column is purely
-- informational — a future cleanup migration (deferred ~30 days)
-- will drop the table entirely.
--
-- The column has NO NOT NULL constraint and NO default — only the
-- ops team that retires this table sets it.

begin;

alter table public.shipments
  add column if not exists deprecated_at timestamptz;

commit;

comment on column public.shipments.deprecated_at is
  'Informational: when the row was created against the deprecated '
  'shipments workflow. Set by data-import / archival scripts; NULL '
  'for live rows from before the cutover. The application surface '
  'is fully read-only as of phase 6 — this column exists for the '
  'future cleanup migration to filter on.';
