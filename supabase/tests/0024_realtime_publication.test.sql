-- supabase/tests/0024_realtime_publication.test.sql
-- pgTAP tests for migration 0024 — realtime publication membership.

begin;

select plan(3);

select ok(
  exists(
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_items'
  ),
  'inventory_items is in the supabase_realtime publication'
);

select ok(
  exists(
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'stock_movements'
  ),
  'stock_movements is in the supabase_realtime publication'
);

select ok(
  exists(
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'purchase_orders'
  ),
  'purchase_orders is in the supabase_realtime publication'
);

select * from finish();
rollback;
