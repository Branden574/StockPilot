-- supabase/tests/0478_platform_security_map.test.sql
-- Proves migration 0478: the read behind the platform console's attack map.
--   public._security_map_units(timestamptz, timestamptz)                    private: the counting rules, once
--   public.platform_security_map(timestamptz, timestamptz, timestamptz)     the map's one document
--
-- WHAT IS WORTH PINNING
--   1. The grant is the whole control. anon and authenticated hold EXECUTE on
--      neither function; service_role on the public one only; nobody on the
--      private one. No body names any of the four words security_invariants
--      INV-25 accepts as a gate, so if EXECUTE ever reaches authenticated
--      INV-25 names the function: shown here by granting it inside a
--      savepoint. With that grant in place the second lock in each body
--      still refuses a member and a signed-out caller.
--   2. Read-only: STABLE, and no write statement in either body (the write
--      forms of the security invariant suite's bare word list).
--   3. The four lists the counting rules need are written once, in the
--      private function, and are held here to the letter: a change to one
--      of them fails this file until the list below changes with it.
--   4. The fold: a sign-in event recorded once in each organization of one
--      account is one, with the largest count among its rows, not their
--      sum; another place, minute or source is another event.
--   5. A tally (a count of other rows) is in no total, no cell and no entry
--      of the feed: only in the list of tallies. Shown for every reason of
--      the list.
--   6. A row that stands for events past a cap is counted, has no place
--      whatever the row holds, and is listed with the floods.
--   7. Every number of a made-up record worked out by hand (the working is
--      beside the fixture): totals, events with no country, by country, the
--      cells of the timeline, the feed, the late sources.
--   8. The edges: a row is in the window when its minute starts at or after
--      the start and before the end; the 10-minute buckets sit on the UTC
--      clock; the 1-minute buckets are the window's last ten minutes.
--   9. The caps (4,000 cells, 2,000 groups by country, 60 entries) and the
--      flags that say when they cut.
--  10. A window that cannot be read is answered with a fixed word and never
--      raises; the answer never repeats the argument.
--  11. Blocked since the day start, for a day start inside the window, on
--      its edges and outside it.
--  12. An organization's name is cut at 200 characters; every time in the
--      answer is written in UTC whatever the session's time zone is.
--
-- now() is fixed for the whole transaction and the function uses it. Every
-- row below is placed from T0, a 10-minute mark between 5 hours and 5 hours
-- 10 minutes ago, so no assertion depends on the clock. m(n) is T0 plus n
-- minutes. Namespace a0478000. Every organization, place and value is made
-- up. Wrapped in begin/rollback: nothing leaks. Run via `supabase test db`
-- after `supabase db reset`.

begin;

select plan(73);

\set orgA '\'a0478000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0478000-0000-0000-0000-0000000000b1\''
\set orgC '\'a0478000-0000-0000-0000-0000000000c1\''
\set orgL '\'a0478000-0000-0000-0000-0000000000d1\''

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Every grant on a function other than its owner's, as role:privilege.
create function pg_temp.grants_of(p regprocedure) returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type), '{}'::text[])
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
   where pr.oid = p and x.grantee <> pr.proowner;
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
     and p.proname like '%security\_map%';
$$;

create function pg_temp.keys_of(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(k order by k), '{}'::text[]) from jsonb_object_keys(p) k;
$$;

-- The five categories with the three outcomes each, zeros unless given:
-- cats('{"bots": {"blocked": 3}}').
create function pg_temp.cats(p jsonb) returns jsonb language sql as $$
  select jsonb_object_agg(c, jsonb_build_object(
           'blocked', coalesce((p -> c ->> 'blocked')::bigint, 0),
           'flagged', coalesce((p -> c ->> 'flagged')::bigint, 0),
           'allowed', coalesce((p -> c ->> 'allowed')::bigint, 0)))
    from unnest(array['password_guessing', 'exploit', 'bots', 'phishing', 'malware']) c;
$$;

-- One of the four lists, as the private function's body writes it.
create function pg_temp.list_of(p_name text) returns text language sql as $$
  select (regexp_match(p.prosrc, '\m' || p_name || '\s+constant text\[\] := array\[([^\]]*)\];'))[1]
    from pg_proc p where p.oid = 'public._security_map_units(timestamptz, timestamptz)'::regprocedure;
$$;
create function pg_temp.list_items(p_name text) returns text[] language sql as $$
  select coalesce(array_agg(m[1] order by o), '{}'::text[])
    from regexp_matches(pg_temp.list_of(p_name), '''([^'']*)''', 'g') with ordinality as x(m, o);
$$;

-- The record is emptied for this transaction (the rollback at the end puts
-- everything back), so every number below counts from zero.
delete from public.security_events;

-- T0 and m(n).
create temporary table clock as
  select date_bin('10 minutes', now() - interval '5 hours', timestamptz '2000-01-01 00:00:00+00') as t0;
create function pg_temp.m(p_minutes integer) returns timestamptz language sql stable as $$
  select c.t0 + make_interval(mins => p_minutes) from pg_temp.clock c;
$$;
-- A made-up country code for a number from 1 to 676: AA, AB, ... ZZ.
create function pg_temp.cc(p integer) returns text language sql immutable as $$
  select chr(65 + (p - 1) / 26) || chr(65 + (p - 1) % 26);
$$;

-- One row of the record at m(p_minute), as the table's owner.
create function pg_temp.ev(p_minute integer, p_category text, p_outcome text, p_reason text, p_source text,
                           p_org uuid, p_country text, p_city text, p_count integer)
returns void language sql as $$
  insert into public.security_events (minute, category, outcome, reason, source, organization_id, country, city,
                                      event_count, dedupe_key)
  values (pg_temp.m(p_minute), p_category, p_outcome, p_reason, p_source, p_org, p_country, p_city, p_count,
          md5(gen_random_uuid()::text));
$$;

-- The lists of an answer as lines, in the answer's own order. A time is
-- written as its minutes after T0; nothing is '-'.
create function pg_temp.mins(p text) returns text language sql stable as $$
  select (extract(epoch from (p::timestamptz - c.t0)) / 60)::integer::text from pg_temp.clock c;
$$;
create function pg_temp.timeline_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg(pg_temp.mins(e ->> 'bucket_start') || '|' || (e ->> 'bucket_seconds') || '|'
                            || (e ->> 'country') || '|' || (e ->> 'category') || '|' || (e ->> 'outcome') || '|'
                            || (e ->> 'events') order by o), '{}'::text[])
    from jsonb_array_elements(p -> 'timeline') with ordinality as x(e, o);
$$;
create function pg_temp.country_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg((e ->> 'country') || '|' || (e ->> 'category') || '|' || (e ->> 'outcome') || '|'
                            || (e ->> 'events') order by o), '{}'::text[])
    from jsonb_array_elements(p -> 'by_country') with ordinality as x(e, o);
$$;
create function pg_temp.feed_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg(pg_temp.mins(e ->> 'minute') || '|' || (e ->> 'category') || '|' || (e ->> 'outcome') || '|'
                            || (e ->> 'reason') || '|' || (e ->> 'source') || '|' || coalesce(e ->> 'country', '-') || '|'
                            || coalesce(e ->> 'city', '-') || '|' || (e ->> 'events') || '|'
                            || coalesce(e ->> 'organization_name', '-') || '|' || (e ->> 'organizations')
                            order by o), '{}'::text[])
    from jsonb_array_elements(p -> 'feed') with ordinality as x(e, o);
$$;
create function pg_temp.reason_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg((e ->> 'reason') || '|' || (e ->> 'source') || '|' || (e ->> 'category') || '|'
                            || (e ->> 'outcome') || '|' || (e ->> 'events') || '|' || (e ->> 'rows') order by o), '{}'::text[])
    from jsonb_array_elements(p) with ordinality as x(e, o);
$$;
create function pg_temp.late_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg((e ->> 'source') || '|' || (e ->> 'category') || '|' || (e ->> 'outcome') || '|'
                            || (e ->> 'events') order by o), '{}'::text[])
    from jsonb_array_elements(p -> 'late_sources') with ordinality as x(e, o);
$$;
-- The distinct sets of keys of a list's objects: one set when every object
-- has the same keys; 'empty' for an empty list.
create function pg_temp.key_sets(p jsonb) returns text language sql as $$
  select coalesce(string_agg(distinct array_to_string(pg_temp.keys_of(e), ','), ' / '), 'empty')
    from jsonb_array_elements(p) e;
$$;
-- The answer of a call, or what it raised (a call of the map must never
-- raise for an argument).
create function pg_temp.answer_of(p_sql text) returns jsonb language plpgsql as $$
declare
  v_answer jsonb;
  v_state  text;
  v_msg    text;
