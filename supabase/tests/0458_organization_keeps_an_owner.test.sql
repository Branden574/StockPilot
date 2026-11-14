-- supabase/tests/0458_organization_keeps_an_owner.test.sql
-- pgTAP proof for migration 0458: no commit leaves an organization that has
-- real members with no real owner. A real member is an accepted row that is
-- not an "Act as" support seat; a real owner is a real member whose role is
-- owner (0393's definitions, word for word).
--
-- The rule runs at COMMIT (deferred constraint triggers), and a pgTAP file
-- never commits. So every write here runs inside ONE subtransaction together
-- with `set constraints all immediate`, which fires the queued checks there
-- and then: pg_temp.write_now for a refusal (inside throws_ok, so the undone
-- subtransaction takes the write with it) and pg_temp.try_now for a write
-- that must pass (always undone; it can read pg_locks before the undo). The
-- fixtures are inserted as postgres, which queues no check, so the file's
-- own transaction carries no queued event.
--
-- T.  Posture: the four constraint triggers (AFTER, FOR EACH ROW,
--     DEFERRABLE INITIALLY DEFERRED, enabled, the function and its argument,
--     the WHEN clauses); the function's md5, SECURITY DEFINER, empty
--     search_path, owner and EXECUTE list (nobody); the codes it raises
--     (never 40001 or 40P01); no function in any schema sets its own
--     transaction isolation; the bodies the rule works with are unchanged;
--     the comments name 0458; the one function body that writes memberships
--     and the roles that can write the table.
-- B.  A real owner row stops being one while a real member remains: refused
--     (P0001 organization_needs_owner, constraint organization_owner_present)
--     for the service role (demote, delete, un-accept, make a seat, move to
--     another organization with no activity row, an insert with on
--     conflict do update), a SECURITY DEFINER function owned by postgres, postgres
--     itself, and deleting the owner's user_profiles row directly. One
--     statement over two organizations, one of which keeps an owner: refused
--     whole, nothing applied. A support seat never counts as the owner.
-- J.  The join side: a row that becomes a real member (insert, completing a
--     row, a move) written by service_role or authenticated into an
--     organization with no real owner: refused. Into an organization with an
--     owner, a not-accepted row, a seat, and postgres's own writes: pass.
-- C.  What must keep working: the ownership transfer; demote then promote
--     again, and the transfer's shape by hand; organization delete with
--     members; deleting every member in one statement; deleting the only
--     owner's account when only a seat and a not-accepted row remain; one of
--     two owners' accounts; demoting one of two owners; deleting the only
--     owner's row when no other real member exists; creating an
--     organization then its owner then a member (sign-up order), and a
--     member then the owner in one transaction; seat insert and delete;
--     every non-owner change, which takes no advisory lock; changes in the
--     fixture with no owner row that are not a join.
-- D.  The account-deletion dry run (account_deletion_check, 0388) and the
--     real delete agree for a sole owner with staff, with a seat only, with a
--     not-accepted row only, and for one of two owners; the dry run leaves no
--     advisory lock and no queued check (the deferred check is discarded with
--     its subtransaction; the narrowed 0388 P8 / 0393 K13 invariant).
-- E.  The refusal's identity: SQLSTATE, message, constraint, detail, hint.
--
-- Two-session behaviour (the lock, 55P03, READ COMMITTED, GoTrue's own role
-- and a real COMMIT) is scripts/db-concurrency/0458_owner_present_races.sh.
-- begin/rollback: nothing leaks. Namespace 04580000, made-up data only.

begin;

select plan(74);

\set orgA  '\'04580000-0000-0000-0000-00000000000a\''
\set orgC  '\'04580000-0000-0000-0000-00000000000c\''
\set orgD  '\'04580000-0000-0000-0000-00000000000d\''
\set orgE  '\'04580000-0000-0000-0000-00000000000e\''
\set orgF  '\'04580000-0000-0000-0000-00000000000f\''
\set orgH  '\'04580000-0000-0000-0000-000000000011\''
\set orgN  '\'04580000-0000-0000-0000-000000000012\''
\set orgN2 '\'04580000-0000-0000-0000-000000000013\''
\set orgZ  '\'04580000-0000-0000-0000-000000000014\''
\set orgW  '\'04580000-0000-0000-0000-000000000015\''
\set oA    '\'04580000-0000-0000-0000-0000000000a0\''
\set sA    '\'04580000-0000-0000-0000-0000000000a1\''
\set mA    '\'04580000-0000-0000-0000-0000000000a2\''
\set oC1   '\'04580000-0000-0000-0000-0000000000c0\''
\set oC2   '\'04580000-0000-0000-0000-0000000000c1\''
\set sC    '\'04580000-0000-0000-0000-0000000000c2\''
\set oD    '\'04580000-0000-0000-0000-0000000000d0\''
\set pD    '\'04580000-0000-0000-0000-0000000000d1\''
\set seat  '\'04580000-0000-0000-0000-0000000000d2\''
\set oE    '\'04580000-0000-0000-0000-0000000000e0\''
\set pE    '\'04580000-0000-0000-0000-0000000000e1\''
\set oF    '\'04580000-0000-0000-0000-0000000000f0\''
\set sF    '\'04580000-0000-0000-0000-0000000000f1\''
\set oH    '\'04580000-0000-0000-0000-0000000000b0\''
\set aN2   '\'04580000-0000-0000-0000-0000000000b1\''
\set sN2   '\'04580000-0000-0000-0000-0000000000b2\''
\set pN2   '\'04580000-0000-0000-0000-0000000000b3\''
\set j1    '\'04580000-0000-0000-0000-0000000000b4\''
\set j2    '\'04580000-0000-0000-0000-0000000000b5\''
\set oW    '\'04580000-0000-0000-0000-0000000000b6\''
\set sW    '\'04580000-0000-0000-0000-0000000000b7\''

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- The write, then the queued checks, in one subtransaction, as p_as with the
-- JWT subject p_sub (PostgREST's shape). Raises whatever the write or a check
-- raises; when nothing is refused it raises XX458 so the write is undone
-- either way (throws_ok then reports the missing refusal).
create function pg_temp.write_now(p_as text, p_sub uuid, p_sql text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', p_as, true);
  perform set_config('role', p_as, true);
  execute p_sql;
  set constraints all immediate;
  raise exception using errcode = 'XX458', message = 'no refusal at commit';
end $$;
-- The same, always undone, answering 'ok:<rows>[:<check>]' or
-- '<sqlstate>:<message>[:<constraint>]'. p_check runs (as postgres) after the
-- queued checks and before the undo, so it sees their locks.
create function pg_temp.try_now(p_as text, p_sub uuid, p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_con text; v_n bigint; v_seen text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    set constraints all immediate;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX458', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_con = constraint_name;
  end;
  if v_state = 'XX458' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || v_msg || coalesce(':' || nullif(v_con, ''), '');
end $$;
-- The advisory locks this backend holds right now.
create function pg_temp.advisory() returns bigint language sql as $$
  select count(*) from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid()
$$;
-- The real owners of an organization, as a sorted list of user ids.
create function pg_temp.owners(p_org uuid) returns text language sql as $$
  select coalesce(string_agg(m.user_id::text, ',' order by m.user_id), '')
    from public.organization_members m
   where m.organization_id = p_org and m.role = 'owner'
     and m.accepted_at is not null and m.impersonation_expires_at is null
$$;
-- The dry run's answer, in short: deletable, or the refusal's constraint.
create function pg_temp.dry(p_user uuid) returns text language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('role', 'service_role', true);
  v := public.account_deletion_check(p_user);
  perform set_config('role', 'none', true);
  return case when (v ->> 'deletable')::boolean then 'deletable'
              else coalesce(v ->> 'constraint', v ->> 'reason') end;
end $$;
-- A SECURITY DEFINER writer owned by postgres (as the transfer is), in a
-- schema this file creates and the rollback removes.
create schema zz_t0458;
create function zz_t0458.demote(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.organization_members set role = 'admin' where organization_id = p_org and user_id = p_user;
end $$;
grant usage on schema zz_t0458 to service_role;
grant execute on function zz_t0458.demote(uuid, uuid) to service_role;

-- ══ Fixtures (as postgres: no check is queued) ════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:oA,  '0458-oa@test.local',  '{}'::jsonb), (:sA,  '0458-sa@test.local',  '{}'::jsonb),
  (:mA,  '0458-ma@test.local',  '{}'::jsonb), (:oC1, '0458-oc1@test.local', '{}'::jsonb),
  (:oC2, '0458-oc2@test.local', '{}'::jsonb), (:sC,  '0458-sc@test.local',  '{}'::jsonb),
  (:oD,  '0458-od@test.local',  '{}'::jsonb), (:pD,  '0458-pd@test.local',  '{}'::jsonb),
  (:seat,'0458-seat@test.local','{}'::jsonb), (:oE,  '0458-oe@test.local',  '{}'::jsonb),
  (:pE,  '0458-pe@test.local',  '{}'::jsonb), (:oF,  '0458-of@test.local',  '{}'::jsonb),
  (:sF,  '0458-sf@test.local',  '{}'::jsonb), (:oH,  '0458-oh@test.local',  '{}'::jsonb),
  (:aN2, '0458-an2@test.local', '{}'::jsonb), (:sN2, '0458-sn2@test.local', '{}'::jsonb),
  (:pN2, '0458-pn2@test.local', '{}'::jsonb), (:j1,  '0458-j1@test.local',  '{}'::jsonb),
  (:j2,  '0458-j2@test.local',  '{}'::jsonb), (:oW,  '0458-ow@test.local',  '{}'::jsonb),
  (:sW,  '0458-sw@test.local',  '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA,  '0458 A one owner',      '0458-a'),
  (:orgC,  '0458 C two owners',     '0458-c'),
  (:orgD,  '0458 D seat and pending','0458-d'),
  (:orgE,  '0458 E pending only',   '0458-e'),
  (:orgF,  '0458 F owner and seat', '0458-f'),
  (:orgH,  '0458 H seat only',      '0458-h'),
  (:orgN,  '0458 N empty',          '0458-n'),
  (:orgN2, '0458 N2 no owner',      '0458-n2'),
  (:orgZ,  '0458 Z empty',          '0458-z'),
  (:orgW,  '0458 W second',         '0458-w');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  -- A: the only owner, a staff member and a manager.
  (:orgA, :oA, 'owner', now(), null), (:orgA, :sA, 'staff', now(), null), (:orgA, :mA, 'manager', now(), null),
  -- C: two owners and a staff member.
  (:orgC, :oC1, 'owner', now(), null), (:orgC, :oC2, 'owner', now(), null), (:orgC, :sC, 'staff', now(), null),
  -- D: the only owner, a support seat and a member who has not accepted.
  (:orgD, :oD, 'owner', now(), null), (:orgD, :seat, 'owner', now(), now() + interval '1 hour'),
  (:orgD, :pD, 'staff', null, null),
  -- E: the only owner and a member who has not accepted.
  (:orgE, :oE, 'owner', now(), null), (:orgE, :pE, 'staff', null, null),
  -- F: the only owner, a staff member and a support seat (role owner).
  (:orgF, :oF, 'owner', now(), null), (:orgF, :sF, 'staff', now(), null),
  (:orgF, :seat, 'owner', now(), now() + interval '1 hour'),
  -- H: the only owner and a support seat.
  (:orgH, :oH, 'owner', now(), null), (:orgH, :seat, 'owner', now(), now() + interval '1 hour'),
  -- N2: a fixture with no owner row (for the join-side rows): an admin, a
  -- staff member, a member who has not accepted.
  (:orgN2, :aN2, 'admin', now(), null), (:orgN2, :sN2, 'staff', now(), null), (:orgN2, :pN2, 'staff', null, null),
  -- W: the only owner and a staff member (the second organization of B10).
  (:orgW, :oW, 'owner', now(), null), (:orgW, :sW, 'staff', now(), null);

-- ══ T. Posture ════════════════════════════════════════════════════════════
select is(
  (select string_agg(t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text || ':'
                     || t.tgdeferrable::text || ':' || t.tginitdeferred::text || ':' || (t.tgconstraint <> 0)::text || ':'
                     || t.tgfoid::regproc::text || ':' || encode(t.tgargs, 'escape'),
                     ',' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.organization_members'::regclass and t.tgname like 'organization\_members\_owner\_present\_%'),
  'organization_members_owner_present_del:9:O:true:true:true:tg_organization_members_owner_present:old\000,'
  'organization_members_owner_present_join_ins:5:O:true:true:true:tg_organization_members_owner_present:new\000,'
  'organization_members_owner_present_join_upd:17:O:true:true:true:tg_organization_members_owner_present:new\000,'
  'organization_members_owner_present_upd:17:O:true:true:true:tg_organization_members_owner_present:old\000',
  'T1: four constraint triggers on organization_members, AFTER (DELETE, INSERT, UPDATE, UPDATE) FOR EACH ROW, enabled, DEFERRABLE INITIALLY DEFERRED, one function; ''old'' on the owner side, ''new'' on the join side');
select is(
  (select string_agg(regexp_replace(pg_get_triggerdef(t.oid), '^.* WHEN ', ''), ' || ' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.organization_members'::regclass and t.tgname like 'organization\_members\_owner\_present\_%'),
  '(((old.role = ''owner''::text) AND (old.accepted_at IS NOT NULL) AND (old.impersonation_expires_at IS NULL))) EXECUTE FUNCTION tg_organization_members_owner_present(''old'')'
  ' || (((new.role <> ''owner''::text) AND (new.accepted_at IS NOT NULL) AND (new.impersonation_expires_at IS NULL) AND (CURRENT_USER = ANY (ARRAY[''service_role''::name, ''authenticated''::name, ''anon''::name])))) EXECUTE FUNCTION tg_organization_members_owner_present(''new'')'
  ' || (((new.role <> ''owner''::text) AND (new.accepted_at IS NOT NULL) AND (new.impersonation_expires_at IS NULL) AND ((old.accepted_at IS NULL) OR (old.impersonation_expires_at IS NOT NULL) OR (old.organization_id <> new.organization_id)) AND (CURRENT_USER = ANY (ARRAY[''service_role''::name, ''authenticated''::name, ''anon''::name])))) EXECUTE FUNCTION tg_organization_members_owner_present(''new'')'
  ' || (((old.role = ''owner''::text) AND (old.accepted_at IS NOT NULL) AND (old.impersonation_expires_at IS NULL) AND ((new.role <> ''owner''::text) OR (new.accepted_at IS NULL) OR (new.impersonation_expires_at IS NOT NULL) OR (new.organization_id <> old.organization_id)))) EXECUTE FUNCTION tg_organization_members_owner_present(''old'')',
  'T2: the WHEN clauses: a real owner row stops being one (every role); a row becomes a real member that is not an owner, written by service_role, authenticated or anon');
select is(
  (select c.contype::text || ':' || c.condeferrable::text || ':' || c.condeferred::text || '/' || count(*) over ()
     from pg_constraint c
    where c.conrelid = 'public.organization_members'::regclass and c.conname = 'organization_members_owner_present_upd'),
  't:true:true/1',
  'T3: each trigger is a constraint trigger (a pg_constraint row of type t, deferrable, initially deferred)');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || p.provolatile::text || '|'
          || (select string_agg(a::text, ',' order by a::text collate "C") from unnest(p.proacl) a)
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_members_owner_present()')),
  '6b65ec1b' || '7b964cd4733b927dbed25604|true|{"search_path=\"\""}|postgres|v|postgres=X/postgres',
  'T4: tg_organization_members_owner_present is 0458''s body, SECURITY DEFINER with an empty search_path, owned by postgres, EXECUTE held by nobody but its owner (a trigger function needs none to fire)');
select is(
  (select has_function_privilege('anon', p.oid, 'EXECUTE')::text || ',' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
          || ',' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_members_owner_present()')),
  'false,false,false',
  'T5: anon, authenticated and service_role cannot execute the trigger function');
select is(
  (select string_agg(distinct m[1], ',' order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = to_regprocedure('public.tg_organization_members_owner_present()'))
  || '/' || (select (p.prosrc !~* '40001|40p01|serialization_failure|deadlock_detected')::text
               from pg_proc p where p.oid = to_regprocedure('public.tg_organization_members_owner_present()')),
  '0A000,55P03,P0001/true',
  'T6: the function raises only 0A000 (not READ COMMITTED), 55P03 (busy) and P0001 (needs an owner), never 40001 or 40P01 (PostgREST retries those forever)');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ','), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where exists (select 1 from unnest(p.proconfig) c
                   where c like 'default\_transaction\_isolation=%' or c like 'transaction\_isolation=%'))
  || '/' || (select count(*) from pg_db_role_setting s, unnest(s.setconfig) c where c like 'default\_transaction\_isolation=%'),
  '/0',
  'T7: no function in any schema sets its own transaction isolation and no database or role setting does: the Data API and the auth server commit in READ COMMITTED, where the check reads after the lock');
select is(
  (select string_agg(md5(p.prosrc), ',' order by x.n)
     from (values (1, 'public._guard_organization_member_changes()'), (2, 'public.transfer_org_ownership(uuid,uuid,uuid)'),
                  (3, 'public.tg_auth_users_before_delete()'), (4, 'public.account_deletion_check(uuid)')) x(n, sig)
     join pg_proc p on p.oid = to_regprocedure(x.sig)),
  'b48c165e' || '5ff1ae0e8bbf159ab97c0d42,'
  || '777da8ae' || '49fdeabee55bb49f7259b9a2,'
  || '88fbc1c4' || 'a826334245675b24b3d23106,'
  || '15968336' || 'd457e56544f3a2421e807b35',
  'T8: the guard, the transfer, the account trigger and the dry run keep the bodies the rule was written against (0393, 0393, 0393, 0388)');
select is(
  (select coalesce(obj_description(to_regprocedure('public.tg_organization_members_owner_present()'), 'pg_proc') ~ '0458', false)::text)
  || '/' || (select bool_and(coalesce(obj_description(t.oid, 'pg_trigger') ~ '0458', false))::text || ':' || count(*)
               from pg_trigger t
              where t.tgrelid = 'public.organization_members'::regclass and t.tgname like 'organization\_members\_owner\_present\_%'),
  'true/true:4',
  'T9: the function and the four triggers say 0458 in their comments');
-- The join side is checked for the API roles (current_user). T10 and T11 pin
-- which function bodies write memberships and which roles can write the
-- table: a new writer or a new grant fails here and gets its own review
-- against this rule.
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ',' order by 1), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname <> 'zz_t0458' and n.nspname !~ '^pg_temp'
      and p.prosrc ~* '(insert\s+into|merge\s+into|update|delete\s+from)\s+(only\s+)?(public\.)?"?organization_members"?\M'),
  'public.transfer_org_ownership',
  'T10: one function body in any schema writes organization_members (transfer_org_ownership; this file''s own fixture schema aside)');
select is(
  (select string_agg(r.rolname, ',' order by r.rolname)
     from pg_roles r
    where has_table_privilege(r.oid, 'public.organization_members'::regclass, 'INSERT')
       or has_table_privilege(r.oid, 'public.organization_members'::regclass, 'UPDATE')),
  'anon,authenticated,pg_write_all_data,postgres,service_role,supabase_admin',
  'T11: the roles that can insert or update organization_members are the three API roles, the table owner, the superuser and the built-in write-all role');

-- ══ B. A real owner row stops being one ═══════════════════════════════════
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B1: the service role demotes the only owner while a staff member and a manager remain: refused at commit');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B2: the service role deletes the only owner''s membership: refused');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set accepted_at = null where organization_id = %L and user_id = %L', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B3: the service role clears the only owner''s accepted_at: refused (a row not accepted is not a real owner)');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set impersonation_expires_at = now() + interval ''1 hour'' where organization_id = %L and user_id = %L', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B4: the service role turns the only owner''s row into an "Act as" seat: refused (a seat is never the owner)');
select is(
  (select count(*) from public.member_activity where organization_id = :orgA and user_id = :oA)::text,
  '0',
  'B5a: the fixture of B5 has no member_activity row for the owner (an activity row would refuse the move first, 23503)');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set organization_id = %L where organization_id = %L and user_id = %L', :orgZ, :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B5: the service role moves the only owner''s row to another organization: refused for the organization it left');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''viewer'', now())'
                ' on conflict (organization_id, user_id) do update set role = excluded.role, accepted_at = excluded.accepted_at', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B6: an insert with on conflict do update that changes the only owner''s role, as the service role: refused');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$, format('select zz_t0458.demote(%L, %L)', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B7: a SECURITY DEFINER function owned by postgres, called by the service role, demotes the only owner: refused');
