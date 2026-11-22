-- supabase/tests/0475_passkeys.test.sql
-- Proves migration 0475: public.member_passkeys, public.passkey_bridges,
-- public.passkey_challenges, public.organization_passkey_switches, the two
-- switches platform_settings.passkeys_on and passkey_adds_on, and the
-- fifteen functions.
--
-- WHAT IS WORTH PINNING
--   1. Shape: exactly the designed columns (no device model, no attestation,
--      no plain secret); the only foreign keys are three to user_profiles and
--      one to organizations, all cascading (none into auth, none on
--      factor_id or session_id); RLS on with no policy; the indexes; every
--      CHECK refuses a bad row even when the table's owner writes it, by its
--      own name (a public key sent as text, a name with a dot). Both switches
--      are off by default.
--   2. Privileges: no role but service_role has anything on any table (every
--      grantee listed, not three named roles); service_role reads all four,
--      updates only a use and a name on member_passkeys, and inserts and
--      deletes only switch rows; each function has exactly one grant, and
--      the private check none; a caller without EXECUTE is refused by the
--      grant, by name (a member cannot spend a recovery code through the
--      function that removes passkeys). The two switches: platform_settings
--      has row security on and no policy, and a member and a signed-out
--      caller really can neither read nor change its row.
--   3. The member's read: their own active passkeys, newest first, at most
--      20, with no key material; nobody signed in and a disabled account are
--      refused; an account with a verified factor reads only with the second
--      step.
--   4. passkey_add_allowed: every reason, both switches, with act-as seats
--      and invitations counting for nothing.
--   5. passkey_register: both rows in one transaction; the rule re-checked
--      inside it; the bridge row inserted only when there is none (never
--      overwritten), and only for a reserved-name TOTP factor of the same
--      account; a refused call leaves nothing.
--   6. Challenges: issued for 2 minutes by the database clock; spent once,
--      only when all five bindings match and it has not ended, and never
--      while the kill switch is off; the account's spent and ended ones
--      cleaned at issue; 10 live at most (one call after another).
--   7. Removal and the bridge: one passkey; the last one takes the bridge
--      row in the same call, and a call that removed nothing never does; all
--      of them (support); compare and swap, only to a factor of ours, never a
--      verified bridge for an unverified one, and the same factor with a new
--      key version; compare and delete, refused while a passkey is active.
--      The account lock that replace and drop take, read from the profile
--      row's lock record (a single session can show that the call locked the
--      row and in which mode; scripts/db-concurrency/0475_passkey_races.sh
--      shows what a second session does meanwhile).
--   8. A recovery code: spent and every passkey and the bridge row removed
--      together, only when the code is the account's and unspent.
--   9. The health list: each unhealthy state, a healthy account left out; a
--      removal not finished told from a factor made after the newest removal
--      (a restore), at the edge; the facts that tell apart the cases one word
--      covers; the sessions held by a bridge factor, with the time each last
--      answered a TOTP factor (Auth's own method row); ending one such
--      session, only when its second step is held by the account's recorded
--      bridge at aal2 (every other session refused, by name), with its
--      refresh tokens, method rows and name, and nothing else.
--  10. The purge: the 1-day and 90-day edges, an unfinished removal kept (a
--      bridge row, or a verified reserved-name factor), oldest first, 5,000 a
--      call.
--  11. The cascade from user_profiles and organizations.
--  12. What a later edit must not lose; the audit vocabulary unchanged.
--
-- now() is fixed for the whole transaction and every function uses it, so
-- every time below is computed from now() and no assertion depends on the
-- clock. Namespace a0475000. Every value is made up (no real name). Wrapped in
-- begin/rollback: nothing leaks. Run via `supabase test db` after
-- `supabase db reset`.

begin;

select plan(221);

\set orgA '\'a0475000-0000-0000-0000-0000000000a1\''
\set orgB '\'a0475000-0000-0000-0000-0000000000b1\''
\set orgD '\'a0475000-0000-0000-0000-0000000000d1\''
\set m1 '\'a0475000-0000-0000-0000-0000000000c1\''
\set m2 '\'a0475000-0000-0000-0000-0000000000c2\''
\set twoOrg '\'a0475000-0000-0000-0000-0000000000c3\''
\set actasB '\'a0475000-0000-0000-0000-0000000000c4\''
\set invitedB '\'a0475000-0000-0000-0000-0000000000c5\''
\set outsider '\'a0475000-0000-0000-0000-0000000000c6\''
\set disabled '\'a0475000-0000-0000-0000-0000000000c7\''
\set full '\'a0475000-0000-0000-0000-0000000000c8\''
\set factorUser '\'a0475000-0000-0000-0000-0000000000c9\''
\set unverified '\'a0475000-0000-0000-0000-0000000000ca\''
\set many '\'a0475000-0000-0000-0000-0000000000cb\''
\set purger '\'a0475000-0000-0000-0000-0000000000cc\''
\set recov '\'a0475000-0000-0000-0000-0000000000cd\''
\set lockR '\'a0475000-0000-0000-0000-0000000000ce\''
\set lockD '\'a0475000-0000-0000-0000-0000000000cf\''
\set s1 '\'a0475000-0000-0000-0000-0000000005e1\''
\set s2 '\'a0475000-0000-0000-0000-0000000005e2\''
\set f1 '\'a0475000-0000-0000-0000-00000000f001\''
\set f2 '\'a0475000-0000-0000-0000-00000000f002\''
\set f3 '\'a0475000-0000-0000-0000-00000000f003\''
\set f121 '\'a0475000-0000-0000-0000-00000000f121\''
\set m1app '\'a0475000-0000-0000-0000-00000000f1a0\''
\set m1web '\'a0475000-0000-0000-0000-00000000f1b0\''
\set fr1 '\'a0475000-0000-0000-0000-00000000f0d1\''
\set f4 '\'a0475000-0000-0000-0000-00000000f004\''
\set fLR '\'a0475000-0000-0000-0000-00000000fce0\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:m1,         'a-m1-passkeys@test.local',         '{"full_name": "Passkey Member One"}'::jsonb),
  (:m2,         'a-m2-passkeys@test.local',         '{"full_name": "Passkey Member Two"}'::jsonb),
  (:twoOrg,     'ab-member-passkeys@test.local',    '{"full_name": "Passkey Member AB"}'::jsonb),
  (:actasB,     'a-actas-b-passkeys@test.local',    '{"full_name": "Passkey Act As B"}'::jsonb),
  (:invitedB,   'a-invited-b-passkeys@test.local',  '{"full_name": "Passkey Invited B"}'::jsonb),
  (:outsider,   'outsider-passkeys@test.local',     '{"full_name": "Passkey Outsider"}'::jsonb),
  (:disabled,   'a-disabled-passkeys@test.local',   '{"full_name": "Passkey Disabled"}'::jsonb),
  (:full,       'a-full-passkeys@test.local',       '{"full_name": "Passkey Full"}'::jsonb),
  (:factorUser, 'a-factor-passkeys@test.local',     '{"full_name": "Passkey Factor"}'::jsonb),
  (:unverified, 'a-unverified-passkeys@test.local', '{"full_name": "Passkey Unverified"}'::jsonb),
  (:many,       'a-many-passkeys@test.local',       '{"full_name": "Passkey Many"}'::jsonb),
  (:purger,     'a-purge-passkeys@test.local',      '{"full_name": "Passkey Purge"}'::jsonb),
  (:recov,      'a-recovery-passkeys@test.local',   '{"full_name": "Passkey Recovery"}'::jsonb),
  (:lockR,      'a-lock-r-passkeys@test.local',     '{"full_name": "Passkey Lock R"}'::jsonb),
  (:lockD,      'a-lock-d-passkeys@test.local',     '{"full_name": "Passkey Lock D"}'::jsonb);
-- The health list's accounts, e1 to ee.
insert into auth.users (id, email, raw_user_meta_data)
select ('a0475000-0000-0000-0000-0000000000' || x)::uuid, 'a-state-' || x || '-passkeys@test.local',
       jsonb_build_object('full_name', 'Passkey State ' || x)
  from unnest(array['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'ea', 'eb', 'ec', 'ed', 'ee']) x;
update public.user_profiles set disabled_at = now() where id = :disabled;

-- A has passkeys on, B does not; D exists only for the cascade.
insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Passkeys Org A', 'a0475000-org-a', 'optional'),
  (:orgB, 'Passkeys Org B', 'a0475000-org-b', 'optional'),
  (:orgD, 'Passkeys Org D', 'a0475000-org-d', 'optional');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :m1,         'staff', now(), null),
  (:orgA, :m2,         'staff', now(), null),
  (:orgA, :twoOrg,     'staff', now(), null),
  (:orgB, :twoOrg,     'staff', now(), null),
  (:orgA, :actasB,     'staff', now(), null),
  -- A live act-as seat in B: not a membership here.
  (:orgB, :actasB,     'owner', now(), now() + interval '1 hour'),
  (:orgA, :invitedB,   'staff', now(), null),
  -- An invitation to B not accepted: not a membership here.
  (:orgB, :invitedB,   'admin', null,  null),
  (:orgA, :disabled,   'staff', now(), null),
  (:orgA, :full,       'staff', now(), null),
  (:orgA, :factorUser, 'staff', now(), null),
  (:orgA, :unverified, 'staff', now(), null),
  (:orgA, :many,       'staff', now(), null),
  (:orgA, :purger,     'staff', now(), null),
  (:orgA, :recov,      'staff', now(), null);

-- Made-up key material: a 77-byte "public key", base64url-shaped ids of 22
-- characters (16 bytes, the floor).
create function pg_temp.key() returns bytea language sql as $$ select decode(repeat('a5', 77), 'hex') $$;
create function pg_temp.cred(n integer) returns text language sql as $$
  select 'cred-0475_' || lpad(n::text, 12, '0') $$;
create function pg_temp.ct(n integer) returns text language sql as $$
  select 'v1.' || repeat('I', 16) || '.' || 'C' || lpad(n::text, 42, '0') || '.' || repeat('T', 22) $$;
create function pg_temp.ch(n integer) returns text language sql as $$
  select 'h' || lpad(n::text, 42, '0') $$;
create function pg_temp.bind(n integer) returns text language sql as $$
  select encode(sha256(convert_to('0475-binding-' || n, 'UTF8')), 'hex') $$;
-- A factor at Supabase Auth: by default a TOTP factor with the reserved
-- bridge name (unique per account, as Auth requires of a name), made now.
create function pg_temp.factor(p_user uuid, p_id uuid, p_status text, p_type text default 'totp', p_name text default null,
                               p_created timestamptz default now())
returns uuid language sql as $$
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (p_id, p_user, coalesce(p_name, 'sp-passkey-bridge-' || replace(p_id::text, '-', '')),
          p_type::auth.factor_type, p_status::auth.factor_status, p_created, p_created)
  returning id $$;
-- The hash a recovery code is stored under (0103's canonical form).
create function pg_temp.code_hash(p text) returns text language sql as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- A direct insert as the table's owner, for the CHECK constraints. Every
-- field has a valid default, so a refusal names the field under test.
create function pg_temp.pk(p jsonb) returns uuid language sql as $$
  insert into public.member_passkeys
    (user_id, credential_id, public_key, counter, transports, backup_eligible, backed_up,
     user_verified_at_registration, rp_id, name, created_at, last_used_at, removed_at, removed_reason)
  values
    (coalesce((p ->> 'user_id')::uuid, 'a0475000-0000-0000-0000-0000000000c6'),
     coalesce(p ->> 'credential_id', 'cred-0475-' || gen_random_uuid()::text),
     coalesce(decode(p ->> 'public_key_hex', 'hex'), decode(repeat('a5', 77), 'hex')),
     coalesce((p ->> 'counter')::bigint, 0),
     coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'transports') x), '{}'::text[]),
     coalesce((p ->> 'backup_eligible')::boolean, true),
     coalesce((p ->> 'backed_up')::boolean, false),
     coalesce((p ->> 'uv')::boolean, true),
     coalesce(p ->> 'rp_id', 'stockpilotusa.com'),
     coalesce(p ->> 'name', 'Work laptop'),
     coalesce((p ->> 'created_at')::timestamptz, now()),
     (p ->> 'last_used_at')::timestamptz,
     (p ->> 'removed_at')::timestamptz,
     p ->> 'removed_reason')
  returning id;
$$;

-- Runs a statement and undoes it: 'accepted', or the SQLSTATE, the
-- constraint's name when there is one, else the message and the hint.
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_msg   text;
  v_hint  text;
  v_c     text;
begin
  begin
    execute p_sql;
    raise exception 'accepted' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_c = constraint_name;
    if v_state = 'P0001' and v_msg = 'accepted' then
      return 'accepted';
    end if;
    if nullif(v_c, '') is not null then
      return v_state || ':' || v_c;
    end if;
    return v_state || ':' || v_msg || coalesce(':' || nullif(v_hint, ''), '');
  end;
end;
$$;

create function pg_temp.try_pk(p jsonb) returns text language sql as $$
  select pg_temp.try(format('select pg_temp.pk(%L::jsonb)', p::text)) $$;

create function pg_temp.try_bridge(p jsonb) returns text language sql as $$
  select pg_temp.try(format(
    'insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version) values (%L, %L, %L, %s)',
    coalesce(p ->> 'user_id', 'a0475000-0000-0000-0000-0000000000c6'),
    coalesce(p ->> 'factor_id', 'a0475000-0000-0000-0000-00000000f0ff'),
    coalesce(p ->> 'secret_ciphertext', 'v1.' || repeat('I', 16) || '.' || repeat('C', 43) || '.' || repeat('T', 22)),
    coalesce(p ->> 'key_version', '1'))) $$;

create function pg_temp.try_challenge(p jsonb) returns text language sql as $$
  select pg_temp.try(format(
    'insert into public.passkey_challenges (user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at, used_at) values (%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    'a0475000-0000-0000-0000-0000000000c6',
    'a0475000-0000-0000-0000-0000000005e9',
    coalesce(p ->> 'purpose', 'second_step'),
    coalesce(p ->> 'challenge', 'z' || repeat('0', 42)),
    coalesce(p ->> 'binding_hash', repeat('b', 64)),
    coalesce(p ->> 'rp_id', 'stockpilotusa.com'),
    coalesce(p ->> 'created_at', now()::text),
    coalesce(p ->> 'expires_at', (now() + interval '2 minutes')::text),
    p ->> 'used_at')) $$;

-- A registration through the function, as text for pg_temp.try.
create function pg_temp.reg(p_user text, p_cred integer, p_name text, p_factor text, p_ct integer) returns text
language sql as $$
  select format('select public.passkey_register(%L, %L, %L::bytea, 0, null, true, true, %L, %L, %s, %s, %s)',
                p_user, pg_temp.cred(p_cred), pg_temp.key(), p_name, 'stockpilotusa.com',
                coalesce(quote_literal(p_factor), 'null'),
                case when p_ct is null then 'null' else quote_literal(pg_temp.ct(p_ct)) end,
                case when p_ct is null then 'null' else '1::smallint' end) $$;

-- Every grant on a function other than its owner's, as role:privilege.
create function pg_temp.grants_of(p regprocedure) returns text[] language sql as $$
  select coalesce(array_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                            || ':' || x.privilege_type order by 1), '{}'::text[])
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
   where pr.oid = p and x.grantee <> pr.proowner;
$$;
-- Every grant on a table other than its owner's, to any grantee (PUBLIC
-- included), table-wide as role:privilege and per column as
-- role:privilege(column).
create function pg_temp.table_grants_of(p regclass) returns text[] language sql as $$
  select coalesce(array_agg(g order by g collate "C"), '{}'::text[]) from (
    select case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end || ':' || x.privilege_type as g
      from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
     where c.oid = p and x.grantee <> c.relowner
    union all
    select case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end || ':' || x.privilege_type
           || '(' || a.attname || ')'
      from pg_attribute a join pg_class c on c.oid = a.attrelid, aclexplode(a.attacl) x
     where a.attrelid = p and a.attnum > 0 and a.attacl is not null and x.grantee <> c.relowner) t;
