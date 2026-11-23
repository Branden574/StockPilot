-- 0477_platform_security_briefing.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The reads behind the platform console's security briefing: for every
-- organization, and for one organization in detail, who has no second
-- sign-in step, which sign-ins have not been used for 30 days, what was
-- blocked or flagged this week against last week, which sign-ins a member
-- reported as not theirs, and which admin and sign-in policy changes the
-- audit log holds. Read-only: five functions and nothing else. Nothing calls
-- them until the console code that follows this migration. This file's
-- number is in its name, its test's name and labels, and the manifest entry
-- in scripts/security-test.sh.
--
-- WHAT IT ADDS (tier A: five functions and their grants. No table, no index,
-- no column, no trigger, no stored row; no existing function, policy or grant
-- changes.)
--   Words used below.
--     A member of an organization: an organization_members row that is
--       accepted and is not an act-as seat (impersonation_expires_at set,
--       live or expired), whose account is not disabled. The console's Users
--       tab counts members the same way, except that it lists a disabled
--       account too.
--     A second step: at least one verified factor of the account at Supabase
--       Auth, of any type and any name: the rule every sign-in gate reads.
--     A sign-in not used for 30 days: an Auth session that has not ended
--       whose last renewal (or its start, when it was never renewed) is more
--       than 30 days old. One row is one sign-in, not one device. Nothing
--       ends such a session today, so the number only grows: information,
--       not an alarm.
--     This week: the 7 days up to now. Last week: the 7 days before that.
--   1. public._security_briefing_members(uuid). Private. One organization's
--      members: account, role, name, email, whether the account has a second
--      step, how many sign-ins it has, how many of them have not been used
--      for 30 days and the last use of the oldest of those. One factor probe
--      and one session index scan per member.
--   2. public.platform_security_briefing_members(). Every organization (at
--      most 500, those with a count to show first), in one pass: factors,
--      sessions and reported sign-in alerts are each grouped by account
--      once and then joined to the memberships, so a person in three
--      organizations is computed once. For each organization: its name and
--      sign-in policy, members, admins (owners included), members and admins
--      without a second step, members with a sign-in not used for 30 days
--      and how many such sign-ins, admins who joined this week (from the
--      membership rows themselves) and sign-ins reported this week as "not
--      me" (from sign_in_alerts, never from security_events). The totals
--      count accounts, so a person in two organizations is one.
--   3. public.platform_security_briefing_events(). For every organization
--      with an event in the 14 days (at most 500) and for the events about
--      no organization: this week's and last week's counts by category and
--      outcome (blocked, flagged, allowed), this week's count of each of the
--      two passkey reasons the platform has to chase, and the time of the
--      oldest event on record, so a comparison with a week that was not
--      fully recorded can be told apart.
--   4. public.platform_security_briefing_changes(). For every organization
--      with one (at most 500), this week's counts from audit_logs: admins
--      promoted, admins demoted or removed, ownership moved, and the sign-in
--      policy loosened, tightened or changed in a way whose direction cannot
--      be told. A promotion or demotion that an invitation acceptance
--      explains (the same member, the same UTC day) is not counted. A change
--      with owner on either side is always an ownership move: never an admin
--      added or removed, and never set aside for an invitation; the two rows
--      of one transfer are one move.
--   5. public.platform_security_briefing_for_organization(uuid). One
--      organization: the numbers of 2 for it; the members who have no second
--      step or have a sign-in not used for 30 days (owners and admins first,
--      at most 200), with name, email and role; and the audit rows of 30
--      days for role changes, invitations accepted, members removed,
--      ownership transfers and sign-in policy changes (newest first, at most
--      200), each cut down to a fixed set of keys. No organization, or an id
--      that names none: null.
--   No function returns a session id, a network address, a user agent, a
--   device label, a factor id or a factor name.
--
-- WHO CAN READ AND WRITE
--   - Nobody writes anything through these functions: each is STABLE, which
--     Postgres holds to (a write inside one is refused).
--   - service_role only may call 2 to 5. They are SECURITY DEFINER because
--     the auth schema is not reachable through the Data API: a definer
--     function is what lets one call read auth.mfa_factors and
--     auth.sessions (0351's shape). The
--     caller is the console's admin client, behind the console's own gate
--     (a platform admin with the second step held); it has no signed-in
--     account, so the bodies make no account check. THE GRANT IS THE WHOLE
--     CONTROL (0351's note). EXECUTE is revoked from PUBLIC, anon,
--     authenticated and service_role by name and then granted to
--     service_role alone, so the result is the same with and without
--     Supabase's default grants.
--   - If EXECUTE ever reaches authenticated, security_invariants INV-25 names
--     the function: that is the intended tripwire. For that reason no body
--     here holds any of the four names INV-25 accepts as a gate, and none of
--     these functions is ever to be added to its allowlist: they return
--     facts about people.
--   - A second lock that names no gate: each of 2 to 5 first reads the role
--     setting (0413's form), which names the caller's role inside a SECURITY
--     DEFINER body too, and refuses with 42501
--     (platform_security_briefing_not_allowed) when it is authenticated or
--     anon. With the grant in place that line is never reached.
--   - 1 is SECURITY INVOKER and no role holds EXECUTE on it. It is called
--     only by 5, which runs as its owner. Were it ever granted by mistake, a
--     member's call would end at the auth tables' own privileges, not in
--     data.
--
-- ROLLBACK
--   Nothing depends on these functions but the console code that follows
--   this migration, which shows "could not check" when one is missing. To
--   remove them (no table lock; an older web build never calls them):
--     drop function if exists public.platform_security_briefing_for_organization(uuid);
--     drop function if exists public.platform_security_briefing_changes();
--     drop function if exists public.platform_security_briefing_events();
--     drop function if exists public.platform_security_briefing_members();
--     drop function if exists public._security_briefing_members(uuid);
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: none on any table outside pg_catalog. Every body is plpgsql, which
-- Postgres does not resolve when the function is created, so creating them
-- reads and locks no table the bodies name. Measured on a local stack (the
-- whole file run inside BEGIN ... ROLLBACK, then the session's locks
-- listed): the system catalogs the preflight and the statements read or
-- write, the five new functions themselves and the four roles the REVOKEs
-- and GRANTs name; nothing in public, nothing in auth. The preflight reads
-- the catalogs only. lock_timeout 900ms bounds anything unforeseen; it is
-- not reset at the end of the file, so the push's own last write, made in
-- the same transaction, has the same limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only. Refuses to run (55000, hint
-- platform_security_briefing_preflight, nothing applied) when a name this
-- file creates is taken (applied already, or half applied by hand); when
-- this role, the functions' owner, could not read auth.mfa_factors or
-- auth.sessions, or would see none of their rows through row security (the
-- functions would then answer as if nobody had a second step); when the
-- session columns do not have the types the "last use" arithmetic depends on
-- (refreshed_at is a timestamp without time zone that holds UTC, 0351's note;
-- read as anything else the 30 days would shift by the session's zone); when
-- either auth table has no valid index that starts with user_id (the
-- per-member probes would read the whole table); and when a table, column or
-- index the bodies read is missing.
do $preflight$
declare
  v_bad text := '';
begin
  if to_regclass('auth.mfa_factors') is null or to_regclass('auth.sessions') is null then
    v_bad := v_bad || ' auth.mfa_factors or auth.sessions is missing;';
  else
    if not has_table_privilege('auth.mfa_factors', 'select')
       or not has_table_privilege('auth.sessions', 'select') then
      v_bad := v_bad || ' this role may not read auth.mfa_factors or auth.sessions;';
    end if;
    if not (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user)
       and exists (select 1 from pg_catalog.pg_class c
                    where c.oid in ('auth.mfa_factors'::regclass, 'auth.sessions'::regclass)
                      and c.relrowsecurity) then
      v_bad := v_bad || ' row security would hide auth.mfa_factors or auth.sessions from this role;';
    end if;
    -- The columns the bodies read, with the types the arithmetic needs.
    if (select count(*) from pg_catalog.pg_attribute a
         where a.attnum > 0 and not a.attisdropped
           and ((a.attrelid = 'auth.sessions'::regclass
                 and (a.attname, format_type(a.atttypid, a.atttypmod)) in (
                       ('user_id', 'uuid'),
                       ('refreshed_at', 'timestamp without time zone'),
                       ('created_at', 'timestamp with time zone'),
                       ('not_after', 'timestamp with time zone')))
                or (a.attrelid = 'auth.mfa_factors'::regclass
                    and a.attname in ('user_id', 'status')))) <> 6 then
      v_bad := v_bad || ' auth.sessions (user_id uuid, refreshed_at timestamp without time zone, created_at and not_after timestamp with time zone) or auth.mfa_factors (user_id, status) is not as the functions read it;';
    end if;
    -- A valid index over every row whose first column is user_id, on each.
    if (select count(distinct i.indrelid) from pg_catalog.pg_index i
          join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
         where i.indrelid in ('auth.mfa_factors'::regclass, 'auth.sessions'::regclass)
           and i.indisvalid and i.indpred is null
           and a.attname = 'user_id') <> 2 then
      v_bad := v_bad || ' auth.mfa_factors or auth.sessions has no valid index that starts with user_id;';
    end if;
  end if;

  if to_regclass('public.sign_in_alerts') is null or to_regclass('public.security_events') is null
     or to_regclass('public.audit_logs') is null or to_regclass('public.organizations') is null
     or to_regclass('public.organization_members') is null or to_regclass('public.user_profiles') is null then
    v_bad := v_bad || ' a public table the functions read is missing;';
  elsif (select count(*) from pg_catalog.pg_attribute a
          where a.attnum > 0 and not a.attisdropped
            and ((a.attrelid = 'public.organizations'::regclass
                  and a.attname in ('id', 'name', 'mfa_policy'))
                 or (a.attrelid = 'public.organization_members'::regclass
                     and a.attname in ('id', 'organization_id', 'user_id', 'role', 'accepted_at',
                                       'impersonation_expires_at'))
                 or (a.attrelid = 'public.user_profiles'::regclass
                     and a.attname in ('id', 'full_name', 'email', 'disabled_at'))
                 or (a.attrelid = 'public.sign_in_alerts'::regclass
                     and a.attname in ('user_id', 'status', 'resolved_at'))
                 or (a.attrelid = 'public.security_events'::regclass
                     and a.attname in ('organization_id', 'minute', 'category', 'outcome', 'reason',
                                       'event_count'))
                 or (a.attrelid = 'public.audit_logs'::regclass
                     and a.attname in ('id', 'organization_id', 'user_id', 'event', 'metadata',
                                       'created_at')))) <> 28 then
    v_bad := v_bad || ' a column of a public table the functions read is missing;';
  end if;

  -- The indexes the reads are written for.
  if (select count(*) from pg_catalog.pg_index i
       where i.indisvalid
         and i.indexrelid in (to_regclass('public.security_events_organization_minute_idx'),
                              to_regclass('public.security_events_no_organization_minute_idx'),
                              to_regclass('public.audit_logs_org_created_idx'),
                              to_regclass('public.audit_logs_org_entity_created_idx'))) <> 4 then
    v_bad := v_bad || ' an index of security_events (by organization and minute; by minute where there is no organization) or of audit_logs (by organization and time; by organization, entity and time) is missing or not valid;';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('_security_briefing_members',
                                  'platform_security_briefing_members',
                                  'platform_security_briefing_events',
                                  'platform_security_briefing_changes',
                                  'platform_security_briefing_for_organization')) then
    v_bad := v_bad || ' a function name this file creates is taken (or this file already ran);';
  end if;

  if v_bad <> '' then
    raise exception 'platform_security_briefing_preflight:%', v_bad
      using errcode = '55000', hint = 'platform_security_briefing_preflight';
  end if;
end
$preflight$;

-- ── 1. One organization's members (private) ──────────────────────────────────
-- plpgsql, not sql, here and below: a sql body is resolved when it is
-- created, which would lock the auth tables while this file runs (0475).
create function public._security_briefing_members(p_organization_id uuid)
returns table (
  user_id          uuid,
  role             text,
  full_name        text,
  email            text,
  has_second_step  boolean,
  sign_ins         integer,
  idle_sign_ins    integer,
  oldest_idle_at   timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_now   timestamptz := pg_catalog.now();
  v_idle  timestamptz := v_now - interval '30 days';
begin
  -- Members: accepted, not an act-as seat, account not disabled.
  -- Last use of a sign-in: its last renewal, or its start when it was never
  -- renewed. refreshed_at is a timestamp without time zone that holds UTC
  -- (0351 measured it; the preflight pins the type). A sign-in used exactly
  -- 30 days ago is not counted: only one used before that.
  return query
    select m.user_id,
           m.role,
           p.full_name,
           p.email::text,
           exists (select 1 from auth.mfa_factors f
                    where f.user_id = m.user_id and f.status = 'verified'),
           coalesce(s.sign_ins, 0)::integer,
           coalesce(s.idle_sign_ins, 0)::integer,
           s.oldest_idle_at
      from public.organization_members m
      join public.user_profiles p on p.id = m.user_id
      left join lateral (
        select pg_catalog.count(*) as sign_ins,
               pg_catalog.count(*) filter (where u.last_used < v_idle) as idle_sign_ins,
               pg_catalog.min(u.last_used) filter (where u.last_used < v_idle) as oldest_idle_at
          from auth.sessions se
          cross join lateral (
            select greatest(se.refreshed_at at time zone 'utc', se.created_at) as last_used
          ) u
         where se.user_id = m.user_id
           and (se.not_after is null or se.not_after > v_now)
      ) s on true
     where m.organization_id = p_organization_id
       and m.accepted_at is not null
       and m.impersonation_expires_at is null
       and p.disabled_at is null;
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
-- No grant follows: only the detail read below calls it, as its owner.
revoke all on function public._security_briefing_members(uuid) from public, anon, authenticated, service_role;

comment on function public._security_briefing_members(uuid) is
  'Private. One row per member of the organization (accepted, not an act-as seat, account not disabled): account, role, name, email, whether the account has a verified factor at Supabase Auth, its sign-ins that have not ended, how many of them were last used more than 30 days ago and the last use of the oldest of those. SECURITY INVOKER; called only by platform_security_briefing_for_organization, as its owner. No API role may call it.';

-- ── 2. Every organization's member state ─────────────────────────────────────
create function public.platform_security_briefing_members()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now     timestamptz := pg_catalog.now();
  v_idle    timestamptz := v_now - interval '30 days';
  v_week    timestamptz := v_now - interval '7 days';
  v_result  jsonb;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_briefing_not_allowed' using errcode = '42501';
  end if;

  -- One pass over each table: factors, idle sign-ins and reported alerts are
  -- grouped by account once, then joined to the memberships, so an account
  -- in several organizations is computed once.
  with fac as (
    select f.user_id
      from auth.mfa_factors f
     where f.status = 'verified'
     group by f.user_id
  ),
  ses as (
    select se.user_id, pg_catalog.count(*) as idle_sign_ins
      from auth.sessions se
     where (se.not_after is null or se.not_after > v_now)
       and greatest(se.refreshed_at at time zone 'utc', se.created_at) < v_idle
     group by se.user_id
  ),
  rep as (
    -- Reported as "not me" this week: the alert row is the record (0474).
    select a.user_id, pg_catalog.count(*) as reported
      from public.sign_in_alerts a
     where a.status = 'not_me'
       and a.resolved_at >= v_week
     group by a.user_id
  ),
  mem as (
    select m.organization_id,
           m.user_id,
           (m.role in ('owner', 'admin')) as is_admin,
           (m.role in ('owner', 'admin') and m.accepted_at >= v_week) as joined_as_admin,
           (fac.user_id is not null) as has_second_step,
           coalesce(ses.idle_sign_ins, 0) as idle_sign_ins,
           coalesce(rep.reported, 0) as reported
      from public.organization_members m
      join public.user_profiles p on p.id = m.user_id
      left join fac on fac.user_id = m.user_id
      left join ses on ses.user_id = m.user_id
      left join rep on rep.user_id = m.user_id
     where m.accepted_at is not null
       and m.impersonation_expires_at is null
       and p.disabled_at is null
  ),
  org as (
    select o.id,
           o.name,
           o.mfa_policy::text as mfa_policy,
           pg_catalog.count(mem.user_id) as members,
           pg_catalog.count(mem.user_id) filter (where mem.is_admin) as admins,
           pg_catalog.count(mem.user_id) filter (where not mem.has_second_step) as without_second_step,
           pg_catalog.count(mem.user_id) filter (where mem.is_admin and not mem.has_second_step) as admins_without_second_step,
           pg_catalog.count(mem.user_id) filter (where mem.idle_sign_ins > 0) as members_with_idle_sign_ins,
           coalesce(pg_catalog.sum(mem.idle_sign_ins), 0)::bigint as idle_sign_ins,
           pg_catalog.count(mem.user_id) filter (where mem.joined_as_admin) as admins_joined_this_week,
           coalesce(pg_catalog.sum(mem.reported), 0)::bigint as sign_ins_reported_this_week
      from public.organizations o
      left join mem on mem.organization_id = o.id
     group by o.id
  ),
  ranked as (
    -- Those with a count to show first. Idle sign-ins are information only
    -- and move no organization up.
    select org.*,
           pg_catalog.row_number() over (
             order by (org.admins_without_second_step > 0 or org.without_second_step > 0
                       or org.sign_ins_reported_this_week > 0 or org.admins_joined_this_week > 0) desc,
                      org.admins_without_second_step desc,
                      org.sign_ins_reported_this_week desc,
                      org.without_second_step desc,
                      org.admins_joined_this_week desc,
                      pg_catalog.lower(org.name),
                      org.id) as rn
      from org
  )
  select pg_catalog.jsonb_build_object(
           'organizations',
             coalesce((select pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'organization_id', r.id,
                                  'name', r.name,
                                  'mfa_policy', r.mfa_policy,
                                  'members', r.members,
                                  'admins', r.admins,
                                  'without_second_step', r.without_second_step,
                                  'admins_without_second_step', r.admins_without_second_step,
                                  'members_with_idle_sign_ins', r.members_with_idle_sign_ins,
                                  'idle_sign_ins', r.idle_sign_ins,
                                  'admins_joined_this_week', r.admins_joined_this_week,
                                  'sign_ins_reported_this_week', r.sign_ins_reported_this_week)
                                order by r.rn)
                         from ranked r
                        where r.rn <= 500), pg_catalog.jsonb_build_array()),
           'organizations_truncated', (select pg_catalog.count(*) from org) > 500,
           'totals', pg_catalog.jsonb_build_object(
             'organizations', (select pg_catalog.count(*) from org),
             -- Accounts, not memberships: a person in two organizations is one.
             'accounts', (select pg_catalog.count(distinct mem.user_id) from mem),
             'accounts_without_second_step',
               (select pg_catalog.count(distinct mem.user_id) from mem where not mem.has_second_step),
             'admin_accounts_without_second_step',
               (select pg_catalog.count(distinct mem.user_id) from mem
                 where mem.is_admin and not mem.has_second_step)),
           'idle_after_days', 30)
    into v_result;

  return v_result;
end;
$$;

revoke all on function public.platform_security_briefing_members() from public, anon, authenticated, service_role;
grant execute on function public.platform_security_briefing_members() to service_role;

comment on function public.platform_security_briefing_members() is
  'For the platform console. Every organization (at most 500, those with a count to show first; organizations_truncated says when more exist): name, sign-in policy, members (accepted, not act-as seats, not disabled), admins, members and admins with no verified factor, members with a sign-in not used for 30 days and how many such sign-ins, admins who joined in the last 7 days, and sign-in alerts answered "not me" in the last 7 days (from sign_in_alerts). Totals count distinct accounts. One pass: factors, sessions and alerts are grouped by account once. Returns no session id, address, device or factor detail. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 3. Every organization's events, this week and last ───────────────────────
create function public.platform_security_briefing_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now         timestamptz := pg_catalog.now();
  v_week        timestamptz := v_now - interval '7 days';
  v_fortnight   timestamptz := v_now - interval '14 days';
  -- Every outcome and every category is always present, zeros included.
  v_no_outcome  jsonb := pg_catalog.jsonb_build_object('blocked', 0, 'flagged', 0, 'allowed', 0);
  v_no_category jsonb := pg_catalog.jsonb_build_object(
                           'password_guessing', v_no_outcome, 'exploit', v_no_outcome,
                           'bots', v_no_outcome, 'phishing', v_no_outcome, 'malware', v_no_outcome);
  v_orgs        jsonb;
  v_truncated   boolean;
  v_none        jsonb;
  v_oldest      timestamptz;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_briefing_not_allowed' using errcode = '42501';
  end if;

  -- This week: from 7 days ago up to now. Last week: the 7 days before.
  -- Each organization's rows are read through its own index range (by
  -- organization and minute), so one organization's volume is its own cost.
  with cell as (
    select o.id as organization_id, e.category, e.outcome,
           e.this_week, e.last_week, e.unexplained, e.went_back
      from public.organizations o
      cross join lateral (
        select s.category, s.outcome,
               coalesce(pg_catalog.sum(s.event_count) filter (where s.minute >= v_week), 0)::bigint as this_week,
               coalesce(pg_catalog.sum(s.event_count) filter (where s.minute < v_week), 0)::bigint as last_week,
               coalesce(pg_catalog.sum(s.event_count) filter (
                 where s.minute >= v_week and s.reason = 'passkey_unexplained_sign_in'), 0)::bigint as unexplained,
               coalesce(pg_catalog.sum(s.event_count) filter (
                 where s.minute >= v_week and s.reason = 'passkey_counter_went_back'), 0)::bigint as went_back
          from public.security_events s
         where s.organization_id = o.id
           and s.organization_id is not null
           and s.minute >= v_fortnight
           and s.minute < v_now
         group by s.category, s.outcome
      ) e
  ),
  cat as (
    select c.organization_id, c.category,
           v_no_outcome || pg_catalog.jsonb_object_agg(c.outcome, c.this_week) as this_week,
           v_no_outcome || pg_catalog.jsonb_object_agg(c.outcome, c.last_week) as last_week,
           pg_catalog.sum(c.this_week)::bigint as this_total,
           pg_catalog.sum(c.last_week)::bigint as last_total,
           pg_catalog.sum(c.unexplained)::bigint as unexplained,
           pg_catalog.sum(c.went_back)::bigint as went_back
      from cell c
     group by c.organization_id, c.category
  ),
  org as (
    select t.organization_id,
           v_no_category || pg_catalog.jsonb_object_agg(t.category, t.this_week) as this_week,
           v_no_category || pg_catalog.jsonb_object_agg(t.category, t.last_week) as last_week,
           pg_catalog.sum(t.this_total)::bigint as this_total,
           pg_catalog.sum(t.last_total)::bigint as last_total,
           pg_catalog.sum(t.unexplained)::bigint as unexplained,
           pg_catalog.sum(t.went_back)::bigint as went_back
      from cat t
     group by t.organization_id
  ),
  ranked as (
    select org.*,
           pg_catalog.row_number() over (
             order by org.this_total desc, org.last_total desc, org.organization_id) as rn
      from org
  )
  select coalesce(pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'organization_id', r.organization_id,
                      'this_week', r.this_week,
                      'last_week', r.last_week,
                      'passkey_unexplained_sign_in_this_week', r.unexplained,
                      'passkey_counter_went_back_this_week', r.went_back)
                    order by r.rn) filter (where r.rn <= 500), pg_catalog.jsonb_build_array()),
         pg_catalog.count(*) > 500
    into v_orgs, v_truncated
    from ranked r;

  -- The events about no organization, through their own partial index.
  with cell as (
    select s.category, s.outcome,
           coalesce(pg_catalog.sum(s.event_count) filter (where s.minute >= v_week), 0)::bigint as this_week,
           coalesce(pg_catalog.sum(s.event_count) filter (where s.minute < v_week), 0)::bigint as last_week,
           coalesce(pg_catalog.sum(s.event_count) filter (
             where s.minute >= v_week and s.reason = 'passkey_unexplained_sign_in'), 0)::bigint as unexplained,
           coalesce(pg_catalog.sum(s.event_count) filter (
             where s.minute >= v_week and s.reason = 'passkey_counter_went_back'), 0)::bigint as went_back
      from public.security_events s
     where s.organization_id is null
       and s.minute >= v_fortnight
       and s.minute < v_now
     group by s.category, s.outcome
  ),
  cat as (
    select c.category,
           v_no_outcome || pg_catalog.jsonb_object_agg(c.outcome, c.this_week) as this_week,
           v_no_outcome || pg_catalog.jsonb_object_agg(c.outcome, c.last_week) as last_week,
           pg_catalog.sum(c.unexplained)::bigint as unexplained,
           pg_catalog.sum(c.went_back)::bigint as went_back
      from cell c
     group by c.category
  )
  select pg_catalog.jsonb_build_object(
           'this_week', v_no_category || coalesce(pg_catalog.jsonb_object_agg(t.category, t.this_week), pg_catalog.jsonb_build_object()),
           'last_week', v_no_category || coalesce(pg_catalog.jsonb_object_agg(t.category, t.last_week), pg_catalog.jsonb_build_object()),
           'passkey_unexplained_sign_in_this_week', coalesce(pg_catalog.sum(t.unexplained), 0)::bigint,
           'passkey_counter_went_back_this_week', coalesce(pg_catalog.sum(t.went_back), 0)::bigint)
    into v_none
    from cat t;

  -- The oldest event on record, with or without an organization (the first
  -- entry of the index on minute): a week that began before it was not fully
  -- recorded.
  select pg_catalog.min(s.minute) into v_oldest from public.security_events s;

  return pg_catalog.jsonb_build_object(
    'organizations', v_orgs,
    'organizations_truncated', v_truncated,
    'no_organization', v_none,
    'oldest_event_at', v_oldest);
