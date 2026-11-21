-- supabase/tests/0472_security_events.test.sql
-- Proves migration 0472: public.security_events, its writer
-- record_security_events(jsonb), its retention purge_security_events() and the
-- two read functions for an organization's admins and owners.
--
-- WHAT IS WORTH PINNING
--   1. Shape: exactly the designed columns, none that could hold an address,
--      an email or an account; every CHECK refuses a bad row even when the
--      table's owner writes it; the cascade from organizations, by behaviour.
--   2. Who reads: no API role reads the table directly. An organization's
--      owner and admin read their organization's rows through the read
--      functions; a manager, another organization's owner and a signed-out
--      caller are refused; a row with no organization is returned to nobody.
--      No function returns source_hash or the row key.
--   3. Who writes: no API role but through the two functions. service_role
--      itself cannot insert, update or delete; authenticated and anon cannot
--      call the writer or the purge.
--   4. The writer: skips an element whose required fields are not valid
--      strings, clears or defaults an optional field that fails its rule
--      (the usual shapes of an address, an email, an id, a path or a user
--      agent sent as a city are not stored), folds repeats into one row, marks repeats from one
--      source, applies the two minute caps, and takes a time only from the
--      last 26 hours.
--   5. Retention: rows older than 90 days go; a hash older than 24 hours is
--      cleared with its row key and the row stays.
--
-- now() is fixed for the whole transaction and the writer uses it, so every
-- minute below is computed from now() and no assertion depends on the clock.
-- Namespace a0472000. Every value is made up. Wrapped in begin/rollback:
-- nothing leaks. Run via `supabase test db` after `supabase db reset`.

begin;

select plan(108);

\set orgA '\'a0472000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0472000-0000-0000-0000-0000000000b1\''
\set ownerA '\'a0472000-0000-0000-0000-0000000000c1\''
\set adminA '\'a0472000-0000-0000-0000-0000000000c2\''
\set managerA '\'a0472000-0000-0000-0000-0000000000c3\''
\set ownerB '\'a0472000-0000-0000-0000-0000000000c4\''
\set orgC '\'a0472000-0000-0000-0000-0000000000d1\''
\set ownerC '\'a0472000-0000-0000-0000-0000000000c5\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,   'a-owner-events@test.local',   '{}'::jsonb),
  (:adminA,   'a-admin-events@test.local',   '{}'::jsonb),
  (:managerA, 'a-manager-events@test.local', '{}'::jsonb),
  (:ownerB,   'b-owner-events@test.local',   '{}'::jsonb),
  (:ownerC,   'c-owner-events@test.local',   '{}'::jsonb);
-- A and B do not ask for an authenticator, so sections 1 to 9 read with a
-- password-only session; C asks its owners and admins for one (section 10).
insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Events Org A', 'a0472000-org-a', 'optional'),
  (:orgB, 'Events Org B', 'a0472000-org-b', 'optional'),
  (:orgC, 'Events Org C', 'a0472000-org-c', 'admins_required');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :ownerA,   'owner',   now()),
  (:orgA, :adminA,   'admin',   now()),
  (:orgA, :managerA, 'manager', now()),
  (:orgB, :ownerB,   'owner',   now()),
  (:orgC, :ownerC,   'owner',   now());

-- Times, in milliseconds, readable by every role below (floor keeps each in
-- its own minute).
select set_config('t.m2',  (floor(extract(epoch from now() - interval '2 hours') * 1000))::bigint::text, true);
select set_config('t.m2a', (floor(extract(epoch from now() - interval '2 hours 10 minutes') * 1000))::bigint::text, true);
select set_config('t.m2b', (floor(extract(epoch from now() - interval '2 hours 11 minutes') * 1000))::bigint::text, true);
select set_config('t.m5',  (floor(extract(epoch from now() - interval '5 hours') * 1000))::bigint::text, true);
select set_config('t.m7',  (floor(extract(epoch from now() - interval '7 hours') * 1000))::bigint::text, true);
select set_config('t.h25', (floor(extract(epoch from now() - interval '25 hours') * 1000))::bigint::text, true);
select set_config('t.h27', (floor(extract(epoch from now() - interval '27 hours') * 1000))::bigint::text, true);
select set_config('t.s30', (floor(extract(epoch from now() + interval '30 seconds') * 1000))::bigint::text, true);
select set_config('t.f2',  (floor(extract(epoch from now() + interval '2 hours') * 1000))::bigint::text, true);

