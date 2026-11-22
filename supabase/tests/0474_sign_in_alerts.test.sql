-- supabase/tests/0474_sign_in_alerts.test.sql
-- Proves migration 0474: public.sign_in_alerts and public.user_sign_in_countries,
-- the member's read my_sign_in_alerts(), the organization read
-- sign_in_alerts_for_organization(uuid, integer) and the retention
-- purge_sign_in_alerts().
--
-- WHAT IS WORTH PINNING
--   1. Shape: exactly the designed columns, none for an address, an email or
--      a user agent; the only foreign keys are the two to user_profiles,
--      which cascade (none to an auth table, none on session_id); every CHECK
--      refuses a bad row even when the table's owner writes it, by its own
--      name: the device words take letters, digits, spaces and ( ) + . - only
--      (so no user agent, link or markup), the device row is 40 lower-case
--      hex digits, a new country names its country, an answer and its time
--      go together; the city rule is the same text as security_events_city
--      (0472).
--   2. Privileges: no API role but service_role touches either table, and it
--      has exactly SELECT, INSERT, UPDATE and DELETE; each function has
--      exactly one grant; RLS is on with no policy; a caller without EXECUTE
--      is refused by the grant, by name.
--   3. The member's read: their own alerts of the last 30 days (a row exactly
--      30 days old included), newest first, at most 50, with the device as
--      the member sees it, for every kind of caller; nobody signed in and a
--      disabled account are refused; an account with an authenticator reads
--      only with the second step.
--   4. The organization read, by role: its owner, its admin and a live act-as
--      seat read; a manager, a staff member, another organization's owner,
--      an expired act-as seat, an invitation not accepted, a disabled admin
--      and a signed-out caller are refused. It lists the accepted members (a
--      disabled one included; act-as seats, invitations, outsiders and a
--      member removed left out) for 90 days (a row exactly 90 days old
--      included), with name, email and the device as the organization sees
--      it, and no session id, device row or full label; a member of two
--      organizations is listed in both. The limit is held to 1..500, default
--      100.
--   5. The authenticator rule on the organization read (0472's check).
--   6. The purge: older than 90 days, oldest first, 5,000 a call, the count
--      returned; a row exactly 90 days old stays.
--   7. The cascade from user_profiles, for both tables.
--
-- now() is fixed for the whole transaction and every function uses it, so
-- every time below is computed from now() and no assertion depends on the
-- clock. Namespace a0474000. Every value is made up. Wrapped in
-- begin/rollback: nothing leaks. Run via `supabase test db` after
-- `supabase db reset`.

begin;

select plan(126);

\set orgA '\'a0474000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0474000-0000-0000-0000-0000000000b1\''
\set orgC '\'a0474000-0000-0000-0000-0000000000d1\''
\set ownerA '\'a0474000-0000-0000-0000-0000000000c1\''
\set adminA '\'a0474000-0000-0000-0000-0000000000c2\''
\set managerA '\'a0474000-0000-0000-0000-0000000000c3\''
\set ownerB '\'a0474000-0000-0000-0000-0000000000c4\''
\set ownerC '\'a0474000-0000-0000-0000-0000000000c5\''
\set memberA '\'a0474000-0000-0000-0000-0000000000c6\''
\set twoOrg '\'a0474000-0000-0000-0000-0000000000c7\''
\set actas '\'a0474000-0000-0000-0000-0000000000c8\''
\set actasOld '\'a0474000-0000-0000-0000-0000000000c9\''
\set invited '\'a0474000-0000-0000-0000-0000000000ca\''
\set outsider '\'a0474000-0000-0000-0000-0000000000cb\''
\set busy '\'a0474000-0000-0000-0000-0000000000cc\''
\set disabled '\'a0474000-0000-0000-0000-0000000000cd\''
\set disabledAdmin '\'a0474000-0000-0000-0000-0000000000ce\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,        'a-owner-alerts@test.local',          '{"full_name": "Alert Owner A"}'::jsonb),
  (:adminA,        'a-admin-alerts@test.local',          '{"full_name": "Alert Admin A"}'::jsonb),
  (:managerA,      'a-manager-alerts@test.local',        '{"full_name": "Alert Manager A"}'::jsonb),
  (:ownerB,        'b-owner-alerts@test.local',          '{"full_name": "Alert Owner B"}'::jsonb),
  (:ownerC,        'c-owner-alerts@test.local',          '{"full_name": "Alert Owner C"}'::jsonb),
  (:memberA,       'a-member-alerts@test.local',         '{"full_name": "Alert Member A"}'::jsonb),
  (:twoOrg,        'ab-member-alerts@test.local',        '{"full_name": "Alert Member AB"}'::jsonb),
  (:actas,         'act-as-alerts@test.local',           '{"full_name": "Alert Act As"}'::jsonb),
  (:actasOld,      'act-as-old-alerts@test.local',       '{"full_name": "Alert Act As Old"}'::jsonb),
  (:invited,       'invited-alerts@test.local',          '{"full_name": "Alert Invited"}'::jsonb),
  (:outsider,      'outsider-alerts@test.local',         '{"full_name": "Alert Outsider"}'::jsonb),
  (:busy,          'b-busy-alerts@test.local',           '{"full_name": "Alert Busy B"}'::jsonb),
  (:disabled,      'a-disabled-alerts@test.local',       '{}'::jsonb),
  (:disabledAdmin, 'a-disabled-admin-alerts@test.local', '{"full_name": "Alert Disabled Admin A"}'::jsonb);
update public.user_profiles set disabled_at = now() where id in (:disabled, :disabledAdmin);

-- A and B do not ask for an authenticator, so the sections before 8 read
-- with a password-only session; C asks its owners and admins for one.
insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Alerts Org A', 'a0474000-org-a', 'optional'),
  (:orgB, 'Alerts Org B', 'a0474000-org-b', 'optional'),
  (:orgC, 'Alerts Org C', 'a0474000-org-c', 'admins_required');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :ownerA,        'owner',   now(), null),
  (:orgA, :adminA,        'admin',   now(), null),
  (:orgA, :managerA,      'manager', now(), null),
  (:orgA, :memberA,       'staff',   now(), null),
  (:orgA, :twoOrg,        'staff',   now(), null),
  (:orgA, :disabled,      'staff',   now(), null),
  (:orgA, :disabledAdmin, 'admin',   now(), null),
  -- A live act-as seat and one that has expired.
  (:orgA, :actas,         'owner',   now(), now() + interval '1 hour'),
  (:orgA, :actasOld,      'owner',   now(), now() - interval '1 hour'),
  -- An invitation not accepted.
  (:orgA, :invited,       'admin',   null,  null),
  (:orgB, :ownerB,        'owner',   now(), null),
  (:orgB, :twoOrg,        'staff',   now(), null),
  (:orgB, :busy,          'staff',   now(), null),
  (:orgC, :ownerC,        'owner',   now(), null);

