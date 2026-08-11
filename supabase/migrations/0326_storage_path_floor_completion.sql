-- 0326_storage_path_floor_completion.sql
-- ============================================================================
-- Completes the HI-8 storage-path floor: the traversal-refusing CHECK 0323 put
-- under nine path columns, extended to the five columns 0323 skipped —
--
--   item_attachments.storage_path
--   cycle_count_ai_scans.photo_storage_path
--   import_jobs.storage_path
--   size_count_training_samples.image_storage_path
--   support_tickets.attachment_path
--
-- These have been carried in security_invariants.test.sql's INV-15 known-gap
-- allowlist since that file was written. This migration closes the gap, and the
-- SAME change deletes their allowlist rows so the invariant now ENFORCES them
-- (INV-16 refuses a stale entry, so the two edits cannot ship apart).
--
-- The predicate is 0323's, verbatim — see 0323's header for what each clause
-- refuses and why the predicate is inline rather than a helper function (a
-- CREATE OR REPLACE on a helper would silently change what every constraint
-- means without any of them being re-validated).
--
-- PRE-VERIFIED AGAINST PRODUCTION 2026-08-11
-- ---------------------------------------------------------------------------
-- Zero violating rows across all five columns. Row counts at verification:
-- item_attachments 0, cycle_count_ai_scans 0, import_jobs 0,
-- size_count_training_samples 2171, support_tickets 3.
--
-- WHY ADD NOT VALID + VALIDATE IN ONE MIGRATION, WHEN 0323/0324 WERE SPLIT
-- ---------------------------------------------------------------------------
-- The split existed for lock risk: a plain ADD CONSTRAINT takes an ACCESS
-- EXCLUSIVE lock while it full-scans the table, so 0323 deferred the scan and
-- 0324 ran it later under SHARE UPDATE EXCLUSIVE. That risk is proportional to
-- table size, and these tables are tiny (largest: 2,171 rows) — the validate
-- scan is milliseconds, so the two-step happens here back-to-back: ADD NOT
-- VALID (no scan, brief lock), then VALIDATE CONSTRAINT (SHARE UPDATE
-- EXCLUSIVE, permits concurrent reads and writes). The house discipline is
-- kept — the lock taken while rows are scanned never blocks readers — without
-- splitting a trivial scan across two deploys. If a VALIDATE below fails on a
-- future environment, that is the constraint doing its job: fix the offending
-- row, never drop the constraint.
--
-- No policy is created or altered here (pattern #24/#25 do not apply) and no
-- function is created (0318's default-PUBLIC-grant trap does not apply).
-- ============================================================================

alter table public.item_attachments
  add constraint item_attachments_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.item_attachments
  validate constraint item_attachments_storage_path_safe;

alter table public.cycle_count_ai_scans
  add constraint cycle_count_ai_scans_photo_storage_path_safe
  check (
    length(photo_storage_path) between 1 and 400
    and position('..' in photo_storage_path) = 0
    and position('%' in photo_storage_path) = 0
    and position(E'\\' in photo_storage_path) = 0
    and position('//' in photo_storage_path) = 0
    and photo_storage_path not like '/%'
    and photo_storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.cycle_count_ai_scans
  validate constraint cycle_count_ai_scans_photo_storage_path_safe;

alter table public.import_jobs
  add constraint import_jobs_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.import_jobs
  validate constraint import_jobs_storage_path_safe;

alter table public.size_count_training_samples
  add constraint size_count_training_samples_image_storage_path_safe
  check (
    length(image_storage_path) between 1 and 400
    and position('..' in image_storage_path) = 0
    and position('%' in image_storage_path) = 0
    and position(E'\\' in image_storage_path) = 0
    and position('//' in image_storage_path) = 0
    and image_storage_path not like '/%'
    and image_storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.size_count_training_samples
  validate constraint size_count_training_samples_image_storage_path_safe;

-- attachment_path is the one NULLABLE column of the five (0260 added it as a
-- plain `text`; a support ticket without an attachment carries NULL), so it
-- takes the null-or wrapper — same shape as item_images_thumb_path_safe in
-- 0323.
alter table public.support_tickets
  add constraint support_tickets_attachment_path_safe
  check (
    attachment_path is null
    or (
      length(attachment_path) between 1 and 400
      and position('..' in attachment_path) = 0
      and position('%' in attachment_path) = 0
      and position(E'\\' in attachment_path) = 0
      and position('//' in attachment_path) = 0
      and attachment_path not like '/%'
      and attachment_path !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.support_tickets
  validate constraint support_tickets_attachment_path_safe;


-- ═══════════════════════════════════════════════════════════════════════════
-- Constraint comments — one per constraint, so `\d+` explains itself.
-- ═══════════════════════════════════════════════════════════════════════════

comment on constraint item_attachments_storage_path_safe on public.item_attachments is
  'HI-8 (0326, completing 0323). Refuses the path-traversal alphabet (.., %, leading /, //, backslash, control chars, over-length) on a column authenticated members can write through PostgREST. Structural floor only — the positive shape belongs to the service that knows the org id. Validated in the same migration: the table held 0 rows at pre-verification (2026-08-11).';

comment on constraint cycle_count_ai_scans_photo_storage_path_safe on public.cycle_count_ai_scans is
  'HI-8 (0326, completing 0323). Structural traversal floor; scan photos are minted by the cycle-count service, but the column is writable through PostgREST like every other, so the floor belongs here too. Validated in-migration (0 rows at pre-verification, 2026-08-11).';

comment on constraint import_jobs_storage_path_safe on public.import_jobs is
  'HI-8 (0326, completing 0323). Structural traversal floor. The import worker DOWNLOADS whatever this column names, so a traversal value here is an arbitrary-object read. Validated in-migration (0 rows at pre-verification, 2026-08-11).';

comment on constraint size_count_training_samples_image_storage_path_safe on public.size_count_training_samples is
  'HI-8 (0326, completing 0323). Structural traversal floor on the training-image pointer (0284). Validated in-migration (2,171 rows at pre-verification, all clean, 2026-08-11).';

comment on constraint support_tickets_attachment_path_safe on public.support_tickets is
  'HI-8 (0326, completing 0323). Same predicate under the null-or wrapper — a ticket without an attachment carries NULL (0260). Validated in-migration (3 rows at pre-verification, all clean, 2026-08-11).';
