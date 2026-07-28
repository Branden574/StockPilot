-- supabase/tests/0298_product_groups_and_variants.test.sql
--
-- Proves 0298: the group overlay, the variant columns, the two headline
-- requirements scenarios, and the regression anchors that keep the most
-- shared table in the app intact.
--
-- Assertion index (53):
--    1-13  schema shape: the table exists, all ten variant columns exist,
--          product_groups owns NO quantity column, group_id is NULLABLE with
--          NO default (the "no backfill" structural anchor)
--   14-15  anti-vacuity / no-backfill: a plain item is ungrouped, and not one
--          row anywhere else in the database acquired a group_id
--   16-19  Model B (0234) is UNTOUCHED: byte-identical index definition, the
--          true-duplicate placement still 23505s, a legitimate second
--          placement still inserts, and jersey_number is in NO unique index
--   20-23  R2: shoe sizes 9/10/11 -> ONE group, per-size qty, ZERO serials
--   24-27  R3: jersey #12 in M(3) + XL(2) -> total 5, number repeats, not a
--          serial
--   28-33  jersey_number rules: '0','00','07','12','99' all accepted AND
--          preserved byte-for-byte; junk, empty and 5-digit rejected; the same
--          number repeats across GROUPS as well as across sizes
--   34-35  variant_size length guard
--   36-37  group_key uniqueness is per-ORG, not global
--   38-40  the new inventory_items indexes: inventory_items_group_idx pinned
--          byte-identically as NON-PARTIAL (a partial index cannot serve the
--          inventory_items_group_id_fkey RI probe), no partial index leads
--          with group_id at all, and the jersey-number index exists
--   41-47  RLS + view security: the roll-up view is security_invoker (a
--          default-owner view would leak every org's totals), a foreign org
--          sees neither the group nor its roll-up, the owning manager does,
--          and a foreign org CANNOT attach its item to my group (insert or
--          update) even though it can attach to its own
--   48-51  category visibility: an unrestricted member reads both groups
--          (positive control), a category-restricted viewer reads ZERO rows
--          for a group outside their whitelist, reads EXACTLY the whitelisted
--          one, and the roll-up view hides the same group
--   52-53  both new CHECKs end up VALIDATED: 0298 adds them NOT VALID (to keep
--          the 1.2 M-row scan off the ACCESS EXCLUSIVE window) and then
--          VALIDATEs them, so dropping the second statement would silently
--          leave constraints Postgres will not trust for planning
--
-- Namespace: 9e298000. Wrapped in begin/rollback - nothing leaks.

begin;

select plan(53);

\set org    '\'9e298000-0000-0000-0000-000000000001\''
\set usr    '\'9e298000-0000-0000-0000-000000000002\''
\set wh     '\'9e298000-0000-0000-0000-000000000003\''
\set gShoe  '\'9e298000-0000-0000-0000-000000000004\''
\set gJers  '\'9e298000-0000-0000-0000-000000000005\''
\set s9     '\'9e298000-0000-0000-0000-000000000006\''
\set s10    '\'9e298000-0000-0000-0000-000000000007\''
\set s11    '\'9e298000-0000-0000-0000-000000000008\''
\set j12m   '\'9e298000-0000-0000-0000-000000000009\''
\set j12xl  '\'9e298000-0000-0000-0000-000000000010\''
\set legacy '\'9e298000-0000-0000-0000-000000000011\''
\set orgB   '\'9e298000-0000-0000-0000-000000000012\''
\set mgrB   '\'9e298000-0000-0000-0000-000000000013\''
\set whB    '\'9e298000-0000-0000-0000-000000000014\''
\set gJersB '\'9e298000-0000-0000-0000-000000000015\''
\set gJers2 '\'9e298000-0000-0000-0000-000000000016\''
\set j12alt '\'9e298000-0000-0000-0000-000000000017\''
\set vwr    '\'9e298000-0000-0000-0000-000000000018\''
\set catVis '\'9e298000-0000-0000-0000-000000000019\''
\set catHid '\'9e298000-0000-0000-0000-000000000020\''
\set gVis   '\'9e298000-0000-0000-0000-000000000021\''
\set gHid   '\'9e298000-0000-0000-0000-000000000022\''

-- organizations.slug and warehouses.code are NOT NULL with no default.
insert into auth.users (id, email) values
  (:usr,  'u-0298@example.test'),
  (:mgrB, 'mgrb-0298@example.test'),
  (:vwr,  'viewer-0298@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org,  'Sports 0298 Org', 'sports-0298-org'),
  (:orgB, 'Other 0298 Org',  'other-0298-org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org,  :usr,  'manager', now()),
  (:orgB, :mgrB, 'manager', now()),
  -- A VIEWER in org A, restricted to catVis by the assignment row below.
  (:org,  :vwr,  'viewer',  now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code) values
  (:wh,  :org,  'WH 0298',   'WH0298'),
  (:whB, :orgB, 'WH 0298 B', 'WH0298B')
  on conflict (id) do nothing;

-- Category-visibility fixtures for 48-51. The viewer needs NO warehouse
-- assignment: group visibility is org membership AND category, nothing else.
insert into public.categories (id, organization_id, name) values
  (:catVis, :org, 'Visible Cat 0298'),
  (:catHid, :org, 'Hidden Cat 0298')
  on conflict (id) do nothing;
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:org, :vwr, :catVis)
  on conflict do nothing;

-- A pre-existing item in a DIFFERENT org, standing in for "every item in every
-- existing org". Assertion 15 scans it, so that assertion is never vacuous
-- (the shipped seed contains zero inventory_items rows).
insert into public.inventory_items
  (organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:orgB, :whB, 'ORGB-LEGACY-0298', 'Other org legacy widget', 3, 'active', 'none')
  on conflict do nothing;

-- ── 1-13. Schema shape ──────────────────────────────────────────────────────
select has_table('public', 'product_groups', 'product_groups exists');
select has_column('public', 'inventory_items', 'group_id', 'inventory_items.group_id exists');
select has_column('public', 'inventory_items', 'variant_size', 'inventory_items.variant_size exists');
select has_column('public', 'inventory_items', 'variant_size_original', 'the ORIGINAL imported size text is preserved in its own column');
select has_column('public', 'inventory_items', 'variant_size_system', 'inventory_items.variant_size_system exists');
select has_column('public', 'inventory_items', 'variant_width', 'inventory_items.variant_width exists');
select has_column('public', 'inventory_items', 'variant_fit', 'inventory_items.variant_fit exists');
select has_column('public', 'inventory_items', 'variant_color', 'inventory_items.variant_color exists');
select has_column('public', 'inventory_items', 'jersey_number', 'inventory_items.jersey_number exists');
select has_column('public', 'inventory_items', 'player_name', 'inventory_items.player_name exists');
select has_column('public', 'inventory_items', 'variant_key', 'inventory_items.variant_key exists');

-- THE invariant: a group must never own quantity.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'product_groups'
      and column_name in ('quantity_on_hand','quantity','total_quantity','on_hand',
                          'quantity_reserved','quantity_available','stock')),
  0,
  'product_groups owns NO quantity column - not now, not ever');

