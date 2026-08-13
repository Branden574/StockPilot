-- 0335_inventory_set_bin_location.sql
-- The narrow writer for the PICKER-FACING placement LABEL, and nothing else.
--
-- THE GAP. `inventory_set_rack` (0064 -> 0068, search_path-pinned by 0329) is
-- the only server-side writer of `inventory_items.bin_location`, and it cannot
-- say "set the label, keep the rack pair": when BOTH rack arguments are null it
-- DELETES `rack_number` / `rack_row` (or the `book_rack_*` twins) from
-- custom_fields. So a put-away into a crate that states no rack position had
-- exactly two options through that function, and both are wrong:
--
--   1. Pass both nulls. The label lands, and the rack pair is ERASED — which
--      publishes "this item is on no rack" about stock that demonstrably is:
--      a PARTIAL put-away moves some copies into the crate and leaves the rest
--      on the rack the operator never mentioned.
--   2. Write nothing at all. The pair survives, and `bin_location` is left
--      describing the item's PREVIOUS location. That is the worse failure:
--      every crate location in production today is position-less, so every
--      put-away into an existing crate would leave a stale label behind, and
--      `bin_location` is read by the pick slip, the warehouse packing slip, the
--      cycle-count sheet, the inventory-snapshot report, the orders catalog
--      loader and the mobile lookup's placement label. "Crate placed, rack
--      column empty" became "crate placed, label WRONG".
--
-- Passing the item's EXISTING pair back into `inventory_set_rack` is not a
-- third option: the pair is per-item, so it needs a read per item, and a
-- 200-book bulk place can hold 200 distinct pairs — 200 RPC round trips for a
-- label stamp. Writing the label ALONE needs no read at all, which is why the
-- capability is split out here rather than bolted onto the rack writer.
--
-- WHY A NEW FUNCTION INSTEAD OF EXTENDING inventory_set_rack — the same
-- argument 0334 made for the crate summary, with the same conclusion:
--   1. Adding a parameter creates a NEW Postgres OVERLOAD, and PostgREST
--      cannot disambiguate two same-named functions reachable by the same
--      argument names — the hazard 0068 called out when it dropped the 4-arg
--      signature.
--   2. supabase/tests/0329_function_grants_and_search_path.test.sql pins a
--      LIST-INTEGRITY count of 22 functions "with a single overload each"; a
--      second `inventory_set_rack` signature makes that 23 and fails the suite.
-- `inventory_set_rack` is left BYTE-UNTOUCHED by this migration.
--
-- ONE COLUMN, BY CONSTRUCTION. This function never mentions `custom_fields`,
-- so the rack pair (owned by `inventory_set_rack`) and the crate summary
-- (owned by `inventory_set_book_storage`, 0334) are preserved because they are
-- unreachable from here — not because a caller remembered to pass the right
-- arguments. That is the whole point of the decomposition: three independent
-- facts about an item, three writers, each auditable on its own.
--
-- NOT BOOKS-ONLY, deliberately — the opposite of 0334. `book_crate_*` are
-- book-scoped keys, so a NON-BOOK has no crate summary anywhere: put a
-- Chromebook away from staging into "Blue Shelf" and this label is the ONLY
-- record that names the crate. `bin_location` is a plain column on every
-- inventory_items row and has never been item-type-scoped.
--
-- BLANK CLEARS. A NULL or all-whitespace argument stores NULL rather than an
-- empty string, so "no label" has one representation (matching 0334's
-- `nullif(btrim(...), '')` idiom, and the `bin_location <> ''` shape readers
-- already assume). The decision "this destination says nothing, so do not
-- write" belongs to the CALLER, which is the layer that knows what the
-- destination means — see `stampPlacementBin` in
-- apps/web/src/server/services/inventory.ts, which returns without calling
-- rather than erasing a label it has nothing to replace.
--
-- INHERITED HAZARD, stated so nobody rediscovers it as a mystery: 0234's
-- partial unique index (organization_id, sku, charter_id, bin_location) NULLS
-- NOT DISTINCT means two Model-B placements of the SAME sku under the SAME
-- charter cannot both carry the same label, so labelling both in one call
-- raises 23505 and the whole statement rolls back. That is not new here —
-- `inventory_set_rack` sets `bin_location` for every id in its array and has
-- always had the identical exposure — and it is why the caller treats a label
-- stamp as BEST EFFORT: the stock is already physically placed, so a failed
-- label must degrade to "no label", never to a failed put-away.
--
-- SECURITY INVOKER: RLS on inventory_items enforces org isolation, exactly as
-- inventory_set_rack and inventory_set_book_storage do. Returns the ACTUAL
-- affected row count so a caller can tell "wrote nothing because RLS filtered
-- the rows" from "wrote" (recurring pattern: a write that fails OPEN is
-- indistinguishable from a write that worked).

create or replace function public.inventory_set_bin_location(
  p_item_ids     uuid[],
  p_bin_location text
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
       set bin_location = nullif(btrim(coalesce(p_bin_location, '')), ''),
           updated_by   = coalesce(uid, ii.updated_by),
           updated_at   = now()
     where ii.id = any(p_item_ids)
       and ii.deleted_at is null
    returning 1
  )
  select count(*)::integer into updated_count from merged;

  return coalesce(updated_count, 0);
end;
$$;

comment on function public.inventory_set_bin_location(uuid[], text) is
  'Sets inventory_items.bin_location — the free-text, picker-facing placement '
  'LABEL — for every non-deleted item in the array, and touches NOTHING else. '
  'Exists because inventory_set_rack (0068) deletes the rack pair when both '
  'rack arguments are null, so it cannot write a label for a destination that '
  'states no rack position (every crate in production today). custom_fields is '
  'never mentioned here, so the rack pair and the book crate summary survive by '
  'construction. Any item type — a non-book has no crate summary at all, so '
  'this label is the only record of the crate it sits in. NULL/blank stores '
  'NULL; deciding whether a destination is worth labelling is the caller''s job. '
  'Returns the ACTUAL affected row count.';

-- Grant posture matches every other user-facing RPC in this schema: no PUBLIC,
-- no anon, authenticated only (RLS does the org scoping). Spelled out rather
-- than inherited, because a NULL proacl is itself PUBLIC-executable.
revoke all on function public.inventory_set_bin_location(uuid[], text) from public;
revoke all on function public.inventory_set_bin_location(uuid[], text) from anon;
grant execute on function public.inventory_set_bin_location(uuid[], text) to authenticated;
