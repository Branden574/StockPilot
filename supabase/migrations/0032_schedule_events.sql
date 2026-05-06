-- 0032_schedule_events.sql
-- ============================================================================
-- Team schedule / job calendar. A single events table, scoped per
-- organization, that any org member can read + write so the team can
-- coordinate location-based work (deliveries, pickups, donation drops,
-- etc.) without leaving StockPilot.
--
-- Trust model:
--   • Read / create / update / delete: any authenticated org member.
--   • The calendar is intentionally collaborative — there's no
--     "events I created" silo. If finer-grained ownership is ever
--     needed (creator-only edit), gate at the service layer rather
--     than rewriting RLS.
-- ============================================================================

create table if not exists public.schedule_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title           text not null,
  starts_at       timestamptz not null,
  /** Open-ended events (e.g. all-day reminder) leave ends_at null. */
  ends_at         timestamptz,
  all_day         boolean not null default false,
  /** Free-text location ("DC4 dock 2", "Customer X HQ"). */
  location_text   text,
  /** Optional pin to a warehouse for filtering / activity. */
  warehouse_id    uuid references public.warehouses(id) on delete set null,
  /** Who asked for the work — could be internal (manager name) or
      external (customer / requester). Free text by intent. */
  requester_name  text,
  details         text,
  status          text not null default 'scheduled'
                    check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  created_by      uuid not null references auth.users(id),
  updated_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Range queries on the calendar view: "events in this month".
create index if not exists schedule_events_org_starts_idx
  on public.schedule_events(organization_id, starts_at);

-- "What's open / in progress?" — covers the dashboard's upcoming
-- panel without scanning closed/cancelled history.
create index if not exists schedule_events_open_idx
  on public.schedule_events(organization_id, starts_at)
  where status in ('scheduled', 'in_progress');

alter table public.schedule_events enable row level security;

drop policy if exists schedule_events_select on public.schedule_events;
create policy schedule_events_select on public.schedule_events
  for select to authenticated
  using (public.is_org_member(organization_id));

drop policy if exists schedule_events_insert on public.schedule_events;
create policy schedule_events_insert on public.schedule_events
  for insert to authenticated
  with check (
    public.is_org_member(organization_id)
    and created_by = auth.uid()
  );

drop policy if exists schedule_events_update on public.schedule_events;
create policy schedule_events_update on public.schedule_events
  for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

drop policy if exists schedule_events_delete on public.schedule_events;
create policy schedule_events_delete on public.schedule_events
  for delete to authenticated
  using (public.is_org_member(organization_id));

-- Keep updated_at honest. Trigger fires on UPDATE only — INSERTs use
-- the column default. Mirrors the pattern other org tables use.
create or replace function public._touch_schedule_events_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists schedule_events_touch_updated_at on public.schedule_events;
create trigger schedule_events_touch_updated_at
  before update on public.schedule_events
  for each row execute function public._touch_schedule_events_updated_at();
