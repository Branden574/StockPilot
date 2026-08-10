-- supabase/tests/0323_storage_path_shape_constraints.test.sql
-- Proves migration 0323 — the DATABASE floor under Wave D's storage-path
-- traversal class (HI-8).
--
-- WHAT IS BEING PROVEN, AND WHY IT IS NOT THE SAME AS THE APP FIX
--   Wave D replaced five `path.startsWith('<org>/')` checks with strict
--   positive shapes in the service layer. That layer is bypassable: the mobile
--   PO-attachments screen inserts into public.po_attachments DIRECTLY through
--   PostgREST, and maintenance_request_attachments' INSERT policy admits a
--   requester writing its own row. This migration is what covers those writers.
--   So every negative below is a DIRECT INSERT — the bypass route — not a
--   service call.
--
-- THE VACUITY PROBLEM
--   "the hostile insert failed" proves nothing on its own: a typo'd column, a
--   missing fixture or an unrelated NOT NULL would fail too, and the test would
--   still pass. So every refusal is asserted with its SQLSTATE (23514, a check
--   violation specifically) and is PAIRED with a `lives_ok` proving the same
--   table accepts the LEGITIMATE minted path for the same fixtures. A
--   constraint that refused everything would fail those positives.
--
-- THE PROPERTY, NOT THE IMPLEMENTATION
--   The assertions are written against what must be TRUE (a path that can climb
--   out of its bucket is refused; a path a real uploader mints is accepted),
--   never against the predicate's spelling. Rewriting the check from
--   `position()` to `like` or to a regex must keep every test below passing.
--
-- ONE THING THIS DELIBERATELY DOES NOT TEST
--   An embedded NUL. Postgres `text` cannot hold U+0000 at all — the server
--   raises `null character not permitted` (22021) while parsing the literal,
--   before any constraint is consulted. The NUL leg of the traversal alphabet
--   is therefore closed by the type, not by this constraint, and asserting it
--   here would be asserting Postgres's own behavior. The `[[:cntrl:]]` leg is
--   still exercised, via newline and DEL.
--
-- Fixtures inserted as postgres (bypassing RLS — a CHECK constraint is not an
-- RLS boundary, so no session-role dance is needed). Literals are hardcoded
-- inside the throws_ok/lives_ok bodies per house convention (see 0316).
--
-- Namespace: a0323000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(16);

\set org    '\'a0323000-0000-0000-0000-000000000001\''
\set usr    '\'a0323000-0000-0000-0000-0000000000a1\''
\set item   '\'a0323000-0000-0000-0000-0000000000b1\''
\set po     '\'a0323000-0000-0000-0000-0000000000d1\''
\set req    '\'a0323000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:usr, 'storage-path-shape-0323@test.local', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  (:org, 'Storage Path Shape Org', 'storage-path-shape-org-0323');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :usr, 'admin', now());

insert into public.inventory_items (id, organization_id, sku, name) values
  (:item, :org, 'SPS-0323-001', 'Storage Path Shape Item');

insert into public.purchase_orders (id, organization_id, po_number) values
  (:po, :org, 'PO-0323-001');

insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description)
values
  (:req, :org, :usr, 'Shape Tester', 'Broken shelf', 'The middle shelf sags.');


-- ─────────────────────────────────────────────────────────────────────────
-- 1-2. All nine constraints exist, and every one of them is NOT VALID.
--
--   The NOT VALID assertion is a real requirement, not trivia: a future
--   migration that re-adds one of these as VALIDATING would take an ACCESS
--   EXCLUSIVE lock and full-scan the table on deploy, which is exactly the
--   outage 0323's header declines to risk. `convalidated = false` is how that
--   decision is pinned so a change has to be deliberate.
-- ─────────────────────────────────────────────────────────────────────────
select is(
  (select count(*)::int
     from pg_constraint
    where contype = 'c'
      and conname in (
        'item_images_storage_path_safe',
        'item_images_thumb_path_safe',
        'order_request_attachments_storage_path_safe',
        'po_attachments_storage_path_safe',
        'po_imports_storage_path_safe',
        'procedure_videos_storage_path_safe',
        'procedure_videos_thumbnail_path_safe',
        'maintenance_request_attachments_storage_path_safe',
        'maintenance_request_attachments_thumbnail_path_safe'
      )),
  9,
  'all nine storage-path CHECK constraints exist'
);

select is(
  (select count(*)::int
     from pg_constraint
    where contype = 'c'
      and convalidated
      and conname in (
        'item_images_storage_path_safe',
        'item_images_thumb_path_safe',
        'order_request_attachments_storage_path_safe',
        'po_attachments_storage_path_safe',
        'po_imports_storage_path_safe',
        'procedure_videos_storage_path_safe',
        'procedure_videos_thumbnail_path_safe',
        'maintenance_request_attachments_storage_path_safe',
        'maintenance_request_attachments_thumbnail_path_safe'
      )),
  0,
  'every one is NOT VALID on purpose — none was added as a validating constraint'
);


-- ─────────────────────────────────────────────────────────────────────────
-- 3. THE PAIRED POSITIVE, FIRST. The exact path
--    ItemImagesService.createUploadUrl mints is accepted. Every refusal
--    below is only meaningful because this passes.
-- ─────────────────────────────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path, thumb_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/items/a0323000-0000-0000-0000-0000000000b1/11111111-1111-4111-8111-111111111111.webp',
       'a0323000-0000-0000-0000-000000000001/items/a0323000-0000-0000-0000-0000000000b1/11111111-1111-4111-8111-111111111111-thumb.webp'
     ) $$,
  'the real minted item-image master + thumb pair is accepted'
);