begin
  execute p_sql into v_answer;
  return v_answer;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return jsonb_build_object('raised', v_state || '|' || v_msg);
end;
$$;
-- The lines that match a LIKE pattern, in their order.
create function pg_temp.pick(p_lines text[], p_like text) returns text[] language sql immutable as $$
  select coalesce(array_agg(l order by o), '{}'::text[])
    from unnest(p_lines) with ordinality as x(l, o)
   where l like p_like;
$$;
-- The sum of the events of a list of cells.
create function pg_temp.events_of(p jsonb, p_seconds integer) returns bigint language sql as $$
  select coalesce(sum((e ->> 'events')::bigint), 0)::bigint
    from jsonb_array_elements(p) e
   where p_seconds is null or (e ->> 'bucket_seconds')::integer = p_seconds;
$$;

-- ── 1. An empty record ──────────────────────────────────────────────────────
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(45)),
  jsonb_build_object(
    'window', jsonb_build_object('from', pg_temp.m(0), 'to', pg_temp.m(120), 'live_from', pg_temp.m(110)),
    'refused', null,
    'generated_at', now(),
    'oldest_event_at', null,
    'timeline', '[]'::jsonb, 'timeline_truncated', false,
    'by_country', '[]'::jsonb, 'by_country_truncated', false,
    'totals', pg_temp.cats('{}'), 'no_place', pg_temp.cats('{}'),
    'blocked_window', 0, 'flagged_window', 0, 'allowed_window', 0,
    'day_start', pg_temp.m(45), 'blocked_since_day_start', 0,
    'feed', '[]'::jsonb, 'late_sources', '[]'::jsonb, 'tallies', '[]'::jsonb, 'flood_rows', '[]'::jsonb),
  '0478/1: with no row on record the answer is whole: every key, every category and outcome as zero, empty lists, no oldest minute, and zero blocked since a day start inside the window');
select is(
  (select count(*)::int from public._security_map_units(pg_temp.m(0), pg_temp.m(120))),
  0,
  '0478/2: and the private function returns no unit');

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Example Map Academy',   'a0478000-example-map-academy',   'optional'),
  (:orgB, 'Example Map Charter',   'a0478000-example-map-charter',   'optional'),
  (:orgC, 'Example Map Institute', 'a0478000-example-map-institute', 'optional');

-- THE RECORD, AND THE HAND WORKING. The window asked for is m(0) to m(120):
-- two hours, twelve 10-minute buckets b0 (m0 to m9) ... b11 (m110 to m119);
-- its last ten minutes are m110 to m119.
--
-- P: ordinary events with a place.
--   P1, P2: the same kind twice in one minute (two sources): 5 + 2. On the
--   window's first minute, which is also a bucket's first.
select pg_temp.ev(0,   'password_guessing', 'blocked', 'wrong_password',      'web', :orgA, 'US', 'Example Springs', 5);
select pg_temp.ev(0,   'password_guessing', 'blocked', 'wrong_password',      'web', :orgA, 'US', 'Example Springs', 2);
--   P3: the last minute of b0. P4: the first minute of b1.
select pg_temp.ev(9,   'password_guessing', 'blocked', 'wrong_password',      'web', null,  'US', 'Example Springs', 3);
select pg_temp.ev(10,  'exploit',           'blocked', 'env_file',            'web', null,  'DE', null, 4);
select pg_temp.ev(35,  'bots',              'blocked', 'public_order_paused', 'web', :orgB, 'FR', 'Example Ville', 6);
--   P6: an allowed event: its own outcome, never blocked.
select pg_temp.ev(35,  'malware',           'allowed', 'upload_allowed',      'web', :orgB, 'FR', null, 1);
--   P9: the minute before the last ten. P8: the first of the last ten. P7:
--   the window's last minute.
select pg_temp.ev(109, 'exploit',           'blocked', 'git_dir',             'web', null,  'DE', null, 8);
select pg_temp.ev(110, 'exploit',           'blocked', 'git_dir',             'web', null,  'DE', null, 2);
select pg_temp.ev(119, 'password_guessing', 'blocked', 'wrong_password',      'web', null,  'US', null, 7);
-- X: outside the window. X1 on the minute the window ends at; X2 a minute
-- before it starts (the oldest row on record).
select pg_temp.ev(120, 'bots',              'blocked', 'public_order_paused', 'web', null,  'US', null, 1000);
select pg_temp.ev(-1,  'bots',              'blocked', 'public_order_paused', 'web', null,  'US', null, 2000);
-- N: no country. N2 has a city and no country: still no place.
select pg_temp.ev(20,  'bots',              'blocked', 'share_link_paused',   'web', null,  null, null, 9);
select pg_temp.ev(21,  'password_guessing', 'flagged', 'passkey_counter_went_back', 'web', :orgA, null, 'Example Hamlet', 2);
-- F: rows that stand for events past a cap. F2 was given a place by hand:
-- it must have none in the answer. F3 and F4 are two rows of one kind.
select pg_temp.ev(40,  'bots',              'blocked', 'over_minute_cap',     'web', null,  null, null, 50);
select pg_temp.ev(40,  'bots',              'blocked', 'over_minute_cap',     'web', :orgA, 'FR', 'Example Ville', 30);
select pg_temp.ev(41,  'exploit',           'blocked', 'over_buffer_cap',     'web', null,  null, null, 20);
select pg_temp.ev(41,  'exploit',           'blocked', 'over_buffer_cap',     'web', null,  null, null, 5);
-- T: tallies. T2 was given a country by hand and sits in the last ten
-- minutes: it must still be in no total and no cell.
select pg_temp.ev(60,  'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', null, null, null, 700);
select pg_temp.ev(115, 'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', null, 'US', null, 300);
-- L: the phone and the api (late). L3 is in the last ten minutes. L4 is
-- the hourly reader's own remainder row: no place, and not a flood row.
select pg_temp.ev(50,  'password_guessing', 'blocked', 'wrong_password',      'phone', null, 'US', null, 11);
select pg_temp.ev(51,  'bots',              'blocked', 'auth_rate_limited',   'api',   null, null, null, 13);
select pg_temp.ev(112, 'password_guessing', 'blocked', 'wrong_password',      'api',   null, 'US', null, 4);
select pg_temp.ev(52,  'password_guessing', 'blocked', 'auth_log_over_cap',   'phone', null, null, null, 17);
-- S: the sign-in events that are recorded once in each organization.
--   S1: one account in three organizations: 1, not 3.
select pg_temp.ev(70,  'phishing', 'flagged', 'sign_in_new_country', 'web', :orgA, 'PT', 'Example Harbour', 1);
select pg_temp.ev(70,  'phishing', 'flagged', 'sign_in_new_country', 'web', :orgB, 'PT', 'Example Harbour', 1);
select pg_temp.ev(70,  'phishing', 'flagged', 'sign_in_new_country', 'web', :orgC, 'PT', 'Example Harbour', 1);
--   S2: the same minute from another place: another event.
select pg_temp.ev(70,  'phishing', 'flagged', 'sign_in_new_country', 'web', :orgA, 'ES', 'Example Plaza', 1);
--   S7: the same minute and place from the phone: another event (and late).
select pg_temp.ev(70,  'phishing', 'flagged', 'sign_in_new_country', 'phone', :orgB, 'PT', 'Example Harbour', 1);
--   S3: 2 in one organization and 1 in another: 2 (the largest), not 3.
select pg_temp.ev(71,  'phishing', 'flagged', 'sign_in_not_me',      'web', :orgA, 'IT', 'Example Piazza', 2);
select pg_temp.ev(71,  'phishing', 'flagged', 'sign_in_not_me',      'web', :orgB, 'IT', 'Example Piazza', 1);
--   S4: the third reason of the list, 3 in each of two organizations: 3.
select pg_temp.ev(72,  'password_guessing', 'flagged', 'sign_in_alerts_held', 'phone', :orgA, 'GB', 'Example Borough', 3);
select pg_temp.ev(72,  'password_guessing', 'flagged', 'sign_in_alerts_held', 'phone', :orgB, 'GB', 'Example Borough', 3);
--   S5: one organization only: it is named. S6: no organization.
select pg_temp.ev(73,  'phishing', 'flagged', 'sign_in_new_country', 'web', :orgC, 'BR', null, 1);
select pg_temp.ev(74,  'phishing', 'flagged', 'sign_in_not_me',      'web', null,  'JP', 'Example Bay', 1);
--   S8: in the last ten minutes, two organizations: 1.
select pg_temp.ev(118, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgA, 'PT', 'Example Harbour', 1);
select pg_temp.ev(118, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgB, 'PT', 'Example Harbour', 1);
--
-- TOTALS (the tallies, 700 and 300, are in none):
--   password_guessing blocked  P1 5 + P2 2 + P3 3 + P7 7 + L1 11 + L3 4 + L4 17      = 49
--   password_guessing flagged  N2 2 + S4 3                                            = 5
--   exploit blocked            P4 4 + P9 8 + P8 2 + F3 20 + F4 5                      = 39
--   bots blocked               P5 6 + N1 9 + F1 50 + F2 30 + L2 13                    = 108
--   phishing flagged           S1 1 + S2 1 + S7 1 + S3 2 + S5 1 + S6 1 + S8 1         = 8
--   malware allowed            P6                                                     = 1
--   blocked 49 + 39 + 108 = 196; flagged 5 + 8 = 13; allowed 1; all 210.
-- NO COUNTRY:
--   password_guessing blocked  L4 17
--   password_guessing flagged  N2 2
--   exploit blocked            F3 20 + F4 5 = 25
--   bots blocked               N1 9 + F1 50 + F2 30 + L2 13 = 102             all 146.
-- BY COUNTRY (210 - 146 = 64):
--   US password_guessing blocked  P1 5 + P2 2 + P3 3 + P7 7 + L1 11 + L3 4 = 32
--   DE exploit blocked            P4 4 + P9 8 + P8 2 = 14
--   FR bots blocked 6; FR malware allowed 1
--   PT phishing flagged           S1 1 + S7 1 + S8 1 = 3
--   GB password_guessing flagged 3; IT phishing flagged 2
--   BR, ES, JP phishing flagged 1 each
-- THE 10-MINUTE CELLS (events with a country; 64 in all):
--   b0   US password_guessing blocked 10 (P1, P2, P3)
--   b1   DE exploit blocked 4 (P4)
--   b3   FR bots blocked 6; FR malware allowed 1
--   b5   US password_guessing blocked 11 (L1)
--   b7   PT phishing flagged 2 (S1, S7); ES 1; IT 2; GB password_guessing flagged 3; BR 1; JP 1
--   b10  DE exploit blocked 8 (P9)
--   b11  DE exploit blocked 2 (P8); US password_guessing blocked 11 (P7 7 + L3 4); PT phishing flagged 1 (S8)
-- THE 1-MINUTE CELLS (m110 to m119, a country, not late):
--   m110 DE exploit blocked 2; m118 PT phishing flagged 1; m119 US password_guessing blocked 7
--   (L3 at m112 is late; T2 at m115 is a tally.)
-- LATE (phone and api, no tally):
--   api bots blocked 13 (L2); api password_guessing blocked 4 (L3)
--   phone password_guessing blocked 28 (L1 11 + L4 17); phone password_guessing flagged 3 (S4)
--   phone phishing flagged 1 (S7)
-- BLOCKED SINCE A DAY START AT m(45): L1 11 + L2 13 + L4 17 + P9 8 + P8 2 + L3 4 + P7 7 = 62.
--   At m(50), L1's own minute: still 62. A second later: 51. At m(0): 196. At m(120): 0.

