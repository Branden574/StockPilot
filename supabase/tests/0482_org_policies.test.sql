-- supabase/tests/0482_org_policies.test.sql
-- Proves migration 0482, policy sign-off:
--   public.org_policies, org_policy_versions, org_policy_acknowledgements, org_policy_reminders
--   members:  org_policies_for_member(uuid), org_policy_text(uuid, integer), org_policy_acknowledge(uuid, text, text)
--   admins:   org_policies_for_admin(uuid), org_policy_draft(uuid), org_policy_status(uuid),
--             org_policy_acknowledgement_record(uuid), org_policy_save_draft(uuid, uuid, text, text, text),
--             org_policy_discard_draft(uuid), org_policy_publish(uuid, text, text), org_policy_retire(uuid),
--             org_policy_remind_now(uuid)
--   the job:  org_policy_reminders_claim(integer)
--
-- WHAT IS WORTH PINNING
--   1. Shape: the designed columns (no email column anywhere), keys, checks, indexes and triggers; RLS on and
--      no policy.
--   2. Privileges for every role on every object: anon and authenticated nothing on the tables, service_role
--      SELECT only; EXECUTE to authenticated on the twelve member and admin functions, to service_role on the
--      claim only, to nobody on the helpers and the trigger functions; PUBLIC nothing. Every authenticated
--      function gates in its body (INV-25), and the claim refuses authenticated even if it were granted.
--   3. The text rules: the normal form and the refused characters, the same as packages/core; the hash of the
--      stored words, the same value as the core's pinned fixture.
--   4. Drafts and publishing: who may write; the first publish is a version; a correction asks nobody again and
--      a new version asks everyone; a published version never changes and is never deleted.
--   5. The acknowledgement: for the caller's own account only, a current member (0422's rule), of the current
--      version of a published policy, with the hash of the words shown, the second step held where an
--      authenticator is set up; once per version. Nobody (no API role, not the owner, not any function)
--      changes or removes one; TRUNCATE is refused; an account deletion keeps it with the kept name; the
--      organization's deletion removes its records.
--   6. The reads: what a member and an admin see; who has not acknowledged follows the current-member rule,
--      invitations apart; the record keeps former members and deleted accounts.
--   7. Reminders: Remind now once a day, stamp first, nobody owed stamps nothing; the claim's schedule (3, 7,
--      then weekly, at most 6, never within 3 days of the last), oldest first, the limit and more; a
--      correction keeps the count and a new version starts a new one. (Two sessions:
--      scripts/db-concurrency/0482_org_policies_race.sh.)
--
-- now() is fixed for the whole transaction and every function uses it. A time in the past is made by moving a
-- row's own time back, as its owner (for a published version, with its guard switched off for that one
-- statement). Every organization, account, address, name and text is made up. Wrapped in begin/rollback:
-- nothing leaks. Run via `supabase test db` after `supabase db reset`.

begin;

select plan(138);

set local timezone = 'UTC';

select has_table('public', 'org_policies', '0482/1: org_policies exists');
select has_table('public', 'org_policy_versions', '0482/2: org_policy_versions exists');
select has_table('public', 'org_policy_acknowledgements', '0482/3: org_policy_acknowledgements exists');
select has_table('public', 'org_policy_reminders', '0482/4: org_policy_reminders exists');

\set orgA '\'a0482000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0482000-0000-0000-0000-0000000000b1\''
\set orgC '\'a0482000-0000-0000-0000-0000000000d1\''
\set ownerA '\'a0482000-0000-0000-0000-0000000000c1\''
\set adminA '\'a0482000-0000-0000-0000-0000000000c2\''
\set managerA '\'a0482000-0000-0000-0000-0000000000c3\''
\set adminP '\'a0482000-0000-0000-0000-0000000000c4\''
\set memberA '\'a0482000-0000-0000-0000-0000000000c6\''
\set memberB '\'a0482000-0000-0000-0000-0000000000c7\''
\set removedA '\'a0482000-0000-0000-0000-0000000000c8\''
\set noName '\'a0482000-0000-0000-0000-0000000000c9\''
\set viewerA '\'a0482000-0000-0000-0000-0000000000ca\''
\set atName '\'a0482000-0000-0000-0000-0000000000cb\''
\set longName '\'a0482000-0000-0000-0000-0000000000cc\''
\set mfaA '\'a0482000-0000-0000-0000-0000000000cd\''
\set disabledA '\'a0482000-0000-0000-0000-0000000000ce\''
\set disabledAdmin '\'a0482000-0000-0000-0000-0000000000cf\''
\set actas '\'a0482000-0000-0000-0000-0000000000d0\''
\set actasOld '\'a0482000-0000-0000-0000-0000000000d2\''
\set invitedA '\'a0482000-0000-0000-0000-0000000000d3\''
\set outsider '\'a0482000-0000-0000-0000-0000000000d4\''
\set ownerB '\'a0482000-0000-0000-0000-0000000000d5\''
\set memberAB '\'a0482000-0000-0000-0000-0000000000d6\''
\set ownerC '\'a0482000-0000-0000-0000-0000000000e0\''
\set adminC '\'a0482000-0000-0000-0000-0000000000e1\''
\set managerC '\'a0482000-0000-0000-0000-0000000000e2\''
\set memberC '\'a0482000-0000-0000-0000-0000000000e3\''
\set viewerC '\'a0482000-0000-0000-0000-0000000000e4\''
\set gapC '\'a0482000-0000-0000-0000-0000000000e5\''
\set lateC2 '\'a0482000-0000-0000-0000-0000000000e6\''
\set lateC5 '\'a0482000-0000-0000-0000-0000000000e7\''
\set disabledC '\'a0482000-0000-0000-0000-0000000000e8\''
\set actasC '\'a0482000-0000-0000-0000-0000000000e9\''
\set invitedC '\'a0482000-0000-0000-0000-0000000000ea\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,        'policy-owner-a@test.local',        '{"full_name": "Policy Owner A"}'::jsonb),
  (:adminA,        'policy-admin-a@test.local',        '{"full_name": "Policy Admin A"}'::jsonb),
  (:managerA,      'policy-manager-a@test.local',      '{"full_name": "Policy Manager A"}'::jsonb),
  (:adminP,        'policy-publisher-a@test.local',    '{"full_name": "Policy Publisher A"}'::jsonb),
  (:memberA,       'policy-member-a@test.local',       '{"full_name": "Policy Member A"}'::jsonb),
  (:memberB,       'policy-member-b@test.local',       '{"full_name": "Policy Member B"}'::jsonb),
  (:removedA,      'policy-removed-a@test.local',      '{"full_name": "Policy Removed A"}'::jsonb),
  (:noName,        'policy-no-name@test.local',        '{}'::jsonb),
  (:viewerA,       'policy-viewer-a@test.local',       '{"full_name": "Policy Viewer A"}'::jsonb),
  (:atName,        'policy-at-name@test.local',        '{"full_name": "policy-at-name@test.local"}'::jsonb),
  (:longName,      'policy-long-name@test.local',      json_build_object('full_name', '  ' || repeat('L', 250))::jsonb),
  (:mfaA,          'policy-mfa-a@test.local',          '{"full_name": "Policy Second Step A"}'::jsonb),
  (:disabledA,     'policy-disabled-a@test.local',     '{"full_name": "Policy Disabled A"}'::jsonb),
  (:disabledAdmin, 'policy-disabled-admin@test.local', '{"full_name": "Policy Disabled Admin"}'::jsonb),
  (:actas,         'policy-act-as@test.local',         '{"full_name": "Policy Act As"}'::jsonb),
  (:actasOld,      'policy-act-as-old@test.local',     '{"full_name": "Policy Act As Old"}'::jsonb),
  (:invitedA,      'policy-invited-a@test.local',      '{"full_name": "Policy Invited A"}'::jsonb),
  (:outsider,      'policy-outsider@test.local',       '{"full_name": "Policy Outsider"}'::jsonb),
  (:ownerB,        'policy-owner-b@test.local',        '{"full_name": "Policy Owner B"}'::jsonb),
  (:memberAB,      'policy-member-ab@test.local',      '{"full_name": "Policy Member AB"}'::jsonb),
  (:ownerC,        'policy-owner-c@test.local',        '{"full_name": "Policy Owner C"}'::jsonb),
  (:adminC,        'policy-admin-c@test.local',        '{"full_name": "Policy Admin C"}'::jsonb),
  (:managerC,      'policy-manager-c@test.local',      '{"full_name": "Policy Manager C"}'::jsonb),
  (:memberC,       'policy-member-c@test.local',       '{"full_name": "Policy Member C"}'::jsonb),
  (:viewerC,       'policy-viewer-c@test.local',       '{"full_name": "Policy Viewer C"}'::jsonb),
  (:gapC,          'policy-gap-c@test.local',          '{"full_name": "Policy Gap C"}'::jsonb),
  (:lateC2,        'policy-late-two-c@test.local',     '{"full_name": "Policy Late Two C"}'::jsonb),
  (:lateC5,        'policy-late-five-c@test.local',    '{"full_name": "Policy Late Five C"}'::jsonb),
  (:disabledC,     'policy-disabled-c@test.local',     '{"full_name": "Policy Disabled C"}'::jsonb),
  (:actasC,        'policy-act-as-c@test.local',       '{"full_name": "Policy Act As C"}'::jsonb),
  (:invitedC,      'policy-invited-c@test.local',      '{"full_name": "Policy Invited C"}'::jsonb);
update public.user_profiles set disabled_at = now() where id in (:disabledA, :disabledAdmin, :disabledC);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), :mfaA, '0482 authenticator', 'totp', 'verified', now(), now()),
  (gen_random_uuid(), :memberA, '0482 unfinished authenticator', 'totp', 'unverified', now(), now());

insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Policy Org A', 'a0482000-org-a', 'optional'),
  (:orgB, 'Policy Org B', 'a0482000-org-b', 'optional'),
  (:orgC, 'Policy Org C', 'a0482000-org-c', 'optional');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :ownerA,        'owner',   now() - interval '100 days', null),
  (:orgA, :adminA,        'admin',   now() - interval '100 days', null),
  (:orgA, :managerA,      'manager', now() - interval '100 days', null),
  (:orgA, :adminP,        'admin',   now() - interval '100 days', null),
  (:orgA, :memberA,       'staff',   now() - interval '100 days', null),
  (:orgA, :memberB,       'staff',   now() - interval '100 days', null),
  (:orgA, :removedA,      'staff',   now() - interval '100 days', null),
  (:orgA, :noName,        'staff',   now() - interval '100 days', null),
  (:orgA, :viewerA,       'viewer',  now() - interval '100 days', null),
  (:orgA, :atName,        'staff',   now() - interval '100 days', null),
  (:orgA, :longName,      'staff',   now() - interval '100 days', null),
  (:orgA, :mfaA,          'staff',   now() - interval '100 days', null),
  (:orgA, :memberAB,      'staff',   now() - interval '100 days', null),
  (:orgA, :disabledA,     'staff',   now() - interval '100 days', null),
  (:orgA, :disabledAdmin, 'admin',   now() - interval '100 days', null),
  -- A live act-as seat and one that has expired.
  (:orgA, :actas,         'owner',   now() - interval '1 hour', now() + interval '1 hour'),
  (:orgA, :actasOld,      'owner',   now() - interval '3 hours', now() - interval '1 hour'),
  -- A membership not accepted.
  (:orgA, :invitedA,      'staff',   null, null),
  (:orgB, :ownerB,        'owner',   now() - interval '100 days', null),
  (:orgB, :memberAB,      'staff',   now() - interval '100 days', null),
  (:orgC, :ownerC,        'owner',   now() - interval '100 days', null),
  (:orgC, :adminC,        'admin',   now() - interval '100 days', null),
  (:orgC, :managerC,      'manager', now() - interval '100 days', null),
  (:orgC, :memberC,       'staff',   now() - interval '100 days', null),
  (:orgC, :viewerC,       'viewer',  now() - interval '100 days', null),
  (:orgC, :gapC,          'staff',   now() - interval '100 days', null),
  (:orgC, :lateC2,        'staff',   now() - interval '2 days', null),
  (:orgC, :lateC5,        'staff',   now() - interval '5 days', null),
  (:orgC, :disabledC,     'staff',   now() - interval '100 days', null),
  (:orgC, :actasC,        'owner',   now() - interval '1 hour', now() + interval '1 hour'),
  (:orgC, :invitedC,      'staff',   null, null);
-- Invitations of A: one open, one expired, one revoked, one accepted. Only the open one is listed.
insert into public.organization_invites (organization_id, email, role, token, expires_at, invited_by, accepted_at, revoked_at) values
  (:orgA, 'invite-open@test.local',     'staff',   'a0482000-token-open',     now() + interval '7 days', :adminA, null, null),
  (:orgA, 'invite-expired@test.local',  'staff',   'a0482000-token-expired',  now() - interval '1 day',  :adminA, null, null),
  (:orgA, 'invite-revoked@test.local',  'manager', 'a0482000-token-revoked',  now() + interval '7 days', :adminA, null, now()),
  (:orgA, 'invite-accepted@test.local', 'staff',   'a0482000-token-accepted', now() + interval '7 days', :adminA, now(), null);

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- This file's functions.
create function pg_temp.is_ours(p oid) returns boolean language sql stable as $$
  select exists (select 1 from pg_proc x
                  where x.oid = p and x.pronamespace = 'public'::regnamespace
                    and (x.proname like 'org\_polic%' or x.proname like '\_org\_polic%'));
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
-- security_invariants INV-25 over this file's functions: its conditions, its strip pass and its gate words,
-- word for word. The names it would report.
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

-- Runs one statement that returns one jsonb value as p_role (authenticated by default), signed in as p_user
-- with the session level p_aal: its answer, or {"error": SQLSTATE, "hint", "detail"}. Nothing it raises
-- stops the file; what it wrote stays (use pg_temp.try_as to undo).
create function pg_temp.as_(p_user uuid, p_sql text, p_aal text default 'aal1', p_role text default 'authenticated')
returns jsonb language plpgsql as $$
declare
  v jsonb; s text; h text; d text;
begin
  perform set_config('request.jwt.claims',
    case when p_role = 'anon' then json_build_object('role', 'anon')::text
         else json_build_object('sub', p_user, 'role', p_role, 'aal', p_aal)::text end, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql into v;
    reset role;
  exception when others then
    get stacked diagnostics s = returned_sqlstate, h = pg_exception_hint, d = pg_exception_detail;
    if h like 'Grant the required privileges%' then h := null; end if;
    v := jsonb_build_object('error', s, 'hint', nullif(h, ''), 'detail', nullif(d, ''));
  end;
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;
-- 'ok' or 'SQLSTATE|hint' for an answer of pg_temp.as_.
create function pg_temp.err(p jsonb) returns text language sql immutable as $$
  select case when jsonb_typeof(p) = 'object' and p ? 'error'
              then (p ->> 'error') || coalesce('|' || (p ->> 'hint'), '') else 'ok' end;
$$;
-- Runs a statement as p_role ('postgres' for the tables' owner) and undoes it: 'ok', or 'SQLSTATE|hint:constraint'.
create function pg_temp.try_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare
  s text; h text; c text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role)::text, true);
  begin
    if p_role <> 'postgres' then
      execute format('set local role %I', p_role);
    end if;
    execute p_sql;
    raise exception 'pg_temp.try_as: undone';
  exception when others then
    get stacked diagnostics s = returned_sqlstate, h = pg_exception_hint, c = constraint_name;
    -- This platform adds a "Grant the required privileges ..." hint to a privilege refusal: not a hint of ours.
    if h like 'Grant the required privileges%' then h := null; end if;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm = 'pg_temp.try_as: undone' then
      return 'ok';
    end if;
    return s || coalesce('|' || nullif(h, ''), '') || coalesce(':' || nullif(c, ''), '');
  end;
end;
$$;

-- Named ids (policies and versions) made during the file.
create temporary table ids (k text primary key, v uuid not null);
create function pg_temp.id(p_k text) returns uuid language sql stable as $$ select v from ids where k = p_k $$;
create function pg_temp.keep(p_k text, p_v uuid) returns uuid language sql as $$
  insert into ids (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v returning v;
$$;

-- The calls, each through pg_temp.as_.
create function pg_temp.save(p_actor uuid, p_org uuid, p_policy uuid, p_kind text, p_title text, p_body text)
returns jsonb language sql as $$
  select pg_temp.as_(p_actor, format('select public.org_policy_save_draft(%L::uuid, %L::uuid, %L, %L, %L)',
                                     p_org, p_policy, p_kind, p_title, p_body));
$$;
-- The draft's hash, read as the owner (what an admin's page holds).
create function pg_temp.draft_hash(p_policy uuid) returns text language sql stable as $$
  select text_hash from public.org_policy_versions where policy_id = p_policy and published_at is null;
$$;
create function pg_temp.pub(p_actor uuid, p_policy uuid, p_change text, p_hash text default 'draft')
returns jsonb language sql as $$
  select pg_temp.as_(p_actor, format('select public.org_policy_publish(%L::uuid, %L, %L)', p_policy, p_change,
                                     case when p_hash = 'draft' then pg_temp.draft_hash(p_policy) else p_hash end));
$$;
-- A published version's id, by number.
create function pg_temp.ver(p_policy uuid, p_number integer) returns uuid language sql stable as $$
  select id from public.org_policy_versions where policy_id = p_policy and version_number = p_number;
$$;
create function pg_temp.ack(p_actor uuid, p_version uuid, p_method text default 'web', p_aal text default 'aal1',
                            p_hash text default 'version')
returns jsonb language sql as $$
  select pg_temp.as_(p_actor, format('select public.org_policy_acknowledge(%L::uuid, %L, %L)', p_version,
                                     case when p_hash = 'version'
                                          then (select text_hash from public.org_policy_versions where id = p_version)
                                          else p_hash end,
                                     p_method), p_aal);
$$;
create function pg_temp.fn1(p_actor uuid, p_fn text, p_policy uuid) returns jsonb language sql as $$
  select pg_temp.as_(p_actor, format('select public.%I(%L::uuid)', p_fn, p_policy));
$$;
create function pg_temp.txt(p_actor uuid, p_policy uuid, p_number integer default null) returns jsonb language sql as $$
  select pg_temp.as_(p_actor, format('select public.org_policy_text(%L::uuid, %L::integer)', p_policy, p_number));
$$;
-- A table function's rows as one jsonb array.
create function pg_temp.rows_of(p_actor uuid, p_fn text, p_arg uuid) returns jsonb language sql as $$
  select pg_temp.as_(p_actor, format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I(%L::uuid) x',
                                     p_fn, p_arg));
$$;
create function pg_temp.claim(p_limit integer default 200) returns jsonb language sql as $$
  select pg_temp.as_(null, format('select public.org_policy_reminders_claim(%L::integer)', p_limit), 'aal1', 'service_role');
$$;
-- The user ids of a jsonb array of objects (key user_id), sorted, as text.
create function pg_temp.users_of(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(e ->> 'user_id', ',' order by e ->> 'user_id'), '')
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) e;
$$;
-- The same for a list of ids.
create function pg_temp.ids_text(p uuid[]) returns text language sql immutable as $$
  select coalesce(string_agg(u::text, ',' order by u::text), '') from unnest(p) u;
