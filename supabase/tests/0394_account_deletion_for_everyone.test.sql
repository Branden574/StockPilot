-- supabase/tests/0394_account_deletion_for_everyone.test.sql
-- pgTAP proof for migration 0394 (security slice A3): every member can delete
-- their own account. Business records stay and record "Deleted user"; the
-- only owner of an organization with other members is refused; open work is
-- released; F12's legacy orders no longer refuse their requester's deletion.
--
-- K. Catalog (no fixtures):
--    K1  the public person-key census (md5|count, the 0394 prediction from
--        production's own keys) and no composite key or column-list SET NULL
--        to a person;
--    K2  no RESTRICT or NO ACTION key to a person in any schema;
--    K3  the CASCADE person keys in public are exactly the 19 personal ones
--        (delivery_locations and order_submissions added, invites gone);
--    K4  the tables carrying deleted_users are exactly the 16 of the narrow
--        scope, and each table's trigger arguments are exactly its SET NULL
--        person columns;
--    K5  no person FK column in public is NOT NULL unless its key cascades;
--    K6  the 9 exactly-one CHECKs and cc_ai_scans_confirm_chk exist and are
--        validated (their behaviour is C1, D4, M5);
--    K7  each marked table has exactly the zzz_deleted_users_ins/_upd pair:
--        BEFORE INSERT / BEFORE UPDATE FOR EACH ROW, enabled, the function,
--        its arguments, the WHEN terms (one per person column, no other), and
--        they are the last BEFORE row triggers by name;
--    K8  deleted_users is jsonb, nullable, no default; on schedule_events
--        (column grants) authenticated may read it and may not write it;
--    K9-K12, K16 posture and md5(prosrc) of the five functions;
--    K10b the trigger on auth.users; the body raises only P0001;
--    K13 nothing in public or auth is DEFERRABLE;
--    K14 the only function body naming deleted_users is tg_mark_deleted_users;
--    K15 0388 C1 still holds: only account_deletion_check deletes accounts;
--    K18 F12: no NOT VALID constraint is left in public or auth, and
--        order_requests_delivery_target_chk is the 0394 text (compared with
--        the same CHECK on a reference table) and validated;
--    K19 the triggers on auth.users; K20 comments name 0394.
-- X0. Coverage: the fixture names the subject in every marked column.
-- X0b. Each marked column also names the subject on a row where no other
--      person column of that row does, so every WHEN term of a table's
--      _upd trigger is exercised on its own (test stage, mutation M23: on
--      a row naming the subject in several columns an earlier column's
--      stamp fires the trigger and masks a missing term).
-- C1. Each relaxed NOT NULL column nulled for a live person by service_role
--     fails its exactly-one CHECK (23514).
-- S.  The schedule writer: no role moves or clears a live creator.
-- M.  Marker semantics: API roles never set, clear or change a stamp; a
--     stamp goes when the column names a live person again; a live person
--     nulled by a non-API role is never stamped; a profile-only delete
--     stamps nothing (a relaxed column then fails closed); unknown keys and
--     stamps on non-null columns are dropped; the server's audit row keeps
--     its stamp.
-- L.  The last owner (refused, P0001 organization_last_owner, through
--     account_deletion_check too), solo owners, two owners, an owner of two
--     organizations, the console's org-first path, the member guard,
--     impersonation seats (live and expired) that are neither owners nor
--     members, the locked transfer, and the lock-first body.
-- P10 the dry run answers deletable and changes nothing.
-- D.  The subject (history in every marked column, open and closed work of
--     every released kind, personal rows) is deleted: rows kept and stamped,
--     open work released and unstamped, closed work kept, personal rows gone,
--     every other row byte-identical, no dangling key anywhere, nothing
--     notified, nothing about the person copied; work and edits continue.
-- F.  F12: a legacy-shaped row is exempt by primary key only, its requester
--     can be deleted, and the rule is unchanged for every other row.
--
-- Roles: fixtures as the test superuser. Attempts run through pg_temp.attempt
-- (always undone) or pg_temp.call_as (kept), the 0387/0388 helpers. Accounts
-- are deleted as postgres (delete from auth.users); GoTrue's role
-- (supabase_auth_admin) is D1g when this role may act as it, and the race
-- script otherwise. begin/rollback: nothing leaks. Namespace 03940000.

begin;

select plan(79);

\set orgA    '\'03940000-0000-0000-0000-00000000000a\''
\set orgB    '\'03940000-0000-0000-0000-00000000000b\''
\set orgC    '\'03940000-0000-0000-0000-00000000000c\''
\set orgD    '\'03940000-0000-0000-0000-00000000000d\''
\set orgE    '\'03940000-0000-0000-0000-00000000000e\''
\set orgF    '\'03940000-0000-0000-0000-00000000000f\''
\set own     '\'03940000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03940000-0000-0000-0000-0000000000a1\''
\set stf     '\'03940000-0000-0000-0000-0000000000a2\''
\set sub     '\'03940000-0000-0000-0000-0000000000a3\''
\set pa      '\'03940000-0000-0000-0000-0000000000a4\''
\set own2    '\'03940000-0000-0000-0000-0000000000b0\''
\set pend    '\'03940000-0000-0000-0000-0000000000b1\''
\set xinv    '\'03940000-0000-0000-0000-0000000000b2\''
\set c1o     '\'03940000-0000-0000-0000-0000000000c0\''
\set c2o     '\'03940000-0000-0000-0000-0000000000c1\''
\set cst     '\'03940000-0000-0000-0000-0000000000c2\''
\set own3    '\'03940000-0000-0000-0000-0000000000d0\''
\set dmem    '\'03940000-0000-0000-0000-0000000000d1\''
\set own4    '\'03940000-0000-0000-0000-0000000000e0\''
\set est     '\'03940000-0000-0000-0000-0000000000e1\''
\set cust    '\'03940000-0000-0000-0000-0000000000f0\''
\set q1      '\'03940000-0000-0000-0000-0000000000f1\''
\set q2      '\'03940000-0000-0000-0000-0000000000f2\''
\set leg     '\'03940000-0000-0000-0000-0000000000f3\''
\set vd      '\'03940000-0000-0000-0000-0000000000f5\''
\set own5    '\'03940000-0000-0000-0000-0000000000f6\''
\set fmem    '\'03940000-0000-0000-0000-0000000000f7\''
\set whA     '\'03940000-0000-0000-0000-000000000101\''
\set itA     '\'03940000-0000-0000-0000-000000000102\''
\set binA1   '\'03940000-0000-0000-0000-000000000103\''
\set binA2   '\'03940000-0000-0000-0000-000000000104\''
\set poA     '\'03940000-0000-0000-0000-000000000105\''
\set chA     '\'03940000-0000-0000-0000-000000000106\''
\set custA   '\'03940000-0000-0000-0000-000000000107\''
\set oPick   '\'03940000-0000-0000-0000-000000000201\''
\set oDrv    '\'03940000-0000-0000-0000-000000000202\''
\set oTrans  '\'03940000-0000-0000-0000-000000000203\''
\set oDone   '\'03940000-0000-0000-0000-000000000204\''
\set oRet    '\'03940000-0000-0000-0000-000000000205\''
\set oP      '\'03940000-0000-0000-0000-000000000206\''
\set oF2     '\'03940000-0000-0000-0000-000000000207\''
\set oF5     '\'03940000-0000-0000-0000-000000000208\''
\set oLeg    '\'20ad4cb9-733e-4348-a4fd-074f43ce2025\''
\set ccOpen  '\'03940000-0000-0000-0000-000000000301\''
\set ccDone  '\'03940000-0000-0000-0000-000000000302\''
\set scan1   '\'03940000-0000-0000-0000-000000000303\''
\set seOpen  '\'03940000-0000-0000-0000-000000000311\''
\set seProg  '\'03940000-0000-0000-0000-000000000312\''
\set seDone  '\'03940000-0000-0000-0000-000000000313\''
\set seCre   '\'03940000-0000-0000-0000-000000000314\''
\set seLive  '\'03940000-0000-0000-0000-000000000315\''
\set mrOpen  '\'03940000-0000-0000-0000-000000000321\''
\set mrDone  '\'03940000-0000-0000-0000-000000000322\''
\set exOpen  '\'03940000-0000-0000-0000-000000000331\''
\set exDone  '\'03940000-0000-0000-0000-000000000332\''
\set rcpt1   '\'03940000-0000-0000-0000-000000000401\''
\set poi1    '\'03940000-0000-0000-0000-000000000402\''
\set appr1   '\'03940000-0000-0000-0000-000000000403\''
\set put1    '\'03940000-0000-0000-0000-000000000404\''
\set smp1    '\'03940000-0000-0000-0000-000000000405\''
\set ret1    '\'03940000-0000-0000-0000-000000000406\''
\set ret2    '\'03940000-0000-0000-0000-000000000407\''
\set uom1    '\'03940000-0000-0000-0000-000000000408\''
\set conn1   '\'03940000-0000-0000-0000-000000000409\''
\set cs1     '\'03940000-0000-0000-0000-000000000410\''
\set pa1     '\'03940000-0000-0000-0000-000000000411\''
\set pa2     '\'03940000-0000-0000-0000-000000000412\''
\set pa3     '\'03940000-0000-0000-0000-000000000413\''
\set pa4     '\'03940000-0000-0000-0000-000000000414\''
\set pa5     '\'03940000-0000-0000-0000-000000000415\''
\set invP    '\'03940000-0000-0000-0000-000000000416\''
\set invAcc  '\'03940000-0000-0000-0000-000000000417\''
\set invB1   '\'03940000-0000-0000-0000-000000000418\''
\set invB2   '\'03940000-0000-0000-0000-000000000419\''
\set al1     '\'03940000-0000-0000-0000-000000000420\''
\set al2     '\'03940000-0000-0000-0000-000000000421\''
\set al3     '\'03940000-0000-0000-0000-000000000422\''
\set al4     '\'03940000-0000-0000-0000-000000000423\''
\set alB     '\'03940000-0000-0000-0000-000000000424\''
-- X0b: rows naming the subject in one person column only.
\set appr2   '\'03940000-0000-0000-0000-000000000501\''
\set appr3   '\'03940000-0000-0000-0000-000000000502\''
\set scan2   '\'03940000-0000-0000-0000-000000000503\''
\set scan3   '\'03940000-0000-0000-0000-000000000504\''
\set poi2    '\'03940000-0000-0000-0000-000000000505\''
\set poi3    '\'03940000-0000-0000-0000-000000000506\''
\set ret3    '\'03940000-0000-0000-0000-000000000507\''
\set ret4    '\'03940000-0000-0000-0000-000000000508\''
\set ret5    '\'03940000-0000-0000-0000-000000000509\''
\set ret6    '\'03940000-0000-0000-0000-000000000510\''
\set ret7    '\'03940000-0000-0000-0000-000000000511\''
\set uom2    '\'03940000-0000-0000-0000-000000000512\''
\set uom3    '\'03940000-0000-0000-0000-000000000513\''
\set seAsg   '\'03940000-0000-0000-0000-000000000514\''
\set seCr2   '\'03940000-0000-0000-0000-000000000515\''
\set seUpd   '\'03940000-0000-0000-0000-000000000516\''
\set sm1     '\'03940000-0000-0000-0000-000000000425\''
\set rcptQ   '\'03940000-0000-0000-0000-000000000426\''
\set retQ    '\'03940000-0000-0000-0000-000000000427\''

-- ══ Helpers (the 0387/0388 helpers, sentinel XX394) ═══════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
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
    raise exception using errcode = 'XX394', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX394' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text; v_seen text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;
-- A trigger's arguments, decoded from pg_trigger.tgargs (NUL-separated).
create function pg_temp.tgargs(p bytea) returns text[] language sql immutable as $$
  select coalesce(array_remove(string_to_array(encode(p, 'escape'), '\000'), ''), '{}'::text[])
$$;
-- The narrow scope: the 16 marked tables and their person columns, in the
-- order the migration passes them to tg_mark_deleted_users.
create temp table marked (tbl text primary key, cols text[] not null);
insert into marked values
  ('approvals',                   array['decided_by', 'requested_by']),
  ('audit_logs',                  array['user_id']),
  ('carrier_shipments',           array['purchased_by']),
  ('cycle_count_ai_scans',        array['confirmed_by', 'created_by']),
  ('org_connections',             array['created_by']),
  ('organization_invites',        array['invited_by']),
  ('organization_modules',        array['enabled_by']),
  ('platform_admin_audit',        array['actor_user_id', 'target_user_id']),
  ('po_imports',                  array['approved_by', 'uploaded_by']),
  ('putaway_moves',               array['performed_by']),
  ('receipts',                    array['received_by']),
  ('returns',                     array['approved_by', 'closed_by', 'denied_by', 'received_by', 'requested_by']),
  ('schedule_events',             array['assigned_user_id', 'created_by', 'updated_by']),
  ('size_count_training_samples', array['captured_by']),
  ('stock_movements',             array['user_id']),
  ('uom_conversions',             array['approved_by', 'created_by']);
-- Every row of every marked table, keyed by id (organization_modules: by
-- organization and module), as jsonb.
create function pg_temp.marked_rows() returns table (o_tbl text, o_k text, o_j jsonb) language plpgsql as $$
declare v_t text;
begin
  for v_t in select m.tbl from marked m order by m.tbl loop
    return query execute format(
      'select %L::text, coalesce(to_jsonb(r) ->> ''id'', (to_jsonb(r) ->> ''organization_id'') || '':'' || (to_jsonb(r) ->> ''module_id'')), to_jsonb(r) from public.%I r',
      v_t, v_t);
  end loop;
end $$;
-- Rows of every single-column foreign key in public whose value has no
-- parent (0 expected: a trigger that reverts a SET NULL leaves one, 2.5).
create function pg_temp.dangling() returns text language plpgsql as $$
declare r record; n bigint; v_out text := '';
begin
  for r in
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref, ra.attname as refcol
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = c.confkey[1]
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
     order by 1, 2
  loop
    execute format('select count(*) from %s x where x.%I is not null and not exists (select 1 from %s p where p.%I = x.%I)',
                   r.tbl, r.col, r.ref, r.refcol, r.col) into n;
    if n > 0 then
      v_out := v_out || r.tbl || '.' || r.col || '=' || n || ' ';
    end if;
  end loop;
  return v_out;
end $$;
-- Rows queued for pg_net, if the extension is present.
create function pg_temp.net_queue() returns bigint language plpgsql as $$
declare n bigint := 0;
begin
  if to_regclass('net.http_request_queue') is not null then
    execute 'select count(*) from net.http_request_queue' into n;
  end if;
  return n;
end $$;
create temp view fn_scope as
select n.nspname || '.' || p.proname as fn, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and n.nspname !~ '^pg_(toast_)?temp_'
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

-- ══ K. Catalog ════════════════════════════════════════════════════════════
select is(
  (select md5(string_agg(f.s, ',' order by f.s collate "C")) || '|' || count(*)
     from (select c.conrelid::regclass::text || '.' || a.attname || '>' || c.confrelid::regclass::text || ':'
                  || c.confdeltype::text || case when a.attnotnull then ':NN' else '' end as s
             from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass)
              and c.connamespace = 'public'::regnamespace) f)
  || '|' || (select (count(*) filter (where array_length(c.conkey, 1) > 1))::text || '/'
                    || (count(*) filter (where c.confdelsetcols is not null))::text
               from pg_constraint c
              where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass)),
  -- Production d05804c6ca1f8bee2744301f5b1e43bb|130 before 0394; this value
  -- is production's own keys with exactly 0394's changes applied (19 SET
  -- NULL, 9 NOT NULL dropped, delivery_locations CASCADE, 4 new keys).
  'afc55a5ab973223f06d7c9d0245929f1|134|0/0',
  'K1: the person-key census in public is 0394''s (134 keys), and no key to a person is composite or names SET NULL columns');
