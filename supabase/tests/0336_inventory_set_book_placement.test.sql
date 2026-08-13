-- supabase/tests/0336_inventory_set_book_placement.test.sql
-- Proves migration 0336: `inventory_set_book_placement` writes a book's WHOLE
-- placement summary — the crate pair AND the rack pair — in one statement,
-- merges into custom_fields, never touches bin_location, and carries the house
-- grant/search_path posture.
--
-- Five properties, each literal-pinned:
--
--   A. ONE STATEMENT, BOTH PAIRS. The reason the function exists. The four keys
--      are two projections of ONE fact (the single location the book's live
--      holdings resolve to), so one call must land all four — a caller that
--      needed two calls could leave the row saying "in Blue 13, on no rack".
--
--   B. THE FOUR CASES OF THE DERIVATION, as SQL. Position-less crate (rack pair
--      CLEARED — main's behaviour, and the right one for a FULL move), positioned
--      crate (rack pair becomes the crate's position), plain rack (crate cleared,
--      rack set), and neither (all four cleared). The SPLIT case is a caller
--      decision — this function is never called for it — and is pinned in
--      apps/web/src/server/services/inventory.bookCratePlacement.test.ts.
--
--   C. MERGE + bin_location. Every non-placement custom_fields key survives;
--      `bin_location` comes out untouched, because it belongs to
--      inventory_set_bin_location (0335) and a put-away's LABEL is a separate
--      call with a separate reason. Blank/whitespace clears like NULL.
--
--   D. SCOPE + FAIL-CLOSED. Books only (a non-book never acquires book_* keys,
--      even from a mixed array); a soft-deleted row is never touched; a NULL id
--      array short-circuits to 0; the return value is always the ACTUAL affected
--      row count. Plus: nothing is validated — a legacy COMPOSITE rack number is
--      stored verbatim, because decomposition is the application's job
--      (normalizeRackFields) and a raise here would fail a reconciliation that
--      runs AFTER the stock has already moved.
--
--   E. POSTURE. Exactly ONE overload (so PostgREST cannot go ambiguous and
--      0329's by-name lists stay valid), SECURITY INVOKER, search_path=public
--      pinned, authenticated holds EXECUTE, anon and PUBLIC hold none. Plus the
--      tripwire that the three writers this one sits beside — inventory_set_rack,
--      inventory_set_book_storage, inventory_set_bin_location — STILL have
--      exactly one signature each: 0336 overloaded none of them.
--
-- Every RPC call below is wrapped in an assertion on purpose: a bare
-- `select fn(...)` would mutate state without pinning what it returned. None is
-- called from inside another statement's WHERE clause either — this function
-- UPDATEs inventory_items, and hiding that write inside a scan of the same table
-- is unreadable at best.
--
-- Fixtures inserted as postgres (RLS bypassed — write semantics and grants are
-- not RLS boundaries). Every fixture SKU differs, which keeps 0234's
-- (organization_id, sku, charter_id, bin_location) unique index out of the way.
-- Namespace: 03360000. begin/rollback — nothing leaks.
--
-- PLAN: hand-counted 32 — A: 5, B: 9, C: 6, D: 7, E: 5.

begin;

select plan(32);

\set org    '\'03360000-0000-0000-0000-000000000001\''
\set usr    '\'03360000-0000-0000-0000-000000000002\''
\set wh     '\'03360000-0000-0000-0000-0000000000b1\''
\set bookA  '\'03360000-0000-0000-0000-0000000000c1\''
\set bookB  '\'03360000-0000-0000-0000-0000000000c2\''
\set bookC  '\'03360000-0000-0000-0000-0000000000c3\''
\set bookD  '\'03360000-0000-0000-0000-0000000000c4\''
\set widget '\'03360000-0000-0000-0000-0000000000c5\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'book-placement-0336@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Book Placement Org 0336', 'book-placement-0336')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Book WH 0336', 'WH-0336', 'active')
  on conflict (id) do nothing;

-- bookA is the regression fixture: recorded in crate Blue 4 AND on rack 38-A,
-- with the rest of a real book's custom_fields alongside, and a bin_location
-- label a picker reads. This is the production shape whose rack pair went on
-- naming 38-A after every copy had moved into a position-less crate.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, status, tracking_type,
   bin_location, custom_fields)
