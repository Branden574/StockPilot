-- 0036_digest_section_optins.sql
-- Per-section opt-in flags for the weekly inventory digest. Lets users
-- subscribe to just the parts they care about (e.g. only low-stock
-- alerts) instead of the all-or-nothing master toggle.
--
-- Defaults are TRUE so anyone already opted into email_digest_optin
-- keeps receiving the full digest after this migration runs. The
-- master email_digest_optin from migration 0034 still gates whether
-- any email goes out at all.
--
-- Spec: docs/superpowers/specs/2026-05-08-weekly-email-digest-design.md (extended)

alter table public.user_profiles
  add column if not exists digest_section_low_stock     boolean not null default true;
alter table public.user_profiles
  add column if not exists digest_section_open_pos      boolean not null default true;
alter table public.user_profiles
  add column if not exists digest_section_cycle_counts  boolean not null default true;

comment on column public.user_profiles.digest_section_low_stock is
  'When true and email_digest_optin is true, the weekly digest includes the Low / out of stock section.';
comment on column public.user_profiles.digest_section_open_pos is
  'When true and email_digest_optin is true, the weekly digest includes the Open purchase orders section.';
comment on column public.user_profiles.digest_section_cycle_counts is
  'When true and email_digest_optin is true, the weekly digest includes the Cycle counts in progress section.';
