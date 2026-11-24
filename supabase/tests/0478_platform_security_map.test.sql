-- supabase/tests/0478_platform_security_map.test.sql
-- Proves migration 0478: the read behind the platform console's attack map.
--   public._security_map_units(timestamptz, timestamptz, boolean)           private: the counting rules, once
--   public._security_map_read_from(timestamptz, timestamptz, integer)       private: the row ceiling
--   public.platform_security_map(timestamptz, timestamptz, timestamptz)     the map's one document
--
-- WHAT IS WORTH PINNING
--   1. The grant is the whole control. anon and authenticated hold EXECUTE on
--      no function here; service_role on the public one only; nobody on the
--      private ones. No body names any of the four words security_invariants
--      INV-25 accepts as a gate, so if EXECUTE ever reaches authenticated
--      INV-25 names the function: shown here by granting it inside a
--      savepoint. With that grant in place the second lock in each body
--      still refuses a member and a signed-out caller.
--   2. Read-only: STABLE, and no write statement in any body (the write
--      forms of the security invariant suite's bare word list).
--   3. The four lists the counting rules need, and the constants of the
--      fold and of the read's bounds, are written once and are held here to
--      the letter: a change to one of them fails this file until the value
--      below changes with it.
--   4. The fold: a sign-in event recorded once in each organization of one
--      account is one, counted as a floor (the largest count among its rows,
--      or a fifth of their sum rounded up when that is more; never their
--      sum); another place, city, minute or source is another event; a
--      number that holds a unit of two rows or more is named a floor.
--   5. A tally (a number that can be a count of other rows) is in no total,
--      no cell and no entry of the feed: only in the list of tallies. Shown
--      for every reason of the list.
--   6. A row that stands for events past a cap is counted, has no place
--      whatever the row holds, and is listed with the floods (also when it
--      comes from the phone or the api, and then it is late).
--   7. Every number of a made-up record worked out by hand (the working is
--      beside the fixture): totals, events with no country, by country, the
--      cells of the timeline, the feed, the late sources.
--   8. The edges: a row is in the window when its minute starts at or after
--      the start and before the end; the 10-minute buckets sit on the UTC
--      clock; the 1-minute buckets are the window's last ten minutes.
--   9. The caps (4,000 cells, 2,000 groups by country, 60 entries) and the
--      flags that say when they cut; a cut keeps the flagged cells and
--      groups first, and the flagged feed always holds the newest flagged
--      entries.
--  10. A window that cannot be read is answered with a fixed word and never
--      raises; the answer never repeats the argument.
--  11. Blocked since the day start, for a day start inside the window, on
--      its edges and outside it.
--  12. An organization's name is cut at 200 characters; every time in the
--      answer is written in UTC whatever the session's time zone is.
--  13. A window asked for that is shorter than 30 minutes (the poll) has no
--      10-minute cells and no groups by country.
--  14. The row ceiling: a window that holds exactly the ceiling is read as
--      asked; one more row and it is read from the minute after the oldest
--      one the ceiling reaches, the answer says so and counts that window
--      only, and a day start before it is counted from it and marked
--      partial; a newest minute that alone holds more is refused.
--
-- now() is fixed for the whole transaction and the function uses it. Every
-- row below is placed from T0, a 10-minute mark between 5 hours and 5 hours
-- 10 minutes ago, so no assertion depends on the clock. m(n) is T0 plus n
-- minutes. Namespace a0478000. Every organization, place and value is made
-- up. Wrapped in begin/rollback: nothing leaks. Run via `supabase test db`
-- after `supabase db reset`.

begin;

select plan(99);

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
    from pg_proc p where p.oid = 'public._security_map_units(timestamptz, timestamptz, boolean)'::regprocedure;
$$;
-- Any other constant of a body, as 'type := value'.
create function pg_temp.constant_of(p_fn regprocedure, p_name text) returns text language sql as $$
  select m[1] || ' := ' || m[2]
    from pg_proc p, regexp_match(p.prosrc, '\m' || p_name || '\s+constant\s+(\w+)\s+:=\s+([^;]+);') m
   where p.oid = p_fn;
$$;
-- The row ceiling of the public function, as its body writes it.
create function pg_temp.ceiling() returns integer language sql as $$
  select split_part(pg_temp.constant_of('public.platform_security_map(timestamptz, timestamptz, timestamptz)', 'c_max_rows'),
                    ':= ', 2)::integer;
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
-- The entries of a feed (a list), and of an answer's feed. The last field
-- is at_least: t when the entry's count is a floor.
create function pg_temp.entry_lines(p jsonb) returns text[] language sql stable as $$
  select coalesce(array_agg(pg_temp.mins(e ->> 'minute') || '|' || (e ->> 'category') || '|' || (e ->> 'outcome') || '|'
                            || (e ->> 'reason') || '|' || (e ->> 'source') || '|' || coalesce(e ->> 'country', '-') || '|'
                            || coalesce(e ->> 'city', '-') || '|' || (e ->> 'events') || '|'
                            || coalesce(e ->> 'organization_name', '-') || '|' || (e ->> 'organizations') || '|'
                            || left(e ->> 'at_least', 1)
                            order by o), '{}'::text[])
    from jsonb_array_elements(p) with ordinality as x(e, o);
$$;
create function pg_temp.feed_lines(p jsonb) returns text[] language sql stable as $$
  select pg_temp.entry_lines(p -> 'feed');
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
-- How many cells of a timeline are of one kind, and of one kind and outcome.
create function pg_temp.cells_of(p jsonb, p_seconds integer, p_outcome text) returns integer language sql as $$
  select count(*)::integer
    from jsonb_array_elements(p) e
   where (e ->> 'bucket_seconds')::integer = p_seconds and (p_outcome is null or e ->> 'outcome' = p_outcome);
$$;

-- ── 1. An empty record ──────────────────────────────────────────────────────
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(45)),
  jsonb_build_object(
    'window', jsonb_build_object('from', pg_temp.m(0), 'to', pg_temp.m(120), 'live_from', pg_temp.m(110),
                                 'asked_from', pg_temp.m(0)),
    'window_shortened', false, 'short_window', false,
    'refused', null,
    'generated_at', now(),
    'oldest_event_at', null,
    'timeline', '[]'::jsonb, 'timeline_truncated', false,
    'by_country', '[]'::jsonb, 'by_country_truncated', false,
    'totals', pg_temp.cats('{}'), 'no_place', pg_temp.cats('{}'),
    'blocked_window', 0, 'flagged_window', 0, 'allowed_window', 0,
    'day_start', pg_temp.m(45), 'blocked_since_day_start', 0, 'blocked_since_day_start_partial', false,
    'floors', '[]'::jsonb,
    'feed', '[]'::jsonb, 'flagged_feed', '[]'::jsonb, 'late_sources', '[]'::jsonb, 'tallies', '[]'::jsonb,
    'flood_rows', '[]'::jsonb),
  '0478/1: with no row on record the answer is whole: every key, every category and outcome as zero, empty lists, no floor, no oldest minute, the window read as asked, and zero blocked since a day start inside the window');
select is(
  (select count(*)::int from public._security_map_units(pg_temp.m(0), pg_temp.m(120), false)),
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
  array['_security_map_read_from(p_from timestamp with time zone, p_to timestamp with time zone, p_max_rows integer) timestamp with time zone',
        '_security_map_units(p_from timestamp with time zone, p_to timestamp with time zone, p_flagged_only boolean) TABLE(minute timestamp with time zone, category text, outcome text, reason text, source text, country text, city text, organization_id uuid, organizations integer, events integer, at_least boolean, kind text, late boolean)',
        'platform_security_map(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_day_start timestamp with time zone DEFAULT NULL::timestamp with time zone) jsonb'],
  '0478/3: exactly the three functions, with the designed arguments and results');
select is(
  (select array_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                    || array_to_string(p.proconfig, ',') order by p.proname)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'),
  array['_security_map_read_from:plpgsql:false:s:search_path="",enable_sort=off',
        '_security_map_units:plpgsql:false:s:search_path=""',
        'platform_security_map:plpgsql:true:s:search_path="",statement_timeout=5s,TimeZone=UTC'],
  '0478/4: all three plpgsql and STABLE with an empty search_path; the public one SECURITY DEFINER with a statement_timeout of 5 seconds and TimeZone UTC as its own settings, the private ones SECURITY INVOKER, the row ceiling''s with enable_sort off (it walks the index; it never sorts the window)');
select is(
  array_to_string(pg_temp.grants_of('public._security_map_units(timestamptz, timestamptz, boolean)'), ' ')
  || array_to_string(pg_temp.grants_of('public._security_map_read_from(timestamptz, timestamptz, integer)'), ' '),
  '',
  '0478/5: neither private function has a grant to any role, PUBLIC included');
select is(
  array_to_string(pg_temp.grants_of('public.platform_security_map(timestamptz, timestamptz, timestamptz)'), ' '),
  'service_role:EXECUTE',
  '0478/6: the public function has exactly one grant: EXECUTE to service_role (nothing to PUBLIC)');