-- A direct insert as the table's owner, for the CHECK constraints.
create function pg_temp.raw_insert(p jsonb) returns void language sql as $$
  insert into public.security_events
    (minute, category, outcome, reason, source, country, city, source_hash, event_count, dedupe_key)
  values
    (coalesce((p ->> 'minute')::timestamptz, date_trunc('minute', now(), 'UTC')),
     coalesce(p ->> 'category', 'bots'), coalesce(p ->> 'outcome', 'blocked'),
     coalesce(p ->> 'reason', 'raw'), coalesce(p ->> 'source', 'web'),
     p ->> 'country', p ->> 'city', p ->> 'source_hash',
     coalesce((p ->> 'event_count')::integer, 1),
     coalesce(p ->> 'dedupe_key', md5(random()::text)));
$$;

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select has_table('public', 'security_events', '0472/1: table exists');
select columns_are('public', 'security_events',
  array['id', 'minute', 'category', 'outcome', 'reason', 'source', 'organization_id',
        'country', 'city', 'source_hash', 'event_count', 'last_seen_at', 'dedupe_key'],
  '0472/2: exactly the designed columns, none for an address, an email or an account');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.security_events'::regclass and contype = 'f'
      and confrelid = 'public.organizations'::regclass),
  'c',
  '0472/3: organization_id cascades from organizations');
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'security_events'),
  '0472/4: RLS is enabled');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'security_events'),
  0,
  '0472/5: there is no policy');
select has_index('public', 'security_events', 'security_events_organization_minute_idx',
  '0472/6: an organization''s rows are indexed by minute');
select has_index('public', 'security_events', 'security_events_source_hash_minute_idx',
  '0472/7: rows are indexed by source');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid = 'public.security_events'::regclass and contype = 'c'),
  array['security_events_category', 'security_events_city', 'security_events_count_positive',
        'security_events_country', 'security_events_dedupe_key',
        'security_events_minute_is_a_minute', 'security_events_outcome',
        'security_events_reason', 'security_events_source', 'security_events_source_hash'],
  '0472/8: the ten CHECK constraints are there by name');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'security_events', 'anon', array[]::text[],
  '0472/9: anon has no table privilege');
select table_privs_are('public', 'security_events', 'authenticated', array[]::text[],
  '0472/10: authenticated has no table privilege');
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'security_events'
      and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0,
  '0472/11: no column of the table is granted to anon, authenticated or PUBLIC');
select table_privs_are('public', 'security_events', 'service_role', array['SELECT'],
  '0472/12: service_role has SELECT only');
select ok(
  not has_function_privilege('anon', 'public.record_security_events(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_security_events(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.record_security_events(jsonb)', 'execute'),
  '0472/13: only service_role may call the writer');
select ok(
  not has_function_privilege('anon', 'public.purge_security_events()', 'execute')
  and not has_function_privilege('authenticated', 'public.purge_security_events()', 'execute')
  and has_function_privilege('service_role', 'public.purge_security_events()', 'execute'),
  '0472/14: only service_role may call the purge');
select ok(
  not has_function_privilege('anon', 'public.security_events_for_organization(uuid, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.security_events_for_organization(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.security_event_totals_for_organization(uuid, timestamptz, timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.security_event_totals_for_organization(uuid, timestamptz, timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'public.security_events_for_organization(uuid, integer)', 'execute')
  and not has_function_privilege('service_role', 'public.security_event_totals_for_organization(uuid, timestamptz, timestamptz)', 'execute'),
  '0472/15: authenticated may call the two read functions; anon and service_role neither');
select is(
  (select array_agg(p.proname || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ',')
                    order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_security_events', 'purge_security_events',
                        'security_events_for_organization',
                        'security_event_totals_for_organization',
                        'security_events_reader_check')),
  array['purge_security_events:true:search_path="",lock_timeout=2s',
        'record_security_events:true:search_path="",lock_timeout=2s',
        'security_event_totals_for_organization:true:search_path=""',
        'security_events_for_organization:true:search_path=""',
        'security_events_reader_check:true:search_path=""'],
  '0472/16: the five functions are SECURITY DEFINER with an empty search_path; the writer and the purge give up a lock wait after 2 s');

-- ── 3. The table's own checks, written to as its owner ──────────────────────
select lives_ok($$ select pg_temp.raw_insert('{}') $$, '0472/17: a well-formed row is accepted');
delete from public.security_events where reason = 'raw';
select throws_ok($$ select pg_temp.raw_insert(jsonb_build_object('minute', date_trunc('minute', now(), 'UTC') + interval '7 seconds')) $$,
  '23514', null, '0472/18: a minute that is not the start of a minute is refused');
select throws_ok($$ select pg_temp.raw_insert('{"category": "weather"}') $$,
  '23514', null, '0472/19: an unknown category is refused');
select throws_ok($$ select pg_temp.raw_insert('{"outcome": "stopped"}') $$,
  '23514', null, '0472/20: an unknown outcome is refused');