-- The window's ends as text, for the calls made as another role.
select pg_temp.m(0)::text as w0, pg_temp.m(120)::text as w120 \gset

create temporary table ans as
  select public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null) as a,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(45)) as d45,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(50)) as d50,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(50) + interval '1 second') as d50s,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(0)) as dfrom,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(120)) as dto,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(0) - interval '1 second') as dbefore,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(120) + interval '1 second') as dafter,
         public.platform_security_map(pg_temp.m(0), pg_temp.m(120), 'infinity') as dnever;

-- ── 2. Shape and privileges ─────────────────────────────────────────────────
select is(
  (select array_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ') ' || pg_get_function_result(p.oid)
                    order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'),
  array['_security_map_units(p_from timestamp with time zone, p_to timestamp with time zone) TABLE(minute timestamp with time zone, category text, outcome text, reason text, source text, country text, city text, organization_id uuid, organizations integer, events integer, kind text, late boolean)',
        'platform_security_map(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_day_start timestamp with time zone DEFAULT NULL::timestamp with time zone) jsonb'],
  '0478/3: exactly the two functions, with the designed arguments and results');
select is(
  (select array_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                    || array_to_string(p.proconfig, ',') order by p.proname)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'),
  array['_security_map_units:plpgsql:false:s:search_path=""',
        'platform_security_map:plpgsql:true:s:search_path="",statement_timeout=5s,TimeZone=UTC'],
  '0478/4: both plpgsql and STABLE with an empty search_path; the public one SECURITY DEFINER with a statement_timeout of 5 seconds and TimeZone UTC as its own settings, the private one SECURITY INVOKER');
select is(
  array_to_string(pg_temp.grants_of('public._security_map_units(timestamptz, timestamptz)'), ' '),
  '',
  '0478/5: the private function has no grant to any role, PUBLIC included');
select is(
  array_to_string(pg_temp.grants_of('public.platform_security_map(timestamptz, timestamptz, timestamptz)'), ' '),
  'service_role:EXECUTE',
  '0478/6: the public function has exactly one grant: EXECUTE to service_role (nothing to PUBLIC)');
select is(
  (select array_agg(has_function_privilege(r.role, f.fn, 'execute') order by f.n, r.n)
     from unnest(array['public._security_map_units(timestamptz, timestamptz)',
                       'public.platform_security_map(timestamptz, timestamptz, timestamptz)']) with ordinality as f(fn, n),
          unnest(array['anon', 'authenticated', 'service_role']) with ordinality as r(role, n)),
  array[false, false, false,
        false, false, true],
  '0478/7: anon and authenticated may execute neither; service_role the public one and not the private one');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'
      and p.prosrc ~* '(auth\.uid|has_org_role|has_permission|is_org_member)'),
  0,
  '0478/8: no body holds any of the four gate words, not even in a comment or a string');
select is(pg_temp.inv25_names(), '',
  '0478/9: as granted, INV-25 has nothing to say about these functions (authenticated cannot execute them)');
select ok(
  (select regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
          ~* $re$\m(auth\.uid|has_org_role|has_permission|is_org_member)\M$re$
     from pg_proc p where p.oid = 'public.security_events_for_organization(uuid, integer)'::regprocedure),
  '0478/10: the same reading does find the gate of a function that has one (so 8 and 9 can fail)');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'
      and p.prosrc !~* '\m(insert|update|delete|merge|truncate)\M'),
  2,
  '0478/11: no body holds a write statement: none of the five write verbs appears as a word');
select is(
  array[(select string_agg(m[1], ',' order by m[1])
           from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
          where c.conrelid = 'public.security_events'::regclass and c.conname = 'security_events_category'),
        (select string_agg(m[1], ',' order by m[1])
           from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
          where c.conrelid = 'public.security_events'::regclass and c.conname = 'security_events_outcome'),
        (select string_agg(m[1], ',' order by m[1])
           from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
          where c.conrelid = 'public.security_events'::regclass and c.conname = 'security_events_source')],
  array['bots,exploit,malware,password_guessing,phishing', 'allowed,blocked,flagged', 'api,edge,email,phone,web'],
  '0478/12: security_events still has the five categories and three outcomes the map names as fixed keys, and the five sources two of which it calls late (a new one must be added to the map)');

-- THE FOUR LISTS, to the letter. A change to a list in the migration fails
-- here until this file (and the console's copy of the lists) changes too.
select is(
  array[pg_temp.list_of('c_folded_reasons'), pg_temp.list_of('c_tally_reasons'),
        pg_temp.list_of('c_flood_reasons'), pg_temp.list_of('c_late_sources')],
  array['''sign_in_new_country'', ''sign_in_not_me'', ''sign_in_alerts_held''',
        '''too_many_forms_to_count''',
        '''over_minute_cap'', ''over_buffer_cap''',
        '''phone'', ''api'''],
  '0478/13: the four lists of the counting rules are exactly: recorded once in each organization (sign_in_new_country, sign_in_not_me, sign_in_alerts_held); tallies (too_many_forms_to_count); past a cap (over_minute_cap, over_buffer_cap); late sources (phone, api)');
select is(
  (select array[count(*)::int, count(distinct r)::int, count(*) filter (where r !~ '^[a-z][a-z0-9_]{0,47}$')::int]
     from unnest(pg_temp.list_items('c_folded_reasons') || pg_temp.list_items('c_tally_reasons')
                 || pg_temp.list_items('c_flood_reasons')) r),
  array[6, 6, 0],
  '0478/14: no reason is in two of the three reason lists, and each is a reason code the record accepts');
select is(
  (select array_agg((regexp_count(p.prosrc, 'constant text\[\]'))::int order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'),
  array[4, 0],
  '0478/15: the lists are written in the private function and nowhere else: the public function holds none');
select is(
  (select array[(regexp_count(p.prosrc, 'sign_in_new_country|sign_in_not_me|sign_in_alerts_held|too_many_forms_to_count|over_minute_cap|over_buffer_cap'))::int,
                (regexp_count(p.prosrc, 'public\.security_events\M'))::int]
     from pg_proc p where p.oid = 'public.platform_security_map(timestamptz, timestamptz, timestamptz)'::regprocedure),
  array[0, 1],
  '0478/16: the public function names no reason of any list, and reads the record itself in one place only (the oldest minute): every count comes from the private function');

-- ── 3. Who may call ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0478000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now()) $$),
        pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now() - interval '1 hour', now(), null) $$)],
  array['42501|permission denied for function _security_map_units',
        '42501|permission denied for function platform_security_map',
        '42501|permission denied for function platform_security_map'],
  '0478/17: a signed-in member, even one holding the second step, can call neither: no EXECUTE');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now()) $$),
        pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now() - interval '1 hour', now(), null) $$)],
  array['42501|permission denied for function _security_map_units',
        '42501|permission denied for function platform_security_map',
        '42501|permission denied for function platform_security_map'],
  '0478/18: a signed-out caller can call neither: no EXECUTE');
