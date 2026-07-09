-- Passphrase-gated org deletion for the platform super-admin console.
-- Orgs have no soft-delete, so removing one is a hard cascade delete — a
-- catastrophic action if a platform-admin session is ever compromised. This adds
-- a SECOND factor beyond the platform-admin allowlist + AAL2: a deletion
-- passphrase the owner sets, required (and scrypt-verified) on every org delete.
-- Even with a stolen platform-admin session, an attacker cannot delete orgs
-- without also knowing the passphrase (which is never exposed to the client).

-- Singleton settings row (id is a constant true so there is exactly one row).
create table if not exists public.platform_settings (
  id                             boolean primary key default true check (id),
  org_deletion_passphrase_hash   text,
  org_deletion_passphrase_salt   text,
  updated_at                     timestamptz not null default now(),
  updated_by                     uuid references public.user_profiles(id) on delete set null
);

-- RLS ON, NO policies → service-role-only (server code behind the platform-admin
-- gate), identical posture to platform_admin_audit. anon/authed cannot read the
-- hash.
alter table public.platform_settings enable row level security;

-- Extend the audit action vocabulary with the two new platform events.
alter table public.platform_admin_audit drop constraint if exists platform_admin_audit_action_check;
alter table public.platform_admin_audit add constraint platform_admin_audit_action_check
  check (action in (
    'viewed_org', 'acted_as_start', 'acted_as_end',
    'billing_changed', 'password_reset_sent',
    'org_provisioned', 'ticket_updated',
    'deletion_passphrase_set', 'org_deleted'
  ));