select is(
  (select array_agg(has_function_privilege(r.role, f.fn, 'execute') order by f.n, r.n)
     from unnest(array['public._security_map_units(timestamptz, timestamptz, boolean)',
                       'public._security_map_read_from(timestamptz, timestamptz, integer)',
                       'public.platform_security_map(timestamptz, timestamptz, timestamptz)']) with ordinality as f(fn, n),
          unnest(array['anon', 'authenticated', 'service_role']) with ordinality as r(role, n)),
  array[false, false, false,
        false, false, false,
        false, false, true],
  '0478/7: anon and authenticated may execute none; service_role the public one and neither private one');
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
  3,
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
        '''too_many_forms_to_count'', ''unrecorded_server_form_password'', ''unrecorded_server_form_code''',
        '''over_minute_cap'', ''over_buffer_cap'', ''auth_log_over_cap''',
        '''phone'', ''api'''],
  '0478/13: the four lists of the counting rules are exactly: recorded once in each organization (sign_in_new_country, sign_in_not_me, sign_in_alerts_held); tallies (too_many_forms_to_count, unrecorded_server_form_password, unrecorded_server_form_code); past a cap (over_minute_cap, over_buffer_cap, auth_log_over_cap); late sources (phone, api)');
select is(
  (select array[count(*)::int, count(distinct r)::int, count(*) filter (where r !~ '^[a-z][a-z0-9_]{0,47}$')::int]
     from unnest(pg_temp.list_items('c_folded_reasons') || pg_temp.list_items('c_tally_reasons')
                 || pg_temp.list_items('c_flood_reasons')) r),
  array[9, 9, 0],
  '0478/14: no reason is in two of the three reason lists, and each is a reason code the record accepts');
select is(
  (select array_agg((regexp_count(p.prosrc, 'constant text\[\]'))::int order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'),
  array[0, 4, 0],
  '0478/15: the lists are written in the private units function and nowhere else: the other two hold none');
select is(
  array[pg_temp.constant_of('public._security_map_units(timestamptz, timestamptz, boolean)', 'c_rows_per_sign_in'),
        pg_temp.constant_of('public.platform_security_map(timestamptz, timestamptz, timestamptz)', 'c_max_rows'),
        pg_temp.constant_of('public.platform_security_map(timestamptz, timestamptz, timestamptz)', 'c_longest'),
        pg_temp.constant_of('public.platform_security_map(timestamptz, timestamptz, timestamptz)', 'c_short_window'),
        (select sum(regexp_count(p.prosrc, '\m(c_rows_per_sign_in|c_max_rows|c_longest|c_short_window)\s+constant'))::text
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%')],
  array['numeric := 5', 'integer := 400000', 'interval := ''26 hours''', 'interval := ''30 minutes''', '4'],
  '0478/16: the other constants, each written once: one sign-in writes at most 5 rows of a folded reason; a read takes at most 400,000 rows; a window is at most 26 hours; a window shorter than 30 minutes is a poll');
select is(
  (select array[(regexp_count(p.prosrc, 'sign_in_new_country|sign_in_not_me|sign_in_alerts_held|too_many_forms_to_count|unrecorded_server_form|over_minute_cap|over_buffer_cap|auth_log_over_cap'))::int,
                (regexp_count(p.prosrc, 'public\.security_events\M'))::int,
                (select regexp_count(r.prosrc, 'public\.security_events\M')::int from pg_proc r
                  where r.oid = 'public._security_map_read_from(timestamptz, timestamptz, integer)'::regprocedure),
                (select regexp_count(r.prosrc, 'sign_in_new_country|sign_in_not_me|sign_in_alerts_held|too_many_forms_to_count|unrecorded_server_form|over_minute_cap|over_buffer_cap|auth_log_over_cap')::int
                   from pg_proc r where r.oid = 'public._security_map_read_from(timestamptz, timestamptz, integer)'::regprocedure)]
     from pg_proc p where p.oid = 'public.platform_security_map(timestamptz, timestamptz, timestamptz)'::regprocedure),
  array[0, 1, 1, 0],
  '0478/17: the public function names no reason of any list and reads the record itself in one place only (the oldest minute); the row ceiling reads it once and names no reason either: every count comes from the private units function');
-- The row ceiling's function on the fixture's 34 rows of m(0) to m(120),
-- newest first: m119, m118, m118, m115 (a tally: a row like any other), ...
-- the oldest at m0. Asked for at most n rows it gives the start to read.
select is(
  (select array_agg(pg_temp.mins(public._security_map_read_from(pg_temp.m(0), pg_temp.m(120), n)::text)::int order by o)
     from unnest(array[1000, 34, 33, 3, 1, 0]) with ordinality as x(n, o)),
  array[0, 0, 1, 116, 119, 120],
  '0478/18: the row ceiling: the window as asked while it holds at most n rows (34 of 34); else the minute after the minute of the row that comes after the newest n (33: m1; 3: m116; 1: m119), at the window''s end when the newest minute alone holds more (0)');

-- ── 3. Who may call ─────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0478000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now(), false) $$),
        pg_temp.refusal($$ select public._security_map_read_from(now() - interval '1 hour', now(), 1) $$),
        pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now() - interval '1 hour', now(), null) $$)],
  array['42501|permission denied for function _security_map_units',
        '42501|permission denied for function _security_map_read_from',
        '42501|permission denied for function platform_security_map',
        '42501|permission denied for function platform_security_map'],
  '0478/19: a signed-in member, even one holding the second step, can call none of the three: no EXECUTE');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now(), false) $$),
        pg_temp.refusal($$ select public._security_map_read_from(now() - interval '1 hour', now(), 1) $$),
        pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now() - interval '1 hour', now(), null) $$)],
  array['42501|permission denied for function _security_map_units',
        '42501|permission denied for function _security_map_read_from',
        '42501|permission denied for function platform_security_map',
        '42501|permission denied for function platform_security_map'],
  '0478/20: a signed-out caller can call none of the three: no EXECUTE');
reset role;
select set_config('request.jwt.claims', '', true);

-- If a grant to the member roles ever slipped in: INV-25 names the public
-- function, and the second lock in each body still refuses the call, before
-- anything is read and before the window is looked at. Undone by the
-- savepoint.
savepoint slipped_grant;
grant execute on function public.platform_security_map(timestamptz, timestamptz, timestamptz) to authenticated, anon;
grant execute on function public._security_map_units(timestamptz, timestamptz, boolean) to authenticated, anon;
grant execute on function public._security_map_read_from(timestamptz, timestamptz, integer) to authenticated, anon;
select is(pg_temp.inv25_names(), 'platform_security_map',
  '0478/21: with EXECUTE granted to authenticated, INV-25 names the public function');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0478000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now() - interval '1 hour', now(), null) $$),
        pg_temp.refusal($$ select public.platform_security_map(now(), now() - interval '1 hour', null) $$),
        pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now(), false) $$),
        pg_temp.refusal($$ select public._security_map_read_from(now() - interval '1 hour', now(), 1) $$)],
  array_fill('42501|platform_security_map_not_allowed'::text, array[5]),
  '0478/22: and even then the second lock refuses a signed-in member on the public function (also for a window it would not read) and on the private ones, which hold the same lock');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select public.platform_security_map() $$),
        pg_temp.refusal($$ select public.platform_security_map(now(), now() - interval '1 hour', null) $$),
        pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now(), false) $$),
        pg_temp.refusal($$ select public._security_map_read_from(now() - interval '1 hour', now(), 1) $$)],
  array_fill('42501|platform_security_map_not_allowed'::text, array[4]),
  '0478/23: the second lock refuses a signed-out caller on all three as well');
reset role;
select set_config('request.jwt.claims', '', true);
rollback to savepoint slipped_grant;
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_map%'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  '0478/24: the savepoint took the grants back');

-- service_role: the same answer as the functions' owner gets, and no way to
-- the private function.
select a::text as j_a from ans \gset
set local role service_role;
select is(public.platform_security_map(:'w0', :'w120', null), :'j_a'::jsonb,
  '0478/25: service_role reads the map');
select is(
  array[pg_temp.refusal($$ select * from public._security_map_units(now() - interval '1 hour', now(), false) $$),
        pg_temp.refusal($$ select public._security_map_read_from(now() - interval '1 hour', now(), 1) $$)],
  array['42501|permission denied for function _security_map_units',
        '42501|permission denied for function _security_map_read_from'],
  '0478/26: service_role cannot call either private function');
reset role;

-- ── 4. The answer for the made-up record ────────────────────────────────────
select is(pg_temp.keys_of((select a from ans)),
  array['allowed_window', 'blocked_since_day_start', 'blocked_since_day_start_partial', 'blocked_window', 'by_country',
        'by_country_truncated', 'day_start', 'feed', 'flagged_feed', 'flagged_window', 'flood_rows', 'floors',
        'generated_at', 'late_sources', 'no_place', 'oldest_event_at', 'refused', 'short_window', 'tallies', 'timeline',
        'timeline_truncated', 'totals', 'window', 'window_shortened'],
  '0478/27: the answer has exactly its twenty-four keys');
select is(
  (select array[a -> 'window', a -> 'window_shortened', a -> 'short_window', a -> 'refused', a -> 'generated_at',
                a -> 'oldest_event_at', a -> 'day_start', a -> 'blocked_since_day_start', a -> 'blocked_since_day_start_partial']
     from ans),
  array[jsonb_build_object('from', pg_temp.m(0), 'to', pg_temp.m(120), 'live_from', pg_temp.m(110), 'asked_from', pg_temp.m(0)),
        'false'::jsonb, 'false'::jsonb, 'null'::jsonb, to_jsonb(now()), to_jsonb(pg_temp.m(-1)), 'null'::jsonb, 'null'::jsonb,
        'false'::jsonb],
  '0478/28: the window read is the window asked for, with its last ten minutes; not shortened and not a poll; nothing refused, made now, the oldest minute on record (a row before the window), and no day start');