select is(
  (select coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname || ':' || c.confdeltype::text, ',' order by 1), '')
     from pg_constraint c
    where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass)
      and c.confdeltype not in ('n', 'c')),
  '',
  'K2: no key to a person, in any schema, is RESTRICT, NO ACTION or SET DEFAULT: none refuses a deletion');
select is(
  (select string_agg(c.conrelid::regclass::text || '.' || a.attname, ',' order by (c.conrelid::regclass::text || '.' || a.attname) collate "C")
     from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass)
      and c.connamespace = 'public'::regnamespace and c.confdeltype = 'c'),
  'ai_chat_sessions.user_id,customer_users.user_id,delivery_locations.driver_user_id,import_jobs.user_id,'
  'mfa_recovery_codes.user_id,notification_preferences.user_id,notifications.user_id,order_submissions.user_id,'
  'organization_members.user_id,platform_impersonation_sessions.admin_user_id,push_tokens.user_id,saved_views.user_id,'
  'user_category_assignments.user_id,user_login_devices.user_id,user_onboarding.user_id,user_permission_overrides.user_id,'
  'user_profiles.id,user_release_state.user_id,user_warehouse_assignments.user_id',
  'K3: the person keys in public that cascade are exactly the 19 personal ones (0394 adds the driver''s live position and the placer''s submission log; invites move to SET NULL)');
select is(
  (select string_agg(c.relname, ',' order by c.relname collate "C")
     from pg_attribute a join pg_class c on c.oid = a.attrelid
    where a.attname = 'deleted_users' and not a.attisdropped and c.relnamespace = 'public'::regnamespace and c.relkind = 'r')
  || '#' ||
  (select coalesce(string_agg(m.tbl, ',' order by m.tbl), '')
     from marked m
    where m.cols is distinct from (
            select array_agg(a.attname::text order by a.attname collate "C")
              from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             where c.conrelid = ('public.' || m.tbl)::regclass and c.contype = 'f'
               and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass)
               and c.confdeltype = 'n')),
  'approvals,audit_logs,carrier_shipments,cycle_count_ai_scans,org_connections,organization_invites,organization_modules,'
  'platform_admin_audit,po_imports,putaway_moves,receipts,returns,schedule_events,size_count_training_samples,'
  'stock_movements,uom_conversions#',
  'K4: deleted_users is on exactly the 16 tables of the narrow scope (the 14 whose key 0394 changes, audit_logs, stock_movements), and on each the marked columns are exactly its SET NULL person columns');
select is(
  (select coalesce(string_agg(c.conrelid::regclass::text || '.' || a.attname, ',' order by 1), '')
     from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass)
      and c.connamespace = 'public'::regnamespace and a.attnotnull and c.confdeltype <> 'c'),
  '',
  'K5: no person column in public is NOT NULL unless its key cascades (the nine relaxed columns lost NOT NULL)');
select is(
  (select string_agg(c.conrelid::regclass::text || '.' || c.conname || ':' || c.convalidated::text, ',' order by c.conname collate "C")
     from pg_constraint c
    where c.connamespace = 'public'::regnamespace and c.contype = 'c'
      and (c.conname like '%\_deleted\_chk' and c.conname <> 'order_requests_requester_deleted_chk'
           or c.conname = 'cc_ai_scans_confirm_chk')),
  'approvals.approvals_requested_by_deleted_chk:true,cycle_count_ai_scans.cc_ai_scans_confirm_chk:true,'
  'cycle_count_ai_scans.cycle_count_ai_scans_created_by_deleted_chk:true,organization_invites.organization_invites_invited_by_deleted_chk:true,'
  'platform_admin_audit.platform_admin_audit_actor_user_id_deleted_chk:true,po_imports.po_imports_uploaded_by_deleted_chk:true,'
  'putaway_moves.putaway_moves_performed_by_deleted_chk:true,receipts.receipts_received_by_deleted_chk:true,'
  'schedule_events.schedule_events_created_by_deleted_chk:true,'
  'size_count_training_samples.size_count_training_samples_captured_by_deleted_chk:true',
  'K6: the nine exactly-one CHECKs and the relaxed cc_ai_scans_confirm_chk exist and are validated');
select is(
  (select coalesce(string_agg(x.tbl || ':' || x.problem, ',' order by x.tbl), '')
     from (
       select m.tbl,
              case
                when (select count(*) from pg_trigger t
                       where t.tgrelid = ('public.' || m.tbl)::regclass and t.tgname like 'zzz\_deleted\_users\_%') <> 2
                  then 'count'
                when not exists (
                       select 1 from pg_trigger t
                        where t.tgrelid = ('public.' || m.tbl)::regclass and t.tgname = 'zzz_deleted_users_ins'
                          and t.tgtype = 7 and t.tgenabled = 'O' and t.tgfoid = 'public.tg_mark_deleted_users()'::regprocedure
                          and pg_temp.tgargs(t.tgargs) = m.cols
                          and position('WHEN ((new.deleted_users IS NOT NULL))' in pg_get_triggerdef(t.oid)) > 0)
                  then 'ins'
                when not exists (
                       select 1 from pg_trigger t
                        where t.tgrelid = ('public.' || m.tbl)::regclass and t.tgname = 'zzz_deleted_users_upd'
                          and t.tgtype = 19 and t.tgenabled = 'O' and t.tgfoid = 'public.tg_mark_deleted_users()'::regprocedure
                          and pg_temp.tgargs(t.tgargs) = m.cols
                          and position('(old.deleted_users IS NOT NULL)' in pg_get_triggerdef(t.oid)) > 0
                          and position('(new.deleted_users IS NOT NULL)' in pg_get_triggerdef(t.oid)) > 0
                          and (select bool_and(position(format('(old.%s IS NOT NULL) AND (new.%s IS NULL)', c, c) in pg_get_triggerdef(t.oid)) > 0)
                                 from unnest(m.cols) c)
                          and (select count(*) from regexp_matches(pg_get_triggerdef(t.oid), ' IS NULL\)', 'g')) = cardinality(m.cols))
                  then 'upd'
                when (select max(t.tgname collate "C") from pg_trigger t
                       where t.tgrelid = ('public.' || m.tbl)::regclass and not t.tgisinternal
                         and (t.tgtype & 3) = 3 and (t.tgtype & 4) = 4) <> 'zzz_deleted_users_ins'
                  then 'ins-not-last'
                when (select max(t.tgname collate "C") from pg_trigger t
                       where t.tgrelid = ('public.' || m.tbl)::regclass and not t.tgisinternal
                         and (t.tgtype & 3) = 3 and (t.tgtype & 16) = 16) <> 'zzz_deleted_users_upd'
                  then 'upd-not-last'
              end as problem
         from marked m) x
    where x.problem is not null),
  '',
  'K7: each marked table has exactly the zzz_deleted_users_ins/_upd pair: BEFORE INSERT (WHEN a stamp is written) and BEFORE UPDATE (WHEN a stamp exists or is written, or a person column goes from set to null, one term per column and no other) FOR EACH ROW, enabled, running tg_mark_deleted_users with the table''s person columns, last of the BEFORE row triggers by name (they see every earlier trigger''s change)');