-- The "no backfill" anchor, stated structurally: a NOT NULL or a DEFAULT on
-- group_id is the only way a future edit could quietly grab existing rows.
select is(
  (select is_nullable || '/' || coalesce(column_default, 'no-default')
     from information_schema.columns
    where table_schema = 'public' and table_name = 'inventory_items'
      and column_name = 'group_id'),
  'YES/no-default',
  'group_id is NULLABLE with NO default - existing rows can never be swept into a group');

-- ── 14-15. Anti-vacuity: a plain legacy item is ungrouped ───────────────────
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:legacy, :org, :wh, 'LEGACY-0298', 'Ordinary Widget', 7, 'active', 'none')
  on conflict (id) do nothing;

select is(
  (select group_id from public.inventory_items where id = :legacy),
  null,
  'an item created without a group has a NULL group_id - existing orgs are untouched');

-- Proof there is no backfill statement hiding in the migration: the row that
-- already existed in ANOTHER org is still ungrouped. The '1/0' form asserts
-- both halves at once - one row really was scanned, and zero of them carry a
-- group_id - so this cannot silently pass on an empty table.
select is(
  (select count(*)::text || '/' || count(group_id)::text
     from public.inventory_items
    where organization_id = '9e298000-0000-0000-0000-000000000012'::uuid),
  '1/0',
  'the pre-existing item in another org is still ungrouped (1 row scanned, 0 group_ids) - 0298 runs no backfill');