end;
$$;

revoke all on function public.platform_security_briefing_events() from public, anon, authenticated, service_role;
grant execute on function public.platform_security_briefing_events() to service_role;

comment on function public.platform_security_briefing_events() is
  'For the platform console. For each organization with a security_events row in the last 14 days (at most 500, the most events this week first; organizations_truncated says when more exist) and for the rows about no organization: event counts of this week (the 7 days up to now) and last week (the 7 days before) by category and outcome (blocked, flagged, allowed; every category and outcome always present), and this week''s counts of the reasons passkey_unexplained_sign_in and passkey_counter_went_back; plus oldest_event_at, the earliest minute on record. Returns no source hash, place or row key. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501. Its work grows with the rows of 14 days.';

-- ── 4. Every organization's admin and sign-in policy changes, this week ──────
create function public.platform_security_briefing_changes()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now        timestamptz := pg_catalog.now();
  v_week       timestamptz := v_now - interval '7 days';
  v_orgs       jsonb;
  v_truncated  boolean;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_briefing_not_allowed' using errcode = '42501';
  end if;

  -- Each organization's audit rows of the week, through the index by
  -- organization and time. No index holds the event, so every row of the
  -- week is read to test it.
  with ev as (
    select o.id as organization_id, a.event, a.created_at,
           a.metadata ->> 'entity_type' as entity_type,
           a.metadata -> 'before' ->> 'role' as before_role,
           a.metadata -> 'after' ->> 'role' as after_role,
           a.metadata -> 'before' ->> 'mfa_policy' as before_policy,
           a.metadata -> 'after' ->> 'mfa_policy' as after_policy,
           -- The member a role change is about: target_user_id on the rows
           -- the database writes (0467); on the older rows the app wrote,
           -- the account of the membership named by entity_id, while that
           -- membership exists.
           case when a.event = 'user.role.changed' then
             coalesce(
               case when (a.metadata ->> 'target_user_id')
                           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    then (a.metadata ->> 'target_user_id')::uuid end,
               (select om.user_id
                  from public.organization_members om
                 where om.organization_id = o.id
                   and om.id = case when (a.metadata ->> 'entity_id')
                                           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                    then (a.metadata ->> 'entity_id')::uuid end))
           end as member_id
      from public.organizations o
      cross join lateral (
        select al.event, al.created_at, al.metadata
          from public.audit_logs al
         where al.organization_id = o.id
           and al.created_at >= v_week
           and al.event in ('user.role.changed', 'user.deactivated', 'organization.mfa_policy.changed')
      ) a
  ),
  judged as materialized (
    -- Materialized so the invitation lookup runs once for each row, not
    -- once for each count below that reads it.
    select ev.organization_id, ev.event, ev.created_at, ev.entity_type,
           ev.before_role, ev.after_role,
           case ev.before_policy when 'optional' then 0 when 'admins_required' then 1 when 'all_required' then 2 end as before_rank,
           case ev.after_policy when 'optional' then 0 when 'admins_required' then 1 when 'all_required' then 2 end as after_rank,
           (coalesce(ev.before_role, '') = 'owner' or coalesce(ev.after_role, '') = 'owner') as owner_side,
           -- The invitation wins over a promotion or a demotion: a role
           -- change of a member who accepted an invitation to this
           -- organization on the same UTC day is that acceptance seen twice
           -- (0467), and is not counted. An "already a member" press changed
           -- nothing and folds nothing. A change with owner on either side
           -- is never folded: it is always an ownership move.
           (ev.event = 'user.role.changed'
            and coalesce(ev.before_role, '') <> 'owner'
            and coalesce(ev.after_role, '') <> 'owner'
            and exists (
              select 1
                from public.audit_logs i
               where i.organization_id = ev.organization_id
                 and i.event = 'user.invite.accepted'
                 and i.user_id = ev.member_id
                 and (i.metadata -> 'already_member') is distinct from pg_catalog.to_jsonb(true)
                 and i.created_at >= pg_catalog.date_trunc('day', ev.created_at, 'UTC')
                 and i.created_at < pg_catalog.date_trunc('day', ev.created_at, 'UTC') + interval '1 day')) as folded
      from ev
  ),
  org as (
    select j.organization_id,
           pg_catalog.count(*) filter (
             where j.event = 'user.role.changed' and not j.folded and not j.owner_side
               and j.after_role = 'admin' and coalesce(j.before_role, '') <> 'admin') as admins_promoted,
           pg_catalog.count(*) filter (
             where (j.event = 'user.role.changed' and not j.folded and not j.owner_side
                    and j.before_role = 'admin' and coalesce(j.after_role, '') <> 'admin')
                or (j.event = 'user.deactivated' and j.entity_type = 'organization_member'
                    and j.before_role in ('admin', 'owner'))) as admins_demoted_or_removed,
           -- Every change with owner on either side, whatever invitation the
           -- member accepted that day. The two rows of one transfer are
           -- written in one transaction and carry its time: one move.
           pg_catalog.count(distinct j.created_at) filter (
             where j.event = 'user.role.changed' and j.owner_side) as ownership_moved,
           pg_catalog.count(*) filter (
             where j.event = 'organization.mfa_policy.changed' and j.after_rank < j.before_rank) as sign_in_policy_loosened,
           pg_catalog.count(*) filter (
             where j.event = 'organization.mfa_policy.changed' and j.after_rank > j.before_rank) as sign_in_policy_tightened,
           -- A value outside the three, a missing one, or the same twice:
           -- the direction cannot be told.
           pg_catalog.count(*) filter (
             where j.event = 'organization.mfa_policy.changed'
               and (j.before_rank is null or j.after_rank is null or j.after_rank = j.before_rank)) as sign_in_policy_changed_other
      from judged j
     group by j.organization_id
  ),
  ranked as (
    select org.*,
           pg_catalog.row_number() over (
             order by (org.admins_promoted + org.admins_demoted_or_removed + org.ownership_moved
                       + org.sign_in_policy_loosened + org.sign_in_policy_tightened
                       + org.sign_in_policy_changed_other) desc,
                      org.organization_id) as rn
      from org
     where org.admins_promoted + org.admins_demoted_or_removed + org.ownership_moved
           + org.sign_in_policy_loosened + org.sign_in_policy_tightened
           + org.sign_in_policy_changed_other > 0
  )
  select coalesce(pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'organization_id', r.organization_id,
                      'admins_promoted', r.admins_promoted,
                      'admins_demoted_or_removed', r.admins_demoted_or_removed,
                      'ownership_moved', r.ownership_moved,
                      'sign_in_policy_loosened', r.sign_in_policy_loosened,
                      'sign_in_policy_tightened', r.sign_in_policy_tightened,
                      'sign_in_policy_changed_other', r.sign_in_policy_changed_other)
                    order by r.rn) filter (where r.rn <= 500), pg_catalog.jsonb_build_array()),
         pg_catalog.count(*) > 500
    into v_orgs, v_truncated
    from ranked r;

  return pg_catalog.jsonb_build_object(
    'organizations', v_orgs,
    'organizations_truncated', v_truncated);
