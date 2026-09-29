-- 0381_item_images_item_scope.sql
--
-- Item photos follow the item. A photo row, and the stored photo file, is
-- readable only by someone who can read its item, and writable only by
-- someone who can read AND change that item, at a path that names it.
--
-- No table, column, index, trigger or data change. Five helper functions
-- (four SECURITY INVOKER; one read-only SECURITY DEFINER set for the bucket
-- read policy, section 3), their comments and grants, and a policy swap:
--   public.item_images   item_images_select (replaced),
--                        item_images_write (FOR ALL) replaced by
--                        item_images_insert / _update / _delete;
--   storage.objects      the four item-images policies (replaced, same names).
--
-- ── THE HOLE ────────────────────────────────────────────────────────────────
-- item_images_select (0003, wrapped by 0140) was is_org_member(org), and the
-- bucket's read policy (0003/0140) was is_org_member(first folder), while
-- inventory_items_select (0229) is narrower: staff and viewers see only the
-- items of their warehouses and charters, and a category-scoped viewer only
-- their categories. #290 (fb16dc5c) stopped the WEB from signing photos of
-- unreadable items, but a member's OWN client (the phone, or the anon key
-- with their JWT) still:
--   * listed every item_images row of the organization,
--   * signed, downloaded and listed every object in the org's folder.
-- item_images_write was has_org_role(staff) for ANY row and ANY path (0323's
-- CHECKs are structural only), and the bucket's write policies were
-- has_org_role(staff) on the org folder, so warehouse-scoped staff could add,
-- repoint, update and delete photo rows of other warehouses' items, upload or
-- overwrite objects in any item's folder, remove any object, and file a row
-- in their own org whose item_id and path name ANOTHER org's item and object.
-- All of it reproduced on the local stack on 2026-09-29 with each persona's
-- own client (stockpilot-work/sec-image2/leak-before.txt).
--
-- ── THE PATHS THAT EXIST (production, read-only SELECT, 2026-09-29) ─────────
-- Every writer was read: web ItemImagesService.createUploadUrl mints
-- {org}/items/{item}/{uuid}.{ext} and {uuid}-thumb.webp; the phone (new item,
-- item detail replace, scan capture) uploads {org}/items/{item}/{rand}.{ext};
-- the books import cover rehost writes {org}/{item}/cover.{ext}; the thumb
-- backfill, demo seed and perf lab use the service role. Maintenance, orders,
-- POs, rentals and exception evidence use their own buckets. In production
-- all 1,176 objects, all 655 storage_path values and all 559 thumb_path
-- values match exactly one of the two shapes below (1,014 + 162 objects).
--   A  {org}/items/{item}/{file}
--   B  {org}/{item}/{file}                      (books import covers)
-- with lowercase uuids as Postgres and randomUUID() write them, and {file}
-- word characters then one or more .extensions (a superset of lib/
-- storage-path.ts's OBJECT_FILENAME_SEGMENT; section 1 says why).
--
-- ── DUPLICATED ITEMS SHARE FILES ────────────────────────────────────────────
-- duplicate_inventory_item (0125/0299, SECURITY INVOKER) copies the source's
-- item_images rows onto the new item with the SAME storage_path/thumb_path,
-- so the new item's row names the SOURCE item in its path. Production has 24
-- such rows (one org, every one written in the same second as its duplicate
-- item, 21 with the duplicate stock movement); 2 of them now sit in a
-- different charter from their source. So:
--   * read: an object is readable when the item its path names is readable,
--     OR a photo row the caller can read names it (the duplicate's photo is
--     that file). A row the caller can read is itself pinned to a readable
--     item, and new rows can only name objects of items their writer could
--     read, so this grants nothing the writer could not already see.
--   * write: a row's path must name the row's own item, or another item of
--     the same org that the caller can read (the duplicate shape).
--
-- ── WHO SEES WHAT AFTER ─────────────────────────────────────────────────────
-- Owners, admins and managers read every item of their org that has a
-- warehouse (inventory_items_select), and production has no item without one
-- and no photo row whose item is in another org (0 of 655), so they see
-- exactly the rows they saw: L4L 622 -> 622, Demo Co 33 -> 33. Objects: L4L
-- 1,110 -> 1,109, Demo Co 66 -> 66; the one L4L object is the file of a
-- hard-deleted item that no row names, so nothing renders it. The service
-- role (web signing, /r, /p/items, exports, PDFs, the storefront loader,
-- prewarm, backfills) bypasses RLS and is unchanged.
--
-- ── WRITE RULE ──────────────────────────────────────────────────────────────
-- "Can change the item" is inventory_items_update's USING, restated in
-- item_image_item_writable (keep the two in step): the staff role or
-- items:update, and the manager role, a null warehouse, or write access to
-- the item's warehouse. The EXISTS it runs is itself filtered by
-- inventory_items_select, so writable implies readable (an UPDATE on
-- inventory_items needs both too). This is what ItemImagesService already
-- asserts (items:update) plus the item's scope; the old rule was the staff
-- role alone, so no one who could write a photo of an item they can change
-- loses that.
--
-- ── PERFORMANCE ─────────────────────────────────────────────────────────────
-- item_images_select is one pkey probe per row into inventory_items, whose
-- policy is 0229's hashed sets (built once per statement). The bucket read
-- policy is one pkey probe per object for the path's item; the shared-file
-- branch is a hashed set built at most once per statement, only when the
-- probe refuses an object (section 3 says why it is not an EXISTS). Measured
-- on the local stack at ten times L4L's volume (stockpilot-work/sec-image2/
-- perf-*.txt).
--
-- Rules: lock_timeout 5s; DROP POLICY IF EXISTS + CREATE POLICY in this one
-- transaction; CREATE OR REPLACE FUNCTION; COMMENT (public objects only);
-- GRANT/REVOKE. Nothing here raises, so never 40001/40P01.

