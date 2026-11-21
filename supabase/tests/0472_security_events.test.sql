-- supabase/tests/0472_security_events.test.sql
-- Proves migration 0472: public.security_events, its writer
-- record_security_events(jsonb) and its retention purge_security_events().
--
-- WHAT IS WORTH PINNING
--   1. Shape: exactly the columns the design names, none that could hold an
--      address, an email or an account; the checks on each field; the cascade
--      from organizations.
--   2. Who reads: an organization's admin and owner read their organization's
--      rows and nobody else's; a manager, another organization's owner and a
--      signed-out caller read nothing; a row with no organization is read by
--      no member. source_hash and dedupe_key are not readable by any member.
--   3. Who writes: nobody but the two functions. service_role itself cannot
--      insert, update or delete; authenticated and anon cannot call either
--      function.
--   4. The writer: skips a malformed element without raising, clears a field
--      that fails its rule, folds repeats into one row, marks repeats from one
--      source, applies the minute cap, and takes a time only from the last 26
--      hours.
--   5. Retention: rows older than 90 days go; source_hash older than 24 hours
--      is cleared and the row stays.
--
-- Namespace a0472000. Every value is made up. Wrapped in begin/rollback:
-- nothing leaks. Run via `supabase test db` after `supabase db reset`.

begin;

select plan(47);

\set orgA '\'a0472000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0472000-0000-0000-0000-0000000000b1\''
\set ownerA '\'a0472000-0000-0000-0000-0000000000c1\''
\set adminA '\'a0472000-0000-0000-0000-0000000000c2\''
\set managerA '\'a0472000-0000-0000-0000-0000000000c3\''
\set ownerB '\'a0472000-0000-0000-0000-0000000000c4\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,   'a-owner-events@test.local',   '{}'::jsonb),
  (:adminA,   'a-admin-events@test.local',   '{}'::jsonb),
  (:managerA, 'a-manager-events@test.local', '{}'::jsonb),
  (:ownerB,   'b-owner-events@test.local',   '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'Events Org A', 'a0472000-org-a'),
  (:orgB, 'Events Org B', 'a0472000-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :ownerA,   'owner',   now()),
  (:orgA, :adminA,   'admin',   now()),
  (:orgA, :managerA, 'manager', now()),
  (:orgB, :ownerB,   'owner',   now());

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
  (select array_agg(policyname || ':' || cmd order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'security_events'),
  array['security_events_admin_read:SELECT'],
  '0472/5: the only policy is the admin read');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'security_events', 'anon', array[]::text[],
  '0472/6: anon has no table privilege');
select table_privs_are('public', 'security_events', 'authenticated', array[]::text[],
  '0472/7: authenticated has no table-wide privilege (its read is by column)');
select table_privs_are('public', 'security_events', 'service_role', array['SELECT'],
  '0472/8: service_role has SELECT only');
select ok(
  has_column_privilege('authenticated', 'public.security_events', 'minute', 'select')
  and has_column_privilege('authenticated', 'public.security_events', 'category', 'select')
  and has_column_privilege('authenticated', 'public.security_events', 'city', 'select')
  and has_column_privilege('authenticated', 'public.security_events', 'event_count', 'select'),
  '0472/9: authenticated may read the event columns');
select ok(
  not has_column_privilege('authenticated', 'public.security_events', 'source_hash', 'select')
  and not has_column_privilege('authenticated', 'public.security_events', 'dedupe_key', 'select'),
  '0472/10: authenticated may not read source_hash or dedupe_key');
select ok(
  not has_function_privilege('anon', 'public.record_security_events(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_security_events(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.record_security_events(jsonb)', 'execute'),
  '0472/11: only service_role may call the writer');
select ok(
  not has_function_privilege('anon', 'public.purge_security_events()', 'execute')
  and not has_function_privilege('authenticated', 'public.purge_security_events()', 'execute')
  and has_function_privilege('service_role', 'public.purge_security_events()', 'execute'),
  '0472/12: only service_role may call the purge');
select is(
  (select array_agg(p.proname || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ',')
                    order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('record_security_events', 'purge_security_events')),
  array['purge_security_events:true:search_path=""', 'record_security_events:true:search_path=""'],
  '0472/13: both functions are SECURITY DEFINER with an empty search_path');

-- ── 3. The writer, as the app calls it ──────────────────────────────────────
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
  '0472/14: three well-formed events are stored');

select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1',
      'country', 'US', 'city', 'Fresno', 'source_hash', repeat('a', 32), 'count', 2))),
  1,
  '0472/15: a repeat of the same kind in the same minute is stored');

select results_eq(
  $$ select reason, event_count from public.security_events
      where organization_id = 'a0472000-0000-0000-0000-0000000000a1' order by reason $$,
  $$ values ('wrong_password'::text, 3) $$,
  '0472/16: the repeat added to the row''s count, with no second row');

