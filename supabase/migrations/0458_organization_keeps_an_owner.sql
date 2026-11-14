-- An organization that has members keeps an owner.
--
-- No commit may leave an organization with real members and no real owner,
-- whoever makes the write: a signed-in member, the server's service key, the
-- auth server, a SECURITY DEFINER function or a foreign key action. The words
-- are 0393's, used by its account-deletion rule (tg_auth_users_before_delete):
--   - a REAL member is a membership row with accepted_at set and
--     impersonation_expires_at null (an "Act as" support seat is never a real
--     member, and never a real owner, although its role is owner);
--   - a REAL owner is a real member whose role is owner.
--
-- HOW. Four deferred constraint triggers on public.organization_members run
-- one function, tg_organization_members_owner_present(), at commit:
--   1. organization_members_owner_present_upd and _del: a real owner row
--      stops being one (demoted, un-accepted, made a seat, moved to another
--      organization, or deleted, a cascade included). Every role. The check
--      is for the organization the row left (argument 'old').
--   2. organization_members_owner_present_join_ins and _join_upd: a row
--      becomes a real member that is not an owner (inserted accepted, or
--      completed, or made real from a seat, or moved into an organization),
--      written by an API role (service_role, authenticated, anon). The check
--      is for the organization the row is in now (argument 'new'). Writers
--      running as the table owner (hand SQL, migrations, a SECURITY DEFINER
--      function's own statements, foreign key actions, the two-session race
--      fixtures) are not checked on this side. The first member of a new
--      organization is its owner (workspace creation and provisioning insert
--      the owner row), and an owner row is never checked on this side.
-- The WHEN clauses are evaluated when the row is written (not deferred), so a
-- write that queues no check costs one expression test and takes no lock.
--
-- At commit the function takes a transaction-level advisory lock for the
-- organization (pg_try_advisory_xact_lock in a loop: 40 tries, 50 to 150 ms
-- apart, so 2 to 6 s at most; then 55P03 'organization_owner_check_busy' and
-- nothing is applied), then reads the organization again in a new statement,
-- so it sees every commit made before it got the lock (a commit is visible
-- before its locks are released). It refuses with SQLSTATE P0001, message
-- 'organization_needs_owner', constraint 'organization_owner_present', when
-- real members remain and no real owner does. Two transactions that change
-- owners or members of one organization at once are therefore decided one
-- after the other. A try-lock never registers a wait, so no deadlock (40P01)
-- can come from it: two transactions that each hold one organization's lock
-- and try the other's end with one or two 55P03s. The function never raises
-- 40001 or 40P01 (PostgREST retries those forever).
--
-- The check runs in READ COMMITTED only (0A000
-- 'organization_owner_check_isolation' otherwise): under REPEATABLE READ or
-- SERIALIZABLE its second read would use the transaction's first snapshot.
-- The Data API and the auth server run READ COMMITTED; the preflight below
-- checks that no database, role or function setting changes that.
--
-- What it allows, by design: deleting an organization (its members cascade;
-- at commit no member is left); the ownership transfer (transfer_org_ownership
-- demotes, then promotes, in one transaction; at commit the target is the
-- owner); an account deletion that 0393's rule allows (the same definitions:
-- a sole owner with no other real member, or one of several owners);
-- removing every member at once; starting and ending an "Act as" seat; any
-- change that neither takes an owner away nor adds a member that is not an
-- owner (stored rows are never read or checked by this file).
--
-- The account-deletion dry run (account_deletion_check, 0388) undoes its
-- delete inside a subtransaction, which discards a deferred check queued
-- there. Its answer still agrees with the real delete: the refusal condition
-- here equals 0393's last-owner rule, which fires inside the dry run, so the
-- two can differ only when another transaction commits between the dry run
-- and the auth server's commit. The pgTAP suite pins that agreement.
--
-- The guard (_guard_organization_member_changes) is unchanged.
--
-- TIER A. No row is written, rewritten or deleted; nothing is dropped or
-- retyped. Created: one function and four constraint triggers (each a
-- pg_trigger row and a pg_constraint row of type 't'), and their comments.
--
-- GRANTS. tg_organization_members_owner_present(): EXECUTE revoked from
-- PUBLIC, anon, authenticated and service_role (no role calls it; a trigger
-- function needs no EXECUTE to fire). Owner postgres, SECURITY DEFINER with an
-- empty search_path: the read must see every row of the organization whoever
-- writes (row rules would filter a signed-in writer's read; the auth server's
-- role holds no privilege on public.organization_members).
--
-- LOCKS. CREATE CONSTRAINT TRIGGER takes SHARE ROW EXCLUSIVE on
-- public.organization_members, held to commit. It conflicts with every write
-- of that table (ROW EXCLUSIVE), so inserts, updates and deletes of
-- memberships wait for the few milliseconds the file runs; reads (ACCESS
-- SHARE) and the key-share row locks other tables' foreign keys take (ROW
-- SHARE) do not wait. It scans and validates nothing. COMMENT ON TRIGGER
-- takes SHARE UPDATE EXCLUSIVE on the same table, inside the same lock.
-- CREATE FUNCTION takes no table lock. The prelude takes the table lock first,
-- NOWAIT, in a bounded retry (the 0390 pattern): a busy table fails the
-- attempt at once and the next attempt starts 50 to 150 ms later holding
-- nothing; after 40 busy attempts the file raises 55P03 and applies nothing.
-- No later statement locks another table. lock_timeout 900ms.
-- scripts/db-concurrency/0458_migration_lock_footprint.sh checks it.
--
-- PREFLIGHT (after the lock, before any change). Stops with SQLSTATE 55000,
-- hint 'organization_owner_preflight', naming every difference, and applies
-- nothing, unless:
--   - the bodies this rule works with are the ones it was written against:
--     md5(prosrc), SECURITY DEFINER and owner of _guard_organization_member_
--     changes, transfer_org_ownership, tg_auth_users_before_delete and
--     account_deletion_check;
--   - the guard trigger is BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW and
--     enabled; on_auth_user_before_delete is BEFORE DELETE FOR EACH ROW on
--     auth.users and enabled; (organization_id, user_id) is unique;
--     memberships cascade from user_profiles and organizations, and profiles
--     from auth.users;
--   - every name this file creates is free;
--   - no function in any schema sets its own transaction isolation
--     (proconfig), no database or role setting sets
--     default_transaction_isolation, and the server's default is read
--     committed.
-- It reads no membership row: the triggers act on later writes only.
--
-- ERRORS. This file: 55000 (preflight), 55P03 (prelude). At run time:
-- P0001 organization_needs_owner, 55P03 organization_owner_check_busy, 0A000
-- organization_owner_check_isolation, all at COMMIT (or at SET CONSTRAINTS
-- ... IMMEDIATE). Never 40001 or 40P01.