select is(
  (select coalesce(string_agg(m.tbl, ',' order by m.tbl), '')
     from marked m
    where not exists (select 1 from pg_attribute a
                       where a.attrelid = ('public.' || m.tbl)::regclass and a.attname = 'deleted_users' and not a.attisdropped
                         and a.atttypid = 'jsonb'::regtype and not a.attnotnull and not a.atthasdef))
  || '|' || has_column_privilege('authenticated', 'public.schedule_events', 'deleted_users', 'SELECT')::text
  || ',' || has_column_privilege('authenticated', 'public.schedule_events', 'deleted_users', 'INSERT')::text
  || ',' || has_column_privilege('authenticated', 'public.schedule_events', 'deleted_users', 'UPDATE')::text,
  '|true,false,false',
  'K8: deleted_users is jsonb, nullable, with no default (a catalog-only add) on all 16 tables; on schedule_events (column grants, 0384) authenticated may read it and may not insert or update it');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
     from pg_proc p where p.oid = to_regprocedure('public.tg_mark_deleted_users()')),
  'd37ffc38926ea5ca42cd2812efa51802|false|{"search_path=public, pg_temp"}|postgres|false|false|false',
  'K9: tg_mark_deleted_users is 0394''s body, SECURITY INVOKER (an FK action runs as the table owner; a DEFINER would make every caller postgres), search_path pinned, owned by postgres, not executable by PUBLIC, anon or authenticated');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || (select string_agg(a::text, ',' order by a::text collate "C") from unnest(p.proacl) a)
     from pg_proc p where p.oid = to_regprocedure('public.tg_auth_users_before_delete()'))
  || '#' || (select string_agg(distinct m[1], ',' order by m[1])
               from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
              where p.oid = to_regprocedure('public.tg_auth_users_before_delete()')),
  -- Re-pinned by the review fix (was e2aeabeff7339b21b86f95788a597d6a ... #P0001): the lock loop (race 7e) and its 55P03.
  '88fbc1c4a826334245675b24b3d23106|true|{"search_path=public, pg_temp"}|postgres|postgres=X/postgres,service_role=X/postgres#55P03,P0001',
  'K10: tg_auth_users_before_delete is 0394''s body, SECURITY DEFINER (it must release rows the deleting role cannot touch), search_path pinned, owned by postgres, EXECUTE for postgres and service_role only (a trigger function needs none to fire), and it raises only P0001 (last_owner) and 55P03 (owner rows kept changing: try again), never 40001 or 40P01');
select is(
  (select t.tgtype::text || '|' || t.tgenabled::text || '|' || t.tgfoid::regproc::text
     from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname = 'on_auth_user_before_delete'),
  '11|O|tg_auth_users_before_delete',
  'K10b: on_auth_user_before_delete is BEFORE DELETE FOR EACH ROW on auth.users, enabled: it runs before any cascade on every path (GoTrue, the dry run, the dashboard)');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || ('search_path=""' = any (p.proconfig))::text || '|' || pg_get_userbyid(p.proowner) || '|'
          || (select string_agg(a::text, ',' order by a::text collate "C") from unnest(p.proacl) a)
     from pg_proc p where p.oid = to_regprocedure('public._account_exists(uuid)')),
  '3b8a465c85fc816ea2ad5c8c57ede301|true|true|postgres|postgres=X/postgres,service_role=X/postgres',
  'K11: _account_exists is 0394''s body, SECURITY DEFINER with an empty search_path (service_role cannot read auth.users), EXECUTE for postgres and service_role only');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || (select string_agg(a::text, ',' order by a::text collate "C") from unnest(p.proacl) a)
     from pg_proc p where p.oid = to_regprocedure('public._enforce_schedule_events_writer()')),
  '46bfd5262da44f0586892f0bf4178f6b|false|{search_path=public}|postgres|postgres=X/postgres,service_role=X/postgres',
  'K12: _enforce_schedule_events_writer is 0394''s body (a null created_by stands only when a non-API role nulls it and the account is gone), SECURITY INVOKER, search_path=public (0329 pins that value), grants unchanged');
select is(
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('public', 'auth') and c.condeferrable)::text
  || '/' ||
  (select count(*) from pg_trigger t join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace
    where n.nspname in ('public', 'auth') and t.tgconstraint <> 0 and t.tgdeferrable)::text,
  '0/0',
  'K13: nothing in public or auth is DEFERRABLE: every check of a deletion fires inside account_deletion_check''s subtransaction (0388 P8)');
select is(
  (select coalesce(string_agg(f.fn, ',' order by f.fn collate "C"), '') from fn_scope f where f.prosrc ~ '\mdeleted_users\M'),
  'public.tg_mark_deleted_users',
  'K14: in every schema, the only function whose body names deleted_users is tg_mark_deleted_users (no other path writes the marker)');
select is(
  (select coalesce(string_agg(f.fn || ':' || f.owner || ':' || f.prosecdef::text, ',' order by f.fn collate "C"), '')
     from fn_scope f
    where f.prosrc ~* $re$delete\s+from\s+(only\s+)?("?auth"?\s*\.\s*"?users\M"?|("?public"?\s*\.\s*)?"?user_profiles\M"?)$re$),
  'public.account_deletion_check:postgres:true',
  'K15: the only function that deletes from auth.users or user_profiles is still account_deletion_check (0388 C1; the 0394 trigger releases, it never deletes an account)');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || (select string_agg(a::text, ',' order by a::text collate "C") from unnest(p.proacl) a)
     from pg_proc p where p.oid = to_regprocedure('public.transfer_org_ownership(uuid, uuid, uuid)')),
  '777da8ae49fdeabee55bb49f7259b9a2|true|{search_path=public}|postgres|postgres=X/postgres,service_role=X/postgres',
  'K16: transfer_org_ownership is 0394''s body (both rows locked FOR UPDATE, seats ignored, both updates checked), SECURITY DEFINER, search_path=public, service_role only as before');
create temp table f12_ref (
  id uuid not null,
  fulfillment_type text,
  delivery_charter_id uuid,
  constraint order_requests_delivery_target_chk check (
    (fulfillment_type = 'delivery' and delivery_charter_id is not null)
    or (fulfillment_type = 'pickup' and delivery_charter_id is null)
    or (id = any ('{20ad4cb9-733e-4348-a4fd-074f43ce2025,5cf416da-e6ee-47a1-bbfd-34a473f920d4,76f4f559-3947-4f75-b389-1bde004bfcce,8827813a-b336-4b22-93f4-00134069a322,989b85ca-0e72-492b-af62-01340aab0219}'::uuid[])
        and fulfillment_type = 'delivery'
        and delivery_charter_id is null)));
select is(
  (select coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname, ','), '')
     from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('public', 'auth') and not c.convalidated)
  || '|' || (select (pg_get_constraintdef(c.oid) = (select pg_get_constraintdef(r.oid) from pg_constraint r
                                                      where r.conrelid = 'pg_temp.f12_ref'::regclass
                                                        and r.conname = 'order_requests_delivery_target_chk'))::text
                    || '/' || c.convalidated::text
               from pg_constraint c
              where c.conrelid = 'public.order_requests'::regclass and c.conname = 'order_requests_delivery_target_chk'),
  '|true/true',
  'K18: F12: no NOT VALID constraint is left in public or auth (a NOT VALID CHECK refused the FK''s SET NULL on 5 legacy orders), and order_requests_delivery_target_chk is 0394''s text (the two arms plus the five legacy ids in their legacy shape) and validated');
select is(
  (select string_agg(t.tgname, ',' order by t.tgname collate "C") from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal),
  'on_auth_user_before_delete,on_auth_user_created,on_auth_user_email_updated',
  'K19: auth.users carries exactly the two earlier triggers and 0394''s');
select is(
  (select bool_and(coalesce(obj_description(p.oid, 'pg_proc') ~ '0394', false))::text
     from pg_proc p
    where p.oid in (to_regprocedure('public.tg_mark_deleted_users()'), to_regprocedure('public.tg_auth_users_before_delete()'),
                    to_regprocedure('public._account_exists(uuid)'), to_regprocedure('public._enforce_schedule_events_writer()'),
                    to_regprocedure('public.transfer_org_ownership(uuid, uuid, uuid)')))
  || '|' || (select bool_and(coalesce(col_description(('public.' || m.tbl)::regclass,
                                                      (select a.attnum from pg_attribute a
                                                        where a.attrelid = ('public.' || m.tbl)::regclass and a.attname = 'deleted_users'))
                                      ~ '0394', false))::text
               from marked m)
  || '|' || (select bool_and(coalesce(obj_description(c.oid, 'pg_constraint') ~ '0394', false))::text || '/' || count(*)::text
               from pg_constraint c
              where c.connamespace = 'public'::regnamespace
                and (c.conname like '%\_deleted\_chk' and c.conname <> 'order_requests_requester_deleted_chk'
                     or c.conname in ('cc_ai_scans_confirm_chk', 'order_requests_delivery_target_chk', 'order_submissions_user_id_fkey',
                                      'delivery_locations_driver_user_id_fkey', 'user_permission_overrides_updated_by_fkey',
                                      'role_permission_overrides_updated_by_fkey', 'user_profiles_disabled_by_fkey'))),
  'true|true|true/16',
  'K20: the five functions, the 16 deleted_users columns and the 16 constraints 0394 adds or restates say so in their comments');

select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
     from pg_proc p where p.oid = to_regprocedure('public._guard_organization_member_changes()'))
  || '#' || (select t.tgtype::text || '/' || t.tgenabled::text from pg_trigger t
              where t.tgrelid = 'public.organization_members'::regclass and t.tgname = 'organization_members_role_guard'),
  'b48c165e5ff1ae0e8bbf159ab97c0d42|true|{search_path=public}|postgres|false|false#31/O',
  'K21: _guard_organization_member_changes is 0394''s body (review: an API caller may change only role, is_delivery_driver and all_warehouses on a membership, and may not create an "Act as" seat), SECURITY DEFINER, search_path=public (0329), not executable by anon or authenticated, still BEFORE INSERT OR UPDATE OR DELETE on organization_members');

