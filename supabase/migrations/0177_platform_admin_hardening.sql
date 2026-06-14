-- 0177_platform_admin_hardening.sql
-- ─────────────────────────────────────────────────────────────────────
-- Two security fixes from the platform super-admin console adversarial review.
--
-- FIX 1 (CRITICAL, defense-in-depth) — user_profiles.email is immutable.
--   The RLS policy user_profiles_update_self (0003) lets a user UPDATE their
--   own row with no column restriction, so a member could rewrite their
--   `email` column to an allowlisted platform-admin address. The PRIMARY fix
--   is in code (the gate now authorizes on the VERIFIED auth email from
--   auth.getUser(), never the profile column). This trigger closes the root at
--   the DB so the profile email can never diverge from the auth identity:
--   email is set once by the auth-sync trigger on INSERT and pinned thereafter.
--
-- FIX 2 (HIGH) — impersonation expiry is self-enforcing.
--   "Act as" grants a real organization_members row with impersonation_expires_at
--   set (0176). The membership RLS helpers only checked `accepted_at`, so an
--   expired grant kept full owner access until a cron sweep deleted the row.
--   Redefining the three helpers to also require the grant be unexpired makes
--   expiry enforced DB-wide the instant it passes — the sweep becomes pure
--   cleanup, not the security boundary. Real memberships
--   (impersonation_expires_at IS NULL) are unaffected.
-- ─────────────────────────────────────────────────────────────────────

-- ── FIX 1: pin user_profiles.email on UPDATE ──────────────────────────
create or replace function public.tg_pin_user_profile_email()
returns trigger
language plpgsql
as $$
begin
  -- email is owned by the auth identity (synced on signup); never mutable via
  -- a row UPDATE, regardless of caller. Silently keep the existing value.
  new.email := old.email;
  return new;
end;
$$;

drop trigger if exists pin_user_profile_email on public.user_profiles;
create trigger pin_user_profile_email
  before update on public.user_profiles
  for each row
  when (new.email is distinct from old.email)
  execute function public.tg_pin_user_profile_email();

-- ── FIX 2: impersonation-aware membership helpers ─────────────────────
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
  );
$$;

create or replace function public.user_org_role(org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.organization_members
  where organization_id = org_id
    and user_id = auth.uid()
    and accepted_at is not null
    and (impersonation_expires_at is null or impersonation_expires_at > now())
  limit 1;
$$;

create or replace function public.has_org_role(org_id uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with role_rank(role, rank) as (
    values
      ('owner',   100),
      ('admin',    80),
      ('manager',  60),
      ('staff',    40),
      ('viewer',   20)
  ),
  user_role as (
    select rr.rank
    from public.organization_members m
    join role_rank rr on rr.role = m.role
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    limit 1
  )
  select coalesce((select rank from user_role), 0)
       >= coalesce((select rank from role_rank where role = min_role), 999);
$$;
