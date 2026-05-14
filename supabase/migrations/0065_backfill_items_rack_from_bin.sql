-- 0065_backfill_items_rack_from_bin.sql
-- One-time backfill: pre-existing non-book items that have a structured
-- "{number}-{row}" or "{number}" bin_location set but no
-- custom_fields.rack_number get their rack mirrored into the neutral
-- custom_fields.rack_number / rack_row keys so they show up in the new
-- rack filter + dropdown without the user having to re-save each row.
--
-- Only touches rows that:
--   - aren't soft-deleted
--   - aren't books (books keep their book_rack_* keys)
--   - have a bin_location matching the expected "NUM" or "NUM-ROW" shape
--   - don't already have custom_fields.rack_number set
-- Anything else (free-form bin labels like "Shelf 3, second bay")
-- is left alone — the user can re-enter rack via the form.

update public.inventory_items
set custom_fields = coalesce(custom_fields, '{}'::jsonb)
  || jsonb_strip_nulls(
       jsonb_build_object(
         'rack_number',
           (regexp_match(bin_location, '^([A-Za-z0-9]+)(?:-([A-Za-z0-9]+))?$'))[1],
         'rack_row',
           upper((regexp_match(bin_location, '^([A-Za-z0-9]+)(?:-([A-Za-z0-9]+))?$'))[2])
       )
     ),
  updated_at = now()
where deleted_at is null
  and item_type <> 'book'
  and bin_location is not null
  and bin_location ~ '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?$'
  and (custom_fields->>'rack_number') is null;