values
  (:bookA, :org, :wh, 'BK-0336-A', 'Derivation Book 0336', 'book', 'active', 'none',
   'Blue Shelf',
   '{"author":"Ada Lovelace","book_grade":"5","publisher":"Analytical Press",
     "isbn":"9780000000001","thumbnail_url":"https://example.test/a.jpg",
     "book_rack_number":"38","book_rack_row":"A",
     "book_crate_color":"blue","book_crate_number":"4",
     "org_custom_donor":"PTA 2024"}'::jsonb),
  (:bookB, :org, :wh, 'BK-0336-B', 'Batch Book 0336', 'book', 'active', 'none',
   null, '{"author":"Grace Hopper"}'::jsonb),
  (:bookC, :org, :wh, 'BK-0336-C', 'Free Text Book 0336', 'book', 'active', 'none',
   null, '{"book_crate_number":"Blue Shelf","book_rack_number":"22","book_rack_row":"B"}'::jsonb),
  (:bookD, :org, :wh, 'BK-0336-D', 'Deleted Book 0336', 'book', 'active', 'none',
   '12-A', '{"book_rack_number":"12","book_rack_row":"A","book_crate_number":"9"}'::jsonb),
  (:widget, :org, :wh, 'WD-0336', 'Not A Book 0336', 'product', 'active', 'none',
   '38-A', '{"rack_number":"38","rack_row":"A"}'::jsonb)
on conflict (id) do nothing;

update public.inventory_items set deleted_at = now() where id = :bookD;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. ONE STATEMENT, BOTH PAIRS.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1
select is(
  public.inventory_set_book_placement(array[:bookA]::uuid[], 'green', '2', '43', 'B'),
  1,
  'returns the ACTUAL affected row count (1 book updated)'
);
-- 2-3. Both pairs, from one call. Two calls could have landed one and lost the
--      other, which is the self-contradicting row this function prevents.
select is(
  (select (custom_fields->>'book_crate_color') || ' ' || (custom_fields->>'book_crate_number')
     from public.inventory_items where id = :bookA),
  'green 2',
  'the CRATE pair is written'
);
select is(
  (select (custom_fields->>'book_rack_number') || '-' || (custom_fields->>'book_rack_row')
     from public.inventory_items where id = :bookA),
  '43-B',
  'the RACK pair is written by the SAME call — one statement, both projections'
);
-- 4-5
select is(
  public.inventory_set_book_placement(array[:bookA, :bookB]::uuid[], 'red', '7', '40', 'C'),
  2,
  'ONE call covers every id in the array (a 200-book bulk place is one round trip)'
);
select is(
  (select count(*)::int from public.inventory_items
    where id in (:bookA, :bookB)
      and custom_fields->>'book_crate_number' = '7'
      and custom_fields->>'book_rack_number' = '40'
      and custom_fields->>'book_rack_row' = 'C'),
  2,
  'both rows really carry the whole summary'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- B. THE FOUR CASES OF THE DERIVATION.
-- ═══════════════════════════════════════════════════════════════════════════

-- 6-8. CASE 1 — all stock in a POSITION-LESS crate. The rack pair CLEARS. This
--      is main's behaviour, restored for the case where it was right: no stock
--      remains on any rack, so a preserved 40-C names a rack the book has left,
--      and nine surfaces reprint it (pick slip, warehouse packing slip, mobile
--      scan sheet). Passing both rack arguments NULL is how that is expressed.
select is(
  public.inventory_set_book_placement(array[:bookA]::uuid[], 'gray', 'BIN', null, null),
  1,
  'a position-less crate is a legal call (both rack arguments NULL)'
);
select is(
  (select custom_fields ? 'book_rack_number' or custom_fields ? 'book_rack_row'
     from public.inventory_items where id = :bookA),
  false,
  'the rack pair is CLEARED — both keys are REMOVED, not stored as JSON null'
);
select is(
  (select (custom_fields->>'book_crate_color') || ' ' || (custom_fields->>'book_crate_number')
     from public.inventory_items where id = :bookA),
  'gray BIN',
  'and the crate summary is the crate the stock is actually in'
);

-- 9-10. CASE 2 — all stock in a POSITIONED crate. The rack pair becomes the
--       CRATE's position: one physical place, two item keys, so a row that
--       names the crate and no rack contradicts itself.
select is(
  public.inventory_set_book_placement(array[:bookA]::uuid[], 'gray', 'BIN', '43', 'B'),
  1,
  'a positioned crate writes both pairs'
);
select is(
  (select custom_fields - 'author' - 'book_grade' - 'publisher' - 'isbn'
                        - 'thumbnail_url' - 'org_custom_donor'
     from public.inventory_items where id = :bookA),
  '{"book_rack_number":"43","book_rack_row":"B",
    "book_crate_color":"gray","book_crate_number":"BIN"}'::jsonb,
  'the summary reads "Gray BIN on rack 43-B" — the crate SITS ON the rack'
);