set lock_timeout = '900ms';

-- ═══ 0. Lock prelude ══════════════════════════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there); the lock lasts until the batch commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organization_members in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock$;

-- ═══ 1. Preflight ═════════════════════════════════════════════════════════
do $pre$
declare
  v_bad text[] := '{}';
  r record;
begin
  for r in
    select x.sig, h.want, p.oid as fn,
           md5(p.prosrc) as got, p.prosecdef, pg_get_userbyid(p.proowner) as owner
      from (values
              ('g1', 'public._guard_organization_member_changes()'),
              ('g2', 'public.transfer_org_ownership(uuid,uuid,uuid)'),
              ('g3', 'public.tg_auth_users_before_delete()'),
              ('g4', 'public.account_deletion_check(uuid)')) x(k, sig)
      -- md5(prosrc) of each body above, keyed by the same alias.
      join (values
              ('g1', 'b48c165e' || '5ff1ae0e8bbf159ab97c0d42'),
              ('g2', '777da8ae' || '49fdeabee55bb49f7259b9a2'),
              ('g3', '88fbc1c4' || 'a826334245675b24b3d23106'),
              ('g4', '15968336' || 'd457e56544f3a2421e807b35')) h(k, want) on h.k = x.k
      left join pg_proc p on p.oid = to_regprocedure(x.sig)
  loop
    if r.fn is null then
      v_bad := v_bad || format('%s is missing', r.sig);
    elsif r.got <> r.want or not r.prosecdef or r.owner <> 'postgres' then
      v_bad := v_bad || format('%s is md5 %s, definer %s, owner %s (want %s, true, postgres)',
                               r.sig, r.got, r.prosecdef, r.owner, r.want);
    end if;
  end loop;

  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.organization_members'::regclass
                    and t.tgname = 'organization_members_role_guard'
                    and t.tgtype = 31 and t.tgenabled = 'O'
                    and t.tgfoid = to_regprocedure('public._guard_organization_member_changes()')) then
    v_bad := v_bad || 'organization_members_role_guard is not BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW, enabled, on the guard function'::text;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'auth.users'::regclass
                    and t.tgname = 'on_auth_user_before_delete'
                    and t.tgtype = 11 and t.tgenabled = 'O'
                    and t.tgfoid = to_regprocedure('public.tg_auth_users_before_delete()')) then
    v_bad := v_bad || 'on_auth_user_before_delete is not BEFORE DELETE FOR EACH ROW on auth.users, enabled'::text;
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.organization_members'::regclass
                    and c.contype = 'u'
                    and (select array_agg(a.attname::text order by a.attname)
                           from pg_attribute a
                          where a.attrelid = c.conrelid and a.attnum = any (c.conkey))
                        = array['organization_id', 'user_id']) then
    v_bad := v_bad || 'organization_members has no unique key on (organization_id, user_id)'::text;
  end if;
  for r in
    select x.tbl, x.col, x.ref
      from (values ('public.organization_members', 'user_id', 'public.user_profiles'),
                   ('public.organization_members', 'organization_id', 'public.organizations'),
                   ('public.user_profiles', 'id', 'auth.users')) x(tbl, col, ref)
     where not exists (select 1 from pg_constraint c
                         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                        where c.conrelid = x.tbl::regclass and c.contype = 'f'
                          and array_length(c.conkey, 1) = 1 and a.attname = x.col
                          and c.confrelid = x.ref::regclass and c.confdeltype = 'c')
  loop
    v_bad := v_bad || format('%s.%s does not cascade from %s', r.tbl, r.col, r.ref);
  end loop;

  if to_regprocedure('public.tg_organization_members_owner_present()') is not null then
    v_bad := v_bad || 'public.tg_organization_members_owner_present() already exists'::text;
  end if;
  for r in
    select t.tgname::text as n from pg_trigger t
     where t.tgrelid = 'public.organization_members'::regclass
       and t.tgname in ('organization_members_owner_present_upd', 'organization_members_owner_present_del',
                        'organization_members_owner_present_join_ins', 'organization_members_owner_present_join_upd')
    union all
    select c.conname::text from pg_constraint c
     where c.conrelid = 'public.organization_members'::regclass
       and c.conname in ('organization_members_owner_present_upd', 'organization_members_owner_present_del',
                         'organization_members_owner_present_join_ins', 'organization_members_owner_present_join_upd')
  loop
    v_bad := v_bad || format('the name %s is taken on organization_members', r.n);
  end loop;

  for r in
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where exists (select 1 from unnest(p.proconfig) c
                    where c like 'default\_transaction\_isolation=%' or c like 'transaction\_isolation=%')
  loop
    v_bad := v_bad || format('%s sets its own transaction isolation', r.fn);
  end loop;
  if exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) c
              where c like 'default\_transaction\_isolation=%') then
    v_bad := v_bad || 'a database or role setting sets default_transaction_isolation'::text;
  end if;
  if (select s.reset_val from pg_settings s where s.name = 'default_transaction_isolation') <> 'read committed' then
    v_bad := v_bad || 'the server''s default_transaction_isolation is not read committed'::text;
  end if;

  if cardinality(v_bad) > 0 then
    raise exception 'organization_owner_preflight: % difference(s); nothing was applied', cardinality(v_bad)
      using errcode = '55000',
            detail = array_to_string(v_bad, '; '),
            hint = 'organization_owner_preflight';
  end if;
