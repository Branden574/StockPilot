-- 0473_membership_rows_added_by_the_server.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Membership rows are added by the server. A row of
-- public.organization_members is the record that an account joined an
-- organization. The server writes it after its own checks (workspace
-- creation, provisioning, an accepted invitation, an act-as seat), through
-- the service-role client. The database holds the same line, in two layers
-- that each stand alone:
--   - the data API roles, anon and authenticated, hold no INSERT on the
--     table or on any column of it;
--   - a BEFORE INSERT trigger refuses a row inserted as either role.
-- Reads, the changes an admin may make to a member (role, delivery driver,
-- all warehouses) and removals are untouched.
--
-- WHAT IT ADDS AND CHANGES (tier B: it decides which writes are allowed. No
-- stored row and no existing function, policy or trigger changes.)
--   1. public.tg_membership_rows_added_by_server(): a trigger function,
--      SECURITY INVOKER, search_path '', EXECUTE for no API role (a trigger
--      function fires without it). It raises 42501, "Membership rows are
--      added by the server.", when current_user is anon or authenticated, and
--      returns the row untouched for every other role: service_role, the
--      table's owner, and SECURITY DEFINER code, which runs as its owner. It
--      reads nothing of the row.
--   2. trg_zz_organization_members_added_by_server: BEFORE INSERT FOR EACH
--      ROW on public.organization_members, bound to that function. A BEFORE
--      INSERT row trigger fires for every row a statement proposes, so an
--      upsert of a row that exists and MERGE's insert arm are refused too.
--   3. revoke insert on table public.organization_members from anon,
--      authenticated. A table-level revoke also clears a column-level INSERT,
--      and the post-condition checks every column.
--   4. A comment on the table that says so, for a reader of the catalog.
--
-- THE TWO LAYERS, AND THE ORDER OF THE TRIGGERS
--   The privilege is checked first, before any trigger or policy, so with
--   both layers in place a caller sees "permission denied for table
--   organization_members". The trigger is the layer that still stands if the
--   privilege is ever granted to one of the two roles.
--   BEFORE row triggers fire in name order, so the 0393 guard's
--   organization_members_role_guard fires before this one. The order does not
--   matter for the outcome: neither trigger changes the row, this one reads
--   nothing of it, and each refuses on its own. It only decides whose message
--   is seen when both refuse (the guard's, for an owner row or an act-as
--   seat). trg_zz_ is the prefix this schema gives a trigger that is meant
--   to fire late (the table's other two triggers carry it).
--
-- WHAT IT DOES NOT CHANGE
--   - An existing row's account, organization and acceptance are not written
--     by an API caller: the 0393 guard (_guard_organization_member_changes,
--     BEFORE INSERT OR UPDATE OR DELETE) lets a signed-in caller change role,
--     is_delivery_driver and all_warehouses, never to or from owner, and
--     nothing else (but for emptying invited_by once the inviter's account is
--     gone). The preflight below refuses to apply this file unless that guard
--     is 0393's, bound and enabled, and the test pins each column. This file
--     does not touch the guard or its trigger.
--   - The UPDATE and DELETE rules (0140) stay as they are.
--   - The policy organization_members_insert (0217) is LEFT IN PLACE ON
--     PURPOSE and is not in use: neither role it names holds INSERT, and the
--     trigger refuses both. It is not dropped here because on this platform
--     DROP POLICY, ALTER POLICY and even COMMENT ON POLICY, run by a
--     migration, take ACCESS EXCLUSIVE on about 23 auth, storage and realtime
--     tables (auth.users and auth.sessions among them) and on
--     organization_members itself, held to commit (0390, 0400, 0418, 0462 and
--     0465 have the notes; measured again for this file). The table is read
--     by nearly every request. Whoever next restates this table's policies,
--     and pays for those locks anyway, should drop the policy in the same
--     file. Until then pg_policies still lists it; has_table_privilege(
--     'authenticated', 'public.organization_members', 'INSERT'), the trigger
--     and the table's comment say what is true.
--
-- KEEPING IT SO
--   - apps/web/src/test/membership-insert-stays-revoked.guard.test.ts reads
--     every later migration and fails on one that grants INSERT or ALL on
--     this table (or INSERT on a column of it) to anon, authenticated or
--     PUBLIC, or that drops, disables or restates the trigger or its
--     function.
--   - supabase/tests/0473_membership_rows_added_by_the_server.test.sql fails
--     if either role holds INSERT on the table or a column, or if the trigger
--     is not bound and enabled, on a database built from the migrations.
--   - Neither looks at a live database. A check of one is one read: both
--     has_table_privilege('anon', 'public.organization_members', 'insert')
--     and the same for authenticated are false, and pg_trigger.tgenabled of
--     the trigger is 'O'.
--
-- WHO IS AFFECTED
--   Refused (42501) for the roles a person's token can carry, anon and
--   authenticated, whatever the person's role in the organization:
--     - INSERT into organization_members, one row or several;
--     - an upsert of it (INSERT ... ON CONFLICT DO NOTHING or DO UPDATE: the
--       data API's POST with a resolution preference, and its PUT);
--     - MERGE with an insert arm.
--   The app makes none of these calls with a person's token. Evidence, at
--   this commit:
--     - web: the inserts and upserts of organization_members are
--       createOrganizationAction (actions/organization.ts), the platform
--       console's createOrgForCustomerAction (actions/platform-admin.ts),
--       startActingAs (services/platform/impersonation.ts) and
--       acceptInviteWithToken (services/team.ts), each through
--       createAdminClient(), the service-role client;
--     - web, with the person's own client: TeamService updates role,
--       is_delivery_driver and all_warehouses and deletes a member's row.
--       UPDATE and DELETE are not touched;
--     - phone: one write, the role UPDATE in app/(drawer)/admin/users.tsx
--       (src/lib/member-role-write.ts reads its answer). No released version
--       of the phone app has inserted a membership row (git history of
--       apps/mobile);
--     - SQL: no function inserts a membership row; the one function that
--       writes the table, transfer_org_ownership, updates two roles and is
--       executable by service_role only. No view is built on the table;
--     - operator scripts (seed and load-test tools) use the service-role key
--       or run as the table's owner.
--   Still working, unchanged: workspace creation, provisioning, invitations
--   and their acceptance, act-as seats and transfer_org_ownership (service
--   role: it keeps every privilege, is not subject to row security, and the
--   trigger lets it through); role, delivery-driver and all-warehouses
--   changes, warehouse assignments and member removal by an admin (their own
--   token: UPDATE and DELETE); a member removing their own row; account
--   deletion (the cascade runs as the table's owner).
--
-- ROLLBACK (a last resort: a caller that turns out to need one of the refused
-- statements should move to the server instead)
--   To switch both layers off with no table lock, in one transaction:
--     begin;
--     create or replace function public.tg_membership_rows_added_by_server()
--       returns trigger language plpgsql security invoker set search_path = ''
--       as $f$ begin return new; end $f$;
--     grant insert on table public.organization_members to anon, authenticated;
--     commit;
--   To remove the objects as well, in one transaction:
--     begin;
--     set local lock_timeout = '900ms';
--     grant insert on table public.organization_members to anon, authenticated;
--     drop trigger trg_zz_organization_members_added_by_server on public.organization_members;
--     drop function public.tg_membership_rows_added_by_server();
--     comment on table public.organization_members is null;
--     commit;
--   WHAT THE SECOND FORM COSTS: on this platform a DROP TRIGGER run by
--   postgres makes supautils take ACCESS EXCLUSIVE on every table in
--   supautils.drop_trigger_grants (about 23 auth, storage and realtime
--   tables, auth.users and auth.sessions among them; 0373's note), and
--   Postgres itself takes ACCESS EXCLUSIVE on organization_members, all held
--   to commit: sign-ins, token refreshes and every request wait for it, and
--   lock_timeout bounds each wait, not their sum. So the trigger is never
--   dropped in passing. The first form is the way to switch it off;
--   ALTER TABLE ... DISABLE TRIGGER (SHARE ROW EXCLUSIVE on this table only)
--   is the other. The guard test above fails on a later migration that does
--   any of these, until that file is listed there with its reason.
--
-- ERRORS
--   55000 hint membership_rows_preflight: the table, its owner, row security
--   or the 0393 guard is not what this file was written against, or the
--   trigger or its function already exists (a second run stops here);
--   nothing applied. 55000 hint membership_rows_postcondition: anon or
--   authenticated still holds INSERT (a grant made by another role, or a
--   column grant), the trigger or its function is not as created, or a
--   privilege this file must not touch moved; nothing applied. 55P03: the
--   table's lock was busy for 900 ms; nothing applied, run it again.
--   Afterwards an insert made as anon or authenticated gets 42501. Never
--   40001 or 40P01 (PostgREST retries those, 0367).
--
-- ORDER: after 0393 (the guard) and 0402 (the explicit grants). It reads
-- nothing of 0472.
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS (measured on the scratch database, the whole file inside BEGIN ...
-- ROLLBACK, and with two sessions): one table, public.organization_members.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on it, held to commit
-- (milliseconds); COMMENT ON TABLE then asks for SHARE UPDATE EXCLUSIVE,
-- which the stronger lock already covers, and REVOKE takes no table lock.
--   - Reads of the table (every request reads its membership), SELECT ...
--     FOR UPDATE / FOR SHARE and the foreign key check a child row's write
--     makes on it (ROW SHARE) do not wait, neither while the lock is held
--     nor while the file is still waiting for it.
--   - What waits: an insert, update or delete of a membership row (ROW
--     EXCLUSIVE: an accepted invitation, a role, driver or warehouse-access
--     change, a removal, an account deletion's cascade, an act-as seat), and
--     a VACUUM, ANALYZE or schema change of this table. Such a write waits
--     from the lock to the commit (milliseconds), or, when the file is itself
--     queued behind an open write of the table, for as long as the file
--     waits: at most 900 ms, after which the file gives up with 55P03 and
--     nothing applied, and the writes go on. Run it again.
--   - The function is created before the trigger, so the one wait happens
--     while the file holds no table lock.
-- Nothing in auth, storage or realtime is locked: no policy statement and no
-- DROP TRIGGER runs, so supautils takes nothing (CREATE TRIGGER and COMMENT
-- ON TRIGGER are not among the statements it meets with its lists).
-- lock_timeout is not reset at the end of the file (0469 to 0472 do the
-- same).
set lock_timeout = '900ms';

-- ─── 0. Preflight ────────────────────────────────────────────────────────────
do $pre_membership_rows$
declare
  v_bad text := '';
  v_tbl oid := to_regclass('public.organization_members');
  v_fn  oid := to_regprocedure('public._guard_organization_member_changes()');
  r     record;
begin
  if v_tbl is null then
    raise exception 'membership_rows_preflight: public.organization_members missing'
      using errcode = '55000', hint = 'membership_rows_preflight';
  end if;

  select c.relkind::text as kind, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls
    into r
    from pg_class c where c.oid = v_tbl;
  if r.kind <> 'r' or r.owner <> 'postgres' or not r.rls then
    v_bad := v_bad || format(' public.organization_members is not as expected (kind %s, owner %s, row security %s);',
                             r.kind, r.owner, r.rls);
  end if;

  -- The server's own path: without it nothing could add a member afterwards.
  if not has_table_privilege('service_role', v_tbl, 'insert') then
    v_bad := v_bad || ' service_role holds no INSERT on public.organization_members;';
  end if;

  -- The 0393 guard, as its own test pins it (K21): the body by md5, written
  -- in two halves, SECURITY DEFINER, owned by postgres, bound BEFORE INSERT
  -- OR UPDATE OR DELETE for each row and enabled. It is what keeps an
  -- existing row's account, organization and acceptance from being written
  -- by an API caller, so this file is not applied over a different one.
  if v_fn is null then
    v_bad := v_bad || ' public._guard_organization_member_changes() missing;';
  else
    select md5(p.prosrc) as got, p.prosecdef, pg_get_userbyid(p.proowner) as owner
      into r
      from pg_proc p where p.oid = v_fn;
    if r.got <> ('b48c165e5ff1ae0e' || '8bbf159ab97c0d42') or not r.prosecdef or r.owner <> 'postgres' then
      v_bad := v_bad || format(' public._guard_organization_member_changes() drifted (md5 %s, definer %s, owner %s);',
                               r.got, r.prosecdef, r.owner);
    end if;
    if not exists (
      select 1 from pg_trigger t
       where t.tgrelid = v_tbl and t.tgfoid = v_fn and not t.tgisinternal
         and t.tgname = 'organization_members_role_guard'
         and t.tgtype = 31 and t.tgenabled = 'O'
    ) then
      v_bad := v_bad || ' organization_members_role_guard is not bound BEFORE INSERT OR UPDATE OR DELETE for each row, or is not enabled;';
    end if;
  end if;

  -- The two names this file creates are free (a second run stops here).
  if to_regprocedure('public.tg_membership_rows_added_by_server()') is not null then
    v_bad := v_bad || ' public.tg_membership_rows_added_by_server() already exists;';
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = v_tbl and t.tgname = 'trg_zz_organization_members_added_by_server') then
    v_bad := v_bad || ' trg_zz_organization_members_added_by_server already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'membership_rows_preflight:%', v_bad
      using errcode = '55000', hint = 'membership_rows_preflight';
  end if;
end
$pre_membership_rows$;

-- ─── 1. The trigger function (no table lock) ─────────────────────────────────
create function public.tg_membership_rows_added_by_server()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- current_user is the role the statement runs as: anon or authenticated
  -- for a request made with a person's token or the public key; service_role
  -- for the server's client; the function's owner inside SECURITY DEFINER
  -- code. Only the first two are refused.
  if current_user in ('anon', 'authenticated') then
    raise exception 'Membership rows are added by the server.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- No role needs EXECUTE: a trigger function fires without it, and no API
-- role may call it.
revoke all on function public.tg_membership_rows_added_by_server() from public, anon, authenticated, service_role;

comment on function public.tg_membership_rows_added_by_server() is
  'BEFORE INSERT row trigger on organization_members (0473): membership rows are added by the server. Raises 42501 when current_user is anon or authenticated; returns the row untouched for every other role (service_role, the table''s owner, SECURITY DEFINER code). SECURITY INVOKER, search_path empty, EXECUTE for no API role. A later change to it is checked by apps/web/src/test/membership-insert-stays-revoked.guard.test.ts.';

-- ─── 2. The trigger (the file's one wait: SHARE ROW EXCLUSIVE) ───────────────
create trigger trg_zz_organization_members_added_by_server
  before insert on public.organization_members
  for each row
  execute function public.tg_membership_rows_added_by_server();

comment on trigger trg_zz_organization_members_added_by_server on public.organization_members is
  'Membership rows are added by the server (0473): refuses a row inserted as anon or authenticated. It fires after organization_members_role_guard (name order); the order does not matter, each refuses on its own. Not dropped or disabled in passing: 0473''s header says what a DROP TRIGGER costs on this platform.';

-- ─── 3. The table's comment ──────────────────────────────────────────────────
comment on table public.organization_members is
  'Who belongs to which organization, with which role. Rows are added by the server only (the service-role client and database code): anon and authenticated hold no INSERT privilege on this table, and trg_zz_organization_members_added_by_server refuses a row inserted as either role (0473). The policy organization_members_insert is not in use and is left in place on purpose (0473''s header says why). A signed-in admin may change role, is_delivery_driver and all_warehouses (the 0393 guard refuses every other column) and remove a member; a member may remove their own row.';

-- ─── 4. The privilege ────────────────────────────────────────────────────────
revoke insert on table public.organization_members from anon, authenticated;

-- ─── 5. Post-condition ───────────────────────────────────────────────────────
do $post_membership_rows$
declare
  v_tbl oid := 'public.organization_members'::regclass;
  v_fn  oid := to_regprocedure('public.tg_membership_rows_added_by_server()');
  v_bad text := '';
  r     record;
begin
  -- No INSERT for either role: not on the table, not on any column, and not
  -- through PUBLIC or a grant made by another role (has_table_privilege and
  -- has_any_column_privilege see all of those).
  for r in select x.role_name from (values ('anon'), ('authenticated')) x(role_name) loop
    if has_table_privilege(r.role_name, v_tbl, 'insert') then
      v_bad := v_bad || format(' %s still holds INSERT on the table;', r.role_name);
    end if;
    if has_any_column_privilege(r.role_name, v_tbl, 'insert') then
      v_bad := v_bad || format(' %s still holds INSERT on a column;', r.role_name);
    end if;
  end loop;

  -- The trigger: this function, BEFORE INSERT for each row (tgtype 7),
  -- enabled, with no WHEN clause; the function as created.
  if v_fn is null then
    v_bad := v_bad || ' public.tg_membership_rows_added_by_server() missing;';
  else
    if not exists (
      select 1 from pg_trigger t
       where t.tgrelid = v_tbl and t.tgfoid = v_fn and not t.tgisinternal
         and t.tgname = 'trg_zz_organization_members_added_by_server'
         and t.tgtype = 7 and t.tgenabled = 'O' and t.tgqual is null
    ) then
      v_bad := v_bad || ' trg_zz_organization_members_added_by_server is not bound BEFORE INSERT for each row, or is not enabled;';
    end if;
    select p.prosecdef, pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ','), '-') as cfg,
           has_function_privilege('public', p.oid, 'execute') as public_x,
           has_function_privilege('anon', p.oid, 'execute') as anon_x,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
           has_function_privilege('service_role', p.oid, 'execute') as svc_x
      into r
      from pg_proc p where p.oid = v_fn;
    if r.prosecdef or r.owner <> 'postgres' or r.cfg <> 'search_path=""'
       or r.public_x or r.anon_x or r.auth_x or r.svc_x then
      v_bad := v_bad || format(' public.tg_membership_rows_added_by_server() is not as created (definer %s, owner %s, config %s, public %s, anon %s, authenticated %s, service_role %s);',
                               r.prosecdef, r.owner, r.cfg, r.public_x, r.anon_x, r.auth_x, r.svc_x);
    end if;
  end if;

  -- What this file must leave as it was. (One privilege a call: a list
  -- asks whether any of them is held.)
  if not has_table_privilege('service_role', v_tbl, 'select')
     or not has_table_privilege('service_role', v_tbl, 'insert')
     or not has_table_privilege('service_role', v_tbl, 'update')
     or not has_table_privilege('service_role', v_tbl, 'delete') then
    v_bad := v_bad || ' service_role lost SELECT, INSERT, UPDATE or DELETE;';
  end if;
  if not has_table_privilege('authenticated', v_tbl, 'select')
     or not has_table_privilege('authenticated', v_tbl, 'update')
     or not has_table_privilege('authenticated', v_tbl, 'delete') then
    v_bad := v_bad || ' authenticated lost SELECT, UPDATE or DELETE;';
  end if;

  if v_bad <> '' then
    raise exception 'membership_rows_postcondition:%', v_bad
      using errcode = '55000', hint = 'membership_rows_postcondition';
  end if;
end
$post_membership_rows$;