$$;
-- A jsonb array of plain values, sorted, as text.
create function pg_temp.arr_text(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(e #>> '{}', ',' order by e #>> '{}'), '')
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) e;
$$;
-- One field of the row of a jsonb array whose key k is v.
create function pg_temp.pick(p jsonb, p_key text, p_val text) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) e
   where e ->> p_key = p_val limit 1;
$$;
-- The acknowledgement rows, as one md5 (every column).
create function pg_temp.acks_md5() returns text language sql stable as $$
  select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from public.org_policy_acknowledgements a;
$$;
-- The current members of A at publish time, sorted (0422's rule: not disabled, act-as seats or invitations).
create function pg_temp.current_a() returns text language sql immutable as $$
  select 'a0482000-0000-0000-0000-0000000000c1,a0482000-0000-0000-0000-0000000000c2,a0482000-0000-0000-0000-0000000000c3,'
      || 'a0482000-0000-0000-0000-0000000000c4,a0482000-0000-0000-0000-0000000000c6,a0482000-0000-0000-0000-0000000000c7,'
      || 'a0482000-0000-0000-0000-0000000000c8,a0482000-0000-0000-0000-0000000000c9,a0482000-0000-0000-0000-0000000000ca,'
      || 'a0482000-0000-0000-0000-0000000000cb,a0482000-0000-0000-0000-0000000000cc,a0482000-0000-0000-0000-0000000000cd,'
      || 'a0482000-0000-0000-0000-0000000000d6';
$$;

-- The made-up texts.
\set t1 '\'Acceptable use\''
\set b1 '\'# Purpose\nThis policy says how we use the app.\n\n- Use only your own account.\n- Lock your device.\''

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select columns_are('public', 'org_policies',
  array['id', 'organization_id', 'kind', 'title', 'status', 'current_version', 'first_published_at', 'retired_at',
        'last_remind_now_at', 'created_at', 'updated_at'],
  '0482/5: org_policies has exactly its designed columns');
select columns_are('public', 'org_policy_versions',
  array['id', 'organization_id', 'policy_id', 'kind', 'title', 'body', 'text_hash', 'version_number', 'needs_acknowledgement',
        'acknowledgement_round', 'published_at', 'published_by', 'published_by_name', 'created_at', 'updated_at'],
  '0482/6: org_policy_versions has exactly its designed columns');
select columns_are('public', 'org_policy_acknowledgements',
  array['id', 'organization_id', 'policy_id', 'version_id', 'version_number', 'acknowledgement_round', 'text_hash',
        'user_id', 'user_name', 'member_since', 'method', 'acknowledged_at'],
  '0482/7: org_policy_acknowledgements has exactly its designed columns (no email, no address, no device)');
select columns_are('public', 'org_policy_reminders',
  array['id', 'organization_id', 'policy_id', 'round_version_id', 'user_id', 'sent_count', 'last_sent_at',
        'manual_count', 'last_reminded_at', 'correction_notice_number', 'correction_noticed_at'],
  '0482/8: org_policy_reminders has exactly its designed columns');

-- Every foreign key of the four tables: name, columns, referenced table and columns, ON DELETE.
select is(
  (select string_agg(c.conrelid::regclass::text || ' ' || c.conname || ' (' ||
            (select string_agg(a.attname, ',' order by k.n) from unnest(c.conkey) with ordinality k(attnum, n)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) || ') -> ' ||
            c.confrelid::regclass::text || ' (' ||
            (select string_agg(a.attname, ',' order by k.n) from unnest(c.confkey) with ordinality k(attnum, n)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) || ') on delete ' ||
            c.confdeltype::text, E'\n' order by c.conrelid::regclass::text, c.conname)
     from pg_constraint c
    where c.contype = 'f'
      and c.conrelid in ('public.org_policies'::regclass, 'public.org_policy_versions'::regclass,
                         'public.org_policy_acknowledgements'::regclass, 'public.org_policy_reminders'::regclass)),
  'org_policies org_policies_organization_id_fkey (organization_id) -> organizations (id) on delete c' || E'\n' ||
  'org_policy_acknowledgements org_policy_acknowledgements_user_id_fkey (user_id) -> user_profiles (id) on delete n' || E'\n' ||
  'org_policy_acknowledgements org_policy_acknowledgements_version_fkey (version_id,policy_id,organization_id) -> org_policy_versions (id,policy_id,organization_id) on delete c' || E'\n' ||
  'org_policy_reminders org_policy_reminders_user_id_fkey (user_id) -> user_profiles (id) on delete c' || E'\n' ||
  'org_policy_reminders org_policy_reminders_version_fkey (round_version_id,policy_id,organization_id) -> org_policy_versions (id,policy_id,organization_id) on delete c' || E'\n' ||
  'org_policy_versions org_policy_versions_policy_fkey (policy_id,organization_id) -> org_policies (id,organization_id) on delete c' || E'\n' ||
  'org_policy_versions org_policy_versions_published_by_fkey (published_by) -> user_profiles (id) on delete n',
  '0482/9: the foreign keys: the organization cascades, an account deletion empties the person of a record (SET NULL) and removes a reminder row, the versions and their records follow the policy by organization');

select is(
  (select string_agg(c.conrelid::regclass::text || ':' || c.contype::text || ':' || c.conname, ',' order by c.conrelid::regclass::text, c.contype, c.conname)
     from pg_constraint c
    where c.contype in ('c', 'u', 'p')
      and c.conrelid in ('public.org_policies'::regclass, 'public.org_policy_versions'::regclass,
                         'public.org_policy_acknowledgements'::regclass, 'public.org_policy_reminders'::regclass)),
  'org_policies:c:org_policies_current_version,org_policies:c:org_policies_first_published,org_policies:c:org_policies_kind,'
  'org_policies:c:org_policies_remind_now,org_policies:c:org_policies_retired,org_policies:c:org_policies_status,'
  'org_policies:c:org_policies_title,org_policies:p:org_policies_pkey,org_policies:u:org_policies_id_organization_key,'
  'org_policy_acknowledgements:c:org_policy_acknowledgements_method,org_policy_acknowledgements:c:org_policy_acknowledgements_name,'
  'org_policy_acknowledgements:c:org_policy_acknowledgements_numbers,'
  'org_policy_acknowledgements:c:org_policy_acknowledgements_text_hash,org_policy_acknowledgements:p:org_policy_acknowledgements_pkey,'
  'org_policy_acknowledgements:u:org_policy_acknowledgements_once,'
  'org_policy_reminders:c:org_policy_reminders_correction_notice,'
  'org_policy_reminders:c:org_policy_reminders_last,org_policy_reminders:c:org_policy_reminders_manual,'
  'org_policy_reminders:c:org_policy_reminders_sent,org_policy_reminders:p:org_policy_reminders_pkey,'
  'org_policy_reminders:u:org_policy_reminders_once,'
  'org_policy_versions:c:org_policy_versions_body,org_policy_versions:c:org_policy_versions_kind,'
  'org_policy_versions:c:org_policy_versions_number,'
  'org_policy_versions:c:org_policy_versions_published,org_policy_versions:c:org_policy_versions_publisher,'
  'org_policy_versions:c:org_policy_versions_publisher_name,org_policy_versions:c:org_policy_versions_round,'
  'org_policy_versions:c:org_policy_versions_text_hash,org_policy_versions:c:org_policy_versions_title,'
  'org_policy_versions:p:org_policy_versions_pkey,org_policy_versions:u:org_policy_versions_key,'
  'org_policy_versions:u:org_policy_versions_number_key',
  '0482/10: the checks, keys and unique constraints, by name');

select is(
  (select string_agg(indexrelid::regclass::text, ',' order by indexrelid::regclass::text)
     from pg_index
    where indrelid in ('public.org_policies'::regclass, 'public.org_policy_versions'::regclass,
                       'public.org_policy_acknowledgements'::regclass, 'public.org_policy_reminders'::regclass)
      and not indisprimary
      and indexrelid not in (select conindid from pg_constraint where contype = 'u')),
  'org_policies_organization_idx,org_policy_acknowledgements_round_idx,org_policy_acknowledgements_user_idx,'
  'org_policy_reminders_user_idx,org_policy_versions_one_draft,org_policy_versions_published_by_idx',
  '0482/11: the indexes (one draft per policy; the reads and the account deletion''s key actions)');
select is((select pg_get_indexdef('public.org_policy_versions_one_draft'::regclass)),
  'CREATE UNIQUE INDEX org_policy_versions_one_draft ON public.org_policy_versions USING btree (policy_id) WHERE (published_at IS NULL)',
  '0482/12: at most one draft per policy');

-- Every trigger on the four tables, with when it fires and what it runs.
select is(
  (select string_agg(t.tgrelid::regclass::text || ' ' || t.tgname || ' ' ||
            case when t.tgtype & 2 = 2 then 'before' else 'after' end || ' ' ||
            concat_ws('/', case when t.tgtype & 4 = 4 then 'insert' end, case when t.tgtype & 16 = 16 then 'update' end,
                           case when t.tgtype & 8 = 8 then 'delete' end, case when t.tgtype & 32 = 32 then 'truncate' end) || ' ' ||
            case when t.tgtype & 1 = 1 then 'row' else 'statement' end || ' ' || t.tgfoid::regproc::text ||
            coalesce(' args ' || nullif(encode(t.tgargs, 'escape'), ''), ''),
            E'\n' order by t.tgrelid::regclass::text, t.tgname)
     from pg_trigger t
    where not t.tgisinternal
      and t.tgrelid in ('public.org_policies'::regclass, 'public.org_policy_versions'::regclass,
                        'public.org_policy_acknowledgements'::regclass, 'public.org_policy_reminders'::regclass)),
  'org_policies org_policies_guard before update/delete row _org_policies_guard' || E'\n' ||
  'org_policies org_policies_no_truncate before truncate statement _org_policy_refuse_truncate' || E'\n' ||
  'org_policy_acknowledgements org_policy_acknowledgements_guard before insert/update/delete row _org_policy_acknowledgements_guard' || E'\n' ||
  'org_policy_acknowledgements org_policy_acknowledgements_no_truncate before truncate statement _org_policy_refuse_truncate' || E'\n' ||
  'org_policy_versions org_policy_versions_guard before insert/update/delete row _org_policy_versions_guard' || E'\n' ||
  'org_policy_versions org_policy_versions_no_truncate before truncate statement _org_policy_refuse_truncate',
  '0482/13: the guards on every table that holds evidence, and TRUNCATE refused; no deleted_users marker (a person column is empty only after its account''s deletion)');

select is(
  (select string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity, ',' order by c.relname)
     from pg_class c where c.oid in ('public.org_policies'::regclass, 'public.org_policy_versions'::regclass,
                                     'public.org_policy_acknowledgements'::regclass, 'public.org_policy_reminders'::regclass))
  || ' policies:' || (select count(*) from pg_policy where polrelid in ('public.org_policies'::regclass,
       'public.org_policy_versions'::regclass, 'public.org_policy_acknowledgements'::regclass, 'public.org_policy_reminders'::regclass)),
  'org_policies:true:false,org_policy_acknowledgements:true:false,org_policy_reminders:true:false,org_policy_versions:true:false policies:0',
  '0482/14: row security on for all four, with no policy (every read goes through a function)');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select is(
  (select string_agg(t || '=' || array_to_string(pg_temp.table_grants(('public.' || t)::regclass), ' '), ', ' order by t)
     from unnest(array['org_policies', 'org_policy_versions', 'org_policy_acknowledgements', 'org_policy_reminders']) t),
  'org_policies=service_role:SELECT, org_policy_acknowledgements=service_role:SELECT, org_policy_reminders=service_role:SELECT, org_policy_versions=service_role:SELECT',
  '0482/15: the tables'' grants: service_role SELECT and nothing else, for anon, authenticated and PUBLIC nothing');

select is(
  (select coalesce(string_agg(r || ':' || t || ':' || p, ', ' order by r, t, p), 'none')
     from unnest(array['anon', 'authenticated', 'service_role', 'public']) r,
          unnest(array['org_policies', 'org_policy_versions', 'org_policy_acknowledgements', 'org_policy_reminders']) t,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    where has_table_privilege(r, 'public.' || t, p)),
  'service_role:org_policies:SELECT, service_role:org_policy_acknowledgements:SELECT, service_role:org_policy_reminders:SELECT, service_role:org_policy_versions:SELECT',
  '0482/16: every table privilege of every API role and PUBLIC, by has_table_privilege: only service_role''s SELECT');

select is(
  (select string_agg(p.oid::regprocedure::text || '=' || array_to_string(pg_temp.grants_of(p.oid), ' '), E'\n' order by p.oid::regprocedure::text)
     from pg_proc p where pg_temp.is_ours(p.oid)),
  '_org_policies_guard()=' || E'\n' ||
  '_org_policy_acknowledgements_guard()=' || E'\n' ||
  '_org_policy_body_problem(text)=' || E'\n' ||
  '_org_policy_caller_is_act_as(uuid)=' || E'\n' ||
  '_org_policy_person_name(uuid)=' || E'\n' ||
  '_org_policy_refuse_truncate()=' || E'\n' ||
  '_org_policy_title_problem(text)=' || E'\n' ||
  '_org_policy_versions_guard()=' || E'\n' ||
  'org_policies_for_admin(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policies_for_member(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_acknowledge(uuid,text,text)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_acknowledgement_record(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_correction_notices_claim(integer)=service_role:EXECUTE' || E'\n' ||
  'org_policy_discard_draft(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_draft(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_publish(uuid,text,text)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_remind_now(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_reminders_claim(integer)=service_role:EXECUTE' || E'\n' ||
  'org_policy_retire(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_save_draft(uuid,uuid,text,text,text)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_status(uuid)=authenticated:EXECUTE' || E'\n' ||
  'org_policy_text(uuid,integer)=authenticated:EXECUTE',
  '0482/17: every function''s grants: authenticated the twelve member and admin functions, service_role the two claims only, nobody the helpers and the trigger functions, PUBLIC and anon nothing');

select is(
  (select coalesce(string_agg(r || ':' || p.proname, ', ' order by r, p.proname), 'none')
     from pg_proc p, unnest(array['anon', 'public', 'authenticated', 'service_role']) r
    where pg_temp.is_ours(p.oid) and has_function_privilege(r, p.oid, 'execute')
      and not (r = 'authenticated' and p.proname not like '\_%'
               and p.proname not in ('org_policy_reminders_claim', 'org_policy_correction_notices_claim'))
      and not (r = 'service_role' and p.proname in ('org_policy_reminders_claim', 'org_policy_correction_notices_claim'))),
  'none',
  '0482/18: by has_function_privilege: anon and PUBLIC execute none of them, service_role none but the two claims, authenticated not a claim, a helper or a trigger function');

select is(
  (select string_agg(p.proname || ':' || case when p.prosecdef then 'definer' else 'invoker' end || ':' ||
            pg_get_userbyid(p.proowner) || ':' ||
            coalesce((select string_agg(c, ' ' order by c) from unnest(p.proconfig) c), ''), E'\n' order by p.proname)
     from pg_proc p where pg_temp.is_ours(p.oid)),
  '_org_policies_guard:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_acknowledgements_guard:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_body_problem:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_caller_is_act_as:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_person_name:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_refuse_truncate:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_title_problem:invoker:postgres:search_path=""' || E'\n' ||
  '_org_policy_versions_guard:invoker:postgres:search_path=""' || E'\n' ||
  'org_policies_for_admin:definer:postgres:search_path=""' || E'\n' ||
  'org_policies_for_member:definer:postgres:search_path=""' || E'\n' ||
  'org_policy_acknowledge:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_acknowledgement_record:definer:postgres:search_path=""' || E'\n' ||
  'org_policy_correction_notices_claim:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_discard_draft:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_draft:definer:postgres:search_path=""' || E'\n' ||
  'org_policy_publish:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_remind_now:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_reminders_claim:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_retire:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_save_draft:definer:postgres:lock_timeout=2s search_path=""' || E'\n' ||
  'org_policy_status:definer:postgres:search_path=""' || E'\n' ||
  'org_policy_text:definer:postgres:search_path=""',
  '0482/19: who runs each function, its owner, a pinned empty search_path for all and the writers'' own 2 s lock_timeout');

select is(pg_temp.inv25_names(), '',
  '0482/20: security_invariants INV-25 names none of them: every function authenticated may execute gates in its body');

select is(pg_get_function_identity_arguments('public.org_policy_acknowledge(uuid,text,text)'::regprocedure),
  'p_version_id uuid, p_text_hash text, p_method text',
  '0482/21: the acknowledgement takes no account: it is always for the caller''s own');

-- Signed out (anon) every function is refused by its grant; signed in with no account, by its gate.
select is(
  (select string_agg(f || '=' || pg_temp.err(pg_temp.as_(null, format('select to_jsonb(x) from %s x limit 1', f), 'aal1', 'anon')), ', ' order by f)
     from unnest(array[
       'public.org_policies_for_member(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_text(''a0482000-0000-0000-0000-0000000000a1''::uuid, null)',
       'public.org_policy_acknowledge(''a0482000-0000-0000-0000-0000000000a1''::uuid, repeat(''a'', 64), ''web'')',
       'public.org_policies_for_admin(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_status(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_acknowledgement_record(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_save_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid, null, ''other'', ''T'', ''B'')',
       'public.org_policy_discard_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_publish(''a0482000-0000-0000-0000-0000000000a1''::uuid, ''new_version'', repeat(''a'', 64))',
       'public.org_policy_retire(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_remind_now(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_reminders_claim(1)']) f),
  (select string_agg(f || '=42501', ', ' order by f)
     from unnest(array[
       'public.org_policies_for_member(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_text(''a0482000-0000-0000-0000-0000000000a1''::uuid, null)',
       'public.org_policy_acknowledge(''a0482000-0000-0000-0000-0000000000a1''::uuid, repeat(''a'', 64), ''web'')',
       'public.org_policies_for_admin(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_status(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_acknowledgement_record(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_save_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid, null, ''other'', ''T'', ''B'')',
       'public.org_policy_discard_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_publish(''a0482000-0000-0000-0000-0000000000a1''::uuid, ''new_version'', repeat(''a'', 64))',
       'public.org_policy_retire(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_remind_now(''a0482000-0000-0000-0000-0000000000a1''::uuid)',
       'public.org_policy_reminders_claim(1)']) f),
  '0482/22: signed out (anon), every function is refused (42501, permission denied)');

select is(
  pg_temp.err(pg_temp.as_(null, 'select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.org_policies_for_member(''a0482000-0000-0000-0000-0000000000a1''::uuid) x'))
  || ' ' || pg_temp.err(pg_temp.as_(null, 'select public.org_policy_acknowledge(''a0482000-0000-0000-0000-0000000000a1''::uuid, repeat(''a'', 64), ''web'')'))
  || ' ' || pg_temp.err(pg_temp.as_(null, 'select public.org_policy_save_draft(''a0482000-0000-0000-0000-0000000000a1''::uuid, null, ''other'', ''T'', ''B'')'))
  || ' ' || pg_temp.err(pg_temp.as_(null, 'select public.org_policy_reminders_claim(1)')),
  '42501|policy_not_allowed 42501|policy_not_allowed 42501|policy_admins_only 42501',
  '0482/23: an authenticated call with no account is refused by each gate; the claim stays refused by its grant');