end;
$$;

revoke all on function public.platform_security_briefing_changes() from public, anon, authenticated, service_role;
grant execute on function public.platform_security_briefing_changes() to service_role;

comment on function public.platform_security_briefing_changes() is
  'For the platform console. For each organization with one (at most 500; organizations_truncated says when more exist), counts from audit_logs of the last 7 days: admins promoted, admins demoted or removed (a removed member who was admin or owner included), ownership moved (every change with owner on either side; the rows of one transfer are one move; never an admin added or removed), and the sign-in policy loosened, tightened, or changed with a direction that cannot be told. A promotion or demotion of a member who accepted an invitation to the organization on the same UTC day is not counted; an ownership move always is. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501. It reads every audit row of the week: no index holds the event.';

-- ── 5. One organization in detail ────────────────────────────────────────────
create function public.platform_security_briefing_for_organization(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now       timestamptz := pg_catalog.now();
  v_week      timestamptz := v_now - interval '7 days';
  v_month     timestamptz := v_now - interval '30 days';
  v_name      text;
  v_policy    text;
  v_counts    jsonb;
  v_people    jsonb;
  v_more      boolean;
  v_joined    bigint;
  v_reported  bigint;
  v_changes   jsonb;
  v_cut       boolean;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_briefing_not_allowed' using errcode = '42501';
  end if;

  if p_organization_id is null then
    return null;
  end if;
  select o.name, o.mfa_policy::text into v_name, v_policy
    from public.organizations o
   where o.id = p_organization_id;
  if not found then
    return null;
  end if;

  -- The members, read once. People: those with no second step or with a
  -- sign-in not used for 30 days; owners and admins first, then by name.
  with mb as materialized (
    select b.user_id, b.role, b.full_name, b.email, b.has_second_step,
           b.idle_sign_ins, b.oldest_idle_at
      from public._security_briefing_members(p_organization_id) b
  ),
  listed as (
    select mb.*,
           pg_catalog.row_number() over (
             order by (mb.role in ('owner', 'admin')) desc,
                      pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(mb.full_name), ''), mb.email)),
                      mb.user_id) as rn
      from mb
     where not mb.has_second_step or mb.idle_sign_ins > 0
  )
  select (select pg_catalog.jsonb_build_object(
                   'members', pg_catalog.count(*),
                   'admins', pg_catalog.count(*) filter (where mb.role in ('owner', 'admin')),
                   'without_second_step', pg_catalog.count(*) filter (where not mb.has_second_step),
                   'admins_without_second_step',
                     pg_catalog.count(*) filter (where mb.role in ('owner', 'admin') and not mb.has_second_step),
                   'members_with_idle_sign_ins', pg_catalog.count(*) filter (where mb.idle_sign_ins > 0),
                   'idle_sign_ins', coalesce(pg_catalog.sum(mb.idle_sign_ins), 0)::bigint)
            from mb),
         coalesce((select pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'user_id', l.user_id,
                              'full_name', l.full_name,
                              'email', l.email,
                              'role', l.role,
                              'has_second_step', l.has_second_step,
                              'idle_sign_ins', l.idle_sign_ins,
                              'oldest_idle_at', l.oldest_idle_at)
                            order by l.rn)
                     from listed l
                    where l.rn <= 200), pg_catalog.jsonb_build_array()),
         (select pg_catalog.count(*) from listed) > 200
    into v_counts, v_people, v_more;

  -- Admins who joined this week, from the membership rows themselves: a
  -- member inserted as admin or owner leaves no role-change row (0467).
  select pg_catalog.count(*) into v_joined
    from public.organization_members m
    join public.user_profiles p on p.id = m.user_id
   where m.organization_id = p_organization_id
     and m.accepted_at is not null
     and m.impersonation_expires_at is null
     and p.disabled_at is null
     and m.role in ('owner', 'admin')
     and m.accepted_at >= v_week;

  -- Sign-ins its members reported as "not me" this week: the alert rows
  -- (0474), never security_events.
  select pg_catalog.count(*) into v_reported
    from public.organization_members m
    join public.user_profiles p on p.id = m.user_id
    join public.sign_in_alerts a on a.user_id = m.user_id
   where m.organization_id = p_organization_id
     and m.accepted_at is not null
     and m.impersonation_expires_at is null
     and p.disabled_at is null
     and a.status = 'not_me'
     and a.resolved_at >= v_week;

  -- The audit rows of 30 days for the five events, newest first, each cut
  -- down to fixed keys. before and after keep only role, mfa_policy,
  -- user_id and owner_user_id, as text of at most 64 characters. Never the
  -- row's address or user agent.
  with picked as (
    select a.id, a.created_at, a.event, a.user_id, a.metadata,
           pg_catalog.row_number() over (order by a.created_at desc, a.id desc) as rn
      from public.audit_logs a
     where a.organization_id = p_organization_id
       and a.created_at >= v_month
       and a.event in ('user.role.changed', 'user.invite.accepted', 'user.deactivated',
                       'organization.ownership.transferred', 'organization.mfa_policy.changed')
     order by a.created_at desc, a.id desc
     limit 201
  )
  select coalesce(pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'created_at', k.created_at,
                      'event', k.event,
                      'actor_user_id', k.user_id,
                      -- As in the counts: the database's target_user_id, or
                      -- for the app's older rows the account of the
                      -- membership named by entity_id while it exists.
                      'target_user_id',
                        case when k.event = 'user.role.changed' then
                          coalesce(
                            case when (k.metadata ->> 'target_user_id')
                                        ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                 then (k.metadata ->> 'target_user_id')::uuid end,
                            (select om.user_id
                               from public.organization_members om
                              where om.organization_id = p_organization_id
                                and om.id = case when (k.metadata ->> 'entity_id')
                                                        ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                                 then (k.metadata ->> 'entity_id')::uuid end))
                        end,
                      'entity_id', pg_catalog.left(k.metadata ->> 'entity_id', 64),
                      'entity_type', pg_catalog.left(k.metadata ->> 'entity_type', 64),
                      'before',
                        case when pg_catalog.jsonb_typeof(k.metadata -> 'before') = 'object' then
                          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                            'role', case when pg_catalog.jsonb_typeof(k.metadata -> 'before' -> 'role') = 'string'
                                         then pg_catalog.left(k.metadata -> 'before' ->> 'role', 64) end,
                            'mfa_policy', case when pg_catalog.jsonb_typeof(k.metadata -> 'before' -> 'mfa_policy') = 'string'
                                               then pg_catalog.left(k.metadata -> 'before' ->> 'mfa_policy', 64) end,
                            'user_id', case when pg_catalog.jsonb_typeof(k.metadata -> 'before' -> 'user_id') = 'string'
                                            then pg_catalog.left(k.metadata -> 'before' ->> 'user_id', 64) end,
                            'owner_user_id', case when pg_catalog.jsonb_typeof(k.metadata -> 'before' -> 'owner_user_id') = 'string'
                                                  then pg_catalog.left(k.metadata -> 'before' ->> 'owner_user_id', 64) end))
                        end,
                      'after',
                        case when pg_catalog.jsonb_typeof(k.metadata -> 'after') = 'object' then
                          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                            'role', case when pg_catalog.jsonb_typeof(k.metadata -> 'after' -> 'role') = 'string'
                                         then pg_catalog.left(k.metadata -> 'after' ->> 'role', 64) end,
                            'mfa_policy', case when pg_catalog.jsonb_typeof(k.metadata -> 'after' -> 'mfa_policy') = 'string'
                                               then pg_catalog.left(k.metadata -> 'after' ->> 'mfa_policy', 64) end,
                            'user_id', case when pg_catalog.jsonb_typeof(k.metadata -> 'after' -> 'user_id') = 'string'
                                            then pg_catalog.left(k.metadata -> 'after' ->> 'user_id', 64) end,
                            'owner_user_id', case when pg_catalog.jsonb_typeof(k.metadata -> 'after' -> 'owner_user_id') = 'string'
                                                  then pg_catalog.left(k.metadata -> 'after' ->> 'owner_user_id', 64) end))
                        end,
                      'role', case when pg_catalog.jsonb_typeof(k.metadata -> 'role') = 'string'
                                   then pg_catalog.left(k.metadata ->> 'role', 64) end,
                      'already_member', coalesce((k.metadata -> 'already_member') = pg_catalog.to_jsonb(true), false),
                      'made_as', case when pg_catalog.jsonb_typeof(k.metadata -> 'made_as') = 'string'
                                      then pg_catalog.left(k.metadata ->> 'made_as', 64) end)
                    order by k.rn) filter (where k.rn <= 200), pg_catalog.jsonb_build_array()),
         pg_catalog.count(*) > 200
    into v_changes, v_cut
    from picked k;

  return pg_catalog.jsonb_build_object(
           'organization_id', p_organization_id,
           'name', v_name,
           'mfa_policy', v_policy)
         || v_counts
         || pg_catalog.jsonb_build_object(
           'admins_joined_this_week', v_joined,
           'sign_ins_reported_this_week', v_reported,
           'idle_after_days', 30,
           'people', v_people,
           'people_truncated', v_more,
           'changes', v_changes,
           'changes_truncated', v_cut);
end;
$$;

revoke all on function public.platform_security_briefing_for_organization(uuid) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_briefing_for_organization(uuid) to service_role;

comment on function public.platform_security_briefing_for_organization(uuid) is
  'For the platform console: one organization in detail, or null when the id is null or names no organization. Its numbers as platform_security_briefing_members() gives them; people: the members (accepted, not act-as seats, not disabled) with no verified factor or with a sign-in not used for 30 days, owners and admins first, at most 200 (people_truncated), with name, email, role and the last use of the oldest such sign-in; changes: its audit_logs rows of the last 30 days for role changes, invitations accepted, members removed, ownership transfers and sign-in policy changes, newest first, at most 200 (changes_truncated), each cut down to created_at, event, actor_user_id, target_user_id, entity_id, entity_type, before, after, role, already_member and made_as. Returns no session id, address, user agent, device or factor detail. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501. The caller records the view in the platform audit before it calls.';
