-- supabase/tests/0477_platform_security_briefing.test.sql
-- Proves migration 0477: the six read functions behind the platform
-- console's security briefing.
--   public._security_briefing_members(uuid)                       private
--   public._security_briefing_change_counts(uuid)                 private: the week's counting rules, once
--   public.platform_security_briefing_members()                   every organization's member state
--   public.platform_security_briefing_events()                    events, this week and last
--   public.platform_security_briefing_changes()                   admin and sign-in policy changes
--   public.platform_security_briefing_for_organization(uuid)      one organization in detail
--
-- WHAT IS WORTH PINNING
--   1. The grant is the whole control. anon and authenticated hold EXECUTE on
--      none of the six; service_role on the four public ones and nothing
--      else; nobody on the two private ones. No body names any of the four words
--      security_invariants INV-25 accepts as a gate, so if EXECUTE ever
--      reaches authenticated INV-25 names the function: shown here by
--      granting it inside a savepoint. With that grant in place the second
--      lock in each body still refuses a member and a signed-out caller.
--   2. Read-only: STABLE, and no write statement in any body (the write
--      forms of the security invariant suite's bare word list).
--   3. Who is a member: accepted, not an act-as seat (live or expired), not
--      disabled. Who has a second step: any verified factor, of any type and
--      name; an unverified one does not count.
--   4. A sign-in not used for 30 days: not ended, last used BEFORE now minus
--      30 days (exactly 30 days is not), with refreshed_at read as UTC
--      whatever the session's time zone is.
--   5. The all-organizations numbers equal the per-organization function's
--      for the same data; totals count a person in two organizations once.
--   6. Reported sign-ins come from sign_in_alerts (status not_me, answered
--      in the last 7 days) and never from security_events.
--   7. Events: split by outcome and by week at the boundary, the two passkey
--      reasons counted for this week only, the rows about no organization
--      kept apart, the oldest event time.
--   8. The admin-change rules: promoted, demoted or removed, ownership moved
--      once per transfer, never as an admin added or removed and never set
--      aside for an invitation; both shapes of a role change; the sign-in
--      policy loosened, tightened or neither.
--   9. Every object has exactly the documented keys, so no session id,
--      address, device or factor detail can appear; before and after are cut
--      down to four known keys; the caps (500 organizations, 200 people, 200
--      changes) and their flags.
--  10. The counting rules are written once: one organization's detail carries
--      the very object the read of all organizations gives for it (zeros
--      when that read does not list it), and its numbers stay exact when
--      its list of rows is cut short.
--  11. An invitation acceptance seen twice is not a promotion or a demotion,
--      and nothing else is set aside: the same organization, the same
--      member, the same UTC day whatever the session's time zone, the role
--      the invitation gave, and recorded no later than the acceptance (at
--      the very same time counts). A member named only by a membership id
--      is looked up in the row's own organization.
--  12. Admins added counts people, not rows: whoever joined this week as an
--      admin or owner (exactly 168 hours ago is this week) or was promoted
--      this week, each once for an organization; an ownership move adds
--      nobody.
--  13. A member's name is cut at 200 characters, and a value of an audit row
--      that is not text is not returned.
--  14. 7, 14 and 30 days are 168, 336 and 720 hours, also in a session whose
--      zone changed its clocks inside the window.
--
-- now() is fixed for the whole transaction and every function uses it, so
-- every time below is computed from now() and no assertion depends on the
-- clock. Namespace a0477000. Every person, organization and value is made
-- up. Wrapped in begin/rollback: nothing leaks. Run via `supabase test db`
-- after `supabase db reset`.

begin;

select plan(107);

\set orgA '\'a0477000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0477000-0000-0000-0000-0000000000b1\''
\set orgC '\'a0477000-0000-0000-0000-0000000000c1\''
\set orgZ '\'a0477000-0000-0000-0000-0000000000d1\''
\set ownerA      '\'a0477000-0000-0000-0000-000000000001\''
\set adminNone   '\'a0477000-0000-0000-0000-000000000002\''
\set adminUnv    '\'a0477000-0000-0000-0000-000000000003\''
\set adminOld    '\'a0477000-0000-0000-0000-000000000004\''
\set manager     '\'a0477000-0000-0000-0000-000000000005\''
\set staffNone   '\'a0477000-0000-0000-0000-000000000006\''
\set staffIdle   '\'a0477000-0000-0000-0000-000000000007\''
\set edgeIn      '\'a0477000-0000-0000-0000-000000000008\''
\set edgeOut     '\'a0477000-0000-0000-0000-000000000009\''
\set twoOrgs     '\'a0477000-0000-0000-0000-00000000000a\''
\set disabled    '\'a0477000-0000-0000-0000-00000000000b\''
\set actas       '\'a0477000-0000-0000-0000-00000000000c\''
\set actasOld    '\'a0477000-0000-0000-0000-00000000000d\''
\set invited     '\'a0477000-0000-0000-0000-00000000000e\''
\set outsider    '\'a0477000-0000-0000-0000-00000000000f\''
\set ownerB      '\'a0477000-0000-0000-0000-000000000010\''
\set staffB      '\'a0477000-0000-0000-0000-000000000011\''
\set ownerC      '\'a0477000-0000-0000-0000-000000000012\''
-- Membership ids (the audit rows name a membership).
\set mOwnerA     '\'a0477000-0000-0000-0000-000000000701\''
\set mAdminNone  '\'a0477000-0000-0000-0000-000000000702\''
\set mAdminUnv   '\'a0477000-0000-0000-0000-000000000703\''
\set mAdminOld   '\'a0477000-0000-0000-0000-000000000704\''
\set mManager    '\'a0477000-0000-0000-0000-000000000705\''
\set mStaffNone  '\'a0477000-0000-0000-0000-000000000706\''
\set mStaffIdle  '\'a0477000-0000-0000-0000-000000000707\''
\set mEdgeIn     '\'a0477000-0000-0000-0000-000000000708\''
\set mStaffB     '\'a0477000-0000-0000-0000-000000000811\''
\set mGone       '\'a0477000-0000-0000-0000-0000000007ff\''

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
     and p.proname like '%security\_briefing%';
$$;

-- One organization's object in a list answer; the sorted keys of an object.
create function pg_temp.org_of(p_answer jsonb, p_org uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(p_answer -> 'organizations') e
   where e ->> 'organization_id' = p_org::text;
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

-- Fixture writers (as the tables' owner).
create function pg_temp.ev(p_org uuid, p_at timestamptz, p_category text, p_outcome text, p_reason text, p_count integer)
returns void language sql as $$
  insert into public.security_events (minute, category, outcome, reason, source, organization_id, event_count, dedupe_key)
  values (date_trunc('minute', p_at, 'UTC'), p_category, p_outcome, p_reason, 'web', p_org, p_count,
          md5(gen_random_uuid()::text));
$$;
create function pg_temp.audit(p_org uuid, p_actor uuid, p_event text, p_at timestamptz, p_meta jsonb)
returns void language sql as $$
  insert into public.audit_logs (organization_id, user_id, event, metadata, created_at)
  values (p_org, p_actor, p_event, p_meta, p_at);
$$;
-- A role change as the database records it (0467).
create function pg_temp.role_row(p_org uuid, p_membership uuid, p_target uuid, p_before text, p_after text,
                                 p_at timestamptz, p_actor uuid, p_made_as text)
returns void language sql as $$
  select pg_temp.audit(p_org, p_actor, 'user.role.changed', p_at, jsonb_build_object(
    'entity_type', 'organization_member', 'entity_id', p_membership, 'warehouse_id', null,
    'before', jsonb_build_object('role', p_before), 'after', jsonb_build_object('role', p_after),
    'reason', null, 'source', 'database', 'made_as', p_made_as, 'aal', null,
    'target_user_id', p_target));
$$;
-- A sign-in policy change as the database records it (0467).
create function pg_temp.policy_row(p_org uuid, p_before text, p_after text, p_at timestamptz)
returns void language sql as $$
  select pg_temp.audit(p_org, null, 'organization.mfa_policy.changed', p_at, jsonb_build_object(
    'entity_type', 'organization', 'entity_id', p_org, 'warehouse_id', null,
    'before', jsonb_build_object('mfa_policy', p_before), 'after', jsonb_build_object('mfa_policy', p_after),
    'reason', null, 'source', 'database', 'made_as', 'authenticated', 'aal', 'aal2'));
$$;
-- An invitation accepted, as the app records it: by the member, with the
-- role the invitation gave.
create function pg_temp.invite(p_org uuid, p_user uuid, p_role text, p_at timestamptz)
returns void language sql as $$
  select pg_temp.audit(p_org, p_user, 'user.invite.accepted', p_at, jsonb_build_object(
    'invite_id', gen_random_uuid(), 'role', p_role, 'warehouse_id', null, 'charter_id', null,
    'charter_ids', '[]'::jsonb, 'all_warehouses', false));
$$;
-- One organization's counts of the week as its detail carries them, and
-- the object expected: promoted, demoted or removed, ownership moved, the
-- policy loosened, tightened, other, and admins added.
create function pg_temp.week(p_org uuid) returns jsonb language sql as $$
  select public.platform_security_briefing_for_organization(p_org) -> 'changes_this_week';
$$;
create function pg_temp.counts(p_org uuid, p_promoted int, p_demoted int, p_moved int, p_loosened int,
                               p_tightened int, p_other int, p_added int)
returns jsonb language sql as $$
  select jsonb_build_object('organization_id', p_org,
    'admins_promoted', p_promoted, 'admins_demoted_or_removed', p_demoted, 'ownership_moved', p_moved,
    'sign_in_policy_loosened', p_loosened, 'sign_in_policy_tightened', p_tightened,
    'sign_in_policy_changed_other', p_other, 'admins_added_this_week', p_added);
$$;
create function pg_temp.alert(p_user uuid, p_status text, p_resolved timestamptz)
returns void language sql as $$
  insert into public.sign_in_alerts (user_id, new_device, new_country, client, device_label, device_family,
                                     status, resolved_at, created_at)
  values (p_user, true, false, 'web', 'Chrome on macOS', 'Chrome on macOS', p_status, p_resolved,
          now() - interval '10 days');
$$;

-- What the database held before this file's rows: the totals below are
-- asserted as this plus the fixtures.
create temporary table base as
  select public.platform_security_briefing_members() as members,
         public.platform_security_briefing_events() as events,
         public.platform_security_briefing_changes() as changes;

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,    'owner-a@example.com',          '{"full_name": "Briefing Owner A"}'::jsonb),
  (:adminNone, 'admin-none@example.com',       '{"full_name": "Briefing Admin None"}'::jsonb),
  (:adminUnv,  'admin-unverified@example.com', '{"full_name": "Briefing Admin Unverified"}'::jsonb),
  (:adminOld,  'admin-old@example.com',        '{"full_name": "Briefing Admin Old"}'::jsonb),
  (:manager,   'manager-bridge@example.com',   '{"full_name": "Briefing Manager Bridge"}'::jsonb),
  -- No name: listed by the email.
  (:staffNone, 'aaa-staff-none@example.com',   '{}'::jsonb),
  (:staffIdle, 'staff-idle@example.com',       '{"full_name": "Briefing Staff Idle"}'::jsonb),
  (:edgeIn,    'staff-edge-in@example.com',    '{"full_name": "Briefing Staff Edge In"}'::jsonb),
  (:edgeOut,   'staff-edge-out@example.com',   '{"full_name": "Briefing Staff Edge Out"}'::jsonb),
  (:twoOrgs,   'two-orgs@example.com',         '{"full_name": "Briefing Two Orgs"}'::jsonb),
  (:disabled,  'disabled@example.com',         '{"full_name": "Briefing Disabled"}'::jsonb),
  (:actas,     'act-as@example.com',           '{"full_name": "Briefing Act As"}'::jsonb),
  (:actasOld,  'act-as-old@example.com',       '{"full_name": "Briefing Act As Old"}'::jsonb),
  (:invited,   'invited@example.com',          '{"full_name": "Briefing Invited"}'::jsonb),
  (:outsider,  'outsider@example.org',         '{"full_name": "Briefing Outsider"}'::jsonb),
  (:ownerB,    'owner-b@example.com',          '{"full_name": "Briefing Owner B"}'::jsonb),
  (:staffB,    'staff-b@example.com',          '{"full_name": "Briefing Staff B"}'::jsonb),
  (:ownerC,    'owner-c@example.com',          '{"full_name": "Briefing Owner C"}'::jsonb);
update public.user_profiles set disabled_at = now() where id = :disabled;

insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Example Academy',   'a0477000-example-academy',   'admins_required'),
  (:orgB, 'Example Charter',   'a0477000-example-charter',   'optional'),
  (:orgC, 'Example Institute', 'a0477000-example-institute', 'all_required'),
  (:orgZ, 'Example Empty',     'a0477000-example-empty',     'optional');

-- Example Academy: ten members (four of them owner or admin), plus a
-- disabled admin, two act-as seats and an invitation that count for nothing.
insert into public.organization_members (id, organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:mOwnerA,    :orgA, :ownerA,    'owner',   now() - interval '100 days', null),
  (:mAdminNone, :orgA, :adminNone, 'admin',   now() - interval '3 days', null),
  -- Joined exactly 7 days ago: still this week. A microsecond earlier: not.
  (:mAdminUnv,  :orgA, :adminUnv,  'admin',   now() - interval '7 days', null),
  (:mAdminOld,  :orgA, :adminOld,  'admin',   now() - interval '7 days' - interval '1 microsecond', null),
  (:mManager,   :orgA, :manager,   'manager', now() - interval '50 days', null),
  (:mStaffNone, :orgA, :staffNone, 'staff',   now() - interval '50 days', null),
  (:mStaffIdle, :orgA, :staffIdle, 'staff',   now() - interval '50 days', null),
  (:mEdgeIn,    :orgA, :edgeIn,    'staff',   now() - interval '50 days', null),
  (gen_random_uuid(), :orgA, :edgeOut,  'staff', now() - interval '50 days', null),
  (gen_random_uuid(), :orgA, :twoOrgs,  'staff', now() - interval '50 days', null),
  (gen_random_uuid(), :orgA, :disabled, 'admin', now() - interval '1 day', null),
  (gen_random_uuid(), :orgA, :actas,    'owner', now(), now() + interval '1 hour'),
  (gen_random_uuid(), :orgA, :actasOld, 'owner', now() - interval '2 days', now() - interval '1 hour'),
  (gen_random_uuid(), :orgA, :invited,  'admin', null, null),
  (gen_random_uuid(), :orgB, :ownerB,   'owner', now() - interval '100 days', null),
  (gen_random_uuid(), :orgB, :twoOrgs,  'admin', now() - interval '1 day', null),
  (:mStaffB,    :orgB, :staffB,    'staff',   now() - interval '20 days', null),
  (gen_random_uuid(), :orgC, :ownerC,   'owner', now() - interval '100 days', null);

-- Second steps. Verified: an authenticator app, a factor with the passkey
-- bridge's reserved name, a factor of another type. Not a second step: an
-- unverified factor on its own.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values
  (gen_random_uuid(), :ownerA,    'Briefing authenticator',  'totp',     'verified',   now(), now()),
  (gen_random_uuid(), :adminUnv,  'Briefing not finished',   'totp',     'unverified', now(), now()),
  (gen_random_uuid(), :adminOld,  'Briefing authenticator',  'totp',     'verified',   now(), now()),
  (gen_random_uuid(), :manager,   'sp-passkey-bridge-0477',  'totp',     'verified',   now(), now()),
  (gen_random_uuid(), :staffIdle, 'Briefing authenticator',  'totp',     'verified',   now(), now()),
  (gen_random_uuid(), :staffIdle, 'Briefing second attempt', 'totp',     'unverified', now(), now()),
  (gen_random_uuid(), :edgeIn,    'Briefing security key',   'webauthn', 'verified',   now(), now()),
  (gen_random_uuid(), :edgeOut,   'Briefing authenticator',  'totp',     'verified',   now(), now()),
  (gen_random_uuid(), :ownerB,    'Briefing authenticator',  'totp',     'verified',   now(), now()),
  (gen_random_uuid(), :ownerC,    'Briefing authenticator',  'totp',     'verified',   now(), now());

-- Sign-ins. refreshed_at is a timestamp without time zone that holds UTC.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, not_after) values
  -- Renewed today.
  ('a0477000-0000-0000-0000-000000000501', :ownerA,    now() - interval '10 days',  now(), now() at time zone 'utc', null),
  -- Not ended (it ends tomorrow), started 100 days ago, never renewed: idle.
  ('a0477000-0000-0000-0000-000000000502', :adminOld,  now() - interval '100 days', now(), null, now() + interval '1 day'),
  -- Ended this instant: not counted.
  ('a0477000-0000-0000-0000-000000000503', :adminOld,  now() - interval '100 days', now(), null, now()),
  -- No start and no renewal on record: a sign-in, never idle.
  ('a0477000-0000-0000-0000-000000000504', :manager,   null, now(), null, null),
  -- Started 50 days ago, renewed an hour ago: in use.
  ('a0477000-0000-0000-0000-000000000505', :staffNone, now() - interval '50 days',  now(), (now() - interval '1 hour') at time zone 'utc', null),
  -- Staff Idle: one in use, one renewed 31 days ago, one started 45 days
  -- ago and never renewed, one that ended yesterday.
  ('a0477000-0000-0000-0000-000000000506', :staffIdle, now() - interval '2 days',   now(), (now() - interval '1 hour') at time zone 'utc', null),
  ('a0477000-0000-0000-0000-000000000507', :staffIdle, now() - interval '60 days',  now(), (now() - interval '31 days') at time zone 'utc', null),
  ('a0477000-0000-0000-0000-000000000508', :staffIdle, now() - interval '45 days',  now(), null, null),
  ('a0477000-0000-0000-0000-000000000509', :staffIdle, now() - interval '90 days',  now(), null, now() - interval '1 day'),
  -- The boundary: last used exactly 30 days ago is not idle; a microsecond
  -- earlier is.
  ('a0477000-0000-0000-0000-00000000050a', :edgeIn,    now() - interval '40 days',  now(), (now() - interval '30 days') at time zone 'utc', null),
  ('a0477000-0000-0000-0000-00000000050b', :edgeOut,   now() - interval '40 days',  now(), (now() - interval '30 days' - interval '1 microsecond') at time zone 'utc', null),
  ('a0477000-0000-0000-0000-00000000050c', :twoOrgs,   now() - interval '35 days',  now(), null, null),
  ('a0477000-0000-0000-0000-00000000050d', :ownerB,    now() - interval '70 days',  now(), (now() - interval '33 days') at time zone 'utc', null),
  -- Idle sign-ins of accounts that are nobody's member here.
  ('a0477000-0000-0000-0000-00000000050e', :disabled,  now() - interval '80 days',  now(), null, null),
  ('a0477000-0000-0000-0000-00000000050f', :outsider,  now() - interval '80 days',  now(), null, null),
  ('a0477000-0000-0000-0000-000000000510', :actas,     now() - interval '80 days',  now(), null, null);

-- Sign-in alerts. Counted: answered "not me" in the last 7 days (exactly 7
-- days ago included), by a member.
select pg_temp.alert(:adminNone, 'not_me', now() - interval '1 day');
select pg_temp.alert(:twoOrgs,   'not_me', now() - interval '2 days');
select pg_temp.alert(:staffNone, 'open',   null);
select pg_temp.alert(:staffNone, 'was_me', now());
select pg_temp.alert(:staffNone, 'not_me', now() - interval '8 days');
select pg_temp.alert(:staffNone, 'not_me', now() - interval '7 days');
select pg_temp.alert(:staffNone, 'not_me', now() - interval '7 days' - interval '1 microsecond');
select pg_temp.alert(:staffB,    'not_me', now());
select pg_temp.alert(:outsider,  'not_me', now());
select pg_temp.alert(:disabled,  'not_me', now());
select pg_temp.alert(:actas,     'not_me', now());

-- Security events. ev() cuts the time to its minute. now - 7 days + 1
-- minute is always this week and now - 7 days - 1 minute always last week,
-- whatever the second is; the same at 14 days.
select pg_temp.ev(:orgA, now() - interval '1 minute',  'password_guessing', 'blocked', 'wrong_password', 12);
select pg_temp.ev(:orgA, now() - interval '3 days',    'password_guessing', 'blocked', 'repeated_wrong_password', 8);
select pg_temp.ev(:orgA, now() - interval '1 day',     'password_guessing', 'flagged', 'passkey_unexplained_sign_in', 2);
select pg_temp.ev(:orgA, now() - interval '2 days',    'password_guessing', 'flagged', 'passkey_counter_went_back', 1);
select pg_temp.ev(:orgA, now() - interval '2 days',    'phishing',          'flagged', 'sign_in_new_country', 4);
select pg_temp.ev(:orgA, now() - interval '7 days' + interval '1 minute', 'bots', 'blocked', 'bot_detected', 3);
select pg_temp.ev(:orgA, now() - interval '4 days',    'exploit',           'allowed', 'probe_allowed', 1);
select pg_temp.ev(:orgA, now() - interval '7 days' - interval '1 minute', 'password_guessing', 'blocked', 'wrong_password', 5);
select pg_temp.ev(:orgA, now() - interval '10 days',   'password_guessing', 'flagged', 'passkey_unexplained_sign_in', 7);
select pg_temp.ev(:orgA, now() - interval '14 days' + interval '1 minute', 'bots', 'flagged', 'bot_suspected', 6);
-- Outside both weeks: older than 14 days, and a minute that has not come.
select pg_temp.ev(:orgA, now() - interval '14 days' - interval '1 minute', 'malware', 'blocked', 'upload_blocked', 99);
select pg_temp.ev(:orgA, now() + interval '1 minute',  'bots',              'blocked', 'bot_detected', 1000);
select pg_temp.ev(:orgB, now() - interval '1 day',     'exploit',           'blocked', 'probe_blocked', 2);
-- Example Institute: five "this was not me" events and no alert row.
select pg_temp.ev(:orgC, now() - interval '1 day',     'phishing',          'flagged', 'sign_in_not_me', 5);
-- Example Empty: only an old row (the oldest on record).
select pg_temp.ev(:orgZ, now() - interval '20 days',   'malware',           'blocked', 'upload_blocked', 3);
-- About no organization.
select pg_temp.ev(null, now() - interval '1 hour',     'bots',              'blocked', 'bot_detected', 9);
select pg_temp.ev(null, now() - interval '9 days',     'bots',              'blocked', 'bot_detected', 4);
select pg_temp.ev(null, now() - interval '2 days',     'password_guessing', 'flagged', 'passkey_unexplained_sign_in', 1);
select pg_temp.ev(null, now() - interval '3 days',     'password_guessing', 'flagged', 'passkey_counter_went_back', 2);
select pg_temp.ev(null, now() - interval '8 days',     'malware',           'allowed', 'upload_allowed', 2);
select pg_temp.ev(null, now() - interval '15 days',    'exploit',           'blocked', 'probe_blocked', 50);

-- Audit rows of Example Academy. D is the UTC day that holds now - 2 days.
-- C1: promoted (staff to admin), by its owner. Another member's invitation
-- on the same UTC day (C5's) folds nothing.
select pg_temp.role_row(:orgA, :mAdminNone, :adminNone, 'staff', 'admin', now() - interval '2 days', :ownerA, 'authenticated');
-- C2: a promotion 8 days ago: not this week, still in the 30-day list.
select pg_temp.role_row(:orgA, :mManager, :manager, 'manager', 'admin', now() - interval '8 days', :ownerA, 'authenticated');
-- C3: demoted (admin to staff). Its before carries keys the list must drop.
select pg_temp.audit(:orgA, :ownerA, 'user.role.changed', now() - interval '1 day', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', :mStaffNone, 'warehouse_id', null,
  'before', jsonb_build_object('role', 'admin', 'ip', '203.0.113.9', 'session_id', 'a0477000-0000-0000-0000-000000000505'),
  'after', jsonb_build_object('role', 'staff'),
  'reason', null, 'source', 'database', 'made_as', 'authenticated', 'aal', 'aal2',
  'target_user_id', :staffNone, 'user_agent', 'Example Browser'));
-- C4: promoted, in the shape the app wrote before 0467: the membership id
-- in entity_id and no target_user_id.
select pg_temp.audit(:orgA, :ownerA, 'user.role.changed', now() - interval '3 days', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', :mAdminUnv, 'warehouse_id', null,
  'before', jsonb_build_object('role', 'manager'), 'after', jsonb_build_object('role', 'admin'), 'reason', null));