reset role;
select set_config('request.jwt.claims', '', true);

-- If a grant to the member roles ever slipped in: INV-25 names the public
-- function, and the second lock in each body still refuses the call, before
-- anything is read and before the window is looked at. Undone by the
-- savepoint.
savepoint slipped_grant;
grant execute on function public.platform_security_map(timestamptz, timestamptz, timestamptz) to authenticated, anon;
grant execute on function public._security_map_units(timestamptz, timestamptz) to authenticated, anon;
select is(pg_temp.inv25_names(), 'platform_security_map',
  '0478/19: with EXECUTE granted to authenticated, INV-25 names the public function');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0478000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now() - interval '1 hour', now(), null) $$),
        pg_temp.refusal($$ select public.platform_security_map(now(), now() - interval '1 hour', null) $$),
        pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now()) $$)],
  array_fill('42501|platform_security_map_not_allowed'::text, array[4]),
  '0478/20: and even then the second lock refuses a signed-in member on the public function (also for a window it would not read) and on the private one, which holds the same lock');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now(), now() - interval '1 hour', null) $$),
        pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now()) $$)],
  array_fill('42501|platform_security_map_not_allowed'::text, array[3]),
  '0478/21: the second lock refuses a signed-out caller on both as well');
reset role;
select set_config('request.jwt.claims', '', true);
rollback to savepoint slipped_grant;
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  '0478/22: the savepoint took the grants back');

-- service_role: the same answer as the functions' owner gets, and no way to
-- the private function.
select a::text as j_a from ans \gset
set local role service_role;
select is(public.platform_security_map(:'w0', :'w120', null), :'j_a'::jsonb,
  '0478/23: service_role reads the map');
select is(
  pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now()) $$),
  '42501|permission denied for function _security_map_units',
  '0478/24: service_role cannot call the private function');
reset role;

-- ── 4. The answer for the made-up record ────────────────────────────────────
select is(pg_temp.keys_of((select a from ans)),
  array['allowed_window', 'blocked_since_day_start', 'blocked_window', 'by_country', 'by_country_truncated',
        'day_start', 'feed', 'flagged_window', 'flood_rows', 'generated_at', 'late_sources', 'no_place',
        'oldest_event_at', 'refused', 'tallies', 'timeline', 'timeline_truncated', 'totals', 'window'],
  '0478/25: the answer has exactly its nineteen keys');
select is(
  (select array[a -> 'window', a -> 'refused', a -> 'generated_at', a -> 'oldest_event_at', a -> 'day_start',
                a -> 'blocked_since_day_start']
     from ans),
  array[jsonb_build_object('from', pg_temp.m(0), 'to', pg_temp.m(120), 'live_from', pg_temp.m(110)),
        'null'::jsonb, to_jsonb(now()), to_jsonb(pg_temp.m(-1)), 'null'::jsonb, 'null'::jsonb],
  '0478/26: the window as asked for with its last ten minutes, nothing refused, made now, the oldest minute on record (a row before the window), and no day start');
select is((select a -> 'totals' from ans),
  pg_temp.cats('{"password_guessing": {"blocked": 49, "flagged": 5}, "exploit": {"blocked": 39},
                 "bots": {"blocked": 108}, "phishing": {"flagged": 8}, "malware": {"allowed": 1}}'),
  '0478/27: totals by category and outcome as worked out by hand: the rows on the minute the window ends at and before it starts are out, the tallies are in none, the folded sign-ins count once, the rows past a cap are counted');
select is(
  (select array[(a ->> 'blocked_window')::int, (a ->> 'flagged_window')::int, (a ->> 'allowed_window')::int] from ans),
  array[196, 13, 1],
  '0478/28: blocked 196, flagged 13, allowed 1: an allowed event is its own outcome and never blocked, a flagged one never blocked');
select is((select a -> 'no_place' from ans),
  pg_temp.cats('{"password_guessing": {"blocked": 17, "flagged": 2}, "exploit": {"blocked": 25}, "bots": {"blocked": 102}}'),
  '0478/29: events with no country, by category and outcome: a row with a city and no country, the rows past a cap (also the one given a place by hand) and the hourly reader''s remainder');
select is(pg_temp.country_lines((select a from ans)),
  array['US|password_guessing|blocked|32', 'DE|exploit|blocked|14', 'FR|bots|blocked|6',
        'GB|password_guessing|flagged|3', 'PT|phishing|flagged|3', 'IT|phishing|flagged|2',
        'BR|phishing|flagged|1', 'ES|phishing|flagged|1', 'FR|malware|allowed|1', 'JP|phishing|flagged|1'],
  '0478/30: by country, the largest first: the row past a cap that named FR is not under FR, the tally that named US is not under US, the sign-in recorded in three organizations is one under PT');
select is((select (a ->> 'by_country_truncated')::boolean or (a ->> 'timeline_truncated')::boolean from ans), false,
  '0478/31: nothing was cut short');
select is(pg_temp.timeline_lines((select a from ans)),
  array['119|60|US|password_guessing|blocked|7', '110|60|DE|exploit|blocked|2', '118|60|PT|phishing|flagged|1',
        '110|600|US|password_guessing|blocked|11', '50|600|US|password_guessing|blocked|11',
        '0|600|US|password_guessing|blocked|10', '100|600|DE|exploit|blocked|8', '30|600|FR|bots|blocked|6',
        '10|600|DE|exploit|blocked|4', '70|600|GB|password_guessing|flagged|3',
        '110|600|DE|exploit|blocked|2', '70|600|IT|phishing|flagged|2', '70|600|PT|phishing|flagged|2',
        '110|600|PT|phishing|flagged|1', '70|600|BR|phishing|flagged|1', '70|600|ES|phishing|flagged|1',
        '70|600|JP|phishing|flagged|1', '30|600|FR|malware|allowed|1'],
  '0478/32: the timeline: the three 1-minute cells of the last ten minutes first (the late api row at m112 and the tally at m115 are in none; m110 is in, m109 is not), then the fifteen 10-minute cells, the largest first: m9 is in the bucket that starts at m0 and m10 in the one that starts at m10');
select is(
  (select array[pg_temp.events_of(a -> 'timeline', 600), pg_temp.events_of(a -> 'by_country', null),
                (select sum((o.value)::bigint) from jsonb_each(a -> 'totals') c, jsonb_each_text(c.value) o)
                - (select sum((o.value)::bigint) from jsonb_each(a -> 'no_place') c, jsonb_each_text(c.value) o)]
     from ans),
  array[64::numeric, 64, 64],
  '0478/33: the parts agree: the 10-minute cells, the groups by country, and the totals less the events with no country are the same 64 events');
select is(
  (select array[pg_temp.key_sets(a -> 'timeline'), pg_temp.key_sets(a -> 'by_country'), pg_temp.key_sets(a -> 'late_sources'),
                pg_temp.key_sets(a -> 'feed'), pg_temp.key_sets(a -> 'tallies'), pg_temp.key_sets(a -> 'flood_rows')]
     from ans),
  array['bucket_seconds,bucket_start,category,country,events,outcome',
        'category,country,events,outcome',
        'category,events,outcome,source',
        'category,city,country,events,minute,organization_id,organization_name,organizations,outcome,reason,source',
        'category,events,outcome,reason,rows,source',
        'category,events,outcome,reason,rows,source'],
  '0478/34: every cell of the timeline, group by country, late line, feed entry, tally and flood line has exactly its documented keys: no source hash, no row key, no row id');
