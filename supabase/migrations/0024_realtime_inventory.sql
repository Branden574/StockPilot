-- 0024_realtime_inventory.sql
-- Add inventory tables to the supabase_realtime publication so the web app
-- can subscribe to postgres_changes and reflect updates without a manual
-- refresh. RLS still applies to realtime subscriptions, so the broadcast
-- only reaches users who can read the row.

-- Tables that drive the dashboard's "what's happening right now" surface:
-- inventory_items, stock_movements, purchase_orders. Adding more later is a
-- one-liner per table.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- supabase_realtime is created by the Supabase platform on every project,
    -- but guard against fresh local instances anyway.
    create publication supabase_realtime;
  end if;
end$$;

alter publication supabase_realtime add table public.inventory_items;
alter publication supabase_realtime add table public.stock_movements;
alter publication supabase_realtime add table public.purchase_orders;
