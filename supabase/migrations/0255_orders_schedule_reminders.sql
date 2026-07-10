-- 0255: orders → schedule auto-events + reminder plumbing.
--
-- 1. order_requests.needed_by — the requester's structured "needed by"
--    datetime (was buried in free-text notes). Drives the auto-created
--    schedule event at approval.
-- 2. schedule_events.order_request_id — links an auto-created event to its
--    order (cascade: cancelling/deleting the order removes the event).
-- 3. schedule_events.assigned_user_id — who the event is for (auto-synced
--    to the delivery driver on assign_delivery). Reminders target this
--    user (+ org managers).
-- 4. schedule_events.reminded_24h_at / reminded_1h_at — dedupe stamps so
--    the reminder cron never double-sends a window.

alter table public.order_requests
  add column if not exists needed_by timestamptz;

alter table public.schedule_events
  add column if not exists order_request_id uuid references public.order_requests(id) on delete cascade,
  add column if not exists assigned_user_id uuid references auth.users(id) on delete set null,
  add column if not exists reminded_24h_at timestamptz,
  add column if not exists reminded_1h_at timestamptz;

-- One auto-event per order (manual events stay unconstrained at null).
create unique index if not exists schedule_events_order_request_uniq
  on public.schedule_events (order_request_id)
  where order_request_id is not null;

-- The reminder cron scans upcoming un-reminded scheduled events.
create index if not exists schedule_events_reminder_scan_idx
  on public.schedule_events (starts_at)
  where status = 'scheduled';