-- C5: an invitation accepted onto an existing row: the database's role
-- change and the app's acceptance, the same member, the same UTC day. The
-- invitation wins: no promotion.
select pg_temp.role_row(:orgA, :mAdminOld, :adminOld, 'viewer', 'admin',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '10 hours', null, 'service_role');
select pg_temp.audit(:orgA, :adminOld, 'user.invite.accepted',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '10 hours 1 second',
  jsonb_build_object('invite_id', gen_random_uuid(), 'role', 'admin', 'warehouse_id', null, 'charter_id', null,
                     'charter_ids', '[]'::jsonb, 'all_warehouses', false));
-- C6: a promotion a second before midnight UTC and the same member's
-- acceptance the next UTC day: not the same day, so the promotion counts.
select pg_temp.role_row(:orgA, :mStaffIdle, :staffIdle, 'staff', 'admin',
  date_trunc('day', now() - interval '4 days', 'UTC') + interval '23 hours 59 minutes 59 seconds', :ownerA, 'authenticated');
select pg_temp.audit(:orgA, :staffIdle, 'user.invite.accepted',
  date_trunc('day', now() - interval '4 days', 'UTC') + interval '1 day 1 second',
  jsonb_build_object('invite_id', gen_random_uuid(), 'role', 'staff'));
-- C7: an "already a member" press changed nothing and folds nothing.
select pg_temp.role_row(:orgA, :mEdgeIn, :edgeIn, 'staff', 'admin',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '11 hours', :ownerA, 'authenticated');
select pg_temp.audit(:orgA, :edgeIn, 'user.invite.accepted',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '11 hours 1 second',
  jsonb_build_object('invite_id', gen_random_uuid(), 'already_member', true, 'invite_role', 'admin', 'member_role', 'staff'));
-- C9: Staff B accepted an invitation to Example Academy on the day Example
-- Charter promoted them: another organization's invitation folds nothing.
select pg_temp.audit(:orgA, :staffB, 'user.invite.accepted',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '12 hours',
  jsonb_build_object('invite_id', gen_random_uuid(), 'role', 'viewer'));
select pg_temp.role_row(:orgB, :mStaffB, :staffB, 'staff', 'admin',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '12 hours', :ownerB, 'authenticated');
-- C10: an ownership transfer: the database's two rows carry one time, and
-- the app's row follows.
select pg_temp.role_row(:orgA, :mOwnerA, :ownerA, 'owner', 'admin', now() - interval '3 days 6 hours', null, 'service_role');
select pg_temp.role_row(:orgA, :mAdminOld, :adminOld, 'admin', 'owner', now() - interval '3 days 6 hours', null, 'service_role');
select pg_temp.audit(:orgA, :ownerA, 'organization.ownership.transferred', now() - interval '3 days 6 hours' + interval '2 seconds',
  jsonb_build_object('entity_type', 'organization', 'entity_id', :orgA, 'warehouse_id', null,
                     'before', jsonb_build_object('owner_user_id', :ownerA),
                     'after', jsonb_build_object('owner_user_id', :adminOld),
                     'reason', null, 'previous_owner_member_id', :mAdminOld));
-- C11: a second move, one row (direct SQL): owner to staff.
select pg_temp.role_row(:orgA, :mAdminOld, :adminOld, 'owner', 'staff', now() - interval '5 days', null, 'direct');
-- C12: members removed: an admin, an owner, a staff member; and an account
-- its holder deleted (no role is known).
select pg_temp.audit(:orgA, :ownerA, 'user.deactivated', now() - interval '1 day 4 hours', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', gen_random_uuid(), 'warehouse_id', null,
  'before', jsonb_build_object('user_id', 'a0477000-0000-0000-0000-0000000009a1', 'role', 'admin'), 'after', null,
  'reason', null, 'assignments_cleared', 0, 'session_revoked', false));
select pg_temp.audit(:orgA, :ownerA, 'user.deactivated', now() - interval '1 day 5 hours', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', gen_random_uuid(),
  'before', jsonb_build_object('user_id', 'a0477000-0000-0000-0000-0000000009a2', 'role', 'owner'), 'after', null));
select pg_temp.audit(:orgA, :ownerA, 'user.deactivated', now() - interval '1 day 6 hours', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', gen_random_uuid(),
  'before', jsonb_build_object('user_id', 'a0477000-0000-0000-0000-0000000009a3', 'role', 'staff'), 'after', null));
select pg_temp.audit(:orgA, null, 'user.deactivated', now() - interval '1 day 7 hours', jsonb_build_object(
  'entity_type', 'user', 'entity_id', 'a0477000-0000-0000-0000-0000000009a4', 'warehouse_id', null,
  'before', null, 'after', null, 'reason', 'self', 'confirmed_by', 'password'));