select throws_ok($$ select pg_temp.raw_insert('{"reason": "Has Spaces"}') $$,
  '23514', null, '0472/21: a reason that is not a short code is refused');
select throws_ok($$ select pg_temp.raw_insert('{"source": "fax"}') $$,
  '23514', null, '0472/22: an unknown source is refused');
select throws_ok($$ select pg_temp.raw_insert('{"country": "usa"}') $$,
  '23514', null, '0472/23: a country that is not two capital letters is refused');
select throws_ok($$ select pg_temp.raw_insert('{"city": "someone@example.test"}') $$,
  '23514', null, '0472/24: an email as a city is refused');
select throws_ok($$ select pg_temp.raw_insert('{"city": "203.0.113.9"}') $$,
  '23514', null, '0472/25: an address as a city is refused');
select throws_ok($$ select pg_temp.raw_insert('{"event_count": 0}') $$,
  '23514', null, '0472/26: a count below one is refused');
select throws_ok($$ select pg_temp.raw_insert('{"source_hash": "203.0.113.9"}') $$,
  '23514', null, '0472/27: a source_hash that is not 32 hex is refused');
select throws_ok($$ select pg_temp.raw_insert('{"dedupe_key": "short"}') $$,
  '23514', null, '0472/28: a row key that is not 32 hex is refused');

-- ── 4. The writer, as the app calls it ──────────────────────────────────────
set local role service_role;

select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1',
      'country', 'US', 'city', 'Fresno', 'source_hash', repeat('a', 32)),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked',
      'reason', 'env_file', 'source', 'web', 'country', 'NL', 'city', 'Amsterdam'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'public_order_paused', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000b1', 'count', 7))),
  3,
  '0472/29: three well-formed events are stored');

select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1',
      'country', 'US', 'city', 'Fresno', 'source_hash', repeat('a', 32), 'count', 2))),
  1,
  '0472/30: a repeat of the same kind in the same minute is stored');
reset role;

select results_eq(
  $$ select reason, event_count, minute, last_seen_at from public.security_events
      where organization_id = 'a0472000-0000-0000-0000-0000000000a1' $$,
  $$ values ('wrong_password'::text, 3, date_trunc('minute', now(), 'UTC'), now()) $$,
  '0472/31: the repeat added to the row''s count, with no second row, in this minute');

-- Malformed elements: skipped, never raised.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    'a string'::text,
    42,
    jsonb_build_object('category', 'weather', 'outcome', 'blocked', 'reason', 'x', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'stopped', 'reason', 'x', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'Has Spaces', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'x', 'source', 'fax'),
    jsonb_build_object('outcome', 'blocked', 'reason', 'x', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', true, 'source', 'web'),
    jsonb_build_object('category', null, 'outcome', 'blocked', 'reason', 'x', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'x',
      'source', jsonb_build_array('web')))),
  0,
  '0472/32: an element whose required fields are missing, unknown or not strings is skipped');
select is(public.record_security_events('{"category": "bots"}'::jsonb), 0,
  '0472/33: an input that is not an array stores nothing');
select is(public.record_security_events(null), 0, '0472/34: a null input stores nothing');

-- A field that fails its rule is cleared or defaulted; the event is stored.
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked',
      'reason', 'git_dir', 'source', 'api',
      'organization_id', 'not-a-uuid',
      'country', 'usa', 'city', repeat('x', 81), 'source_hash', '203.0.113.9',
      'count', '0', 'at_ms', 'yesterday'))),
  1,
  '0472/35: an event with unusable optional fields is still stored');
reset role;
select results_eq(
  $$ select organization_id is null, country is null, city is null, source_hash is null,
            event_count, minute
       from public.security_events where reason = 'git_dir' $$,
  $$ values (true, true, true, true, 1, date_trunc('minute', now(), 'UTC')) $$,
  '0472/36: its organization, country, city and hash are empty, its count is 1 and its time is now');

-- What must never be stored as a city.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_address', 'source', 'web', 'city', '203.0.113.9'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_address6', 'source', 'web', 'city', '2001:db8::1'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_email', 'source', 'web', 'city', 'someone@example.test'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_id', 'source', 'web', 'city', 'a0472000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_hexid', 'source', 'web', 'city', 'abcdefab-abcd-abcd-abcd-abcdefabcdef'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_path', 'source', 'web', 'city', '/wp-admin/setup.php'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_agent', 'source', 'web', 'city', 'curl/8.4.0'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_markup', 'source', 'web', 'city', '<b>Fresno</b>'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_newline', 'source', 'web', 'city', 'Ber' || chr(10) || 'lin'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_hidden', 'source', 'web', 'city', 'Fres' || chr(8238) || 'no'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_spaces', 'source', 'web', 'city', '   '),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_object', 'source', 'web', 'city', jsonb_build_object('name', 'Fresno')),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'city_number', 'source', 'web', 'city', 12))),
  13,
  '0472/37: events whose city is an address, an email, an id, a path, a user agent, markup, hidden characters or not a string are stored');
