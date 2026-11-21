-- supabase/tests/0473_membership_rows_added_by_the_server.test.sql
-- Proves migration 0473: a membership row (public.organization_members) is
-- added by the server only, in two layers that each stand alone (the data
-- API roles hold no INSERT; a BEFORE INSERT trigger refuses a row inserted
-- as either role); an existing row's account, organization and acceptance
-- are not written by an API caller; and every write the app makes works.
--
-- WHAT IS WORTH PINNING
--   1. Privileges and catalog: anon and authenticated hold no INSERT on the
--      table or on any column of it; authenticated keeps SELECT, UPDATE and
--      DELETE; service_role keeps all four; the four policies are 0140's and
--      0217's text, the insert one still there (0473 leaves it on purpose);
--      the table's comment says so; the 0393 guard is bound and enabled; the
--      new trigger is bound BEFORE INSERT for each row, enabled, and fires
--      after the guard; its function runs with the caller's rights (not
--      SECURITY DEFINER), has the body 0473 creates (by md5), an empty
--      search_path and EXECUTE for no API role; the one function whose
--      definition names a write of the table is transfer_org_ownership
--      (every schema, SQL-standard bodies included), and no view that anon
--      or authenticated may write through reads the table, directly or
--      through another view.
--   2. The first layer, the privilege: an owner, an admin, a manager, a
--      staff member, a viewer, a live act-as seat, an invitation not
--      accepted, an account with no membership, a token with no account and
--      a signed-out caller are each refused by its exact message, in every
--      statement shape that can add a row (one row, several, INSERT ...
--      SELECT, both upsert forms, MERGE).
--   3. No API caller writes a row's account, organization or acceptance:
--      each of user_id, organization_id, accepted_at (set, changed,
--      cleared), invited_by, invited_at, impersonation_expires_at, id and
--      created_at is refused by the 0393 guard's exact message for an admin
--      and an owner; a manager, a staff member, an invitation not accepted, a
--      token with no account and a signed-out caller change no row.
--   4. The second layer, the trigger: with INSERT handed to the role for the
--      length of one undone block, so that the privilege is out of the way,
--      an owner, an admin, a manager, a signed-out caller and a token with
--      no account are still refused, by the trigger's exact message, for a
--      plain row, both upsert forms and MERGE; the 0393 guard, which fires
--      first, still refuses an owner row and an act-as seat by its own
--      messages; a row inserted through a view that postgres owns is refused
--      too (the statement still runs as the caller's role); SECURITY DEFINER
--      code called by a signed-in member still adds a row (it runs as its
--      owner).
--   5. Everything the app does works. Through the service role: workspace
--      creation and provisioning (an owner row), invitation acceptance in
--      the app's upsert shape (a new row, and a row not yet accepted
--      completed), an act-as seat written and removed, ownership transfer.
--      With an admin's own token: an invitation, a role change in the web's
--      and the phone's shape, the delivery-driver flag, the all-warehouses
--      flag both ways, a warehouse assignment, removing a member; an owner
--      changes a role too. A member removes their own row. Deleting an
--      account takes its membership rows with it. Members read their
--      organization's rows.
--   6. The header's rollback lines, both forms. The second form runs a real
--      DROP TRIGGER, which on this platform asks for locks on the auth,
--      storage and realtime tables; it runs with a 500 ms lock_timeout inside
--      its undone block and is SKIPPED, not failed, when one of those tables
--      is busy (another session on a shared database), so it never stalls a
--      run. Its lock footprint is measured outside this file.
--
-- WHAT THIS FILE CANNOT SEE: a write of the table that a function builds
-- from pieces at run time (dynamic SQL), and a function in a language whose
-- body is not SQL text. The scan in section 1 reads each function's whole
-- definition, as written.
--
-- Every assertion runs its statement inside a block that is undone, so each
-- starts from the same rows. No assertion reads the clock: the only times
-- are now(), fixed for the transaction. Namespace a0473000. Every value is
-- made up. Wrapped in begin/rollback: nothing leaks. Run via
-- `supabase test db` after `supabase db reset`.

begin;

select plan(82);

\set orgA '\'a0473000-0000-0000-0000-0000000000a1\''
\set orgC '\'a0473000-0000-0000-0000-0000000000d1\''
\set orgN '\'a0473000-0000-0000-0000-0000000000e1\''
\set whA '\'a0473000-0000-0000-0000-0000000000f1\''
\set ownerA '\'a0473000-0000-0000-0000-0000000000c1\''
\set adminA '\'a0473000-0000-0000-0000-0000000000c2\''
\set managerA '\'a0473000-0000-0000-0000-0000000000c3\''
\set staffA '\'a0473000-0000-0000-0000-0000000000c4\''
\set viewerA '\'a0473000-0000-0000-0000-0000000000c5\''
\set pendingA '\'a0473000-0000-0000-0000-0000000000c6\''
\set seatA '\'a0473000-0000-0000-0000-0000000000c7\''
\set ownerC '\'a0473000-0000-0000-0000-0000000000c8\''
\set memberC '\'a0473000-0000-0000-0000-0000000000c9\''
\set nobody '\'a0473000-0000-0000-0000-0000000000ca\''

\set denied '42501:permission denied for table organization_members'
\set guarded '42501:only role, is_delivery_driver and all_warehouses can change on a membership'
\set by_server '42501:Membership rows are added by the server.'
\set hand_back 'grant insert on table public.organization_members to anon, authenticated'

insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,   'a-owner-members@test.local',   '{"full_name": "Members Owner A"}'::jsonb),
  (:adminA,   'a-admin-members@test.local',   '{"full_name": "Members Admin A"}'::jsonb),
  (:managerA, 'a-manager-members@test.local', '{"full_name": "Members Manager A"}'::jsonb),
  (:staffA,   'a-staff-members@test.local',   '{"full_name": "Members Staff A"}'::jsonb),
  (:viewerA,  'a-viewer-members@test.local',  '{"full_name": "Members Viewer A"}'::jsonb),
  (:pendingA, 'a-pending-members@test.local', '{"full_name": "Members Pending A"}'::jsonb),
  (:seatA,    'act-as-members@test.local',    '{"full_name": "Members Act As"}'::jsonb),
  (:ownerC,   'c-owner-members@test.local',   '{"full_name": "Members Owner C"}'::jsonb),
  (:memberC,  'c-staff-members@test.local',   '{"full_name": "Members Staff C"}'::jsonb),
  (:nobody,   'nobody-members@test.local',    '{"full_name": "Members Nobody"}'::jsonb);

-- A has every kind of row; C is another organization; N has no member yet.
insert into public.organizations (id, name, slug) values
  (:orgA, 'Members Org A', 'a0473000-org-a'),
  (:orgC, 'Members Org C', 'a0473000-org-c'),
  (:orgN, 'Members Org N', 'a0473000-org-n');
insert into public.warehouses (id, organization_id, name, code) values
  (:whA, :orgA, 'Members Warehouse A', 'A0473');
insert into public.organization_members
  (organization_id, user_id, role, accepted_at, impersonation_expires_at, invited_by, invited_at) values
  (:orgA, :ownerA,   'owner',   now(), null, null, null),
  (:orgA, :adminA,   'admin',   now(), null, null, null),
  (:orgA, :managerA, 'manager', now(), null, null, null),
  (:orgA, :staffA,   'staff',   now(), null, :ownerA, now()),
  (:orgA, :viewerA,  'viewer',  now(), null, null, null),
  -- An invitation not accepted.
  (:orgA, :pendingA, 'staff',   null,  null, null, null),
  -- A live act-as seat.
  (:orgA, :seatA,    'owner',   now(), now() + interval '1 hour', null, null),
  (:orgC, :ownerC,   'owner',   now(), null, null, null),
  (:orgC, :memberC,  'staff',   now(), null, null, null);

-- Runs p_sql as role p_as with p_sub as the token's account, inside a block
-- that is always undone. Answers 'ok:<rows>' (and ':<what p_check read>',
-- read as the test's own role before the undo), or '<SQLSTATE>:<message>'.
-- p_prep runs first, as the test's own role, inside the same block.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_check text default null, p_prep text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX473', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state = 'XX473' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || v_msg;
end $$;

-- The rows of the fixture, for "nothing changed".
create function pg_temp.rows_now() returns text language sql as $$
  select md5(string_agg(to_jsonb(m)::text, '|' order by m.organization_id, m.user_id)) || '/' || count(*)::text
    from public.organization_members m
   where m.organization_id in ('a0473000-0000-0000-0000-0000000000a1', 'a0473000-0000-0000-0000-0000000000d1',
                               'a0473000-0000-0000-0000-0000000000e1')
$$;
create temp table rows_at_start as select pg_temp.rows_now() as fingerprint;

-- An accepted staff row for an account, in an organization.
\set add_row 'insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, %L, now())'

-- ═══ 1. Privileges and catalog ══════════════════════════════════════════════

select is(
  has_table_privilege('anon', 'public.organization_members', 'insert')::text || '|'
  || has_table_privilege('authenticated', 'public.organization_members', 'insert')::text,
  'false|false',
  '0473/1: anon and authenticated hold no INSERT on organization_members');

select is(
  (select count(*)::int
     from pg_attribute a, (values ('anon'), ('authenticated')) r(role_name)
    where a.attrelid = 'public.organization_members'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege(r.role_name, a.attrelid, a.attnum, 'insert')),
  0,
  '0473/2: nor INSERT on any column of it');

select is(
  has_table_privilege('authenticated', 'public.organization_members', 'select')::text || '|'
  || has_table_privilege('authenticated', 'public.organization_members', 'update')::text || '|'
  || has_table_privilege('authenticated', 'public.organization_members', 'delete')::text,
  'true|true|true',
  '0473/3: authenticated keeps SELECT, UPDATE and DELETE');

select is(
  has_table_privilege('service_role', 'public.organization_members', 'select')::text || '|'
  || has_table_privilege('service_role', 'public.organization_members', 'insert')::text || '|'
  || has_table_privilege('service_role', 'public.organization_members', 'update')::text || '|'
  || has_table_privilege('service_role', 'public.organization_members', 'delete')::text,
  'true|true|true|true',
  '0473/4: service_role keeps SELECT, INSERT, UPDATE and DELETE');

select is(
  (select string_agg(p.polname || ' ' || p.polcmd::text || ' ' || p.polpermissive::text || ' '
                     || (select string_agg(pg_get_userbyid(x), ',' order by 1) from unnest(p.polroles) x)
                     || ' USING ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-')
                     || ' CHECK ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'),
                     E'\n' order by p.polname)
     from pg_policy p where p.polrelid = 'public.organization_members'::regclass),
  $pol$organization_members_delete d true authenticated USING ((user_id = auth.uid()) OR ( SELECT has_org_role(organization_members.organization_id, 'admin'::text) AS has_org_role)) CHECK -