$$;
-- The row lock this transaction (not a subtransaction) holds on a profile
-- row, as Postgres's mode word. The accounts it is used for were given their
-- rows in a released savepoint, so the row already carries that
-- subtransaction's KEY SHARE lock (from the foreign key); a lock the
-- transaction itself then takes turns the row's lock record into a list of
-- both, which pg_get_multixact_members reads. 'no new lock' when the record
-- did not change.
create function pg_temp.profile_lock_mode(p_user uuid, p_before text) returns text language plpgsql as $$
declare
  v xid;
begin
  select up.xmax into v from public.user_profiles up where up.id = p_user;
  if v::text = p_before then
    return 'no new lock';
  end if;
  return coalesce((select string_agg(m.mode, ',' order by m.mode)
                     from pg_get_multixact_members(v) m
                    where m.xid::text = (txid_current() % 4294967296)::text), 'none');
end;
$$;

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select has_table('public', 'member_passkeys', '0475/1: member_passkeys exists');
select has_table('public', 'passkey_bridges', '0475/2: passkey_bridges exists');
select has_table('public', 'passkey_challenges', '0475/3: passkey_challenges exists');
select has_table('public', 'organization_passkey_switches', '0475/4: organization_passkey_switches exists');
select columns_are('public', 'member_passkeys',
  array['id', 'user_id', 'credential_id', 'public_key', 'counter', 'transports', 'backup_eligible',
        'backed_up', 'user_verified_at_registration', 'rp_id', 'name', 'created_at', 'last_used_at',
        'removed_at', 'removed_reason'],
  '0475/5: member_passkeys has exactly the designed columns: no device model (AAGUID), no attestation');
select columns_are('public', 'passkey_bridges',
  array['user_id', 'factor_id', 'secret_ciphertext', 'key_version', 'created_at'],
  '0475/6: passkey_bridges has exactly the designed columns: the secret only as ciphertext, with its key version');
select columns_are('public', 'passkey_challenges',
  array['id', 'user_id', 'session_id', 'purpose', 'challenge', 'binding_hash', 'rp_id', 'created_at',
        'expires_at', 'used_at'],
  '0475/7: passkey_challenges has exactly the designed columns');
select columns_are('public', 'organization_passkey_switches',
  array['organization_id', 'switched_on_at'],
  '0475/8: organization_passkey_switches has exactly the designed columns');
select is(
  (select array_agg(c.conrelid::regclass::text || '.' || a.attname || '>' || c.confrelid::regclass::text
                    || '(' || r.attname || '):' || c.confdeltype::text
                    order by c.conrelid::regclass::text)
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     join pg_attribute r on r.attrelid = c.confrelid and r.attnum = c.confkey[1]
    where c.contype = 'f'
      and c.conrelid in ('public.member_passkeys'::regclass, 'public.passkey_bridges'::regclass,
                         'public.passkey_challenges'::regclass, 'public.organization_passkey_switches'::regclass)),
  array['member_passkeys.user_id>user_profiles(id):c',
        'organization_passkey_switches.organization_id>organizations(id):c',
        'passkey_bridges.user_id>user_profiles(id):c',
        'passkey_challenges.user_id>user_profiles(id):c'],
  '0475/9: the only foreign keys are user_id to user_profiles(id) and organization_id to organizations(id), all cascading (none on factor_id or session_id)');
select is(
  (select count(*)::int from pg_constraint c
    where c.contype = 'f'
      and c.conrelid in ('public.member_passkeys'::regclass, 'public.passkey_bridges'::regclass,
                         'public.passkey_challenges'::regclass, 'public.organization_passkey_switches'::regclass)
      and c.confrelid in (select k.oid from pg_class k where k.relnamespace = 'auth'::regnamespace)),
  0,
  '0475/10: no foreign key points at a table in the auth schema');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.member_passkeys'::regclass, 'public.passkey_bridges'::regclass,
                    'public.passkey_challenges'::regclass, 'public.organization_passkey_switches'::regclass)),
  '0475/11: RLS is enabled on all four tables');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('member_passkeys', 'passkey_bridges', 'passkey_challenges', 'organization_passkey_switches')),
  0,
  '0475/12: there is no policy on any of the four tables');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text)
     from pg_index i where i.indrelid = 'public.member_passkeys'::regclass),
  array['CREATE UNIQUE INDEX member_passkeys_credential_id_key ON public.member_passkeys USING btree (credential_id)',
        'CREATE UNIQUE INDEX member_passkeys_pkey ON public.member_passkeys USING btree (id)',
        'CREATE INDEX member_passkeys_removed_idx ON public.member_passkeys USING btree (removed_at) WHERE (removed_at IS NOT NULL)',
        'CREATE INDEX member_passkeys_user_created_idx ON public.member_passkeys USING btree (user_id, created_at DESC)'],
  '0475/13: member_passkeys is indexed by id, by credential (unique across all accounts), by account and time, and by removal time');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text)
     from pg_index i where i.indrelid = 'public.passkey_bridges'::regclass),
  array['CREATE UNIQUE INDEX passkey_bridges_factor_id_key ON public.passkey_bridges USING btree (factor_id)',
        'CREATE UNIQUE INDEX passkey_bridges_pkey ON public.passkey_bridges USING btree (user_id)'],
  '0475/14: passkey_bridges has one row per account and one per factor');
select is(
  (select array_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text)
     from pg_index i where i.indrelid = 'public.passkey_challenges'::regclass),
  array['CREATE UNIQUE INDEX passkey_challenges_challenge_key ON public.passkey_challenges USING btree (challenge)',
        'CREATE INDEX passkey_challenges_expires_idx ON public.passkey_challenges USING btree (expires_at)',
        'CREATE UNIQUE INDEX passkey_challenges_pkey ON public.passkey_challenges USING btree (id)',
        'CREATE INDEX passkey_challenges_user_created_idx ON public.passkey_challenges USING btree (user_id, created_at)'],
  '0475/15: passkey_challenges is indexed by id, by challenge (unique), by account and time, and by end');
select is(
  (select array_agg(conrelid::regclass::text || '.' || conname::text order by conrelid::regclass::text, conname)
     from pg_constraint
    where conrelid in ('public.member_passkeys'::regclass, 'public.passkey_bridges'::regclass,
                       'public.passkey_challenges'::regclass)
      and contype = 'c'),
  array['member_passkeys.member_passkeys_backup_flags', 'member_passkeys.member_passkeys_counter',
        'member_passkeys.member_passkeys_credential_id', 'member_passkeys.member_passkeys_last_used_after_added',
        'member_passkeys.member_passkeys_name', 'member_passkeys.member_passkeys_public_key',
        'member_passkeys.member_passkeys_removed_reason', 'member_passkeys.member_passkeys_removed_with_reason',
        'member_passkeys.member_passkeys_rp_id', 'member_passkeys.member_passkeys_transports',
        'member_passkeys.member_passkeys_user_verified',
        'passkey_bridges.passkey_bridges_key_version', 'passkey_bridges.passkey_bridges_secret_ciphertext',
        'passkey_challenges.passkey_challenges_binding_hash', 'passkey_challenges.passkey_challenges_challenge',
        'passkey_challenges.passkey_challenges_lifetime', 'passkey_challenges.passkey_challenges_purpose',
        'passkey_challenges.passkey_challenges_rp_id', 'passkey_challenges.passkey_challenges_used_after_created'],
  '0475/16: the nineteen CHECK constraints are there by name');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.member_passkeys'::regclass and a.attnum > 0
      and not a.attisdropped and not a.attnotnull),
  array['last_used_at', 'removed_at', 'removed_reason'],
  '0475/17: member_passkeys may leave empty only the last use and the removal');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.passkey_challenges'::regclass and a.attnum > 0
      and not a.attisdropped and not a.attnotnull),
  array['used_at'],
  '0475/18: passkey_challenges may leave empty only the time it was spent');
select is(
  (select array_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text
                    || ' ' || pg_get_expr(d.adbin, d.adrelid) order by a.attname)
     from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.platform_settings'::regclass and a.attname like 'passkey%'),
  array['passkey_adds_on boolean true false', 'passkey_check_ends_sessions boolean true false',
        'passkeys_on boolean true false'],
  '0475/19: the three platform settings (the kill switch passkeys_on, "new passkeys" passkey_adds_on, and passkey_check_ends_sessions, which lets the server''s check end a session) are booleans, required, default false (report only)');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'member_passkeys', 'anon', array[]::text[],
  '0475/20: anon has no privilege on member_passkeys');
select table_privs_are('public', 'member_passkeys', 'authenticated', array[]::text[],
  '0475/21: authenticated has no privilege on member_passkeys');
select table_privs_are('public', 'member_passkeys', 'service_role', array['SELECT'],
  '0475/22: service_role reads member_passkeys and has no table-wide write on it');
select is(
  (select array_agg(column_name::text || ':' || privilege_type::text order by column_name, privilege_type)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'member_passkeys' and grantee = 'service_role'
      and privilege_type <> 'SELECT'),
  array['backed_up:UPDATE', 'counter:UPDATE', 'last_used_at:UPDATE', 'name:UPDATE'],
  '0475/23: service_role may update only the counter, the last use, the backup flag and the name of a passkey');
select table_privs_are('public', 'passkey_bridges', 'anon', array[]::text[],
  '0475/24: anon has no privilege on passkey_bridges');
select table_privs_are('public', 'passkey_bridges', 'authenticated', array[]::text[],
  '0475/25: authenticated has no privilege on passkey_bridges');
select table_privs_are('public', 'passkey_bridges', 'service_role', array['SELECT'],
  '0475/26: service_role only reads passkey_bridges (writes go through the functions, which check the factor)');
select table_privs_are('public', 'passkey_challenges', 'anon', array[]::text[],
  '0475/27: anon has no privilege on passkey_challenges');
select table_privs_are('public', 'passkey_challenges', 'authenticated', array[]::text[],
  '0475/28: authenticated has no privilege on passkey_challenges');
select table_privs_are('public', 'passkey_challenges', 'service_role', array['SELECT'],
  '0475/29: service_role only reads passkey_challenges (writes go through the functions)');
select table_privs_are('public', 'organization_passkey_switches', 'anon', array[]::text[],
  '0475/30: anon has no privilege on organization_passkey_switches');
select table_privs_are('public', 'organization_passkey_switches', 'authenticated', array[]::text[],
  '0475/31: authenticated has no privilege on organization_passkey_switches (no customer-facing switch)');
select table_privs_are('public', 'organization_passkey_switches', 'service_role',
  array['DELETE', 'INSERT', 'SELECT'],
  '0475/32: service_role reads, inserts and deletes switch rows, and nothing else');
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in ('member_passkeys', 'passkey_bridges', 'passkey_challenges', 'organization_passkey_switches')
      and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0,
  '0475/33: no column of the four tables is granted to anon, authenticated or PUBLIC');
select is(pg_temp.table_grants_of('public.member_passkeys'),
  array['service_role:SELECT', 'service_role:UPDATE(backed_up)', 'service_role:UPDATE(counter)',
        'service_role:UPDATE(last_used_at)', 'service_role:UPDATE(name)'],
  '0475/34: every grant on member_passkeys, to any role: service_role reads it and updates four columns, nobody else has anything');
select is(pg_temp.table_grants_of('public.passkey_bridges'), array['service_role:SELECT'],
  '0475/35: every grant on passkey_bridges, to any role: service_role reads it, nobody else has anything');
select is(pg_temp.table_grants_of('public.passkey_challenges'), array['service_role:SELECT'],
  '0475/36: every grant on passkey_challenges, to any role: service_role reads it, nobody else has anything');
select is(pg_temp.table_grants_of('public.organization_passkey_switches'),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT'],
  '0475/37: every grant on organization_passkey_switches, to any role: service_role reads, inserts and deletes, nobody else has anything');
select is(pg_temp.grants_of('public.my_passkeys()'), array['authenticated:EXECUTE'],
  '0475/38: my_passkeys has one grant: EXECUTE to authenticated');
select is(
  (select array_agg(pg_temp.grants_of(p.oid)::text order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('passkey_add_allowed', 'passkey_register', 'issue_passkey_challenge',
                        'take_passkey_challenge', 'passkey_mark_removed', 'passkey_remove_all',
                        'consume_recovery_code_with_passkeys', 'passkey_replace_bridge',
                        'passkey_drop_bridge', 'passkey_account_states', 'passkey_bridge_sessions',
                        'passkey_end_bridge_session', 'purge_passkey_records')),
  array_fill('{service_role:EXECUTE}'::text, array[13]),
  '0475/39: each of the thirteen server functions has one grant: EXECUTE to service_role (the recovery code one and the session end too: never authenticated)');
select is(pg_temp.grants_of('public._passkey_bridge_factor_ok(uuid, uuid)'), '{}'::text[],
  '0475/40: the private factor check has no grant at all');
select is(
  (select array_agg(p.proname::text || ':' || l.lanname::text || ':' || p.prosecdef::text || ':'
                    || coalesce(array_to_string(p.proconfig, ','), '')
                    order by p.proname::text collate "C")
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_passkey_bridge_factor_ok', 'my_passkeys', 'passkey_add_allowed', 'passkey_register',
                        'issue_passkey_challenge', 'take_passkey_challenge', 'passkey_mark_removed',
                        'passkey_remove_all', 'consume_recovery_code_with_passkeys', 'passkey_replace_bridge',
                        'passkey_drop_bridge', 'passkey_account_states', 'passkey_bridge_sessions',
                        'passkey_end_bridge_session', 'purge_passkey_records')),
  array['_passkey_bridge_factor_ok:plpgsql:false:search_path=""',
        'consume_recovery_code_with_passkeys:plpgsql:true:search_path=""',
        'issue_passkey_challenge:plpgsql:true:search_path=""', 'my_passkeys:plpgsql:true:search_path=""',
        'passkey_account_states:plpgsql:true:search_path=""', 'passkey_add_allowed:plpgsql:true:search_path=""',
        'passkey_bridge_sessions:plpgsql:true:search_path=""', 'passkey_drop_bridge:plpgsql:true:search_path=""',
        'passkey_end_bridge_session:plpgsql:true:search_path="",lock_timeout=2s',
        'passkey_mark_removed:plpgsql:true:search_path=""', 'passkey_register:plpgsql:true:search_path=""',
        'passkey_remove_all:plpgsql:true:search_path=""', 'passkey_replace_bridge:plpgsql:true:search_path=""',
        'purge_passkey_records:plpgsql:true:search_path="",lock_timeout=2s', 'take_passkey_challenge:plpgsql:true:search_path=""'],
  '0475/41: the fifteen functions, one of each name, are plpgsql (resolved only when called, so creating them locks no table) with an empty search_path; all but the private check are SECURITY DEFINER; the purge and the session end also wait at most 2 s for a lock');

-- ── 3. Every CHECK, by name ─────────────────────────────────────────────────
select is(pg_temp.try_pk('{}'::jsonb), 'accepted', '0475/42: a valid passkey row is accepted');
select is(
  array[pg_temp.try_pk('{"credential_id": "abc"}'),
        pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 21))),
        pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 18) || 'b+d/')),
        pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 21) || '=')),
        pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 1365))),
        pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 22) || chr(10)))],
  array_fill('23514:member_passkeys_credential_id'::text, array[6]),
  '0475/43: a credential id is base64url without padding, 22 to 1364 characters (16 to 1023 bytes): too short, 15 bytes, other characters, padded, too long and a line break are refused');