-- Malformed elements: skipped, never raised.
select is(
  public.record_security_events(jsonb_build_array(
    'a string'::text,
    42,
    jsonb_build_object('category', 'weather', 'outcome', 'blocked', 'reason', 'x', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'stopped', 'reason', 'x', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'Has Spaces', 'source', 'web'),
    jsonb_build_object('category', 'bots', 'outcome', 'blocked', 'reason', 'x', 'source', 'fax'),
    jsonb_build_object('outcome', 'blocked', 'reason', 'x', 'source', 'web'))),
  0,
  '0472/17: an element that fails a rule is skipped');
select is(public.record_security_events('{"category": "bots"}'::jsonb), 0,
  '0472/18: an input that is not an array stores nothing');
select is(public.record_security_events(null), 0, '0472/19: a null input stores nothing');

-- A field that fails its rule is cleared; the event is still stored.
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked',
      'reason', 'git_dir', 'source', 'api',
      'organization_id', 'not-a-uuid',
      'country', 'usa', 'city', repeat('x', 81), 'source_hash', '203.0.113.9',
      'count', '0', 'at_ms', 'yesterday'))),
  1,
  '0472/20: an event with unusable optional fields is still stored');
reset role;
select results_eq(
  $$ select organization_id is null, country is null, city is null, source_hash is null, event_count
       from public.security_events where reason = 'git_dir' $$,
  $$ values (true, true, true, true, 1) $$,
  '0472/21: the unusable organization, country, city, hash and count were cleared or defaulted');

set local role service_role;
-- An organization that does not exist: stored with none.
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked',
      'reason', 'wordpress', 'source', 'web',
      'organization_id', 'a0472000-0000-0000-0000-00000000dead'))),
  1,
  '0472/22: an event naming an organization that does not exist is stored');
reset role;
select is(
  (select organization_id from public.security_events where reason = 'wordpress'),
  null::uuid,
  '0472/23: with no organization');

-- A city with a control character is cleared.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'exploit', 'outcome', 'blocked',
      'reason', 'php_file', 'source', 'web', 'country', 'DE',
      'city', 'Ber' || chr(10) || 'lin'))),
  1,
  '0472/24: an event whose city holds a control character is stored');
reset role;
select results_eq(
  $$ select country, city from public.security_events where reason = 'php_file' $$,
  $$ values ('DE'::text, null::text) $$,
  '0472/25: with its country and no city');

-- The time: taken from the last 26 hours, otherwise now.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged',
      'reason', 'recent_report', 'source', 'email',
      'at_ms', (floor(extract(epoch from clock_timestamp() - interval '3 hours') * 1000))::bigint),
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged',
      'reason', 'old_report', 'source', 'email',
      'at_ms', (floor(extract(epoch from clock_timestamp() - interval '3 days') * 1000))::bigint),
    jsonb_build_object('category', 'phishing', 'outcome', 'flagged',
      'reason', 'future_report', 'source', 'email',
      'at_ms', (floor(extract(epoch from clock_timestamp() + interval '2 hours') * 1000))::bigint))),
  3,
  '0472/26: events carrying a time are stored');
reset role;
select ok(
  (select minute between clock_timestamp() - interval '3 hours 2 minutes'
                     and clock_timestamp() - interval '2 hours 58 minutes'
     from public.security_events where reason = 'recent_report'),
  '0472/27: a time three hours ago is kept');
select ok(
  (select bool_and(minute > clock_timestamp() - interval '2 minutes'
                   and minute <= clock_timestamp())
     from public.security_events where reason in ('old_report', 'future_report')),
  '0472/28: a time three days ago or in the future is stored as now');
select ok(
  (select bool_and(minute = date_trunc('minute', minute, 'UTC')) from public.security_events),
  '0472/29: every row sits on the start of a minute');

-- ── 4. Repeats from one source ──────────────────────────────────────────────
-- Source b: four wrong passwords, then a fifth. The fifth is a repeat.
set local role service_role;
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web', 'source_hash', repeat('b', 32), 'count', 4))),
  1, '0472/30: four wrong passwords from one source are stored');
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web', 'source_hash', repeat('b', 32)),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_code', 'source', 'web', 'source_hash', repeat('b', 32)),
    jsonb_build_object('category', 'password_guessing', 'outcome', 'blocked',
      'reason', 'wrong_password', 'source', 'web'))),
  3, '0472/31: a fifth, a wrong code from the same source, and one with no source are stored');
reset role;
select results_eq(
  $$ select reason, event_count from public.security_events
      where source_hash = repeat('b', 32) order by reason $$,
  $$ values ('repeated_wrong_code'::text, 1), ('repeated_wrong_password'::text, 1),
            ('wrong_password'::text, 4) $$,
  '0472/32: the fifth password and the code after it are stored as repeats');
