-- 0480_platform_security_alerts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The platform console's security alerts, the database half: what the
-- alert job reads, how it claims an alert so that each is sent once, what it
-- records after sending, how it says it ran, the switches and thresholds the
-- owner sets on the console, and the console's read. Nothing calls these
-- objects until the job and the console page that follow this migration;
-- until the owner turns a channel on, every alert is recorded only. The
-- advisory lock key below (4800001) carries this file's number.
--
-- WHAT IT ADDS (tier A: three new tables with their keys, indexes and
-- checks, one row in the new state table, nine functions and their grants.
-- No foreign key, no policy, no trigger; no existing table, function, policy
-- or grant changes, no row is written to a table that exists, and no lock is
-- taken on a table that exists.)
--   Words used below.
--     A rule: serious_flag (class serious), aimed_guessing and spike (class
--       volume), record_trouble (class record).
--     An alert: one (rule, subject, event_key, phase). subject is an
--       organization id for aimed_guessing and '' for every other rule.
--       event_key comes from the EVENTS, never from the clock of the run
--       that reads them: for serious_flag the reason and the UTC hour of the
--       event ('sign_in_not_me|2026-11-24T10:00Z'); for the other rules the
--       start of the condition, a 10-minute bucket on the UTC clock
--       ('2026-11-24T10:20Z'), and for a reminder that start and the step
--       ('2026-11-24T10:20Z+6h'). Two runs that read the same events make
--       the same key whatever second each runs at.
--     A state: a condition of a volume or record rule for one subject, from
--       its 'started' alert to its 'ended' alert. At most one is open for a
--       rule and subject at a time; it has at most three reminders (1, 6 and
--       24 hours after its start).
--   1. public.platform_security_alert_state: exactly one row, made here. The
--      three switches (email_on, push_on, summary_on: all false, so every
--      alert is recorded only), the thresholds as jsonb with the defaults
--      below (tunable on the console without a release), planned_check_until
--      (a planned check holds volume and record alerts, never a serious
--      one), the stored baseline (the 7-day high marks), and the job's
--      heartbeat (its last run started, finished, whether it went well and
--      checked fully, the last good run, failures in a row, when the failing
--      notice was last asked for).
--   2. public.platform_security_alerts: one row per alert claimed, with its
--      class, counts (numbers and reason codes only), disposition
--      (record_only, sent, held_planned_check, email_only_budget,
--      held_for_summary, not_sent), the channels it was handed out for,
--      whether it used a slot of its class's push budget, why a serious
--      flag's email went although email alerts were off (email_floor), each
--      channel's result as counts of result codes (never an address or an
--      account), the attempts, when it was claimed and when its result came.
--      UNIQUE (rule, subject, event_key, phase).
--   3. public.platform_security_alert_changes: who changed which switch,
--      threshold or planned check, from what to what, and when (the acting
--      user's id as a plain uuid, passed in by the server).
--   4. Nine functions, each SECURITY DEFINER with an empty search_path:
--      - platform_security_alert_inputs(): what the job reads. Of the
--        security events record (0472), the last 8 hours by the EVENT's
--        minute, with a row ceiling (400,000 rows, then read from a later
--        whole minute, and said), counted by the map's own rules (0478's
--        _security_map_units: a sign-in recorded once in each organization
--        of one account is one unit, a tally is kept out of every total, a
--        flood row has no place): the serious flags by reason and UTC hour
--        (and the flood rows whose outcome is flagged), the four guessing
--        reasons by organization and 10-minute bucket, every bucket's events
--        and distinct sources (a COUNT; never a source hash) and its flood
--        rows. And of this file's tables: the open states, the alerts due
--        their one retry, the thresholds, the baseline marks with their
--        floors, the switches; the serious flags due their retry have a list
--        of their own, so the others never crowd them out. STABLE.
--      - platform_security_alert_claim(...): one transaction under this
--        file's advisory lock. Is this alert new (a row claimed before is
--        answered by its row, whatever the age of its key); is a state
--        already open, or has this start's state ended; is a reminder due;
--        is the class's push budget free (serious: 6 an hour, and 4 a day for
--        one reason; volume and record together: 8 a day, and 4 a day for one
--        rule and subject); is a planned check on; which switches are on.
--        Email is a serious flag's floor: past its push budget it goes by
--        email even when email alerts are off, and the row says so; nothing
--        is sent only when both switches are off. Volume and record emails:
--        24 a day together, then held for the daily summary. Inserts the
--        alert, also when nothing is sent, and answers what to send. A claim
--        that had no result 5 minutes later is handed out once more; a second
--        time it is marked not_sent.
--      - platform_security_alert_result(...): records each channel's result;
--        a serious flag's push that reached no one is recorded only with the
--        email that took its place.
--      - platform_security_alert_heartbeat(...): the start and the finish of
--        a run (and whether it could check fully); counts missed and failed
--        runs in a row and says when they reach three, at most once in 6
--        hours; marks not_sent the claims nobody finished (a serious flag
--        only 10 hours after its claim, so a run that comes late still
--        offers its one retry).
--      - platform_security_alert_set(...): one switch, threshold or planned
--        check, its name and value checked, and its change row, in one
--        transaction. A planned check: at most 30 minutes, none while one is
--        on or within 30 minutes of the last one's end, at most 4 a day.
--      - platform_security_alert_list(...): the console's read, with the
--        latest change of every setting however old. STABLE.
--      - platform_security_alert_baseline(): once a day, the 99th percentile
--        of the 10-minute buckets of the last 7 days (events, and distinct
--        sources), with a row ceiling and a statement timeout; stored.
--      - platform_security_alert_purge(): alerts claimed more than 400 days
--        ago, 5,000 a call.
--      - platform_admin_user_ids(text[]): the ids of the accounts whose
--        CONFIRMED sign-in email (auth.users.email, never the profile column)
--        is on the list, case-insensitive, at most 20 addresses read; an
--        account that is disabled (user_profiles.disabled_at, the console's
--        own flag, or a ban in Auth) or deleted is left out. STABLE.
--      No function returns a source hash, a path, an address or a row key of
--      the security events record. Every function that the job or the
--      console calls answers a fixed word for an argument it will not take;
--      none raises for one.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy on the three tables, and anon, authenticated
--     and service_role hold no privilege on any of them: the functions are
--     the only way in (service_role bypasses row security, so the missing
--     grant is what keeps it out).
--   - service_role may EXECUTE the nine functions and nothing else. The
--     grant is the gate (0477, 0478, 0479): no body names auth.uid,
--     has_org_role, has_permission or is_org_member, so if EXECUTE ever
--     reached authenticated, security_invariants INV-25 would name the
--     function. A second lock that names no gate: each body first reads the
--     role setting (0413's form) and refuses with 42501
--     (platform_security_alerts_not_allowed) when it is authenticated or
--     anon.
--   - The writes (claim, result, heartbeat, set, purge, and the baseline's
--     last statement) take this file's own advisory lock (4800001), never the
--     security events' (4720001) or the samples' (4790001), so the alert job
--     never makes the record drop a batch. A call that waits 2 s for its turn
--     ends with 55P03. The reads take no lock.
--   Explicit for all three API roles and PUBLIC (apps/web/src/test/
--   migration-grants.ts), the same with and without Supabase's default
--   grants.
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: none on any table that exists. The tables have no foreign key, so
-- creating them locks nothing but themselves, their indexes and their toast
-- tables; the row inserted goes into a new table; every function body is
-- plpgsql, which Postgres does not resolve when it is created, so creating
-- them reads and locks no table the bodies name; no policy is created, so
-- supautils takes nothing on the auth, storage and realtime tables (0418's
-- note). The preflight reads the catalogs only. lock_timeout 900ms bounds
-- anything unforeseen; it is not reset at the end of the file, so the push's
-- own last write, made in the same transaction, has the same limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only. Refuses to run (55000, hint
-- platform_security_alerts_preflight, nothing applied) when a name this file
-- creates is taken (the file already ran, or was half applied by hand); when
-- another function already names the advisory lock key; when a table, column
-- or function the bodies read is missing or is not of the type they read it
-- as; and when this role, the functions' owner, could not read those tables
-- or would see none of their rows through row security.
do $preflight$
declare
  v_bad text := '';
begin
  if exists (select 1 from pg_catalog.pg_class c
              where c.relnamespace = 'public'::regnamespace
                and c.relname in ('platform_security_alert_state', 'platform_security_alert_state_pkey',
                                  'platform_security_alerts', 'platform_security_alerts_pkey',
                                  'platform_security_alerts_alert_key', 'platform_security_alerts_claimed_at_idx',
                                  'platform_security_alerts_awaiting_idx', 'platform_security_alerts_open_idx',
                                  'platform_security_alert_changes', 'platform_security_alert_changes_pkey',
                                  'platform_security_alert_changes_changed_at_idx'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'public'::regnamespace
                   and t.typname in ('platform_security_alert_state', '_platform_security_alert_state',
                                     'platform_security_alerts', '_platform_security_alerts',
                                     'platform_security_alert_changes', '_platform_security_alert_changes')) then
    v_bad := v_bad || ' a table, index or type name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('platform_security_alert_inputs', 'platform_security_alert_claim',
                                  'platform_security_alert_result', 'platform_security_alert_heartbeat',
                                  'platform_security_alert_set', 'platform_security_alert_list',
                                  'platform_security_alert_baseline', 'platform_security_alert_purge',
                                  'platform_admin_user_ids')) then
    v_bad := v_bad || ' a function name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p where p.prosrc like '%4800001%') then
    v_bad := v_bad || ' another function already names the advisory lock key 4800001;';
  end if;

  if pg_catalog.to_regclass('public.security_events') is null
     or pg_catalog.to_regclass('public.organizations') is null
     or pg_catalog.to_regclass('public.user_profiles') is null
     or pg_catalog.to_regclass('auth.users') is null then
    v_bad := v_bad || ' public.security_events, public.organizations, public.user_profiles or auth.users is missing;';
  else
    if (select pg_catalog.count(*) from pg_catalog.pg_attribute a
         where a.attnum > 0 and not a.attisdropped
           and ((a.attrelid = 'public.security_events'::regclass
                 and (a.attname, pg_catalog.format_type(a.atttypid, null)) in (
                       ('minute', 'timestamp with time zone'), ('outcome', 'text'),
                       ('source_hash', 'text')))
                or (a.attrelid = 'public.organizations'::regclass
                    and (a.attname, pg_catalog.format_type(a.atttypid, null)) in (
                          ('id', 'uuid'), ('name', 'text')))
                or (a.attrelid = 'public.user_profiles'::regclass
                    and (a.attname, pg_catalog.format_type(a.atttypid, null)) in (
                          ('id', 'uuid'), ('disabled_at', 'timestamp with time zone'),
                          ('deleted_at', 'timestamp with time zone')))
                or (a.attrelid = 'auth.users'::regclass
                    and (a.attname, pg_catalog.format_type(a.atttypid, null)) in (
                          ('id', 'uuid'), ('email', 'character varying'),
                          ('email_confirmed_at', 'timestamp with time zone'),
                          ('banned_until', 'timestamp with time zone'),
                          ('deleted_at', 'timestamp with time zone'),
                          ('is_sso_user', 'boolean'), ('is_anonymous', 'boolean'))))) <> 15 then
      v_bad := v_bad || ' security_events (minute, outcome, source_hash), organizations (id, name), user_profiles (id, disabled_at, deleted_at) or auth.users (id, email, email_confirmed_at, banned_until, deleted_at, is_sso_user, is_anonymous) is not as the functions read it;';
    end if;
    if not pg_catalog.has_table_privilege('public.security_events', 'select')
       or not pg_catalog.has_table_privilege('public.organizations', 'select')
       or not pg_catalog.has_table_privilege('public.user_profiles', 'select')
       or not pg_catalog.has_table_privilege('auth.users', 'select') then
      v_bad := v_bad || ' this role may not read security_events, organizations, user_profiles or auth.users;';
    end if;
    -- Row security: the table's owner reads every row unless it is forced
    -- on the owner too; any other role needs to be exempt from it.
    if not (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user)
       and exists (select 1 from pg_catalog.pg_class c
                    where c.oid in ('public.security_events'::regclass, 'public.organizations'::regclass,
                                    'public.user_profiles'::regclass, 'auth.users'::regclass)
                      and c.relrowsecurity
                      and (c.relforcerowsecurity
                           or c.relowner <> (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user))) then
      v_bad := v_bad || ' row security would hide security_events, organizations, user_profiles or auth.users from this role;';
    end if;
  end if;

  -- The map's two private functions (0478), which the reads call so that
  -- the alerts count exactly as the map does.
  if pg_catalog.to_regprocedure('public._security_map_units(timestamptz, timestamptz, boolean)') is null
     or pg_catalog.to_regprocedure('public._security_map_read_from(timestamptz, timestamptz, integer)') is null then
    v_bad := v_bad || ' 0478''s _security_map_units or _security_map_read_from is missing;';
  elsif pg_catalog.pg_get_function_result('public._security_map_units(timestamptz, timestamptz, boolean)'::regprocedure)
          <> 'TABLE(minute timestamp with time zone, category text, outcome text, reason text, source text, country text, city text, organization_id uuid, organizations integer, events integer, at_least boolean, kind text, late boolean)'
     or pg_catalog.pg_get_function_result('public._security_map_read_from(timestamptz, timestamptz, integer)'::regprocedure)
          <> 'timestamp with time zone' then
    v_bad := v_bad || ' 0478''s _security_map_units or _security_map_read_from does not answer as the reads use it;';
  end if;

  if v_bad <> '' then
    raise exception 'platform_security_alerts_preflight:%', v_bad
      using errcode = '55000', hint = 'platform_security_alerts_preflight';
  end if;