set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Path parsing
-- ═══════════════════════════════════════════════════════════════════════════
-- The item a photo path names, for shape A or B, or null for anything else
-- (another shape, uppercase, a traversal, an extra folder, a name over the
-- 400-character cap of 0323). One anchored regex, so a name that is not
-- exactly one of the two shapes names no item and every policy below refuses
-- it; the regex guarantees the segment cast to uuid is one, so the cast
-- cannot fail.
--
-- Used by every write rule and the row path check. A boolean `~` with no
-- capture group, then split_part: a capturing substring() of the same
-- pattern with the app's {1,120}/{1,3} bounds cost ~120 us per name locally,
-- this ~7 us. The file segment is therefore "word characters, then one or
-- more .extensions" with the whole name capped at 400, a superset of lib/
-- storage-path.ts's OBJECT_FILENAME_SEGMENT that still cannot express a
-- traversal, a percent sign, a backslash or a further folder. The bucket
-- READ policy does not call it (section 5 reads the item segment inline, at
-- ~2 us, because a listing runs that policy on every object it walks).
create or replace function public.item_image_path_item_id(p_name text)
returns uuid
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when length(p_name) <= 400
     and p_name ~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                   || '/(?:items/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                   || '/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)+$')
    then (case when split_part(p_name, '/', 2) = 'items'
               then split_part(p_name, '/', 3)
               else split_part(p_name, '/', 2) end)::uuid
  end;
$$;

comment on function public.item_image_path_item_id(text) is
  'The item an item-images path names: {org}/items/{item}/{file} or the books '
  'import {org}/{item}/{file}; null for any other name (0381). Pure parse.';

-- The org a photo path names (its first folder), only when the whole name is
-- one of the two shapes; null otherwise.
create or replace function public.item_image_path_org_id(p_name text)
returns uuid
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when public.item_image_path_item_id(p_name) is not null
      then split_part(p_name, '/', 1)::uuid
  end;
$$;

