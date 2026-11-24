-- 0478_platform_security_map.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The read behind the platform console's attack map: what the security
-- events record holds for a window of at most 26 hours, counted by time,
-- country, category and outcome, with the newest entries. Read-only: three
-- functions and nothing else. Nothing calls them until the console code
-- that follows this migration. This file's number is in its name, its
-- test's name and labels, and the manifest entry in scripts/security-test.sh.
--
-- WHAT IT ADDS (tier A: three functions and their grants. No table, no index,
-- no column, no trigger, no stored row; no existing function, policy or grant
-- changes.)
--   Words used below.
--     A row: one row of public.security_events (0472): one kind of event
--       from one source in one UTC minute, with a count.
--     The window: the rows whose minute starts at or after its start and
--       before its end. At most 26 hours, and at most 400,000 rows (below).
--     A unit: what is counted. A row as it is; or, for a sign-in event
--       that is recorded once in each organization of one account, its rows
--       taken together.
--   1. public._security_map_units(timestamptz, timestamptz, boolean).
--      Private. The units of a window (the flagged ones only when the third
--      argument is true). THE ONE PLACE THE COUNTING RULES ARE WRITTEN, with
--      the four lists they need:
--        - a sign-in event that is recorded once in each organization of
--          one account (sign_in_new_country, sign_in_not_me,
--          sign_in_alerts_held) is one unit whatever the organizations: the
--          rows of one minute with the same category, outcome, reason,
--          source, country and city count once. Its count is a floor: the
--          largest count among those rows, or a fifth of their sum rounded
--          up when that is more (one sign-in writes at most five such rows,
--          each of 1); a unit made of two rows or more is marked at_least;
--        - a reason whose number can be a count of other rows
--          (too_many_forms_to_count, unrecorded_server_form_password,
--          unrecorded_server_form_code) is marked a tally, so the caller
--          keeps it out of every total and lists it apart;
--        - a row that stands for events past a cap (over_minute_cap,
--          over_buffer_cap, auth_log_over_cap) is marked a flood and has no
--          place, whatever the row holds;
--        - a unit whose source is phone or api is marked late: those rows
--          can be added up to hours after their minute.
--      Every other row is a unit of its own, with its own count.
--   2. public._security_map_read_from(timestamptz, timestamptz, integer).
--      Private. The row ceiling: the start to read a window from. The start
--      asked for when the window holds at most the given number of rows;
--      else the minute after the one its newest rows reach at that number
--      and one more, which is the earliest start on a whole minute that keeps
--      the rows read to that number (the start moved on no more than it
--      must). It walks the index on minute from the
--      window's end and stops there, so its cost is bounded by that number
--      whatever the window holds; a setting of its own keeps the planner
--      from sorting the window instead (it changes the plan, never the
--      answer).
--   3. public.platform_security_map(timestamptz, timestamptz, timestamptz).
--      One jsonb document for a window (p_from to p_to; with neither, the
--      24 hours up to now) and an optional day start. Its parts are all
--      made from the units of 1, read from the start 2 gives, so no two of
--      them can count differently:
--      the window read and the window asked for (a window that holds more
--      than 400,000 rows is read from the earliest start on a whole minute
--      that keeps it to 400,000, and says so); when the answer was made;
--      the oldest minute on record; a timeline of cells (10-minute buckets
--      on the UTC clock for the window, and 1-minute buckets for the
--      window's last 10 minutes without the late units; country, category,
--      outcome and a count; at most 4,000 cells: the 1-minute cells first,
--      at most 1,000, then the 10-minute cells, each listed largest first;
--      when a cap cuts, the flagged cells are kept first and then the
--      largest; and a flag when cut); the same by country for the whole
--      window (at most 2,000, kept as the cells are, and a flag); totals by
--      category and outcome, with blocked, flagged and allowed apart;
--      blocked since the day start, when the day start is
--      inside the window asked for (and marked partial when it is before the
--      start read); the events with no country; the newest 60 entries (the
--      units of one minute with the same category, outcome, reason, source,
--      country, city and organization, taken together) and the newest 20
--      flagged entries, with the organization's id and name (its first 200
--      characters); the late units by source; the tallies; the flood units;
--      and the list of the numbers that are floors. A window asked for that
--      is shorter than 30 minutes (the console's 30-second poll) leaves out
--      the 10-minute cells and the groups by country.
--      A window that is out of order, longer than 26 hours, ends more than
--      a minute after now, or is not a time, and one whose newest minute
--      alone holds more than 400,000 rows, is answered with a document that
--      says so by a fixed word. No argument makes it raise, and no answer
--      repeats an argument that was refused.
--   No function here returns source_hash, a row key or a row id, and the
--   record has no column for an address, an email or an account.
--
-- WHO CAN READ AND WRITE
--   - Nobody writes anything through these functions: each is STABLE, which
--     Postgres holds to (a write inside one is refused).
--   - service_role only may call 3. It is SECURITY DEFINER, as 0477's reads
--     are: the caller is the console's admin client, behind the console's
--     own gate (a platform admin with the second step held); it has no
--     signed-in account, so the body makes no account check. THE GRANT IS
--     THE WHOLE CONTROL (0351's note). EXECUTE is revoked from PUBLIC, anon,
--     authenticated and service_role by name and then granted to
--     service_role alone, so the result is the same with and without
--     Supabase's default grants.
--   - If EXECUTE ever reaches authenticated, security_invariants INV-25 names
--     the function: that is the intended tripwire. For that reason no body
--     here holds any of the four names INV-25 accepts as a gate, and no
--     function here is ever to be added to its allowlist.
--   - A second lock that names no gate: each body first reads the role
--     setting (0413's form), which names the caller's role inside a SECURITY
--     DEFINER body too, and refuses with 42501
--     (platform_security_map_not_allowed) when it is authenticated or anon.
--     With the grant in place that line is never reached.
--   - 1 and 2 are SECURITY INVOKER and no role holds EXECUTE on them. They
--     are called only by 3, which runs as its owner.
--   - 3 carries a statement_timeout of 5 seconds as a function setting: the
--     Data API, which is how the console calls it, applies a function's own
--     statement_timeout to the request that calls it. The row ceiling keeps
--     the read well inside it. It also carries TimeZone = UTC, so every time
--     in the answer is written with +00:00 whatever the caller's session
--     says.
--
-- ROLLBACK
--   Nothing depends on these functions but the console code that follows
--   this migration, which shows "could not check" when one is missing. To
--   remove them (no table lock; an older web build never calls them):
--     drop function if exists public.platform_security_map(timestamptz, timestamptz, timestamptz);
--     drop function if exists public._security_map_read_from(timestamptz, timestamptz, integer);
--     drop function if exists public._security_map_units(timestamptz, timestamptz, boolean);
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: none on any table outside pg_catalog. Every body is plpgsql,
-- which Postgres does not resolve when the function is created, so creating
-- them reads and locks no table the bodies name. The preflight reads the
-- catalogs only. lock_timeout 900ms bounds anything unforeseen; it is not
-- reset at the end of the file, so the push's own last write, made in the
-- same transaction, has the same limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only. Refuses to run (55000, hint
-- platform_security_map_preflight, nothing applied) when a name this file
-- creates is taken (applied already, or half applied by hand); when a table
-- or column the bodies read is missing or is not of the type the bodies
-- count with; when this role, the functions' owner, could not read
-- security_events or organizations, or would see none of the events through
-- row security (the map would then answer as if nothing had happened); and
-- when the record has no valid index over every row that starts with the
-- minute (the window, and the row ceiling, are read by it).
do $preflight$
declare
  v_bad text := '';
begin
  if to_regclass('public.security_events') is null or to_regclass('public.organizations') is null then
    v_bad := v_bad || ' public.security_events or public.organizations is missing;';
  else
    if (select count(*) from pg_catalog.pg_attribute a
         where a.attnum > 0 and not a.attisdropped
           and ((a.attrelid = 'public.security_events'::regclass
                 and (a.attname, format_type(a.atttypid, a.atttypmod)) in (
                       ('minute', 'timestamp with time zone'),
                       ('category', 'text'),
                       ('outcome', 'text'),
                       ('reason', 'text'),
                       ('source', 'text'),
                       ('organization_id', 'uuid'),
                       ('country', 'text'),
                       ('city', 'text'),
                       ('event_count', 'integer')))
                or (a.attrelid = 'public.organizations'::regclass
                    and (a.attname, format_type(a.atttypid, a.atttypmod)) in (
                          ('id', 'uuid'),
                          ('name', 'text'))))) <> 11 then
      v_bad := v_bad || ' security_events (minute, category, outcome, reason, source, organization_id, country, city, event_count) or organizations (id, name) is not as the functions read it;';
    end if;
    if not has_table_privilege('public.security_events', 'select')
       or not has_table_privilege('public.organizations', 'select') then
      v_bad := v_bad || ' this role may not read security_events or organizations;';
    end if;
    -- Row security: the table's owner reads every row unless it is forced
    -- on the owner too; any other role needs to be exempt from it.
    if not (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user)
       and exists (select 1 from pg_catalog.pg_class c
                    where c.oid = 'public.security_events'::regclass
                      and c.relrowsecurity
                      and (c.relforcerowsecurity
                           or c.relowner <> (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user))) then
      v_bad := v_bad || ' row security would hide security_events from this role;';
    end if;
    -- A valid index over every row whose first column is the minute.
    if not exists (select 1 from pg_catalog.pg_index i
                     join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = 'public.security_events'::regclass
                      and i.indisvalid and i.indpred is null
                      and a.attname = 'minute') then
      v_bad := v_bad || ' security_events has no valid index over every row that starts with minute;';
    end if;
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('_security_map_units', '_security_map_read_from', 'platform_security_map')) then
    v_bad := v_bad || ' a function name this file creates is taken (or this file already ran);';
  end if;

  if v_bad <> '' then
    raise exception 'platform_security_map_preflight:%', v_bad
      using errcode = '55000', hint = 'platform_security_map_preflight';
  end if;
end
$preflight$;

-- ── 1. The units of a window (private): the counting rules, once ─────────────
-- plpgsql, not sql, here and below: a sql body is resolved when it is
-- created, which would lock the tables it names while this file runs (0475).
create function public._security_map_units(p_from timestamptz, p_to timestamptz, p_flagged_only boolean)
returns table (
  minute           timestamptz,
  category         text,
  outcome          text,
  reason           text,
  source           text,
  country          text,
  city             text,
  organization_id  uuid,
  organizations    integer,
  events           integer,
  at_least         boolean,
  kind             text,
  late             boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  -- THE FOUR LISTS. Written here and nowhere else in the database; the
  -- console's code keeps a copy of each, and this file's test holds the
  -- lists below to the letter.
  -- Reasons recorded once in each organization of one account
  -- (apps/web/src/server/security/sign-in-alert-events.ts): one unit
  -- whatever the organizations, counted as a floor (below).
  c_folded_reasons  constant text[] := array['sign_in_new_country', 'sign_in_not_me', 'sign_in_alerts_held'];
  -- Reasons whose number is, or in some hours is, a count of other rows of
  -- the record (apps/web/src/server/security/auth-logs.ts: "TOTALS THAT ARE
  -- NOT WHOLE"; and the two counts of our server's form, from which the
  -- rows past a cap are never taken off): kept out of every total and
  -- listed apart.
  c_tally_reasons   constant text[] := array['too_many_forms_to_count', 'unrecorded_server_form_password', 'unrecorded_server_form_code'];
  -- Reasons of the rows that stand for events past a cap (0472's minute
  -- caps; the recorder's buffer; the hourly reader's remainder): counted,
  -- with no place.
  c_flood_reasons   constant text[] := array['over_minute_cap', 'over_buffer_cap', 'auth_log_over_cap'];
  -- Sources whose rows can be added up to hours after their minute (the
  -- hourly reader of the sign-in service's log).
  c_late_sources    constant text[] := array['phone', 'api'];
  -- The most rows one sign-in writes of a folded reason: one in each of at
  -- most 5 organizations (MAX_ORGANIZATIONS in sign-in-alert-events.ts),
  -- each adding 1 to its row's count (recordSecurityEvent in events.ts). So
  -- rows whose counts add up to S stand for at least S / 5 sign-ins.
  c_rows_per_sign_in constant numeric := 5;
begin
  -- No role holds EXECUTE on this function. It carries the lock of the
  -- public read as well, which names no gate (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_map_not_allowed' using errcode = '42501';
  end if;

  -- A row is in the window when its minute starts at or after p_from and
  -- before p_to. The rows of every other reason, each as it is; then the
  -- rows of the first list, taken together by minute and place.
  return query
    select s.minute, s.category, s.outcome, s.reason, s.source,
           case when s.reason = any (c_flood_reasons) then null else s.country end,
           case when s.reason = any (c_flood_reasons) then null else s.city end,
           s.organization_id,
           case when s.organization_id is null then 0 else 1 end,
           s.event_count,
           false,
           case when s.reason = any (c_tally_reasons) then 'tally'
                when s.reason = any (c_flood_reasons) then 'flood'
                else 'event' end,
           (s.source = any (c_late_sources))
      from public.security_events s
     where s.minute >= p_from
       and s.minute < p_to
       and s.reason <> all (c_folded_reasons)
       and (s.outcome = 'flagged' or not p_flagged_only)
    union all
    select f.minute, f.category, f.outcome, f.reason, f.source, f.country, f.city,
           -- The one organization its rows name, or none when they name
           -- several (the record keeps one row for each organization).
           case when pg_catalog.count(f.organization_id) = 1
                then pg_catalog.min(f.organization_id::text)::uuid end,
           pg_catalog.count(f.organization_id)::integer,
           -- A floor: the largest count among the rows, or a fifth of their
           -- sum rounded up when that is more (never their sum). Held to
           -- the writer's own ceiling on a count (0472).
           least(greatest(pg_catalog.max(f.event_count)::numeric,
                          pg_catalog.ceil(pg_catalog.sum(f.event_count) / c_rows_per_sign_in)),
                 2000000000)::integer,
           -- Two rows or more can be more sign-ins than the floor says.
           pg_catalog.count(*) > 1,
           'event',
           (f.source = any (c_late_sources))
      from public.security_events f
     where f.minute >= p_from
       and f.minute < p_to
       and f.reason = any (c_folded_reasons)
       and (f.outcome = 'flagged' or not p_flagged_only)
     group by f.minute, f.category, f.outcome, f.reason, f.source, f.country, f.city;
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
-- No grant follows: only the map read below calls it, as its owner.
revoke all on function public._security_map_units(timestamptz, timestamptz, boolean) from public, anon, authenticated, service_role;

comment on function public._security_map_units(timestamptz, timestamptz, boolean) is
  'Private. The counting rules of the platform console''s attack map, written once. One row per unit of the window (security_events rows whose minute starts at or after p_from and before p_to; only the flagged ones when p_flagged_only). A unit is a row as it is, with events its count; except that the rows of a reason recorded once in each organization of one account (sign_in_new_country, sign_in_not_me, sign_in_alerts_held) that share minute, category, outcome, source, country and city are one unit whatever the organizations, counted as a floor: the largest count among those rows, or a fifth of their sum rounded up when that is more (one sign-in writes at most 5 such rows); at_least is true when such a unit is made of two rows or more, organizations says how many organizations its rows name, and organization_id is set when that is one. kind is tally for a reason whose number can be a count of other rows (too_many_forms_to_count, unrecorded_server_form_password, unrecorded_server_form_code), flood for a row that stands for events past a cap (over_minute_cap, over_buffer_cap, auth_log_over_cap; never a country or city), else event. late is true when the source is phone or api. SECURITY INVOKER; called only by platform_security_map, as its owner. No API role may call it; called as authenticated or anon it raises 42501.';

-- ── 2. The start to read from (private): the row ceiling ─────────────────────
create function public._security_map_read_from(p_from timestamptz, p_to timestamptz, p_max_rows integer)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
-- The window's newest rows are wanted in the order of the index on minute.
-- Without this the planner may choose to read and sort the whole window
-- (it prices the walk high while recent pages are not yet marked all
-- visible), and that costs as the window does. With it, the only plan
-- without a sort is the walk from the window's end, which stops after
-- p_max_rows and one more row. It changes the plan only, never the answer.
set enable_sort = off
as $$
declare
  v_past timestamptz;
begin
  -- No role holds EXECUTE on this function. It carries the lock of the
  -- public read as well, which names no gate (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_map_not_allowed' using errcode = '42501';
  end if;

  -- The row after the window's newest p_max_rows, newest first, if there is
  -- one. Its minute is then only partly within the p_max_rows: the window
  -- is read from the minute after it.
  select s.minute
    into v_past
    from public.security_events s
   where s.minute >= p_from
     and s.minute < p_to
   order by s.minute desc
  offset p_max_rows
   limit 1;
  if v_past is null then
    return p_from;
  end if;
  return v_past + interval '1 minute';
end;
$$;

revoke all on function public._security_map_read_from(timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;

comment on function public._security_map_read_from(timestamptz, timestamptz, integer) is
  'Private. The row ceiling of the platform console''s attack map: the start to read the window p_from to p_to from (a row is in it when its minute starts at or after p_from and before p_to). p_from when the window holds at most p_max_rows rows of security_events; else the minute after the minute of the row that comes after the newest p_max_rows, newest first: the earliest start on a whole minute that keeps the rows read to p_max_rows (a result at or after p_to means the newest minute alone holds more). Walks the index on minute from p_to and stops one row past p_max_rows, whatever the window holds; enable_sort is off in it so that the planner does not read and sort the whole window instead (the plan only, never the answer). SECURITY INVOKER; called only by platform_security_map, as its owner. No API role may call it; called as authenticated or anon it raises 42501.';

-- ── 3. The map read ──────────────────────────────────────────────────────────
create function public.platform_security_map(
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set timezone = 'UTC'
as $$
declare
  -- THE BOUNDS OF ONE READ. Written here and nowhere else.
  -- The most rows of the record one answer reads. A window that holds more
  -- is read from a later start (on a whole minute) that keeps it to this
  -- many, and the answer says so (2 finds the start). At this many rows the
  -- read answers in about a second on the development stack, whatever the
  -- rows hold.
  c_max_rows      constant integer  := 400000;
  -- The longest window: the longest local day (25 hours, when the clocks
  -- go back) and an hour more. The refusal's word names it.
  c_longest       constant interval := '26 hours';
  -- A window asked for that is shorter than this is a poll: its answer
  -- leaves out the 10-minute cells and the groups by country.
  c_short_window  constant interval := '30 minutes';
  v_now          timestamptz := pg_catalog.now();
  v_to           timestamptz;
  v_asked_from   timestamptz;
  v_from         timestamptz;
  v_shortened    boolean := false;
  v_short        boolean;
  v_live_from    timestamptz;
  v_day_start    timestamptz;
  v_day_partial  boolean := false;
  v_oldest       timestamptz;
  v_feed_from    timestamptz;
  v_flagged_from timestamptz;
  v_feed         jsonb;
  v_flagged_feed jsonb;
  v_result       jsonb;
  -- The 10-minute buckets sit on the UTC clock (:00, :10, ...), so a bucket
  -- has the same start in every answer that holds it.
  c_bucket_origin constant timestamptz := '2000-01-01 00:00:00+00';
  -- Every outcome and every category is always present, zeros included.
  v_no_outcome   jsonb := pg_catalog.jsonb_build_object('blocked', 0, 'flagged', 0, 'allowed', 0);
  v_no_category  jsonb := pg_catalog.jsonb_build_object(
                            'password_guessing', v_no_outcome, 'exploit', v_no_outcome,
                            'bots', v_no_outcome, 'phishing', v_no_outcome, 'malware', v_no_outcome);
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_map_not_allowed' using errcode = '42501';
  end if;

  -- The window asked for: up to p_to (default: now), from p_from (default:
  -- 24 hours before the end). A window that cannot be read is answered, not
  -- raised, and the answer holds a fixed word, never the argument.
  v_to         := coalesce(p_to, v_now);
  v_asked_from := coalesce(p_from, v_to - interval '24 hours');
  if not pg_catalog.isfinite(v_to) or not pg_catalog.isfinite(v_asked_from) then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'not_a_time', 'generated_at', v_now);
  end if;
  if v_to > v_now + interval '1 minute' then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'to_in_the_future', 'generated_at', v_now);
  end if;
  if v_asked_from >= v_to then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'from_not_before_to', 'generated_at', v_now);
  end if;
  if v_asked_from < v_to - c_longest then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'longer_than_26_hours', 'generated_at', v_now);
  end if;
  v_short := v_to - v_asked_from < c_short_window;

  -- The row ceiling: the start to read from (2). It is the start asked for
  -- when the window holds at most the ceiling; else the earliest start on
  -- a whole minute that keeps the rows read to the ceiling.
  v_from := public._security_map_read_from(v_asked_from, v_to, c_max_rows);
  if v_from > v_asked_from then
    v_shortened := true;
    -- The newest minute alone holds more than the ceiling.
    if v_from >= v_to then
      return pg_catalog.jsonb_build_object('window', null, 'refused', 'too_many_events_in_one_minute', 'generated_at', v_now);
    end if;
  end if;

  -- The last 10 minutes of the window read: ten 1-minute buckets, whatever
  -- second the window ends on.
  v_live_from := greatest(v_to - interval '10 minutes', v_from);
  -- A day start counts only when it is inside the window asked for; any
  -- other is as if none was given. One before the start read is counted
  -- from that start and marked partial.
  if p_day_start is not null and p_day_start >= v_asked_from and p_day_start <= v_to then
    v_day_start   := p_day_start;
    v_day_partial := p_day_start < v_from;
  end if;

  -- One pass over the units of the window read, four groupings at once (the
  -- number is which of bucket, live_minute, reason and minute a grouping
  -- leaves out):
  --    7: 10-minute bucket, country, category, outcome
  --   11: minute of the last 10 (late units left out), country, category, outcome
  --   13: kind, late, reason, source, category, outcome
  --   14: minute, outcome
  -- events leaves the tallies out; all_events has them too, for the list of
  -- tallies alone; at_least is set when a counted unit in the cell is a
  -- floor. Every part of the answer but the two feeds is made from these
  -- cells.
  with cells as materialized (
    select grouping(d.bucket, d.live_minute, d.reason, d.minute) as grouped_by,
           d.bucket, d.live_minute, d.minute, d.country, d.category, d.outcome,
           d.kind, d.late, d.reason, d.source,
           pg_catalog.sum(d.events) filter (where d.counted) as events,
           pg_catalog.sum(d.events) as all_events,
           pg_catalog.count(*) as units,
           coalesce(pg_catalog.bool_or(d.at_least) filter (where d.counted), false) as at_least
      from (
        select x.minute, x.category, x.outcome, x.reason, x.source, x.country, x.events, x.at_least,
               x.kind, x.late,
               (x.kind <> 'tally') as counted,
               pg_catalog.date_bin(interval '10 minutes', x.minute, c_bucket_origin) as bucket,
               case when x.minute >= v_live_from and not x.late then x.minute end as live_minute
          from public._security_map_units(v_from, v_to, false) x
      ) d
     group by grouping sets (
       (d.bucket, d.country, d.category, d.outcome),
       (d.live_minute, d.country, d.category, d.outcome),
       (d.kind, d.late, d.reason, d.source, d.category, d.outcome),
       (d.minute, d.outcome))
  ),
  ten as (
    -- Every counted event of the window by 10-minute bucket, with and
    -- without a country.
    select c.bucket, c.country, c.category, c.outcome, c.events, c.at_least
      from cells c
     where c.grouped_by = 7 and c.events is not null
  ),
  -- Which cells and groups are kept when a cap cuts: in each kind of cell,
  -- and in the groups by country, the flagged first, so that no number of
  -- blocked events can push a flagged one out of the answer; then the
  -- largest. (The lists are written largest first all the same.)
  one_ranked as (
    select c.live_minute as bucket_start, c.country, c.category, c.outcome, c.events,
           pg_catalog.row_number() over (
             order by (c.outcome = 'flagged') desc, c.events desc, c.live_minute desc, c.country collate "C",
                      c.category collate "C", c.outcome collate "C") as rn
      from cells c
     where c.grouped_by = 11 and c.live_minute is not null and c.country is not null and c.events is not null
  ),
  ten_ranked as (
    select t.bucket as bucket_start, t.country, t.category, t.outcome, t.events,
           pg_catalog.row_number() over (
             order by (t.outcome = 'flagged') desc, t.events desc, t.bucket desc, t.country collate "C",
                      t.category collate "C", t.outcome collate "C") as rn
      from ten t
     where t.country is not null
  ),
  kept as (
    -- At most 4,000 cells: the 1-minute cells first (at most 1,000 of
    -- them), then the 10-minute cells; none of those in a poll.
    select least((select pg_catalog.count(*) from one_ranked), 1000) as one_cells,
           case when v_short then 0
                else 4000 - least((select pg_catalog.count(*) from one_ranked), 1000) end as ten_cells
  ),
  places as (
    -- None in a poll.
    select t.country, t.category, t.outcome, pg_catalog.sum(t.events)::bigint as events
      from ten t
     where t.country is not null and not v_short
     group by t.country, t.category, t.outcome
  ),
  places_ranked as (
    select p.country, p.category, p.outcome, p.events,
           pg_catalog.row_number() over (
             order by (p.outcome = 'flagged') desc, p.events desc, p.country collate "C", p.category collate "C",
                      p.outcome collate "C") as rn
      from places p
  ),
  sums as (
    select t.category, t.outcome,
           pg_catalog.sum(t.events)::bigint as events,
           coalesce(pg_catalog.sum(t.events) filter (where t.country is null), 0)::bigint as no_place_events,
           pg_catalog.bool_or(t.at_least) as at_least,
           coalesce(pg_catalog.bool_or(t.at_least) filter (where t.country is null), false) as no_place_at_least
      from ten t
     group by t.category, t.outcome
  ),
  sums_by_category as (
    select s.category,
           v_no_outcome || pg_catalog.jsonb_object_agg(s.outcome, s.events) as totals,
           v_no_outcome || pg_catalog.jsonb_object_agg(s.outcome, s.no_place_events) as no_place
      from sums s
     group by s.category
  ),
  floors as (
    -- The numbers of the answer that are floors: a total, a count with no
    -- place or a window count that holds a counted unit marked at_least,
    -- and the count since the day start when it holds one or is partial.
    select 'totals.' || s.category || '.' || s.outcome as name from sums s where s.at_least
    union all
    select 'no_place.' || s.category || '.' || s.outcome from sums s where s.no_place_at_least
    union all
    select s.outcome || '_window' from sums s group by s.outcome having pg_catalog.bool_or(s.at_least)
    union all
    select 'blocked_since_day_start'
     where v_day_start is not null
       and (v_day_partial
            or exists (select 1 from cells c
                        where c.grouped_by = 14 and c.outcome = 'blocked' and c.minute >= v_day_start
                          and c.at_least))
  )
  select pg_catalog.jsonb_build_object(
           'window', pg_catalog.jsonb_build_object('from', v_from, 'to', v_to, 'live_from', v_live_from,
                                                   'asked_from', v_asked_from),
           'window_shortened', v_shortened,
           'short_window', v_short,
           'refused', null,
           'generated_at', v_now,
           'timeline',
             coalesce((select pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'bucket_start', b.bucket_start,
                                  'bucket_seconds', b.bucket_seconds,
                                  'country', b.country,
                                  'category', b.category,
                                  'outcome', b.outcome,
                                  'events', b.events)
                                order by b.bucket_seconds, b.events desc, b.bucket_start desc,
                                         b.country collate "C", b.category collate "C", b.outcome collate "C")
                         from (
                           select 60 as bucket_seconds, o.bucket_start, o.country, o.category, o.outcome, o.events, o.rn
                             from one_ranked o
                            where o.rn <= (select k.one_cells from kept k)
                           union all
                           select 600, t.bucket_start, t.country, t.category, t.outcome, t.events, t.rn
                             from ten_ranked t
                            where t.rn <= (select k.ten_cells from kept k)
                         ) b), pg_catalog.jsonb_build_array()),
           'timeline_truncated',
             (select pg_catalog.count(*) from one_ranked) > (select k.one_cells from kept k)
             or (not v_short and (select pg_catalog.count(*) from ten_ranked) > (select k.ten_cells from kept k)),
           'by_country',
             coalesce((select pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'country', p.country,
                                  'category', p.category,
                                  'outcome', p.outcome,
                                  'events', p.events)
                                order by p.events desc, p.country collate "C", p.category collate "C",
                                         p.outcome collate "C")
                         from places_ranked p
                        where p.rn <= 2000), pg_catalog.jsonb_build_array()),
           'by_country_truncated', (select pg_catalog.count(*) from places) > 2000,
           'totals',
             v_no_category || coalesce((select pg_catalog.jsonb_object_agg(s.category, s.totals) from sums_by_category s),
                                       pg_catalog.jsonb_build_object()),
           'no_place',
             v_no_category || coalesce((select pg_catalog.jsonb_object_agg(s.category, s.no_place) from sums_by_category s),
                                       pg_catalog.jsonb_build_object()),
           'blocked_window', (select coalesce(pg_catalog.sum(s.events), 0)::bigint from sums s where s.outcome = 'blocked'),
           'flagged_window', (select coalesce(pg_catalog.sum(s.events), 0)::bigint from sums s where s.outcome = 'flagged'),
           'allowed_window', (select coalesce(pg_catalog.sum(s.events), 0)::bigint from sums s where s.outcome = 'allowed'),
           'day_start', v_day_start,
           'blocked_since_day_start',
             case when v_day_start is null then null
                  else (select coalesce(pg_catalog.sum(c.events), 0)::bigint
                          from cells c
                         where c.grouped_by = 14 and c.outcome = 'blocked' and c.minute >= v_day_start) end,
           'blocked_since_day_start_partial', v_day_partial,
           'floors',
             coalesce((select pg_catalog.jsonb_agg(f.name order by f.name collate "C") from floors f),
                      pg_catalog.jsonb_build_array()),
           'late_sources',
             coalesce((select pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'source', l.source,
                                  'category', l.category,
                                  'outcome', l.outcome,
                                  'events', l.events)
                                order by l.source collate "C", l.category collate "C", l.outcome collate "C")
                         from (
                           select c.source, c.category, c.outcome, pg_catalog.sum(c.events)::bigint as events
                             from cells c
                            where c.grouped_by = 13 and c.late and c.events is not null
                            group by c.source, c.category, c.outcome
                         ) l), pg_catalog.jsonb_build_array()),
           'tallies',
             coalesce((select pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'reason', c.reason,
                                  'source', c.source,
                                  'category', c.category,
                                  'outcome', c.outcome,
                                  'events', c.all_events,
                                  'rows', c.units)
                                order by c.reason collate "C", c.source collate "C", c.category collate "C",
                                         c.outcome collate "C")
                         from cells c
                        where c.grouped_by = 13 and c.kind = 'tally'), pg_catalog.jsonb_build_array()),
           'flood_rows',
             coalesce((select pg_catalog.jsonb_agg(
                                pg_catalog.jsonb_build_object(
                                  'reason', c.reason,
                                  'source', c.source,
                                  'category', c.category,
                                  'outcome', c.outcome,
                                  'events', c.events,
                                  'rows', c.units)
                                order by c.reason collate "C", c.source collate "C", c.category collate "C",
                                         c.outcome collate "C")
                         from cells c
                        where c.grouped_by = 13 and c.kind = 'flood'), pg_catalog.jsonb_build_array())),
         -- Where the feed starts: the newest 60 entries lie in the newest 60
         -- minutes that hold a counted unit.
         (select pg_catalog.min(m.minute)
            from (select distinct c.minute
                    from cells c
                   where c.grouped_by = 14 and c.events is not null
                   order by c.minute desc
                   limit 60) m),
         -- And the flagged feed: the newest 20 flagged entries lie in the
         -- newest 20 minutes that hold a counted flagged unit.
         (select pg_catalog.min(m.minute)
            from (select c.minute
                    from cells c
                   where c.grouped_by = 14 and c.outcome = 'flagged' and c.events is not null
                   order by c.minute desc
                   limit 20) m)
    into v_result, v_feed_from, v_flagged_from;

  -- The feed: the newest 60 entries, the latest minute first and in a
  -- minute the largest first; and the flagged feed: the newest 20 flagged
  -- entries in the same order, so that a page can always show them. An
  -- entry is the units of one minute with the same category, outcome,
  -- reason, source, country, city and organization, taken together (a
  -- tally is listed apart). Read from the same units, for those minutes
  -- only (and for the flagged feed, the flagged units only).
  if v_feed_from is not null then
    select pg_catalog.jsonb_agg(n.entry order by n.rn) filter (where not n.flagged_only),
           pg_catalog.jsonb_agg(n.entry order by n.rn) filter (where n.flagged_only)
      into v_feed, v_flagged_feed
      from (
        select e.flagged_only,
               pg_catalog.row_number() over (
                 partition by e.flagged_only
                 order by e.minute desc, e.events desc, e.category collate "C", e.outcome collate "C",
                          e.reason collate "C", e.source collate "C", e.country collate "C" nulls last,
                          e.city collate "C" nulls last, e.organization_id nulls last) as rn,
               pg_catalog.jsonb_build_object(
                 'minute', e.minute,
                 'category', e.category,
                 'outcome', e.outcome,
                 'reason', e.reason,
                 'source', e.source,
                 'country', e.country,
                 'city', e.city,
                 'events', e.events,
                 'at_least', e.at_least,
                 'organization_id', e.organization_id,
                 'organization_name', pg_catalog.left(o.name, 200),
                 'organizations', e.organizations) as entry
          from (
            (select false as flagged_only,
                    x.minute, x.category, x.outcome, x.reason, x.source, x.country, x.city, x.organization_id,
                    pg_catalog.max(x.organizations) as organizations,
                    pg_catalog.sum(x.events)::bigint as events,
                    pg_catalog.bool_or(x.at_least) as at_least
               from public._security_map_units(v_feed_from, v_to, false) x
              where x.kind <> 'tally'
              group by x.minute, x.category, x.outcome, x.reason, x.source, x.country, x.city, x.organization_id
              order by x.minute desc, pg_catalog.sum(x.events) desc, x.category collate "C", x.outcome collate "C",
                       x.reason collate "C", x.source collate "C", x.country collate "C" nulls last,
                       x.city collate "C" nulls last, x.organization_id nulls last
              limit 60)
            union all
            (select true,
                    x.minute, x.category, x.outcome, x.reason, x.source, x.country, x.city, x.organization_id,
                    pg_catalog.max(x.organizations),
                    pg_catalog.sum(x.events)::bigint,
                    pg_catalog.bool_or(x.at_least)
               from public._security_map_units(coalesce(v_flagged_from, v_to), v_to, true) x
              where x.kind <> 'tally'
              group by x.minute, x.category, x.outcome, x.reason, x.source, x.country, x.city, x.organization_id
              order by x.minute desc, pg_catalog.sum(x.events) desc, x.category collate "C", x.outcome collate "C",
                       x.reason collate "C", x.source collate "C", x.country collate "C" nulls last,
                       x.city collate "C" nulls last, x.organization_id nulls last
              limit 20)
          ) e
          left join public.organizations o on o.id = e.organization_id
      ) n;
  end if;

  -- The oldest minute on record (the first entry of the index on minute): a
  -- window that starts before it was not fully recorded.
  select pg_catalog.min(s.minute) into v_oldest from public.security_events s;

  return v_result || pg_catalog.jsonb_build_object(
    'feed', coalesce(v_feed, pg_catalog.jsonb_build_array()),
    'flagged_feed', coalesce(v_flagged_feed, pg_catalog.jsonb_build_array()),
    'oldest_event_at', v_oldest);
