-- 0169_integration_events.sql
-- ─────────────────────────────────────────────────────────────────────
-- Outbound event delivery — generic webhooks + Slack/Teams alerts.
--
-- One event-dispatch system, three delivery target types. Domain events
-- (stock.low, order.created, po.received, …) fan out to whatever endpoints an
-- admin configured. Webhooks are HMAC-signed; Slack/Teams post to their own
-- incoming-webhook URLs. Outbound only — StockPilot never ingests from these.
--
-- `integration_deliveries` is the durable outbox: dispatch inserts a row per
-- subscribed endpoint, an immediate attempt fires, and the every-5-min
-- drain-outbox cron retries failures with backoff (status pending→success/
-- failed→dead at max_attempts).
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.integration_endpoints (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  type             text not null check (type in ('webhook', 'slack', 'teams')),
  url              text not null,
  -- HMAC-SHA256 signing secret for type='webhook' (null for slack/teams, which
  -- authenticate via their unguessable incoming-webhook URL). Shown to the admin
  -- once at creation; readable only by org admins (RLS) for re-display/rotate.
  secret           text,
  event_types      text[] not null default '{}',
  enabled          boolean not null default true,
  description      text,
  created_by       uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_delivery_at timestamptz,
  last_status      text
);

create index if not exists integration_endpoints_org_idx
  on public.integration_endpoints (organization_id);

create table if not exists public.integration_deliveries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  endpoint_id      uuid not null references public.integration_endpoints(id) on delete cascade,
  event_type       text not null,
  payload          jsonb not null,
  status           text not null default 'pending'
                     check (status in ('pending', 'success', 'failed', 'dead')),
  attempts         int not null default 0,
  max_attempts     int not null default 6,
  next_attempt_at  timestamptz not null default now(),
  response_code    int,
  error            text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz
);

-- Drain index: the cron pulls due pending rows oldest-first.
create index if not exists integration_deliveries_drain_idx
  on public.integration_deliveries (next_attempt_at)
  where status = 'pending';
create index if not exists integration_deliveries_endpoint_idx
  on public.integration_deliveries (endpoint_id, created_at desc);

alter table public.integration_endpoints enable row level security;
alter table public.integration_deliveries enable row level security;

-- Endpoints: org admins manage. (Service-layer also gates on the `integrations`
-- module + `integrations:manage` permission; RLS is the floor.)
drop policy if exists integration_endpoints_admin_all on public.integration_endpoints;
create policy integration_endpoints_admin_all on public.integration_endpoints
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- Deliveries are written server-side (admin client); admins may READ the log.
drop policy if exists integration_deliveries_admin_read on public.integration_deliveries;
create policy integration_deliveries_admin_read on public.integration_deliveries
  for select to authenticated
  using (public.has_org_role(organization_id, 'admin'));
