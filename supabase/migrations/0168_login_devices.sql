-- 0168_login_devices.sql
-- ─────────────────────────────────────────────────────────────────────
-- Tracks the (coarse) devices each user signs in from, powering a
-- "new device sign-in" alert email.
--
-- Device identity = hash(user_id + a VERSION-STRIPPED user-agent), so a routine
-- browser auto-update doesn't read as a brand-new device (which would spam
-- alerts). Deliberately NOT keyed on IP — mobile/residential IPs churn
-- constantly and would generate noise.
--
-- Rollout-safe: the FIRST device a user is ever seen on is recorded SILENTLY
-- (baseline). Alerts only fire for a NEW device once the account already has at
-- least one known device — so existing users don't get alerted about the device
-- they're already using.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.user_login_devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  device_hash     text not null,
  user_agent      text,
  last_ip         text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (user_id, device_hash)
);

create index if not exists user_login_devices_user_idx
  on public.user_login_devices (user_id);

alter table public.user_login_devices enable row level security;

-- Users may read their OWN device list (foundation for a future "where you're
-- signed in" settings panel). Inserts/updates happen server-side via the admin
-- client in the sign-in hook, so there are intentionally NO write policies.
drop policy if exists user_login_devices_select_self on public.user_login_devices;
create policy user_login_devices_select_self on public.user_login_devices
  for select to authenticated
  using (user_id = auth.uid());