end
$preflight$;

-- ── 1. The state: one row ────────────────────────────────────────────────────
create table public.platform_security_alert_state (
  id                    boolean     primary key default true,
  -- The channels. All off: every alert is recorded only (disposition
  -- record_only) until the owner turns one on.
  email_on              boolean     not null default false,
  push_on               boolean     not null default false,
  summary_on            boolean     not null default false,
  -- The thresholds, by name. Their ranges are checked by
  -- platform_security_alert_set; this table holds them to their names and to
  -- whole numbers.
  thresholds            jsonb       not null default '{
    "aimed_guessing_events": 20,
    "aimed_guessing_minutes": 30,
    "record_trouble_rows": 1,
    "serious_pushes_per_hour": 6,
    "spike_event_floor": 50,
    "spike_learning_days": 14,
    "spike_source_floor": 10,
    "subject_pushes_per_day": 4,
    "volume_pushes_per_day": 8
  }'::jsonb,
  -- A planned check: until this time, volume and record alerts are held
  -- (recorded, not sent). It ends by itself; one ended early keeps the time
  -- it was ended (the next may start 30 minutes after the last one's end).
  planned_check_until   timestamptz,
  -- The baseline (platform_security_alert_baseline): the 99th percentile of
  -- the 10-minute buckets of the window it read, in events and in distinct
  -- sources, the window and whether it was shortened, and when.
  baseline_event_high   integer,
  baseline_source_high  integer,
  baseline_from         timestamptz,
  baseline_to           timestamptz,
  baseline_shortened    boolean,
  baseline_computed_at  timestamptz,
  -- The job's heartbeat (platform_security_alert_heartbeat): the latest run
  -- (its token, when it started and finished, whether it went well and
  -- checked fully), the last run that went well, the runs missed or failed
  -- in a row, whether that has been reported since the last good run, and
  -- when it was last reported.
  last_run_id           uuid,
  last_run_started_at   timestamptz,
  last_run_finished_at  timestamptz,
  last_run_ok           boolean,
  -- The latest run's finish said it could not check fully (its read was
  -- shortened or truncated); null until it finishes or when it did not say.
  last_run_partial      boolean,
  last_ok_at            timestamptz,
  failures_in_a_row     integer     not null default 0,
  failure_reported      boolean     not null default false,
  -- When the failing notice was last asked for (at most once in 6 hours).
  failure_reported_at   timestamptz,
  constraint platform_security_alert_state_one_row check (id),
  -- Exactly the nine names, each a whole number from 0 to 1,000,000.
  constraint platform_security_alert_state_thresholds check (
    pg_catalog.jsonb_typeof(thresholds) = 'object'
    and thresholds ?& array['aimed_guessing_events', 'aimed_guessing_minutes', 'record_trouble_rows',
                            'serious_pushes_per_hour', 'spike_event_floor', 'spike_learning_days',
                            'spike_source_floor', 'subject_pushes_per_day', 'volume_pushes_per_day']
    and (thresholds - array['aimed_guessing_events', 'aimed_guessing_minutes', 'record_trouble_rows',
                            'serious_pushes_per_hour', 'spike_event_floor', 'spike_learning_days',
                            'spike_source_floor', 'subject_pushes_per_day', 'volume_pushes_per_day']) = '{}'::jsonb
    and not pg_catalog.jsonb_path_exists(thresholds,
          '$.* ? (@.type() != "number" || @ < 0 || @ > 1000000 || @.floor() != @)')),
  constraint platform_security_alert_state_baseline check (
    (baseline_computed_at is null and baseline_event_high is null and baseline_source_high is null
     and baseline_from is null and baseline_to is null and baseline_shortened is null)
    or (baseline_computed_at is not null and baseline_event_high >= 0 and baseline_source_high >= 0
        and baseline_from <= baseline_to and baseline_shortened is not null)),
  constraint platform_security_alert_state_heartbeat check (
    failures_in_a_row between 0 and 1000000
    and (last_run_id is null) = (last_run_started_at is null)
    and (last_run_finished_at is null) = (last_run_ok is null)
    and (last_run_finished_at is null or last_run_finished_at >= last_run_started_at))
);

comment on table public.platform_security_alert_state is
  'The security alerts'' one row: the switches (email_on, push_on, summary_on; all false at first, so every alert is recorded only), the thresholds (jsonb, by name, tunable without a release), planned_check_until (volume and record alerts held until then), the stored baseline (7-day 99th-percentile marks of 10-minute buckets, in events and distinct sources) and the alert job''s heartbeat (whether the latest run checked fully; when the failing notice was last asked for). No API role reads or writes it directly: platform_security_alert_set, _heartbeat, _baseline and _list are the way in.';

-- RLS on and no policy, and no table privilege for any API role.
alter table public.platform_security_alert_state enable row level security;
-- Supabase's default privileges have given anon, authenticated and
-- service_role every privilege on a new public table; the change Supabase
-- set for 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE
-- out of them. Everything is revoked from all of them here and nothing is
-- granted back, so each table ends the same under either set of defaults.
revoke all on table public.platform_security_alert_state from public, anon, authenticated, service_role;

-- The one row: every switch off, the default thresholds, no planned check,
-- no baseline, no run yet.
insert into public.platform_security_alert_state (id) values (true);

-- ── 2. The alerts ────────────────────────────────────────────────────────────
create table public.platform_security_alerts (
  id              uuid        primary key default gen_random_uuid(),
  rule            text        not null,
  class           text        not null,
  -- An organization id for aimed_guessing; '' for every other rule (never
  -- null, so the unique key below holds for them too).
  subject         text        not null default '',
  -- From the events, never from the run's clock (the header).
  event_key       text        not null,
  phase           text        not null,
  -- Numbers and reason codes only (platform_security_alert_claim checks the
  -- shape): never an address, an account, a path or a sample.
  counts          jsonb       not null default '{}'::jsonb,
  disposition     text        not null,
  -- The channels the alert was handed out for.
  push_planned    boolean     not null default false,
  email_planned   boolean     not null default false,
  -- The alert used a slot of its class's push budget (counted as if push
  -- were on: the budget is the same with the switch on or off).
  push_counted    boolean     not null default false,
  -- A serious flag's email that went although email alerts were off, and
  -- why: push_budget_spent (push was on and its budget spent: the email
  -- took its place) or push_failed (its push reached no one).
  email_floor     text,
  -- Each channel's result: counts of result codes, never an address.
  push_result     jsonb,
  email_result    jsonb,
  attempts        smallint    not null default 1,
  -- When it was last handed out (a retry moves it), and when its result came.
  claimed_at      timestamptz not null default now(),
  resulted_at     timestamptz,
  -- On a started row of a volume or record rule: when its state ended.
  state_ended_at  timestamptz,
  constraint platform_security_alerts_rule
    check (rule in ('serious_flag', 'aimed_guessing', 'spike', 'record_trouble')),
  constraint platform_security_alerts_class
    check (class = case rule when 'serious_flag' then 'serious' when 'record_trouble' then 'record' else 'volume' end),
  constraint platform_security_alerts_subject
    check (case when rule = 'aimed_guessing'
                then subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                else subject = '' end),
  constraint platform_security_alerts_phase
    check (phase in ('started', 'reminder', 'ended') and (rule <> 'serious_flag' or phase = 'started')),
  constraint platform_security_alerts_event_key
    check (case when rule = 'serious_flag'
                then event_key ~ '^[a-z][a-z0-9_]{0,47}[|][0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00Z$'
                when phase = 'reminder'
                then event_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-5]0Z[+](1h|6h|24h)$'
                else event_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-5]0Z$' end),
  constraint platform_security_alerts_counts
    check (pg_catalog.jsonb_typeof(counts) = 'object' and pg_catalog.octet_length(counts::text) <= 4000),
  constraint platform_security_alerts_disposition
    check (disposition in ('record_only', 'sent', 'held_planned_check', 'email_only_budget', 'held_for_summary',
                           'not_sent')),
  -- What each disposition hands out: sent at least one channel;
  -- email_only_budget email and never push; not_sent what it was handed out
  -- for; record_only, held_planned_check and held_for_summary nothing.
  constraint platform_security_alerts_planned
    check (case disposition
             when 'sent' then push_planned or email_planned
             when 'email_only_budget' then email_planned and not push_planned
             when 'not_sent' then push_planned or email_planned
             else not push_planned and not email_planned end),
  -- An end never pushes and a held alert never does: neither uses a slot.
  constraint platform_security_alerts_push_counted
    check (not push_counted or (phase <> 'ended' and disposition <> 'held_planned_check')),
  -- The email floor is a serious flag's only, on an email it was handed out
  -- for: in place of a push whose budget was spent (no push), or after a
  -- push that reached no one (with its result).
  constraint platform_security_alerts_email_floor
    check (email_floor is null
           or (class = 'serious' and email_planned
               and case email_floor
                     when 'push_budget_spent' then not push_planned and disposition in ('email_only_budget', 'not_sent')
                     when 'push_failed' then push_planned and resulted_at is not null
                     else false end)),
  -- A result is counts of result codes for each channel handed out, and
  -- only for those; a not_sent alert has none.
  constraint platform_security_alerts_results
    check ((push_result is null or (pg_catalog.jsonb_typeof(push_result) = 'object' and push_planned))
           and (email_result is null or (pg_catalog.jsonb_typeof(email_result) = 'object' and email_planned))
           and (resulted_at is null) = (push_result is null and email_result is null)
           and (resulted_at is null or ((push_result is not null) = push_planned
                                        and (email_result is not null) = email_planned
                                        and disposition <> 'not_sent'
                                        and resulted_at >= claimed_at))),
  constraint platform_security_alerts_attempts
    check (attempts between 1 and 2),
  constraint platform_security_alerts_state_ended
    check (state_ended_at is null or (phase = 'started' and rule <> 'serious_flag')),
  -- One row per alert: the idempotency lock of two overlapping runs.
  constraint platform_security_alerts_alert_key unique (rule, subject, event_key, phase)
);