-- The claim's second lock: granted to authenticated and anon inside a savepoint, it still refuses both.
savepoint claim_grant;
grant execute on function public.org_policy_reminders_claim(integer) to authenticated, anon;
select is(
  pg_temp.err(pg_temp.as_(:ownerA, 'select public.org_policy_reminders_claim(1)'))
  || ' ' || pg_temp.err(pg_temp.as_(null, 'select public.org_policy_reminders_claim(1)', 'aal1', 'anon')),
  '42501|policy_not_allowed 42501|policy_not_allowed',
  '0482/24: even with EXECUTE, the claim refuses a signed-in member and a signed-out caller (the role setting)');
rollback to savepoint claim_grant;

select is(
  (select count(*)::integer from pg_proc p where p.prosrc like '%4820001%'),
  1, '0482/25: one function names the advisory lock key 4820001 (the claim)');

-- ── 3. The text rules (the same as packages/core policy-text.ts) ────────────
select is(
  (select string_agg(coalesce(public._org_policy_title_problem(t), 'ok'), ',' order by n)
     from unnest(array[
       null, '', 'Acceptable use', repeat('t', 120), repeat('t', 121), repeat(chr(128512), 120),
       'a' || chr(10) || 'b', 'a  b', ' a', 'a ', 'Cafe' || chr(769), 'Caf' || chr(233),
       'a' || chr(13) || 'b', 'a' || chr(9) || 'b', 'a' || chr(8203) || 'b', 'Data handling, “policy” — v2'
     ]) with ordinality u(t, n)),
  'empty,empty,ok,ok,too_long,ok,not_normal_form,not_normal_form,not_normal_form,not_normal_form,not_normal_form,ok,'
  'forbidden_character,forbidden_character,forbidden_character,ok',
  '0482/26: a title: 1 to 120 characters (counted as code points), one line, single spaces, trimmed, NFC, no refused character');

select is(
  (select string_agg(coalesce(public._org_policy_body_problem(t), 'ok'), ',' order by n)
     from unnest(array[
       null, '', 'One line.', repeat('b', 30000), repeat('b', 30001),
       'a ' || chr(10) || 'b', 'a ', 'a' || chr(10) || chr(10) || chr(10) || 'b', chr(10) || 'a', 'a' || chr(10),
       'e' || chr(769), ' ', 'a' || chr(10) || chr(10) || 'b', '  indented' || chr(10) || '- item',
       'a' || chr(13) || chr(10) || 'b', 'a' || chr(9) || 'b', 'a' || chr(8238) || 'b', 'a' || chr(160) || 'b'
     ]) with ordinality u(t, n)),
  'empty,empty,ok,ok,too_long,not_normal_form,not_normal_form,not_normal_form,not_normal_form,not_normal_form,'
  'not_normal_form,not_normal_form,ok,ok,forbidden_character,forbidden_character,forbidden_character,ok',
  '0482/27: a body: 1 to 30,000 characters, LF line ends, no space at a line''s end, at most one empty line in a row, none at either end, NFC, no refused character');

-- Every refused range, at both ends, in a title and a body; the code point on either side is allowed.
select is(
  (select coalesce(string_agg(to_hex(cp) || ':' || coalesce(public._org_policy_title_problem('a' || chr(cp) || 'b'), 'ok')
                              || '/' || coalesce(public._org_policy_body_problem('a' || chr(cp) || 'b'), 'ok'), ' ' order by cp), '')
     from unnest(array[1, 9, 11, 31, 127, 159, 173, 1564, 6158, 8203, 8207, 8232, 8238, 8288, 8292, 8294, 8303,
                       65279, 65529, 65535, 917504, 917631, 917760, 917999]) cp
    where coalesce(public._org_policy_title_problem('a' || chr(cp) || 'b'), 'ok') <> 'forbidden_character'
       or coalesce(public._org_policy_body_problem('a' || chr(cp) || 'b'), 'ok') <> 'forbidden_character'),
  '',
  '0482/28: every refused range is refused at both of its ends, in a title and in a body');
select is(
  (select string_agg(to_hex(cp) || ':' || coalesce(public._org_policy_body_problem('a' || chr(cp) || 'b'), 'ok'), ' ' order by cp)
     from unnest(array[32, 126, 160, 172, 174, 1563, 1565, 8202, 8208, 8231, 8239, 8287, 8293, 8304, 65278, 65280,
                       65528, 65536, 917503, 917632, 917759, 918000]) cp),
  '20:ok 7e:ok a0:ok ac:ok ae:ok 61b:ok 61d:ok 200a:ok 2010:ok 2027:ok 202f:ok 205f:ok 2065:ok 2070:ok fefe:ok ff00:ok '
  'fff8:ok 10000:ok dffff:ok e0080:ok e00ff:ok e01f0:ok',
  '0482/29: the code points beside each refused range are allowed');

-- ── 4. Drafts and publishing ────────────────────────────────────────────────
-- Each refusal of the text, with its detail word.
select is(
  (select string_agg(coalesce(r ->> 'error', 'ok') || '|' || coalesce(r ->> 'hint', '') || '|' || coalesce(r ->> 'detail', ''), ' ' order by n)
     from (values
       (1, pg_temp.save(:adminA, :orgA, null, 'security', 'T', 'B')),
       (2, pg_temp.save(:adminA, :orgA, null, 'other', '', 'B')),
       (3, pg_temp.save(:adminA, :orgA, null, 'other', 'a  b', 'B')),
       (4, pg_temp.save(:adminA, :orgA, null, 'other', repeat('t', 121), 'B')),
       (5, pg_temp.save(:adminA, :orgA, null, 'other', 'T', 'a' || chr(8238) || 'b')),
       (6, pg_temp.save(:adminA, :orgA, null, 'other', 'T', repeat('b', 30001))),
       (7, pg_temp.save(:adminA, :orgA, null, 'other', 'T', 'a' || chr(13) || chr(10) || 'b')),
       (8, pg_temp.save(:adminA, :orgA, null, 'other', 'T', 'a' || chr(10) || chr(10) || chr(10) || 'b')),
       (9, pg_temp.save(:adminA, :orgA, null, 'other', 'T', null)),
       (10, pg_temp.save(:adminA, :orgA, null, null, 'T', 'B'))) v(n, r)),
  '22023|policy_kind_invalid| 22023|policy_title_invalid|empty 22023|policy_title_invalid|not_normal_form '
  '22023|policy_title_invalid|too_long 22023|policy_body_invalid|forbidden_character 22023|policy_body_invalid|too_long '
  '22023|policy_body_invalid|forbidden_character 22023|policy_body_invalid|not_normal_form 22023|policy_body_invalid|empty '
  '22023|policy_kind_invalid|',
  '0482/30: a draft with a wrong kind, title or body is refused (22023), the detail naming the core''s word');
select is((select count(*)::integer from public.org_policies), 0, '0482/31: and nothing was written');

-- Who may write a draft: owners and admins, nobody else; a live act-as seat is an owner seat that reads and never writes (S7).
select is(
  (select string_agg(n || '=' || pg_temp.try_as('authenticated', u::uuid,
            format('select public.org_policy_save_draft(%L::uuid, null, ''other'', ''T'', ''B'')', 'a0482000-0000-0000-0000-0000000000a1')),
            ', ' order by n)
     from (values ('1 owner', :ownerA), ('2 admin', :adminA), ('3 live act-as seat', :actas), ('4 manager', :managerA),
                  ('5 staff', :memberA), ('6 viewer', :viewerA), ('7 disabled admin', :disabledAdmin),
                  ('8 expired act-as seat', :actasOld), ('9 not accepted', :invitedA), ('a outsider', :outsider),
                  ('b owner of B', :ownerB)) v(n, u)),
  '1 owner=ok, 2 admin=ok, 3 live act-as seat=42501|policy_act_as_read_only, 4 manager=42501|policy_admins_only, 5 staff=42501|policy_admins_only, '
  '6 viewer=42501|policy_admins_only, 7 disabled admin=42501|policy_admins_only, 8 expired act-as seat=42501|policy_admins_only, '
  '9 not accepted=42501|policy_admins_only, a outsider=42501|policy_admins_only, b owner of B=42501|policy_admins_only',
  '0482/32: an owner and an admin may write a draft; a live act-as seat is refused as read-only; a manager, staff, a viewer, a disabled admin, an expired seat, an invitation, an outsider and another organization''s owner may not');

select pg_temp.keep('p1', (pg_temp.save(:adminA, :orgA, null, 'acceptable_use', :t1, :b1) ->> 'policy_id')::uuid);
select pg_temp.keep('p6', (pg_temp.save(:adminA, :orgA, null, 'other', 'Smoke policy',
                           '# Heading' || chr(10) || 'A line.' || chr(10) || chr(10) || '- one' || chr(10) || '- two') ->> 'policy_id')::uuid);
select is(
  (select status || '|' || kind || '|' || title || '|' || coalesce(current_version::text, 'none') || '|' || organization_id
     from public.org_policies where id = pg_temp.id('p1')),
  'draft|acceptable_use|Acceptable use|none|a0482000-0000-0000-0000-0000000000a1',
  '0482/33: a new policy is a draft with no version');
select is(pg_temp.draft_hash(pg_temp.id('p6')),
  '12a02b3a7236cb1ea4d72b177819ae0b14d29ef9ed9ca567134a31a320e8ebe3',
  '0482/34: the hash of the words is the value packages/core policyTextHash gives for the same made-up text (policy-hash.test.ts)');

select is(
  pg_temp.rows_of(:memberA, 'org_policies_for_member', :orgA)::text || ' ' ||
  pg_temp.err(pg_temp.txt(:memberA, pg_temp.id('p1'))) || ' ' ||
  pg_temp.err(pg_temp.txt(:adminA, pg_temp.id('p1'))) || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_draft', pg_temp.id('p1')) -> 'draft' ->> 'body' = :b1)::text || ' ' ||
  coalesce(pg_temp.fn1(:adminA, 'org_policy_draft', pg_temp.id('p1')) ->> 'current', 'no current') || ' ' ||
  pg_temp.err(pg_temp.fn1(:managerA, 'org_policy_draft', pg_temp.id('p1'))),
  '[] 42501|policy_not_allowed P0001|policy_not_published true no current 42501|policy_admins_only',
  '0482/35: a draft is the admins'' alone: no member lists or reads it; an admin reads it through org_policy_draft');

select is(
  pg_temp.err(pg_temp.save(:adminA, :orgB, pg_temp.id('p1'), 'other', 'T', 'B')) || ' ' ||
  pg_temp.err(pg_temp.save(:ownerB, :orgB, pg_temp.id('p1'), 'other', 'T', 'B')) || ' ' ||
  pg_temp.err(pg_temp.save(:adminA, :orgA, 'a0482000-0000-0000-0000-000000000999', 'other', 'T', 'B')),
  '42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only',
  '0482/36: a draft is saved only in its own organization, by its admins; an unknown policy is refused the same way');

select is(
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policy_versions (organization_id, policy_id, kind, title, body, text_hash) values (%L, %L, ''other'', ''T'', ''B'', repeat(''0'', 64))',
    'a0482000-0000-0000-0000-0000000000a1', pg_temp.id('p1'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policy_versions (organization_id, policy_id, kind, title, body, text_hash) values (%L, %L, ''other'', ''T'', ''B'', encode(sha256(convert_to(''T'' || E''\n\n'' || ''B'', ''UTF8'')), ''hex''))',
    'a0482000-0000-0000-0000-0000000000a1', pg_temp.id('p1'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policy_versions (organization_id, policy_id, kind, title, body, text_hash) values (%L, %L, ''other'', ''T'', ''B'', encode(sha256(convert_to(''T'' || E''\n\n'' || ''B'', ''UTF8'')), ''hex''))',
    'a0482000-0000-0000-0000-0000000000a1', 'a0482000-0000-0000-0000-000000000999')) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policy_versions (organization_id, policy_id, kind, title, body, text_hash) values (%L, %L, ''other'', ''T'', ''B '', encode(sha256(convert_to(''T'' || E''\n\n'' || ''B '', ''UTF8'')), ''hex''))',
    'a0482000-0000-0000-0000-0000000000a1', pg_temp.id('p6'))),
  '23514:org_policy_versions_text_hash 23505:org_policy_versions_one_draft 23503:org_policy_versions_policy_fkey 23514:org_policy_versions_body',
  '0482/37: even the tables'' owner cannot store a hash that is not of the words, a second draft, a version of no policy, or words out of normal form');

-- Publishing.
select is(
  pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), 'correction')) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), 'new_version', repeat('0', 64))) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), 'minor')) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), 'new_version', 'not a hash')) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), null)) || ' ' ||
  pg_temp.err(pg_temp.pub(:managerA, pg_temp.id('p1'), 'new_version')) || ' ' ||
  pg_temp.err(pg_temp.pub(:ownerB, pg_temp.id('p1'), 'new_version')) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminA, 'a0482000-0000-0000-0000-000000000999', 'new_version')),
  'P0001|policy_correction_needs_a_version P0001|policy_draft_changed 22023|policy_change_invalid 22023|policy_hash_invalid '
  '22023|policy_change_invalid 42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only',
  '0482/38: the first publish is a version; the hash must be the draft''s; the change and the hash are checked; only the organization''s admins publish');

create temporary table answers (k text primary key, v jsonb);
insert into answers values ('p1v1', pg_temp.pub(:adminA, pg_temp.id('p1'), 'new_version'));
select pg_temp.keep('p1v1', (select (v ->> 'version_id')::uuid from answers where k = 'p1v1'));
select is(
  (select (v ->> 'version_number') || '|' || (v ->> 'needs_acknowledgement') || '|' || (v ->> 'acknowledgement_round') || '|' ||
          (v ->> 'title') || '|' || ((v ->> 'published_at')::timestamptz = now())::text from answers where k = 'p1v1'),
  '1|true|1|Acceptable use|true',
  '0482/39: the first publish makes version 1, which asks (round 1)');
select is((select pg_temp.arr_text(v -> 'asked_user_ids') from answers where k = 'p1v1'), pg_temp.current_a(),
  '0482/40: it names who is asked: the current members (0422), never a disabled account, an act-as seat (live or expired) or an invitation');
select is(
  (select p.status || '|' || p.current_version || '|' || (p.first_published_at = now())::text || '|' ||
          v.published_by || '|' || v.published_by_name || '|' || (v.updated_at = now())::text
     from public.org_policies p join public.org_policy_versions v on v.policy_id = p.id and v.version_number = 1
    where p.id = pg_temp.id('p1')),
  'published|1|true|a0482000-0000-0000-0000-0000000000c2|Policy Admin A|true',
  '0482/41: the policy is published at version 1; the version names its publisher and keeps their name');
select is(pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), 'new_version', repeat('a', 64))), 'P0001|policy_no_draft',
  '0482/42: with no draft there is nothing to publish');

-- A published version never changes and is never deleted, whoever writes.
select is(
  (select string_agg(c || '=' || pg_temp.try_as('postgres', null,
            format('update public.org_policy_versions set %s where id = %L', c, pg_temp.id('p1v1'))), ', ' order by c)
     from unnest(array['title = ''Other''', 'body = ''Other''', 'text_hash = repeat(''a'', 64)', 'version_number = 9',
                       'needs_acknowledgement = false', 'acknowledgement_round = 1', 'published_at = now() - interval ''1 day''',
                       'published_by = ''a0482000-0000-0000-0000-0000000000c1''', 'published_by_name = ''Someone''',
                       'organization_id = ''a0482000-0000-0000-0000-0000000000b1''', 'updated_at = now() + interval ''1 second''',
                       'published_by = null']) c),
  (select string_agg(c || '=55000|org_policy_version_frozen', ', ' order by c)
     from unnest(array['title = ''Other''', 'body = ''Other''', 'text_hash = repeat(''a'', 64)', 'version_number = 9',
                       'needs_acknowledgement = false', 'acknowledgement_round = 1', 'published_at = now() - interval ''1 day''',
                       'published_by = ''a0482000-0000-0000-0000-0000000000c1''', 'published_by_name = ''Someone''',
                       'organization_id = ''a0482000-0000-0000-0000-0000000000b1''', 'updated_at = now() + interval ''1 second''',
                       'published_by = null']) c),
  '0482/43: no column of a published version can be changed, even by the tables'' owner (emptying the publisher while the account exists included)');
select is(
  pg_temp.try_as('postgres', null, format('delete from public.org_policy_versions where id = %L', pg_temp.id('p1v1'))) || ' ' ||
  pg_temp.try_as('postgres', null, 'truncate public.org_policy_versions cascade') || ' ' ||
  pg_temp.try_as('postgres', null, 'truncate public.org_policies cascade') || ' ' ||
  pg_temp.try_as('postgres', null, format('delete from public.org_policies where id = %L', pg_temp.id('p1'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policy_versions (organization_id, policy_id, kind, title, body, text_hash) values (%L, %L, ''other'', ''T'', ''B'', encode(sha256(convert_to(''T'' || E''\n\n'' || ''B'', ''UTF8'')), ''hex''))',
    'a0482000-0000-0000-0000-0000000000b1', pg_temp.id('p1'))),
  '55000|org_policy_version_kept 55000|org_policy_truncate_refused 55000|org_policy_truncate_refused 55000|org_policy_kept '
  '23503:org_policy_versions_policy_fkey',
  '0482/44: nor deleted or truncated; a published policy is never deleted either; a version names its policy''s own organization');
select is(
  (select string_agg(c || '=' || pg_temp.try_as('postgres', null,
            format('update public.org_policies set %s where id = %L', c, pg_temp.id('p1'))), ', ' order by c)
     from unnest(array['organization_id = ''a0482000-0000-0000-0000-0000000000b1''', 'status = ''draft''',
                       'current_version = 0', 'first_published_at = now() - interval ''1 day''', 'created_at = now() - interval ''1 day''',
                       'kind = ''other''']) c),
  'created_at = now() - interval ''1 day''=55000|org_policy_changed_wrongly, current_version = 0=55000|org_policy_changed_wrongly, '
  'first_published_at = now() - interval ''1 day''=55000|org_policy_changed_wrongly, kind = ''other''=ok, '
  'organization_id = ''a0482000-0000-0000-0000-0000000000b1''=55000|org_policy_changed_wrongly, status = ''draft''=55000|org_policy_changed_wrongly',
  '0482/45: a policy keeps its organization, its creation and first publish times; its state and version never go back (its kind may change)');
select is(
  pg_temp.try_as('postgres', null, format('update public.org_policy_versions set body = ''Changed.'', text_hash = encode(sha256(convert_to(title || E''\n\n'' || ''Changed.'', ''UTF8'')), ''hex'') where id = (select id from public.org_policy_versions where policy_id = %L)', pg_temp.id('p6'))) || ' ' ||
  pg_temp.try_as('postgres', null, format('update public.org_policy_versions set policy_id = %L where policy_id = %L', pg_temp.id('p1'), pg_temp.id('p6'))) || ' ' ||
  pg_temp.try_as('postgres', null, format('update public.org_policy_versions set version_number = 1, needs_acknowledgement = true, acknowledgement_round = 1, published_at = now() where policy_id = %L', pg_temp.id('p6'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policy_versions (organization_id, policy_id, title, body, text_hash, version_number, needs_acknowledgement, acknowledgement_round, published_at, published_by) '
    'select organization_id, id, ''T'', ''B'', encode(sha256(convert_to(''T'' || E''\n\n'' || ''B'', ''UTF8'')), ''hex''), 1, true, 1, now(), %L from public.org_policies where id = %L',
    'a0482000-0000-0000-0000-0000000000c2', pg_temp.id('p6'))) || ' ' ||
  pg_temp.try_as('postgres', null, format('delete from public.org_policy_versions where policy_id = %L', pg_temp.id('p6'))) || ' ' ||
  pg_temp.try_as('postgres', null, format('delete from public.org_policies where id = %L', pg_temp.id('p6'))),
  'ok 55000|org_policy_changed_wrongly 55000|org_policy_changed_wrongly 55000|org_policy_changed_wrongly ok ok',
  '0482/46: a draft''s words may change and a draft may be deleted, with a never-published policy; a draft never moves to another policy; a version is published only from a draft and with its publisher, even by the owner');

-- ── 5. The acknowledgement ──────────────────────────────────────────────────
-- An admin saves a draft for later; the published words stay what members see.
select pg_temp.save(:adminA, :orgA, pg_temp.id('p1'), 'acceptable_use', 'Acceptable use policy', :b1 || chr(10) || chr(10) || 'Ask an admin if unsure.');
select is(
  (select title from public.org_policies where id = pg_temp.id('p1')) || ' | ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p1')) ->> 'title') || ' | ' ||
  ((pg_temp.txt(:memberA, pg_temp.id('p1')) ->> 'body') = :b1)::text || ' | ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p1')) ->> 'version_number'),
  'Acceptable use | Acceptable use | true | 1',
  '0482/47: saving a draft of a published policy changes nothing members see');