select is(
  array[pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 22))),
        pg_temp.try_pk(jsonb_build_object('credential_id', repeat('A', 1364)))],
  array['accepted', 'accepted'],
  '0475/44: 22 characters (16 bytes) and 1364 characters (1023 bytes) are accepted');
select is(
  array[pg_temp.try_pk(jsonb_build_object('public_key_hex', 'a5' || repeat('00', 30))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', 'a5' || repeat('00', 2048))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', 'a5' || repeat('00', 31))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', 'a5' || repeat('00', 2047)))],
  array['23514:member_passkeys_public_key', '23514:member_passkeys_public_key', 'accepted', 'accepted'],
  '0475/45: a public key is 32 to 2048 bytes');
select is(
  array[pg_temp.try_pk(jsonb_build_object('public_key_hex', 'a0' || repeat('00', 40))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', 'bf' || repeat('00', 40))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', '9f' || repeat('00', 40))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', 'c0' || repeat('00', 40))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', repeat('00', 41))),
        -- The same key sent as base64 text, and as hex text: the bytes of the letters.
        pg_temp.try_pk(jsonb_build_object('public_key_hex', encode(convert_to('pQECAyYgASFYI' || repeat('A', 40), 'UTF8'), 'hex'))),
        pg_temp.try_pk(jsonb_build_object('public_key_hex', encode(convert_to('a5' || repeat('0', 80), 'UTF8'), 'hex')))],
  array['accepted', 'accepted', '23514:member_passkeys_public_key', '23514:member_passkeys_public_key',
        '23514:member_passkeys_public_key', '23514:member_passkeys_public_key', '23514:member_passkeys_public_key'],
  '0475/46: a public key opens a CBOR map (first byte 0xA0 to 0xBF), as every COSE key does: other first bytes, and a key sent as base64 or hex text, are refused');
select is(
  array[pg_temp.try_pk('{"counter": -1}'), pg_temp.try_pk('{"counter": 4294967296}'),
        pg_temp.try_pk('{"counter": 4294967295}')],
  array['23514:member_passkeys_counter', '23514:member_passkeys_counter', 'accepted'],
  '0475/47: a counter is 0 to 4294967295');
select is(
  array[pg_temp.try_pk('{"transports": ["internal", "bluetooth"]}'),
        pg_temp.try_pk('{"transports": ["INTERNAL"]}'),
        pg_temp.try_pk('{"transports": ["usb", "usb", "usb", "usb", "usb", "usb", "usb", "usb"]}'),
        pg_temp.try_pk('{"transports": ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]}')],
  array['23514:member_passkeys_transports', '23514:member_passkeys_transports',
        '23514:member_passkeys_transports', 'accepted'],
  '0475/48: transports come from WebAuthn''s seven words, at most seven');
select is(
  array[pg_temp.try_pk('{"backup_eligible": false, "backed_up": true}'),
        pg_temp.try_pk('{"backup_eligible": true, "backed_up": true}')],
  array['23514:member_passkeys_backup_flags', 'accepted'],
  '0475/49: a passkey backed up is one that can be');
select is(pg_temp.try_pk('{"uv": false}'), '23514:member_passkeys_user_verified',
  '0475/50: a passkey whose device did not check it was the member cannot be stored');
select is(
  array[pg_temp.try_pk('{"rp_id": "StockPilotUSA.com"}'),
        pg_temp.try_pk('{"rp_id": "https://stockpilotusa.com"}'),
        pg_temp.try_pk('{"rp_id": ""}'),
        pg_temp.try_pk('{"rp_id": "localhost"}')],
  array['23514:member_passkeys_rp_id', '23514:member_passkeys_rp_id', '23514:member_passkeys_rp_id', 'accepted'],
  '0475/51: the site is a lower-case host name, not an origin');
select is(
  array[pg_temp.try_pk('{"name": ""}'),
        pg_temp.try_pk(jsonb_build_object('name', repeat('n', 61))),
        pg_temp.try_pk('{"name": " Work laptop"}'),
        pg_temp.try_pk('{"name": "Work laptop "}'),
        pg_temp.try_pk('{"name": "<b>laptop</b>"}'),
        pg_temp.try_pk('{"name": "https://example.test"}'),
        pg_temp.try_pk(jsonb_build_object('name', 'Work' || chr(10) || 'laptop')),
        pg_temp.try_pk(jsonb_build_object('name', 'Work laptop' || chr(10))),
        pg_temp.try_pk(jsonb_build_object('name', 'Work' || chr(8203) || 'laptop')),
        pg_temp.try_pk(jsonb_build_object('name', 'Work ' || chr(8238) || 'laptop')),
        pg_temp.try_pk(jsonb_build_object('name', 'Caf' || chr(233))),
        pg_temp.try_pk('{"name": "Open example.test now"}'),
        pg_temp.try_pk('{"name": "Sample phone 2.0"}'),
        pg_temp.try_pk('{"name": "Sample phone."}')],
  array_fill('23514:member_passkeys_name'::text, array[14]),
  '0475/52: a name is 1 to 60 of letters, digits, spaces and ( ) + '' _ -, with no space at either end: empty, too long, padded, markup, a link, line breaks, invisible and other-script characters refused, and any dot (so no site name rides in it)');
select is(
  array[pg_temp.try_pk(jsonb_build_object('name', repeat('n', 60))),
        pg_temp.try_pk('{"name": "Sample phone (work) - 2"}'),
        pg_temp.try_pk('{"name": "Front desk''s key"}'),
        pg_temp.try_pk('{"name": "Security key 5C_NFC+"}')],
  array['accepted', 'accepted', 'accepted', 'accepted'],
  '0475/53: ordinary names are accepted, an apostrophe included');
select is(
  array[pg_temp.try_pk(jsonb_build_object('removed_at', now()::text)),
        pg_temp.try_pk('{"removed_reason": "member"}'),
        pg_temp.try_pk(jsonb_build_object('removed_at', now()::text, 'removed_reason', 'admin')),
        pg_temp.try_pk(jsonb_build_object('removed_at', now()::text, 'removed_reason', 'member')),
        pg_temp.try_pk(jsonb_build_object('removed_at', now()::text, 'removed_reason', 'recovery_code')),
        pg_temp.try_pk(jsonb_build_object('removed_at', now()::text, 'removed_reason', 'setup_failed')),
        pg_temp.try_pk(jsonb_build_object('removed_at', now()::text, 'removed_reason', 'support'))],
  array['23514:member_passkeys_removed_with_reason', '23514:member_passkeys_removed_with_reason',
        '23514:member_passkeys_removed_reason', 'accepted', 'accepted', 'accepted', 'accepted'],
  '0475/54: a removal has its reason, from member, recovery_code, setup_failed and support (no organization admin reset)');
select is(
  pg_temp.try_pk(jsonb_build_object('created_at', now()::text, 'last_used_at', (now() - interval '1 second')::text)),
  '23514:member_passkeys_last_used_after_added',
  '0475/55: a passkey is not used before it was added');
select is(
  array[pg_temp.try_bridge('{"user_id": "a0475000-0000-0000-0000-0000000000c6"}'),
        pg_temp.try_bridge('{"secret_ciphertext": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"}'),
        pg_temp.try_bridge(jsonb_build_object('secret_ciphertext', 'v2.' || repeat('I', 16) || '.' || repeat('C', 43) || '.' || repeat('T', 22))),
        pg_temp.try_bridge(jsonb_build_object('secret_ciphertext', 'v1.' || repeat('I', 15) || '.' || repeat('C', 43) || '.' || repeat('T', 22))),
        pg_temp.try_bridge(jsonb_build_object('secret_ciphertext', 'v1.' || repeat('I', 16) || '.' || repeat('C', 43) || '.' || repeat('T', 21))),
        pg_temp.try_bridge(jsonb_build_object('secret_ciphertext', 'v1.' || repeat('I', 16) || '.' || repeat('C', 43) || '.' || repeat('T', 22) || chr(10))),
        pg_temp.try_bridge('{"key_version": "0"}')],
  array['accepted', '23514:passkey_bridges_secret_ciphertext', '23514:passkey_bridges_secret_ciphertext',
        '23514:passkey_bridges_secret_ciphertext', '23514:passkey_bridges_secret_ciphertext',
        '23514:passkey_bridges_secret_ciphertext', '23514:passkey_bridges_key_version'],
  '0475/56: a bridge secret is stored only as v<key version>.<12-byte iv>.<ciphertext>.<16-byte tag> with its own key version: a plain base32 secret, another version''s prefix, a short iv or tag and a line break are refused');
select is(
  array[pg_temp.try_challenge('{}'),
        pg_temp.try_challenge('{"purpose": "step_up"}'),
        pg_temp.try_challenge('{"purpose": "delete_account"}'),
        pg_temp.try_challenge(jsonb_build_object('challenge', repeat('z', 42))),
        pg_temp.try_challenge(jsonb_build_object('challenge', repeat('z', 42) || '=')),
        pg_temp.try_challenge(jsonb_build_object('binding_hash', repeat('B', 64))),
        pg_temp.try_challenge(jsonb_build_object('binding_hash', repeat('b', 63))),
        pg_temp.try_challenge('{"rp_id": "https://stockpilotusa.com"}')],
  array['accepted', '23514:passkey_challenges_purpose', '23514:passkey_challenges_purpose',
        '23514:passkey_challenges_challenge', '23514:passkey_challenges_challenge',
        '23514:passkey_challenges_binding_hash', '23514:passkey_challenges_binding_hash',
        '23514:passkey_challenges_rp_id'],
  '0475/57: a challenge has one of the five purposes, 32 bytes in base64url, a 64-hex-digit binding and a host name');
select is(
  array[pg_temp.try_challenge(jsonb_build_object('expires_at', now()::text)),
        pg_temp.try_challenge(jsonb_build_object('expires_at', (now() + interval '5 minutes 1 microsecond')::text)),
        pg_temp.try_challenge(jsonb_build_object('expires_at', (now() + interval '5 minutes')::text)),
        pg_temp.try_challenge(jsonb_build_object('used_at', (now() - interval '1 second')::text)),
        pg_temp.try_challenge('{"purpose": "second_step"}'), pg_temp.try_challenge('{"purpose": "password_reset"}'),
        pg_temp.try_challenge('{"purpose": "register"}'), pg_temp.try_challenge('{"purpose": "confirm_add"}'),
        pg_temp.try_challenge('{"purpose": "finish_setup"}')],
  array['23514:passkey_challenges_lifetime', '23514:passkey_challenges_lifetime', 'accepted',
        '23514:passkey_challenges_used_after_created', 'accepted', 'accepted', 'accepted', 'accepted', 'accepted'],
  '0475/58: a challenge ends after it starts and at most 5 minutes later, and is not spent before it starts; each of the five purposes is accepted');

-- ── 4. The member's own passkeys ────────────────────────────────────────────
-- m1: two active (an hour ago, a day ago) and one removed; m2: one active.
insert into public.member_passkeys
  (id, user_id, credential_id, public_key, counter, transports, backup_eligible, backed_up,
   user_verified_at_registration, rp_id, name, created_at, last_used_at, removed_at, removed_reason)
values
  ('a0475000-0000-0000-0000-000000000101', :m1, pg_temp.cred(101), pg_temp.key(), 0, array['internal', 'hybrid'],
     true, true, true, 'stockpilotusa.com', 'Work laptop', now() - interval '1 hour', now() - interval '5 minutes', null, null),
  ('a0475000-0000-0000-0000-000000000102', :m1, pg_temp.cred(102), pg_temp.key(), 7, array['usb', 'nfc'],
     false, false, true, 'stockpilotusa.com', 'YubiKey', now() - interval '1 day', null, null, null),
  ('a0475000-0000-0000-0000-000000000103', :m1, pg_temp.cred(103), pg_temp.key(), 0, '{}',
     true, true, true, 'stockpilotusa.com', 'Old phone', now() - interval '2 days', null, now() - interval '1 day', 'member'),
  ('a0475000-0000-0000-0000-000000000201', :m2, pg_temp.cred(201), pg_temp.key(), 0, array['internal'],
     true, true, true, 'stockpilotusa.com', 'Office Mac', now() - interval '3 hours', null, null, null),
  ('a0475000-0000-0000-0000-000000000701', :disabled, pg_temp.cred(701), pg_temp.key(), 0, '{}',
     true, true, true, 'stockpilotusa.com', 'Disabled laptop', now() - interval '3 hours', null, null, null),
  ('a0475000-0000-0000-0000-000000000901', :factorUser, pg_temp.cred(901), pg_temp.key(), 0, '{}',
     true, true, true, 'stockpilotusa.com', 'Factor laptop', now() - interval '3 hours', null, null, null),
  ('a0475000-0000-0000-0000-000000000a01', :unverified, pg_temp.cred(1001), pg_temp.key(), 0, '{}',
     true, true, true, 'stockpilotusa.com', 'Unverified laptop', now() - interval '3 hours', null, null, null);
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name, created_at)
select :many, pg_temp.cred(2000 + g), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Many ' || g,
       now() - make_interval(mins => g)
  from generate_series(1, 25) g;
-- The member's own authenticator apps (not bridges).
select pg_temp.factor(:factorUser, 'a0475000-0000-0000-0000-00000000f9a0', 'verified', 'totp', '0475 authenticator');
select pg_temp.factor(:unverified, 'a0475000-0000-0000-0000-00000000faa0', 'unverified', 'totp', '0475 authenticator');

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c1', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select results_eq(
  $$ select * from public.my_passkeys() $$,
  $$ values
     ('a0475000-0000-0000-0000-000000000101'::uuid, 'Work laptop'::text, now() - interval '1 hour',
        now() - interval '5 minutes', true, true, array['internal', 'hybrid']::text[]),
     ('a0475000-0000-0000-0000-000000000102'::uuid, 'YubiKey'::text, now() - interval '1 day',
        null::timestamptz, false, false, array['usb', 'nfc']::text[]) $$,
  '0475/59: a member reads their own active passkeys, newest first, with names, times, backup flags and transports; the removed one left out');
select is(
  (select proargnames from pg_proc where oid = 'public.my_passkeys()'::regprocedure),
  array['id', 'name', 'created_at', 'last_used_at', 'backup_eligible', 'backed_up', 'transports'],
  '0475/60: the member''s read returns no credential id, public key, counter or site');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select id from public.my_passkeys() $$,
  $$ values ('a0475000-0000-0000-0000-000000000201'::uuid) $$,
  '0475/61: another member reads their own one passkey and none of the first member''s');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000cb', 'role', 'authenticated')::text, true);
select results_eq(
  $$ select created_at from public.my_passkeys() $$,
  $$ select now() - make_interval(mins => g) from generate_series(1, 20) g $$,
  '0475/62: a member with 25 rows reads the newest 20, newest first');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c6', 'role', 'authenticated')::text, true);
select is((select count(*)::int from public.my_passkeys()), 0,
  '0475/63: a member with no passkey reads none');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c7', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select throws_ok(
  $$ select * from public.my_passkeys() $$,
  '42501', 'passkeys_not_allowed',
  '0475/64: a disabled account cannot read its passkeys, even with a token that still lasts and holds the second step');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c9', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select throws_ok(
  $$ select * from public.my_passkeys() $$,
  '42501', 'aal2_required',
  '0475/65: an account with a verified authenticator reads only from a session that holds the second step');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c9', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.my_passkeys() $$,
  '42501', 'aal2_required',
  '0475/66: a token with no level counts as the first step');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c9', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select results_eq(
  $$ select id from public.my_passkeys() $$,
  $$ values ('a0475000-0000-0000-0000-000000000901'::uuid) $$,
  '0475/67: with the second step, it reads');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000ca', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select results_eq(
  $$ select id from public.my_passkeys() $$,
  $$ values ('a0475000-0000-0000-0000-000000000a01'::uuid) $$,
  '0475/68: an authenticator not yet verified owes nothing');
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
select throws_ok(
  $$ select * from public.my_passkeys() $$,
  '42501', 'passkeys_not_allowed',
  '0475/69: a token with no account is refused by the function''s own gate');
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000cd', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select throws_ok(
  $$ select public.passkey_add_allowed('a0475000-0000-0000-0000-0000000000c1') $$,
  '42501', 'permission denied for function passkey_add_allowed',
  '0475/70: a signed-in member cannot call a server function');
