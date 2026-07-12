-- 0257: first-run onboarding dismissal (cross-device).
-- Null = never dismissed → the animated Getting-started panel shows until
-- every task auto-completes or the user dismisses it.
alter table public.user_profiles
  add column if not exists onboarding_dismissed_at timestamptz;
