-- pgTAP for 0324 (+ the 0327 inversion): the twelve constraints must be
-- VALIDATED, the one deliberately-excluded constraint must still be NOT VALID,
-- and item_stock_levels.quantity — deferred by 0322/0324 until the RPC writers
-- were fixed — must now carry its validated constraint (added by 0327).
--
-- Asserts the PROPERTY (this constraint is enforced for every row, or is
-- deliberately deferred) rather than re-testing what the predicates match --
-- 0323's own test already covers the predicate behaviour.

begin;
select plan(15);

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

-- The deliberate exclusion, and it is now a SETTLED decision rather than an
-- open question. Production holds 5 legacy 'delivery' orders (created
-- 2026-05-12..15, predating the requirement) with a null delivery_charter_id,
-- so validating this constraint would fail the deploy.
--
-- Owner decision 2026-08-11: LEAVE THEM. Backfilling means choosing a delivery
-- charter per order, which is a judgement about real historical orders that no
-- migration should guess, and the rows are five closed records from a three-day
-- window with no operational consequence. The constraint keeps guarding every
-- NEW write meanwhile, which is the entire attack surface.
--
-- Pinned so a later cleanup pass cannot silently validate it -- doing so would
-- fail the deploy on those five rows.
select ok(NOT _is_validated('order_requests', 'order_requests_delivery_target_chk'),
  'order_requests_delivery_target_chk is STILL not valid, by owner decision 2026-08-11: the 5 legacy charter-less delivery orders are left as-is, and the constraint keeps guarding new writes');

-- INVERTED by 0327: the ordering this pin protected has now been honored.
-- 0327 fixed both RPC writers FIRST (adjust_stock's explicit-location draw is
-- conditional; transfer_stock tests sufficiency IN the draw, so no negative is
-- ever written, transiently or durably) and added the constraint in the SAME
-- change. Pinned by NAME and by count so a rename, a second stray quantity
-- constraint, or a silent drop all fail here.
select is(
  (select array_agg(c.conname order by c.conname)
     from pg_constraint c
     join pg_class r on r.oid = c.conrelid
     join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = 'item_stock_levels'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%quantity%'),
  array['item_stock_levels_quantity_nonneg']::name[],
  'item_stock_levels.quantity carries exactly one CHECK constraint, item_stock_levels_quantity_nonneg (RPC writers fixed first, in 0327)'
);
select ok(_is_validated('item_stock_levels', 'item_stock_levels_quantity_nonneg'),
  'item_stock_levels_quantity_nonneg is validated for every existing row (production checked 2026-08-11: zero negative rows)');

drop function _is_validated(text, text);
select finish();
rollback;
