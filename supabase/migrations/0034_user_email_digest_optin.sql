-- 0034_user_email_digest_optin.sql
-- Adds an opt-in flag for the weekly inventory digest. Default false so
-- the cron can never send to anyone before they explicitly enable it
-- in /dashboard/settings/notifications.
--
-- Spec: docs/superpowers/specs/2026-05-08-weekly-email-digest-design.md

alter table public.user_profiles
  add column if not exists email_digest_optin boolean not null default false;

comment on column public.user_profiles.email_digest_optin is
  'When true, this user receives the weekly inventory digest email (Mondays). Opt-in via /dashboard/settings/notifications.';

-- Partial index for the cron query that filters opted-in recipients.
-- Tiny index — only opt-in rows live here, not the full table.
create index if not exists user_profiles_email_digest_optin_idx
  on public.user_profiles(id)
  where email_digest_optin = true;