select is((select a -> 'totals' from ans),
  pg_temp.cats('{"password_guessing": {"blocked": 49, "flagged": 5}, "exploit": {"blocked": 39},
                 "bots": {"blocked": 108}, "phishing": {"flagged": 8}, "malware": {"allowed": 1}}'),
  '0478/29: totals by category and outcome as worked out by hand: the rows on the minute the window ends at and before it starts are out, the tallies are in none, the folded sign-ins count once, the rows past a cap are counted');
select is(
  (select array[(a ->> 'blocked_window')::int, (a ->> 'flagged_window')::int, (a ->> 'allowed_window')::int] from ans),
  array[196, 13, 1],
  '0478/30: blocked 196, flagged 13, allowed 1: an allowed event is its own outcome and never blocked, a flagged one never blocked');
select is((select a -> 'no_place' from ans),
  pg_temp.cats('{"password_guessing": {"blocked": 17, "flagged": 2}, "exploit": {"blocked": 25}, "bots": {"blocked": 102}}'),
  '0478/31: events with no country, by category and outcome: a row with a city and no country, and the rows past a cap (also the one given a place by hand, and the hourly reader''s remainder)');
select is(pg_temp.country_lines((select a from ans)),
  array['US|password_guessing|blocked|32', 'DE|exploit|blocked|14', 'FR|bots|blocked|6',
        'GB|password_guessing|flagged|3', 'PT|phishing|flagged|3', 'IT|phishing|flagged|2',
        'BR|phishing|flagged|1', 'ES|phishing|flagged|1', 'FR|malware|allowed|1', 'JP|phishing|flagged|1'],
  '0478/32: by country, the largest first: the row past a cap that named FR is not under FR, the tally that named US is not under US, the sign-in recorded in three organizations is one under PT');
select is((select (a ->> 'by_country_truncated')::boolean or (a ->> 'timeline_truncated')::boolean from ans), false,
  '0478/33: nothing was cut short');
select is(pg_temp.timeline_lines((select a from ans)),
  array['119|60|US|password_guessing|blocked|7', '110|60|DE|exploit|blocked|2', '118|60|PT|phishing|flagged|1',
        '110|600|US|password_guessing|blocked|11', '50|600|US|password_guessing|blocked|11',
        '0|600|US|password_guessing|blocked|10', '100|600|DE|exploit|blocked|8', '30|600|FR|bots|blocked|6',
        '10|600|DE|exploit|blocked|4', '70|600|GB|password_guessing|flagged|3',
        '110|600|DE|exploit|blocked|2', '70|600|IT|phishing|flagged|2', '70|600|PT|phishing|flagged|2',
        '110|600|PT|phishing|flagged|1', '70|600|BR|phishing|flagged|1', '70|600|ES|phishing|flagged|1',
        '70|600|JP|phishing|flagged|1', '30|600|FR|malware|allowed|1'],
  '0478/34: the timeline: the three 1-minute cells of the last ten minutes first (the late api row at m112 and the tally at m115 are in none; m110 is in, m109 is not), then the fifteen 10-minute cells, the largest first: m9 is in the bucket that starts at m0 and m10 in the one that starts at m10');
select is(
  (select array[pg_temp.events_of(a -> 'timeline', 600), pg_temp.events_of(a -> 'by_country', null),
                (select sum((o.value)::bigint) from jsonb_each(a -> 'totals') c, jsonb_each_text(c.value) o)
                - (select sum((o.value)::bigint) from jsonb_each(a -> 'no_place') c, jsonb_each_text(c.value) o)]
     from ans),
  array[64::numeric, 64, 64],
  '0478/35: the parts agree: the 10-minute cells, the groups by country, and the totals less the events with no country are the same 64 events');
select is(
  (select array[pg_temp.key_sets(a -> 'timeline'), pg_temp.key_sets(a -> 'by_country'), pg_temp.key_sets(a -> 'late_sources'),
                pg_temp.key_sets(a -> 'feed'), pg_temp.key_sets(a -> 'flagged_feed'), pg_temp.key_sets(a -> 'tallies'),
                pg_temp.key_sets(a -> 'flood_rows'),
                (select string_agg(distinct jsonb_typeof(f), ',') from jsonb_array_elements(a -> 'floors') f)]
     from ans),
  array['bucket_seconds,bucket_start,category,country,events,outcome',
        'category,country,events,outcome',
        'category,events,outcome,source',
        'at_least,category,city,country,events,minute,organization_id,organization_name,organizations,outcome,reason,source',
        'at_least,category,city,country,events,minute,organization_id,organization_name,organizations,outcome,reason,source',
        'category,events,outcome,reason,rows,source',
        'category,events,outcome,reason,rows,source',
        'string'],
  '0478/36: every cell of the timeline, group by country, late line, entry of either feed, tally and flood line has exactly its documented keys (no source hash, no row key, no row id), and floors is a list of names');
select is(pg_temp.feed_lines((select a from ans)),
  array['119|password_guessing|blocked|wrong_password|web|US|-|7|-|0|f',
        '118|phishing|flagged|sign_in_new_country|web|PT|Example Harbour|1|-|2|t',
        '112|password_guessing|blocked|wrong_password|api|US|-|4|-|0|f',
        '110|exploit|blocked|git_dir|web|DE|-|2|-|0|f',
        '109|exploit|blocked|git_dir|web|DE|-|8|-|0|f',
        '74|phishing|flagged|sign_in_not_me|web|JP|Example Bay|1|-|0|f',
        '73|phishing|flagged|sign_in_new_country|web|BR|-|1|Example Map Institute|1|f',
        '72|password_guessing|flagged|sign_in_alerts_held|phone|GB|Example Borough|3|-|2|t',
        '71|phishing|flagged|sign_in_not_me|web|IT|Example Piazza|2|-|2|t',
        '70|phishing|flagged|sign_in_new_country|phone|PT|Example Harbour|1|Example Map Charter|1|f',
        '70|phishing|flagged|sign_in_new_country|web|ES|Example Plaza|1|Example Map Academy|1|f',
        '70|phishing|flagged|sign_in_new_country|web|PT|Example Harbour|1|-|3|t',
        '52|password_guessing|blocked|auth_log_over_cap|phone|-|-|17|-|0|f',
        '51|bots|blocked|auth_rate_limited|api|-|-|13|-|0|f',
        '50|password_guessing|blocked|wrong_password|phone|US|-|11|-|0|f',
        '41|exploit|blocked|over_buffer_cap|web|-|-|25|-|0|f',
        '40|bots|blocked|over_minute_cap|web|-|-|50|-|0|f',
        '40|bots|blocked|over_minute_cap|web|-|-|30|Example Map Academy|1|f',
        '35|bots|blocked|public_order_paused|web|FR|Example Ville|6|Example Map Charter|1|f',
        '35|malware|allowed|upload_allowed|web|FR|-|1|Example Map Charter|1|f',
        '21|password_guessing|flagged|passkey_counter_went_back|web|-|Example Hamlet|2|Example Map Academy|1|f',
        '20|bots|blocked|share_link_paused|web|-|-|9|-|0|f',
        '10|exploit|blocked|env_file|web|DE|-|4|-|0|f',
        '9|password_guessing|blocked|wrong_password|web|US|Example Springs|3|-|0|f',
        '0|password_guessing|blocked|wrong_password|web|US|Example Springs|7|Example Map Academy|1|f'],
  '0478/37: the feed, the latest minute first and in a minute the largest first: two rows of one kind in a minute are one entry (7), a sign-in recorded in several organizations is one entry that names none, says how many and is marked at_least (3, 2, 2), one recorded in a single organization names it and is exact, neither tally is listed, and the rows past a cap are listed with no place');
select is(
  (select array[jsonb_array_length(a -> 'feed')::bigint, pg_temp.events_of(a -> 'feed', null)] from ans),
  array[25::bigint, 210],
  '0478/38: the feed''s 25 entries hold the same 210 events as the totals');
select is(pg_temp.late_lines((select a from ans)),
  array['api|bots|blocked|13', 'api|password_guessing|blocked|4', 'phone|password_guessing|blocked|28',
        'phone|password_guessing|flagged|3', 'phone|phishing|flagged|1'],
  '0478/39: the late sources: the events whose source is phone or api, by source, category and outcome, the rows past a cap among them (the hourly reader''s remainder from the phone, 17); the tally from the api is not among them; the folded phone sign-ins count once');
select is(pg_temp.reason_lines((select a -> 'tallies' from ans)),
  array['too_many_forms_to_count|api|password_guessing|flagged|1000|2'],
  '0478/40: the tallies are listed apart: 1,000 over two rows');
select is(pg_temp.reason_lines((select a -> 'flood_rows' from ans)),
  array['auth_log_over_cap|phone|password_guessing|blocked|17|1', 'over_buffer_cap|web|exploit|blocked|25|2',
        'over_minute_cap|web|bots|blocked|80|2'],
  '0478/41: the rows past a cap are named with their events and how many rows they are: the recorder''s buffer, the writer''s minute caps and the hourly reader''s remainder');