organization_members_insert a true authenticated USING - CHECK ( SELECT has_org_role(organization_members.organization_id, 'admin'::text) AS has_org_role)
organization_members_select r true authenticated USING ( SELECT is_org_member(organization_members.organization_id) AS is_org_member) CHECK -
organization_members_update w true authenticated USING ( SELECT has_org_role(organization_members.organization_id, 'admin'::text) AS has_org_role) CHECK ( SELECT has_org_role(organization_members.organization_id, 'admin'::text) AS has_org_role)$pol$,
  '0473/5: the table''s four policies are 0140''s and 0217''s text, for authenticated only; the insert one is still there, left on purpose and unused');

select ok(
  obj_description('public.organization_members'::regclass, 'pg_class') ~ '0473'
  and obj_description('public.organization_members'::regclass, 'pg_class') ~ 'organization_members_insert is not in use'
  and obj_description('public.organization_members'::regclass, 'pg_class') ~ 'added by the server only'
  and obj_description('public.organization_members'::regclass, 'pg_class') ~ 'trg_zz_organization_members_added_by_server',
  '0473/6: the table''s comment says rows are added by the server only, names the trigger, and says the insert policy is not in use');

select is(
  (select t.tgtype::text || '/' || t.tgenabled::text || '/' || p.prosecdef::text || '/' || pg_get_userbyid(p.proowner)
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.organization_members'::regclass and t.tgname = 'organization_members_role_guard'
      and p.oid = to_regprocedure('public._guard_organization_member_changes()')),
  '31/O/true/postgres',
  '0473/7: the 0393 guard is bound BEFORE INSERT OR UPDATE OR DELETE for each row and enabled (its body is pinned by 0393''s own test)');

select is(
  (select t.tgtype::text || '/' || t.tgenabled::text || '/' || (t.tgqual is null)::text || '/' || t.tgfoid::regprocedure::text
     from pg_trigger t
    where t.tgrelid = 'public.organization_members'::regclass and t.tgname = 'trg_zz_organization_members_added_by_server'),
  '7/O/true/tg_membership_rows_added_by_server()',
  '0473/8: the new trigger is bound BEFORE INSERT for each row, with no WHEN clause, enabled, to its function');

-- BEFORE row triggers fire in the byte order of their names.
select is(
  (select string_agg(t.tgname::text, ' < ' order by t.tgname::text collate "C")
     from pg_trigger t
    where t.tgrelid = 'public.organization_members'::regclass and not t.tgisinternal
      and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4),
  'organization_members_role_guard < trg_zz_organization_members_added_by_server',
  '0473/9: the table''s BEFORE INSERT row triggers are the 0393 guard and the new one, and the guard fires first');

select is(
  (select p.prosecdef::text || '|' || md5(p.prosrc) || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|' || pg_get_userbyid(p.proowner) || '|'
          || l.lanname::text || '|' || p.prorettype::regtype::text || '|'
          || has_function_privilege('public', p.oid, 'execute')::text || '|' || has_function_privilege('anon', p.oid, 'execute')::text || '|'
          || has_function_privilege('authenticated', p.oid, 'execute')::text || '|' || has_function_privilege('service_role', p.oid, 'execute')::text
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure('public.tg_membership_rows_added_by_server()')),
  'false|55e3edc02cb3bccdf9c0fa97a3c10555|search_path=""|postgres|plpgsql|trigger|false|false|false|false',
  '0473/10: its function is not SECURITY DEFINER, has the body 0473 creates (md5), an empty search_path, is owned by postgres, and no API role may call it');

-- Every function and procedure, in every schema, whose whole definition (a
-- SQL-standard body included) names a write of the table. A write built
-- from pieces at run time is not seen.
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname || ':' || has_function_privilege('anon', p.oid, 'execute')::text
                              || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text
                              || ':' || has_function_privilege('service_role', p.oid, 'execute')::text,
                              ',' order by n.nspname, p.proname), 'none')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p')
      and n.nspname !~ '^pg_temp'
      and pg_get_functiondef(p.oid) ~* '(insert\s+into|update|merge\s+into|delete\s+from|truncate(\s+table)?|copy)\s+(only\s+)?(public\.)?"?organization_members"?\M'),
  'public.transfer_org_ownership:false:false:true',
  '0473/11: the one function, in any schema, whose definition names a write of the table is transfer_org_ownership, and neither anon nor authenticated may call it');

-- Every view and materialized view that reads the table, directly or
-- through another view.
select is(
  (with recursive readers(oid) as (
     select 'public.organization_members'::regclass::oid
     union
     select w.ev_class
       from readers r
       join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = r.oid and d.classid = 'pg_rewrite'::regclass
       join pg_rewrite w on w.oid = d.objid
   )
   select count(*)::int
     from readers r join pg_class c on c.oid = r.oid
    where c.relkind in ('v', 'm')
      and (has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'insert')
           or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'update'))),
  0,
  '0473/12: no view over organization_members, direct or through another view, can be written through by anon or authenticated');

-- ═══ 2. The first layer: the privilege ═════════════════════════════════════

