-- supabase/tests/0480_platform_security_alerts.test.sql
-- Proves migration 0480: the platform console's security alerts.
--   public.platform_security_alert_state                    the one row
--   public.platform_security_alerts                         the alerts
--   public.platform_security_alert_changes                  the change history
--   public.platform_security_alert_inputs()                 what the job reads
--   public.platform_security_alert_claim(text, text, text, text, jsonb)
--   public.platform_security_alert_result(uuid, integer, jsonb, jsonb)
--   public.platform_security_alert_heartbeat(text, uuid, boolean, boolean)
--   public.platform_security_alert_set(uuid, text, jsonb, jsonb)
--   public.platform_security_alert_list(integer, integer)   the console's read
--   public.platform_security_alert_baseline()
--   public.platform_security_alert_purge()
--   public.platform_admin_user_ids(text[])
--
-- WHAT IS WORTH PINNING
--   1. Shape: the designed columns, keys, checks and indexes; no foreign
--      key, no trigger, no policy; the one state row with every switch off
--      and the default thresholds.
--   2. Privileges for every role on every object: anon, authenticated and
--      service_role nothing on the tables; service_role EXECUTE on the nine
--      functions and nothing else; PUBLIC nothing. No body names a gate word,
--      so INV-25 names every function if EXECUTE reached authenticated (in a
--      savepoint), and even then the second lock refuses a member and a
--      signed-out caller.
--   3. The locks: every write takes this file's advisory lock (4800001),
--      never the security events' or the samples'; the reads take none.
--      (Two sessions: scripts/db-concurrency/0480_platform_security_alerts_race.sh.)
--   4. The inputs: the 8 hours by the event's minute, counted as the map
--      counts (folded, tallies apart), every number of a made-up record
--      worked out by hand; never a source hash; the row ceiling.
--   5. The claim (M6, M7, M9): one row per alert however often it is
--      claimed; a subject of null and '' the same; the key from the events;
--      the one retry after 5 minutes and then not_sent, and a serious flag's
--      retry never lost (not swept before it is offered, not refused when
--      its hour has left the window, listed apart from the others); the
--      class budgets ("a scan that lasts 12 hours claims at most 4 pushes",
--      "six cheap alerts do not delay a serious flag", "one serious reason
--      that repeats every hour for a day pushes at most 4 times"); email as
--      a serious flag's floor; the day's cap on volume and record emails;
--      the states (a start with an ended state's key); the switches; the
--      planned check and its limits; every refusal, never raised.
--   6. The result (a serious push that reached no one is owed its email),
--      the heartbeat (a run that could not check fully, the failing notice
--      at most once in 6 hours), the set, the list (the latest change of
--      every setting however old), the baseline, the purge and the push
--      recipients: every answer and every refusal.
--
-- now() is fixed for the whole transaction and the functions use it. Every
-- row is placed from B0, the start of the 10-minute bucket now() is in: b(n)
-- is B0 plus n buckets, at(n, k) is b(n) plus k minutes. A time that must
-- pass is made by moving a row's own time back, as its owner. Every
-- organization, account, address and value is made up. Wrapped in
-- begin/rollback: nothing leaks. Run via `supabase test db` after
-- `supabase db reset`.

begin;

select plan(167);

-- Every time below is compared as text; the functions write UTC whatever
-- the session says (0480/67), and so does this file.
set local timezone = 'UTC';

-- First, before any helper names the tables (they cannot be created without them).
select has_table('public', 'platform_security_alert_state', '0480/1: the state table exists');
select has_table('public', 'platform_security_alerts', '0480/2: the alerts table exists');
select has_table('public', 'platform_security_alert_changes', '0480/3: the changes table exists');

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- This file's functions.
create function pg_temp.is_ours(p oid) returns boolean language sql stable as $$
  select exists (select 1 from pg_proc x
                  where x.oid = p and x.pronamespace = 'public'::regnamespace
                    and (x.proname like 'platform\_security\_alert\_%' or x.proname = 'platform_admin_user_ids'));
$$;
-- Every grant on a function other than its owner's, as role:privilege.
create function pg_temp.grants_of(p regprocedure) returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type order by 1), '{}'::text[])
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
   where pr.oid = p and x.grantee <> pr.proowner;
$$;
-- Every grant on a table other than its owner's.
create function pg_temp.table_grants(p regclass) returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type order by 1), '{}'::text[])
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   where c.oid = p and x.grantee <> c.relowner;
$$;
-- The SQLSTATE and message of a refused statement, or 'no error'.
create function pg_temp.refusal(p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || '|' || v_msg;
end;
$$;
grant execute on function pg_temp.refusal(text) to anon, authenticated, service_role;
-- Runs a statement and undoes it: 'ok', or the SQLSTATE it raised.
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'pg_temp.try: undone';
  exception when others then
    if sqlerrm = 'pg_temp.try: undone' then
      return 'ok';
    end if;
    return sqlstate;
  end;
end;
$$;
-- security_invariants INV-25 over this file's functions: its conditions, its
-- strip pass and its gate words, word for word. The names it would report.
create function pg_temp.inv25_names() returns text language sql as $$
  select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'execute')
     and regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
         !~* $re$\m(auth\.uid|has_org_role|has_permission|is_org_member)\M$re$
     and pg_temp.is_ours(p.oid);
$$;
-- The keys of an object (none for anything else: never an error).
create function pg_temp.keys_of(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(k order by k), '{}'::text[])
    from jsonb_object_keys(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) k;
$$;
-- A constant of a body, as 'type := value'.
create function pg_temp.constant_of(p_fn regprocedure, p_name text) returns text language sql as $$
  select m[1] || ' := ' || regexp_replace(m[2], '\s+', ' ', 'g')
    from pg_proc p, regexp_match(p.prosrc, '\m' || p_name || '\s+constant\s+([\w\[\]]+)\s+:=\s+([^;]+);') m
   where p.oid = p_fn;
$$;
-- This transaction's advisory locks on the three keys.
create function pg_temp.locks() returns text language sql as $$
  select 'alerts:' || count(*) filter (where l.objid = 4800001) || ' events:' || count(*) filter (where l.objid = 4720001)
         || ' samples:' || count(*) filter (where l.objid = 4790001)
    from pg_locks l
   where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.classid = 0 and l.objsubid = 1;
$$;
-- The length of a JSON array; null for anything else (never an error).
create function pg_temp.alen(p jsonb) returns integer language sql immutable as $$
  select case when jsonb_typeof(p) = 'array' then jsonb_array_length(p) end;
$$;
-- A JSON array, or an empty one for anything else (so a wrong answer fails its test instead of stopping the file).
create function pg_temp.arr(p jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end;
$$;

-- B0, b(n), at(n, k) and the keys as the functions write them.
create temporary table clock as
  select now() as t0,
         date_bin('10 minutes', now(), '2000-01-01 00:00:00+00') as b0,
         date_bin('10 minutes', now() - interval '8 hours', '2000-01-01 00:00:00+00') + interval '10 minutes' as ws;
create function pg_temp.b(p_n integer) returns timestamptz language sql stable as $$
  select c.b0 + make_interval(mins => 10 * p_n) from pg_temp.clock c;
$$;
create function pg_temp.at(p_n integer, p_k integer default 0) returns timestamptz language sql stable as $$
  select pg_temp.b(p_n) + make_interval(mins => p_k);
$$;
-- The key of a state that starts in bucket n.
create function pg_temp.bk(p_n integer) returns text language sql stable as $$
  select to_char(pg_temp.b(p_n) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"');
$$;
-- The key of a serious flag of an event at p_at.
create function pg_temp.hk(p_reason text, p_at timestamptz) returns text language sql stable as $$
  select p_reason || '|' || to_char(date_trunc('hour', p_at, 'UTC') at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00Z"');
$$;

-- Made-up organizations and accounts.
create function pg_temp.o(p_n integer) returns uuid language sql immutable as $$
  select ('a0480000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;
create function pg_temp.u(p_n integer) returns uuid language sql immutable as $$
  select ('b0480000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;
insert into public.organizations (id, name, slug)
select pg_temp.o(g), case when g = 7 then left('Example ' || repeat('Long Name ', 30), 200) else 'Example Org ' || g end,
       'example-org-0480-' || g
  from generate_series(1, 120) g;

-- A row of the security events record, written by its owner.
create function pg_temp.ev(p_at timestamptz, p_category text, p_outcome text, p_reason text, p_source text default 'web',
                           p_org uuid default null, p_country text default null, p_city text default null,
                           p_count integer default 1, p_hash text default null)
returns void language sql as $$
  insert into public.security_events (minute, category, outcome, reason, source, organization_id, country, city,
                                      event_count, source_hash, last_seen_at, dedupe_key)
  values (date_trunc('minute', p_at, 'UTC'), p_category, p_outcome, p_reason, p_source, p_org, p_country, p_city,
          p_count, p_hash, p_at, md5(gen_random_uuid()::text));
$$;
-- A made-up source hash.
create function pg_temp.h(p_n integer) returns text language sql immutable as $$
  select md5('a0480-source-' || p_n);
$$;

-- The functions as the app calls them, as service_role. An error comes back
-- as {"raised": <SQLSTATE>} (what it wrote undone, the role restored), so a
-- function that raises fails the test that called it instead of stopping
-- the file.
create function pg_temp.claim(p_rule text, p_subject text, p_key text, p_phase text default 'started',
                              p_counts jsonb default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_claim(p_rule, p_subject, p_key, p_phase, p_counts);
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.res(p_id uuid, p_attempt integer, p_push jsonb default null, p_email jsonb default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_result(p_id, p_attempt, p_push, p_email);
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.hb(p_step text, p_run uuid default null, p_ok boolean default null, p_partial boolean default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_heartbeat(p_step, p_run, p_ok, p_partial);
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.setv(p_actor uuid, p_name text, p_value jsonb, p_expected jsonb default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_set(p_actor, p_name, p_value, p_expected);
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.lst(p_limit integer default null, p_changes integer default null)
returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_list(p_limit, p_changes);
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.inp() returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_inputs();
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.base() returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_baseline();
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
create function pg_temp.purge() returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    set local role service_role;
    v := public.platform_security_alert_purge();
    reset role;
  exception when others then
    v := jsonb_build_object('raised', sqlstate);
  end;
  return v;
end;
$$;
-- The push recipients as a list of the made-up account numbers (u(n)), or
-- 'none', or 'raised:<SQLSTATE>'.
create function pg_temp.ids(p text[]) returns text language plpgsql as $$
declare
  v uuid[];
begin
  begin
    set local role service_role;
    select array_agg(x.user_id order by x.user_id) into v from public.platform_admin_user_ids(p) x;
    reset role;
  exception when others then
    return 'raised:' || sqlstate;
  end;
  return coalesce((select string_agg(ltrim(right(i::text, 12), '0'), ',' order by i) from unnest(v) i), 'none');
end;
$$;

-- As the tables' owner: the switches, a row's own time moved back, a fresh start.
create function pg_temp.sw(p_email boolean, p_push boolean) returns void language sql as $$
  update public.platform_security_alert_state set email_on = p_email, push_on = p_push;
$$;
create function pg_temp.age(p_id uuid, p_by interval) returns void language sql as $$
  update public.platform_security_alerts set claimed_at = claimed_at - p_by where id = p_id;
$$;
create function pg_temp.fresh() returns void language sql as $$
  delete from public.platform_security_alerts;
  delete from public.platform_security_alert_changes;
  delete from public.platform_security_alert_state;
  insert into public.platform_security_alert_state (id) values (true);
$$;
-- The alerts of a rule and subject, as 'phase:disposition:push:email:counted' lines in claim order (all
-- claims of one statement share now(): by the state's start, then started, its reminders, its end).
create function pg_temp.rows_of(p_rule text, p_subject text default '') returns text[] language sql as $$
  select coalesce(array_agg(a.phase || ':' || a.disposition || ':' || a.push_planned::text || ':'
                            || a.email_planned::text || ':' || a.push_counted::text
                            order by a.claimed_at, split_part(a.event_key, '+', 1),
                                     case a.phase when 'started' then 0 when 'reminder' then 1 else 2 end,
                                     nullif(rtrim(split_part(a.event_key, '+', 2), 'h'), '')::int nulls first),
                  '{}'::text[])
    from public.platform_security_alerts a where a.rule = p_rule and a.subject = p_subject;
$$;
-- Pushes and emails handed out, as 'pushes:n emails:n rows:n'.
create function pg_temp.sent_of(p_rule text, p_subject text default null) returns text language sql as $$
  select 'pushes:' || count(*) filter (where a.push_planned) || ' emails:' || count(*) filter (where a.email_planned)
         || ' rows:' || count(*)
    from public.platform_security_alerts a
   where a.rule = p_rule and (p_subject is null or a.subject = p_subject);
$$;

-- The nine functions, the calls each refuses for a caller that may not
-- call it, and the record emptied so every number counts from zero (all of
-- it undone at the end).
create temporary table ours (n integer, sig text, call text);
insert into ours values
  (1, 'public.platform_security_alert_inputs()', 'select public.platform_security_alert_inputs()'),
  (2, 'public.platform_security_alert_claim(text, text, text, text, jsonb)', 'select public.platform_security_alert_claim(null, null, null, null)'),
  (3, 'public.platform_security_alert_result(uuid, integer, jsonb, jsonb)', 'select public.platform_security_alert_result(null, null)'),
  (4, 'public.platform_security_alert_heartbeat(text, uuid, boolean, boolean)', 'select public.platform_security_alert_heartbeat(''start'')'),
  (5, 'public.platform_security_alert_set(uuid, text, jsonb, jsonb)', 'select public.platform_security_alert_set(null, null, null)'),
  (6, 'public.platform_security_alert_list(integer, integer)', 'select public.platform_security_alert_list()'),
  (7, 'public.platform_security_alert_baseline()', 'select public.platform_security_alert_baseline()'),
  (8, 'public.platform_security_alert_purge()', 'select public.platform_security_alert_purge()'),
  (9, 'public.platform_admin_user_ids(text[])', 'select count(*) from public.platform_admin_user_ids(null)');
grant select on pg_temp.ours, pg_temp.clock to anon, authenticated, service_role;
delete from public.security_events;

-- ── 1. Shape ────────────────────────────────────────────────────────────────
create function pg_temp.columns_of(p regclass) returns text[] language sql as $$
  select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                   || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') order by a.attnum)
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = p and a.attnum > 0 and not a.attisdropped;
$$;
select is(
  (select array_agg(regexp_replace(x, ':''\{.*$', ':<thresholds>')) from unnest(pg_temp.columns_of('public.platform_security_alert_state')) x),
  array['id:boolean:true:true', 'email_on:boolean:true:false', 'push_on:boolean:true:false', 'summary_on:boolean:true:false',
        'thresholds:jsonb:true:<thresholds>', 'planned_check_until:timestamp with time zone:false:-',
        'baseline_event_high:integer:false:-', 'baseline_source_high:integer:false:-',
        'baseline_from:timestamp with time zone:false:-', 'baseline_to:timestamp with time zone:false:-',
        'baseline_shortened:boolean:false:-', 'baseline_computed_at:timestamp with time zone:false:-',
        'last_run_id:uuid:false:-', 'last_run_started_at:timestamp with time zone:false:-',
        'last_run_finished_at:timestamp with time zone:false:-', 'last_run_ok:boolean:false:-',
        'last_run_partial:boolean:false:-', 'last_ok_at:timestamp with time zone:false:-',
        'failures_in_a_row:integer:true:0', 'failure_reported:boolean:true:false',
        'failure_reported_at:timestamp with time zone:false:-'],
  '0480/4: the state table has exactly its designed columns, types, nullability and defaults (every switch off by default)');
select is(
  pg_temp.columns_of('public.platform_security_alerts'),
  array['id:uuid:true:gen_random_uuid()', 'rule:text:true:-', 'class:text:true:-', 'subject:text:true:''''::text',
        'event_key:text:true:-', 'phase:text:true:-', 'counts:jsonb:true:''{}''::jsonb', 'disposition:text:true:-',
        'push_planned:boolean:true:false', 'email_planned:boolean:true:false', 'push_counted:boolean:true:false',
        'email_floor:text:false:-', 'push_result:jsonb:false:-', 'email_result:jsonb:false:-', 'attempts:smallint:true:1',
        'claimed_at:timestamp with time zone:true:now()', 'resulted_at:timestamp with time zone:false:-',
        'state_ended_at:timestamp with time zone:false:-'],
  '0480/5: the alerts table has exactly its designed columns: subject NOT NULL with '''' for none (M9), no column for an address, an account, a path or a sample');
select is(
  pg_temp.columns_of('public.platform_security_alert_changes'),
  array['id:uuid:true:gen_random_uuid()', 'changed_at:timestamp with time zone:true:now()', 'actor_user_id:uuid:true:-',
        'name:text:true:-', 'old_value:jsonb:false:-', 'new_value:jsonb:false:-'],
  '0480/6: the changes table has exactly its designed columns (the actor a plain uuid)');
select is(
  (select array_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || ':'
                    || (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
                    order by c.relname)
     from pg_class c
    where c.oid in ('public.platform_security_alert_state'::regclass, 'public.platform_security_alerts'::regclass,
                    'public.platform_security_alert_changes'::regclass)),
  array['platform_security_alert_changes:true:false:0', 'platform_security_alert_state:true:false:0',
        'platform_security_alerts:true:false:0'],
  '0480/7: row security is on for all three (not forced on the owner) and none has a policy');
select is(
  (select array_agg(conrelid::regclass::text || '.' || conname order by conrelid::regclass::text, conname)
     from pg_constraint
    where conrelid in ('public.platform_security_alert_state'::regclass, 'public.platform_security_alerts'::regclass,
                       'public.platform_security_alert_changes'::regclass) and contype in ('c', 'u')),
  array['platform_security_alert_changes.platform_security_alert_changes_name',
        'platform_security_alert_changes.platform_security_alert_changes_values',
        'platform_security_alert_state.platform_security_alert_state_baseline',
        'platform_security_alert_state.platform_security_alert_state_heartbeat',
        'platform_security_alert_state.platform_security_alert_state_one_row',
        'platform_security_alert_state.platform_security_alert_state_thresholds',
        'platform_security_alerts.platform_security_alerts_alert_key',
        'platform_security_alerts.platform_security_alerts_attempts',
        'platform_security_alerts.platform_security_alerts_class',
        'platform_security_alerts.platform_security_alerts_counts',
        'platform_security_alerts.platform_security_alerts_disposition',
        'platform_security_alerts.platform_security_alerts_email_floor',
        'platform_security_alerts.platform_security_alerts_event_key',
        'platform_security_alerts.platform_security_alerts_phase',
        'platform_security_alerts.platform_security_alerts_planned',
        'platform_security_alerts.platform_security_alerts_push_counted',
        'platform_security_alerts.platform_security_alerts_results',
        'platform_security_alerts.platform_security_alerts_rule',
        'platform_security_alerts.platform_security_alerts_state_ended',
        'platform_security_alerts.platform_security_alerts_subject'],
  '0480/8: the CHECK and UNIQUE constraints are there by name');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid))
     from pg_index i
    where i.indrelid in ('public.platform_security_alert_state'::regclass, 'public.platform_security_alerts'::regclass,
                         'public.platform_security_alert_changes'::regclass)),
  array['CREATE INDEX platform_security_alert_changes_changed_at_idx ON public.platform_security_alert_changes USING btree (changed_at)',
        'CREATE INDEX platform_security_alerts_awaiting_idx ON public.platform_security_alerts USING btree (claimed_at) WHERE ((push_planned OR email_planned) AND (resulted_at IS NULL) AND (disposition = ANY (ARRAY[''sent''::text, ''email_only_budget''::text])))',
        'CREATE INDEX platform_security_alerts_claimed_at_idx ON public.platform_security_alerts USING btree (claimed_at)',
        'CREATE INDEX platform_security_alerts_open_idx ON public.platform_security_alerts USING btree (rule, subject) WHERE ((phase = ''started''::text) AND (rule = ANY (ARRAY[''aimed_guessing''::text, ''spike''::text, ''record_trouble''::text])) AND (state_ended_at IS NULL))',
        'CREATE UNIQUE INDEX platform_security_alert_changes_pkey ON public.platform_security_alert_changes USING btree (id)',
        'CREATE UNIQUE INDEX platform_security_alert_state_pkey ON public.platform_security_alert_state USING btree (id)',
        'CREATE UNIQUE INDEX platform_security_alerts_alert_key ON public.platform_security_alerts USING btree (rule, subject, event_key, phase)',
        'CREATE UNIQUE INDEX platform_security_alerts_pkey ON public.platform_security_alerts USING btree (id)'],
  '0480/9: the indexes and no more: the three keys, the alert key (rule, subject, event_key, phase), claimed_at, the awaiting and the open-state partial indexes, changed_at');
select is(
  (select array[(select count(*)::int from pg_constraint where contype = 'f' and conrelid in (t.a, t.b, t.c)),
                (select count(*)::int from pg_constraint where confrelid in (t.a, t.b, t.c)),
                (select count(*)::int from pg_trigger where tgrelid in (t.a, t.b, t.c))]
     from (select 'public.platform_security_alert_state'::regclass as a, 'public.platform_security_alerts'::regclass as b,
                  'public.platform_security_alert_changes'::regclass as c) t),
  array[0, 0, 0],
  '0480/10: no foreign key from or to the three tables and no trigger on them (creating them locked no other table)');
select is(
  (select to_jsonb(s) - 'thresholds' from public.platform_security_alert_state s),
  '{"id": true, "email_on": false, "push_on": false, "summary_on": false, "planned_check_until": null,
    "baseline_event_high": null, "baseline_source_high": null, "baseline_from": null, "baseline_to": null,
    "baseline_shortened": null, "baseline_computed_at": null, "last_run_id": null, "last_run_started_at": null,
    "last_run_finished_at": null, "last_run_ok": null, "last_run_partial": null, "last_ok_at": null,
    "failures_in_a_row": 0, "failure_reported": false, "failure_reported_at": null}'::jsonb,
  '0480/11: the migration made the one state row: every switch off (record only), no planned check, no baseline, no run yet');
select is(
  (select thresholds from public.platform_security_alert_state),
  '{"aimed_guessing_events": 20, "aimed_guessing_minutes": 30, "record_trouble_rows": 1, "serious_pushes_per_hour": 6,
    "serious_reason_pushes_per_day": 4, "spike_event_floor": 50, "spike_learning_days": 14, "spike_source_floor": 10,
    "subject_pushes_per_day": 4, "volume_pushes_per_day": 8}'::jsonb,
  '0480/12: the thresholds'' names and defaults to the letter (the constants for core)');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'platform_security_alert_state', 'anon', array[]::text[], '0480/13: anon has no privilege on the state table');
select table_privs_are('public', 'platform_security_alert_state', 'authenticated', array[]::text[], '0480/14: authenticated has no privilege on the state table');
select table_privs_are('public', 'platform_security_alert_state', 'service_role', array[]::text[], '0480/15: service_role has no privilege on the state table');
select table_privs_are('public', 'platform_security_alerts', 'anon', array[]::text[], '0480/16: anon has no privilege on the alerts table');
select table_privs_are('public', 'platform_security_alerts', 'authenticated', array[]::text[], '0480/17: authenticated has no privilege on the alerts table');
select table_privs_are('public', 'platform_security_alerts', 'service_role', array[]::text[], '0480/18: service_role has no privilege on the alerts table');
select table_privs_are('public', 'platform_security_alert_changes', 'anon', array[]::text[], '0480/19: anon has no privilege on the changes table');
select table_privs_are('public', 'platform_security_alert_changes', 'authenticated', array[]::text[], '0480/20: authenticated has no privilege on the changes table');
select table_privs_are('public', 'platform_security_alert_changes', 'service_role', array[]::text[], '0480/21: service_role has no privilege on the changes table');
select is(
  array[array_to_string(pg_temp.table_grants('public.platform_security_alert_state'), ' '),
        array_to_string(pg_temp.table_grants('public.platform_security_alerts'), ' '),
        array_to_string(pg_temp.table_grants('public.platform_security_alert_changes'), ' '),
        (select count(*)::text from pg_attribute
          where attrelid in ('public.platform_security_alert_state'::regclass, 'public.platform_security_alerts'::regclass,
                             'public.platform_security_alert_changes'::regclass) and attnum > 0 and attacl is not null)],
  array['', '', '', '0'],
  '0480/22: no table has a grant beside its owner''s (none to PUBLIC or any API role), and no column has one of its own');
select is(
  (select array_agg(array_to_string(pg_temp.grants_of(o.sig::regprocedure), ' ') order by o.n) from ours o),
  array_fill('service_role:EXECUTE'::text, array[9]),
  '0480/23: each of the nine functions has exactly one grant: EXECUTE to service_role (nothing to PUBLIC)');
select is(
  (select array_agg(has_function_privilege(r.role, o.sig::regprocedure, 'execute') order by o.n, r.n)
     from ours o, unnest(array['anon', 'authenticated', 'service_role']) with ordinality as r(role, n)),
  (select array_agg(x order by g) from generate_series(1, 27) g, lateral (select g % 3 = 0 as x) y),
  '0480/24: anon and authenticated may execute none of the nine; service_role all nine');
select is(
  (select array_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ') ' || pg_get_function_result(p.oid)
                    order by p.proname)
     from pg_proc p where pg_temp.is_ours(p.oid)),
  array['platform_admin_user_ids(p_emails text[]) TABLE(user_id uuid)',
        'platform_security_alert_baseline() jsonb',
        'platform_security_alert_claim(p_rule text, p_subject text, p_event_key text, p_phase text, p_counts jsonb DEFAULT NULL::jsonb) jsonb',
        'platform_security_alert_heartbeat(p_step text, p_run_id uuid DEFAULT NULL::uuid, p_ok boolean DEFAULT NULL::boolean, p_partial boolean DEFAULT NULL::boolean) jsonb',
        'platform_security_alert_inputs() jsonb',
        'platform_security_alert_list(p_limit integer DEFAULT NULL::integer, p_changes integer DEFAULT NULL::integer) jsonb',
        'platform_security_alert_purge() jsonb',
        'platform_security_alert_result(p_id uuid, p_attempt integer, p_push_result jsonb DEFAULT NULL::jsonb, p_email_result jsonb DEFAULT NULL::jsonb) jsonb',
        'platform_security_alert_set(p_actor_user_id uuid, p_name text, p_value jsonb, p_expected jsonb DEFAULT NULL::jsonb) jsonb'],
  '0480/25: exactly the nine functions, with the designed arguments and results');
select is(
  (select array_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                    || array_to_string(p.proconfig, ',') order by p.proname)
     from pg_proc p join pg_language l on l.oid = p.prolang where pg_temp.is_ours(p.oid)),
  array['platform_admin_user_ids:plpgsql:true:s:search_path="",statement_timeout=5s',
        'platform_security_alert_baseline:plpgsql:true:v:search_path="",statement_timeout=20s,lock_timeout=2s,TimeZone=UTC',
        'platform_security_alert_claim:plpgsql:true:v:search_path="",lock_timeout=2s,TimeZone=UTC',
        'platform_security_alert_heartbeat:plpgsql:true:v:search_path="",lock_timeout=2s,TimeZone=UTC',
        'platform_security_alert_inputs:plpgsql:true:s:search_path="",statement_timeout=5s,TimeZone=UTC',
        'platform_security_alert_list:plpgsql:true:s:search_path="",statement_timeout=5s,TimeZone=UTC',
        'platform_security_alert_purge:plpgsql:true:v:search_path="",lock_timeout=2s',
        'platform_security_alert_result:plpgsql:true:v:search_path="",lock_timeout=2s,TimeZone=UTC',
        'platform_security_alert_set:plpgsql:true:v:search_path="",lock_timeout=2s,TimeZone=UTC'],
  '0480/26: all nine plpgsql SECURITY DEFINER with an empty search_path; the three reads STABLE with a statement timeout; every write gives up a lock wait after 2 s; the baseline bounded by 20 s');
select is(
  (select count(*)::int from pg_proc p
    where pg_temp.is_ours(p.oid) and p.prosrc ~* '(auth\.uid|auth\.jwt|has_org_role|has_permission|is_org_member)'),
  0,
  '0480/27: no body names an organization-membership helper or the signed-in account, not even in a comment or a string');
select is(pg_temp.inv25_names(), '',
  '0480/28: as granted, INV-25 has nothing to say about these functions (authenticated cannot execute them)');
select is(
  (select array_agg(p.proname || ':' || regexp_count(p.prosrc, 'pg_advisory_xact_lock\(4800001\)') || ':'
                    || (p.prosrc ~ '47200|47900')::text order by p.proname)
     from pg_proc p where pg_temp.is_ours(p.oid)),
  array['platform_admin_user_ids:0:false', 'platform_security_alert_baseline:1:false', 'platform_security_alert_claim:1:false',
        'platform_security_alert_heartbeat:1:false', 'platform_security_alert_inputs:0:false',
        'platform_security_alert_list:0:false', 'platform_security_alert_purge:1:false',
        'platform_security_alert_result:1:false', 'platform_security_alert_set:1:false'],
  '0480/29: every write takes this file''s lock once and the reads none; no body names the security events'' or the samples'' lock key');
select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
     from pg_proc p where p.prosrc like '%4800001%' and p.pronamespace::regnamespace::text not like 'pg\_temp%'),
  array['platform_security_alert_baseline()', 'platform_security_alert_claim(text,text,text,text,jsonb)',
        'platform_security_alert_heartbeat(text,uuid,boolean,boolean)', 'platform_security_alert_purge()',
        'platform_security_alert_result(uuid,integer,jsonb,jsonb)', 'platform_security_alert_set(uuid,text,jsonb,jsonb)'],
  '0480/30: no other function in the database names this file''s lock key');