reset role;
select is(
  (select count(*)::int from public.security_events where reason like 'city\_%' and city is null),
  13,
  '0472/38: each with no city');

set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'place_a', 'source', 'web', 'country', 'CA', 'city', 'St. John''s'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'place_b', 'source', 'web', 'country', 'FR', 'city', 'Saint-Denis'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'place_c', 'source', 'web', 'country', 'EG', 'city', '6th of October City'),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'place_d', 'source', 'web', 'country', 'BR', 'city', '  São Paulo '),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'place_e', 'source', 'web', 'country', 'de', 'city', repeat('y', 80)))),
  5,
  '0472/39: events with real place names are stored');
reset role;
select results_eq(
  $$ select reason, country, city from public.security_events where reason like 'place\_%' order by reason $$,
  $$ values ('place_a'::text, 'CA'::text, 'St. John''s'::text),
            ('place_b', 'FR', 'Saint-Denis'),
            ('place_c', 'EG', '6th of October City'),
            ('place_d', 'BR', 'São Paulo'),
            ('place_e', null, repeat('y', 80)) $$,
  '0472/40: with their names kept and trimmed, 80 characters accepted, and a lower-case country left empty');

-- The organization: one that does not exist is left empty; capitals are read.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked',
      'reason', 'wordpress', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-00000000dead'),
    jsonb_build_object('category', 'bots', 'outcome', 'flagged',
      'reason', 'upper_org', 'source', 'phone',
      'organization_id', 'A0472000-0000-0000-0000-0000000000A1'))),
  2,
  '0472/41: events naming an organization that does not exist, and one in capitals, are stored');
reset role;
select results_eq(
  $$ select reason, organization_id from public.security_events
      where reason in ('wordpress', 'upper_org') order by reason $$,
  $$ values ('upper_org'::text, 'a0472000-0000-0000-0000-0000000000a1'::uuid),
            ('wordpress', null) $$,
  '0472/42: the unknown organization is empty; the one in capitals is found');

-- The count.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'count_big', 'source', 'web', 'count', 1000000),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'count_part', 'source', 'web', 'count', 2.5),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'count_minus', 'source', 'web', 'count', -3),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'count_most', 'source', 'web', 'count', 999999),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'count_text', 'source', 'web', 'count', '12'))),
  5,
  '0472/43: events with every kind of count are stored');
reset role;
select results_eq(
  $$ select reason, event_count from public.security_events where reason like 'count\_%' order by reason $$,
  $$ values ('count_big'::text, 1), ('count_minus', 1), ('count_most', 999999),
            ('count_part', 1), ('count_text', 12) $$,
  '0472/44: a count over six digits, a fraction and a negative become 1; 999999 and digits in a string are kept');

-- The time: taken from the last 26 hours and at most a minute ahead.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged', 'reason', 'time_h25', 'source', 'email',
      'at_ms', current_setting('t.h25')::bigint),
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged', 'reason', 'time_h27', 'source', 'email',
      'at_ms', current_setting('t.h27')::bigint),
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged', 'reason', 'time_s30', 'source', 'email',
      'at_ms', current_setting('t.s30')::bigint),
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged', 'reason', 'time_f2', 'source', 'email',
      'at_ms', current_setting('t.f2')::bigint))),
  4,
  '0472/45: events carrying a time are stored');
reset role;
select results_eq(
  $$ select reason, minute from public.security_events where reason like 'time\_%' order by reason $$,
  $$ values ('time_f2'::text,  date_trunc('minute', now(), 'UTC')),
            ('time_h25', date_trunc('minute', now() - interval '25 hours', 'UTC')),
            ('time_h27', date_trunc('minute', now(), 'UTC')),
            ('time_s30', date_trunc('minute', now() + interval '30 seconds', 'UTC')) $$,
  '0472/46: 25 hours ago and 30 seconds ahead are kept; 27 hours ago and 2 hours ahead are stored as now');
select ok(
  (select bool_and(minute = date_trunc('minute', minute, 'UTC')) from public.security_events),
  '0472/47: every row sits on the start of a minute');

-- At most 200 elements of one call are read.
set local role service_role;
select is(
  public.record_security_events((
    select jsonb_agg(jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'many_' || g, 'source', 'web', 'at_ms', current_setting('t.m7')::bigint))
      from generate_series(1, 201) g)),
  200, '0472/48: of 201 elements in one call, 200 are stored');
