-- 0264_rental_overdue_reminder.sql
-- Rental notifications: the overdue-reminder cron emails a borrower once when
-- their rental passes its expected return date and is still out. Track the
-- send so the daily cron never re-emails the same overdue rental every day —
-- one nudge per rental. Cleared implicitly when the rental leaves 'out'
-- (returned/cancelled), and the cron only ever considers status='out' rows.

alter table public.rentals
  add column if not exists overdue_reminder_sent_at timestamptz;

-- The cron scans status='out' AND expected_return_at < now() AND
-- overdue_reminder_sent_at IS NULL. rentals_expected_return_idx (0131, partial
-- on status='out') already serves the expected_return_at range scan.
comment on column public.rentals.overdue_reminder_sent_at is
  'When the overdue-reminder email was sent (rental past expected_return_at, still out). NULL = not yet reminded; set once by the rental-overdue cron so it is not re-sent daily.';