select is(
  (select array_agg(p.proname || ':' || (p.prosrc ~* '\m(insert|update|delete|merge|truncate)\M')::text order by p.proname)
     from pg_proc p where pg_temp.is_ours(p.oid) and p.provolatile = 's'),
  array['platform_admin_user_ids:false', 'platform_security_alert_inputs:false', 'platform_security_alert_list:false'],
  '0480/31: the three reads hold no write statement (none of the five write verbs appears as a word)');
-- The lock comes first: in each writer the advisory lock is taken before the
-- first statement that reads or writes one of the three tables, so the
-- novelty, the open state and every budget are counted under it (two
-- overlapping runs would otherwise both see a free slot). The baseline reads
-- the record without it and takes it before its one write.
select is(
  (select array_agg(p.proname || ':'
                    || (strpos(p.prosrc, 'pg_catalog.pg_advisory_xact_lock(4800001)') > 0
                        and strpos(p.prosrc, 'pg_catalog.pg_advisory_xact_lock(4800001)')
                            < regexp_instr(p.prosrc, case when p.proname = 'platform_security_alert_baseline'
                                                          then '\mupdate\s+public\.platform_security_alert'
                                                          else '\m(from|update|into|join)\s+public\.platform_security_alert' end))::text
                    order by p.proname)
     from pg_proc p where pg_temp.is_ours(p.oid) and p.provolatile = 'v'),
  array['platform_security_alert_baseline:true', 'platform_security_alert_claim:true', 'platform_security_alert_heartbeat:true',
        'platform_security_alert_purge:true', 'platform_security_alert_result:true', 'platform_security_alert_set:true'],
  '0480/32: every writer takes the lock before its first read or write of the three tables (the baseline before its write)');
select is(
  array[pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_window'),
        pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_max_rows'),
        pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_max_organizations'),
        pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_retry_after'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_window'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_retry_after'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_serious_window'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_volume_window'),
        pg_temp.constant_of('public.platform_security_alert_heartbeat(text, uuid, boolean, boolean)', 'c_report_at'),
        pg_temp.constant_of('public.platform_security_alert_heartbeat(text, uuid, boolean, boolean)', 'c_abandon_after'),
        pg_temp.constant_of('public.platform_security_alert_heartbeat(text, uuid, boolean, boolean)', 'c_serious_abandon_after'),
        pg_temp.constant_of('public.platform_security_alert_heartbeat(text, uuid, boolean, boolean)', 'c_report_gap'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_volume_emails_per_day'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_record_emails_per_day'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_notice_gap'),
        pg_temp.constant_of('public.platform_security_alert_set(uuid, text, jsonb, jsonb)', 'c_check_gap'),
        pg_temp.constant_of('public.platform_security_alert_set(uuid, text, jsonb, jsonb)', 'c_checks_per_day'),
        pg_temp.constant_of('public.platform_security_alert_baseline()', 'c_max_rows'),
        pg_temp.constant_of('public.platform_security_alert_baseline()', 'c_percentile'),
        pg_temp.constant_of('public.platform_security_alert_baseline()', 'c_min_gap'),
        pg_temp.constant_of('public.platform_security_alert_baseline()', 'c_days'),
        pg_temp.constant_of('public.platform_admin_user_ids(text[])', 'c_max_emails'),
        pg_temp.constant_of('public.platform_security_alert_set(uuid, text, jsonb, jsonb)', 'c_check_most')],
  array['interval := ''8 hours''', 'integer := 400000', 'integer := 100', 'interval := ''5 minutes''',
        'interval := ''8 hours''', 'interval := ''5 minutes''', 'interval := ''1 hour''', 'interval := ''24 hours''',
        'integer := 3', 'interval := ''30 minutes''', 'interval := ''10 hours''', 'interval := ''6 hours''', 'integer := 24',
        'integer := 6', 'interval := ''6 hours''',
        'interval := ''30 minutes''', 'integer := 4', 'integer := 1500000', 'float8 := 0.99', 'interval := ''6 hours''',
        'interval := ''7 days''', 'integer := 20', 'integer := 30'],
  '0480/33: the bounds, each written as designed: 8 hours read, 400,000 rows, 100 organizations, a retry after 5 minutes, push budgets by the hour and the day, three failures reported, an untaken retry abandoned after 30 minutes (a serious flag''s after 10 hours: the 8 hours read and a margin), the failing notice at most once in 6 hours, 24 volume emails a day and 6 of record trouble, the notice that alerts are held at most once in 6 hours, a planned check not within 30 minutes of the last and at most 4 a day, a baseline of 7 days, 1,500,000 rows, the 99th percentile, not again within 6 hours, 20 addresses, a planned check of 30 minutes at most');
select is(
  array[pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_serious_reasons'),
        pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_aimed_reasons'),
        pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_trouble_reasons'),
        pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_flood_reasons')],
  array[pg_temp.constant_of('public.platform_security_alert_claim(text, text, text, text, jsonb)', 'c_serious_reasons'),
        'text[] := array[''repeated_wrong_password'', ''repeated_wrong_code'', ''sign_in_paused'', ''code_checks_paused'']',
        'text[] := array[''over_minute_cap'', ''over_buffer_cap'']',
        (select 'text[] := ' || regexp_replace((regexp_match(prosrc, 'c_flood_reasons\s+constant\s+text\[\]\s+:=\s+([^;]+);'))[1], '\s+', ' ', 'g')
           from pg_proc where oid = 'public._security_map_units(timestamptz, timestamptz, boolean)'::regprocedure)],
  '0480/34: the lists to the letter (white space folded): the inputs'' serious list is the claim''s, the four guessing reasons, the two flood reasons of record trouble, and the claim''s flood list is the map''s own (0478)');
select ok(
  pg_temp.constant_of('public.platform_security_alert_inputs()', 'c_serious_reasons')
  = 'text[] := array[''passkey_counter_went_back'', ''passkey_unexplained_sign_in'', ''sign_in_not_me'', ''unrecorded_server_form_password'', ''unrecorded_server_form_code'']',
  '0480/35: the serious flags are the five of the design: passkey_counter_went_back, passkey_unexplained_sign_in, sign_in_not_me, unrecorded_server_form_password, unrecorded_server_form_code');
select ok(
  (select prosrc like '%a.claimed_at < pg_catalog.now() - interval ''400 days''%' and prosrc like '%limit 5000%'
     from pg_proc where oid = 'public.platform_security_alert_purge()'::regprocedure),
  '0480/36: the purge keeps 400 days and takes 5,000 a call');

-- ── 3. Who may call ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'b0480000-0000-4000-8000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  (select array_agg(pg_temp.refusal(o.call) order by o.n) from ours o)
  || array[pg_temp.refusal('select count(*) from public.platform_security_alert_state'),
           pg_temp.refusal('select count(*) from public.platform_security_alerts'),
           pg_temp.refusal('select count(*) from public.platform_security_alert_changes'),
           pg_temp.refusal('update public.platform_security_alert_state set push_on = true')],
  (select array_agg('42501|permission denied for function ' || regexp_replace(o.sig, '^public\.|\(.*$', '', 'g') order by o.n) from ours o)
  || array['42501|permission denied for table platform_security_alert_state',
           '42501|permission denied for table platform_security_alerts',
           '42501|permission denied for table platform_security_alert_changes',
           '42501|permission denied for table platform_security_alert_state'],
  '0480/37: a signed-in member, even one holding the second step, can call none of the nine and can neither read nor change any table');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  (select array_agg(pg_temp.refusal(o.call) order by o.n) from ours o)
  || array[pg_temp.refusal('select count(*) from public.platform_security_alerts')],
  (select array_agg('42501|permission denied for function ' || regexp_replace(o.sig, '^public\.|\(.*$', '', 'g') order by o.n) from ours o)
  || array['42501|permission denied for table platform_security_alerts'],
  '0480/38: a signed-out caller can call none of the nine and cannot read the alerts');
reset role;
select set_config('request.jwt.claims', '', true);

-- If a grant to the member roles ever slipped in: INV-25 names every
-- function, and the second lock in each body still refuses the call before
-- anything is read or written. Undone by the savepoint.
savepoint slipped_grant;
do $$ declare r record; begin
  for r in select sig from pg_temp.ours loop
    execute format('grant execute on function %s to authenticated, anon', r.sig);
  end loop;
end $$;
select is(pg_temp.inv25_names(),
  'platform_admin_user_ids, platform_security_alert_baseline, platform_security_alert_claim, platform_security_alert_heartbeat, platform_security_alert_inputs, platform_security_alert_list, platform_security_alert_purge, platform_security_alert_result, platform_security_alert_set',
  '0480/39: with EXECUTE granted to authenticated, INV-25 names all nine');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'b0480000-0000-4000-8000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  (select array_agg(pg_temp.refusal(o.call) order by o.n) from ours o)
  || array[pg_temp.refusal($$ select public.platform_security_alert_claim('spike', '', 'not a key', 'started') $$)],
  array_fill('42501|platform_security_alerts_not_allowed'::text, array[10]),
  '0480/40: and even then the second lock refuses a signed-in member on all nine (also for arguments a function would refuse)');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  (select array_agg(pg_temp.refusal(o.call) order by o.n) from ours o),
  array_fill('42501|platform_security_alerts_not_allowed'::text, array[9]),
  '0480/41: the second lock refuses a signed-out caller on all nine as well');
reset role;
select set_config('request.jwt.claims', '', true);
rollback to savepoint slipped_grant;
select is(
  (select count(*)::int from ours o
    where has_function_privilege('authenticated', o.sig::regprocedure, 'execute')
       or has_function_privilege('anon', o.sig::regprocedure, 'execute')),
  0,
  '0480/42: the savepoint took the grants back');

set local role service_role;
select is(
  array[pg_temp.refusal('select count(*) from public.platform_security_alert_state'),
        pg_temp.refusal('update public.platform_security_alert_state set push_on = true'),
        pg_temp.refusal('select count(*) from public.platform_security_alerts'),
        pg_temp.refusal($$ insert into public.platform_security_alerts (rule, class, event_key, phase, disposition) values ('spike', 'volume', '2026-01-01T00:00Z', 'started', 'record_only') $$),
        pg_temp.refusal('delete from public.platform_security_alerts'),
        pg_temp.refusal('select count(*) from public.platform_security_alert_changes'),
        pg_temp.refusal($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'push_on', 'true', 'false') $$)],
  array['42501|permission denied for table platform_security_alert_state',
        '42501|permission denied for table platform_security_alert_state',
        '42501|permission denied for table platform_security_alerts',
        '42501|permission denied for table platform_security_alerts',
        '42501|permission denied for table platform_security_alerts',
        '42501|permission denied for table platform_security_alert_changes',
        '42501|permission denied for table platform_security_alert_changes'],
  '0480/43: service_role can neither read nor write any of the three tables directly: the nine functions are the only way in (a switch cannot be turned off without a change row)');
reset role;

