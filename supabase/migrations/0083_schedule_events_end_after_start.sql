-- 0083_schedule_events_end_after_start.sql
-- ============================================================================
-- DB-level guard: ends_at must be >= starts_at when set
-- ----------------------------------------------------------------------------
-- The Zod schema and form already enforce this, but a determined caller
-- (server action with a stale build, future API expansion, manual psql
-- session) could still write a row where ends_at < starts_at. That
-- breaks the calendar's range query — events with a negative span
-- silently disappear from listInRange().
--
-- Add a CHECK constraint as the last line of defense. NULL ends_at is
-- allowed (open-ended events); equal start/end is allowed (zero-
-- duration markers — useful for "pickup at 9:00am sharp").
--
-- This migration also drops schedule_events_open_idx — it was created
-- in 0032 to support "what's open / in progress?" queries, but the
-- dashboard upcoming panel uses listUpcoming() which filters by
-- starts_at >= now() and the planning index on (org, starts_at)
-- covers it. The open-idx never gets picked.
-- ============================================================================

alter table public.schedule_events
  drop constraint if exists schedule_events_end_after_start;
alter table public.schedule_events
  add constraint schedule_events_end_after_start
  check (ends_at is null or ends_at >= starts_at);

drop index if exists public.schedule_events_open_idx;
