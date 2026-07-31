-- 0309_pin_user_profile_disable_flags.sql
-- Closes the hole 0308 opened: a disabled user could un-disable themselves.
--
-- THE HOLE
--   0003's user_profiles_update_self is
--     for update to authenticated using (id = auth.uid()) with check (id = auth.uid())
--   — row-scoped, with NO column restriction. 0308 then added disabled_at /
--   disabled_reason / disabled_by to that same table. Layer A (the disable flag
--   every enforcement chokepoint reads) therefore sat on a column the subject of
--   the disable could write.
--
--   The access token is the reason this is exploitable rather than theoretical.
--   Disabling revokes auth.sessions (0308's admin_revoke_user_sessions), but that
--   only stops the NEXT refresh; the already-issued JWT stays signature-valid for
--   up to its full ~1h TTL. PostgREST and RLS validate that signature and never
--   consult GoTrue, so for that window a banned user still has a working
--   authenticated connection. One
--     PATCH /rest/v1/user_profiles?id=eq.<self>  {"disabled_at": null}
--   and Layer A reads active again — and the platform console, which reads the
--   same column, reports them active too. The feature was defeatable by exactly
--   the person it exists to stop.
--
-- THE FIX — precedent: 0177's tg_pin_user_profile_email
--   Same shape (BEFORE UPDATE ... FOR EACH ROW ... WHEN the guarded columns
--   actually change), same silent-revert posture, same naming. Pinning at the
--   trigger rather than narrowing the RLS policy is deliberate: a column-level
--   policy would have to be kept in sync with every future column, and recurring
--   bug #24 (`alter policy ... with check` REPLACES rather than adds) makes
--   editing that shared policy the more dangerous edit of the two.
--
-- WHERE THIS DIFFERS FROM 0177
--   0177 pins email UNCONDITIONALLY, because nothing legitimately updates it —
--   it is owned by the auth identity. These three columns ARE legitimately
--   written: the disable/re-enable service writes them through
--   createAdminClient (service-role). So the trigger must revert for ordinary
--   callers and ALLOW the privileged writer. Pinning unconditionally would break
--   the feature; not pinning at all leaves the hole.
--
-- WHY current_user IS THE DETECTION MECHANISM (measured, not assumed)
--   Probed on the local stack with real connections — a real PostgREST request
--   per role, plus a direct psql connection:
--
--     caller                                   current_user    auth.role()
--     ---------------------------------------- --------------- -------------
--     service-role key (sb_secret_, PostgREST)  service_role    service_role
--     signed-in user's access token (PostgREST) authenticated   authenticated
--     publishable key, no user (PostgREST)      anon            anon
--     direct psql / migrations / pgTAP / cron   postgres        NULL
--
--   Both columns discriminate the request roles, so the last row is the
--   tie-breaker. auth.role() reads the request.jwt.claims GUC, which only
--   PostgREST sets; on every direct connection it is NULL. An auth.role()-based
--   rule would therefore have to treat NULL as "allow", and that is fail-OPEN —
--   any future path that reaches this table without PostgREST populating claims
--   would be waved through, and the check would silently become a no-op if
--   claims stopped being set. current_user is set by Postgres itself, is never
--   null, and is exactly what PostgREST switches per request (SET LOCAL ROLE
--   from the validated JWT's role claim; session_user stays `authenticator`), so
--   it stays correct under the new sb_secret_/sb_publishable_ keys as well as
--   legacy JWT keys — verified above against sb_secret_, which is what this
--   project now uses.
--
--   The list is an ALLOWLIST, so it fails CLOSED: an unrecognised role reverts.
--   A denylist of ('authenticated','anon') would silently grant write access to
--   any request-facing role added later. The three allowed roles are the only
--   legitimate writers: service_role is the app's createAdminClient (the only
--   way the product writes these columns); postgres is migrations, `supabase db
--   reset`, pgTAP and operator SQL; supabase_admin is the platform superuser.
--   No custom PostgREST role exists in this schema — every `grant ... to` in
--   supabase/migrations targets anon, authenticated or service_role — so the
--   request-facing surface this must defend against is exactly those roles.
--
--   A caller who could SET ROLE service_role would defeat this, but such a
--   caller could equally set_config('request.jwt.claims', ...) and defeat
--   auth.role(); it needs arbitrary SQL execution, which PostgREST does not
--   grant. Neither candidate is weaker on that axis, so it does not decide.
--
-- POSTURE: silent revert, not an exception — matching 0177. Raising would name
-- the guarded column in the error, telling an attacker precisely what to probe
-- for, and for a legitimate no-op the honest UX is nothing at all.
--
-- ── WHY THERE IS NO `WHEN` CLAUSE (the first cut of this migration had one) ──
-- The original trigger carried
--     when (new.disabled_at is distinct from old.disabled_at or ... )
-- so it fired ONLY when one of the three guarded columns changed. That scoped
-- the guard to the un-disable attack and left the rest of the row writable by a
-- disabled account. Reproduced on the local stack: as role `authenticated` with
-- request.jwt.claims.sub set to a profile whose disabled_at was already stamped,
--     update public.user_profiles set full_name = 'DEFACED' where id = auth.uid()
-- returned UPDATE 1 and the new name stuck.
--
-- user_profiles is not a private preferences row. full_name and avatar_url are
-- embedded into every colleague's UI through `user_profiles!<fk> (full_name,
-- avatar_url)`: the team list, the order timeline actor, the cycle-count
-- assignee, the movement actor, the procedure author. A user disabled for
-- suspected compromise could therefore deface their identity ORG-WIDE for the
-- remaining ~1h of their access-token TTL — with the same token that 0310 now
-- refuses everywhere else. It also contradicted the guard the web layer
-- documents ("a disabled token is refused for SELECT/INSERT/UPDATE/DELETE
-- immediately", lib/auth/account-status.ts).
--
-- So the trigger now fires on EVERY update of this table and takes one of three
-- paths:
--   1. an allowlisted role (service_role / postgres / supabase_admin) — allowed
--      through untouched, because the disable/re-enable service and migrations
--      MUST be able to write a disabled row;
--   2. the row's account is already disabled — the whole statement is dropped
--      for that row (`return null`), so nothing about a disabled identity can be
--      changed by anyone but the platform;
--   3. an active row — only the three disable columns are pinned, exactly as
--      before, so ordinary profile editing is untouched.
--
-- `return null` rather than `return old`: returning OLD still performs a write
-- of identical values (a new row version, AFTER triggers, an updated_at bump on
-- any future trigger that sets one). Returning NULL suppresses the row update
-- entirely, which is the honest meaning of "a disabled account cannot write this
-- row". It stays SILENT — the statement succeeds and simply affects no rows —
-- for the same reason the revert is silent.
--
-- The check is `old.disabled_at is not null`, i.e. a property of the ROW, not of
-- the caller. That is deliberate: it needs no nested SECURITY DEFINER call (this
-- trigger runs on the hottest table in the product since 0310), and the only
-- policy that lets a non-service caller reach another user's row is none — 0003's
-- user_profiles_update_self is `id = auth.uid()` — so row-disabled and
-- caller-disabled are the same fact here, and the row-based form additionally
-- refuses any future policy that widened the reach.

create or replace function public.tg_pin_user_profile_disable_flags()
returns trigger
language plpgsql
as $$
begin
  -- See the header: current_user, not auth.role(). auth.role() is NULL on every
  -- non-PostgREST connection, which would force a fail-open "NULL means allow".
  -- Allowlist, so an unrecognised caller reverts rather than being trusted.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  -- A DISABLED profile is frozen for every request-facing role. Not just the
  -- three flags: full_name and avatar_url are rendered to the whole org, so a
  -- disabled account editing them is an org-wide write, not a self-scoped one.
  -- Returning NULL skips the row entirely — no write, no AFTER triggers.
  if old.disabled_at is not null then
    return null;
  end if;

  -- Layer A and its attribution are owned by the platform-admin disable action.
  -- Silently keep the existing values for everyone else, including the row's
  -- own owner holding a still-valid pre-disable access token.
  new.disabled_at     := old.disabled_at;
  new.disabled_reason := old.disabled_reason;
  new.disabled_by     := old.disabled_by;
  return new;
end;
$$;

comment on function public.tg_pin_user_profile_disable_flags() is
  'Two guards in one BEFORE UPDATE trigger, for any caller that is not the '
  'service role (or a direct superuser connection): (1) a row whose account is '
  'already disabled is frozen ENTIRELY — the update is dropped, so a disabled '
  'user cannot deface the full_name/avatar_url every colleague''s UI renders; '
  '(2) on an active row, disabled_at/_reason/_by are reverted, so 0003''s '
  'column-unrestricted user_profiles_update_self cannot be used to clear the '
  'disable flag with a still-valid access token.';

drop trigger if exists pin_user_profile_disable_flags on public.user_profiles;
-- No WHEN clause on purpose — see the header. Scoping the trigger to the three
-- disable columns is exactly what left the rest of a disabled user's row
-- writable. The allowlist check is the first statement in the body, so the
-- service-role and migration paths pay one string comparison per row.
create trigger pin_user_profile_disable_flags
  before update on public.user_profiles
  for each row
  execute function public.tg_pin_user_profile_disable_flags();