-- C13: the sign-in policy. Tightened three times (one exactly 7 days ago),
-- loosened twice, and three changes whose direction cannot be told (a value
-- outside the three, no before, the same value twice). A microsecond past 7
-- days and 8 days ago: not this week.
select pg_temp.policy_row(:orgA, 'optional', 'admins_required', now() - interval '6 days');
select pg_temp.policy_row(:orgA, 'all_required', 'optional', now() - interval '5 days 1 hour');
select pg_temp.policy_row(:orgA, 'admins_required', 'all_required', now() - interval '4 days 1 hour');
select pg_temp.policy_row(:orgA, 'all_required', 'admins_required', now() - interval '3 days 1 hour');
select pg_temp.policy_row(:orgA, 'optional', 'strict_new', now() - interval '2 days 1 hour');
select pg_temp.audit(:orgA, :ownerA, 'organization.mfa_policy.changed', now() - interval '2 days 2 hours', jsonb_build_object(
  'entity_type', 'organization', 'entity_id', :orgA, 'after', jsonb_build_object('mfa_policy', 'optional')));
select pg_temp.policy_row(:orgA, 'admins_required', 'admins_required', now() - interval '2 days 3 hours');
select pg_temp.policy_row(:orgA, 'optional', 'all_required', now() - interval '7 days');
select pg_temp.policy_row(:orgA, 'optional', 'all_required', now() - interval '7 days' - interval '1 microsecond');
select pg_temp.policy_row(:orgA, 'optional', 'all_required', now() - interval '8 days 1 hour');
-- C14: role changes that are about no admin, in the older shape, with
-- values the list must cut down: a membership that is gone; a membership of
-- ANOTHER organization (never looked up across organizations); before that
-- is not an object, after whose role is not text, over-long text.
select pg_temp.audit(:orgA, :ownerA, 'user.role.changed', now() - interval '1 day 1 hour', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', :mGone,
  'before', jsonb_build_object('role', 'staff', 'note', 'x', 'ip', '203.0.113.9'),
  'after', jsonb_build_object('role', 'manager', 'nested', jsonb_build_object('role', 'admin'))));
select pg_temp.audit(:orgA, :ownerA, 'user.role.changed', now() - interval '1 day 2 hours', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', :mStaffB,
  'before', 'staff', 'after', jsonb_build_object('role', 7),
  'role', repeat('r', 80), 'made_as', repeat('m', 70)));
select pg_temp.audit(:orgA, :ownerA, 'user.deactivated', now() - interval '1 day 3 hours', jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', repeat('e', 100),
  'before', jsonb_build_object('user_id', repeat('u', 80), 'role', 'staff')));
-- An acceptance with no metadata at all; the 30-day boundary (exactly 30
-- days: listed; a microsecond older: not); an event that is none of the five.
select pg_temp.audit(:orgA, null, 'user.invite.accepted', now() - interval '9 days', null);
select pg_temp.audit(:orgA, null, 'user.invite.accepted', now() - interval '30 days', jsonb_build_object('role', 'staff'));
select pg_temp.audit(:orgA, null, 'user.invite.accepted', now() - interval '30 days' - interval '1 microsecond', jsonb_build_object('role', 'staff'));
select pg_temp.audit(:orgA, :ownerA, 'item.created', now() - interval '1 day', jsonb_build_object('entity_type', 'item'));

-- The answers, read once (as the functions' owner; service_role's are
-- compared with them in section 3).
create temporary table ans as
  select public.platform_security_briefing_members() as members,
         public.platform_security_briefing_events() as events,
         public.platform_security_briefing_changes() as changes,
         public.platform_security_briefing_for_organization(:orgA) as da,
         public.platform_security_briefing_for_organization(:orgB) as db,
         public.platform_security_briefing_for_organization(:orgC) as dc,
         public.platform_security_briefing_for_organization(:orgZ) as dz;

-- ── 1. Shape and privileges ─────────────────────────────────────────────────
select is(
  (select array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || pg_get_function_result(p.oid)
                    order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'),
  array['_security_briefing_change_counts(p_organization_id uuid) TABLE(organization_id uuid, total bigint, counts jsonb)',
        '_security_briefing_members(p_organization_id uuid) TABLE(user_id uuid, role text, full_name text, email text, has_second_step boolean, sign_ins integer, idle_sign_ins integer, oldest_idle_at timestamp with time zone)',
        'platform_security_briefing_changes() jsonb',
        'platform_security_briefing_events() jsonb',
        'platform_security_briefing_for_organization(p_organization_id uuid) jsonb',
        'platform_security_briefing_members() jsonb'],
  '0477/1: exactly the six functions, with the designed arguments and results');
select is(
  (select array_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':'
                    || array_to_string(p.proconfig, ',') order by p.proname)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'),
  array['_security_briefing_change_counts:plpgsql:false:s:search_path=""',
        '_security_briefing_members:plpgsql:false:s:search_path=""',
        'platform_security_briefing_changes:plpgsql:true:s:search_path=""',
        'platform_security_briefing_events:plpgsql:true:s:search_path=""',
        'platform_security_briefing_for_organization:plpgsql:true:s:search_path=""',
        'platform_security_briefing_members:plpgsql:true:s:search_path=""'],
  '0477/2: all plpgsql and STABLE with an empty search_path and no other setting; the four public ones SECURITY DEFINER, the two private ones SECURITY INVOKER');
select is(
  array[array_to_string(pg_temp.grants_of('public._security_briefing_members(uuid)'), ' '),
        array_to_string(pg_temp.grants_of('public._security_briefing_change_counts(uuid)'), ' ')],
  array['', ''],
  '0477/3: the two private functions have no grant to any role');
select is(
  array[array_to_string(pg_temp.grants_of('public.platform_security_briefing_members()'), ' '),
        array_to_string(pg_temp.grants_of('public.platform_security_briefing_events()'), ' '),
        array_to_string(pg_temp.grants_of('public.platform_security_briefing_changes()'), ' '),
        array_to_string(pg_temp.grants_of('public.platform_security_briefing_for_organization(uuid)'), ' ')],
  array['service_role:EXECUTE', 'service_role:EXECUTE', 'service_role:EXECUTE', 'service_role:EXECUTE'],
  '0477/4: each public function has exactly one grant: EXECUTE to service_role');
select is(
  (select array_agg(has_function_privilege(r.role, f.fn, 'execute') order by f.n, r.n)
     from unnest(array['public._security_briefing_members(uuid)',
                       'public._security_briefing_change_counts(uuid)',
                       'public.platform_security_briefing_members()',
                       'public.platform_security_briefing_events()',
                       'public.platform_security_briefing_changes()',
                       'public.platform_security_briefing_for_organization(uuid)']) with ordinality as f(fn, n),
          unnest(array['anon', 'authenticated', 'service_role']) with ordinality as r(role, n)),
  array[false, false, false,
        false, false, false,
        false, false, true,
        false, false, true,
        false, false, true,
        false, false, true],
  '0477/5: anon and authenticated may execute none of the six; service_role the four public ones and neither private one');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'
      and p.prosrc ~* '(auth\.uid|has_org_role|has_permission|is_org_member)'),
  0,
  '0477/6: no body holds any of the four gate words, not even in a comment or a string (so none is left once comments and strings are stripped)');
select is(pg_temp.inv25_names(), '',
  '0477/7: as granted, INV-25 has nothing to say about these functions (authenticated cannot execute them)');
select ok(
  (select regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
          ~* $re$\m(auth\.uid|has_org_role|has_permission|is_org_member)\M$re$
     from pg_proc p where p.oid = 'public.sign_in_alerts_for_organization(uuid, integer)'::regprocedure),
  '0477/8: the same reading does find the gate of a function that has one (so 6 and 7 can fail)');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'
      and p.prosrc !~* '\m(insert|update|delete|merge|truncate)\M'),
  6,
  '0477/9: no body holds a write statement: none of the five write verbs appears as a word');
select is(
  array[(select string_agg(m[1], ',' order by m[1])
           from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
          where c.conrelid = 'public.security_events'::regclass and c.conname = 'security_events_category'),
        (select string_agg(m[1], ',' order by m[1])
           from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
          where c.conrelid = 'public.security_events'::regclass and c.conname = 'security_events_outcome')],
  array['bots,exploit,malware,password_guessing,phishing', 'allowed,blocked,flagged'],
  '0477/10: security_events still has the five categories and three outcomes the events read names (a new one must be added to it)');

-- ── 2. Who may call ─────────────────────────────────────────────────────────
-- An owner of Example Academy holding the second step, and a signed-out
-- caller: refused by the grant, by name, on all six.
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0477000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select * from public._security_briefing_members('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select * from public._security_briefing_change_counts('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select public.platform_security_briefing_members() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_events() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_changes() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_for_organization('a0477000-0000-0000-0000-0000000000a1') $$)],
  array['42501|permission denied for function _security_briefing_members',
        '42501|permission denied for function _security_briefing_change_counts',
        '42501|permission denied for function platform_security_briefing_members',
        '42501|permission denied for function platform_security_briefing_events',
        '42501|permission denied for function platform_security_briefing_changes',
        '42501|permission denied for function platform_security_briefing_for_organization'],
  '0477/11: a signed-in member, even an owner holding the second step, can call none of the six: no EXECUTE');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select * from public._security_briefing_members('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select * from public._security_briefing_change_counts('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select public.platform_security_briefing_members() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_events() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_changes() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_for_organization('a0477000-0000-0000-0000-0000000000a1') $$)],
  array['42501|permission denied for function _security_briefing_members',
        '42501|permission denied for function _security_briefing_change_counts',
        '42501|permission denied for function platform_security_briefing_members',
        '42501|permission denied for function platform_security_briefing_events',
        '42501|permission denied for function platform_security_briefing_changes',
        '42501|permission denied for function platform_security_briefing_for_organization'],
  '0477/12: a signed-out caller can call none of the six: no EXECUTE');
reset role;
select set_config('request.jwt.claims', '', true);

