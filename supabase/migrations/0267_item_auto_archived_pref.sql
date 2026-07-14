-- 0267_item_auto_archived_pref.sql
-- Per-user opt-out for the "item auto-archived" in-app notice sent by the
-- daily auto-archive-zero-stock cron (see 0266's zero_since/auto_archived
-- columns + apps/web/src/app/api/cron/auto-archive-zero-stock/route.ts).
--
-- Default-on opt-out model, same as every other 0113-lineage pref
-- (push_order_request_created / push_schedule_reminders): missing prefs row
-- OR pref = true → notify; pref explicitly false → skip. The cron gates in
-- app code (not a DB trigger — createNotification is called directly), but
-- the column lives here so it fits the same notification_preferences row +
-- settings-form select list as every other toggle.

alter table public.notification_preferences
  add column if not exists push_item_auto_archived boolean not null default true;

comment on column public.notification_preferences.push_item_auto_archived is
  'In-app alert when the daily cron auto-archives an out-of-stock item (inventory.item.auto_archived). Default on.';
