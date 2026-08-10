-- 0323_storage_path_shape_constraints.sql
-- ============================================================================
-- Security Wave D (HI-8) — a DATABASE floor under the storage-path traversal
-- class the application layer closed in this same wave.
--
-- THE HOLE THE APPLICATION FIX CLOSES, AND WHY THE DATABASE ALSO NEEDS ONE
-- -----------------------------------------------------------------------
-- Five services accepted a client-supplied storage path, gated it with
-- `path.startsWith('<org-id>/')`, and handed it to a Supabase Storage client.
-- @supabase/storage-js interpolates the path into a fetch() URL, and the WHATWG
-- URL parser resolves `..` / `%2e%2e` segments BEFORE the request leaves Node,
-- so
--     <org-id>/../../item-images/<victim-org>/<victim-item>/cover.jpg
-- passes the prefix check, escapes the org folder AND the bucket, and comes
-- back as a signed URL that RLS never evaluated. Wave D replaces every one of
-- those prefix checks with a strict positive shape (apps/web/src/lib/
-- storage-path.ts).
--
-- That fix lives in the SERVICE layer, and the service layer is not the only
-- writer. `authenticated` holds INSERT on these tables through PostgREST, and
-- their write policies gate the ROLE and the FK-org consistency, never the
-- VALUE of the path. Two live examples:
--   * apps/mobile/src/components/po-attachments.tsx inserts into
--     public.po_attachments DIRECTLY via PostgREST — it never calls
--     PoAttachmentsService.add(), so the new shape check does not run for it.
--   * public.maintenance_request_attachments' INSERT policy (0314/0317) lets a
--     request's own requester insert a row, so a hand-rolled PATCH/POST can
--     name any storage_path it likes even though every legitimate write goes
--     through the service's validateFinalizePath.
-- So the shape check is bypassable while the columns themselves accept
-- anything. These constraints are the floor that closes that: they are not a
-- substitute for the service-layer shape checks (a CHECK constraint cannot know
-- the caller's org id or the parent entity id, so it cannot pin either), they
-- are a structural refusal of the traversal ALPHABET, wherever the write comes
-- from.
--
-- WHAT IS REFUSED, AND WHY EACH CLAUSE IS THERE
--   `..` anywhere              the traversal itself
--   `%`                        every percent-encoded form of it in one rule
--                              (%2e%2e, %252e%252e, %2f, over-long UTF-8) —
--                              the storage clients percent-decode downstream,
--                              and no legitimate path in this product contains
--                              a `%`, so refusing the character beats chasing
--                              encodings
--   leading `/`                an absolute path
--   `//`                       an empty segment, which normalizes away and can
--                              shift what the following segments mean
--   `\`                        a Windows separator some parsers fold to `/`
--   control characters         the embedded-NUL truncation payload and the
--                              trailing-newline smuggle (U+0000-U+001F, U+007F)
--   over-length                a bounded cap (400) before anything downstream
--                              has to reason about a megabyte of path
--   empty string               never a real object
--
-- Deliberately NOT enforced here: the positive shape (org id / entity id /
-- filename). That belongs in the application, where those ids are known.
--
-- WHY `not valid` — THE IMPORTANT PART
--   The controller checked production before this file was written: 1,001 rows
--   across all seven columns below (item_images.storage_path 465,
--   item_images.thumb_path 461, po_imports 56, po_attachments 10,
--   order_request_attachments 5, procedure_videos 3,
--   maintenance_request_attachments 1) satisfy every clause above — zero `..`,
--   zero `%`, zero leading `/`, zero `//`, longest path 127 characters against
--   a 400 cap. public.item_attachments holds 0 rows.
--
--   So a VALIDATING constraint would very probably succeed. `not valid` is
--   still the right call, because "very probably" is the wrong risk posture for
--   a deploy: `alter table ... add constraint` without it takes an ACCESS
--   EXCLUSIVE lock and full-scans the table, and if a single row anywhere
--   disagrees the statement fails, the migration aborts, and in this repo an
--   aborted migration means pending migrations and crashed pages. `not valid`
--   enforces the invariant on every NEW insert and update — the entire attack
--   surface, since the hole is a hostile write, not a legacy row — while
--   leaving existing rows unscanned.
--
--   Promoting them later is SAFE and is a separate, deliberate owner step. Do
--   NOT run it from this migration. Re-check first:
--
--     select 'item_images.storage_path' as col, count(*) from public.item_images
--      where storage_path like '%..%' or storage_path like '%\%%'
--         or storage_path like '/%'   or storage_path like '%//%'
--     union all select 'item_images.thumb_path', count(*) from public.item_images
--      where thumb_path like '%..%' or thumb_path like '%\%%'
--         or thumb_path like '/%'   or thumb_path like '%//%';
--     -- (repeat per column; the constraint bodies below are the exact predicate)
--
--   Then, per constraint (SHARE UPDATE EXCLUSIVE only — does not block reads
--   or writes):
--     alter table public.item_images validate constraint item_images_storage_path_safe;
--
-- NEVER EDIT A SHIPPED MIGRATION (charter 100): 0322 is the latest shipped
-- file, so this is 0323. Nothing above 0322 is touched.
--
-- No policy is created or altered here, so pattern #24 (`alter policy ... with
-- check` REPLACING a whole predicate) and pattern #25 (an unqualified column
-- inside a policy subquery resolving to the inner relation) do not apply. No
-- function is created, so 0318's default-PUBLIC-grant trap does not apply
-- either.
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- The shared predicate, stated once per column.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Written inline rather than as a helper function on purpose. A CHECK
-- constraint that calls a function is only as immutable as that function: the
-- planner records it as IMMUTABLE-by-assertion, and a later CREATE OR REPLACE
-- silently changes what every constraint means without any of them being
-- re-validated. An inline predicate cannot drift.
--
-- The control-character leg uses the POSIX class `[[:cntrl:]]` rather than a
-- hand-written range, because a hand-written range would need literal control
-- bytes in this file — unreviewable in a diff and easy to mangle in transit.
-- `[[:cntrl:]]` is exactly U+0000-U+001F plus U+007F.
--
-- The `position(... in ...) = 0` form is used for the literal substrings so
-- there is no LIKE escaping to get wrong (`like '%\%%'` needs its own escape
-- discussion; `position('%' in path) = 0` does not). The backslash literal is
-- written `E'\\'` so it means one backslash regardless of
-- standard_conforming_strings, instead of depending on the session setting.

alter table public.item_images
  add constraint item_images_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.item_images
  add constraint item_images_thumb_path_safe
  check (
    thumb_path is null
    or (
      length(thumb_path) between 1 and 400
      and position('..' in thumb_path) = 0
      and position('%' in thumb_path) = 0
      and position(E'\\' in thumb_path) = 0
      and position('//' in thumb_path) = 0
      and thumb_path not like '/%'
      and thumb_path !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.order_request_attachments
  add constraint order_request_attachments_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.po_attachments
  add constraint po_attachments_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.po_imports
  add constraint po_imports_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.procedure_videos
  add constraint procedure_videos_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.procedure_videos
  add constraint procedure_videos_thumbnail_path_safe
  check (
    thumbnail_path is null
    or (
      length(thumbnail_path) between 1 and 400
      and position('..' in thumbnail_path) = 0
      and position('%' in thumbnail_path) = 0
      and position(E'\\' in thumbnail_path) = 0
      and position('//' in thumbnail_path) = 0
      and thumbnail_path not like '/%'
      and thumbnail_path !~ '[[:cntrl:]]'
    )
  ) not valid;

-- maintenance_request_attachments was already hardened in the application (its
-- validateFinalizePath is the reference implementation lib/storage-path.ts
-- generalizes), but its INSERT policy admits a requester writing the row
-- directly through PostgREST, which never reaches that function — so the floor
-- belongs here too.
alter table public.maintenance_request_attachments
  add constraint maintenance_request_attachments_storage_path_safe
  check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ) not valid;

alter table public.maintenance_request_attachments
  add constraint maintenance_request_attachments_thumbnail_path_safe
  check (
    thumbnail_path is null
    or (
      length(thumbnail_path) between 1 and 400
      and position('..' in thumbnail_path) = 0
      and position('%' in thumbnail_path) = 0
      and position(E'\\' in thumbnail_path) = 0
      and position('//' in thumbnail_path) = 0
      and thumbnail_path not like '/%'
      and thumbnail_path !~ '[[:cntrl:]]'
    )
  ) not valid;


-- ═══════════════════════════════════════════════════════════════════════════
-- Constraint comments — one per constraint, so `\d+` explains itself.
-- ═══════════════════════════════════════════════════════════════════════════

comment on constraint item_images_storage_path_safe on public.item_images is
  'HI-8 (0323). Refuses the path-traversal alphabet (.., %, leading /, //, backslash, control chars, over-length) on a column that authenticated members can write through PostgREST. Structural floor only: the positive shape (org/items/item/file) is enforced in ItemImagesService.record via lib/storage-path.ts, which is where the org and item ids are known. NOT VALID on purpose so the deploy cannot fail on legacy rows; production was verified clean, so `validate constraint` is safe as a separate step.';

comment on constraint item_images_thumb_path_safe on public.item_images is
  'HI-8 (0323). Same predicate as item_images_storage_path_safe, on the nullable thumb column. NULL is allowed (rows predating migration 0122 have no thumb).';

comment on constraint order_request_attachments_storage_path_safe on public.order_request_attachments is
  'HI-8 (0323). Structural traversal floor; OrderAttachmentsService.add enforces the positive {org}/{orderRequestId}/{file} shape. NOT VALID on purpose.';

comment on constraint po_attachments_storage_path_safe on public.po_attachments is
  'HI-8 (0323). Structural traversal floor. This column has a writer that BYPASSES the service entirely: the mobile PO-attachments screen inserts through PostgREST, so PoAttachmentsService.add''s new shape check never runs for it and this constraint is the only path guard that does. NOT VALID on purpose.';

comment on constraint po_imports_storage_path_safe on public.po_imports is
  'HI-8 (0323). Structural traversal floor. parseImport DOWNLOADS whatever this column names, so a traversal value here is an arbitrary-object read whose extracted text lands in the import. PoImportsService.createFromUpload enforces the positive {org}/po-imports/{file} shape. NOT VALID on purpose.';

comment on constraint procedure_videos_storage_path_safe on public.procedure_videos is
  'HI-8 (0323). Structural traversal floor; ProcedureVideosService.record enforces the positive {org}/{procedureId}/{file} shape. Signing here uses the SERVICE-ROLE client, so RLS cannot backstop a bad path. NOT VALID on purpose.';

comment on constraint procedure_videos_thumbnail_path_safe on public.procedure_videos is
  'HI-8 (0323). Same predicate as procedure_videos_storage_path_safe, on the nullable poster column. NULL is allowed (a video records without a poster when capture fails).';

comment on constraint maintenance_request_attachments_storage_path_safe on public.maintenance_request_attachments is
  'HI-8 (0323). Structural traversal floor. The service-layer guard (validateFinalizePath, the reference implementation) is not reachable from a direct PostgREST insert, which 0314/0317''s INSERT policy permits for a request''s own requester — this constraint covers that writer. NOT VALID on purpose.';

comment on constraint maintenance_request_attachments_thumbnail_path_safe on public.maintenance_request_attachments is
  'HI-8 (0323). Same predicate on the nullable thumbnail column.';