comment on function public.item_image_path_org_id(text) is
  'The org an item-images path names (first folder), when the whole name is '
  'one of the two photo shapes; null otherwise (0381). Pure parse.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. "Can the caller change this item's photos?"
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER on purpose: the EXISTS reads inventory_items under the
-- caller's own inventory_items_select, so this can never answer true for an
-- item the caller cannot read. The rest is inventory_items_update's USING
-- (0212), restated for one item; keep the two in step.
create or replace function public.item_image_item_writable(p_org uuid, p_item uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select p_org is not null and p_item is not null and exists (
    select 1
      from public.inventory_items i
     where i.id = p_item
       and i.organization_id = p_org
       and (public.has_org_role(i.organization_id, 'staff')
            or public.has_permission(i.organization_id, 'items:update'))
       and (public.has_org_role(i.organization_id, 'manager')
            or i.warehouse_id is null
            or public.user_can_access_warehouse(auth.uid(), i.warehouse_id, 'write'))
  );
$$;

comment on function public.item_image_item_writable(uuid, uuid) is
  'True when the caller can read the item (inventory_items RLS) and change it '
  '(inventory_items_update''s rule: staff or items:update, and manager, no '
  'warehouse, or warehouse write access), in that org (0381). SECURITY INVOKER.';

-- A path a photo ROW of (p_org, p_item) may carry: in p_org's folder, one of
-- the two shapes, naming p_item itself or, for a duplicated item's shared
-- file, another item of the same org that the caller can read.
create or replace function public.item_image_row_path_ok(p_org uuid, p_item uuid, p_path text)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    public.item_image_path_org_id(p_path) = p_org
    and (public.item_image_path_item_id(p_path) = p_item
         or exists (
           select 1
             from public.inventory_items i
            where i.id = public.item_image_path_item_id(p_path)
              and i.organization_id = p_org)),
    false);
$$;

comment on function public.item_image_row_path_ok(uuid, uuid, text) is
  'True when an item_images row of (org, item) may carry this path: the org''s '
  'folder, a photo shape, naming this item or (duplicate_inventory_item''s '
  'shared file) another item of the org the caller can read (0381).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Shared (duplicated) files the caller may read, as one hashed set
-- ═══════════════════════════════════════════════════════════════════════════
-- The bucket read policy's second branch: the paths that a photo row carries
-- although they are not in that row's own item folder (duplicate_inventory_
-- item's shared files; 24 rows in production), for rows whose item the
-- caller can read.
--
-- Why a set function and not an EXISTS on item_images inside the policy.
-- The Storage API's folder listing (storage.search) filters with operators
-- that are not leakproof (ILIKE; lower(name) COLLATE "C" range tests), so the
-- read policy runs on every object the listing walks before the prefix is
-- applied, one statement per listed entry. A correlated EXISTS over item_images (no index
-- on its paths, and 0381 adds none) then costs one scan of item_images per
-- object the first branch refuses: measured on the local stack at ten times
-- L4L's volume, a warehouse-scoped staff member's single list() call took
-- ~7 s. As `name in (select ...)` this is an uncorrelated hashed subplan,
-- built at most once per statement and only when the first branch refuses an
-- object in one of the caller's own orgs, so signing or listing readable
-- photos never builds it. Measured: ~2 ms at 6,400 photo rows (ten times
-- L4L), ~0.2 ms at production volume.
--
-- SECURITY DEFINER so the scan can use a cheap filter first (the row's own
-- item id does not appear in its master path) instead of evaluating
-- item_images' policy on every row; the caller's scope is then applied to the few rows
-- left by caller_can_read_item (0361: inventory_items_select's predicate for
-- DEFINER callers), plus the row-org checks the policy states. It answers
-- only for auth.uid() and returns nothing without one.
create or replace function public.rls_item_image_shared_paths()
returns setof text
language sql
stable
security definer
set search_path = public
rows 50
as $$
  -- MATERIALIZED fences the cheap row filter (the row's own item id does not
  -- appear in its master path): without the fence the planner pushes the
  -- per-item scope check below it and runs it for every photo row (measured:
  -- 3 s instead of ~1.5 ms at 6,400 rows). Only the master path is scanned:
  -- duplicate_inventory_item copies master and thumb together, and a row
  -- whose master is in its own folder reads its thumb through the policy's
  -- first branch like any other (no writer produces anything else).
  with shared_rows as materialized (
    select ii.item_id, ii.organization_id, ii.storage_path, ii.thumb_path
      from public.item_images ii
     where strpos(ii.storage_path, ii.item_id::text) = 0
  )
  select p.path
    from shared_rows s
   cross join lateral (values (s.storage_path), (s.thumb_path)) p(path)
   where p.path is not null
     and strpos(p.path, s.item_id::text) = 0
     and (select auth.uid()) is not null
     and split_part(p.path, '/', 1) = s.organization_id::text
     and exists (select 1 from public.inventory_items i
                  where i.id = s.item_id and i.organization_id = s.organization_id)
     and public.caller_can_read_item(s.item_id);