end;
$$;

revoke all on function public.platform_security_map(timestamptz, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_map(timestamptz, timestamptz, timestamptz) to service_role;

comment on function public.platform_security_map(timestamptz, timestamptz, timestamptz) is
  'For the platform console''s attack map. One document for the window asked for, from p_from (default: 24 hours before the end) up to, not including, p_to (default: now), at most 26 hours, counted as _security_map_units counts. A window that holds more than 400,000 rows of the record is read from a later start on a whole minute, the earliest that keeps it to 400,000: window_shortened is then true, window.from is the start read and window.asked_from the start asked for; every part of the answer is of the window read. Keys: window (from, to, live_from, asked_from), window_shortened, short_window, refused (null), generated_at, oldest_event_at (the earliest minute on record); timeline, cells of bucket_start, bucket_seconds, country, category, outcome and events: 600-second buckets on the UTC clock for the window and 60-second buckets for its last 10 minutes without the units whose source is phone or api, only for events with a country, at most 4,000 cells (the 60-second cells first, at most 1,000, then the 600-second cells, each kind listed largest first; when a cap cuts, the flagged cells are kept first and then the largest; timeline_truncated); by_country (country, category, outcome, events; at most 2,000, listed largest first, kept as the cells are; by_country_truncated); a window asked for that is shorter than 30 minutes (short_window) has no 600-second cells and an empty by_country; totals and no_place (events with no country) by category and outcome, every one always present; blocked_window, flagged_window, allowed_window; day_start and blocked_since_day_start (set only when p_day_start is inside the window asked for; counted from the start read, and blocked_since_day_start_partial true, when it is before that start); floors, the names of the numbers that are floors; feed, the newest 60 entries, and flagged_feed, the newest 20 flagged entries (the units of one minute with the same category, outcome, reason, source, country, city and organization, taken together) with minute, category, outcome, reason, source, country, city, events, at_least, organization_id, organization_name (its first 200 characters) and organizations; late_sources (source, category, outcome, events for phone and api); tallies and flood_rows (reason, source, category, outcome, events, rows). A tally is in tallies and in nothing else. A window that is not a time, ends more than a minute after now, is out of order or is longer than 26 hours, or whose newest minute alone holds more than 400,000 rows, answers window null and refused with a fixed word (not_a_time, to_in_the_future, from_not_before_to, longer_than_26_hours, too_many_events_in_one_minute); no argument makes it raise. Returns no source hash, row key or row id. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';