-- A direct insert as the table's owner, for the CHECK constraints. Every
-- field has a valid default, so a refusal names the field under test.
create function pg_temp.alert(p jsonb) returns void language sql as $$
  insert into public.sign_in_alerts
    (user_id, session_id, new_device, new_country, client, device_label, device_family,
     device_hash, country, city, status, resolved_at)
  values
    (coalesce((p ->> 'user_id')::uuid, 'a0474000-0000-0000-0000-0000000000cb'),
     (p ->> 'session_id')::uuid,
     coalesce((p ->> 'new_device')::boolean, true),
     coalesce((p ->> 'new_country')::boolean, false),
     coalesce(p ->> 'client', 'web'),
     coalesce(p ->> 'device_label', 'Chrome on macOS'),
     coalesce(p ->> 'device_family', 'Chrome on macOS'),
     p ->> 'device_hash', p ->> 'country', p ->> 'city',
     coalesce(p ->> 'status', 'open'),
     case when p ? 'resolved' then now() end);
$$;

-- Tries the insert and undoes it: 'accepted', or the SQLSTATE and the name of
-- the constraint that refused it.
create function pg_temp.try_alert(p jsonb) returns text language plpgsql as $$
declare
  v_c text;
begin
  begin
    perform pg_temp.alert(p);
    raise exception 'accepted' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_c = constraint_name;
    if sqlstate = 'P0001' and sqlerrm = 'accepted' then
      return 'accepted';
    end if;
    return sqlstate || coalesce(':' || nullif(v_c, ''), '');
  end;
end;
$$;

create function pg_temp.try_country(p_user uuid, p_country text) returns text language plpgsql as $$
declare
  v_c text;
begin
  begin
    insert into public.user_sign_in_countries (user_id, country) values (p_user, p_country);
    raise exception 'accepted' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_c = constraint_name;
    if sqlstate = 'P0001' and sqlerrm = 'accepted' then
      return 'accepted';
    end if;
    return sqlstate || coalesce(':' || nullif(v_c, ''), '');
  end;
end;
$$;

-- Every grant on a function other than its owner's, as role:privilege.
create function pg_temp.grants_of(p regprocedure) returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type), '{}'::text[])
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
   where pr.oid = p and x.grantee <> pr.proowner;
$$;

-- Words the device rules must refuse: empty, too long, a control or invisible
-- character, a user agent, a link with its scheme, markup, and the characters a sentence, a
-- path or a name in another script needs.
create function pg_temp.bad_words() returns text[] language sql as $$ select array[
  '',
  repeat('d', 121),
  'Chrome' || chr(10) || 'on macOS',
  'Chrome' || chr(9) || 'on macOS',
  'Chrome on macOS' || chr(127),
  'Chrome on ' || chr(8238) || 'SOcam',
  'Chrome' || chr(8203) || ' on macOS',
  'Chrome on macOS' || chr(65279),
  chr(8294) || 'Chrome on macOS',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'curl/8.4.0',
  'Call 555 0100 https://example.test/reset',
  '<b>x</b>',
  'Chrome, on macOS',
  'Chrome on someone''s Mac',
  'Chrome_on_macOS',
  'Chrome on ' || chr(233) || 'cran'] $$;

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select has_table('public', 'sign_in_alerts', '0474/1: sign_in_alerts exists');
select has_table('public', 'user_sign_in_countries', '0474/2: user_sign_in_countries exists');
select columns_are('public', 'sign_in_alerts',
  array['id', 'user_id', 'session_id', 'new_device', 'new_country', 'client', 'device_label',
        'device_family', 'device_hash', 'country', 'city', 'status', 'resolved_at', 'created_at'],
  '0474/3: sign_in_alerts has exactly the designed columns, none for an address, an email or a user agent');
select columns_are('public', 'user_sign_in_countries',
  array['user_id', 'country', 'first_seen_at', 'last_seen_at'],
  '0474/4: user_sign_in_countries has exactly the designed columns');
select is(
  (select array_agg(c.conrelid::regclass::text || '.' || a.attname || '>' || c.confrelid::regclass::text
                    || '(' || r.attname || '):' || c.confdeltype::text
                    order by c.conrelid::regclass::text)
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     join pg_attribute r on r.attrelid = c.confrelid and r.attnum = c.confkey[1]
    where c.contype = 'f'
      and c.conrelid in ('public.sign_in_alerts'::regclass, 'public.user_sign_in_countries'::regclass)),
  array['sign_in_alerts.user_id>user_profiles(id):c', 'user_sign_in_countries.user_id>user_profiles(id):c'],
  '0474/5: the only foreign keys are user_id to user_profiles(id), cascading, one on each table (none on session_id or device_hash)');
select is(
  (select count(*)::int from pg_constraint c
    where c.contype = 'f'
      and c.conrelid in ('public.sign_in_alerts'::regclass, 'public.user_sign_in_countries'::regclass)
      and c.confrelid in (select k.oid from pg_class k where k.relnamespace = 'auth'::regnamespace)),
  0,
  '0474/6: no foreign key points at a table in the auth schema');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.sign_in_alerts'::regclass, 'public.user_sign_in_countries'::regclass)),
  '0474/7: RLS is enabled on both tables');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('sign_in_alerts', 'user_sign_in_countries')),
  0,
  '0474/8: there is no policy on either table');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text)
     from pg_index i where i.indrelid = 'public.sign_in_alerts'::regclass),
  array['CREATE INDEX sign_in_alerts_created_idx ON public.sign_in_alerts USING btree (created_at)',
        'CREATE UNIQUE INDEX sign_in_alerts_pkey ON public.sign_in_alerts USING btree (id)',
        'CREATE INDEX sign_in_alerts_session_idx ON public.sign_in_alerts USING btree (session_id) WHERE (session_id IS NOT NULL)',
        'CREATE INDEX sign_in_alerts_user_created_idx ON public.sign_in_alerts USING btree (user_id, created_at DESC)'],
  '0474/9: sign_in_alerts is indexed by id, by account and time, by session (when known) and by time');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text)
     from pg_index i where i.indrelid = 'public.user_sign_in_countries'::regclass),
  array['CREATE UNIQUE INDEX user_sign_in_countries_pkey ON public.user_sign_in_countries USING btree (user_id, country)'],
  '0474/10: user_sign_in_countries is keyed by account and country');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid = 'public.sign_in_alerts'::regclass and contype = 'c'),
  array['sign_in_alerts_city', 'sign_in_alerts_client', 'sign_in_alerts_country',
        'sign_in_alerts_device_family', 'sign_in_alerts_device_hash', 'sign_in_alerts_device_label',
        'sign_in_alerts_new_country_named', 'sign_in_alerts_new_device_or_country',
        'sign_in_alerts_resolved_with_answer', 'sign_in_alerts_status'],
  '0474/11: the ten CHECK constraints of sign_in_alerts are there by name');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid = 'public.user_sign_in_countries'::regclass and contype = 'c'),
  array['user_sign_in_countries_country'],
  '0474/12: the one CHECK constraint of user_sign_in_countries is there by name');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.sign_in_alerts'::regclass and a.attnum > 0
      and not a.attisdropped and a.attnotnull),
  array['id', 'user_id', 'new_device', 'new_country', 'client', 'device_label', 'device_family',
        'status', 'created_at'],
  '0474/13: sign_in_alerts requires the account, both flags, the client, both device words, the status and the time');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.user_sign_in_countries'::regclass and a.attnum > 0
      and not a.attisdropped and a.attnotnull),
  array['user_id', 'country', 'first_seen_at', 'last_seen_at'],
  '0474/14: user_sign_in_countries requires every column');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'sign_in_alerts', 'anon', array[]::text[],
  '0474/15: anon has no privilege on sign_in_alerts');
