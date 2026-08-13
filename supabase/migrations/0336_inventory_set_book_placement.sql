-- 0336_inventory_set_book_placement.sql
-- ONE writer for a book's PLACEMENT SUMMARY, because it is ONE derived fact.
--
-- ═══ WHY THIS EXISTS: THE CRATE PAIR AND THE RACK PAIR STOPPED BEING
--     INDEPENDENT ═══
--
-- 0334 and 0335 split item placement metadata into three writers on the stated
-- premise that they are "three independent facts about an item":
--   • book_crate_color / book_crate_number  -> inventory_set_book_storage (0334)
--   • book_rack_number / book_rack_row      -> inventory_set_rack (0068)
--   • bin_location (the picker-facing label) -> inventory_set_bin_location (0335)
--
-- That premise holds for `bin_location`, which is free text a caller composes.
-- It does NOT hold for the other two. `syncBookCratePlacement`
-- (apps/web/src/server/services/inventory.ts) derives a book's crate summary
-- from its LIVE holdings: when every placed holding resolves to exactly ONE
-- location, that location's `crate_color` / `crate_number` become the summary.
-- The rack pair is now derived from THE SAME single location's `rack_number` /
-- `rack_row` — because it answers the same question ("where is this book's
-- stock") about the same row. Two projections of one fact, not two facts.
--
-- Writing two projections of one fact with two statements is not atomic, and
-- the failure it admits is exactly the bug this whole line of work has been
-- chasing: the crate write lands, the rack write fails (RLS, a lock timeout,
-- a dropped connection), and the row now says "recorded in Blue 13, on no
-- rack" — a self-contradicting item that a picker acts on. One statement makes
-- that outcome unreachable rather than merely unlikely.
--
-- ═══ WHAT CHANGED IN THE BEHAVIOUR THIS SERVES ═══
--
-- main CLEARED the rack pair on every put-away into a position-less crate
-- (`inventory_set_rack` deletes the pair when both rack arguments are null,
-- 0068). That is right for a FULL move — no stock is left on any rack — and
-- wrong for a PARTIAL one, which leaves the rest of the stock on a rack the
-- operator never mentioned.
--
-- 0335 then PRESERVED the pair unconditionally. That is right for the partial
-- move and wrong for the full one: the pair goes on naming a rack the stock has
-- entirely left, and nine surfaces faithfully reprint it — including the pick
-- slip and the warehouse packing slip a picker physically carries.
--
-- Both were unconditional answers to a conditional question. The rule is
-- DERIVATION: the summary follows the live holdings, and the split case (stock
-- in more than one location) is SKIPPED and reported rather than guessed at.
-- So a full move into a position-less crate clears the pair, a full move into a
-- POSITIONED crate sets the pair to the crate's own position, a full move onto
-- a plain rack sets it to that rack, and a split move writes nothing.
--
-- ═══ 0335 IS NOT SUPERSEDED ═══
--
-- `bin_location` still needs stamping on a put-away, still must not disturb
-- either pair, and is still the ONLY record of a crate for a NON-BOOK (both
-- 0334 and this function are `item_type = 'book'`). 0335 remains the writer for
-- it, called from `stampPlacementBin` exactly as before. This migration does
-- not touch `bin_location` at all — a put-away's label and the summary
-- reconciliation stay separate calls with separate reasons, which is why the
-- transfer path can (deliberately) write the summary without writing a label.
--
-- 0334 keeps its grants, its comment and its pgTAP suite, and is left
-- BYTE-UNTOUCHED — a shipped migration is never edited. It simply has no
-- application caller after this: every write it could do, this one does, plus
-- the half it cannot. It is a strictly narrower, still-correct function, kept
-- rather than dropped because dropping it would need its own migration to
-- justify and would invalidate a passing test suite for no behavioural gain.
--
-- ═══ WHY A NEW FUNCTION INSTEAD OF EXTENDING EITHER EXISTING ONE ═══
-- The same two reasons 0334 and 0335 each gave, unchanged:
--   1. Adding a parameter to `inventory_set_book_storage` or
--      `inventory_set_rack` creates a NEW Postgres OVERLOAD, and PostgREST
--      cannot disambiguate two same-named functions reachable by the same
--      argument names — the hazard 0068 called out when it dropped the 4-arg
--      signature.
--   2. supabase/tests/0329_function_grants_and_search_path.test.sql pins its
--      function lists by NAME; a second signature of a listed name makes its
--      "single overload each" counts wrong. A new, differently-named function
--      does not appear in those lists at all.
-- `inventory_set_rack`, `inventory_set_book_storage` and
-- `inventory_set_bin_location` are all left byte-untouched by this migration.
--
-- MERGE, NEVER REPLACE. `custom_fields` on a book also carries author,
-- book_grade, publisher, ISBN, thumbnail_url and the org's own custom field
-- definitions (0159). Same `(cf - keys) || jsonb_strip_nulls(...)` idiom as
-- 0068 and 0334, so a concurrent edit to any other key is not clobbered and a
-- NULL argument CLEARS its key rather than storing a JSON null. Clearing is
-- load-bearing here, not incidental: "all the stock is in a crate that sits on
-- no rack" is expressed by passing both rack arguments NULL.
--
-- BOOKS ONLY, like 0334. `book_crate_*` and `book_rack_*` are the book-scoped
-- keys (the neutral `rack_*` / `book_rack_*` split from 0068), and the
-- reconciliation that calls this reads book rows only. The `item_type = 'book'`
-- predicate means a non-book can never acquire them even from a mixed array.
-- The consequence is stated plainly so nobody has to rediscover it: a NON-BOOK
-- fully moved into a position-less crate still keeps its neutral `rack_*` pair,
-- because no derivation runs for it. Its readers resolve that from live
-- holdings (packages/core/src/inventory/placement-resolution.ts); closing it at
-- the WRITE layer needs a non-book reconciliation that does not exist yet.
--
-- NOTHING IS VALIDATED OR NORMALISED HERE, deliberately, and both halves have a
-- precedent:
--   • CRATE NUMBER is FREE TEXT (0334's note: production holds 0, 1..16, 'Bin',
--     'BIN' and 'Blue Shelf'). Any range or enum check rejects real books.
--   • The RACK NUMBER is stored exactly as given, including a legacy COMPOSITE
--     ("22-B" in the number column). Decomposition is the application's job and
--     always has been — `normalizeRackFields` in
--     packages/core/src/inventory/rack-label.ts, policed for every writer by
--     apps/web/src/server/services/rack-shape.inventory-guard.test.ts. Adding a
--     DB-side raise would turn a caller bug into a failed reconciliation on a
--     path that runs AFTER the stock has already physically moved, which is the
--     one place a new exception must never be introduced. `inventory_set_rack`
--     validates neither, and this function must not disagree with it about what
--     a legal pair is.
--
-- SECURITY INVOKER: RLS on inventory_items enforces org isolation, exactly as
-- inventory_set_rack, inventory_set_book_storage and inventory_set_bin_location
-- do. Returns the ACTUAL affected row count so a caller can tell "wrote nothing
-- because RLS filtered the rows" from "wrote" (recurring pattern: a write whose
-- affected-row count is never checked fails OPEN).