select is(
  (select array[a -> 'floors', d45 -> 'floors', dbefore -> 'floors'] from ans),
  array['["flagged_window", "totals.password_guessing.flagged", "totals.phishing.flagged"]'::jsonb,
        '["flagged_window", "totals.password_guessing.flagged", "totals.phishing.flagged"]'::jsonb,
        '["flagged_window", "totals.password_guessing.flagged", "totals.phishing.flagged"]'::jsonb],
  '0478/42: the numbers that are floors: the two flagged totals that hold a sign-in folded from two rows or more, and the flagged window count; no blocked or allowed number, no count with no place, and not the day count (no folded unit is blocked)');
select is(pg_temp.entry_lines((select a -> 'flagged_feed' from ans)),
  pg_temp.pick(pg_temp.feed_lines((select a from ans)), '%|flagged|%'),
  '0478/43: the flagged feed holds the flagged entries of the feed, in the same order and with the same shape (nine here, fewer than its 20)');

-- ── 5. The private function: the units themselves ───────────────────────────
select results_eq(
  $$ select pg_temp.mins(u.minute::text), u.reason, u.source, u.country, u.city, u.organization_id, u.organizations,
            u.events, u.at_least, u.kind, u.late
       from public._security_map_units(pg_temp.m(70), pg_temp.m(75), false) u
      order by u.minute, u.reason, u.source, u.country $$,
  $$ values
    ('70', 'sign_in_new_country', 'phone', 'PT', 'Example Harbour', 'a0478000-0000-0000-0000-0000000000b1'::uuid, 1, 1, false, 'event', true),
    ('70', 'sign_in_new_country', 'web',   'ES', 'Example Plaza',   'a0478000-0000-0000-0000-0000000000a1'::uuid, 1, 1, false, 'event', false),
    ('70', 'sign_in_new_country', 'web',   'PT', 'Example Harbour', null::uuid,                                   3, 1, true,  'event', false),
    ('71', 'sign_in_not_me',      'web',   'IT', 'Example Piazza',  null::uuid,                                   2, 2, true,  'event', false),
    ('72', 'sign_in_alerts_held', 'phone', 'GB', 'Example Borough', null::uuid,                                   2, 3, true,  'event', true),
    ('73', 'sign_in_new_country', 'web',   'BR', null,              'a0478000-0000-0000-0000-0000000000c1'::uuid, 1, 1, false, 'event', false),
    ('74', 'sign_in_not_me',      'web',   'JP', 'Example Bay',     null::uuid,                                   0, 1, false, 'event', false) $$,
  '0478/44: the fold: one account in three organizations is one unit of 1 (not 3) that names no organization, says three and is marked at_least; two places in one minute are two units; the phone is another unit; 2 and 1 in two organizations are 2 (the largest, not 3); 3 and 3 are 3; a unit of one row is exact; one organization is named; none is none');
select results_eq(
  $$ select pg_temp.mins(u.minute::text), u.reason, u.country, u.city, u.organization_id, u.organizations, u.events, u.kind, u.late
       from public._security_map_units(pg_temp.m(40), pg_temp.m(61), false) u
      order by u.minute, u.events desc $$,
  $$ values
    ('40', 'over_minute_cap',         null::text, null::text, null::uuid,                                   0, 50, 'flood', false),
    ('40', 'over_minute_cap',         null,       null,       'a0478000-0000-0000-0000-0000000000a1'::uuid, 1, 30, 'flood', false),
    ('41', 'over_buffer_cap',         null,       null,       null,                                         0, 20, 'flood', false),
    ('41', 'over_buffer_cap',         null,       null,       null,                                         0, 5,  'flood', false),
    ('50', 'wrong_password',          'US',       null,       null,                                         0, 11, 'event', true),
    ('51', 'auth_rate_limited',       null,       null,       null,                                         0, 13, 'event', true),
    ('52', 'auth_log_over_cap',       null,       null,       null,                                         0, 17, 'flood', true),
    ('60', 'too_many_forms_to_count', null,       null,       null,                                         0, 700, 'tally', true) $$,
  '0478/45: the other kinds: a row past a cap (the hourly reader''s remainder too) is a flood unit with no country and no city whatever the row holds, and keeps its organization; a tally is marked a tally; the phone and the api are late; every other row is a unit as it is');
select is(
  (select array[count(*)::int, count(*) filter (where u.outcome = 'flagged')::int, sum(u.events)::int]
     from public._security_map_units(pg_temp.m(0), pg_temp.m(120), true) u),
  (select array[count(*)::int, count(*)::int, sum(u.events)::int]
     from public._security_map_units(pg_temp.m(0), pg_temp.m(120), false) u where u.outcome = 'flagged'),
  '0478/46: asked for the flagged units only, the private function returns exactly the flagged units of the window, folded the same way');

-- A tally is in nothing but the list of tallies: take the two tally rows
-- away and the rest of the answer is the same, to the letter.
savepoint no_tally_rows;
delete from public.security_events where reason = any (pg_temp.list_items('c_tally_reasons'));
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null) - 'tallies',
  (select a - 'tallies' from ans),
  '0478/47: with the tally rows gone the answer differs in its list of tallies and in nothing else: no total, cell, group, feed entry or late line held them');
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
  '0478/48: a row of 100,000 for each reason of the list of tallies changes no total, cell, group, feed entry or late line');
select is(
  (select array[count(*)::int, count(distinct e ->> 'reason')::int, sum((e ->> 'events')::bigint)::int]
     from jsonb_array_elements(public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null) -> 'tallies') e
    where e ->> 'source' = 'web'),
  (select array[n, n, n * 100000] from (select cardinality(pg_temp.list_items('c_tally_reasons')) as n) x),
  '0478/49: and each is listed with the tallies, once, with its 100,000');
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(45)) - 'tallies',
  (select d45 - 'tallies' from ans),
  '0478/50: a blocked tally is not counted since the day start either (62 still)');
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
     from (select public.platform_security_map(pg_temp.m(-45), pg_temp.m(-15), null) as a) x),
  (select array[3, 10 * n, 10 * n, 1, 3, n] from (select cardinality(pg_temp.list_items('c_flood_reasons')) as n) y),
  '0478/51: each of the three reasons recorded once in each organization counts 1 for three organizations (3 in all, the only group by country), and each reason past a cap is counted with no place (10 each) and listed');
rollback to savepoint every_listed_reason;

-- The city, a live minute with no country, and the window's end on a folded
-- minute. m(-60): one sign-in from a new country in two cities of PT (A in
-- one, B in the other): two units, not one. m(-58): one kind of row from
-- two cities of FR for A: two entries of the feed. m(-56): a counted row
-- with no country inside the last ten minutes: in the totals, in no cell.
savepoint more_edges;
select pg_temp.ev(-60, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgA, 'PT', 'Example Harbour', 1);
select pg_temp.ev(-60, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgB, 'PT', 'Example Quay', 1);
select pg_temp.ev(-58, 'bots', 'blocked', 'public_order_paused', 'web', :orgA, 'FR', 'Example Ville', 3);
select pg_temp.ev(-58, 'bots', 'blocked', 'public_order_paused', 'web', :orgA, 'FR', 'Example Bourg', 4);
select pg_temp.ev(-56, 'exploit', 'blocked', 'env_file', 'web', null, null, null, 9);
select is(
  (select array[count(*)::int, sum(u.events)::int, sum(u.organizations)::int, count(*) filter (where u.at_least)::int]
     from public._security_map_units(pg_temp.m(-61), pg_temp.m(-55), false) u where u.reason = 'sign_in_new_country'),
  array[2, 2, 2, 0],
  '0478/52: a sign-in event in two cities of one country in one minute is two units of 1, each of one organization: the city is part of the fold''s key');
select is(pg_temp.feed_lines(public.platform_security_map(pg_temp.m(-61), pg_temp.m(-55), null)),
  array['-56|exploit|blocked|env_file|web|-|-|9|-|0|f',
        '-58|bots|blocked|public_order_paused|web|FR|Example Bourg|4|Example Map Academy|1|f',
        '-58|bots|blocked|public_order_paused|web|FR|Example Ville|3|Example Map Academy|1|f',
        '-60|phishing|flagged|sign_in_new_country|web|PT|Example Harbour|1|Example Map Academy|1|f',
        '-60|phishing|flagged|sign_in_new_country|web|PT|Example Quay|1|Example Map Charter|1|f'],
  '0478/53: two cities of one country, kind and organization in one minute are two entries of the feed (4 and 3), and so are the two cities of the sign-in event, each naming its organization');
select is(
  (select array_to_string(pg_temp.timeline_lines(a), ' ') || ' ' || (a ->> 'blocked_window') || ' '
          || (a -> 'no_place' -> 'exploit' ->> 'blocked')
          || ' ' || (select count(*) from jsonb_array_elements(a -> 'timeline') e where e -> 'country' = 'null'::jsonb)
     from (select public.platform_security_map(pg_temp.m(-61), pg_temp.m(-55), null) as a) x),
  '-58|60|FR|bots|blocked|7 -60|60|PT|phishing|flagged|2 16 9 0',
  '0478/54: the row with no country inside the last ten minutes is counted (blocked 16, 9 of them with no place) and has no 1-minute cell: every cell names a country');
select is(
  (select array[(a -> 'totals' -> 'phishing' ->> 'flagged')::int, (a ->> 'flagged_window')::int,
                jsonb_array_length(a -> 'feed')]
     from (select public.platform_security_map(pg_temp.m(-65), pg_temp.m(-60), null) as a) x),
  array[0, 0, 0],
  '0478/55: a window that ends on the minute of a folded sign-in leaves it out: the fold reads the window as every other row is read');
