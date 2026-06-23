-- 0182_inventory_source_po.sql
--
-- Track which purchase order auto-created a custom (new) line item.
--
-- Custom PO line items create real catalog items at save time so they're
-- immediately pickable/manageable. But when the PO is later CANCELLED, those
-- items linger on the Items page forever — the user has to hunt them down and
-- archive them by hand. Recording the originating PO lets the cancel flow
-- archive the items it spawned (only the unused ones — zero stock, not on any
-- other live PO), without touching pre-existing catalog items that merely
-- appeared as lines.
--
-- on delete set null: if a PO is ever hard-deleted the item is kept, just
-- unlinked. Partial index keeps it cheap (only stamped rows are indexed).

alter table public.inventory_items
  add column if not exists created_from_purchase_order_id uuid
    references public.purchase_orders(id) on delete set null;

create index if not exists inventory_items_created_from_po_idx
  on public.inventory_items (created_from_purchase_order_id)
  where created_from_purchase_order_id is not null;