select throws_ok(
  format($q$select pg_temp.write_now('postgres', null, %L)$q$,
         format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgA, :oA)),
  'P0001', 'organization_needs_owner',
  'B8: the table owner (postgres) demotes the only owner: refused');
select throws_ok(
  format($q$select pg_temp.write_now('postgres', null, %L)$q$,
         format('delete from public.user_profiles where id = %L', :oA)),
  'P0001', 'organization_needs_owner',
  'B9: deleting the only owner''s user_profiles row (the membership cascades): refused');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set role = ''admin'' where user_id in (%L, %L)', :oC1, :oW)),
  'P0001', 'organization_needs_owner',
  'B10: one statement over two organizations, C keeping an owner and W losing its only one: refused whole');
select is(
  pg_temp.owners(:orgC) || '|' || pg_temp.owners(:orgW),
  '04580000-0000-0000-0000-0000000000c0,04580000-0000-0000-0000-0000000000c1|04580000-0000-0000-0000-0000000000b6',
  'B10b: after B10 nothing was applied to either organization');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgF, :oF)),
  'P0001', 'organization_needs_owner',
  'B12: a support seat never satisfies the rule: demoting F''s only real owner is refused although a seat with role owner remains');

-- ══ J. The join side ══════════════════════════════════════════════════════
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())', :orgN, :j1)),
  'P0001', 'organization_needs_owner',
  'J1: the service role inserts an accepted member into an organization with no member and no owner: refused');