-- 11-12. CASE 3 — all stock on a plain RACK. The crate CLEARS (a book on a rack
--        is in no crate, and a stale "Gray BIN" walks a picker to a full bin)
--        while the rack pair is that rack.
select is(
  public.inventory_set_book_placement(array[:bookA]::uuid[], null, null, '38', 'A'),
  1,
  'a plain rack clears the crate and sets the rack'
);
select is(
  (select custom_fields - 'author' - 'book_grade' - 'publisher' - 'isbn'
                        - 'thumbnail_url' - 'org_custom_donor'
     from public.inventory_items where id = :bookA),
  '{"book_rack_number":"38","book_rack_row":"A"}'::jsonb,
  'only the rack pair remains — the crate keys are REMOVED'
);

-- 13-14. CASE 4 — the stock resolves to a location that is NEITHER a rack nor a
--        crate: a NULL-kind SITE holding, which is REAL in this data (405 units
--        on DC4 per migration 0292) and must never be filtered out of the
--        derivation. The book is in no crate and on no rack, so all four go.
select is(
  public.inventory_set_book_placement(array[:bookA]::uuid[], null, null, null, null),
  1,
  'all four arguments NULL is a legal call (stock on a plain Site)'
);
select is(
  (select custom_fields - 'author' - 'book_grade' - 'publisher' - 'isbn'
                        - 'thumbnail_url' - 'org_custom_donor'
     from public.inventory_items where id = :bookA),
  '{}'::jsonb,
  'the whole summary clears — in no crate and on no rack is a real answer'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- C. MERGE + bin_location.
-- ═══════════════════════════════════════════════════════════════════════════

-- 15. Everything that is not a placement key survived all of section B.
select is(
  (select custom_fields from public.inventory_items where id = :bookA),
  '{"author":"Ada Lovelace","book_grade":"5","publisher":"Analytical Press",
    "isbn":"9780000000001","thumbnail_url":"https://example.test/a.jpg",
    "org_custom_donor":"PTA 2024"}'::jsonb,
  'MERGE, never replace: author/grade/publisher/isbn/thumbnail and the org custom field all survive'
);
-- 16. The other half of the decomposition: this writer cannot reach the LABEL.
select is(
  (select bin_location from public.inventory_items where id = :bookA),
  'Blue Shelf',
  'bin_location is UNTOUCHED — the picker-facing label belongs to inventory_set_bin_location (0335)'
);
-- 17-18. Blank/whitespace clears exactly like NULL, so "no crate, no rack" has
--        ONE representation and no reader has to handle ''.
select is(
  public.inventory_set_book_placement(array[:bookC]::uuid[], '  ', '   ', '  ', '  '),
  1,
  'a blank/whitespace argument set is a legal call'
);
select is(
  (select custom_fields from public.inventory_items where id = :bookC),
  '{}'::jsonb,
  'blank/whitespace CLEARS each key rather than storing an empty string'
);
-- 19-20. Free text is preserved verbatim after trimming — production really does
--        store 'Blue Shelf' as a crate NUMBER (0334's note). Never range-check.
select is(
  public.inventory_set_book_placement(array[:bookC]::uuid[], '  blue  ', '  Blue Shelf  ', '  22  ', '  B  '),
  1,
  'padded values are accepted'
);
select is(
  (select custom_fields from public.inventory_items where id = :bookC),
  '{"book_rack_number":"22","book_rack_row":"B",
    "book_crate_color":"blue","book_crate_number":"Blue Shelf"}'::jsonb,
  'surrounding whitespace is trimmed and the free-text crate number survives intact'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- D. SCOPE + FAIL-CLOSED.
-- ═══════════════════════════════════════════════════════════════════════════

-- 21-22
select is(
  public.inventory_set_book_placement(array[:widget]::uuid[], 'blue', '4', '43', 'B'),
  0,
  'a NON-BOOK is never written — book_crate_* / book_rack_* are book-scoped keys'
);
select is(
  (select custom_fields from public.inventory_items where id = :widget),
  '{"rack_number":"38","rack_row":"A"}'::jsonb,
  'the non-book keeps its NEUTRAL rack pair, byte-identically (see the migration''s stated gap)'
);
-- 23-24
select is(
  public.inventory_set_book_placement(array[:bookD]::uuid[], 'green', '1', '43', 'B'),
  0,
  'a soft-deleted item is never written'
);
select is(
  (select custom_fields from public.inventory_items where id = :bookD),
  '{"book_rack_number":"12","book_rack_row":"A","book_crate_number":"9"}'::jsonb,
  'the soft-deleted row''s summary is left exactly as it was'
);
-- 25
select is(
  public.inventory_set_book_placement(null::uuid[], 'green', '1', '43', 'B'),
  0,
  'a NULL id array short-circuits to 0 instead of rewriting every book in the org'
);
-- 26-27. NOT VALIDATED, on purpose. A legacy composite ("22-B" in the number
--        column) is stored verbatim: decomposition is normalizeRackFields' job
--        in the application, policed by rack-shape.inventory-guard.test.ts, and
--        a raise here would fail a reconciliation that runs after the stock has
--        already physically moved. inventory_set_rack validates nothing either,
--        and these two must not disagree about what a legal pair is.
select is(
  public.inventory_set_book_placement(array[:bookB]::uuid[], null, null, '22-B', null),
  1,
  'a composite rack number is accepted without a raise'
);
select is(
  (select custom_fields->>'book_rack_number' from public.inventory_items where id = :bookB),
  '22-B',
  'and stored verbatim — this function validates and normalises nothing'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- E. POSTURE.
-- ═══════════════════════════════════════════════════════════════════════════

-- 28
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_book_placement'),
  1,
  'exactly ONE overload — PostgREST cannot go ambiguous (the 0068 hazard)'
);
-- 29. The tripwire: 0336 overloaded none of the three writers it sits beside.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('inventory_set_rack', 'inventory_set_book_storage',
                        'inventory_set_bin_location')),
  3,
  'inventory_set_rack / _book_storage / _bin_location still have exactly ONE signature each'
);
-- 30
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_book_placement'),
  false,
  'SECURITY INVOKER — RLS on inventory_items does the org scoping'
);
-- 31
select ok(
  (select 'search_path=public' = any(p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_set_book_placement'),
  'carries the repo-standard search_path=public pin (0329 posture)'
);
-- 32. authenticated holds EXECUTE and no PUBLIC/anon grant survives. A NULL
--     proacl is itself PUBLIC-executable, so the ACL rows are checked directly
--     rather than trusting that a revoke happened.
select ok(
  has_function_privilege('authenticated',
    'public.inventory_set_book_placement(uuid[], text, text, text, text)', 'execute')
  and 0 = (select count(*)::int
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace,
             lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
            where n.nspname = 'public'
              and p.proname = 'inventory_set_book_placement'
              and (a::text like '=%' or a::text like 'anon=%')),
  'authenticated holds EXECUTE while no PUBLIC and no anon grant survives in the ACL'
);

select * from finish();
rollback;