-- The budgets count by claimed_at, the console lists newest first, the purge
-- takes the oldest.
create index platform_security_alerts_claimed_at_idx
  on public.platform_security_alerts (claimed_at);
-- The alerts handed out with no result yet (few): the retries and the sweep.
create index platform_security_alerts_awaiting_idx
  on public.platform_security_alerts (claimed_at)
  where (push_planned or email_planned) and resulted_at is null and disposition in ('sent', 'email_only_budget');
-- The open states (few): a claim's check and the job's read.
create index platform_security_alerts_open_idx
  on public.platform_security_alerts (rule, subject)
  where phase = 'started' and rule <> 'serious_flag' and state_ended_at is null;

comment on table public.platform_security_alerts is
  'Security alerts claimed by the alert job: one row per (rule, subject, event_key, phase), the key from the events, never from the run''s clock. disposition: sent, email_only_budget, record_only, held_planned_check, held_for_summary or not_sent; email_floor says why a serious flag''s email went although email alerts were off. counts holds numbers and reason codes only; push_result and email_result hold counts of result codes, never an address or an account. No API role reads or writes it directly: platform_security_alert_claim, _result, _heartbeat, _purge, _inputs and _list are the way in. Rows claimed more than 400 days ago are removed by platform_security_alert_purge().';

alter table public.platform_security_alerts enable row level security;
revoke all on table public.platform_security_alerts from public, anon, authenticated, service_role;

-- ── 3. The changes ───────────────────────────────────────────────────────────
create table public.platform_security_alert_changes (
  id             uuid        primary key default gen_random_uuid(),
  changed_at     timestamptz not null default now(),
  -- The platform admin who made the change, as the server passes it: a
  -- plain uuid, no foreign key.
  actor_user_id  uuid        not null,
  name           text        not null,
  old_value      jsonb,
  new_value      jsonb,
  constraint platform_security_alert_changes_name
    check (name in ('email_on', 'push_on', 'summary_on', 'planned_check',
                    'aimed_guessing_events', 'aimed_guessing_minutes', 'record_trouble_rows',
                    'serious_pushes_per_hour', 'spike_event_floor', 'spike_learning_days',
                    'spike_source_floor', 'subject_pushes_per_day', 'volume_pushes_per_day')),
  -- A switch from one boolean to the other; a planned check from an end
  -- time (or none) to another; a threshold from one number to another.
  constraint platform_security_alert_changes_values
    check (old_value is distinct from new_value
           and case when name in ('email_on', 'push_on', 'summary_on')
                    then pg_catalog.jsonb_typeof(old_value) = 'boolean' and pg_catalog.jsonb_typeof(new_value) = 'boolean'
                    when name = 'planned_check'
                    then coalesce(pg_catalog.jsonb_typeof(old_value), 'string') = 'string'
                         and coalesce(pg_catalog.jsonb_typeof(new_value), 'string') = 'string'
                    else pg_catalog.jsonb_typeof(old_value) = 'number' and pg_catalog.jsonb_typeof(new_value) = 'number' end)
);

create index platform_security_alert_changes_changed_at_idx
  on public.platform_security_alert_changes (changed_at);

comment on table public.platform_security_alert_changes is
  'Who changed which security alert switch, threshold or planned check, from what to what, and when (actor_user_id as the server passes it; no foreign key). Written only by platform_security_alert_set, in the same transaction as the change; read through platform_security_alert_list. No API role reads or writes it directly.';

alter table public.platform_security_alert_changes enable row level security;
revoke all on table public.platform_security_alert_changes from public, anon, authenticated, service_role;

-- ── 4. What the job reads ────────────────────────────────────────────────────
create function public.platform_security_alert_inputs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set timezone = 'UTC'
as $$
declare
  -- THE BOUNDS AND LISTS OF THE READ. Written here and nowhere else (the
  -- claim keeps its own copy of the serious list, and this file's test holds
  -- the two to the letter).
  -- How far back the record is read, by the event's minute.
  c_window        constant interval    := '8 hours';
  -- The buckets: 10 minutes on the UTC clock (the map's, 0478).
  c_bucket        constant interval    := '10 minutes';
  c_bucket_origin constant timestamptz := '2000-01-01 00:00:00+00';
  -- The most rows of the record one answer reads (the map's ceiling).
  c_max_rows      constant integer     := 400000;
  -- The most organizations listed for the guessing rule (the busiest).
  c_max_organizations constant integer := 100;
  c_max_open      constant integer     := 500;
  -- The most alerts listed due their retry: serious flags on a list of their
  -- own, the others on another, so no number of volume alerts crowds out a
  -- serious flag.
  c_max_retry     constant integer     := 100;
  -- A claim with no result this long after it was handed out is due its
  -- one retry.
  c_retry_after   constant interval    := '5 minutes';
  -- The serious flags (design 4, rule "serious flag").
  c_serious_reasons constant text[] := array['passkey_counter_went_back', 'passkey_unexplained_sign_in',
                                             'sign_in_not_me', 'unrecorded_server_form_password',
                                             'unrecorded_server_form_code'];
  -- The four guessing reasons counted for one organization.
  c_aimed_reasons constant text[] := array['repeated_wrong_password', 'repeated_wrong_code',
                                           'sign_in_paused', 'code_checks_paused'];
  -- The rows that say the record itself is flooding.
  c_trouble_reasons constant text[] := array['over_minute_cap', 'over_buffer_cap'];
  v_now         timestamptz := pg_catalog.now();
  v_to          timestamptz;
  v_asked_from  timestamptz;
  v_from        timestamptz;
  v_state       public.platform_security_alert_state;
  v_result      jsonb;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  select s.* into v_state from public.platform_security_alert_state s where s.id;
  if not found then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'no_state', 'generated_at', v_now);
  end if;

  -- The window: from the first whole bucket that starts within the last 8
  -- hours, up to a minute after now (the record takes an event up to a
  -- minute ahead). A row is in it when its minute starts at or after the
  -- start and before the end.
  v_to         := v_now + interval '1 minute';
  v_asked_from := pg_catalog.date_bin(c_bucket, v_now - c_window, c_bucket_origin) + c_bucket;
  -- The row ceiling (0478's walk): the window asked for, or the earliest
  -- later start on a whole minute that keeps it to the ceiling.
  v_from := public._security_map_read_from(v_asked_from, v_to, c_max_rows);
  if v_from >= v_to then
    return pg_catalog.jsonb_build_object('window', null, 'refused', 'too_many_events_in_one_minute',
                                         'generated_at', v_now);
  end if;

  with u as materialized (
    select x.minute, x.outcome, x.reason, x.organization_id, x.events, x.at_least, x.kind,
           pg_catalog.date_bin(c_bucket, x.minute, c_bucket_origin) as bucket,
           pg_catalog.date_trunc('hour', x.minute, 'UTC') as hour
      from public._security_map_units(v_from, v_to, false) x
  ),
  -- A serious flag: one entry per reason and UTC hour, across every
  -- organization; and a flood row whose outcome is flagged, per reason and
  -- hour (something was flagged during a flood and its kind could not be
  -- listed).
  serious as (
    select u.reason, u.hour, false as flagged_in_flood,
           pg_catalog.sum(u.events)::bigint as events,
           pg_catalog.bool_or(u.at_least) as at_least,
           pg_catalog.bool_or(u.kind = 'tally') as tally,
           pg_catalog.min(u.minute) as first_minute, pg_catalog.max(u.minute) as last_minute
      from u
     where u.reason = any (c_serious_reasons)
     group by u.reason, u.hour
    union all
    select u.reason, u.hour, true,
           pg_catalog.sum(u.events)::bigint, false, false,
           pg_catalog.min(u.minute), pg_catalog.max(u.minute)
      from u
     where u.kind = 'flood' and u.outcome = 'flagged'
     group by u.reason, u.hour
  ),
  -- The guessing reasons, per organization and bucket; the busiest
  -- organizations first.
  aimed_cells as (
    select u.organization_id, u.bucket, pg_catalog.sum(u.events)::bigint as events
      from u
     where u.reason = any (c_aimed_reasons) and u.organization_id is not null
     group by u.organization_id, u.bucket
  ),
  aimed_orgs as (
    select a.organization_id, pg_catalog.sum(a.events)::bigint as events,
           pg_catalog.row_number() over (order by pg_catalog.sum(a.events) desc, a.organization_id) as rn
      from aimed_cells a
     group by a.organization_id
  ),
  -- Every bucket of the window read, empty ones too: the counted events
  -- that were blocked or flagged (no tally), and the flood rows of the
  -- record itself.
  slots as (
    select g as bucket
      from pg_catalog.generate_series(pg_catalog.date_bin(c_bucket, v_from, c_bucket_origin),
                                      pg_catalog.date_bin(c_bucket, v_now, c_bucket_origin), c_bucket) g
  ),
  per_bucket as (
    select u.bucket,
           coalesce(pg_catalog.sum(u.events) filter (where u.kind <> 'tally' and u.outcome in ('blocked', 'flagged')), 0)::bigint as events,
           pg_catalog.count(*) filter (where u.reason = any (c_trouble_reasons)) as trouble_rows,
           coalesce(pg_catalog.sum(u.events) filter (where u.reason = any (c_trouble_reasons)), 0)::bigint as trouble_events
      from u
     group by u.bucket
  ),
  -- Distinct sources a bucket (a count; the hash never leaves this read).
  sources as (
    select pg_catalog.date_bin(c_bucket, s.minute, c_bucket_origin) as bucket,
           pg_catalog.count(distinct s.source_hash) as sources
      from public.security_events s
     where s.minute >= v_from and s.minute < v_to
       and s.source_hash is not null and s.outcome in ('blocked', 'flagged')
     group by 1
  ),
  open_states as (
    select a.rule, a.subject, a.event_key, a.claimed_at, a.disposition,
           pg_catalog.row_number() over (order by a.claimed_at, a.rule, a.subject) as rn
      from public.platform_security_alerts a
     where a.phase = 'started' and a.rule <> 'serious_flag' and a.state_ended_at is null
  ),
  retry_due as (
    select a.class = 'serious' as serious, a.rule, a.subject, a.event_key, a.phase, a.claimed_at,
           pg_catalog.row_number() over (partition by a.class = 'serious' order by a.claimed_at, a.id) as rn
      from public.platform_security_alerts a
     where (a.push_planned or a.email_planned) and a.resulted_at is null
       and a.disposition in ('sent', 'email_only_budget')
       and a.attempts = 1 and a.claimed_at <= v_now - c_retry_after
  )
  select pg_catalog.jsonb_build_object(
    'serious',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'reason', s.reason,
                         'hour', s.hour,
                         'event_key', s.reason || '|' || pg_catalog.to_char(s.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00Z"'),
                         'flagged_in_flood', s.flagged_in_flood,
                         'events', s.events,
                         'at_least', s.at_least,
                         'tally', s.tally,
                         'first_minute', s.first_minute,
                         'last_minute', s.last_minute)
                       order by s.hour, s.flagged_in_flood, s.reason collate "C")
                  from serious s), pg_catalog.jsonb_build_array()),
    'aimed',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'organization_id', o.organization_id,
                         'events', o.events,
                         'buckets', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                              'bucket_start', c.bucket,
                                              'bucket_key', pg_catalog.to_char(c.bucket at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
                                              'events', c.events) order by c.bucket)
                                       from aimed_cells c where c.organization_id = o.organization_id))
                       order by o.rn)
                  from aimed_orgs o where o.rn <= c_max_organizations), pg_catalog.jsonb_build_array()),
    'aimed_truncated', (select pg_catalog.count(*) from aimed_orgs) > c_max_organizations,
    'buckets',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'bucket_start', sl.bucket,
                         'bucket_key', pg_catalog.to_char(sl.bucket at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
                         'partial', sl.bucket < v_from or sl.bucket + c_bucket > v_now,
                         'events', coalesce(b.events, 0),
                         'sources', coalesce(src.sources, 0),
                         'trouble_rows', coalesce(b.trouble_rows, 0),
                         'trouble_events', coalesce(b.trouble_events, 0))
                       order by sl.bucket)
                  from slots sl
                  left join per_bucket b on b.bucket = sl.bucket
                  left join sources src on src.bucket = sl.bucket), pg_catalog.jsonb_build_array()),
    'open_states',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'rule', o.rule,
                         'subject', o.subject,
                         'event_key', o.event_key,
                         'started_claimed_at', o.claimed_at,
                         'held', o.disposition = 'held_planned_check',
                         'reminders', coalesce((select pg_catalog.jsonb_agg(pg_catalog.substr(r.event_key, pg_catalog.length(o.event_key) + 2)
                                                                            order by r.claimed_at, r.event_key)
                                                  from public.platform_security_alerts r
                                                 where r.rule = o.rule and r.subject = o.subject and r.phase = 'reminder'
                                                   and r.event_key in (o.event_key || '+1h', o.event_key || '+6h', o.event_key || '+24h')),
                                               pg_catalog.jsonb_build_array()))
                       order by o.rn)
                  from open_states o where o.rn <= c_max_open), pg_catalog.jsonb_build_array()),
    'open_states_truncated', (select pg_catalog.count(*) from open_states) > c_max_open,
    'serious_retry_due',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'rule', r.rule, 'subject', r.subject, 'event_key', r.event_key, 'phase', r.phase,
                         'claimed_at', r.claimed_at)
                       order by r.rn)
                  from retry_due r where r.serious and r.rn <= c_max_retry), pg_catalog.jsonb_build_array()),
    'serious_retry_due_truncated', (select pg_catalog.count(*) from retry_due r where r.serious) > c_max_retry,
    'retry_due',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'rule', r.rule, 'subject', r.subject, 'event_key', r.event_key, 'phase', r.phase,
                         'claimed_at', r.claimed_at)
                       order by r.rn)
                  from retry_due r where not r.serious and r.rn <= c_max_retry), pg_catalog.jsonb_build_array()),
    'retry_due_truncated', (select pg_catalog.count(*) from retry_due r where not r.serious) > c_max_retry)
    into v_result;

  return v_result || pg_catalog.jsonb_build_object(
    'window', pg_catalog.jsonb_build_object('from', v_from, 'to', v_to, 'asked_from', v_asked_from),
    'shortened', v_from > v_asked_from,
    'refused', null,
    'generated_at', v_now,
    'bucket_seconds', 600,
    'oldest_event_at', (select pg_catalog.min(s.minute) from public.security_events s),
    'thresholds', v_state.thresholds,
    -- The marks with their floors: the stored highs, or the floors when
    -- higher (or when there is no baseline yet).
    'baseline', pg_catalog.jsonb_build_object(
      'event_high', v_state.baseline_event_high,
      'source_high', v_state.baseline_source_high,
      'event_mark', greatest(coalesce(v_state.baseline_event_high, 0), (v_state.thresholds ->> 'spike_event_floor')::integer),
      'source_mark', greatest(coalesce(v_state.baseline_source_high, 0), (v_state.thresholds ->> 'spike_source_floor')::integer),
      'from', v_state.baseline_from,
      'to', v_state.baseline_to,
      'shortened', v_state.baseline_shortened,
      'computed_at', v_state.baseline_computed_at),
    'switches', pg_catalog.jsonb_build_object('email_on', v_state.email_on, 'push_on', v_state.push_on,
                                              'summary_on', v_state.summary_on),
    'planned_check_until', case when v_state.planned_check_until > v_now then v_state.planned_check_until end);
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
revoke all on function public.platform_security_alert_inputs() from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_inputs() to service_role;