-- ── 4. The locks ────────────────────────────────────────────────────────────
-- Each call in its own savepoint; the locks this transaction holds after it.
create function pg_temp.locks_after(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
    v := pg_temp.locks();
    raise exception 'pg_temp.locks_after: undone';
  exception when others then
    if sqlerrm <> 'pg_temp.locks_after: undone' then
      return 'raised:' || sqlstate;
    end if;
  end;
  return v;
end;
$$;
select is(
  array[pg_temp.locks(),
        pg_temp.locks_after($$ select pg_temp.claim('spike', '', pg_temp.bk(-3)) $$),
        pg_temp.locks_after($$ select pg_temp.res(gen_random_uuid(), 1, '{"sent": 1}') $$),
        pg_temp.locks_after($$ select pg_temp.hb('start') $$),
        pg_temp.locks_after($$ select pg_temp.setv(pg_temp.u(1), 'summary_on', 'true') $$),
        pg_temp.locks_after($$ select pg_temp.purge() $$),
        pg_temp.locks_after($$ select pg_temp.base() $$),
        pg_temp.locks_after($$ select pg_temp.inp(), pg_temp.lst(), pg_temp.ids(array['someone@example.test']) $$),
        pg_temp.locks_after($$ set local role service_role; select public.record_security_events('[{"category": "exploit", "outcome": "blocked", "reason": "env_file", "source": "web"}]'); reset role $$)],
  array['alerts:0 events:0 samples:0', 'alerts:1 events:0 samples:0', 'alerts:1 events:0 samples:0',
        'alerts:1 events:0 samples:0', 'alerts:0 events:0 samples:0', 'alerts:1 events:0 samples:0',
        'alerts:1 events:0 samples:0', 'alerts:0 events:0 samples:0', 'alerts:0 events:1 samples:0'],
  '0480/44: the claim, the result, the heartbeat, the purge and the baseline hold this file''s lock (4800001) to the end of their transaction and never the record''s; the three reads take none; the security events'' writer takes its own and not this one (a set refused before the lock, for an unknown actor, takes none)');

-- ── 5. The tables' own checks, written to as their owner ────────────────────
select is(
  array[pg_temp.try($$ insert into public.platform_security_alert_state (id) values (true) $$),
        pg_temp.try($$ insert into public.platform_security_alert_state (id) values (false) $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds - 'spike_event_floor' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds - 'serious_reason_pushes_per_day' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds || '{"extra": 1}' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds || '{"spike_event_floor": "50"}' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds || '{"spike_event_floor": -1}' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds || '{"spike_event_floor": 1.5}' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds || '{"spike_event_floor": 1000001}' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = '[]' $$),
        pg_temp.try($$ update public.platform_security_alert_state set thresholds = thresholds || '{"spike_event_floor": 1000000, "volume_pushes_per_day": 0}' $$)],
  array['23505', '23514', '23514', '23514', '23514', '23514', '23514', '23514', '23514', '23514', 'ok'],
  '0480/45: the state is one row (no second, no false key); its thresholds are exactly the ten names, each a whole number from 0 to 1,000,000');
select is(
  array[pg_temp.try($$ update public.platform_security_alert_state set baseline_computed_at = now() $$),
        pg_temp.try($$ update public.platform_security_alert_state set baseline_event_high = 1 $$),
        pg_temp.try($$ update public.platform_security_alert_state set baseline_computed_at = now(), baseline_event_high = -1, baseline_source_high = 0, baseline_from = now(), baseline_to = now(), baseline_shortened = false $$),
        pg_temp.try($$ update public.platform_security_alert_state set baseline_computed_at = now(), baseline_event_high = 0, baseline_source_high = 0, baseline_from = now(), baseline_to = now() - interval '1 second', baseline_shortened = false $$),
        pg_temp.try($$ update public.platform_security_alert_state set baseline_computed_at = now(), baseline_event_high = 0, baseline_source_high = 0, baseline_from = now(), baseline_to = now(), baseline_shortened = false $$),
        pg_temp.try($$ update public.platform_security_alert_state set last_run_id = gen_random_uuid() $$),
        pg_temp.try($$ update public.platform_security_alert_state set last_run_id = gen_random_uuid(), last_run_started_at = now(), last_run_finished_at = now() $$),
        pg_temp.try($$ update public.platform_security_alert_state set last_run_id = gen_random_uuid(), last_run_started_at = now(), last_run_finished_at = now() - interval '1 second', last_run_ok = true $$),
        pg_temp.try($$ update public.platform_security_alert_state set failures_in_a_row = -1 $$),
        pg_temp.try($$ update public.platform_security_alert_state set last_run_id = gen_random_uuid(), last_run_started_at = now(), last_run_finished_at = now(), last_run_ok = false $$)],
  array['23514', '23514', '23514', '23514', 'ok', '23514', '23514', '23514', '23514', 'ok'],
  '0480/46: a baseline is all its fields or none, with marks of 0 or more and its window in order; a heartbeat''s run has a token and a start, a finish with its outcome and not before its start, failures never below 0');
-- An alert row as its owner writes it: unnamed fields of a record-only
-- spike start in the window.
create function pg_temp.raw(p jsonb) returns void language sql as $$
  insert into public.platform_security_alerts
    (rule, class, subject, event_key, phase, counts, disposition, push_planned, email_planned, push_counted,
     push_result, email_result, attempts, claimed_at, resulted_at, state_ended_at)
  select coalesce(p ->> 'rule', 'spike'), coalesce(p ->> 'class', 'volume'), coalesce(p ->> 'subject', ''),
         coalesce(p ->> 'event_key', pg_temp.bk(-3)), coalesce(p ->> 'phase', 'started'),
         coalesce(p -> 'counts', '{}'), coalesce(p ->> 'disposition', 'record_only'),
         coalesce((p ->> 'push_planned')::boolean, false), coalesce((p ->> 'email_planned')::boolean, false),
         coalesce((p ->> 'push_counted')::boolean, false), p -> 'push_result', p -> 'email_result',
         coalesce((p ->> 'attempts')::smallint, 1::smallint), coalesce((p ->> 'claimed_at')::timestamptz, now()),
         (p ->> 'resulted_at')::timestamptz, (p ->> 'state_ended_at')::timestamptz;
$$;
select is(
  array[pg_temp.try($$ select pg_temp.raw('{}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "other"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"class": "serious"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "record_trouble"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"subject": "a0480000-0000-4000-8000-000000000001"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "aimed_guessing"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "aimed_guessing", "subject": "A0480000-0000-4000-8000-000000000001"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "aimed_guessing", "subject": "a0480000-0000-4000-8000-000000000001"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"phase": "begun"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "serious_flag", "class": "serious", "event_key": "sign_in_not_me|2026-11-24T10:00Z", "phase": "ended"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "serious_flag", "class": "serious", "event_key": "sign_in_not_me|2026-11-24T10:00Z"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "serious_flag", "class": "serious", "event_key": "sign_in_not_me|2026-11-24T10:30Z"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"rule": "serious_flag", "class": "serious", "event_key": "Sign_in_not_me|2026-11-24T10:00Z"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"event_key": "2026-11-24T10:25Z"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"event_key": "2026-11-24T10:20Z+1h"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"event_key": "2026-11-24T10:20Z+1h", "phase": "reminder"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"event_key": "2026-11-24T10:20Z+2h", "phase": "reminder"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"event_key": "2026-11-24T10:20Z", "phase": "reminder"}') $$)],
  array['ok', '23514', '23514', '23514', '23514', '23514', '23514', 'ok', '23514', '23514', 'ok', '23514', '23514',
        '23514', '23514', 'ok', '23514', '23514'],
  '0480/47: a rule of the four with its own class; an organization id (in lower case) as the subject of aimed guessing and only of it; a phase of the three, a serious flag only started; a key of its rule''s shape (reason and whole hour; a 10-minute start; a reminder with its step)');
select is(
  array[pg_temp.try($$ select pg_temp.raw('{"counts": []}') $$),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('counts', jsonb_build_object('x', repeat('a', 4000))))),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "deferred"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "sent"}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "sent", "email_planned": true}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "email_only_budget", "email_planned": true, "push_planned": true}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "record_only", "email_planned": true}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "held_planned_check", "push_counted": true}') $$),
        pg_temp.try($$ select pg_temp.raw('{"phase": "ended", "push_counted": true}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "sent", "email_planned": true, "email_result": {"sent": 1}}') $$),
        pg_temp.try($$ select pg_temp.raw('{"disposition": "sent", "email_planned": true, "email_result": {"sent": 1}, "resulted_at": "2000-01-01T00:00:00Z"}') $$),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('disposition', 'sent', 'email_planned', true, 'email_result', '{"sent": 1}'::jsonb, 'resulted_at', now()))),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('disposition', 'sent', 'email_planned', true, 'push_result', '{"sent": 1}'::jsonb, 'email_result', '{"sent": 1}'::jsonb, 'resulted_at', now()))),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('disposition', 'not_sent', 'email_planned', true, 'email_result', '{"sent": 1}'::jsonb, 'resulted_at', now()))),
        pg_temp.try($$ select pg_temp.raw('{"attempts": 3}') $$),
        pg_temp.try($$ select pg_temp.raw('{"attempts": 0}') $$),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('phase', 'reminder', 'event_key', pg_temp.bk(-3) || '+1h', 'state_ended_at', now()))),
        pg_temp.try(format('select pg_temp.raw(%L)', jsonb_build_object('state_ended_at', now())))],
  array['23514', '23514', '23514', '23514', 'ok', '23514', '23514', '23514', '23514', '23514', '23514', 'ok', '23514',
        '23514', '23514', '23514', '23514', 'ok'],
  '0480/48: counts an object of at most 4,000 characters; a disposition of the five, each handing out what it may (sent at least one channel, email only never push, record only and held nothing); an end and a held alert use no push slot; a result for each channel handed out and only those, not before the claim, never on a not_sent alert; one or two attempts; an end time only on a started row');
-- A serious flag's email floor and the summary's hold, as the owner would
-- write them.
create function pg_temp.ins(p_rule text, p_disp text, p_push boolean, p_email boolean, p_floor text,
                            p_result boolean default false) returns text language plpgsql as $$
begin
  return pg_temp.try(format(
    'insert into public.platform_security_alerts (rule, class, event_key, phase, disposition, push_planned, email_planned, '
    'email_floor, push_result, email_result, resulted_at) values (%L, %L, %L, ''started'', %L, %L, %L, %L, %L, %L, %L)',
    p_rule, case p_rule when 'serious_flag' then 'serious' when 'record_trouble' then 'record' when 'alerts_held' then 'notice'
                        else 'volume' end,
    case p_rule when 'serious_flag' then 'sign_in_not_me|2026-11-24T10:00Z' else '2026-11-24T10:20Z' end,
    p_disp, p_push, p_email, p_floor,
    case when p_result and p_push then '{"failed": 1}' end, case when p_result and p_email then '{"sent": 1}' end,
    case when p_result then now() end));
end;
$$;
select is(
  array[pg_temp.ins('spike', 'held_for_summary', false, false, null),
        pg_temp.ins('spike', 'held_for_summary', false, true, null),
        pg_temp.ins('serious_flag', 'email_only_budget', false, true, 'push_budget_spent'),
        pg_temp.ins('serious_flag', 'not_sent', false, true, 'push_budget_spent'),
        pg_temp.ins('serious_flag', 'sent', true, true, 'push_failed', true),
        pg_temp.ins('serious_flag', 'sent', true, true, 'push_failed'),
        pg_temp.ins('serious_flag', 'sent', true, true, 'push_budget_spent'),
        pg_temp.ins('serious_flag', 'email_only_budget', false, false, 'push_budget_spent'),
        pg_temp.ins('serious_flag', 'email_only_budget', false, true, 'email_off'),
        pg_temp.ins('spike', 'email_only_budget', false, true, 'push_budget_spent'),
        pg_temp.ins('record_trouble', 'sent', true, true, 'push_failed', true),
        pg_temp.ins('spike', 'held_with_notice', false, false, null),
        pg_temp.ins('spike', 'held_with_notice', true, false, null),
        pg_temp.ins('alerts_held', 'sent', false, true, null),
        pg_temp.ins('alerts_held', 'sent', true, false, null),
        pg_temp.ins('alerts_held', 'sent', false, true, 'push_budget_spent'),
        pg_temp.try($$ insert into public.platform_security_alerts (rule, class, event_key, phase, disposition) values ('alerts_held', 'volume', '2026-11-24T10:20Z', 'started', 'record_only') $$),
        pg_temp.try($$ insert into public.platform_security_alerts (rule, class, event_key, phase, disposition) values ('alerts_held', 'notice', '2026-11-24T10:20Z', 'ended', 'record_only') $$),
        pg_temp.try($$ insert into public.platform_security_alerts (rule, class, event_key, phase, disposition, state_ended_at) values ('alerts_held', 'notice', '2026-11-24T10:20Z', 'started', 'record_only', now()) $$)],
  array['ok', '23514', 'ok', 'ok', 'ok', '23514', '23514', '23514', '23514', '23514', '23514',
        'ok', '23514', 'ok', 'ok', '23514', '23514', '23514', '23514'],
  '0480/49: held for the summary or with a notice hands out nothing; the notice that more alerts are held (alerts_held) is its own class, started only, never a state; an email that went although email alerts were off is a serious flag''s only, and says why: the push budget was spent (no push), or the push reached no one (after its result)');