select throws_ok(
  format($q$select pg_temp.write_now('authenticated', %L, %L)$q$, :aN2,
         format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())', :orgN2, :j1)),
  'P0001', 'organization_needs_owner',
  'J2: an admin (signed in) of an organization that has members and no owner inserts an accepted member: refused');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())'
                ' on conflict (organization_id, user_id) do update set accepted_at = excluded.accepted_at', :orgN2, :pN2)),
  'P0001', 'organization_needs_owner',
  'J3: the acceptance upsert completes a not-accepted row in an organization with no owner: refused (an update that makes a real member)');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set organization_id = %L where organization_id = %L and user_id = %L', :orgN, :orgA, :sA)),
  'P0001', 'organization_needs_owner',
  'J4: the service role moves a real member into an organization with no owner: refused');
select is(
  pg_temp.try_now('postgres', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())', :orgN, :j1),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'J5: the table owner''s own insert (hand SQL, the race fixtures, seeds run as postgres) is not checked on the join side: passes, no lock taken');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())', :orgA, :j1),
    'select pg_temp.advisory()'),
  'ok:1:1',
  'J6: the service role inserts an accepted member into an organization with an owner: passes, after one advisory lock');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role) values (%L, %L, ''staff'')', :orgN, :j1),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'J7: a row that is not accepted is not a real member: inserting one into an organization with no owner passes, no lock');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values (%L, %L, ''owner'', now(), now() + interval ''1 hour'')', :orgN2, :j2),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'J8: a support seat never trips the rule: starting one in an organization with members and no owner passes, no lock');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''owner'', now())', :orgN, :j1),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'J9: the first member of a new organization is its owner: an owner row is never checked on the join side, no lock');

