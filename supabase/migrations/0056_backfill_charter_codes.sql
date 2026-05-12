-- ============================================================================
-- 0056_backfill_charter_codes.sql
--
-- Backfill `charters.code` for every row where it's null / empty by
-- slugifying the charter's name into the format the shipments service
-- expects for work-order numbers:
--
--   "CVW Manchester"   →  "CVW-MANCHESTER"
--   "AMB Sanchez"      →  "AMB-SANCHEZ"
--   "CVSII West Shaw"  →  "CVSII-WEST-SHAW"
--
-- Rules (matches the sanitization in shipments.ts insertShipmentWithLines):
--   1. Replace any run of non-alphanumeric characters with a single '-'.
--   2. Uppercase.
--   3. Trim leading/trailing '-'.
--
-- The function `regexp_replace(name, '[^A-Za-z0-9]+', '-', 'g')` collapses
-- spaces, punctuation, periods, etc. into a single dash. `btrim(..., '-')`
-- removes edge dashes so we don't produce codes like "-CVW-" from a name
-- that happens to start with a space.
--
-- Why this is needed: `code` was always nullable, and the existing
-- /dashboard/admin/charters page lets you skip the code field. Every
-- charter the user created went in without a code, and the shipments
-- service refuses to mint a degenerate WO# like "ISR--MMDDYYYY" — so
-- generating a packing slip throws "Destination charter has no usable
-- code for the work order number." This migration fills them in once,
-- and going forward the charter create/edit form should also auto-
-- suggest a code from the name (separate change).
--
-- Collision safety: charters has `unique (organization_id, code)`. If two
-- charters in the same org slugify to the same code, the UPDATE aborts
-- with a unique_violation and the migration fails — the user will see
-- which two names collide and can resolve manually. For the current data
-- (AMB Sanchez, CVLYII Visalia, CVSII Madera, CVSII West Shaw, CVW Clovis,
-- CVW Manchester, CVW Sunnyside, KVA Hanford, KVA Tulare, MLA Sacremento,
-- ...) no collisions are expected.
-- ============================================================================

update public.charters
set code = btrim(upper(regexp_replace(name, '[^A-Za-z0-9]+', '-', 'g')), '-')
where (code is null or btrim(code) = '')
  and name is not null
  and btrim(name) <> '';
