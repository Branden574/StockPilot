-- supabase/tests/0261_public_request_links.test.sql
-- Proves migration 0261 (public catalog visibility P1):
--   S1. public_links:manage seeded for admin only.
--   S2. Column defaults: inventory_items.public_visibility='internal_only',
--       categories.public_visibility='public'.
--   S3. THE eligibility predicate public_link_eligible_items():
--       entry-based + public-pool inclusion; hidden/archived/deleted items,
--       internal-only categories, non-'public' pool items, non-orderable
--       warehouses, expired/inactive links, and the per-type toggles all
--       excluded; max_qty resolves entry cap ?? link default ?? null.
--   S4. RLS: org members read; viewer writes denied; admin writes allowed;
--       a viewer GRANTED public_links:manage writes (has_permission path);
--       cross-org isolation; entries can't reference another org's item.
-- Namespace ab026100. Wrapped in begin/rollback.

begin;

select plan(21);

\set orga      '\'ab026100-0000-0000-0000-00000000000a\''
\set orgb      '\'ab026100-0000-0000-0000-00000000000b\''
\set admin     '\'ab026100-0000-0000-0000-000000000001\''
\set viewer    '\'ab026100-0000-0000-0000-000000000002\''
\set outsider  '\'ab026100-0000-0000-0000-000000000003\''
\set wh1       '\'ab026100-0000-0000-0000-0000000000e1\''
\set wh2       '\'ab026100-0000-0000-0000-0000000000e2\''
\set whb       '\'ab026100-0000-0000-0000-0000000000e3\''
\set cat_pub   '\'ab026100-0000-0000-0000-0000000000ca\''
\set cat_int   '\'ab026100-0000-0000-0000-0000000000cb\''
\set book_entry    '\'ab026100-0000-0000-0000-0000000000f1\''
\set book_hidden   '\'ab026100-0000-0000-0000-0000000000f2\''
\set book_archived '\'ab026100-0000-0000-0000-0000000000f3\''
\set book_deleted  '\'ab026100-0000-0000-0000-0000000000f4\''
\set pool_pub      '\'ab026100-0000-0000-0000-0000000000f5\''
\set pool_intcat   '\'ab026100-0000-0000-0000-0000000000f6\''
\set pool_internal '\'ab026100-0000-0000-0000-0000000000f7\''
\set product_item  '\'ab026100-0000-0000-0000-0000000000f8\''
\set item_orgb     '\'ab026100-0000-0000-0000-0000000000f9\''
\set default_item  '\'ab026100-0000-0000-0000-0000000000fa\''
\set book_wh2      '\'ab026100-0000-0000-0000-0000000000fb\''
\set link_main     '\'ab026100-0000-0000-0000-0000000000a1\''
\set link_expired  '\'ab026100-0000-0000-0000-0000000000a2\''
\set link_inactive '\'ab026100-0000-0000-0000-0000000000a3\''
\set link_items    '\'ab026100-0000-0000-0000-0000000000a4\''
\set link_admin    '\'ab026100-0000-0000-0000-0000000000a5\''
\set link_grantee  '\'ab026100-0000-0000-0000-0000000000a6\''

-- ── Fixtures (seeded as the test superuser — RLS bypassed) ─────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:admin,    'plinks-admin-0261@test.local', '{}'::jsonb),
  (:viewer,   'plinks-view-0261@test.local',  '{}'::jsonb),
  (:outsider, 'plinks-out-0261@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orga, 'PLinks Org A', 'plinks-a-0261'),
  (:orgb, 'PLinks Org B', 'plinks-b-0261')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orga, :admin,    'admin',   now()),
  (:orga, :viewer,   'viewer',  now()),
  (:orgb, :outsider, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status, is_public_orderable) values
  (:wh1, :orga, 'PL Orderable',   'WH-PL1-0261', 'active', true),
  (:wh2, :orga, 'PL Internal',    'WH-PL2-0261', 'active', false),
  (:whb, :orgb, 'PL B Orderable', 'WH-PLB-0261', 'active', true)
  on conflict (id) do nothing;