create or replace function public.inventory_set_book_placement(
  p_item_ids     uuid[],
  p_crate_color  text,
  p_crate_number text,
  p_rack_number  text,
  p_rack_row     text
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  updated_count integer;
  uid uuid := auth.uid();
begin
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    return 0;
  end if;

  with merged as (
    update public.inventory_items ii
       set custom_fields =
             (coalesce(ii.custom_fields, '{}'::jsonb)
                - 'book_crate_color' - 'book_crate_number'
                - 'book_rack_number' - 'book_rack_row')
             || jsonb_strip_nulls(
                  jsonb_build_object(
                    'book_crate_color',  nullif(btrim(coalesce(p_crate_color, '')),  ''),
                    'book_crate_number', nullif(btrim(coalesce(p_crate_number, '')), ''),
                    'book_rack_number',  nullif(btrim(coalesce(p_rack_number, '')),  ''),
                    'book_rack_row',     nullif(btrim(coalesce(p_rack_row, '')),     '')
                  )
                ),
           updated_by = coalesce(uid, ii.updated_by),
           updated_at = now()
     where ii.id = any(p_item_ids)
       and ii.deleted_at is null
       and ii.item_type = 'book'
    returning 1
  )
  select count(*)::integer into updated_count from merged;

  return coalesce(updated_count, 0);
end;
$$;

comment on function public.inventory_set_book_placement(uuid[], text, text, text, text) is
  'Merges a book''s WHOLE placement summary — book_crate_color / book_crate_number '
  'AND book_rack_number / book_rack_row — into inventory_items.custom_fields in ONE '
  'statement, for BOOK rows only. These four keys are two projections of ONE fact '
  '(the single location the book''s live holdings resolve to), so they are written '
  'together: writing them with two calls admits a half-updated row that says '
  '"in Blue 13, on no rack". A NULL/blank argument CLEARS its key — passing both '
  'rack arguments NULL is how "all the stock is in a crate that sits on no rack" '
  'is expressed, and it is the correct outcome of a FULL move into a position-less '
  'crate. Every other custom_fields key is preserved; this MERGES, it never '
  'replaces. bin_location is NOT touched (that is inventory_set_bin_location, '
  '0335). Nothing is validated: the crate number is free text and a rack pair is '
  'decomposed by the application (normalizeRackFields), never here. This is a '
  'SUMMARY of item_stock_levels -> locations, never the source of truth.';

-- Grant posture matches every other user-facing RPC in this schema: no PUBLIC,
-- no anon, authenticated only (RLS does the org scoping). Spelled out rather
-- than inherited, because a NULL proacl is itself PUBLIC-executable.
revoke all on function public.inventory_set_book_placement(uuid[], text, text, text, text) from public;
revoke all on function public.inventory_set_book_placement(uuid[], text, text, text, text) from anon;
grant execute on function public.inventory_set_book_placement(uuid[], text, text, text, text) to authenticated;