select is(
  (select count(*)::int from public.security_events
    where reason = 'wrong_password' and source_hash is null and organization_id is null),
  1,
  '0472/33: a wrong password with no source is never a repeat');
select is(
  (select reason from public.security_events where source_hash = repeat('a', 32)),
  'wrong_password',
  '0472/34: three wrong passwords from another source are not repeats');

-- ── 5. The minute cap ───────────────────────────────────────────────────────
-- 230 different events in one past minute: 200 rows, the rest on one overflow row.
set local role service_role;
select is(
  public.record_security_events((
    select jsonb_agg(jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'cap_' || g, 'source', 'web',
      'at_ms', (floor(extract(epoch from date_trunc('minute', clock_timestamp() - interval '5 hours')) * 1000))::bigint))
      from generate_series(1, 200) g)),
  200, '0472/35: 200 different events in one minute are stored');
select is(
  public.record_security_events((
    select jsonb_agg(jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'late_' || g, 'source', 'web', 'country', 'US',
      'organization_id', 'a0472000-0000-0000-0000-0000000000a1',
      'at_ms', (floor(extract(epoch from date_trunc('minute', clock_timestamp() - interval '5 hours')) * 1000))::bigint))
      from generate_series(1, 30) g)),
  30, '0472/36: 30 more in the same minute are accepted');
select is(
  public.record_security_events(jsonb_build_array(
    jsonb_build_object('category', 'bots', 'outcome', 'blocked',
      'reason', 'cap_1', 'source', 'web',
      'at_ms', (floor(extract(epoch from date_trunc('minute', clock_timestamp() - interval '5 hours')) * 1000))::bigint))),
  1, '0472/37: an event whose row exists is accepted past the cap');
reset role;
select results_eq(
  $$ select count(*)::int,
            (count(*) filter (where reason like 'late_%'))::int,
            (sum(event_count) filter (where reason = 'over_minute_cap'))::int,
            (count(*) filter (where reason = 'over_minute_cap'
                                and organization_id is null and country is null))::int,
            (max(event_count) filter (where reason = 'cap_1'))::int
       from public.security_events
      where minute = date_trunc('minute', clock_timestamp() - interval '5 hours') $$,
  $$ values (201, 0, 30, 1, 2) $$,
  '0472/38: the minute holds its 200 rows and one overflow row counting the other 30, with no organization or place; the existing row took its repeat');

-- ── 6. Who writes: only the functions ───────────────────────────────────────
set local role service_role;
select throws_ok(
  $$ insert into public.security_events (minute, category, outcome, reason, source, dedupe_key)
       values (date_trunc('minute', now(), 'UTC'), 'bots', 'blocked', 'direct', 'web', repeat('0', 32)) $$,
  '42501', null, '0472/39: service_role cannot insert a row directly');
select throws_ok(
  $$ update public.security_events set event_count = 999 $$,
  '42501', null, '0472/40: service_role cannot update a row directly');
select throws_ok(
  $$ delete from public.security_events $$,
  '42501', null, '0472/41: service_role cannot delete a row directly');
reset role;

-- ── 7. Who reads ────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select distinct organization_id from public.security_events $$,
  $$ values ('a0472000-0000-0000-0000-0000000000a1'::uuid) $$,
  '0472/42: an owner reads only their organization''s rows, never one with no organization');
select throws_ok(
  $$ select source_hash from public.security_events $$,
  '42501', null, '0472/43: an owner cannot read source_hash');
select throws_ok(
  $$ select public.record_security_events('[]'::jsonb) $$,
  '42501', null, '0472/44: an owner cannot call the writer');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select is(
  (select count(distinct organization_id)::int from public.security_events),
  1, '0472/45: an admin reads their organization''s rows');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0472000-0000-0000-0000-0000000000c3', 'role', 'authenticated')::text, true);
select is(
  (select count(id)::int from public.security_events),
  0, '0472/46: a manager reads no row');
reset role;

-- ── 8. Retention ────────────────────────────────────────────────────────────
-- Age two rows as the table owner: one past 90 days, one past 24 hours.
update public.security_events
   set minute = date_trunc('minute', now() - interval '91 days', 'UTC')
 where reason = 'env_file';
update public.security_events
   set minute = date_trunc('minute', now() - interval '25 hours', 'UTC')
 where source_hash = repeat('a', 32);
set local role service_role;
select public.purge_security_events();
reset role;
select results_eq(
  $$ select (select count(*)::int from public.security_events where reason = 'env_file'),
            (select count(*)::int from public.security_events
              where organization_id = 'a0472000-0000-0000-0000-0000000000a1'
                and reason = 'wrong_password' and source_hash is null),
            (select count(*)::int from public.security_events where source_hash = repeat('b', 32)) $$,
  $$ values (0, 1, 3) $$,
  '0472/47: the purge removed the row past 90 days, cleared the hash past 24 hours and kept its row, and left today''s hashes');

select * from finish();
rollback;