comment on function public.platform_security_alert_inputs() is
  'What the security alert job reads. Of public.security_events, the rows whose minute starts at or after the first whole 10-minute bucket within the last 8 hours and before a minute after now, at most 400,000 (else read from the earliest later whole minute that keeps it so: shortened), counted by _security_map_units (0478): serious (per reason and UTC hour, across organizations, with its event_key; and the flood rows whose outcome is flagged), aimed (the four guessing reasons per organization and 10-minute bucket, the 100 busiest organizations), buckets (every 10-minute bucket of the window read: counted blocked and flagged events, distinct sources as a count, flood rows of over_minute_cap and over_buffer_cap). Of the alerts: open_states (at most 500); the alerts due their one retry, serious_retry_due (serious flags, at most 100) and retry_due (the others, at most 100), each with its own _truncated. The thresholds, the baseline marks with their floors, the switches, planned_check_until while on, oldest_event_at. Never a source hash, a path, an address or a row key. Never raises for the record''s contents: no_state and too_many_events_in_one_minute are answered as refused. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 5. The claim ─────────────────────────────────────────────────────────────
create function public.platform_security_alert_claim(
  p_rule      text,
  p_subject   text,
  p_event_key text,
  p_phase     text,
  p_counts    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set timezone = 'UTC'
as $$
declare
  -- THE RULES OF A CLAIM. Written here and nowhere else.
  -- The serious flags, as platform_security_alert_inputs lists them, and the
  -- flood reasons (0478's), whose flagged rows are serious flags too.
  c_serious_reasons constant text[] := array['passkey_counter_went_back', 'passkey_unexplained_sign_in',
                                             'sign_in_not_me', 'unrecorded_server_form_password',
                                             'unrecorded_server_form_code'];
  c_flood_reasons   constant text[] := array['over_minute_cap', 'over_buffer_cap', 'auth_log_over_cap'];
  -- How far back a key may lie when it is first claimed (the read's window).
  c_window          constant interval    := '8 hours';
  c_bucket          constant interval    := '10 minutes';
  c_bucket_origin   constant timestamptz := '2000-01-01 00:00:00+00';
  -- A claim with no result this long after it was handed out is handed out
  -- once more; after the second, it is not_sent.
  c_retry_after     constant interval    := '5 minutes';
  -- The windows of the push budgets: serious flags by the hour (and by the
  -- day for one reason), volume and record by the day.
  c_serious_window  constant interval    := '1 hour';
  c_volume_window   constant interval    := '24 hours';
  c_day             constant interval    := '24 hours';
  -- Volume and record emails a day, together; past it they are held for the
  -- daily summary. A serious flag's email is never held.
  c_volume_emails_per_day constant integer := 24;
  -- The shape of counts.
  c_counts_chars    constant integer     := 4000;
  c_counts_keys     constant integer     := 40;
  c_counts_items    constant integer     := 50;
  v_now        timestamptz := pg_catalog.now();
  v_answer     jsonb := pg_catalog.jsonb_build_object('outcome', 'refused', 'refused', null, 'id', null,
                                                      'disposition', null, 'push', false, 'email', false,
                                                      'attempt', null, 'open_key', null);
  v_class      text;
  v_subject    text;
  v_m          text[];
  v_at         timestamptz;
  v_step       interval;
  v_base_key   text;
  v_counts     jsonb;
  v_k          text;
  v_v          jsonb;
  v_e          jsonb;
  v_bad        boolean := false;
  v_out_of_window boolean := false;
  v_state      public.platform_security_alert_state;
  v_row        public.platform_security_alerts;
  v_open       public.platform_security_alerts;
  v_held       boolean;
  v_room       boolean;
  v_disp       text;
  v_push       boolean;
  v_email      boolean;
  v_floor      text;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  -- ── The arguments. Each is tested before it is used; none makes this
  -- raise. A refusal names the argument's kind, never its value.
  if p_rule is null or p_rule not in ('serious_flag', 'aimed_guessing', 'spike', 'record_trouble') then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_rule');
  end if;
  v_class := case p_rule when 'serious_flag' then 'serious' when 'record_trouble' then 'record' else 'volume' end;

  if p_phase is null or p_phase not in ('started', 'reminder', 'ended')
     or (p_rule = 'serious_flag' and p_phase <> 'started') then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_phase');
  end if;

  -- The subject: an organization id for aimed_guessing (in either case, the
  -- same alert); none ('' or null, the same alert) for every other rule.
  v_subject := coalesce(p_subject, '');
  if p_rule = 'aimed_guessing' then
    v_subject := pg_catalog.lower(v_subject);
    if v_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_subject');
    end if;
  elsif v_subject <> '' then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_subject');
  end if;

  -- The key, from the events. Its time is read back and written again, so a
  -- key is one spelling of one time (no '24:00', no day that is not one).
  if p_event_key is null or pg_catalog.char_length(p_event_key) > 80 then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_key');
  end if;
  if p_rule = 'serious_flag' then
    v_m := pg_catalog.regexp_match(p_event_key, '^([a-z][a-z0-9_]{0,47})[|]([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}):00Z$');
    if v_m is null or not (v_m[1] = any (c_serious_reasons) or v_m[1] = any (c_flood_reasons)) then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_key');
    end if;
    begin
      v_at := (v_m[2] || ':00:00+00')::timestamptz;
    exception when others then
      v_at := null;
    end;
    if v_at is null or pg_catalog.to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24') <> v_m[2] then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_key');
    end if;
    -- Answered after the lookup below: a row claimed before is answered by
    -- its row whatever the age of its key.
    if v_at < pg_catalog.date_trunc('hour', v_now - c_window, 'UTC')
       or v_at > pg_catalog.date_trunc('hour', v_now + interval '1 minute', 'UTC') then
      v_out_of_window := true;
    end if;
  else
    v_m := pg_catalog.regexp_match(p_event_key, '^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-5]0)Z(?:[+](1h|6h|24h))?$');
    if v_m is null or (p_phase = 'reminder') <> (v_m[2] is not null) then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_key');
    end if;
    begin
      v_at := (v_m[1] || ':00+00')::timestamptz;
    exception when others then
      v_at := null;
    end;
    if v_at is null or pg_catalog.to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') <> v_m[1] then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_key');
    end if;
    v_base_key := v_m[1] || 'Z';
    v_step := case v_m[2] when '1h' then interval '1 hour' when '6h' then interval '6 hours'
                          when '24h' then interval '24 hours' end;
    if v_at > v_now + interval '1 minute'
       or (p_phase = 'started' and v_at < pg_catalog.date_bin(c_bucket, v_now - c_window, c_bucket_origin)) then
      v_out_of_window := true;
    end if;
  end if;

  -- counts: an object of at most 40 keys and 4,000 characters; each key a
  -- reason-code word; each value a whole number (0 to 13 digits), a boolean,
  -- a reason-code word, a list of at most 50 of those, or an object of at
  -- most 50 reason-code words or country codes to whole numbers.
  v_counts := coalesce(p_counts, '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_counts) <> 'object' or pg_catalog.octet_length(v_counts::text) > c_counts_chars then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_counts');
  end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_counts)) > c_counts_keys then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_counts');
  end if;
  for v_k, v_v in select e.key, e.value from pg_catalog.jsonb_each(v_counts) e loop
    if v_k !~ '^[a-z][a-z0-9_]{0,47}$' then
      v_bad := true;
    elsif pg_catalog.jsonb_typeof(v_v) = 'number' then
      v_bad := (v_v #>> '{}') !~ '^[0-9]{1,13}$';
    elsif pg_catalog.jsonb_typeof(v_v) = 'boolean' then
      v_bad := false;
    elsif pg_catalog.jsonb_typeof(v_v) = 'string' then
      v_bad := (v_v #>> '{}') !~ '^[a-z][a-z0-9_]{0,47}$';
    elsif pg_catalog.jsonb_typeof(v_v) = 'array' then
      v_bad := pg_catalog.jsonb_array_length(v_v) > c_counts_items
               or exists (select 1 from pg_catalog.jsonb_array_elements(v_v) a(x)
                           where not ((pg_catalog.jsonb_typeof(a.x) = 'number' and (a.x #>> '{}') ~ '^[0-9]{1,13}$')
                                      or (pg_catalog.jsonb_typeof(a.x) = 'string' and (a.x #>> '{}') ~ '^[a-z][a-z0-9_]{0,47}$')));
    elsif pg_catalog.jsonb_typeof(v_v) = 'object' then
      v_bad := (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_v)) > c_counts_items
               or exists (select 1 from pg_catalog.jsonb_each(v_v) o
                           where not ((o.key ~ '^[a-z][a-z0-9_]{0,47}$' or o.key ~ '^[A-Z]{2}$')
                                      and pg_catalog.jsonb_typeof(o.value) = 'number'
                                      and (o.value #>> '{}') ~ '^[0-9]{1,13}$'));
    else
      v_bad := true;
    end if;
    if v_bad then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_counts');
    end if;
  end loop;

  -- ── One claim at a time (result, heartbeat, set and purge take the same
  -- lock), so the novelty, the open state and the budgets below are counted
  -- exactly. Its own key: never the security events' or the samples'
  -- (their writers do not wait on it). A call that waits 2 s for its turn ends with 55P03
  -- (the function's lock_timeout).
  perform pg_catalog.pg_advisory_xact_lock(4800001);

  select s.* into v_state from public.platform_security_alert_state s where s.id;
  if not found then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'no_state');
  end if;

  -- ── This alert, claimed before? Another run's claim of it is never sent
  -- again, except once, 5 minutes after it was handed out with no result
  -- (the run that had it may have died); the second time it is not_sent.
  -- Looked up before the key's age is judged, so a serious flag's one retry
  -- is taken after its hour has left the read's window.
  select a.* into v_row
    from public.platform_security_alerts a
   where a.rule = p_rule and a.subject = v_subject and a.event_key = p_event_key and a.phase = p_phase;
  if found then
    if (v_row.push_planned or v_row.email_planned) and v_row.resulted_at is null
       and v_row.disposition in ('sent', 'email_only_budget') and v_row.claimed_at <= v_now - c_retry_after then
      if v_row.attempts = 1 then
        update public.platform_security_alerts a set attempts = 2, claimed_at = v_now where a.id = v_row.id;
        -- What the first claim planned, whatever a switch says now.
        return v_answer || pg_catalog.jsonb_build_object(
          'outcome', 'retry', 'id', v_row.id, 'disposition', v_row.disposition,
          'push', v_row.push_planned, 'email', v_row.email_planned, 'attempt', 2);
      end if;
      update public.platform_security_alerts a set disposition = 'not_sent' where a.id = v_row.id;
      return v_answer || pg_catalog.jsonb_build_object(
        'outcome', 'not_sent', 'id', v_row.id, 'disposition', 'not_sent', 'attempt', v_row.attempts);
    end if;
    -- A start with the key of a state that has ended is the condition back,
    -- not the alert already sent: refused in a word of its own, so the job
    -- opens the new state with a newer key.
    if v_row.phase = 'started' and v_row.rule <> 'serious_flag' and v_row.state_ended_at is not null then
      return v_answer || pg_catalog.jsonb_build_object(
        'refused', 'state_ended',
        'open_key', (select a.event_key from public.platform_security_alerts a
                      where a.rule = p_rule and a.subject = v_subject and a.phase = 'started'
                        and a.state_ended_at is null
                      order by a.claimed_at desc
                      limit 1));
    end if;
    return v_answer || pg_catalog.jsonb_build_object(
      'outcome', 'duplicate', 'id', v_row.id, 'disposition', v_row.disposition, 'attempt', v_row.attempts);
  end if;
  if v_out_of_window then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'key_out_of_window');
  end if;

  -- ── A state: one open at a time for a rule and subject; a reminder or an
  -- end only of the open one; a reminder only once its step has passed.
  if p_rule <> 'serious_flag' then
    select a.* into v_open
      from public.platform_security_alerts a
     where a.rule = p_rule and a.subject = v_subject and a.phase = 'started'
       and a.state_ended_at is null
     order by a.claimed_at desc
     limit 1;
    if p_phase = 'started' then
      if found then
        return v_answer || pg_catalog.jsonb_build_object('refused', 'already_open', 'open_key', v_open.event_key);
      end if;
    else
      if v_open.id is null or v_open.event_key <> v_base_key then
        if exists (select 1 from public.platform_security_alerts a
                    where a.rule = p_rule and a.subject = v_subject and a.event_key = v_base_key
                      and a.phase = 'started') then
          return v_answer || pg_catalog.jsonb_build_object('refused', 'state_ended', 'open_key', v_open.event_key);
        end if;
        return v_answer || pg_catalog.jsonb_build_object('refused', 'no_open_state', 'open_key', v_open.event_key);
      end if;
      if p_phase = 'reminder' and v_at + v_step > v_now + interval '1 minute' then
        return v_answer || pg_catalog.jsonb_build_object('refused', 'reminder_not_due', 'open_key', v_open.event_key);
      end if;
    end if;
  end if;

  -- ── What is sent.
  -- A planned check holds volume and record alerts, never a serious one; and
  -- the end of a state none of whose alerts went out is held as they were.
  v_held := v_class <> 'serious' and v_state.planned_check_until is not null and v_now < v_state.planned_check_until;
  if not v_held and p_phase = 'ended' then
    v_held := not exists (select 1 from public.platform_security_alerts a
                           where a.rule = p_rule and a.subject = v_subject
                             and ((a.phase = 'started' and a.event_key = v_base_key)
                                  or (a.phase = 'reminder'
                                      and a.event_key in (v_base_key || '+1h', v_base_key || '+6h', v_base_key || '+24h')))
                             and a.disposition <> 'held_planned_check');
  end if;

  if v_held then
    v_disp  := 'held_planned_check';
    v_room  := false;
    v_push  := false;
    v_email := false;
  else
    -- The push budgets, counted over the alerts that used a slot, switch on
    -- or off. Serious: its own, per hour, and per day for one reason (its
    -- key is the reason and the event's hour, so a reason that lasts is a
    -- new alert every hour); no volume or record alert can spend it. Volume
    -- and record: one per day for both, and one per day for one rule and
    -- subject. An end never pushes.
    if p_phase = 'ended' then
      v_room := false;
    elsif v_class = 'serious' then
      v_room := (select pg_catalog.count(*) from public.platform_security_alerts a
                  where a.class = 'serious' and a.push_counted and a.claimed_at > v_now - c_serious_window)
                < (v_state.thresholds ->> 'serious_pushes_per_hour')::integer
                and (select pg_catalog.count(*) from public.platform_security_alerts a
                      where a.rule = 'serious_flag' and a.push_counted
                        and pg_catalog.split_part(a.event_key, '|', 1) = v_m[1]
                        and a.claimed_at > v_now - c_day)
                    < (v_state.thresholds ->> 'subject_pushes_per_day')::integer;
    else
      v_room := (select pg_catalog.count(*) from public.platform_security_alerts a
                  where a.class in ('volume', 'record') and a.push_counted and a.claimed_at > v_now - c_volume_window)
                < (v_state.thresholds ->> 'volume_pushes_per_day')::integer
                and (select pg_catalog.count(*) from public.platform_security_alerts a
                      where a.rule = p_rule and a.subject = v_subject and a.push_counted
                        and a.claimed_at > v_now - c_volume_window)
                    < (v_state.thresholds ->> 'subject_pushes_per_day')::integer;
    end if;
    -- The channels. Push: when it is on and there is a slot. Email: when it
    -- is on; for a serious flag also when push is on and has no slot (email
    -- is a serious flag's floor, never refused: the row says why it went);
    -- for volume and record only while the day has fewer than 24 of their
    -- emails, then they are held for the daily summary.
    v_push := v_state.push_on and v_room;
    if v_class = 'serious' then
      v_email := v_state.email_on or (v_state.push_on and not v_room);
      v_floor := case when v_email and not v_state.email_on then 'push_budget_spent' end;
    else
      v_email := v_state.email_on
                 and (select pg_catalog.count(*) from public.platform_security_alerts a
                       where a.class in ('volume', 'record') and a.email_planned and a.claimed_at > v_now - c_day)
                     < c_volume_emails_per_day;
    end if;
    -- Sent, on the channels above; email_only_budget when push was on and
    -- had no slot (an end never pushes: it is simply sent). Nothing to send:
    -- held for the summary when email is on (its day's emails spent), else
    -- recorded only.
    if v_push or v_email then
      v_disp := case when not v_push and v_state.push_on and p_phase <> 'ended' then 'email_only_budget' else 'sent' end;
    elsif v_state.email_on then
      v_disp := 'held_for_summary';
    else
      v_disp := 'record_only';
    end if;
  end if;

  insert into public.platform_security_alerts as a
    (rule, class, subject, event_key, phase, counts, disposition, push_planned, email_planned, push_counted,
     email_floor, attempts, claimed_at)
  values
    (p_rule, v_class, v_subject, p_event_key, p_phase, v_counts, v_disp, v_push, v_email, v_room,
     v_floor, 1, v_now)
  -- The lookup above found no row and this call holds the one lock, so this
  -- inserts; ON CONFLICT only keeps it from raising if that ever stopped
  -- being true.
  on conflict on constraint platform_security_alerts_alert_key do nothing
  returning a.* into v_row;
  if v_row.id is null then
    return v_answer || pg_catalog.jsonb_build_object('outcome', 'duplicate');
  end if;

  if p_phase = 'ended' then
    update public.platform_security_alerts a set state_ended_at = v_now where a.id = v_open.id;
  end if;

  return v_answer || pg_catalog.jsonb_build_object(
    'outcome', 'new', 'id', v_row.id, 'disposition', v_disp, 'push', v_push, 'email', v_email, 'attempt', 1);
end;
$$;

revoke all on function public.platform_security_alert_claim(text, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_claim(text, text, text, text, jsonb) to service_role;

comment on function public.platform_security_alert_claim(text, text, text, text, jsonb) is
  'Claims one security alert (rule, subject, event_key, phase; counts of numbers and reason codes) under its own advisory lock (4800001; a wait of 2 s ends with 55P03), in one transaction. Answers {outcome, refused, id, disposition, push, email, attempt, open_key}: outcome new (inserted; send on the channels push and email say), retry (claimed 5 minutes ago or more with no result: handed out once more, attempt 2), duplicate (claimed already: send nothing), not_sent (its retry had no result either: marked not_sent), refused (with a fixed word: not_a_rule, not_a_phase, not_a_subject, not_a_key, key_out_of_window, not_counts, no_state, already_open, state_ended, no_open_state, reminder_not_due). A row claimed before is answered by its row whatever the age of its key; a start with the key of a state that has ended is refused state_ended. Serious flags: 6 pushes an hour of their own and 4 a day for one reason (subject_pushes_per_day), then by email, also with email alerts off (email_floor push_budget_spent); a planned check never holds them. Volume and record: 8 pushes a day together and 4 for one rule and subject, then email only; 24 emails a day together, then held_for_summary; an end never pushes; a planned check holds them. Both switches off: record_only, still inserted. Never raises for an argument. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 6. The result ────────────────────────────────────────────────────────────
create function public.platform_security_alert_result(
  p_id           uuid,
  p_attempt      integer,
  p_push_result  jsonb default null,
  p_email_result jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set timezone = 'UTC'
as $$
declare
  v_now    timestamptz := pg_catalog.now();
  v_answer jsonb := pg_catalog.jsonb_build_object('recorded', false, 'refused', null);
  v_row    public.platform_security_alerts;
  v_floor  boolean;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  if p_id is null then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_an_alert');
  end if;
  -- A result: an object of one to six result codes, each a count of
  -- recipients from 0 to 100. Push: sent, failed, timeout, no_account,
  -- no_phone, skipped. Email: sent, failed, timeout, skipped.
  if (p_push_result is not null
      and (pg_catalog.jsonb_typeof(p_push_result) <> 'object' or p_push_result = '{}'::jsonb
           or exists (select 1 from pg_catalog.jsonb_each(p_push_result) e
                       where e.key not in ('sent', 'failed', 'timeout', 'no_account', 'no_phone', 'skipped')
                          or pg_catalog.jsonb_typeof(e.value) <> 'number'
                          or (e.value #>> '{}') !~ '^[0-9]{1,3}$' or (e.value #>> '{}')::integer > 100)))
     or (p_email_result is not null
         and (pg_catalog.jsonb_typeof(p_email_result) <> 'object' or p_email_result = '{}'::jsonb
              or exists (select 1 from pg_catalog.jsonb_each(p_email_result) e
                          where e.key not in ('sent', 'failed', 'timeout', 'skipped')
                             or pg_catalog.jsonb_typeof(e.value) <> 'number'
                             or (e.value #>> '{}') !~ '^[0-9]{1,3}$' or (e.value #>> '{}')::integer > 100))) then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_result');
  end if;

  -- The claim's lock: a result and a claim (its retry, its not_sent) never
  -- cross.
  perform pg_catalog.pg_advisory_xact_lock(4800001);

  select a.* into v_row from public.platform_security_alerts a where a.id = p_id;
  if not found then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_an_alert');
  end if;
  if v_row.disposition = 'not_sent' then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_sent_already');
  end if;
  if not (v_row.push_planned or v_row.email_planned) then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'nothing_to_record');
  end if;
  if v_row.resulted_at is not null then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'already_recorded');
  end if;
  if p_attempt is distinct from v_row.attempts::integer then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_this_attempt');
  end if;
  -- Email is a serious flag's floor: one handed out by push alone whose
  -- push reached no one (no sent count above 0) is owed its email, whatever
  -- the email switch says. Its result is taken only with the email's.
  v_floor := v_row.class = 'serious' and v_row.push_planned and not v_row.email_planned
             and p_push_result is not null and coalesce((p_push_result ->> 'sent')::integer, 0) = 0;
  if v_floor and p_email_result is null then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'email_floor_due');
  end if;
  -- A result for each channel the alert was handed out for, and none for
  -- another (but the floor's email).
  if (p_push_result is not null) <> v_row.push_planned
     or ((p_email_result is not null) <> v_row.email_planned and not v_floor) then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_its_channels');
  end if;

  update public.platform_security_alerts a
     set push_result = p_push_result, email_result = p_email_result, resulted_at = v_now,
         email_planned = a.email_planned or v_floor,
         email_floor = case when v_floor then 'push_failed' else a.email_floor end
   where a.id = v_row.id;

  return pg_catalog.jsonb_build_object('recorded', true, 'refused', null);
end;
$$;

revoke all on function public.platform_security_alert_result(uuid, integer, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_result(uuid, integer, jsonb, jsonb) to service_role;

comment on function public.platform_security_alert_result(uuid, integer, jsonb, jsonb) is
  'Records the result of a claimed security alert: p_attempt as the claim answered it, and for each channel the alert was handed out for (and only those) an object of result codes to counts of recipients, 0 to 100 (push: sent, failed, timeout, no_account, no_phone, skipped; email: sent, failed, timeout, skipped). Under the claim''s advisory lock (4800001; a wait of 2 s ends with 55P03). A serious flag handed out by push alone whose push reached no one (no sent count above 0) is owed its email whatever the email switch says: its push result alone is refused email_floor_due, and with the email''s result both are recorded and email_floor is push_failed. Answers {recorded, refused}: refused not_an_alert, not_a_result, not_sent_already, nothing_to_record, already_recorded, not_this_attempt, email_floor_due or not_its_channels. Never raises for an argument. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 7. The heartbeat ─────────────────────────────────────────────────────────
create function public.platform_security_alert_heartbeat(
  p_step    text,
  p_run_id  uuid    default null,
  p_ok      boolean default null,
  p_partial boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set timezone = 'UTC'
as $$
declare
  -- The job runs every 10 minutes.
  c_tick          constant interval := '10 minutes';
  -- This many runs missed or failed in a row are reported, once until a run
  -- goes well, and never again within 6 hours of the last report.
  c_report_at     constant integer  := 3;
  c_report_gap    constant interval := '6 hours';
  -- A claim handed out a second time with no result this long after: not
  -- sent. One never handed out again (its retry never taken) this long
  -- after its first: not sent; a serious flag only after the 8 hours the
  -- job reads and a margin, so its one retry is offered by the first run
  -- that gets past its read, however late.
  c_retry_after   constant interval := '5 minutes';
  c_abandon_after constant interval := '30 minutes';
  c_serious_abandon_after constant interval := '10 hours';
  v_now      timestamptz := pg_catalog.now();
  v_state    public.platform_security_alert_state;
  v_missed   integer := 0;
  v_failures integer;
  v_report   boolean;
  v_swept    integer;
  v_run      uuid;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  if p_step is null or p_step not in ('start', 'finish') then
    return pg_catalog.jsonb_build_object('step', null, 'refused', 'not_a_step');
  end if;
  if p_step = 'finish' and (p_run_id is null or p_ok is null) then
    return pg_catalog.jsonb_build_object('step', 'finish', 'refused', 'not_a_finish');
  end if;

  -- The claim's lock.
  perform pg_catalog.pg_advisory_xact_lock(4800001);

  select s.* into v_state from public.platform_security_alert_state s where s.id for update;
  if not found then
    return pg_catalog.jsonb_build_object('step', p_step, 'refused', 'no_state');
  end if;

  if p_step = 'start' then
    -- Runs missed since the last start, by the time between (a tick is 10
    -- minutes, give or take); and the last run, when it never finished.
    if v_state.last_run_started_at is not null then
      v_missed := greatest(least(pg_catalog.round(extract(epoch from (v_now - v_state.last_run_started_at))
                                                  / extract(epoch from c_tick)), 1000001)::integer - 1, 0);
    end if;
    v_failures := least(v_state.failures_in_a_row::bigint + v_missed
                        + case when v_state.last_run_started_at is not null and v_state.last_run_finished_at is null
                               then 1 else 0 end, 1000000)::integer;
    v_report := v_failures >= c_report_at and not v_state.failure_reported
                and (v_state.failure_reported_at is null or v_state.failure_reported_at <= v_now - c_report_gap);

    -- The claims nobody finished: handed out twice with no result 5 minutes
    -- after the second, or never handed out again 30 minutes after the
    -- first (a serious flag 10 hours after it). Shown on the console as not
    -- sent.
    update public.platform_security_alerts a
       set disposition = 'not_sent'
     where (a.push_planned or a.email_planned) and a.resulted_at is null
       and a.disposition in ('sent', 'email_only_budget')
       and ((a.attempts = 2 and a.claimed_at <= v_now - c_retry_after)
            or (a.attempts = 1 and a.class <> 'serious' and a.claimed_at <= v_now - c_abandon_after)
            or (a.attempts = 1 and a.class = 'serious' and a.claimed_at <= v_now - c_serious_abandon_after));
    get diagnostics v_swept = row_count;

    v_run := pg_catalog.gen_random_uuid();
    update public.platform_security_alert_state s
       set last_run_id = v_run, last_run_started_at = v_now, last_run_finished_at = null, last_run_ok = null,
           last_run_partial = null, failures_in_a_row = v_failures, failure_reported = s.failure_reported or v_report,
           failure_reported_at = case when v_report then v_now else s.failure_reported_at end
     where s.id;

    return pg_catalog.jsonb_build_object(
      'step', 'start', 'refused', null, 'run_id', v_run,
      'previous', pg_catalog.jsonb_build_object('started_at', v_state.last_run_started_at,
                                                'finished_at', v_state.last_run_finished_at,
                                                'ok', v_state.last_run_ok),
      'last_ok_at', v_state.last_ok_at,
      'missed_runs', v_missed,
      'failures_in_a_row', v_failures,
      'report_now', v_report,
      'marked_not_sent', v_swept);
  end if;

  -- The finish of the latest run only, once.
  if v_state.last_run_id is distinct from p_run_id then
    return pg_catalog.jsonb_build_object('step', 'finish', 'refused', 'not_the_latest_run');
  end if;
  if v_state.last_run_finished_at is not null then
    return pg_catalog.jsonb_build_object('step', 'finish', 'refused', 'already_finished');
  end if;
  if p_ok then
    v_failures := 0;
    v_report := false;
  else
    v_failures := least(v_state.failures_in_a_row + 1, 1000000);
    v_report := v_failures >= c_report_at and not v_state.failure_reported
                and (v_state.failure_reported_at is null or v_state.failure_reported_at <= v_now - c_report_gap);
  end if;
  -- p_partial: the run could not check fully (a shortened or truncated
  -- read); the console shows it. Not said is a full check.
  update public.platform_security_alert_state s
     set last_run_finished_at = v_now, last_run_ok = p_ok, last_run_partial = coalesce(p_partial, false),
         last_ok_at = case when p_ok then v_now else s.last_ok_at end,
         failures_in_a_row = v_failures,
         failure_reported = case when p_ok then false else s.failure_reported or v_report end,
         failure_reported_at = case when v_report then v_now else s.failure_reported_at end
   where s.id;
  return pg_catalog.jsonb_build_object('step', 'finish', 'refused', null, 'failures_in_a_row', v_failures,
                                       'report_now', v_report);
end;
$$;

revoke all on function public.platform_security_alert_heartbeat(text, uuid, boolean, boolean) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_heartbeat(text, uuid, boolean, boolean) to service_role;

comment on function public.platform_security_alert_heartbeat(text, uuid, boolean, boolean) is
  'The security alert job''s heartbeat, under the claim''s advisory lock (4800001; a wait of 2 s ends with 55P03). p_step start: counts the runs missed since the last start (by 10-minute ticks) and the last run when it never finished into failures_in_a_row, marks not_sent the claims handed out twice with no result 5 minutes after the second or never handed out again 30 minutes after the first (a serious flag 10 hours after it), and answers {step, refused, run_id, previous {started_at, finished_at, ok}, last_ok_at, missed_runs, failures_in_a_row, report_now, marked_not_sent}. p_step finish with that run_id, p_ok and p_partial (true: the run could not check fully; not given: false): answers {step, refused, failures_in_a_row, report_now}; ok resets the count, not ok adds one. report_now is true once when the count reaches 3, until a run goes well, and never within 6 hours of the last time it was. Refused: not_a_step, not_a_finish, no_state, not_the_latest_run, already_finished. Never raises for an argument. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 8. A switch, a threshold or a planned check ──────────────────────────────
create function public.platform_security_alert_set(
  p_actor_user_id uuid,
  p_name          text,
  p_value         jsonb,
  p_expected      jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set timezone = 'UTC'
as $$
declare
  -- THE RANGES OF THE THRESHOLDS, [least, most]. Written here and nowhere
  -- else (the table holds them to whole numbers from 0 to 1,000,000).
  -- aimed_guessing_minutes is also a whole number of 10-minute buckets.
  c_ranges constant jsonb := '{
    "aimed_guessing_events": [5, 100000],
    "aimed_guessing_minutes": [10, 120],
    "record_trouble_rows": [1, 100000],
    "serious_pushes_per_hour": [1, 60],
    "spike_event_floor": [10, 1000000],
    "spike_learning_days": [1, 90],
    "spike_source_floor": [2, 100000],
    "subject_pushes_per_day": [1, 24],
    "volume_pushes_per_day": [0, 100]
  }'::jsonb;
  -- The longest planned check, in minutes; no new one while one is on or
  -- within 30 minutes of the last one's end; at most 4 started in a day
  -- (so a stolen console session cannot hold volume and record alerts all
  -- day; a serious flag is never held).
  c_check_most constant integer := 30;
  c_check_gap  constant interval := '30 minutes';
  c_checks_per_day constant integer := 4;
  v_last_end timestamptz;
  v_now     timestamptz := pg_catalog.now();
  v_answer  jsonb := pg_catalog.jsonb_build_object('changed', false, 'refused', null, 'name', null,
                                                   'old_value', null, 'new_value', null, 'changed_at', null);
  v_state   public.platform_security_alert_state;
  v_n       bigint;
  v_old     jsonb;
  v_new     jsonb;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  if p_actor_user_id is null then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'no_actor');
  end if;
  if p_name is null
     or not (p_name in ('email_on', 'push_on', 'summary_on', 'planned_check') or c_ranges ? p_name) then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_name');
  end if;
  v_answer := v_answer || pg_catalog.jsonb_build_object('name', p_name);

  -- The value: a boolean for a switch; whole minutes 0 to 30 for a planned
  -- check (0 ends it); a whole number in its range for a threshold.
  if p_name in ('email_on', 'push_on', 'summary_on') then
    if coalesce(pg_catalog.jsonb_typeof(p_value), '') <> 'boolean' then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_value');
    end if;
  else
    if coalesce(pg_catalog.jsonb_typeof(p_value), '') <> 'number' or (p_value #>> '{}') !~ '^[0-9]{1,7}$' then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'not_a_value');
    end if;
    v_n := (p_value #>> '{}')::bigint;
    if p_name = 'planned_check' then
      if v_n > c_check_most then
        return v_answer || pg_catalog.jsonb_build_object('refused', 'out_of_range');
      end if;
    elsif v_n < (c_ranges -> p_name ->> 0)::bigint or v_n > (c_ranges -> p_name ->> 1)::bigint
          or (p_name = 'aimed_guessing_minutes' and v_n % 10 <> 0) then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'out_of_range');
    end if;
  end if;

  -- The actor: an account that exists and is not deleted.
  if not exists (select 1 from auth.users u where u.id = p_actor_user_id and u.deleted_at is null) then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'unknown_actor');
  end if;

  -- The claim's lock: a change and a claim never cross.
  perform pg_catalog.pg_advisory_xact_lock(4800001);

  select s.* into v_state from public.platform_security_alert_state s where s.id for update;
  if not found then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'no_state');
  end if;

  -- The value now (a planned check that has ended is none), and the new one.
  v_old := case p_name
             when 'email_on' then pg_catalog.to_jsonb(v_state.email_on)
             when 'push_on' then pg_catalog.to_jsonb(v_state.push_on)
             when 'summary_on' then pg_catalog.to_jsonb(v_state.summary_on)
             when 'planned_check' then case when v_state.planned_check_until > v_now
                                            then pg_catalog.to_jsonb(v_state.planned_check_until) end
             else v_state.thresholds -> p_name end;
  v_new := case when p_name = 'planned_check'
                then case when v_n = 0 then null else pg_catalog.to_jsonb(v_now + pg_catalog.make_interval(mins => v_n::integer)) end
                else p_value end;

  -- Compare-and-set: when the console says what it saw, it must still be so.
  if p_expected is not null and p_expected is distinct from coalesce(v_old, 'null'::jsonb) then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'changed_by_someone_else', 'old_value', v_old);
  end if;
  if v_new is not distinct from v_old then
    return v_answer || pg_catalog.jsonb_build_object('refused', 'unchanged', 'old_value', v_old);
  end if;
  -- A new planned check (ending one is always taken): not while one is on
  -- or within 30 minutes of the last one's end (planned_check_until keeps
  -- it: the end it was given, or when it was ended early), and at most 4
  -- started in a day.
  if p_name = 'planned_check' and v_n > 0 then
    v_last_end := v_state.planned_check_until;
    if v_last_end is not null and v_last_end + c_check_gap > v_now then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'planned_check_too_soon', 'old_value', v_old);
    end if;
    if (select pg_catalog.count(*) from public.platform_security_alert_changes c
         where c.name = 'planned_check' and c.new_value is not null and c.changed_at > v_now - interval '24 hours')
       >= c_checks_per_day then
      return v_answer || pg_catalog.jsonb_build_object('refused', 'planned_checks_used_up', 'old_value', v_old);
    end if;
  end if;

  update public.platform_security_alert_state s
     set email_on   = case when p_name = 'email_on' then (p_value #>> '{}')::boolean else s.email_on end,
         push_on    = case when p_name = 'push_on' then (p_value #>> '{}')::boolean else s.push_on end,
         summary_on = case when p_name = 'summary_on' then (p_value #>> '{}')::boolean else s.summary_on end,
         planned_check_until = case when p_name = 'planned_check' then coalesce((v_new #>> '{}')::timestamptz, v_now)
                                    else s.planned_check_until end,
         thresholds = case when c_ranges ? p_name
                           then s.thresholds || pg_catalog.jsonb_build_object(p_name, v_n)
                           else s.thresholds end
   where s.id;

  insert into public.platform_security_alert_changes (changed_at, actor_user_id, name, old_value, new_value)
  values (v_now, p_actor_user_id, p_name, v_old, v_new);

  return pg_catalog.jsonb_build_object('changed', true, 'refused', null, 'name', p_name,
                                       'old_value', v_old, 'new_value', v_new, 'changed_at', v_now);
end;
$$;

revoke all on function public.platform_security_alert_set(uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_set(uuid, text, jsonb, jsonb) to service_role;

comment on function public.platform_security_alert_set(uuid, text, jsonb, jsonb) is
  'Changes one security alert setting for the platform console and writes its change row (actor, name, old and new value) in the same transaction, under the claim''s advisory lock (4800001; a wait of 2 s ends with 55P03). p_name: email_on, push_on or summary_on (p_value a boolean); planned_check (whole minutes 0 to 30 from now; 0 ends it and is always taken; a new one is refused planned_check_too_soon while one is on or within 30 minutes of the last one''s end, and planned_checks_used_up when 4 were started in the last 24 hours); or a threshold (a whole number in its range: aimed_guessing_events 5 to 100000, aimed_guessing_minutes 10 to 120 in tens, record_trouble_rows 1 to 100000, serious_pushes_per_hour 1 to 60, spike_event_floor 10 to 1000000, spike_learning_days 1 to 90, spike_source_floor 2 to 100000, subject_pushes_per_day 1 to 24, volume_pushes_per_day 0 to 100). p_expected, when given, must equal the value now. Answers {changed, refused, name, old_value, new_value, changed_at}: refused no_actor, not_a_name, not_a_value, out_of_range, unknown_actor, no_state, changed_by_someone_else, unchanged, planned_check_too_soon or planned_checks_used_up. Never raises for an argument. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 9. The console's read ────────────────────────────────────────────────────
create function public.platform_security_alert_list(
  p_limit   integer default null,
  p_changes integer default null
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
  -- Alerts and changes listed: this many when none is asked for, never more
  -- than the most.
  c_default        constant integer  := 50;
  c_most           constant integer  := 200;
  c_retry_after    constant interval := '5 minutes';
  c_serious_window constant interval := '1 hour';
  c_volume_window  constant interval := '24 hours';
  v_now     timestamptz := pg_catalog.now();
  v_limit   integer;
  v_changes integer;
  v_state   public.platform_security_alert_state;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  select s.* into v_state from public.platform_security_alert_state s where s.id;
  if not found then
    return pg_catalog.jsonb_build_object('refused', 'no_state', 'generated_at', v_now);
  end if;
  v_limit   := least(greatest(coalesce(p_limit, c_default), 1), c_most);
  v_changes := least(greatest(coalesce(p_changes, c_default), 1), c_most);

  return pg_catalog.jsonb_build_object(
    'refused', null,
    'generated_at', v_now,
    -- The state row, but not the run token.
    'state', pg_catalog.jsonb_build_object(
      'email_on', v_state.email_on,
      'push_on', v_state.push_on,
      'summary_on', v_state.summary_on,
      'record_only', not v_state.email_on and not v_state.push_on,
      'planned_check_until', case when v_state.planned_check_until > v_now then v_state.planned_check_until end,
      'thresholds', v_state.thresholds,
      'baseline', pg_catalog.jsonb_build_object(
        'event_high', v_state.baseline_event_high,
        'source_high', v_state.baseline_source_high,
        'from', v_state.baseline_from,
        'to', v_state.baseline_to,
        'shortened', v_state.baseline_shortened,
        'computed_at', v_state.baseline_computed_at),
      'heartbeat', pg_catalog.jsonb_build_object(
        'last_run_started_at', v_state.last_run_started_at,
        'last_run_finished_at', v_state.last_run_finished_at,
        'last_run_ok', v_state.last_run_ok,
        'last_run_partial', v_state.last_run_partial,
        'last_ok_at', v_state.last_ok_at,
        'failures_in_a_row', v_state.failures_in_a_row,
        'failure_reported_at', v_state.failure_reported_at)),
    'budget', pg_catalog.jsonb_build_object(
      'serious_pushes_last_hour', (select pg_catalog.count(*) from public.platform_security_alerts a
                                    where a.class = 'serious' and a.push_counted
                                      and a.claimed_at > v_now - c_serious_window),
      'serious_pushes_last_day_by_reason',
        coalesce((select pg_catalog.jsonb_object_agg(x.reason, x.n)
                    from (select pg_catalog.split_part(a.event_key, '|', 1) as reason, pg_catalog.count(*) as n
                            from public.platform_security_alerts a
                           where a.class = 'serious' and a.push_counted and a.claimed_at > v_now - c_volume_window
                           group by 1) x), '{}'::jsonb),
      'volume_pushes_last_day', (select pg_catalog.count(*) from public.platform_security_alerts a
                                  where a.class in ('volume', 'record') and a.push_counted
                                    and a.claimed_at > v_now - c_volume_window),
      'volume_emails_last_day', (select pg_catalog.count(*) from public.platform_security_alerts a
                                  where a.class in ('volume', 'record') and a.email_planned
                                    and a.claimed_at > v_now - c_volume_window)),
    'alerts',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'rule', x.rule, 'class', x.class, 'subject', x.subject,
                         'organization_name', pg_catalog.left(o.name, 200),
                         'event_key', x.event_key, 'phase', x.phase, 'counts', x.counts,
                         'disposition', x.disposition, 'push_planned', x.push_planned,
                         'email_planned', x.email_planned, 'push_counted', x.push_counted, 'email_floor', x.email_floor,
                         'push_result', x.push_result, 'email_result', x.email_result,
                         'attempts', x.attempts, 'claimed_at', x.claimed_at, 'resulted_at', x.resulted_at,
                         'state_ended_at', x.state_ended_at,
                         'awaiting_result', x.awaiting,
                         'overdue', x.awaiting and x.claimed_at <= v_now - c_retry_after)
                       order by x.claimed_at desc, x.id)
                  from (select a.*,
                               ((a.push_planned or a.email_planned) and a.resulted_at is null
                                and a.disposition in ('sent', 'email_only_budget')) as awaiting
                          from public.platform_security_alerts a
                         order by a.claimed_at desc, a.id
                         limit v_limit) x
                  left join public.organizations o
                    on o.id = case when x.subject <> '' then x.subject::uuid end), pg_catalog.jsonb_build_array()),
    'alerts_truncated', (select pg_catalog.count(*) > v_limit
                           from (select 1 from public.platform_security_alerts a limit v_limit + 1) q),
    'changes',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'changed_at', c.changed_at, 'actor_user_id', c.actor_user_id, 'name', c.name,
                         'old_value', c.old_value, 'new_value', c.new_value)
                       order by c.changed_at desc, c.id)
                  from (select * from public.platform_security_alert_changes ch
                         order by ch.changed_at desc, ch.id
                         limit v_changes) c), pg_catalog.jsonb_build_array()),
    'changes_truncated', (select pg_catalog.count(*) > v_changes
                            from (select 1 from public.platform_security_alert_changes ch limit v_changes + 1) q),
    -- The latest change of every setting, however old: who made each value
    -- that is in force never falls out of the read.
    'latest_changes',
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                         'changed_at', c.changed_at, 'actor_user_id', c.actor_user_id, 'name', c.name,
                         'old_value', c.old_value, 'new_value', c.new_value)
                       order by c.name)
                  from (select distinct on (ch.name) ch.*
                          from public.platform_security_alert_changes ch
                         order by ch.name, ch.changed_at desc, ch.id desc) c), pg_catalog.jsonb_build_array()));
end;
$$;

revoke all on function public.platform_security_alert_list(integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_list(integer, integer) to service_role;

comment on function public.platform_security_alert_list(integer, integer) is
  'For the platform console''s alerts page. Keys: refused (null), generated_at; state (email_on, push_on, summary_on, record_only, planned_check_until while on, thresholds, baseline {event_high, source_high, from, to, shortened, computed_at}, heartbeat {last_run_started_at, last_run_finished_at, last_run_ok, last_run_partial, last_ok_at, failures_in_a_row, failure_reported_at}; never the run token); budget (serious_pushes_last_hour, serious_pushes_last_day_by_reason, volume_pushes_last_day, volume_emails_last_day); alerts, the newest p_limit (default 50, 1 to 200) with rule, class, subject, organization_name (its first 200 characters), event_key, phase, counts, disposition, push_planned, email_planned, push_counted, email_floor, push_result, email_result, attempts, claimed_at, resulted_at, state_ended_at, awaiting_result and overdue (no result 5 minutes after it was handed out); alerts_truncated; changes, the newest p_changes (default 50, 1 to 200); changes_truncated; latest_changes, the latest change of each setting however old (at most thirteen, by name). A missing state row answers refused no_state. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 10. The baseline ─────────────────────────────────────────────────────────
create function public.platform_security_alert_baseline()
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '20s'
set lock_timeout = '2s'
set timezone = 'UTC'
as $$
declare
  -- THE BOUNDS OF THE BASELINE. Written here and nowhere else.
  c_days          constant interval    := '7 days';
  c_bucket        constant interval    := '10 minutes';
  c_bucket_origin constant timestamptz := '2000-01-01 00:00:00+00';
  -- The most rows of the record one baseline reads; a week that holds more
  -- is read from a later start, and the baseline says so.
  c_max_rows      constant integer     := 1500000;
  -- The high mark: this percentile of the week's buckets, empty ones
  -- included.
  c_percentile    constant float8      := 0.99;
  -- Once a day: a baseline computed less than this long ago is kept.
  c_min_gap       constant interval    := '6 hours';
  v_now       timestamptz := pg_catalog.now();
  v_state     public.platform_security_alert_state;
  v_to        timestamptz;
  v_asked     timestamptz;
  v_from      timestamptz;
  v_first     timestamptz;
  v_event     integer;
  v_source    integer;
  v_buckets   integer;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  select s.* into v_state from public.platform_security_alert_state s where s.id;
  if not found then
    return pg_catalog.jsonb_build_object('computed', false, 'refused', 'no_state');
  end if;
  if v_state.baseline_computed_at > v_now - c_min_gap then
    return pg_catalog.jsonb_build_object('computed', false, 'refused', 'computed_recently',
                                         'computed_at', v_state.baseline_computed_at);
  end if;

  -- Whole buckets only: up to the start of the bucket running now, 7 days
  -- back; with the row ceiling (0478's walk), from the first whole bucket
  -- after the start it gives.
  v_to    := pg_catalog.date_bin(c_bucket, v_now, c_bucket_origin);
  v_asked := v_to - c_days;
  v_from  := public._security_map_read_from(v_asked, v_to, c_max_rows);
  v_first := pg_catalog.date_bin(c_bucket, v_from, c_bucket_origin);
  if v_first < v_from then
    v_first := v_first + c_bucket;
  end if;
  if v_first >= v_to then
    return pg_catalog.jsonb_build_object('computed', false, 'refused', 'too_many_events_in_one_bucket');
  end if;

  -- Counted as the alert job counts (the inputs' buckets): blocked and
  -- flagged events, no tally; distinct sources a bucket.
  with u as (
    select pg_catalog.date_bin(c_bucket, x.minute, c_bucket_origin) as bucket, pg_catalog.sum(x.events)::bigint as events
      from public._security_map_units(v_first, v_to, false) x
     where x.kind <> 'tally' and x.outcome in ('blocked', 'flagged')
     group by 1
  ),
  s as (
    select pg_catalog.date_bin(c_bucket, e.minute, c_bucket_origin) as bucket,
           pg_catalog.count(distinct e.source_hash) as sources
      from public.security_events e
     where e.minute >= v_first and e.minute < v_to
       and e.source_hash is not null and e.outcome in ('blocked', 'flagged')
     group by 1
  ),
  slots as (
    select g as bucket from pg_catalog.generate_series(v_first, v_to - c_bucket, c_bucket) g
  )
  select least(pg_catalog.percentile_disc(c_percentile) within group (order by coalesce(u.events, 0)), 2000000000)::integer,
         least(pg_catalog.percentile_disc(c_percentile) within group (order by coalesce(s.sources, 0)), 2000000000)::integer,
         pg_catalog.count(*)::integer
    into v_event, v_source, v_buckets
    from slots sl
    left join u on u.bucket = sl.bucket
    left join s on s.bucket = sl.bucket;

  -- The claim's lock, only for the write: the week's read above holds none,
  -- so a claim never waits on it.
  perform pg_catalog.pg_advisory_xact_lock(4800001);
  update public.platform_security_alert_state st
     set baseline_event_high = v_event, baseline_source_high = v_source,
         baseline_from = v_first, baseline_to = v_to, baseline_shortened = v_first > v_asked,
         baseline_computed_at = v_now
   where st.id;

  return pg_catalog.jsonb_build_object('computed', true, 'refused', null, 'event_high', v_event,
                                       'source_high', v_source, 'from', v_first, 'to', v_to,
                                       'asked_from', v_asked, 'shortened', v_first > v_asked,
                                       'buckets', v_buckets, 'computed_at', v_now);
end;
$$;

revoke all on function public.platform_security_alert_baseline() from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_baseline() to service_role;

comment on function public.platform_security_alert_baseline() is
  'Once a day, for the security alerts'' spike rule: of the whole 10-minute buckets of the 7 days up to the bucket running now (at most 1,500,000 rows of the record, else from the first whole bucket after the earliest later start that keeps it so: shortened), the 99th percentile, empty buckets included, of the counted blocked and flagged events (as _security_map_units counts, no tally) and of the distinct sources, stored in the state row with the window and the time. The read holds no lock; the write takes the claim''s advisory lock (4800001; a wait of 2 s ends with 55P03). Answers {computed, refused, event_high, source_high, from, to, asked_from, shortened, buckets, computed_at}; refused no_state, computed_recently (less than 6 hours ago; computed_at given) or too_many_events_in_one_bucket. Never raises for the record''s contents. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── 11. Retention ────────────────────────────────────────────────────────────
create function public.platform_security_alert_purge()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_deleted integer;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  -- The claim's lock.
  perform pg_catalog.pg_advisory_xact_lock(4800001);

  -- An alert goes once it was claimed more than 400 days ago. Oldest first,
  -- at most 5,000. The change rows are kept.
  with doomed as (
    select a.id
      from public.platform_security_alerts a
     where a.claimed_at < pg_catalog.now() - interval '400 days'
     order by a.claimed_at
     limit 5000
  )
  delete from public.platform_security_alerts a using doomed d where a.id = d.id;
  get diagnostics v_deleted = row_count;

  return pg_catalog.jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function public.platform_security_alert_purge() from public, anon, authenticated, service_role;
grant execute on function public.platform_security_alert_purge() to service_role;

comment on function public.platform_security_alert_purge() is
  'Deletes security alerts claimed more than 400 days ago, oldest first, at most 5,000 a call, under the claim''s advisory lock (4800001; a wait of 2 s ends with 55P03). The change rows are kept. Returns {deleted}; the retention job calls it until that is under 5,000. service_role only.';

-- ── 12. Who gets a push ──────────────────────────────────────────────────────
create function public.platform_admin_user_ids(p_emails text[])
returns table (user_id uuid)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  -- The most addresses read from one call.
  c_max_emails constant integer := 20;
  v_emails text[];
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'platform_security_alerts_not_allowed' using errcode = '42501';
  end if;

  if p_emails is null then
    return;
  end if;
  -- The first 20 elements, trimmed and in lower case; one that is not
  -- shaped like an address is left out.
  select coalesce(pg_catalog.array_agg(distinct x.e), '{}'::text[]) into v_emails
    from (select pg_catalog.lower(pg_catalog.btrim(t.e)) as e
            from pg_catalog.unnest(p_emails) with ordinality as t(e, n)
           order by t.n
           limit c_max_emails) x
   where x.e is not null and pg_catalog.char_length(x.e) between 3 and 320
     and x.e ~ '^[^@[:space:]]+@[^@[:space:]]+$';
  if pg_catalog.cardinality(v_emails) = 0 then
    return;
  end if;

  -- The sign-in email Auth confirmed, in any case; an account that is not
  -- disabled by the console (user_profiles.disabled_at, which the console's
  -- disable writes first and every request reads) nor banned by Auth (the
  -- console's second layer), not deleted (in Auth or as a profile
  -- tombstone), and neither an SSO nor an anonymous account. An account
  -- with no profile is left out: an unreadable flag never counts as "not
  -- disabled".
  return query
    select u.id
      from auth.users u
     where pg_catalog.lower(u.email::text) = any (v_emails)
       and u.email_confirmed_at is not null
       and u.deleted_at is null
       and not u.is_sso_user
       and not u.is_anonymous
       and (u.banned_until is null or u.banned_until <= pg_catalog.now())
       and exists (select 1 from public.user_profiles p
                    where p.id = u.id and p.disabled_at is null and p.deleted_at is null)
     order by u.id;
end;
$$;

revoke all on function public.platform_admin_user_ids(text[]) from public, anon, authenticated, service_role;
grant execute on function public.platform_admin_user_ids(text[]) to service_role;

comment on function public.platform_admin_user_ids(text[]) is
  'For the security alerts'' push: the ids of the accounts whose confirmed sign-in email (auth.users.email with email_confirmed_at set; never the profile column) is one of the first 20 elements of p_emails, case-insensitive and trimmed, leaving out an account disabled by the platform console (user_profiles.disabled_at) or banned in Auth (banned_until in the future), deleted (auth.users.deleted_at or user_profiles.deleted_at), with no profile row, or an SSO or anonymous account. Ordered by id; none for null, an empty list or no match. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Nothing depends on these objects but the app code that follows this
-- migration, which treats a missing function as "could not check" (the
-- console) or as a failed run (the job, which then sends nothing). To remove
-- them (an ACCESS EXCLUSIVE lock on the three new tables only; no other table
-- is locked; their rows go with them), and then the migration history row of
-- 0480 too, or the next push takes the file as applied:
--   drop function if exists public.platform_admin_user_ids(text[]);
--   drop function if exists public.platform_security_alert_purge();
--   drop function if exists public.platform_security_alert_baseline();
--   drop function if exists public.platform_security_alert_list(integer, integer);
--   drop function if exists public.platform_security_alert_set(uuid, text, jsonb, jsonb);
--   drop function if exists public.platform_security_alert_heartbeat(text, uuid, boolean, boolean);
--   drop function if exists public.platform_security_alert_result(uuid, integer, jsonb, jsonb);
--   drop function if exists public.platform_security_alert_claim(text, text, text, text, jsonb);
--   drop function if exists public.platform_security_alert_inputs();
--   drop table if exists public.platform_security_alert_changes;
--   drop table if exists public.platform_security_alerts;
--   drop table if exists public.platform_security_alert_state;
