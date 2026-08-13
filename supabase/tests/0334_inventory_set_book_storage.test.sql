-- supabase/tests/0334_inventory_set_book_storage.test.sql
-- Proves migration 0334: `inventory_set_book_storage` writes a book's crate
-- SUMMARY into custom_fields without destroying anything else, and carries the
-- house grant/search_path posture.
--
-- Four properties, each literal-pinned:
--
--   A. MERGE, NEVER REPLACE. The load-bearing one. A book's custom_fields also
--      holds author, book_grade, publisher, isbn, thumbnail_url and the org's
--      own 0159 custom-field values. Writing a crate must leave every one of
--      them byte-identical, and must leave the book_rack_* pair (owned by the
--      SEPARATE inventory_set_rack writer) alone. A `set custom_fields =
--      jsonb_build_object(...)` regression fails here.
--
--   B. FREE-TEXT CRATE NUMBER. Production stores 0, 1..16 and the strings
--      'Bin', 'BIN' and 'Blue Shelf'. Each is accepted verbatim. Any future
--      range/enum check fails here — which is the point.
--
--   C. CLEARING + SCOPE. Both-NULL (and blank-string) strips the pair rather
--      than storing JSON nulls; a NON-BOOK in the id array is never touched;
--      a soft-deleted row is never touched; the return value is always the
--      ACTUAL affected row count, so a caller can tell "RLS filtered every
--      row" from "wrote" (recurring pattern #2 — never fail open on a write).
--
--   D. POSTURE. Exactly ONE overload (so PostgREST cannot go ambiguous and
--      0329's list-integrity counts stay valid), SECURITY INVOKER,
--      search_path=public pinned, authenticated holds EXECUTE, anon and PUBLIC
--      hold none. Plus the tripwire that inventory_set_rack STILL has exactly
--      one signature — 0334 deliberately did not overload it.
--
-- Every RPC call below is wrapped in an assertion on purpose: a bare
-- `select fn(...)` would mutate state without pinning what it returned.
--
-- Fixtures inserted as postgres (RLS bypassed — merge semantics and grants are
-- not RLS boundaries). Namespace: 03340000. begin/rollback — nothing leaks.
--
-- PLAN: hand-counted 26 — A: 5, B: 6, C: 9, D: 6.

begin;

select plan(26);

\set org    '\'03340000-0000-0000-0000-000000000001\''
\set usr    '\'03340000-0000-0000-0000-000000000002\''
\set wh     '\'03340000-0000-0000-0000-0000000000b1\''
\set bookA  '\'03340000-0000-0000-0000-0000000000c1\''
\set bookB  '\'03340000-0000-0000-0000-0000000000c2\''
\set bookD  '\'03340000-0000-0000-0000-0000000000c3\''
\set widget '\'03340000-0000-0000-0000-0000000000c4\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'book-storage-0334@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Book Storage Org 0334', 'book-storage-0334')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Book WH 0334', 'WH-0334', 'active')
  on conflict (id) do nothing;

-- bookA carries a FULL custom_fields payload: everything below that is not a
-- book_crate_* key must survive every call in this file.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, status, tracking_type, custom_fields)
values
  (:bookA, :org, :wh, 'BK-0334-A', 'Merge Guard Book 0334', 'book', 'active', 'none',
   '{"author":"Ada Lovelace","book_grade":"5","publisher":"Analytical Press",
     "isbn":"9780000000001","thumbnail_url":"https://example.test/a.jpg",
     "book_rack_number":"38","book_rack_row":"A",
     "book_crate_color":"blue","book_crate_number":"4",
     "org_custom_donor":"PTA 2024"}'::jsonb),
  (:bookB, :org, :wh, 'BK-0334-B', 'Free Text Book 0334', 'book', 'active', 'none',
   '{"author":"Grace Hopper"}'::jsonb),
  (:bookD, :org, :wh, 'BK-0334-D', 'Deleted Book 0334', 'book', 'active', 'none',
   '{"book_crate_color":"red","book_crate_number":"9"}'::jsonb),
  (:widget, :org, :wh, 'WD-0334', 'Not A Book 0334', 'product', 'active', 'none',
   '{"rack_number":"12"}'::jsonb)
on conflict (id) do nothing;