-- ── 16-19. Model B (0234) is untouched ──────────────────────────────────────
-- Byte-identical definition, not merely "an index with that name exists".
select is(
  (select indexdef from pg_indexes
    where schemaname = 'public'
      and indexname = 'inventory_items_org_sku_charter_bin_unique'),
  'CREATE UNIQUE INDEX inventory_items_org_sku_charter_bin_unique ON public.inventory_items USING btree (organization_id, sku, charter_id, bin_location) NULLS NOT DISTINCT WHERE (deleted_at IS NULL)',
  'the Model B (org, sku, charter, bin) uniqueness index is byte-identical to 0234');

-- Behavioural: a TRUE duplicate placement still collides.
select throws_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
     values ('9e298000-0000-0000-0000-000000000001',
             '9e298000-0000-0000-0000-000000000003',
             'LEGACY-0298', 'Duplicate placement', 1, 'active', 'none') $$,
  '23505',
  null,
  'Model B still refuses a true duplicate placement (same org, sku, charter, bin)');

-- Behavioural: a legitimate SECOND placement of the same SKU still inserts,
-- and carrying variant columns does not change that.
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, bin_location, quantity_on_hand,
        status, tracking_type, variant_size, jersey_number)
     values ('9e298000-0000-0000-0000-000000000001',
             '9e298000-0000-0000-0000-000000000003',
             'LEGACY-0298', 'Second placement', 'RACK-2', 1, 'active', 'none',
             'M', '12') $$,
  'a second placement of the same SKU in another bin still inserts - Model B stays permissive');

-- Structural: jersey_number must never be dragged into a uniqueness key.
select is(
  (select count(*)::int from pg_indexes
    where schemaname = 'public' and tablename = 'inventory_items'
      and indexdef like '%jersey_number%'
      and indexdef like 'CREATE UNIQUE INDEX%'),
  0,
  'jersey_number appears in NO unique index - the number is never identity');

-- ── 20-23. R2: shoe sizes 9/10/11 are ONE group with no fake serials ────────
insert into public.product_groups
  (id, organization_id, name, brand, model, style_number, group_key,
   default_counting_unit, tracking_mode)
  values (:gShoe, :org, 'Nike Pegasus 41', 'Nike', 'Pegasus 41', 'FD2722',
          'shoes|nike|pegasus 41|fd2722|black-white', 'pair', 'QUANTITY_BY_VARIANT')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, group_id, variant_size, variant_size_original,
   variant_size_system, unit_of_measure, variant_key)
values
  (:s9,  :org, :wh, 'PEG41-9',  'Nike Pegasus 41 - 9',  4, 'active', 'none',
   :gShoe, '9',  'US 9',  'US_MENS', 'pair', 'size=9|system=US_MENS'),
  (:s10, :org, :wh, 'PEG41-10', 'Nike Pegasus 41 - 10', 6, 'active', 'none',
   :gShoe, '10', 'US 10', 'US_MENS', 'pair', 'size=10|system=US_MENS'),
  (:s11, :org, :wh, 'PEG41-11', 'Nike Pegasus 41 - 11', 2, 'active', 'none',
   :gShoe, '11', 'US 11', 'US_MENS', 'pair', 'size=11|system=US_MENS')
on conflict (id) do nothing;

select is(
  (select count(distinct group_id)::int from public.inventory_items
    where id in (:s9, :s10, :s11)),
  1,
  'R2: sizes 9, 10 and 11 all hang off exactly ONE product group');

select is(
  (select variant_count::int from public.product_group_rollups where group_id = :gShoe),
  3,
  'R2: the roll-up reports 3 variants');

select is(
  (select total_quantity from public.product_group_rollups where group_id = :gShoe),
  12::numeric,
  'R2: per-size quantities (4+6+2) roll up to 12 pairs - derived, never stored');

select is(
  (select count(*)::int from public.serial_registry
    where item_id in (:s9, :s10, :s11)),
  0,
  'R2: ZERO serial rows - no fake placeholders were created for a quantity product');

-- ── 24-27. R3: jersey #12 in M(3) + XL(2) totals 5 ──────────────────────────
insert into public.product_groups
  (id, organization_id, name, team, season, home_away, group_key,
   default_counting_unit, tracking_mode)
  values (:gJers, :org, 'Falcons Home Jersey', 'Falcons', '2026', 'home',
          'jerseys|falcons|2026|home', 'each', 'NUMBERED_VARIANT')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, group_id, jersey_number, variant_size, unit_of_measure, variant_key)