select throws_ok(
  $$ select * from public.consume_recovery_code_with_passkeys('a0475000-0000-0000-0000-0000000000cd', 'ABCD-1234-EF') $$,
  '42501', 'permission denied for function consume_recovery_code_with_passkeys',
  '0475/71: nor spend a recovery code through the function that removes passkeys, even for their own account with the second step');
select throws_ok(
  $$ select * from public.take_passkey_challenge(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'second_step', repeat('b', 64)) $$,
  '42501', 'permission denied for function take_passkey_challenge',
  '0475/72: nor spend a challenge');
select throws_ok(
  $$ select count(*) from public.member_passkeys $$,
  '42501', 'permission denied for table member_passkeys',
  '0475/73: nor read the passkeys table');
select throws_ok(
  $$ insert into public.organization_passkey_switches (organization_id) values ('a0475000-0000-0000-0000-0000000000b1') $$,
  '42501', 'permission denied for table organization_passkey_switches',
  '0475/74: nor switch passkeys on for an organization');
reset role;

set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select throws_ok(
  $$ select * from public.my_passkeys() $$,
  '42501', 'permission denied for function my_passkeys',
  '0475/75: a signed-out caller cannot call the member''s read: it has no EXECUTE');
reset role;

-- ── 5. passkey_add_allowed ──────────────────────────────────────────────────
-- No settings row first, then a row with both switches off, then each on.
delete from public.platform_settings;
select is(public.passkey_add_allowed(:m2), 'kill_switch_off',
  '0475/76: with no platform settings row, the kill switch is off');
insert into public.platform_settings (id, passkeys_on, passkey_adds_on) values (true, false, true);
select is(public.passkey_add_allowed(:m2), 'kill_switch_off',
  '0475/77: with the kill switch false, it is off, whatever the "new passkeys" switch says');
-- What guards the two switches: 0402 grants anon and authenticated every
-- privilege on platform_settings; row security with no policy keeps them
-- from the row. A later policy on this table would open the switches.
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.platform_settings'::regclass),
  '0475/78: platform_settings has row security on');
select is((select count(*)::int from pg_policy pol where pol.polrelid = 'public.platform_settings'::regclass), 0,
  '0475/79: platform_settings has no policy at all');
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000c2', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is((select count(*)::int from public.platform_settings), 0,
  '0475/80: a signed-in member, with the second step, reads no settings row');
with u as (update public.platform_settings
              set passkeys_on = true, passkey_adds_on = true, passkey_check_ends_sessions = true returning 1)
select is(count(*)::int, 0, '0475/81: a member''s update of the three settings changes no row') from u;
with d as (delete from public.platform_settings returning 1)
select is(count(*)::int, 0, '0475/82: a member''s delete removes no row') from d;
select throws_ok(
  $$ insert into public.platform_settings (id, passkeys_on, passkey_adds_on) values (true, true, true) $$,
  '42501', 'new row violates row-level security policy for table "platform_settings"',
  '0475/83: a member cannot insert a settings row');
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
select is((select count(*)::int from public.platform_settings), 0,
  '0475/84: a signed-out caller reads no settings row');
with u as (update public.platform_settings
              set passkeys_on = true, passkey_adds_on = true, passkey_check_ends_sessions = true returning 1)
select is(count(*)::int, 0, '0475/85: a signed-out caller''s update changes no row') from u;
select throws_ok(
  $$ insert into public.platform_settings (id, passkeys_on, passkey_adds_on) values (true, true, true) $$,
  '42501', 'new row violates row-level security policy for table "platform_settings"',
  '0475/86: a signed-out caller cannot insert a settings row');
reset role;
select is(
  (select array_agg(array[s.passkeys_on, s.passkey_adds_on, s.passkey_check_ends_sessions]::text)
     from public.platform_settings s),
  array['{f,t,f}'],
  '0475/87: the one settings row is as it was: the kill switch still off, and the check still only reports');
update public.platform_settings set passkeys_on = true, passkey_adds_on = false;
select is(public.passkey_add_allowed(:m2), 'adds_off',
  '0475/88: with the kill switch on and "new passkeys" off, no passkey may be added');
update public.platform_settings set passkey_adds_on = true;
select is(public.passkey_add_allowed(:m2), 'organization_off',
  '0475/89: both switches on, but no organization of the member has passkeys on');
insert into public.organization_passkey_switches (organization_id) values (:orgA);
select is(
  array[public.passkey_add_allowed(:m2), public.passkey_add_allowed(:twoOrg),
        public.passkey_add_allowed(:actasB), public.passkey_add_allowed(:invitedB),
        public.passkey_add_allowed(:outsider), public.passkey_add_allowed(:disabled),
        public.passkey_add_allowed('a0475000-0000-0000-0000-0000000000ff'),
        public.passkey_add_allowed(null)],
  array['ok', 'organization_off', 'ok', 'ok', 'no_membership', 'disabled', 'no_profile', 'no_profile'],
  '0475/90: A on: its member may; a member of A and B (B off) may not; an act-as seat and an invitation in B count for nothing; no membership, a disabled account and no profile may not');
update public.platform_settings set passkeys_on = false;
select is(
  array[public.passkey_add_allowed(:m2), public.passkey_add_allowed(:disabled)],
  array['kill_switch_off', 'disabled'],
  '0475/91: the kill switch off stops everyone (a disabled account is still told it is disabled first)');
update public.platform_settings set passkeys_on = true;
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name, created_at)
select :full, pg_temp.cred(3000 + g), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Full ' || g, now()
  from generate_series(1, 9) g;
select is(public.passkey_add_allowed(:full), 'ok', '0475/92: nine active passkeys: one more may be added');
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name,
   created_at, removed_at, removed_reason)
values (:full, pg_temp.cred(3100), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Removed one', now(), now(), 'member');
select is(public.passkey_add_allowed(:full), 'ok', '0475/93: a removed passkey does not count');
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name, created_at)
values (:full, pg_temp.cred(3010), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Full 10', now());
select is(public.passkey_add_allowed(:full), 'too_many', '0475/94: ten active passkeys: no more');

-- ── 6. passkey_register ─────────────────────────────────────────────────────
-- The bridge factors at Supabase Auth: three of m2, one of m1; and two
-- factors of m1 that are not bridges (its own app, and a factor of another
-- type that carries the reserved name).
select pg_temp.factor(:m2, :f1, 'verified');
select pg_temp.factor(:m2, :f2, 'verified');
select pg_temp.factor(:m2, :f3, 'verified');
select pg_temp.factor(:m1, :f121, 'verified');
select pg_temp.factor(:m1, :m1app, 'verified', 'totp', '0475 m1 app');
select pg_temp.factor(:m1, :m1web, 'verified', 'webauthn', 'sp-passkey-bridge-0475webauthn');
-- m2 already has one active passkey (201) but no bridge row: a set-up of an
-- earlier day. A first registration with a bridge stores both.
set local role service_role;
select isnt(
  public.passkey_register(:m2, pg_temp.cred(202), pg_temp.key(), 0, array['internal'], true, true,
                          'New laptop', 'stockpilotusa.com', :f1, pg_temp.ct(1), 1::smallint),
  null,
  '0475/95: service_role registers a passkey with its bridge');
reset role;
select is(
  (select array[p.user_verified_at_registration::text, p.counter::text, p.name, p.rp_id,
                array_to_string(p.transports, ','), (p.removed_at is null)::text, (p.created_at = now())::text]
     from public.member_passkeys p where p.credential_id = pg_temp.cred(202)),
  array['true', '0', 'New laptop', 'stockpilotusa.com', 'internal', 'true', 'true'],
  '0475/96: the passkey row is stored as given, user-verified, active, added now');
select is(
  (select array[b.factor_id::text, b.secret_ciphertext, b.key_version::text]
     from public.passkey_bridges b where b.user_id = :m2),
  array['a0475000-0000-0000-0000-00000000f001', pg_temp.ct(1), '1'],
  '0475/97: and the bridge row, in the same call');
select isnt(
  public.passkey_register(:m2, pg_temp.cred(203), pg_temp.key(), null, null, false, false,
                          'Security key', 'stockpilotusa.com', null, null, null),
  null,
  '0475/98: a later passkey keeps the present bridge (no bridge values given)');
select is(
  (select array[b.factor_id::text, b.secret_ciphertext,
                (select array_to_string(p.transports, ',') || '/' || p.counter
                   from public.member_passkeys p where p.credential_id = pg_temp.cred(203))]
     from public.passkey_bridges b where b.user_id = :m2),
  array['a0475000-0000-0000-0000-00000000f001', pg_temp.ct(1), '/0'],
  '0475/99: the bridge is unchanged, and a missing counter and transports are stored as 0 and none');
-- Two tabs: the second registration also brings a new bridge.
select is(
  array[pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c2', 204, 'Phone', 'a0475000-0000-0000-0000-00000000f002', 2)),
        (select count(*)::text from public.member_passkeys p where p.credential_id = pg_temp.cred(204)),
        (select b.factor_id::text || '/' || b.secret_ciphertext from public.passkey_bridges b where b.user_id = :m2)],
  array['55000:passkey_bridge_exists', '0', 'a0475000-0000-0000-0000-00000000f001/' || pg_temp.ct(1)],
  '0475/100: a registration that brings a bridge when the account has one is refused whole: no passkey row, the bridge never overwritten');
select is(
  array[pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 110, 'X', null, null)),
        pg_temp.try(format('select public.passkey_register(%L, %L, %L::bytea, 0, null, true, true, %L, %L, %L, null, null)',
                           'a0475000-0000-0000-0000-0000000000c1', pg_temp.cred(111), pg_temp.key(), 'X', 'stockpilotusa.com',
                           'a0475000-0000-0000-0000-00000000f121'))],
  array['55000:passkey_bridge_missing', '22023:passkey_bridge_incomplete'],
  '0475/101: with no bridge row, a registration must bring all three bridge values; part of them is refused');
select is(
  array[pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 112, 'X', 'a0475000-0000-0000-0000-00000000f009', 112)),
        pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 113, 'X', 'a0475000-0000-0000-0000-00000000f002', 113)),
        pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 114, 'X', 'a0475000-0000-0000-0000-00000000f1a0', 114)),
        pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 115, 'X', 'a0475000-0000-0000-0000-00000000f1b0', 115))],
  array_fill('22023:passkey_bridge_not_ours'::text, array[4]),
  '0475/102: the bridge must be a TOTP factor of the same account with the reserved name: a factor that does not exist, another account''s bridge factor, the member''s own authenticator app and a factor of another type are refused');
select is(
  array[(select count(*)::int from public.member_passkeys p where p.credential_id in (pg_temp.cred(112), pg_temp.cred(113),
                                                                                       pg_temp.cred(114), pg_temp.cred(115))),
        (select count(*)::int from public.passkey_bridges b where b.user_id = :m1)],
  array[0, 0],
  '0475/103: and those refusals left no passkey and no bridge');
select is(
  array[pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c3', 301, 'X', 'a0475000-0000-0000-0000-00000000f301', 301)),
        pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c8', 801, 'X', 'a0475000-0000-0000-0000-00000000f801', 801)),
        pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c7', 702, 'X', 'a0475000-0000-0000-0000-00000000f701', 701)),
        pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000ff', 991, 'X', 'a0475000-0000-0000-0000-00000000f991', 991)),
        pg_temp.try('select public.passkey_register(null, ''abcd'', ''\x00''::bytea, 0, null, true, true, ''X'', ''localhost'', null, null, null)')],
  array['42501:passkey_not_allowed:organization_off', '42501:passkey_not_allowed:too_many',
        '42501:passkey_not_allowed:disabled', '42501:passkey_not_allowed:no_profile',
        '42501:passkey_not_allowed:no_profile'],
  '0475/104: passkey_register re-checks the rule itself, with the reason as hint: an organization off, ten active, disabled, no profile');
update public.platform_settings set passkeys_on = false;
select is(
  pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c2', 205, 'X', null, null)),
  '42501:passkey_not_allowed:kill_switch_off',
  '0475/105: with the kill switch off nothing can be registered');
update public.platform_settings set passkeys_on = true, passkey_adds_on = false;
select is(
  pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c2', 205, 'X', null, null)),
  '42501:passkey_not_allowed:adds_off',
  '0475/106: with "new passkeys" off nothing can be registered either');
update public.platform_settings set passkey_adds_on = true;
select is(
  pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 201, 'Copy', 'a0475000-0000-0000-0000-00000000f121', 121)),
  '23505:member_passkeys_credential_id_key',
  '0475/107: a credential id stored for another account is refused');
select is(
  pg_temp.try(pg_temp.reg('a0475000-0000-0000-0000-0000000000c1', 116, '<b>x</b>', 'a0475000-0000-0000-0000-00000000f121', 121)),
  '23514:member_passkeys_name',
  '0475/108: a passkey row refused by its own rules (here the name) is refused by the table, and its bridge with it');

-- ── 7. Challenges ───────────────────────────────────────────────────────────
select set_config('t.c1',
  public.issue_passkey_challenge(:m1, :s1, 'second_step', pg_temp.ch(1), pg_temp.bind(1), 'stockpilotusa.com')::text, true);
select is(
  (select array[c.user_id::text, c.session_id::text, c.purpose, c.challenge, c.binding_hash, c.rp_id,
                (c.created_at = now())::text, (c.expires_at = now() + interval '2 minutes')::text, coalesce(c.used_at::text, 'unspent')]
     from public.passkey_challenges c where c.id = current_setting('t.c1')::uuid),
  array['a0475000-0000-0000-0000-0000000000c1', 'a0475000-0000-0000-0000-0000000005e1', 'second_step',
        pg_temp.ch(1), pg_temp.bind(1), 'stockpilotusa.com', 'true', 'true', 'unspent'],
  '0475/109: a challenge is issued for the account, session, purpose and binding, ending 2 minutes from now by the database clock');
select is(
  array[(select count(*)::int from public.take_passkey_challenge(current_setting('t.c1')::uuid, :m2, :s1, 'second_step', pg_temp.bind(1))),
        (select count(*)::int from public.take_passkey_challenge(current_setting('t.c1')::uuid, :m1, :s2, 'second_step', pg_temp.bind(1))),
        (select count(*)::int from public.take_passkey_challenge(current_setting('t.c1')::uuid, :m1, :s1, 'password_reset', pg_temp.bind(1))),
        (select count(*)::int from public.take_passkey_challenge(current_setting('t.c1')::uuid, :m1, :s1, 'second_step', pg_temp.bind(2))),
        (select count(*)::int from public.take_passkey_challenge(gen_random_uuid(), :m1, :s1, 'second_step', pg_temp.bind(1))),
        (select count(*)::int from public.take_passkey_challenge(current_setting('t.c1')::uuid, :m1, :s1, 'second_step', null))],
  array[0, 0, 0, 0, 0, 0],
  '0475/110: a challenge is not spent for another account, another session, another purpose, another browser, another id or no binding');
select is(
  (select used_at from public.passkey_challenges c where c.id = current_setting('t.c1')::uuid),
  null,
  '0475/111: and those tries left it unspent');