select is(pg_temp.feed_lines((select a from ans)),
  array['119|password_guessing|blocked|wrong_password|web|US|-|7|-|0',
        '118|phishing|flagged|sign_in_new_country|web|PT|Example Harbour|1|-|2',
        '112|password_guessing|blocked|wrong_password|api|US|-|4|-|0',
        '110|exploit|blocked|git_dir|web|DE|-|2|-|0',
        '109|exploit|blocked|git_dir|web|DE|-|8|-|0',
        '74|phishing|flagged|sign_in_not_me|web|JP|Example Bay|1|-|0',
        '73|phishing|flagged|sign_in_new_country|web|BR|-|1|Example Map Institute|1',
        '72|password_guessing|flagged|sign_in_alerts_held|phone|GB|Example Borough|3|-|2',
        '71|phishing|flagged|sign_in_not_me|web|IT|Example Piazza|2|-|2',
        '70|phishing|flagged|sign_in_new_country|phone|PT|Example Harbour|1|Example Map Charter|1',
        '70|phishing|flagged|sign_in_new_country|web|ES|Example Plaza|1|Example Map Academy|1',
        '70|phishing|flagged|sign_in_new_country|web|PT|Example Harbour|1|-|3',
        '52|password_guessing|blocked|auth_log_over_cap|phone|-|-|17|-|0',
        '51|bots|blocked|auth_rate_limited|api|-|-|13|-|0',
        '50|password_guessing|blocked|wrong_password|phone|US|-|11|-|0',
        '41|exploit|blocked|over_buffer_cap|web|-|-|25|-|0',
        '40|bots|blocked|over_minute_cap|web|-|-|50|-|0',
        '40|bots|blocked|over_minute_cap|web|-|-|30|Example Map Academy|1',
        '35|bots|blocked|public_order_paused|web|FR|Example Ville|6|Example Map Charter|1',
        '35|malware|allowed|upload_allowed|web|FR|-|1|Example Map Charter|1',
        '21|password_guessing|flagged|passkey_counter_went_back|web|-|Example Hamlet|2|Example Map Academy|1',
        '20|bots|blocked|share_link_paused|web|-|-|9|-|0',
        '10|exploit|blocked|env_file|web|DE|-|4|-|0',
        '9|password_guessing|blocked|wrong_password|web|US|Example Springs|3|-|0',
        '0|password_guessing|blocked|wrong_password|web|US|Example Springs|7|Example Map Academy|1'],
  '0478/35: the feed, the latest minute first and in a minute the largest first: two rows of one kind in a minute are one entry (7), a sign-in recorded in several organizations is one entry that names none and says how many (3, 2, 2), one recorded in a single organization names it, neither tally is listed, and the rows past a cap are listed with no place');
select is(
  (select array[jsonb_array_length(a -> 'feed')::bigint, pg_temp.events_of(a -> 'feed', null)] from ans),
  array[25::bigint, 210],
  '0478/36: the feed''s 25 entries hold the same 210 events as the totals');
select is(pg_temp.late_lines((select a from ans)),
  array['api|bots|blocked|13', 'api|password_guessing|blocked|4', 'phone|password_guessing|blocked|28',
        'phone|password_guessing|flagged|3', 'phone|phishing|flagged|1'],
  '0478/37: the late sources: the events whose source is phone or api, by source, category and outcome (the tally from the api is not among them; the folded phone sign-ins count once)');
select is(pg_temp.reason_lines((select a -> 'tallies' from ans)),
  array['too_many_forms_to_count|api|password_guessing|flagged|1000|2'],
  '0478/38: the tallies are listed apart: 1,000 over two rows');
select is(pg_temp.reason_lines((select a -> 'flood_rows' from ans)),
  array['over_buffer_cap|web|exploit|blocked|25|2', 'over_minute_cap|web|bots|blocked|80|2'],
  '0478/39: the rows past a cap are named with their events and how many rows they are');

-- ── 5. The private function: the units themselves ───────────────────────────
select results_eq(
  $$ select pg_temp.mins(u.minute::text), u.reason, u.source, u.country, u.city, u.organization_id, u.organizations,
            u.events, u.kind, u.late
       from public._security_map_units(pg_temp.m(70), pg_temp.m(75)) u
      order by u.minute, u.reason, u.source, u.country $$,
  $$ values
    ('70', 'sign_in_new_country', 'phone', 'PT', 'Example Harbour', 'a0478000-0000-0000-0000-0000000000b1'::uuid, 1, 1, 'event', true),
    ('70', 'sign_in_new_country', 'web',   'ES', 'Example Plaza',   'a0478000-0000-0000-0000-0000000000a1'::uuid, 1, 1, 'event', false),
    ('70', 'sign_in_new_country', 'web',   'PT', 'Example Harbour', null::uuid,                                   3, 1, 'event', false),
    ('71', 'sign_in_not_me',      'web',   'IT', 'Example Piazza',  null::uuid,                                   2, 2, 'event', false),
    ('72', 'sign_in_alerts_held', 'phone', 'GB', 'Example Borough', null::uuid,                                   2, 3, 'event', true),
    ('73', 'sign_in_new_country', 'web',   'BR', null,              'a0478000-0000-0000-0000-0000000000c1'::uuid, 1, 1, 'event', false),
    ('74', 'sign_in_not_me',      'web',   'JP', 'Example Bay',     null::uuid,                                   0, 1, 'event', false) $$,
  '0478/40: the fold: one account in three organizations is one unit of 1 (not 3) that names no organization and says three; two places in one minute are two units; the phone is another unit; 2 and 1 in two organizations are 2 (the largest, not 3); 3 and 3 are 3; one organization is named; none is none');
select results_eq(
  $$ select pg_temp.mins(u.minute::text), u.reason, u.country, u.city, u.organization_id, u.organizations, u.events, u.kind, u.late
       from public._security_map_units(pg_temp.m(40), pg_temp.m(61)) u
      order by u.minute, u.events desc $$,
  $$ values
    ('40', 'over_minute_cap',         null::text, null::text, null::uuid,                                   0, 50, 'flood', false),
    ('40', 'over_minute_cap',         null,       null,       'a0478000-0000-0000-0000-0000000000a1'::uuid, 1, 30, 'flood', false),
    ('41', 'over_buffer_cap',         null,       null,       null,                                         0, 20, 'flood', false),
    ('41', 'over_buffer_cap',         null,       null,       null,                                         0, 5,  'flood', false),
    ('50', 'wrong_password',          'US',       null,       null,                                         0, 11, 'event', true),
    ('51', 'auth_rate_limited',       null,       null,       null,                                         0, 13, 'event', true),
    ('52', 'auth_log_over_cap',       null,       null,       null,                                         0, 17, 'event', true),
    ('60', 'too_many_forms_to_count', null,       null,       null,                                         0, 700, 'tally', true) $$,
  '0478/41: the other kinds: a row past a cap is a flood unit with no country and no city whatever the row holds, and keeps its organization; a tally is marked a tally; the phone and the api are late; every other row is a unit as it is');

-- A tally is in nothing but the list of tallies: take the two tally rows
-- away and the rest of the answer is the same, to the letter.
savepoint no_tally_rows;
delete from public.security_events where reason = 'too_many_forms_to_count';
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null) - 'tallies',
  (select a - 'tallies' from ans),
  '0478/42: with the tally rows gone the answer differs in its list of tallies and in nothing else: no total, cell, group, feed entry or late line held them');
rollback to savepoint no_tally_rows;

-- Every reason of the list of tallies, whatever the list grows to: a large
-- row of each, with a place, in the last ten minutes, from the web.
savepoint every_tally_reason;
insert into public.security_events (minute, category, outcome, reason, source, country, city, event_count, dedupe_key)
select pg_temp.m(117), 'bots', 'blocked', r, 'web', 'US', 'Example Springs', 100000, md5(gen_random_uuid()::text)
  from unnest(pg_temp.list_items('c_tally_reasons')) r;
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null) - 'tallies',
  (select a - 'tallies' from ans),
  '0478/43: a row of 100,000 for each reason of the list of tallies changes no total, cell, group, feed entry or late line');
select is(
  (select array[count(*)::int, count(distinct e ->> 'reason')::int, sum((e ->> 'events')::bigint)::int]
     from jsonb_array_elements(public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null) -> 'tallies') e
    where e ->> 'source' = 'web'),
  (select array[n, n, n * 100000] from (select cardinality(pg_temp.list_items('c_tally_reasons')) as n) x),
  '0478/44: and each is listed with the tallies, once, with its 100,000');
rollback to savepoint every_tally_reason;

