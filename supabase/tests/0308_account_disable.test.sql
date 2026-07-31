-- supabase/tests/0308_account_disable.test.sql
-- Proves migration 0308: the god-admin account-disable substrate.
--
-- Three independent things are asserted:
--   (a) user_profiles carries the three additive status columns — nullable, with
--       no default — so an existing row must read as ACTIVE without a backfill;
--   (b) platform_admin_audit's action CHECK accepts the two new actions AND
--       still accepts EVERY value it accepted before. The constraint is DROPPED
--       and RE-ADDED (0241's precedent), which is the CHECK analogue of
--       recurring bug #24: a re-add that forgets a value silently breaks an
--       existing god-mode action at insert time, so all nine pre-0308 values are
--       asserted one by one rather than sampled. The list under test was read
--       out of the LOCAL database (pg_get_constraintdef on
--       platform_admin_audit_action_check at 0307) so the assertion pins what
--       shipped, not what a migration file claims;
--   (c) admin_revoke_user_sessions deletes exactly ONE user's auth.sessions
--       rows, returns their ids, is SECURITY DEFINER with a pinned search_path,
--       and is executable by service_role ONLY. The 0213 self-service functions
--       are auth.uid()-scoped and cannot be reused by an admin acting on someone
--       else, and the installed auth-js has no signOut-by-user-id — this
--       function is the ONLY by-user-id revocation the platform gets, which is
--       exactly why an authenticated/anon EXECUTE grant on it would let any
--       logged-in user sign out anybody. That grant is asserted ABSENT two ways:
--       via has_function_privilege for the named roles, and via the raw ACL for
--       PUBLIC (which has_function_privilege cannot be asked about directly).
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(39);

\set u_target '\'ad080000-0000-0000-0000-0000000000a1\''
\set u_other  '\'ad080000-0000-0000-0000-0000000000a2\''
\set s_t1     '\'ad080000-0000-0000-0000-0000000000b1\''
\set s_t2     '\'ad080000-0000-0000-0000-0000000000b2\''
\set s_o1     '\'ad080000-0000-0000-0000-0000000000c1\''
\set actor    '\'ad080000-0000-0000-0000-0000000000d1\''

-- ── (a) columns ────────────────────────────────────────────────────────────
select has_column('public', 'user_profiles', 'disabled_at',     'user_profiles.disabled_at exists');
select has_column('public', 'user_profiles', 'disabled_reason', 'user_profiles.disabled_reason exists');
select has_column('public', 'user_profiles', 'disabled_by',     'user_profiles.disabled_by exists');

select col_type_is('public', 'user_profiles', 'disabled_at', 'timestamp with time zone',
  'disabled_at is timestamptz');
select col_type_is('public', 'user_profiles', 'disabled_reason', 'text',
  'disabled_reason is text');
select col_type_is('public', 'user_profiles', 'disabled_by', 'uuid',
  'disabled_by is uuid');

select col_hasnt_default('public', 'user_profiles', 'disabled_at',
  'disabled_at has NO default — an existing row reads as ACTIVE with no backfill');
select col_hasnt_default('public', 'user_profiles', 'disabled_reason',
  'disabled_reason has NO default');
select col_hasnt_default('public', 'user_profiles', 'disabled_by',
  'disabled_by has NO default');

-- Nullable, or the ADD COLUMN would have had to rewrite every existing row.
select col_is_null('public', 'user_profiles', 'disabled_at',     'disabled_at is nullable');
select col_is_null('public', 'user_profiles', 'disabled_reason', 'disabled_reason is nullable');
select col_is_null('public', 'user_profiles', 'disabled_by',     'disabled_by is nullable');

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_target, 'target@ad08.test', '{}'::jsonb),
  (:u_other,  'other@ad08.test',  '{}'::jsonb),
  (:actor,    'actor@ad08.test',  '{}'::jsonb) on conflict (id) do nothing;

-- The profile row above was written by the 0001 on_auth_user_created trigger,
-- which names none of the new columns — i.e. an OLD-SHAPE insert still
-- succeeds, and what it produces is an ACTIVE account.
select is(
  (select disabled_at from public.user_profiles where id = :u_target),
  null,
  'a freshly created profile is ACTIVE (disabled_at null)'
);
select is(
  (select disabled_reason from public.user_profiles where id = :u_target),
  null,
  'a freshly created profile has no disable reason'
);
select is(
  (select disabled_by from public.user_profiles where id = :u_target),
  null,
  'a freshly created profile has no disabling admin'
);

-- The columns are writable as a set and read back unchanged.
select lives_ok(
  $$update public.user_profiles
      set disabled_at = now(),
          disabled_reason = 'policy_violation',
          disabled_by = 'ad080000-0000-0000-0000-0000000000d1'
    where id = 'ad080000-0000-0000-0000-0000000000a1'$$,
  'a profile can be stamped disabled'
);
select is(
  (select disabled_reason from public.user_profiles
    where id = :u_target and disabled_at is not null),
  'policy_violation',
  'the disable stamp reads back'
);