select results_eq(
  $$ select * from public.take_passkey_challenge(current_setting('t.c1')::uuid,
       'a0475000-0000-0000-0000-0000000000c1', 'a0475000-0000-0000-0000-0000000005e1', 'second_step',
       encode(sha256(convert_to('0475-binding-1', 'UTF8')), 'hex')) $$,
  $$ values ('h' || lpad('1', 42, '0'), 'stockpilotusa.com') $$,
  '0475/112: with all five bindings it is spent, returning its challenge and site');
select is(
  (select count(*)::int from public.take_passkey_challenge(current_setting('t.c1')::uuid, :m1, :s1, 'second_step', pg_temp.bind(1))),
  0,
  '0475/113: a spent challenge is never returned again');
select is(
  (select used_at = now() from public.passkey_challenges c where c.id = current_setting('t.c1')::uuid),
  true,
  '0475/114: it is marked spent now');
-- Ended exactly now, and ended a minute ago: neither is spent.
insert into public.passkey_challenges
  (id, user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at)
values
  ('a0475000-0000-0000-0000-000000000c02', :m1, :s1, 'register', pg_temp.ch(2), pg_temp.bind(1), 'stockpilotusa.com',
     now() - interval '2 minutes', now()),
  ('a0475000-0000-0000-0000-000000000c03', :m1, :s1, 'register', pg_temp.ch(3), pg_temp.bind(1), 'stockpilotusa.com',
     now() - interval '3 minutes', now() - interval '1 minute'),
  ('a0475000-0000-0000-0000-000000000c04', :m1, :s1, 'register', pg_temp.ch(4), pg_temp.bind(1), 'stockpilotusa.com',
     now() - interval '1 minute', now() + interval '1 microsecond');
select is(
  array[(select count(*)::int from public.take_passkey_challenge('a0475000-0000-0000-0000-000000000c02', :m1, :s1, 'register', pg_temp.bind(1))),
        (select count(*)::int from public.take_passkey_challenge('a0475000-0000-0000-0000-000000000c03', :m1, :s1, 'register', pg_temp.bind(1))),
        (select count(*)::int from public.take_passkey_challenge('a0475000-0000-0000-0000-000000000c04', :m1, :s1, 'register', pg_temp.bind(1)))],
  array[0, 0, 1],
  '0475/115: a challenge that ends now or has ended is not spent; one that ends a microsecond from now is');
-- The kill switch off: nothing is spent, whatever the bindings.
insert into public.passkey_challenges
  (id, user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at)
values ('a0475000-0000-0000-0000-000000000c05', :m1, :s1, 'second_step', pg_temp.ch(7), pg_temp.bind(1), 'stockpilotusa.com',
        now(), now() + interval '2 minutes');
update public.platform_settings set passkeys_on = false;
select is(
  pg_temp.try(format('select * from public.take_passkey_challenge(%L, %L, %L, %L, %L)',
                     'a0475000-0000-0000-0000-000000000c05', 'a0475000-0000-0000-0000-0000000000c1',
                     'a0475000-0000-0000-0000-0000000005e1', 'second_step', pg_temp.bind(1))),
  '42501:passkey_not_allowed:kill_switch_off',
  '0475/116: with the kill switch off no challenge is spent, even with all five bindings');
delete from public.platform_settings;
select is(
  pg_temp.try(format('select * from public.take_passkey_challenge(%L, %L, %L, %L, %L)',
                     'a0475000-0000-0000-0000-000000000c05', 'a0475000-0000-0000-0000-0000000000c1',
                     'a0475000-0000-0000-0000-0000000005e1', 'second_step', pg_temp.bind(1))),
  '42501:passkey_not_allowed:kill_switch_off',
  '0475/117: nor with no settings row');
insert into public.platform_settings (id, passkeys_on, passkey_adds_on) values (true, true, true);
select is(
  (select count(*)::int from public.take_passkey_challenge('a0475000-0000-0000-0000-000000000c05', :m1, :s1, 'second_step', pg_temp.bind(1))),
  1,
  '0475/118: the challenge was left unspent, and is spent once the switch is back on');
-- m2 has an older challenge; spent and ended ones are cleaned for m1 only.
insert into public.passkey_challenges
  (id, user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at)
values ('a0475000-0000-0000-0000-000000000c21', :m2, :s2, 'second_step', pg_temp.ch(21), pg_temp.bind(2), 'stockpilotusa.com',
        now() - interval '10 minutes', now() - interval '8 minutes');
select set_config('t.c5',
  public.issue_passkey_challenge(:m1, :s1, 'confirm_add', pg_temp.ch(5), pg_temp.bind(5), 'stockpilotusa.com')::text, true);
select is(
  (select array_agg(c.challenge order by c.challenge) from public.passkey_challenges c
    where c.user_id in (:m1, :m2)),
  array[pg_temp.ch(5), pg_temp.ch(21)],
  '0475/119: issuing deletes the account''s spent and ended challenges, and no other account''s');
select is(
  pg_temp.try(format('select public.issue_passkey_challenge(%L, %L, %L, %L, %L, %L)',
                     'a0475000-0000-0000-0000-0000000000c1', 'a0475000-0000-0000-0000-0000000005e1', 'second_step',
                     pg_temp.ch(5), pg_temp.bind(6), 'stockpilotusa.com')),
  '23505:passkey_challenges_challenge_key',
  '0475/120: a challenge value is never issued twice');
select is(
  array[pg_temp.try(format('select public.issue_passkey_challenge(null, %L, %L, %L, %L, %L)',
                           'a0475000-0000-0000-0000-0000000005e1', 'second_step', pg_temp.ch(6), pg_temp.bind(6), 'stockpilotusa.com')),
        pg_temp.try(format('select public.issue_passkey_challenge(%L, null, %L, %L, %L, %L)',
                           'a0475000-0000-0000-0000-0000000000c1', 'second_step', pg_temp.ch(6), pg_temp.bind(6), 'stockpilotusa.com')),
        pg_temp.try(format('select public.issue_passkey_challenge(%L, %L, %L, %L, %L, %L)',
                           'a0475000-0000-0000-0000-0000000000c1', 'a0475000-0000-0000-0000-0000000005e1', 'delete_account',
                           pg_temp.ch(6), pg_temp.bind(6), 'stockpilotusa.com'))],
  array['22023:passkey_challenge_refused', '22023:passkey_challenge_refused', '23514:passkey_challenges_purpose'],
  '0475/121: a challenge needs an account, a session and one of the five purposes');
select is(
  (select count(*)::int from (
     select public.issue_passkey_challenge(:m1, :s1, 'second_step', pg_temp.ch(100 + g), pg_temp.bind(g), 'stockpilotusa.com')
       from generate_series(1, 9) g) x),
  9,
  '0475/122: an account may hold ten live challenges');
select is(
  pg_temp.try(format('select public.issue_passkey_challenge(%L, %L, %L, %L, %L, %L)',
                     'a0475000-0000-0000-0000-0000000000c1', 'a0475000-0000-0000-0000-0000000005e1', 'second_step',
                     pg_temp.ch(200), pg_temp.bind(200), 'stockpilotusa.com')),
  '54000:passkey_challenges_busy',
  '0475/123: an eleventh is refused');

-- ── 8. Removal and the bridge ───────────────────────────────────────────────
-- m2 now: 201, 202, 203 active; bridge f1. m1: 101, 102 active, no bridge.
select results_eq(
  $$ select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000c2',
       'a0475000-0000-0000-0000-000000000201', 'member') $$,
  $$ values (true, 2, 'a0475000-0000-0000-0000-00000000f001'::uuid, false) $$,
  '0475/124: removing one passkey answers removed, two left, the bridge factor, and the bridge kept');
select is(
  (select array[(p.removed_at = now())::text, p.removed_reason] from public.member_passkeys p
    where p.id = 'a0475000-0000-0000-0000-000000000201'),
  array['true', 'member'],
  '0475/125: the row is kept, marked removed now by the member');
select results_eq(
  $$ select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000c2',
       'a0475000-0000-0000-0000-000000000201', 'member') $$,
  $$ values (false, 2, 'a0475000-0000-0000-0000-00000000f001'::uuid, false) $$,
  '0475/126: removing it again removes nothing');
select results_eq(
  $$ select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000c1',
       (select p.id from public.member_passkeys p where p.credential_id = 'cred-0475_000000000202'), 'member') $$,
  $$ values (false, 2, null::uuid, false) $$,
  '0475/127: an account cannot remove another account''s passkey (answers for its own: two active, no bridge)');
select is(
  (select removed_at from public.member_passkeys p where p.user_id = :m2 and p.credential_id = pg_temp.cred(202)),
  null,
  '0475/128: and the other account''s passkey stays active');
select is(
  array[pg_temp.try(format('select public.passkey_mark_removed(%L, %L, %L)', 'a0475000-0000-0000-0000-0000000000c2',
                           'a0475000-0000-0000-0000-000000000202', 'recovery_code')),
        pg_temp.try(format('select public.passkey_mark_removed(%L, %L, %L)', 'a0475000-0000-0000-0000-0000000000c2',
                           'a0475000-0000-0000-0000-000000000202', 'admin')),
        pg_temp.try(format('select public.passkey_mark_removed(%L, %L, null)', 'a0475000-0000-0000-0000-0000000000c2',
                           'a0475000-0000-0000-0000-000000000202'))],
  array['22023:passkey_removal_refused', '22023:passkey_removal_refused', '22023:passkey_removal_refused'],
  '0475/129: one passkey is removed only by the member, a failed set-up or support; a recovery code removes all, and there is no admin reset');
-- A bridge in place of the one expected, or nothing.
select is(
  array[public.passkey_replace_bridge(:m2, :f2, :f3, pg_temp.ct(3), 1::smallint),
        public.passkey_replace_bridge(:m2, null, :f3, pg_temp.ct(3), 1::smallint)],
  array[false, false],
  '0475/130: a repair that expects another bridge, or no bridge, changes nothing');
select is(
  (select b.factor_id from public.passkey_bridges b where b.user_id = :m2),
  'a0475000-0000-0000-0000-00000000f001'::uuid,
  '0475/131: the bridge is still the one it was');
select is(
  pg_temp.try(format('select public.passkey_replace_bridge(%L, %L, %L, %L, 2::smallint)',
                     'a0475000-0000-0000-0000-0000000000c2', 'a0475000-0000-0000-0000-00000000f001',
                     'a0475000-0000-0000-0000-00000000f003', pg_temp.ct(3))),
  '23514:passkey_bridges_secret_ciphertext',
  '0475/132: a repair whose key version does not match the ciphertext is refused by the table');
select is(
  array[pg_temp.try(format('select public.passkey_replace_bridge(%L, %L, %L, %L, 1::smallint)',
                           'a0475000-0000-0000-0000-0000000000c2', 'a0475000-0000-0000-0000-00000000f001',
                           'a0475000-0000-0000-0000-00000000f121', pg_temp.ct(3))),
        pg_temp.try(format('select public.passkey_replace_bridge(%L, %L, %L, %L, 1::smallint)',
                           'a0475000-0000-0000-0000-0000000000c2', 'a0475000-0000-0000-0000-00000000f001',
                           'a0475000-0000-0000-0000-00000000f009', pg_temp.ct(3)))],
  array['22023:passkey_bridge_not_ours', '22023:passkey_bridge_not_ours'],
  '0475/133: a repair to another account''s factor, or to a factor that does not exist, is refused');
-- f4: a reserved-name factor of m2 that is not verified yet.
select pg_temp.factor(:m2, :f4, 'unverified');
select is(
  pg_temp.try(format('select public.passkey_replace_bridge(%L, %L, %L, %L, 1::smallint)',
                     'a0475000-0000-0000-0000-0000000000c2', 'a0475000-0000-0000-0000-00000000f001',
                     'a0475000-0000-0000-0000-00000000f004', pg_temp.ct(4))),
  '55000:passkey_bridge_not_verified',
  '0475/134: a verified bridge is never replaced by a factor that is not verified');
select is(
  (select b.factor_id from public.passkey_bridges b where b.user_id = :m2),
  'a0475000-0000-0000-0000-00000000f001'::uuid,
  '0475/135: and the verified bridge stays');
select is(
  public.passkey_replace_bridge(:m2, :f1, :f3, pg_temp.ct(3), 1::smallint),
  true,
  '0475/136: a repair that expects the present bridge puts the new one in place');
select is(
  (select array[b.factor_id::text, b.secret_ciphertext] from public.passkey_bridges b where b.user_id = :m2),
  array['a0475000-0000-0000-0000-00000000f003', pg_temp.ct(3)],
  '0475/137: now the new factor and its secret');
-- A new key version for the same factor (plan 2.3's rotation).
select is(
  public.passkey_replace_bridge(:m2, :f3, :f3, 'v2' || substr(pg_temp.ct(33), 3), 2::smallint),
  true,
  '0475/138: a new key version for the same factor is put in place');
select is(
  (select array[b.factor_id::text, b.secret_ciphertext, b.key_version::text, (b.created_at = now())::text]
     from public.passkey_bridges b where b.user_id = :m2),
  array['a0475000-0000-0000-0000-00000000f003', 'v2' || substr(pg_temp.ct(33), 3), '2', 'true'],
  '0475/139: the same factor, the new ciphertext and version, the row last written now');
select is(
  public.passkey_replace_bridge(:m1, null, :f121, pg_temp.ct(121), 1::smallint),
  true,
  '0475/140: finishing a set-up puts a bridge in place where there was none');
select is(
  array[pg_temp.try(format('select public.passkey_replace_bridge(%L, null, %L, %L, 1::smallint)',
                           'a0475000-0000-0000-0000-0000000000c6', 'a0475000-0000-0000-0000-00000000f601', pg_temp.ct(601))),
        pg_temp.try(format('select public.passkey_replace_bridge(%L, null, null, %L, 1::smallint)',
                           'a0475000-0000-0000-0000-0000000000c1', pg_temp.ct(601)))],
  array['55000:passkey_none_active', '22023:passkey_bridge_incomplete'],
  '0475/141: no bridge for an account with no active passkey; none with a value missing');
select is(
  array[pg_temp.try(format('select public.passkey_drop_bridge(%L, %L)',
                           'a0475000-0000-0000-0000-0000000000c2', 'a0475000-0000-0000-0000-00000000f003')),
        pg_temp.try(format('select public.passkey_drop_bridge(%L, %L)',
                           'a0475000-0000-0000-0000-0000000000c1', 'a0475000-0000-0000-0000-00000000f121'))],
  array['55000:passkey_still_active', '55000:passkey_still_active'],
  '0475/142: a bridge row is never dropped while the account has an active passkey');
select is(
  (select count(*)::int from public.passkey_bridges b where b.user_id in (:m1, :m2)),
  2,
  '0475/143: both bridge rows are still there');
-- The account lock in replace and drop, in one session. lockR has an active
-- passkey and no bridge row, lockD a removed passkey only; both rows are
-- written in a released savepoint, so each profile row carries that
-- subtransaction's KEY SHARE lock (pg_temp.profile_lock_mode). Each call
-- below changes nothing (replace expects a bridge the account does not
-- have; drop finds no row), so a lock the call leaves on the profile row is
-- the account lock and nothing else.
select pg_temp.factor(:lockR, :fLR, 'verified');
savepoint lock_setup;
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name,
   created_at, removed_at, removed_reason)
