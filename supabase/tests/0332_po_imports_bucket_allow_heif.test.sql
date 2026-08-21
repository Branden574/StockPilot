-- supabase/tests/0332_po_imports_bucket_allow_heif.test.sql
-- pgTAP tests for migration 0332 — 'image/heif' added to the po-imports
-- bucket pin that 0325 established.
--
-- WHY A TEST FOR A ONE-ENTRY WIDENING
-- `allowed_mime_types` is a whole-array column: any future migration that
-- wants to add one type has to rewrite the WHOLE list, and the failure mode of
-- that pattern is dropping an entry by omission — silently, with no error,
-- turning a working upload path into a bucket-door refusal that only shows up
-- in the field. INV-24 cannot catch it: it only asserts the pin is non-null.
-- So the assertions below are per-entry membership, plus a cardinality pin so
-- a REPLACEMENT (rather than an addition) is caught too.
--
-- The heic/heif PAIR is asserted as a pair on purpose. They label the same
-- ISO-BMFF picture and the browser picks which one it sends, so a pin holding
-- exactly one of them is a coin-flip refusal, not a policy.
--
-- No fixtures, no writes: this reads one catalog row. Wrapped in
-- begin/rollback like every other file here.

begin;

select plan(7);

-- ─────────────────────────────────────────────────────────────────────────
-- The pin still exists and is still a pin (INV-24's property, locally)
-- ─────────────────────────────────────────────────────────────────────────
select isnt(
  (select allowed_mime_types from storage.buckets where id = 'po-imports'),
  null,
  '0332: po-imports still PINS allowed_mime_types (never widened to null)'
);

-- ─────────────────────────────────────────────────────────────────────────
-- The widening itself
-- ─────────────────────────────────────────────────────────────────────────
select ok(
  'image/heif' = any (
    select unnest(allowed_mime_types) from storage.buckets where id = 'po-imports'
  ),
  '0332: po-imports accepts image/heif'
);

select ok(
  'image/heic' = any (
    select unnest(allowed_mime_types) from storage.buckets where id = 'po-imports'
  ),
  '0332: po-imports still accepts image/heic — heif was ADDED, not swapped in'
);

-- ─────────────────────────────────────────────────────────────────────────
-- Nothing 0325 established was dropped by the array rewrite
-- ─────────────────────────────────────────────────────────────────────────
select is(
  (
    select array_agg(t order by t)
    from (
      select unnest(allowed_mime_types) as t
      from storage.buckets where id = 'po-imports'
    ) s
  ),
  array[
    'application/csv',
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/heic',
    'image/heif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/csv',
    'text/plain'
  ],
  -- UPDATED BY 0344, which replaced `text/*` with explicit types. The wildcard
  -- matched text/html, and objects here are served from the storage origin
  -- with their stored mime — so declaring text/html was enough to host a
  -- rendering page on our own domain. `text/plain` is kept deliberately:
  -- operating systems label .csv as text/plain often enough that dropping it
  -- would reject real imports, and plain text carries no active content.
  --
  -- This assertion did its job. It is a literal pin, so widening the bucket
  -- could not happen quietly — it failed CI the moment 0344 landed.
  '0344: the po-imports pin is EXACTLY the explicit set that replaced text/*'
);

-- A separate cardinality assertion so a future rewrite that both adds and
-- drops an entry fails on the count even if someone updates the list above.
select is(
  (select array_length(allowed_mime_types, 1)
     from storage.buckets where id = 'po-imports'),
  11,
  '0344: po-imports pins exactly 11 content types — no wildcard among them'
);

-- THE PROPERTY 0344 EXISTS FOR, asserted directly rather than only implied by
-- the list above: no entry may be a wildcard, and text/html must not be
-- reachable. A future edit that reintroduces `text/*` would satisfy neither.
select is(
  (select count(*) from (
     select unnest(allowed_mime_types) as t
       from storage.buckets where id = 'po-imports'
   ) s where t like '%*%'),
  0::bigint,
  '0344: no wildcard survives in the po-imports allowlist'
);

select ok(
  not ('text/html' = any(
    select unnest(allowed_mime_types) from storage.buckets where id = 'po-imports'
  )),
  '0344: text/html is not declarable against po-imports'
);

select * from finish();
rollback;
