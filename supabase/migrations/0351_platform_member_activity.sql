-- 0351_platform_member_activity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- "Last active" for the platform super-admin console (the Users tab on
-- /platform/orgs/[id]). READ-ONLY and ADDITIVE: one function. No table, no
-- column, no trigger, no index, no write, no backfill.
--
-- WHY A FUNCTION AT ALL
--   The auth schema is not published over PostgREST, so the service-role admin
--   client behind getOrgMembers() cannot select auth.users or auth.sessions.
--   SECURITY DEFINER is what lets one RPC read them (the 0213 / 0308 shape).
--
-- WHY THREE SIGNALS AND NOT auth.users.last_sign_in_at
--   Measured in production on 2026-09-18, for the members of one tenant:
--
--   1. last_sign_in_at is stamped at SIGN-IN only. Sessions here live for
--      months on refresh tokens ("Keep me signed in", the mobile app), so it
--      understates real use badly: one admin last signed in on 22 Jul and
--      renewed a session the same morning this was written; one manager last
--      signed in on 28 May and was active the day before.
--   2. auth.sessions.refreshed_at moves roughly once an hour while the app is
--      open (jwt expiry 3600s). It is the best account-wide signal, but the
--      row is DELETED on sign-out and on revocation (0213, 0308), and the
--      timestamp goes with it. It also moves for a tab left open on an
--      unattended screen.
--   3. public.audit_logs records what a person actually DID, in THIS
--      organization, and it survives sign-out. It is blind to read-only use.
--
--   Each one is a floor with a different blind spot, so the function returns
--   all three and the console shows the latest together with its source.
--
-- AUTOMATION IS NOT ACTIVITY
--   Seven cron routes (restore points, auto-reorder, recurring POs, auto-archive,
--   auto-delete, schedule reminders, daily briefing) run under a per-org system
--   context that BORROWS an owner's or admin's user id, and audit() stamps that
--   id on the row. Counted naively, the nightly restore-point cron makes that
--   person look active every day forever. audit() also records the request's
--   user agent, and every cron-written row in production carries
--   'vercel-cron/1.0' (231 rows across exactly the three cron-driven events on
--   2026-09-18; every human row carries a browser or mobile agent). The audit
--   leg therefore ignores rows whose user agent is absent or starts with
--   'vercel-cron'. Both exclusions err toward UNDER-reporting, which is the safe
--   direction for a number an operator may use to decide an account is dormant.
--
-- refreshed_at IS `timestamp WITHOUT time zone`; every other column read here
--   is timestamptz. GoTrue writes it as a UTC wall clock: in production it
--   lands within 32 seconds of updated_at on all 31 refreshed sessions when
--   read `at time zone 'utc'`, and 25,200 seconds off when misread as Pacific.
--   0213's `::timestamptz` cast is correct only while the session TimeZone
--   happens to be UTC. Do not copy it here.
--
-- WHY THE MEMBERSHIP JOIN
--   The caller already holds the ids of one page of one organization's
--   members. The join makes that the function's CONTRACT rather than the
--   caller's promise: an id that is not an accepted member of p_org_id returns
--   no row, so a future caller bug cannot turn this into a lookup for
--   arbitrary users.
--
-- WHY NO NEW INDEX
--   auth.sessions is already indexed on (user_id). The audit leg rides
--   audit_logs_org_created_idx (organization_id, created_at desc); the largest
--   tenant holds 3,242 audit rows. Revisit with
--   (organization_id, user_id, created_at desc) if a tenant passes roughly half
--   a million rows; an index on a hot insert table is not free and nothing
--   measured today asks for it.
--
-- SECURITY MODEL
--   service_role ONLY. The body carries NO auth.uid() / has_org_role gate, on
--   purpose: the caller is the admin client behind the platform-admin + AAL2
--   gate and has no auth.uid(). That makes the revoke below the ENTIRE control.
--   The `public` default ACL grants EXECUTE on every new function to anon and
--   authenticated DIRECTLY, so revoking from PUBLIC alone closes nothing (0097
--   shipped exactly that; 0318 had to close it). If the `authenticated` revoke
--   is ever lost, security_invariants INV-25 goes red: the intended tripwire.
--   NEVER answer that by adding this function to allowlist E. It returns
--   per-person ATTRIBUTES, the class 0350 removed from that list.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.platform_member_activity(p_org_id uuid, p_user_ids uuid[])
returns table (
  user_id         uuid,
  last_sign_in_at timestamptz,
  last_session_at timestamptz,
  last_action_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id,
         u.last_sign_in_at,
         s.last_session_at,
         a.last_action_at
    from auth.users u
    join public.organization_members om
      on om.user_id = u.id
     and om.organization_id = p_org_id
     and om.accepted_at is not null
    left join lateral (
      select max(greatest(se.refreshed_at at time zone 'utc', se.created_at)) as last_session_at
        from auth.sessions se
       where se.user_id = u.id
    ) s on true
    left join lateral (
      select max(al.created_at) as last_action_at
        from public.audit_logs al
       where al.organization_id = p_org_id
         and al.user_id = u.id
         and al.user_agent is not null
         and al.user_agent not ilike 'vercel-cron%'
    ) a on true
   where u.id = any(p_user_ids);
$$;

revoke execute on function public.platform_member_activity(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.platform_member_activity(uuid, uuid[]) to service_role;

comment on function public.platform_member_activity(uuid, uuid[]) is
  'Last sign-in, last session renewal and last human audit event for accepted members of one organization, for the platform super-admin console. service_role only. Read-only; every value is a floor, never a measurement.';
