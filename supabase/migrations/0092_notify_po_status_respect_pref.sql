-- 0092_notify_po_status_respect_pref.sql
-- Bug fix (Notifications hunter, finding C6):
--
-- _notify_po_status (0025) inserts a notification row for the creator
-- and every notify-eligible org member on every status transition, but
-- never consults notification_preferences.push_po_status. That column
-- exists (see 0002_inventory.sql lines 280, 284) and users believe it
-- silences PO emails / pushes, but it's currently a no-op for this
-- writer.
--
-- Mirror the gate used by _notify_cycle_count_assigned in 0042:
--   row exists AND push_po_status = true  → notify
--   row missing                           → notify (legacy default = on)
--   row exists AND push_po_status = false → skip
--
-- Functions are CREATE OR REPLACE so trigger binding and grants from
-- 0025 persist; no extra grants needed.

create or replace function public._notify_po_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  link_url text;
  notif_title text;
  notif_body text;
begin
  if old.status is null or new.status is null then
    return new;
  end if;
  if old.status = new.status then
    return new;
  end if;

  link_url := '/dashboard/purchase-orders/' || new.id::text;
  notif_title := 'PO ' || coalesce(new.po_number, new.id::text) ||
                 ' is now ' || new.status;
  notif_body := 'Status changed from ' || old.status || ' to ' || new.status || '.';

  for uid in
    select distinct u
    from (
      select new.created_by as u
      union
      select user_id from public._notify_recipients(new.organization_id)
    ) s
    where u is not null
  loop
    -- Honor the per-user push_po_status opt-out. Treat a missing prefs
    -- row as opt-in for backwards-compat with existing accounts that
    -- haven't touched the (currently unsurfaced) settings UI.
    if exists (
      select 1 from public.notification_preferences
      where user_id = uid and push_po_status = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = uid
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        uid,
        'purchase_order.status_changed',
        notif_title,
        notif_body,
        link_url,
        jsonb_build_object(
          'po_id', new.id,
          'po_number', new.po_number,
          'from_status', old.status,
          'to_status', new.status
        )
      );
    end if;
  end loop;
  return new;
end;
$$;
