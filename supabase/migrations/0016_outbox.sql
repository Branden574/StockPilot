-- 0016_outbox.sql
-- ─────────────────────────────────────────────────────────────────────
-- Transactional outbox for downstream consumers (notifications, analytics,
-- integrations). A future worker process drains rows where published_at
-- IS NULL. Today the rows just sit there for audit/replay.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

create table if not exists public.outbox_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  topic           text not null,
  aggregate_type  text not null,
  aggregate_id    uuid,
  dedupe_key      text,
  payload         jsonb not null,
  published_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- Dedupe per org+key (skip when dedupe_key is null).
create unique index if not exists outbox_dedupe_uniq
  on public.outbox_events(organization_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists outbox_unpublished_idx
  on public.outbox_events(organization_id, created_at)
  where published_at is null;

create index if not exists outbox_topic_idx
  on public.outbox_events(organization_id, topic, created_at desc);

alter table public.outbox_events enable row level security;

drop policy if exists outbox_events_select on public.outbox_events;
create policy outbox_events_select on public.outbox_events
  for select using (
    public.has_org_role(organization_id, 'manager')
  );

drop policy if exists outbox_events_write on public.outbox_events;
create policy outbox_events_write on public.outbox_events
  for all using (public.has_org_role(organization_id, 'manager'));

create or replace function public.publish_outbox(
  p_org_id        uuid,
  p_topic         text,
  p_aggregate_type text,
  p_aggregate_id  uuid,
  p_payload       jsonb,
  p_dedupe_key    text default null
)
returns uuid
language sql
security invoker
set search_path = public
as $$
  insert into public.outbox_events(
    organization_id, topic, aggregate_type, aggregate_id, dedupe_key, payload
  ) values (
    p_org_id, p_topic, p_aggregate_type, p_aggregate_id, p_dedupe_key, p_payload
  )
  on conflict (organization_id, dedupe_key) where dedupe_key is not null do nothing
  returning id;
$$;

grant execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to authenticated;