select is(pg_temp.attempt('authenticated', :ownerA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/13: an owner cannot add a membership row');
select is(pg_temp.attempt('authenticated', :adminA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/14: an admin cannot add a membership row');
select is(pg_temp.attempt('authenticated', :managerA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/15: a manager cannot add a membership row');
select is(pg_temp.attempt('authenticated', :staffA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/16: a staff member cannot add a membership row');
select is(pg_temp.attempt('authenticated', :viewerA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/17: a viewer cannot add a membership row');
select is(pg_temp.attempt('authenticated', :seatA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/18: a live act-as seat cannot add a membership row with its own token');
select is(pg_temp.attempt('authenticated', :pendingA, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/19: an account whose invitation is not accepted cannot add a membership row');
select is(pg_temp.attempt('authenticated', :nobody, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/20: an account with no membership cannot add itself');
select is(pg_temp.attempt('authenticated', null, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/21: a token with no account cannot add a membership row');
select is(pg_temp.attempt('anon', null, format(:'add_row', :orgA, :nobody, 'staff')), :'denied',
  '0473/22: a signed-out caller cannot add a membership row');

-- Every statement shape that can add a row, as an admin and as an owner.
select is(pg_temp.attempt('authenticated', :adminA, format(:'add_row', :orgA, :memberC, 'staff')), :'denied',
  '0473/23: an admin cannot add a row, whatever account it names');
select is(pg_temp.attempt('authenticated', :adminA, format(:'add_row', :orgC, :adminA, 'staff')), :'denied',
  '0473/24: an admin cannot add a row, whatever organization it names');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('insert into public.organization_members (organization_id, user_id, role) values (%L, %L, %L)',
                         :orgA, :nobody, 'viewer')),
  :'denied',
  '0473/25: an admin cannot add a row that is not accepted yet');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('insert into public.organization_members (organization_id, user_id, role, accepted_at) values (%L, %L, %L, now()), (%L, %L, %L, now())',
                         :orgA, :nobody, 'staff', :orgA, :memberC, 'viewer')),
  :'denied',
  '0473/26: an admin cannot add several rows in one statement');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('insert into public.organization_members (organization_id, user_id, role, accepted_at) select %L, p.id, %L, now() from public.user_profiles p where p.id = %L',
                         :orgA, 'staff', :nobody)),
  :'denied',
  '0473/27: an admin cannot add a row with INSERT ... SELECT');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format(:'add_row', :orgA, :staffA, 'manager') || ' on conflict (organization_id, user_id) do nothing'),
  :'denied',
  '0473/28: an admin''s upsert that would do nothing is refused');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format(:'add_row', :orgA, :staffA, 'manager')
                  || ' on conflict (organization_id, user_id) do update set role = excluded.role'),
  :'denied',
  '0473/29: an admin''s upsert of a row that exists is refused, even one that would only change the role (the app changes a role with an update)');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format($q$merge into public.organization_members m
                            using (select %L::uuid as organization_id, %L::uuid as user_id) s
                               on m.organization_id = s.organization_id and m.user_id = s.user_id
                             when not matched then insert (organization_id, user_id, role, accepted_at)
                                                   values (s.organization_id, s.user_id, 'staff', now())$q$,
                         :orgA, :nobody)),
  :'denied',
  '0473/30: an admin''s MERGE with an insert arm is refused');
select is(pg_temp.attempt('authenticated', :ownerA, format(:'add_row', :orgA, :nobody, 'admin')), :'denied',
  '0473/31: an owner cannot add an admin row');
select is(pg_temp.attempt('authenticated', :ownerA, format(:'add_row', :orgA, :nobody, 'owner')), :'denied',
  '0473/32: an owner cannot add an owner row (refused by the privilege, before the 0393 guard)');
select is(pg_temp.attempt('authenticated', :ownerA, format(:'add_row', :orgN, :ownerA, 'owner')), :'denied',
  '0473/33: an owner cannot add a row in an organization that has no member');

select is(pg_temp.rows_now(), (select fingerprint from rows_at_start),
  '0473/34: every attempt above was undone by the helper: the rows are as the fixture made them');

-- ═══ 3. No API caller writes a row's account, organization or acceptance ═══

-- Each change as an admin: the staff member's row, and for acceptance also
-- the row that is not accepted yet.
select is(
  (select string_agg(s.n::text || ' ' ||
                     pg_temp.attempt('authenticated', :adminA,
                                     format('update public.organization_members set %s where organization_id = %L and user_id = %L',
                                            s.setc, :orgA, s.who)),
                     E'\n' order by s.n)
     from (values
       (1,  format('user_id = %L', :nobody),                              :staffA::uuid),
       (2,  format('user_id = %L', :memberC),                             :staffA::uuid),
       (3,  format('organization_id = %L', :orgC),                        :staffA::uuid),
       (4,  format('organization_id = %L', :orgN),                        :staffA::uuid),
       (5,  'accepted_at = now()',                                        :pendingA::uuid),
       (6,  $v$accepted_at = now() - interval '1 year'$v$,                :staffA::uuid),
       (7,  'accepted_at = null',                                         :staffA::uuid),
       (8,  format('invited_by = %L', :adminA),                           :staffA::uuid),
       (9,  'invited_by = null',                                          :staffA::uuid),
       (10, $v$invited_at = now() - interval '1 day'$v$,                  :staffA::uuid),
       (11, $v$impersonation_expires_at = now() + interval '1 hour'$v$,   :staffA::uuid),
       (12, 'id = gen_random_uuid()',                                     :staffA::uuid),
       (13, $v$created_at = now() - interval '1 year'$v$,                 :staffA::uuid),
       (14, format($v$role = 'manager', user_id = %L$v$, :nobody),        :staffA::uuid),
       (15, $v$role = 'staff', accepted_at = now()$v$,                    :pendingA::uuid)
     ) s(n, setc, who)),
  (select string_agg(n::text || ' ' || :'guarded', E'\n' order by n) from generate_series(1, 15) n),
  '0473/35: an admin cannot write a row''s account, its organization, its acceptance (set, changed or cleared), who invited it or when, an act-as expiry, its id or its creation time, alone or beside a role change');

select is(
  (select string_agg(s.n::text || ' ' ||
                     pg_temp.attempt('authenticated', :ownerA,
                                     format('update public.organization_members set %s where organization_id = %L and user_id = %L',
                                            s.setc, :orgA, s.who)),
                     E'\n' order by s.n)
     from (values
       (1, format('user_id = %L', :nobody),       :staffA::uuid),
       (2, format('organization_id = %L', :orgC), :staffA::uuid),
       (3, 'accepted_at = now()',                 :pendingA::uuid),
       (4, 'accepted_at = null',                  :adminA::uuid),
       (5, $v$impersonation_expires_at = now() + interval '1 hour'$v$, :ownerA::uuid)
     ) s(n, setc, who)),
  (select string_agg(n::text || ' ' || :'guarded', E'\n' order by n) from generate_series(1, 5) n),
  '0473/36: an owner cannot either, on a member''s row or their own');

select is(
  pg_temp.attempt('authenticated', :seatA,
                  format($q$update public.organization_members set impersonation_expires_at = now() + interval '1 year'
                             where organization_id = %L and user_id = %L$q$, :orgA, :seatA)),
  :'guarded',
  '0473/37: a live act-as seat cannot move its own expiry');

select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('update public.organization_members set accepted_at = now() where organization_id = %L and user_id = %L',
                         :orgC, :memberC)),
  'ok:0',
  '0473/38: an admin changes no row of another organization');

-- Callers the row rules give no row to: nothing changes, whatever the column.
select is(
  pg_temp.attempt('authenticated', :pendingA,
                  format('update public.organization_members set accepted_at = now() where user_id = %L', :pendingA)),
  'ok:0',
  '0473/39: an account whose invitation is not accepted cannot accept it by writing its own row');
select is(
  pg_temp.attempt('authenticated', :managerA,
                  format('update public.organization_members set user_id = %L where organization_id = %L and user_id = %L',
                         :nobody, :orgA, :staffA))
  || ' | ' ||
  pg_temp.attempt('authenticated', :staffA,
                  format($q$update public.organization_members set role = 'admin' where organization_id = %L and user_id = %L$q$,
                         :orgA, :staffA))
  || ' | ' ||
  pg_temp.attempt('authenticated', :nobody,
                  format('update public.organization_members set user_id = %L where organization_id = %L and user_id = %L',
                         :nobody, :orgA, :staffA))
  || ' | ' ||
  pg_temp.attempt('authenticated', null, 'update public.organization_members set accepted_at = now()')
  || ' | ' ||
  pg_temp.attempt('anon', null, 'update public.organization_members set accepted_at = now()'),
  'ok:0 | ok:0 | ok:0 | ok:0 | ok:0',
  '0473/40: a manager, a staff member on their own row, an account with no membership, a token with no account and a signed-out caller change no row');

-- ═══ 4. The second layer: the trigger ══════════════════════════════════════

-- INSERT is handed to both roles for the length of one undone block
-- (:hand_back), so the privilege is out of the way and the trigger is what
-- answers.
select is(pg_temp.attempt('authenticated', :ownerA, format(:'add_row', :orgA, :nobody, 'staff'), null, :'hand_back'), :'by_server',
  '0473/41: with the privilege out of the way, an owner is refused by the trigger');
select is(pg_temp.attempt('authenticated', :adminA, format(:'add_row', :orgA, :nobody, 'staff'), null, :'hand_back'), :'by_server',
  '0473/42: and an admin');
select is(pg_temp.attempt('authenticated', :managerA, format(:'add_row', :orgA, :nobody, 'staff'), null, :'hand_back'), :'by_server',
  '0473/43: and a manager (the trigger fires before the row rules are asked)');
select is(pg_temp.attempt('anon', null, format(:'add_row', :orgA, :nobody, 'staff'), null, :'hand_back'), :'by_server',
  '0473/44: and a signed-out caller');
select is(pg_temp.attempt('authenticated', null, format(:'add_row', :orgA, :nobody, 'staff'), null, :'hand_back'), :'by_server',
  '0473/45: and a token with no account');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format(:'add_row', :orgA, :staffA, 'manager') || ' on conflict (organization_id, user_id) do nothing',
                  null, :'hand_back')
  || ' | ' ||
  pg_temp.attempt('authenticated', :adminA,
                  format(:'add_row', :orgA, :staffA, 'manager')
                  || ' on conflict (organization_id, user_id) do update set role = excluded.role',
                  null, :'hand_back')
  || ' | ' ||
  pg_temp.attempt('authenticated', :adminA,
                  format($q$merge into public.organization_members m
                            using (select %L::uuid as organization_id, %L::uuid as user_id) s
                               on m.organization_id = s.organization_id and m.user_id = s.user_id
                             when not matched then insert (organization_id, user_id, role, accepted_at)
                                                   values (s.organization_id, s.user_id, 'staff', now())$q$,
                         :orgA, :nobody),
                  null, :'hand_back'),
  :'by_server' || ' | ' || :'by_server' || ' | ' || :'by_server',
  '0473/46: the trigger refuses both upsert forms of a row that exists, and MERGE''s insert arm');

-- The 0393 guard fires first, so an owner row and an act-as seat are still
-- refused by its own messages.
select is(
  pg_temp.attempt('authenticated', :adminA, format(:'add_row', :orgA, :nobody, 'owner'), null, :'hand_back'),
  '42501:cannot create an owner row via direct insert',
  '0473/47: the 0393 guard''s refusal of an owner row is still there, ahead of the trigger');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format($q$insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at)
                            values (%L, %L, 'staff', now(), now() + interval '1 hour')$q$, :orgA, :nobody),
                  null, :'hand_back'),
  '42501:cannot create an Act as seat via direct insert',
  '0473/48: and so is its refusal of an act-as seat');