reset role;
select results_eq(
  $$ select count(*)::int, (count(*) filter (where reason = 'over_minute_cap'))::int
       from public.security_events
      where minute = date_trunc('minute', now() - interval '7 hours', 'UTC') $$,
  $$ values (200, 0) $$,
  '0472/49: as 200 rows, the 201st not read at all');

-- ── 5. Repeats from one source ──────────────────────────────────────────────
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web', 'source_hash', repeat('b', 32), 'count', 4,
      'at_ms', current_setting('t.m2')::bigint))),
  1, '0472/50: four wrong passwords from one source are stored');
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web', 'source_hash', repeat('b', 32),
      'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_code', 'source', 'web', 'source_hash', repeat('b', 32),
      'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web',
      'at_ms', current_setting('t.m2')::bigint))),
  3, '0472/51: a fifth, a wrong code from the same source, and one with no source are stored');
reset role;
select results_eq(
  $$ select reason, event_count from public.security_events
      where source_hash = repeat('b', 32) order by reason $$,
  $$ values ('repeated_wrong_code'::text, 1), ('repeated_wrong_password'::text, 1),
            ('wrong_password'::text, 4) $$,
  '0472/52: the fifth password and the code after it are stored as repeats');
select is(
  (select count(*)::int from public.security_events
    where reason = 'wrong_password' and source_hash is null
      and minute = date_trunc('minute', now() - interval '2 hours', 'UTC')),
  1,
  '0472/53: a wrong password with no source is never a repeat');

-- Only password events count, and only wrong passwords and codes are renamed.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'env_probe', 'source', 'web',
      'source_hash', repeat('c', 32), 'count', 4, 'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('c', 32), 'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'sign_in_paused', 'source', 'web',
      'source_hash', repeat('d', 32), 'count', 9, 'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('d', 32), 'at_ms', current_setting('t.m2')::bigint))),
  4, '0472/54: events of another category and of another password reason are stored');
reset role;
select results_eq(
  $$ select source_hash, reason from public.security_events
      where source_hash in (repeat('c', 32), repeat('d', 32)) order by source_hash, reason $$,
  $$ values (repeat('c', 32), 'env_probe'::text), (repeat('c', 32), 'wrong_password'),
            (repeat('d', 32), 'repeated_wrong_password'), (repeat('d', 32), 'sign_in_paused') $$,
  '0472/55: another category from the source does not make a repeat; a paused sign-in counts toward one and keeps its own name');

-- The ten minutes include the tenth; the eleventh is outside.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('e', 32), 'count', 4, 'at_ms', current_setting('t.m2a')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('e', 32), 'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('f', 32), 'count', 4, 'at_ms', current_setting('t.m2b')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('f', 32), 'at_ms', current_setting('t.m2')::bigint),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked', 'reason', 'wrong_password', 'source', 'web',
      'source_hash', repeat('9', 32), 'count', 5, 'at_ms', current_setting('t.m2')::bigint))),
  5, '0472/56: wrong passwords ten and eleven minutes apart, and five in one element, are stored');
reset role;
select results_eq(
  $$ select source_hash, reason, event_count from public.security_events
      where source_hash in (repeat('e', 32), repeat('f', 32), repeat('9', 32))
        and minute = date_trunc('minute', now() - interval '2 hours', 'UTC')
      order by source_hash $$,
  $$ values (repeat('9', 32), 'repeated_wrong_password'::text, 5),
            (repeat('e', 32), 'repeated_wrong_password', 1),
            (repeat('f', 32), 'wrong_password', 1) $$,
  '0472/57: four ten minutes earlier make the fifth a repeat, four eleven minutes earlier do not, and five counted in one element are a repeat');
select is(
  (select reason from public.security_events where source_hash = repeat('a', 32)),
  'wrong_password',
  '0472/58: three wrong passwords from another source are not repeats');

-- ── 6. The minute caps ──────────────────────────────────────────────────────
-- No organization: 200 rows, the rest on overflow rows.
set local role service_role;
select is(
  public.record_security_events((
    select jsonb_agg(jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'cap_' || g, 'source', 'web', 'at_ms', current_setting('t.m5')::bigint))
      from generate_series(1, 200) g)),
  200, '0472/59: 200 different events with no organization in one minute are stored');
select is(
  public.record_security_events((
    select jsonb_agg(jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'late_' || g, 'source', 'web', 'country', 'US', 'city', 'Fresno',
      'source_hash', repeat('1', 32), 'at_ms', current_setting('t.m5')::bigint))
      from generate_series(1, 30) g)),
  30, '0472/60: 30 more in the same minute are accepted');
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'cap_1', 'source', 'web', 'at_ms', current_setting('t.m5')::bigint))),
  1, '0472/61: an event whose row exists is accepted past the cap');