-- Every reason of the list recorded once in each organization: 1 in three
-- organizations is 1; and every reason of the list of rows past a cap: no
-- place, whatever the row holds.
savepoint every_listed_reason;
insert into public.security_events (minute, category, outcome, reason, source, organization_id, country, city, event_count, dedupe_key)
select pg_temp.m(-30), 'phishing', 'flagged', r, 'web', o, 'NZ', 'Example Cove', 1, md5(gen_random_uuid()::text)
  from unnest(pg_temp.list_items('c_folded_reasons')) r,
       unnest(array[:orgA, :orgB, :orgC]::uuid[]) o;
insert into public.security_events (minute, category, outcome, reason, source, country, city, event_count, dedupe_key)
select pg_temp.m(-30), 'bots', 'blocked', r, 'web', 'NZ', 'Example Cove', 10, md5(gen_random_uuid()::text)
  from unnest(pg_temp.list_items('c_flood_reasons')) r;
select is(
  (select array[(a -> 'totals' -> 'phishing' ->> 'flagged')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int,
                (a -> 'no_place' -> 'bots' ->> 'blocked')::int, jsonb_array_length(a -> 'by_country'),
                (a -> 'by_country' -> 0 ->> 'events')::int, jsonb_array_length(a -> 'flood_rows')]
     from (select public.platform_security_map(pg_temp.m(-40), pg_temp.m(-20), null) as a) x),
  array[3, 20, 20, 1, 3, 2],
  '0478/45: each of the three reasons recorded once in each organization counts 1 for three organizations (3 in all, the only group by country), and each of the two reasons past a cap is counted with no place (20) and listed');
rollback to savepoint every_listed_reason;

-- ── 6. The edges of the window and of the buckets ───────────────────────────
select is(
  (select array[(a ->> 'blocked_window')::int, (a -> 'totals' -> 'password_guessing' ->> 'blocked')::int,
                (a -> 'totals' -> 'bots' ->> 'blocked')::int]
     from (select public.platform_security_map(pg_temp.m(0) + interval '1 second', pg_temp.m(120), null) as a) x),
  array[189, 42, 108],
  '0478/46: a window that starts a second after m(0) leaves out the rows of the minute m(0) (7 fewer): a row is in the window when its minute starts at or after the start');
select is(
  (select array[(a ->> 'blocked_window')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int]
     from (select public.platform_security_map(pg_temp.m(-1), pg_temp.m(120), null) as a) x),
  array[2196, 2108],
  '0478/47: a window that starts on the minute before takes that minute''s row in (2,000 more)');
select is(
  (select array[(a ->> 'blocked_window')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int]
     from (select public.platform_security_map(pg_temp.m(0), pg_temp.m(120) + interval '1 microsecond', null) as a) x),
  array[1196, 1108],
  '0478/48: the row on the minute m(120) is out of a window that ends at m(120) and in one that ends a microsecond later (1,000 more)');
select is(
  (select array[(a -> 'window' ->> 'live_from')::timestamptz = pg_temp.m(109), (a ->> 'blocked_window')::int = 189]::text
          || ' ' || array_to_string(pg_temp.pick(pg_temp.timeline_lines(a), '%|60|%'), ' ')
     from (select public.platform_security_map(pg_temp.m(0), pg_temp.m(119), null) as a) x),
  '{t,t} 109|60|DE|exploit|blocked|8 110|60|DE|exploit|blocked|2 118|60|PT|phishing|flagged|1',
  '0478/49: a window that ends at m(119): the row of m(119) is out (7 fewer), the last ten minutes are m109 to m118, and m109 now has a 1-minute cell');
select is(
  (select array[(a -> 'window' ->> 'live_from')::timestamptz = pg_temp.m(109) + interval '30 seconds',
                (a ->> 'blocked_window')::int = 196]::text
          || ' ' || array_to_string(pg_temp.pick(pg_temp.timeline_lines(a), '%|60|%'), ' ')
     from (select public.platform_security_map(pg_temp.m(0), pg_temp.m(119) + interval '30 seconds', null) as a) x),
  '{t,t} 119|60|US|password_guessing|blocked|7 110|60|DE|exploit|blocked|2 118|60|PT|phishing|flagged|1',
  '0478/50: a window that ends 30 seconds into m(119): that minute is in, and the last ten minutes are the ten minutes m110 to m119 (m109, which starts before the ten minutes do, has no 1-minute cell)');
select is(
  (select pg_temp.pick(pg_temp.timeline_lines(a), '10|600|%') || pg_temp.pick(pg_temp.timeline_lines(a), '0|600|%')
     from (select public.platform_security_map(pg_temp.m(5), pg_temp.m(120), null) as a) x),
  array['10|600|DE|exploit|blocked|4', '0|600|US|password_guessing|blocked|3'],
  '0478/51: a window that starts at m(5), inside a bucket: the buckets stay on the clock, so the first cell starts at m(0), before the window, and holds only the row of m9 (3)');
select is(
  (select array[(a -> 'window' ->> 'live_from')::timestamptz = pg_temp.m(113), jsonb_array_length(a -> 'timeline') = 4]::text
          || ' ' || array_to_string(pg_temp.timeline_lines(a), ' ')
     from (select public.platform_security_map(pg_temp.m(113), pg_temp.m(120), null) as a) x),
  '{t,t} 119|60|US|password_guessing|blocked|7 118|60|PT|phishing|flagged|1 110|600|US|password_guessing|blocked|7 110|600|PT|phishing|flagged|1',
  '0478/52: a window shorter than ten minutes (the 30-second poll): its last ten minutes are the whole window');

-- ── 7. Blocked since the day start ──────────────────────────────────────────
select is(
  (select array[d45 -> 'blocked_since_day_start', d45 -> 'day_start', d50 -> 'blocked_since_day_start',
                d50s -> 'blocked_since_day_start', d50s -> 'day_start']
     from ans),
  array['62'::jsonb, to_jsonb(pg_temp.m(45)), '62'::jsonb, '51'::jsonb, to_jsonb(pg_temp.m(50) + interval '1 second')],
  '0478/53: a day start inside the window: the blocked events of the minutes that start at or after it (62 from m45; still 62 from m50, the minute of a row; 51 a second later), and the day start is given back');
select is(
  (select array[dfrom -> 'blocked_since_day_start', dto -> 'blocked_since_day_start', dto -> 'day_start'] from ans),
  array['196'::jsonb, '0'::jsonb, to_jsonb(pg_temp.m(120))],
  '0478/54: on the window''s edges: a day start at its start counts every blocked event of the window (196, flagged and allowed never), one at its end counts none (0)');
select is(
  (select array[dbefore -> 'blocked_since_day_start', dbefore -> 'day_start', dafter -> 'blocked_since_day_start',
                dafter -> 'day_start', dnever -> 'blocked_since_day_start', dnever -> 'day_start',
                a -> 'blocked_since_day_start', a -> 'day_start']
     from ans),
  array_fill('null'::jsonb, array[8]),
  '0478/55: a day start outside the window (a second before it, a second after it, not a time) or none: no number and no day start, never a count of part of a day');
select is(
  (select array[d45 - 'blocked_since_day_start' - 'day_start', dbefore - 'blocked_since_day_start' - 'day_start',
                dnever - 'blocked_since_day_start' - 'day_start']
     from ans),
  (select array_fill(a - 'blocked_since_day_start' - 'day_start', array[3]) from ans),
  '0478/56: the day start changes those two keys and nothing else');

