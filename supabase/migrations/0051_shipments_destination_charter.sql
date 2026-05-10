-- ============================================================================
-- 0051_shipments_destination_charter.sql
-- ============================================================================
-- Phase 2A's shipments table referenced destination_warehouse_id, but the
-- real-world model is "warehouse SHIPS, charter RECEIVES." A charter is the
-- school/site that gets the books; warehouses are the distribution centers
-- that hold inventory. The Word-template packing slip from L4L shows the
-- destination row as "Ship To: CVW-MANCHESTER" — that's a charter code, not
-- a warehouse.
--
-- The warehouse_charters junction table (added in 0008) already tracks which
-- charters each warehouse services. The shipment form will filter the
-- destination picker against that join.
--
-- Safe to drop+re-add the column because 0050 shipped today, no real
-- shipments exist yet, and the table is empty in every deployed env.
-- ============================================================================

drop index if exists shipments_destination_idx;
alter table public.shipments drop column destination_warehouse_id;

alter table public.shipments
  add column destination_charter_id uuid not null
    references public.charters(id) on delete restrict;

create index shipments_destination_charter_idx
  on public.shipments(destination_charter_id, ship_date desc);