select is(
  array[pg_temp.try($$ select pg_temp.raw('{}'), pg_temp.raw('{}') $$),
        pg_temp.try($$ select pg_temp.raw('{}'), pg_temp.raw('{"phase": "ended"}') $$),
        pg_temp.try($$ select pg_temp.raw('{}'), pg_temp.raw('{"rule": "record_trouble", "class": "record"}') $$),
        pg_temp.try($$ insert into public.platform_security_alerts (rule, class, subject, event_key, phase, disposition) values ('spike', 'volume', null, '2026-11-24T10:20Z', 'started', 'record_only') $$)],
  array['23505', 'ok', 'ok', '23502'],
  '0480/50: one row per (rule, subject, event_key, phase): the same alert twice is refused, another phase or rule is another row, and a subject cannot be null (M9: '''' for none, so the key holds for rules with no subject)');
select is(
  array[pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'push_on', 'false', 'true') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'push_on', 'true', 'true') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'push_on', '1', '0') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'sound_on', '1', '2') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (null, 'push_on', 'false', 'true') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'planned_check', null, '"2026-11-24T10:00:00+00:00"') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'planned_check', null, '30') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'spike_event_floor', '50', '60') $$),
        pg_temp.try($$ insert into public.platform_security_alert_changes (actor_user_id, name, old_value, new_value) values (gen_random_uuid(), 'spike_event_floor', '50', 'true') $$)],
  array['ok', '23514', '23514', '23514', '23502', 'ok', '23514', 'ok', '23514'],
  '0480/51: a change row names one of the fourteen settings and an actor, and goes from one value to another of its kind (a switch boolean, a planned check an end time or none, a threshold a number)');

-- ── 6. What the job reads ───────────────────────────────────────────────────
savepoint inputs_fixture;
-- A made-up record. In the window (b-47 to now): a passkey counter that went
-- back at its first minute; one "not me" sign-in recorded in three
-- organizations (one unit) and another in a fourth (2); our server's form
-- counted 7 (a tally); a flood row of 30 flagged events and one of 40
-- blocked; a buffer flood of 5; the four guessing reasons for organization
-- 5 (8, 6 + 4, 3) and 6 (2), a wrong password (not a guessing reason) and
-- an organization-less repeat; 100 allowed events; three sources in b-6
-- (and one allowed source that does not count). Before the window: a "not
-- me" a minute before its start.
select pg_temp.ev(pg_temp.at(-48, 9), 'phishing', 'flagged', 'sign_in_not_me', 'web', pg_temp.o(1), 'SE', 'Example Sound');
select pg_temp.ev(pg_temp.at(-47, 0), 'password_guessing', 'flagged', 'passkey_counter_went_back', 'web', pg_temp.o(1));
select pg_temp.ev(pg_temp.at(-10, 3), 'phishing', 'flagged', 'sign_in_not_me', 'web', pg_temp.o(g), 'SE', 'Example Sound')
  from generate_series(1, 3) g;
select pg_temp.ev(pg_temp.at(-10, 4), 'phishing', 'flagged', 'sign_in_not_me', 'web', pg_temp.o(4), 'NO', null, 2);
select pg_temp.ev(pg_temp.at(-5, 1), 'password_guessing', 'flagged', 'unrecorded_server_form_password', 'api', null, null, null, 7);
select pg_temp.ev(pg_temp.at(-5, 2), 'exploit', 'flagged', 'over_minute_cap', 'web', pg_temp.o(2), null, null, 30);
select pg_temp.ev(pg_temp.at(-5, 2), 'exploit', 'blocked', 'over_minute_cap', 'web', null, null, null, 40);
select pg_temp.ev(pg_temp.at(-4, 0), 'bots', 'blocked', 'over_buffer_cap', 'web', null, null, null, 5);
select pg_temp.ev(pg_temp.at(-4, 1), 'password_guessing', 'blocked', 'auth_log_over_cap', 'web', null, null, null, 2);
select pg_temp.ev(pg_temp.at(-3, 0), 'password_guessing', 'blocked', 'repeated_wrong_password', 'web', pg_temp.o(5), null, null, 8);
select pg_temp.ev(pg_temp.at(-2, 0), 'password_guessing', 'blocked', 'sign_in_paused', 'web', pg_temp.o(5), null, null, 6);
select pg_temp.ev(pg_temp.at(-2, 5), 'password_guessing', 'blocked', 'code_checks_paused', 'web', pg_temp.o(5), null, null, 4);
select pg_temp.ev(pg_temp.at(-1, 0), 'password_guessing', 'blocked', 'repeated_wrong_code', 'web', pg_temp.o(5), null, null, 3);
select pg_temp.ev(pg_temp.at(-1, 1), 'password_guessing', 'blocked', 'repeated_wrong_password', 'web', pg_temp.o(6), null, null, 2);
select pg_temp.ev(pg_temp.at(-2, 1), 'password_guessing', 'blocked', 'wrong_password', 'web', pg_temp.o(5), null, null, 50);
select pg_temp.ev(pg_temp.at(-2, 2), 'password_guessing', 'blocked', 'repeated_wrong_password', 'web', null, null, null, 9);
select pg_temp.ev(pg_temp.at(-6, 0), 'bots', 'allowed', 'public_order_paused', 'web', null, null, null, 100);
select pg_temp.ev(pg_temp.at(-6, 1), 'exploit', 'blocked', 'env_file', 'web', null, 'US', null, 1, pg_temp.h(1));
select pg_temp.ev(pg_temp.at(-6, 2), 'exploit', 'blocked', 'env_file', 'web', null, 'US', null, 1, pg_temp.h(2));
select pg_temp.ev(pg_temp.at(-6, 3), 'exploit', 'blocked', 'env_file', 'web', null, 'US', null, 1, pg_temp.h(1));
select pg_temp.ev(pg_temp.at(-6, 4), 'phishing', 'flagged', 'sign_in_new_country', 'web', pg_temp.o(3), 'FR', null, 1, pg_temp.h(3));
select pg_temp.ev(pg_temp.at(-6, 5), 'bots', 'allowed', 'public_order_paused', 'web', null, null, null, 1, pg_temp.h(4));
create temporary table inputs_ans as select pg_temp.inp() as a;
select is(
  (select pg_temp.keys_of(a) from inputs_ans),
  array['aimed', 'aimed_truncated', 'baseline', 'bucket_seconds', 'buckets', 'generated_at', 'oldest_event_at',
        'open_states', 'open_states_truncated', 'planned_check_until', 'refused', 'retry_due', 'retry_due_truncated',
        'serious', 'serious_retry_due', 'serious_retry_due_truncated', 'shortened', 'switches', 'thresholds', 'window'],
  '0480/52: the inputs answer has exactly its documented keys');
select is(
  (select array[a -> 'window' ->> 'asked_from', a -> 'window' ->> 'from', a -> 'window' ->> 'to', a ->> 'shortened',
                a ->> 'refused', a ->> 'bucket_seconds', a ->> 'oldest_event_at']
     from inputs_ans),
  array[to_jsonb(pg_temp.b(-47)) #>> '{}', to_jsonb(pg_temp.b(-47)) #>> '{}', to_jsonb(now() + interval '1 minute') #>> '{}',
        'false', null, '600', to_jsonb(pg_temp.at(-48, 9)) #>> '{}'],
  '0480/53: the window starts at the first whole 10-minute bucket within the last 8 hours (b-47) and ends a minute after now; not shortened; the oldest minute on record is given (a row before the window)');
select is(
  (select array_agg(e ->> 'event_key' || '|' || (e ->> 'flagged_in_flood') || '|' || (e ->> 'events') || '|'
                    || (e ->> 'at_least') || '|' || (e ->> 'tally') order by e ->> 'event_key', e ->> 'flagged_in_flood')
     from inputs_ans, jsonb_array_elements(pg_temp.arr(a -> 'serious')) e),
  (select array_agg(x order by x) from unnest(array[
     pg_temp.hk('passkey_counter_went_back', pg_temp.at(-47, 0)) || '|false|1|false|false',
     pg_temp.hk('sign_in_not_me', pg_temp.at(-10, 3)) || '|false|3|true|false',
     pg_temp.hk('unrecorded_server_form_password', pg_temp.at(-5, 1)) || '|false|7|false|true',
     pg_temp.hk('over_minute_cap', pg_temp.at(-5, 2)) || '|true|30|false|false']) x),
  '0480/54: the serious flags by reason and the event''s UTC hour, each with its key: the "not me" recorded in three organizations counted once (1, a floor) and the other 2, so 3 at least; our server''s form marked a tally; the flagged flood row as flagged_in_flood; the row a minute before the window is not read');
select is(
  (select array_agg((e ->> 'organization_id') || ':' || (e ->> 'events') || ':'
                    || (select string_agg((c ->> 'bucket_key') || '=' || (c ->> 'events'), ',' order by c ->> 'bucket_key')
                          from jsonb_array_elements(pg_temp.arr(e -> 'buckets')) c) order by o)
     from inputs_ans, jsonb_array_elements(pg_temp.arr(a -> 'aimed')) with ordinality x(e, o)),
  array[pg_temp.o(5) || ':21:' || pg_temp.bk(-3) || '=8,' || pg_temp.bk(-2) || '=10,' || pg_temp.bk(-1) || '=3',
        pg_temp.o(6) || ':2:' || pg_temp.bk(-1) || '=2'],
  '0480/55: the four guessing reasons per organization and bucket, the busiest first; a wrong password and a repeat with no organization are not counted');
select is(
  (select array_agg((e ->> 'bucket_key') || ':' || (e ->> 'events') || ':' || (e ->> 'sources') || ':'
                    || (e ->> 'trouble_rows') || ':' || (e ->> 'trouble_events') order by e ->> 'bucket_key')
     from inputs_ans, jsonb_array_elements(pg_temp.arr(a -> 'buckets')) e
    where (e ->> 'events')::int > 0 or (e ->> 'sources')::int > 0 or (e ->> 'trouble_rows')::int > 0),
  array[pg_temp.bk(-47) || ':1:0:0:0', pg_temp.bk(-10) || ':3:0:0:0', pg_temp.bk(-6) || ':4:3:0:0',
        pg_temp.bk(-5) || ':70:0:2:70', pg_temp.bk(-4) || ':7:0:1:5', pg_temp.bk(-3) || ':8:0:0:0',
        pg_temp.bk(-2) || ':69:0:0:0', pg_temp.bk(-1) || ':5:0:0:0'],
  '0480/56: each bucket''s counted blocked and flagged events (the folded "not me" once, no tally, no allowed event), its distinct sources (three, not the allowed one) and its flood rows of over_minute_cap and over_buffer_cap (an auth_log_over_cap row counts as events, not as record trouble)');
select is(
  (select array[pg_temp.alen(a -> 'buckets')::text,
                (a -> 'buckets' -> 0 ->> 'bucket_start'),
                (a -> 'buckets' -> -1 ->> 'bucket_start'),
                (select string_agg(e ->> 'partial', ',' order by o) from jsonb_array_elements(pg_temp.arr(a -> 'buckets')) with ordinality x(e, o)
                  where (e ->> 'partial')::boolean)]
     from inputs_ans),
  array['48', to_jsonb(pg_temp.b(-47)) #>> '{}', to_jsonb(pg_temp.b(0)) #>> '{}', 'true'],
  '0480/57: every bucket of the window is listed, empty ones too (48, b-47 to the bucket running now), and only the one running now is partial');
select is(
  (select array[(a::text ~ '[0-9a-f]{32}')::text, (a::text like '%' || pg_temp.h(1) || '%')::text,
                (a::text ~* 'source_hash|dedupe|city|country')::text]
     from inputs_ans),
  array['false', 'false', 'false'],
  '0480/58: the answer holds no source hash, no row key and no place: no 32 hex characters anywhere, and no key for them');
-- An event at minute 59 of an hour: its key is that hour, whichever second
-- the run reads it at.
select pg_temp.ev(date_trunc('hour', pg_temp.at(-20), 'UTC') + interval '59 minutes', 'phishing', 'flagged',
                  'passkey_unexplained_sign_in', 'web', pg_temp.o(9));
select is(
  (select e ->> 'event_key' from jsonb_array_elements(pg_temp.arr(pg_temp.inp() -> 'serious')) e
    where e ->> 'reason' = 'passkey_unexplained_sign_in'),
  'passkey_unexplained_sign_in|' || to_char(date_trunc('hour', pg_temp.at(-20), 'UTC') at time zone 'UTC', 'YYYY-MM-DD"T"HH24') || ':00Z',
  '0480/59: an hour edge (M9): an event at minute 59 of an hour has that hour in its key, from the event, not from the run''s clock');
rollback to savepoint inputs_fixture;

-- The busiest 100 organizations, and the rest said.
savepoint aimed_cap;
select pg_temp.ev(pg_temp.at(-2, 0), 'password_guessing', 'blocked', 'sign_in_paused', 'web', pg_temp.o(g), null, null, g)
  from generate_series(1, 101) g;
select is(
  (select array[pg_temp.alen(a -> 'aimed')::text, a ->> 'aimed_truncated', a -> 'aimed' -> 0 ->> 'organization_id',
                a -> 'aimed' -> 99 ->> 'organization_id']
     from (select pg_temp.inp() as a) x),
  array['100', 'true', pg_temp.o(101)::text, pg_temp.o(2)::text],
  '0480/60: at most 100 organizations are listed, the busiest first, and the answer says more were seen');
rollback to savepoint aimed_cap;

-- The row ceiling: exactly 400,000 rows in the window are read as asked;
-- one more and the window is read from the minute after the oldest minute
-- the ceiling reaches.
savepoint row_ceiling;
insert into public.security_events (minute, category, outcome, reason, source, event_count, dedupe_key)
select pg_temp.at(-30, 0), 'bots', 'blocked', 'public_order_paused', 'web', 1, md5('a0480-ceiling-' || g)
  from generate_series(1, 399999) g;
select pg_temp.ev(pg_temp.at(-30, 1), 'exploit', 'blocked', 'env_file', 'web', null, null, null, 5);
select is(
  (select array[a ->> 'shortened', a -> 'window' ->> 'from',
                (select sum((e ->> 'events')::int) from jsonb_array_elements(pg_temp.arr(a -> 'buckets')) e)::text]
     from (select pg_temp.inp() as a) x),
  array['false', to_jsonb(pg_temp.b(-47)) #>> '{}', '400004'],
  '0480/61: a window that holds exactly the ceiling (400,000 rows) is read as asked, every row counted');
select pg_temp.ev(pg_temp.at(-30, 1), 'exploit', 'blocked', 'git_dir', 'web', null, null, null, 3);
select is(
  (select array[a ->> 'shortened', a -> 'window' ->> 'from', a -> 'window' ->> 'asked_from',
                (select sum((e ->> 'events')::int) from jsonb_array_elements(pg_temp.arr(a -> 'buckets')) e)::text,
                (a -> 'buckets' -> 0 ->> 'partial')]
     from (select pg_temp.inp() as a) x),
  array['true', to_jsonb(pg_temp.at(-30, 1)) #>> '{}', to_jsonb(pg_temp.b(-47)) #>> '{}', '8', 'true'],
  '0480/62: one row more and the window is read from the minute after (at -30 +1), says so with the start asked for, and counts only what it read (its first bucket marked partial)');
rollback to savepoint row_ceiling;

-- The thresholds, the baseline marks with their floors, the switches, the
-- planned check while on.
savepoint inputs_state;
select is(
  (select array[a -> 'baseline' ->> 'event_mark', a -> 'baseline' ->> 'source_mark', a -> 'baseline' ->> 'computed_at',
                (a -> 'thresholds')::text, (a -> 'switches')::text, a ->> 'planned_check_until']
     from (select pg_temp.inp() as a) x),
  array['50', '10', null,
        (select thresholds::text from public.platform_security_alert_state),
        '{"push_on": false, "email_on": false, "summary_on": false}', null],
  '0480/63: with no baseline the marks are the floors (50 events, 10 sources); the thresholds and the switches are the state''s');
update public.platform_security_alert_state
   set baseline_event_high = 120, baseline_source_high = 4, baseline_from = now() - interval '7 days', baseline_to = now(),
       baseline_shortened = false, baseline_computed_at = now(), email_on = true, planned_check_until = now() + interval '10 minutes';
select is(
  (select array[a -> 'baseline' ->> 'event_mark', a -> 'baseline' ->> 'source_mark', a -> 'baseline' ->> 'event_high',
                (a -> 'switches')::text, a ->> 'planned_check_until']
     from (select pg_temp.inp() as a) x),
  array['120', '10', '120', '{"push_on": false, "email_on": true, "summary_on": false}', to_jsonb(now() + interval '10 minutes') #>> '{}'],
  '0480/64: a stored high above its floor is the mark, one below is not (a floor of 10 sources against a high of 4); a planned check on is given');
update public.platform_security_alert_state set planned_check_until = now() - interval '1 second';
select is((select pg_temp.inp() ->> 'planned_check_until'), null,
  '0480/65: a planned check that has ended is not given');
rollback to savepoint inputs_state;
savepoint no_state;
delete from public.platform_security_alert_state;
select is(
  array[pg_temp.inp() - 'generated_at', pg_temp.lst() - 'generated_at', pg_temp.claim('spike', '', pg_temp.bk(-3)),
        pg_temp.hb('start'), pg_temp.setv(pg_temp.u(1), 'push_on', 'true'), pg_temp.base()],
  array['{"window": null, "refused": "no_state"}'::jsonb, '{"refused": "no_state"}'::jsonb,
        '{"outcome": "refused", "refused": "no_state", "id": null, "disposition": null, "push": false, "email": false, "attempt": null, "open_key": null, "notice": null}'::jsonb,
        '{"step": "start", "refused": "no_state"}'::jsonb,
        '{"changed": false, "refused": "unknown_actor", "name": "push_on", "old_value": null, "new_value": null, "changed_at": null}'::jsonb,
        '{"computed": false, "refused": "no_state"}'::jsonb],
  '0480/66: with the state row gone (only its owner can delete it) every function answers no_state and none raises (the set refuses an unknown actor first)');
rollback to savepoint no_state;
savepoint zone;
set local timezone = 'Pacific/Honolulu';
select is(
  (select array[(a ->> 'generated_at') like '%+00:00', (a -> 'window' ->> 'to') like '%+00:00',
                (l ->> 'generated_at') like '%+00:00', (h ->> 'run_id') is not null]
     from (select pg_temp.inp() as a, pg_temp.lst() as l, pg_temp.hb('start') as h) x),
  array[true, true, true, true],
  '0480/67: every time is written in UTC whatever the session''s time zone is');
rollback to savepoint zone;

-- ── 7. The claim: refusals ──────────────────────────────────────────────────
create function pg_temp.refused(p jsonb) returns text language sql immutable as $$
  select coalesce(p ->> 'refused', p ->> 'raised', p ->> 'outcome');
$$;
select is(
  array[pg_temp.refused(pg_temp.claim(null, '', pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('Spike', '', pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('new_kind', '', pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3), null)),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3), 'start')),
        pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()), 'reminder')),
        pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()), 'ended')),
        pg_temp.refused(pg_temp.claim('aimed_guessing', '', pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('aimed_guessing', null, pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('aimed_guessing', 'example org', pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('aimed_guessing', pg_temp.o(1)::text || ' ', pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('spike', pg_temp.o(1)::text, pg_temp.bk(-3))),
        pg_temp.refused(pg_temp.claim('serious_flag', ' ', pg_temp.hk('sign_in_not_me', now())))],
  array['not_a_rule', 'not_a_rule', 'not_a_rule', 'not_a_phase', 'not_a_phase', 'not_a_phase', 'not_a_phase',
        'not_a_subject', 'not_a_subject', 'not_a_subject', 'not_a_subject', 'not_a_subject', 'not_a_subject'],
  '0480/68: a rule not of the four, a phase not of the three, a serious flag other than started, aimed guessing without an organization id, or a subject for a rule that has none, is refused with its word');
select is(
  array[pg_temp.refused(pg_temp.claim('serious_flag', '', null)),
        pg_temp.refused(pg_temp.claim('serious_flag', '', '')),
        pg_temp.refused(pg_temp.claim('serious_flag', '', repeat('a', 81))),
        pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('wrong_password', now()))),
        pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_new_country', now()))),
        pg_temp.refused(pg_temp.claim('serious_flag', '', replace(pg_temp.hk('sign_in_not_me', now()), ':00Z', ':10Z'))),
        pg_temp.refused(pg_temp.claim('serious_flag', '', replace(pg_temp.hk('sign_in_not_me', now()), '|', ':'))),
        pg_temp.refused(pg_temp.claim('serious_flag', '', 'sign_in_not_me|2026-02-30T10:00Z')),
        pg_temp.refused(pg_temp.claim('serious_flag', '', 'sign_in_not_me|' || to_char(date_trunc('day', now() - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD') || 'T24:00Z')),
        pg_temp.refused(pg_temp.claim('serious_flag', '', 'sign_in_not_me|' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD') || 'T7:00Z')),
        pg_temp.refused(pg_temp.claim('spike', '', replace(pg_temp.bk(-3), '0Z', '5Z'))),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3) || '+1h')),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3), 'reminder')),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3) || '+2h', 'reminder')),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3) || '+1h', 'ended')),
        pg_temp.refused(pg_temp.claim('spike', '', replace(pg_temp.bk(-3), 'Z', ':00Z'))),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.hk('sign_in_not_me', now())))],
  array_fill('not_a_key'::text, array[17]),
  '0480/69: a key not of its rule''s shape is refused: none, empty, too long, a reason that is not a serious flag, an hour not whole, another separator, a day that is not one, 24:00 (another spelling of the next day), a one-digit hour, a start not on a 10-minute bucket, a step on a start or an end, a reminder with no step or another step, seconds, another rule''s shape');
select is(
  array[pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now() - interval '9 hours'))),
        pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now() + interval '2 hours'))),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-49))),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(2))),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(2), 'ended')),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(2) || '+1h', 'reminder')),
        (pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now() - interval '8 hours')) ->> 'outcome'),
        (pg_temp.claim('spike', '', pg_temp.bk(-48)) ->> 'outcome'),
        (pg_temp.claim('serious_flag', '', pg_temp.hk('auth_log_over_cap', now())) ->> 'outcome'),
        (pg_temp.claim('serious_flag', '', pg_temp.hk('over_buffer_cap', now())) ->> 'outcome')],
  array['key_out_of_window', 'key_out_of_window', 'key_out_of_window', 'key_out_of_window', 'key_out_of_window',
        'key_out_of_window', 'new', 'new', 'new', 'new'],
  '0480/70: a key outside the read''s window is refused: a serious flag of 9 hours back or of a later hour, a start older than the window or in the future (any phase); the hour of 8 hours back and the bucket of 8 hours back are taken, and a flood reason''s key (the flagged flood rows) is a serious flag''s');
select pg_temp.fresh();
select is(
  (select array_agg(pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-3), 'started', c.v)) order by c.o)
     from (values (1, '[]'::jsonb), (2, '"x"'), (3, '1'), (4, 'null'),
                  (5, '{"Events": 1}'), (6, '{"events": -1}'), (7, '{"events": 1.5}'), (8, '{"events": 12345678901234}'),
                  (9, '{"events": null}'), (10, '{"reason": "Not A Code"}'), (11, '{"reason": "someone@example.test"}'),
                  (12, '{"reasons": ["env_file", "x-y"]}'), (13, '{"reasons": [["env_file"]]}'), (14, '{"reasons": [true]}'),
                  (15, '{"by_country": {"Us": 1}}'), (16, '{"by_country": {"US": "1"}}'), (17, '{"by_country": {"US": {"x": 1}}}'),
                  (18, '{"place": "192.0.2.1"}'), (19, '{"organization": "a0480000-0000-4000-8000-000000000001"}'),
                  (20, (select jsonb_object_agg('k' || g, 1) from generate_series(1, 41) g)),
                  (21, jsonb_build_object('reasons', (select jsonb_agg('env_file'::text) from generate_series(1, 51)))),
                  (22, jsonb_build_object('by_country', (select jsonb_object_agg('k' || g, 1) from generate_series(1, 51) g))),
                  (23, jsonb_build_object('reasons', (select jsonb_agg('r' || repeat('a', 46)) from generate_series(1, 50) g),
                                          'more', (select jsonb_agg('r' || repeat('b', 46)) from generate_series(1, 50) g)))) c(o, v))
  || array[(select count(*)::text from public.platform_security_alerts)],
  array_fill('not_counts'::text, array[23]) || array['0'],
  '0480/71: counts must be numbers and reason codes only: an object of reason-code keys whose values are whole numbers, booleans, reason codes, short lists of those, or small objects of reason codes or country codes to numbers; at most 40 keys and 4,000 characters; nothing refused wrote a row');
select is(
  pg_temp.claim('spike', '', pg_temp.bk(-3), 'started',
                '{"events": 0, "sources": 1234567890123, "at_least": true, "reason": "env_file", "reasons": ["env_file", "git_dir", 3],
                  "by_country": {"US": 4, "SE": 0}, "by_reason": {"env_file": 2}}') ->> 'outcome',
  'new',
  '0480/72: every allowed form of counts is taken');
select is(
  (select counts from public.platform_security_alerts where rule = 'spike'),
  '{"events": 0, "sources": 1234567890123, "at_least": true, "reason": "env_file", "reasons": ["env_file", "git_dir", 3],
    "by_country": {"US": 4, "SE": 0}, "by_reason": {"env_file": 2}}'::jsonb,
  '0480/73: and stored as given');
savepoint no_raise;
select is(
  (select count(*)::int
     from unnest(array['serious_flag', 'spike', 'aimed_guessing', 'record_trouble', null, 'x']) r(rule),
          unnest(array[null, '', 'x', 'started', 'reminder', 'ended', '2026-13-45T99:90Z', '2026-02-30T10:00Z',
                       'sign_in_not_me|2026-13-45T99:00Z', 'sign_in_not_me|2026-02-30T10:00Z',
                       pg_temp.o(1)::text]) v(p),
          unnest(array['started', 'reminder', 'ended']) ph(phase),
          lateral (select coalesce(pg_temp.claim(r.rule, v.p, v.p, v.p, '{"x": []}') ->> 'raised',
                                   pg_temp.claim(r.rule, '', v.p, ph.phase, '{"x": []}') ->> 'raised',
                                   pg_temp.claim(r.rule, v.p, v.p || '+1h', 'reminder', '{"x": []}') ->> 'raised',
                                   pg_temp.claim(r.rule, '', '2026-02-30T10:00Z', ph.phase) ->> 'raised') as raised) z
    where z.raised is not null),
  0,
  '0480/74: no argument makes the claim raise: every rule (and none) with null, empty, wrong and impossible values, keys and times in every phase');
rollback to savepoint no_raise;

-- ── 8. The claim: one row per alert (M9) ────────────────────────────────────
select pg_temp.fresh();
create temporary table c1 as
  select pg_temp.claim('serious_flag', null, pg_temp.hk('sign_in_not_me', pg_temp.at(-12)), 'started', '{"events": 1}') as a;
create temporary table c2 as
  select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-12)), 'started', '{"events": 2}') as a;
select is(
  (select array[pg_temp.keys_of(c1.a)::text, c1.a ->> 'outcome', c1.a ->> 'disposition', c1.a ->> 'push', c1.a ->> 'email',
                c1.a ->> 'attempt', c2.a ->> 'outcome', (c2.a ->> 'id' = c1.a ->> 'id')::text, c2.a ->> 'push', c2.a ->> 'email']
     from c1, c2),
  array['{attempt,disposition,email,id,notice,open_key,outcome,push,refused}', 'new', 'record_only', 'false', 'false', '1',
        'duplicate', 'true', 'false', 'false'],
  '0480/75: two runs claim the same serious flag (one with a subject of null, one of ''''): the first is new, the second a duplicate of the same row and sends nothing (M9: no hole for a missing subject)');
select is(
  (select array[count(*)::text, min(subject), min(event_key), min(counts::text), (min(claimed_at) = now())::text]
     from public.platform_security_alerts),
  array['1', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-12)), '{"events": 1}', 'true'],
  '0480/76: exactly one row, subject '''', its key the event''s hour (not the run''s), the first claim''s counts');
-- (A statement's own subqueries see the rows as they were when it began, so
-- each check of a table reads it in a statement after the calls.)
create temporary table c3 as
  select array[pg_temp.claim('aimed_guessing', upper(pg_temp.o(3)::text), pg_temp.bk(-2)) ->> 'outcome',
               pg_temp.claim('aimed_guessing', pg_temp.o(3)::text, pg_temp.bk(-2)) ->> 'outcome',
               pg_temp.claim('spike', null, pg_temp.bk(-2)) ->> 'outcome',
               pg_temp.claim('spike', '', pg_temp.bk(-2)) ->> 'outcome'] as a;
select is(
  (select a from c3)
  || array[(select count(*)::text from public.platform_security_alerts),
           (select subject from public.platform_security_alerts where rule = 'aimed_guessing')],
  array['new', 'duplicate', 'new', 'duplicate', '3', pg_temp.o(3)::text],
  '0480/77: an organization written in capitals is the same alert, stored in lower case; a spike with a subject of null and of '''' is one alert');
select is(
  array[pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', date_trunc('hour', pg_temp.at(-12), 'UTC') + interval '59 minutes')) ->> 'outcome',
        pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', date_trunc('hour', pg_temp.at(-12), 'UTC') + interval '1 hour')) ->> 'outcome',
        pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', pg_temp.at(-12))) ->> 'outcome'],
  array['duplicate', 'new', 'new'],
  '0480/78: an hour edge (M9): an event at minute 59 of the hour of an alert is that alert; an event at the next hour''s first minute, or of another reason, is another');

-- ── 9. The claim: the one retry, then not_sent (M9) ─────────────────────────
select pg_temp.fresh();
select pg_temp.sw(true, true);
create temporary table r1 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) as a;
select pg_temp.age((select (a ->> 'id')::uuid from r1), interval '4 minutes 59 seconds');
create temporary table r2 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) as a;
select pg_temp.age((select (a ->> 'id')::uuid from r1), interval '1 second');
create temporary table r3 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) as a;
create temporary table r4 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) as a;
select is(
  (select array[r1.a ->> 'outcome', r1.a ->> 'push', r1.a ->> 'email', r2.a ->> 'outcome', r3.a ->> 'outcome',
                r3.a ->> 'attempt', r3.a ->> 'push', r3.a ->> 'email', (r3.a ->> 'id' = r1.a ->> 'id')::text, r4.a ->> 'outcome',
                (select attempts || ':' || (claimed_at = now())::text from public.platform_security_alerts)]
     from r1, r2, r3, r4),
  array['new', 'true', 'true', 'duplicate', 'retry', '2', 'true', 'true', 'true', 'duplicate', '2:true'],
  '0480/79: a claim with no result is not sent again before 5 minutes; at 5 minutes the next claim gets it once more (attempt 2, the same channels), and the one after is a duplicate again');
select pg_temp.age((select (a ->> 'id')::uuid from r1), interval '5 minutes');
select is(
  array[pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) - 'id',
        pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) - 'id'],
  array['{"outcome": "not_sent", "refused": null, "disposition": "not_sent", "push": false, "email": false, "attempt": 2, "open_key": null, "notice": null}'::jsonb,
        '{"outcome": "duplicate", "refused": null, "disposition": "not_sent", "push": false, "email": false, "attempt": 2, "open_key": null, "notice": null}'::jsonb],
  '0480/80: with no result 5 minutes after the second, it is marked not_sent and never handed out again');
select is(
  array[(select pg_temp.res((a ->> 'id')::uuid, 2, '{"sent": 1}', '{"sent": 1}') ->> 'refused' from r1),
        (select disposition from public.platform_security_alerts)],
  array['not_sent_already', 'not_sent'],
  '0480/81: a late result for a not_sent alert is refused: the console shows it as not sent');
-- A claim answered with a result is never handed out again.
create temporary table r5 as select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', pg_temp.at(-3))) as a;
select pg_temp.res((select (a ->> 'id')::uuid from r5), 1, '{"sent": 1}', '{"sent": 2}');
select pg_temp.age((select (a ->> 'id')::uuid from r5), interval '1 hour');
select is(
  pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', pg_temp.at(-3))) ->> 'outcome',
  'duplicate',
  '0480/82: an alert whose result came is a duplicate however old (no retry)');
-- A record-only alert needs no result and is never retried.
select pg_temp.sw(false, false);
create temporary table r6 as select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_unexplained_sign_in', pg_temp.at(-3))) as a;
select pg_temp.age((select (a ->> 'id')::uuid from r6), interval '1 hour');
select is(
  array[pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_unexplained_sign_in', pg_temp.at(-3))) ->> 'outcome',
        (select pg_temp.res((a ->> 'id')::uuid, 1, '{"sent": 1}') ->> 'refused' from r6)],
  array['duplicate', 'nothing_to_record'],
  '0480/83: a record-only alert is never handed out again and takes no result');

-- ── 9b. A serious flag's one retry is never lost ────────────────────────────
-- The run that claimed it died before its send; the runs after it ended at
-- the inputs (a timeout in a flood) before their claims. The run that starts
-- 30 minutes after the claim still offers the retry.
select pg_temp.fresh();
select pg_temp.sw(true, true);
create temporary table lost1 as
  select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()), 'started', '{"events": 1}') as a;