values (:lockR, pg_temp.cred(7101), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Lock R', now(), null, null),
       (:lockD, pg_temp.cred(7201), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Lock D', now(), now(), 'member');
release savepoint lock_setup;
select set_config('t.lockR', (select xmax::text from public.user_profiles where id = :lockR), true);
select set_config('t.lockD', (select xmax::text from public.user_profiles where id = :lockD), true);
select is(
  public.passkey_replace_bridge(:lockR, :f3, :fLR, pg_temp.ct(7101), 1::smallint),
  false,
  '0475/144: (a replace that expects a bridge the account does not have changes nothing)');
select is(pg_temp.profile_lock_mode(:lockR, current_setting('t.lockR')), 'fornokeyupd',
  '0475/145: passkey_replace_bridge takes the account lock: FOR NO KEY UPDATE on the profile row, held to the end of the transaction');
select is(
  public.passkey_drop_bridge(:lockD, :fLR),
  false,
  '0475/146: (a drop that finds no bridge row changes nothing)');
select is(pg_temp.profile_lock_mode(:lockD, current_setting('t.lockD')), 'fornokeyupd',
  '0475/147: passkey_drop_bridge takes the account lock: FOR NO KEY UPDATE on the profile row, held to the end of the transaction');
-- The last passkey takes the bridge row with it, in the same call.
select results_eq(
  $$ select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000c2',
       (select p.id from public.member_passkeys p where p.credential_id = 'cred-0475_000000000202'), 'member') $$,
  $$ values (true, 1, 'a0475000-0000-0000-0000-00000000f003'::uuid, false) $$,
  '0475/148: removing one of two leaves the bridge');
select results_eq(
  $$ select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000c2',
       (select p.id from public.member_passkeys p where p.credential_id = 'cred-0475_000000000203'), 'setup_failed') $$,
  $$ values (true, 0, 'a0475000-0000-0000-0000-00000000f003'::uuid, true) $$,
  '0475/149: removing the last one deletes the bridge row in the same call and answers its factor, for the server to remove at Supabase');
select is(
  array[(select count(*)::int from public.passkey_bridges b where b.user_id = :m2),
        (select count(*)::int from public.member_passkeys p where p.user_id = :m2 and p.removed_at is null)],
  array[0, 0],
  '0475/150: no bridge row and no active passkey are left');
select is(
  public.passkey_drop_bridge(:m2, :f3),
  false,
  '0475/151: dropping a bridge that is gone answers false');
select results_eq(
  $$ select removed, active_left, bridge_dropped from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000c8',
       (select p.id from public.member_passkeys p where p.credential_id = 'cred-0475_000000003001'), 'support') $$,
  $$ values (true, 9, false) $$,
  '0475/152: support may remove one passkey');
-- Every passkey at once (support).
select is(
  array[pg_temp.try(format('select public.passkey_remove_all(%L, %L)', 'a0475000-0000-0000-0000-0000000000c1', 'member')),
        pg_temp.try(format('select public.passkey_remove_all(%L, %L)', 'a0475000-0000-0000-0000-0000000000c1', 'setup_failed')),
        pg_temp.try(format('select public.passkey_remove_all(%L, null)', 'a0475000-0000-0000-0000-0000000000c1'))],
  array['22023:passkey_removal_refused', '22023:passkey_removal_refused', '22023:passkey_removal_refused'],
  '0475/153: every passkey is removed at once only for a recovery code or support');
select results_eq(
  $$ select * from public.passkey_remove_all('a0475000-0000-0000-0000-0000000000c1', 'support') $$,
  $$ values (2, 'a0475000-0000-0000-0000-00000000f121'::uuid) $$,
  '0475/154: support removes every active passkey and the bridge row, answering its factor');
select is(
  array[(select array_agg(coalesce(p.removed_reason, 'active') order by p.credential_id)::text
           from public.member_passkeys p where p.user_id = :m1),
        (select count(*)::text from public.passkey_bridges b where b.user_id = :m1)],
  array['{support,support,member}', '0'],
  '0475/155: each is marked removed by support (the one removed earlier keeps its own reason), and the bridge row is gone');
select results_eq(
  $$ select * from public.passkey_remove_all('a0475000-0000-0000-0000-0000000000c1', 'support') $$,
  $$ values (0, null::uuid) $$,
  '0475/156: a second call finds nothing left');

-- ── 9. A recovery code ──────────────────────────────────────────────────────
-- recov: two active passkeys, a bridge, two codes (one in the canonical
-- form, one legacy with its dashes); outsider has a code of its own.
select pg_temp.factor(:recov, :fr1, 'verified');
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name, created_at)
values (:recov, pg_temp.cred(5001), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Recovery 1', now()),
       (:recov, pg_temp.cred(5002), pg_temp.key(), true, true, true, 'stockpilotusa.com', 'Recovery 2', now());
insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
values (:recov, :fr1, pg_temp.ct(5001), 1);
insert into public.mfa_recovery_codes (id, user_id, code_hash) values
  ('a0475000-0000-0000-0000-0000000c0de1', :recov, pg_temp.code_hash('ABCD1234EF')),
  ('a0475000-0000-0000-0000-0000000c0de2', :recov, pg_temp.code_hash('LEG-ACY-0001')),
  ('a0475000-0000-0000-0000-0000000c0de3', :outsider, pg_temp.code_hash('OTHER12345'));
select is(
  array[(select row(r.*)::text from public.consume_recovery_code_with_passkeys(:recov, 'ABCD-1234-EE') r),
        (select row(r.*)::text from public.consume_recovery_code_with_passkeys(:recov, 'OTHER12345') r),
        (select row(r.*)::text from public.consume_recovery_code_with_passkeys(:recov, '   ') r),
        (select row(r.*)::text from public.consume_recovery_code_with_passkeys(:recov, null) r)],
  array_fill('(f,0,)'::text, array[4]),
  '0475/157: a wrong code, another account''s code, a blank and no code spend nothing');
select is(
  array[(select count(*)::int from public.member_passkeys p where p.user_id = :recov and p.removed_at is null),
        (select count(*)::int from public.passkey_bridges b where b.user_id = :recov),
        (select count(*)::int from public.mfa_recovery_codes c
          where c.id in ('a0475000-0000-0000-0000-0000000c0de1', 'a0475000-0000-0000-0000-0000000c0de3') and c.used_at is null)],
  array[2, 1, 2],
  '0475/158: and remove nothing: both passkeys, the bridge and both codes are as they were');
select results_eq(
  $$ select * from public.consume_recovery_code_with_passkeys('a0475000-0000-0000-0000-0000000000cd', 'abcd-1234 ef') $$,
  $$ values (true, 2, 'a0475000-0000-0000-0000-00000000f0d1'::uuid) $$,
  '0475/159: the account''s code, typed in lower case with a dash and a space, is spent, and every passkey and the bridge row go with it');
select is(
  array[(select (c.used_at = now())::text from public.mfa_recovery_codes c where c.id = 'a0475000-0000-0000-0000-0000000c0de1'),
        (select array_agg(p.removed_reason || '@' || (p.removed_at = now())::text order by p.credential_id)::text
           from public.member_passkeys p where p.user_id = :recov),
        (select count(*)::text from public.passkey_bridges b where b.user_id = :recov)],
  array['true', '{recovery_code@true,recovery_code@true}', '0'],
  '0475/160: in the same transaction: the code marked spent now, both passkeys removed now by the recovery code, the bridge row deleted');
select results_eq(
  $$ select * from public.consume_recovery_code_with_passkeys('a0475000-0000-0000-0000-0000000000cd', 'ABCD1234EF') $$,
  $$ values (false, 0, null::uuid) $$,
  '0475/161: a spent code is never spent again');
select results_eq(
  $$ select * from public.consume_recovery_code_with_passkeys('a0475000-0000-0000-0000-0000000000cd', ' leg-acy-0001 ') $$,
  $$ values (true, 0, null::uuid) $$,
  '0475/162: a legacy code (stored with its dashes) is accepted as 0103 accepts it, with nothing left to remove');
select is(
  pg_temp.try('select public.consume_recovery_code_with_passkeys(null, ''ABCD1234EF'')'),
  '22023:recovery_code_refused',
  '0475/163: an account is required');

-- ── 10. The health list and the bridge sessions ─────────────────────────────
-- e1 healthy; e2 no bridge; e3 bridge factor gone; e4 bridge factor not
-- verified; e5 a second verified reserved factor beside a healthy bridge;
-- e6 a removal not finished (a verified reserved factor made exactly when
-- the passkey was removed, removed rows only); e7 a verified reserved
-- factor and never a passkey; e8 a bridge row and removed rows only (its
-- factor made exactly at the removal); e9 passkeys of another site only; ea
-- healthy with a reserved factor not verified beside it; eb removed rows
-- only and nothing else (finished); ec as e6 but the factor was made after
-- the removal (a restore of public older than auth lost the live passkey);
-- ed as e8 but the row's factor was made after the removal; ee a bridge row
-- whose factor is gone and another verified reserved factor, with an active
-- passkey.
insert into public.member_passkeys
  (user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name,
   created_at, removed_at, removed_reason)
select ('a0475000-0000-0000-0000-0000000000' || x.u)::uuid, pg_temp.cred(6000 + x.n), pg_temp.key(), true, true, true,
       x.rp, 'State ' || x.u, now() - interval '200 days',
       case when x.removed then now() - interval '120 days' end,
       case when x.removed then 'member' end
  from (values ('e1', 1, 'stockpilotusa.com', false), ('e2', 2, 'stockpilotusa.com', false),
               ('e3', 3, 'stockpilotusa.com', false), ('e4', 4, 'stockpilotusa.com', false),
               ('e5', 5, 'stockpilotusa.com', false), ('e6', 6, 'stockpilotusa.com', true),
               ('e8', 8, 'stockpilotusa.com', true), ('e9', 9, 'localhost', false),
               ('ea', 10, 'stockpilotusa.com', false), ('eb', 11, 'stockpilotusa.com', true),
               ('ec', 12, 'stockpilotusa.com', true), ('ed', 13, 'stockpilotusa.com', true),
               ('ee', 14, 'stockpilotusa.com', false)) x(u, n, rp, removed);
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e1', 'a0475000-0000-0000-0000-00000000fe10', 'verified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e4', 'a0475000-0000-0000-0000-00000000fe40', 'unverified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e5', 'a0475000-0000-0000-0000-00000000fe50', 'verified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e5', 'a0475000-0000-0000-0000-00000000fe51', 'verified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e6', 'a0475000-0000-0000-0000-00000000fe60', 'verified', 'totp', null,
                       now() - interval '120 days');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e7', 'a0475000-0000-0000-0000-00000000fe70', 'verified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e8', 'a0475000-0000-0000-0000-00000000fe80', 'verified', 'totp', null,
                       now() - interval '120 days');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000ec', 'a0475000-0000-0000-0000-00000000fec0', 'verified', 'totp', null,
                       now() - interval '120 days' + interval '1 microsecond');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000ed', 'a0475000-0000-0000-0000-00000000fed0', 'verified', 'totp', null,
                       now() - interval '30 days');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000ee', 'a0475000-0000-0000-0000-00000000fee1', 'verified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000ea', 'a0475000-0000-0000-0000-00000000fea0', 'verified');
select pg_temp.factor('a0475000-0000-0000-0000-0000000000ea', 'a0475000-0000-0000-0000-00000000fea1', 'unverified');
-- A member's own app beside a healthy bridge is no concern of the list.
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e1', 'a0475000-0000-0000-0000-00000000fe1a', 'verified', 'totp', 'e1 app');
insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
select ('a0475000-0000-0000-0000-0000000000' || x.u)::uuid, ('a0475000-0000-0000-0000-00000000' || x.f)::uuid,
       pg_temp.ct(6000 + x.n), 1
  from (values ('e1', 'fe10', 1), ('e3', 'fe30', 3), ('e4', 'fe40', 4), ('e5', 'fe50', 5),
               ('e8', 'fe80', 8), ('ea', 'fea0', 10), ('ed', 'fed0', 13), ('ee', 'fee0', 14)) x(u, f, n);
select results_eq(
  $$ select right(s.user_id::text, 2), s.state from public.passkey_account_states('stockpilotusa.com') s
      where s.user_id::text like 'a0475000-0000-0000-0000-0000000000e%' order by s.user_id $$,
  $$ values ('e2', 'no_bridge'), ('e3', 'bridge_factor_missing'), ('e4', 'bridge_factor_unverified'),
            ('e5', 'reserved_factor_without_row'), ('e6', 'removal_unfinished'), ('e7', 'bridge_without_passkey'),
            ('e8', 'bridge_row_without_passkey'), ('e9', 'other_site_only'), ('ea', 'unverified_reserved_factor'),
            ('ec', 'bridge_newer_than_removal'), ('ed', 'bridge_newer_than_removal'),
            ('ee', 'reserved_factor_without_row') $$,
  '0475/164: the health list names each unhealthy state, and leaves out a healthy account (with its own app beside) and a finished removal');
select is(
  (select array_agg(right(s.user_id::text, 2) || ' ' || coalesce(s.bridge_factor_id::text, '-') || ' '
                    || coalesce(s.bridge_factor_status, '-') order by s.user_id)
     from public.passkey_account_states('stockpilotusa.com') s
    where s.user_id in ('a0475000-0000-0000-0000-0000000000e5', 'a0475000-0000-0000-0000-0000000000ee')),
  array['e5 a0475000-0000-0000-0000-00000000fe50 verified', 'ee a0475000-0000-0000-0000-00000000fee0 -'],
  '0475/165: one word, two cases told apart by the facts: a second verified reserved factor beside a verified bridge (its bridge status verified), and beside a bridge row whose factor is gone (no status), which must fail closed');
select is(
  (select array_agg(right(s.user_id::text, 2) || ' ' || s.state || ' '
                    || (s.last_removed_at = now() - interval '120 days')::text || ' '
                    || coalesce((s.bridge_factor_created_at - s.last_removed_at)::text, '-') || ' '
                    || coalesce(((s.reserved_factors -> 0 ->> 'created_at')::timestamptz - s.last_removed_at)::text, '-')
                    order by s.user_id)
     from public.passkey_account_states('stockpilotusa.com') s
    where s.user_id in ('a0475000-0000-0000-0000-0000000000e6', 'a0475000-0000-0000-0000-0000000000e8',
                        'a0475000-0000-0000-0000-0000000000ec', 'a0475000-0000-0000-0000-0000000000ed')),
  array['e6 removal_unfinished true - 00:00:00', 'e8 bridge_row_without_passkey true 00:00:00 -',
        'ec bridge_newer_than_removal true - 00:00:00.000001', 'ed bridge_newer_than_removal true 90 days -'],
  '0475/166: a factor made at the newest removal or before is a removal not finished; one made a microsecond after, with no row or as the row''s factor, is a factor the removed rows never served (fail closed), and the list returns the times that tell them apart');
select is(
  (select array[s.active_passkeys, s.other_site_passkeys, s.removed_passkeys]::text || ' ' || s.bridge_factor_id::text
          || ' ' || s.bridge_factor_status || ' ' || jsonb_array_length(s.reserved_factors)::text
          || ' ' || (s.reserved_factors -> 0 ->> 'factor_id') || ' ' || (s.reserved_factors -> 0 ->> 'status')
     from public.passkey_account_states('stockpilotusa.com') s
    where s.user_id = 'a0475000-0000-0000-0000-0000000000e5'),
  '{1,0,0} a0475000-0000-0000-0000-00000000fe50 verified 1 a0475000-0000-0000-0000-00000000fe51 verified',
  '0475/167: with the counts, the bridge factor and its status, and the other reserved-name factors');
select results_eq(
  $$ select right(s.user_id::text, 2), s.state from public.passkey_account_states('localhost') s
      where s.user_id::text in ('a0475000-0000-0000-0000-0000000000e1', 'a0475000-0000-0000-0000-0000000000e9')
      order by s.user_id $$,
  $$ values ('e1', 'other_site_only'), ('e9', 'no_bridge') $$,
  '0475/168: the site decides: read for localhost, the production account''s passkeys are another site''s, and the localhost account owes a bridge');