-- ── 8. A window that cannot be read ─────────────────────────────────────────
-- Each call goes through answer_of, so a call that raised would be shown
-- as what it raised and the file would go on.
select is(
  array[pg_temp.answer_of($$ select public.platform_security_map(now(), now() - interval '1 hour', null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '1 hour', now() - interval '1 hour', null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '48 hours' - interval '1 microsecond', now(), null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '49 hours', null, null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '1 hour', now() + interval '1 minute' + interval '1 microsecond', null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(null, now() + interval '2 minutes', null) $$)],
  array[jsonb_build_object('window', null, 'refused', 'from_not_before_to', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'from_not_before_to', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'longer_than_48_hours', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'longer_than_48_hours', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'to_in_the_future', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'to_in_the_future', 'generated_at', now())],
  '0478/57: refused with a fixed word and exactly three keys, never raised: a window out of order or empty, one longer than 48 hours by a microsecond (also with no end given), one that ends more than a minute after now');
select is(
  array[pg_temp.answer_of($$ select public.platform_security_map('-infinity', now(), null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map(now(), 'infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map('infinity', 'infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map(null, 'infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map(null, '-infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map('-infinity', null, 'infinity') $$) - 'generated_at'],
  array_fill(jsonb_build_object('window', null, 'refused', 'not_a_time'), array[6]),
  '0478/58: a start or an end that is not a time is refused as such, never raised');
select is(
  array[(pg_temp.answer_of($$ select public.platform_security_map('1999-12-31 00:00:00+00', now(), '1998-01-01 00:00:00+00') $$) - 'generated_at')::text,
        (pg_temp.answer_of($$ select public.platform_security_map('1999-12-31 00:00:00+00', '1999-12-30 00:00:00+00', null) $$) - 'generated_at')::text,
        (pg_temp.answer_of($$ select public.platform_security_map('1999-12-31 00:00:00+00', '1999-12-31 00:00:00+00', '1999-12-31 00:00:00+00') $$) - 'generated_at')::text,
        (pg_temp.answer_of($$ select public.platform_security_map(now(), now() + interval '9 days', now() + interval '8 days') $$) - 'generated_at')::text],
  array['{"window": null, "refused": "longer_than_48_hours"}',
        '{"window": null, "refused": "from_not_before_to"}',
        '{"window": null, "refused": "from_not_before_to"}',
        '{"window": null, "refused": "to_in_the_future"}'],
  '0478/59: a refusal holds its word and nothing of the argument it refused: no date, no time, no day start');
select is(
  array[public.platform_security_map(now() - interval '48 hours', now(), null) -> 'window',
        public.platform_security_map(now() - interval '1 hour', now() + interval '1 minute', null) -> 'window',
        public.platform_security_map(null, null, null) -> 'window',
        public.platform_security_map() -> 'window',
        public.platform_security_map(now() - interval '2 hours', null, null) -> 'window',
        public.platform_security_map(null, now() - interval '70 hours', null) -> 'window'],
  array[jsonb_build_object('from', now() - interval '48 hours', 'to', now(), 'live_from', now() - interval '10 minutes'),
        jsonb_build_object('from', now() - interval '1 hour', 'to', now() + interval '1 minute', 'live_from', now() - interval '9 minutes'),
        jsonb_build_object('from', now() - interval '24 hours', 'to', now(), 'live_from', now() - interval '10 minutes'),
        jsonb_build_object('from', now() - interval '24 hours', 'to', now(), 'live_from', now() - interval '10 minutes'),
        jsonb_build_object('from', now() - interval '2 hours', 'to', now(), 'live_from', now() - interval '10 minutes'),
        jsonb_build_object('from', now() - interval '94 hours', 'to', now() - interval '70 hours', 'live_from', now() - interval '70 hours 10 minutes')],
  '0478/60: read: exactly 48 hours; an end exactly a minute after now; no argument at all is the 24 hours up to now; a start alone runs to now; an end alone is the 24 hours before it, however old');
select is(
  (select (a ->> 'blocked_window')::int from (select public.platform_security_map() as a) x),
  3196,
  '0478/61: with no argument the answer is the last 24 hours of the record: every blocked event on record (196 in the window, 2,000 before it, 1,000 after)');

-- ── 9. The caps ─────────────────────────────────────────────────────────────
-- The timeline. In the window m(-600) to m(-480): for each of six buckets,
-- 600 countries with c events for country c (3,600 cells of 1 to 600); and
-- in each of the last ten minutes 150 countries with 1,000 + c events
-- (1,500 1-minute cells, and 150 more 10-minute cells of 10,000 + 10c).
-- Kept: the 1,000 largest 1-minute cells (c from 150 down to 51, ten
-- minutes each: the smallest kept is 1,051) and the 3,000 largest
-- 10-minute cells (the 150 of the last bucket and c from 600 down to 126,
-- six buckets each: the smallest kept is 126).
savepoint timeline_cap;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-600 + 10 * k), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), c, md5(gen_random_uuid()::text)
  from generate_series(0, 5) k, generate_series(1, 600) c;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-490 + j), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), 1000 + c, md5(gen_random_uuid()::text)
  from generate_series(0, 9) j, generate_series(1, 150) c;
select is(
  (select array[jsonb_array_length(a -> 'timeline'),
                (select count(*)::int from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '60'),
                (select min((e ->> 'events')::int) from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '60'),
                (select count(*)::int from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '600'),
                (select min((e ->> 'events')::int) from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '600'),
                (select max((e ->> 'events')::int) from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '600'),
                (a -> 'timeline' -> 0 ->> 'bucket_seconds')::int, (a -> 'timeline' -> 0 ->> 'events')::int,
                (a -> 'timeline' -> 1000 ->> 'bucket_seconds')::int, (a -> 'timeline' -> 1000 ->> 'events')::int]::text
          || (a ->> 'timeline_truncated') || (a ->> 'by_country_truncated') || (a ->> 'blocked_window')
     from (select public.platform_security_map(pg_temp.m(-600), pg_temp.m(-480), null) as a) x),
  '{4000,1000,1051,3000,126,11500,60,1150,600,11500}truefalse2695050',
  '0478/62: 1,500 1-minute cells and 3,750 10-minute cells: 4,000 are returned, the 1,000 largest 1-minute cells first and then the 3,000 largest 10-minute cells, with the flag set; the totals still count every event (2,695,050) and the 600 groups by country are not cut');
rollback to savepoint timeline_cap;

-- Exactly at the caps: 1,000 1-minute cells and 3,000 10-minute cells (100
-- of the last bucket and five buckets of 580 countries); and 400 countries
-- in five categories: 2,000 groups by country.
savepoint exactly_at_the_caps;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-600 + 10 * k), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), c, md5(gen_random_uuid()::text)
  from generate_series(0, 4) k, generate_series(1, 580) c;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-490 + j), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), 1000 + c, md5(gen_random_uuid()::text)
  from generate_series(0, 9) j, generate_series(1, 100) c;
select is(
  (select array[jsonb_array_length(a -> 'timeline'),
                (select count(*)::int from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '60')]::text
          || (a ->> 'timeline_truncated')
     from (select public.platform_security_map(pg_temp.m(-600), pg_temp.m(-480), null) as a) x),
  '{4000,1000}false',
  '0478/63: exactly 1,000 1-minute cells and 3,000 10-minute cells: all 4,000 returned and the flag not set');
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-900), k.category, 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), c, md5(gen_random_uuid()::text)
  from generate_series(1, 400) c,
       unnest(array['password_guessing', 'exploit', 'bots', 'phishing', 'malware']) k(category);
select is(
  (select array[jsonb_array_length(a -> 'by_country'), (a -> 'by_country' -> 0 ->> 'events')::int,
                (a -> 'by_country' -> 1999 ->> 'events')::int]::text
          || (a ->> 'by_country_truncated') || (a ->> 'timeline_truncated')
     from (select public.platform_security_map(pg_temp.m(-905), pg_temp.m(-880), null) as a) x),
  '{2000,400,1}falsefalse',
  '0478/64: exactly 2,000 groups by country: all returned, the largest first, and the flag not set');
-- Fifty more countries: 2,250 groups. Kept: the 2,000 largest (c from 450
-- down to 51, five categories each).
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-900), k.category, 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), c, md5(gen_random_uuid()::text)
  from generate_series(401, 450) c,
       unnest(array['password_guessing', 'exploit', 'bots', 'phishing', 'malware']) k(category);
select is(
  (select array[jsonb_array_length(a -> 'by_country'), (a -> 'by_country' -> 0 ->> 'events')::int,
                (a -> 'by_country' -> 1999 ->> 'events')::int, (a ->> 'blocked_window')::int,
                jsonb_array_length(a -> 'timeline')]::text
          || (a ->> 'by_country_truncated') || (a ->> 'timeline_truncated')
     from (select public.platform_security_map(pg_temp.m(-905), pg_temp.m(-880), null) as a) x),
  '{2000,450,51,507375,2250}truefalse',
  '0478/65: 2,250 groups by country: the 2,000 largest are returned (down to 51 events) with the flag set, the totals still count every event (507,375), and the timeline, which has room for them, holds all 2,250');
rollback to savepoint exactly_at_the_caps;

-- Few 1-minute cells: the 10-minute cells get the room they leave. Ten
-- 1-minute cells of one country, and 3,997 10-minute cells.
savepoint room_left_over;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-600 + 10 * k), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), c, md5(gen_random_uuid()::text)
  from generate_series(0, 5) k, generate_series(1, 666) c;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-490 + j), 'bots', 'blocked', 'public_order_paused', 'web', 'AA', 5, md5(gen_random_uuid()::text)
  from generate_series(0, 9) j;