rollback to savepoint more_edges;

-- ── 6. The edges of the window and of the buckets ───────────────────────────
select is(
  (select array[(a ->> 'blocked_window')::int, (a -> 'totals' -> 'password_guessing' ->> 'blocked')::int,
                (a -> 'totals' -> 'bots' ->> 'blocked')::int]
     from (select public.platform_security_map(pg_temp.m(0) + interval '1 second', pg_temp.m(120), null) as a) x),
  array[189, 42, 108],
  '0478/56: a window that starts a second after m(0) leaves out the rows of the minute m(0) (7 fewer): a row is in the window when its minute starts at or after the start');
select is(
  (select array[(a ->> 'blocked_window')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int]
     from (select public.platform_security_map(pg_temp.m(-1), pg_temp.m(120), null) as a) x),
  array[2196, 2108],
  '0478/57: a window that starts on the minute before takes that minute''s row in (2,000 more)');
select is(
  (select array[(a ->> 'blocked_window')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int]
     from (select public.platform_security_map(pg_temp.m(0), pg_temp.m(120) + interval '1 microsecond', null) as a) x),
  array[1196, 1108],
  '0478/58: the row on the minute m(120) is out of a window that ends at m(120) and in one that ends a microsecond later (1,000 more)');
select is(
  (select array[(a -> 'window' ->> 'live_from')::timestamptz = pg_temp.m(109), (a ->> 'blocked_window')::int = 189]::text
          || ' ' || array_to_string(pg_temp.pick(pg_temp.timeline_lines(a), '%|60|%'), ' ')
     from (select public.platform_security_map(pg_temp.m(0), pg_temp.m(119), null) as a) x),
  '{t,t} 109|60|DE|exploit|blocked|8 110|60|DE|exploit|blocked|2 118|60|PT|phishing|flagged|1',
  '0478/59: a window that ends at m(119): the row of m(119) is out (7 fewer), the last ten minutes are m109 to m118, and m109 now has a 1-minute cell');
select is(
  (select array[(a -> 'window' ->> 'live_from')::timestamptz = pg_temp.m(109) + interval '30 seconds',
                (a ->> 'blocked_window')::int = 196]::text
          || ' ' || array_to_string(pg_temp.pick(pg_temp.timeline_lines(a), '%|60|%'), ' ')
     from (select public.platform_security_map(pg_temp.m(0), pg_temp.m(119) + interval '30 seconds', null) as a) x),
  '{t,t} 119|60|US|password_guessing|blocked|7 110|60|DE|exploit|blocked|2 118|60|PT|phishing|flagged|1',
  '0478/60: a window that ends 30 seconds into m(119): that minute is in, and the last ten minutes are the ten minutes m110 to m119 (m109, which starts before the ten minutes do, has no 1-minute cell)');
select is(
  (select pg_temp.pick(pg_temp.timeline_lines(a), '10|600|%') || pg_temp.pick(pg_temp.timeline_lines(a), '0|600|%')
     from (select public.platform_security_map(pg_temp.m(5), pg_temp.m(120), null) as a) x),
  array['10|600|DE|exploit|blocked|4', '0|600|US|password_guessing|blocked|3'],
  '0478/61: a window that starts at m(5), inside a bucket: the buckets stay on the clock, so the first cell starts at m(0), before the window, and holds only the row of m9 (3)');
select is(
  (select array[(a -> 'window' ->> 'live_from')::timestamptz = pg_temp.m(113), (a ->> 'short_window')::boolean,
                jsonb_array_length(a -> 'by_country') = 0, not (a ->> 'by_country_truncated')::boolean,
                not (a ->> 'timeline_truncated')::boolean,
                (a ->> 'blocked_window')::int = 7, (a ->> 'flagged_window')::int = 1]::text
          || ' ' || array_to_string(pg_temp.timeline_lines(a), ' ')
     from (select public.platform_security_map(pg_temp.m(113), pg_temp.m(120), null) as a) x),
  '{t,t,t,t,t,t,t} 119|60|US|password_guessing|blocked|7 118|60|PT|phishing|flagged|1',
  '0478/62: a window shorter than ten minutes (the 30-second poll): its last ten minutes are the whole window; being shorter than 30 minutes it has the 1-minute cells only, no 10-minute cell and no group by country, and is marked short; its totals are of its own minutes');
select is(
  (select array[(a ->> 'short_window'), pg_temp.cells_of(a -> 'timeline', 600, null)::text,
                jsonb_array_length(a -> 'by_country')::text, (b ->> 'short_window'),
                pg_temp.cells_of(b -> 'timeline', 600, null)::text, jsonb_array_length(b -> 'by_country')::text,
                pg_temp.cells_of(b -> 'timeline', 60, null)::text, (b ->> 'blocked_window')]
     from (select public.platform_security_map(pg_temp.m(90), pg_temp.m(120), null) as a,
                  public.platform_security_map(pg_temp.m(90) + interval '1 microsecond', pg_temp.m(120), null) as b) x),
  array['false', '4', '3', 'true', '0', '0', '3', '21'],
  '0478/63: a window of exactly 30 minutes is a whole window (four 10-minute cells, three groups by country); a microsecond shorter is a poll (none of either, its 1-minute cells and totals all the same)');

-- ── 7. Blocked since the day start ──────────────────────────────────────────
select is(
  (select array[d45 -> 'blocked_since_day_start', d45 -> 'day_start', d50 -> 'blocked_since_day_start',
                d50s -> 'blocked_since_day_start', d50s -> 'day_start']
     from ans),
  array['62'::jsonb, to_jsonb(pg_temp.m(45)), '62'::jsonb, '51'::jsonb, to_jsonb(pg_temp.m(50) + interval '1 second')],
  '0478/64: a day start inside the window: the blocked events of the minutes that start at or after it (62 from m45; still 62 from m50, the minute of a row; 51 a second later), and the day start is given back');
select is(
  (select array[dfrom -> 'blocked_since_day_start', dto -> 'blocked_since_day_start', dto -> 'day_start'] from ans),
  array['196'::jsonb, '0'::jsonb, to_jsonb(pg_temp.m(120))],
  '0478/65: on the window''s edges: a day start at its start counts every blocked event of the window (196, flagged and allowed never), one at its end counts none (0)');
select is(
  (select array[dbefore -> 'blocked_since_day_start', dbefore -> 'day_start', dafter -> 'blocked_since_day_start',
                dafter -> 'day_start', dnever -> 'blocked_since_day_start', dnever -> 'day_start',
                a -> 'blocked_since_day_start', a -> 'day_start']
     from ans),
  array_fill('null'::jsonb, array[8]),
  '0478/66: a day start outside the window (a second before it, a second after it, not a time) or none: no number and no day start, never a count of part of a day');
select is(
  (select array[d45 - 'blocked_since_day_start' - 'day_start', dbefore - 'blocked_since_day_start' - 'day_start',
                dnever - 'blocked_since_day_start' - 'day_start']
     from ans),
  (select array_fill(a - 'blocked_since_day_start' - 'day_start', array[3]) from ans),
  '0478/67: the day start changes those two keys and nothing else');