-- ══ Fixtures ══════════════════════════════════════════════════════════════
-- full_name and email feed D12: no row may gain a deleted person's name or
-- email. sub (P) is the subject: history in every marked column, open and
-- closed work of every kind the trigger releases, and personal rows.
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,  '0394-own@test.local',  '{"full_name": "Own Er 0394"}'::jsonb),
  (:mgr,  '0394-mgr@test.local',  '{"full_name": "Man Ager 0394"}'::jsonb),
  (:stf,  '0394-stf@test.local',  '{"full_name": "Sta Ff 0394"}'::jsonb),
  (:sub,  '0394-sub@test.local',  '{"full_name": "Sub Ject 0394"}'::jsonb),
  (:pa,   '0394-pa@test.local',   '{"full_name": "Plat Form 0394"}'::jsonb),
  (:own2, '0394-own2@test.local', '{"full_name": "Solo Owner 0394"}'::jsonb),
  (:pend, '0394-pend@test.local', '{"full_name": "Pen Ding 0394"}'::jsonb),
  (:xinv, '0394-xinv@test.local', '{"full_name": "Ex Inviter 0394"}'::jsonb),
  (:c1o,  '0394-c1o@test.local',  '{"full_name": "Co Owner One 0394"}'::jsonb),
  (:c2o,  '0394-c2o@test.local',  '{"full_name": "Co Owner Two 0394"}'::jsonb),
  (:cst,  '0394-cst@test.local',  '{"full_name": "Co Staff 0394"}'::jsonb),
  (:own3, '0394-own3@test.local', '{"full_name": "Two Orgs 0394"}'::jsonb),
  (:dmem, '0394-dmem@test.local', '{"full_name": "Dee Member 0394"}'::jsonb),
  (:own4, '0394-own4@test.local', '{"full_name": "Seat Org Owner 0394"}'::jsonb),
  (:est,  '0394-est@test.local',  '{"full_name": "Seat Org Staff 0394"}'::jsonb),
  (:cust, '0394-cust@test.local', '{"full_name": "Cust Person 0394"}'::jsonb),
  (:q1,   '0394-q1@test.local',   '{"full_name": "Que One 0394"}'::jsonb),
  (:q2,   '0394-q2@test.local',   '{"full_name": "Que Two 0394"}'::jsonb),
  (:leg,  '0394-leg@test.local',  '{"full_name": "Leg Acy 0394"}'::jsonb),
  (:vd,   '0394-vd@test.local',   '{"full_name": "Dis Abled 0394"}'::jsonb),
  (:own5, '0394-own5@test.local', '{"full_name": "Console Owner 0394"}'::jsonb),
  (:fmem, '0394-fmem@test.local', '{"full_name": "Console Member 0394"}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0394 Deletion A', '0394-deletion-a'),
  (:orgB, '0394 Solo B',     '0394-solo-b'),
  (:orgC, '0394 Two Owners', '0394-two-owners'),
  (:orgD, '0394 Second Org', '0394-second-org'),
  (:orgE, '0394 Seat Org',   '0394-seat-org'),
  (:orgF, '0394 Console Org', '0394-console-org');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :own,  'owner',   now(), null),
  (:orgA, :mgr,  'manager', now(), null),
  (:orgA, :stf,  'staff',   now(), null),
  (:orgA, :sub,  'staff',   now(), null),
  (:orgA, :own3, 'staff',   now(), null),
  (:orgB, :own2, 'owner',   now(), null),
  (:orgB, :pend, 'staff',   null,  null),
  (:orgC, :c1o,  'owner',   now(), null),
  (:orgC, :c2o,  'owner',   now(), null),
  (:orgC, :cst,  'staff',   now(), null),
  (:orgD, :own3, 'owner',   now(), null),
  (:orgD, :dmem, 'staff',   now(), null),
  (:orgE, :own4, 'owner',   now(), null),
  (:orgE, :est,  'staff',   now(), null),
  (:orgE, :pa,   'owner',   now(), now() + interval '1 hour'),
  (:orgF, :own5, 'owner',   now(), null),
  (:orgF, :fmem, 'staff',   now(), null);
insert into public.warehouses (id, organization_id, name, code, status, manager_user_id) values
  (:whA, :orgA, '0394 Main', 'WH-0394A', 'active', :sub);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :mgr, :whA, true),
  (:orgA, :stf, :whA, true),
  (:orgA, :sub, :whA, true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itA, :orgA, :whA, '0394-I', '0394 item', 100, 'active', 'none');
insert into public.bins (id, organization_id, warehouse_id, code, name, bin_type) values
  (:binA1, :orgA, :whA, '0394-B1', '0394 Bin 1', 'storage'),
  (:binA2, :orgA, :whA, '0394-B2', '0394 Bin 2', 'storage');
insert into public.purchase_orders (id, organization_id, po_number, status) values (:poA, :orgA, 'PO-0394-A', 'draft');
insert into public.charters (id, organization_id, name, code, status) values (:chA, :orgA, '0394 Charter', 'CH-0394A', 'active');
insert into public.customers (id, organization_id, name) values (:custA, :orgA, '0394 Cust Co');
insert into public.customer_users (customer_id, user_id, email) values (:custA, :cust, '0394-cust@test.local');

-- Orders: an open pick and two open deliveries assigned to P (released), a
-- completed order P picked (kept), an order for the returns and the carrier
-- shipment, and one P placed (its submission row cascades, D20).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, pick_slip_generated_by, pick_slip_generated_at,
   assigned_picker_id, picking_claimed_by, picking_claimed_at,
   assigned_delivery_user_id, assigned_delivery_by, assigned_delivery_at, in_transit_at, in_transit_by,
   completed_at, completed_by) values
  (:oPick,  :orgA, :whA, 'picking_in_progress', 'internal', :stf, 'pickup', null,
   :mgr, now(), :mgr, now(), :sub, :sub, now(), null, null, null, null, null, null, null),
  (:oDrv,   :orgA, :whA, 'staged_for_delivery', 'internal', :stf, 'delivery', :chA,
   :mgr, now(), :mgr, now(), null, null, null, :sub, :mgr, now(), null, null, null, null),
  (:oTrans, :orgA, :whA, 'in_transit', 'internal', :stf, 'delivery', :chA,
   :mgr, now(), :mgr, now(), null, null, null, :sub, :mgr, now(), now(), :mgr, null, null),
  (:oDone,  :orgA, :whA, 'completed', 'internal', :stf, 'pickup', null,
   :mgr, now(), :mgr, now(), :sub, :sub, now(), null, null, null, null, null, now(), :mgr),
  (:oRet,   :orgA, :whA, 'completed', 'internal', :stf, 'pickup', null,
   :mgr, now(), null, null, null, null, null, null, null, null, null, null, now(), :mgr),
  (:oP,     :orgA, :whA, 'pending_approval', 'internal', :sub, 'pickup', null,
   null, null, null, null, null, null, null, null, null, null, null, null, null, null);
insert into public.delivery_locations (organization_id, order_request_id, driver_user_id, lat, lng) values
  (:orgA, :oTrans, :sub, 34.05, -118.25);
insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, order_request_id, surface) values
  (:orgA, :sub, gen_random_uuid(), md5('0394 submission'), 'placed', :oP, 'web');

-- Counts: one in progress assigned to P (released), one completed (kept).
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at, assigned_to, assignment_claimed_at,
   assignment_claimed_by, completed_by, completed_at) values
  (:ccOpen, :orgA, :whA, 'in_progress', 'warehouse', :mgr, now(), :sub, now(), :mgr, null, null),
  (:ccDone, :orgA, :whA, 'completed',   'warehouse', :mgr, now(), :sub, now(), :mgr, :mgr, now());
insert into public.cycle_count_ai_scans
  (id, organization_id, cycle_count_id, created_by, photo_storage_path, model_version, confirmed_at, confirmed_by) values
  (:scan1, :orgA, :ccOpen, :sub, '0394/scan-1.jpg', 'test-0394', now(), :sub);

-- Schedule: scheduled and in-progress entries assigned to P (released), a
-- completed one P created, updated and was assigned (kept), one P created
-- (D8/D13), and a live manager's entry (S, M4, M7).
insert into public.schedule_events (id, organization_id, title, starts_at, status, assigned_user_id, created_by, updated_by) values
  (:seOpen, :orgA, '0394 scheduled', now() + interval '1 day',  'scheduled',   :sub,  :mgr, :mgr),
  (:seProg, :orgA, '0394 underway',  now(),                     'in_progress', :sub,  :mgr, :mgr),
  (:seDone, :orgA, '0394 done',      now() - interval '1 day',  'completed',   :sub,  :sub, :sub),
  (:seCre,  :orgA, '0394 created',   now() + interval '2 days', 'scheduled',   null,  :sub, :sub),
  (:seLive, :orgA, '0394 live',      now() + interval '3 days', 'scheduled',   :stf,  :mgr, :mgr);

-- Maintenance and exceptions: open work owned or claimed by P (released) and
-- closed work (kept).
insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description, priority, status,
   local_owner_user_id, resolved_at, resolved_by, resolved_by_name_snapshot) values
  (:mrOpen, :orgA, :stf, 'Sta Ff', 'Broken door 0394', 'It sticks', 'normal', 'saved',    :sub, null,  null, null),
  (:mrDone, :orgA, :stf, 'Sta Ff', 'Broken lamp 0394', 'Flickers',  'normal', 'resolved', :sub, now(), :sub, 'Resolver');
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, warehouse_id, first_seen_at, last_seen_at, resolved_at, resolved_reason,
   escalation_claimed_by, escalation_claimed_at) values
  (:exOpen, :orgA, 1, 'label_mismatch', :itA, :whA, now(), now(), null,  null,      :sub, now()),
  (:exDone, :orgA, 2, 'label_mismatch', :itA, :whA, now(), now(), now(), 'cleared', :sub, now());

-- History on the 14 tables whose key 0394 changed, and the two log tables.
insert into public.receipts (id, organization_id, purchase_order_id, warehouse_id, receipt_number, received_by, immutable_hash) values
  (:rcpt1, :orgA, :poA, :whA, 'RCV-0394-1', :sub, repeat('b', 64)),
  (:rcptQ, :orgA, :poA, :whA, 'RCV-0394-2', :q1,  repeat('d', 64));
insert into public.po_imports (id, organization_id, uploaded_by, approved_by, source_type, file_name, file_mime_type, file_size, storage_path, sha256) values
  (:poi1, :orgA, :sub, :sub, 'csv', '0394.csv', 'text/csv', 10, '0394/po.csv', repeat('c', 64));
insert into public.approvals (id, organization_id, type, related_type, requested_by, payload, status, decided_by) values
  (:appr1, :orgA, 'manual_adjustment', 'inventory_item', :sub, '{}'::jsonb, 'approved', :sub);
insert into public.putaway_moves (id, organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by) values
  (:put1, :orgA, :whA, :itA, :binA1, :binA2, 1, 'putaway', :sub);
insert into public.size_count_training_samples (id, organization_id, captured_by, image_storage_path, size_label) values
  (:smp1, :orgA, :sub, '0394/sample.jpg', 'M');
insert into public.returns (id, organization_id, order_request_id, status, requested_by, approved_by, received_by, closed_by, denied_by) values
  (:ret1, :orgA, :oRet, 'closed',   :sub, :sub, :sub, :sub, :sub),
  (:ret2, :orgA, :oRet, 'approved', :stf, :mgr, null, null, null),
  (:retQ, :orgA, :oRet, 'approved', :stf, :q2,  null, null, null);
insert into public.uom_conversions (id, organization_id, item_id, from_uom, to_uom, numerator, created_by, approved_by) values
  (:uom1, :orgA, :itA, 'ea', 'cs', 12, :sub, :sub);
-- X0b: on tables with several person columns, one row per column naming the
-- subject in that column only (the others name a live person or nothing).
insert into public.approvals (id, organization_id, type, related_type, requested_by, payload, status, decided_by) values
  (:appr2, :orgA, 'manual_adjustment', 'inventory_item', :sub, '{}'::jsonb, 'approved', :mgr),
  (:appr3, :orgA, 'manual_adjustment', 'inventory_item', :stf, '{}'::jsonb, 'approved', :sub);
insert into public.cycle_count_ai_scans
  (id, organization_id, cycle_count_id, created_by, photo_storage_path, model_version, confirmed_at, confirmed_by) values
  (:scan2, :orgA, :ccDone, :sub, '0394/scan-2.jpg', 'test-0394', null,  null),
  (:scan3, :orgA, :ccDone, :stf, '0394/scan-3.jpg', 'test-0394', now(), :sub);
insert into public.po_imports (id, organization_id, uploaded_by, approved_by, source_type, file_name, file_mime_type, file_size, storage_path, sha256) values
  (:poi2, :orgA, :sub, null, 'csv', '0394-2.csv', 'text/csv', 10, '0394/po-2.csv', repeat('5', 64)),
  (:poi3, :orgA, :stf, :sub, 'csv', '0394-3.csv', 'text/csv', 10, '0394/po-3.csv', repeat('6', 64));
insert into public.returns (id, organization_id, order_request_id, status, requested_by, approved_by, received_by, closed_by, denied_by) values
  (:ret3, :orgA, :oRet, 'requested', :sub, null, null, null, null),
  (:ret4, :orgA, :oRet, 'approved',  :stf, :sub, null, null, null),
  (:ret5, :orgA, :oRet, 'received',  :stf, null, :sub, null, null),
  (:ret6, :orgA, :oRet, 'closed',    :stf, null, null, :sub, null),
  (:ret7, :orgA, :oRet, 'denied',    :stf, null, null, null, :sub);
