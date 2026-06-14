-- 0175_platform_super_admin.sql
-- ─────────────────────────────────────────────────────────────────────
-- Platform Super-Admin Console.
--
-- Two parts:
--   1. Billing-control columns on organizations — the admin override dials
--      that coexist with Stripe (override wins; see resolveEffectivePlan).
--      "Access tier" (what they can use) and "billing arrangement" (how
--      they're billed) are deliberately SEPARATE so "Comped" (no charge,
--      full access) never collides with the literal "free" entry tier.
--   2. platform_admin_audit — an append-only trail of every god-mode action.
--
-- SECURITY: platform_admin_audit has RLS ON with NO policies → only the
-- service-role client (server code behind requirePlatformAdmin) can touch
-- it. No tenant RLS is changed anywhere in this migration; cross-org access
-- in the console is service-role + code-gated, never a DB-level bypass.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. Billing-control override columns on organizations ──────────────
alter table public.organizations
  add column if not exists access_tier text
    check (access_tier is null or access_tier in ('free', 'pro', 'business', 'enterprise')),
  add column if not exists billing_arrangement text
    check (billing_arrangement is null
           or billing_arrangement in ('standard', 'comped', 'trial', 'custom', 'stripe')),
  add column if not exists custom_price_cents integer
    check (custom_price_cents is null or custom_price_cents >= 0),
  add column if not exists custom_price_interval text
    check (custom_price_interval is null or custom_price_interval in ('month', 'year')),
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_tier text
    check (trial_tier is null or trial_tier in ('free', 'pro', 'business', 'enterprise')),
  add column if not exists billing_notes text,
  add column if not exists all_modules_comp boolean not null default false;

comment on column public.organizations.access_tier is
  'Platform-admin forced tier override. NULL = defer to Stripe/trial/default. Wins over Stripe.';
comment on column public.organizations.billing_arrangement is
  'Display/intent label: standard|comped|trial|custom|stripe. Comped = full access, no charge.';
comment on column public.organizations.all_modules_comp is
  'When true, the entitlement layer treats every premium module as enabled (used with Comped).';

-- ── 2. platform_admin_audit — append-only god-mode action trail ───────
create table if not exists public.platform_admin_audit (
  id                      uuid primary key default gen_random_uuid(),
  actor_user_id           uuid not null references public.user_profiles(id) on delete set null,
  actor_email             text not null,
  action                  text not null
                            check (action in (
                              'viewed_org', 'acted_as_start', 'acted_as_end',
                              'billing_changed', 'password_reset_sent',
                              'org_provisioned', 'ticket_updated'
                            )),
  target_organization_id  uuid references public.organizations(id) on delete set null,
  target_user_id          uuid references public.user_profiles(id) on delete set null,
  detail                  jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now()
);

create index if not exists platform_admin_audit_created_idx
  on public.platform_admin_audit (created_at desc);
create index if not exists platform_admin_audit_org_idx
  on public.platform_admin_audit (target_organization_id, created_at desc);

-- RLS ON, NO policies → service-role-only (server code behind the
-- platform-admin gate). The anon/authed clients cannot read or write it.
alter table public.platform_admin_audit enable row level security;
