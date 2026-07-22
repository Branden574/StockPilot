-- Make the cancelled-PO reimport actually possible at the DATABASE level.
--
-- 0286 + the service change decided a reimport was allowed, but the insert then
-- hit this pre-existing guard:
--
--   CREATE UNIQUE INDEX po_imports_org_sha_uniq ON po_imports (organization_id, sha256)
--     WHERE status <> ALL (ARRAY['failed','canceled','duplicate'])
--
-- The predecessor import stays 'approved' after its PO is cancelled, so it is
-- still inside that index and a second import of the same file raised 23505
-- ("duplicate key value violates unique constraint") — surfacing as a 500 on
-- the scan route. Confirmed in prod logs.
--
-- Fix WITHOUT weakening duplicate protection: add an explicit `superseded_at`
-- marker and narrow the unique index to LIVE imports only. When (and only when)
-- the service decides a file may be re-imported because every prior import's PO
-- is cancelled, it stamps the predecessor superseded — which removes it from the
-- index and lets exactly ONE new live import take its place.
--
-- Crucially this PRESERVES the predecessor: its status stays 'approved', its
-- approved_po_id, lines, source document, audit trail and cancelled PO are all
-- untouched. `superseded_at` is purely an "is this the live import for this
-- file" marker. Uniqueness among live imports is still enforced by the database,
-- so two concurrent reimports still collide and exactly one wins (the service
-- maps that collision to a clean conflict instead of a 500).

alter table public.po_imports
  add column if not exists superseded_at timestamptz;

comment on column public.po_imports.superseded_at is
  'Set when a LATER import re-used this import''s file because every purchase '
  'order this import produced was cancelled. Removes the row from the '
  'live-uniqueness index without altering its status or history.';

-- Swap the guard for the same rule PLUS "is still the live import".
-- po_imports is a desktop-upload workflow table (small), so a plain
-- drop/recreate is fast; no CONCURRENTLY needed.
drop index if exists public.po_imports_org_sha_uniq;

create unique index po_imports_org_sha_uniq
  on public.po_imports (organization_id, sha256)
  where status <> all (array['failed'::text, 'canceled'::text, 'duplicate'::text])
    and superseded_at is null;

-- ROLLBACK (reversible):
--   drop index if exists public.po_imports_org_sha_uniq;
--   create unique index po_imports_org_sha_uniq
--     on public.po_imports (organization_id, sha256)
--     where status <> all (array['failed'::text,'canceled'::text,'duplicate'::text]);
--   alter table public.po_imports drop column if exists superseded_at;
-- (Rollback is safe only if no two live imports share a hash; supersede any
--  extras first, or the unique index creation will fail.)