-- ══ C. What keeps working ═════════════════════════════════════════════════
select is(
  pg_temp.try_now('service_role', null,
    format('select public.transfer_org_ownership(%L, %L, %L)', :orgA, :oA, :sA),
    format('select pg_temp.owners(%L)', :orgA)),
  'ok:1:04580000-0000-0000-0000-0000000000a1',
  'C1: transfer_org_ownership (demote, then promote, in one transaction) passes at commit; exactly one owner, the target');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L;'
           ' update public.organization_members set role = ''owner'' where organization_id = %L and user_id = %L', :orgA, :oA, :orgA, :oA),
    format('select pg_temp.owners(%L)', :orgA)),
  'ok:1:04580000-0000-0000-0000-0000000000a0',
  'C1b: demote the only owner, then promote them again, in one transaction: passes');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set role = ''owner'' where organization_id = %L and user_id = %L;'
           ' update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgA, :mA, :orgA, :oA),
    format('select pg_temp.owners(%L)', :orgA)),
  'ok:1:04580000-0000-0000-0000-0000000000a2',
  'C1c: the transfer''s shape by hand (promote the manager, demote the owner) in one transaction: passes');
select is(
  pg_temp.try_now('service_role', null,
    format('delete from public.organizations where id = %L', :orgA),
    format('select count(*) from public.organization_members where organization_id = %L', :orgA)),
  'ok:1:0',
  'C2: deleting an organization that has members (its owner row cascades and queues a check): passes, no member left');