select table_privs_are('public', 'sign_in_alerts', 'authenticated', array[]::text[],
  '0474/16: authenticated has no privilege on sign_in_alerts');
select table_privs_are('public', 'sign_in_alerts', 'service_role',
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  '0474/17: service_role has SELECT, INSERT, UPDATE and DELETE on sign_in_alerts, and nothing else');
select table_privs_are('public', 'user_sign_in_countries', 'anon', array[]::text[],
  '0474/18: anon has no privilege on user_sign_in_countries');
select table_privs_are('public', 'user_sign_in_countries', 'authenticated', array[]::text[],
  '0474/19: authenticated has no privilege on user_sign_in_countries');
select table_privs_are('public', 'user_sign_in_countries', 'service_role',
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  '0474/20: service_role has SELECT, INSERT, UPDATE and DELETE on user_sign_in_countries, and nothing else');
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name in ('sign_in_alerts', 'user_sign_in_countries')
      and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0,
  '0474/21: no column of either table is granted to anon, authenticated or PUBLIC');
select is(pg_temp.grants_of('public.my_sign_in_alerts()'), array['authenticated:EXECUTE'],
  '0474/22: my_sign_in_alerts has one grant: EXECUTE to authenticated');
select is(pg_temp.grants_of('public.sign_in_alerts_for_organization(uuid, integer)'), array['authenticated:EXECUTE'],
  '0474/23: sign_in_alerts_for_organization has one grant: EXECUTE to authenticated');
select is(pg_temp.grants_of('public.purge_sign_in_alerts()'), array['service_role:EXECUTE'],
  '0474/24: purge_sign_in_alerts has one grant: EXECUTE to service_role');
select is(
  array[has_function_privilege('anon', 'public.my_sign_in_alerts()', 'execute'),
        has_function_privilege('authenticated', 'public.my_sign_in_alerts()', 'execute'),
        has_function_privilege('service_role', 'public.my_sign_in_alerts()', 'execute'),
        has_function_privilege('anon', 'public.sign_in_alerts_for_organization(uuid, integer)', 'execute'),
        has_function_privilege('authenticated', 'public.sign_in_alerts_for_organization(uuid, integer)', 'execute'),
        has_function_privilege('service_role', 'public.sign_in_alerts_for_organization(uuid, integer)', 'execute'),
        has_function_privilege('anon', 'public.purge_sign_in_alerts()', 'execute'),
        has_function_privilege('authenticated', 'public.purge_sign_in_alerts()', 'execute'),
        has_function_privilege('service_role', 'public.purge_sign_in_alerts()', 'execute')],
  array[false, true, false, false, true, false, false, false, true],
  '0474/25: for anon, authenticated and service_role, EXECUTE on the two reads is authenticated''s only and on the purge service_role''s only');
select is(
  (select array_agg(p.proname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                    || array_to_string(p.proconfig, ',') order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('my_sign_in_alerts', 'sign_in_alerts_for_organization', 'purge_sign_in_alerts')),
  array['my_sign_in_alerts:true:s:search_path=""',
        'purge_sign_in_alerts:true:v:search_path="",lock_timeout=2s',
        'sign_in_alerts_for_organization:true:s:search_path=""'],
  '0474/26: the three functions are SECURITY DEFINER with an empty search_path, the reads STABLE; the purge gives up a lock wait after 2 s');

-- ── 3. The tables' own checks, written to as their owner ────────────────────
select is(
  (select array_agg(pg_temp.try_alert(t.p) order by t.n)
     from unnest(array[
       '{}'::jsonb,
       jsonb_build_object('client', 'phone'),
       jsonb_build_object('new_device', false, 'new_country', true, 'country', 'MX'),
       jsonb_build_object('new_device', true, 'new_country', true, 'country', 'MX', 'city', 'Tijuana'),
       jsonb_build_object('session_id', 'a0474000-0000-0000-0000-0000000005e9'),
       jsonb_build_object('device_label', 'StockPilot app on iPhone 15 Pro (iOS 18.1)',
                          'device_family', 'StockPilot app on iPhone'),
       jsonb_build_object('device_label', 'StockPilot app on iPad Air (5th generation) (iPadOS 17.4.1)',
                          'device_family', 'StockPilot app on iPad'),
       jsonb_build_object('device_label', 'StockPilot app on Galaxy S24+ (Android 14)',
                          'device_family', 'StockPilot app on Android'),
       jsonb_build_object('device_label', 'StockPilot app', 'device_family', 'StockPilot app'),
       jsonb_build_object('device_label', 'Unknown browser on Unknown OS',
                          'device_family', 'Unknown browser on Unknown OS'),
       jsonb_build_object('device_label', 'Unknown device', 'device_family', 'Unknown device'),
       jsonb_build_object('device_label', repeat('d', 120), 'device_family', repeat('f', 120)),
       jsonb_build_object('device_label', 'd', 'device_family', 'f'),
       jsonb_build_object('device_hash', repeat('0123456789', 4)),
       jsonb_build_object('device_hash', repeat('abcdef0123', 4)),
       jsonb_build_object('country', 'US'),
       jsonb_build_object('city', 'Fresno'),
       jsonb_build_object('city', 'St. John''s'),
       jsonb_build_object('city', 'Saint-Denis'),
       jsonb_build_object('city', '6th of October City'),
       jsonb_build_object('city', 'S' || chr(227) || 'o Paulo'),
       jsonb_build_object('city', repeat('y', 80)),
       jsonb_build_object('status', 'was_me', 'resolved', true),
       jsonb_build_object('status', 'not_me', 'resolved', true)]) with ordinality as t(p, n)),
  array_fill('accepted'::text, array[24]),
  '0474/27: well-formed alerts are accepted: phone, either flag or both, a session, every kind of device words the app makes (a phone''s model and version, unknown browser and system), 1 and 120 characters, a device row, a country, real place names, 80 characters, each answer with its time');
select is(
  pg_temp.try_alert(jsonb_build_object('new_device', false, 'new_country', false)),
  '23514:sign_in_alerts_new_device_or_country',
  '0474/28: an alert that is neither a new device nor a new country is refused');
select is(
  array[pg_temp.try_alert(jsonb_build_object('new_device', false, 'new_country', true)),
        pg_temp.try_alert(jsonb_build_object('new_device', true, 'new_country', true, 'city', 'Tijuana'))],
  array_fill('23514:sign_in_alerts_new_country_named'::text, array[2]),
  '0474/29: a new-country alert with no country is refused');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('client', t.c)) order by t.n)
     from unnest(array['tablet', 'Web', '']) with ordinality as t(c, n)),
  array_fill('23514:sign_in_alerts_client'::text, array[3]),
  '0474/30: a client other than web or phone is refused');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('device_label', t.d)) order by t.n)
     from unnest(pg_temp.bad_words()) with ordinality as t(d, n)),
  array_fill('23514:sign_in_alerts_device_label'::text, array[17]),
  '0474/31: device_label refuses empty and over-long words, control and invisible characters, a user agent, a link with its scheme, markup, a comma, an apostrophe, an underscore and a letter outside A to Z');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('device_family', t.d)) order by t.n)
     from unnest(pg_temp.bad_words()) with ordinality as t(d, n)),
  array_fill('23514:sign_in_alerts_device_family'::text, array[17]),
  '0474/32: device_family refuses the same words');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('device_hash', t.h)) order by t.n)
     from unnest(array[
       upper(repeat('abcdef0123', 4)),
       repeat('a', 39),
       repeat('a', 41),
       repeat('a', 64),
       repeat('g', 40),
       '']) with ordinality as t(h, n)),
  array_fill('23514:sign_in_alerts_device_hash'::text, array[6]),
  '0474/33: a device row that is not 40 lower-case hex digits is refused');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('country', t.c)) order by t.n)
     from unnest(array['usa', 'us', 'U1', '']) with ordinality as t(c, n)),
  array_fill('23514:sign_in_alerts_country'::text, array[4]),
  '0474/34: a country that is not two capital letters is refused');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('city', t.c)) order by t.n)
     from unnest(array[
       'someone@test.local',
       '203.0.113.9',
       '2001:db8::1',
       '/wp-admin/setup.php',
       'curl/8.4.0',
       'a0474000-0000-0000-0000-0000000000c1',
       'abcdefab-abcd-abcd-abcd-abcdefabcdef',
       '<b>Fresno</b>',
       'Fresno?x=1',
       'Ber' || chr(10) || 'lin',
       'Fres' || chr(8238) || 'no',
       'Fres' || chr(8203) || 'no',
       '',
       repeat('x', 81)]) with ordinality as t(c, n)),
  array_fill('23514:sign_in_alerts_city'::text, array[14]),
  '0474/35: an email, an address, a path, a user agent, an id, markup, a query, a control or invisible character, an empty city and 81 characters are refused as a city');