update public.inventory_items set deleted_at = now() where id = :bookD;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. MERGE, NEVER REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1
select is(
  public.inventory_set_book_storage(array[:bookA]::uuid[], 'green', '2'),
  1,
  'returns the ACTUAL affected row count (1 book updated)'
);
-- 2
select is(
  (select custom_fields->>'book_crate_color' from public.inventory_items where id = :bookA),
  'green',
  'book_crate_color written'
);
-- 3
select is(
  (select custom_fields->>'book_crate_number' from public.inventory_items where id = :bookA),
  '2',
  'book_crate_number written'
);
-- 4. The regression this whole file exists for.
select is(
  (select custom_fields - 'book_crate_color' - 'book_crate_number'
     from public.inventory_items where id = :bookA),
  '{"author":"Ada Lovelace","book_grade":"5","publisher":"Analytical Press",
    "isbn":"9780000000001","thumbnail_url":"https://example.test/a.jpg",
    "book_rack_number":"38","book_rack_row":"A",
    "org_custom_donor":"PTA 2024"}'::jsonb,
  'MERGE not replace: every non-crate custom_fields key survives byte-identically'
);
-- 5. The rack pair belongs to inventory_set_rack; this writer must not touch it.
select is(
  (select (custom_fields->>'book_rack_number') || '-' || (custom_fields->>'book_rack_row')
     from public.inventory_items where id = :bookA),
  '38-A',
  'the book_rack_* pair (owned by inventory_set_rack) is untouched'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. FREE-TEXT CRATE NUMBER — the live production values, verbatim.
-- ═══════════════════════════════════════════════════════════════════════════

-- 6-7
select is(
  public.inventory_set_book_storage(array[:bookB]::uuid[], 'blue', 'Bin'),
  1,
  'crate number "Bin" is accepted — free text, never range-validated'
);
select is(
  (select custom_fields->>'book_crate_number' from public.inventory_items where id = :bookB),
  'Bin',
  '"Bin" is stored verbatim — normalisation is the application''s job, not the DB''s'
);
-- 8-9
select is(
  public.inventory_set_book_storage(array[:bookB]::uuid[], null, 'Blue Shelf'),
  1,
  'the free text "Blue Shelf" is a legal crate number'
);
select is(
  (select custom_fields->>'book_crate_number' from public.inventory_items where id = :bookB),
  'Blue Shelf',
  '"Blue Shelf" stored verbatim'
);
-- 10-11
select is(
  public.inventory_set_book_storage(array[:bookB]::uuid[], null, '0'),
  1,
  'crate number 0 is legal (a 1..9 enum would reject it — live books say otherwise)'
);
select is(
  (select custom_fields->>'book_crate_number' from public.inventory_items where id = :bookB),
  '0',
  '0 stored verbatim'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. CLEARING + SCOPE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 12-14
select is(
  public.inventory_set_book_storage(array[:bookA]::uuid[], null, null),
  1,
  'both-NULL is a legal call (a rack destination CLEARS the crate summary)'
);
select is(
  (select custom_fields ? 'book_crate_color' or custom_fields ? 'book_crate_number'
     from public.inventory_items where id = :bookA),
  false,
  'both-NULL STRIPS the pair (jsonb_strip_nulls) — no JSON nulls left behind'
);
select is(
  (select custom_fields->>'author' from public.inventory_items where id = :bookA),
  'Ada Lovelace',
  'clearing the crate still preserves every other key'
);
-- 15-16
select is(
  public.inventory_set_book_storage(array[:bookB]::uuid[], '  ', '   '),
  1,
  'blank/whitespace arguments are accepted'
);
select is(
  (select custom_fields ? 'book_crate_number' from public.inventory_items where id = :bookB),
  false,
  'blank/whitespace CLEARS rather than storing an empty string'
);
-- 17-18
select is(
  public.inventory_set_book_storage(array[:widget]::uuid[], 'blue', '4'),
  0,
  'a NON-BOOK in the id array updates zero rows'
);
select is(
  (select custom_fields from public.inventory_items where id = :widget),
  '{"rack_number":"12"}'::jsonb,
  'the non-book row never acquires book_crate_* keys'
);
-- 19
select is(
  public.inventory_set_book_storage(array[:bookD]::uuid[], 'green', '1'),
  0,
  'a soft-deleted book is never updated'
);
-- 20
select is(
  public.inventory_set_book_storage(null::uuid[], 'green', '1'),
  0,
  'a NULL id array short-circuits to 0 instead of touching every row'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. POSTURE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 21
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_book_storage'),
  1,
  'exactly ONE overload — PostgREST cannot go ambiguous (the 0068 hazard)'
);
-- 22. The reason this function exists at all: inventory_set_rack was NOT
--     extended, so 0329's "22 functions, a single overload each" count holds.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_rack'),
  1,
  'inventory_set_rack still has exactly ONE signature — 0334 did not overload it'
);
-- 23
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_book_storage'),
  false,
  'SECURITY INVOKER — RLS on inventory_items does the org scoping'
);
-- 24
select ok(
  (select 'search_path=public' = any(p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_book_storage'),
  'carries the repo-standard search_path=public pin (0329 posture)'
);
-- 25
select ok(
  has_function_privilege('authenticated',
    'public.inventory_set_book_storage(uuid[], text, text)', 'execute'),
  'authenticated holds EXECUTE (the placement path calls it)'
);
-- 26. A NULL proacl is itself PUBLIC-executable, so this checks the ACL rows
--     directly rather than trusting that a revoke happened.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
    where n.nspname = 'public'
      and p.proname = 'inventory_set_book_storage'
      and (a::text like '=%' or a::text like 'anon=%')),
  0,
  'no PUBLIC and no anon grant survives in the ACL'
);

select * from finish();
rollback;