end $pre$;

-- ═══ 2. The function ══════════════════════════════════════════════════════
create function public.tg_organization_members_owner_present()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_try integer := 0;
begin
  if tg_argv[0] = 'new' then
    v_org := new.organization_id;
  else
    v_org := old.organization_id;
  end if;

  -- The read below must see what committed while this waited for the lock.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'organization_owner_check_isolation'
      using errcode = '0A000',
            detail = 'A change to the owners or members of an organization is checked in a READ COMMITTED transaction only.';
  end if;

  loop
    exit when pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('organization_owner_present:' || v_org::text, 0));
    v_try := v_try + 1;
    if v_try >= 40 then
      raise exception 'organization_owner_check_busy'
        using errcode = '55P03',
              detail = 'Another change to the owners or members of this organization was being saved.',
              hint = 'Try again in a minute.';
    end if;
    perform pg_catalog.pg_sleep(0.05 + pg_catalog.random() * 0.1);
  end loop;

  -- A new statement, so a new snapshot: it is taken after the lock.
  if exists (select 1 from public.organization_members m
              where m.organization_id = v_org
                and m.accepted_at is not null
                and m.impersonation_expires_at is null)
     and not exists (select 1 from public.organization_members m
                      where m.organization_id = v_org
                        and m.role = 'owner'
                        and m.accepted_at is not null
                        and m.impersonation_expires_at is null) then
    raise exception 'organization_needs_owner'
      using errcode = 'P0001',
            constraint = 'organization_owner_present',
            schema = 'public',
            table = 'organization_members',
            detail = 'The change would leave an organization that has members with no owner.',
            hint = 'Transfer ownership first, or remove the other members.';
  end if;
  return null;
