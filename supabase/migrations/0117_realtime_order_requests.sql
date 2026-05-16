-- 0117_realtime_order_requests.sql
--
-- Add public.order_requests to the supabase_realtime publication so
-- the dashboard order-detail page can subscribe to row updates and
-- auto-refresh when status changes happen on another device (e.g.
-- driver signs on phone -> manager's laptop detail page should
-- update without a manual refresh).
--
-- RLS still applies to realtime broadcasts — Supabase enforces the
-- subscriber's policies before delivering each row event, so org A
-- members never see org B events.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

-- Idempotent: alter publication ... add table errors with 42710 if
-- the table is already a member. Guard with a membership check so
-- re-running this migration is harmless.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'order_requests'
  ) then
    alter publication supabase_realtime add table public.order_requests;
  end if;
end$$;
