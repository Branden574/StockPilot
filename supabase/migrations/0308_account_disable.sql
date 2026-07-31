-- 0308_account_disable.sql
-- God-admin temporary account disable. ADDITIVE ONLY. Nothing is backfilled,
-- nothing is dropped, and no existing row changes meaning: a null disabled_at
-- IS the active state, so every pre-existing profile stays active untouched.
--
-- This migration is NOT pushed to production in this workstream. The owner
-- pushes it with `supabase db push --linked` after merge; pending migrations
-- crash pages, so the web deploy must follow, never lead.

-- ── 1) Layer A: the app-level account status ───────────────────────────────
-- Read per request by loadSessionAndContext (lib/auth/session.ts) and
-- withApiContext (lib/auth/api-context.ts). Both look the row up by PRIMARY
-- KEY, so this is not a hot-path filter and needs no index — same posture as
-- 0171's user_profiles.deleted_at.
alter table public.user_profiles
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text,
  add column if not exists disabled_by uuid;

comment on column public.user_profiles.disabled_at is
  'Non-null = platform-admin temporary disable, effective across EVERY org. '
  'Null = active. Read per-request by loadSessionAndContext and withApiContext.';
comment on column public.user_profiles.disabled_reason is
  'Operator-supplied reason (category, plus notes when the category is other). '
  'Service-role visible only — never shown to the disabled user.';
comment on column public.user_profiles.disabled_by is
  'auth uid of the platform admin who disabled the account. Attribution also '
  'lands in platform_admin_audit with the actor email.';

-- ── 2) Widen the god-mode audit action vocabulary ──────────────────────────
-- Precedent: 0241 dropped and re-added this same constraint to add two values.
-- The re-add MUST restate every previously accepted value; omitting one
-- silently breaks an existing god-mode action at insert time. This is the
-- CHECK-constraint analogue of recurring bug #24 (`alter policy ... with check`
-- REPLACES rather than adds). The nine values below were read back out of the
-- database (pg_get_constraintdef at 0307), not copied from a migration file,
-- and 0308's pgTAP asserts each one still inserts.
alter table public.platform_admin_audit
  drop constraint if exists platform_admin_audit_action_check;
alter table public.platform_admin_audit
  add constraint platform_admin_audit_action_check
  check (action in (
    'viewed_org', 'acted_as_start', 'acted_as_end',
    'billing_changed', 'password_reset_sent',
    'org_provisioned', 'ticket_updated',
    'deletion_passphrase_set', 'org_deleted',
    'user_disabled', 'user_reenabled'
  ));

-- ── 3) Admin-scoped session revocation ─────────────────────────────────────
-- The 0213 functions (list_my_sessions / revoke_my_session /
-- revoke_my_other_sessions) are auth.uid()-scoped: a god admin cannot use them
-- against another user. The installed auth-js 2.105.1 has NO signOut-by-user-id
-- (its signOut takes a JWT), so the existing team.ts call that passes a uuid is
-- broken as typed. This function is the ONE supported by-user-id revocation.
--
-- auth.refresh_tokens.session_id references auth.sessions(id) ON DELETE CASCADE
-- (prod-verified), so deleting the session rows cascades the refresh tokens
-- away and the next refresh attempt fails.
create or replace function public.admin_revoke_user_sessions(p_target_user_id uuid)
returns setof uuid
language sql
security definer
set search_path = auth, pg_temp
as $$
  delete from auth.sessions where user_id = p_target_user_id returning id;
$$;

-- Locked to the service-role client used behind the platform-admin gate. An
-- ordinary authenticated user must never be able to kill another user's
-- sessions, which is exactly what a public EXECUTE grant here would allow.
-- Postgres grants EXECUTE to PUBLIC by default and Supabase's default
-- privileges additionally grant anon/authenticated, so all three are revoked
-- explicitly before the single grant that is wanted.
revoke all on function public.admin_revoke_user_sessions(uuid) from public;
revoke all on function public.admin_revoke_user_sessions(uuid) from anon;
revoke all on function public.admin_revoke_user_sessions(uuid) from authenticated;
grant execute on function public.admin_revoke_user_sessions(uuid) to service_role;
