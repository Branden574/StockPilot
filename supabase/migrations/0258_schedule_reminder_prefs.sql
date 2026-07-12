-- 0258: per-user schedule-reminder notification preferences.
-- Owner ask 2026-07-11: individuals can turn off notification types.
-- Default TRUE (opt-out), matching every other pref (0113 pattern).
alter table public.notification_preferences
  add column if not exists email_schedule_reminders boolean not null default true,
  add column if not exists push_schedule_reminders boolean not null default true;