insert into answers values ('ackA', pg_temp.ack(:memberA, pg_temp.id('p1v1')));
select is(
  (select (v ->> 'already') || '|' || (v ->> 'method') || '|' || (v ->> 'version_number') || '|' ||
          ((v ->> 'acknowledged_at')::timestamptz = now())::text || '|' || ((v ->> 'version_id')::uuid = pg_temp.id('p1v1'))::text
     from answers where k = 'ackA'),
  'false|web|1|true|true',
  '0482/48: a current member acknowledges the current version for themselves');
select is(
  (select a.user_id || '|' || a.user_name || '|' || a.method || '|' || a.version_number || '|' || a.acknowledgement_round || '|' ||
          (a.text_hash = v.text_hash)::text || '|' || (a.organization_id = v.organization_id and a.policy_id = v.policy_id)::text
     from public.org_policy_acknowledgements a join public.org_policy_versions v on v.id = a.version_id
    where a.id = (select (v ->> 'acknowledgement_id')::uuid from answers where k = 'ackA')),
  'a0482000-0000-0000-0000-0000000000c6|Policy Member A|web|1|1|true|true',
  '0482/49: the row: the caller''s own account and name as it was, the version''s number, round and hash, web');
insert into answers values ('ackA2', pg_temp.ack(:memberA, pg_temp.id('p1v1'), 'phone'));
select is(
  (select (v ->> 'already') || '|' || (v ->> 'method') || '|' ||
          ((v ->> 'acknowledgement_id') = (select w ->> 'acknowledgement_id' from answers x(kk, w) where kk = 'ackA'))::text
     from answers where k = 'ackA2') || ' rows:' ||
  (select count(*) from public.org_policy_acknowledgements where user_id = :memberA),
  'true|web|true rows:1',
  '0482/50: a repeat (from the phone) writes nothing and answers the first row');

select is(
  (select string_agg(n || '=' || pg_temp.err(pg_temp.ack(u::uuid, pg_temp.id('p1v1'))), ', ' order by n)
     from (values ('1 owner of B', :ownerB), ('2 outsider', :outsider), ('3 live act-as seat', :actas),
                  ('4 expired act-as seat', :actasOld), ('5 disabled', :disabledA), ('6 not accepted', :invitedA),
                  ('7 nobody', null)) v(n, u))
  || ' unknown=' || pg_temp.err(pg_temp.ack(:memberA, 'a0482000-0000-0000-0000-000000000999', 'web', 'aal1', repeat('a', 64))),
  '1 owner of B=42501|policy_not_allowed, 2 outsider=42501|policy_not_allowed, 3 live act-as seat=42501|policy_not_allowed, '
  '4 expired act-as seat=42501|policy_not_allowed, 5 disabled=42501|policy_not_allowed, 6 not accepted=42501|policy_not_allowed, '
  '7 nobody=42501|policy_not_allowed unknown=42501|policy_not_allowed',
  '0482/51: only a current member acknowledges: another organization''s owner, an outsider, an act-as seat, a disabled account, an invitation and nobody are refused, with the same answer as a version that does not exist');
select is(
  pg_temp.err(pg_temp.ack(:mfaA, pg_temp.id('p1v1'), 'web', 'aal1')) || ' ' ||
  pg_temp.err(pg_temp.ack(:mfaA, pg_temp.id('p1v1'), 'phone', 'aal2')),
  '42501|aal2_required ok',
  '0482/52: an account with a verified authenticator acknowledges only from a session that holds the second step (an unverified one asks nothing: 0482/48)');
insert into answers values ('a53', to_jsonb(
  pg_temp.err(pg_temp.ack(:viewerA, pg_temp.id('p1v1'), 'email')) || ' ' ||
  pg_temp.err(pg_temp.ack(:viewerA, pg_temp.id('p1v1'), null)) || ' ' ||
  pg_temp.err(pg_temp.ack(:viewerA, pg_temp.id('p1v1'), 'web', 'aal1', 'ABC')) || ' ' ||
  pg_temp.err(pg_temp.ack(:viewerA, pg_temp.id('p1v1'), 'web', 'aal1', null)) || ' ' ||
  pg_temp.err(pg_temp.ack(:viewerA, pg_temp.id('p1v1'), 'web', 'aal1', repeat('a', 64))) || ' ' ||
  pg_temp.err(pg_temp.ack(:viewerA, (select id from public.org_policy_versions where policy_id = pg_temp.id('p1') and published_at is null)))));