values
  (:j12m,  :org, :wh, 'FALC-12-M',  'Falcons Home Jersey 12 - M',  3, 'active',
   'none', :gJers, '12', 'M',  'each', 'number=12|size=M'),
  (:j12xl, :org, :wh, 'FALC-12-XL', 'Falcons Home Jersey 12 - XL', 2, 'active',
   'none', :gJers, '12', 'XL', 'each', 'number=12|size=XL')
on conflict (id) do nothing;

select is(
  (select count(*)::int from public.inventory_items
    where group_id = :gJers and jersey_number = '12'),
  2,
  'R3: number 12 exists in TWO sizes - the number is not unique and never blocks');

select is(
  (select total_quantity from public.product_group_rollups where group_id = :gJers),
  5::numeric,
  'R3: M(3) + XL(2) totals 5');

select is(
  (select quantity_on_hand from public.inventory_items where id = :j12m),
  3::numeric(14,4),
  'R3: the per-size quantity is retained, not merged away');

select is(
  (select count(*)::int from public.serial_registry
    where serial_number = '12' and organization_id = :org),
  0,
  'R3: the jersey number never leaked into serial_registry - a number is not a serial');

-- ── 28-33. jersey_number normalization rules ────────────────────────────────
-- All five canonical forms must INSERT and come back byte-identical. '0' and
-- '00' and '07' are distinct legal numbers; any numeric coercion collapses
-- them and this assertion catches it.
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, jersey_number)
     values
       ('9e298000-0000-0000-0000-000000000001','9e298000-0000-0000-0000-000000000003','JN-0','Number 0', 1,'active','none','0'),
       ('9e298000-0000-0000-0000-000000000001','9e298000-0000-0000-0000-000000000003','JN-00','Number 00',1,'active','none','00'),
       ('9e298000-0000-0000-0000-000000000001','9e298000-0000-0000-0000-000000000003','JN-07','Number 07',1,'active','none','07'),
       ('9e298000-0000-0000-0000-000000000001','9e298000-0000-0000-0000-000000000003','JN-12','Number 12',1,'active','none','12'),
       ('9e298000-0000-0000-0000-000000000001','9e298000-0000-0000-0000-000000000003','JN-99','Number 99',1,'active','none','99') $$,
  'the CHECK accepts 0, 00, 07, 12 and 99');

select is(
  (select array_agg(jersey_number order by sku)
     from public.inventory_items
    where organization_id = :org and sku like 'JN-%'),
  array['0','00','07','12','99'],
  'leading zeroes survive the round trip - 0, 00 and 07 stay three distinct numbers');

select throws_ok(
  $$ update public.inventory_items set jersey_number = 'ABC'
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  '23514',
  null,
  'a non-numeric jersey number is rejected (JERSEY_NUMBER_INVALID)');

select throws_ok(
  $$ update public.inventory_items set jersey_number = ''
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  '23514',
  null,
  'an empty-string jersey number is rejected - blank is NULL, never a number');

select throws_ok(
  $$ update public.inventory_items set jersey_number = '12345'
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  '23514',
  null,
  'a five-digit jersey number is rejected by the length guard');

-- The same number in a DIFFERENT group of the same org. Non-uniqueness has to
-- hold across groups, not only across sizes within one group.
insert into public.product_groups
  (id, organization_id, name, team, season, home_away, group_key, default_counting_unit)
  values (:gJers2, :org, 'Falcons Away Jersey', 'Falcons', '2026', 'away',
          'jerseys|falcons|2026|away', 'each')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, group_id, jersey_number, variant_size, variant_key)
  values (:j12alt, :org, :wh, 'FALC-A-12-M', 'Falcons Away Jersey 12 - M', 1,
          'active', 'none', :gJers2, '12', 'M', 'number=12|size=M')
  on conflict (id) do nothing;

select is(
  (select count(distinct group_id)::int from public.inventory_items
    where organization_id = :org and jersey_number = '12' and group_id is not null),
  2,
  'number 12 repeats across TWO different groups in the same org - still allowed');

-- ── 34-35. variant_size length guard ────────────────────────────────────────
select throws_ok(
  $$ update public.inventory_items
       set variant_size = 'XXXXXXXXXXXXXXXXXXXXXXXXX'
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  '23514',
  null,
  'a variant_size longer than 24 characters is rejected');

select lives_ok(
  $$ update public.inventory_items set variant_size = 'XXL'
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  'a normal size still updates cleanly');