select is(
  (select array_agg(pg_temp.try_alert(jsonb_build_object('status', t.s, 'resolved', true)) order by t.n)
     from unnest(array['maybe', 'OPEN', '']) with ordinality as t(s, n)),
  array_fill('23514:sign_in_alerts_status'::text, array[3]),
  '0474/36: an answer other than open, was_me or not_me is refused');
select is(
  array[pg_temp.try_alert(jsonb_build_object('status', 'open', 'resolved', true)),
        pg_temp.try_alert(jsonb_build_object('status', 'was_me')),
        pg_temp.try_alert(jsonb_build_object('status', 'not_me'))],
  array_fill('23514:sign_in_alerts_resolved_with_answer'::text, array[3]),
  '0474/37: an open alert with an answer time, and an answered one without, are refused');
select is(
  pg_temp.try_alert(jsonb_build_object('user_id', 'a0474000-0000-0000-0000-00000000dead')),
  '23503:sign_in_alerts_user_id_fkey',
  '0474/38: an alert for an account with no profile is refused');
select is(
  (select array_agg(pg_temp.try_country('a0474000-0000-0000-0000-0000000000cb', t.c) order by t.n)
     from unnest(array['MX', 'usa', 'us', 'U1', '']) with ordinality as t(c, n)),
  array['accepted', '23514:user_sign_in_countries_country', '23514:user_sign_in_countries_country',
        '23514:user_sign_in_countries_country', '23514:user_sign_in_countries_country'],
  '0474/39: a country row takes two capital letters and nothing else');
insert into public.user_sign_in_countries (user_id, country) values (:outsider, 'NL');
select is(
  array[pg_temp.try_country('a0474000-0000-0000-0000-0000000000cb', 'NL'),
        pg_temp.try_country('a0474000-0000-0000-0000-00000000dead', 'NL')],
  array['23505:user_sign_in_countries_pkey', '23503:user_sign_in_countries_user_id_fkey'],
  '0474/40: one row per account and country, and only for an account with a profile');
delete from public.user_sign_in_countries where user_id = :outsider;
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_city'),
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.security_events'::regclass and c.conname = 'security_events_city'),
  '0474/41: the city rule is the same text as security_events_city (0472), whole');