reset role;
select results_eq(
  $$ select count(*)::int,
            (count(*) filter (where reason like 'late\_%'))::int,
            (sum(event_count) filter (where reason = 'over_minute_cap'))::int,
            (count(*) filter (where reason = 'over_minute_cap' and country is null
                                and city is null and source_hash is null))::int,
            (max(event_count) filter (where reason = 'cap_1'))::int
       from public.security_events
      where minute = date_trunc('minute', now() - interval '5 hours', 'UTC')
        and organization_id is null $$,
  $$ values (201, 0, 30, 1, 2) $$,
  '0472/62: the minute holds its 200 rows and one overflow row counting the other 30 with no place and no hash; the existing row took its repeat');

-- An organization: its own 60 rows, whatever the rows with no organization
-- did to that minute; its overflow rows keep the organization.
set local role service_role;
select is(
  public.record_security_events((
    select jsonb_agg(jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'a_cap_' || g, 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1',
      'at_ms', current_setting('t.m5')::bigint))
      from generate_series(1, 60) g)),
  60, '0472/63: 60 different events of one organization are stored in a minute that is full for rows with no organization');
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'a_late_1', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1', 'country', 'US', 'city', 'Fresno',
      'source_hash', repeat('2', 32), 'at_ms', current_setting('t.m5')::bigint),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'a_late_2', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1', 'at_ms', current_setting('t.m5')::bigint),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'a_late_3', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1', 'at_ms', current_setting('t.m5')::bigint),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'a_late_4', 'source', 'api',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1', 'at_ms', current_setting('t.m5')::bigint),
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked', 'reason', 'a_late_5', 'source', 'api',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1', 'at_ms', current_setting('t.m5')::bigint),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'b_event', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000b1', 'country', 'MX', 'city', 'Tijuana',
      'at_ms', current_setting('t.m5')::bigint))),
  6, '0472/64: five more of that organization and one of another are accepted');
reset role;
select results_eq(
  $$ select category, source, reason, event_count, country is null and city is null and source_hash is null
       from public.security_events
      where minute = date_trunc('minute', now() - interval '5 hours', 'UTC')
        and organization_id = 'a0472000-0000-0000-0000-0000000000a1'
        and reason not like 'a\_cap\_%'
      order by category $$,
  $$ values ('bots'::text, 'web'::text, 'over_minute_cap'::text, 3, true),
            ('exploit', 'api', 'over_minute_cap', 2, true) $$,
  '0472/65: past its 60 rows the organization''s events are counted on overflow rows that keep the organization, one per category and source, with no place and no hash');
select results_eq(
  $$ select reason, country, city from public.security_events
      where organization_id = 'a0472000-0000-0000-0000-0000000000b1'
        and minute = date_trunc('minute', now() - interval '5 hours', 'UTC') $$,
  $$ values ('b_event'::text, 'MX'::text, 'Tijuana'::text) $$,
  '0472/66: another organization''s event in that minute is stored as it came');

-- ── 7. Who writes: no API role but through the functions ────────────────────
set local role service_role;
select throws_ok(
  $$ insert into public.security_events (minute, category, outcome, reason, source, dedupe_key)
       values (date_trunc('minute', now(), 'UTC'), 'bots', 'blocked', 'direct', 'web', repeat('0', 32)) $$,
  '42501', null, '0472/67: service_role cannot insert a row directly');
select throws_ok(
  $$ update public.security_events set event_count = 999 $$,
  '42501', null, '0472/68: service_role cannot update a row directly');
select throws_ok(
  $$ delete from public.security_events $$,
  '42501', null, '0472/69: service_role cannot delete a row directly');
select lives_ok(
  $$ select count(*) from public.security_events $$,
  '0472/70: service_role can read the table');
reset role;

-- ── 8. Who reads ────────────────────────────────────────────────────────────
select set_config('t.n_a', (select count(*) from public.security_events
  where organization_id = 'a0472000-0000-0000-0000-0000000000a1')::text, true);
select set_config('t.n_b', (select count(*) from public.security_events
  where organization_id = 'a0472000-0000-0000-0000-0000000000b1')::text, true);

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select is(
  (select count(*)::text from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 500)),
  current_setting('t.n_a'),
  '0472/71: an owner reads every row of their organization through the read function');
select is(
  (select count(*)::int from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 3)),
  3, '0472/72: the limit is applied');
select is(
  (select count(*)::int from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 0)),
  1, '0472/73: a limit below one reads one row');
select is(
  (select minute from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 1)),
  date_trunc('minute', now(), 'UTC'),
  '0472/74: the newest row comes first');
select throws_ok(
  $$ select * from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000b1', 10) $$,
  '42501', null, '0472/75: an owner cannot read another organization''s rows');
select throws_ok(
  $$ select * from public.security_events_for_organization(null, 10) $$,
  '42501', null, '0472/76: nobody reads the rows with no organization through it');
