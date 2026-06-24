-- 0185_po_import_line_item_created.sql
--
-- Track whether a PO-import line's inventory item was NEWLY CREATED by the
-- import (vs linked to a pre-existing item the user matched).
--
-- The import creates catalog items during review (createItemsFromPoLinesAction),
-- before the PO exists, so those items never got the created_from_purchase_order_id
-- marker that cancel-cleanup keys on — and a cancelled import/PO left them
-- stranded in inventory. We need to clean up ONLY the items the import created,
-- never the user's pre-existing items, so we record which lines created an item:
--
--   * approve() stamps created items with created_from_purchase_order_id so the
--     normal PO-cancel cleanup (archiveOrphanedCustomItems) archives the unused
--     ones.
--   * cancelling the import BEFORE approval archives the created (still-unused)
--     items directly.
--
-- Default false: existing rows + linked/use_existing lines are not "created".

alter table public.po_import_lines
  add column if not exists item_created boolean not null default false;
