-- 0176_platform_impersonation.sql
-- ─────────────────────────────────────────────────────────────────────
-- Platform Super-Admin "Act as this org" (impersonation).
--
-- DESIGN NOTE: the app is protected by row-level security that checks
-- ACTUAL org membership on every query. A signed cookie can't satisfy that,
-- so impersonation works by granting the platform admin a REAL, temporary,
-- auto-expiring `owner` membership in the target org (inserted via the
-- service-role client behind the platform-admin + step-up gate). RLS then
-- does all the enforcement — no DB-level bypass anywhere. On exit / expiry
-- the grant is removed.
--
--   • organization_members.impersonation_expires_at — NULL on a real
--     membership; a future timestamp marks an impersonation grant that must
--     be torn down at/after that time.
--   • platform_impersonation_sessions — tracks the active grant so we can
--     (a) restore the admin's previous active org on exit, (b) render the
--     "acting as" banner, (c) sweep expired grants. RLS on, no policies
--     (service-role only).
-- ─────────────────────────────────────────────────────────────────────

alter table public.organization_members
  add column if not exists impersonation_expires_at timestamptz;

comment on column public.organization_members.impersonation_expires_at is
  'NULL = real membership. Non-NULL = a platform-admin impersonation grant that auto-expires at this time.';

create table if not exists public.platform_impersonation_sessions (
  id                        uuid primary key default gen_random_uuid(),
  admin_user_id             uuid not null references public.user_profiles(id) on delete cascade,
  target_organization_id    uuid not null references public.organizations(id) on delete cascade,
  -- the admin's default org BEFORE impersonation, restored on exit
  previous_organization_id  uuid references public.organizations(id) on delete set null,
  started_at                timestamptz not null default now(),
  expires_at                timestamptz not null,
  ended_at                  timestamptz
);

create index if not exists platform_impersonation_active_idx
  on public.platform_impersonation_sessions (admin_user_id)
  where ended_at is null;

-- RLS ON, NO policies → service-role-only (the impersonation service runs
-- behind requirePlatformAdmin + AAL2 step-up).
alter table public.platform_impersonation_sessions enable row level security;