-- The books-import cover rehost writes the SHORTER {org}/{item}/cover.{ext}
-- form directly. It must keep working — this constraint is structural and must
-- not encode one surface's convention as the only legal one.
select lives_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/a0323000-0000-0000-0000-0000000000b1/cover.jpg'
     ) $$,
  'the books-import {org}/{item}/cover.jpg convention is accepted'
);

-- A row with NO thumb (predates migration 0122) must still insert.
select lives_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path, thumb_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/items/a0323000-0000-0000-0000-0000000000b1/22222222-2222-4222-8222-222222222222.webp',
       null
     ) $$,
  'a null thumb_path is still accepted (rows predating 0122 have none)'
);


-- ─────────────────────────────────────────────────────────────────────────
-- 4. THE PROVEN EXPLOIT. The literal traversal from the finding: a path that
--    passes `startsWith('<org>/')` and, once @supabase/storage-js
--    interpolates it into a fetch() URL, resolves OUT of the org folder and
--    OUT of the bucket. 23514 = check_violation specifically.
-- ─────────────────────────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/../../item-images/victim-org/victim-item/cover.jpg'
     ) $$,
  '23514', null,
  'a `..` traversal out of the org folder and bucket is refused'
);

-- The percent-encoded form. Storage clients percent-decode downstream, so a
-- denylist that only knew about a literal `..` would let this through.
select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/%2e%2e/%2e%2e/order-attachments/victim/proof.jpg'
     ) $$,
  '23514', null,
  'the %2e%2e-encoded traversal is refused'
);

-- Double-encoded, for a decode that happens twice on the way down.
select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/%252e%252e/item-images/victim/x.jpg'
     ) $$,
  '23514', null,
  'the double-encoded %252e%252e traversal is refused'
);

select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       '/a0323000-0000-0000-0000-000000000001/items/a0323000-0000-0000-0000-0000000000b1/x.jpg'
     ) $$,
  '23514', null,
  'an absolute path (leading slash) is refused'
);

select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001//items/a0323000-0000-0000-0000-0000000000b1/x.jpg'
     ) $$,
  '23514', null,
  'an empty segment (//) is refused'
);

-- A newline appended after a legitimate-looking path — the trailing-newline
-- smuggle. Proves the [[:cntrl:]] leg actually bites.
select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/items/a0323000-0000-0000-0000-0000000000b1/x.jpg' || chr(10)
     ) $$,
  '23514', null,
  'a trailing newline is refused (the [[:cntrl:]] leg bites)'
);

select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       repeat('a', 401)
     ) $$,
  '23514', null,
  'an over-length path (401 chars, cap is 400) is refused'
);

-- The THUMB column carries the same guard. It is a separate constraint, so it
-- needs its own proof — a valid master paired with a hostile thumb is the
-- realistic shape of this one (the master passes review, the thumb does not).
select throws_ok(
  $$ insert into public.item_images (organization_id, item_id, storage_path, thumb_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000b1',
       'a0323000-0000-0000-0000-000000000001/items/a0323000-0000-0000-0000-0000000000b1/33333333-3333-4333-8333-333333333333.webp',
       'a0323000-0000-0000-0000-000000000001/../../org-logos/victim-org/logo.png'
     ) $$,
  '23514', null,
  'a traversal in thumb_path is refused even when storage_path is legitimate'
);


-- ─────────────────────────────────────────────────────────────────────────
-- 5. po_attachments — the column where this constraint is the ONLY path
--    guard, because the mobile uploader inserts here through PostgREST and
--    never reaches PoAttachmentsService.add. Both directions.
-- ─────────────────────────────────────────────────────────────────────────
select lives_ok(
  $$ insert into public.po_attachments (organization_id, purchase_order_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000d1',
       'a0323000-0000-0000-0000-000000000001/a0323000-0000-0000-0000-0000000000d1/k3j4h5g6f7d8.pdf'
     ) $$,
  'the mobile PO-attachment mint (base36 filename) is accepted'
);

select throws_ok(
  $$ insert into public.po_attachments (organization_id, purchase_order_id, storage_path)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000d1',
       'a0323000-0000-0000-0000-000000000001/a0323000-0000-0000-0000-0000000000d1/../../../item-images/victim/cover.jpg'
     ) $$,
  '23514', null,
  'a traversal inserted DIRECTLY into po_attachments (the service-bypassing route) is refused'
);


-- ─────────────────────────────────────────────────────────────────────────
-- 6. maintenance_request_attachments — already guarded in the service, but
--    0314/0317's INSERT policy admits a requester writing the row directly,
--    which never reaches validateFinalizePath.
-- ─────────────────────────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename,
        mime_type, byte_size, uploaded_by)
     values (
       'a0323000-0000-0000-0000-000000000001',
       'a0323000-0000-0000-0000-0000000000c1',
       'a0323000-0000-0000-0000-000000000001/a0323000-0000-0000-0000-0000000000c1/../../item-images/victim/cover.jpg',
       'photo.jpg', 'photo.jpg', 'image/jpeg', 1234,
       'a0323000-0000-0000-0000-0000000000a1'
     ) $$,
  '23514', null,
  'a traversal inserted directly into maintenance_request_attachments is refused'
);

select * from finish();
rollback;