select is(
  pg_temp.try_now('postgres', null,
    format('delete from auth.users where id = %L', :oD),
    format('select count(*) || ''/'' || count(*) filter (where accepted_at is not null and impersonation_expires_at is null) from public.organization_members where organization_id = %L', :orgD)),
  'ok:1:2/0',
  'C3: deleting the only owner''s account when the only other rows are a seat and a member who has not accepted: passes (0393 allows it; no real member is left)');
select is(
  pg_temp.try_now('postgres', null,
    format('delete from auth.users where id = %L', :oC1),
    format('select pg_temp.owners(%L)', :orgC)),
  'ok:1:04580000-0000-0000-0000-0000000000c1',
  'C4: deleting one of two owners'' accounts: passes, the other owner remains');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgC, :oC2),
    format('select pg_temp.owners(%L)', :orgC)),
  'ok:1:04580000-0000-0000-0000-0000000000c0',
  'C5: demoting one of two owners: passes');
select is(
  pg_temp.try_now('service_role', null,
    format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgE, :oE)),
  'ok:1',
  'C6: deleting the only owner''s row when no other real member exists (only a member who has not accepted): passes');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organizations (id, name, slug) values (%L, ''0458 new'', ''0458-new'');'
           ' insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''owner'', now());'
           ' insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())',
           '04580000-0000-0000-0000-0000000000ff', '04580000-0000-0000-0000-0000000000ff', :j1, '04580000-0000-0000-0000-0000000000ff', :j2),
    format('select pg_temp.owners(%L)', '04580000-0000-0000-0000-0000000000ff')),
  'ok:1:04580000-0000-0000-0000-0000000000b4',
  'C8: workspace creation and sign-up order (the organization, its owner, then a member) as the service role: passes');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now());'
           ' insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''owner'', now())', :orgN, :j2, :orgN, :j1)),
  'ok:1',
  'C8b: a member, then the owner, in one transaction: passes (the check runs at commit)');
