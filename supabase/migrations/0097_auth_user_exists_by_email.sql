-- ============================================================================
-- 0097_auth_user_exists_by_email.sql
--
-- Adds a SECURITY DEFINER helper so the application can cheaply check whether
-- an auth.users row exists for a given email WITHOUT paginating the entire
-- auth.users table from the server side.
--
-- Why: `acceptInviteWithSignupAction` previously called
--      `admin.auth.admin.listUsers({ page, perPage: 1000 })` in a loop bounded
--      by MAX_PAGES=100. With 100k users that's 100 round-trips per invite
--      acceptance, a brittle O(n) scan, and a DoS amplifier (each call goes
--      through GoTrue). This function replaces the loop with a single indexed
--      lookup against `auth.users.email` (lowercased for case-insensitive
--      compare).
--
-- Security model:
--   * SECURITY DEFINER so the caller does not need direct SELECT on auth.users
--     (only the postgres owner does).
--   * Returns boolean ONLY — never echoes the user id, profile, or any other
--     PII back to the caller. Enumeration risk is the same as the previous
--     listUsers loop (the answer "does this email exist" is exposed during
--     invite-by-token + signup, which is a flow gated by single-use tokens
--     only the inviter could have leaked).
--   * Granted to `authenticated` so server actions running under the user's
--     session can call it via supabase.rpc; the admin client also works.
-- ============================================================================

create or replace function public.auth_user_exists_by_email(p_email text)
returns boolean
language sql
security definer
set search_path = public, auth
stable
as $$
  select exists (
    select 1
    from auth.users
    where lower(email) = lower(p_email)
  );
$$;

revoke all on function public.auth_user_exists_by_email(text) from public;
grant execute on function public.auth_user_exists_by_email(text) to authenticated;
grant execute on function public.auth_user_exists_by_email(text) to service_role;

comment on function public.auth_user_exists_by_email(text) is
  'Returns true if an auth.users row exists for the given email (case-insensitive). '
  'Used by invite signup flow to avoid scanning the entire auth.users table.';