select is(
  (select count(*)::int
     from unnest(array[
            $p$[[:cntrl:]]$p$,
            $p$[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]$p$,
            $p$[@/\\:;<>(){}\[\]=?&%#"|$*+^~`]$p$,
            $p$[0-9].*[0-9].*[0-9].*[0-9]$p$,
            $p$[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-$p$]) as t(pat)
    where position(t.pat in (select pg_get_constraintdef(c.oid) from pg_constraint c
                              where c.conrelid = 'public.sign_in_alerts'::regclass
                                and c.conname = 'sign_in_alerts_city')) > 0
      and position(t.pat in (select pg_get_constraintdef(c.oid) from pg_constraint c
                              where c.conrelid = 'public.security_events'::regclass
                                and c.conname = 'security_events_city')) > 0),
  5,
  '0474/42: each of the five city patterns is in both rules, written as escapes');
select is(
  (select replace(pg_get_constraintdef(c.oid), 'device_family', 'device_label') from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_device_family'),
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_device_label'),
  '0474/43: the two device rules are the same text');

-- ── 4. The alerts every section below reads ─────────────────────────────────
-- The member's own: an hour ago, two days ago, exactly 30 days, just past 30
-- days, exactly 90 days, just past 90 days, 120 days. Then one each for the
-- admin, the member of A and B, the live and the expired act-as seats, the
-- invitation, the outsider, the disabled member, B's and C's owners, and 520
-- for one member of B. The phones' labels carry a model; their families do
-- not.
insert into public.sign_in_alerts
  (id, user_id, session_id, new_device, new_country, client, device_label, device_family, device_hash,
   country, city, status, resolved_at, created_at)
values
  ('a0474000-0000-0000-0000-000000000101', :memberA, 'a0474000-0000-0000-0000-0000000005e1',
     true,  false, 'web',   'Chrome on macOS', 'Chrome on macOS', repeat('a', 40),
     'US', 'Fresno',      'open',   null, now() - interval '1 hour'),
  ('a0474000-0000-0000-0000-000000000102', :memberA, null,
     false, true,  'phone', 'StockPilot app on iPhone 15 Pro (iOS 18.1)', 'StockPilot app on iPhone', null,
     'MX', 'Tijuana',     'was_me', now() - interval '1 day', now() - interval '2 days'),
  ('a0474000-0000-0000-0000-000000000103', :memberA, null,
     true,  false, 'web',   'Firefox on Windows', 'Firefox on Windows', null,
     null, null,          'open',   null, now() - interval '30 days'),
  ('a0474000-0000-0000-0000-000000000104', :memberA, null,
     true,  false, 'web',   'Firefox on Windows', 'Firefox on Windows', null,
     null, null,          'open',   null, now() - interval '30 days' - interval '1 microsecond'),
  ('a0474000-0000-0000-0000-000000000105', :memberA, null,
     true,  false, 'web',   'Safari on macOS', 'Safari on macOS', null,
     null, null,          'open',   null, now() - interval '90 days'),
  ('a0474000-0000-0000-0000-000000000106', :memberA, null,
     true,  false, 'web',   'Safari on macOS', 'Safari on macOS', null,
     null, null,          'open',   null, now() - interval '90 days' - interval '1 microsecond'),
  ('a0474000-0000-0000-0000-000000000107', :memberA, null,
     true,  false, 'web',   'Safari on macOS', 'Safari on macOS', null,
     null, null,          'open',   null, now() - interval '120 days'),
  ('a0474000-0000-0000-0000-000000000111', :adminA,  null,
     true,  true,  'web',   'Edge on Windows', 'Edge on Windows', repeat('b', 40),
     'CA', 'St. John''s', 'not_me', now() - interval '2 hours', now() - interval '3 hours'),
  ('a0474000-0000-0000-0000-000000000121', :twoOrg,  null,
     true,  false, 'phone', 'StockPilot app on iPad Air (5th generation) (iPadOS 17.4.1)', 'StockPilot app on iPad', null,
     'US', null,          'open',   null, now() - interval '4 hours'),
  ('a0474000-0000-0000-0000-000000000131', :actas,   null,
     true,  false, 'web',   'Chrome on Linux', 'Chrome on Linux', null,
     null, null,          'open',   null, now() - interval '5 hours'),
  ('a0474000-0000-0000-0000-000000000132', :actasOld, null,
     true,  false, 'web',   'Chrome on Linux', 'Chrome on Linux', null,
     null, null,          'open',   null, now() - interval '6 hours'),
  ('a0474000-0000-0000-0000-000000000133', :invited, null,
     true,  false, 'web',   'Chrome on Linux', 'Chrome on Linux', null,
     null, null,          'open',   null, now() - interval '7 hours'),
  ('a0474000-0000-0000-0000-000000000134', :outsider, null,
     true,  false, 'web',   'Chrome on Linux', 'Chrome on Linux', null,
     null, null,          'open',   null, now() - interval '8 hours'),
  ('a0474000-0000-0000-0000-000000000135', :disabled, null,
     false, true,  'web',   'Chrome on Linux', 'Chrome on Linux', null,
     'FR', 'Saint-Denis', 'open',   null, now() - interval '11 hours'),
  ('a0474000-0000-0000-0000-000000000141', :ownerB,  null,
     true,  false, 'web',   'Chrome on Linux', 'Chrome on Linux', null,
     null, null,          'open',   null, now() - interval '2 hours'),
  ('a0474000-0000-0000-0000-000000000151', :ownerC,  null,
     true,  false, 'web',   'Chrome on Linux', 'Chrome on Linux', null,
     null, null,          'open',   null, now() - interval '10 hours');
insert into public.sign_in_alerts (user_id, new_device, new_country, client, device_label, device_family, created_at)
select :busy, true, false, 'web', 'Busy browser ' || g, 'Busy browser', now() - make_interval(mins => g) - interval '30 seconds'
  from generate_series(1, 520) g;

-- ── 5. The member's own alerts, by caller ───────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c6', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select * from public.my_sign_in_alerts() $$,
  $$ values
     ('a0474000-0000-0000-0000-000000000101'::uuid, 'a0474000-0000-0000-0000-0000000005e1'::uuid,
        true, false, 'web'::text, 'Chrome on macOS'::text, 'US'::text, 'Fresno'::text, 'open'::text,
        now() - interval '1 hour'),
     ('a0474000-0000-0000-0000-000000000102'::uuid, null, false, true, 'phone',
        'StockPilot app on iPhone 15 Pro (iOS 18.1)', 'MX', 'Tijuana', 'was_me', now() - interval '2 days'),
     ('a0474000-0000-0000-0000-000000000103'::uuid, null, true, false, 'web', 'Firefox on Windows',
        null, null, 'open', now() - interval '30 days') $$,
  '0474/44: a member reads their own alerts of the last 30 days, newest first, with the full device label, the one exactly 30 days old included and the one a microsecond older left out');
select is(
  (select proargnames from pg_proc where oid = 'public.my_sign_in_alerts()'::regprocedure),
  array['id', 'session_id', 'new_device', 'new_country', 'client', 'device_label', 'country', 'city',
        'status', 'created_at'],
  '0474/45: the member''s read returns the designed columns: the full label, not the family, and not the device row');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c7', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000121'::uuid) $$,
  '0474/46: another member, of two organizations, reads their own one alert, once, and none of the first member''s');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000111'::uuid) $$,
  '0474/47: an admin reads only their own alerts through it, none of their members''');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select is((select count(*)::int from public.my_sign_in_alerts()), 0,
  '0474/48: an owner with no alert of their own reads none');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c3', 'role', 'authenticated')::text, true);
select is((select count(*)::int from public.my_sign_in_alerts()), 0,
  '0474/49: a manager with no alert of their own reads none');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c4', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000141'::uuid) $$,
  '0474/50: another organization''s owner reads only their own');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c8', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000131'::uuid) $$,
  '0474/51: the account holding an act-as seat reads its own alerts, as any account does');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000cd', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.my_sign_in_alerts() $$,
  '42501', 'sign_in_alerts_not_allowed',
  '0474/52: a disabled account cannot read its own alerts, even with a token that still lasts');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000cc', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select created_at from public.my_sign_in_alerts() $$,
  $$ select now() - make_interval(mins => g) - interval '30 seconds' from generate_series(1, 50) g $$,
  '0474/53: a member with 520 alerts reads the newest 50, newest first');

select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.my_sign_in_alerts() $$,
  '42501', 'sign_in_alerts_not_allowed',
  '0474/54: a token with no account is refused by the function''s own gate');
reset role;

set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select throws_ok(
  $$ select * from public.my_sign_in_alerts() $$,
  '42501', 'permission denied for function my_sign_in_alerts',
  '0474/55: a signed-out caller cannot call the member''s read: it has no EXECUTE');
reset role;