select is(
  pg_temp.try_now('service_role', null,
    format('delete from public.organization_members where organization_id = %L', :orgA),
    'select pg_temp.advisory()'),
  'ok:3:1',
  'C9: deleting every member of an organization in one statement (the perf-lab teardown): passes; only the owner row queued a check');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values (%L, %L, ''owner'', now(), now() + interval ''1 hour'');'
           ' delete from public.organization_members where organization_id = %L and user_id = %L and impersonation_expires_at is not null', :orgA, :j2, :orgF, :seat),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'C7: starting and ending an "Act as" seat queue no check and take no lock');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set role = ''viewer'', is_delivery_driver = true, all_warehouses = true where organization_id = %L and user_id = %L;'
           ' delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sA, :orgA, :mA),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'C10: changing and removing members who are not owners takes no advisory lock');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgC, :oC2),
    'select pg_temp.advisory()'),
  'ok:1:1',
  'C10b: the control: an owner change takes exactly one advisory lock (so C10 and J5 would see one)');
select is(
  pg_temp.try_now('authenticated', :aN2,
    format('update public.organization_members set role = ''viewer'' where organization_id = %L and user_id = %L', :orgN2, :sN2),
    'select pg_temp.advisory()')
  || ' | ' ||
  pg_temp.try_now('authenticated', :aN2,
    format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgN2, :sN2),
    'select pg_temp.advisory()'),
  'ok:1:0 | ok:1:0',
  'C11: in the fixture with no owner row, an admin''s role change and removal queue no check and take no lock');