select pg_temp.age((select (a ->> 'id')::uuid from lost1), interval '30 minutes');
create temporary table lost1_hb as select pg_temp.hb('start') as a;
create temporary table lost1_inp as select pg_temp.inp() as a;
create temporary table lost1_c as
  select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()), 'started', '{"events": 1}') as a;
select is(
  (select array[lost1.a ->> 'outcome', lost1_hb.a ->> 'marked_not_sent',
                (select string_agg(e ->> 'event_key', ',') from jsonb_array_elements(pg_temp.arr(lost1_inp.a -> 'serious_retry_due')) e),
                lost1_c.a ->> 'outcome', lost1_c.a ->> 'push', lost1_c.a ->> 'email', lost1_c.a ->> 'attempt']
     from lost1, lost1_hb, lost1_inp, lost1_c),
  array['new', '0', pg_temp.hk('sign_in_not_me', now()), 'retry', 'true', 'true', '2'],
  '0480/84: a serious flag with no result is still offered its one retry by a run that starts 30 minutes after the claim (the runs between failed before their claims): not swept, listed, handed out');
-- Never handed out again: a serious flag is marked not_sent 10 hours after
-- its claim (the 8 hours read and a margin), a volume alert after 30
-- minutes.
select pg_temp.fresh();
select pg_temp.raw(jsonb_build_object('rule', 'serious_flag', 'class', 'serious',
                                      'event_key', pg_temp.hk('sign_in_not_me', now() - interval '10 hours'),
                                      'disposition', 'sent', 'push_planned', true, 'email_planned', true, 'push_counted', true,
                                      'claimed_at', now() - interval '9 hours 59 minutes 59 seconds'));
select pg_temp.raw(jsonb_build_object('rule', 'serious_flag', 'class', 'serious',
                                      'event_key', pg_temp.hk('passkey_counter_went_back', now() - interval '10 hours'),
                                      'disposition', 'email_only_budget', 'email_planned', true,
                                      'claimed_at', now() - interval '10 hours'));
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-3), 'disposition', 'sent', 'email_planned', true,
                                      'claimed_at', now() - interval '30 minutes'));
create temporary table sweep2 as select pg_temp.hb('start') as a;
select is(
  array[(select a ->> 'marked_not_sent' from sweep2),
        (select string_agg(rule || ':' || disposition, ',' order by claimed_at) from public.platform_security_alerts)],
  array['2', 'serious_flag:not_sent,serious_flag:sent,spike:not_sent'],
  '0480/85: a run''s start marks a serious flag never handed out again not_sent only 10 hours after its claim (the 8 hours read and a margin), a volume alert after 30 minutes');
-- A late reason is first claimed near the end of its hour's 8 hours; ten
-- minutes on, that hour has left the window. Its retry is still taken: the
-- row is looked up before the key's age is judged.
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.raw(jsonb_build_object('rule', 'serious_flag', 'class', 'serious',
                                      'event_key', pg_temp.hk('unrecorded_server_form_password', now() - interval '9 hours'),
                                      'disposition', 'sent', 'push_planned', true, 'email_planned', true, 'push_counted', true,
                                      'claimed_at', now() - interval '10 minutes'));
create temporary table late1 as select pg_temp.inp() as a;
create temporary table late1_c as
  select pg_temp.claim('serious_flag', '', (select a -> 'serious_retry_due' -> 0 ->> 'event_key' from late1)) as a;
select is(
  array[(select string_agg(e ->> 'event_key', ',') from late1, jsonb_array_elements(pg_temp.arr(late1.a -> 'serious_retry_due')) e),
        (select a ->> 'outcome' || ' ' || coalesce(a ->> 'refused', '-') from late1_c),
        pg_temp.refused(pg_temp.claim('serious_flag', '', pg_temp.hk('unrecorded_server_form_code', now() - interval '9 hours')))],
  array[pg_temp.hk('unrecorded_server_form_password', now() - interval '9 hours'), 'retry -', 'key_out_of_window'],
  '0480/86: a serious flag''s retry is handed out even when its hour has just left the 8-hour window (the row is looked up first); a new key of that age is still refused');
-- One hundred and one volume alerts due their retry and one serious flag.
select pg_temp.fresh();
select pg_temp.raw(jsonb_build_object('rule', 'aimed_guessing', 'subject', pg_temp.o(g)::text, 'event_key', pg_temp.bk(-3),
                                      'disposition', 'sent', 'email_planned', true, 'claimed_at', now() - interval '25 minutes'))
  from generate_series(1, 101) g;
select pg_temp.raw(jsonb_build_object('rule', 'serious_flag', 'class', 'serious', 'event_key', pg_temp.hk('sign_in_not_me', now()),
                                      'disposition', 'sent', 'push_planned', true, 'email_planned', true, 'push_counted', true,
                                      'claimed_at', now() - interval '6 minutes'));
create temporary table due1 as select pg_temp.inp() as a;
select is(
  (select array[pg_temp.alen(a -> 'serious_retry_due')::text, a ->> 'serious_retry_due_truncated', a -> 'serious_retry_due' -> 0 ->> 'rule',
                pg_temp.alen(a -> 'retry_due')::text, a ->> 'retry_due_truncated',
                (select count(*)::text from jsonb_array_elements(pg_temp.arr(a -> 'retry_due')) e where e ->> 'rule' = 'serious_flag')]
     from due1),
  array['1', 'false', 'serious_flag', '100', 'true', '0'],
  '0480/87: the serious flags due their retry have a list of their own, never crowded out: one serious flag 6 minutes old beside 101 volume alerts 25 minutes old is listed; the volume list is the oldest 100 of the others');

-- ── 10. The claim: switches and budgets (M6) ────────────────────────────────
select pg_temp.fresh();
create temporary table off1 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3))) as a;
select is(
  array[(select a - 'id' - 'refused' - 'open_key' - 'attempt' - 'notice' from off1),
        (select to_jsonb(a) - 'id' - 'claimed_at' - 'counts' - 'event_key' - 'subject' - 'rule' - 'class' - 'phase'
           from public.platform_security_alerts a)],
  array['{"outcome": "new", "disposition": "record_only", "push": false, "email": false}'::jsonb,
        '{"disposition": "record_only", "push_planned": false, "email_planned": false, "push_counted": true,
          "email_floor": null, "push_result": null, "email_result": null, "attempts": 1, "resulted_at": null,
          "state_ended_at": null}'::jsonb],
  '0480/88: with every switch off (4a) the alert is still inserted, record_only, nothing handed out; it uses a push slot all the same (the budget is the same with the switch on or off)');
select pg_temp.fresh();
select pg_temp.sw(true, false);
select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', pg_temp.at(-3)));
select pg_temp.sw(false, true);
select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', pg_temp.at(-3)));
select pg_temp.sw(true, true);
select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_unexplained_sign_in', pg_temp.at(-3)));
select is(
  pg_temp.rows_of('serious_flag'),
  array['started:sent:true:false:true', 'started:sent:true:true:true', 'started:sent:false:true:true'],
  '0480/89: push on alone: sent by push (passkey_counter_went_back); both: by both (passkey_unexplained_sign_in); email on alone: by email (sign_in_not_me)');
-- Serious: 6 pushes an hour, then email only (never deferred, never refused).
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now() - make_interval(hours => g))) from generate_series(0, 3) g;
select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', now() - make_interval(hours => g))) from generate_series(0, 2) g;
select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_unexplained_sign_in', now()));
select is(
  pg_temp.sent_of('serious_flag'),
  'pushes:6 emails:8 rows:8',
  '0480/90: serious flags: six pushes in an hour; the seventh and eighth go by email only, nothing is held or deferred');
select is(
  (select array_agg(disposition order by claimed_at, event_key) filter (where not push_planned) from public.platform_security_alerts),
  array['email_only_budget', 'email_only_budget'],
  '0480/91: and are marked email_only_budget');
update public.platform_security_alerts set claimed_at = now() - interval '1 hour'
 where id = (select id from public.platform_security_alerts where push_planned order by event_key limit 1);
select is(
  pg_temp.claim('serious_flag', '', pg_temp.hk('unrecorded_server_form_code', now())) ->> 'push',
  'true',
  '0480/92: a slot used an hour ago is free again');
-- The slots are counted whether push is on or not, and email is a serious
-- flag's floor: past the push budget it goes by email even with email
-- alerts off; only with both switches off is it recorded only.
select pg_temp.fresh();
select pg_temp.sw(true, false);
select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now() - make_interval(hours => g))) from generate_series(0, 3) g;
select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', now() - make_interval(hours => g))) from generate_series(0, 2) g;
select pg_temp.sw(false, true);
select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_unexplained_sign_in', now() - make_interval(hours => g))) from generate_series(0, 1) g;
select pg_temp.sw(false, false);
select pg_temp.claim('serious_flag', '', pg_temp.hk('unrecorded_server_form_code', now()));
select is(
  (select array_agg(split_part(a.event_key, '|', 1) || ':' || a.disposition || ':' || a.push_planned || ':' || a.email_planned || ':'
                    || a.push_counted || ':' || coalesce(to_jsonb(a) ->> 'email_floor', '-')
                    order by split_part(a.event_key, '|', 1), a.event_key desc)
     from public.platform_security_alerts a),
  array['passkey_counter_went_back:sent:false:true:true:-', 'passkey_counter_went_back:sent:false:true:true:-',
        'passkey_counter_went_back:sent:false:true:false:-',
        'passkey_unexplained_sign_in:email_only_budget:false:true:false:push_budget_spent',
        'passkey_unexplained_sign_in:email_only_budget:false:true:false:push_budget_spent',
        'sign_in_not_me:sent:false:true:true:-', 'sign_in_not_me:sent:false:true:true:-', 'sign_in_not_me:sent:false:true:true:-',
        'sign_in_not_me:sent:false:true:true:-',
        'unrecorded_server_form_code:record_only:false:false:false:-'],
  '0480/93: the slots are counted as if push were on, and email is a serious flag''s floor: with email alone every serious flag goes by email, marked sent (push off: no budget in play), the seventh of the hour using no slot; with push alone and the six slots spent, each goes by email although email alerts are off, marked email_only_budget and why (push_budget_spent); with both off, recorded only');
-- One serious reason that repeats every hour for a day (its key is the
-- reason and the event's hour, so each hour is a new alert). Each hour the
-- reasons given are flagged once; the earlier rows are moved an hour back
-- and given a past key, as their owner, to stand for the hour passing.
create function pg_temp.hourly(p_reasons text[], p_hours integer) returns text language plpgsql as $$
declare
  h      integer;
  k      text;
  c      jsonb;
  pushes integer := 0;
  emails integer := 0;
  other  integer := 0;
begin
  for h in 1..p_hours loop
    foreach k in array p_reasons loop
      c := pg_temp.claim('serious_flag', '', pg_temp.hk(k, now()));
      if c ->> 'outcome' is distinct from 'new' then
        other := other + 1;
      end if;
      pushes := pushes + coalesce((c ->> 'push')::boolean::integer, 0);
      emails := emails + coalesce((c ->> 'email')::boolean::integer, 0);
      update public.platform_security_alerts
         set event_key = k || '|' || to_char(timestamp '2001-01-01 00:00' + make_interval(hours => h), 'YYYY-MM-DD"T"HH24":00Z"')
       where id = (c ->> 'id')::uuid;
    end loop;
    update public.platform_security_alerts set claimed_at = claimed_at - interval '1 hour';
  end loop;
  return 'pushes:' || pushes || ' emails:' || emails || ' not new:' || other;
end;
$$;
select pg_temp.fresh();
select pg_temp.sw(true, true);
select is(
  pg_temp.hourly(array['unrecorded_server_form_password'], 24),
  'pushes:4 emails:24 not new:0',
  '0480/94: one serious reason that repeats every hour for a day pushes at most 4 times; every one of the 24 goes by email (the email is never refused)');
select pg_temp.fresh();
select pg_temp.sw(true, true);
select is(
  pg_temp.hourly(array['passkey_counter_went_back', 'passkey_unexplained_sign_in', 'sign_in_not_me', 'unrecorded_server_form_password',
                       'unrecorded_server_form_code', 'over_minute_cap', 'over_buffer_cap', 'auth_log_over_cap'], 24),
  'pushes:32 emails:192 not new:0',
  '0480/95: every serious key of every hour for a day pushes at most 4 times for each of the eight reasons (32 in all, not 144), and every one goes by email');
-- A flood of one serious reason, one new key an hour: what each claim
-- answers, as 'first then each other answer xN' (in the order first seen).
create function pg_temp.flood(p_hours integer) returns text language plpgsql as $$
declare
  h integer;
  c jsonb;
  v text[] := '{}';
begin
  for h in 1..p_hours loop
    c := pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()));
    v := v || ((c ->> 'outcome') || ':' || coalesce(c ->> 'disposition', '-') || ':' || coalesce(c ->> 'push', '-') || ':'
               || coalesce(c ->> 'email', '-'));
    update public.platform_security_alerts
       set event_key = 'sign_in_not_me|' || to_char(timestamp '2001-01-01 00:00' + make_interval(hours => h), 'YYYY-MM-DD"T"HH24":00Z"')
     where id = (c ->> 'id')::uuid;
    update public.platform_security_alerts set claimed_at = claimed_at - interval '1 hour';
  end loop;
  return v[1] || ' then ' || coalesce((select string_agg(x.e || ' x' || x.n, ', ' order by x.first)
                                         from (select e, count(*) as n, min(o) as first
                                                 from unnest(v[2:]) with ordinality u(e, o) group by e) x), 'nothing');
end;
$$;
-- Six cheap alerts do not delay a serious flag (M6).
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-2)) from generate_series(1, 6) g;
create temporary table cheap6 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now())) as a;
select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-2)) from generate_series(7, 12) g;
create temporary table cheap12 as select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', now())) as a;
select is(
  (select array[cheap6.a ->> 'outcome', cheap6.a ->> 'disposition', cheap6.a ->> 'push', cheap6.a ->> 'email',
                cheap12.a ->> 'disposition', cheap12.a ->> 'push', pg_temp.sent_of('aimed_guessing')]
     from cheap6, cheap12),
  array['new', 'sent', 'true', 'true', 'sent', 'true', 'pushes:8 emails:12 rows:12'],
  '0480/96: six cheap alerts do not delay a serious flag: after six volume alerts, and after twelve (their day''s 8 pushes spent), a serious flag is sent at once by push and email; the volume alerts past 8 went by email only');
select is(
  (select pg_temp.claim('spike', '', pg_temp.bk(-1)) ->> 'disposition'),
  'email_only_budget',
  '0480/97: and a serious push spends nothing of the volume budget, nor a volume push of the serious one (the ninth volume alert of the day is email only)');
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-2)) from generate_series(1, 2) g;
select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now() - make_interval(hours => g))) from generate_series(0, 5) g;
select is(
  pg_temp.claim('record_trouble', '', pg_temp.bk(-1)) ->> 'push',
  'true',
  '0480/98: six serious pushes in an hour leave the volume and record budget whole (after two volume pushes, a record alert still pushes)');
-- Volume and record: 8 a day together, 4 a day for one rule and subject.
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.claim('aimed_guessing', pg_temp.o(1)::text, pg_temp.bk(-40 + g), 'started') ->> 'outcome',
       pg_temp.claim('aimed_guessing', pg_temp.o(1)::text, pg_temp.bk(-40 + g), 'ended') ->> 'outcome'
  from generate_series(0, 5) g;
select is(
  pg_temp.rows_of('aimed_guessing', pg_temp.o(1)::text),
  array['started:sent:true:true:true', 'ended:sent:false:true:false', 'started:sent:true:true:true', 'ended:sent:false:true:false',
        'started:sent:true:true:true', 'ended:sent:false:true:false', 'started:sent:true:true:true', 'ended:sent:false:true:false',
        'started:email_only_budget:false:true:false', 'ended:sent:false:true:false',
        'started:email_only_budget:false:true:false', 'ended:sent:false:true:false'],
  '0480/99: one rule and subject pushes at most 4 times a day: a condition that starts and ends six times pushes its first four starts, then email only; an end never pushes');
select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-2)) from generate_series(2, 6) g;
select is(
  array[pg_temp.sent_of('aimed_guessing'),
        pg_temp.claim('record_trouble', '', pg_temp.bk(-1)) ->> 'disposition'],
  array['pushes:8 emails:17 rows:17', 'email_only_budget'],
  '0480/100: volume and record together push at most 8 times a day: four more organizations push, the fifth and a record alert go by email only');
update public.platform_security_alerts set claimed_at = now() - interval '24 hours'
 where id = (select id from public.platform_security_alerts where push_planned order by claimed_at, event_key limit 1);
select is(
  pg_temp.claim('spike', '', pg_temp.bk(-1)) ->> 'push',
  'true',
  '0480/101: a day-old slot is free again');
-- Volume and record emails: at most 24 a day together, then held for the
-- daily summary (recorded, nothing sent now); a serious flag's email is
-- never held. Ten organizations whose guessing stops and starts every 20
-- minutes for 24 hours; the earlier rows are moved 20 minutes back and given
-- a past key, as their owner, to stand for the time passing.
create function pg_temp.flapping_orgs(p_orgs integer, p_cycles integer) returns text language plpgsql as $$
declare
  cy     integer;
  o      integer;
  c      jsonb;
  e      jsonb;
  ak     text;
  pushes integer := 0;
  emails integer := 0;
  notices integer := 0;
  other  integer := 0;
begin
  for cy in 1..p_cycles loop
    ak := to_char(timestamp '2001-01-01 00:00' + make_interval(mins => 10 * cy), 'YYYY-MM-DD"T"HH24:MI"Z"');
    for o in 1..p_orgs loop
      c := pg_temp.claim('aimed_guessing', pg_temp.o(o)::text, pg_temp.bk(-1), 'started');
      e := pg_temp.claim('aimed_guessing', pg_temp.o(o)::text, pg_temp.bk(-1), 'ended');
      if c ->> 'outcome' is distinct from 'new' or e ->> 'outcome' is distinct from 'new' then
        other := other + 1;
      end if;
      pushes := pushes + coalesce((c ->> 'push')::boolean::integer, 0) + coalesce((e ->> 'push')::boolean::integer, 0);
      emails := emails + coalesce((c ->> 'email')::boolean::integer, 0) + coalesce((e ->> 'email')::boolean::integer, 0);
      notices := notices + (jsonb_typeof(c -> 'notice') = 'object')::integer + (jsonb_typeof(e -> 'notice') = 'object')::integer;
      update public.platform_security_alerts set event_key = ak where id in ((c ->> 'id')::uuid, (e ->> 'id')::uuid);
    end loop;
    -- A notice's key is the bucket it was made in; this one's goes to the past with it.
    update public.platform_security_alerts set event_key = ak where rule = 'alerts_held' and event_key = pg_temp.bk(0);
    update public.platform_security_alerts set claimed_at = claimed_at - interval '20 minutes';
  end loop;
  return 'pushes:' || pushes || ' emails:' || emails || ' notices:' || notices || ' not new:' || other;
end;
$$;
select pg_temp.fresh();
select pg_temp.sw(true, true);
update public.platform_security_alert_state set summary_on = true;
create temporary table flap1 as select pg_temp.flapping_orgs(10, 72) as a;
create temporary table flap1_s as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now())) as a;
select is(
  array[(select a from flap1),
        (select string_agg(x.disposition || '=' || x.n, ',' order by x.disposition)
           from (select disposition, count(*) as n from public.platform_security_alerts where rule = 'aimed_guessing' group by 1) x),
        (select (a ->> 'disposition') || ' push:' || (a ->> 'push') || ' email:' || (a ->> 'email') from flap1_s)],
  array['pushes:8 emails:24 notices:0 not new:0', 'email_only_budget=4,held_for_summary=1416,sent=20', 'sent push:true email:true'],
  '0480/102: volume alerts that stop and start cannot email without bound: ten organizations, a start and an end every 20 minutes for 24 hours, send 8 pushes and 24 emails, the other 1,416 held for the daily summary (it is on); a serious flag after them still goes by push and email');
-- With the summary off, held is never silent: the claim hands out one
-- notice that more alerts are being held (open the console), at most once
-- in 6 hours, and the rows say they were held with it.
select pg_temp.fresh();
select pg_temp.sw(true, true);
create temporary table flap2 as select pg_temp.flapping_orgs(10, 72) as a;
select is(
  array[(select a from flap2),
        (select string_agg(x.disposition || '=' || x.n, ',' order by x.disposition)
           from (select disposition, count(*) as n from public.platform_security_alerts where rule = 'aimed_guessing' group by 1) x),
        (select string_agg(a.class || ':' || a.disposition || ':' || a.push_planned || ':' || a.email_planned || ':'
                           || coalesce(a.counts ->> 'held', '-'), ',' order by a.claimed_at)
           from public.platform_security_alerts a where a.rule = 'alerts_held'),
        (select count(*)::text from public.platform_security_alerts a
          where a.rule = 'aimed_guessing' and a.disposition not in ('sent', 'email_only_budget', 'held_with_notice'))],
  array['pushes:8 emails:24 notices:4 not new:0', 'email_only_budget=4,held_with_notice=1416,sent=20',
        'notice:sent:false:true:1,notice:sent:false:true:357,notice:sent:false:true:717,notice:sent:false:true:1077', '0'],
  '0480/103: with the summary off, volume alerts past the day''s 24 emails are held with a notice: one email that more alerts are being held, at most once in 6 hours (4 in the 24 hours), counts only (the alerts held so in the last 24 hours: 1, 357, 717, 1,077); none is both unsent and unreported');
-- The notice is an alert like the others for its sending: its one retry,
-- then not_sent; the job cannot claim one of its own.
create temporary table nt1 as
  select id, event_key from public.platform_security_alerts where rule = 'alerts_held' order by claimed_at desc limit 1;