-- ── 36-37. group_key uniqueness is per-ORG ──────────────────────────────────
select throws_ok(
  $$ insert into public.product_groups (organization_id, name, group_key)
     values ('9e298000-0000-0000-0000-000000000001',
             'Duplicate Pegasus',
             'shoes|nike|pegasus 41|fd2722|black-white') $$,
  '23505',
  null,
  'two groups cannot share a group_key within one org');

select lives_ok(
  $$ insert into public.product_groups (organization_id, name, group_key)
     values ('9e298000-0000-0000-0000-000000000012',
             'Pegasus in another org',
             'shoes|nike|pegasus 41|fd2722|black-white') $$,
  'the SAME group_key in a DIFFERENT org is fine - uniqueness is per-org, not global');

-- ── 38-40. The new inventory_items indexes ──────────────────────────────────
-- Pinned BYTE-IDENTICALLY, not merely by name: the point of the 2026-07-27
-- review fix is the ABSENCE of the WHERE clause. Postgres runs the
-- inventory_items_group_id_fkey RI probe as a bare `where group_id = $1` with
-- no knowledge of deleted_at, so it cannot use a partial index - re-adding
-- `where group_id is not null and deleted_at is null` would silently turn every
-- `delete from product_groups` into a sequential scan and row-lock of the
-- 1.2 M-row items table.
select is(
  (select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'inventory_items_group_idx'),
  'CREATE INDEX inventory_items_group_idx ON public.inventory_items USING btree (group_id)',
  'inventory_items_group_idx is NON-PARTIAL on (group_id) - the FK RI probe can use it');

-- The same guarantee restated structurally, so a differently NAMED partial
-- index cannot reintroduce the problem.
select is(
  (select count(*)::int from pg_indexes
    where schemaname = 'public' and tablename = 'inventory_items'
      and indexdef like '%(group_id%' and indexdef like '%WHERE%'),
  0,
  'no partial index leads with group_id - a group delete never falls back to a seq scan');

select ok(
  exists (select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'inventory_items_jersey_number_idx'),
  'inventory_items_jersey_number_idx exists (non-unique, per-org search)');

-- ── 41-47. RLS + roll-up view security ──────────────────────────────────────
-- A Postgres view defaults to security_invoker = FALSE, which reads the base
-- tables as the view OWNER (the migration superuser, who bypasses RLS). That
-- would publish every org's group totals to every authenticated user.
select is(
  (select 'security_invoker=true' = any(c.reloptions)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'product_group_rollups'),
  true,
  'product_group_rollups is security_invoker - it cannot read past the caller''s RLS');

-- A group in org B, so org B has something legitimate of its own to attach to.
insert into public.product_groups
  (id, organization_id, name, group_key, default_counting_unit)
  values (:gJersB, :orgB, 'Org B Jersey', 'jerseys|orgb|2026|home', 'each')
  on conflict (id) do nothing;

-- Two groups in org A that differ ONLY by category: one inside the restricted
-- viewer's whitelist, one outside it (48-51).
insert into public.product_groups
  (id, organization_id, category_id, name, group_key, default_counting_unit)
values
  (:gVis, :org, :catVis, 'Group In Visible Cat', 'shoes|visible-cat|0298', 'each'),
  (:gHid, :org, :catHid, 'Group In Hidden Cat',  'shoes|hidden-cat|0298',  'each')
  on conflict (id) do nothing;

-- As the OWNING org's manager: the group and its real total are visible.
set local "request.jwt.claim.sub" to '9e298000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select total_quantity from public.product_group_rollups
    where group_id = '9e298000-0000-0000-0000-000000000004'::uuid),
  12::numeric,
  'the owning org''s manager still reads the real roll-up through the invoker view');

-- As the FOREIGN org's manager.
set local "request.jwt.claim.sub" to '9e298000-0000-0000-0000-000000000013';

select is(
  (select count(*)::int from public.product_groups
    where id = '9e298000-0000-0000-0000-000000000004'::uuid),
  0,
  'a foreign org cannot see my product group (RLS isolation)');

select is(
  (select count(*)::int from public.product_group_rollups
    where group_id = '9e298000-0000-0000-0000-000000000004'::uuid),
  0,
  'a foreign org cannot read my group roll-up either - the view leaks nothing');