insert into public.uom_conversions (id, organization_id, item_id, from_uom, to_uom, numerator, created_by, approved_by) values
  (:uom2, :orgA, :itA, 'ea', 'pk', 6, :sub, null),
  (:uom3, :orgA, :itA, 'ea', 'bx', 24, :stf, :sub);
insert into public.schedule_events (id, organization_id, title, starts_at, status, assigned_user_id, created_by, updated_by) values
  (:seAsg, :orgA, '0394 done, assigned only', now() - interval '2 days', 'completed', :sub, :mgr, :mgr),
  (:seCr2, :orgA, '0394 created only',        now() + interval '4 days', 'scheduled', null, :sub, :mgr),
  (:seUpd, :orgA, '0394 updated only',        now() + interval '5 days', 'scheduled', null, :mgr, :sub);
insert into public.org_connections (id, organization_id, provider_id, created_by) values
  (:conn1, :orgA, 'test_provider_0394', :sub);
insert into public.carrier_shipments (id, organization_id, order_request_id, purchased_by) values
  (:cs1, :orgA, :oRet, :sub);
insert into public.organization_modules (organization_id, module_id, tier, enabled_by, settings) values
  (:orgA, 'maintenance_requests', 'optional', :sub,
   jsonb_build_object('notifyAudience', jsonb_build_object(:sub, 'all', :mgr, 'all'), 'keep', 1))
  on conflict (organization_id, module_id) do update set enabled_by = excluded.enabled_by, settings = excluded.settings;
insert into public.platform_admin_audit (id, actor_user_id, actor_email, action, target_user_id) values
  (:pa1, :sub, '0394-sub@test.local', 'viewed_org', null),
  (:pa2, :own, '0394-own@test.local', 'viewed_org', :sub),
  (:pa4, :own, '0394-own@test.local', 'viewed_org', :mgr);
-- pa3 carries a stamp written by a non-API role (postgres): kept, because its
-- column is null (M2, M3).
insert into public.platform_admin_audit (id, actor_user_id, actor_email, action, target_user_id, deleted_users) values
  (:pa3, :own, '0394-own@test.local', 'viewed_org', null, '{"target_user_id": "2026-10-01T00:00:00+00:00"}'::jsonb);
insert into public.organization_invites (id, organization_id, email, role, token, expires_at, invited_by, accepted_at) values
  (:invP,   :orgA, '0394-newcomer@test.local', 'staff', '0394-token-pending',  now() + interval '7 days', :sub,  null),
  (:invAcc, :orgA, '0394-mgr@test.local',      'staff', '0394-token-accepted', now() + interval '7 days', :sub,  now()),
  (:invB1,  :orgB, '0394-b1@test.local',       'staff', '0394-token-b1',       now() + interval '7 days', :own2, null),
  (:invB2,  :orgB, '0394-b2@test.local',       'staff', '0394-token-b2',       now() + interval '7 days', :xinv, null);
insert into public.audit_logs (id, organization_id, user_id, event) values
  (:al1, :orgA, :sub,  'test.0394'),
  (:alB, :orgB, :own2, 'test.0394.b');
insert into public.stock_movements (id, organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id) values
  (:sm1, :orgA, :itA, 'adjust', 1, 100, 101, :sub);
-- Personal and keyless rows: P's own override, an override and a role
-- override P last changed, and a profile P disabled.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted, updated_by) values
  (:orgA, :sub, 'orders:approve', true, null),
  (:orgA, :stf, 'orders:approve', true, :sub);
insert into public.role_permission_overrides (organization_id, role, permission, granted, updated_by) values
  (:orgA, 'viewer', 'orders:request', true, :sub);
update public.user_profiles set disabled_at = now(), disabled_reason = '0394 test', disabled_by = :sub where id = :vd;

-- ══ X0. Coverage ══════════════════════════════════════════════════════════
create temp table snap0 as select * from pg_temp.marked_rows();
select is(
  (select coalesce(string_agg(m.tbl || '.' || c.col, ',' order by m.tbl, c.col), '')
     from marked m cross join lateral unnest(m.cols) c(col)
    where not exists (select 1 from snap0 s where s.o_tbl = m.tbl and s.o_j ->> c.col = :sub)),
  '',
  'X0: the fixture names the subject in every one of the 27 marked person columns (a new marked column without a fixture fails here)');
select is(
  (select coalesce(string_agg(m.tbl || '.' || c.col, ',' order by m.tbl, c.col), '')
     from marked m cross join lateral unnest(m.cols) c(col)
    where cardinality(m.cols) > 1
      and not exists (select 1 from snap0 s
                       where s.o_tbl = m.tbl and s.o_j ->> c.col = :sub
                         and not exists (select 1 from unnest(m.cols) o(col)
                                          where o.col <> c.col and s.o_j ->> o.col = :sub))),
  '',
  'X0b: on every table with several marked columns, each column names the subject on a row where no other person column does, so each WHEN term of its _upd trigger is exercised on its own');

-- ══ C1. The exactly-one CHECKs refuse a live person nulled ════════════════
select is(
  (select string_agg(x.tbl || '=' || pg_temp.attempt('service_role', null,
                                     format('update public.%I set %I = null where id = %L', x.tbl, x.col, x.rid)),
                     E'\n' order by x.tbl)
     from (values ('approvals', 'requested_by', :appr1::uuid), ('cycle_count_ai_scans', 'created_by', :scan1::uuid),
                  ('organization_invites', 'invited_by', :invP::uuid), ('platform_admin_audit', 'actor_user_id', :pa1::uuid),
                  ('po_imports', 'uploaded_by', :poi1::uuid), ('putaway_moves', 'performed_by', :put1::uuid),
                  ('receipts', 'received_by', :rcpt1::uuid), ('size_count_training_samples', 'captured_by', :smp1::uuid)) x(tbl, col, rid)),
  E'approvals=23514:-:new row for relation "approvals" violates check constraint "approvals_requested_by_deleted_chk"\n'
  'cycle_count_ai_scans=23514:-:new row for relation "cycle_count_ai_scans" violates check constraint "cycle_count_ai_scans_created_by_deleted_chk"\n'
  'organization_invites=23514:-:new row for relation "organization_invites" violates check constraint "organization_invites_invited_by_deleted_chk"\n'
  'platform_admin_audit=23514:-:new row for relation "platform_admin_audit" violates check constraint "platform_admin_audit_actor_user_id_deleted_chk"\n'
  'po_imports=23514:-:new row for relation "po_imports" violates check constraint "po_imports_uploaded_by_deleted_chk"\n'
  'putaway_moves=23514:-:new row for relation "putaway_moves" violates check constraint "putaway_moves_performed_by_deleted_chk"\n'
  'receipts=23514:-:new row for relation "receipts" violates check constraint "receipts_received_by_deleted_chk"\n'
  'size_count_training_samples=23514:-:new row for relation "size_count_training_samples" violates check constraint "size_count_training_samples_captured_by_deleted_chk"',
  'C1: service_role nulling a LIVE person in a relaxed column is refused by its exactly-one CHECK (23514, where it was 23502 before 0394): only an account deletion stamps');

-- ══ S. The schedule writer ════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.schedule_events set created_by = %L where id = %L', :stf, :seLive), null,
                  format('select created_by::text from public.schedule_events where id = %L', :seLive))
  || ' | ' ||
  pg_temp.attempt('service_role', null, format('update public.schedule_events set created_by = %L where id = %L', :stf, :seLive), null,
                  format('select created_by::text from public.schedule_events where id = %L', :seLive))
  || ' | ' ||
  pg_temp.attempt('service_role', null, format('update public.schedule_events set created_by = null where id = %L', :seLive), null,
                  format('select coalesce(created_by::text, ''null'') || ''/'' || coalesce(deleted_users::text, ''null'') from public.schedule_events where id = %L', :seLive)),
  'ok:1:' || :mgr || ' | ok:1:' || :mgr || ' | ok:1:' || :mgr || '/null',
  'S1-S3: no role moves a schedule entry''s creator (an API role, service_role) and no role clears a LIVE creator: the writer restores it, so no stamp and no CHECK failure');

-- ══ M. Marker semantics ═══════════════════════════════════════════════════
-- platform_admin_audit has RLS and no policy, so each probe adds its own. An
-- UPDATE with a WHERE clause also needs a SELECT policy to see the row (test
-- stage fix: M2/M3a first ran with the UPDATE policy only and matched 0 rows).
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.platform_admin_audit (id, actor_user_id, actor_email, action, deleted_users)
                            values (%L, %L, '0394-mgr@test.local', 'viewed_org', '{"actor_user_id": "2026-01-01T00:00:00+00:00"}'::jsonb)$q$, :pa5, :mgr),
                  'create policy zz_0394_probe_ins on public.platform_admin_audit for insert to authenticated with check (true)',
                  format('select coalesce(deleted_users::text, ''null'') from public.platform_admin_audit where id = %L', :pa5)),
  'ok:1:null',
  'M1: an API role''s insert carrying a stamp stores none (a probe policy lets authenticated insert, so only the trigger decides)');
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$update public.platform_admin_audit set deleted_users = '{"actor_user_id": "2026-01-01T00:00:00+00:00"}'::jsonb where id = %L$q$, :pa4),
                  'create policy zz_0394_probe_upd on public.platform_admin_audit for update to authenticated using (true) with check (true); '
                  'create policy zz_0394_probe_sel on public.platform_admin_audit for select to authenticated using (true)',
                  format('select coalesce(deleted_users::text, ''null'') from public.platform_admin_audit where id = %L', :pa4))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
                  format('update public.platform_admin_audit set deleted_users = null where id = %L', :pa3),
                  'create policy zz_0394_probe_upd on public.platform_admin_audit for update to authenticated using (true) with check (true); '
                  'create policy zz_0394_probe_sel on public.platform_admin_audit for select to authenticated using (true)',
                  format('select coalesce(deleted_users ->> ''target_user_id'', ''null'') from public.platform_admin_audit where id = %L', :pa3))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
                  format($q$update public.platform_admin_audit set deleted_users = '{"target_user_id": "1999-01-01T00:00:00+00:00"}'::jsonb where id = %L$q$, :pa3),
                  'create policy zz_0394_probe_upd on public.platform_admin_audit for update to authenticated using (true) with check (true); '
                  'create policy zz_0394_probe_sel on public.platform_admin_audit for select to authenticated using (true)',
                  format('select coalesce(deleted_users ->> ''target_user_id'', ''null'') from public.platform_admin_audit where id = %L', :pa3)),
  'ok:1:null | ok:1:2026-10-01T00:00:00+00:00 | ok:1:2026-10-01T00:00:00+00:00',
  'M2: an API role can neither add a stamp, nor erase one, nor change one (the trigger keeps the old stamps)');
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format('update public.platform_admin_audit set target_user_id = %L where id = %L', :mgr, :pa3),
                  'create policy zz_0394_probe_upd on public.platform_admin_audit for update to authenticated using (true) with check (true); '
                  'create policy zz_0394_probe_sel on public.platform_admin_audit for select to authenticated using (true)',
                  format($q$select coalesce(deleted_users::text, 'null') || '/' || target_user_id::text from public.platform_admin_audit where id = %L$q$, :pa3)),
  'ok:1:null/' || :mgr,
  'M3a: when a stamped column names a live person again (here by an API role), its stamp is dropped');