select is(
  (select events from public.security_event_totals_for_organization('a0472000-0000-0000-0000-0000000000a1', null, null)
    where reason = 'wrong_password' and country = 'US'),
  3::bigint,
  '0472/77: the totals add up an organization''s events by reason and country');
select is(
  (select count(*)::int from public.security_event_totals_for_organization(
     'a0472000-0000-0000-0000-0000000000a1', now() - interval '30 minutes', now() + interval '1 minute')
    where reason = 'over_minute_cap'),
  0, '0472/78: the totals leave out what is before the window');
select is(
  (select sum(events)::int from public.security_event_totals_for_organization(
     'a0472000-0000-0000-0000-0000000000a1', now() - interval '6 hours', null)
    where reason = 'over_minute_cap'),
  5, '0472/79: and count what is inside it');
select throws_ok(
  $$ select * from public.security_event_totals_for_organization('a0472000-0000-0000-0000-0000000000b1', null, null) $$,
  '42501', null, '0472/80: an owner cannot read another organization''s totals');
select throws_ok(
  $$ select count(*) from public.security_events $$,
  '42501', null, '0472/81: an owner cannot read the table directly');
select throws_ok(
  $$ select public.record_security_events('[]'::jsonb) $$,
  '42501', null, '0472/82: an owner cannot call the writer');
select throws_ok(
  $$ select public.purge_security_events() $$,
  '42501', null, '0472/83: an owner cannot call the purge');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select is(
  (select count(*)::text from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 500)),
  current_setting('t.n_a'),
  '0472/84: an admin reads every row of their organization');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c3', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', null, '0472/85: a manager cannot read the rows');
select throws_ok(
  $$ select * from public.security_event_totals_for_organization('a0472000-0000-0000-0000-0000000000a1', null, null) $$,
  '42501', null, '0472/86: a manager cannot read the totals');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c4', 'role', 'authenticated')::text, true);
