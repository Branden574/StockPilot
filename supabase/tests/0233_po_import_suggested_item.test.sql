-- supabase/tests/0233_po_import_suggested_item.test.sql
begin;
select plan(3);

select has_column('public', 'po_import_lines', 'suggested_item_id',
  'po_import_lines has suggested_item_id');
select col_is_null('public', 'po_import_lines', 'suggested_item_id',
  'suggested_item_id is nullable');
-- FK sets null on item delete (a suggestion must never block deleting an item)
select fk_ok('public', 'po_import_lines', 'suggested_item_id',
             'public', 'inventory_items', 'id');

select * from finish();
rollback;