-- A view that postgres owns reaches the table with its owner's privileges,
-- but the statement still runs as the caller's role, so the trigger refuses
-- a row inserted through it. The view exists for the length of the block.
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('insert into public.zz_a0473000_members (organization_id, user_id, role, accepted_at) values (%L, %L, %L, now())',
                         :orgA, :nobody, 'staff'),
                  null,
                  $q$create view public.zz_a0473000_members as select * from public.organization_members;
                     grant insert on public.zz_a0473000_members to authenticated$q$),
  :'by_server',
  '0473/49: a row inserted through a view that postgres owns is refused by the trigger');

-- The trigger looks at the role a statement runs as, so SECURITY DEFINER
-- code, which runs as its owner, is let through whoever calls it. The
-- function exists for the length of the block.
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('select public.zz_a0473000_server_add(%L, %L)', :orgA, :nobody),
                  format($q$select role || '/' || (accepted_at is not null)::text from public.organization_members
                             where organization_id = %L and user_id = %L$q$, :orgA, :nobody),
                  $q$create function public.zz_a0473000_server_add(p_org uuid, p_user uuid) returns void
                       language sql security definer set search_path = ''
                       as $d$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
                              values (p_org, p_user, 'staff', now()) $d$;
                     grant execute on function public.zz_a0473000_server_add(uuid, uuid) to authenticated$q$),
  'ok:1:staff/true',
  '0473/50: SECURITY DEFINER code owned by postgres adds a row when a signed-in member calls it (it runs as its owner)');