-- If a grant to the member roles ever slipped in: INV-25 names each of the
-- four, and the second lock in each body still refuses the call; the
-- private count carries the same lock, the private member read ends at the
-- auth tables. Undone by the savepoint.
savepoint slipped_grant;
grant execute on function public.platform_security_briefing_members() to authenticated, anon;
grant execute on function public.platform_security_briefing_events() to authenticated, anon;
grant execute on function public.platform_security_briefing_changes() to authenticated, anon;
grant execute on function public.platform_security_briefing_for_organization(uuid) to authenticated, anon;
grant execute on function public._security_briefing_members(uuid) to authenticated, anon;
grant execute on function public._security_briefing_change_counts(uuid) to authenticated, anon;
select is(pg_temp.inv25_names(),
  'platform_security_briefing_changes, platform_security_briefing_events, '
  'platform_security_briefing_for_organization, platform_security_briefing_members',
  '0477/13: with EXECUTE granted to authenticated, INV-25 names each of the four public functions');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0477000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  array[pg_temp.refusal($$ select public.platform_security_briefing_members() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_events() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_changes() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_for_organization('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select public.platform_security_briefing_for_organization(null) $$),
        pg_temp.refusal($$ select * from public._security_briefing_change_counts('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select * from public._security_briefing_change_counts(null) $$)],
  array_fill('42501|platform_security_briefing_not_allowed'::text, array[7]),
  '0477/14: and even then the second lock refuses a signed-in owner on each of the four (before the null check too), and on the private count, which holds the same lock');
select ok(
  pg_temp.refusal($$ select * from public._security_briefing_members('a0477000-0000-0000-0000-0000000000a1') $$)
    ~ '^42501\|permission denied for table (sessions|mfa_factors)$',
  '0477/15: the private function, were it ever granted, ends at the auth tables'' own privileges for a member (it has no definer rights)');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is(
  array[pg_temp.refusal($$ select public.platform_security_briefing_members() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_events() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_changes() $$),
        pg_temp.refusal($$ select public.platform_security_briefing_for_organization('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select * from public._security_briefing_change_counts('a0477000-0000-0000-0000-0000000000a1') $$)],
  array_fill('42501|platform_security_briefing_not_allowed'::text, array[5]),
  '0477/16: the second lock refuses a signed-out caller on each of the four as well, and on the private count');
reset role;
select set_config('request.jwt.claims', '', true);
rollback to savepoint slipped_grant;
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  '0477/17: the savepoint took the grants back');

-- ── 3. service_role ─────────────────────────────────────────────────────────
select members::text as j_members, events::text as j_events, changes::text as j_changes, da::text as j_a from ans \gset
set local role service_role;
select is(public.platform_security_briefing_members(), :'j_members'::jsonb,
  '0477/18: service_role reads every organization''s member state');
select is(public.platform_security_briefing_events(), :'j_events'::jsonb,
  '0477/19: service_role reads the events');
select is(public.platform_security_briefing_changes(), :'j_changes'::jsonb,
  '0477/20: service_role reads the changes');
select is(public.platform_security_briefing_for_organization('a0477000-0000-0000-0000-0000000000a1'), :'j_a'::jsonb,
  '0477/21: service_role reads one organization in detail');
select is(
  array[pg_temp.refusal($$ select * from public._security_briefing_members('a0477000-0000-0000-0000-0000000000a1') $$),
        pg_temp.refusal($$ select * from public._security_briefing_change_counts('a0477000-0000-0000-0000-0000000000a1') $$)],
  array['42501|permission denied for function _security_briefing_members',
        '42501|permission denied for function _security_briefing_change_counts'],
  '0477/22: service_role cannot call either private function');
reset role;

-- ── 4. The private member read ──────────────────────────────────────────────
select results_eq(
  $$ select user_id, role, full_name, email, has_second_step, sign_ins, idle_sign_ins, oldest_idle_at
       from public._security_briefing_members('a0477000-0000-0000-0000-0000000000a1') order by user_id $$,
  $$ values
    ('a0477000-0000-0000-0000-000000000001'::uuid, 'owner'::text,   'Briefing Owner A'::text,         'owner-a@example.com'::text,          true,  1, 0, null::timestamptz),
    ('a0477000-0000-0000-0000-000000000002'::uuid, 'admin',         'Briefing Admin None',            'admin-none@example.com',             false, 0, 0, null),
    ('a0477000-0000-0000-0000-000000000003'::uuid, 'admin',         'Briefing Admin Unverified',      'admin-unverified@example.com',       false, 0, 0, null),
    ('a0477000-0000-0000-0000-000000000004'::uuid, 'admin',         'Briefing Admin Old',             'admin-old@example.com',              true,  1, 1, now() - interval '100 days'),
    ('a0477000-0000-0000-0000-000000000005'::uuid, 'manager',       'Briefing Manager Bridge',        'manager-bridge@example.com',         true,  1, 0, null),
    ('a0477000-0000-0000-0000-000000000006'::uuid, 'staff',         null,                             'aaa-staff-none@example.com',         false, 1, 0, null),
    ('a0477000-0000-0000-0000-000000000007'::uuid, 'staff',         'Briefing Staff Idle',            'staff-idle@example.com',             true,  3, 2, now() - interval '45 days'),
    ('a0477000-0000-0000-0000-000000000008'::uuid, 'staff',         'Briefing Staff Edge In',         'staff-edge-in@example.com',          true,  1, 0, null),
    ('a0477000-0000-0000-0000-000000000009'::uuid, 'staff',         'Briefing Staff Edge Out',        'staff-edge-out@example.com',         true,  1, 1, now() - interval '30 days' - interval '1 microsecond'),
    ('a0477000-0000-0000-0000-00000000000a'::uuid, 'staff',         'Briefing Two Orgs',              'two-orgs@example.com',               false, 1, 1, now() - interval '35 days') $$,
  '0477/23: the members of Example Academy: ten rows (no disabled account, act-as seat, invitation or outsider); a verified factor of any type or name is a second step and an unverified one is not; a sign-in is idle only when it has not ended and was last used before now minus 30 days (renewed today, ended, and exactly 30 days are not; renewed 31 days ago, never renewed for 45 days, and 30 days and a microsecond are), with the last use of the oldest');
-- A zone eight hours behind UTC with no daylight saving (so "45 days ago" is
-- the same instant in it).
set local time zone 'Etc/GMT+8';
select results_eq(
  $$ select user_id, sign_ins, idle_sign_ins, oldest_idle_at
       from public._security_briefing_members('a0477000-0000-0000-0000-0000000000a1')
      where user_id in ('a0477000-0000-0000-0000-000000000007', 'a0477000-0000-0000-0000-000000000008',
                        'a0477000-0000-0000-0000-000000000009') order by user_id $$,
  $$ values
    ('a0477000-0000-0000-0000-000000000007'::uuid, 3, 2, now() - interval '45 days'),
    ('a0477000-0000-0000-0000-000000000008'::uuid, 1, 0, null::timestamptz),
    ('a0477000-0000-0000-0000-000000000009'::uuid, 1, 1, now() - interval '30 days' - interval '1 microsecond') $$,
  '0477/24: the same answer in a session whose time zone is not UTC: refreshed_at is read as UTC');
select is(
  (select array[(o ->> 'idle_sign_ins')::int, (o ->> 'members_with_idle_sign_ins')::int]
     from pg_temp.org_of(public.platform_security_briefing_members(), :orgA) o),
  array[5, 4],
  '0477/25: and the all-organizations read counts the same idle sign-ins in that session');
reset time zone;
select is(
  (select count(*)::int from public._security_briefing_members(null)),
  0,
  '0477/26: no organization: no row');

-- ── 5. Every organization's member state ────────────────────────────────────
select is(pg_temp.keys_of((select members from ans)),
  array['idle_after_days', 'organizations', 'organizations_truncated', 'totals'],
  '0477/27: the members answer has exactly its four keys');
select is(
  (select array_agg(distinct pg_temp.keys_of(e)) from ans, jsonb_array_elements(ans.members -> 'organizations') e),
  array[array['admins', 'admins_joined_this_week', 'admins_without_second_step', 'idle_sign_ins',
              'members', 'members_with_idle_sign_ins', 'mfa_policy', 'name', 'organization_id',
              'sign_ins_reported_this_week', 'without_second_step']],
  '0477/28: every organization object has exactly the eleven documented keys');
select is(pg_temp.org_of((select members from ans), :orgA),
  jsonb_build_object('organization_id', :orgA, 'name', 'Example Academy', 'mfa_policy', 'admins_required',
    'members', 10, 'admins', 4, 'without_second_step', 4, 'admins_without_second_step', 2,
    'members_with_idle_sign_ins', 4, 'idle_sign_ins', 5,
    'admins_joined_this_week', 2, 'sign_ins_reported_this_week', 3),
  '0477/29: Example Academy: ten members, four admins (the owner included), four without a second step of whom two admins, four members with five idle sign-ins, two admins joined this week (three days ago and exactly seven; not seven days and a microsecond), three sign-ins reported (one, two and exactly seven days ago; not open, "was me", eight days, or seven days and a microsecond)');
select is(pg_temp.org_of((select members from ans), :orgB),
  jsonb_build_object('organization_id', :orgB, 'name', 'Example Charter', 'mfa_policy', 'optional',
    'members', 3, 'admins', 2, 'without_second_step', 2, 'admins_without_second_step', 1,
    'members_with_idle_sign_ins', 2, 'idle_sign_ins', 2,
    'admins_joined_this_week', 1, 'sign_ins_reported_this_week', 2),
  '0477/30: Example Charter: the person in both organizations is counted here too (as its admin), with their idle sign-in and their reported sign-in; an alert of a member of this organization only is counted here only');
select is(
  array[pg_temp.org_of((select members from ans), :orgC), pg_temp.org_of((select members from ans), :orgZ)],
  array[jsonb_build_object('organization_id', :orgC, 'name', 'Example Institute', 'mfa_policy', 'all_required',
          'members', 1, 'admins', 1, 'without_second_step', 0, 'admins_without_second_step', 0,
          'members_with_idle_sign_ins', 0, 'idle_sign_ins', 0,
          'admins_joined_this_week', 0, 'sign_ins_reported_this_week', 0),
        jsonb_build_object('organization_id', :orgZ, 'name', 'Example Empty', 'mfa_policy', 'optional',
          'members', 0, 'admins', 0, 'without_second_step', 0, 'admins_without_second_step', 0,
          'members_with_idle_sign_ins', 0, 'idle_sign_ins', 0,
          'admins_joined_this_week', 0, 'sign_ins_reported_this_week', 0)],
  '0477/31: Example Institute reports no sign-in although security_events holds five "not me" events for it (the alert rows are the record); an organization with no member is listed with zeros');
select is(
  (select array[(t.now -> 'totals' ->> 'organizations')::int - (t.was -> 'totals' ->> 'organizations')::int,
                (t.now -> 'totals' ->> 'accounts')::int - (t.was -> 'totals' ->> 'accounts')::int,
                (t.now -> 'totals' ->> 'accounts_without_second_step')::int - (t.was -> 'totals' ->> 'accounts_without_second_step')::int,
                (t.now -> 'totals' ->> 'admin_accounts_without_second_step')::int - (t.was -> 'totals' ->> 'admin_accounts_without_second_step')::int]
     from (select ans.members as now, base.members as was from ans, base) t),
  array[4, 13, 5, 3],
  '0477/32: the totals count accounts: four organizations, thirteen accounts (the person in two organizations once; fourteen memberships), five without a second step, three of them an admin somewhere (the person who is staff in one and admin in the other is one)');
select is(pg_temp.keys_of((select members -> 'totals' from ans)),
  array['accounts', 'accounts_without_second_step', 'admin_accounts_without_second_step', 'organizations'],
  '0477/33: totals has exactly its four keys');
select is(
  (select array[ans.members -> 'idle_after_days', ans.members -> 'organizations_truncated'] from ans),
  array['30'::jsonb, 'false'::jsonb],
  '0477/34: idle_after_days is 30 and the list is not truncated');
select is(
  (select array_agg(e ->> 'name' order by n)
     from ans, jsonb_array_elements(ans.members -> 'organizations') with ordinality as t(e, n)
    where e ->> 'organization_id' in (:orgA, :orgB, :orgC, :orgZ)),
  array['Example Academy', 'Example Charter', 'Example Empty', 'Example Institute'],
  '0477/35: organizations with a count to show come first, the most admins without a second step first; the rest by name');

-- ── 6. One organization in detail ───────────────────────────────────────────
select is(pg_temp.keys_of((select da from ans)),
  array['admins', 'admins_joined_this_week', 'admins_without_second_step', 'changes', 'changes_this_week',
        'changes_truncated', 'idle_after_days', 'idle_sign_ins', 'members', 'members_with_idle_sign_ins', 'mfa_policy', 'name',
        'organization_id', 'people', 'people_truncated', 'sign_ins_reported_this_week', 'without_second_step'],
  '0477/36: the detail has exactly its seventeen keys');
select is(
  (select array[ans.da - 'people' - 'people_truncated' - 'changes' - 'changes_truncated' - 'idle_after_days' - 'changes_this_week',
                ans.db - 'people' - 'people_truncated' - 'changes' - 'changes_truncated' - 'idle_after_days' - 'changes_this_week',
                ans.dc - 'people' - 'people_truncated' - 'changes' - 'changes_truncated' - 'idle_after_days' - 'changes_this_week',
                ans.dz - 'people' - 'people_truncated' - 'changes' - 'changes_truncated' - 'idle_after_days' - 'changes_this_week']
     from ans),
  (select array[pg_temp.org_of(ans.members, :orgA), pg_temp.org_of(ans.members, :orgB),
                pg_temp.org_of(ans.members, :orgC), pg_temp.org_of(ans.members, :orgZ)]
     from ans),
  '0477/37: for each organization the detail''s numbers equal its object in the all-organizations read (the per-member form and the one-pass form agree)');
select is(
  (select ans.da -> 'people' from ans),
  jsonb_build_array(
    jsonb_build_object('user_id', :adminNone, 'full_name', 'Briefing Admin None', 'email', 'admin-none@example.com',
      'role', 'admin', 'has_second_step', false, 'idle_sign_ins', 0, 'oldest_idle_at', null),
    jsonb_build_object('user_id', :adminOld, 'full_name', 'Briefing Admin Old', 'email', 'admin-old@example.com',
      'role', 'admin', 'has_second_step', true, 'idle_sign_ins', 1, 'oldest_idle_at', now() - interval '100 days'),
    jsonb_build_object('user_id', :adminUnv, 'full_name', 'Briefing Admin Unverified', 'email', 'admin-unverified@example.com',
      'role', 'admin', 'has_second_step', false, 'idle_sign_ins', 0, 'oldest_idle_at', null),
    jsonb_build_object('user_id', :staffNone, 'full_name', null, 'email', 'aaa-staff-none@example.com',
      'role', 'staff', 'has_second_step', false, 'idle_sign_ins', 0, 'oldest_idle_at', null),
    jsonb_build_object('user_id', :edgeOut, 'full_name', 'Briefing Staff Edge Out', 'email', 'staff-edge-out@example.com',
      'role', 'staff', 'has_second_step', true, 'idle_sign_ins', 1,
      'oldest_idle_at', now() - interval '30 days' - interval '1 microsecond'),
    jsonb_build_object('user_id', :staffIdle, 'full_name', 'Briefing Staff Idle', 'email', 'staff-idle@example.com',
      'role', 'staff', 'has_second_step', true, 'idle_sign_ins', 2, 'oldest_idle_at', now() - interval '45 days'),
    jsonb_build_object('user_id', :twoOrgs, 'full_name', 'Briefing Two Orgs', 'email', 'two-orgs@example.com',
      'role', 'staff', 'has_second_step', false, 'idle_sign_ins', 1, 'oldest_idle_at', now() - interval '35 days')),
  '0477/38: people of Example Academy: only the members with no second step or an idle sign-in (not the owner, the manager or the member at exactly 30 days), admins first, then by name (by email when there is no name), each with exactly the seven keys; nobody from another organization, no disabled account, act-as seat or invitation');
select is(
  (select array_agg(p ->> 'email' order by n) from ans, jsonb_array_elements(ans.db -> 'people') with ordinality as t(p, n)),
  array['owner-b@example.com', 'two-orgs@example.com', 'staff-b@example.com'],
  '0477/39: people of Example Charter: its owner (an idle sign-in) and its admin before its staff member, whatever their names; the person in two organizations is listed in each');
select is(
  (select array[ans.da -> 'people_truncated', ans.da -> 'changes_truncated', ans.da -> 'idle_after_days',
                ans.dc -> 'people', ans.dc -> 'changes', ans.dz -> 'people'] from ans),
  array['false'::jsonb, 'false'::jsonb, '30'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb],
  '0477/40: nothing is truncated; an organization with nobody to list and no change has empty lists, not null');
select is(
  array[public.platform_security_briefing_for_organization(null),
        public.platform_security_briefing_for_organization('a0477000-0000-0000-0000-00000000dead')],
  array[null::jsonb, null::jsonb],
  '0477/41: no organization, or an id that names none: null');

-- ── 7. Events ───────────────────────────────────────────────────────────────
select is(
  (select array[base.events -> 'organizations', base.events -> 'no_organization', base.events -> 'oldest_event_at',
                base.changes -> 'organizations']
     from base),
  array['[]'::jsonb,
        jsonb_build_object('this_week', pg_temp.cats('{}'), 'last_week', pg_temp.cats('{}'),
                           'passkey_unexplained_sign_in_this_week', 0, 'passkey_counter_went_back_this_week', 0),
        'null'::jsonb,
        '[]'::jsonb],
  '0477/42: before the fixtures the database held no event and no counted change (the numbers below count from zero); with no event every category and outcome is still present as zero and the oldest time is null');
select is(pg_temp.keys_of((select events from ans)),
  array['no_organization', 'oldest_event_at', 'organizations', 'organizations_truncated'],
  '0477/43: the events answer has exactly its four keys');
select is(pg_temp.org_of((select events from ans), :orgA),
  jsonb_build_object('organization_id', :orgA,
    'this_week', pg_temp.cats('{"password_guessing": {"blocked": 20, "flagged": 3}, "exploit": {"allowed": 1},
                                "bots": {"blocked": 3}, "phishing": {"flagged": 4}}'),
    'last_week', pg_temp.cats('{"password_guessing": {"blocked": 5, "flagged": 7}, "bots": {"flagged": 6}}'),
    'passkey_unexplained_sign_in_this_week', 2,
    'passkey_counter_went_back_this_week', 1),
  '0477/44: Example Academy''s events: blocked, flagged and allowed kept apart in each category; a minute after now minus 7 days is this week and a minute before it last week; a minute after now minus 14 days is last week and a minute before it is in neither; a minute that has not come is in neither; the two passkey reasons are counted for this week only');
select is(
  array[pg_temp.org_of((select events from ans), :orgB), pg_temp.org_of((select events from ans), :orgC)],
  array[jsonb_build_object('organization_id', :orgB,
          'this_week', pg_temp.cats('{"exploit": {"blocked": 2}}'), 'last_week', pg_temp.cats('{}'),
          'passkey_unexplained_sign_in_this_week', 0, 'passkey_counter_went_back_this_week', 0),
        jsonb_build_object('organization_id', :orgC,
          'this_week', pg_temp.cats('{"phishing": {"flagged": 5}}'), 'last_week', pg_temp.cats('{}'),
          'passkey_unexplained_sign_in_this_week', 0, 'passkey_counter_went_back_this_week', 0)],
  '0477/45: each other organization has its own events and nobody else''s');
select is(
  (select array_agg(e ->> 'organization_id' order by n)
     from ans, jsonb_array_elements(ans.events -> 'organizations') with ordinality as t(e, n)),
  array[:orgA, :orgC, :orgB],
  '0477/46: only organizations with an event in the 14 days are listed (not the one whose only event is 20 days old), the most events this week first');
select is(
  (select ans.events -> 'no_organization' from ans),
  jsonb_build_object(
    'this_week', pg_temp.cats('{"bots": {"blocked": 9}, "password_guessing": {"flagged": 3}}'),
    'last_week', pg_temp.cats('{"bots": {"blocked": 4}, "malware": {"allowed": 2}}'),
    'passkey_unexplained_sign_in_this_week', 1,
    'passkey_counter_went_back_this_week', 2),
  '0477/47: the events about no organization are kept apart, by week, category and outcome, with their own passkey counts');
select is(
  (select array[(ans.events ->> 'oldest_event_at')::timestamptz::text, (ans.events -> 'organizations_truncated')::text] from ans),
  array[date_trunc('minute', now() - interval '20 days', 'UTC')::text, 'false'],
  '0477/48: oldest_event_at is the earliest minute on record, whatever the organization; the list is not truncated');
select is(
  (select array_agg(distinct pg_temp.keys_of(e) || pg_temp.keys_of(e -> 'this_week') || pg_temp.keys_of(e -> 'last_week')
                    || pg_temp.keys_of(e -> 'this_week' -> 'bots') || pg_temp.keys_of(e -> 'last_week' -> 'malware'))
     from ans, jsonb_array_elements(ans.events -> 'organizations' || jsonb_build_array(
            (ans.events -> 'no_organization') || jsonb_build_object('organization_id', null))) e),
  array[array['last_week', 'organization_id', 'passkey_counter_went_back_this_week',
              'passkey_unexplained_sign_in_this_week', 'this_week',
              'bots', 'exploit', 'malware', 'password_guessing', 'phishing',
              'bots', 'exploit', 'malware', 'password_guessing', 'phishing',
              'allowed', 'blocked', 'flagged', 'allowed', 'blocked', 'flagged']],
  '0477/49: every events object has exactly its keys: the two weeks, the two passkey counts, five categories, three outcomes');

-- ── 8. Admin and sign-in policy changes ─────────────────────────────────────
select is(pg_temp.keys_of((select changes from ans)),
  array['organizations', 'organizations_truncated'],
  '0477/50: the changes answer has exactly its two keys');
select is(pg_temp.org_of((select changes from ans), :orgA),
  jsonb_build_object('organization_id', :orgA,
    'admins_promoted', 4, 'admins_demoted_or_removed', 3, 'ownership_moved', 2,
    'sign_in_policy_loosened', 2, 'sign_in_policy_tightened', 3, 'sign_in_policy_changed_other', 3,
    'admins_added_this_week', 4),
  '0477/51: Example Academy this week. Promoted 4: the database''s row, the app''s older row, the promotion whose invitation fell on the next UTC day, and the one beside an "already a member" press; not the one 8 days ago, not the one an invitation of the same member and day explains, not the new owner. Demoted or removed 3: one admin made staff, an admin removed, an owner removed; not a staff member removed, a deleted account or the previous owner. Ownership moved 2: the transfer''s two rows once, and a lone owner row. Policy: loosened 2, tightened 3 (one exactly 7 days ago; not a microsecond older), other 3 (an unknown value, no before, the same value). Admins added 4, people not rows: the two admins who joined this week (three days ago and exactly seven) are two of the four members promoted, so each is one');
select is(pg_temp.org_of((select changes from ans), :orgB),
  jsonb_build_object('organization_id', :orgB,
    'admins_promoted', 1, 'admins_demoted_or_removed', 0, 'ownership_moved', 0,
    'sign_in_policy_loosened', 0, 'sign_in_policy_tightened', 0, 'sign_in_policy_changed_other', 0,
    'admins_added_this_week', 2),
  '0477/52: Example Charter: its promotion counts although the member accepted another organization''s invitation that day; admins added 2, the member promoted and the admin who joined a day ago (who is staff in Example Academy and adds nothing there)');
select is(
  (select array_agg(e ->> 'organization_id' order by n)
     from ans, jsonb_array_elements(ans.changes -> 'organizations') with ordinality as t(e, n)),
  array[:orgA, :orgB],
  '0477/53: only organizations with a count are listed, the most changes first');
select is(
  (select ans.changes -> 'organizations_truncated' from ans), 'false'::jsonb,
  '0477/54: the changes list is not truncated');

-- The database's own rows (0467), made here by real changes, are read as
-- the fixtures' are. Undone by the savepoint.
savepoint real_rows;
update public.organization_members set role = 'admin' where id = :mStaffB;
update public.organization_members set role = 'viewer' where organization_id = :orgB and user_id = :twoOrgs;
update public.organizations set mfa_policy = 'optional' where id = :orgC;
select is(
  array[pg_temp.org_of(public.platform_security_briefing_changes(), :orgB),
        pg_temp.org_of(public.platform_security_briefing_changes(), :orgC)],
  array[jsonb_build_object('organization_id', :orgB,
          'admins_promoted', 2, 'admins_demoted_or_removed', 1, 'ownership_moved', 0,
          'sign_in_policy_loosened', 0, 'sign_in_policy_tightened', 0, 'sign_in_policy_changed_other', 0,
          'admins_added_this_week', 1),
        jsonb_build_object('organization_id', :orgC,
          'admins_promoted', 0, 'admins_demoted_or_removed', 0, 'ownership_moved', 0,
          'sign_in_policy_loosened', 1, 'sign_in_policy_tightened', 0, 'sign_in_policy_changed_other', 0,
          'admins_added_this_week', 0)],
  '0477/55: a real promotion, a real demotion and a real loosening of the policy, recorded by the database''s own triggers, are counted; the member promoted twice this week is one admin added, and the admin who joined this week and was demoted is none');
select is(
  (select jsonb_agg(c - 'entity_id' order by c ->> 'target_user_id')
     from jsonb_array_elements(public.platform_security_briefing_for_organization(:orgB) -> 'changes') c
    where (c ->> 'created_at')::timestamptz = now()),
  jsonb_build_array(
    jsonb_build_object('created_at', now(), 'event', 'user.role.changed', 'actor_user_id', null,
      'target_user_id', :twoOrgs, 'entity_type', 'organization_member',
      'before', jsonb_build_object('role', 'admin'), 'after', jsonb_build_object('role', 'viewer'),
      'role', null, 'already_member', false, 'made_as', 'direct'),
    jsonb_build_object('created_at', now(), 'event', 'user.role.changed', 'actor_user_id', null,
      'target_user_id', :staffB, 'entity_type', 'organization_member',
      'before', jsonb_build_object('role', 'staff'), 'after', jsonb_build_object('role', 'admin'),
      'role', null, 'already_member', false, 'made_as', 'direct')),
  '0477/56: and listed in the detail with the member, the roles and how the change was made');
rollback to savepoint real_rows;

-- ── 9. The 30-day list of one organization ──────────────────────────────────
select is(
  (select jsonb_array_length(ans.da -> 'changes') from ans), 34,
  '0477/57: Example Academy''s list holds its 34 rows of the five events from the last 30 days: the row exactly 30 days old, not the one a microsecond older, not another event');
select is(
  (select array_agg(distinct pg_temp.keys_of(c)) from ans, jsonb_array_elements(ans.da -> 'changes') c),
  array[array['actor_user_id', 'after', 'already_member', 'before', 'created_at', 'entity_id', 'entity_type',
              'event', 'made_as', 'role', 'target_user_id']],
  '0477/58: every change has exactly the eleven documented keys (no address, no user agent)');
select ok(
  (select bool_and(k in ('role', 'mfa_policy', 'user_id', 'owner_user_id'))
     from ans, jsonb_array_elements(ans.da -> 'changes') c,
          jsonb_each(c -> 'before') as b(k, v)
    where jsonb_typeof(c -> 'before') = 'object')
  and (select bool_and(k in ('role', 'mfa_policy', 'user_id', 'owner_user_id'))
         from ans, jsonb_array_elements(ans.da -> 'changes') c,
              jsonb_each(c -> 'after') as b(k, v)
        where jsonb_typeof(c -> 'after') = 'object'),
  '0477/59: before and after hold nothing but role, mfa_policy, user_id and owner_user_id');
select is(
  (select array_agg((c ->> 'created_at')::timestamptz order by n)
     from ans, jsonb_array_elements(ans.da -> 'changes') with ordinality as t(c, n)),
  (select array_agg((c ->> 'created_at')::timestamptz order by (c ->> 'created_at')::timestamptz desc)
     from ans, jsonb_array_elements(ans.da -> 'changes') c),
  '0477/60: newest first');
select is(
  (select array[ans.da -> 'changes' -> 0 ->> 'event', (ans.da -> 'changes' -> 0 ->> 'created_at')::timestamptz::text,
                ans.da -> 'changes' -> 33 ->> 'event', (ans.da -> 'changes' -> 33 ->> 'created_at')::timestamptz::text]
     from ans),
  array['user.role.changed', (now() - interval '1 day')::text,
        'user.invite.accepted', (now() - interval '30 days')::text],
  '0477/61: the first is the newest (the demotion a day ago) and the last the row exactly 30 days old');
select is(
  (select array_agg(distinct c ->> 'event' order by c ->> 'event') from ans, jsonb_array_elements(ans.da -> 'changes') c),
  array['organization.mfa_policy.changed', 'organization.ownership.transferred', 'user.deactivated',
        'user.invite.accepted', 'user.role.changed'],
  '0477/62: the five events and no other');
select is(
  (select c from ans, jsonb_array_elements(ans.da -> 'changes') c
    where (c ->> 'created_at')::timestamptz = now() - interval '2 days' and c ->> 'target_user_id' = :adminNone),
  jsonb_build_object('created_at', now() - interval '2 days', 'event', 'user.role.changed',
    'actor_user_id', :ownerA, 'target_user_id', :adminNone, 'entity_id', :mAdminNone,
    'entity_type', 'organization_member',
    'before', jsonb_build_object('role', 'staff'), 'after', jsonb_build_object('role', 'admin'),
    'role', null, 'already_member', false, 'made_as', 'authenticated'),
  '0477/63: a role change as the database records it: actor, member, membership, before, after, made_as');
select is(
  (select c from ans, jsonb_array_elements(ans.da -> 'changes') c
    where (c ->> 'created_at')::timestamptz = now() - interval '1 day' and c ->> 'target_user_id' = :staffNone),
  jsonb_build_object('created_at', now() - interval '1 day', 'event', 'user.role.changed',
    'actor_user_id', :ownerA, 'target_user_id', :staffNone, 'entity_id', :mStaffNone,
    'entity_type', 'organization_member',
    'before', jsonb_build_object('role', 'admin'), 'after', jsonb_build_object('role', 'staff'),
    'role', null, 'already_member', false, 'made_as', 'authenticated'),
  '0477/64: an address, a session id and a user agent an audit row may carry are not returned');
select is(
  (select c from ans, jsonb_array_elements(ans.da -> 'changes') c
    where (c ->> 'created_at')::timestamptz = now() - interval '3 days' and c ->> 'target_user_id' = :adminUnv),
  jsonb_build_object('created_at', now() - interval '3 days', 'event', 'user.role.changed',
    'actor_user_id', :ownerA, 'target_user_id', :adminUnv, 'entity_id', :mAdminUnv,
    'entity_type', 'organization_member',
    'before', jsonb_build_object('role', 'manager'), 'after', jsonb_build_object('role', 'admin'),
    'role', null, 'already_member', false, 'made_as', null),
  '0477/65: the app''s older shape of a role change: the member is found through the membership in entity_id');
select is(
  (select jsonb_agg(c order by (c ->> 'created_at')::timestamptz desc) from ans, jsonb_array_elements(ans.da -> 'changes') c
    where (c ->> 'created_at')::timestamptz in (now() - interval '1 day 1 hour', now() - interval '1 day 2 hours',
                                                now() - interval '1 day 3 hours')),
  jsonb_build_array(
    jsonb_build_object('created_at', now() - interval '1 day 1 hour', 'event', 'user.role.changed',
      'actor_user_id', :ownerA, 'target_user_id', null, 'entity_id', :mGone, 'entity_type', 'organization_member',
      'before', jsonb_build_object('role', 'staff'), 'after', jsonb_build_object('role', 'manager'),
      'role', null, 'already_member', false, 'made_as', null),
    jsonb_build_object('created_at', now() - interval '1 day 2 hours', 'event', 'user.role.changed',
      'actor_user_id', :ownerA, 'target_user_id', null, 'entity_id', :mStaffB, 'entity_type', 'organization_member',
      'before', null, 'after', jsonb_build_object(),
      'role', repeat('r', 64), 'already_member', false, 'made_as', repeat('m', 64)),
    jsonb_build_object('created_at', now() - interval '1 day 3 hours', 'event', 'user.deactivated',
      'actor_user_id', :ownerA, 'target_user_id', null, 'entity_id', repeat('e', 64), 'entity_type', 'organization_member',
      'before', jsonb_build_object('user_id', repeat('u', 64), 'role', 'staff'), 'after', null,
      'role', null, 'already_member', false, 'made_as', null)),
  '0477/66: a membership that is gone names no member, and neither does a membership of another organization; unknown keys and nested objects are dropped; a before that is not an object is null and a role that is not text is left out; text is cut at 64 characters');
select is(
  (select jsonb_agg(c - 'created_at' order by (c ->> 'created_at')::timestamptz) from ans, jsonb_array_elements(ans.da -> 'changes') c
    where c ->> 'event' = 'user.invite.accepted'
      and (c ->> 'created_at')::timestamptz >= date_trunc('day', now() - interval '2 days', 'UTC')
      and (c ->> 'created_at')::timestamptz < date_trunc('day', now() - interval '2 days', 'UTC') + interval '12 hours'),
  jsonb_build_array(
    jsonb_build_object('event', 'user.invite.accepted', 'actor_user_id', :adminOld, 'target_user_id', null,
      'entity_id', null, 'entity_type', null, 'before', null, 'after', null,
      'role', 'admin', 'already_member', false, 'made_as', null),
    jsonb_build_object('event', 'user.invite.accepted', 'actor_user_id', :edgeIn, 'target_user_id', null,
      'entity_id', null, 'entity_type', null, 'before', null, 'after', null,
      'role', null, 'already_member', true, 'made_as', null)),
  '0477/67: an invitation accepted carries its role; an "already a member" press carries already_member and no role');
select is(
  (select jsonb_agg(c - 'created_at' order by c ->> 'event', c ->> 'entity_type') from ans, jsonb_array_elements(ans.da -> 'changes') c
    where (c ->> 'created_at')::timestamptz in (now() - interval '3 days 6 hours' + interval '2 seconds',
                                                now() - interval '1 day 7 hours', now() - interval '6 days',
                                                now() - interval '9 days')),
  jsonb_build_array(
    jsonb_build_object('event', 'organization.mfa_policy.changed', 'actor_user_id', null, 'target_user_id', null,
      'entity_id', :orgA, 'entity_type', 'organization',
      'before', jsonb_build_object('mfa_policy', 'optional'), 'after', jsonb_build_object('mfa_policy', 'admins_required'),
      'role', null, 'already_member', false, 'made_as', 'authenticated'),
    jsonb_build_object('event', 'organization.ownership.transferred', 'actor_user_id', :ownerA, 'target_user_id', null,
      'entity_id', :orgA, 'entity_type', 'organization',
      'before', jsonb_build_object('owner_user_id', :ownerA), 'after', jsonb_build_object('owner_user_id', :adminOld),
      'role', null, 'already_member', false, 'made_as', null),
    jsonb_build_object('event', 'user.deactivated', 'actor_user_id', null, 'target_user_id', null,
      'entity_id', 'a0477000-0000-0000-0000-0000000009a4', 'entity_type', 'user',
      'before', null, 'after', null, 'role', null, 'already_member', false, 'made_as', null),
    jsonb_build_object('event', 'user.invite.accepted', 'actor_user_id', null, 'target_user_id', null,
      'entity_id', null, 'entity_type', null, 'before', null, 'after', null,
      'role', null, 'already_member', false, 'made_as', null)),
  '0477/68: a policy change, the app''s ownership row (it never names a membership), a deleted account and a row with no metadata, each as documented');
select is(
  (select jsonb_agg(c -> 'after' order by c ->> 'target_user_id') from ans, jsonb_array_elements(ans.da -> 'changes') c
    where (c ->> 'created_at')::timestamptz = now() - interval '3 days 6 hours'),
  jsonb_build_array(jsonb_build_object('role', 'admin'), jsonb_build_object('role', 'owner')),
  '0477/69: the list keeps both rows of the ownership transfer as they are (nothing is folded in the list)');
select is(
  (select array[jsonb_array_length(ans.db -> 'changes')::text, ans.db -> 'changes' -> 0 ->> 'target_user_id',
                ans.db -> 'changes' -> 0 ->> 'actor_user_id'] from ans),
  array['1', :staffB, :ownerB],
  '0477/70: Example Charter''s list holds its own row and none of Example Academy''s');

-- ── 10. The caps ────────────────────────────────────────────────────────────
-- 200 people. Example Empty gets 200 members with no second step, then one
-- more.
savepoint people_cap;
insert into auth.users (id, email, raw_user_meta_data)
select ('a0477000-0000-0000-0002-' || lpad(g::text, 12, '0'))::uuid, 'cap-' || lpad(g::text, 3, '0') || '@example.com',
       jsonb_build_object('full_name', 'Briefing Cap ' || lpad(g::text, 3, '0'))
  from generate_series(1, 201) g;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
select :orgZ, ('a0477000-0000-0000-0002-' || lpad(g::text, 12, '0'))::uuid, 'staff', now() - interval '30 days'
  from generate_series(1, 200) g;
select is(
  (select array[jsonb_array_length(d -> 'people')::text, d ->> 'people_truncated', d ->> 'members',
                d ->> 'without_second_step', d -> 'people' -> 0 ->> 'email', d -> 'people' -> 199 ->> 'email']
     from public.platform_security_briefing_for_organization(:orgZ) d),
  array['200', 'false', '200', '200', 'cap-001@example.com', 'cap-200@example.com'],
  '0477/71: 200 people are all listed and the list is not truncated');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
values (:orgZ, 'a0477000-0000-0000-0002-000000000201', 'staff', now() - interval '30 days');
select is(
  (select array[jsonb_array_length(d -> 'people')::text, d ->> 'people_truncated', d ->> 'members',
                d ->> 'without_second_step', d -> 'people' -> 0 ->> 'email', d -> 'people' -> 199 ->> 'email']
     from public.platform_security_briefing_for_organization(:orgZ) d),
  array['200', 'true', '201', '201', 'cap-001@example.com', 'cap-200@example.com'],
  '0477/72: at 201 the list holds the first 200, people_truncated is true and the counts stay exact');
select is(
  (select (o ->> 'without_second_step')::int from pg_temp.org_of(public.platform_security_briefing_members(), :orgZ) o),
  201,
  '0477/73: and the all-organizations read counts all 201');
rollback to savepoint people_cap;

-- 200 changes. Example Academy has 34; 166 more make 200, then one more.
savepoint changes_cap;
insert into public.audit_logs (organization_id, user_id, event, metadata, created_at)
select :orgA, null, 'user.invite.accepted', jsonb_build_object('role', 'viewer'),
       now() - interval '20 days' - make_interval(secs => g)
  from generate_series(1, 166) g;
select is(
  (select array[jsonb_array_length(d -> 'changes')::text, d ->> 'changes_truncated',
                (d -> 'changes' -> 199 ->> 'created_at')::timestamptz::text]
     from public.platform_security_briefing_for_organization(:orgA) d),
  array['200', 'false', (now() - interval '30 days')::text],
  '0477/74: 200 changes are all listed and the list is not truncated');
select pg_temp.audit(:orgA, null, 'user.invite.accepted', now() - interval '25 days', jsonb_build_object('role', 'viewer'));
select is(
  (select array[jsonb_array_length(d -> 'changes')::text, d ->> 'changes_truncated',
                (d -> 'changes' -> 199 ->> 'created_at')::timestamptz::text,
                (d -> 'changes' -> 0 ->> 'created_at')::timestamptz::text]
     from public.platform_security_briefing_for_organization(:orgA) d),
  array['200', 'true', (now() - interval '25 days')::text, (now() - interval '1 day')::text],
  '0477/75: at 201 the list holds the newest 200 (the oldest row is the one left out) and changes_truncated is true');
rollback to savepoint changes_cap;

-- 500 organizations. 500 more, each with one event this week and one
-- policy change this week, none with a member.
savepoint org_cap;
insert into public.organizations (id, name, slug, mfa_policy)
select ('a0477000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'Example Filler ' || lpad(g::text, 3, '0'),
       'a0477000-example-filler-' || g, 'optional'
  from generate_series(1, 500) g;
insert into public.security_events (minute, category, outcome, reason, source, organization_id, event_count, dedupe_key)
select date_trunc('minute', now() - interval '1 hour', 'UTC'), 'bots', 'blocked', 'bot_detected', 'web',
       ('a0477000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 1, md5(g::text)
  from generate_series(1, 500) g;
insert into public.audit_logs (organization_id, user_id, event, metadata, created_at)
select ('a0477000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, null, 'organization.mfa_policy.changed',
       jsonb_build_object('entity_type', 'organization',
                          'before', jsonb_build_object('mfa_policy', 'optional'),
                          'after', jsonb_build_object('mfa_policy', 'all_required')),
       now() - interval '1 hour'
  from generate_series(1, 500) g;
select is(
  (select array[jsonb_array_length(m -> 'organizations')::text, m ->> 'organizations_truncated',
                ((m -> 'totals' ->> 'organizations')::int - (base.members -> 'totals' ->> 'organizations')::int)::text,
                ((m -> 'totals' ->> 'accounts')::int - (base.members -> 'totals' ->> 'accounts')::int)::text,
                (pg_temp.org_of(m, :orgA) is not null)::text, (pg_temp.org_of(m, :orgB) is not null)::text,
                (m -> 'organizations' -> 0 ->> 'organization_id')]
     from public.platform_security_briefing_members() m, base),
  array['500', 'true', '504', '13', 'true', 'true', :orgA],
  '0477/76: with more than 500 organizations the members read lists 500, says it is truncated, keeps the ones with a count to show (first), and its totals still count every organization and account');
select is(
  (select array[jsonb_array_length(e -> 'organizations')::text, e ->> 'organizations_truncated',
                e -> 'organizations' -> 0 ->> 'organization_id', e -> 'organizations' -> 1 ->> 'organization_id',
                e -> 'organizations' -> 2 ->> 'organization_id',
                e -> 'organizations' -> 3 ->> 'organization_id', e -> 'organizations' -> 499 ->> 'organization_id']
     from public.platform_security_briefing_events() e),
  array['500', 'true', :orgA, :orgC, :orgB,
        'a0477000-0000-0000-0001-000000000001', 'a0477000-0000-0000-0001-000000000497'],
  '0477/77: with 503 organizations that have events the events read lists the 500 with the most this week and says it is truncated');
select is(
  (select array[jsonb_array_length(c -> 'organizations')::text, c ->> 'organizations_truncated',
                c -> 'organizations' -> 0 ->> 'organization_id', c -> 'organizations' -> 1 ->> 'organization_id',
                c -> 'organizations' -> 499 ->> 'organization_id']
     from public.platform_security_briefing_changes() c),
  array['500', 'true', :orgA, :orgB, 'a0477000-0000-0000-0001-000000000498'],
  '0477/78: with 502 organizations that have a change the changes read lists the 500 with the most and says it is truncated');
rollback to savepoint org_cap;

-- An ownership move is never set aside for an invitation, even in the
-- very shape of an acceptance seen twice (the same member and UTC day, the
-- invitation for the role the row ends at, recorded a second after it).
-- Example Institute: a member becomes the owner while the previous owner
-- steps down, the two rows of one transfer, and each accepts such an
-- invitation. Example Empty: a lone row makes a member the owner. Each is
-- one move, and neither is an admin promoted or demoted.
savepoint owner_and_invite;
select pg_temp.role_row(:orgC, gen_random_uuid(), :staffB, 'admin', 'owner',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '13 hours', null, 'service_role');
select pg_temp.role_row(:orgC, gen_random_uuid(), :ownerC, 'owner', 'admin',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '13 hours', null, 'service_role');
select pg_temp.invite(:orgC, :staffB, 'owner',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '13 hours 1 second');
select pg_temp.invite(:orgC, :ownerC, 'admin',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '13 hours 1 second');
select pg_temp.role_row(:orgZ, gen_random_uuid(), :staffNone, 'staff', 'owner',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '14 hours', null, 'direct');
select pg_temp.invite(:orgZ, :staffNone, 'owner',
  date_trunc('day', now() - interval '2 days', 'UTC') + interval '14 hours 1 second');
select is(
  array[pg_temp.org_of(public.platform_security_briefing_changes(), :orgC),
        pg_temp.org_of(public.platform_security_briefing_changes(), :orgZ)],
  array[jsonb_build_object('organization_id', :orgC,
          'admins_promoted', 0, 'admins_demoted_or_removed', 0, 'ownership_moved', 1,
          'sign_in_policy_loosened', 0, 'sign_in_policy_tightened', 0, 'sign_in_policy_changed_other', 0,
          'admins_added_this_week', 0),
        jsonb_build_object('organization_id', :orgZ,
          'admins_promoted', 0, 'admins_demoted_or_removed', 0, 'ownership_moved', 1,
          'sign_in_policy_loosened', 0, 'sign_in_policy_tightened', 0, 'sign_in_policy_changed_other', 0,
          'admins_added_this_week', 0)],
  '0477/79: a change with owner on either side is always an ownership move, also when the member accepts, a second later, an invitation for the role it ends at: the transfer counts once and a lone owner row counts once, with nobody promoted or demoted');
rollback to savepoint owner_and_invite;

-- ── 11. The week's counts, written once ─────────────────────────────────────
select is(
  array[(select count(*) from public._security_briefing_change_counts(:orgA)),
        (select count(*) from public._security_briefing_change_counts(null)) - (select count(*) from public.organizations),
        (select count(*) from public._security_briefing_change_counts('a0477000-0000-0000-0000-00000000dead'))],
  array[1, 0, 0]::bigint[],
  '0477/80: the private count gives one row for the organization asked for, one for every organization when none is named, and none for an id that names no organization');
select is(
  (select array[(a.organization_id = :orgA)::text, a.total::text, (a.counts = pg_temp.org_of(ans.changes, :orgA))::text,
                (z.organization_id = :orgZ)::text, z.total::text,
                (z.counts = pg_temp.counts(:orgZ, 0, 0, 0, 0, 0, 0, 0))::text]
     from public._security_briefing_change_counts(:orgA) a, public._security_briefing_change_counts(:orgZ) z, ans),
  array['true', '21', 'true', 'true', '0', 'true'],
  '0477/81: its counts are the object the changes read returns and its total is the sum of the seven numbers; an organization with nothing this week has a row of zeros');
select is(
  (select array[ans.da -> 'changes_this_week', ans.db -> 'changes_this_week',
                ans.dc -> 'changes_this_week', ans.dz -> 'changes_this_week'] from ans),
  (select array[pg_temp.org_of(ans.changes, :orgA), pg_temp.org_of(ans.changes, :orgB),
                pg_temp.counts(:orgC, 0, 0, 0, 0, 0, 0, 0), pg_temp.counts(:orgZ, 0, 0, 0, 0, 0, 0, 0)] from ans),
  '0477/82: one organization''s detail carries in changes_this_week the very object the read of all organizations gives for it, and all zeros (with exactly the same keys) when that read does not list it');
select is(
  array[(select count(*)::int
           from regexp_matches((select p.prosrc from pg_proc p
                                 where p.oid = 'public._security_briefing_change_counts(uuid)'::regprocedure),
                               'public\.audit_logs', 'g')),
        (select count(*)::int from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'
            and p.prosrc ~ 'admins_promoted'),
        (select count(*)::int from pg_proc p
          where p.oid in ('public.platform_security_briefing_changes()'::regprocedure,
                          'public.platform_security_briefing_for_organization(uuid)'::regprocedure)
            and p.prosrc ~ 'public\._security_briefing_change_counts\(')],
  array[1, 1, 2],
  '0477/83: the counting rules are written once: the private count reads the audit log in one place (one pass over the week''s rows, nothing read again for a row), it alone names the counts, and both public reads call it');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '%security\_briefing%'
      and p.prosrc ~* 'interval\s+''[^'']*(day|week|month|year)'),
  0,
  '0477/84: no body measures its windows in days: 7, 14 and 30 days are written as 168, 336 and 720 hours');

-- ── 12. An invitation and the role change it explains ───────────────────────
-- D is the UTC day that holds now - 72 hours; d(h) is h hours into it.
-- Eight more organizations, each with one case. The acceptance of an
-- invitation onto a row that is not accepted yet writes the role first (the
-- database's row) and its own row after: only that pair is one event.
create function pg_temp.d(p_hours numeric) returns timestamptz language sql as $$
  select date_trunc('day', now() - interval '72 hours', 'UTC') + make_interval(secs => p_hours * 3600);
$$;
\set e1 '\'a0477000-0000-0000-0003-000000000001\''
\set e2 '\'a0477000-0000-0000-0003-000000000002\''
\set e3 '\'a0477000-0000-0000-0003-000000000003\''
\set e4 '\'a0477000-0000-0000-0003-000000000004\''
\set e5 '\'a0477000-0000-0000-0003-000000000005\''
\set e6 '\'a0477000-0000-0000-0003-000000000006\''
\set e7 '\'a0477000-0000-0000-0003-000000000007\''
\set e8 '\'a0477000-0000-0000-0003-000000000008\''
\set x1 '\'a0477000-0000-0000-0004-000000000001\''
\set x2 '\'a0477000-0000-0000-0004-000000000002\''
\set x3 '\'a0477000-0000-0000-0004-000000000003\''
\set x4 '\'a0477000-0000-0000-0004-000000000004\''
\set x5 '\'a0477000-0000-0000-0004-000000000005\''
\set x6 '\'a0477000-0000-0000-0004-000000000006\''
\set x7 '\'a0477000-0000-0000-0004-000000000007\''
\set x8 '\'a0477000-0000-0000-0004-000000000008\''
\set x9 '\'a0477000-0000-0000-0004-000000000009\''
\set mX9 '\'a0477000-0000-0000-0005-000000000009\''
savepoint invitation_rules;
insert into public.organizations (id, name, slug, mfa_policy)
select ('a0477000-0000-0000-0003-' || lpad(g::text, 12, '0'))::uuid, 'Example Annex ' || g,
       'a0477000-example-annex-' || g, 'optional'
  from generate_series(1, 8) g;
insert into auth.users (id, email, raw_user_meta_data)
select ('a0477000-0000-0000-0004-' || lpad(g::text, 12, '0'))::uuid, 'annex-' || g || '@example.com',
       jsonb_build_object('full_name', 'Briefing Annex ' || g)
  from generate_series(1, 9) g;
-- Annex 1: the acceptance seen twice, as a promotion (the row was viewer,
-- the invitation is for admin) and as a demotion (the row was admin, the
-- invitation is for staff).
select pg_temp.role_row(:e1, gen_random_uuid(), :x1, 'viewer', 'admin', pg_temp.d(9), null, 'service_role');
select pg_temp.invite(:e1, :x1, 'admin', pg_temp.d(9) + interval '1 second');
select pg_temp.role_row(:e1, gen_random_uuid(), :x2, 'admin', 'staff', pg_temp.d(10), null, 'service_role');
select pg_temp.invite(:e1, :x2, 'staff', pg_temp.d(10) + interval '1 second');
-- Annex 2: joined as staff in the morning, made an admin that afternoon.
select pg_temp.invite(:e2, :x3, 'staff', pg_temp.d(9));
select pg_temp.role_row(:e2, gen_random_uuid(), :x3, 'staff', 'admin', pg_temp.d(15), :ownerA, 'authenticated');
-- Annex 3: joined as staff, made an admin, made staff again, all that day.
-- The last row ends at the role the invitation gave, after the acceptance.
select pg_temp.invite(:e3, :x4, 'staff', pg_temp.d(9));
select pg_temp.role_row(:e3, gen_random_uuid(), :x4, 'staff', 'admin', pg_temp.d(15), :ownerA, 'authenticated');
select pg_temp.role_row(:e3, gen_random_uuid(), :x4, 'admin', 'staff', pg_temp.d(18), :ownerA, 'authenticated');
-- Annex 4: joined as an admin, made staff, made an admin again that day.
select pg_temp.invite(:e4, :x5, 'admin', pg_temp.d(9));
select pg_temp.role_row(:e4, gen_random_uuid(), :x5, 'admin', 'staff', pg_temp.d(12), :ownerA, 'authenticated');
select pg_temp.role_row(:e4, gen_random_uuid(), :x5, 'staff', 'admin', pg_temp.d(15), :ownerA, 'authenticated');
-- Annex 5: a promotion a second before the member accepts an invitation
-- for another role; and a promotion a second before an "already a member"
-- press, which changed nothing, even were its row to carry the role.
select pg_temp.role_row(:e5, gen_random_uuid(), :x6, 'staff', 'admin', pg_temp.d(9), :ownerA, 'authenticated');
select pg_temp.invite(:e5, :x6, 'staff', pg_temp.d(9) + interval '1 second');
select pg_temp.role_row(:e5, gen_random_uuid(), :x1, 'viewer', 'admin', pg_temp.d(11), :ownerA, 'authenticated');
select pg_temp.audit(:e5, :x1, 'user.invite.accepted', pg_temp.d(11) + interval '1 second', jsonb_build_object(
  'invite_id', gen_random_uuid(), 'already_member', true, 'invite_role', 'admin', 'member_role', 'viewer',
  'role', 'admin'));
-- Annex 6 and 7: the day is the UTC day. 07:00 and 09:00 UTC are one UTC
-- day and two days in a zone eight hours behind; 23:00 and 01:00 UTC are
-- two UTC days and one day there.
select pg_temp.role_row(:e6, gen_random_uuid(), :x7, 'viewer', 'admin', pg_temp.d(7), null, 'service_role');
select pg_temp.invite(:e6, :x7, 'admin', pg_temp.d(9));
select pg_temp.role_row(:e7, gen_random_uuid(), :x8, 'viewer', 'admin', pg_temp.d(23), null, 'service_role');
select pg_temp.invite(:e7, :x8, 'admin', pg_temp.d(25));
-- Annex 8: the older shape, which names a membership and no member. One row
-- names a membership of Example Charter, whose member accepts an invitation
-- to Annex 8 a second later: a membership is never looked up in another
-- organization, so the member is not known and the promotion counts (as one
-- admin added). The other names a membership of Annex 8 itself.
insert into public.organization_members (id, organization_id, user_id, role, accepted_at)
values (:mX9, :e8, :x9, 'admin', now() - interval '60 days');
select pg_temp.audit(:e8, null, 'user.role.changed', pg_temp.d(9), jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', :mStaffB,
  'before', jsonb_build_object('role', 'manager'), 'after', jsonb_build_object('role', 'admin'), 'reason', null));
select pg_temp.invite(:e8, :staffB, 'admin', pg_temp.d(9) + interval '1 second');
select pg_temp.audit(:e8, null, 'user.role.changed', pg_temp.d(10), jsonb_build_object(
  'entity_type', 'organization_member', 'entity_id', :mX9,
  'before', jsonb_build_object('role', 'viewer'), 'after', jsonb_build_object('role', 'admin'), 'reason', null));
select pg_temp.invite(:e8, :x9, 'admin', pg_temp.d(10) + interval '1 second');

select is(pg_temp.week(:e1), pg_temp.counts(:e1, 0, 0, 0, 0, 0, 0, 0),
  '0477/85: an invitation acceptance seen twice is not counted: a role change of the member, on the same UTC day, to the role the invitation gave, recorded just before the acceptance, is neither a promotion nor a demotion');
select is(pg_temp.week(:e2), pg_temp.counts(:e2, 1, 0, 0, 0, 0, 0, 1),
  '0477/86: a member who joined as staff and was made an admin later the same day is one admin promoted');
select is(
  array[pg_temp.week(:e3), pg_temp.week(:e4)],
  array[pg_temp.counts(:e3, 1, 1, 0, 0, 0, 0, 1), pg_temp.counts(:e4, 1, 1, 0, 0, 0, 0, 1)],
  '0477/87: a change recorded after the acceptance is counted even when it ends at the role the invitation gave: promoted and made staff again on the joining day is one promotion and one demotion, and so is an invited admin made staff and then admin again');
select is(pg_temp.week(:e5), pg_temp.counts(:e5, 2, 0, 0, 0, 0, 0, 2),
  '0477/88: an invitation for another role explains nothing, and neither does an "already a member" press: a promotion recorded just before the member accepts an invitation for staff is counted, and so is one recorded just before such a press, whatever its row carries');
select is(
  array[pg_temp.week(:e6), pg_temp.week(:e7)],
  array[pg_temp.counts(:e6, 0, 0, 0, 0, 0, 0, 0), pg_temp.counts(:e7, 1, 0, 0, 0, 0, 0, 1)],
  '0477/89: the day is the UTC day: 07:00 and 09:00 UTC are one acceptance; 23:00 and 01:00 UTC the next day are not');
set local time zone 'Etc/GMT+8';
select is(
  array[pg_temp.week(:e6), pg_temp.week(:e7)],
  array[pg_temp.counts(:e6, 0, 0, 0, 0, 0, 0, 0), pg_temp.counts(:e7, 1, 0, 0, 0, 0, 0, 1)],
  '0477/90: and the same in a session whose zone is eight hours behind UTC, where those are two days and one day');
reset time zone;
select is(pg_temp.week(:e8), pg_temp.counts(:e8, 1, 0, 0, 0, 0, 0, 1),
  '0477/91: a member named only by a membership id is looked up in the row''s own organization and never in another: the row naming another organization''s membership names nobody, so that member''s invitation does not set it aside; the row naming this organization''s membership is the acceptance seen twice');
select is(
  (select array_agg(pg_temp.week(o.id) order by o.id)
     from public.organizations o where o.name like 'Example Annex %'),
  (select array_agg(coalesce(pg_temp.org_of(c.j, o.id), pg_temp.counts(o.id, 0, 0, 0, 0, 0, 0, 0)) order by o.id)
     from public.organizations o, (select public.platform_security_briefing_changes() as j) c
    where o.name like 'Example Annex %'),
  '0477/92: for all eight the detail and the read of all organizations give the same object (zeros where the list leaves the organization out)');
rollback to savepoint invitation_rules;

-- ── 13. Admins added: people, not rows ──────────────────────────────────────
\set g1 '\'a0477000-0000-0000-0006-000000000001\''
\set g2 '\'a0477000-0000-0000-0006-000000000002\''
\set g3 '\'a0477000-0000-0000-0006-000000000003\''
\set g4 '\'a0477000-0000-0000-0006-000000000004\''
\set g5 '\'a0477000-0000-0000-0006-000000000005\''
\set g6 '\'a0477000-0000-0000-0006-000000000006\''
\set g7 '\'a0477000-0000-0000-0006-000000000007\''
\set y1 '\'a0477000-0000-0000-0007-000000000001\''
\set y2 '\'a0477000-0000-0000-0007-000000000002\''
\set y4 '\'a0477000-0000-0000-0007-000000000004\''
\set y5 '\'a0477000-0000-0000-0007-000000000005\''
\set y6 '\'a0477000-0000-0000-0007-000000000006\''
\set y7 '\'a0477000-0000-0000-0007-000000000007\''
\set y8 '\'a0477000-0000-0000-0007-000000000008\''
\set y9 '\'a0477000-0000-0000-0007-000000000009\''
savepoint admins_added;
insert into public.organizations (id, name, slug, mfa_policy)
select ('a0477000-0000-0000-0006-' || lpad(g::text, 12, '0'))::uuid, 'Example Branch ' || g,
       'a0477000-example-branch-' || g, 'optional'
  from generate_series(1, 7) g;
insert into auth.users (id, email, raw_user_meta_data)
select ('a0477000-0000-0000-0007-' || lpad(g::text, 12, '0'))::uuid, 'branch-' || g || '@example.com',
       jsonb_build_object('full_name', 'Briefing Branch ' || g)
  from generate_series(1, 9) g;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  -- Branch 1: joined as staff this week and was promoted (an admin now).
  (:g1, :y1, 'admin', pg_temp.d(9)),
  -- Branch 2: joined as an admin this week.
  (:g2, :y2, 'admin', pg_temp.d(9)),
  -- Branch 3: the same person, a member here for 60 days, promoted this
  -- week, made staff and promoted again.
  (:g3, :y2, 'admin', now() - interval '60 days'),
  -- Branch 4: one of each.
  (:g4, :y4, 'admin', pg_temp.d(9)),
  (:g4, :y5, 'admin', pg_temp.d(10)),
  (:g4, :y6, 'admin', now() - interval '60 days'),
  -- Branch 5: joined as an admin this week and was made staff; and a staff
  -- member of 60 days who became an admin of Branch 1 this week.
  (:g5, :y7, 'staff', pg_temp.d(9)),
  (:g5, :y1, 'staff', now() - interval '60 days'),
  -- Branch 6: joined as staff this week and was given the ownership; the
  -- previous owner, a member for 60 days, is an admin now.
  (:g6, :y8, 'owner', pg_temp.d(9)),
  (:g6, :y9, 'admin', now() - interval '60 days'),
  -- Branch 7: the ownership moved between two members of 60 days.
  (:g7, :y5, 'owner', now() - interval '60 days'),
  (:g7, :y6, 'admin', now() - interval '60 days');
select pg_temp.invite(:g1, :y1, 'staff', pg_temp.d(9));
select pg_temp.role_row(:g1, gen_random_uuid(), :y1, 'staff', 'admin', pg_temp.d(15), :ownerA, 'authenticated');
select pg_temp.invite(:g2, :y2, 'admin', pg_temp.d(9));
select pg_temp.role_row(:g3, gen_random_uuid(), :y2, 'staff', 'admin', pg_temp.d(15), :ownerA, 'authenticated');
select pg_temp.role_row(:g3, gen_random_uuid(), :y2, 'admin', 'staff', pg_temp.d(16), :ownerA, 'authenticated');
select pg_temp.role_row(:g3, gen_random_uuid(), :y2, 'staff', 'admin', pg_temp.d(17), :ownerA, 'authenticated');
select pg_temp.invite(:g4, :y4, 'staff', pg_temp.d(9));
select pg_temp.role_row(:g4, gen_random_uuid(), :y4, 'staff', 'admin', pg_temp.d(15), :ownerA, 'authenticated');
select pg_temp.invite(:g4, :y5, 'admin', pg_temp.d(10));
select pg_temp.role_row(:g4, gen_random_uuid(), :y6, 'staff', 'admin', pg_temp.d(16), :ownerA, 'authenticated');
select pg_temp.invite(:g5, :y7, 'admin', pg_temp.d(9));
select pg_temp.role_row(:g5, gen_random_uuid(), :y7, 'admin', 'staff', pg_temp.d(15), :ownerA, 'authenticated');
select pg_temp.invite(:g6, :y8, 'staff', pg_temp.d(9));
select pg_temp.role_row(:g6, gen_random_uuid(), :y8, 'staff', 'owner', pg_temp.d(13), null, 'service_role');
select pg_temp.role_row(:g6, gen_random_uuid(), :y9, 'owner', 'admin', pg_temp.d(13), null, 'service_role');
select pg_temp.role_row(:g7, gen_random_uuid(), :y5, 'admin', 'owner', pg_temp.d(13), null, 'service_role');
select pg_temp.role_row(:g7, gen_random_uuid(), :y6, 'owner', 'admin', pg_temp.d(13), null, 'service_role');

select is(
  array[pg_temp.week(:g1), pg_temp.week(:g2), pg_temp.week(:g3)],
  array[pg_temp.counts(:g1, 1, 0, 0, 0, 0, 0, 1), pg_temp.counts(:g2, 0, 0, 0, 0, 0, 0, 1),
        pg_temp.counts(:g3, 2, 1, 0, 0, 0, 0, 1)],
  '0477/93: admins added counts people: joined as staff and promoted the same week is 1 (not a joiner and a promotion); joined as an admin is 1; a member of long standing promoted twice in the week is 1; and the person who joined one organization as an admin and was promoted in another is counted in each on its own facts');
select is(pg_temp.week(:g4), pg_temp.counts(:g4, 2, 0, 0, 0, 0, 0, 3),
  '0477/94: one of each in one organization is 3 admins added, with 2 promotions');
select is(pg_temp.week(:g5), pg_temp.counts(:g5, 0, 1, 0, 0, 0, 0, 0),
  '0477/95: joined as an admin and made staff the same week is no admin added and one demoted; a staff member here who became an admin of another organization adds nothing here');
select is(
  array[pg_temp.week(:g6), pg_temp.week(:g7)],
  array[pg_temp.counts(:g6, 0, 0, 1, 0, 0, 0, 1), pg_temp.counts(:g7, 0, 0, 1, 0, 0, 0, 0)],
  '0477/96: an ownership move is counted in its own number and adds nobody by itself: the new owner who also joined this week is one admin added (as a new member), the previous owner is none, and a move between members of long standing adds none');
select is(
  (select array_agg((public.platform_security_briefing_for_organization(o.id) ->> 'admins_joined_this_week')::int order by o.id)
     from public.organizations o where o.name like 'Example Branch %'),
  array[1, 1, 0, 2, 0, 1, 0],
  '0477/97: admins_joined_this_week is unchanged beside it: the members who joined this week and are an admin or owner now');
select is(
  (select array_agg(pg_temp.week(o.id) order by o.id)
     from public.organizations o where o.name like 'Example Branch %'),
  (select array_agg(pg_temp.org_of(c.j, o.id) order by o.id)
     from public.organizations o, (select public.platform_security_briefing_changes() as j) c
    where o.name like 'Example Branch %'),
  '0477/98: all seven are listed by the read of all organizations with the object their detail carries (an organization whose only number is an admin added is listed too)');
rollback to savepoint admins_added;

-- ── 14. A busy week ─────────────────────────────────────────────────────────
-- Example Institute loosens its sign-in policy six days ago, and then 250
-- members accept invitations. The list holds the newest 200 rows, so the
-- policy change is not in it; the week's counts still hold it.
savepoint busy_week;
select pg_temp.policy_row(:orgC, 'all_required', 'optional', now() - interval '144 hours');
insert into public.audit_logs (organization_id, user_id, event, metadata, created_at)
select :orgC, null, 'user.invite.accepted', jsonb_build_object('role', 'viewer'),
       now() - interval '120 hours' + make_interval(secs => g)
  from generate_series(1, 250) g;
select is(
  (select array[jsonb_array_length(d -> 'changes')::text, d ->> 'changes_truncated',
                (select count(*) from jsonb_array_elements(d -> 'changes') c
                  where c ->> 'event' = 'organization.mfa_policy.changed')::text,
                (d -> 'changes_this_week' = pg_temp.counts(:orgC, 0, 0, 0, 1, 0, 0, 0))::text,
                (d -> 'changes_this_week' = pg_temp.org_of(public.platform_security_briefing_changes(), :orgC))::text]
     from public.platform_security_briefing_for_organization(:orgC) d),
  array['200', 'true', '0', 'true', 'true'],
  '0477/99: with more than 200 rows in the list (changes_truncated true, the policy change no longer among them) changes_this_week still counts the loosened policy, as the read of all organizations does: the counts are never cut short');
rollback to savepoint busy_week;

-- ── 15. Free text ───────────────────────────────────────────────────────────
-- A member's name is their own free text; an audit row's values are whatever
-- was stored.
savepoint free_text;
update public.user_profiles set full_name = repeat('Example ', 700) where id = :adminNone;
select pg_temp.audit(:orgA, :ownerA, 'user.deactivated', now() - interval '1 hour', jsonb_build_object(
  'entity_type', jsonb_build_array('organization_member'), 'entity_id', jsonb_build_object('id', 'x'),
  'before', jsonb_build_object('role', 'staff')));
select is(
  array[(select length(b.full_name)::text from public._security_briefing_members(:orgA) b where b.user_id = :adminNone),
        (select (p ->> 'full_name' = left(repeat('Example ', 700), 200))::text
           from jsonb_array_elements(public.platform_security_briefing_for_organization(:orgA) -> 'people') p
          where p ->> 'user_id' = :adminNone)],
  array['200', 'true'],
  '0477/100: a member''s name of 5,600 characters comes back as its first 200, from the private member read and in people');
select is(
  (select c - 'created_at'
     from jsonb_array_elements(public.platform_security_briefing_for_organization(:orgA) -> 'changes') c
    where (c ->> 'created_at')::timestamptz = now() - interval '1 hour'),
  jsonb_build_object('event', 'user.deactivated', 'actor_user_id', :ownerA, 'target_user_id', null,
    'entity_id', null, 'entity_type', null, 'before', jsonb_build_object('role', 'staff'), 'after', null,
    'role', null, 'already_member', false, 'made_as', null),
  '0477/101: an entity_id or entity_type that is not text (an object, a list) is null, as every other value of a row that is not text');
rollback to savepoint free_text;

-- ── 16. A clock change inside the window ────────────────────────────────────
-- A made-up zone whose clocks went forward three days ago: there, "7 days
-- ago" is 167 hours ago and "30 days ago" 719. Example Institute gets one of
-- everything half an hour inside each window as the functions measure it
-- (168, 336 and 720 hours), which a window measured in days of that zone
-- would leave out (or, for the sign-in, take as idle).
\set clock '\'a0477000-0000-0000-0008-000000000001\''
savepoint clock_change;
insert into auth.users (id, email, raw_user_meta_data)
values (:clock, 'clock@example.com', '{"full_name": "Briefing Clock"}'::jsonb);
insert into public.organization_members (organization_id, user_id, role, accepted_at)
values (:orgC, :clock, 'admin', now() - interval '167 hours 30 minutes');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), :clock, 'Briefing authenticator', 'totp', 'verified', now(), now());
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at, not_after)
values (gen_random_uuid(), :clock, now() - interval '960 hours', now(),
        (now() - interval '719 hours 30 minutes') at time zone 'utc', null);
select pg_temp.alert(:clock, 'not_me', now() - interval '167 hours 30 minutes');
select pg_temp.ev(:orgC, now() - interval '167 hours 30 minutes', 'malware', 'allowed', 'upload_allowed', 7);
select pg_temp.ev(:orgC, now() - interval '335 hours 30 minutes', 'malware', 'flagged', 'upload_flagged', 9);
select pg_temp.policy_row(:orgC, 'optional', 'all_required', now() - interval '167 hours 30 minutes');
select pg_temp.invite(:orgC, :clock, 'admin', now() - interval '719 hours 30 minutes');
select set_config('TimeZone',
  'EXS8EXD,' || (extract(doy from (now() at time zone 'utc') - interval '72 hours')::int - 1) || '/2,'
             || ((extract(doy from (now() at time zone 'utc') - interval '72 hours')::int - 1 + 180) % 365) || '/2',
  true) is not null as zone_set \gset
select is(
  (select array[((now() - interval '7 days') - (now() - interval '168 hours'))::text,
                ((now() - interval '30 days') - (now() - interval '720 hours'))::text]),
  array['01:00:00', '01:00:00'],
  '0477/102: in the made-up zone 7 days ago and 30 days ago are an hour later than 168 and 720 hours ago (so the next test can fail)');
select is(
  (select array[d ->> 'admins_joined_this_week', d ->> 'sign_ins_reported_this_week', d ->> 'idle_sign_ins',
                jsonb_array_length(d -> 'changes')::text,
                (d -> 'changes_this_week' = pg_temp.counts(:orgC, 0, 0, 0, 0, 1, 0, 1))::text,
                m ->> 'admins_joined_this_week', m ->> 'sign_ins_reported_this_week', m ->> 'idle_sign_ins',
                e -> 'this_week' -> 'malware' ->> 'allowed', e -> 'last_week' -> 'malware' ->> 'flagged',
                (c = pg_temp.counts(:orgC, 0, 0, 0, 0, 1, 0, 1))::text]
     from public.platform_security_briefing_for_organization(:orgC) d,
          pg_temp.org_of(public.platform_security_briefing_members(), :orgC) m,
          pg_temp.org_of(public.platform_security_briefing_events(), :orgC) e,
          pg_temp.org_of(public.platform_security_briefing_changes(), :orgC) c),
  array['1', '1', '0', '2', 'true', '1', '1', '0', '7', '9', 'true'],
  '0477/103: there, every function still measures 168, 336 and 720 hours: the admin who joined, the sign-in reported, the event and the policy change of 167 and a half hours ago are this week; the event of 335 and a half hours ago is last week; the sign-in last used 719 and a half hours ago is not idle and the row of that age is in the 30-day list');
rollback to savepoint clock_change;

-- ── 17. Three edges of the week's counts ────────────────────────────────────
-- Five more organizations. Wing 1 and 2: one person accepts an invitation
-- for admin in Wing 1 a second after Wing 2 made them an admin; nothing
-- but the organization differs between the two rows. Wing 3: the role row
-- and the acceptance carry the very same time. Wing 4 and 5: an admin who
-- joined exactly 168 hours ago, and one a microsecond before that; neither
-- organization has an audit row.
\set w1 '\'a0477000-0000-0000-0009-000000000001\''
\set w2 '\'a0477000-0000-0000-0009-000000000002\''
\set w3 '\'a0477000-0000-0000-0009-000000000003\''
\set w4 '\'a0477000-0000-0000-0009-000000000004\''
\set w5 '\'a0477000-0000-0000-0009-000000000005\''
\set p1 '\'a0477000-0000-0000-000a-000000000001\''
\set p2 '\'a0477000-0000-0000-000a-000000000002\''
\set p3 '\'a0477000-0000-0000-000a-000000000003\''
\set p4 '\'a0477000-0000-0000-000a-000000000004\''
savepoint week_edges;
insert into public.organizations (id, name, slug, mfa_policy)
select ('a0477000-0000-0000-0009-' || lpad(g::text, 12, '0'))::uuid, 'Example Wing ' || g,
       'a0477000-example-wing-' || g, 'optional'
  from generate_series(1, 5) g;
insert into auth.users (id, email, raw_user_meta_data)
select ('a0477000-0000-0000-000a-' || lpad(g::text, 12, '0'))::uuid, 'wing-' || g || '@example.com',
       jsonb_build_object('full_name', 'Briefing Wing ' || g)
  from generate_series(1, 4) g;
select pg_temp.role_row(:w2, gen_random_uuid(), :p1, 'viewer', 'admin', pg_temp.d(9), :ownerA, 'authenticated');
select pg_temp.invite(:w1, :p1, 'admin', pg_temp.d(9) + interval '1 second');
select pg_temp.role_row(:w3, gen_random_uuid(), :p2, 'viewer', 'admin', pg_temp.d(9), null, 'service_role');
select pg_temp.invite(:w3, :p2, 'admin', pg_temp.d(9));
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:w4, :p3, 'admin', now() - interval '168 hours'),
  (:w5, :p4, 'admin', now() - interval '168 hours' - interval '1 microsecond');
-- Read both ways: the read of all organizations holds both organizations'
-- rows at once, the detail one organization's.
select is(
  (select array[pg_temp.org_of(c.j, :w1), pg_temp.org_of(c.j, :w2), pg_temp.week(:w1), pg_temp.week(:w2)]
     from (select public.platform_security_briefing_changes() as j) c),
  array[null::jsonb, pg_temp.counts(:w2, 1, 0, 0, 0, 0, 0, 1),
        pg_temp.counts(:w1, 0, 0, 0, 0, 0, 0, 0), pg_temp.counts(:w2, 1, 0, 0, 0, 0, 0, 1)],
  '0477/104: an invitation accepted in one organization sets nothing aside in another: the same person, the same UTC day, the same role, the acceptance a second after the role change, and only the organization differs; the promotion counts where it was made, in the read of all organizations (which does not list the other) and in the detail');
select is(pg_temp.week(:w3), pg_temp.counts(:w3, 0, 0, 0, 0, 0, 0, 0),
  '0477/105: a role change and the acceptance at the very same time are the acceptance seen twice (the acceptance is not earlier): not counted');
select is(
  array[pg_temp.week(:w4), pg_temp.week(:w5)],
  array[pg_temp.counts(:w4, 0, 0, 0, 0, 0, 0, 1), pg_temp.counts(:w5, 0, 0, 0, 0, 0, 0, 0)],
  '0477/106: an admin who joined exactly 168 hours ago is an admin added this week; one who joined a microsecond before that is not');
rollback to savepoint week_edges;

-- After the savepoints the database is as the fixtures left it.
select is(
  array[public.platform_security_briefing_members(), public.platform_security_briefing_events(),
        public.platform_security_briefing_changes(), public.platform_security_briefing_for_organization(:orgA)],
  (select array[ans.members, ans.events, ans.changes, ans.da] from ans),
  '0477/107: with the savepoints undone the four answers are what they were (the functions keep nothing between calls)');

select * from finish();
rollback;