insert into public.categories (id, organization_id, name, public_visibility) values
  (:cat_pub, :orga, 'PL Public Cat', 'public'),
  (:cat_int, :orga, 'PL Internal Cat', 'internal_only')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, item_type, category_id, public_visibility, deleted_at)
values
  -- entry-based book: eligible.
  (:book_entry,    :orga, :wh1, 'PL-0261-1', 'PL Entry Book',    10, 'active',   'none', 'book',    :cat_pub, 'internal_only', null),
  -- entry present but item hidden: NEVER eligible.
  (:book_hidden,   :orga, :wh1, 'PL-0261-2', 'PL Hidden Book',   10, 'active',   'none', 'book',    :cat_pub, 'hidden',        null),
  -- entry present but archived: not eligible.
  (:book_archived, :orga, :wh1, 'PL-0261-3', 'PL Archived Book', 10, 'archived', 'none', 'book',    :cat_pub, 'internal_only', null),
  -- entry present but soft-deleted: not eligible.
  (:book_deleted,  :orga, :wh1, 'PL-0261-4', 'PL Deleted Book',  10, 'active',   'none', 'book',    :cat_pub, 'internal_only', now()),
  -- pool item: public item in a public category → eligible WITHOUT an entry.
  (:pool_pub,      :orga, :wh1, 'PL-0261-5', 'PL Pool Book',     10, 'active',   'none', 'book',    :cat_pub, 'public',        null),
  -- pool blocked by internal-only CATEGORY.
  (:pool_intcat,   :orga, :wh1, 'PL-0261-6', 'PL IntCat Book',   10, 'active',   'none', 'book',    :cat_int, 'public',        null),
  -- pool blocked by ITEM not being 'public'.
  (:pool_internal, :orga, :wh1, 'PL-0261-7', 'PL Internal Book', 10, 'active',   'none', 'book',    :cat_pub, 'internal_only', null),
  -- non-book with an entry: eligibility depends on items_enabled.
  (:product_item,  :orga, :wh1, 'PL-0261-8', 'PL Product',       10, 'active',   'none', 'product', :cat_pub, 'internal_only', null),
  -- org B item (for the cross-org entry guard).
  (:item_orgb,     :orgb, :whb, 'PL-0261-9', 'PL B Item',        10, 'active',   'none', 'book',    null,     'internal_only', null),
  -- book parked in the NON-orderable warehouse (entry on link_main too).
  (:book_wh2,      :orga, :wh2, 'PL-0261-B', 'PL WH2 Book',      10, 'active',   'none', 'book',    :cat_pub, 'internal_only', null)
  on conflict (id) do nothing;

insert into public.public_request_links
  (id, organization_id, name, token_hash, active, expires_at, availability_display,
   books_enabled, items_enabled, include_public_pool, default_max_qty)
values
  (:link_main,     :orga, 'Main link',     encode(extensions.digest('ab026100tokenmain0000000000000000000000000000000000000000000001', 'sha256'), 'hex'), true,  null,                'exact',  true,  false, true,  10),
  (:link_expired,  :orga, 'Expired link',  encode(extensions.digest('ab026100tokenexp00000000000000000000000000000000000000000000002', 'sha256'), 'hex'), true,  now() - interval '1 day', 'bucket', true, false, true, null),
  (:link_inactive, :orga, 'Inactive link', encode(extensions.digest('ab026100tokenoff00000000000000000000000000000000000000000000003', 'sha256'), 'hex'), false, null,                'bucket', true,  false, true,  null),
  (:link_items,    :orga, 'Items link',    encode(extensions.digest('ab026100tokenitems000000000000000000000000000000000000000000004', 'sha256'), 'hex'), true,  null,                'bucket', false, true,  false, null)
  on conflict (id) do nothing;