select is(
  pg_temp.attempt('authenticated', :adminA, 'select public.tg_membership_rows_added_by_server()'),
  '42501:permission denied for function tg_membership_rows_added_by_server',
  '0473/51: the trigger function itself cannot be called by a signed-in member');
select is(
  has_table_privilege('anon', 'public.organization_members', 'insert')::text || '|'
  || has_table_privilege('authenticated', 'public.organization_members', 'insert')::text || '|'
  || (to_regprocedure('public.zz_a0473000_server_add(uuid, uuid)') is null)::text || '|'
  || (to_regclass('public.zz_a0473000_members') is null)::text || '|' || pg_temp.rows_now(),
  'false|false|true|true|' || (select fingerprint from rows_at_start),
  '0473/52: every block of this section was undone: no INSERT for either role, no function or view left, the rows as the fixture made them');

-- ═══ 5. Everything the app does works ══════════════════════════════════════

-- The service-role client: no account in the token, not subject to row rules.
select is(
  pg_temp.attempt('service_role', null, format(:'add_row', :orgN, :nobody, 'owner'),
                  format($q$select role || '/' || (accepted_at is not null)::text from public.organization_members
                             where organization_id = %L and user_id = %L$q$, :orgN, :nobody)),
  'ok:1:owner/true',
  '0473/53: workspace creation and provisioning: the service role adds the first owner row');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.organization_members (organization_id, user_id, role, invited_by, accepted_at)
                            values (%L, %L, 'manager', %L, now())
                            on conflict (organization_id, user_id)
                            do update set role = excluded.role, invited_by = excluded.invited_by, accepted_at = excluded.accepted_at$q$,
                         :orgA, :nobody, :adminA),
                  format($q$select role || '/' || (accepted_at is not null)::text || '/' || (invited_by = %L)::text
                              from public.organization_members where organization_id = %L and user_id = %L$q$,
                         :adminA, :orgA, :nobody)),
  'ok:1:manager/true/true',
  '0473/54: invitation acceptance: the service role''s upsert adds the accepted row with the invitation''s role and inviter');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.organization_members (organization_id, user_id, role, invited_by, accepted_at)
                            values (%L, %L, 'viewer', %L, now())
                            on conflict (organization_id, user_id)
                            do update set role = excluded.role, invited_by = excluded.invited_by, accepted_at = excluded.accepted_at$q$,
                         :orgA, :pendingA, :adminA),
                  format($q$select role || '/' || (accepted_at is not null)::text || '/' || count(*) over ()::text
                              from public.organization_members where organization_id = %L and user_id = %L$q$,
                         :orgA, :pendingA)),
  'ok:1:viewer/true/1',
  '0473/55: invitation acceptance: the same upsert completes a row that was not accepted yet, as one row');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at)
                            values (%L, %L, 'owner', now(), now() + interval '1 hour')
                            on conflict (organization_id, user_id)
                            do update set role = excluded.role, accepted_at = excluded.accepted_at,
                                          impersonation_expires_at = excluded.impersonation_expires_at$q$,
                         :orgC, :seatA),
                  format($q$select role || '/' || (impersonation_expires_at > now())::text from public.organization_members
                             where organization_id = %L and user_id = %L$q$, :orgC, :seatA)),
  'ok:1:owner/true',
  '0473/56: an act-as seat: the service role writes it');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$delete from public.organization_members
                             where organization_id = %L and user_id = %L and impersonation_expires_at is not null$q$,
                         :orgA, :seatA),
                  format('select count(*)::text from public.organization_members where organization_id = %L and user_id = %L',
                         :orgA, :seatA)),
  'ok:1:0',
  '0473/57: an act-as seat: the service role removes it');