$$;

comment on function public.rls_item_image_shared_paths() is
  'RLS helper (0381): paths carried by item_images rows outside their own item '
  'folder (duplicated items'' shared files), for rows whose item the caller can '
  'read (caller_can_read_item). For a hashed IN in the item-images read policy.';

revoke all on function public.item_image_path_item_id(text) from public, anon;
revoke all on function public.item_image_path_org_id(text) from public, anon;
revoke all on function public.item_image_item_writable(uuid, uuid) from public, anon;
revoke all on function public.item_image_row_path_ok(uuid, uuid, text) from public, anon;
revoke all on function public.rls_item_image_shared_paths() from public, anon;
grant execute on function public.item_image_path_item_id(text) to authenticated, service_role;
grant execute on function public.item_image_path_org_id(text) to authenticated, service_role;
grant execute on function public.item_image_item_writable(uuid, uuid) to authenticated, service_role;
grant execute on function public.item_image_row_path_ok(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.rls_item_image_shared_paths() to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. public.item_images
-- ═══════════════════════════════════════════════════════════════════════════
-- Read: the row's item is readable (the EXISTS runs under
-- inventory_items_select) and in the row's org. A readable item implies an
-- accepted, enabled membership of that org, so is_org_member adds nothing.
--
-- The org is compared with IS NOT DISTINCT FROM (both columns are NOT NULL,
-- so it means `=`) on purpose: an all-equality correlation lets the planner
-- turn this EXISTS into a hashed ANY over EVERY item the caller can read,
-- built per statement (~1.5 ms at 6,400 items, measured), which made the
-- phone's 50-row photo read slower than the old policy. This form keeps one
-- pkey probe per photo row. Do not "simplify" it back to `=`.
drop policy if exists item_images_select on public.item_images;
create policy item_images_select on public.item_images
  for select to authenticated
  using (exists (
    select 1
      from public.inventory_items i
     where i.id = item_images.item_id
       and i.organization_id is not distinct from item_images.organization_id));

comment on policy item_images_select on public.item_images is
  'A photo row is visible exactly when its item is (inventory_items RLS), in '
  'the row''s org (0381; was every org member, 0003/0140).';

-- Writes: split from the old FOR ALL policy so that SELECT is decided by
-- item_images_select alone (a FOR ALL USING also grants reads).
drop policy if exists item_images_write on public.item_images;
drop policy if exists item_images_insert on public.item_images;
drop policy if exists item_images_update on public.item_images;
drop policy if exists item_images_delete on public.item_images;

create policy item_images_insert on public.item_images
  for insert to authenticated
  with check (
    public.item_image_item_writable(organization_id, item_id)
    and public.item_image_row_path_ok(organization_id, item_id, storage_path)
    and (thumb_path is null
         or public.item_image_row_path_ok(organization_id, item_id, thumb_path)));

create policy item_images_update on public.item_images
  for update to authenticated
  using (public.item_image_item_writable(organization_id, item_id))
  with check (
    public.item_image_item_writable(organization_id, item_id)
    and public.item_image_row_path_ok(organization_id, item_id, storage_path)
    and (thumb_path is null
         or public.item_image_row_path_ok(organization_id, item_id, thumb_path)));

