-- 0324_validate_storage_path_and_nonneg_constraints.sql
--
-- Promotes twelve NOT VALID constraints to fully validated.
--
-- WHY THIS IS A SEPARATE MIGRATION
-- ---------------------------------------------------------------------------
-- 0323 (storage-path shapes) and the Wave C2 non-negative quantity checks were
-- both added `NOT VALID` on purpose: `alter table ... add constraint` WITHOUT
-- that flag takes an ACCESS EXCLUSIVE lock and scans the whole table to prove
-- every existing row conforms, so one legacy row could have failed the deploy.
-- `NOT VALID` enforces on new writes immediately and defers the proof.
--
-- This migration is the deferred proof. `validate constraint` takes only a
-- SHARE UPDATE EXCLUSIVE lock, which permits concurrent reads AND writes, so
-- promoting them afterwards is the cheap half of the operation.
--
-- Once validated, the invariant holds for EVERY row rather than only for rows
-- written since 0323 — which is what lets a future audit trust the constraint
-- instead of re-querying the table.
--
-- PRE-VERIFIED AGAINST PRODUCTION BEFORE WRITING THIS
-- ---------------------------------------------------------------------------
-- Storage paths: 1,001 rows across all seven path columns, zero containing
-- '..', '%', a leading '/', '//', a backslash or a control character, longest
-- 127 characters against the 400 cap.
-- Quantities: 516 inventory_items rows, zero negative quantity_on_hand,
-- reorder_point or reorder_quantity.
-- So every statement below is expected to be a no-op scan. If any FAILS on a
-- future environment, that is the constraint doing its job: the correct
-- response is to find and fix the offending row, never to drop the constraint.
--
-- DELIBERATELY NOT INCLUDED
-- ---------------------------------------------------------------------------
-- `order_requests_delivery_target_chk` is also NOT VALID and is LEFT THAT WAY.
-- Production holds 5 violating rows (fulfillment_type = 'delivery' with a null
-- delivery_charter_id), all created between 2026-05-12 and 2026-05-15 — legacy
-- orders that predate the requirement. Validating it would fail the deploy, and
-- backfilling those rows means choosing a delivery charter for each, which is a
-- data decision for the owner rather than something a migration should guess.
-- It stays NOT VALID so it keeps guarding new writes while the legacy rows are
-- resolved separately.

-- Storage-path shapes (0323). Each guards a column that authenticated members
-- can write through PostgREST; for po_attachments and the maintenance columns
-- the constraint is the ONLY path guard, because mobile inserts those rows
-- directly rather than through a service.
alter table public.item_images
  validate constraint item_images_storage_path_safe;
alter table public.item_images
  validate constraint item_images_thumb_path_safe;

alter table public.order_request_attachments
  validate constraint order_request_attachments_storage_path_safe;

alter table public.po_attachments
  validate constraint po_attachments_storage_path_safe;

alter table public.po_imports
  validate constraint po_imports_storage_path_safe;

alter table public.procedure_videos
  validate constraint procedure_videos_storage_path_safe;
alter table public.procedure_videos
  validate constraint procedure_videos_thumbnail_path_safe;

alter table public.maintenance_request_attachments
  validate constraint maintenance_request_attachments_storage_path_safe;
alter table public.maintenance_request_attachments
  validate constraint maintenance_request_attachments_thumbnail_path_safe;

-- Non-negative quantities (Wave C2).
--
-- Note what these do and do NOT cover: they constrain the DENORMALIZED totals
-- on inventory_items. `item_stock_levels.quantity` is deliberately still
-- unconstrained, because `adjust_stock` commits negatives today and
-- `transfer_stock` writes a negative before its own guard runs — constraining
-- that column first would convert an existing bug into a mid-transaction
-- failure. The RPCs must be fixed before that column can be constrained; that
-- ordering is pinned in pgTAP so it cannot be quietly reversed.
alter table public.inventory_items
  validate constraint inventory_items_quantity_on_hand_nonneg;
alter table public.inventory_items
  validate constraint inventory_items_reorder_point_nonneg;
alter table public.inventory_items
  validate constraint inventory_items_reorder_quantity_nonneg;