create temporary table nt1_inp as select pg_temp.inp() as a;
select is(
  array[(select count(*)::text from nt1, nt1_inp, jsonb_array_elements(pg_temp.arr(nt1_inp.a -> 'retry_due')) e
          where e ->> 'rule' = 'alerts_held' and e ->> 'event_key' = nt1.event_key),
        (select pg_temp.claim('alerts_held', '', event_key) ->> 'outcome' from nt1),
        pg_temp.refused(pg_temp.claim('alerts_held', '', pg_temp.bk(-1))),
        (select count(*)::text from pg_temp.arr((select a -> 'open_states' from nt1_inp)) x(e), jsonb_array_elements(x.e) y
          where y ->> 'rule' = 'alerts_held')],
  array['1', 'retry', 'not_claimable', '0'],
  '0480/104: a notice with no result is listed for its retry and retried like any alert; a new notice cannot be claimed by the job (the claim makes it); a notice is never an open state');
-- The record class has its own day of emails (6), apart from the volume
-- alerts' 24: twenty-four volume emails do not silence record trouble, and
-- record trouble past its own six is held.
select pg_temp.fresh();
select pg_temp.sw(true, true);
update public.platform_security_alert_state set summary_on = true;
create temporary table rec_vol as
  select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-1), 'started') as s,
         pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-1), 'ended') as e
    from generate_series(1, 12) g;
create function pg_temp.record_flaps(p_n integer) returns void language plpgsql as $$
declare
  i integer;
begin
  for i in 1..p_n loop
    perform pg_temp.claim('record_trouble', '', pg_temp.bk(-10 + i), 'started');
    perform pg_temp.claim('record_trouble', '', pg_temp.bk(-10 + i), 'ended');
  end loop;
end;
$$;
select pg_temp.record_flaps(4);
create temporary table vol25 as select pg_temp.claim('aimed_guessing', pg_temp.o(13)::text, pg_temp.bk(-1)) as a;
select is(
  array[pg_temp.sent_of('aimed_guessing'), array_to_string(pg_temp.rows_of('record_trouble'), ' '),
        (select (a ->> 'disposition') from vol25)],
  array['pushes:8 emails:24 rows:25',
        'started:email_only_budget:false:true:false ended:sent:false:true:false started:email_only_budget:false:true:false ended:sent:false:true:false '
        || 'started:email_only_budget:false:true:false ended:sent:false:true:false started:held_for_summary:false:false:false ended:held_for_summary:false:false:false',
        'held_for_summary'],
  '0480/105: record trouble has its own 6 emails a day: after 24 volume emails it still goes by email, its seventh and eighth are held for the summary, and the 25th volume alert is held too (24 volume emails, 25 rows)');

-- Email is a serious flag's floor only: a volume alert with push alone and
-- the day's 8 pushes spent is recorded only (email alerts are off).
select pg_temp.fresh();
select pg_temp.sw(false, true);
select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-2)) from generate_series(1, 9) g;
select is(
  (select array_agg(a.disposition || ':' || a.push_planned || ':' || a.email_planned || ':' || coalesce(to_jsonb(a) ->> 'email_floor', '-')
                    order by a.subject)
     from public.platform_security_alerts a where a.rule = 'aimed_guessing')
  || array[(select string_agg(a.disposition || ':' || a.push_planned || ':' || a.email_planned, ',')
              from public.platform_security_alerts a where a.rule = 'alerts_held')],
  array_fill('sent:true:false:-'::text, array[8]) || array['held_with_notice:false:false:-', 'sent:true:false'],
  '0480/106: email is a serious flag''s floor only: with push alone and the day''s 8 pushes spent, the ninth volume alert sends no email (email alerts are off) but is held with a notice, which goes by push (the summary is off)');

-- ── 11. A scan that lasts 12 hours claims at most 4 pushes (M6) ─────────────
-- Seventy-two runs, one every 10 minutes for 12 hours, as a job would claim
-- if the attacker's scan made the condition stop and start again on every
-- other run (a new start each time, every reminder it could ask for, an
-- end). And a steady scan aimed at one organization, whose start moves
-- between two buckets as late rows arrive.
select pg_temp.fresh();
select pg_temp.sw(true, true);
create function pg_temp.flapping_scan() returns void language plpgsql as $$
declare
  v jsonb;
  k text;
  r integer;
begin
  for r in 1..72 loop
    v := pg_temp.claim('spike', '', pg_temp.bk(-47 + (r % 48)), 'started');
    k := coalesce(v ->> 'open_key', (select a.event_key from public.platform_security_alerts a
                                       where a.rule = 'spike' and a.phase = 'started' and a.state_ended_at is null
                                       order by a.claimed_at desc, a.event_key desc limit 1));
    if k is not null then
      perform pg_temp.claim('spike', '', k || '+1h', 'reminder');
      perform pg_temp.claim('spike', '', k || '+6h', 'reminder');
      perform pg_temp.claim('spike', '', k || '+24h', 'reminder');
      if r % 2 = 0 then
        perform pg_temp.claim('spike', '', k, 'ended');
      end if;
    end if;
  end loop;
end;
$$;
create function pg_temp.steady_scan() returns void language plpgsql as $$
declare
  r integer;
  k text;
begin
  for r in 1..72 loop
    k := pg_temp.bk(-46 + (r % 2));
    perform pg_temp.claim('aimed_guessing', pg_temp.o(50)::text, k, 'started');
    k := (select a.event_key from public.platform_security_alerts a
           where a.rule = 'aimed_guessing' and a.phase = 'started' and a.state_ended_at is null
           order by a.claimed_at desc, a.event_key desc limit 1);
    perform pg_temp.claim('aimed_guessing', pg_temp.o(50)::text, k || '+1h', 'reminder');
    perform pg_temp.claim('aimed_guessing', pg_temp.o(50)::text, k || '+6h', 'reminder');
    perform pg_temp.claim('aimed_guessing', pg_temp.o(50)::text, k || '+24h', 'reminder');
  end loop;
end;
$$;
select pg_temp.flapping_scan();
create temporary table flap_spike as
  select pg_temp.sent_of('spike') as a, (select count(*) from public.platform_security_alerts where rule = 'spike') as n;
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.steady_scan();
select is(
  array[(select a from flap_spike), (select (n > 24)::text from flap_spike), pg_temp.sent_of('aimed_guessing'),
        (select string_agg(phase || ':' || push_planned, ',' order by claimed_at, phase desc, event_key)
           from public.platform_security_alerts where rule = 'aimed_guessing')],
  array[(select 'pushes:4 emails:24 rows:' || n from flap_spike), 'true',
        'pushes:3 emails:3 rows:3', 'started:true,reminder:true,reminder:true'],
  '0480/107: a scan that lasts 12 hours claims at most 4 pushes: a scan that stops and starts on every other run pushes 4 times (and emails 24 times, the rest held for the summary), and a steady one 3 times (its start, the 1-hour and 6-hour reminders; the 24-hour one not due), one row each however often it is claimed');

-- ── 12. The claim: states ───────────────────────────────────────────────────
select pg_temp.fresh();
select is(
  array[pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-30) || '+1h', 'reminder')),
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-30), 'ended')),
        pg_temp.claim('spike', '', pg_temp.bk(-30)) ->> 'outcome',
        (pg_temp.claim('spike', '', pg_temp.bk(-29)) - 'id')::text,
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-30) || '+6h', 'reminder')),
        pg_temp.claim('spike', '', pg_temp.bk(-30) || '+1h', 'reminder') ->> 'outcome',
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-29) || '+1h', 'reminder')),
        pg_temp.claim('spike', '', pg_temp.bk(-30), 'ended') ->> 'outcome',
        pg_temp.refused(pg_temp.claim('spike', '', pg_temp.bk(-30) || '+6h', 'reminder')),
        pg_temp.claim('spike', '', pg_temp.bk(-30), 'ended') ->> 'outcome',
        pg_temp.claim('spike', '', pg_temp.bk(-30)) ->> 'outcome',
        pg_temp.claim('spike', '', pg_temp.bk(-20)) ->> 'outcome']::text[],
  array['no_open_state', 'no_open_state', 'new',
        jsonb_build_object('outcome', 'refused', 'refused', 'already_open', 'disposition', null, 'push', false,
                           'email', false, 'attempt', null, 'open_key', pg_temp.bk(-30), 'notice', null)::text,
        'reminder_not_due', 'new', 'no_open_state', 'new', 'state_ended', 'duplicate', 'refused', 'new'],
  '0480/108: a state: no reminder or end before it starts; one open at a time for a rule and subject (another start is already_open and names the open one); a reminder only once its step has passed (5 hours in, the 6-hour one is not due) and only of the open state; after its end no reminder (state_ended), its end again is a duplicate, its start again is refused (state_ended), and a later start is a new state');
select is(
  (select array_agg(phase || ':' || event_key || ':' || (state_ended_at is not null)::text
                    order by claimed_at, split_part(event_key, '+', 1), case phase when 'started' then 0 when 'reminder' then 1 else 2 end)
     from public.platform_security_alerts),
  array['started:' || pg_temp.bk(-30) || ':true', 'reminder:' || pg_temp.bk(-30) || '+1h:false',
        'ended:' || pg_temp.bk(-30) || ':false', 'started:' || pg_temp.bk(-20) || ':false'],
  '0480/109: the end marks its started row ended; the later state is open');
-- A condition that ends and comes back (Q15): a start with the ended
-- state's key is told so in a word of its own (not answered like an alert
-- already sent), and the job's next key alerts again, exactly once.
select pg_temp.fresh();
select pg_temp.sw(true, true);
create temporary table again1 as
  select array[pg_temp.claim('spike', '', pg_temp.bk(-6)) ->> 'outcome',
               pg_temp.claim('spike', '', pg_temp.bk(-6), 'ended') ->> 'outcome',
               (pg_temp.claim('spike', '', pg_temp.bk(-6)) - 'id')::text,
               pg_temp.claim('spike', '', pg_temp.bk(-5)) ->> 'outcome',
               pg_temp.claim('spike', '', pg_temp.bk(-5)) ->> 'outcome',
               pg_temp.claim('spike', '', pg_temp.bk(-6)) ->> 'refused',
               pg_temp.claim('spike', '', pg_temp.bk(-4)) ->> 'refused'] as a;
select is(
  (select a from again1)
  || array[(select string_agg(e ->> 'event_key', ',') from jsonb_array_elements(pg_temp.arr(pg_temp.inp() -> 'open_states')) e),
           pg_temp.sent_of('spike')],
  array['new', 'new',
        jsonb_build_object('outcome', 'refused', 'refused', 'state_ended', 'disposition', null, 'push', false, 'email', false,
                           'attempt', null, 'open_key', null, 'notice', null)::text,
        'new', 'duplicate', 'state_ended', 'already_open', pg_temp.bk(-5), 'pushes:2 emails:3 rows:3'],
  '0480/110: a condition that ended and comes back: a start with the ended state''s key is refused state_ended (so the job uses a newer key), the newer key opens one new state and alerts once (its repeat a duplicate), and the old key stays refused');
-- A state that started 25 hours ago (written by the owner, as a run a day
-- ago would have): every reminder is due.
select pg_temp.fresh();
select pg_temp.raw(jsonb_build_object('rule', 'record_trouble', 'class', 'record', 'event_key', pg_temp.bk(-150),
                                      'claimed_at', now() - interval '25 hours'));
select is(
  array[pg_temp.claim('record_trouble', '', pg_temp.bk(-150) || '+24h', 'reminder') ->> 'outcome',
        pg_temp.claim('record_trouble', '', pg_temp.bk(-150) || '+6h', 'reminder') ->> 'outcome',
        pg_temp.claim('record_trouble', '', pg_temp.bk(-150) || '+1h', 'reminder') ->> 'outcome',
        pg_temp.claim('record_trouble', '', pg_temp.bk(-150), 'ended') ->> 'outcome',
        pg_temp.refused(pg_temp.claim('record_trouble', '', pg_temp.bk(-150))),
        pg_temp.refused(pg_temp.claim('record_trouble', '', pg_temp.bk(-151)))],
  array['new', 'new', 'new', 'new', 'state_ended', 'key_out_of_window'],
  '0480/111: a state older than the read''s window still takes its reminders and its end; its own key cannot start it again (state_ended), and no other key so old can start one');

-- ── 13. The claim: the planned check ────────────────────────────────────────
select pg_temp.fresh();
select pg_temp.sw(true, true);
update public.platform_security_alert_state set planned_check_until = now() + interval '20 minutes';
select pg_temp.claim('spike', '', pg_temp.bk(-3));
select pg_temp.claim('aimed_guessing', pg_temp.o(1)::text, pg_temp.bk(-3));
select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()));
select is(
  array[array_to_string(pg_temp.rows_of('spike'), ' '), array_to_string(pg_temp.rows_of('aimed_guessing', pg_temp.o(1)::text), ' '),
        array_to_string(pg_temp.rows_of('serious_flag'), ' ')],
  array['started:held_planned_check:false:false:false', 'started:held_planned_check:false:false:false',
        'started:sent:true:true:true'],
  '0480/112: during a planned check volume and record alerts are recorded as held (nothing sent, no slot used); a serious flag is never held');
select pg_temp.claim('spike', '', pg_temp.bk(-3), 'ended');
update public.platform_security_alert_state set planned_check_until = now() - interval '1 second';
select pg_temp.claim('aimed_guessing', pg_temp.o(1)::text, pg_temp.bk(-3), 'ended');
select pg_temp.claim('aimed_guessing', pg_temp.o(2)::text, pg_temp.bk(-3));
select is(
  array[array_to_string(pg_temp.rows_of('spike'), ' '), array_to_string(pg_temp.rows_of('aimed_guessing', pg_temp.o(1)::text), ' '),
        array_to_string(pg_temp.rows_of('aimed_guessing', pg_temp.o(2)::text), ' ')],
  array['started:held_planned_check:false:false:false ended:held_planned_check:false:false:false',
        'started:held_planned_check:false:false:false ended:held_planned_check:false:false:false',
        'started:sent:true:true:true'],
  '0480/113: the end of a held state is held, during the check or after it ended; once the check has ended, a new alert is sent');
select pg_temp.fresh();
select pg_temp.sw(true, true);
update public.platform_security_alert_state set planned_check_until = now() + interval '20 minutes';
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'class', 'volume', 'event_key', pg_temp.bk(-40),
                                      'disposition', 'held_planned_check', 'claimed_at', now() - interval '2 hours'));
update public.platform_security_alert_state set planned_check_until = null;
select pg_temp.claim('spike', '', pg_temp.bk(-40) || '+1h', 'reminder');
select pg_temp.claim('spike', '', pg_temp.bk(-40), 'ended');
select is(
  pg_temp.rows_of('spike'),
  array['started:held_planned_check:false:false:false', 'reminder:sent:true:true:true', 'ended:sent:false:true:false'],
  '0480/114: a state that outlasts the check is not hidden by it: its reminder is the first notice, and its end is sent');

-- ── 14. The result ──────────────────────────────────────────────────────────
select pg_temp.fresh();
select pg_temp.sw(true, true);
create temporary table q1 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now())) as a;
select pg_temp.sw(true, false);
create temporary table q2 as select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', now())) as a;
create function pg_temp.q(p text) returns uuid language sql as $$
  select (a ->> 'id')::uuid from pg_temp.q1 where p = 'q1' union all select (a ->> 'id')::uuid from pg_temp.q2 where p = 'q2';
$$;
select is(
  array[pg_temp.res(null, 1, '{"sent": 1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(gen_random_uuid(), 1, '{"sent": 1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '[]', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{"delivered": 1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{"sent": 1}', '{"no_phone": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{"sent": "1"}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{"sent": -1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{"sent": 1.5}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, '{"sent": 101}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 2, '{"sent": 1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), null, '{"sent": 1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q1'), 1, null, '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q2'), 1, '{"sent": 1}', '{"sent": 1}') ->> 'refused',
        pg_temp.res(pg_temp.q('q2'), 1, null, null) ->> 'refused',
        (select count(*)::text from public.platform_security_alerts where resulted_at is not null)],
  array['not_an_alert', 'not_an_alert', 'not_a_result', 'not_a_result', 'not_a_result', 'not_a_result', 'not_a_result',
        'not_a_result', 'not_a_result', 'not_a_result', 'not_this_attempt', 'not_this_attempt', 'not_its_channels',
        'not_its_channels', 'not_its_channels', '0'],
  '0480/115: a result is refused for no alert, a result not of counts of the known codes (0 to 100 each), another attempt, or a channel the alert was not handed out for (and for none it was); nothing refused is written');
select is(
  array[pg_temp.res(pg_temp.q('q1'), 1, '{"sent": 1, "no_account": 1, "no_phone": 0, "failed": 0, "timeout": 0, "skipped": 0}',
                    '{"sent": 2, "failed": 0, "timeout": 0, "skipped": 0}'),
        pg_temp.res(pg_temp.q('q2'), 1, null, '{"timeout": 1}'),
        pg_temp.res(pg_temp.q('q1'), 1, '{"sent": 1}', '{"sent": 1}')],
  array['{"recorded": true, "refused": null}'::jsonb, '{"recorded": true, "refused": null}'::jsonb,
        '{"recorded": false, "refused": "already_recorded"}'::jsonb],
  '0480/116: a result for each channel handed out is recorded once; a second is refused');
select is(
  (select array_agg(coalesce(push_result::text, '-') || ' ' || email_result::text || ' ' || (resulted_at = now())::text order by event_key)
     from public.platform_security_alerts),
  array['- {"timeout": 1} true',
        '{"sent": 1, "failed": 0, "skipped": 0, "timeout": 0, "no_phone": 0, "no_account": 1} {"sent": 2, "failed": 0, "skipped": 0, "timeout": 0} true'],
  '0480/117: and stored as counts of result codes, never an address');
-- A retried alert takes the second attempt's result, not the first's.
-- Its retry hands out what the first claim planned (push only), though
-- email has been turned on since.
select pg_temp.fresh();
select pg_temp.sw(false, true);
create temporary table q3 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now())) as a;
select pg_temp.age((select (a ->> 'id')::uuid from q3), interval '6 minutes');
select pg_temp.sw(true, true);
create temporary table q4 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now())) as a;
select is(
  array[(select a ->> 'outcome' || ' push:' || (a ->> 'push') || ' email:' || (a ->> 'email') from q4),
        (select pg_temp.res((a ->> 'id')::uuid, 1, '{"sent": 1}') ->> 'refused' from q3),
        (select pg_temp.res((a ->> 'id')::uuid, 2, '{"sent": 1}') ->> 'recorded' from q3)],
  array['retry push:true email:false', 'not_this_attempt', 'true'],
  '0480/118: a retry hands out the channels the first claim planned, whatever the switches say now; then the first attempt''s result is refused and the second''s recorded');
-- A serious flag sent by push alone whose push reached no one is owed its
-- email, whatever the email switch says: its result is refused until the
-- email's result comes with it, and the row says why the email went. A
-- push that reached someone owes nothing; a volume alert has no floor.
select pg_temp.fresh();
select pg_temp.sw(false, true);
create temporary table fl1 as select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now())) as a;
create temporary table fl2 as select pg_temp.claim('serious_flag', '', pg_temp.hk('passkey_counter_went_back', now())) as a;
create temporary table fl3 as select pg_temp.claim('spike', '', pg_temp.bk(-1)) as a;
create temporary table fl_res as
  select array[(select coalesce(pg_temp.res((a ->> 'id')::uuid, 1, '{"failed": 1, "no_phone": 1}') ->> 'refused', 'recorded') from fl1),
               (select coalesce(pg_temp.res((a ->> 'id')::uuid, 1, '{"sent": 0, "timeout": 1}') ->> 'refused', 'recorded') from fl1),
               (select coalesce(pg_temp.res((a ->> 'id')::uuid, 1, '{"no_phone": 2}', '{"sent": 2}') ->> 'refused', 'recorded') from fl1),
               (select coalesce(pg_temp.res((a ->> 'id')::uuid, 1, '{"sent": 1}', '{"sent": 2}') ->> 'refused', 'recorded') from fl2),
               (select coalesce(pg_temp.res((a ->> 'id')::uuid, 1, '{"sent": 1}') ->> 'refused', 'recorded') from fl2),
               (select coalesce(pg_temp.res((a ->> 'id')::uuid, 1, '{"failed": 1}') ->> 'refused', 'recorded') from fl3)] as a;
select is(
  (select a from fl_res)
  || (select array_agg(a.rule || ':' || a.disposition || ':' || a.push_planned || ':' || a.email_planned || ':'
                       || coalesce(to_jsonb(a) ->> 'email_floor', '-') || ':' || coalesce(a.push_result::text, '-') || ':'
                       || coalesce(a.email_result::text, '-') order by a.rule, a.event_key)
        from public.platform_security_alerts a)
  || array[(select string_agg(e ->> 'email_floor', ',') from jsonb_array_elements(pg_temp.arr(pg_temp.lst() -> 'alerts')) e
             where e ->> 'email_floor' is not null)],
  array['email_floor_due', 'email_floor_due', 'recorded', 'not_its_channels', 'recorded', 'recorded',
        'serious_flag:sent:true:false:-:{"sent": 1}:-',
        'serious_flag:sent:true:true:push_failed:{"no_phone": 2}:{"sent": 2}',
        'spike:sent:true:false:-:{"failed": 1}:-',
        'push_failed'],
  '0480/119: a serious flag sent by push alone whose push reached no one is owed its email though email alerts are off: the push result alone is refused (email_floor_due), the two together are recorded and the row (and the console) says push_failed; a push that reached someone, or a volume alert, owes nothing');

-- ── 15. The heartbeat ───────────────────────────────────────────────────────
select pg_temp.fresh();
select is(
  array[pg_temp.hb(null), pg_temp.hb('begin'), pg_temp.hb('finish'), pg_temp.hb('finish', gen_random_uuid()),
        pg_temp.hb('finish', null, true)],
  array['{"step": null, "refused": "not_a_step"}'::jsonb, '{"step": null, "refused": "not_a_step"}'::jsonb,
        '{"step": "finish", "refused": "not_a_finish"}'::jsonb, '{"step": "finish", "refused": "not_a_finish"}'::jsonb,
        '{"step": "finish", "refused": "not_a_finish"}'::jsonb],
  '0480/120: a step that is not start or finish, and a finish without its run and outcome, are refused');