select is(
  pg_temp.attempt('service_role', null,
                  format('select public.transfer_org_ownership(%L, %L, %L)', :orgA, :ownerA, :adminA),
                  format($q$select string_agg(role, ',' order by user_id) from public.organization_members
                             where organization_id = %L and user_id in (%L, %L)$q$, :orgA, :ownerA, :adminA)),
  'ok:1:admin,owner',
  '0473/58: ownership transfer: the service role''s call swaps the two roles');

-- An admin's own token: what the Team page and the phone write.
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format($q$insert into public.organization_invites (organization_id, email, role, token, expires_at, invited_by)
                            values (%L, 'invited-members@test.local', 'staff', 'a0473000-invite-token', now() + interval '7 days', %L)$q$,
                         :orgA, :adminA)),
  'ok:1',
  '0473/59: an admin creates an invitation');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format($q$update public.organization_members set role = 'manager'
                             where organization_id = %L and id = (select m.id from public.organization_members m
                                                                    where m.organization_id = %L and m.user_id = %L)
                         returning id$q$, :orgA, :orgA, :staffA),
                  format('select role from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:manager',
  '0473/60: an admin changes a member''s role (the web''s shape: by row id, the row asked back)');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format($q$update public.organization_members set role = 'viewer'
                             where organization_id = %L and user_id = %L returning user_id$q$, :orgA, :staffA),
                  format('select role from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:viewer',
  '0473/61: an admin changes a member''s role (the phone''s shape: by account, the row asked back)');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('update public.organization_members set is_delivery_driver = true where organization_id = %L and user_id = %L returning id, user_id',
                         :orgA, :staffA),
                  format('select is_delivery_driver::text from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:true',
  '0473/62: an admin marks a delivery driver');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('update public.organization_members set all_warehouses = true where organization_id = %L and user_id = %L returning id',
                         :orgA, :staffA),
                  format('select all_warehouses::text from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:true',
  '0473/63: an admin gives a member every warehouse');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('update public.organization_members set all_warehouses = false where organization_id = %L and user_id = %L returning id',
                         :orgA, :staffA),
                  format('select all_warehouses::text from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA),
                  format('update public.organization_members set all_warehouses = true where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:false',
  '0473/64: and takes it back');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format('insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, assigned_by) values (%L, %L, %L, %L)',
                         :orgA, :staffA, :whA, :adminA)),
  'ok:1',
  '0473/65: an admin assigns a member to a warehouse');
select is(
  pg_temp.attempt('authenticated', :adminA,
                  format($q$delete from public.organization_members
                             where organization_id = %L and id = (select m.id from public.organization_members m
                                                                    where m.organization_id = %L and m.user_id = %L)$q$,
                         :orgA, :orgA, :staffA),
                  format('select count(*)::text from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:0',
  '0473/66: an admin removes a member');
select is(
  pg_temp.attempt('authenticated', :ownerA,
                  format($q$update public.organization_members set role = 'admin' where organization_id = %L and user_id = %L returning id$q$,
                         :orgA, :managerA),
                  format('select role from public.organization_members where organization_id = %L and user_id = %L', :orgA, :managerA)),
  'ok:1:admin',
  '0473/67: an owner changes a member''s role');
select is(
  pg_temp.attempt('authenticated', :seatA,
                  format($q$update public.organization_members set role = 'manager' where organization_id = %L and user_id = %L returning id$q$,
                         :orgA, :staffA)),
  'ok:1',
  '0473/68: a live act-as seat changes a member''s role');

-- A member's own token.
select is(
  pg_temp.attempt('authenticated', :staffA,
                  format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA),
                  format('select count(*)::text from public.organization_members where organization_id = %L and user_id = %L', :orgA, :staffA)),
  'ok:1:0',
  '0473/69: a member removes their own row');
select is(
  pg_temp.attempt('authenticated', :staffA,
                  format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :viewerA)),
  'ok:0',
  '0473/70: and removes nobody else''s');

-- Account deletion: the auth row goes, the profile and the membership rows
-- go with it (the cascade runs as the table's owner).
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :staffA),
                  format('select count(*)::text from public.organization_members where user_id = %L', :staffA)),
  'ok:1:0',
  '0473/71: deleting an account takes its membership rows with it');

-- Reads.
select is(
  pg_temp.attempt('authenticated', :staffA,
                  format('select 1 from public.organization_members where organization_id in (%L, %L)', :orgA, :orgC)),
  'ok:7',
  '0473/72: a member reads the rows of their own organization, and none of another');
select is(
  pg_temp.attempt('authenticated', :pendingA, 'select 1 from public.organization_members')
  || ' | ' || pg_temp.attempt('anon', null, 'select 1 from public.organization_members'),
  'ok:0 | ok:0',
  '0473/73: an account whose invitation is not accepted and a signed-out caller read none');

select is(pg_temp.rows_now(), (select fingerprint from rows_at_start),
  '0473/74: every attempt above was undone by the helper: the rows are as the fixture made them');