select is(
  (select v #>> '{}' from answers where k = 'a53') || ' rows:' ||
  (select count(*) from public.org_policy_acknowledgements where user_id = :viewerA),
  '22023|policy_method_invalid 22023|policy_method_invalid 22023|policy_hash_invalid 22023|policy_hash_invalid '
  'P0001|policy_text_changed P0001|policy_version_not_current rows:0',
  '0482/53: a method other than web or phone, a hash that is not one, the hash of other words and a draft are refused, and nothing is written');

select pg_temp.ack(u::uuid, pg_temp.id('p1v1'))
  from unnest(array[:memberB, :removedA, :noName, :atName, :longName]) u;
select is(
  (select string_agg(a.user_id || '=' || coalesce(a.user_name, 'no name'), ', ' order by a.user_id)
     from public.org_policy_acknowledgements a where a.user_id in (:memberB, :removedA, :noName, :atName, :longName)),
  'a0482000-0000-0000-0000-0000000000c7=Policy Member B, a0482000-0000-0000-0000-0000000000c8=Policy Removed A, '
  'a0482000-0000-0000-0000-0000000000c9=no name, a0482000-0000-0000-0000-0000000000cb=no name, '
  'a0482000-0000-0000-0000-0000000000cc=' || repeat('L', 200),
  '0482/54: the name kept: the profile''s name, trimmed, at most 200 characters; none for an empty name or one that holds an ''@'' (never an email)');
select is((select count(*)::integer from public.org_policy_acknowledgements a where to_jsonb(a)::text like '%@%'), 0,
  '0482/55: no acknowledgement holds an email address');

-- No API role writes, changes or removes an acknowledgement.
select is(
  (select string_agg(r || ':' || op || '=' || pg_temp.try_as(r, u::uuid, s), ', ' order by r, op)
     from (values ('anon', null), ('authenticated', :memberA), ('service_role', null)) w(r, u),
          (values
            ('1 insert', format('insert into public.org_policy_acknowledgements (organization_id, policy_id, version_id, version_number, acknowledgement_round, text_hash, user_id, method) select organization_id, policy_id, id, version_number, acknowledgement_round, text_hash, %L, ''web'' from public.org_policy_versions where id = %L', 'a0482000-0000-0000-0000-0000000000ca', pg_temp.id('p1v1'))),
            ('2 update', 'update public.org_policy_acknowledgements set method = ''phone'''),
            ('3 delete', 'delete from public.org_policy_acknowledgements'),
            ('4 truncate', 'truncate public.org_policy_acknowledgements')) x(op, s)),
  'anon:1 insert=42501, anon:2 update=42501, anon:3 delete=42501, anon:4 truncate=42501, '
  'authenticated:1 insert=42501, authenticated:2 update=42501, authenticated:3 delete=42501, authenticated:4 truncate=42501, '
  'service_role:1 insert=42501, service_role:2 update=42501, service_role:3 delete=42501, service_role:4 truncate=42501',
  '0482/56: anon, a signed-in member and service_role can neither insert, update, delete nor truncate an acknowledgement');
select is(
  (select string_agg(r || '=' || pg_temp.try_as(r, u::uuid, 'update public.org_policy_versions set title = title'), ', ' order by r)
     from (values ('anon', null), ('authenticated', :adminA), ('service_role', null)) w(r, u)) || ' ' ||
  (select string_agg(r || '=' || pg_temp.try_as(r, u::uuid, 'delete from public.org_policies'), ', ' order by r)
     from (values ('anon', null), ('authenticated', :adminA), ('service_role', null)) w(r, u)) || ' ' ||
  (select string_agg(r || '=' || pg_temp.try_as(r, u::uuid, 'update public.org_policy_reminders set sent_count = 0'), ', ' order by r)
     from (values ('anon', null), ('authenticated', :adminA), ('service_role', null)) w(r, u)),
  'anon=42501, authenticated=42501, service_role=42501 anon=42501, authenticated=42501, service_role=42501 '
  'anon=42501, authenticated=42501, service_role=42501',
  '0482/57: nor a version, a policy or a reminder, even as the organization''s admin');

-- The tables' owner cannot either: the guard refuses every change and every removal.
select is(
  (select string_agg(c || '=' || pg_temp.try_as('postgres', null,
            format('update public.org_policy_acknowledgements set %s where id = %L', c,
                   (select (v ->> 'acknowledgement_id')::uuid from answers where k = 'ackA'))), ', ' order by c)
     from unnest(array['user_name = ''Someone else''', 'acknowledged_at = now() - interval ''1 day''', 'method = ''phone''',
                       'text_hash = repeat(''a'', 64)', 'user_id = ''a0482000-0000-0000-0000-0000000000c2''',
                       'user_id = null', 'organization_id = ''a0482000-0000-0000-0000-0000000000b1''', 'version_number = 1']) c),
  (select string_agg(c || '=55000|org_policy_acknowledgement_append_only', ', ' order by c)
     from unnest(array['user_name = ''Someone else''', 'acknowledged_at = now() - interval ''1 day''', 'method = ''phone''',
                       'text_hash = repeat(''a'', 64)', 'user_id = ''a0482000-0000-0000-0000-0000000000c2''',
                       'user_id = null', 'organization_id = ''a0482000-0000-0000-0000-0000000000b1''', 'version_number = 1']) c),
  '0482/58: the owner cannot change any column of an acknowledgement (emptying the account while it exists included, or writing the same value)');
select is(
  pg_temp.try_as('postgres', null, 'delete from public.org_policy_acknowledgements') || ' ' ||
  pg_temp.try_as('postgres', null, 'truncate public.org_policy_acknowledgements'),
  '55000|org_policy_acknowledgement_append_only 55000|org_policy_truncate_refused',
  '0482/59: nor delete or truncate one');
select is(
  (select string_agg(n || '=' || pg_temp.try_as('postgres', null, format(
            'insert into public.org_policy_acknowledgements (organization_id, policy_id, version_id, version_number, acknowledgement_round, text_hash, user_id, member_since, method) '
            'select organization_id, policy_id, id, %s, %s, %s, %s, now(), ''web'' from public.org_policy_versions where id = %L',
            vn, rd, th, uid, ver)), ', ' order by n)
     from (values
       ('1 right', 'version_number', 'acknowledgement_round', 'text_hash', '''a0482000-0000-0000-0000-0000000000ca''::uuid', pg_temp.id('p1v1')),
       ('2 other hash', 'version_number', 'acknowledgement_round', 'repeat(''a'', 64)', '''a0482000-0000-0000-0000-0000000000ca''::uuid', pg_temp.id('p1v1')),
       ('3 other number', '2', 'acknowledgement_round', 'text_hash', '''a0482000-0000-0000-0000-0000000000ca''::uuid', pg_temp.id('p1v1')),
       ('4 other round', 'version_number', '2', 'text_hash', '''a0482000-0000-0000-0000-0000000000ca''::uuid', pg_temp.id('p1v1')),
       ('5 no account', 'version_number', 'acknowledgement_round', 'text_hash', 'null::uuid', pg_temp.id('p1v1')),
       ('6 a draft', '1', '1', 'text_hash', '''a0482000-0000-0000-0000-0000000000ca''::uuid',
        (select id from public.org_policy_versions where policy_id = pg_temp.id('p1') and published_at is null))
     ) v(n, vn, rd, th, uid, ver)),
  '1 right=ok, 2 other hash=55000|org_policy_acknowledgement_append_only, 3 other number=55000|org_policy_acknowledgement_append_only, '
  '4 other round=55000|org_policy_acknowledgement_append_only, 5 no account=55000|org_policy_acknowledgement_append_only, '
  '6 a draft=55000|org_policy_acknowledgement_append_only',
  '0482/60: an insert by the owner must name an account and the number, round and hash of a published version (the right one passes, so the guard is not blanket)');

-- ── 6. What members and admins read; Remind now ─────────────────────────────
-- Acknowledged so far: memberA, mfaA, memberB, removedA, noName, atName, longName.
insert into answers values ('st1', pg_temp.fn1(:adminA, 'org_policy_status', pg_temp.id('p1')));
select is(
  (select pg_temp.users_of(v -> 'acknowledged') from answers where k = 'st1'),
  'a0482000-0000-0000-0000-0000000000c6,a0482000-0000-0000-0000-0000000000c7,a0482000-0000-0000-0000-0000000000c8,'
  'a0482000-0000-0000-0000-0000000000c9,a0482000-0000-0000-0000-0000000000cb,a0482000-0000-0000-0000-0000000000cc,'
  'a0482000-0000-0000-0000-0000000000cd',
  '0482/61: the status lists who has acknowledged the round');
select is(
  (select string_agg(e ->> 'name', ', ' order by n) from answers, jsonb_array_elements(v -> 'not_acknowledged') with ordinality x(e, n)
    where k = 'st1'),
  'Policy Admin A, Policy Manager A, Policy Member AB, Policy Owner A, Policy Publisher A, Policy Viewer A',
  '0482/62: and who has not, by the current-member rule (0422: no disabled account, no act-as seat live or expired, no invitation, no outsider), by name');
select is(
  (select (v -> 'counts')::text || ' ' || pg_temp.arr_text(jsonb_path_query_array(v -> 'invited', '$[*].email'))
     from answers where k = 'st1'),
  '{"invited": 2, "members": 13, "acknowledged": 7, "not_acknowledged": 6} invite-open@test.local,policy-invited-a@test.local',
  '0482/63: the counts; invitations are listed apart: the open invitation and the membership not accepted (not the expired, revoked or accepted ones)');
select is(
  (select (e ->> 'role') || '|' || (e ->> 'email') || '|' || ((e ->> 'owed_since')::timestamptz = now())::text || '|' ||
          ((e ->> 'member_since')::timestamptz = now() - interval '100 days')::text || '|' || (e ->> 'reminders_sent') || '|' ||
          coalesce(e ->> 'last_reminded_at', 'never')
     from answers, jsonb_array_elements(v -> 'not_acknowledged') e
    where k = 'st1' and e ->> 'user_id' = 'a0482000-0000-0000-0000-0000000000ca'),
  'viewer|policy-viewer-a@test.local|true|true|0|never',
  '0482/64: a member not acknowledged: role, email, owed since the publish, member since, no reminder yet');
select is(
  pg_temp.err(pg_temp.fn1(:managerA, 'org_policy_status', pg_temp.id('p1'))) || ' ' ||
  pg_temp.err(pg_temp.fn1(:actasOld, 'org_policy_status', pg_temp.id('p1'))) || ' ' ||
  pg_temp.err(pg_temp.fn1(:ownerB, 'org_policy_status', pg_temp.id('p1'))) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:memberA, 'org_policies_for_admin', :orgA)) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:disabledAdmin, 'org_policy_acknowledgement_record', pg_temp.id('p1'))) || ' ' ||
  pg_temp.err(pg_temp.fn1(:actas, 'org_policy_status', pg_temp.id('p1'))),
  '42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only ok',
  '0482/65: only the organization''s owners and admins (a live act-as seat among them) read the status, the list and the record');

-- What members read.
select is(
  (select string_agg((e ->> 'title') || '|' || (e ->> 'status') || '|' || (e ->> 'acknowledged') || '|' || (e ->> 'owed') || '|' ||
                     (e ->> 'version_number') || '|' || coalesce(e ->> 'acknowledged_method', '-') || '|' ||
                     jsonb_array_length(e -> 'my_acknowledgements'), ' ')
     from jsonb_array_elements(pg_temp.rows_of(:memberA, 'org_policies_for_member', :orgA)) e) || ' / ' ||
  (select string_agg((e ->> 'acknowledged') || '|' || (e ->> 'owed'), ' ')
     from jsonb_array_elements(pg_temp.rows_of(:viewerA, 'org_policies_for_member', :orgA)) e) || ' / ' ||
  (select string_agg((e ->> 'acknowledged') || '|' || (e ->> 'owed'), ' ')
     from jsonb_array_elements(pg_temp.rows_of(:actas, 'org_policies_for_member', :orgA)) e),
  'Acceptable use|published|true|false|1|web|1 / false|true / false|false',
  '0482/66: a member sees the published policy with their own acknowledgement; one who has not acknowledged owes it; an act-as seat reads it and is never asked');
select is(
  pg_temp.err(pg_temp.rows_of(:disabledA, 'org_policies_for_member', :orgA)) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:invitedA, 'org_policies_for_member', :orgA)) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:outsider, 'org_policies_for_member', :orgA)) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:ownerB, 'org_policies_for_member', :orgA)) || ' ' ||
  pg_temp.err(pg_temp.txt(:outsider, pg_temp.id('p1'))) || ' ' ||
  pg_temp.err(pg_temp.txt(:memberA, 'a0482000-0000-0000-0000-000000000999')) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:memberA, 'org_policies_for_member', null)),
  '42501|policy_not_allowed 42501|policy_not_allowed 42501|policy_not_allowed 42501|policy_not_allowed '
  '42501|policy_not_allowed 42501|policy_not_allowed 42501|policy_not_allowed',
  '0482/67: a disabled account, an invitation, an outsider and another organization read nothing; an unknown policy answers the same');
select is(
  (select string_agg(k2 || '=' || coalesce(pg_temp.txt(:memberA, pg_temp.id('p1')) ->> k2, 'null'), ' ' order by k2)
     from unnest(array['is_current', 'needs_acknowledgement', 'owed', 'acknowledged_in_current_round', 'status', 'kind']) k2)
  || ' mine=' || ((pg_temp.txt(:memberA, pg_temp.id('p1')) -> 'my_acknowledgement' ->> 'method')) ||
  ' keys=' || (select string_agg(x, ',' order by x) from jsonb_object_keys(pg_temp.txt(:memberA, pg_temp.id('p1'))) x),
  'acknowledged_in_current_round=true is_current=true kind=acceptable_use needs_acknowledgement=true owed=false status=published mine=web '
  'keys=acknowledged_in_current_round,acknowledged_version_number,acknowledgement_round,body,corrected_since_acknowledged,'
  'current_version_number,is_current,kind,last_corrected_at,my_acknowledgement,'
  'needs_acknowledgement,organization_id,owed,policy_id,published_at,status,text_hash,title,version_id,version_number',
  '0482/68: the words a member reads, with their own acknowledgement; no publisher, no draft');

-- Remind now.
select is(pg_temp.err(pg_temp.fn1(:managerA, 'org_policy_remind_now', pg_temp.id('p1'))), '42501|policy_admins_only',
  '0482/69: only an admin reminds');
insert into answers values ('rn1', pg_temp.fn1(:adminA, 'org_policy_remind_now', pg_temp.id('p1')));
select is(
  (select (v ->> 'reminded') || '|' || ((v ->> 'reminded_at')::timestamptz = now())::text || '|' ||
          ((v ->> 'next_allowed_at')::timestamptz = now() + interval '24 hours')::text || '|' || (v ->> 'version_number') || '|' ||
          pg_temp.arr_text(v -> 'recipients')
     from answers where k = 'rn1'),
  'true|true|true|1|a0482000-0000-0000-0000-0000000000c1,a0482000-0000-0000-0000-0000000000c2,a0482000-0000-0000-0000-0000000000c3,'
  'a0482000-0000-0000-0000-0000000000c4,a0482000-0000-0000-0000-0000000000ca,a0482000-0000-0000-0000-0000000000d6',
  '0482/70: Remind now names the current members who have not acknowledged, for the website to send');
select is(
  (select string_agg(r.user_id || ':' || r.sent_count || ':' || r.manual_count || ':' || (r.last_reminded_at = now())::text ||
                     ':' || coalesce(r.last_sent_at::text, 'none') || ':' || (r.round_version_id = pg_temp.id('p1v1'))::text, ' ' order by r.user_id)
     from public.org_policy_reminders r where r.policy_id = pg_temp.id('p1')) || ' policy:' ||
  (select (last_remind_now_at = now())::text from public.org_policies where id = pg_temp.id('p1')),
  'a0482000-0000-0000-0000-0000000000c1:0:1:true:none:true a0482000-0000-0000-0000-0000000000c2:0:1:true:none:true '
  'a0482000-0000-0000-0000-0000000000c3:0:1:true:none:true a0482000-0000-0000-0000-0000000000c4:0:1:true:none:true '
  'a0482000-0000-0000-0000-0000000000ca:0:1:true:none:true a0482000-0000-0000-0000-0000000000d6:0:1:true:none:true policy:true',
  '0482/71: stamped before anything is sent: each recipient''s row of the round (not an automatic one) and the policy''s time');
create temporary table rem_before as select * from public.org_policy_reminders;
insert into answers values ('rn2', pg_temp.fn1(:adminA, 'org_policy_remind_now', pg_temp.id('p1')));
select is(
  (select (v ->> 'reminded') || '|' || (v ->> 'reason') || '|' || ((v ->> 'next_allowed_at')::timestamptz = now() + interval '24 hours')::text
          || '|' || jsonb_array_length(v -> 'recipients') from answers where k = 'rn2') || ' unchanged:' ||
  ((select count(*) from rem_before) = (select count(*) from public.org_policy_reminders)
   and not exists (select 1 from rem_before b where not exists (select 1 from public.org_policy_reminders r where to_jsonb(r) = to_jsonb(b))))::text,
  'false|too_soon|true|0 unchanged:true',
  '0482/72: again within a day: too soon, with when it is next allowed, and nothing stamped');
select is(
  (select (e ->> 'members') || '|' || (e ->> 'acknowledged') || '|' || (e ->> 'not_acknowledged') || '|' || (e ->> 'has_draft') || '|' ||
          (e ->> 'draft_title') || '|' || ((e ->> 'next_remind_now_at')::timestamptz = now() + interval '24 hours')::text || '|' ||
          (e ->> 'current_version_number') || '|' || (e ->> 'round_version_number')
     from jsonb_array_elements(pg_temp.rows_of(:adminA, 'org_policies_for_admin', :orgA)) e
    where e ->> 'policy_id' = pg_temp.id('p1')::text),
  '13|7|6|true|Acceptable use policy|true|1|1',
  '0482/73: the admin list: the round''s counts, the saved draft and when Remind now is next allowed');

-- ── 7. A correction asks nobody again; a new version asks everyone ──────────
-- The draft saved in 0482/47 is set back to the current words: nothing to correct.
select pg_temp.save(:adminA, :orgA, pg_temp.id('p1'), 'acceptable_use', :t1, :b1);
select is(pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p1'), 'correction')), 'P0001|policy_draft_unchanged',
  '0482/74: a correction with the current words is refused');

-- Every acknowledgement as it is now: no function below may change or remove one.
create temporary table acks_before as select * from public.org_policy_acknowledgements;

select pg_temp.save(:adminA, :orgA, pg_temp.id('p1'), 'acceptable_use', :t1, :b1 || chr(10) || chr(10) || 'Ask an admin if unsure.');
insert into answers values ('p1v2', pg_temp.pub(:adminA, pg_temp.id('p1'), 'correction'));
select pg_temp.keep('p1v2', (select (v ->> 'version_id')::uuid from answers where k = 'p1v2'));
select is(
  (select (v ->> 'version_number') || '|' || (v ->> 'needs_acknowledgement') || '|' || (v ->> 'acknowledgement_round') || '|' ||
          jsonb_array_length(v -> 'asked_user_ids') from answers where k = 'p1v2') || ' ' ||
  (select title || '|' || current_version from public.org_policies where id = pg_temp.id('p1')),
  '2|false|1|0 Acceptable use|2',
  '0482/75: a correction is version 2 in round 1 and asks nobody; it keeps the title');
select is(
  (select (e ->> 'acknowledged') || '|' || (e ->> 'owed') || '|' || (e ->> 'version_number') || '|' || (e ->> 'acknowledged_version_number')
     from jsonb_array_elements(pg_temp.rows_of(:memberA, 'org_policies_for_member', :orgA)) e) || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_status', pg_temp.id('p1')) -> 'counts')::text,
  'true|false|2|1 {"invited": 2, "members": 13, "acknowledged": 7, "not_acknowledged": 6}',
  '0482/76: who acknowledged the version it corrects is not asked again, and the counts are as they were');
select is(
  pg_temp.err(pg_temp.ack(:memberA, pg_temp.id('p1v1'))) || ' ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p1'), 1) ->> 'version_number') || ' ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p1'), 1) ->> 'is_current') || ' ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p1')) ->> 'version_number'),
  'P0001|policy_version_not_current 1 false 2',
  '0482/77: an older version can no longer be acknowledged, but the member still reads the words they agreed to, and the current ones');
insert into answers values ('ackV', pg_temp.ack(:viewerA, pg_temp.id('p1v2'), 'phone'));
select is(
  (select (v ->> 'already') || '|' || (v ->> 'version_number') || '|' || (v ->> 'method') from answers where k = 'ackV') || ' ' ||
  (select a.acknowledgement_round || '|' || a.version_number from public.org_policy_acknowledgements a
    where a.user_id = :viewerA) || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_status', pg_temp.id('p1')) -> 'counts' ->> 'acknowledged'),
  'false|2|phone 1|2 8',
  '0482/78: a member who had not acknowledged acknowledges the corrected words, which count for the round');

-- A member removed from the organization: not listed, not asked, refused; their record stays.
delete from public.organization_members where organization_id = :orgA and user_id = :removedA;
select is(
  (pg_temp.fn1(:adminA, 'org_policy_status', pg_temp.id('p1')) -> 'counts')::text || ' ' ||
  pg_temp.err(pg_temp.ack(:removedA, pg_temp.id('p1v2'))) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:removedA, 'org_policies_for_member', :orgA)) || ' ' ||
  (select (e ->> 'name') || '|' || (e ->> 'current_member') || '|' || coalesce(e ->> 'email', 'no email') || '|' || (e ->> 'account_deleted')
     from jsonb_array_elements(pg_temp.rows_of(:adminA, 'org_policy_acknowledgement_record', pg_temp.id('p1'))) e
    where e ->> 'user_id' = 'a0482000-0000-0000-0000-0000000000c8'),
  '{"invited": 2, "members": 12, "acknowledged": 7, "not_acknowledged": 5} 42501|policy_not_allowed 42501|policy_not_allowed '
  'Policy Removed A|false|no email|false',
  '0482/79: a member removed leaves the lists and is refused; the record keeps their acknowledgement, without their email');

insert into answers values ('p1v3_draft', pg_temp.save(:adminA, :orgA, pg_temp.id('p1'), 'acceptable_use', 'Acceptable use policy',
  '# Purpose' || chr(10) || 'This policy says how we use the app, from this year.' || chr(10) || chr(10) || '- Use only your own account.'));
insert into answers values ('p1v3', pg_temp.pub(:adminA, pg_temp.id('p1'), 'new_version', (select v ->> 'text_hash' from answers where k = 'p1v3_draft')));
select pg_temp.keep('p1v3', (select (v ->> 'version_id')::uuid from answers where k = 'p1v3'));
select is(
  (select (v ->> 'version_number') || '|' || (v ->> 'needs_acknowledgement') || '|' || (v ->> 'acknowledgement_round') || '|' ||
          jsonb_array_length(v -> 'asked_user_ids') || '|' ||
          (v -> 'asked_user_ids' ? 'a0482000-0000-0000-0000-0000000000c8')::text from answers where k = 'p1v3') || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_status', pg_temp.id('p1')) -> 'counts')::text || ' ' ||
  (select (e ->> 'owed') || '|' || (e ->> 'acknowledged') from jsonb_array_elements(pg_temp.rows_of(:memberA, 'org_policies_for_member', :orgA)) e),
  '3|true|3|12|false {"invited": 2, "members": 12, "acknowledged": 0, "not_acknowledged": 12} true|false',
  '0482/80: a new version (with the hash save_draft gave) asks every current member again: round 3, nobody has acknowledged it');
select is(
  pg_temp.err(pg_temp.txt(:memberA, pg_temp.id('p1'), 2)) || ' ' ||
  (pg_temp.txt(:viewerA, pg_temp.id('p1'), 2) ->> 'version_number') || ' ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p1'), 1) ->> 'version_number') || ' ' ||
  (pg_temp.txt(:adminA, pg_temp.id('p1'), 2) ->> 'version_number') || ' ' ||
  pg_temp.err(pg_temp.txt(:adminA, pg_temp.id('p1'), 99)) || ' ' ||
  pg_temp.err(pg_temp.txt(:memberA, pg_temp.id('p1'), 99)),
  '42501|policy_not_allowed 2 1 2 P0001|policy_version_not_found 42501|policy_not_allowed',
  '0482/81: a member reads only the current version and the ones they acknowledged; an admin reads every published one');
insert into answers values ('a82', pg_temp.ack(:memberA, pg_temp.id('p1v3'), 'phone'));
select is(
  (select pg_temp.err(v) from answers where k = 'a82') || ' ' ||
  (select string_agg(a.version_number || ':' || a.user_id, ' ' order by a.version_number, a.user_id)
     from public.org_policy_acknowledgements a where a.user_id in (:memberA, :viewerA)),
  'ok 1:a0482000-0000-0000-0000-0000000000c6 2:a0482000-0000-0000-0000-0000000000ca 3:a0482000-0000-0000-0000-0000000000c6',
  '0482/82: the member acknowledges the new version; every earlier acknowledgement stays');

-- ── 8. Retiring, discarding, and what no function changes ───────────────────
-- A second policy, published by an admin who will delete their account; memberA acknowledges it.
select pg_temp.keep('p2', (pg_temp.save(:adminP, :orgA, null, 'data_handling', 'Data handling',
  '# What we keep' || chr(10) || '- Only what the work needs.') ->> 'policy_id')::uuid);
select pg_temp.pub(:adminP, pg_temp.id('p2'), 'new_version');
select pg_temp.keep('p2v1', pg_temp.ver(pg_temp.id('p2'), 1));
select pg_temp.ack(:memberA, pg_temp.id('p2v1'));
select pg_temp.save(:adminA, :orgA, pg_temp.id('p2'), 'data_handling', 'Data handling', '# What we keep' || chr(10) || '- Less.');

select is(
  pg_temp.err(pg_temp.fn1(:managerA, 'org_policy_retire', pg_temp.id('p2'))) || ' ' ||
  pg_temp.err(pg_temp.fn1(:adminA, 'org_policy_retire', pg_temp.id('p6'))),
  '42501|policy_admins_only P0001|policy_not_published',
  '0482/83: only an admin retires, and only a published policy (a draft is discarded instead)');
insert into answers values ('ret1', pg_temp.fn1(:adminA, 'org_policy_retire', pg_temp.id('p2')));
insert into answers values ('ret2', pg_temp.fn1(:adminA, 'org_policy_retire', pg_temp.id('p2')));
select is(
  (select (v ->> 'already') || '|' || ((v ->> 'retired_at')::timestamptz = now())::text from answers where k = 'ret1') || ' ' ||
  (select (v ->> 'already') || '|' || ((v ->> 'retired_at')::timestamptz = now())::text from answers where k = 'ret2') || ' ' ||
  (select status || '|' || current_version || '|' || (retired_at = now())::text from public.org_policies where id = pg_temp.id('p2')) || ' drafts:' ||
  (select count(*) from public.org_policy_versions where policy_id = pg_temp.id('p2') and published_at is null) || ' versions:' ||
  (select count(*) from public.org_policy_versions where policy_id = pg_temp.id('p2')),
  'false|true true|true retired|1|true drafts:0 versions:1',
  '0482/84: retiring keeps every published version and discards the draft; again, it answers the same retirement');
select is(
  (select string_agg((e ->> 'title') || '|' || (e ->> 'status') || '|' || (e ->> 'acknowledged') || '|' || (e ->> 'owed'), ' ' order by e ->> 'title')
     from jsonb_array_elements(pg_temp.rows_of(:memberA, 'org_policies_for_member', :orgA)) e) || ' / ' ||
  (select string_agg((e ->> 'title') || '|' || (e ->> 'status'), ' ' order by e ->> 'title')
     from jsonb_array_elements(pg_temp.rows_of(:viewerA, 'org_policies_for_member', :orgA)) e) || ' / ' ||
  (pg_temp.txt(:memberA, pg_temp.id('p2')) ->> 'status') || ' ' ||
  pg_temp.err(pg_temp.txt(:viewerA, pg_temp.id('p2'))),
  'Acceptable use policy|published|true|false Data handling|retired|true|false / Acceptable use policy|published / retired 42501|policy_not_allowed',
  '0482/85: a retired policy is asked of nobody; a member who acknowledged it still lists and reads it, others do not');
select is(
  pg_temp.err(pg_temp.save(:adminA, :orgA, pg_temp.id('p2'), 'other', 'T', 'B')) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminA, pg_temp.id('p2'), 'new_version', repeat('a', 64))) || ' ' ||
  pg_temp.err(pg_temp.fn1(:adminA, 'org_policy_remind_now', pg_temp.id('p2'))) || ' ' ||
  pg_temp.err(pg_temp.ack(:memberAB, pg_temp.id('p2v1'))) || ' ' ||
  pg_temp.try_as('postgres', null, format('update public.org_policies set kind = ''other'' where id = %L', pg_temp.id('p2'))) || ' ' ||
  pg_temp.try_as('postgres', null, format('update public.org_policies set status = ''published'', retired_at = null where id = %L', pg_temp.id('p2'))),
  'P0001|policy_retired P0001|policy_retired P0001|policy_retired P0001|policy_retired 55000|org_policy_changed_wrongly 55000|org_policy_changed_wrongly',
  '0482/86: a retired policy is final: no draft, publish, reminder or acknowledgement, and even its owner cannot change it');

-- Discarding.
select pg_temp.save(:adminA, :orgA, pg_temp.id('p1'), 'acceptable_use', 'Acceptable use policy', 'A draft to throw away.');
insert into answers values ('d87', to_jsonb(
  pg_temp.err(pg_temp.fn1(:managerA, 'org_policy_discard_draft', pg_temp.id('p1'))) || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_discard_draft', pg_temp.id('p1')) ->> 'discarded') || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_discard_draft', pg_temp.id('p1')) ->> 'discarded') || ' ' ||
  (pg_temp.fn1(:adminA, 'org_policy_discard_draft', pg_temp.id('p6')) ->> 'discarded')));
select is(
  (select v #>> '{}' from answers where k = 'd87') || ' ' ||
  (select count(*) from public.org_policies where id = pg_temp.id('p6')) || ' ' ||
  (select count(*) from public.org_policy_versions where policy_id = pg_temp.id('p6')) || ' ' ||
  (select count(*) from public.org_policy_versions where policy_id = pg_temp.id('p1') and published_at is not null),
  '42501|policy_admins_only draft nothing policy 0 0 3',
  '0482/87: discarding removes a draft (then there is nothing), or a policy never published with its draft; published versions stay');

-- Every acknowledgement that existed before the correction (0482/75) is unchanged after every write since:
-- two saves, a correction, a removal, a new version, a second policy, a retirement, discards, Remind now.
select is(
  (select count(*)::integer from acks_before b
    where not exists (select 1 from public.org_policy_acknowledgements a where to_jsonb(a) = to_jsonb(b))),
  0, '0482/88: no function changed or removed an acknowledgement (every row of before is there, byte for byte)');
select is((select count(*)::integer from acks_before), 7, '0482/89: (seven rows were checked)');

-- ── 9. An account deleted; an organization deleted ──────────────────────────
-- memberB acknowledged P1 version 1; give them a reminder row to see it go.
insert into public.org_policy_reminders (organization_id, policy_id, round_version_id, user_id, manual_count, last_reminded_at)
values (:orgA, pg_temp.id('p1'), pg_temp.id('p1v3'), :memberB, 1, now());
create temporary table b_before as
  select to_jsonb(a) - 'user_id' as j from public.org_policy_acknowledgements a where a.user_id = :memberB;
delete from auth.users where id = :memberB;
select is(
  (select count(*)::integer from public.org_policy_acknowledgements a
    where a.user_id is null and (to_jsonb(a) - 'user_id') = (select j from b_before)) || ' ' ||
  (select count(*) from b_before) || ' ' ||
  (select count(*) from public.org_policy_reminders where user_id = :memberB),
  '1 1 0',
  '0482/90: deleting an account keeps its acknowledgement, every column as it was but the person, which is emptied; its reminders go');
select is(
  (select (e ->> 'name') || '|' || (e ->> 'account_deleted') || '|' || coalesce(e ->> 'user_id', 'none') || '|' ||
          coalesce(e ->> 'email', 'no email') || '|' || (e ->> 'current_member')
     from jsonb_array_elements(pg_temp.rows_of(:adminA, 'org_policy_acknowledgement_record', pg_temp.id('p1'))) e
    where e ->> 'name' = 'Policy Member B'),
  'Policy Member B|true|none|no email|false',
  '0482/91: the record names the deleted account by the name it kept');

create temporary table p_before as
  select to_jsonb(v) - 'published_by' as j from public.org_policy_versions v where v.id = pg_temp.id('p2v1');
delete from auth.users where id = :adminP;
select is(
  (select coalesce(v.published_by::text, 'none') || '|' || v.published_by_name || '|' ||
          ((to_jsonb(v) - 'published_by') = (select j from p_before))::text
     from public.org_policy_versions v where v.id = pg_temp.id('p2v1')),
  'none|Policy Publisher A|true',
  '0482/92: deleting the publisher''s account keeps the version and its words, with the publisher emptied and named as they were');

-- Organization B: a policy, two acknowledgements, a reminder; Remind now with nobody owed stamps nothing.
select pg_temp.keep('pb', (pg_temp.save(:ownerB, :orgB, null, 'other', 'B rules', 'Be kind.') ->> 'policy_id')::uuid);
select pg_temp.pub(:ownerB, pg_temp.id('pb'), 'new_version');
select pg_temp.ack(:ownerB, pg_temp.ver(pg_temp.id('pb'), 1));
insert into answers values ('a93', to_jsonb(
  pg_temp.err(pg_temp.ack(:memberAB, pg_temp.ver(pg_temp.id('pb'), 1), 'phone')) || ' ' ||
  pg_temp.err(pg_temp.ack(:ownerB, pg_temp.id('p1v3'))) || ' ' ||
  pg_temp.err(pg_temp.ack(:memberAB, pg_temp.id('p1v3')))));
select is(
  (select v #>> '{}' from answers where k = 'a93') || ' ' ||
  (select string_agg(a.organization_id || ':' || a.version_number, ' ' order by a.organization_id) from public.org_policy_acknowledgements a
    where a.user_id = :memberAB),
  'ok 42501|policy_not_allowed ok a0482000-0000-0000-0000-0000000000a1:3 a0482000-0000-0000-0000-0000000000b1:1',
  '0482/93: a member of two organizations acknowledges each one''s policy; another organization''s owner cannot acknowledge A''s');
insert into answers values ('rnB', pg_temp.fn1(:ownerB, 'org_policy_remind_now', pg_temp.id('pb')));
select is(
  (select (v ->> 'reminded') || '|' || (v ->> 'reason') || '|' || jsonb_array_length(v -> 'recipients') from answers where k = 'rnB') || ' ' ||
  (select coalesce(last_remind_now_at::text, 'never') from public.org_policies where id = pg_temp.id('pb')) || ' ' ||
  (select count(*) from public.org_policy_reminders where policy_id = pg_temp.id('pb')),
  'false|nobody_owed|0 never 0',
  '0482/94: Remind now with everyone acknowledged stamps nothing');
insert into public.org_policy_reminders (organization_id, policy_id, round_version_id, user_id, sent_count, last_sent_at, last_reminded_at)
values (:orgB, pg_temp.id('pb'), pg_temp.ver(pg_temp.id('pb'), 1), :ownerB, 1, now(), now());
create temporary table a_counts as
  select (select count(*) from public.org_policies where organization_id = :orgA) p,
         (select count(*) from public.org_policy_versions where organization_id = :orgA) v,
         (select count(*) from public.org_policy_acknowledgements where organization_id = :orgA) a;
select is(
  pg_temp.try_as('postgres', null, format('delete from public.organizations where id = %L', 'a0482000-0000-0000-0000-0000000000b1')),
  'ok', '0482/95: an organization can still be deleted (its records go with it, the one removal the guards allow)');
delete from public.organizations where id = :orgB;
select is(
  (select count(*) from public.org_policies where organization_id = :orgB) || ' ' ||
  (select count(*) from public.org_policy_versions where organization_id = :orgB) || ' ' ||
  (select count(*) from public.org_policy_acknowledgements where organization_id = :orgB) || ' ' ||
  (select count(*) from public.org_policy_reminders where organization_id = :orgB) || ' A:' ||
  ((select count(*) from public.org_policies where organization_id = :orgA) = (select p from a_counts)
   and (select count(*) from public.org_policy_versions where organization_id = :orgA) = (select v from a_counts)
   and (select count(*) from public.org_policy_acknowledgements where organization_id = :orgA) = (select a from a_counts))::text,
  '0 0 0 0 A:true',
  '0482/96: deleting organization B removed its policies, versions, acknowledgements and reminders, and nothing of A');

-- ── 10. The reminder job's claim ────────────────────────────────────────────
-- Organization C. P3 asks since 40 days ago (its version 1 moved back, its guard off for that one statement);
-- adminC acknowledged it. P4 asked since 40 days ago too but is retired. P5 was published now.
select pg_temp.keep('p3', (pg_temp.save(:adminC, :orgC, null, 'acceptable_use', 'C rules', 'Lock your device.') ->> 'policy_id')::uuid);
select pg_temp.pub(:adminC, pg_temp.id('p3'), 'new_version');
select pg_temp.keep('p3v1', pg_temp.ver(pg_temp.id('p3'), 1));
select pg_temp.ack(:adminC, pg_temp.id('p3v1'));
select pg_temp.keep('p4', (pg_temp.save(:adminC, :orgC, null, 'other', 'C old rules', 'Old words.') ->> 'policy_id')::uuid);
select pg_temp.pub(:adminC, pg_temp.id('p4'), 'new_version');
select pg_temp.keep('p5', (pg_temp.save(:adminC, :orgC, null, 'data_handling', 'C data', 'New words.') ->> 'policy_id')::uuid);
select pg_temp.pub(:adminC, pg_temp.id('p5'), 'new_version');
alter table public.org_policy_versions disable trigger org_policy_versions_guard;
update public.org_policy_versions set published_at = now() - interval '40 days'
 where id in (pg_temp.id('p3v1'), pg_temp.ver(pg_temp.id('p4'), 1));
alter table public.org_policy_versions enable trigger org_policy_versions_guard;
select pg_temp.fn1(:adminC, 'org_policy_retire', pg_temp.id('p4'));
-- Earlier reminders of P3's round: managerC had 1 (10 days ago), viewerC 5 (4 days ago), ownerC all 6, gapC a
-- Remind now yesterday.
insert into public.org_policy_reminders (organization_id, policy_id, round_version_id, user_id, sent_count, last_sent_at, manual_count, last_reminded_at) values
  (:orgC, pg_temp.id('p3'), pg_temp.id('p3v1'), :managerC, 1, now() - interval '10 days', 0, now() - interval '10 days'),
  (:orgC, pg_temp.id('p3'), pg_temp.id('p3v1'), :viewerC,  5, now() - interval '4 days',  0, now() - interval '4 days'),
  (:orgC, pg_temp.id('p3'), pg_temp.id('p3v1'), :ownerC,   6, now() - interval '4 days',  0, now() - interval '4 days'),
  (:orgC, pg_temp.id('p3'), pg_temp.id('p3v1'), :gapC,     0, null,                       1, now() - interval '1 day');

-- One a call (0 is held to 1): the oldest owed first, then by policy and account.
insert into answers values ('c1', pg_temp.claim(0));
select is(
  (select (v ->> 'busy') || '|' || (v ->> 'more') || '|' || ((v ->> 'claimed_at')::timestamptz = now())::text || '|' ||
          (select string_agg((e ->> 'user_id') || '#' || (e ->> 'reminder_number'), ' ') from jsonb_array_elements(v -> 'claimed') e)
     from answers where k = 'c1'),
  'false|true|true|a0482000-0000-0000-0000-0000000000e2#2',
  '0482/97: the claim hands out the oldest owed reminder first (managerC''s second, 7 days after), and says more are due');
select is(
  (select (e ->> 'organization_id') || '|' || (e ->> 'policy_id' = pg_temp.id('p3')::text)::text || '|' || (e ->> 'title') || '|' ||
          (e ->> 'version_id' = pg_temp.id('p3v1')::text)::text || '|' || (e ->> 'round_version_id' = pg_temp.id('p3v1')::text)::text || '|' ||
          (e ->> 'version_number') || '|' || ((e ->> 'owed_since')::timestamptz = now() - interval '40 days')::text || '|' ||
          (select string_agg(x, ',' order by x) from jsonb_object_keys(e) x)
     from answers, jsonb_array_elements(v -> 'claimed') e where k = 'c1'),
  'a0482000-0000-0000-0000-0000000000d1|true|C rules|true|true|1|true|organization_id,owed_since,policy_id,reminder_number,round_version_id,title,user_id,version_id,version_number',
  '0482/98: what a claimed reminder says: the organization, the policy and its title, the version to read, the round, since when');
insert into answers values ('c2', pg_temp.claim(null));
select is(
  (select (v ->> 'busy') || '|' || (v ->> 'more') || '|' ||
          (select string_agg((e ->> 'user_id') || '#' || (e ->> 'reminder_number'), ' ') from jsonb_array_elements(v -> 'claimed') e)
     from answers where k = 'c2'),
  'false|false|a0482000-0000-0000-0000-0000000000e3#1 a0482000-0000-0000-0000-0000000000e4#6 a0482000-0000-0000-0000-0000000000e7#1',
  '0482/99: the rest, oldest first: memberC''s first, viewerC''s sixth (35 days), lateC5''s first (3 days after joining). Not: adminC (acknowledged), ownerC (6 sent), gapC (reminded yesterday), lateC2 (joined 2 days ago), a disabled account, an act-as seat, an invitation, the retired P4, the new P5');
select is(
  (select string_agg(r.user_id || ':' || r.sent_count || ':' || coalesce((r.last_sent_at = now())::text, 'none') || ':' ||
                     r.manual_count || ':' || (r.last_reminded_at = now())::text, ' ' order by r.user_id)
     from public.org_policy_reminders r where r.policy_id = pg_temp.id('p3')) || ' P4:' ||
  (select count(*) from public.org_policy_reminders r where r.policy_id in (pg_temp.id('p4'), pg_temp.id('p5'))),
  'a0482000-0000-0000-0000-0000000000e0:6:false:0:false a0482000-0000-0000-0000-0000000000e2:2:true:0:true '
  'a0482000-0000-0000-0000-0000000000e3:1:true:0:true a0482000-0000-0000-0000-0000000000e4:6:true:0:true '
  'a0482000-0000-0000-0000-0000000000e5:0:none:1:false a0482000-0000-0000-0000-0000000000e7:1:true:0:true P4:0',
  '0482/100: each was stamped as it was handed out (stamp first); nothing for the others');
select is(
  (select (v ->> 'more') || '|' || jsonb_array_length(v -> 'claimed') from (select pg_temp.claim(200) v) x) || ' ' ||
  (select (v ->> 'more') || '|' || jsonb_array_length(v -> 'claimed') || '|' || (v ->> 'busy') from (select pg_temp.claim(-5) v) x) || ' ' ||
  (select (v ->> 'more') || '|' || jsonb_array_length(v -> 'claimed') from (select pg_temp.claim(5000) v) x),
  'false|0 false|0|false false|0',
  '0482/101: claimed again at once, nothing (each is stamped and 3 days must pass); any limit is held to 1..1000 and never raises');

-- A correction keeps the count; a new version starts a new one.
select pg_temp.save(:adminC, :orgC, pg_temp.id('p3'), 'acceptable_use', 'C rules', 'Lock your device when you leave it.');
select pg_temp.keep('p3v2', (pg_temp.pub(:adminC, pg_temp.id('p3'), 'correction') ->> 'version_id')::uuid);
update public.org_policy_reminders set last_sent_at = now() - interval '8 days', last_reminded_at = now() - interval '8 days'
 where policy_id = pg_temp.id('p3') and user_id = :memberC;
insert into answers values ('c3', pg_temp.claim(10));
select is(
  (select string_agg((e ->> 'user_id') || '#' || (e ->> 'reminder_number') || '|' || (e ->> 'version_number') || '|' ||
                     (e ->> 'round_version_id' = pg_temp.id('p3v1')::text)::text || '|' || (e ->> 'version_id' = pg_temp.id('p3v2')::text)::text, ' ')
     from answers, jsonb_array_elements(v -> 'claimed') e where k = 'c3'),
  'a0482000-0000-0000-0000-0000000000e3#2|2|true|true',
  '0482/102: after a correction the round and its count go on: memberC''s second reminder, to read the corrected version');
select pg_temp.save(:adminC, :orgC, pg_temp.id('p3'), 'acceptable_use', 'C rules', 'New rules for this year.');
select pg_temp.keep('p3v3', (pg_temp.pub(:adminC, pg_temp.id('p3'), 'new_version') ->> 'version_id')::uuid);
update public.org_policy_reminders set last_sent_at = now() - interval '8 days', last_reminded_at = now() - interval '8 days'
 where policy_id = pg_temp.id('p3') and sent_count > 0;
insert into answers values ('c4', pg_temp.claim(10));
select is(
  (select jsonb_array_length(v -> 'claimed') from answers where k = 'c4') || ' ' ||
  (select count(*) from public.org_policy_reminders where round_version_id = pg_temp.id('p3v3')) || ' ' ||
  (select (e ->> 'reminders_sent') || '|' || coalesce(e ->> 'last_reminded_at', 'never')
     from jsonb_array_elements(pg_temp.fn1(:adminC, 'org_policy_status', pg_temp.id('p3')) -> 'not_acknowledged') e
    where e ->> 'user_id' = 'a0482000-0000-0000-0000-0000000000e3'),
  '0 0 0|never',
  '0482/103: a new version starts a new round: nothing is due for 3 days, and its count starts at none');
insert into answers values ('rnC', pg_temp.fn1(:adminC, 'org_policy_remind_now', pg_temp.id('p3')));
select is(
  (select pg_temp.arr_text(v -> 'recipients') || ' v' || (v ->> 'version_number') from answers where k = 'rnC'),
  'a0482000-0000-0000-0000-0000000000e0,a0482000-0000-0000-0000-0000000000e1,a0482000-0000-0000-0000-0000000000e2,'
  'a0482000-0000-0000-0000-0000000000e3,a0482000-0000-0000-0000-0000000000e4,a0482000-0000-0000-0000-0000000000e5,'
  'a0482000-0000-0000-0000-0000000000e6,a0482000-0000-0000-0000-0000000000e7 v3',
  '0482/104: Remind now for the new round names every current member of C (the admin too), never the disabled account, the act-as seat or the invitation');
-- Three days after Remind now nothing automatic is due either (the new round asks at 3 days from now).
update public.org_policy_reminders set last_reminded_at = now() - interval '2 days' where round_version_id = pg_temp.id('p3v3');
select is((select jsonb_array_length(v -> 'claimed') from (select pg_temp.claim(10) v) x), 0,
  '0482/105: and the round''s first automatic reminder waits for its 3 days');

-- ── 11. The rest of the rules, each where only it decides ────────────────────
-- A policy never published (P7) and a draft of the published P5.
select pg_temp.keep('p7', (pg_temp.save(:adminC, :orgC, null, 'other', 'C draft', 'Draft words.') ->> 'policy_id')::uuid);
select pg_temp.save(:adminC, :orgC, pg_temp.id('p5'), 'data_handling', 'C data', 'Changed words.');
select is(
  pg_temp.try_as('postgres', null, format(
    'insert into public.org_policies (organization_id, kind, title, current_version) values (%L, ''other'', ''T'', 1)', :orgC)) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'update public.org_policies set last_remind_now_at = now() where id = %L', pg_temp.id('p7'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'update public.org_policy_versions set published_by = %L where policy_id = %L and published_at is null', :adminC, pg_temp.id('p5'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'update public.org_policy_versions set published_at = now(), published_by = %L where policy_id = %L and published_at is null',
    :adminC, pg_temp.id('p5'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'update public.org_policy_versions set version_number = 2, needs_acknowledgement = false, acknowledgement_round = 2, '
    'published_at = now(), published_by = %L where policy_id = %L and published_at is null', :adminC, pg_temp.id('p5'))) || ' ' ||
  pg_temp.try_as('postgres', null, format(
    'update public.org_policy_reminders set sent_count = 7 where round_version_id = %L and user_id = %L', pg_temp.id('p3v1'), :ownerC)),
  '23514:org_policies_current_version 23514:org_policies_remind_now 23514:org_policy_versions_publisher '
  '23514:org_policy_versions_published 23514:org_policy_versions_round 23514:org_policy_reminders_sent',
  '0482/106: the tables'' own checks hold against their owner: a draft names no version and no Remind now, a draft no publisher, a version is published with its number, a correction never opens its own round, at most 6 automatic reminders');
select is(
  pg_temp.err(pg_temp.ack(:memberC, pg_temp.ver(pg_temp.id('p5'), 1), 'web', 'aal1',
                          upper((select text_hash from public.org_policy_versions where id = pg_temp.ver(pg_temp.id('p5'), 1))))) || ' ' ||
  pg_temp.err(pg_temp.pub(:adminC, pg_temp.id('p5'), 'new_version', upper(pg_temp.draft_hash(pg_temp.id('p5'))))),
  '22023|policy_hash_invalid 22023|policy_hash_invalid',
  '0482/107: a hash in capital letters is not a hash: the acknowledgement and the publish refuse it');
select is(
  (pg_temp.txt(:actasC, pg_temp.id('p5')) ->> 'owed') || ' ' || (pg_temp.txt(:memberC, pg_temp.id('p5')) ->> 'owed') || ' ' ||
  pg_temp.err(pg_temp.rows_of(:managerC, 'org_policy_acknowledgement_record', pg_temp.id('p3'))) || ' ' ||
  pg_temp.err(pg_temp.rows_of(:viewerC, 'org_policy_acknowledgement_record', pg_temp.id('p3'))),
  'false true 42501|policy_admins_only 42501|policy_admins_only',
  '0482/108: the words never say owed to an act-as seat (a current member is owed them); a manager or a viewer cannot read the record');

-- P5's round moved back 40 days (its guard off for that one statement); a support seat not accepted in C.
alter table public.org_policy_versions disable trigger org_policy_versions_guard;
update public.org_policy_versions set published_at = now() - interval '40 days' where id = pg_temp.ver(pg_temp.id('p5'), 1);
alter table public.org_policy_versions enable trigger org_policy_versions_guard;
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0482000-0000-0000-0000-0000000000eb', 'policy-seat-pending-c@test.local', '{"full_name": "Policy Seat Pending C"}'::jsonb);
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgC, 'a0482000-0000-0000-0000-0000000000eb', 'owner', null, now() + interval '1 hour');
select is(
  (select string_agg((e ->> 'user_id') || '=' ||
            case (e ->> 'owed_since')::timestamptz when now() - interval '2 days' then 'joined'
                                                    when now() - interval '40 days' then 'round' else e ->> 'owed_since' end,
            ' ' order by e ->> 'user_id')
     from jsonb_array_elements(pg_temp.fn1(:adminC, 'org_policy_status', pg_temp.id('p5')) -> 'not_acknowledged') e
    where e ->> 'user_id' in ('a0482000-0000-0000-0000-0000000000e3', 'a0482000-0000-0000-0000-0000000000e6')) || ' ' ||
  (select count(*) from jsonb_array_elements(pg_temp.fn1(:adminC, 'org_policy_status', pg_temp.id('p5')) -> 'invited') e
    where e ->> 'email' = 'policy-seat-pending-c@test.local'),
  'a0482000-0000-0000-0000-0000000000e3=round a0482000-0000-0000-0000-0000000000e6=joined 0',
  '0482/109: a member is owed a round from its publish or from their joining, whichever is later; a support seat not accepted is not listed as invited');

-- A retirement of yesterday (its guard off for that one statement), retired again.
alter table public.org_policies disable trigger org_policies_guard;
update public.org_policies set retired_at = now() - interval '1 day' where id = pg_temp.id('p4');
alter table public.org_policies enable trigger org_policies_guard;
insert into answers values ('rt2', pg_temp.fn1(:adminC, 'org_policy_retire', pg_temp.id('p4')));
select is(
  (select (v ->> 'already') || '|' || ((v ->> 'retired_at')::timestamptz = now() - interval '1 day')::text from answers where k = 'rt2'),
  'true|true',
  '0482/110: retiring a retired policy again answers the first retirement''s time');

-- viewerC had a Remind now of P5's round 60 hours ago; the others of C are owed its first reminder.
insert into public.org_policy_reminders (organization_id, policy_id, round_version_id, user_id, sent_count, last_sent_at, manual_count, last_reminded_at)
values (:orgC, pg_temp.id('p5'), pg_temp.ver(pg_temp.id('p5'), 1), :viewerC, 0, null, 1, now() - interval '60 hours');
insert into answers values ('c5', pg_temp.claim(6));
select is(
  (select pg_temp.users_of(v -> 'claimed') || ' ' || (v ->> 'more') from answers where k = 'c5'),
  'a0482000-0000-0000-0000-0000000000e0,a0482000-0000-0000-0000-0000000000e1,a0482000-0000-0000-0000-0000000000e2,'
  'a0482000-0000-0000-0000-0000000000e3,a0482000-0000-0000-0000-0000000000e5,a0482000-0000-0000-0000-0000000000e7 false',
  '0482/111: exactly six were due and six were claimed (more is false): never viewerC, reminded 60 hours ago (3 days must pass), nor lateC2 (joined 2 days ago)');

update public.org_policies set last_remind_now_at = now() - interval '13 hours' where id = pg_temp.id('p5');
insert into answers values ('rn13', pg_temp.fn1(:adminC, 'org_policy_remind_now', pg_temp.id('p5')));
select is(
  (select (v ->> 'reminded') || '|' || (v ->> 'reason') || '|' || ((v ->> 'next_allowed_at')::timestamptz = now() + interval '11 hours')::text
     from answers where k = 'rn13'),
  'false|too_soon|true',
  '0482/112: Remind now 13 hours after the last one is too soon, and allowed 24 hours after it');
update public.org_policies set last_remind_now_at = now() - interval '25 hours' where id = pg_temp.id('p5');
insert into answers values ('rn25', pg_temp.fn1(:adminC, 'org_policy_remind_now', pg_temp.id('p5')));
select is(
  (select v ->> 'reminded' from answers where k = 'rn25') || ' ' ||
  (select string_agg(right(r.user_id::text, 2) || ':' || r.sent_count || '/' || r.manual_count, ' ' order by r.user_id)
     from public.org_policy_reminders r where r.round_version_id = pg_temp.ver(pg_temp.id('p5'), 1)) || ' ' ||
  ((select last_remind_now_at from public.org_policies where id = pg_temp.id('p5')) = now())::text,
  'true e0:1/1 e1:1/1 e2:1/1 e3:1/1 e4:0/2 e5:1/1 e6:0/1 e7:1/1 true',
  '0482/113: 25 hours after, Remind now reaches every current member owed the round and counts it on each one''s row (automatic/Remind now)');

-- ── 11. The review of 2026-11-24 (REVIEW-0482.md), each item where only it decides ──
-- An organization of its own (D), so the counts above stay as they were.
\set orgD '\'a0482000-0000-0000-0000-0000000000f1\''
\set ownerD '\'a0482000-0000-0000-0000-0000000000f2\''
\set memberD1 '\'a0482000-0000-0000-0000-0000000000f3\''
\set memberD2 '\'a0482000-0000-0000-0000-0000000000f4\''
\set noNameD '\'a0482000-0000-0000-0000-0000000000f5\''
\set adminMfaD '\'a0482000-0000-0000-0000-0000000000f6\''
\set adminNoNameD '\'a0482000-0000-0000-0000-0000000000f7\''
\set memberD3 '\'a0482000-0000-0000-0000-0000000000f8\''
\set memberD4 '\'a0482000-0000-0000-0000-0000000000f9\''
insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerD,       'policy-owner-d@test.local',     '{"full_name": "Policy Owner D"}'::jsonb),
  (:memberD1,     'policy-member-d1@test.local',   '{"full_name": "Policy Member D1"}'::jsonb),
  (:memberD2,     'policy-member-d2@test.local',   '{"full_name": "Policy Member D2"}'::jsonb),
  (:noNameD,      'policy-no-name-d@test.local',   '{}'::jsonb),
  (:adminMfaD,    'policy-admin-mfa-d@test.local', '{"full_name": "Policy Admin Second Step D"}'::jsonb),
  (:adminNoNameD, 'policy-admin-no-name-d@test.local', '{}'::jsonb),
  (:memberD3,     'policy-member-d3@test.local',   '{"full_name": "Policy Member D3"}'::jsonb),
  (:memberD4,     'policy-member-d4@test.local',   '{"full_name": "Policy Member D4"}'::jsonb);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), :adminMfaD, '0482 admin authenticator', 'totp', 'verified', now(), now());
insert into public.organizations (id, name, slug, mfa_policy) values (:orgD, 'Policy Org D', 'a0482000-org-d', 'optional');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgD, :ownerD,       'owner', now() - interval '50 days', null),
  (:orgD, :memberD1,     'staff', now() - interval '50 days', null),
  (:orgD, :memberD2,     'staff', now() - interval '40 days', null),
  (:orgD, :noNameD,      'staff', now() - interval '30 days', null),
  (:orgD, :adminMfaD,    'admin', now() - interval '50 days', null),
  (:orgD, :adminNoNameD, 'admin', now() - interval '50 days', null),
  (:orgD, :memberD3,     'staff', now() - interval '50 days', null),
  (:orgD, :memberD4,     'staff', now() - interval '50 days', null);
\set tD '\'Rules D\''
\set bD '\'# Rules\nKeep the shared room tidy.\''

-- S6: at most 600 lines, in the database as in the core.
insert into answers values ('d601', pg_temp.save(:ownerD, :orgD, null, 'other', 'Long D',
  (select string_agg('a', E'\n') from generate_series(1, 601))));
select is(
  coalesce(public._org_policy_body_problem((select string_agg('a', E'\n') from generate_series(1, 600))), 'ok') || ' ' ||
  public._org_policy_body_problem((select string_agg('a', E'\n') from generate_series(1, 601))) || ' ' ||
  public._org_policy_body_problem((select string_agg('a', E'\n\n') from generate_series(1, 301))) || ' ' ||
  coalesce(public._org_policy_body_problem((select string_agg('a', E'\n\n') from generate_series(1, 300))), 'ok') || ' ' ||
  (select pg_temp.err(v) || '|' || (v ->> 'detail') from answers where k = 'd601') || ' ' ||
  public._org_policy_body_problem(repeat('b', 30001) || repeat(E'\n', 700)),
  'ok too_many_lines too_many_lines ok 22023|policy_body_invalid|too_many_lines too_long',
  '0482/114: a body holds at most 600 lines (599 line feeds), checked after the length, refused at the save');

-- S1: every admin function asks for the second step where the app's rule asks for it.
insert into answers values ('pD', pg_temp.save(:ownerD, :orgD, null, 'acceptable_use', :tD, :bD));
select pg_temp.keep('pD', (select (v ->> 'policy_id')::uuid from answers where k = 'pD'));
create function pg_temp.admin_calls(p_org uuid, p_policy uuid) returns text[] language sql stable as $$
  select array[
    format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.org_policies_for_admin(%L::uuid) x', p_org),
    format('select public.org_policy_draft(%L::uuid)', p_policy),
    format('select public.org_policy_status(%L::uuid)', p_policy),
    format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.org_policy_acknowledgement_record(%L::uuid) x', p_policy),
    format('select public.org_policy_save_draft(%L::uuid, %L::uuid, ''acceptable_use'', ''Rules D'', %L)', p_org, p_policy,
           E'# Rules\nKeep the shared room tidy.'),
    format('select public.org_policy_publish(%L::uuid, ''new_version'', %L)', p_policy,
           (select text_hash from public.org_policy_versions where policy_id = p_policy and published_at is null)),
    format('select public.org_policy_retire(%L::uuid)', p_policy),
    format('select public.org_policy_remind_now(%L::uuid)', p_policy),
    format('select public.org_policy_discard_draft(%L::uuid)', p_policy)];
$$;
-- Each call in a savepoint of its own, so a call that is let through changes nothing.
create function pg_temp.each_err(p_user uuid, p_aal text, p_calls text[]) returns text language plpgsql as $$
declare
  out text := ''; c text; r jsonb;
begin
  foreach c in array p_calls loop
    begin
      r := pg_temp.as_(p_user, c, p_aal);
      out := out || pg_temp.err(r) || ' ';
      raise exception 'pg_temp.each_err: undone';
    exception when others then
      if sqlerrm <> 'pg_temp.each_err: undone' then raise; end if;
    end;
  end loop;
  return rtrim(out);
end;
$$;
select is(
  pg_temp.each_err(:adminMfaD, 'aal1', pg_temp.admin_calls(:orgD, pg_temp.id('pD'))),
  '42501|aal2_required 42501|aal2_required 42501|aal2_required 42501|aal2_required 42501|aal2_required '
  '42501|aal2_required 42501|aal2_required 42501|aal2_required 42501|aal2_required',
  '0482/115: an admin who has an authenticator, on a password-only session, is refused every admin function (aal2_required)');
select is(
  pg_temp.each_err(:adminMfaD, 'aal2', pg_temp.admin_calls(:orgD, pg_temp.id('pD'))),
  'ok ok ok ok ok ok P0001|policy_not_published P0001|policy_not_published ok',
  '0482/116: with the second step, the same admin passes the rule (every call is the function''s own answer)');
update public.organizations set mfa_policy = 'admins_required' where id = :orgD;
select is(
  pg_temp.each_err(:ownerD, 'aal1', pg_temp.admin_calls(:orgD, pg_temp.id('pD'))),
  '42501|mfa_required 42501|mfa_required 42501|mfa_required 42501|mfa_required 42501|mfa_required '
  '42501|mfa_required 42501|mfa_required 42501|mfa_required 42501|mfa_required',
  '0482/117: where the organization asks owners and admins for an authenticator, an owner with none is refused every admin function (mfa_required)');
update public.organizations set mfa_policy = 'optional' where id = :orgD;

insert into answers values ('pDv1', pg_temp.pub(:ownerD, pg_temp.id('pD'), 'new_version'));
select pg_temp.keep('pDv1', (select (v ->> 'version_id')::uuid from answers where k = 'pDv1'));
-- A member's own reads and acknowledgement are not admin functions: the strictest policy asks nothing of them here.
update public.organizations set mfa_policy = 'all_required' where id = :orgD;
select is(
  pg_temp.err(pg_temp.rows_of(:memberD1, 'org_policies_for_member', :orgD)) || ' ' ||
  pg_temp.err(pg_temp.txt(:memberD1, pg_temp.id('pD'))) || ' ' ||
  pg_temp.err(pg_temp.ack(:memberD1, pg_temp.id('pDv1'))),
  'ok ok ok',
  '0482/118: a member with no authenticator, where every member is asked for one, still reads and acknowledges (no admin rule)');
update public.organizations set mfa_policy = 'optional' where id = :orgD;
select pg_temp.ack(:noNameD, pg_temp.id('pDv1'), 'phone');
-- A member who acknowledged and whose account was then disabled: no longer a current member (never told, counted or listed).
select pg_temp.ack(:memberD4, pg_temp.id('pDv1'));
update public.user_profiles set disabled_at = now() where id = :memberD4;

-- S2 (e): a correction keeps the title and the kind; a draft's kind waits for the publish.
select pg_temp.save(:ownerD, :orgD, pg_temp.id('pD'), 'acceptable_use', 'Rules D changed', :bD || E'\nNo food.');
insert into answers values ('c_title', pg_temp.pub(:ownerD, pg_temp.id('pD'), 'correction'));
select pg_temp.save(:ownerD, :orgD, pg_temp.id('pD'), 'data_handling', :tD, :bD || E'\nNo food.');
insert into answers values ('kind_wait', jsonb_build_object(
  'policy', (select kind from public.org_policies where id = pg_temp.id('pD')),
  'draft', (select kind from public.org_policy_versions where policy_id = pg_temp.id('pD') and published_at is null)));
insert into answers values ('c_kind', pg_temp.pub(:ownerD, pg_temp.id('pD'), 'correction'));
select pg_temp.save(:ownerD, :orgD, pg_temp.id('pD'), 'acceptable_use', :tD, :bD);
insert into answers values ('c_same', pg_temp.pub(:ownerD, pg_temp.id('pD'), 'correction'));
select is(
  (select pg_temp.err(v) from answers where k = 'c_title') || ' ' ||
  (select (v ->> 'policy') || '|' || (v ->> 'draft') from answers where k = 'kind_wait') || ' ' ||
  (select pg_temp.err(v) from answers where k = 'c_kind') || ' ' ||
  (select pg_temp.err(v) from answers where k = 'c_same'),
  'P0001|policy_correction_changes_title acceptable_use|data_handling P0001|policy_correction_changes_kind P0001|policy_draft_unchanged',
  '0482/119: a correction that changes the title or the kind is refused; a published policy keeps its kind while a draft holds another');
select pg_temp.save(:ownerD, :orgD, pg_temp.id('pD'), 'acceptable_use', :tD, :bD || E'\nNo food.');
insert into answers values ('pDv2', pg_temp.pub(:ownerD, pg_temp.id('pD'), 'correction'));
select pg_temp.keep('pDv2', (select (v ->> 'version_id')::uuid from answers where k = 'pDv2'));
select is(
  (select (v ->> 'version_number') || '|' || (v ->> 'needs_acknowledgement') || '|' || (v ->> 'acknowledgement_round') || '|' ||
          (v ->> 'kind') || '|' || (v ->> 'title') from answers where k = 'pDv2'),
  '2|false|1|acceptable_use|Rules D',
  '0482/120: a correction of the words only is version 2 in round 1, with the same kind and title');
select pg_temp.ack(:memberD2, pg_temp.id('pDv2'));

-- S2 (b): the admin's lists say which version each person acknowledged and whether the current text corrects it.
select is(
  (select string_agg((e ->> 'user_id') || ':' || (e ->> 'version_number') || ':' || (e ->> 'corrected_since'), ' ' order by e ->> 'user_id')
     from jsonb_array_elements(pg_temp.fn1(:ownerD, 'org_policy_status', pg_temp.id('pD')) -> 'acknowledged') e) || ' ' ||
  (select (p ->> 'current_version_number') || '|' || (p ->> 'current_needs_acknowledgement') || '|' ||
          (p ->> 'current_published_by_name') || '|' || ((p ->> 'current_published_by')::uuid = :ownerD)::text
     from (select pg_temp.fn1(:ownerD, 'org_policy_status', pg_temp.id('pD')) -> 'policy' as p) x),
  'a0482000-0000-0000-0000-0000000000f3:1:true a0482000-0000-0000-0000-0000000000f4:2:false '
  'a0482000-0000-0000-0000-0000000000f5:1:true 2|false|Policy Owner D|true',
  '0482/121: the status names each acknowledgement''s version, corrected_since when the current text is a later correction of it, and who published the current version');
select is(
  (select (e ->> 'members') || '|' || (e ->> 'acknowledged') || '|' || (e ->> 'acknowledged_before_correction') || '|' ||
          (e ->> 'not_acknowledged') || '|' || (e ->> 'current_published_by_name')
     from jsonb_array_elements(pg_temp.rows_of(:ownerD, 'org_policies_for_admin', :orgD)) e where e ->> 'policy_id' = pg_temp.id('pD')::text),
  '7|3|2|4|Policy Owner D',
  '0482/122: the admin list counts the acknowledgements of an earlier text apart, and names who published the current version');
select is(
  (select string_agg((e ->> 'user_id') || ':' || (e ->> 'version_number') || ':' || (e ->> 'since_acknowledged') || ':' ||
                     (e ->> 'current_version_number') || ':' ||
                     ((e ->> 'member_since')::timestamptz = (select accepted_at from public.organization_members m
                                                              where m.organization_id = :orgD and m.user_id = (e ->> 'user_id')::uuid))::text,
                     ' ' order by e ->> 'user_id')
     from jsonb_array_elements(pg_temp.rows_of(:ownerD, 'org_policy_acknowledgement_record', pg_temp.id('pD'))) e),
  'a0482000-0000-0000-0000-0000000000f3:1:corrected:2:true a0482000-0000-0000-0000-0000000000f4:2:unchanged:2:true '
  'a0482000-0000-0000-0000-0000000000f5:1:corrected:2:true a0482000-0000-0000-0000-0000000000f9:1:corrected:2:true',
  '0482/123: the record (and its CSV) says of each acknowledgement whether the current text corrects it, and keeps when the membership began');

-- S2 (c): a member reads when the policy was last corrected, the text they agreed to and the current text.
select is(
  (select string_agg((e ->> 'acknowledged_version_number') || '|' || (e ->> 'corrected_since_acknowledged') || '|' ||
                     ((e ->> 'last_corrected_at')::timestamptz = now())::text, ' ')
     from jsonb_array_elements(pg_temp.rows_of(:memberD1, 'org_policies_for_member', :orgD)) e) || ' ' ||
  (select string_agg((e ->> 'acknowledged_version_number') || '|' || (e ->> 'corrected_since_acknowledged'), ' ')
     from jsonb_array_elements(pg_temp.rows_of(:memberD2, 'org_policies_for_member', :orgD)) e) || ' ' ||
  (select (t ->> 'version_number') || '|' || (t ->> 'acknowledged_version_number') || '|' || (t ->> 'corrected_since_acknowledged') || '|' ||
          ((t ->> 'last_corrected_at')::timestamptz = now())::text
     from (select pg_temp.txt(:memberD1, pg_temp.id('pD')) as t) x) || ' ' ||
  (select (t ->> 'version_number') || '|' || (t ->> 'is_current') || '|' || (t -> 'my_acknowledgement' ->> 'method')
     from (select pg_temp.txt(:memberD1, pg_temp.id('pD'), 1) as t) x),
  '1|true|true 2|false 2|1|true|true 1|false|web',
  '0482/124: a member is told the policy was corrected after they agreed (and when), and reads both the corrected text and the text they agreed to');

-- S2 (a): every version, with who published it and when.
select is(
  (select string_agg((e ->> 'version_number') || ':' || (e ->> 'needs_acknowledgement') || ':' || (e ->> 'kind') || ':' ||
                     (e ->> 'published_by_name') || ':' || ((e ->> 'published_at')::timestamptz = now())::text, ' '
                     order by (e ->> 'version_number')::int)
     from jsonb_array_elements(pg_temp.fn1(:ownerD, 'org_policy_draft', pg_temp.id('pD')) -> 'versions') e) || ' ' ||
  (select (c ->> 'published_by_name') || '|' || (c ->> 'acknowledgement_round')
     from (select pg_temp.fn1(:ownerD, 'org_policy_draft', pg_temp.id('pD')) -> 'current' as c) x),
  '1:true:acceptable_use:Policy Owner D:true 2:false:acceptable_use:Policy Owner D:true Policy Owner D|1',
  '0482/125: the admin reads every published version with who published it (id and kept name) and when; a correction is needs_acknowledgement false');

-- S2 (d): the correction notices, each handed out once.
create function pg_temp.notices(p_limit integer default 200) returns jsonb language sql as $$
  select pg_temp.as_(null, format('select public.org_policy_correction_notices_claim(%L::integer)', p_limit), 'aal1', 'service_role');
$$;
insert into answers values ('n1', pg_temp.notices());
insert into answers values ('n1b', pg_temp.notices());
select is(
  (select string_agg((e ->> 'user_id') || ':' || (e ->> 'version_number') || ':' || (e ->> 'acknowledged_version_number'), ' '
                     order by e ->> 'user_id')
     from answers, jsonb_array_elements(v -> 'claimed') e where k = 'n1') || ' ' ||
  (select (v ->> 'busy') || '|' || (v ->> 'more') || '|' || jsonb_array_length(v -> 'claimed') from answers where k = 'n1b') || ' ' ||
  (select string_agg(r.user_id || ':' || r.correction_notice_number || ':' || r.sent_count || ':' || coalesce(r.last_reminded_at::text, 'never'),
                     ' ' order by r.user_id)
     from public.org_policy_reminders r where r.policy_id = pg_temp.id('pD')),
  'a0482000-0000-0000-0000-0000000000f3:2:1 a0482000-0000-0000-0000-0000000000f5:2:1 false|false|0 '
  'a0482000-0000-0000-0000-0000000000f3:2:0:never a0482000-0000-0000-0000-0000000000f5:2:0:never',
  '0482/126: the members who agreed to an earlier text are told of the correction once (stamped first, no reminder counted); a second claim hands out nothing');
-- A second correction, by an admin with no name on the account: everyone who agreed to an earlier text is told again, once.
select pg_temp.save(:adminNoNameD, :orgD, pg_temp.id('pD'), 'acceptable_use', :tD, :bD || E'\nNo food. No drinks.');
insert into answers values ('pDv3', pg_temp.pub(:adminNoNameD, pg_temp.id('pD'), 'correction'));
select pg_temp.keep('pDv3', (select (v ->> 'version_id')::uuid from answers where k = 'pDv3'));
insert into answers values ('n2', pg_temp.notices(2));
insert into answers values ('n3', pg_temp.notices());
insert into answers values ('n4', pg_temp.notices());
select is(
  (select string_agg((e ->> 'user_id') || ':' || (e ->> 'version_number') || ':' || (e ->> 'acknowledged_version_number'), ' '
                     order by e ->> 'user_id')
     from answers, jsonb_array_elements(v -> 'claimed') e where k in ('n2', 'n3')) || ' ' ||
  (select (v ->> 'more') from answers where k = 'n2') || '|' || (select (v ->> 'more') from answers where k = 'n3') || ' ' ||
  (select jsonb_array_length(v -> 'claimed') from answers where k = 'n4'),
  'a0482000-0000-0000-0000-0000000000f3:3:1 a0482000-0000-0000-0000-0000000000f4:3:2 a0482000-0000-0000-0000-0000000000f5:3:1 true|false 0',
  '0482/127: a later correction is told once more to each who agreed to an earlier text, the limit and more as the reminders'' claim');

-- S1 for the words: a read only an admin may make asks for the second step; a member's read does not.
select is(
  pg_temp.err(pg_temp.as_(:adminMfaD, format('select public.org_policy_text(%L::uuid, 1)', pg_temp.id('pD')), 'aal1')) || ' ' ||
  (pg_temp.as_(:adminMfaD, format('select public.org_policy_text(%L::uuid, null)', pg_temp.id('pD')), 'aal1') ->> 'version_number') || ' ' ||
  (pg_temp.as_(:adminMfaD, format('select public.org_policy_text(%L::uuid, 1)', pg_temp.id('pD')), 'aal2') ->> 'version_number'),
  '42501|aal2_required 3 1',
  '0482/128: an admin with an authenticator reads an earlier version only with the second step; the current version is a member''s read');

-- S2 (e) and the kind: a new version may change the kind and the title, and the policy takes them.
select pg_temp.save(:ownerD, :orgD, pg_temp.id('pD'), 'data_handling', 'Rules D, data', :bD || E'\nNo food. No drinks.');
insert into answers values ('pDv4', pg_temp.pub(:ownerD, pg_temp.id('pD'), 'new_version'));
select is(
  (select kind || '|' || title || '|' || current_version from public.org_policies where id = pg_temp.id('pD')) || ' ' ||
  (select string_agg(kind, ',' order by version_number) from public.org_policy_versions
    where policy_id = pg_temp.id('pD') and published_at is not null),
  'data_handling|Rules D, data|4 acceptable_use,acceptable_use,acceptable_use,data_handling',
  '0482/129: a new version changes the kind and the title; each version keeps the kind it was published with');

-- S4: after corrections and a retirement, a member's default read is what they agreed to.
select pg_temp.fn1(:ownerD, 'org_policy_retire', pg_temp.id('pD'));
select is(
  (select (t ->> 'version_number') || '|' || (t ->> 'is_current') || '|' || coalesce(t -> 'my_acknowledgement' ->> 'method', 'none')
     from (select pg_temp.txt(:memberD1, pg_temp.id('pD')) as t) x) || ' ' ||
  (select (t ->> 'version_number') || '|' || coalesce(t -> 'my_acknowledgement' ->> 'method', 'none')
     from (select pg_temp.txt(:noNameD, pg_temp.id('pD')) as t) x) || ' ' ||
  (select (t ->> 'version_number') from (select pg_temp.txt(:memberD2, pg_temp.id('pD')) as t) x) || ' ' ||
  (select (t ->> 'version_number') || '|' || (t ->> 'is_current') from (select pg_temp.txt(:memberD1, pg_temp.id('pD'), 4) as t) x) || ' ' ||
  pg_temp.err(pg_temp.txt(:memberD1, pg_temp.id('pD'), 3)) || ' ' ||
  pg_temp.err(pg_temp.txt(:memberD3, pg_temp.id('pD'))) || ' ' ||
  (select jsonb_array_length(v -> 'claimed') from (select pg_temp.notices() as v) x),
  '1|false|web 1|phone 2 4|true 42501|policy_not_allowed 42501|policy_not_allowed 0',
  '0482/130: a retired policy''s default read is the version the member agreed to; they read its last version too, nothing else; one who never agreed reads nothing; no notice for a retired policy');

-- S3: a deleted account that had no name keeps a label and when the membership began; a name is kept as it was.
delete from auth.users where id in (:noNameD, :memberD1, :adminNoNameD);
select is(
  (select string_agg(coalesce(e ->> 'user_id', 'gone') || ':' || (e ->> 'name') || ':' || (e ->> 'account_deleted') || ':' ||
                     ((e ->> 'member_since')::timestamptz = now() - interval '30 days')::text,
                     ' ' order by e ->> 'name')
     from jsonb_array_elements(pg_temp.rows_of(:ownerD, 'org_policy_acknowledgement_record', pg_temp.id('pD'))) e
    where e ->> 'user_id' is null) || ' ' ||
  (select string_agg(version_number || ':' || coalesce(published_by::text, 'gone') || ':' || published_by_name, ' ' order by version_number)
     from public.org_policy_versions where policy_id = pg_temp.id('pD') and version_number in (2, 3)),
  'gone:Former member, no name on the account:true:true gone:Policy Member D1:true:false '
  '2:a0482000-0000-0000-0000-0000000000f2:Policy Owner D 3:gone:Former member, no name on the account',
  '0482/131: after an account deletion a record names the kept name, or for an account with none the label and when the membership began; a version''s publisher the same');

-- The notices claim's lock key and grants.
savepoint notices_grant;
grant execute on function public.org_policy_correction_notices_claim(integer) to authenticated, anon;
select is(
  (select count(*)::integer from pg_proc p where p.prosrc like '%4820002%') || ' ' ||
  pg_temp.err(pg_temp.as_(:ownerA, 'select public.org_policy_correction_notices_claim(1)')) || ' ' ||
  pg_temp.err(pg_temp.as_(null, 'select public.org_policy_correction_notices_claim(1)', 'aal1', 'anon')),
  '1 42501|policy_not_allowed 42501|policy_not_allowed',
  '0482/132: one function names the lock key 4820002 (the notices claim); even with EXECUTE it refuses a member and a signed-out caller');
rollback to savepoint notices_grant;
select is(
  pg_temp.err(pg_temp.as_(:ownerA, 'select public.org_policy_correction_notices_claim(1)')) || ' ' ||
  pg_temp.err(pg_temp.as_(null, 'select public.org_policy_correction_notices_claim(1)', 'aal1', 'anon')),
  '42501 42501',
  '0482/133: without the grant, authenticated and anon are refused the notices claim by its grant');

-- ── 12. S7 (the coordinator, 2026-11-24): a support (act-as) seat reads what an admin reads, and never writes ──
-- An organization of its own (E). A live seat, an expired seat, and a support person who is a real admin of E
-- (act-as writes no seat for a real member: only its session row) and is on a live seat in D.
\set orgE '\'a0482000-0000-0000-0000-000000000101\''
\set ownerE '\'a0482000-0000-0000-0000-000000000102\''
\set seatE '\'a0482000-0000-0000-0000-000000000103\''
\set seatOldE '\'a0482000-0000-0000-0000-000000000104\''
\set supportE '\'a0482000-0000-0000-0000-000000000105\''
\set memberE '\'a0482000-0000-0000-0000-000000000106\''
insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerE,   'policy-owner-e@test.local',    '{"full_name": "Policy Owner E"}'::jsonb),
  (:seatE,    'policy-seat-e@test.local',     '{"full_name": "Policy Support Seat E"}'::jsonb),
  (:seatOldE, 'policy-seat-old-e@test.local', '{"full_name": "Policy Old Seat E"}'::jsonb),
  (:supportE, 'policy-support-e@test.local',  '{"full_name": "Policy Support Admin E"}'::jsonb),
  (:memberE,  'policy-member-e@test.local',   '{"full_name": "Policy Member E"}'::jsonb);
insert into public.organizations (id, name, slug, mfa_policy) values (:orgE, 'Policy Org E', 'a0482000-org-e', 'optional');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgE, :ownerE,   'owner', now() - interval '50 days', null),
  (:orgE, :seatE,    'owner', now() - interval '1 hour',  now() + interval '1 hour'),
  (:orgE, :seatOldE, 'owner', now() - interval '3 hours', now() - interval '1 hour'),
  (:orgE, :supportE, 'admin', now() - interval '50 days', null),
  (:orgE, :memberE,  'staff', now() - interval '50 days', null),
  (:orgD, :supportE, 'owner', now() - interval '1 hour',  now() + interval '1 hour');
insert into public.platform_impersonation_sessions (admin_user_id, target_organization_id, started_at, expires_at) values
  (:supportE, :orgE, now() - interval '10 minutes', now() + interval '50 minutes'),
  (:supportE, :orgD, now() - interval '10 minutes', now() + interval '50 minutes');
\set tE '\'Rules E\''
\set bE '\'# Rules\nClose the gate.\''
insert into answers values ('pE', pg_temp.save(:ownerE, :orgE, null, 'acceptable_use', :tE, :bE));
select pg_temp.keep('pE', (select (v ->> 'policy_id')::uuid from answers where k = 'pE'));
select pg_temp.pub(:ownerE, pg_temp.id('pE'), 'new_version');
select pg_temp.save(:ownerE, :orgE, pg_temp.id('pE'), 'acceptable_use', :tE, :bE || E'\nClose it quietly.');
insert into answers values ('pE2', pg_temp.save(:ownerE, :orgE, null, 'other', 'Draft E', 'Not yet.'));
select pg_temp.keep('pE2', (select (v ->> 'policy_id')::uuid from answers where k = 'pE2'));

-- The five writes, seven calls (publish twice: a new version and a correction), each valid for a real admin.
create function pg_temp.seat_writes(p_org uuid, p_policy uuid) returns text[] language sql stable as $$
  select array[
    format('select public.org_policy_save_draft(%L::uuid, null, ''other'', ''Seat E'', ''From support.'')', p_org),
    format('select public.org_policy_save_draft(%L::uuid, %L::uuid, ''acceptable_use'', ''Rules E'', %L)', p_org, p_policy,
           E'# Rules\nClose the gate.\nFrom support.'),
    format('select public.org_policy_publish(%L::uuid, ''correction'', %L)', p_policy, pg_temp.draft_hash(p_policy)),
    format('select public.org_policy_publish(%L::uuid, ''new_version'', %L)', p_policy, pg_temp.draft_hash(p_policy)),
    format('select public.org_policy_retire(%L::uuid)', p_policy),
    format('select public.org_policy_remind_now(%L::uuid)', p_policy),
    format('select public.org_policy_discard_draft(%L::uuid)', p_policy)];
$$;
-- Every row of the four tables for one organization.
create function pg_temp.org_rows(p_org uuid) returns text language sql stable as $$
  select md5(
    coalesce((select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.org_policies x where x.organization_id = p_org), '') || '/' ||
    coalesce((select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.org_policy_versions x where x.organization_id = p_org), '') || '/' ||
    coalesce((select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.org_policy_acknowledgements x where x.organization_id = p_org), '') || '/' ||
    coalesce((select string_agg(to_jsonb(x)::text, ',' order by x::text) from public.org_policy_reminders x where x.organization_id = p_org), ''));
$$;
-- Each call kept (not undone), so a write let through shows in the rows.
create function pg_temp.each_kept(p_user uuid, p_calls text[]) returns text language plpgsql as $$
declare
  out text := ''; c text;
begin
  foreach c in array p_calls loop
    out := out || pg_temp.err(pg_temp.as_(p_user, c)) || ' ';
  end loop;
  return rtrim(out);
end;
$$;
insert into answers values ('rowsE', to_jsonb(pg_temp.org_rows(:orgE)));
-- The calls and the rows read after them are two statements (a statement's reads see the tables as it began).
insert into answers values ('seatE_w', to_jsonb(pg_temp.each_kept(:seatE, pg_temp.seat_writes(:orgE, pg_temp.id('pE')))));
select is(
  (select v #>> '{}' from answers where k = 'seatE_w') || ' ' ||
  ((select v #>> '{}' from answers where k = 'rowsE') = pg_temp.org_rows(:orgE))::text,
  '42501|policy_act_as_read_only 42501|policy_act_as_read_only 42501|policy_act_as_read_only 42501|policy_act_as_read_only '
  '42501|policy_act_as_read_only 42501|policy_act_as_read_only 42501|policy_act_as_read_only true',
  '0482/134: a live support seat is refused each write: a new draft, a draft of a published policy, a correction, a new version, retire, Remind now and discard (42501 policy_act_as_read_only), and nothing changed');
select is(
  (pg_temp.rows_of(:seatE, 'org_policies_for_admin', :orgE) = pg_temp.rows_of(:ownerE, 'org_policies_for_admin', :orgE))::text || ' ' ||
  (pg_temp.fn1(:seatE, 'org_policy_draft', pg_temp.id('pE')) = pg_temp.fn1(:ownerE, 'org_policy_draft', pg_temp.id('pE')))::text || ' ' ||
  (pg_temp.fn1(:seatE, 'org_policy_status', pg_temp.id('pE')) = pg_temp.fn1(:ownerE, 'org_policy_status', pg_temp.id('pE')))::text || ' ' ||
  (pg_temp.rows_of(:seatE, 'org_policy_acknowledgement_record', pg_temp.id('pE'))
     = pg_temp.rows_of(:ownerE, 'org_policy_acknowledgement_record', pg_temp.id('pE')))::text || ' ' ||
  -- the words without the caller's own fields (what the caller acknowledged and owes)
  (pg_temp.txt(:seatE, pg_temp.id('pE'), 1) - array['my_acknowledgement', 'owed', 'acknowledged_in_current_round',
     'acknowledged_version_number', 'corrected_since_acknowledged']
   = pg_temp.txt(:ownerE, pg_temp.id('pE'), 1) - array['my_acknowledgement', 'owed', 'acknowledged_in_current_round',
     'acknowledged_version_number', 'corrected_since_acknowledged'])::text || ' ' ||
  jsonb_array_length(pg_temp.rows_of(:seatE, 'org_policies_for_admin', :orgE)) || ' ' ||
  pg_temp.err(pg_temp.fn1(:seatE, 'org_policy_draft', pg_temp.id('pE'))) || ' ' ||
  pg_temp.err(pg_temp.txt(:seatE, pg_temp.id('pE2'))) || ' ' || pg_temp.err(pg_temp.txt(:memberE, pg_temp.id('pE2'))),
  'true true true true true 2 ok P0001|policy_not_published 42501|policy_not_allowed',
  '0482/135: the same seat reads what an owner reads: the admin list (the draft policy too), the draft, the status, the record and the words, and a draft policy as an admin does (not published), not as a member');
select is(
  pg_temp.each_err(:seatOldE, 'aal1', pg_temp.admin_calls(:orgE, pg_temp.id('pE'))),
  '42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only '
  '42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only 42501|policy_admins_only',
  '0482/136: an expired seat is no member: every admin read and write refuses it (policy_admins_only)');
select is(
  pg_temp.each_err(:supportE, 'aal1', pg_temp.seat_writes(:orgE, pg_temp.id('pE'))) || ' / ' ||
  pg_temp.each_err(:supportE, 'aal1', pg_temp.admin_calls(:orgD, pg_temp.id('pD'))),
  'ok ok ok ok ok ok ok / ok ok ok ok 42501|policy_act_as_read_only 42501|policy_act_as_read_only '
  '42501|policy_act_as_read_only 42501|policy_act_as_read_only 42501|policy_act_as_read_only',
  '0482/137: a support person who is a real admin of E writes there as any admin, also while acting as E; their live seat in D reads there and writes nothing');
select is(
  (select string_agg(p.proname || ':' ||
            (strpos(p.prosrc, 'if public._org_policy_caller_is_act_as(') > strpos(p.prosrc, 'perform public.security_events_reader_check(')
             and strpos(p.prosrc, 'perform public.security_events_reader_check(') > 0
             and strpos(p.prosrc, 'if public._org_policy_caller_is_act_as(')
                 < (select min(n) from unnest(array[strpos(p.prosrc, ' for update'), strpos(p.prosrc, 'insert into public.'),
                                                    strpos(p.prosrc, 'update public.'), strpos(p.prosrc, 'delete from public.'),
                                                    length(p.prosrc)]) n where n > 0))::text,
            ',' order by p.proname)
     from pg_proc p
    where pg_temp.is_ours(p.oid) and (p.prosrc like '%security_events_reader_check%' or p.prosrc like '%_org_policy_caller_is_act_as%')),
  'org_policies_for_admin:false,org_policy_acknowledgement_record:false,org_policy_discard_draft:true,org_policy_draft:false,'
  'org_policy_publish:true,org_policy_remind_now:true,org_policy_retire:true,org_policy_save_draft:true,org_policy_status:false,org_policy_text:false',
  '0482/138: each of the five writes refuses a support seat right after the authenticator rule, before it locks or writes a row; no read does');

select * from finish();
rollback;
