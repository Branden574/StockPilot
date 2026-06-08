-- 0167_mfa_admins_default.sql
-- ─────────────────────────────────────────────────────────────────────
-- Raise the MFA floor: admins must have a verified authenticator by default.
--
--   • Changes the column DEFAULT for NEW orgs from 'optional' to
--     'admins_required'.
--   • Upgrades EXISTING orgs currently on 'optional' to 'admins_required'.
--   • Never downgrades an org already on 'all_required'.
--
-- Effect: an owner/admin without an enrolled TOTP authenticator is redirected
-- to enroll on next login (a one-time ~1-minute step — the MFA gate routes them
-- to Settings → Security; it is NOT a lockout). Non-admin members are unchanged.
-- ─────────────────────────────────────────────────────────────────────

alter table public.organizations
  alter column mfa_policy set default 'admins_required';

update public.organizations
  set mfa_policy = 'admins_required'
  where mfa_policy = 'optional';

comment on column public.organizations.mfa_policy is
  'Per-org MFA enforcement: optional | admins_required | all_required. Default raised to admins_required in 0167.';