create temporary table hb1 as select pg_temp.hb('start') as a;
select is(
  (select a - 'run_id' from hb1),
  '{"step": "start", "refused": null, "previous": {"started_at": null, "finished_at": null, "ok": null}, "last_ok_at": null,
    "missed_runs": 0, "failures_in_a_row": 0, "report_now": false, "marked_not_sent": 0}'::jsonb,
  '0480/121: the first run ever: nothing before it, nothing missed');
select is(
  array[pg_temp.hb('finish', gen_random_uuid(), true),
        (select pg_temp.hb('finish', (a ->> 'run_id')::uuid, true) from hb1),
        (select pg_temp.hb('finish', (a ->> 'run_id')::uuid, true) from hb1)],
  array['{"step": "finish", "refused": "not_the_latest_run"}'::jsonb,
        '{"step": "finish", "refused": null, "failures_in_a_row": 0, "report_now": false}'::jsonb,
        '{"step": "finish", "refused": "already_finished"}'::jsonb],
  '0480/122: only the latest run finishes, once');
select is(
  (select array[last_run_started_at = now(), last_run_finished_at = now(), last_run_ok, last_ok_at = now(),
                last_run_id = (select (a ->> 'run_id')::uuid from hb1)]
     from public.platform_security_alert_state),
  array[true, true, true, true, true],
  '0480/123: the state holds the run: started, finished, ok, the last good run');
-- The time of the last failing notice moved back, as its owner (never an
-- error: a state without the column is left as it is).
create function pg_temp.report_aged(p interval) returns void language plpgsql as $$
begin
  execute format('update public.platform_security_alert_state set failure_reported_at = failure_reported_at - %L::interval', p);
exception when undefined_column then
  null;
end;
$$;
-- Missed runs, from the time since the last start: 10 minutes is none, 21
-- is one, 35 is three (rounded to whole ticks).
create function pg_temp.start_after(p_gap interval, p_finished boolean) returns jsonb language plpgsql as $$
begin
  update public.platform_security_alert_state
     set last_run_id = gen_random_uuid(), last_run_started_at = now() - p_gap,
         last_run_finished_at = case when p_finished then now() - p_gap end,
         last_run_ok = case when p_finished then true end,
         failures_in_a_row = 0, failure_reported = false;
  perform pg_temp.report_aged(interval '1000 days');
  return pg_temp.hb('start');
end;
$$;
select is(
  array[pg_temp.start_after(interval '10 minutes', true) ->> 'missed_runs',
        pg_temp.start_after(interval '14 minutes 59 seconds', true) ->> 'missed_runs',
        pg_temp.start_after(interval '21 minutes', true) ->> 'missed_runs',
        pg_temp.start_after(interval '35 minutes', true) ->> 'missed_runs',
        pg_temp.start_after(interval '10 minutes', false) ->> 'failures_in_a_row',
        pg_temp.start_after(interval '25 minutes', false) ->> 'failures_in_a_row',
        pg_temp.start_after(interval '25 minutes', false) ->> 'report_now',
        pg_temp.start_after(interval '400 days', true) ->> 'failures_in_a_row'],
  array['0', '0', '1', '3', '1', '3', 'true', '57599'],
  '0480/124: missed runs are counted from the time since the last start, in whole 10-minute ticks, and a run that never finished is one more failure; three in a row are reported');
-- Reported once; a good run resets it; failing finishes count too. From a
-- clean start whose first run finished well.
select pg_temp.fresh();
-- A run as 'report_now of its start/report_now of its finish:failures after it'.
create function pg_temp.run(p_ok boolean) returns text language plpgsql as $$
declare
  v jsonb;
  w jsonb;
begin
  v := pg_temp.hb('start');
  w := pg_temp.hb('finish', (v ->> 'run_id')::uuid, p_ok);
  return coalesce(v ->> 'report_now', v ->> 'refused', '?') || '/' || coalesce(w ->> 'report_now', w ->> 'refused', '?')
         || ':' || coalesce(w ->> 'failures_in_a_row', '?');
end;
$$;
select pg_temp.run(true);
select is(
  array[pg_temp.run(false), pg_temp.run(false), pg_temp.run(false), pg_temp.run(false), pg_temp.run(true),
        pg_temp.run(false), pg_temp.run(false), pg_temp.run(false)],
  array['false/false:1', 'false/false:2', 'false/true:3', 'false/false:4', 'false/false:0', 'false/false:1', 'false/false:2',
        'false/false:3'],
  '0480/125: three failed runs in a row are reported once, not again at the fourth; a good run resets the count, and three more within 6 hours of the last notice are not reported');
select pg_temp.report_aged(interval '6 hours');
select is(
  array[pg_temp.run(false), pg_temp.run(false)],
  array['true/false:4', 'false/false:5'],
  '0480/126: once 6 hours have passed since the last notice, failures still going on are reported (once, at the next start)');
-- Failures that come and go: three failed runs and a good one, 36 times
-- over (24 hours of 10-minute runs); the last notice's time is moved 40
-- minutes back after each, as its owner, to stand for the time passing.
create function pg_temp.flaky(p_cycles integer) returns integer language plpgsql as $$
declare
  cy integer;
  i  integer;
  n  integer := 0;
  v  text;
begin
  for cy in 1..p_cycles loop
    for i in 1..3 loop
      v := pg_temp.run(false);
      n := n + (v like 'true/%')::integer + (v like '%/true:%')::integer;
    end loop;
    perform pg_temp.run(true);
    perform pg_temp.report_aged(interval '40 minutes');
  end loop;
  return n;
end;
$$;
select pg_temp.fresh();
select pg_temp.run(true);
select is(
  pg_temp.flaky(36),
  4,
  '0480/127: three failed runs and a good one, 36 times over (24 hours of 10-minute runs), ask for the failing notice 4 times: at most once in 6 hours');
-- The claims nobody finished.
select pg_temp.fresh();
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-1), 'disposition', 'sent', 'email_planned', true,
                                      'attempts', 2, 'claimed_at', now() - interval '5 minutes'));
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-2), 'disposition', 'sent', 'email_planned', true,
                                      'attempts', 2, 'claimed_at', now() - interval '4 minutes 59 seconds'));
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-3), 'disposition', 'email_only_budget', 'email_planned', true,
                                      'attempts', 1, 'claimed_at', now() - interval '30 minutes'));
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-4), 'disposition', 'sent', 'email_planned', true,
                                      'attempts', 1, 'claimed_at', now() - interval '29 minutes 59 seconds'));
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-5), 'disposition', 'record_only',
                                      'claimed_at', now() - interval '2 hours'));
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-6), 'disposition', 'sent', 'email_planned', true,
                                      'email_result', '{"sent": 1}'::jsonb, 'resulted_at', now(), 'claimed_at', now() - interval '2 hours'));
create temporary table sweep1 as select pg_temp.hb('start') as a;
select is(
  array[(select a ->> 'marked_not_sent' from sweep1),
        (select string_agg(disposition, ',' order by event_key desc) from public.platform_security_alerts)],
  array['2', 'not_sent,sent,not_sent,sent,record_only,sent'],
  '0480/128: a run''s start marks not_sent the claims handed out twice with no result 5 minutes after the second, and those never handed out again 30 minutes after the first; nothing else');
select pg_temp.raw(jsonb_build_object('rule', 'spike', 'event_key', pg_temp.bk(-7), 'disposition', 'sent', 'email_planned', true,
                                      'attempts', 2, 'claimed_at', now() - interval '6 minutes'));
select is(
  (select array_agg((e ->> 'event_key') order by e ->> 'event_key')
     from jsonb_array_elements(pg_temp.arr(pg_temp.inp() -> 'retry_due')) e),
  array[pg_temp.bk(-4)],
  '0480/129: the inputs list the claim due its one retry (first handed out 5 minutes ago or more, no result), never one handed out twice');
-- A run that could not check fully (its read shortened or truncated) says
-- so in its finish; the console shows it until the next run starts.
select pg_temp.fresh();
create temporary table part1 as select pg_temp.hb('start') as a;
create temporary table part1_f as select pg_temp.hb('finish', (select (a ->> 'run_id')::uuid from part1), true, true) as a;
create temporary table part1_l as select pg_temp.lst() as a;
create temporary table part2 as select pg_temp.hb('start') as a;
create temporary table part2_s as select to_jsonb(s) ->> 'last_run_partial' as a from public.platform_security_alert_state s;
create temporary table part2_f as select pg_temp.hb('finish', (select (a ->> 'run_id')::uuid from part2), true) as a;
select is(
  array[(select coalesce(a ->> 'refused', a ->> 'raised', 'taken') from part1_f),
        (select a -> 'state' -> 'heartbeat' ->> 'last_run_partial' from part1_l),
        (select coalesce(a, 'null') from part2_s),
        (select coalesce(a ->> 'refused', a ->> 'raised', 'taken') from part2_f),
        (select to_jsonb(s) ->> 'last_run_partial' from public.platform_security_alert_state s)],
  array['taken', 'true', 'null', 'taken', 'false'],
  '0480/130: a finish can say the run could not check fully (the console shows it); the next start clears it, and a finish that does not say is a full check');

-- ── 16. A switch, a threshold or a planned check ────────────────────────────
select pg_temp.fresh();
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
select pg_temp.u(g), e, case when g = 3 then null else now() end, '{}'::jsonb
  from (values (1, 'a.admin@example.test'), (2, 'B.Admin@Example.Test'), (3, 'c.admin@example.test'),
               (4, 'd.admin@example.test'), (5, 'e.admin@example.test'), (6, 'f.admin@example.test'),
               (7, 'g.admin@example.test'), (8, 'h.admin@example.test'), (9, 'i.admin@example.test'),
               (10, 'j.admin@example.test'), (11, 'k.admin@example.test')) v(g, e);
update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.u(4);
update auth.users set banned_until = now() - interval '1 day' where id = pg_temp.u(5);
update auth.users set deleted_at = now() where id = pg_temp.u(6);
update public.user_profiles set disabled_at = now() where id = pg_temp.u(7);
update public.user_profiles set deleted_at = now() where id = pg_temp.u(8);
delete from public.user_profiles where id = pg_temp.u(9);
update auth.users set is_sso_user = true where id = pg_temp.u(10);
update auth.users set is_anonymous = true where id = pg_temp.u(11);
create temporary table set_refused as
select array[pg_temp.setv(null, 'push_on', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), null, 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'sound_on', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'Push_on', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'push_on', null) ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'push_on', '"true"') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'push_on', '1') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'spike_event_floor', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'spike_event_floor', '"60"') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'spike_event_floor', '60.5') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'spike_event_floor', '-60') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'planned_check', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'planned_check', '31') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'aimed_guessing_minutes', '25') ->> 'refused',
        pg_temp.setv(gen_random_uuid(), 'push_on', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(6), 'push_on', 'true') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'push_on', 'false') ->> 'refused',
        pg_temp.setv(pg_temp.u(1), 'push_on', 'true', 'true') ->> 'refused'] as a;
select is(
  (select a from set_refused)
  || array[(select count(*)::text from public.platform_security_alert_changes),
           (select push_on::text from public.platform_security_alert_state)],
  array['no_actor', 'not_a_name', 'not_a_name', 'not_a_name', 'not_a_value', 'not_a_value', 'not_a_value', 'not_a_value',
        'not_a_value', 'not_a_value', 'not_a_value', 'not_a_value', 'out_of_range', 'out_of_range', 'unknown_actor',
        'unknown_actor', 'unchanged', 'changed_by_someone_else', '0', 'false'],
  '0480/131: a set is refused with no actor, a name not of the fourteen, a value not of its kind, out of its range (a planned check of more than 30 minutes, guessing minutes not in tens), an actor that is not an account or is deleted, the value it already has, or when the value is no longer what the console saw; nothing refused is written');