-- ── 6. The organization's list, by caller ───────────────────────────────────
-- Organization A's list: its accepted members' alerts of the last 90 days,
-- newest first: the member (1 hour), the admin (3 hours), the member of A and
-- B (4 hours), the disabled member (11 hours), the member again (2 days,
-- exactly 30 days, just past 30 days, exactly 90 days). Not the act-as seats,
-- the invitation, the outsider, B's or C's owner, or anything past 90 days.
select set_config('t.list_a', array[
  'a0474000-0000-0000-0000-000000000101', 'a0474000-0000-0000-0000-000000000111',
  'a0474000-0000-0000-0000-000000000121', 'a0474000-0000-0000-0000-000000000135',
  'a0474000-0000-0000-0000-000000000102', 'a0474000-0000-0000-0000-000000000103',
  'a0474000-0000-0000-0000-000000000104', 'a0474000-0000-0000-0000-000000000105']::text, true);

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500) $$,
  $$ select unnest(current_setting('t.list_a')::uuid[]) $$,
  '0474/56: an owner reads the alerts of the organization''s accepted members of the last 90 days, newest first, the one exactly 90 days old included');
select results_eq(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500)
      where id in ('a0474000-0000-0000-0000-000000000101', 'a0474000-0000-0000-0000-000000000111',
                   'a0474000-0000-0000-0000-000000000135', 'a0474000-0000-0000-0000-000000000102') $$,
  $$ values
     ('a0474000-0000-0000-0000-000000000101'::uuid, 'a0474000-0000-0000-0000-0000000000c6'::uuid,
        'Alert Member A'::text, 'a-member-alerts@test.local'::text, true, false, 'web'::text,
        'Chrome on macOS'::text, 'US'::text, 'Fresno'::text, 'open'::text, null::timestamptz,
        now() - interval '1 hour'),
     ('a0474000-0000-0000-0000-000000000111'::uuid, 'a0474000-0000-0000-0000-0000000000c2'::uuid,
        'Alert Admin A', 'a-admin-alerts@test.local', true, true, 'web',
        'Edge on Windows', 'CA', 'St. John''s', 'not_me', now() - interval '2 hours',
        now() - interval '3 hours'),
     ('a0474000-0000-0000-0000-000000000135'::uuid, 'a0474000-0000-0000-0000-0000000000cd'::uuid,
        null, 'a-disabled-alerts@test.local', false, true, 'web',
        'Chrome on Linux', 'FR', 'Saint-Denis', 'open', null, now() - interval '11 hours'),
     ('a0474000-0000-0000-0000-000000000102'::uuid, 'a0474000-0000-0000-0000-0000000000c6'::uuid,
        'Alert Member A', 'a-member-alerts@test.local', false, true, 'phone',
        'StockPilot app on iPhone', 'MX', 'Tijuana', 'was_me', now() - interval '1 day',
        now() - interval '2 days') $$,
  '0474/57: each alert comes with the member''s id, name (empty when the profile has none) and email, the device family (a phone without its model), the answer and its time; a disabled member''s alerts are listed');
select is(
  (select proargnames from pg_proc
    where oid = 'public.sign_in_alerts_for_organization(uuid, integer)'::regprocedure),
  array['p_organization_id', 'p_limit', 'id', 'user_id', 'full_name', 'email', 'new_device',
        'new_country', 'client', 'device_family', 'country', 'city', 'status', 'resolved_at',
        'created_at'],
  '0474/58: the organization''s list returns the family and no session id, device row or full label');
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/59: an owner cannot read another organization''s list');
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization(null, 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/60: a null organization is refused');
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-00000000dead', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/61: an organization that does not exist is refused the same way');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500) $$,
  $$ select unnest(current_setting('t.list_a')::uuid[]) $$,
  '0474/62: an admin reads the same list, their own alert in it');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c8', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500) $$,
  $$ select unnest(current_setting('t.list_a')::uuid[]) $$,
  '0474/63: a live act-as seat reads the list as an owner, and its own account''s alert is not in it');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c3', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/64: a manager cannot read the list');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c6', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/65: a staff member cannot read the list, even with their own alerts in it');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c4', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/66: another organization''s owner cannot read the list');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c9', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/67: an expired act-as seat cannot read the list');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000ca', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/68: an admin invitation not accepted cannot read the list');

select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000ce', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/69: a disabled admin cannot read the list');

select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'sign_in_alerts_not_allowed', '0474/70: a token with no account cannot read the list');
reset role;

set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'permission denied for function sign_in_alerts_for_organization',
  '0474/71: a signed-out caller cannot call the organization''s list: it has no EXECUTE');
reset role;

-- Organization B: its owner, the member of A and B, and the member with 520
-- alerts (522 in 90 days).
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c4', 'role', 'authenticated')::text, true);
select is(
  (select array_agg(distinct x.user_id order by x.user_id)
     from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 500) x),
  array['a0474000-0000-0000-0000-0000000000c4', 'a0474000-0000-0000-0000-0000000000c7',
        'a0474000-0000-0000-0000-0000000000cc']::uuid[],
  '0474/72: another organization''s owner reads that organization''s members only');
select ok(
  'a0474000-0000-0000-0000-000000000121'::uuid in
    (select x.id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 500) x),
  '0474/73: the alert of a member of A and B is in B''s list as well as in A''s (0474/56)');

-- ── 7. The limit ────────────────────────────────────────────────────────────
select is(
  array[(select count(*)::int from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 1000)),
        (select count(*)::int from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 500)),
        (select count(*)::int from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 0)),
        (select count(*)::int from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', -5))],
  array[500, 500, 1, 1],
  '0474/74: of 522 alerts, a limit of 1000 or 500 reads 500, and 0 or -5 reads one');
select is(
  array[(select count(*)::int from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', null)),
        (select count(*)::int from public.sign_in_alerts_for_organization(
           p_organization_id => 'a0474000-0000-0000-0000-0000000000b1'))],
  array[100, 100],
  '0474/75: a null limit and no limit read the default 100');
select results_eq(
  $$ select created_at from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 3) $$,
  $$ select now() - make_interval(mins => g) - interval '30 seconds' from generate_series(1, 3) g $$,
  '0474/76: a limit of 3 reads the three newest, newest first');
reset role;

-- ── 8. The authenticator rule, on both reads ────────────────────────────────
-- C asks its owners and admins for an authenticator; its owner has none yet.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c5', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000d1', 10) $$,
  '42501', 'mfa_required',
  '0474/77: where the policy asks for an authenticator, an owner without one cannot read the list');
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000151'::uuid) $$,
  '0474/78: an account with no authenticator reads its own alerts with a password-only session');
reset role;

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), :ownerC, '0474 authenticator c', 'totp', 'verified', now(), now()),
  (gen_random_uuid(), :adminA, '0474 authenticator a', 'totp', 'verified', now(), now()),
  (gen_random_uuid(), :memberA, '0474 authenticator m', 'totp', 'unverified', now(), now());