-- ── 8. A window that cannot be read ─────────────────────────────────────────
-- Each call goes through answer_of, so a call that raised would be shown
-- as what it raised and the file would go on.
select is(
  array[pg_temp.answer_of($$ select public.platform_security_map(now(), now() - interval '1 hour', null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '1 hour', now() - interval '1 hour', null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '26 hours' - interval '1 microsecond', now(), null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '27 hours', null, null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(now() - interval '1 hour', now() + interval '1 minute' + interval '1 microsecond', null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(null, now() + interval '2 minutes', null) $$)],
  array[jsonb_build_object('window', null, 'refused', 'from_not_before_to', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'from_not_before_to', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'longer_than_26_hours', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'longer_than_26_hours', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'to_in_the_future', 'generated_at', now()),
        jsonb_build_object('window', null, 'refused', 'to_in_the_future', 'generated_at', now())],
  '0478/68: refused with a fixed word and exactly three keys, never raised: a window out of order or empty, one longer than 26 hours by a microsecond (also with no end given), one that ends more than a minute after now');
select is(
  array[pg_temp.answer_of($$ select public.platform_security_map('-infinity', now(), null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map(now(), 'infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map('infinity', 'infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map(null, 'infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map(null, '-infinity', null) $$) - 'generated_at',
        pg_temp.answer_of($$ select public.platform_security_map('-infinity', null, 'infinity') $$) - 'generated_at'],
  array_fill(jsonb_build_object('window', null, 'refused', 'not_a_time'), array[6]),
  '0478/69: a start or an end that is not a time is refused as such, never raised');
select is(
  array[(pg_temp.answer_of($$ select public.platform_security_map('1999-12-31 00:00:00+00', now(), '1998-01-01 00:00:00+00') $$) - 'generated_at')::text,
        (pg_temp.answer_of($$ select public.platform_security_map('1999-12-31 00:00:00+00', '1999-12-30 00:00:00+00', null) $$) - 'generated_at')::text,
        (pg_temp.answer_of($$ select public.platform_security_map('1999-12-31 00:00:00+00', '1999-12-31 00:00:00+00', '1999-12-31 00:00:00+00') $$) - 'generated_at')::text,
        (pg_temp.answer_of($$ select public.platform_security_map(now(), now() + interval '9 days', now() + interval '8 days') $$) - 'generated_at')::text],
  array['{"window": null, "refused": "longer_than_26_hours"}',
        '{"window": null, "refused": "from_not_before_to"}',
        '{"window": null, "refused": "from_not_before_to"}',
        '{"window": null, "refused": "to_in_the_future"}'],
  '0478/70: a refusal holds its word and nothing of the argument it refused: no date, no time, no day start');
select is(
  array[public.platform_security_map(now() - interval '26 hours', now(), null) -> 'window',
        public.platform_security_map(now() - interval '1 hour', now() + interval '1 minute', null) -> 'window',
        public.platform_security_map(null, null, null) -> 'window',
        public.platform_security_map() -> 'window',
        public.platform_security_map(now() - interval '2 hours', null, null) -> 'window',
        public.platform_security_map(null, now() - interval '70 hours', null) -> 'window'],
  array[jsonb_build_object('from', now() - interval '26 hours', 'to', now(), 'live_from', now() - interval '10 minutes', 'asked_from', now() - interval '26 hours'),
        jsonb_build_object('from', now() - interval '1 hour', 'to', now() + interval '1 minute', 'live_from', now() - interval '9 minutes', 'asked_from', now() - interval '1 hour'),
        jsonb_build_object('from', now() - interval '24 hours', 'to', now(), 'live_from', now() - interval '10 minutes', 'asked_from', now() - interval '24 hours'),
        jsonb_build_object('from', now() - interval '24 hours', 'to', now(), 'live_from', now() - interval '10 minutes', 'asked_from', now() - interval '24 hours'),
        jsonb_build_object('from', now() - interval '2 hours', 'to', now(), 'live_from', now() - interval '10 minutes', 'asked_from', now() - interval '2 hours'),
        jsonb_build_object('from', now() - interval '94 hours', 'to', now() - interval '70 hours', 'live_from', now() - interval '70 hours 10 minutes', 'asked_from', now() - interval '94 hours')],
  '0478/71: read: exactly 26 hours; an end exactly a minute after now; no argument at all is the 24 hours up to now; a start alone runs to now; an end alone is the 24 hours before it, however old');
select is(
  (select (a ->> 'blocked_window')::int from (select public.platform_security_map() as a) x),
  3196,
  '0478/72: with no argument the answer is the last 24 hours of the record: every blocked event on record (196 in the window, 2,000 before it, 1,000 after)');

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
          || ' ' || jsonb_array_length(a -> 'by_country') || ' ' || pg_temp.events_of(a -> 'by_country', null)
     from (select public.platform_security_map(pg_temp.m(-600), pg_temp.m(-480), null) as a) x),
  '{4000,1000,1051,3000,126,11500,60,1150,600,11500}truefalse2695050 600 2695050',
  '0478/73: 1,500 1-minute cells and 3,750 10-minute cells: 4,000 are returned, the 1,000 largest 1-minute cells first and then the 3,000 largest 10-minute cells, with the flag set; the totals still count every event (2,695,050), and the 600 groups by country are not cut and hold every one of them although the timeline was cut');
-- One flagged sign-in of 1 in the oldest bucket: the 10-minute cells are
-- cut again, and the flagged cell is kept before any blocked one.
select pg_temp.ev(-600, 'phishing', 'flagged', 'sign_in_not_me', 'web', :orgA, 'ZZ', null, 1);
select is(
  (select array[pg_temp.cells_of(a -> 'timeline', 600, null), pg_temp.cells_of(a -> 'timeline', 600, 'flagged'),
                pg_temp.cells_of(a -> 'timeline', 60, null), (a ->> 'flagged_window')::int]::text || (a ->> 'timeline_truncated')
     from (select public.platform_security_map(pg_temp.m(-600), pg_temp.m(-480), null) as a) x),
  '{3000,1,1000,1}true',
  '0478/74: a flagged 10-minute cell of 1 among 3,750 blocked ones that are cut to 3,000 is kept');
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
  '0478/75: exactly 1,000 1-minute cells and 3,000 10-minute cells: all 4,000 returned and the flag not set');
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-900), k.category, 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), c, md5(gen_random_uuid()::text)
  from generate_series(1, 400) c,
       unnest(array['password_guessing', 'exploit', 'bots', 'phishing', 'malware']) k(category);
select is(
  (select array[jsonb_array_length(a -> 'by_country'), (a -> 'by_country' -> 0 ->> 'events')::int,
                (a -> 'by_country' -> 1999 ->> 'events')::int]::text
          || (a ->> 'by_country_truncated') || (a ->> 'timeline_truncated')
     from (select public.platform_security_map(pg_temp.m(-905), pg_temp.m(-875), null) as a) x),
  '{2000,400,1}falsefalse',
  '0478/76: exactly 2,000 groups by country: all returned, the largest first, and the flag not set');
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
     from (select public.platform_security_map(pg_temp.m(-905), pg_temp.m(-875), null) as a) x),
  '{2000,450,51,507375,2250}truefalse',
  '0478/77: 2,250 groups by country: the 2,000 largest are returned (down to 51 events) with the flag set, the totals still count every event (507,375), and the timeline, which has room for them, holds all 2,250');
-- And one flagged sign-in of 1 among them: it is kept, and a blocked group of
-- 51 goes instead (the list is still written largest first).
select pg_temp.ev(-900, 'phishing', 'flagged', 'sign_in_not_me', 'web', :orgA, 'ZZ', null, 1);
select is(
  (select array[jsonb_array_length(a -> 'by_country'),
                (select count(*)::int from jsonb_array_elements(a -> 'by_country') e where e ->> 'outcome' = 'flagged'),
                (select count(*)::int from jsonb_array_elements(a -> 'by_country') e where (e ->> 'events')::int = 51),
                (a -> 'by_country' -> 1999 ->> 'events')::int]::text
          || (a -> 'by_country' -> 1999 ->> 'outcome') || (a ->> 'by_country_truncated')
     from (select public.platform_security_map(pg_temp.m(-905), pg_temp.m(-875), null) as a) x),
  '{2000,1,4,1}flaggedtrue',
  '0478/78: when the groups by country are cut, a flagged group is kept before any blocked one: the flagged group of 1 is in (last, as the list is largest first) and only four of the five groups of 51 are');
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
  '0478/79: ten 1-minute cells and 3,997 10-minute cells: the ten, then the 3,990 largest 10-minute cells, 4,000 in all, with the flag set');
rollback to savepoint room_left_over;

-- A flood does not hide a flagged sign-in. Window m(-1020) to m(-990), whose
-- last ten minutes are m(-1000) to m(-991). In its newest minute, 70
-- blocked entries of 5 (70 countries) and one sign-in from a new country
-- (1): the feed's 60 entries are all blocked, the flagged feed has the
-- sign-in. Then 1,100 blocked 1-minute cells of 5 (110 countries in each of
-- the ten minutes, 1,171 1-minute cells with the 70 and the one): the
-- 1-minute cells are cut to 1,000 and the flagged cell is among them; the
-- 181 10-minute cells are not cut, so the flag says the 1-minute cells were.
savepoint flood_and_flagged;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-991), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(c), 5, md5(gen_random_uuid()::text)
  from generate_series(1, 70) c;
select pg_temp.ev(-991, 'phishing', 'flagged', 'sign_in_new_country', 'web', :orgA, 'PT', 'Example Harbour', 1);
select is(
  (select array[jsonb_array_length(a -> 'feed'),
                (select count(*)::int from jsonb_array_elements(a -> 'feed') e where e ->> 'outcome' = 'flagged'),
                jsonb_array_length(a -> 'flagged_feed'), (a -> 'totals' -> 'phishing' ->> 'flagged')::int]::text
          || ' ' || array_to_string(pg_temp.entry_lines(a -> 'flagged_feed'), ' ')
     from (select public.platform_security_map(pg_temp.m(-1020), pg_temp.m(-990), null) as a) x),
  '{60,0,1,1} -991|phishing|flagged|sign_in_new_country|web|PT|Example Harbour|1|Example Map Academy|1|f',
  '0478/80: 70 blocked entries of 5 and one flagged sign-in in the newest minute: the feed''s 60 entries are all blocked, and the flagged feed holds the sign-in');
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-1000 + j), 'exploit', 'blocked', 'env_file', 'web', pg_temp.cc(c), 5, md5(gen_random_uuid()::text)
  from generate_series(0, 9) j, generate_series(101, 210) c;
select is(
  (select array[pg_temp.cells_of(a -> 'timeline', 60, null), pg_temp.cells_of(a -> 'timeline', 60, 'flagged'),
                pg_temp.cells_of(a -> 'timeline', 600, null), pg_temp.cells_of(a -> 'timeline', 600, 'flagged'),
                jsonb_array_length(a -> 'flagged_feed'), (a ->> 'flagged_window')::int]::text
          || (a ->> 'timeline_truncated') || (a ->> 'by_country_truncated')
     from (select public.platform_security_map(pg_temp.m(-1020), pg_temp.m(-990), null) as a) x),
  '{1000,1,181,1,1,1}truefalse',
  '0478/81: 1,171 1-minute cells, 1,170 of them blocked cells of 5: 1,000 are kept and the flagged cell of 1 is among them; the 181 10-minute cells are all kept, so the flag is set for the cut of the 1-minute cells alone');