select is(
  (select array_agg(pg_temp.setv(pg_temp.u(1), r.k, to_jsonb((r.v ->> 0)::int - 1)) ->> 'refused'
                    || '/' || coalesce(pg_temp.setv(pg_temp.u(1), r.k, to_jsonb((r.v ->> 1)::int + 1)) ->> 'refused', '-')
                    order by r.k)
     from jsonb_each('{"aimed_guessing_events": [5, 100000], "aimed_guessing_minutes": [10, 120], "record_trouble_rows": [1, 100000],
                       "serious_pushes_per_hour": [1, 60], "serious_reason_pushes_per_day": [1, 24], "spike_event_floor": [10, 1000000],
                       "spike_learning_days": [1, 90], "spike_source_floor": [2, 100000], "subject_pushes_per_day": [1, 24],
                       "volume_pushes_per_day": [0, 100]}') r(k, v)),
  array['out_of_range/out_of_range', 'out_of_range/out_of_range', 'out_of_range/out_of_range', 'out_of_range/out_of_range',
        'out_of_range/out_of_range', 'out_of_range/out_of_range', 'out_of_range/out_of_range', 'out_of_range/out_of_range',
        'out_of_range/out_of_range', 'not_a_value/out_of_range'],
  '0480/132: every threshold refuses one below its least and one above its most (serious pushes, of the hour and of one reason a day, never 0; volume pushes may be 0, and -1 is not a whole number)');
select is(
  (select array_agg(coalesce(pg_temp.setv(pg_temp.u(1), r.k, r.v -> 1) ->> 'refused', 'changed') || '/'
                    || coalesce(pg_temp.setv(pg_temp.u(1), r.k, r.v -> 0) ->> 'refused', 'changed') order by r.k)
     from jsonb_each('{"aimed_guessing_events": [5, 100000], "aimed_guessing_minutes": [10, 120], "record_trouble_rows": [1, 100000],
                       "serious_pushes_per_hour": [1, 60], "serious_reason_pushes_per_day": [1, 24], "spike_event_floor": [10, 1000000],
                       "spike_learning_days": [1, 90], "spike_source_floor": [2, 100000], "subject_pushes_per_day": [1, 24],
                       "volume_pushes_per_day": [0, 100]}') r(k, v)),
  array_fill('changed/changed'::text, array[10]),
  '0480/133: and takes its most, then its least (no default is either''s most, so each is a change)');
-- Serious flags have their own cap for one reason a day
-- (serious_reason_pushes_per_day), apart from the volume alerts' cap for
-- one rule and subject (subject_pushes_per_day).
select pg_temp.fresh();
select pg_temp.sw(false, true);
create temporary table sep_set as
  select array[coalesce(pg_temp.setv(pg_temp.u(1), 'serious_reason_pushes_per_day', '2') ->> 'refused', 'changed'),
               coalesce(pg_temp.setv(pg_temp.u(1), 'subject_pushes_per_day', '1') ->> 'refused', 'changed')] as a;
select is(
  (select a from sep_set) || array[pg_temp.flood(4)],
  array['changed', 'changed', 'new:sent:true:false then new:sent:true:false x1, new:email_only_budget:false:true x2'],
  '0480/134: a serious reason''s pushes a day follow serious_reason_pushes_per_day (2 here), not the volume alerts'' subject_pushes_per_day (1 here); past it, by email');
-- At the lowest thresholds the console allows, a flood of one serious
-- reason still sends every new flag: the first by push when push is on,
-- every other by email (the floor) whatever the email switch says; only
-- both switches off sends nothing.
select pg_temp.fresh();
create temporary table least_set as
  select array_agg(r.k || ':' || coalesce(pg_temp.setv(pg_temp.u(1), r.k, r.v -> 0) ->> 'refused', 'changed') order by r.k) as a
    from jsonb_each('{"aimed_guessing_events": [5, 100000], "aimed_guessing_minutes": [10, 120], "record_trouble_rows": [1, 100000],
                      "serious_pushes_per_hour": [1, 60], "serious_reason_pushes_per_day": [1, 24], "spike_event_floor": [10, 1000000],
                      "spike_learning_days": [1, 90], "spike_source_floor": [2, 100000], "subject_pushes_per_day": [1, 24],
                      "volume_pushes_per_day": [0, 100]}') r(k, v);
select pg_temp.sw(false, true);
create temporary table least_flood as select 1 as n, pg_temp.flood(24) as a;
insert into least_flood
  select 2, (select count(*)::text from public.platform_security_alerts where email_floor = 'push_budget_spent');
delete from public.platform_security_alerts;
select pg_temp.sw(true, true);
insert into least_flood select 3, pg_temp.flood(24);
delete from public.platform_security_alerts;
select pg_temp.sw(true, false);
insert into least_flood select 4, pg_temp.flood(24);
delete from public.platform_security_alerts;
select pg_temp.sw(false, false);
insert into least_flood select 5, pg_temp.flood(2);
select is(
  (select a from least_set) || (select array_agg(a order by n) from least_flood),
  array['aimed_guessing_events:changed', 'aimed_guessing_minutes:changed', 'record_trouble_rows:unchanged',
        'serious_pushes_per_hour:changed', 'serious_reason_pushes_per_day:changed', 'spike_event_floor:changed',
        'spike_learning_days:changed', 'spike_source_floor:changed', 'subject_pushes_per_day:changed',
        'volume_pushes_per_day:changed',
        'new:sent:true:false then new:email_only_budget:false:true x23', '23',
        'new:sent:true:true then new:email_only_budget:false:true x23',
        'new:sent:false:true then new:sent:false:true x23',
        'new:record_only:false:false then new:record_only:false:false x1'],
  '0480/135: with every threshold at its least (serious pushes 1 an hour and 1 a day for one reason) a flood of one serious reason for 24 hours still sends every new flag: with push alone, the first by push and the other 23 by email although email alerts are off (push_budget_spent); with both, push and email then email; with email alone, all by email; only both off records it only');
select pg_temp.fresh();
create temporary table s1 as select pg_temp.setv(pg_temp.u(1), 'push_on', 'true') as a;
create temporary table s2 as select pg_temp.setv(pg_temp.u(2), 'spike_event_floor', '75', '50') as a;
create temporary table s3 as select pg_temp.setv(pg_temp.u(1), 'planned_check', '30') as a;
create temporary table s4 as select pg_temp.setv(pg_temp.u(1), 'push_on', 'false', 'true') as a;
select is(
  array[(select a from s1), (select a from s2), (select a - 'new_value' from s3), (select a from s4)],
  array[jsonb_build_object('changed', true, 'refused', null, 'name', 'push_on', 'old_value', false, 'new_value', true, 'changed_at', now()),
        jsonb_build_object('changed', true, 'refused', null, 'name', 'spike_event_floor', 'old_value', 50, 'new_value', 75, 'changed_at', now()),
        jsonb_build_object('changed', true, 'refused', null, 'name', 'planned_check', 'old_value', null, 'changed_at', now()),
        jsonb_build_object('changed', true, 'refused', null, 'name', 'push_on', 'old_value', true, 'new_value', false, 'changed_at', now())],
  '0480/136: a switch on and off again (compare-and-set as the console saw it), a threshold and a planned check each answer what changed from what to what');
select is(
  (select array[push_on::text, thresholds ->> 'spike_event_floor', (planned_check_until = now() + interval '30 minutes')::text]
     from public.platform_security_alert_state),
  array['false', '75', 'true'],
  '0480/137: and the state holds the new values (a planned check ends 30 minutes from now)');
select is(
  (select array_agg(actor_user_id::text || ' ' || name || ' ' || coalesce(old_value::text, '-') || ' ' || coalesce(new_value::text, '-')
                    order by name, old_value::text nulls first)
     from public.platform_security_alert_changes where changed_at = now()),
  array[pg_temp.u(1) || ' planned_check - ' || to_jsonb(now() + interval '30 minutes')::text,
        pg_temp.u(1) || ' push_on false true', pg_temp.u(1) || ' push_on true false',
        pg_temp.u(2) || ' spike_event_floor 50 75'],
  '0480/138: each change wrote its change row in the same call: who, which setting, from what to what');
create temporary table end_check as select pg_temp.setv(pg_temp.u(1), 'planned_check', '0') as a;
select is(
  array[(select a ->> 'new_value' from end_check),
        (select (planned_check_until = now())::text from public.platform_security_alert_state),
        pg_temp.setv(pg_temp.u(1), 'planned_check', '0') ->> 'refused'],
  array[null, 'true', 'unchanged'],
  '0480/139: a planned check of 0 ends it (the state keeps when, for the gap before the next), and ending none is unchanged');
update public.platform_security_alert_state set planned_check_until = now() - interval '1 second';
select is(
  pg_temp.setv(pg_temp.u(1), 'planned_check', '0', 'null') ->> 'refused',
  'unchanged',
  '0480/140: a planned check that has ended counts as none');
-- Planned checks: none while one is on or within 30 minutes of the last
-- one's end, at most 4 in a day; ending one is always taken. Time passing
-- is made by moving the check's end and its change rows back, as their
-- owner.
create function pg_temp.pass(p interval) returns void language sql as $$
  update public.platform_security_alert_state set planned_check_until = planned_check_until - p;
  update public.platform_security_alert_changes
     set changed_at = changed_at - p,
         old_value = case when name = 'planned_check' and old_value is not null
                          then to_jsonb((old_value #>> '{}')::timestamptz - p) else old_value end,
         new_value = case when name = 'planned_check' and new_value is not null
                          then to_jsonb((new_value #>> '{}')::timestamptz - p) else new_value end;
$$;
create function pg_temp.chk(p_minutes integer) returns text language sql as $$
  select coalesce(pg_temp.setv(pg_temp.u(1), 'planned_check', to_jsonb(p_minutes)) ->> 'refused', 'changed');
$$;
create function pg_temp.checks() returns text[] language plpgsql as $$
declare
  r text[] := '{}';
begin
  r := r || pg_temp.chk(30);                                        -- taken (1 of the day)
  r := r || pg_temp.chk(10);                                        -- one is on
  perform pg_temp.pass(interval '30 minutes');
  r := r || pg_temp.chk(30);                                        -- it ended this minute
  perform pg_temp.pass(interval '29 minutes');
  r := r || pg_temp.chk(30);                                        -- 29 minutes after its end
  perform pg_temp.pass(interval '1 minute');
  r := r || pg_temp.chk(30);                                        -- 30 minutes after: taken (2)
  r := r || pg_temp.chk(0);                                         -- ended early
  perform pg_temp.pass(interval '29 minutes');
  r := r || pg_temp.chk(30);                                        -- 29 minutes after the early end
  perform pg_temp.pass(interval '1 minute');
  r := r || pg_temp.chk(30);                                        -- taken (3)
  r := r || pg_temp.chk(0);
  perform pg_temp.pass(interval '30 minutes');
  r := r || pg_temp.chk(30);                                        -- taken (4)
  r := r || pg_temp.chk(0);
  perform pg_temp.pass(interval '30 minutes');
  r := r || pg_temp.chk(30);                                        -- a fifth in the day
  r := r || pg_temp.chk(0);                                         -- none on: unchanged
  perform pg_temp.pass(interval '24 hours');
  r := r || pg_temp.chk(30);                                        -- a day after the first: taken
  return r;
end;
$$;
select pg_temp.fresh();
select is(
  pg_temp.checks(),
  array['changed', 'planned_check_too_soon', 'planned_check_too_soon', 'planned_check_too_soon', 'changed', 'changed',
        'planned_check_too_soon', 'changed', 'changed', 'changed', 'changed', 'planned_checks_used_up', 'unchanged', 'changed'],
  '0480/141: a planned check is refused while one is on and within 30 minutes of the last one''s end (on its own or ended early), and past 4 in a day; ending one is always taken');
-- Pressed back to back, 29 minutes apart, for a day: at most 4 are taken,
-- so volume and record alerts cannot be held all day; record trouble during
-- the 49th press is sent.
create function pg_temp.chain() returns text language plpgsql as $$
declare
  i integer;
  n integer := 0;
  c jsonb;
begin
  for i in 1..48 loop
    if pg_temp.chk(30) = 'changed' then
      n := n + 1;
    end if;
    perform pg_temp.pass(interval '29 minutes');
  end loop;
  perform pg_temp.chk(30);
  c := pg_temp.claim('record_trouble', '', pg_temp.bk(-1));
  return n || ' of 48 taken; record trouble during the 49th: ' || coalesce(c ->> 'disposition', c ->> 'refused', '?');
end;
$$;
select pg_temp.fresh();
select pg_temp.sw(true, true);
select is(
  pg_temp.chain(),
  '4 of 48 taken; record trouble during the 49th: sent',
  '0480/142: planned checks cannot be chained for a day: of 48 pressed 29 minutes apart 4 are taken, and record trouble during the 49th press is sent');

-- ── 17. The console's read ──────────────────────────────────────────────────
select pg_temp.fresh();
select pg_temp.sw(true, true);
select pg_temp.claim('aimed_guessing', pg_temp.o(7)::text, pg_temp.bk(-2));
select pg_temp.claim('serious_flag', '', pg_temp.hk('sign_in_not_me', now()), 'started', '{"events": 2}');
select pg_temp.age(id, interval '6 minutes') from public.platform_security_alerts where rule = 'aimed_guessing';
select pg_temp.hb('start');
select pg_temp.setv(pg_temp.u(1), 'summary_on', 'true');
insert into public.platform_security_alert_changes (changed_at, actor_user_id, name, old_value, new_value)
values (now() - interval '1 day', pg_temp.u(2), 'push_on', 'false', 'true');
create temporary table l1 as select pg_temp.lst() as a;
select is(
  (select array[pg_temp.keys_of(a)::text, pg_temp.keys_of(a -> 'state')::text, pg_temp.keys_of(a -> 'state' -> 'heartbeat')::text,
                pg_temp.keys_of(a -> 'state' -> 'baseline')::text, (a -> 'budget')::text]
     from l1),
  array['{alerts,alerts_truncated,budget,changes,changes_truncated,generated_at,latest_changes,refused,state}',
        '{baseline,email_on,heartbeat,planned_check_until,push_on,record_only,summary_on,thresholds}',
        '{failure_reported_at,failures_in_a_row,last_ok_at,last_run_finished_at,last_run_ok,last_run_partial,last_run_started_at}',
        '{computed_at,event_high,from,shortened,source_high,to}',
        '{"volume_pushes_last_day": 1, "volume_emails_last_day": 1, "record_emails_last_day": 0, "serious_pushes_last_hour": 1, "serious_pushes_last_day_by_reason": {"sign_in_not_me": 1}}'::jsonb::text],
  '0480/143: the list has exactly its documented keys, the state without the run token, and the push slots and emails used (serious pushes of the day by reason)');
select is(
  (select array[(a::text like '%' || (select last_run_id::text from public.platform_security_alert_state) || '%')::text,
                (a -> 'state' ->> 'summary_on'), (a -> 'state' ->> 'record_only')]
     from l1),
  array['false', 'true', 'false'],
  '0480/144: the run token is nowhere in it; the switches are');
select is(
  (select array_agg((e ->> 'rule') || ':' || coalesce(e ->> 'organization_name', '-') || ':' || (e ->> 'awaiting_result') || ':'
                    || (e ->> 'overdue') || ':' || (e -> 'counts')::text order by o)
     from l1, jsonb_array_elements(pg_temp.arr(a -> 'alerts')) with ordinality x(e, o)),
  array['serious_flag:-:true:false:{"events": 2}', 'aimed_guessing:' || left('Example ' || repeat('Long Name ', 30), 200) || ':true:true:{}'],
  '0480/145: the alerts newest first, an organization''s name (the longest a name can be, 200 characters) for aimed guessing, whether each awaits its result and is overdue (5 minutes)');
select is(
  (select array[(a -> 'changes' -> 0 ->> 'name'), (a -> 'changes' -> 0 ->> 'actor_user_id'), (a -> 'changes' -> 1 ->> 'name'),
                (a -> 'changes' -> 1 ->> 'actor_user_id'), pg_temp.alen(a -> 'changes')::text]
     from l1),
  array['summary_on', pg_temp.u(1)::text, 'push_on', pg_temp.u(2)::text, '2'],
  '0480/146: and the change history newest first, who and what');
select pg_temp.claim('aimed_guessing', pg_temp.o(g)::text, pg_temp.bk(-1)) from generate_series(1, 210) g;
select pg_temp.setv(pg_temp.u(1), 'summary_on', to_jsonb(g % 2 = 0)) from generate_series(1, 3) g;
select is(
  array[pg_temp.alen(pg_temp.lst() -> 'alerts'), pg_temp.alen(pg_temp.lst(1) -> 'alerts'), pg_temp.alen(pg_temp.lst(0) -> 'alerts'),
        pg_temp.alen(pg_temp.lst(500) -> 'alerts'), pg_temp.alen(pg_temp.lst(null, 2) -> 'changes'),
        pg_temp.alen(pg_temp.lst(null, 500) -> 'changes')],
  array[50, 1, 1, 200, 2, 5],
  '0480/147: 50 alerts unless asked, at least 1 and at most 200; the changes the same way');
select is(
  array[pg_temp.lst(200) ->> 'alerts_truncated', pg_temp.lst(212) ->> 'alerts_truncated', pg_temp.lst(null, 3) ->> 'changes_truncated',
        pg_temp.lst(null, 5) ->> 'changes_truncated'],
  array['true', 'true', 'true', 'false'],
  '0480/148: and say when there are more');
-- A switch turned off and a threshold silenced, then 200 harmless toggles:
-- who did each and when is still in the read.
create function pg_temp.toggles(p_n integer) returns void language plpgsql as $$
declare
  i integer;
begin
  for i in 1..p_n loop
    update public.platform_security_alert_changes set changed_at = changed_at - interval '1 second';
    perform pg_temp.setv(pg_temp.u(1), 'summary_on', to_jsonb(i % 2 = 1));
  end loop;
end;
$$;
select pg_temp.fresh();
select pg_temp.setv(pg_temp.u(1), 'email_on', 'true');
update public.platform_security_alert_changes set changed_at = changed_at - interval '1 second';
select pg_temp.setv(pg_temp.u(2), 'email_on', 'false');
update public.platform_security_alert_changes set changed_at = changed_at - interval '1 second';
select pg_temp.setv(pg_temp.u(2), 'aimed_guessing_events', '100000');
select pg_temp.toggles(200);
create temporary table l2 as select pg_temp.lst(200, 200) as a;
select is(
  (select array[pg_temp.alen(a -> 'changes')::text, a ->> 'changes_truncated',
                (select count(*)::text from jsonb_array_elements(pg_temp.arr(a -> 'changes')) e
                  where e ->> 'name' in ('email_on', 'aimed_guessing_events')),
                (select string_agg((e ->> 'name') || ':' || (e ->> 'actor_user_id') || ':' || (e ->> 'old_value') || '>' || (e ->> 'new_value'), ','
                                   order by e ->> 'name')
                   from jsonb_array_elements(pg_temp.arr(a -> 'latest_changes')) e),
                (select count(*)::text from jsonb_array_elements(pg_temp.arr(a -> 'latest_changes')) e where e ? 'changed_at')]
     from l2),
  array['200', 'true', '0',
        'aimed_guessing_events:' || pg_temp.u(2) || ':20>100000,email_on:' || pg_temp.u(2) || ':true>false,summary_on:' || pg_temp.u(1) || ':true>false',
        '3'],
  '0480/149: the latest change of every setting is always in the read, however many came after it: a channel turned off and a threshold silenced, then 200 toggles, still show who did each');

-- ── 18. The baseline ────────────────────────────────────────────────────────
savepoint baseline;
select pg_temp.fresh();
-- 1008 buckets in the week (b-1008 to b-1). Events (blocked and flagged):
-- 1100 in the oldest, 1000 in the newest, 900 to 100 in nine more, 5 in one,
-- and 1 to 12 in twelve more (one source each row, so 1 to 12 sources). The
-- 11th largest (the 99th percentile of 1008) is 100 events and 2 sources.
-- Not counted: the bucket before the week, the one running now, a tally, an
-- allowed count, and 20 allowed sources.
select pg_temp.ev(pg_temp.at(-1009), 'exploit', 'blocked', 'env_file', 'web', null, null, null, 50000);
select pg_temp.ev(pg_temp.at(0), 'exploit', 'blocked', 'env_file', 'web', null, null, null, 9999);
select pg_temp.ev(pg_temp.at(-1008), 'exploit', 'blocked', 'env_file', 'web', null, null, null, 1100);
select pg_temp.ev(pg_temp.at(-1), 'exploit', 'blocked', 'env_file', 'web', null, null, null, 1000);
select pg_temp.ev(pg_temp.at(-100 * g - 50), 'exploit', 'flagged', 'env_file', 'web', null, null, null, 1000 - 100 * g)
  from generate_series(1, 9) g;
select pg_temp.ev(pg_temp.at(-500, 3), 'exploit', 'blocked', 'git_dir', 'web', null, null, null, 5);
select pg_temp.ev(pg_temp.at(-1 - g, 0), 'bots', 'blocked', 'public_order_paused', 'web', null, null, null, 1, pg_temp.h(100 * g + s))
  from generate_series(1, 12) g, generate_series(1, g) s;
select pg_temp.ev(pg_temp.at(-200), 'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', null, null, null, 100000);
select pg_temp.ev(pg_temp.at(-201), 'bots', 'allowed', 'public_order_paused', 'web', null, null, null, 100000);
select pg_temp.ev(pg_temp.at(-300), 'bots', 'allowed', 'public_order_paused', 'web', null, null, null, 1, pg_temp.h(9000 + g))
  from generate_series(1, 20) g;
create temporary table base1 as select pg_temp.base() as a;
select is(
  (select a - 'computed_at' from base1),
  jsonb_build_object('computed', true, 'refused', null, 'event_high', 100, 'source_high', 2,
                     'from', pg_temp.b(-1008), 'to', pg_temp.b(0), 'asked_from', pg_temp.b(-1008), 'shortened', false,
                     'buckets', 1008),
  '0480/150: the baseline: the 99th percentile of the week''s 1008 whole buckets, empty ones included: 100 events and 2 sources (blocked and flagged, no tally, no allowed event or source, not the bucket running now, not the one before the week)');
select is(
  (select array[baseline_event_high, baseline_source_high]::text[] || array[(baseline_computed_at = now())::text,
                baseline_shortened::text, (baseline_from = pg_temp.b(-1008))::text]
     from public.platform_security_alert_state),
  array['100', '2', 'true', 'false', 'true'],
  '0480/151: and stored in the state row');
select is(
  array[pg_temp.inp() -> 'baseline' ->> 'event_mark', pg_temp.inp() -> 'baseline' ->> 'source_mark',
        pg_temp.base() ->> 'refused'],
  array['100', '10', 'computed_recently'],
  '0480/152: the inputs give its marks with their floors (100 events over a floor of 50; 2 sources under a floor of 10); a second baseline within 6 hours is refused');
update public.platform_security_alert_state set baseline_computed_at = now() - interval '6 hours 1 second';
select is(pg_temp.base() ->> 'computed', 'true', '0480/153: one 6 hours old is computed again');
rollback to savepoint baseline;

-- ── 19. Retention ───────────────────────────────────────────────────────────
select pg_temp.fresh();
insert into public.platform_security_alerts (rule, class, subject, event_key, phase, disposition, claimed_at)
select 'aimed_guessing', 'volume', pg_temp.o(1 + g % 100)::text, to_char(pg_temp.b(-g) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
       'started', 'record_only', now() - interval '400 days' - make_interval(secs => g)
  from generate_series(1, 5001) g;
select pg_temp.raw(jsonb_build_object('event_key', pg_temp.bk(-1), 'claimed_at', now() - interval '400 days'));
select pg_temp.raw(jsonb_build_object('event_key', pg_temp.bk(-2), 'claimed_at', now() - interval '399 days 23 hours'));
select pg_temp.setv(pg_temp.u(1), 'push_on', 'true');
update public.platform_security_alert_changes set changed_at = now() - interval '500 days';
create temporary table purge1 as select pg_temp.purge() as a;
create temporary table purge_left as
  select jsonb_build_object('left', count(*), 'oldest_left', min(event_key)) as a
    from public.platform_security_alerts where claimed_at < now() - interval '400 days';
create temporary table purge2 as select pg_temp.purge() as a;
select is(
  array[(select a from purge1), (select a from purge_left), (select a from purge2), pg_temp.purge()],
  array['{"deleted": 5000}'::jsonb, jsonb_build_object('left', 1, 'oldest_left', pg_temp.bk(-1)),
        '{"deleted": 1}'::jsonb, '{"deleted": 0}'::jsonb],
  '0480/154: the purge deletes alerts claimed more than 400 days ago, the oldest first, 5,000 a call, until none is left');
select is(
  (select array[count(*), (select count(*) from public.platform_security_alert_changes)]::text[] from public.platform_security_alerts),
  array['2', '1'],
  '0480/155: one claimed exactly 400 days ago and a younger one stay, and the change history is kept');

-- ── 20. Who gets a push ─────────────────────────────────────────────────────
-- u1 confirmed; u2 confirmed, written in capitals; u3 not confirmed; u4
-- banned until tomorrow; u5 banned until yesterday; u6 deleted in Auth; u7
-- disabled by the console; u8 a deleted profile; u9 no profile; u10 an SSO
-- account; u11 an anonymous one.
select is(
  pg_temp.ids(array['a.admin@example.test', 'b.admin@example.test', 'c.admin@example.test', 'd.admin@example.test',
                    'e.admin@example.test', 'f.admin@example.test', 'g.admin@example.test', 'h.admin@example.test',
                    'i.admin@example.test', 'j.admin@example.test', 'k.admin@example.test']),
  '1,2,5',
  '0480/156: the accounts whose confirmed sign-in email is on the list, left out: not confirmed, banned in Auth, deleted in Auth, disabled by the console (user_profiles.disabled_at), a deleted profile, no profile, an SSO or an anonymous account');
select is(
  array[pg_temp.ids(array['  A.ADMIN@Example.Test ']), pg_temp.ids(array['B.ADMIN@EXAMPLE.TEST', 'b.admin@example.test']),
        pg_temp.ids(array['a.admin@example.test', 'a.admin@example.test'])],
  array['1', '2', '1'],
  '0480/157: in any case and trimmed, each account once');
select is(
  array[pg_temp.ids(null), pg_temp.ids('{}'), pg_temp.ids(array[null, '', 'a.admin', '@example.test', 'a.admin@', 'a b@example.test',
                                                             'a@b@example.test', repeat('a', 320) || '@example.test']),
        pg_temp.ids(array['other@example.test'])],
  array['none', 'none', 'none', 'none'],
  '0480/158: none for no list, an empty one, entries that are not addresses, or no match; never raises');
select is(
  array[pg_temp.ids((select array_agg('nobody' || g || '@example.test') from generate_series(1, 19) g) || array['a.admin@example.test']),
        pg_temp.ids((select array_agg('nobody' || g || '@example.test') from generate_series(1, 20) g) || array['a.admin@example.test'])],
  array['1', 'none'],
  '0480/159: at most 20 addresses are read: the 20th is, the 21st is not');
update auth.users set email_confirmed_at = null where id = pg_temp.u(1);
select is(
  pg_temp.ids(array['a.admin@example.test']),
  'none',
  '0480/160: the sign-in email Auth confirmed decides, not the profile''s copy of it (unconfirmed, the account is left out)');
select is(
  (select array[prosrc ~ 'auth\.users', prosrc ~ 'email_confirmed_at', prosrc ~ 'disabled_at', prosrc ~ 'banned_until',
                prosrc !~ 'p\.email']
     from pg_proc where oid = 'public.platform_admin_user_ids(text[])'::regprocedure),
  array[true, true, true, true, true],
  '0480/161: the body reads auth.users and its confirmation, the console''s disable flag and Auth''s ban, and never the profile''s email');

-- ── 21. The answers keep their shape ────────────────────────────────────────
select pg_temp.fresh();
select is(
  array[pg_temp.keys_of(pg_temp.claim('spike', '', pg_temp.bk(-3)))::text,
        pg_temp.keys_of(pg_temp.claim('spike', '', pg_temp.bk(-3)))::text,
        pg_temp.keys_of(pg_temp.claim('nothing', '', pg_temp.bk(-3)))::text,
        pg_temp.keys_of(pg_temp.claim('spike', '', pg_temp.bk(-2)))::text],
  array_fill('{attempt,disposition,email,id,notice,open_key,outcome,push,refused}'::text, array[4]),
  '0480/162: a claim always answers the same nine keys (new, duplicate, refused, already_open)');
select is(
  array[pg_temp.keys_of(pg_temp.res(null, 1))::text, pg_temp.keys_of(pg_temp.hb('start'))::text,
        pg_temp.keys_of(pg_temp.setv(null, 'x', 'true'))::text, pg_temp.keys_of(pg_temp.base())::text],
  array['{recorded,refused}', '{failures_in_a_row,last_ok_at,marked_not_sent,missed_runs,previous,refused,report_now,run_id,step}',
        '{changed,changed_at,name,new_value,old_value,refused}',
        '{asked_from,buckets,computed,computed_at,event_high,from,refused,shortened,source_high,to}'],
  '0480/163: the result, the heartbeat''s start, the set and the baseline answer their documented keys');
-- The latest run's finish with no outcome, in a statement of its own (a
-- start in the same statement would make that run not the latest).
create temporary table odd_calls as
  select array[pg_temp.hb('finish', (select last_run_id from public.platform_security_alert_state), null),
               pg_temp.hb('finish', gen_random_uuid(), null), pg_temp.hb('finish', null, true),
               pg_temp.setv(pg_temp.u(1), 'planned_check', '1e3'), pg_temp.setv(pg_temp.u(1), 'spike_event_floor', '99999999999'),
               pg_temp.res(gen_random_uuid(), 2147483647, '{"sent": 100}'), pg_temp.res(gen_random_uuid(), -1, null, '{"sent": 0}')] as a;
select is(
  (select count(*)::int from (values (null::text), ('start'), ('finish')) v(s),
          lateral (select pg_temp.hb(v.s, null, null) ->> 'raised' as r1,
                          pg_temp.setv(null, v.s, to_jsonb(v.s)) ->> 'raised' as r2,
                          pg_temp.res(null, null, to_jsonb(v.s), to_jsonb(v.s)) ->> 'raised' as r3) z
    where coalesce(z.r1, z.r2, z.r3) is not null)
  + (select count(*)::int from odd_calls, unnest(odd_calls.a) x(a) where x.a ? 'raised'),
  0,
  '0480/164: no argument makes the result, the heartbeat or the set raise (a finish of the latest run with no outcome among them)');

-- ── 22. Comments ────────────────────────────────────────────────────────────
select ok(
  (select bool_and(obj_description(c.oid, 'pg_class') like '%No API role reads or writes it directly%')
     from pg_class c
    where c.oid in ('public.platform_security_alert_state'::regclass, 'public.platform_security_alerts'::regclass,
                    'public.platform_security_alert_changes'::regclass)),
  '0480/165: each table says no API role reads or writes it directly');
select ok(
  (select bool_and(obj_description(p.oid, 'pg_proc') like '%service_role only%') from pg_proc p where pg_temp.is_ours(p.oid)),
  '0480/166: each function says it is service_role only');
select ok(
  (select obj_description('public.platform_security_alerts'::regclass, 'pg_class') like '%never from the run''s clock%'
          and obj_description('public.platform_security_alerts'::regclass, 'pg_class') like '%never an address%'),
  '0480/167: the alerts table says its key comes from the events and it holds no address');

select * from finish();
rollback;