set local role authenticated;
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000d1', 10) $$,
  '42501', 'aal2_required',
  '0474/79: with an authenticator set up, a password-only session cannot read the list');
select throws_ok(
  $$ select * from public.my_sign_in_alerts() $$,
  '42501', 'aal2_required',
  '0474/80: nor its own alerts');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c5', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000d1', 10) $$,
  $$ values ('a0474000-0000-0000-0000-000000000151'::uuid) $$,
  '0474/81: a session that holds the second step reads the list');
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000151'::uuid) $$,
  '0474/82: and its own alerts');

-- An admin who has an authenticator, in an organization that does not ask.
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'aal2_required',
  '0474/83: a member who has an authenticator owes the second step on the list whatever the policy');
select throws_ok(
  $$ select * from public.my_sign_in_alerts() $$,
  '42501', 'aal2_required',
  '0474/84: and on their own alerts');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c2', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500) $$,
  $$ select unnest(current_setting('t.list_a')::uuid[]) $$,
  '0474/85: and reads the list once the session holds it');
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000111'::uuid) $$,
  '0474/86: and their own alerts');

-- A factor that was never verified does not count.
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c6', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.my_sign_in_alerts() $$,
  $$ values ('a0474000-0000-0000-0000-000000000101'::uuid), ('a0474000-0000-0000-0000-000000000102'::uuid),
            ('a0474000-0000-0000-0000-000000000103'::uuid) $$,
  '0474/87: an account whose only authenticator is not verified reads its own three alerts with a password-only session');
reset role;

-- ── 9. Who writes the tables ────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select throws_ok($$ select count(*) from public.sign_in_alerts $$,
  '42501', 'permission denied for table sign_in_alerts',
  '0474/88: an owner cannot read sign_in_alerts directly');
select throws_ok($$ update public.sign_in_alerts set status = 'was_me', resolved_at = now() $$,
  '42501', 'permission denied for table sign_in_alerts',
  '0474/89: an owner cannot answer an alert directly');
select throws_ok($$ select count(*) from public.user_sign_in_countries $$,
  '42501', 'permission denied for table user_sign_in_countries',
  '0474/90: an owner cannot read user_sign_in_countries directly');
select throws_ok(
  $$ insert into public.user_sign_in_countries (user_id, country) values ('a0474000-0000-0000-0000-0000000000c1', 'US') $$,
  '42501', 'permission denied for table user_sign_in_countries',
  '0474/91: an owner cannot write user_sign_in_countries directly');
select throws_ok($$ select public.purge_sign_in_alerts() $$,
  '42501', 'permission denied for function purge_sign_in_alerts',
  '0474/92: an owner cannot call the purge: it has no EXECUTE');
reset role;

set local role anon;
select throws_ok($$ select count(*) from public.sign_in_alerts $$,
  '42501', 'permission denied for table sign_in_alerts',
  '0474/93: a signed-out caller cannot read sign_in_alerts');
reset role;

-- The app's writes, on the service-role client.
set local role service_role;
select lives_ok(
  $$ insert into public.sign_in_alerts (id, user_id, new_device, new_country, client, device_label, device_family)
       values ('a0474000-0000-0000-0000-000000000161', 'a0474000-0000-0000-0000-0000000000c2',
               true, false, 'web', 'Chrome on macOS', 'Chrome on macOS') $$,
  '0474/94: service_role inserts an alert');
select results_eq(
  $$ select status, resolved_at, session_id, device_hash, country, city, created_at
       from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000161' $$,
  $$ values ('open'::text, null::timestamptz, null::uuid, null::text, null::text, null::text, now()) $$,
  '0474/95: a new alert is open, unanswered, with no session, device row or place unless given, made now');
select lives_ok(
  $$ update public.sign_in_alerts set status = 'not_me', resolved_at = now()
      where id = 'a0474000-0000-0000-0000-000000000161' and status <> 'not_me' $$,
  '0474/96: service_role records an answer with its time');
select lives_ok(
  $$ insert into public.user_sign_in_countries (user_id, country) values
       ('a0474000-0000-0000-0000-0000000000c6', 'US'),
       ('a0474000-0000-0000-0000-0000000000c6', 'MX'),
       ('a0474000-0000-0000-0000-0000000000c2', 'US')
     on conflict (user_id, country) do update set last_seen_at = now() $$,
  '0474/97: service_role records the countries an account signs in from');
select results_eq(
  $$ select country, first_seen_at, last_seen_at from public.user_sign_in_countries
      where user_id = 'a0474000-0000-0000-0000-0000000000c6' order by country $$,
  $$ values ('MX'::text, now(), now()), ('US'::text, now(), now()) $$,
  '0474/98: and reads them back, first and last seen now');
select lives_ok(
  $$ delete from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000161' $$,
  '0474/99: service_role deletes an alert');
select throws_ok($$ select * from public.my_sign_in_alerts() $$,
  '42501', 'permission denied for function my_sign_in_alerts',
  '0474/100: service_role cannot call the member''s read: it has no EXECUTE');
select throws_ok($$ select * from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 10) $$,
  '42501', 'permission denied for function sign_in_alerts_for_organization',
  '0474/101: service_role cannot call the organization''s list: it has no EXECUTE');
reset role;

-- ── 10. Retention ───────────────────────────────────────────────────────────
-- 5,000 more alerts about 100 days old, for the outsider, so one call cannot
-- take every old row. Old rows now, oldest first: the member's 120-day alert,
-- the 5,000, the member's alert a microsecond past 90 days (5,002).
insert into public.sign_in_alerts (user_id, new_device, new_country, client, device_label, device_family, created_at)
select :outsider, true, false, 'web', 'Old browser', 'Old browser', now() - interval '100 days' - make_interval(secs => g)
  from generate_series(1, 5000) g;