-- ── (b) audit action vocabulary ────────────────────────────────────────────
-- The two NEW values.
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, target_user_id)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'user_disabled',
            'ad080000-0000-0000-0000-0000000000a1')$$,
  'CHECK accepts user_disabled'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, target_user_id)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'user_reenabled',
            'ad080000-0000-0000-0000-0000000000a1')$$,
  'CHECK accepts user_reenabled'
);

-- Every pre-0308 value, individually. A drop-and-re-add that loses one of these
-- would break a shipped god-mode action and nothing else in the suite notices.
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'viewed_org')$$,
  'CHECK still accepts viewed_org (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'acted_as_start')$$,
  'CHECK still accepts acted_as_start (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'acted_as_end')$$,
  'CHECK still accepts acted_as_end (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'billing_changed')$$,
  'CHECK still accepts billing_changed (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'password_reset_sent')$$,
  'CHECK still accepts password_reset_sent (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'org_provisioned')$$,
  'CHECK still accepts org_provisioned (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'ticket_updated')$$,
  'CHECK still accepts ticket_updated (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'deletion_passphrase_set')$$,
  'CHECK still accepts deletion_passphrase_set (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'org_deleted')$$,
  'CHECK still accepts org_deleted (pre-0308 value)'
);

-- Widening must not turn the CHECK into a rubber stamp.
select throws_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'user_vaporized')$$,
  '23514',
  null,
  'CHECK still rejects an unknown action'
);

-- ── (c) admin_revoke_user_sessions ─────────────────────────────────────────
select has_function('public', 'admin_revoke_user_sessions', array['uuid'],
  'admin_revoke_user_sessions(uuid) exists');
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_revoke_user_sessions'),
  true,
  'admin_revoke_user_sessions is SECURITY DEFINER'
);
-- A SECURITY DEFINER function with an unpinned search_path is a privilege
-- escalation vector: the caller chooses which schema its unqualified names
-- resolve in.
select ok(
  (select p.proconfig is not null
          and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_revoke_user_sessions'),
  'admin_revoke_user_sessions pins search_path'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_revoke_user_sessions(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_revoke_user_sessions(uuid)', 'execute'),
  'authenticated and anon CANNOT execute it — an ordinary user must never kill another user''s sessions'
);
-- The assertion above would already catch a PUBLIC grant — privileges granted to
-- PUBLIC are inherited by every role, so has_function_privilege('authenticated',
-- ...) returns true when PUBLIC holds EXECUTE (verified empirically). This
-- assertion is the stricter structural statement the one above cannot make: that
-- the ACL is EXPLICIT at all. A function left at Postgres' default (proacl null)
-- is PUBLIC-executable, and a null ACL is what a dropped `revoke` would leave
-- behind. So both are required: proacl not null, and no empty-grantee (PUBLIC)
-- entry in it.
select ok(
  (select p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_revoke_user_sessions'),
  'no PUBLIC execute grant survives on admin_revoke_user_sessions'
);
select ok(
  has_function_privilege('service_role', 'public.admin_revoke_user_sessions(uuid)', 'execute'),
  'service_role CAN execute it — this is the platform actions'' admin client'
);

insert into auth.sessions (id, user_id, created_at, updated_at) values
  (:s_t1, :u_target, now(), now()),
  (:s_t2, :u_target, now(), now()),
  (:s_o1, :u_other,  now(), now());

select set_eq(
  $$select public.admin_revoke_user_sessions('ad080000-0000-0000-0000-0000000000a1'::uuid)$$,
  array['ad080000-0000-0000-0000-0000000000b1'::uuid,
        'ad080000-0000-0000-0000-0000000000b2'::uuid],
  'returns exactly the target user''s revoked session ids'
);
select is(
  (select count(*)::int from auth.sessions
    where user_id in ('ad080000-0000-0000-0000-0000000000a1'::uuid,
                      'ad080000-0000-0000-0000-0000000000a2'::uuid)),
  1,
  'the OTHER user''s session survives — revocation is scoped to one user id'
);
select is(
  (select user_id from auth.sessions
    where user_id in ('ad080000-0000-0000-0000-0000000000a1'::uuid,
                      'ad080000-0000-0000-0000-0000000000a2'::uuid)),
  :u_other::uuid,
  'the surviving session belongs to the OTHER user, not the target'
);
-- Re-revoking an already-revoked user is a no-op, not an error: the disable
-- action must stay idempotent for a retry.
select is(
  (select count(*)::int from public.admin_revoke_user_sessions(:u_target::uuid)),
  0,
  'revoking a user with no sessions returns nothing and does not raise'
);

select * from finish();
rollback;