select is(
  array[pg_temp.try('select * from public.passkey_account_states(null)'),
        pg_temp.try('select * from public.passkey_account_states(''https://stockpilotusa.com'')')],
  array['22023:passkey_site_required', '22023:passkey_site_required'],
  '0475/169: the list needs a site, as a host name');
-- Sessions: e1 raised by its bridge; e5 by the reserved factor that is not
-- its bridge; e1 by its own app; e1 by its bridge two days ago.
insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
  ('a0475000-0000-0000-0000-0000000005f1', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '1 hour', now() - interval '1 hour',
     'a0475000-0000-0000-0000-00000000fe10', 'aal2'),
  ('a0475000-0000-0000-0000-0000000005f2', 'a0475000-0000-0000-0000-0000000000e5', now() - interval '2 hours', now() - interval '30 minutes',
     'a0475000-0000-0000-0000-00000000fe51', 'aal2'),
  ('a0475000-0000-0000-0000-0000000005f3', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '1 hour', now() - interval '1 hour',
     'a0475000-0000-0000-0000-00000000fe1a', 'aal2'),
  ('a0475000-0000-0000-0000-0000000005f4', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '2 days', now() - interval '2 days',
     'a0475000-0000-0000-0000-00000000fe10', 'aal2');
select results_eq(
  $$ select right(s.session_id::text, 3), right(s.user_id::text, 2), right(s.factor_id::text, 4), s.recorded, s.aal
       from public.passkey_bridge_sessions(now() - interval '1 day') s
      where s.user_id::text like 'a0475000-0000-0000-0000-0000000000e%' $$,
  $$ values ('5f2', 'e5', 'fe51', false, 'aal2'), ('5f1', 'e1', 'fe10', true, 'aal2') $$,
  '0475/170: the sessions raised by a reserved-name factor since the time given, newest first, each marked whether that factor is the recorded bridge; one raised by the member''s own app, and one older, left out');
select is(
  (select array_agg(a.attname::text order by a.attnum)
     from pg_proc p, unnest(p.proallargtypes, p.proargmodes, p.proargnames) with ordinality a(t, mode, attname, attnum)
    where p.oid = 'public.passkey_bridge_sessions(timestamptz)'::regprocedure and a.mode = 't'),
  array['session_id', 'user_id', 'factor_id', 'recorded', 'aal', 'created_at', 'updated_at', 'raised_at'],
  '0475/171: the session list returns no address and no device');
-- Stage 1 additions. raised_at: Auth's own row per session and method
-- (auth.mfa_amr_claims), upserted with Auth's clock on every TOTP answer.
-- 5f1 answered a TOTP factor 50 minutes ago and a password an hour ago; 5f2
-- has a password row only.
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  ('a0475000-0000-0000-0000-0000000a3f11', 'a0475000-0000-0000-0000-0000000005f1',
     now() - interval '1 hour', now() - interval '1 hour', 'password'),
  ('a0475000-0000-0000-0000-0000000a3f12', 'a0475000-0000-0000-0000-0000000005f1',
     now() - interval '1 hour', now() - interval '50 minutes', 'totp'),
  ('a0475000-0000-0000-0000-0000000a3f21', 'a0475000-0000-0000-0000-0000000005f2',
     now() - interval '2 hours', now() - interval '2 hours', 'password');
select results_eq(
  $$ select right(s.session_id::text, 3), s.raised_at
       from public.passkey_bridge_sessions(now() - interval '1 day') s
      where s.user_id::text like 'a0475000-0000-0000-0000-0000000000e%' $$,
  $$ values ('5f2', null::timestamptz), ('5f1', now() - interval '50 minutes') $$,
  '0475/172: raised_at is the time of the session''s TOTP method row; a session with no such row reads NULL, never another method''s time');

-- Ending one session. More sessions: 5f5 holds e1's bridge factor at aal1;
-- 5f6 has no factor; 5f7 is e7's, raised by e7's own reserved-name factor
-- (e7 has no bridge row); 5f8 is e1's, raised by its recorded bridge, with a
-- refresh token, a method row and a name; 5f9 is e2's, raised by e2's own
-- app.
select pg_temp.factor('a0475000-0000-0000-0000-0000000000e2', 'a0475000-0000-0000-0000-00000000fe2a', 'verified', 'totp', 'e2 app');
insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
  ('a0475000-0000-0000-0000-0000000005f5', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '20 minutes', now() - interval '20 minutes',
     'a0475000-0000-0000-0000-00000000fe10', 'aal1'),
  ('a0475000-0000-0000-0000-0000000005f6', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '20 minutes', now() - interval '20 minutes',
     null, 'aal1'),
  ('a0475000-0000-0000-0000-0000000005f7', 'a0475000-0000-0000-0000-0000000000e7', now() - interval '20 minutes', now() - interval '20 minutes',
     'a0475000-0000-0000-0000-00000000fe70', 'aal2'),
  ('a0475000-0000-0000-0000-0000000005f8', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '10 minutes', now() - interval '10 minutes',
     'a0475000-0000-0000-0000-00000000fe10', 'aal2'),
  ('a0475000-0000-0000-0000-0000000005f9', 'a0475000-0000-0000-0000-0000000000e2', now() - interval '10 minutes', now() - interval '10 minutes',
     'a0475000-0000-0000-0000-00000000fe2a', 'aal2');
insert into auth.refresh_tokens (token, user_id, session_id, revoked, created_at, updated_at) values
  ('sample-0475-refresh-5f8', 'a0475000-0000-0000-0000-0000000000e1', 'a0475000-0000-0000-0000-0000000005f8', false, now(), now()),
  ('sample-0475-refresh-5f1', 'a0475000-0000-0000-0000-0000000000e1', 'a0475000-0000-0000-0000-0000000005f1', false, now(), now());
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  ('a0475000-0000-0000-0000-0000000a3f81', 'a0475000-0000-0000-0000-0000000005f8',
     now() - interval '10 minutes', now() - interval '10 minutes', 'totp');
insert into public.user_session_names (session_id, user_id, name) values
  ('a0475000-0000-0000-0000-0000000005f8', 'a0475000-0000-0000-0000-0000000000e1', 'Sample laptop');
select is(pg_temp.try('select public.passkey_end_bridge_session(null)'), '22023:passkey_session_required',
  '0475/173: ending a session needs a session id');
select is(public.passkey_end_bridge_session('a0475000-0000-0000-0000-0000000005ff'), false,
  '0475/174: no session with that id: false, nothing ended');
select is(
  array[pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f2'')'),
        pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f3'')'),
        pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f5'')'),
        pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f6'')'),
        pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f7'')'),
        pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f9'')')],
  array_fill('22023:passkey_session_not_bridge_raised'::text, array[6]),
  '0475/175: refused, by name: a session raised by a reserved-name factor that is not the recorded bridge, by the member''s own app, the bridge factor at aal1, no factor, a reserved-name factor of an account with no bridge row, and an app of an account with no bridge row');
-- A bridge row of another account naming e7's factor (only the table's
-- owner can write one: the functions refuse it) must not make e7's session
-- endable.
insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
values ('a0475000-0000-0000-0000-0000000000e2', 'a0475000-0000-0000-0000-00000000fe70', pg_temp.ct(6002), 1);
select is(pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f7'')'),
  '22023:passkey_session_not_bridge_raised',
  '0475/176: refused when the bridge row naming the session''s factor is another account''s');
-- A recorded bridge row naming a factor without the reserved name.
update public.passkey_bridges set factor_id = 'a0475000-0000-0000-0000-00000000fe2a'
 where user_id = 'a0475000-0000-0000-0000-0000000000e2';
select is(pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005f9'')'),
  '22023:passkey_session_not_bridge_raised',
  '0475/177: refused when the recorded factor does not carry the reserved bridge name');
delete from public.passkey_bridges where user_id = 'a0475000-0000-0000-0000-0000000000e2';
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'a0475000-0000-0000-0000-0000000000e1', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select throws_ok(
  $$ select public.passkey_end_bridge_session('a0475000-0000-0000-0000-0000000005f8') $$,
  '42501', 'permission denied for function passkey_end_bridge_session',
  '0475/178: a member cannot call it, not even for their own bridge-raised session: it has no EXECUTE');
reset role;
set local role service_role;
select is(public.passkey_end_bridge_session('a0475000-0000-0000-0000-0000000005f8'), true,
  '0475/179: service_role ends a session raised by the account''s recorded bridge');
reset role;
select is(
  array[(select count(*)::int from auth.sessions where id = 'a0475000-0000-0000-0000-0000000005f8'),
        (select count(*)::int from auth.refresh_tokens where session_id = 'a0475000-0000-0000-0000-0000000005f8'),
        (select count(*)::int from auth.mfa_amr_claims where session_id = 'a0475000-0000-0000-0000-0000000005f8'),
        (select count(*)::int from public.user_session_names where session_id = 'a0475000-0000-0000-0000-0000000005f8')],
  array[0, 0, 0, 0],
  '0475/180: the session is gone, and with it its refresh token, its method row and its name');
select is(
  array[(select count(*)::int from auth.sessions where user_id = 'a0475000-0000-0000-0000-0000000000e1'),
        (select count(*)::int from auth.refresh_tokens where session_id = 'a0475000-0000-0000-0000-0000000005f1'),
        (select count(*)::int from auth.mfa_amr_claims where session_id = 'a0475000-0000-0000-0000-0000000005f1'),
        (select count(*)::int from auth.mfa_factors where user_id = 'a0475000-0000-0000-0000-0000000000e1'),
        (select count(*)::int from public.passkey_bridges
          where user_id = 'a0475000-0000-0000-0000-0000000000e1'
            and factor_id = 'a0475000-0000-0000-0000-00000000fe10'),
        (select count(*)::int from public.member_passkeys
          where user_id = 'a0475000-0000-0000-0000-0000000000e1' and removed_at is null)],
  array[5, 1, 2, 2, 1, 1],
  '0475/181: nothing else: the account''s five other sessions (one raised by the same bridge, two days ago), their token and method rows, both factors, the bridge row and the passkey stay');
select is(public.passkey_end_bridge_session('a0475000-0000-0000-0000-0000000005f8'), false,
  '0475/182: a second call finds no session and ends nothing');
-- The session is judged as it is when the call ends it, in the one
-- statement that ends it: 5fb starts raised by e1's recorded bridge.
insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
  ('a0475000-0000-0000-0000-0000000005fb', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '5 minutes', now() - interval '5 minutes',
     'a0475000-0000-0000-0000-00000000fe10', 'aal2');
create temporary table end_5fb (step int, answer text) on commit drop;
update auth.sessions set factor_id = 'a0475000-0000-0000-0000-00000000fe1a' where id = 'a0475000-0000-0000-0000-0000000005fb';
insert into end_5fb values (1, pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005fb'')'));
insert into end_5fb select 2, count(*)::text from auth.sessions where id = 'a0475000-0000-0000-0000-0000000005fb';
update auth.sessions set factor_id = 'a0475000-0000-0000-0000-00000000fe10', aal = 'aal1' where id = 'a0475000-0000-0000-0000-0000000005fb';
insert into end_5fb values (3, pg_temp.try('select public.passkey_end_bridge_session(''a0475000-0000-0000-0000-0000000005fb'')'));
insert into end_5fb select 4, count(*)::text from auth.sessions where id = 'a0475000-0000-0000-0000-0000000005fb';
update auth.sessions set aal = 'aal2' where id = 'a0475000-0000-0000-0000-0000000005fb';
insert into end_5fb values (5, public.passkey_end_bridge_session('a0475000-0000-0000-0000-0000000005fb')::text);
insert into end_5fb select 6, count(*)::text from auth.sessions where id = 'a0475000-0000-0000-0000-0000000005fb';
select is(
  (select array_agg(answer order by step) from end_5fb),
  array['22023:passkey_session_not_bridge_raised', '1', '22023:passkey_session_not_bridge_raised', '1', 'true', '0'],
  '0475/183: the session is judged as it is at the call: moved to the member''s own app, or back at aal1, it is refused and stays; raised by the recorded bridge again, it is ended');
-- The list holds a session whose own time is older than the window when its
-- raise time is inside it: 5fa was made three days ago and raised through
-- e1's bridge 30 minutes ago; 5fc was made and raised three days ago.
insert into auth.sessions (id, user_id, created_at, updated_at, factor_id, aal) values
  ('a0475000-0000-0000-0000-0000000005fa', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '3 days', now() - interval '3 days',
     'a0475000-0000-0000-0000-00000000fe10', 'aal2'),
  ('a0475000-0000-0000-0000-0000000005fc', 'a0475000-0000-0000-0000-0000000000e1', now() - interval '3 days', now() - interval '3 days',
     'a0475000-0000-0000-0000-00000000fe10', 'aal2');
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  ('a0475000-0000-0000-0000-0000000a3fa1', 'a0475000-0000-0000-0000-0000000005fa',
     now() - interval '3 days', now() - interval '30 minutes', 'totp'),
  ('a0475000-0000-0000-0000-0000000a3fc1', 'a0475000-0000-0000-0000-0000000005fc',
     now() - interval '3 days', now() - interval '3 days', 'totp');
select results_eq(
  $$ select right(s.session_id::text, 3), s.raised_at
       from public.passkey_bridge_sessions(now() - interval '1 day') s
      where s.session_id::text in ('a0475000-0000-0000-0000-0000000005fa', 'a0475000-0000-0000-0000-0000000005fc') $$,
  $$ values ('5fa', now() - interval '30 minutes') $$,
  '0475/184: a session is listed when its raise time is in the window, even when its own time is older; one with both times older is not');

-- ── 11. The purge ───────────────────────────────────────────────────────────
-- Challenges that ended a day ago exactly (kept) and a microsecond before
-- (deleted); removed passkeys 90 days ago exactly (kept) and a microsecond
-- before (deleted); unfinished removals of 120 days (kept: a bridge row,
-- or a verified reserved-name factor); a finished one of 120 days (eb,
-- deleted).
insert into public.passkey_challenges
  (id, user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at)
values
  ('a0475000-0000-0000-0000-000000000c31', :purger, :s2, 'second_step', pg_temp.ch(31), pg_temp.bind(31), 'localhost',
     now() - interval '1 day' - interval '2 minutes', now() - interval '1 day'),
  ('a0475000-0000-0000-0000-000000000c32', :purger, :s2, 'second_step', pg_temp.ch(32), pg_temp.bind(32), 'localhost',
     now() - interval '1 day' - interval '2 minutes 1 microsecond', now() - interval '1 day' - interval '1 microsecond');
insert into public.member_passkeys
  (id, user_id, credential_id, public_key, backup_eligible, backed_up, user_verified_at_registration, rp_id, name,
   created_at, removed_at, removed_reason)
values
  ('a0475000-0000-0000-0000-000000000c41', :purger, pg_temp.cred(4001), pg_temp.key(), true, true, true, 'localhost', 'Kept',
     now() - interval '200 days', now() - interval '90 days', 'member'),
  ('a0475000-0000-0000-0000-000000000c42', :purger, pg_temp.cred(4002), pg_temp.key(), true, true, true, 'localhost', 'Gone',
     now() - interval '200 days', now() - interval '90 days' - interval '1 microsecond', 'member'),
  ('a0475000-0000-0000-0000-000000000c43', :unverified, pg_temp.cred(4003), pg_temp.key(), true, true, true, 'localhost', 'Unfinished',
     now() - interval '200 days', now() - interval '120 days', 'recovery_code');
-- :unverified has an active passkey (a01); remove it so its removal is
-- unfinished: a bridge row with no active passkey.
update public.member_passkeys set removed_at = now() - interval '100 days', removed_reason = 'member'
 where id = 'a0475000-0000-0000-0000-000000000a01';
insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
values (:unverified, 'a0475000-0000-0000-0000-00000000fa01', pg_temp.ct(1001), 1);
-- 5,001 more ended challenges, two days old and older, one second apart.
insert into public.passkey_challenges
  (user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at)
select :purger, :s2, 'second_step', pg_temp.ch(10000 + g), pg_temp.bind(g), 'localhost',
       now() - interval '2 days' - make_interval(secs => g) - interval '2 minutes',
       now() - interval '2 days' - make_interval(secs => g)
  from generate_series(1, 5001) g;
select results_eq(
  $$ select * from public.purge_passkey_records() $$,
  $$ values (5000, 2) $$,
  '0475/185: the first purge deletes 5,000 ended challenges and the two passkeys removed more than 90 days ago whose removal is finished');
select is(
  (select array_agg(c.challenge order by c.expires_at)
     from public.passkey_challenges c where c.user_id = :purger),
  array[pg_temp.ch(10001), pg_temp.ch(32), pg_temp.ch(31)],
  '0475/186: oldest first: the newest of the 5,001 and the one that ended a microsecond more than a day ago are left for next time, with the one that ended exactly a day ago');
select results_eq(
  $$ select * from public.purge_passkey_records() $$,
  $$ values (2, 0) $$,
  '0475/187: the next purge deletes the two left past a day, and no passkey');
select is(
  (select array_agg(p.name order by p.name) from public.member_passkeys p
    where p.id in ('a0475000-0000-0000-0000-000000000c41', 'a0475000-0000-0000-0000-000000000c42',
                   'a0475000-0000-0000-0000-000000000c43', 'a0475000-0000-0000-0000-000000000a01')
       or p.credential_id in (pg_temp.cred(6006), pg_temp.cred(6008), pg_temp.cred(6011))),
  array['Kept', 'State e6', 'State e8', 'Unfinished', 'Unverified laptop'],
  '0475/188: a passkey removed exactly 90 days ago stays, and so do the removed rows of an account whose removal is not finished (a bridge row, or a verified reserved-name factor, and no active passkey); a finished one is gone');
select is(
  (select count(*)::int from public.passkey_challenges c where c.id = 'a0475000-0000-0000-0000-000000000c32'),
  0,
  '0475/189: a challenge that ended a microsecond more than a day ago is gone');
-- e8: a bridge row and no active passkey. A removal that removes nothing
-- leaves the row alone; dropping it needs its own factor.
select results_eq(
  $$ select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000e8',
       (select p.id from public.member_passkeys p where p.credential_id = 'cred-0475_000000006008'), 'member')
     union all
     select * from public.passkey_mark_removed('a0475000-0000-0000-0000-0000000000e8',
       (select p.id from public.member_passkeys p where p.credential_id = 'cred-0475_000000000203'), 'member') $$,
  $$ values (false, 0, 'a0475000-0000-0000-0000-00000000fe80'::uuid, false),
            (false, 0, 'a0475000-0000-0000-0000-00000000fe80'::uuid, false) $$,
  '0475/190: with no active passkey, removing one already removed, or another account''s, removes nothing and drops no bridge row (answers the row''s factor, not dropped)');
select is(
  (select count(*)::int from public.passkey_bridges b where b.user_id = 'a0475000-0000-0000-0000-0000000000e8'),
  1,
  '0475/191: the bridge row is still there');
select is(
  public.passkey_drop_bridge('a0475000-0000-0000-0000-0000000000e8', 'a0475000-0000-0000-0000-00000000fe10'),
  false,
  '0475/192: with no active passkey, a bridge row is dropped only when it is the factor named: another account''s factor drops nothing');
select is(
  public.passkey_drop_bridge('a0475000-0000-0000-0000-0000000000e8', 'a0475000-0000-0000-0000-00000000fe80'),
  true,
  '0475/193: its own factor drops it');
select is(
  (select count(*)::int from public.passkey_bridges b
    where b.user_id in ('a0475000-0000-0000-0000-0000000000e8', 'a0475000-0000-0000-0000-0000000000e1')),
  1,
  '0475/194: that row is gone and the other account''s bridge row stays');

-- ── 12. The cascade ─────────────────────────────────────────────────────────
insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
values (:m1, :f121, pg_temp.ct(121), 1);
select is(
  (select array[(select count(*)::int from public.member_passkeys where user_id = :m1),
                (select count(*)::int from public.passkey_bridges where user_id = :m1),
                (select count(*)::int from public.passkey_challenges where user_id = :m1)]),
  array[3, 1, 10],
  '0475/195: before: the member has three passkey rows, a bridge and ten challenges');
delete from public.user_profiles where id = :m1;
select is(
  (select array[(select count(*)::int from public.member_passkeys where user_id = :m1),
                (select count(*)::int from public.passkey_bridges where user_id = :m1),
                (select count(*)::int from public.passkey_challenges where user_id = :m1)]),
  array[0, 0, 0],
  '0475/196: deleting the member''s profile deletes their passkeys, bridge and challenges');
select is(
  (select array[(select count(*)::int from public.member_passkeys where user_id = :m2),
                (select count(*)::int from public.passkey_challenges where user_id = :m2)]),
  array[3, 1],
  '0475/197: another account''s rows stay');
insert into public.organization_passkey_switches (organization_id) values (:orgD);
delete from public.organizations where id = :orgD;
select is(
  (select array_agg(s.organization_id order by s.organization_id) from public.organization_passkey_switches s
    where s.organization_id in (:orgA, :orgD)),
  array['a0475000-0000-0000-0000-0000000000a1'::uuid],
  '0475/198: deleting an organization deletes its switch row, and no other');

-- ── 13. What a later edit must not lose ─────────────────────────────────────
select ok(
  (select position('auth.uid()' in prosrc) between 1 and position('return query' in prosrc)
          and position('disabled_at' in prosrc) between 1 and position('auth.mfa_factors' in prosrc)
          and position('auth.mfa_factors' in prosrc) between 1 and position('return query' in prosrc)
          and prosrc ~ 'p\.removed_at is null'
     from pg_proc where oid = 'public.my_passkeys()'::regprocedure),
  '0475/199: the member''s read takes the account from auth.uid(), refuses a disabled account before it looks at authenticators, and reads only active rows');
select ok(
  (select prosrc !~ 'credential_id' and prosrc !~ 'public_key' and prosrc !~ 'counter' and prosrc !~ 'rp_id'
     from pg_proc where oid = 'public.my_passkeys()'::regprocedure),
  '0475/200: the member''s read names no credential id, public key, counter or site');
select ok(
  (select position('for no key update' in prosrc) between 1 and position('passkey_add_allowed' in prosrc)
          and position('passkey_add_allowed' in prosrc) < position('_passkey_bridge_factor_ok' in prosrc)
          and position('_passkey_bridge_factor_ok' in prosrc) < position('insert into public.passkey_bridges' in prosrc)
          and position('insert into public.passkey_bridges' in prosrc) < position('insert into public.member_passkeys' in prosrc)
          and prosrc !~* 'on conflict'
          -- No UPDATE statement at all (the suite's UPDATE form, security_invariants'
          -- _sec_inv_writer_re): a bridge row is only ever inserted here.
          and prosrc !~* $w$\mupdate\s+(only\s*\(?\s*)?(("([^"]|"")+"|[a-z_][a-z0-9_$]*)\s*\.\s*)*("([^"]|"")+"|[a-z_][a-z0-9_$]*)(\s*\))?(\s*\*)?(\s+(as\s+)?("([^"]|"")+"|[a-z_][a-z0-9_$]*))?\s+set\M$w$
     from pg_proc where oid = 'public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint)'::regprocedure),
  '0475/201: passkey_register locks the account, re-checks the rule, checks the factor, then inserts the bridge and the passkey; it has no upsert and no UPDATE, so it never overwrites a bridge');
select ok(
  (select prosrc ~ 'p_backed_up, true, p_rp_id'
     from pg_proc where oid = 'public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint)'::regprocedure),
  '0475/202: passkey_register stores user verification as true (the server verified it; the table refuses false)');
select ok(
  (select prosrc ~ 'c\.id = p_id' and prosrc ~ 'c\.user_id = p_user_id' and prosrc ~ 'c\.session_id = p_session_id'
          and prosrc ~ 'c\.purpose = p_purpose' and prosrc ~ 'c\.binding_hash = p_binding_hash'
          and prosrc ~ 'c\.used_at is null' and prosrc ~ 'c\.expires_at > pg_catalog\.now\(\)'
          and (length(prosrc) - length(replace(prosrc, 'update public.passkey_challenges', ''))) = length('update public.passkey_challenges')
     from pg_proc where oid = 'public.take_passkey_challenge(uuid, uuid, uuid, text, text)'::regprocedure),
  '0475/203: a challenge is spent by one update that names all five bindings, unspent and not ended');
select ok(
  (select prosrc ~ 'm\.accepted_at is not null' and prosrc ~ 'm\.impersonation_expires_at is null'
          and prosrc ~ 's\.passkeys_on' and prosrc ~ 's\.passkey_adds_on' and prosrc ~ '>= 10'
     from pg_proc where oid = 'public.passkey_add_allowed(uuid)'::regprocedure),
  '0475/204: the rule counts memberships as 0413 does (accepted, not an act-as seat), reads both switches and caps at ten');
select ok(
  (select prosrc ~ 'f\.user_id = p_user_id' and prosrc ~ 'f\.id = p_factor_id' and prosrc ~ 'f\.factor_type = ''totp'''
          and prosrc ~ 'left\(coalesce\(f\.friendly_name, ''''\), 18\) = ''sp-passkey-bridge-'''
     from pg_proc where oid = 'public._passkey_bridge_factor_ok(uuid, uuid)'::regprocedure),
  '0475/205: a bridge factor is a TOTP factor of the same account whose name starts with the reserved sp-passkey-bridge-');
select ok(
  (select bool_and(prosrc ~ 'delete from public\.passkey_bridges' and prosrc ~ 'for no key update')
     from pg_proc where oid in ('public.passkey_mark_removed(uuid, uuid, text)'::regprocedure,
                                'public.passkey_remove_all(uuid, text)'::regprocedure,
                                'public.consume_recovery_code_with_passkeys(uuid, text)'::regprocedure)),
  '0475/206: each removal deletes the bridge row itself, in its own transaction, under the account lock');
select ok(
  (select position('for no key update' in r.prosrc) between 1 and position('passkey_none_active' in r.prosrc)
          and position('for no key update' in d.prosrc) between 1 and position('passkey_still_active' in d.prosrc)
     from pg_proc r, pg_proc d
    where r.oid = 'public.passkey_replace_bridge(uuid, uuid, uuid, text, smallint)'::regprocedure
      and d.oid = 'public.passkey_drop_bridge(uuid, uuid)'::regprocedure),
  '0475/207: replace and drop take the account lock before they look for an active passkey');
select ok(
  (select position('removed_at is null' in prosrc) between 1 and position('delete from public.passkey_bridges' in prosrc)
          and prosrc ~ 'passkey_still_active'
     from pg_proc where oid = 'public.passkey_drop_bridge(uuid, uuid)'::regprocedure),
  '0475/208: dropping a bridge looks for an active passkey first');
select ok(
  (select position('v_code_id is null' in prosrc) between 1 and position('update public.member_passkeys' in prosrc)
          and position('update public.mfa_recovery_codes' in prosrc) between 1 and position('update public.member_passkeys' in prosrc)
          and prosrc ~ 'for update'
     from pg_proc where oid = 'public.consume_recovery_code_with_passkeys(uuid, text)'::regprocedure),
  '0475/209: the recovery function removes passkeys only after it found and spent an unspent code of the account, which it locks');
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relname in ('member_passkeys', 'passkey_bridges', 'passkey_challenges', 'organization_passkey_switches')
      and exists (select 1 from pg_publication_rel pr where pr.prrelid = c.oid)),
  0,
  '0475/210: none of the four tables is in a publication (no realtime feed)');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid in ('public.member_passkeys'::regclass, 'public.passkey_bridges'::regclass,
                        'public.passkey_challenges'::regclass, 'public.organization_passkey_switches'::regclass)
      and not t.tgisinternal),
  0,
  '0475/211: none of the four tables has a trigger of its own');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.user_profiles'::regclass and t.tgisinternal
      and t.tgconstraint in (select c.oid from pg_constraint c
                              where c.contype = 'f'
                                and c.conrelid in ('public.member_passkeys'::regclass, 'public.passkey_bridges'::regclass,
                                                   'public.passkey_challenges'::regclass))),
  6,
  '0475/212: user_profiles gains only the three foreign keys'' internal triggers (on delete and on update, each)');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.organizations'::regclass and t.tgisinternal
      and t.tgconstraint in (select c.oid from pg_constraint c
                              where c.contype = 'f' and c.conrelid = 'public.organization_passkey_switches'::regclass)),
  2,
  '0475/213: organizations gains only the switch key''s two internal triggers');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name like '%passkey%'),
  0,
  '0475/214: there is no passkey column on organizations (an organization''s admins can write their own row)');
select is(
  (select md5(pg_get_constraintdef(c.oid)) from pg_constraint c
    where c.conrelid = 'public.platform_admin_audit'::regclass and c.conname = 'platform_admin_audit_action_check'),
  '5c5206f38b7c1c7c60301d7d2ec92f2c',
  '0475/215: the platform audit vocabulary is the one 0413 left: this file adds no word (the console''s switch words come with the console control)');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.member_passkeys'::regclass and c.conname = 'member_passkeys_user_verified'),
  'CHECK (user_verified_at_registration)',
  '0475/216: a stored passkey was always made with user verification');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.member_passkeys'::regclass and c.conname = 'member_passkeys_name'),
  $c$CHECK (((name ~ '^[A-Za-z0-9 ()+''_-]{1,60}$'::text) AND (name = btrim(name))))$c$,
  '0475/217: the name rule is the allowlist with no dot, 1 to 60, trimmed');
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.passkey_challenges'::regclass and c.conname = 'passkey_challenges_lifetime'),
  $c$CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval))))$c$,
  '0475/218: a challenge lives at most 5 minutes');
select is(
  (select array_agg(e::text order by e)
     from (select (regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g'))[1] as e
             from pg_constraint c
            where c.conrelid = 'public.passkey_challenges'::regclass and c.conname = 'passkey_challenges_purpose') x),
  array['confirm_add', 'finish_setup', 'password_reset', 'register', 'second_step'],
  '0475/219: a ceremony is bound to one of the five purposes where a code is typed today or a passkey is added, and no other');
-- Review 2 N5. A test cannot make a factor with no time (auth.mfa_factors
-- refuses a null created_at, and the test role may not change that table),
-- so these two read the function's own text, as 0475/206 does for its locks.
select ok(
  (select prosrc like '%) as has_other_verified,%'
          and prosrc like '%and x.has_other_verified%then ''reserved_factor_without_row''%'
          and prosrc like '%and x.has_other_verified%then ''removal_unfinished''%'
          and prosrc like '%(x.bridge_id is not null or x.has_other_verified)%'
          and prosrc not like '%newest_other_verified is not null%'
     from pg_proc where oid = 'public.passkey_account_states(text)'::regprocedure),
  '0475/220: whether a verified reserved-name factor exists is asked on its own, never through its time');
select ok(
  (select prosrc like '%f.created_at is null) as other_verified_untimed,%'
          and prosrc like '%or x.other_verified_untimed%then ''bridge_newer_than_removal''%'
          and prosrc like '%(x.bridge_created is null or x.bridge_created > x.last_removed)%then ''bridge_newer_than_removal''%'
     from pg_proc where oid = 'public.passkey_account_states(text)'::regprocedure),
  '0475/221: a verified reserved-name factor or bridge with no time is read as made after the newest removal (closed)');

select * from finish();
rollback;