-- ══ D. The dry run and the real delete agree ══════════════════════════════
select is(
  pg_temp.dry(:oA) || '=' || pg_temp.try_now('postgres', null, format('delete from auth.users where id = %L', :oA))
  || ', ' || pg_temp.dry(:oH) || '=' || pg_temp.try_now('postgres', null, format('delete from auth.users where id = %L', :oH))
  || ', ' || pg_temp.dry(:oE) || '=' || pg_temp.try_now('postgres', null, format('delete from auth.users where id = %L', :oE))
  || ', ' || pg_temp.dry(:oC1) || '=' || pg_temp.try_now('postgres', null, format('delete from auth.users where id = %L', :oC1)),
  'organization_last_owner=P0001:last_owner:organization_last_owner, deletable=ok:1, deletable=ok:1, deletable=ok:1',
  'D1: the dry run and the real delete (then set constraints all immediate) agree: the only owner with staff is refused by 0393''s rule in both; the only owner with a seat only, with a member who has not accepted only, and one of two owners go in both');
select is(
  pg_temp.try_now('service_role', null,
    format('select public.account_deletion_check(%L)', :oH),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'D2: the dry run (deletable, its delete queued an owner check inside its subtransaction) leaves no advisory lock, and set constraints all immediate after it fires nothing: the queued check was discarded with the subtransaction');
select is(
  pg_temp.try_now('postgres', null,
    format('delete from auth.users where id = %L', :oH),
    'select pg_temp.advisory()'),
  'ok:1:1',
  'D3: the control: the real delete of the same account queues the check, which takes the lock at commit');
select is(
  pg_temp.try_now('service_role', null,
    format('select public.account_deletion_check(%L)', :oA),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'D4: the dry run that answers last_owner also leaves no lock and no queued check');

-- ══ E. The refusal ════════════════════════════════════════════════════════
create function pg_temp.refusal(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_con text; v_det text; v_hint text; v_sch text; v_tbl text;
begin
  begin
    perform set_config('role', 'service_role', true);
    execute p_sql;
    set constraints all immediate;
    raise exception using errcode = 'XX458', message = 'no refusal';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_con = constraint_name,
                            v_det = pg_exception_detail, v_hint = pg_exception_hint, v_sch = schema_name, v_tbl = table_name;
  end;
  return concat_ws('|', v_state, v_msg, v_con, v_sch, v_tbl, v_det, v_hint);
end $$;
select is(
  pg_temp.refusal(format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :oA)),
  'P0001|organization_needs_owner|organization_owner_present|public|organization_members|The change would leave an organization that has members with no owner.|Transfer ownership first, or remove the other members.',
  'E1: the refusal is P0001, message organization_needs_owner, constraint organization_owner_present (not 0393''s organization_last_owner), with a plain detail and hint');
select is(
  pg_temp.owners(:orgA) || '|' || (select count(*) from public.organization_members where organization_id = :orgA)::text,
  '04580000-0000-0000-0000-0000000000a0|3',
  'E2: every refusal and every passing write above was undone: organization A is as the fixture made it');

-- ══ More B rows: other writers and shapes ═════════════════════════════════
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L;'
                ' update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgC, :oC1, :orgC, :oC2)),
  'P0001', 'organization_needs_owner',
  'B13: demoting both owners of a two-owner organization in one transaction: refused');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set accepted_at = null where organization_id = %L and user_id = %L', :orgN2, :aN2)
         || format('; update public.organization_members set accepted_at = now() where organization_id = %L and user_id = %L', :orgN2, :aN2)),
  'P0001', 'organization_needs_owner',
  'J10: un-accepting then accepting again a member of an organization with no owner, as the service role: the second write is a join, refused');
select is(
  pg_temp.try_now('postgres', null,
    format('update public.organization_members set accepted_at = now() where organization_id = %L and user_id = %L', :orgN2, :pN2),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'J11: postgres completing a row in an organization with no owner is not checked (the join side binds the API roles)');
select is(
  pg_temp.try_now('authenticated', :oA,
    format('update public.organization_members set role = ''viewer'' where organization_id = %L and user_id = %L', :orgA, :sA)),
  'ok:1',
  'C12: the owner (signed in) changes a staff member''s role, as the Team page does: passes');
select is(
  pg_temp.try_now('authenticated', :oA,
    format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgA, :oA)),
  '42501:cannot demote the owner via direct update',
  'C13: the guard still refuses a signed-in owner demotion first, in the statement (unchanged)');
select is(
  pg_temp.try_now('authenticated', :oA,
    format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sA)),
  'ok:1',
  'C14: the owner (signed in) removes a staff member: passes');