select is(
  (select array[jsonb_array_length(a -> 'timeline'),
                (select count(*)::int from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '60'),
                (select count(*)::int from jsonb_array_elements(a -> 'timeline') e where e ->> 'bucket_seconds' = '600')]::text
          || (a ->> 'timeline_truncated')
     from (select public.platform_security_map(pg_temp.m(-600), pg_temp.m(-480), null) as a) x),
  '{4000,10,3990}true',
  '0478/66: ten 1-minute cells and 3,997 10-minute cells: the ten, then the 3,990 largest 10-minute cells, 4,000 in all, with the flag set');
rollback to savepoint room_left_over;

-- The feed. 30 minutes with three entries each (90): the newest 60 are the
-- newest 20 minutes. Then, in a later window, 70 minutes with one entry
-- each under five newer minutes that hold only a tally: the newest 60
-- entries, and no tally among them.
savepoint feed_cap;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-700 + j), 'exploit', 'blocked', r.reason, 'web', 'CA', r.n, md5(gen_random_uuid()::text)
  from generate_series(0, 29) j,
       (values ('env_file', 3), ('git_dir', 2), ('wordpress', 1)) r(reason, n);
select is(
  (select array[jsonb_array_length(a -> 'feed'),
                pg_temp.mins(a -> 'feed' -> 0 ->> 'minute')::int, (a -> 'feed' -> 0 ->> 'events')::int,
                pg_temp.mins(a -> 'feed' -> 2 ->> 'minute')::int, (a -> 'feed' -> 2 ->> 'events')::int,
                pg_temp.mins(a -> 'feed' -> 59 ->> 'minute')::int, (a -> 'feed' -> 59 ->> 'events')::int,
                (a ->> 'blocked_window')::int]
     from (select public.platform_security_map(pg_temp.m(-700), pg_temp.m(-670), null) as a) x),
  array[60, -671, 3, -671, 1, -690, 1, 180],
  '0478/67: 90 entries in 30 minutes: the feed holds the newest 60 (the newest 20 minutes, three each, the largest first in a minute); the totals count all 180 events');
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-900 + j), 'exploit', 'blocked', 'env_file', 'web', 'CA', 1, md5(gen_random_uuid()::text)
  from generate_series(0, 69) j;
insert into public.security_events (minute, category, outcome, reason, source, event_count, dedupe_key)
select pg_temp.m(-830 + j), 'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', 40, md5(gen_random_uuid()::text)
  from generate_series(0, 4) j;
select is(
  (select array[jsonb_array_length(a -> 'feed'),
                pg_temp.mins(a -> 'feed' -> 0 ->> 'minute')::int, pg_temp.mins(a -> 'feed' -> 59 ->> 'minute')::int,
                (select count(*)::int from jsonb_array_elements(a -> 'feed') e where e ->> 'reason' = 'too_many_forms_to_count'),
                (a -> 'tallies' -> 0 ->> 'rows')::int]
     from (select public.platform_security_map(pg_temp.m(-900), pg_temp.m(-820), null) as a) x),
  array[60, -831, -890, 0, 5],
  '0478/68: 70 minutes of one entry under five newer minutes that hold only a tally: the feed holds the newest 60 entries (m-831 back to m-890): a minute with only a tally takes no place in it');
rollback to savepoint feed_cap;

-- ── 10. Names and times ─────────────────────────────────────────────────────
-- The table holds a name to 200 characters today. Were that ever lifted,
-- the feed still returns 200: shown with the check dropped inside a
-- savepoint.
savepoint long_name;
alter table public.organizations drop constraint organizations_name_check;
insert into public.organizations (id, name, slug, mfa_policy)
  values (:orgL, repeat('Example Long Name ', 16) || repeat('x', 12), 'a0478000-example-long-name', 'optional');
select pg_temp.ev(-200, 'bots', 'blocked', 'public_order_paused', 'web', :orgL, 'SE', null, 1);
select is(
  (select array[(select length(o.name) from public.organizations o where o.id = :orgL),
                length(a -> 'feed' -> 0 ->> 'organization_name'),
                jsonb_array_length(a -> 'feed')]::text
          || ((a -> 'feed' -> 0 ->> 'organization_name') = left(repeat('Example Long Name ', 16), 200))::text
     from (select public.platform_security_map(pg_temp.m(-205), pg_temp.m(-195), null) as a) x),
  '{300,200,1}true',
  '0478/69: an organization name of 300 characters comes back as its first 200');
rollback to savepoint long_name;

-- A session far from UTC: the same answer, to the letter, and every time in
-- it is written with +00:00.
set local time zone 'Pacific/Auckland';
select is(public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(45)), (select d45 from ans),
  '0478/70: in a session whose time zone is not UTC the answer is the same, to the letter');
select is(
  (select array[count(*)::int, count(*) filter (where t !~ '\+00:00$')::int]
     from (select a -> 'window' ->> 'from' as t from ans
           union all select a -> 'window' ->> 'to' from ans
           union all select a -> 'window' ->> 'live_from' from ans
           union all select a ->> 'generated_at' from ans
           union all select a ->> 'oldest_event_at' from ans
           union all select d45 ->> 'day_start' from ans
           union all select e ->> 'bucket_start' from ans, jsonb_array_elements(ans.a -> 'timeline') e
           union all select e ->> 'minute' from ans, jsonb_array_elements(ans.a -> 'feed') e) x),
  array[49, 0],
  '0478/71: every time in the answer (the window, when it was made, the oldest minute, the day start, 18 buckets and 25 minutes) is written with +00:00');
reset time zone;

-- ── 11. The made-up record the console's own test of the lists reads ────────
-- (CONTRACT.md, "The shared fixture".) Window m(-300) to m(-290).
savepoint shared_fixture;
select pg_temp.ev(-299, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgA, 'PT', 'Example Harbour', 1);
select pg_temp.ev(-299, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgB, 'PT', 'Example Harbour', 1);
select pg_temp.ev(-299, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgC, 'PT', 'Example Harbour', 1);
select pg_temp.ev(-298, 'phishing', 'flagged', 'sign_in_not_me', 'web', :orgA, 'IT', 'Example Piazza', 2);
select pg_temp.ev(-298, 'phishing', 'flagged', 'sign_in_not_me', 'web', :orgB, 'IT', 'Example Piazza', 1);
select pg_temp.ev(-297, 'password_guessing', 'flagged', 'sign_in_alerts_held', 'web', :orgA, 'GB', 'Example Borough', 4);
select pg_temp.ev(-297, 'password_guessing', 'flagged', 'sign_in_alerts_held', 'web', :orgB, 'GB', 'Example Borough', 4);
select pg_temp.ev(-296, 'password_guessing', 'blocked', 'wrong_password', 'web', null, 'US', null, 3);
select pg_temp.ev(-296, 'password_guessing', 'blocked', 'wrong_password', 'web', null, 'US', null, 2);
select pg_temp.ev(-295, 'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', null, null, null, 400);
select pg_temp.ev(-294, 'bots', 'blocked', 'over_minute_cap', 'web', null, null, null, 30);
select pg_temp.ev(-293, 'bots', 'blocked', 'over_buffer_cap', 'web', null, null, null, 6);
select is(
  (select array[(a ->> 'blocked_window')::int, (a ->> 'flagged_window')::int, (a ->> 'allowed_window')::int,
                (a -> 'totals' -> 'phishing' ->> 'flagged')::int, (a -> 'totals' -> 'password_guessing' ->> 'flagged')::int,
                (a -> 'totals' -> 'password_guessing' ->> 'blocked')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int,
                (a -> 'no_place' -> 'bots' ->> 'blocked')::int]::text
          || ' ' || array_to_string(pg_temp.country_lines(a), ' ')
          || ' ' || array_to_string(pg_temp.reason_lines(a -> 'tallies'), ' ')
          || ' ' || array_to_string(pg_temp.reason_lines(a -> 'flood_rows'), ' ')
     from (select public.platform_security_map(pg_temp.m(-300), pg_temp.m(-290), null) as a) x),
  '{41,7,0,3,4,5,36,36} US|password_guessing|blocked|5 GB|password_guessing|flagged|4 IT|phishing|flagged|2 PT|phishing|flagged|1'
  ' too_many_forms_to_count|api|password_guessing|flagged|400|1'
  ' over_buffer_cap|web|bots|blocked|6|1 over_minute_cap|web|bots|blocked|30|1',
  '0478/72: the shared fixture: three reasons folded (1 of three rows, 2 of 2 and 1, 4 of 4 and 4: flagged 7, where the rows'' sum would be 14), an ordinary reason summed (3 + 2 = 5), the tally in no total (blocked 41, never 441), both reasons past a cap counted with no place (36)');
rollback to savepoint shared_fixture;

-- After the savepoints the record is as the fixtures left it.
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null),
  (select a from ans),
  '0478/73: every savepoint above put the record back: the answer is the one read at the start');

select * from finish();
rollback;