select is(
  pg_temp.attempt('service_role', null, format('update public.schedule_events set assigned_user_id = null where id = %L', :seLive), null,
                  format($q$select coalesce(assigned_user_id::text, 'null') || '/' || coalesce(deleted_users::text, 'null') from public.schedule_events where id = %L$q$, :seLive))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format('update public.returns set approved_by = null where id = %L', :ret2), null,
                  format('select coalesce(deleted_users::text, ''null'') from public.returns where id = %L', :ret2)),
  'ok:1:null/null | ok:1:null',
  'M4: a LIVE person nulled by a non-API role (service_role, postgres) gets no stamp: only an account that no longer exists is stamped');
select is(
  pg_temp.attempt('postgres', null, format('delete from public.user_profiles where id = %L', :q1))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format('delete from public.user_profiles where id = %L', :q2), null,
                  format($q$select coalesce(approved_by::text, 'null') || '/' || coalesce(deleted_users::text, 'null') from public.returns where id = %L$q$, :retQ)),
  '23514:-:new row for relation "receipts" violates check constraint "receipts_received_by_deleted_chk"'
  ' | ok:1:null/null',
  'M5: a profile-only delete (the auth account alive; unsupported) stamps nothing: a relaxed column fails closed (23514) and a nullable one is just nulled');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.audit_logs (id, organization_id, user_id, event, deleted_users)
                            values (%L, %L, null, 'test.0394.m6', '{"zz_unknown": "2026-01-01T00:00:00+00:00"}'::jsonb)$q$, :al2, :orgA), null,
                  format('select coalesce(deleted_users::text, ''null'') from public.audit_logs where id = %L', :al2))
  || ' | ' ||
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.audit_logs (id, organization_id, user_id, event, deleted_users)
                            values (%L, %L, %L, 'test.0394.m6', '{"user_id": "2026-01-01T00:00:00+00:00"}'::jsonb)$q$, :al3, :orgA, :mgr), null,
                  format('select coalesce(deleted_users::text, ''null'') from public.audit_logs where id = %L', :al3))
  || ' | ' ||
  pg_temp.attempt('postgres', null,
                  format($q$update public.receipts set deleted_users = '{"received_by": "2026-01-01T00:00:00+00:00"}'::jsonb where id = %L$q$, :rcpt1), null,
                  format('select coalesce(deleted_users::text, ''null'') from public.receipts where id = %L', :rcpt1)),
  'ok:1:null | ok:1:null | ok:1:null',
  'M6: a non-API write keeps only stamps of its own person columns that are null: an unknown key, or a stamp on a column that names a person, is dropped');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.schedule_events set title = '0394 renamed' where id = %L$q$, :seLive), null,
                  format($q$select coalesce(deleted_users::text, 'null') || '/' || updated_by::text || '/' || title from public.schedule_events where id = %L$q$, :seLive)),
  'ok:1:null/' || :mgr || '/0394 renamed',
  'M7: an ordinary API update of an unstamped row (a manager renames an entry) changes only what it writes; the marker stays null');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.audit_logs (id, organization_id, user_id, event, metadata, deleted_users)
                            values (%L, %L, null, 'user.deactivated', jsonb_build_object('entity_id', %L::text),
                                    jsonb_build_object('user_id', now()))$q$, :al4, :orgA, :sub), null,
                  format('select ((deleted_users ->> ''user_id'')::timestamptz = now())::text from public.audit_logs where id = %L', :al4)),
  'ok:1:true',
  'M8: the server''s own account-deletion row (service_role, user_id null, a user_id stamp) is stored with its stamp, so the log reads "Deleted user"');

-- ══ L. The last owner ═════════════════════════════════════════════════════
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own)),
  'P0001:Transfer ownership before deleting the account.:last_owner',
  'L1: deleting the only owner of an organization that has other members is refused by the trigger (P0001 last_owner), on every path');
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :own),
                  format($q$select (select count(*) from auth.users where id = %1$L) || '/'
                                   || (select role from public.organization_members where organization_id = %2$L and user_id = %1$L)$q$, :own, :orgA)),
  '{"table": "public.organization_members", "reason": "blocked", "sqlstate": "P0001", "deletable": false, "constraint": "organization_last_owner"}|1/owner',
  'L2: account_deletion_check (0388, unchanged) reports the refusal with constraint organization_last_owner on public.organization_members, and nothing changed');
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own3))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own3),
                  format($q$update public.organization_members set role = case when user_id = %L then 'admin' else 'owner' end
                             where organization_id = %L and user_id in (%L, %L)$q$, :own3, :orgD, :own3, :dmem),
                  format('select count(*)::text from public.organization_members where user_id = %L', :own3)),
  'P0001:Transfer ownership before deleting the account.:last_owner | ok:1:0',
  'L5: an owner of one organization (with members) who is a member of another is refused because of the first; after the ownership moves (the transfer''s effect) the deletion succeeds and both memberships go');
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own5),
                  format('delete from public.organizations where id = %L', :orgF)),
  'ok:1',
  'L6: the console''s path, the organization removed first and then its orphaned owner: the owner holds no membership any more and is deletable');
select ok(
  pg_temp.attempt('authenticated', :own,
                  format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :own))
    ~ '^(42501:-:cannot remove the owner via direct delete|ok:0)$',
  'L7: the member guard (or RLS) still stops an API-role delete of an owner row: the trigger is not the only line');
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own4))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own4),
                  format($q$update public.organization_members set impersonation_expires_at = now() - interval '1 hour'
                             where organization_id = %L and user_id = %L$q$, :orgE, :pa))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own4),
                  format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgE, :est)),
  'P0001:Transfer ownership before deleting the account.:last_owner'
  ' | P0001:Transfer ownership before deleting the account.:last_owner'
  ' | ok:1',
  'L8: a platform admin''s "Act as" seat (an owner row with impersonation_expires_at) is not a second owner, live or expired: the real only owner with a staff member is refused; with the staff member gone the seat is not "another member" either and the owner is deletable (critique C1)');
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :pa), null,
                  format($q$select count(*)::text from public.organization_members
                             where organization_id = %L and role = 'owner' and accepted_at is not null and impersonation_expires_at is null$q$, :orgE)),
  'ok:1:1',
  'L9: an account whose only owner row is an impersonation seat is not a last owner: deletable, and the organization keeps its real owner');
select is(
  pg_temp.attempt('service_role', null, format('select public.transfer_org_ownership(%L, %L, %L)', :orgA, :own, :xinv))
  || ' | ' ||
  pg_temp.attempt('service_role', null, format('select public.transfer_org_ownership(%L, %L, %L)', :orgA, :own, :mgr), null,
                  format($q$select string_agg(role, '/' order by user_id) from public.organization_members
                             where organization_id = %L and user_id in (%L, %L)$q$, :orgA, :own, :mgr)),
  '22023:-:target user is not an active member of this organization | ok:1:admin/owner',
  'L10: the locked transfer refuses a target with no accepted membership (22023, nothing changed) and still swaps the two roles for a member');
select is(
  pg_temp.attempt('service_role', null, format('select public.transfer_org_ownership(%L, %L, %L)', :orgE, :pa, :est))
  || ' | ' ||
  pg_temp.attempt('service_role', null, format('select public.transfer_org_ownership(%L, %L, %L)', :orgE, :own4, :pa)),
  '42501:-:caller is not the current owner | 22023:-:target user is not an active member of this organization',
  'L11: an impersonation seat can neither hand ownership away (42501) nor receive it (22023)');
-- Re-pinned by the review fix (was: the first statement is one FOR NO KEY
-- UPDATE over the person's rows and the owner rows of the organizations they
-- own; race 7e showed a role changing during that wait could hide an owner).
select ok(
  (select p.prosrc ~ $re$^\s*declare(?:[^;]*;){5}\s*begin\s*loop\s+v_try := v_try \+ 1;\s*select coalesce\(array_agg\(l\.id\), '\{\}'\) into v_new$re$
          and position('for share' in p.prosrc) < position('for no key update' in p.prosrc)
          and position('for no key update' in p.prosrc) < position('exit when not exists' in p.prosrc)
          and position('exit when not exists' in p.prosrc) < position('raise exception ''last_owner''' in p.prosrc)
          and position('raise exception ''last_owner''' in p.prosrc) < position('update public.cycle_counts' in p.prosrc)
          and (select count(*) from regexp_matches(p.prosrc, 'order by m\.id\s+for (share|no key update)', 'g')) = 2
     from pg_proc p where p.oid = to_regprocedure('public.tg_auth_users_before_delete()')),
  'L12: the trigger starts with its lock loop: the owner rows of organizations the person belongs to but does not own FOR SHARE, then the person''s rows and the owner rows of organizations they own FOR NO KEY UPDATE (each in id order), repeated until every owner row is locked, before the last-owner check, which precedes every release (critique C2/C3, review race 7e)');

-- ══ G. The membership guard (review 2026-10-05, High + Medium) ════════════
-- Before 0394 the guard pinned only the role: an admin (or the owner) could
-- rewrite any membership's user_id, accepted_at or impersonation_expires_at
-- through PostgREST. That let an admin hand the owner row to another account
-- or lock the owner out, and let the owner (or an admin) mark the owner row an
-- "Act as" seat, which 0394's last-owner rule and transfer ignore. An API
-- caller (auth.uid() set) may now change only role, is_delivery_driver and
-- all_warehouses, and may not create a seat; the server's admin client (no
-- JWT subject) and an account deletion's own key action are unchanged.
select format($q$update public.organization_members set role = 'admin' where organization_id = %L and user_id = %L$q$, :orgA, :mgr) as promote_mgr \gset
select is(
  (select string_agg(pg_temp.attempt('authenticated', :mgr,
                                     format('update public.organization_members set %s where organization_id = %L and user_id = %L', s.setc, :orgA, :own),
                                     :'promote_mgr'),
                     ' | ' order by s.n)
     from (values (1, format('user_id = %L', :xinv)), (2, 'accepted_at = null'), (3, $v$impersonation_expires_at = '2099-01-01'$v$),
                  (4, format('organization_id = %L', :orgB)), (5, format('invited_by = %L', :mgr)), (6, $v$invited_at = now()$v$),
                  (7, $v$created_at = now() - interval '1 day'$v$), (8, 'id = gen_random_uuid()')) s(n, setc)),
  (select string_agg('42501:-:only role, is_delivery_driver and all_warehouses can change on a membership', ' | ') from generate_series(1, 8)),
  'G1: an org admin can no longer rewrite the owner''s membership through the API: not the account it names, its acceptance, an "Act as" expiry, its organization, who invited it or when, or its id (each 42501, nothing changed)');
