-- 0009_mfa_policy.sql
-- ─────────────────────────────────────────────────────────────────────
-- Per-org MFA policy. Drives whether a user must have a verified
-- authenticator factor to keep their session at AAL2.
--
-- Values:
--   'optional'        — users may enroll TOTP, but it isn't required
--   'admins_required' — owner/admin must have MFA; others optional
--   'all_required'    — every member must have MFA enrolled + verified
-- ─────────────────────────────────────────────────────────────────────

alter table public.organizations
  add column if not exists mfa_policy text not null default 'optional'
    check (mfa_policy in ('optional', 'admins_required', 'all_required'));

comment on column public.organizations.mfa_policy is
  'Per-org MFA enforcement: optional | admins_required | all_required';
