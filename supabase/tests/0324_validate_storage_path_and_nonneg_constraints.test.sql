-- pgTAP for 0324: the twelve constraints must be VALIDATED, and the one
-- deliberately-excluded constraint must still be NOT VALID.
--
-- Asserts the PROPERTY (this constraint is enforced for every row, or is
-- deliberately deferred) rather than re-testing what the predicates match --
-- 0323's own test already covers the predicate behaviour.

begin;
select plan(14);

-- Helper shape: convalidated is the single source of truth for "has this been
-- proven against existing rows".
create or replace function _is_validated(tbl text, con text) returns boolean
language sql stable as $$
  select c.convalidated
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public' and r.relname = tbl and c.conname = con
$$;

select ok(_is_validated('item_images', 'item_images_storage_path_safe'),
  'item_images.storage_path shape is validated for every existing row');
select ok(_is_validated('item_images', 'item_images_thumb_path_safe'),
  'item_images.thumb_path shape is validated for every existing row');
select ok(_is_validated('order_request_attachments', 'order_request_attachments_storage_path_safe'),
  'order_request_attachments.storage_path shape is validated');
select ok(_is_validated('po_attachments', 'po_attachments_storage_path_safe'),
  'po_attachments.storage_path shape is validated (mobile inserts here directly, so this constraint is the only path guard)');
select ok(_is_validated('po_imports', 'po_imports_storage_path_safe'),
  'po_imports.storage_path shape is validated');
select ok(_is_validated('procedure_videos', 'procedure_videos_storage_path_safe'),
  'procedure_videos.storage_path shape is validated');
select ok(_is_validated('procedure_videos', 'procedure_videos_thumbnail_path_safe'),
  'procedure_videos.thumbnail_path shape is validated');
select ok(_is_validated('maintenance_request_attachments', 'maintenance_request_attachments_storage_path_safe'),
  'maintenance_request_attachments.storage_path shape is validated');
select ok(_is_validated('maintenance_request_attachments', 'maintenance_request_attachments_thumbnail_path_safe'),
  'maintenance_request_attachments.thumbnail_path shape is validated');

select ok(_is_validated('inventory_items', 'inventory_items_quantity_on_hand_nonneg'),
  'inventory_items.quantity_on_hand non-negative is validated');
select ok(_is_validated('inventory_items', 'inventory_items_reorder_point_nonneg'),
  'inventory_items.reorder_point non-negative is validated');
select ok(_is_validated('inventory_items', 'inventory_items_reorder_quantity_nonneg'),
  'inventory_items.reorder_quantity non-negative is validated');

-- The deliberate exclusion. Production holds 5 legacy 'delivery' orders with a
-- null delivery_charter_id, so validating this would fail the deploy. Pinned so
-- a later cleanup pass cannot silently validate it without resolving the rows.
select ok(NOT _is_validated('order_requests', 'order_requests_delivery_target_chk'),
  'order_requests_delivery_target_chk is STILL not valid on purpose -- 5 legacy delivery orders carry no charter, and choosing one for each is an owner data decision');

-- item_stock_levels.quantity must remain unconstrained until adjust_stock and
-- transfer_stock stop writing negatives. Pinned so the ordering cannot reverse.
select is(
  (select count(*)::int
     from pg_constraint c
     join pg_class r on r.oid = c.conrelid
     join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = 'item_stock_levels'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%quantity%>=%0%'),
  0,
  'item_stock_levels.quantity is still unconstrained -- adjust_stock commits negatives and transfer_stock writes one before its guard, so the RPCs must be fixed FIRST'
);

drop function _is_validated(text, text);
select finish();
rollback;
