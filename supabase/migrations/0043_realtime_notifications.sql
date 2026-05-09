-- 0043_realtime_notifications.sql
-- Add public.notifications to the supabase_realtime publication so the
-- topbar bell can subscribe to postgres_changes and reflect new
-- notifications + read-state changes without a manual refresh.
--
-- RLS already restricts the broadcast to rows the user can read
-- (notifications_select_own enforces user_id = auth.uid()), so the
-- subscription is automatically scoped to the signed-in user.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

-- pg won't error if the table is already in the publication (older
-- versions did; modern Supabase + pg 15+ are tolerant). Wrap defensively
-- regardless so re-running the migration is a no-op.
do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception
    when duplicate_object then null;
  end;
end$$;
