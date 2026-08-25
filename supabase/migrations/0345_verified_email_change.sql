-- 0345_verified_email_change.sql
-- ─────────────────────────────────────────────────────────────────────
-- Verified self-service email change: make user_profiles.email a TRUE
-- projection of the auth identity instead of a frozen copy.
--
-- Before this migration:
--   * 0001 copied auth.users.email into user_profiles.email on INSERT only.
--   * 0177 pinned the column against every UPDATE for every role, including
--     service_role, with no exception — so once GoTrue changed an auth email
--     the profile (and with it session.email, the weekly digest recipient,
--     schedule reminders, admin password resets, invite matching and every
--     member list) kept the OLD address forever. The platform console
--     comment recorded that as acceptable only because "no product flow
--     changes an auth email today". This feature is that flow.
--
-- After this migration:
--   1. tg_pin_user_profile_email allows a profile-email write ONLY when the
--      new value equals the verified auth.users.email for that row. Anything
--      else is still silently reverted, for every caller — the 0177 defence
--      (a member rewriting their profile email to a platform-admin
--      allowlisted address) is intact, and even service_role cannot put an
--      arbitrary address into the projection.
--   2. on_auth_user_email_updated (AFTER UPDATE OF email ON auth.users) writes
--      the projection and an audit row in the SAME transaction as GoTrue's
--      own update. No client path can skip it.
--   3. cancel_pending_email_change(uuid) lets the app abandon a pending change,
--      because GoTrue's admin API exposes no cancel (measured 2026-08-25).
--      service_role only; it can only clear pending state, never set an email.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. The pin becomes "only the verified identity may be written" ─────
create or replace function public.tg_pin_user_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_email text;
begin
  -- Fires only when new.email is distinct from old.email (trigger WHEN).
  select u.email into v_auth_email
    from auth.users u
   where u.id = new.id;

  if v_auth_email is not null
     and lower(new.email::text) = lower(v_auth_email) then
    -- The write matches the auth identity: allow it, normalised to the exact
    -- spelling GoTrue holds so the two columns compare equal byte-for-byte.
    new.email := v_auth_email;
    return new;
  end if;

  -- Anything else is what 0177 was written to stop. Keep the existing value.
  new.email := old.email;
  return new;
end;
$$;

-- 0329 posture: trigger functions hold no EXECUTE for anon/authenticated.
revoke execute on function public.tg_pin_user_profile_email() from public, anon, authenticated;

-- The column is citext, so 0177's `new.email is distinct from old.email` did
-- NOT fire for a case-only variant ('ALPHA@…' vs 'alpha@…') and the odd
-- spelling landed verbatim. Compare as text so every spelling change goes
-- through the pin and comes out in the exact form GoTrue holds.
drop trigger if exists pin_user_profile_email on public.user_profiles;
create trigger pin_user_profile_email
  before update on public.user_profiles
  for each row
  when (new.email::text is distinct from old.email::text)
  execute function public.tg_pin_user_profile_email();

-- ── 2. auth.users.email → user_profiles.email, transactionally ─────────
create or replace function public.tg_sync_profile_email_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  update public.user_profiles
     set email = new.email
   where id = new.id
     and lower(email::text) is distinct from lower(new.email);

  if found then
    select default_organization_id into v_org
      from public.user_profiles
     where id = new.id;

    -- The audit row is written here, not by the app, so it exists whichever
    -- path applied the change (self-service confirmation, an admin update,
    -- a future support tool) and exactly once per real change.
    insert into public.audit_logs (organization_id, user_id, event, metadata)
    values (
      v_org,
      new.id,
      'user.email.changed',
      jsonb_build_object(
        'entity_type', 'user',
        'entity_id',   new.id,
        'warehouse_id', null,
        'before',      old.email,
        'after',       new.email,
        'reason',      null,
        'source',      'auth_email_updated'
      )
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.tg_sync_profile_email_from_auth() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.tg_sync_profile_email_from_auth();

-- ── 3. Cancel a pending change (GoTrue has no API for it) ──────────────
create or replace function public.cancel_pending_email_change(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update auth.users
     set email_change                = '',
         email_change_token_current  = '',
         email_change_token_new      = '',
         email_change_sent_at        = null,
         email_change_confirm_status = 0
   where id = p_user_id
     and coalesce(email_change, '') <> '';
  return found;
end;
$$;

revoke execute on function public.cancel_pending_email_change(uuid) from public, anon, authenticated;
grant execute on function public.cancel_pending_email_change(uuid) to service_role;

comment on function public.cancel_pending_email_change(uuid) is
  'Clears GoTrue''s pending email-change state for one user. service_role only. Can only remove a pending change; never sets an email.';
