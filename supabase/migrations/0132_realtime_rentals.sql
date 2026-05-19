-- 0132_realtime_rentals.sql
--
-- Add public.rentals to the supabase_realtime publication so the
-- dashboard's InventoryRealtime subscription receives postgres_changes
-- events when a rental is created / returned / cancelled. Mirrors the
-- pattern in 0117 (order_requests).
--
-- RLS applies to realtime broadcasts — events for rows the subscriber
-- can't read are filtered out by Postgres before delivery. So a
-- warehouse-scoped staff user only ever receives events for rentals
-- they have warehouse access to.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

-- Idempotent guard — alter publication add table errors 42710 if
-- the table is already a member.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'rentals'
  ) then
    alter publication supabase_realtime add table public.rentals;
  end if;
end$$;
