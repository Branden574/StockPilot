-- ============================================================================
-- 0042_notify_writers_cycle_count_bundle.sql
-- ============================================================================
-- Two new notification writers feeding the existing public.notifications
-- table. Inserts into that table already fan out to Expo push tokens via
-- the trigger from 0028, so all we need here are the writers themselves.
--
--   1. cycle_count.assigned — pings the new assignee when a manager
--      points a count at them (or pings the previous assignee when
--      they're un-assigned).
--   2. bundle.distributed_shortage — pings notify-eligible org members
--      (managers/admins/owners) when a bundle distribution records a
--      component shortage, so someone can react before the next event.
--
-- New per-event push opt-in columns on notification_preferences so users
-- can mute either category individually if they want. Default = on.
-- ============================================================================

alter table public.notification_preferences
  add column if not exists push_cycle_count    boolean not null default true,
  add column if not exists push_bundle_shortage boolean not null default true;

-- ─────────────────────────────────────────────────────────────────────
-- cycle_count.assigned writer
-- ─────────────────────────────────────────────────────────────────────
create or replace function public._notify_cycle_count_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  link_url text;
  notif_title text;
  cc_label text;
  prev_assignee uuid;
  new_assignee uuid;
begin
  prev_assignee := old.assigned_to;
  new_assignee  := new.assigned_to;
  if prev_assignee is not distinct from new_assignee then
    return new;
  end if;

  link_url := '/dashboard/cycle-counts/' || new.id::text;
  cc_label := coalesce(
    nullif(trim(new.notes), ''),
    'Cycle count from ' || to_char(new.started_at, 'Mon DD')
  );

  -- Notify the new assignee (if any), respecting their push preference.
  if new_assignee is not null then
    notif_title := 'Cycle count assigned to you: ' || cc_label;
    if exists (
      select 1 from public.notification_preferences
      where user_id = new_assignee and push_cycle_count = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = new_assignee
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        new_assignee,
        'cycle_count.assigned',
        notif_title,
        'Tap to start the count.',
        link_url,
        jsonb_build_object(
          'cycle_count_id', new.id,
          'previous_assignee', prev_assignee,
          'warehouse_id', new.warehouse_id
        )
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cycle_counts_assigned on public.cycle_counts;
create trigger trg_cycle_counts_assigned
  after update of assigned_to on public.cycle_counts
  for each row execute function public._notify_cycle_count_assigned();

-- ─────────────────────────────────────────────────────────────────────
-- bundle.distributed_shortage writer
-- ─────────────────────────────────────────────────────────────────────
create or replace function public._notify_bundle_shortage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  bundle_name text;
  link_url text;
  notif_title text;
  notif_body text;
begin
  if not new.shortage_recorded then
    return new;
  end if;

  select name into bundle_name
  from public.bundles
  where id = new.bundle_id;

  link_url := '/dashboard/bundles/' || new.bundle_id::text;
  notif_title := 'Bundle shortage on ' || coalesce(bundle_name, 'a bundle');
  notif_body :=
    'Distributed ' || new.quantity::text ||
    ' kit' || case when new.quantity = 1 then '' else 's' end ||
    ' but some components were short — review for restocking.';

  for rec in
    select user_id from public._notify_recipients(new.organization_id)
  loop
    if exists (
      select 1 from public.notification_preferences
      where user_id = rec.user_id and push_bundle_shortage = true
    ) or not exists (
      select 1 from public.notification_preferences where user_id = rec.user_id
    ) then
      insert into public.notifications (
        organization_id, user_id, type, title, body, link, metadata
      ) values (
        new.organization_id,
        rec.user_id,
        'bundle.distributed_shortage',
        notif_title,
        notif_body,
        link_url,
        jsonb_build_object(
          'bundle_id', new.bundle_id,
          'distribution_id', new.id,
          'warehouse_id', new.warehouse_id,
          'quantity', new.quantity
        )
      );
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_bundle_distributions_shortage on public.bundle_distributions;
create trigger trg_bundle_distributions_shortage
  after insert on public.bundle_distributions
  for each row execute function public._notify_bundle_shortage();