rollback to savepoint flood_and_flagged;

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
  '0478/82: 90 entries in 30 minutes: the feed holds the newest 60 (the newest 20 minutes, three each, the largest first in a minute); the totals count all 180 events');
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
  '0478/83: 70 minutes of one entry under five newer minutes that hold only a tally: the feed holds the newest 60 entries (m-831 back to m-890): a minute with only a tally takes no place in it');
rollback to savepoint feed_cap;

-- The flagged feed's cap. 25 minutes with one flagged entry each, under five
-- newer minutes that hold only a flagged tally: the newest 20 flagged
-- entries (m-1076 back to m-1095), and no tally among them.
savepoint flagged_feed_cap;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-1100 + j), 'password_guessing', 'flagged', 'passkey_counter_went_back', 'web', 'CA', 1, md5(gen_random_uuid()::text)
  from generate_series(0, 24) j;
insert into public.security_events (minute, category, outcome, reason, source, event_count, dedupe_key)
select pg_temp.m(-1070 + j), 'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', 40, md5(gen_random_uuid()::text)
  from generate_series(0, 4) j;
select is(
  (select array[jsonb_array_length(a -> 'flagged_feed'),
                pg_temp.mins(a -> 'flagged_feed' -> 0 ->> 'minute')::int, pg_temp.mins(a -> 'flagged_feed' -> 19 ->> 'minute')::int,
                (select count(*)::int from jsonb_array_elements(a -> 'flagged_feed') e where e ->> 'reason' = 'too_many_forms_to_count'),
                jsonb_array_length(a -> 'feed')]
     from (select public.platform_security_map(pg_temp.m(-1100), pg_temp.m(-1060), null) as a) x),
  array[20, -1076, -1095, 0, 25],
  '0478/84: 25 flagged entries under five newer minutes that hold only a flagged tally: the flagged feed holds the newest 20 (m-1076 back to m-1095), and a minute with only a tally takes no place in it');
rollback to savepoint flagged_feed_cap;

-- ── Floors ──────────────────────────────────────────────────────────────────
-- Twelve more made-up organizations, and in m(-410) to m(-401) the folded
-- sign-in events whose count is a floor. One sign-in writes at most 5 rows
-- (one in each of at most 5 organizations), each of 1:
--   m-409 new country, NO, 7 rows of 1           at least ceil(7 / 5) = 2
--   m-408 new country, NO, 12 rows of 1          at least 3
--   m-407 not me, SE, rows 3, 1, 1, 1            at least the largest, 3 (ceil(6 / 5) = 2)
--   m-406 not me, SE, one row of 4               exactly 4 (one row: not a floor)
--   m-405 new country, FI, 10 rows of 1          at least 2
--   m-404 new country, DK, 1 with no organization and 1 in one:  at least 1 (two rows),
--         and the organization of the one is named
--   m-403 alerts held, no country, 2 and 2       at least 2: a floor with no place
--   m-402 not me, IS, BLOCKED (made up: no writer does it), 1 and 1: a blocked floor
-- flagged 2 + 3 + 3 + 4 + 2 + 1 + 2 = 17 (phishing 15, password guessing 2); blocked 1.
savepoint floors;
insert into public.organizations (id, name, slug, mfa_policy)
select ('a0478000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'Example Floor Org ' || g,
       'a0478000-example-floor-org-' || g, 'optional'
  from generate_series(1, 12) g;
create function pg_temp.fo(p integer) returns uuid language sql immutable as $$
  select ('a0478000-0000-0000-0000-0000000001' || lpad(p::text, 2, '0'))::uuid;
$$;
select pg_temp.ev(-409, 'phishing', 'flagged', 'sign_in_new_country', 'web', pg_temp.fo(g), 'NO', 'Example Fjord', 1) from generate_series(1, 7) g;
select pg_temp.ev(-408, 'phishing', 'flagged', 'sign_in_new_country', 'web', pg_temp.fo(g), 'NO', 'Example Fjord', 1) from generate_series(1, 12) g;
select pg_temp.ev(-407, 'phishing', 'flagged', 'sign_in_not_me', 'web', pg_temp.fo(g), 'SE', 'Example Sound', case when g = 1 then 3 else 1 end) from generate_series(1, 4) g;
select pg_temp.ev(-406, 'phishing', 'flagged', 'sign_in_not_me', 'web', pg_temp.fo(1), 'SE', 'Example Sound', 4);
select pg_temp.ev(-405, 'phishing', 'flagged', 'sign_in_new_country', 'web', pg_temp.fo(g), 'FI', 'Example Lake', 1) from generate_series(1, 10) g;
select pg_temp.ev(-404, 'phishing', 'flagged', 'sign_in_new_country', 'web', null, 'DK', 'Example Strand', 1);
select pg_temp.ev(-404, 'phishing', 'flagged', 'sign_in_new_country', 'web', pg_temp.fo(1), 'DK', 'Example Strand', 1);
select pg_temp.ev(-403, 'password_guessing', 'flagged', 'sign_in_alerts_held', 'web', pg_temp.fo(g), null, null, 2) from generate_series(1, 2) g;
select pg_temp.ev(-402, 'phishing', 'blocked', 'sign_in_not_me', 'web', pg_temp.fo(g), 'IS', null, 1) from generate_series(1, 2) g;
select results_eq(
  $$ select pg_temp.mins(u.minute::text), u.reason, u.country, u.organizations, u.events, u.at_least,
            u.organization_id = pg_temp.fo(1)
       from public._security_map_units(pg_temp.m(-410), pg_temp.m(-400), false) u
      order by u.minute $$,
  $$ values ('-409', 'sign_in_new_country', 'NO', 7, 2, true, null::boolean),
            ('-408', 'sign_in_new_country', 'NO', 12, 3, true, null),
            ('-407', 'sign_in_not_me', 'SE', 4, 3, true, null),
            ('-406', 'sign_in_not_me', 'SE', 1, 4, false, true),
            ('-405', 'sign_in_new_country', 'FI', 10, 2, true, null),
            ('-404', 'sign_in_new_country', 'DK', 1, 1, true, true),
            ('-403', 'sign_in_alerts_held', null, 2, 2, true, null),
            ('-402', 'sign_in_not_me', 'IS', 2, 1, true, null) $$,
  '0478/85: the fold is a floor: the largest count among the rows or a fifth of their sum rounded up, whichever is more (7 rows of 1 are at least 2, 12 are at least 3, 3 1 1 1 at least 3, 10 rows at least 2); a unit of two rows or more is marked at_least, also when one of its rows names no organization; one row is exact');
select is(
  (select array[(a -> 'totals' -> 'phishing' ->> 'flagged')::int, (a -> 'totals' -> 'password_guessing' ->> 'flagged')::int,
                (a ->> 'flagged_window')::int, (a ->> 'blocked_window')::int, (a ->> 'blocked_since_day_start')::int]::text
          || ' ' || (a -> 'floors')::text
     from (select public.platform_security_map(pg_temp.m(-410), pg_temp.m(-400), pg_temp.m(-405)) as a) x),
  '{15,2,17,1,1} ["blocked_since_day_start", "blocked_window", "flagged_window", "no_place.password_guessing.flagged", "totals.password_guessing.flagged", "totals.phishing.blocked", "totals.phishing.flagged"]',
  '0478/86: every number that holds a unit marked at_least is named a floor: the totals, the count with no place, the window counts, and the day count');
select is(
  (select array_agg(left(e ->> 'at_least', 1) || (e ->> 'events') order by o)
     from jsonb_array_elements(public.platform_security_map(pg_temp.m(-410), pg_temp.m(-400), null) -> 'feed') with ordinality x(e, o)),
  array['t1', 't2', 't1', 't2', 'f4', 't3', 't3', 't2'],
  '0478/87: each entry of the feed whose count is a floor is marked at_least, and the one of a single row is not');
select is(
  (select pg_temp.entry_lines(a -> 'flagged_feed') = pg_temp.pick(pg_temp.feed_lines(a), '%|flagged|%')
          and jsonb_array_length(a -> 'flagged_feed') = 7
     from (select public.platform_security_map(pg_temp.m(-410), pg_temp.m(-400), null) as a) x),
  true,
  '0478/88: the flagged feed holds the seven flagged entries and not the blocked folded one');
select is(
  (select array[(a -> 'floors')::text, (a -> 'totals' -> 'phishing' ->> 'flagged'), (a -> 'feed' -> 0 ->> 'at_least')]
     from (select public.platform_security_map(pg_temp.m(-406), pg_temp.m(-405), null) as a) x),
  array['[]', '4', 'false'],
  '0478/89: a window whose only folded unit is of one row has no floor');
rollback to savepoint floors;

-- ── The row ceiling ─────────────────────────────────────────────────────────
-- One minute short of nothing: m(-1400) holds the ceiling less one row
-- (399,999 blocked rows of 1), m(-1399) one row of 5. The window m(-1400) to
-- m(-1398) then holds exactly the ceiling. One more row (of 3, in m-1399)
-- and the newest 400,001 rows reach into m(-1400): the window is read from
-- m(-1399), the minute after. Two more rows in m(-1400) and that minute
-- alone holds more than the ceiling.
savepoint row_ceiling;
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-1400), 'bots', 'blocked', 'public_order_paused', 'web', pg_temp.cc(1 + g % 7), 1, md5('a0478-ceiling-' || g)
  from generate_series(1, pg_temp.ceiling() - 1) g;
