-- supabase/tests/0192_backfill_placements.test.sql
begin;
select plan(1);

-- After backfill, every non-deleted item reconciles: Σ levels = quantity_on_hand.
select is(
  (select count(*)::int from public.inventory_items i
     where i.deleted_at is null
       and i.quantity_on_hand <> coalesce(
         (select sum(quantity) from public.item_stock_levels s where s.item_id = i.id), 0)),
  0,
  'every item reconciles: Σ item_stock_levels = quantity_on_hand'
);

select * from finish();
rollback;