create policy item_images_delete on public.item_images
  for delete to authenticated
  using (public.item_image_item_writable(organization_id, item_id));

comment on policy item_images_insert on public.item_images is
  'Only for an item the caller can read and change, with paths in the org''s '
  'folder naming that item (or a readable item of the org: duplicates) (0381).';
comment on policy item_images_update on public.item_images is
  'Only rows of an item the caller can read and change, and the new row obeys '
  'item_images_insert''s rule (0381).';
comment on policy item_images_delete on public.item_images is
  'Only rows of an item the caller can read and change (0381).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. storage.objects, bucket item-images (same policy names as 0140)
-- ═══════════════════════════════════════════════════════════════════════════
-- Read (sign, download, list): the item the path names is readable and in
-- the path's org (one pkey probe under the caller's inventory_items RLS), or
-- the object is a duplicated item's shared file named by a photo row the
-- caller can read (the hashed set above, consulted only when the probe
-- refuses an object in one of the caller's own orgs: rls_member_org_ids is
-- a tiny hashed set, so another org's objects never build it).
--
-- Written for the hot path. The Storage API's listing filters with
-- non-leakproof operators, so this runs on every object a listing walks, one
-- statement per entry:
--   * the item id is read straight out of the name (the item folder segment
--     of either shape) and cast only when it is a lowercase uuid, instead of
--     calling item_image_path_item_id: ~2 us per object against ~9 us (the
--     function's full-shape regex and its search_path wrapper). Reading
--     needs only "which item"; the full shape is enforced on every write.
--     A name in no photo shape yields no uuid, or an id no item has.
--   * the org check is starts_with(name, org || '/'), a text test (no name
--     can raise a cast error) that is also deliberately not an equality:
--     with only equalities the planner turns the EXISTS into a hashed ANY
--     over every item the caller can read, rebuilt for EVERY statement (a
--     100-entry list went from ~120 ms to ~800 ms at 6,400 items, measured).
--     This keeps one pkey probe per object.
drop policy if exists "item-images authenticated read" on storage.objects;
create policy "item-images authenticated read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'item-images'
    and (
      exists (
        select 1
          from public.inventory_items i
         where i.id = (case
                         when split_part(objects.name, '/',
                                case when split_part(objects.name, '/', 2) = 'items' then 3 else 2 end)
                              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then split_part(objects.name, '/',
                                case when split_part(objects.name, '/', 2) = 'items' then 3 else 2 end)::uuid
                       end)
           and starts_with(objects.name, i.organization_id::text || '/'))
      or (split_part(objects.name, '/', 1) in (select m::text from public.rls_member_org_ids() m)
          and objects.name in (select public.rls_item_image_shared_paths()))
    ));

-- Writes: the object's path names an item the caller can read and change,
-- in that item's org. Upload (INSERT; a signed upload URL is checked here
-- when it is minted), upsert/overwrite (UPDATE), remove (DELETE).
drop policy if exists "item-images staff write" on storage.objects;
create policy "item-images staff write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and public.item_image_item_writable(
          public.item_image_path_org_id(objects.name),
          public.item_image_path_item_id(objects.name)));

drop policy if exists "item-images staff update" on storage.objects;
create policy "item-images staff update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'item-images'
    and public.item_image_item_writable(
          public.item_image_path_org_id(objects.name),
          public.item_image_path_item_id(objects.name)))
  with check (
    bucket_id = 'item-images'
    and public.item_image_item_writable(
          public.item_image_path_org_id(objects.name),
          public.item_image_path_item_id(objects.name)));

drop policy if exists "item-images staff delete" on storage.objects;
create policy "item-images staff delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'item-images'
    and public.item_image_item_writable(
          public.item_image_path_org_id(objects.name),
          public.item_image_path_item_id(objects.name)));

-- No COMMENT ON POLICY here: storage.objects belongs to the storage admin
-- role on the hosted project, and no migration has ever commented one of its
-- policies; the rules are documented above instead.

reset lock_timeout;
