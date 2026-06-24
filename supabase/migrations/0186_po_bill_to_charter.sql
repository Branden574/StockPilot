-- 0186_po_bill_to_charter.sql
--
-- Add a "bill to" charter to purchase orders. This is the charter the PO is
-- billed to (rendered in the "Bill to" block of the PO PDF). It is distinct
-- from inventory_items.charter_id (which records which charter OWNS the stock):
-- a buyer can bill one charter while stocking items under another.
--
-- NULL = the PO is billed to the organization only (prior behavior).
-- on delete set null: archiving/deleting a charter must not cascade-delete POs.

alter table public.purchase_orders
  add column if not exists charter_id uuid
    references public.charters(id) on delete set null;

create index if not exists purchase_orders_charter_idx
  on public.purchase_orders(charter_id)
  where charter_id is not null;

comment on column public.purchase_orders.charter_id is
  'Bill-to charter for this PO, rendered in the PDF "Bill to" block. NULL = billed to the org only. Distinct from inventory_items.charter_id (stock ownership).';
