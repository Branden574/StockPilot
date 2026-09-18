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
-- AUTOMATION IS NOT ACTIVITY, AND NEITHER IS A SIGN-IN
--   Six cron routes (restore points, auto-reorder, recurring POs, auto-archive,
--   auto-delete, daily briefing) run under a per-org system context that
--   BORROWS an owner's or admin's user id, and audit() stamps that id on the
--   row together with the request's user agent. Counted naively, the nightly
--   restore-point cron makes that person look active every day forever.
--
--   The audit leg therefore counts a row only when its user agent is one a
--   PERSON's client sends. Production on 2026-09-18 holds exactly two such
--   shapes: browsers ('Mozilla/...', 3,245 rows) and the iOS app
--   ('StockPilot/<build> CFNetwork/...', 63 rows). 'okhttp/' is what React
--   Native sends on Android, which has not shipped yet; it is listed so that
--   launch does not silently blank the column for Android-only users.
--   Everything else is ignored: 'vercel-cron/1.0' (231 rows, exactly the three
--   cron-driven events), no agent at all (13 rows, header-less background
--   writes), and 'curl/...' or 'node' (8 rows: a cron route invoked by hand
--   with the secret, or a script). An ALLOWLIST rather than a list of known
--   automation, because the two fail in opposite directions: an unrecognised
--   human client under-reports one person until it is added here, while an
--   unrecognised automation would make a dormant owner look active, which is
--   the mistake this number exists to prevent.
--
--   'user.signed_in' is excluded by name. The web sign-in action writes that
--   row a few hundred milliseconds after GoTrue stamps last_sign_in_at, so it
--   would always outrank the sign-in leg and relabel a bare sign-in as an
--   "action", hiding the one case the console has to hedge. It carries no
--   information last_sign_in_at does not. 'user.signed_out' IS counted: it
--   marks the end of a working session and survives the sign-out that deletes
--   the session rows.
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
--   caller's promise: an id that is not a real, accepted member of p_org_id
--   returns no row, so a future caller bug cannot turn this into a lookup for
--   arbitrary users. "Real" uses the same definition as every other member
--   reader in the platform service: accepted, and NOT an impersonation grant.
--   A platform admin acting as a tenant holds an accepted owner row with
--   impersonation_expires_at set; without that clause their activity would be
--   returned as if they worked there.
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
     and om.impersonation_expires_at is null
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
         and al.event <> 'user.signed_in'
         and (al.user_agent ilike 'Mozilla/%'
              or al.user_agent ilike 'StockPilot/%'
              or al.user_agent ilike 'okhttp/%')
    ) a on true
   where u.id = any(p_user_ids);
$$;

revoke execute on function public.platform_member_activity(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.platform_member_activity(uuid, uuid[]) to service_role;

comment on function public.platform_member_activity(uuid, uuid[]) is
  'Last sign-in, last session renewal and last audit event written from a person''s own client, for the real accepted members of one organization. For the platform super-admin console. service_role only. Read-only; every value is a floor, never a measurement.';
