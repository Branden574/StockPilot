-- 0084_schedule_events_updated_by_trigger.sql
-- ============================================================================
-- Enforce updated_by = auth.uid() on every write
-- ----------------------------------------------------------------------------
-- RLS gates *whether* a user can update a schedule event, but doesn't
-- constrain *what* they can write into updated_by. A buggy client (or
-- a curious user with the bearer token) could update one of their
-- coworker's events and stamp the row with someone else's id —
-- corrupting audit history without the audit log itself catching it.
--
-- The service layer always sets updated_by = ctx.userId today, but
-- that's a convention. Tighten it with a BEFORE INSERT/UPDATE trigger
-- that forces the column to auth.uid() regardless of what the client
-- sent. created_by is forced on INSERT too — the existing RLS check
-- only checks `created_by = auth.uid()`, but doesn't stop later
-- UPDATEs from mutating it.
--
-- The trigger runs SECURITY INVOKER (default) so auth.uid() resolves
-- to the calling user, not the function owner.
-- ============================================================================

create or replace function public._enforce_schedule_events_writer()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT') then
    -- updated_by mirrors created_by on first write; both forced to caller.
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  elsif (tg_op = 'UPDATE') then
    -- created_by is immutable. updated_by is always the caller.
    new.created_by := old.created_by;
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_events_enforce_writer on public.schedule_events;
create trigger schedule_events_enforce_writer
  before insert or update on public.schedule_events
  for each row execute function public._enforce_schedule_events_writer();