insert into public.public_link_catalog_entries (link_id, item_id, max_qty_per_request) values
  (:link_main, :book_entry,    3),
  (:link_main, :book_hidden,   null),
  (:link_main, :book_archived, null),
  (:link_main, :book_deleted,  null),
  (:link_main, :book_wh2,      null),
  (:link_expired,  :book_entry, null),
  (:link_inactive, :book_entry, null),
  (:link_items, :book_entry,   null),
  (:link_items, :product_item, null)
  on conflict do nothing;

-- ── S1: permission seed ─────────────────────────────────────────────────────
select is(
  (select count(*)::int from public.role_default_permissions
    where permission = 'public_links:manage' and role = 'admin'),
  1, 'S1: public_links:manage seeded for admin');
select is(
  (select count(*)::int from public.role_default_permissions
    where permission = 'public_links:manage' and role in ('manager','staff','viewer')),
  0, 'S1b: public_links:manage NOT seeded for manager/staff/viewer');

-- ── S2: column defaults ─────────────────────────────────────────────────────
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, item_type)
values
  (:default_item, :orga, :wh1, 'PL-0261-A', 'PL Default Item', 1, 'active', 'none', 'book');
select is(
  (select public_visibility from public.inventory_items where id = :default_item),
  'internal_only',
  'S2: new inventory_items default public_visibility = internal_only');
insert into public.categories (id, organization_id, name)
  values ('ab026100-0000-0000-0000-0000000000cc', :orga, 'PL Default Cat');
select is(
  (select public_visibility from public.categories
    where id = 'ab026100-0000-0000-0000-0000000000cc'),
  'public',
  'S2b: categories default public_visibility = public');

-- ── S3: the eligibility predicate ───────────────────────────────────────────
-- Main link, orderable warehouse: entry-based book + pool book ONLY.
-- Hidden (even with an entry), archived, deleted, internal-category pool,
-- non-public pool, and the wh2 book are all out.
select set_eq(
  $$ select item_id from public.public_link_eligible_items(
       'ab026100-0000-0000-0000-0000000000a1', 'ab026100-0000-0000-0000-0000000000e1') $$,
  array['ab026100-0000-0000-0000-0000000000f1',
        'ab026100-0000-0000-0000-0000000000f5']::uuid[],
  'S3: link_main/wh1 = entry book + pool book, everything else excluded');

select is(
  (select max_qty from public.public_link_eligible_items(
     'ab026100-0000-0000-0000-0000000000a1', 'ab026100-0000-0000-0000-0000000000e1')
   where item_id = 'ab026100-0000-0000-0000-0000000000f1'),
  3, 'S3b: entry max_qty_per_request wins over the link default');
select is(
  (select max_qty from public.public_link_eligible_items(
     'ab026100-0000-0000-0000-0000000000a1', 'ab026100-0000-0000-0000-0000000000e1')
   where item_id = 'ab026100-0000-0000-0000-0000000000f5'),
  10, 'S3c: pool item falls back to link default_max_qty');

select is(
  (select count(*)::int from public.public_link_eligible_items(
     'ab026100-0000-0000-0000-0000000000a2', 'ab026100-0000-0000-0000-0000000000e1')),
  0, 'S3d: expired link yields nothing');
select is(
  (select count(*)::int from public.public_link_eligible_items(
     'ab026100-0000-0000-0000-0000000000a3', 'ab026100-0000-0000-0000-0000000000e1')),
  0, 'S3e: inactive link yields nothing');
select is(
  (select count(*)::int from public.public_link_eligible_items(
     'ab026100-0000-0000-0000-0000000000a1', 'ab026100-0000-0000-0000-0000000000e2')),
  0, 'S3f: non-orderable warehouse yields nothing (even with an entry)');

-- Per-type toggles: books_enabled=false + items_enabled=true → only the
-- product passes, even though the book has an entry on the same link.
select set_eq(
  $$ select item_id from public.public_link_eligible_items(
       'ab026100-0000-0000-0000-0000000000a4', 'ab026100-0000-0000-0000-0000000000e1') $$,
  array['ab026100-0000-0000-0000-0000000000f8']::uuid[],
  'S3g: per-type toggles — items-only link exposes the product, not the book');