-- ═══ 6. The header's rollback lines ════════════════════════════════════════

select is(
  pg_temp.attempt('postgres', null,
                  'grant insert on table public.organization_members to anon, authenticated',
                  $q$select has_table_privilege('anon', 'public.organization_members', 'insert')::text || '/'
                         || has_table_privilege('authenticated', 'public.organization_members', 'insert')::text || '/'
                         || (select (p.prosrc !~* 'raise')::text || '/' || p.prosecdef::text || '/' || array_to_string(p.proconfig, ',')
                               from pg_proc p where p.oid = to_regprocedure('public.tg_membership_rows_added_by_server()'))$q$,
                  $q$create or replace function public.tg_membership_rows_added_by_server()
                       returns trigger language plpgsql security invoker set search_path = ''
                       as $f$ begin return new; end $f$$q$),
  'ok:0:true/true/true/false/search_path=""',
  '0473/75: the first rollback form, as the header writes it: both roles hold INSERT and the trigger function refuses nobody');
-- The second form drops the trigger. With a 500 ms lock_timeout it gives up
-- (55P03) instead of waiting when a table it must lock is busy, and the
-- assertion is then skipped: that is another session's doing, not the
-- form's.
select case
         when x.answer like '55P03:%'
           then skip('the second rollback form was not run: a table its DROP TRIGGER locks was busy (another session on this database)')
         else is(x.answer, 'ok:0:true/true/0/true/true',
                 '0473/76: the second rollback form, as the header writes it: INSERT for both roles, no trigger, no function, no comment')
       end
  from (select pg_temp.attempt('postgres', null,
                  'comment on table public.organization_members is null',
                  $q$select has_table_privilege('anon', 'public.organization_members', 'insert')::text || '/'
                         || has_table_privilege('authenticated', 'public.organization_members', 'insert')::text || '/'
                         || (select count(*) from pg_trigger t where t.tgrelid = 'public.organization_members'::regclass
                                and t.tgname = 'trg_zz_organization_members_added_by_server')::text || '/'
                         || (to_regprocedure('public.tg_membership_rows_added_by_server()') is null)::text || '/'
                         || (obj_description('public.organization_members'::regclass, 'pg_class') is null)::text$q$,
                  $q$set local lock_timeout = '500ms';
                     grant insert on table public.organization_members to anon, authenticated;
                     drop trigger trg_zz_organization_members_added_by_server on public.organization_members;
                     drop function public.tg_membership_rows_added_by_server()$q$) as answer) x;
select is(
  has_table_privilege('anon', 'public.organization_members', 'insert')::text || '|'
  || has_table_privilege('authenticated', 'public.organization_members', 'insert')::text || '|'
  || (obj_description('public.organization_members'::regclass, 'pg_class') ~ '0473')::text || '|'
  || (select t.tgenabled::text from pg_trigger t where t.tgrelid = 'public.organization_members'::regclass
         and t.tgname = 'trg_zz_organization_members_added_by_server') || '|'
  || (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.tg_membership_rows_added_by_server()')),
  'false|false|true|O|55e3edc02cb3bccdf9c0fa97a3c10555',
  '0473/77: and both blocks were undone');

-- ═══ 7. The refusals as a client meets them, without the helper ════════════

set local "request.jwt.claim.sub" to 'a0473000-0000-0000-0000-0000000000c2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('a0473000-0000-0000-0000-0000000000a1', 'a0473000-0000-0000-0000-0000000000ca', 'staff', now()) $$,
  '42501',
  'permission denied for table organization_members',
  '0473/78: an admin''s insert, as the admin''s own session sends it: 42501, permission denied for table organization_members');
select throws_ok(
  $$ update public.organization_members set user_id = 'a0473000-0000-0000-0000-0000000000ca'
      where organization_id = 'a0473000-0000-0000-0000-0000000000a1' and user_id = 'a0473000-0000-0000-0000-0000000000c4' $$,
  '42501',
  'only role, is_delivery_driver and all_warehouses can change on a membership',
  '0473/79: an admin''s update of a row''s account, the same way: 42501, the 0393 guard''s message');
reset role;

set local "request.jwt.claim.sub" to '';
set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('a0473000-0000-0000-0000-0000000000a1', 'a0473000-0000-0000-0000-0000000000ca', 'staff', now()) $$,
  '42501',
  'permission denied for table organization_members',
  '0473/80: a signed-out caller''s insert, the same way: 42501, permission denied for table organization_members');
reset role;

-- The trigger, the same way: the privilege is handed to authenticated for
-- these two statements and taken away again.
grant insert on table public.organization_members to authenticated;
set local "request.jwt.claim.sub" to 'a0473000-0000-0000-0000-0000000000c2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.organization_members (organization_id, user_id, role, accepted_at)
       values ('a0473000-0000-0000-0000-0000000000a1', 'a0473000-0000-0000-0000-0000000000ca', 'staff', now()) $$,
  '42501',
  'Membership rows are added by the server.',
  '0473/81: with the privilege out of the way, an admin''s insert, as the admin''s own session sends it: 42501, Membership rows are added by the server.');
reset role;
revoke insert on table public.organization_members from authenticated;
select is(
  has_table_privilege('authenticated', 'public.organization_members', 'insert')::text || '|' || pg_temp.rows_now(),
  'false|' || (select fingerprint from rows_at_start),
  '0473/82: the privilege is taken away again and no row was added');

select * from finish();
rollback;