select is(
  (select string_agg(pg_temp.attempt('authenticated', :own,
                                     format('update public.organization_members set %s where organization_id = %L and user_id = %L', s.setc, :orgA, s.who)),
                     ' | ' order by s.n)
     from (values (1, $v$impersonation_expires_at = '2099-01-01'$v$, :own::uuid), (2, 'accepted_at = null', :own::uuid),
                  (3, format('user_id = %L', :xinv), :stf::uuid), (4, $v$impersonation_expires_at = now() + interval '1 hour'$v$, :stf::uuid))
          s(n, setc, who))
  || ' # ' || pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :own)),
  (select string_agg('42501:-:only role, is_delivery_driver and all_warehouses can change on a membership', ' | ') from generate_series(1, 4))
  || ' # P0001:Transfer ownership before deleting the account.:last_owner',
  'G2: the owner cannot make their own row an "Act as" seat or unaccept it, nor rewrite a member''s row, so the last-owner refusal cannot be side-stepped: the owner is still refused (P0001 last_owner)');
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$update public.organization_members set role = 'viewer', is_delivery_driver = true, all_warehouses = true
                             where organization_id = %L and user_id = %L$q$, :orgA, :stf), :'promote_mgr')
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
                  format('update public.organization_members set is_delivery_driver = true where organization_id = %L and user_id = %L', :orgA, :own),
                  :'promote_mgr')
  || ' | ' ||
  pg_temp.attempt('authenticated', :own,
                  format($q$update public.organization_members set role = 'manager' where organization_id = %L and user_id = %L$q$, :orgA, :stf))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at)
                            values (%L, %L, 'staff', now(), now() + interval '1 hour')$q$, :orgA, :xinv), :'promote_mgr')
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.organization_members (organization_id, user_id, role, accepted_at)
                            values (%L, %L, 'staff', now())$q$, :orgA, :xinv), :'promote_mgr'),
  'ok:1 | ok:1 | ok:1 | 42501:-:cannot create an Act as seat via direct insert | ok:1',
  'G3: what the app writes still works (team.ts: role, is_delivery_driver, all_warehouses, on any row an admin may edit; the owner too), an admin may still add a member (0217/0220), but no API caller may insert an "Act as" seat');
select is(
  pg_temp.attempt('service_role', null, format('select public.transfer_org_ownership(%L, %L, %L)', :orgA, :own, :mgr),
                  format('%s; select pg_temp.call_as(%L, %L, %L)', :'promote_mgr', 'authenticated', :mgr,
                         format($q$update public.organization_members set impersonation_expires_at = '2099-01-01'
                                    where organization_id = %L and user_id = %L returning 'written'$q$, :orgA, :own)),
                  format($q$select string_agg(role || '/' || coalesce(impersonation_expires_at::text, 'null'), ',' order by user_id)
                             from public.organization_members where organization_id = %L and user_id in (%L, %L)$q$, :orgA, :own, :mgr)),
  'ok:1:admin/null,owner/null',
  'G4: an admin''s attempt to mark the owner row an "Act as" seat changes nothing, so the owner can still transfer ownership (before the fix the transfer then failed 42501 "caller is not the current owner")');
select is(
  pg_temp.attempt('postgres', :mgr, format('delete from auth.users where id = %L', :xinv),
                  format('update public.organization_members set invited_by = %L where organization_id = %L and user_id = %L', :xinv, :orgD, :dmem),
                  format('select coalesce(invited_by::text, %L) from public.organization_members where organization_id = %L and user_id = %L', 'null', :orgD, :dmem)),
  'ok:1:null',
  'G5: an account deletion''s own key action (organization_members.invited_by SET NULL) still passes the guard even when a JWT subject is set: invited_by may become null only when the inviter''s account is gone');

-- ══ P10. The dry run changes nothing ══════════════════════════════════════
select count(*) as stamped0 from pg_temp.marked_rows() r where r.o_j ->> 'deleted_users' is not null \gset
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :sub),
                  format($q$select (select count(*) from auth.users where id = %1$L) || '/'
                                   || (select assigned_to::text = %1$L from public.cycle_counts where id = %2$L) || '/'
                                   || (select count(*) from pg_temp.marked_rows() r where r.o_j ->> 'deleted_users' is not null)$q$, :sub, :ccOpen)),
  '{"deletable": true}|1/true/' || :stamped0,
  'P10: account_deletion_check answers deletable for the subject (every former blocker converted, F12 resolved) and its dry run changed nothing: the account, the open count still assigned, no new stamp');

-- ══ D. The subject is deleted ═════════════════════════════════════════════
create temp table snap as select * from pg_temp.marked_rows();
create temp table snap_notif as select n.user_id, count(*) as n from public.notifications n group by n.user_id;
create temp table snap_cc as select c.id, c.assignment_version from public.cycle_counts c where c.id in (:ccOpen, :ccDone);
create temp table snap_orders as select o.id, to_jsonb(o) as j from public.order_requests o where o.organization_id = :orgA;
select pg_temp.net_queue() as net0 \gset
create temp table gone as select p.id, p.email::text as email, p.full_name from public.user_profiles p where p.id = :sub;
create temp table held_before as
select s.o_tbl, s.o_k from snap s, gone g
 where strpos(lower(s.o_j::text), lower(g.email)) > 0 or strpos(lower(s.o_j::text), lower(g.full_name)) > 0;

select case when pg_has_role('supabase_auth_admin', 'SET')
            then is(pg_temp.attempt('supabase_auth_admin', null, format('delete from auth.users where id = %L', :sub)),
                    'ok:1',
                    'D1g: the deletion succeeds under GoTrue''s own role (supabase_auth_admin), the trigger firing as its DEFINER owner (undone)')
            else skip('D1g: this test role may not act as supabase_auth_admin; GoTrue''s role is proven by scripts/db-concurrency/0394_account_delete_race.sh', 1)
       end;
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :sub)),
  :sub,
  'D1: deleting the subject''s account succeeds: every former blocker (RESTRICT, NO ACTION, the NOT NULL actor, the invites cascade) gives way');
create temp table after_rows as select * from pg_temp.marked_rows();
select is(
  (select coalesce(string_agg(coalesce(b.t, a.t) || ':' || coalesce(b.n, 0) || '>' || coalesce(a.n, 0), ',' order by coalesce(b.t, a.t)), '')
     from (select s.o_tbl as t, count(*) as n from snap s group by 1) b
     full join (select r.o_tbl as t, count(*) as n from after_rows r group by 1) a on a.t = b.t
    where b.n is distinct from a.n),
  '',
  'D2: no business row is lost: every marked table holds exactly the rows it held');
select is(pg_temp.dangling(), '',
  'D3: no row anywhere in public references a missing parent through any single-column key (the schedule writer no longer reverts the SET NULL: 2.5)');
select is(
  (select coalesce(string_agg(s.o_tbl || '.' || c.col || '@' || s.o_k, ',' order by s.o_tbl, c.col, s.o_k), '')
     from snap s
     join marked m on m.tbl = s.o_tbl
     cross join lateral unnest(m.cols) c(col)
     join after_rows a on a.o_tbl = s.o_tbl and a.o_k = s.o_k
    where s.o_j ->> c.col = :sub
      and not (s.o_tbl = 'schedule_events' and c.col = 'assigned_user_id' and s.o_j ->> 'status' in ('scheduled', 'in_progress'))
      -- coalesce: a MISSING stamp makes the comparison NULL, and NOT NULL
      -- would drop the row from this list (test stage: mutation M23 survived
      -- D4 on a nullable column that way).
      and not coalesce(a.o_j ->> c.col is null and (a.o_j -> 'deleted_users' ->> c.col)::timestamptz = now(), false)),
  '',
  'D4: every history column that named the subject is now null and stamped {column: now()} (stamps satisfy the exactly-one CHECKs, D1)');
select is(
  (select concat_ws('/', c.assigned_to, c.assignment_claimed_at, c.assignment_claimed_by,
                    (c.assignment_version = b.assignment_version + 1)::text)
     from public.cycle_counts c join snap_cc b on b.id = c.id where c.id = :ccOpen)
  || '|' || (select concat_ws('/', o.status, coalesce(o.assigned_picker_id::text, 'null'), coalesce(o.picking_claimed_at::text, 'null'),
                              coalesce(o.picking_claimed_by::text, 'null'))
               from public.order_requests o where o.id = :oPick)
  || '|' || (select string_agg(concat_ws('/', o.status, coalesce(o.assigned_delivery_user_id::text, 'null'),
                                         coalesce(o.assigned_delivery_at::text, 'null'), coalesce(o.assigned_delivery_by::text, 'null')), ' ' order by o.id)
               from public.order_requests o where o.id in (:oDrv, :oTrans))
  || '|' || (select string_agg(coalesce(e.assigned_user_id::text, 'null') || '/' || coalesce(e.deleted_users::text, 'null'), ' ' order by e.id)
               from public.schedule_events e where e.id in (:seOpen, :seProg))
  || '|' || (select coalesce(r.local_owner_user_id::text, 'null') from public.maintenance_requests r where r.id = :mrOpen)
  || '|' || (select coalesce(x.escalation_claimed_by::text, 'null') || '/' || coalesce(x.escalation_claimed_at::text, 'null')
               from public.exception_occurrences x where x.id = :exOpen)
  || '|' || (select coalesce(w.manager_user_id::text, 'null') from public.warehouses w where w.id = :whA),
  'true|picking_in_progress/null/null/null|staged_for_delivery/null/null/null in_transit/null/null/null|null/null null/null|null|null/null|null',
  'D5/D19: open work is released, unstamped, with its side fields cleared: the count (claim cleared, version + 1), the pick (claim cleared), both deliveries (driver, assigned at and assigned by: the unassigned state), the scheduled and in-progress entries, the maintenance owner, the escalation claim, the warehouse manager');
select is(
  (select coalesce(c.assigned_to::text, 'null') || '/' || (c.completed_by = :mgr)::text from public.cycle_counts c where c.id = :ccDone)
  || '|' || (select coalesce(o.assigned_picker_id::text, 'null') || '/' || (o.picking_claimed_at is not null)::text
               from public.order_requests o where o.id = :oDone)
  || '|' || (select coalesce(e.assigned_user_id::text, 'null') || '/' || ((e.deleted_users ->> 'assigned_user_id')::timestamptz = now())::text
               from public.schedule_events e where e.id = :seDone)
  || '|' || (select coalesce(r.local_owner_user_id::text, 'null') || '/' || coalesce(r.resolved_by::text, 'null') || '/' || r.resolved_by_name_snapshot
               from public.maintenance_requests r where r.id = :mrDone)
  || '|' || (select coalesce(x.escalation_claimed_by::text, 'null') || '/' || (x.escalation_claimed_at is not null)::text
               from public.exception_occurrences x where x.id = :exDone),
  'null/true|null/true|null/true|null/null/Resolver|null/true',
  'D5b: closed work of the same kinds is kept as history, not released: the completed count''s assignee and the completed order''s picker are nulled by their keys (claim time kept), the completed entry''s assignee is stamped, the resolved request keeps its snapshot');
select is(
  (select count(*) from snap s join after_rows a on a.o_tbl = s.o_tbl and a.o_k = s.o_k
     join marked m on m.tbl = s.o_tbl
    where not exists (select 1 from unnest(m.cols) c where s.o_j ->> c = :sub)
      and a.o_j <> s.o_j)::text
  || '/' || ((select count(*) from snap s join marked m on m.tbl = s.o_tbl
               where not exists (select 1 from unnest(m.cols) c where s.o_j ->> c = :sub)) > 5)::text,
  '0/true',
  'D6: every row of every marked table that named the subject in no person column is byte-identical, updated_at and deleted_users included');
select is(
  (select coalesce(e.created_by::text, 'null') || '/' || ((e.deleted_users ->> 'created_by')::timestamptz = now())::text || '/'
          || coalesce(e.updated_by::text, 'null') || '/' || ((e.deleted_users ->> 'updated_by')::timestamptz = now())::text
     from public.schedule_events e where e.id = :seCre),
  'null/true/null/true',
  'D8: the schedule entry the subject created is kept with created_by null and stamped: the writer let the SET NULL stand because the account is gone');
select is(
  (select coalesce(l.user_id::text, 'null') || '/' || ((l.deleted_users ->> 'user_id')::timestamptz = now())::text from public.audit_logs l where l.id = :al1)
  || '|' || (select coalesce(a.actor_user_id::text, 'null') || '/' || a.actor_email || '/' || ((a.deleted_users ->> 'actor_user_id')::timestamptz = now())::text
               from public.platform_admin_audit a where a.id = :pa1)
  || '|' || (select (a.actor_user_id = :own)::text || '/' || coalesce(a.target_user_id::text, 'null') || '/'
                    || ((a.deleted_users ->> 'target_user_id')::timestamptz = now())::text
               from public.platform_admin_audit a where a.id = :pa2),
  'null/true|null/0394-sub@test.local/true|true/null/true',
  'D9: audit rows the subject wrote are kept and stamped (the log reads "Deleted user", not "System"); the platform audit keeps the actor''s email, stamps the actor, and stamps a target');
