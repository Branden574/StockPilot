-- 0334_inventory_set_book_storage.sql
-- The missing DB write for a book's CRATE summary.
--
-- THE GAP. `inventory_set_rack` (0064 → 0068, search_path-pinned by 0329) is
-- the only server-side writer of book placement metadata, and it knows nothing
-- about crates: it merges `book_rack_number` / `book_rack_row` and sets
-- `bin_location`, full stop. So put-away could move a book's stock into a
-- crate and the item's `book_crate_color` / `book_crate_number` summary would
-- still describe wherever it used to be.
--
-- WHY A NEW FUNCTION INSTEAD OF EXTENDING inventory_set_rack.
-- Adding parameters to `inventory_set_rack` creates a NEW Postgres OVERLOAD.
-- Two things break on that:
--   1. PostgREST cannot disambiguate two same-named functions reachable by the
--      same argument names — the exact hazard 0068 called out when it dropped
--      the 4-arg signature ("to avoid PostgREST function-overload ambiguity").
--   2. supabase/tests/0329_function_grants_and_search_path.test.sql asserts a
--      LIST-INTEGRITY count of 22 functions "with a single overload each" and
--      a matching count of 22 search_path pins. A second `inventory_set_rack`
--      signature makes both counts 23 and fails that suite.
-- Dropping-and-recreating with a wider signature would avoid the overload but
-- couples an unrelated, heavily-tested rack writer to this change for no gain.
-- A separate, narrow function is the honest decomposition: rack keys and crate
-- keys are independent facts about an item, and each writer stays auditable on
-- its own. `inventory_set_rack` is left BYTE-UNTOUCHED by this migration, so
-- 0329's counts and every existing rack test stay valid.
--
-- MERGE, NEVER REPLACE. `custom_fields` on a book also carries author,
-- book_grade, publisher, ISBN, thumbnail_url and the org's own custom field
-- definitions (0159). This uses the same `(cf - keys) || jsonb_strip_nulls(...)`
-- idiom as 0068 so a concurrent edit to any other key is not clobbered and a
-- NULL argument CLEARS its key rather than storing a JSON null.
--
-- BOOKS ONLY. `book_crate_*` are the book-scoped keys (the neutral rack_* /
-- book_rack_* split from 0068). The `item_type = 'book'` predicate means a
-- non-book can never acquire them, even if a caller passes a mixed id array.
--
-- CRATE NUMBER IS FREE TEXT and is NOT validated here. Production
-- `book_crate_number` values include 0, 1..16 and the strings 'Bin', 'BIN' and
-- 'Blue Shelf'. Any range/enum check would reject real books. Normalisation
-- (trim / case-insensitive compare) is the application's job — see
-- packages/core/src/inventory/book-crate-placement.ts. Do not "tighten" this.
--
-- SECURITY INVOKER: RLS on inventory_items enforces org isolation, exactly as
-- inventory_set_rack does. Returns the ACTUAL affected row count so a caller
-- can tell "wrote nothing because RLS filtered the rows" from "wrote".

create or replace function public.inventory_set_book_storage(
  p_item_ids     uuid[],
  p_crate_color  text,
  p_crate_number text
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
                - 'book_crate_color' - 'book_crate_number')
             || jsonb_strip_nulls(
                  jsonb_build_object(
                    'book_crate_color',  nullif(btrim(coalesce(p_crate_color, '')),  ''),
                    'book_crate_number', nullif(btrim(coalesce(p_crate_number, '')), '')
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

comment on function public.inventory_set_book_storage(uuid[], text, text) is
  'Merges book_crate_color / book_crate_number into inventory_items.custom_fields '
  'for BOOK rows only. Both NULL (or blank) clears the pair. Every other '
  'custom_fields key is preserved — this MERGES, it never replaces. The crate '
  'number is FREE TEXT by design (production holds 0, 1..16, "Bin", "BIN", '
  '"Blue Shelf"); never add a range or enum check. These keys are a SUMMARY of '
  'item_stock_levels -> locations.crate_color/crate_number, never the source of '
  'truth.';

-- Grant posture matches every other user-facing RPC in this schema: no PUBLIC,
-- no anon, authenticated only (RLS does the org scoping). Spelled out rather
-- than inherited, because a NULL proacl is itself PUBLIC-executable.
revoke all on function public.inventory_set_book_storage(uuid[], text, text) from public;
revoke all on function public.inventory_set_book_storage(uuid[], text, text) from anon;
grant execute on function public.inventory_set_book_storage(uuid[], text, text) to authenticated;
