-- Add an optional "purchase order terms" string to organizations.
-- Rendered at the bottom of every PO PDF when non-empty (net-30 / return
-- policy / signature requirements / etc). Null means "no terms block".
-- No data backfill needed.

alter table public.organizations add column po_terms text;