-- Positive control first: org B CAN group its own item. Without this the
-- refusal below would pass even if org B simply could not insert at all.
select lives_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, group_id)
     values ('9e298000-0000-0000-0000-000000000012',
             '9e298000-0000-0000-0000-000000000014',
             'ORGB-OK', 'Org B own group', 1, 'active', 'none',
             '9e298000-0000-0000-0000-000000000015') $$,
  'org B can attach its own item to its OWN group');

select throws_ok(
  $$ insert into public.inventory_items
       (organization_id, warehouse_id, sku, name, quantity_on_hand, status,
        tracking_type, group_id)
     values ('9e298000-0000-0000-0000-000000000012',
             '9e298000-0000-0000-0000-000000000014',
             'ORGB-STEAL', 'Org B steals a group', 1, 'active', 'none',
             '9e298000-0000-0000-0000-000000000004') $$,
  '42501',
  null,
  'org B CANNOT create an item attached to org A''s group (FK org-consistency)');

select throws_ok(
  $$ update public.inventory_items
       set group_id = '9e298000-0000-0000-0000-000000000004'
     where sku = 'ORGB-OK'
       and organization_id = '9e298000-0000-0000-0000-000000000012' $$,
  '42501',
  null,
  'org B CANNOT re-point an existing item at org A''s group either');

-- ── 48-51. Category visibility: the restricted-viewer boundary ──────────────
-- Reviewed 2026-07-27: product_groups_select was is_org_member ALONE, making
-- this the one read surface in the app that ignored viewer category
-- visibility. The same viewer reads zero categories (categories_select) and
-- zero items (inventory_items_select) outside their whitelist, yet could read
-- the group row - name, brand, team, style number, season - for a category
-- invisible to them. Quantities were already masked; the identity was not.

-- Positive control FIRST, as the org's own (unrestricted) manager, so the
-- viewer's zero below is a real refusal and not an empty fixture.
set local "request.jwt.claim.sub" to '9e298000-0000-0000-0000-000000000002';

select is(
  (select count(*)::int from public.product_groups
    where id in ('9e298000-0000-0000-0000-000000000021'::uuid,
                 '9e298000-0000-0000-0000-000000000022'::uuid)),
  2,
  'an UNRESTRICTED member of the org reads both the visible-category and the hidden-category group');

-- Now the viewer restricted to catVis only.
set local "request.jwt.claim.sub" to '9e298000-0000-0000-0000-000000000018';

select is(
  (select count(*)::int from public.product_groups
    where id = '9e298000-0000-0000-0000-000000000022'::uuid),
  0,
  'a category-restricted viewer reads ZERO group rows for a category outside their whitelist - no name/brand/style leak');

-- Exactness, not just the one refusal: the three NULL-category groups in the
-- same org are hidden too, matching how a NULL-category item behaves under
-- inventory_items_select.
select is(
  (select array_agg(name order by name) from public.product_groups
    where organization_id = '9e298000-0000-0000-0000-000000000001'::uuid),
  array['Group In Visible Cat'],
  'the restricted viewer reads EXACTLY the whitelisted-category group - the NULL-category groups are hidden as well');

select is(
  (select count(*)::int from public.product_group_rollups
    where group_id = '9e298000-0000-0000-0000-000000000022'::uuid),
  0,
  'the roll-up view hides the same group - security_invoker means product_groups RLS is the caller''s');

reset role;

-- ── 52-53. Both length guards end up VALIDATED ─────────────────────────────
-- 0298 adds each CHECK as NOT VALID and then VALIDATEs it, so the full-table
-- scan runs under SHARE UPDATE EXCLUSIVE rather than inside the ADD's ACCESS
-- EXCLUSIVE window (see the PROD PUSH NOTE at the head of the migration). The
-- END state must still be a VALIDATED constraint: a NOT VALID one enforces new
-- writes but is not trusted for planning, so losing the VALIDATE would be a
-- regression assertions 28-35 cannot see - they only ever test new writes.
select is(
  (select convalidated from pg_constraint
    where conrelid = 'public.inventory_items'::regclass
      and conname  = 'inventory_items_jersey_number_check'),
  true,
  'inventory_items_jersey_number_check ends up VALIDATED (the VALIDATE step was not dropped)');

select is(
  (select convalidated from pg_constraint
    where conrelid = 'public.inventory_items'::regclass
      and conname  = 'inventory_items_variant_size_check'),
  true,
  'inventory_items_variant_size_check ends up VALIDATED (the VALIDATE step was not dropped)');

select * from finish();
rollback;