-- Multi-link isolation: the pool book is eligible on link_main (pool on)
-- but NOT on link_items (pool off, no entry).
select is(
  (select count(*)::int from public.public_link_eligible_items(
     'ab026100-0000-0000-0000-0000000000a4', 'ab026100-0000-0000-0000-0000000000e1')
   where item_id = 'ab026100-0000-0000-0000-0000000000f5'),
  0, 'S3h: visible on one link does not mean visible on another');

-- ── S4: RLS ─────────────────────────────────────────────────────────────────
-- Viewer (org member) reads all of the org's links…
set local "request.jwt.claim.sub" to 'ab026100-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.public_request_links
    where organization_id = 'ab026100-0000-0000-0000-00000000000a'),
  4, 'S4: org viewer can read the org''s links');
-- …but cannot write links or entries.
select throws_ok(
  $$ insert into public.public_request_links (organization_id, name, token_hash)
       values ('ab026100-0000-0000-0000-00000000000a', 'Sneaky',
               encode(extensions.digest('ab026100tokensneak000000000000000000000000000000000000000000005', 'sha256'), 'hex')) $$,
  '42501', null,
  'S4b: viewer INSERT on public_request_links is rejected by RLS');
select throws_ok(
  $$ insert into public.public_link_catalog_entries (link_id, item_id)
       values ('ab026100-0000-0000-0000-0000000000a1',
               'ab026100-0000-0000-0000-0000000000f7') $$,
  '42501', null,
  'S4c: viewer INSERT on public_link_catalog_entries is rejected by RLS');
reset role;

-- Admin writes pass.
set local "request.jwt.claim.sub" to 'ab026100-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.public_request_links (id, organization_id, name, token_hash)
       values ('ab026100-0000-0000-0000-0000000000a5',
               'ab026100-0000-0000-0000-00000000000a', 'Admin link',
               encode(extensions.digest('ab026100tokenadmin000000000000000000000000000000000000000000006', 'sha256'), 'hex')) $$,
  'S4d: admin creates a link');
select lives_ok(
  $$ insert into public.public_link_catalog_entries (link_id, item_id, max_qty_per_request)
       values ('ab026100-0000-0000-0000-0000000000a5',
               'ab026100-0000-0000-0000-0000000000f6', 5) $$,
  'S4e: admin adds a catalog entry');
-- FK-org guard: an entry may not reference another org's item.
select throws_ok(
  $$ insert into public.public_link_catalog_entries (link_id, item_id)
       values ('ab026100-0000-0000-0000-0000000000a5',
               'ab026100-0000-0000-0000-0000000000f9') $$,
  '42501', null,
  'S4f: entry referencing another org''s item is rejected (item_in_org)');
reset role;

-- A viewer GRANTED public_links:manage passes the write RLS (has_permission).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  values ('ab026100-0000-0000-0000-00000000000a',
          'ab026100-0000-0000-0000-000000000002', 'public_links:manage', true);
set local "request.jwt.claim.sub" to 'ab026100-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.public_request_links (id, organization_id, name, token_hash)
       values ('ab026100-0000-0000-0000-0000000000a6',
               'ab026100-0000-0000-0000-00000000000a', 'Grantee link',
               encode(extensions.digest('ab026100tokengrant000000000000000000000000000000000000000000007', 'sha256'), 'hex')) $$,
  'S4g: viewer granted public_links:manage can create a link');
reset role;

-- Cross-org isolation: org B's manager sees none of org A's links/entries.
set local "request.jwt.claim.sub" to 'ab026100-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.public_request_links
    where organization_id = 'ab026100-0000-0000-0000-00000000000a'),
  0, 'S4h: cross-org member sees zero of org A''s links');
select is(
  (select count(*)::int from public.public_link_catalog_entries
    where link_id = 'ab026100-0000-0000-0000-0000000000a1'),
  0, 'S4i: cross-org member sees zero of org A''s catalog entries');
reset role;

select * from finish();
rollback;
