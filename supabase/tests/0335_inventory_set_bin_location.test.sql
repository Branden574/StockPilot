-- supabase/tests/0335_inventory_set_bin_location.test.sql
-- Proves migration 0335: `inventory_set_bin_location` writes the picker-facing
-- placement LABEL and touches nothing else, on any item type, and carries the
-- house grant/search_path posture.
--
-- Four properties, each literal-pinned:
--
--   A. THE LABEL, AND ONLY THE LABEL. The load-bearing one, and the entire
--      reason this function exists: `inventory_set_rack` (0068) DELETES the
--      rack pair when both rack arguments are null, so it cannot label a
--      destination that states no rack position — and every crate location in
--      production today is position-less. Here `custom_fields` must come out
--      BYTE-IDENTICAL: the `book_rack_*` pair (owned by inventory_set_rack) and
--      the `book_crate_*` summary (owned by inventory_set_book_storage, 0334)
--      both survive. A future "helpful" widening that clears a rack key fails
--      HERE.
--
--   B. ANY ITEM TYPE, AND BATCHES. The exact opposite of 0334, on purpose:
--      `book_crate_*` is books-only, so for a NON-BOOK put away into a crate
--      this label is the ONLY record naming that crate anywhere. A non-book
--      must be labelled, and one call must label every id it is given.
--
--   C. CLEARING + SCOPE. NULL and blank/whitespace both store NULL rather than
--      an empty string; surrounding whitespace is trimmed; a soft-deleted row
--      is never touched; a NULL id array short-circuits to 0; the return value
--      is always the ACTUAL affected row count, so a caller can tell "RLS
--      filtered every row" from "wrote" (never fail open on a write).
--
--   D. POSTURE. Exactly ONE overload (so PostgREST cannot go ambiguous and
--      0329's list-integrity counts stay valid), SECURITY INVOKER,
--      search_path=public pinned, authenticated holds EXECUTE, anon and PUBLIC
--      hold none. Plus the tripwire that inventory_set_rack STILL has exactly
--      one signature — 0335, like 0334, deliberately did not overload it.
--
-- Every RPC call below is wrapped in an assertion on purpose: a bare
-- `select fn(...)` would mutate state without pinning what it returned.
--
-- Fixtures inserted as postgres (RLS bypassed — write semantics and grants are
-- not RLS boundaries). Every fixture SKU differs, which keeps 0234's
-- (organization_id, sku, charter_id, bin_location) unique index out of the way.
-- Namespace: 03350000. begin/rollback — nothing leaks.
--
-- PLAN: hand-counted 26 — A: 7, B: 5, C: 8, D: 6.

begin;

select plan(26);

\set org    '\'03350000-0000-0000-0000-000000000001\''
\set usr    '\'03350000-0000-0000-0000-000000000002\''
\set wh     '\'03350000-0000-0000-0000-0000000000b1\''
\set bookA  '\'03350000-0000-0000-0000-0000000000c1\''
\set bookB  '\'03350000-0000-0000-0000-0000000000c2\''
\set bookD  '\'03350000-0000-0000-0000-0000000000c3\''
\set widget '\'03350000-0000-0000-0000-0000000000c4\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bin-location-0335@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Bin Location Org 0335', 'bin-location-0335')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Bin WH 0335', 'WH-0335', 'active')
  on conflict (id) do nothing;

-- bookA is the regression fixture: a book that sits on rack 40-B AND is
-- recorded in crate Gray BIN, with the rest of a real book's custom_fields
-- alongside. Labelling it must change `bin_location` and nothing else.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, status, tracking_type,
   bin_location, custom_fields)
values
  (:bookA, :org, :wh, 'BK-0335-A', 'Label Guard Book 0335', 'book', 'active', 'none',
   '40-B',
   '{"author":"Ada Lovelace","book_grade":"5","publisher":"Analytical Press",
     "isbn":"9780000000001","thumbnail_url":"https://example.test/a.jpg",
     "book_rack_number":"40","book_rack_row":"B",
     "book_crate_color":"gray","book_crate_number":"BIN",
     "org_custom_donor":"PTA 2024"}'::jsonb),
  (:bookB, :org, :wh, 'BK-0335-B', 'Batch Book 0335', 'book', 'active', 'none',
   null, '{"author":"Grace Hopper"}'::jsonb),
  (:bookD, :org, :wh, 'BK-0335-D', 'Deleted Book 0335', 'book', 'active', 'none',
   '12-A', '{"book_rack_number":"12","book_rack_row":"A"}'::jsonb),
  -- The worst case 0334 cannot serve: a non-book has no crate summary anywhere,
  -- so this label is the only place its crate is ever recorded.
  (:widget, :org, :wh, 'WD-0335', 'Not A Book 0335', 'product', 'active', 'none',
   '38-A', '{"rack_number":"38","rack_row":"A"}'::jsonb)
on conflict (id) do nothing;