set local role service_role;
select is(public.purge_sign_in_alerts(), 5000, '0474/102: the first call deletes 5,000 and says so');
reset role;
select results_eq(
  $$ select (select count(*)::int from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000107'),
            (select count(*)::int from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000106'),
            (select count(*)::int from public.sign_in_alerts where user_id = 'a0474000-0000-0000-0000-0000000000cb'
                                                              and created_at < now() - interval '90 days') $$,
  $$ values (0, 1, 1) $$,
  '0474/103: oldest first: the 120-day alert and 4,999 of the 5,000 are gone; the newest old ones wait for the next call');

set local role service_role;
select is(public.purge_sign_in_alerts(), 2, '0474/104: the second call deletes the two left');
select is(public.purge_sign_in_alerts(), 0, '0474/105: a third finds nothing');
reset role;
select results_eq(
  $$ select (select count(*)::int from public.sign_in_alerts where created_at < now() - interval '90 days'),
            (select count(*)::int from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000105'),
            (select count(*)::int from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000106') $$,
  $$ values (0, 1, 0) $$,
  '0474/106: nothing older than 90 days is left; the alert exactly 90 days old stays and the one a microsecond older is gone');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c1', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500) $$,
  $$ select unnest(current_setting('t.list_a')::uuid[]) $$,
  '0474/107: the organization''s list is unchanged by the purge: its oldest row is the one the purge keeps');
reset role;

-- ── 11. A member removed, and the cascade from user_profiles ────────────────
delete from public.organization_members where organization_id = :orgA and user_id = :twoOrg;
set local role authenticated;
select results_eq(
  $$ select id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000a1', 500) $$,
  $$ select x from unnest(current_setting('t.list_a')::uuid[]) as t(x)
      where x <> 'a0474000-0000-0000-0000-000000000121' $$,
  '0474/108: a member removed from A leaves A''s list');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0474000-0000-0000-0000-0000000000c4', 'role', 'authenticated')::text, true);
select ok(
  'a0474000-0000-0000-0000-000000000121'::uuid in
    (select x.id from public.sign_in_alerts_for_organization('a0474000-0000-0000-0000-0000000000b1', 500) x),
  '0474/109: and stays in B''s, where they are still a member');
reset role;

select is(
  (select array[(select count(*)::int from public.sign_in_alerts where user_id = :memberA),
                (select count(*)::int from public.user_sign_in_countries where user_id = :memberA)]),
  array[5, 2],
  '0474/110: before: the member has five alerts left and two countries');
delete from public.user_profiles where id = :memberA;
select is(
  (select array[(select count(*)::int from public.sign_in_alerts where user_id = :memberA),
                (select count(*)::int from public.user_sign_in_countries where user_id = :memberA)]),
  array[0, 0],
  '0474/111: deleting the member''s profile deletes their alerts and countries');
select is(
  (select array[(select count(*)::int from public.sign_in_alerts where id = 'a0474000-0000-0000-0000-000000000111'),
                (select count(*)::int from public.user_sign_in_countries where user_id = :adminA)]),
  array[1, 1],
  '0474/112: another account''s alert and country stay');

-- ── 12. What a later edit must not lose ─────────────────────────────────────
select ok(
  (select prosrc ~ 'public\.has_org_role\(p_organization_id, ''admin''\)'
          and prosrc ~ 'perform public\.security_events_reader_check\(p_organization_id\)'
          and position('has_org_role' in prosrc) < position('security_events_reader_check' in prosrc)
          and position('security_events_reader_check' in prosrc) < position('return query' in prosrc)
     from pg_proc where oid = 'public.sign_in_alerts_for_organization(uuid, integer)'::regprocedure),
  '0474/113: the source of the organization''s list makes the role check, then the shared check, before it reads');
select ok(
  (select prosrc ~ 'auth\.uid\(\)'
          and position('auth.uid()' in prosrc) between 1 and position('return query' in prosrc)
          and position('auth.mfa_factors' in prosrc) between 1 and position('return query' in prosrc)
     from pg_proc where oid = 'public.my_sign_in_alerts()'::regprocedure),
  '0474/114: the source of the member''s read takes the account from auth.uid() and looks at its authenticators before it reads');
select ok(
  (select prosrc ~ 'm\.accepted_at is not null'
          and prosrc ~ 'm\.impersonation_expires_at is null'
     from pg_proc where oid = 'public.sign_in_alerts_for_organization(uuid, integer)'::regprocedure),
  '0474/115: the source of the organization''s list counts members as 0413 does: accepted, not an act-as seat');
select ok(
  (select prosrc !~ 'device_label' and prosrc !~ 'device_hash' and prosrc !~ 'session_id'
     from pg_proc where oid = 'public.sign_in_alerts_for_organization(uuid, integer)'::regprocedure)
  and (select prosrc !~ 'device_hash' and prosrc !~ 'device_family'
         from pg_proc where oid = 'public.my_sign_in_alerts()'::regprocedure),
  '0474/116: the source of the organization''s list names no full label, device row or session, and the member''s read no device row or family');
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relname in ('sign_in_alerts', 'user_sign_in_countries')
      and exists (select 1 from pg_publication_rel pr where pr.prrelid = c.oid)),
  0,
  '0474/117: neither table is in a publication (no realtime feed)');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid in ('public.sign_in_alerts'::regclass, 'public.user_sign_in_countries'::regclass)
      and not t.tgisinternal),
  0,
  '0474/118: neither table has a trigger of its own');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.user_profiles'::regclass and t.tgisinternal
      and t.tgconstraint in (select c.oid from pg_constraint c
                              where c.contype = 'f'
                                and c.conrelid in ('public.sign_in_alerts'::regclass,
                                                   'public.user_sign_in_countries'::regclass))),
  4,
  '0474/119: user_profiles gains only the two foreign keys'' internal triggers (on delete and on update, each)');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.sign_in_alerts'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attname like 'device%'),
  array['device_label', 'device_family', 'device_hash'],
  '0474/120: the device is held three ways: the member''s label, the organization''s family, the device row');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_device_label'),
  $c$CHECK ((device_label ~ '^[A-Za-z0-9 ()+.-]{1,120}$'::text))$c$,
  '0474/121: the device rule is the allowlist of letters, digits, spaces and ( ) + . -, 1 to 120');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_device_hash'),
  $c$CHECK (((device_hash IS NULL) OR (device_hash ~ '^[0-9a-f]{40}$'::text)))$c$,
  '0474/122: the device row is empty or 40 lower-case hex digits');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_resolved_with_answer'),
  $c$CHECK (((status = 'open'::text) = (resolved_at IS NULL)))$c$,
  '0474/123: an answer and its time go together');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.sign_in_alerts'::regclass and c.conname = 'sign_in_alerts_new_country_named'),
  $c$CHECK (((NOT new_country) OR (country IS NOT NULL)))$c$,
  '0474/124: a new country names its country');
select is(
  pg_temp.try_alert(jsonb_build_object(
    'device_label', 'StockPilot app on ' || repeat('M', 47) || '+ (Android ' || repeat('1.', 8) || ')',
    'device_family', 'StockPilot app on Android')),
  'accepted',
  '0474/125: the longest label the phone route can make (a 48-character model, Android and a 16-character version: 93 characters) is accepted');
-- An anchored pattern's $ in Postgres matches only at the very end, and a
-- line break is not in the class, so words that end in one are refused.
select is(
  array[pg_temp.try_alert(jsonb_build_object('device_label', 'Chrome on macOS' || chr(10))),
        pg_temp.try_alert(jsonb_build_object('device_label', 'Chrome on macOS' || chr(13) || chr(10))),
        pg_temp.try_alert(jsonb_build_object('device_family', 'Chrome on macOS' || chr(10))),
        pg_temp.try_alert(jsonb_build_object('device_family', 'Chrome on macOS' || chr(13) || chr(10)))],
  array['23514:sign_in_alerts_device_label', '23514:sign_in_alerts_device_label',
        '23514:sign_in_alerts_device_family', '23514:sign_in_alerts_device_family'],
  '0474/126: device words that end in a line break are refused, in both columns');

select * from finish();
rollback;
