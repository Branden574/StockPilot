-- ============================================================================
-- 0146_connector_framework.sql — multi-connector integration framework.
-- Vault-backed per-org connection secrets (verified available: YES —
-- supabase_vault 0.3.1 installed on the linked project).
--
-- One-way export framework only: StockPilot -> external provider. Nothing in
-- here writes provider data back into StockPilot. The `integrations` module is
-- OFF by default (entitlement gating lives in a later task).
--
-- Three per-org tables:
--   org_connections     — one row per (org, provider).
--   connection_mappings — local<->external id correspondence.
--   connection_sync_log — per-(connection,event) delivery ledger.
--
-- Secret invariant: OAuth tokens live ONLY in Supabase Vault. The tables store
-- a `secret_id` UUID handle, never the token. The connector_secret_* RPCs are
-- SECURITY DEFINER and callable ONLY by service_role (revoked from
-- authenticated + anon) so the browser/'authenticated' role can never read a
-- token.
--
-- RLS helpers re-used verbatim from 0001_init.sql:
--   is_org_member(org_id uuid) -> boolean
--   has_org_role(org_id uuid, min_role text) -> boolean   (role arg is text)
-- Policies wrap helper calls in (SELECT ...) per the InitPlan convention (0140)
-- and use the `drop policy if exists` idempotency guard from 0144.
-- ============================================================================

create extension if not exists supabase_vault with schema vault;

-- 1. org_connections — one row per (org, provider). ------------------------
create table if not exists public.org_connections (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  provider_id         text not null,
  status              text not null default 'pending'
                        check (status in ('pending','active','error','disconnected')),
  external_account_id text,
  secret_id           uuid,                       -- Vault secret handle; NEVER the token
  settings            jsonb not null default '{}'::jsonb,
  oauth_state         text,
  last_connected_at   timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  created_by          uuid references public.user_profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, provider_id)
);
create index if not exists org_connections_active_idx
  on public.org_connections (organization_id) where status = 'active';

-- 2. connection_mappings — local<->external id correspondence. -------------
create table if not exists public.connection_mappings (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.org_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type     text not null,
  local_id        uuid,
  external_id     text not null,
  external_meta   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, entity_type, local_id),
  unique (connection_id, entity_type, external_id)
);
create index if not exists connection_mappings_lookup_idx
  on public.connection_mappings (connection_id, entity_type);

-- 3. connection_sync_log — per-(connection,event) delivery ledger. ---------
create table if not exists public.connection_sync_log (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.org_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  outbox_event_id uuid not null references public.outbox_events(id) on delete cascade,
  topic           text not null,
  status          text not null default 'pending'
                    check (status in ('pending','success','error','dead')),
  attempts        int not null default 0,
  external_id     text,
  last_error      text,
  next_attempt_at timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, outbox_event_id)
);
create index if not exists connection_sync_log_due_idx
  on public.connection_sync_log (status, next_attempt_at) where status in ('pending','error');

-- updated_at maintenance (mirrors the tg_set_updated_at convention, 0001). --
drop trigger if exists org_connections_set_updated_at on public.org_connections;
create trigger org_connections_set_updated_at
  before update on public.org_connections
  for each row execute function public.tg_set_updated_at();
drop trigger if exists connection_mappings_set_updated_at on public.connection_mappings;
create trigger connection_mappings_set_updated_at
  before update on public.connection_mappings
  for each row execute function public.tg_set_updated_at();
drop trigger if exists connection_sync_log_set_updated_at on public.connection_sync_log;
create trigger connection_sync_log_set_updated_at
  before update on public.connection_sync_log
  for each row execute function public.tg_set_updated_at();

-- RLS ----------------------------------------------------------------------
alter table public.org_connections     enable row level security;
alter table public.connection_mappings enable row level security;
alter table public.connection_sync_log enable row level security;

-- org_connections: member read (NO token exposed — secret_id is a UUID), admin write.
drop policy if exists org_connections_select on public.org_connections;
create policy org_connections_select on public.org_connections
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists org_connections_write on public.org_connections;
create policy org_connections_write on public.org_connections
  for all to authenticated
  using ((select public.has_org_role(organization_id,'admin')))
  with check ((select public.has_org_role(organization_id,'admin')));

-- connection_mappings: member read, manager write.
drop policy if exists connection_mappings_select on public.connection_mappings;
create policy connection_mappings_select on public.connection_mappings
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists connection_mappings_write on public.connection_mappings;
create policy connection_mappings_write on public.connection_mappings
  for all to authenticated
  using ((select public.has_org_role(organization_id,'manager')))
  with check ((select public.has_org_role(organization_id,'manager')));

-- connection_sync_log: member read (settings UI health); writes by the
-- service-role worker only (no authenticated write policy).
drop policy if exists connection_sync_log_select on public.connection_sync_log;
create policy connection_sync_log_select on public.connection_sync_log
  for select to authenticated using ((select public.is_org_member(organization_id)));

grant select, insert, update, delete on public.org_connections     to authenticated;
grant select, insert, update, delete on public.connection_mappings to authenticated;
grant select on public.connection_sync_log to authenticated;

-- ============================================================================
-- Vault secret RPCs — service_role ONLY (revoked from authenticated/anon).
-- vault 0.3.1 signatures (verified on the linked project):
--   vault.create_secret(new_secret text, new_name text, new_description text,
--                        new_key_id uuid) returns uuid  -- last 3 args defaulted
--   vault.update_secret(secret_id uuid, new_secret text, new_name text,
--                        new_description text, new_key_id uuid) returns void
--   vault.decrypted_secrets is a view exposing `decrypted_secret`.
-- ============================================================================
create or replace function public.connector_secret_put(p_secret jsonb, p_name text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    select vault.create_secret(p_secret::text, p_name, 'connector secret') into v_id;
  else
    perform vault.update_secret(v_id, p_secret::text);
  end if;
  return v_id;
end; $$;

create or replace function public.connector_secret_get(p_secret_id uuid)
returns jsonb language sql security definer set search_path = public, vault as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where id = p_secret_id;
$$;

create or replace function public.connector_secret_delete(p_secret_id uuid)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where id = p_secret_id;
$$;

revoke all on function public.connector_secret_put(jsonb, text)   from authenticated, anon;
revoke all on function public.connector_secret_get(uuid)          from authenticated, anon;
revoke all on function public.connector_secret_delete(uuid)       from authenticated, anon;
grant execute on function public.connector_secret_put(jsonb, text)   to service_role;
grant execute on function public.connector_secret_get(uuid)          to service_role;
grant execute on function public.connector_secret_delete(uuid)       to service_role;