select is(
  pg_temp.try_now('service_role', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())'
           ' on conflict (organization_id, user_id) do update set accepted_at = excluded.accepted_at', :orgD, :pD),
    'select pg_temp.advisory()'),
  'ok:1:1',
  'C15: the acceptance upsert completes a not-accepted row in an organization with an owner: passes, after one lock');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set impersonation_expires_at = null where organization_id = %L and user_id = %L', :orgH, :seat),
    format('select pg_temp.owners(%L)', :orgH)),
  'ok:1:04580000-0000-0000-0000-0000000000b0,04580000-0000-0000-0000-0000000000d2',
  'C16: a seat made a real owner row: passes (an owner row never trips the join side)');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values (%L, %L, ''admin'', now(), now() + interval ''1 hour'')', :orgN, :j2)
         || format('; update public.organization_members set impersonation_expires_at = null where organization_id = %L and user_id = %L', :orgN, :j2)),
  'P0001', 'organization_needs_owner',
  'J12: a seat row that is made a real member that is not an owner, in an organization with no owner: refused');
select is(
  pg_temp.try_now('service_role', null,
    format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :oA)
    || format('; delete from public.organization_members where organization_id = %L', :orgA)),
  'ok:2',
  'C17: the owner leaves, then every other member is removed, in one transaction: passes (an emptied organization keeps nothing to own)');
select is(
  pg_temp.try_now('service_role', null,
    format('delete from public.organization_members where organization_id in (%L, %L)', :orgA, :orgC),
    'select pg_temp.advisory()'),
  'ok:6:2',
  'C18: emptying two organizations in one statement: passes; one lock per organization that had an owner row');
select is(
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('public', 'auth') and c.condeferrable
      and not (c.conrelid = 'public.organization_members'::regclass and c.contype = 't'
               and c.conname like 'organization\_members\_owner\_present\_%'))::text
  || '/' || (select count(*) from pg_constraint c
              where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass) and c.condeferrable)::text,
  '0/0',
  'K: nothing else in public or auth is deferrable, and no key that references a user is (0388 P8 and 0393 K13, narrowed by name)');
select is(
  pg_temp.try_now('anon', null,
    format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, ''staff'', now())', :orgN, :j1))
  ~ '^42501:',
  true,
  'J13: anon cannot insert a membership at all (row rules), whatever the join side would say');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set organization_id = %L where organization_id = %L and user_id = %L', :orgZ, :orgC, :oC1),
    format('select pg_temp.owners(%L) || ''/'' || pg_temp.owners(%L)', :orgC, :orgZ)),
  'ok:1:04580000-0000-0000-0000-0000000000c1/04580000-0000-0000-0000-0000000000c0',
  'C19: moving one of two owners to an empty organization passes: C keeps an owner, and Z gains one');
select is(
  pg_temp.try_now('service_role', null,
    format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgH, :oH),
    format('select pg_temp.owners(%L) || ''/'' || count(*) from public.organization_members where organization_id = %L', :orgH, :orgH)),
  'ok:1:/1',
  'C20: removing the only owner of an organization whose only other row is a seat passes (no real member is left; the seat stays and is not counted)');
select throws_ok(
  format($q$select pg_temp.write_now('service_role', null, %L)$q$,
         format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L', :orgH, :oH)),
  'P0001', 'organization_needs_owner',
  'B14: demoting the only owner whose only other row is a seat is refused: the demoted person is still a real member, and the seat is not an owner');
select is(
  pg_temp.try_now('service_role', null,
    format('update public.organization_members set role = ''owner'' where organization_id = %L and user_id = %L', :orgN2, :sN2),
    'select pg_temp.advisory()'),
  'ok:1:0',
  'C21: promoting a member to owner in an organization with no owner passes and takes no lock');
select is(
  pg_temp.try_now('service_role', null,
    format('select public.transfer_org_ownership(%L, %L, %L)', :orgC, :oC1, :sC),
    format('select pg_temp.owners(%L)', :orgC)),
  'ok:1:04580000-0000-0000-0000-0000000000c1,04580000-0000-0000-0000-0000000000c2',
  'C22: a transfer in a two-owner organization: passes');
select is(
  pg_temp.try_now('postgres', null, format('delete from public.organizations where id in (%L, %L, %L)', :orgA, :orgC, :orgF)),
  'ok:3',
  'C23: deleting three organizations in one statement: passes');
select is(
  pg_temp.owners(:orgC) || '|' || pg_temp.owners(:orgH) || '|' || pg_temp.owners(:orgN2),
  '04580000-0000-0000-0000-0000000000c0,04580000-0000-0000-0000-0000000000c1|04580000-0000-0000-0000-0000000000b0|',
  'E3: the fixtures are unchanged after every row (each write was undone)');

select * from finish();
rollback;
