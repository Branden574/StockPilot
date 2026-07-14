-- 0265_notify_order_request_created_pref.sql
-- Per-user opt-out for the "New order request" manager ping.
--
-- Trigger _notify_order_request_changes (0157) inserts an
-- 'order_request.created' notification for EVERY notify-eligible recipient
-- (owner/admin/manager via _notify_recipients) on a new / confirmed request,
-- unconditionally — a manager who doesn't want to be alerted about every
-- order the team places had no way to mute it (only role demotion worked).
--
-- Add a `push_order_request_created` preference (default true = opt-out model,
-- same as every other 0113 pref) and gate ONLY the two 'order_request.created'
-- inserts with the 0092 respect-pref pattern:
--   prefs row exists AND pref = true  → notify
--   no prefs row                      → notify (legacy default = on)
--   prefs row exists AND pref = false → skip
--
-- Everything else in the function is reproduced verbatim from 0157 (it's a
-- CREATE OR REPLACE, so the trigger binding + grants persist): the
-- cancelled-after-approval staff ping and the requester's own status pings are
-- deliberately NOT gated by this pref. _notify_recipients is left untouched —
-- it is shared by low-stock / PO / cycle-count writers.

alter table public.notification_preferences
  add column if not exists push_order_request_created boolean not null default true;

comment on column public.notification_preferences.push_order_request_created is
  'In-app/push alert to managers when a new order request is submitted (order_request.created). Default on.';

create or replace function public._notify_order_request_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_recipients_loop record;
  v_metadata jsonb;
  v_pref_ok boolean;
begin
  v_link := '/dashboard/orders/' || new.id::text;
  v_metadata := jsonb_build_object(
    'order_request_id', new.id,
    'warehouse_id', new.warehouse_id,
    'source', new.source,
    'requester_user_id', new.requester_user_id,
    'requester_email', new.requester_email
  );

  if (tg_op = 'INSERT') then
    if new.status = 'pending_confirmation' then
      return new;
    end if;
    v_title := 'New order request' ||
               case when new.requester_name is not null
                    then ' from ' || new.requester_name else '' end;
    v_body := 'A request is waiting for approval.';
    for v_recipients_loop in
      select user_id from public._notify_recipients(new.organization_id)
    loop
      -- Per-user opt-out (0092 pattern) for the "New order request" ping.
      if exists (
        select 1 from public.notification_preferences
        where user_id = v_recipients_loop.user_id and push_order_request_created = true
      ) or not exists (
        select 1 from public.notification_preferences where user_id = v_recipients_loop.user_id
      ) then
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.created', v_title, v_body, v_link, v_metadata
        );
      end if;
    end loop;
    return new;
  end if;

  if (tg_op = 'UPDATE') then
    if old.status is not distinct from new.status then
      return new;
    end if;

    if old.status = 'pending_confirmation' and new.status = 'pending_approval' then
      v_title := 'New order request' ||
                 case when new.requester_name is not null
                      then ' from ' || new.requester_name else '' end;
      v_body := 'A request is waiting for approval.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        -- Per-user opt-out (0092 pattern) for the "New order request" ping.
        if exists (
          select 1 from public.notification_preferences
          where user_id = v_recipients_loop.user_id and push_order_request_created = true
        ) or not exists (
          select 1 from public.notification_preferences where user_id = v_recipients_loop.user_id
        ) then
          insert into public.notifications (
            organization_id, user_id, type, title, body, link, metadata
          ) values (
            new.organization_id, v_recipients_loop.user_id,
            'order_request.created', v_title, v_body, v_link, v_metadata
          );
        end if;
      end loop;
      return new;
    end if;

    -- Internal-only operational statuses do NOT trigger a requester ping.
    if new.status in (
      'pick_slip_generated',
      'picking_in_progress',
      'picking_complete',
      'packing_slip_generated'
    ) then
      return new;
    end if;

    if new.status = 'cancelled'
       and old.status in ('approved','packing_slip_generated','staged_for_pickup','staged_for_delivery','in_transit')
       and new.cancelled_by is not null
       and not public.has_org_role(new.organization_id, 'manager')
    then
      v_title := 'Order request cancelled after approval';
      v_body := 'Stop preparing this order if you started.';
      for v_recipients_loop in
        select user_id from public._notify_recipients(new.organization_id)
      loop
        insert into public.notifications (
          organization_id, user_id, type, title, body, link, metadata
        ) values (
          new.organization_id, v_recipients_loop.user_id,
          'order_request.cancelled_after_approval',
          v_title, v_body, v_link, v_metadata
        );
      end loop;
      return new;
    end if;

    v_recipient := new.requester_user_id;
    if v_recipient is null then
      return new;
    end if;

    -- Default-on pref gate (0092 pattern) for the requester's own status pings.
    case new.status
      when 'approved' then
        v_title := 'Your order request was approved';
        v_body := 'Stock has been reserved.';
      when 'denied' then
        v_title := 'Your order request was denied';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      when 'completed' then
        v_title := 'Your order was completed';
        v_body := 'Pickup or delivery is finalized.';
      when 'cancelled' then
        v_title := 'Your order was cancelled';
        v_body := coalesce(new.denied_reason, 'See the order page for details.');
      when 'staged_for_pickup' then
        select coalesce(np.email_order_status_changed, true)
          into v_pref_ok
          from public.notification_preferences np
          where np.user_id = v_recipient;
        if not coalesce(v_pref_ok, true) then
          return new;
        end if;
        v_title := 'Your order is ready';
        v_body := 'Ready for pickup.';
      when 'staged_for_delivery' then
        select coalesce(np.email_order_status_changed, true)
          into v_pref_ok
          from public.notification_preferences np
          where np.user_id = v_recipient;
        if not coalesce(v_pref_ok, true) then
          return new;
        end if;
        v_title := 'Your order is ready';
        v_body := 'Ready for delivery.';
      when 'in_transit' then
        select coalesce(np.email_order_in_transit, true)
          into v_pref_ok
          from public.notification_preferences np
          where np.user_id = v_recipient;
        if not coalesce(v_pref_ok, true) then
          return new;
        end if;
        v_title := 'Your order is on the way';
        v_body := 'It''s out for delivery.';
      else
        return new;
    end case;

    insert into public.notifications (
      organization_id, user_id, type, title, body, link, metadata
    ) values (
      new.organization_id, v_recipient,
      'order_request.' || new.status,
      v_title, v_body, v_link, v_metadata
    );
  end if;
  return new;
end;
$$;