select is(
  (select concat_ws('/', coalesce(i.invited_by::text, 'null'), ((i.deleted_users ->> 'invited_by')::timestamptz = now())::text,
                    (i.revoked_at = now())::text, (i.expires_at <= now() - interval '1 minute')::text, i.token)
     from public.organization_invites i where i.id = :invP)
  || '|' || (select concat_ws('/', coalesce(i.invited_by::text, 'null'), ((i.deleted_users ->> 'invited_by')::timestamptz = now())::text,
                              coalesce(i.revoked_at::text, 'null'), (i.accepted_at is not null)::text)
               from public.organization_invites i where i.id = :invAcc),
  'null/true/true/true/0394-token-pending|null/true/null/true',
  'D10: the pending invite the subject sent is kept (token unchanged) but stops working: revoked and expired (acceptance reads expires_at); the accepted invite keeps its history, stamped');
select is(
  (select count(*)
     from (select n.user_id, count(*) as n from public.notifications n group by n.user_id) a
     full join snap_notif b using (user_id)
    where a.n is distinct from b.n and coalesce(a.user_id, b.user_id) <> :sub)::text
  || '/' || (pg_temp.net_queue() = :net0)::text,
  '0/true',
  'D11: the deletion notified nobody (no notification for any other user, no request queued for pg_net): releases notify no one');
select is(
  (select count(*) from after_rows a, gone g
    where (strpos(lower(a.o_j::text), lower(g.email)) > 0 or strpos(lower(a.o_j::text), lower(g.full_name)) > 0)
      and (a.o_tbl, a.o_k) not in (select h.o_tbl, h.o_k from held_before h))::text
  || '/' || (select count(*) from public.order_requests o, gone g
              where o.organization_id = :orgA
                and (strpos(lower(to_jsonb(o)::text), lower(g.email)) > 0 or strpos(lower(to_jsonb(o)::text), lower(g.full_name)) > 0))::text
  || '/' || (select count(*) from public.user_profiles where id = :sub)::text
  || '/' || (select count(*) from public.organization_members where user_id = :sub)::text
  || '/' || (select count(*) from public.user_warehouse_assignments where user_id = :sub)::text
  || '/' || (select count(*) from public.user_permission_overrides where user_id = :sub)::text,
  '0/0/0/0/0/0',
  'D12: privacy: no row gained the subject''s email or name (the platform audit''s actor_email already held it), and the profile, memberships, warehouse access and own overrides are gone');
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :sub)),
  '{"reason": "not_found", "deletable": false}',
  'D15: afterwards account_deletion_check answers not_found');
select is(
  (select ((m.settings -> 'notifyAudience') ? :sub)::text || '/' || ((m.settings -> 'notifyAudience') ? :mgr)::text || '/'
          || (m.settings ->> 'keep') || '/' || coalesce(m.enabled_by::text, 'null') || '/' || ((m.deleted_users ->> 'enabled_by')::timestamptz = now())::text
     from public.organization_modules m where m.organization_id = :orgA and m.module_id = 'maintenance_requests'),
  'false/true/1/null/true',
  'D16: the subject''s id left the maintenance notification audience (a person id with no key); the other member and the rest of the settings are unchanged; enabled_by is stamped');
select is(
  (select count(*) from public.delivery_locations where order_request_id = :oTrans)::text
  || '/' || (select o.status from public.order_requests o where o.id = :oTrans),
  '0/in_transit',
  'D17: the subject''s live GPS point is deleted with the account (personal data, critique C4); the order stays in transit');
select is(
  (select (p.disabled_at is not null)::text || '/' || p.disabled_reason || '/' || coalesce(p.disabled_by::text, 'null')
     from public.user_profiles p where p.id = :vd),
  'true/0394 test/null',
  'D18: a profile the subject disabled stays disabled with its reason; disabled_by is nulled by the new key (the pin trigger lets the owner''s FK action through)');
select is(
  (select count(*) from public.order_submissions where user_id = :sub)::text
  || '/' || (select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || (o.requester_deleted_at = now())::text
               from public.order_requests o where o.id = :oP),
  '0/pending_approval/null/true',
  'D20: the subject''s submission log goes with the account (order_submissions_user_id_fkey, CASCADE); the order they placed stays, marked by 0388');
select is(
  (select coalesce(o.updated_by::text, 'null') || '/' || o.granted::text from public.user_permission_overrides o
    where o.organization_id = :orgA and o.user_id = :stf and o.permission = 'orders:approve')
  || '|' || (select coalesce(o.updated_by::text, 'null') || '/' || o.granted::text from public.role_permission_overrides o
               where o.organization_id = :orgA and o.role = 'viewer' and o.permission = 'orders:request'),
  'null/true|null/true',
  'D21: overrides the subject last changed keep their grant; updated_by is nulled by the new keys (never left dangling)');
select is(
  pg_temp.attempt('service_role', null, format('update public.receipts set received_by = %L where id = %L', :mgr, :rcpt1), null,
                  format($q$select coalesce(deleted_users::text, 'null') || '/' || received_by::text from public.receipts where id = %L$q$, :rcpt1)),
  'ok:1:null/' || :mgr,
  'M3b: service_role naming a live person in a stamped relaxed column drops the stamp, and the exactly-one CHECK holds');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.assigned_to::text from public.assign_cycle_count(%L, %L) r', :ccOpen, :stf))
  || ' | ' || pg_temp.call_as('authenticated', :stf, format('select r.assigned_picker_id::text from public.claim_picking(%L) r', :oPick))
  || ' | ' || pg_temp.call_as('authenticated', :mgr,
                              format($q$with u as (update public.schedule_events set title = '0394 created, edited' where id = %L returning 1)
                                        select count(*)::text from u$q$, :seCre),
                              format($q$select coalesce(created_by::text, 'null') || '/' || updated_by::text || '/'
                                               || (deleted_users ? 'created_by')::text || '/' || (deleted_users ? 'updated_by')::text
                                          from public.schedule_events where id = %L$q$, :seCre)),
  :stf || ' | ' || :stf || ' | 1|null/' || :mgr || '/true/false',
  'D13: work continues: a manager assigns the released count, staff claim the released pick, and a manager edits the deleted creator''s entry (updated_by becomes the manager and its stamp goes; the creator''s stamp stays)');

-- ══ L (kept deletions) ════════════════════════════════════════════════════
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :own2),
                  format($q$select (select count(*) from public.organization_members where organization_id = %1$L and accepted_at is not null) || '/'
                                   || (select count(*) from public.organization_members where organization_id = %1$L and user_id = %2$L) || '/'
                                   || (select coalesce(l.user_id::text, 'null') || '/' || ((l.deleted_users ->> 'user_id')::timestamptz = now())::text
                                         from public.audit_logs l where l.id = %3$L) || '/'
                                   || (select count(*) from public.organizations where id = %1$L)$q$, :orgB, :pend, :alB)),
  :own2 || '|0/1/null/true/1',
  'L3: the only owner of an organization with no other accepted member (a pending one does not count) is deletable; the organization and its records stay (stamped), the pending membership row stays');
select is(
  (select concat_ws('/', (i.revoked_at = now())::text, (i.expires_at <= now() - interval '1 minute')::text,
                    coalesce(i.invited_by::text, 'null'), ((i.deleted_users ->> 'invited_by')::timestamptz = now())::text)
     from public.organization_invites i where i.id = :invB1)
  || '|' || (select concat_ws('/', (i.revoked_at = now())::text, (i.expires_at <= now() - interval '1 minute')::text, i.invited_by::text)
               from public.organization_invites i where i.id = :invB2),
  'true/true/null/true|true/true/' || :xinv,
  'L3b: the organization''s pending invites stop working, the one its owner sent and one another account sent (nobody can join an organization that just lost its only member; critique C6)');
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :c1o),
                  format($q$select (select string_agg(user_id::text, ',') from public.organization_members
                                     where organization_id = %1$L and role = 'owner' and accepted_at is not null and impersonation_expires_at is null) || '/'
                                   || (select count(*) from public.organization_members where organization_id = %1$L and user_id = %2$L)$q$, :orgC, :cst)),
  :c1o || '|' || :c2o || '/1',
  'L4: with a second accepted owner either owner is deletable; the organization keeps the other owner and its staff');
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :cust),
                  format('select count(*)::text from public.customer_users where user_id = %L', :cust)),
  :cust || '|0',
  'D14: a portal customer (no membership) is still deletable with the marker and the trigger in place; the customer_users row cascades');

-- ══ F. F12: legacy delivery orders ════════════════════════════════════════
select is(
  pg_temp.call_as('postgres', null,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id,
                                                               fulfillment_type, delivery_charter_id, approved_by, approved_at)
                            values (%L, %L, %L, 'completed', 'internal', %L, 'delivery', null, %L, now()) returning id::text$q$,
                         :oLeg, :orgA, :whA, :leg, :mgr)),
  '20ad4cb9-733e-4348-a4fd-074f43ce2025',
  'F1: a delivery with no charter under one of the five legacy ids satisfies the validated check (the exemption)');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id,
                                                               fulfillment_type, delivery_charter_id)
                            values (%L, %L, %L, 'completed', 'internal', %L, 'delivery', null)$q$, :oF2, :orgA, :whA, :leg)),
  '23514:-:new row for relation "order_requests" violates check constraint "order_requests_delivery_target_chk"',
  'F2: the same shape under any other id is refused (23514): the exemption is the five primary keys, nothing else');
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :leg),
                  format($q$select concat_ws('/', coalesce(o.requester_user_id::text, 'null'), (o.requester_deleted_at = now())::text,
                                             o.fulfillment_type, coalesce(o.delivery_charter_id::text, 'null'), o.status, (o.approved_by = %L)::text)
                              from public.order_requests o where o.id = %L$q$, :mgr, :oLeg)),
  :leg || '|null/true/delivery/null/completed/true',
  'F3: the legacy order''s requester can be deleted (the SET NULL no longer meets a NOT VALID check); the order keeps every value but the requester, marked by 0388');
select is(
  pg_temp.attempt('postgres', null, format($q$update public.order_requests set fulfillment_type = 'pickup', delivery_charter_id = %L where id = %L$q$, :chA, :oLeg))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format($q$update public.order_requests set fulfillment_type = 'pickup' where id = %L$q$, :oLeg)),
  '23514:-:new row for relation "order_requests" violates check constraint "order_requests_delivery_target_chk"'
  ' | ok:1',
  'F4: a legacy row edited into another invalid shape (a pickup with a charter) is refused; edited into a valid one it is accepted: the exemption covers only the legacy shape');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id,
                                                               fulfillment_type, delivery_charter_id)
                            values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup', %L)$q$, :oF5, :orgA, :whA, :stf, :chA))
  || ' | ' ||
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id,
                                                               fulfillment_type, delivery_charter_id)
                            values (%L, %L, %L, 'pending_approval', 'internal', %L, 'delivery', %L)$q$, :oF5, :orgA, :whA, :stf, :chA)),
  '23514:-:new row for relation "order_requests" violates check constraint "order_requests_delivery_target_chk"'
  ' | ok:1',
  'F5: for every new order the rule is today''s: a pickup naming a charter is refused, a delivery with its charter accepted');

select * from finish();
rollback;