end;
$$;

alter function public.tg_organization_members_owner_present() owner to postgres;
revoke all on function public.tg_organization_members_owner_present() from public, anon, authenticated, service_role;

comment on function public.tg_organization_members_owner_present() is
  'organization_members_owner_present_* (0458): at commit, refuses (P0001 organization_needs_owner, constraint '
  'organization_owner_present) when the organization still has real members (accepted, not an "Act as" seat) '
  'and no real owner (0393''s definitions). Argument ''old'': a real owner row stopped being one; ''new'': a '
  'row became a real member. Takes a per-organization advisory lock first (try-lock loop, 55P03 '
  'organization_owner_check_busy after 40 tries), then reads in a new snapshot; READ COMMITTED only (0A000). '
  'Never 40001 or 40P01. SECURITY DEFINER with an empty search_path; no role holds EXECUTE.';

-- ═══ 3. The triggers ══════════════════════════════════════════════════════
create constraint trigger organization_members_owner_present_upd
  after update on public.organization_members
  deferrable initially deferred
  for each row
  when (old.role = 'owner' and old.accepted_at is not null and old.impersonation_expires_at is null
        and (new.role <> 'owner' or new.accepted_at is null or new.impersonation_expires_at is not null
             or new.organization_id <> old.organization_id))
  execute function public.tg_organization_members_owner_present('old');

create constraint trigger organization_members_owner_present_del
  after delete on public.organization_members
  deferrable initially deferred
  for each row
  when (old.role = 'owner' and old.accepted_at is not null and old.impersonation_expires_at is null)
  execute function public.tg_organization_members_owner_present('old');

create constraint trigger organization_members_owner_present_join_ins
  after insert on public.organization_members
  deferrable initially deferred
  for each row
  when (new.role <> 'owner' and new.accepted_at is not null and new.impersonation_expires_at is null
        and current_user in ('service_role', 'authenticated', 'anon'))
  execute function public.tg_organization_members_owner_present('new');

create constraint trigger organization_members_owner_present_join_upd
  after update on public.organization_members
  deferrable initially deferred
  for each row
  when (new.role <> 'owner' and new.accepted_at is not null and new.impersonation_expires_at is null
        and (old.accepted_at is null or old.impersonation_expires_at is not null
             or old.organization_id <> new.organization_id)
        and current_user in ('service_role', 'authenticated', 'anon'))
  execute function public.tg_organization_members_owner_present('new');

comment on trigger organization_members_owner_present_upd on public.organization_members is
  'At commit (0458): a real owner row was demoted, un-accepted, made an "Act as" seat or moved; the organization '
  'it left must not have real members and no real owner. Every role.';
comment on trigger organization_members_owner_present_del on public.organization_members is
  'At commit (0458): a real owner row was deleted (a cascade included); the organization must not have real '
  'members and no real owner. Every role. An emptied organization passes.';
comment on trigger organization_members_owner_present_join_ins on public.organization_members is
  'At commit (0458): an API role (service_role, authenticated, anon) inserted a real member that is not an owner; '
  'the organization must have a real owner. The table owner''s writers are not checked on this side.';
comment on trigger organization_members_owner_present_join_upd on public.organization_members is
  'At commit (0458): an API role made a row a real member that is not an owner (accepted, no longer a seat, or '
  'moved into the organization); the organization must have a real owner.';

reset lock_timeout;