update public.inventory_items set deleted_at = now() where id = :bookD;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. THE LABEL, AND ONLY THE LABEL.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1
select is(
  public.inventory_set_bin_location(array[:bookA]::uuid[], 'Gray #BIN'),
  1,
  'returns the ACTUAL affected row count (1 item labelled)'
);
-- 2
select is(
  (select bin_location from public.inventory_items where id = :bookA),
  'Gray #BIN',
  'bin_location is written — the label a picker reads on every slip and sheet'
);
-- 3. The regression this whole file exists for.
select is(
  (select custom_fields from public.inventory_items where id = :bookA),
  '{"author":"Ada Lovelace","book_grade":"5","publisher":"Analytical Press",
    "isbn":"9780000000001","thumbnail_url":"https://example.test/a.jpg",
    "book_rack_number":"40","book_rack_row":"B",
    "book_crate_color":"gray","book_crate_number":"BIN",
    "org_custom_donor":"PTA 2024"}'::jsonb,
  'custom_fields comes out BYTE-IDENTICAL — this writer cannot reach it'
);
-- 4. Said explicitly, because "the label without clearing the pair" is the one
--    thing inventory_set_rack could not express.
select is(
  (select (custom_fields->>'book_rack_number') || '-' || (custom_fields->>'book_rack_row')
     from public.inventory_items where id = :bookA),
  '40-B',
  'the book_rack_* pair SURVIVES a label write (inventory_set_rack would have erased it)'
);
-- 5
select is(
  (select (custom_fields->>'book_crate_color') || ' ' || (custom_fields->>'book_crate_number')
     from public.inventory_items where id = :bookA),
  'gray BIN',
  'the book_crate_* summary (0334''s writer) survives too'
);
-- 6-7
select is(
  public.inventory_set_bin_location(array[:bookA]::uuid[], '   Gray #BIN   '),
  1,
  'a padded label is accepted'
);
select is(
  (select bin_location from public.inventory_items where id = :bookA),
  'Gray #BIN',
  'surrounding whitespace is trimmed off the stored label'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. ANY ITEM TYPE, AND BATCHES.
-- ═══════════════════════════════════════════════════════════════════════════

-- 8
select is(
  public.inventory_set_bin_location(array[:widget]::uuid[], 'Blue Shelf'),
  1,
  'a NON-BOOK is labelled — 0334''s crate summary is books-only, so this is the only record of its crate'
);
-- 9
select is(
  (select bin_location from public.inventory_items where id = :widget),
  'Blue Shelf',
  'the non-book carries the crate''s name as its label'
);
-- 10
select is(
  (select custom_fields from public.inventory_items where id = :widget),
  '{"rack_number":"38","rack_row":"A"}'::jsonb,
  'the non-book neutral rack pair survives byte-identically as well'
);
-- 11
select is(
  public.inventory_set_bin_location(array[:bookA, :bookB]::uuid[], 'Red #7'),
  2,
  'ONE call labels every id in the array (a 200-item bulk place is one round trip)'
);
-- 12
select is(
  (select count(*)::int from public.inventory_items
    where id in (:bookA, :bookB) and bin_location = 'Red #7'),
  2,
  'both rows really carry the label'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. CLEARING + SCOPE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 13
select is(
  public.inventory_set_bin_location(array[:bookB]::uuid[], '   '),
  1,
  'a blank/whitespace label is a legal call'
);
-- 14
select is(
  (select bin_location is null from public.inventory_items where id = :bookB),
  true,
  'blank/whitespace stores NULL rather than an empty string'
);
-- 15
select is(
  public.inventory_set_bin_location(array[:bookB]::uuid[], 'Green #2'),
  1,
  're-labelling an item overwrites its previous label'
);
-- 16
select is(
  public.inventory_set_bin_location(array[:bookB]::uuid[], null),
  1,
  'an explicit NULL is a legal call (it CLEARS)'
);
-- 17
select is(
  (select bin_location is null from public.inventory_items where id = :bookB),
  true,
  'NULL clears the label — deciding whether to clear is the CALLER''s job, not this function''s'
);
-- 18
select is(
  public.inventory_set_bin_location(array[:bookD]::uuid[], 'Gray #BIN'),
  0,
  'a soft-deleted item is never labelled'
);
-- 19
select is(
  (select bin_location from public.inventory_items where id = :bookD),
  '12-A',
  'the soft-deleted row''s label is left exactly as it was'
);
-- 20
select is(
  public.inventory_set_bin_location(null::uuid[], 'Gray #BIN'),
  0,
  'a NULL id array short-circuits to 0 instead of relabelling every item in the org'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. POSTURE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 21
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_bin_location'),
  1,
  'exactly ONE overload — PostgREST cannot go ambiguous (the 0068 hazard)'
);
-- 22. The reason this function exists at all, same as 0334's.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_rack'),
  1,
  'inventory_set_rack still has exactly ONE signature — 0335 did not overload it'
);
-- 23
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_bin_location'),
  false,
  'SECURITY INVOKER — RLS on inventory_items does the org scoping'
);
-- 24
select ok(
  (select 'search_path=public' = any(p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_bin_location'),
  'carries the repo-standard search_path=public pin (0329 posture)'
);
-- 25
select ok(
  has_function_privilege('authenticated',
    'public.inventory_set_bin_location(uuid[], text)', 'execute'),
  'authenticated holds EXECUTE (the put-away path calls it)'
);
-- 26. A NULL proacl is itself PUBLIC-executable, so this checks the ACL rows
--     directly rather than trusting that a revoke happened.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
    where n.nspname = 'public'
      and p.proname = 'inventory_set_bin_location'
      and (a::text like '=%' or a::text like 'anon=%')),
  0,
  'no PUBLIC and no anon grant survives in the ACL'
);

select * from finish();
rollback;