select pg_temp.ev(-1399, 'exploit', 'blocked', 'env_file', 'web', null, 'DE', null, 5);
select is(
  (select (a ->> 'window_shortened') || ' ' || ((a -> 'window' ->> 'from')::timestamptz = pg_temp.m(-1400))::text
          || ' ' || ((a -> 'window' ->> 'asked_from')::timestamptz = pg_temp.m(-1400))::text
          || ' ' || ((a ->> 'blocked_window')::bigint = pg_temp.ceiling() - 1 + 5)::text
          || ' ' || (a ->> 'blocked_since_day_start') || ' ' || (a ->> 'blocked_since_day_start_partial')
          || ' ' || (a -> 'floors')::text
     from (select public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1398), pg_temp.m(-1399)) as a) x),
  'false true true true 5 false []',
  '0478/90: a window that holds exactly the ceiling (400,000 rows) is read as asked: not shortened, every row counted');
select pg_temp.ev(-1399, 'exploit', 'blocked', 'git_dir', 'web', null, 'DE', null, 3);
create temporary table ceiling_ans as
  select public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1398), null) as a,
         public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1398), pg_temp.m(-1400)) as dpart,
         public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1398), pg_temp.m(-1399)) as dread,
         public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1398), pg_temp.m(-1400) - interval '1 second') as dbefore,
         public.platform_security_map(pg_temp.m(-1399), pg_temp.m(-1398), null) as fromread;
select is(
  (select array[a -> 'window', a -> 'window_shortened', a -> 'blocked_window', a -> 'totals' -> 'exploit' -> 'blocked']
     from ceiling_ans),
  array[jsonb_build_object('from', pg_temp.m(-1399), 'to', pg_temp.m(-1398), 'live_from', pg_temp.m(-1399),
                           'asked_from', pg_temp.m(-1400)),
        'true'::jsonb, '8'::jsonb, '8'::jsonb],
  '0478/91: one row more than the ceiling: the window is read from the minute after the oldest minute the ceiling reaches (m-1399, the earliest whole-minute start that keeps it within the ceiling), the answer says so and gives the start asked for, and counts the window read (8)');
select is(
  (select a - 'window' - 'window_shortened' from ceiling_ans),
  (select fromread - 'window' - 'window_shortened' from ceiling_ans),
  '0478/92: every part of the shortened answer is the answer for the window read');
select is(
  (select array[dpart -> 'blocked_since_day_start', dpart -> 'blocked_since_day_start_partial', dpart -> 'floors',
                dread -> 'blocked_since_day_start', dread -> 'blocked_since_day_start_partial', dread -> 'floors',
                dbefore -> 'blocked_since_day_start', dbefore -> 'blocked_since_day_start_partial', dbefore -> 'day_start']
     from ceiling_ans),
  array['8'::jsonb, 'true', '["blocked_since_day_start"]', '8', 'false', '[]', 'null', 'false', 'null'],
  '0478/93: a day start inside the window asked for but before the start read is counted from the start read, marked partial and named a floor; one on the start read is whole; one before the window asked for gives no number');
insert into public.security_events (minute, category, outcome, reason, source, country, event_count, dedupe_key)
select pg_temp.m(-1400), 'bots', 'blocked', 'public_order_paused', 'web', 'AA', 1, md5('a0478-ceiling-more-' || g)
  from generate_series(1, 2) g;
select is(
  array[pg_temp.answer_of($$ select public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1399), null) $$),
        pg_temp.answer_of($$ select public.platform_security_map(pg_temp.m(-1400), pg_temp.m(-1398), null) $$) -> 'window'],
  array[jsonb_build_object('window', null, 'refused', 'too_many_events_in_one_minute', 'generated_at', now()),
        jsonb_build_object('from', pg_temp.m(-1399), 'to', pg_temp.m(-1398), 'live_from', pg_temp.m(-1399),
                           'asked_from', pg_temp.m(-1400))],
  '0478/94: a newest minute that alone holds more than the ceiling is refused with a fixed word; with a newer minute in the window, the window is read from that one');
rollback to savepoint row_ceiling;

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
  '0478/95: an organization name of 300 characters comes back as its first 200');
rollback to savepoint long_name;

-- A session far from UTC: the same answer, to the letter, and every time in
-- it is written with +00:00.
set local time zone 'Pacific/Auckland';
select is(public.platform_security_map(pg_temp.m(0), pg_temp.m(120), pg_temp.m(45)), (select d45 from ans),
  '0478/96: in a session whose time zone is not UTC the answer is the same, to the letter');
select is(
  (select array[count(*)::int, count(*) filter (where t !~ '\+00:00$')::int]
     from (select a -> 'window' ->> 'from' as t from ans
           union all select a -> 'window' ->> 'to' from ans
           union all select a -> 'window' ->> 'live_from' from ans
           union all select a -> 'window' ->> 'asked_from' from ans
           union all select a ->> 'generated_at' from ans
           union all select a ->> 'oldest_event_at' from ans
           union all select d45 ->> 'day_start' from ans
           union all select e ->> 'bucket_start' from ans, jsonb_array_elements(ans.a -> 'timeline') e
           union all select e ->> 'minute' from ans, jsonb_array_elements(ans.a -> 'feed') e
           union all select e ->> 'minute' from ans, jsonb_array_elements(ans.a -> 'flagged_feed') e) x),
  array[59, 0],
  '0478/97: every time in the answer (the window read and asked for, when it was made, the oldest minute, the day start, 18 buckets, 25 minutes of the feed and 9 of the flagged feed) is written with +00:00');
reset time zone;

-- ── 11. The made-up record the console's own test of the lists reads ────────
-- (CONTRACT.md, "The shared fixture".) Window m(-300) to m(-270), thirty
-- minutes (a whole window, not a poll). Organizations A, B, C and four more,
-- D to G.
savepoint shared_fixture;
insert into public.organizations (id, name, slug, mfa_policy)
select ('a0478000-0000-0000-0000-0000000002' || lpad(g::text, 2, '0'))::uuid, 'Example Map Shared ' || g,
       'a0478000-example-map-shared-' || g, 'optional'
  from generate_series(1, 4) g;
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
select pg_temp.ev(-295, 'password_guessing', 'flagged', 'unrecorded_server_form_password', 'api', null, null, null, 25);
select pg_temp.ev(-295, 'password_guessing', 'flagged', 'unrecorded_server_form_code', 'api', null, null, null, 4);
select pg_temp.ev(-295, 'password_guessing', 'blocked', 'auth_log_over_cap', 'api', null, null, null, 9);
select pg_temp.ev(-292, 'phishing', 'flagged', 'sign_in_new_country', 'web', o, 'NO', 'Example Fjord', 1)
  from unnest(array[:orgA, :orgB, :orgC]::uuid[]
              || array(select ('a0478000-0000-0000-0000-0000000002' || lpad(g::text, 2, '0'))::uuid
                         from generate_series(1, 4) g)) o;
select is(
  (select array[(a ->> 'blocked_window')::int, (a ->> 'flagged_window')::int, (a ->> 'allowed_window')::int,
                (a -> 'totals' -> 'phishing' ->> 'flagged')::int, (a -> 'totals' -> 'password_guessing' ->> 'flagged')::int,
                (a -> 'totals' -> 'password_guessing' ->> 'blocked')::int, (a -> 'totals' -> 'bots' ->> 'blocked')::int,
                (a -> 'no_place' -> 'bots' ->> 'blocked')::int, (a -> 'no_place' -> 'password_guessing' ->> 'blocked')::int]::text
          || ' ' || array_to_string(pg_temp.country_lines(a), ' ')
          || ' ' || array_to_string(pg_temp.reason_lines(a -> 'tallies'), ' ')
          || ' ' || array_to_string(pg_temp.reason_lines(a -> 'flood_rows'), ' ')
          || ' ' || array_to_string(pg_temp.late_lines(a), ' ')
          || ' ' || (a -> 'floors')::text
     from (select public.platform_security_map(pg_temp.m(-300), pg_temp.m(-270), null) as a) x),
  '{50,9,0,5,4,14,36,36,9} US|password_guessing|blocked|5 GB|password_guessing|flagged|4 IT|phishing|flagged|2 NO|phishing|flagged|2 PT|phishing|flagged|1'
  ' too_many_forms_to_count|api|password_guessing|flagged|400|1 unrecorded_server_form_code|api|password_guessing|flagged|4|1'
  ' unrecorded_server_form_password|api|password_guessing|flagged|25|1'
  ' auth_log_over_cap|api|password_guessing|blocked|9|1 over_buffer_cap|web|bots|blocked|6|1 over_minute_cap|web|bots|blocked|30|1'
  ' api|password_guessing|blocked|9'
  ' ["flagged_window", "totals.password_guessing.flagged", "totals.phishing.flagged"]',
  '0478/98: the shared fixture: three reasons folded (1 of three rows, 2 of 2 and 1, 4 of 4 and 4, and 7 rows of 1 at least 2: flagged 9, where the rows'' sum would be 21), an ordinary reason summed (3 + 2 = 5), the three tallies in no total (flagged 9, never 438), the three reasons past a cap counted with no place (36 and 9), the late line, and the floors');
rollback to savepoint shared_fixture;

-- After the savepoints the record is as the fixtures left it.
select is(
  public.platform_security_map(pg_temp.m(0), pg_temp.m(120), null),
  (select a from ans),
  '0478/99: every savepoint above put the record back: the answer is the one read at the start');

select * from finish();
rollback;