select is(
  (select count(*)::text from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000b1', 500)),
  current_setting('t.n_b'),
  '0472/87: the other organization''s owner reads that organization''s rows, and only those');
reset role;

set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select throws_ok(
  $$ select * from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', null, '0472/88: a signed-out caller cannot call the read function');
reset role;

select is(
  (select proargnames from pg_proc
    where oid = 'public.security_events_for_organization(uuid, integer)'::regprocedure),
  array['p_organization_id', 'p_limit', 'id', 'minute', 'category', 'outcome', 'reason', 'source',
        'country', 'city', 'event_count', 'last_seen_at'],
  '0472/89: the read function returns neither source_hash nor the row key');

-- ── 9. Retention and the cascade ────────────────────────────────────────────
-- Age three rows as the table's owner: one past 90 days, one just inside, one
-- hashed row past 24 hours.
update public.security_events
   set minute = date_trunc('minute', now() - interval '91 days', 'UTC')
 where reason = 'env_file';
update public.security_events
   set minute = date_trunc('minute', now() - interval '89 days', 'UTC')
 where reason = 'git_dir';
update public.security_events
   set minute = date_trunc('minute', now() - interval '25 hours 30 minutes', 'UTC')
 where source_hash = repeat('a', 32);
set local role service_role;
select is(public.purge_security_events(), '{"deleted": 1, "hashes_cleared": 1}'::jsonb,
  '0472/90: the purge reports one row removed and one hash cleared');
reset role;
delete from public.organizations where id = :orgB;
select results_eq(
  $$ select (select count(*)::int from public.security_events where reason = 'env_file'),
            (select count(*)::int from public.security_events where reason = 'git_dir'),
            (select count(*)::int from public.security_events
              where organization_id = 'a0472000-0000-0000-0000-0000000000a1'
                and reason = 'wrong_password' and source_hash is null
                and dedupe_key = md5(id::text)),
            (select count(*)::int from public.security_events where source_hash = repeat('b', 32)),
            (select count(*)::int from public.security_events
              where organization_id = 'a0472000-0000-0000-0000-0000000000b1'),
            (select (count(*) > 0) from public.security_events
              where organization_id = 'a0472000-0000-0000-0000-0000000000a1') $$,
  $$ values (0, 1, 1, 3, 0, true) $$,
  '0472/91: the row past 90 days is gone and the one at 89 days stays; the hash past 24 hours is cleared with its row key and its row stays; newer hashes stay; a deleted organization''s rows go with it and the other''s stay');

-- ── 10. The reader check, and the rest of what the second review asked for ──
select has_index('public', 'security_events', 'security_events_no_organization_minute_idx',
  '0472/92: rows with no organization are indexed by minute, for their cap');
select ok(
  not has_function_privilege('anon', 'public.security_events_reader_check(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.security_events_reader_check(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.security_events_reader_check(uuid)', 'execute'),
  '0472/93: no API role may call the reader check itself');
select ok(
  (select prosrc like '%pg_catalog.pg_advisory_xact_lock(4720001)%' from pg_proc
    where oid = 'public.record_security_events(jsonb)'::regprocedure)
  and (select prosrc like '%pg_catalog.pg_advisory_xact_lock(4720001)%' from pg_proc
        where oid = 'public.purge_security_events()'::regprocedure),
  '0472/94: the writer and the purge take the same advisory lock');
select ok(
  (select prosrc like '%for key share skip locked%' from pg_proc
    where oid = 'public.record_security_events(jsonb)'::regprocedure),
  '0472/95: the writer does not wait for an organization that is being deleted');
select is(
  (select count(*)::int
     from unnest(array[
            $p$[[:cntrl:]]$p$,
            $p$[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]$p$,
            $p$[@/\\:;<>(){}\[\]=?&%#"|$*+^~`]$p$,
            $p$[0-9].*[0-9].*[0-9].*[0-9]$p$,
            $p$[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-$p$]) as t(pat)
    where position(t.pat in (select prosrc from pg_proc
                              where oid = 'public.record_security_events(jsonb)'::regprocedure)) > 0
      and position(t.pat in (select pg_get_constraintdef(c.oid) from pg_constraint c
                              where c.conrelid = 'public.security_events'::regclass
                                and c.conname = 'security_events_city')) > 0),
  5,
  '0472/96: the five city patterns are the same text in the table''s rule and in the writer');

-- An owner of an organization that asks owners and admins for an
-- authenticator, with none set up.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c5', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000d1', 10) $$,
  '42501', 'mfa_required', '0472/97: where the policy asks for an authenticator, an owner without one cannot read the rows');
select throws_ok(
  $$ select * from public.security_event_totals_for_organization('a0472000-0000-0000-0000-0000000000d1') $$,
  '42501', 'mfa_required', '0472/98: or the totals');
reset role;

-- The same owner and organization A's admin each with a verified authenticator.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), :ownerC, '0472 authenticator c', 'totp', 'verified', now(), now()),
  (gen_random_uuid(), :adminA, '0472 authenticator a', 'totp', 'verified', now(), now());
select set_config('t.n_a2', (select count(*) from public.security_events
  where organization_id = 'a0472000-0000-0000-0000-0000000000a1')::text, true);

set local role authenticated;
select throws_ok(
  $$ select * from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000d1', 10) $$,
  '42501', 'aal2_required', '0472/99: with an authenticator set up, a password-only session cannot read the rows');
select throws_ok(
  $$ select * from public.security_event_totals_for_organization('a0472000-0000-0000-0000-0000000000d1') $$,
  '42501', 'aal2_required', '0472/100: or the totals');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c5', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  (select count(*)::int from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000d1', 10)),
  0, '0472/101: a session that holds the second step reads the rows (none here)');
select lives_ok(
  $$ select * from public.security_event_totals_for_organization('a0472000-0000-0000-0000-0000000000d1') $$,
  '0472/102: and the totals');

-- An admin who has an authenticator, in an organization that does not ask for one.
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'aal2_required', '0472/103: a member who has an authenticator owes the second step whatever the policy');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c2', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  (select count(*)::text from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', 500)),
  current_setting('t.n_a2'),
  '0472/104: and reads once the session holds it');

-- An owner with no authenticator, in an organization that does not ask for one.
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select is(
  (select count(*)::int from public.security_event_totals_for_organization(
     p_organization_id => 'a0472000-0000-0000-0000-0000000000a1')),
  (select count(*)::int from public.security_event_totals_for_organization(
     'a0472000-0000-0000-0000-0000000000a1', null, null)),
  '0472/105: the totals can be asked for with the organization alone');
select is(
  (select count(*)::int from public.security_event_totals_for_organization(
     'a0472000-0000-0000-0000-0000000000a1', now() - interval '6 hours',
     date_trunc('minute', now() - interval '5 hours', 'UTC'))
    where reason = 'over_minute_cap'),
  0, '0472/106: a row at the very end of the window is left out');
select is(
  (select count(*)::int from public.security_events_for_organization('a0472000-0000-0000-0000-0000000000a1', null)),
  least(current_setting('t.n_a2')::int, 100),
  '0472/107: a null limit reads the default 100');
reset role;

select is(
  (select proargnames from pg_proc
    where oid = 'public.security_event_totals_for_organization(uuid, timestamptz, timestamptz)'::regprocedure),
  array['p_organization_id', 'p_from', 'p_to', 'category', 'outcome', 'reason', 'source', 'country', 'events'],
  '0472/108: the totals return counts by category, outcome, reason, source and country, and nothing else');

select * from finish();
rollback;
