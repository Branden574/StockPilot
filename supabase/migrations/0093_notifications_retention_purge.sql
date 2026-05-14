-- 0093_notifications_retention_purge.sql
-- Bug fix (Notifications hunter, finding I4 partial):
--
-- public.notifications has no retention policy today, so every low-stock
-- crossing / PO transition / cycle-count assignment piles up forever.
-- A handful of high-churn orgs can easily push 100k+ rows in a year.
--
-- This migration adds a SECURITY DEFINER purge function that deletes
-- READ notifications older than 90 days. Unread rows are kept regardless
-- of age (the user hasn't seen them yet — losing them would be a UX
-- bug, not a retention win).
--
-- Wiring to a Vercel cron (suggested `0 4 * * *`) is intentionally
-- deferred — the function exists so a follow-up commit only needs to
-- add a route and a vercel.json entry. Manual invocation is also fine.

create or replace function public.purge_read_notifications(
  p_older_than interval default interval '90 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.notifications
   where read_at is not null
     and read_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- No grant to authenticated — purge is operational, called from cron
-- with the service-role key (which bypasses RLS / grants). Keeping it
-- closed reduces blast radius if a regular user account is compromised.

-- Supporting index for the purge scan. The existing
-- notifications_user_unread_idx is partial WHERE read_at is null, so
-- it can't satisfy a "read_at < cutoff" delete. Build a tiny btree on
-- read_at scoped to non-null rows so the purge stays O(deleted).
create index if not exists notifications_read_at_purge_idx
  on public.notifications(read_at)
  where read_at is not null;
