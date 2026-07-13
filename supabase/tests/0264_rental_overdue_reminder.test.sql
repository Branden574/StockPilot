-- supabase/tests/0264_rental_overdue_reminder.test.sql
-- Proves migration 0264 (overdue-reminder tracking column):
--   S1. rentals.overdue_reminder_sent_at exists, is timestamptz, nullable.
--   S2. Defaults to NULL (not-yet-reminded) on insert.
-- Namespace ab026400. Wrapped in begin/rollback.

begin;

select plan(4);

select has_column('public', 'rentals', 'overdue_reminder_sent_at', 'overdue_reminder_sent_at exists');
select col_type_is(
  'public', 'rentals', 'overdue_reminder_sent_at', 'timestamp with time zone',
  'overdue_reminder_sent_at is timestamptz'
);
select col_is_null('public', 'rentals', 'overdue_reminder_sent_at', 'overdue_reminder_sent_at is nullable');
select col_default_is(
  'public', 'rentals', 'overdue_reminder_sent_at', null,
  'overdue_reminder_sent_at defaults to NULL'
);

select * from finish();
rollback;
