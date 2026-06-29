-- 0221_user_connections.sql — per-user external connections (Zendesk agent console).
-- Distinct from org_connections (per-org). One row per (org, user, provider).
create table if not exists public.user_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  subdomain text,
  external_account jsonb not null default '{}'::jsonb,
  secret_id uuid,
  status text not null default 'active' check (status in ('active','disconnected','error')),
  last_error text,
  last_connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, provider_id)
);
create index if not exists user_connections_org_user_idx on public.user_connections (organization_id, user_id);
create index if not exists user_connections_user_provider_idx on public.user_connections (user_id, provider_id);

alter table public.user_connections enable row level security;

-- A user may only see/manage THEIR OWN connection rows, within an org they belong to.
create policy user_connections_select on public.user_connections
  for select using (
    user_id = auth.uid()
    and exists (select 1 from public.organization_members m
                where m.organization_id = user_connections.organization_id
                  and m.user_id = auth.uid() and m.accepted_at is not null)
  );
create policy user_connections_insert on public.user_connections
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.organization_members m
                where m.organization_id = user_connections.organization_id
                  and m.user_id = auth.uid() and m.accepted_at is not null)
  );
create policy user_connections_update on public.user_connections
  for update using (
    user_id = auth.uid()
    and exists (select 1 from public.organization_members m
                where m.organization_id = user_connections.organization_id
                  and m.user_id = auth.uid() and m.accepted_at is not null)
  ) with check (
    user_id = auth.uid()
    and exists (select 1 from public.organization_members m
                where m.organization_id = user_connections.organization_id
                  and m.user_id = auth.uid() and m.accepted_at is not null)
  );
create policy user_connections_delete on public.user_connections
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.user_connections to authenticated;
