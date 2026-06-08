-- 0170_api_keys.sql
-- ─────────────────────────────────────────────────────────────────────
-- Public API keys (the `api_access` premium module, which already declares
-- ownsTables: ['api_keys']). External systems authenticate to the public API
-- with `Authorization: Bearer sk_live_…`.
--
-- Security posture:
--   • We store ONLY a SHA-256 hash of the key (key_hash) — never the key
--     itself. A DB leak therefore can't reveal usable keys. The full key is
--     shown to the admin exactly once at creation.
--   • key_prefix (first chars) is stored purely for display ("sk_live_abc1…").
--   • Keys are org-scoped + carry coarse scopes (e.g. inventory:read).
--   • Revocation is a timestamp; the resolver rejects revoked/expired keys.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.api_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null,
  key_hash         text not null,                 -- sha256 hex of the full key
  key_prefix       text not null,                 -- display only, e.g. 'sk_live_abc1'
  scopes           text[] not null default '{}',
  created_by       uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz
);

create unique index if not exists api_keys_hash_idx on public.api_keys (key_hash);
create index if not exists api_keys_org_idx on public.api_keys (organization_id);

alter table public.api_keys enable row level security;

-- Admins manage their org's keys (the create/list/revoke UI uses the RLS client).
-- The public-API request resolver looks keys up by hash via the SERVICE-ROLE
-- client (no user session on an external API call), so it isn't bound by RLS.
drop policy if exists api_keys_admin_all on public.api_keys;
create policy api_keys_admin_all on public.api_keys
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));
