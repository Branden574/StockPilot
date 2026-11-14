-- supabase/tests/NNNN_role_and_sign_in_policy_changes_recorded_by_database.test.sql
-- (NNNN = the migration's number, given in ship order; nothing in this file
-- reads it)
-- pgTAP proof for the migration with which the database records two changes
-- in the audit log itself, in the transaction of the change:
--   * an organization's sign-in policy (organizations.mfa_policy): one row,
--     event organization.mfa_policy.changed, written by
--     trg_zz_record_mfa_policy_change;
--   * a member's role (organization_members.role): one row, event
--     user.role.changed, written by trg_zz_record_member_role_change.
-- The app's own row for a change the database recorded is not stored a
-- second time (zz_fold_app_copy on audit_logs), and no stored audit row is
-- ever changed. Every line states what the database does with the migration
-- applied.
--
-- Personas (organization A unless named): own (owner), adm (admin), mgr
-- (manager), stf1, stf2, stf3 (staff), vwr (viewer), newm (joins in M9);
-- admB (admin of B), stfB (staff of B); ghost is a token subject with no
-- account. Each membership has a fixed id (m_*).
--
-- P.  Posture: the three functions (owner, SECURITY DEFINER or INVOKER,
--     search_path, no EXECUTE for PUBLIC, anon, authenticated, service_role)
--     and the three triggers (table, timing, FOR EACH ROW, no column list,
--     WHEN text, enabled); the two recorders hold one INSERT each and no
--     other write, and the third function holds no write statement at all;
--     zz_fold_app_copy fires before zzz_deleted_users_ins; each function and
--     trigger has a comment.
-- R.  The sign-in policy. An admin's change through the Data API (claims in
--     the JSON form the Data API sets) leaves exactly one row: the admin as
--     the actor, before and after, source, made_as and aal, no address or
--     browser (R1 to R3). The row carries the token's aal as sent, or null
--     when the token has none (R4, R5). The service role and a statement
--     with no role set leave a row with no actor (R6, R7). The same value
--     saved again, and another column of the organization, leave none (R8).
--     A member below admin, and an admin of another organization, change no
--     row and leave none (R9, R10). A token subject that is not a uuid, and
--     claims that are not JSON, count as no actor and no aal and do not
--     stop the change (R11, R12). made_as names anon as anon (R13).
-- M.  A member's role. An admin's change leaves exactly one row naming the
--     membership and the member (M1, M2), in the shape the role monitor
--     reads (M3). A member below admin changes no row and leaves none (M4).
--     One statement over four members writes one row per changed role (M5).
--     The driver flag and "all warehouses" leave none (M6). An ownership
--     transfer leaves two rows with no actor, made_as service_role (M7). A
--     token subject with no account: the change goes through and the row has
--     no actor (M8). An upsert that changes the role leaves one row; the
--     counts after the statements that follow it are as pinned (M9). An
--     admin of another organization changes nothing (M10).
-- F.  The app's row for a recorded change, sent as the server's role. It is
--     accepted and not stored, and the recorded row is as it was, byte for
--     byte and in place (F1, F2); a second and a third later try, sent as
--     INSERT ... ON CONFLICT (id) DO NOTHING, likewise (F3); an upper-case
--     entity id likewise (F4); in a batch, the other rows are stored (F5);
--     the sign-in policy's row likewise (F6). A row that differs in the
--     after value, the before value, the actor, the membership or the
--     organization is stored as it was sent (F7, F8). A recorded row older
--     than ten minutes does not claim the app's row; a newer one does (F9).
--     Rows of other events, and rows sent by any role but the server's, are
--     not judged: an owner-role insert is stored, a member's is refused as
--     before (F10). The same change made twice keeps two rows whatever the
--     app sends (F11).
-- X.  Each trigger does its own work: the same attempt with the trigger
--     disabled and with it enabled, both undone. The counts differ by the
--     one row that trigger writes (X1, X2) or holds back (X3).
-- Z.  The rows this file left, by event and organization.
--
-- Roles: fixtures as the test's own role. pg_temp.run switches role and
-- claims with set_config inside a subtransaction and keeps what succeeds;
-- pg_temp.undone always undoes. R13 makes one SECURITY DEFINER function in
-- public for its own use; it goes with the rollback. begin/rollback: nothing
-- leaks.
-- Namespace c0a70000; undo code XXUND.

begin;

select plan(46);

\set orgA    '\'c0a70000-0000-4000-8000-00000000000a\''
\set orgB    '\'c0a70000-0000-4000-8000-00000000000b\''
\set own     '\'c0a70000-0000-4000-8000-0000000000a1\''
\set adm     '\'c0a70000-0000-4000-8000-0000000000a2\''
\set mgr     '\'c0a70000-0000-4000-8000-0000000000a4\''
\set stf1    '\'c0a70000-0000-4000-8000-0000000000a5\''
\set stf2    '\'c0a70000-0000-4000-8000-0000000000a6\''
\set stf3    '\'c0a70000-0000-4000-8000-0000000000a7\''
\set vwr     '\'c0a70000-0000-4000-8000-0000000000a8\''
\set newm    '\'c0a70000-0000-4000-8000-0000000000a9\''
\set admB    '\'c0a70000-0000-4000-8000-0000000000b1\''
\set stfB    '\'c0a70000-0000-4000-8000-0000000000b2\''
\set ghost   '\'c0a70000-0000-4000-8000-0000000000f1\''
\set m_own   '\'c0a70000-0000-4000-8000-0000000001a1\''
\set m_adm   '\'c0a70000-0000-4000-8000-0000000001a2\''
\set m_mgr   '\'c0a70000-0000-4000-8000-0000000001a4\''
\set m_stf1  '\'c0a70000-0000-4000-8000-0000000001a5\''
\set m_stf2  '\'c0a70000-0000-4000-8000-0000000001a6\''
\set m_stf3  '\'c0a70000-0000-4000-8000-0000000001a7\''
\set m_vwr   '\'c0a70000-0000-4000-8000-0000000001a8\''
\set m_new   '\'c0a70000-0000-4000-8000-0000000001a9\''
\set m_admB  '\'c0a70000-0000-4000-8000-0000000001b1\''
\set m_stfB  '\'c0a70000-0000-4000-8000-0000000001b2\''
-- Made-up membership ids that only audit rows name (F9, F10).
\set e_old   '\'c0a70000-0000-4000-8000-0000000003e1\''
\set e_new   '\'c0a70000-0000-4000-8000-0000000003e2\''
\set e_other '\'c0a70000-0000-4000-8000-0000000003e3\''
-- Ids the app chose for its rows.
\set c1      '\'c0a70000-0000-4000-8000-0000000002c1\''
\set c2      '\'c0a70000-0000-4000-8000-0000000002c2\''
\set c3      '\'c0a70000-0000-4000-8000-0000000002c3\''
\set c4      '\'c0a70000-0000-4000-8000-0000000002c4\''
\set c5      '\'c0a70000-0000-4000-8000-0000000002c5\''
\set c6      '\'c0a70000-0000-4000-8000-0000000002c6\''
\set c7      '\'c0a70000-0000-4000-8000-0000000002c7\''
\set c8      '\'c0a70000-0000-4000-8000-0000000002c8\''
\set c9      '\'c0a70000-0000-4000-8000-0000000002c9\''
\set c10     '\'c0a70000-0000-4000-8000-0000000002ca\''
\set c11     '\'c0a70000-0000-4000-8000-0000000002cb\''
\set c12     '\'c0a70000-0000-4000-8000-0000000002cc\''
\set c13     '\'c0a70000-0000-4000-8000-0000000002cd\''
\set c14     '\'c0a70000-0000-4000-8000-0000000002ce\''
\set c15     '\'c0a70000-0000-4000-8000-0000000002cf\''
\set c16     '\'c0a70000-0000-4000-8000-0000000002d0\''
\set c17     '\'c0a70000-0000-4000-8000-0000000002d1\''
\set c18     '\'c0a70000-0000-4000-8000-0000000002d2\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,  'rec-own@rec.test',  '{}'::jsonb),
  (:adm,  'rec-adm@rec.test',  '{}'::jsonb),
  (:mgr,  'rec-mgr@rec.test',  '{}'::jsonb),
  (:stf1, 'rec-stf1@rec.test', '{}'::jsonb),
  (:stf2, 'rec-stf2@rec.test', '{}'::jsonb),
  (:stf3, 'rec-stf3@rec.test', '{}'::jsonb),
  (:vwr,  'rec-vwr@rec.test',  '{}'::jsonb),
  (:newm, 'rec-newm@rec.test', '{}'::jsonb),
  (:admB, 'rec-admb@rec.test', '{}'::jsonb),
  (:stfB, 'rec-stfb@rec.test', '{}'::jsonb)
  on conflict (id) do nothing;
-- Each organization starts at 'optional', named here so the rows below do
-- not depend on the column's default.
insert into public.organizations (id, name, slug, mfa_policy) values
  (:orgA, 'Rec Org A', 'rec-org-a', 'optional'),
  (:orgB, 'Rec Org B', 'rec-org-b', 'optional');
insert into public.organization_members (id, organization_id, user_id, role, accepted_at) values
  (:m_own,  :orgA, :own,  'owner',   now()),
  (:m_adm,  :orgA, :adm,  'admin',   now()),
  (:m_mgr,  :orgA, :mgr,  'manager', now()),
  (:m_stf1, :orgA, :stf1, 'staff',   now()),
  (:m_stf2, :orgA, :stf2, 'staff',   now()),
  (:m_stf3, :orgA, :stf3, 'staff',   now()),
  (:m_vwr,  :orgA, :vwr,  'viewer',  now()),
  (:m_admB, :orgB, :admB, 'admin',   now()),
  (:m_stfB, :orgB, :stfB, 'staff',   now());

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- A token's claims in the JSON form the Data API sets (request.jwt.claims).
-- p_aal null: the token has no aal claim.
create function pg_temp.claims(p_sub uuid, p_role text, p_aal text default null) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', p_role, 'aal', p_aal))
$$;

-- One statement as p_as (null: no role is set) with p_claims as the text of
-- request.jwt.claims, KEPT when it succeeds: 'ok:<rows>', else
-- '<sqlstate>:<message>'.
create function pg_temp.run_text(p_as text, p_claims text, p_sql text)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_n bigint;
begin
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
    if p_as is not null then
      perform set_config('role', p_as, true);
    end if;
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    return v_state || ':' || v_msg;
  end;
  return 'ok:' || v_n::text;
end $$;
-- The same, with the claims as JSON.
create function pg_temp.run(p_as text, p_claims jsonb, p_sql text) returns text language sql as $$
  select pg_temp.run_text(p_as, p_claims::text, p_sql)
$$;

-- p_prep (as the test's own role), then one statement as p_as with p_claims,
-- then p_check (as the test's own role): p_check's answer, and everything
-- ALWAYS undone. A failure anywhere: '<sqlstate>:<message>'.
create function pg_temp.undone(p_prep text, p_as text, p_claims jsonb, p_sql text, p_check text)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
    perform set_config('role', p_as, true);
    execute p_sql;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    execute p_check into v_seen;
    raise exception using errcode = 'XXUND', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  if v_state = 'XXUND' then
    return v_seen;
  end if;
  return v_state || ':' || v_msg;
end $$;

create function pg_temp.policy_sql(p_org uuid, p_policy text) returns text language sql immutable as $$
  select format('update public.organizations set mfa_policy = %L where id = %L', p_policy, p_org)
$$;
create function pg_temp.role_sql(p_member uuid, p_role text) returns text language sql immutable as $$
  select format('update public.organization_members set role = %L where id = %L', p_role, p_member)
$$;

-- The app's row for a change, as its audit writer shapes it (the six
-- metadata keys, an address and a browser, an id the writer chose). The
-- first try is a plain INSERT; a later try (p_later) carries the time of the
-- event and ON CONFLICT (id) DO NOTHING.
create function pg_temp.copy_sql(p_id uuid, p_org uuid, p_actor uuid, p_event text, p_entity text,
                                 p_before jsonb, p_after jsonb, p_later boolean default false)
returns text language sql immutable as $$
  select format(
    'insert into public.audit_logs (id, organization_id, user_id, event, ip, user_agent, metadata%s) '
    || 'values (%L, %L, %L, %L, %L, %L, %L%s)%s',
    case when p_later then ', created_at' else '' end,
    p_id, p_org, p_actor, p_event, '203.0.113.7', 'Mozilla/5.0 (test browser)',
    jsonb_build_object(
      'entity_type', case p_event when 'organization.mfa_policy.changed' then 'organization' else 'organization_member' end,
      'entity_id', p_entity, 'warehouse_id', null, 'before', p_before, 'after', p_after, 'reason', null),
    case when p_later then ', now()' else '' end,
    case when p_later then ' on conflict (id) do nothing' else '' end)
$$;
-- The same, sent as the server's role (service_role, with its key's claims).
create function pg_temp.copy(p_id uuid, p_org uuid, p_actor uuid, p_event text, p_entity text,
                             p_before jsonb, p_after jsonb, p_later boolean default false)
returns text language sql as $$
  select pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
                     pg_temp.copy_sql(p_id, p_org, p_actor, p_event, p_entity, p_before, p_after, p_later))
$$;

create function pg_temp.r(p_role text) returns jsonb language sql immutable as $$
  select jsonb_build_object('role', p_role)
$$;
create function pg_temp.p(p_policy text) returns jsonb language sql immutable as $$
  select jsonb_build_object('mfa_policy', p_policy)
$$;

-- How many audit rows of p_event name p_entity. VOLATILE (as is print): each
-- call reads with a snapshot of its own, so it sees what an earlier call in
-- the same statement wrote.
create function pg_temp.n(p_event text, p_entity uuid) returns integer language sql volatile as $$
  select count(*)::int from public.audit_logs a
   where a.event = p_event and a.metadata ->> 'entity_id' = p_entity::text
$$;

-- The rows the database recorded for p_entity, as stored: where each is
-- (ctid), the transaction that wrote it (xmin) and an md5 of the whole row.
-- Any change to a stored row moves all three.
create function pg_temp.print(p_event text, p_entity uuid) returns text language sql volatile as $$
  select coalesce(string_agg(a.ctid::text || ' ' || a.xmin::text || ' ' || md5(a::text), ', ' order by a.ctid), 'none')
    from public.audit_logs a
   where a.event = p_event and a.metadata ->> 'entity_id' = p_entity::text and a.metadata ->> 'source' = 'database'
$$;
create temp table kept (label text primary key, print text not null);

-- What each step answered. A step runs in a statement of its own, and the
-- line that judges it reads the tables in the next one.
create temp table outcome (step text primary key, got text not null);
create function pg_temp.got(p_step text) returns text language sql stable as $$
  select o.got from outcome o where o.step = p_step
$$;

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select string_agg(format('%s definer=%s config=%s owner=%s lang=%s returns=%s public=%s anon=%s authenticated=%s service_role=%s',
            p.proname, p.prosecdef::text, array_to_string(p.proconfig, ','), pg_get_userbyid(p.proowner), l.lanname,
            p.prorettype::regtype, has_function_privilege('public', p.oid, 'execute')::text,
            has_function_privilege('anon', p.oid, 'execute')::text,
            has_function_privilege('authenticated', p.oid, 'execute')::text,
            has_function_privilege('service_role', p.oid, 'execute')::text), E'\n' order by p.proname)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('tg_record_mfa_policy_change', 'tg_record_member_role_change', 'tg_audit_logs_fold_app_copy')),
  E'tg_audit_logs_fold_app_copy definer=false config=search_path="" owner=postgres lang=plpgsql returns=trigger public=false anon=false authenticated=false service_role=false\n'
  || E'tg_record_member_role_change definer=true config=search_path="" owner=postgres lang=plpgsql returns=trigger public=false anon=false authenticated=false service_role=false\n'
  || 'tg_record_mfa_policy_change definer=true config=search_path="" owner=postgres lang=plpgsql returns=trigger public=false anon=false authenticated=false service_role=false',
  'P1: the two recorders are SECURITY DEFINER and the third function SECURITY INVOKER; each is owned by postgres, pins an empty search_path, and gives no EXECUTE to PUBLIC, anon, authenticated or service_role');

-- tgtype: 17 = AFTER UPDATE FOR EACH ROW, 7 = BEFORE INSERT FOR EACH ROW.
-- tgattr empty: no column list.
select is(
  (select string_agg(format('%s on %s.%s type=%s enabled=%s columns=%s runs=%s.%s when=%s',
            t.tgname, n.nspname, c.relname, t.tgtype, t.tgenabled, coalesce(nullif(t.tgattr::text, ''), '-'),
            pn.nspname, p.proname, substring(pg_get_triggerdef(t.oid) from 'WHEN \((.*)\) EXECUTE')), E'\n' order by t.tgname)
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal
      and t.tgname in ('trg_zz_record_mfa_policy_change', 'trg_zz_record_member_role_change', 'zz_fold_app_copy')),
  E'trg_zz_record_member_role_change on public.organization_members type=17 enabled=O columns=- runs=public.tg_record_member_role_change when=(old.role IS DISTINCT FROM new.role)\n'
  || E'trg_zz_record_mfa_policy_change on public.organizations type=17 enabled=O columns=- runs=public.tg_record_mfa_policy_change when=(old.mfa_policy IS DISTINCT FROM new.mfa_policy)\n'
  || 'zz_fold_app_copy on public.audit_logs type=7 enabled=O columns=- runs=public.tg_audit_logs_fold_app_copy when=(new.event = ANY (ARRAY[''user.role.changed''::text, ''organization.mfa_policy.changed''::text]))',
  'P2: the recorders run AFTER UPDATE FOR EACH ROW, with no column list, WHEN the value changes; zz_fold_app_copy runs BEFORE INSERT FOR EACH ROW on audit_logs for the two events only; all three enabled');

-- Each recorder holds one INSERT, into public.audit_logs, and no other write
-- statement (the suite's write forms, read on the body less that one
-- statement head).
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('tg_record_mfa_policy_change', 'tg_record_member_role_change')
      and (select count(*) from regexp_matches(p.prosrc, '\minsert\s+into\s+public\.audit_logs\M', 'gi')) = 1
      and replace(p.prosrc, 'insert into public.audit_logs', '') !~* $w$\m(insert\s+into|merge\s+into|delete\s+from|truncate)\M|\mupdate\s+(only\s*\(?\s*)?(("([^"]|"")+"|[a-z_][a-z0-9_$]*)\s*\.\s*)*("([^"]|"")+"|[a-z_][a-z0-9_$]*)(\s*\))?(\s*\*)?(\s+(as\s+)?("([^"]|"")+"|[a-z_][a-z0-9_$]*))?\s+set\M$w$),
  2,
  'P3: each recorder holds exactly one INSERT, into public.audit_logs, and no other write statement');
-- The third function holds none: not one of the five write verbs appears in
-- its body, as a statement or as a word.
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'tg_audit_logs_fold_app_copy'
      and p.prosrc !~* '\m(insert|update|delete|merge|truncate)\M'),
  1,
  'P4: tg_audit_logs_fold_app_copy holds no write statement: it changes no stored row');

select is(
  (select array_agg(t.tgname::text order by t.tgname collate "C") from pg_trigger t
    where t.tgrelid = 'public.audit_logs'::regclass and not t.tgisinternal
      and (t.tgtype & 3) = 3 and (t.tgtype & 4) = 4
      and t.tgname in ('zz_fold_app_copy', 'zzz_deleted_users_ins')),
  array['zz_fold_app_copy', 'zzz_deleted_users_ins'],
  'P5: zz_fold_app_copy sorts before zzz_deleted_users_ins, which stays the last BEFORE INSERT row trigger by name');

select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('tg_record_mfa_policy_change', 'tg_record_member_role_change', 'tg_audit_logs_fold_app_copy')
      and length(obj_description(p.oid, 'pg_proc')) > 40)
  + (select count(*)::int from pg_trigger t
      where not t.tgisinternal
        and t.tgname in ('trg_zz_record_mfa_policy_change', 'trg_zz_record_member_role_change', 'zz_fold_app_copy')
        and length(obj_description(t.oid, 'pg_trigger')) > 40),
  6,
  'P6: each of the three functions and the three triggers has a comment');

-- ══ R. The sign-in policy ═════════════════════════════════════════════════
insert into outcome (step, got) values ('R1',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.policy_sql(:orgA, 'all_required')));
select is(pg_temp.got('R1'), 'ok:1', 'R1: an admin changes the organization''s sign-in policy');
select is(
  (select string_agg(format('org=%s actor=%s ip=%s browser=%s at_now=%s', a.organization_id, a.user_id,
                            coalesce(host(a.ip), 'null'), coalesce(a.user_agent, 'null'), (a.created_at = now())::text), ' / ')
     from public.audit_logs a where a.event = 'organization.mfa_policy.changed' and a.metadata ->> 'entity_id' = :orgA),
  format('org=%s actor=%s ip=null browser=null at_now=true', :orgA, :adm),
  'R2: exactly one row: the organization, the admin as the actor, the time of the change, no address and no browser');
select is(
  (select a.metadata from public.audit_logs a
    where a.event = 'organization.mfa_policy.changed' and a.metadata ->> 'entity_id' = :orgA),
  jsonb_build_object('entity_type', 'organization', 'entity_id', :orgA, 'warehouse_id', null,
                     'before', pg_temp.p('optional'), 'after', pg_temp.p('all_required'), 'reason', null,
                     'source', 'database', 'made_as', 'authenticated', 'aal', 'aal2'),
  'R3: its details: the organization, before and after, source database, made_as authenticated, the token''s aal');

insert into outcome (step, got) values ('R4',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal1'), pg_temp.policy_sql(:orgA, 'admins_required')));
select is(
  pg_temp.got('R4')
  || ' ' || (select string_agg(a.metadata ->> 'aal', ',') from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgA
                and (a.metadata -> 'after') = pg_temp.p('admins_required')),
  'ok:1 aal1',
  'R4: the row carries the token''s aal as sent');
insert into outcome (step, got) values ('R5',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated'), pg_temp.policy_sql(:orgA, 'optional')));
select is(
  pg_temp.got('R5')
  || ' ' || (select string_agg(format('%s %s %s', a.user_id, (a.metadata ? 'aal')::text, a.metadata -> 'aal'), ',')
               from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgA
                and (a.metadata -> 'before') = pg_temp.p('admins_required')),
  format('ok:1 %s true null', :adm),
  'R5: a token with no aal claim: the row keeps the actor and its aal is null');

insert into outcome (step, got) values ('R6',
  pg_temp.run('service_role', '{"role": "service_role"}'::jsonb, pg_temp.policy_sql(:orgA, 'all_required')));
select is(
  pg_temp.got('R6')
  || ' ' || (select string_agg(format('actor=%s made_as=%s aal=%s source=%s', coalesce(a.user_id::text, 'null'),
                                      a.metadata ->> 'made_as', a.metadata -> 'aal', a.metadata ->> 'source'), ',')
               from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgA
                and a.metadata ->> 'made_as' = 'service_role'),
  'ok:1 actor=null made_as=service_role aal=null source=database',
  'R6: the service role''s change leaves one row with no actor, made_as service_role');
insert into outcome (step, got) values ('R7', pg_temp.run(null, null, pg_temp.policy_sql(:orgA, 'optional')));
select is(
  pg_temp.got('R7')
  || ' ' || (select string_agg(format('actor=%s made_as=%s before=%s after=%s', coalesce(a.user_id::text, 'null'),
                                      a.metadata ->> 'made_as', a.metadata -> 'before' ->> 'mfa_policy',
                                      a.metadata -> 'after' ->> 'mfa_policy'), ',')
               from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgA
                and a.metadata ->> 'made_as' not in ('authenticated', 'service_role')),
  'ok:1 actor=null made_as=direct before=all_required after=optional',
  'R7: a statement with no role set leaves one row with no actor, made_as direct');

insert into outcome (step, got) values ('R8',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.policy_sql(:orgA, 'optional'))
  || ' ' || pg_temp.run('service_role', '{"role": "service_role"}'::jsonb, pg_temp.policy_sql(:orgA, 'optional'))
  || ' ' || pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
                        format('update public.organizations set name = %L where id = %L', 'Rec Org A (renamed)', :orgA)));
select is(
  pg_temp.got('R8') || ' rows=' || pg_temp.n('organization.mfa_policy.changed', :orgA),
  'ok:1 ok:1 ok:1 rows=5',
  'R8: the same policy saved again, and another column of the organization, leave no row');
insert into outcome (step, got) values ('R9',
  pg_temp.run('authenticated', pg_temp.claims(:mgr, 'authenticated', 'aal2'), pg_temp.policy_sql(:orgA, 'all_required')));
select is(
  pg_temp.got('R9') || ' rows=' || pg_temp.n('organization.mfa_policy.changed', :orgA)
  || ' policy=' || (select o.mfa_policy from public.organizations o where o.id = :orgA),
  'ok:0 rows=5 policy=optional',
  'R9: a member below admin changes no row and leaves no audit row');
insert into outcome (step, got) values ('R10',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.policy_sql(:orgB, 'all_required')));
select is(
  pg_temp.got('R10') || ' rows=' || pg_temp.n('organization.mfa_policy.changed', :orgB),
  'ok:0 rows=0',
  'R10: an admin of another organization changes no row and leaves no audit row');

-- A policy change with a token whose subject or claims cannot be read
-- (organization B, at 'optional').
insert into outcome (step, got) values ('R11',
  pg_temp.run_text('service_role', '{"role": "service_role", "sub": "not-a-uuid"}', pg_temp.policy_sql(:orgB, 'all_required')));
select is(
  pg_temp.got('R11')
  || ' ' || (select string_agg(format('actor=%s made_as=%s aal=%s', coalesce(a.user_id::text, 'null'),
                                      a.metadata ->> 'made_as', a.metadata -> 'aal'), ',')
               from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgB
                and (a.metadata -> 'after') = pg_temp.p('all_required')),
  'ok:1 actor=null made_as=service_role aal=null',
  'R11: a token subject that is not a uuid counts as no actor: the change goes through and is recorded');
insert into outcome (step, got) values ('R12',
  pg_temp.run_text(null, 'not json', pg_temp.policy_sql(:orgB, 'optional')));
select is(
  pg_temp.got('R12')
  || ' ' || (select string_agg(format('actor=%s made_as=%s aal=%s', coalesce(a.user_id::text, 'null'),
                                      a.metadata ->> 'made_as', a.metadata -> 'aal'), ',')
               from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgB
                and (a.metadata -> 'after') = pg_temp.p('optional')),
  'ok:1 actor=null made_as=direct aal=null',
  'R12: claims that are not JSON count as no actor and no aal: the change goes through and is recorded');

-- made_as names the caller's role as it is. anon reaches a policy change
-- only through a SECURITY DEFINER function, so this row makes one (undone
-- with the file).
create function public.zz_rec_suite_set_policy(p_org uuid, p_policy text) returns void
language sql security definer set search_path = '' as $$
  update public.organizations set mfa_policy = p_policy where id = p_org
$$;
revoke all on function public.zz_rec_suite_set_policy(uuid, text) from public, authenticated, service_role;
grant execute on function public.zz_rec_suite_set_policy(uuid, text) to anon;
insert into outcome (step, got) values ('R13',
  pg_temp.run('anon', '{"role": "anon"}'::jsonb,
              format('select public.zz_rec_suite_set_policy(%L, %L)', :orgB, 'admins_required')));
select is(
  pg_temp.got('R13')
  || ' ' || (select string_agg(format('actor=%s made_as=%s', coalesce(a.user_id::text, 'null'), a.metadata ->> 'made_as'), ',')
               from public.audit_logs a
              where a.event = 'organization.mfa_policy.changed' and a.organization_id = :orgB
                and (a.metadata -> 'after') = pg_temp.p('admins_required')),
  'ok:1 actor=null made_as=anon',
  'R13: made_as names anon as anon');
drop function public.zz_rec_suite_set_policy(uuid, text);

-- ══ M. A member's role ════════════════════════════════════════════════════
insert into outcome (step, got) values ('M1',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.role_sql(:m_stf1, 'manager')));
select is(pg_temp.got('M1'), 'ok:1', 'M1: an admin changes a member''s role');
select is(
  (select string_agg(format('org=%s actor=%s ip=%s browser=%s at_now=%s details=%s', a.organization_id, a.user_id,
                            coalesce(host(a.ip), 'null'), coalesce(a.user_agent, 'null'), (a.created_at = now())::text,
                            (a.metadata = jsonb_build_object(
                              'entity_type', 'organization_member', 'entity_id', :m_stf1, 'warehouse_id', null,
                              'before', pg_temp.r('staff'), 'after', pg_temp.r('manager'), 'reason', null,
                              'source', 'database', 'made_as', 'authenticated', 'aal', 'aal2',
                              'target_user_id', :stf1))::text), ' / ')
     from public.audit_logs a where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' = :m_stf1),
  format('org=%s actor=%s ip=null browser=null at_now=true details=true', :orgA, :adm),
  'M2: exactly one row: the admin as the actor, the membership as the entity, the member as target_user_id, before and after, source database, made_as, aal; no address and no browser');
select is(
  (select format('%s %s %s %s', jsonb_typeof(a.metadata -> 'before' -> 'role'), a.metadata -> 'before' ->> 'role',
                 jsonb_typeof(a.metadata -> 'after' -> 'role'), a.metadata -> 'after' ->> 'role')
     from public.audit_logs a where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' = :m_stf1),
  'string staff string manager',
  'M3: before.role and after.role are text, the shape the role monitor reads');
insert into kept (label, print) values ('stf1', pg_temp.print('user.role.changed', :m_stf1));

insert into outcome (step, got) values ('M4',
  pg_temp.run('authenticated', pg_temp.claims(:mgr, 'authenticated', 'aal2'), pg_temp.role_sql(:m_stf2, 'manager')));
select is(
  pg_temp.got('M4') || ' rows=' || pg_temp.n('user.role.changed', :m_stf2)
  || ' role=' || (select m.role from public.organization_members m where m.id = :m_stf2),
  'ok:0 rows=0 role=staff',
  'M4: a member below admin changes no row and leaves no audit row');

insert into outcome (step, got) values ('M5',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'),
              format('update public.organization_members set role = %L where id in (%L, %L, %L, %L)',
                     'viewer', :m_stf2, :m_stf3, :m_mgr, :m_vwr)));
select is(
  pg_temp.got('M5')
  || ' ' || (select string_agg(x.line, ' ' order by x.line)
               from (select format('%s:%s>%s', case a.metadata ->> 'entity_id'
                                                 when :m_stf2 then 'stf2' when :m_stf3 then 'stf3'
                                                 when :m_mgr then 'mgr' when :m_vwr then 'vwr' end,
                                   a.metadata -> 'before' ->> 'role', a.metadata -> 'after' ->> 'role') as line
                       from public.audit_logs a
                      where a.event = 'user.role.changed'
                        and a.metadata ->> 'entity_id' in (:m_stf2, :m_stf3, :m_mgr, :m_vwr)) x),
  'ok:4 mgr:manager>viewer stf2:staff>viewer stf3:staff>viewer',
  'M5: one statement over four members writes one row for each of the three whose role changed, and none for the one whose role stayed');

insert into outcome (step, got) values ('M6',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'),
              format('update public.organization_members set is_delivery_driver = true where id = %L', :m_stf2))
  || ' ' || pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'),
                        format('update public.organization_members set all_warehouses = true where id = %L', :m_stf2)));
select is(
  pg_temp.got('M6') || ' rows=' || pg_temp.n('user.role.changed', :m_stf2),
  'ok:1 ok:1 rows=1',
  'M6: the driver flag and "all warehouses" leave no row');

insert into outcome (step, got) values ('M7',
  pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
              format('select public.transfer_org_ownership(%L, %L, %L)', :orgA, :own, :adm)));
select is(
  pg_temp.got('M7')
  || ' ' || (select string_agg(x.line, ' ' order by x.line)
               from (select format('%s:%s>%s actor=%s made_as=%s',
                                   case a.metadata ->> 'entity_id' when :m_own then 'own' when :m_adm then 'adm' end,
                                   a.metadata -> 'before' ->> 'role', a.metadata -> 'after' ->> 'role',
                                   coalesce(a.user_id::text, 'null'), a.metadata ->> 'made_as') as line
                       from public.audit_logs a
                      where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' in (:m_own, :m_adm)) x),
  'ok:1 adm:admin>owner actor=null made_as=service_role own:owner>admin actor=null made_as=service_role',
  'M7: an ownership transfer leaves two rows with no actor; the recorder reads the caller''s role (service_role) through the transfer function');

insert into outcome (step, got) values ('M8',
  pg_temp.run('service_role', pg_temp.claims(:ghost, 'service_role'), pg_temp.role_sql(:m_stf3, 'staff')));
select is(
  pg_temp.got('M8')
  || ' ' || (select string_agg(format('actor=%s made_as=%s target=%s', coalesce(a.user_id::text, 'null'),
                                      a.metadata ->> 'made_as', a.metadata ->> 'target_user_id'), ',')
               from public.audit_logs a
              where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' = :m_stf3
                and (a.metadata -> 'after') = pg_temp.r('staff')),
  format('ok:1 actor=null made_as=service_role target=%s', :stf3),
  'M8: a token subject with no account: the change goes through and its row has no actor');

insert into outcome (step, got) values ('M9',
  pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
              format('insert into public.organization_members (organization_id, user_id, role, accepted_at) '
                     || 'values (%L, %L, %L, now()) on conflict (organization_id, user_id) '
                     || 'do update set role = excluded.role, accepted_at = excluded.accepted_at', :orgA, :stf2, 'manager'))
  || ' rows=' || pg_temp.n('user.role.changed', :m_stf2)
  || ' ' || pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
              format('insert into public.organization_members (organization_id, user_id, role, accepted_at) '
                     || 'values (%L, %L, %L, now()) on conflict (organization_id, user_id) '
                     || 'do update set role = excluded.role, accepted_at = excluded.accepted_at', :orgA, :stf2, 'manager'))
  || ' rows=' || pg_temp.n('user.role.changed', :m_stf2)
  || ' ' || pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
              format('insert into public.organization_members (id, organization_id, user_id, role, accepted_at) '
                     || 'values (%L, %L, %L, %L, now())', :m_new, :orgA, :newm, 'staff'))
  || ' ' || pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
              format('delete from public.organization_members where id = %L', :m_new))
  || ' rows=' || pg_temp.n('user.role.changed', :m_new));
select is(
  pg_temp.got('M9'),
  'ok:1 rows=2 ok:1 rows=2 ok:1 ok:1 rows=0',
  'M9: an upsert that changes the role leaves one row; the row counts after the statements that follow it are as pinned');

insert into outcome (step, got) values ('M10',
  pg_temp.run('authenticated', pg_temp.claims(:admB, 'authenticated', 'aal2'), pg_temp.role_sql(:m_stf1, 'viewer'))
  || ' rows=' || pg_temp.n('user.role.changed', :m_stf1)
  || ' ' || pg_temp.run('authenticated', pg_temp.claims(:admB, 'authenticated', 'aal2'), pg_temp.role_sql(:m_stfB, 'manager')));
select is(
  pg_temp.got('M10')
  || ' ' || (select string_agg(format('org=%s actor=%s', a.organization_id, a.user_id), ',')
               from public.audit_logs a where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' = :m_stfB),
  format('ok:0 rows=1 ok:1 org=%s actor=%s', :orgB, :admB),
  'M10: an admin of another organization changes nothing here; their own organization''s change is recorded under it');

-- ══ F. The app's row for a recorded change ════════════════════════════════
-- stf1's change (M1: staff to manager, by adm) is the recorded row.
insert into outcome (step, got) values ('F1',
  pg_temp.copy(:c1, :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager')));
select is(pg_temp.got('F1'), 'ok:0', 'F1: the app''s row for a recorded change is accepted, and not stored');
select is(
  format('rows=%s same=%s by_id=%s', pg_temp.n('user.role.changed', :m_stf1),
         (pg_temp.print('user.role.changed', :m_stf1) = (select k.print from kept k where k.label = 'stf1'))::text,
         (select count(*) from public.audit_logs a where a.id = :c1)),
  'rows=1 same=true by_id=0',
  'F2: still one row, and it is the recorded one as it was: same place, same writing transaction, same bytes');
insert into outcome (step, got) values ('F3',
  pg_temp.copy(:c1, :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'), true)
  || ' ' || pg_temp.copy(:c1, :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'), true));
select is(
  pg_temp.got('F3')
  || format(' rows=%s same=%s by_id=%s', pg_temp.n('user.role.changed', :m_stf1),
            (pg_temp.print('user.role.changed', :m_stf1) = (select k.print from kept k where k.label = 'stf1'))::text,
            (select count(*) from public.audit_logs a where a.id = :c1)),
  'ok:0 ok:0 rows=1 same=true by_id=0',
  'F3: a second and a third later try (INSERT ... ON CONFLICT (id) DO NOTHING) likewise: one row, unchanged');
insert into outcome (step, got) values ('F4',
  pg_temp.copy(:c2, :orgA, :adm, 'user.role.changed', upper(:m_stf1), pg_temp.r('staff'), pg_temp.r('manager')));
select is(
  pg_temp.got('F4')
  || format(' rows=%s upper=%s same=%s', pg_temp.n('user.role.changed', :m_stf1),
            (select count(*) from public.audit_logs a where a.metadata ->> 'entity_id' = upper(:m_stf1)),
            (pg_temp.print('user.role.changed', :m_stf1) = (select k.print from kept k where k.label = 'stf1'))::text),
  'ok:0 rows=1 upper=0 same=true',
  'F4: the entity id is compared without regard to case: an upper-case id is the same change');
insert into outcome (step, got) values ('F5',
  pg_temp.run('service_role', '{"role": "service_role"}'::jsonb,
              pg_temp.copy_sql(:c3, :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'))
              || format(', (%L, %L, %L, %L, %L, %L, %L)', :c4, :orgA, :adm, 'user.signed_in', '203.0.113.7',
                        'Mozilla/5.0 (test browser)', '{"entity_type": "user"}')));
select is(
  pg_temp.got('F5')
  || format(' rows=%s first=%s second=%s', pg_temp.n('user.role.changed', :m_stf1),
            (select count(*) from public.audit_logs a where a.id = :c3),
            (select count(*) from public.audit_logs a where a.id = :c4 and a.event = 'user.signed_in')),
  'ok:1 rows=1 first=0 second=1',
  'F5: in a batch, the row for the recorded change is not stored and the other row is');

-- The sign-in policy's recorded row (R1: optional to all_required, by adm).
insert into kept (label, print) values ('orgA', pg_temp.print('organization.mfa_policy.changed', :orgA));
insert into outcome (step, got) values ('F6',
  pg_temp.copy(:c5, :orgA, :adm, 'organization.mfa_policy.changed', :orgA, pg_temp.p('optional'), pg_temp.p('all_required'))
  || ' ' || pg_temp.copy(:c5, :orgA, :adm, 'organization.mfa_policy.changed', :orgA, pg_temp.p('optional'),
                         pg_temp.p('all_required'), true));
select is(
  pg_temp.got('F6')
  || format(' rows=%s same=%s by_id=%s', pg_temp.n('organization.mfa_policy.changed', :orgA),
            (pg_temp.print('organization.mfa_policy.changed', :orgA) = (select k.print from kept k where k.label = 'orgA'))::text,
            (select count(*) from public.audit_logs a where a.id = :c5)),
  'ok:0 ok:0 rows=5 same=true by_id=0',
  'F6: the app''s row for a recorded sign-in policy change, first try and later try, is not stored; the five recorded rows are unchanged');

-- Rows the database did not record are stored as they were sent.
insert into outcome (step, got) values ('F7',
  pg_temp.copy(:c6, :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('admin'))
  || ' ' || pg_temp.copy(:c7, :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('viewer'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(:c8, :orgA, :own, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(:c9, :orgA, null, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(:c10, :orgA, :adm, 'user.role.changed', :m_vwr, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(:c11, :orgB, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(:c12, :orgA, :adm, 'organization.mfa_policy.changed', :orgA, pg_temp.p('optional'),
                         pg_temp.p('admins_required'))
  || ' ' || pg_temp.copy(:c13, :orgA, :adm, 'user.role.changed', :m_stf1, null, pg_temp.r('manager'), true));
select is(
  pg_temp.got('F7')
  || ' stored=' || (select count(*) from public.audit_logs a where a.id in (:c6, :c7, :c8, :c9, :c10, :c11, :c12, :c13))
  || ' same=' || (pg_temp.print('user.role.changed', :m_stf1) = (select k.print from kept k where k.label = 'stf1'))::text,
  'ok:1 ok:1 ok:1 ok:1 ok:1 ok:1 ok:1 ok:1 stored=8 same=true',
  'F7: a row with another after value, another before value, another actor, no actor, another membership, another organization, another policy value or no before value is stored; the recorded row is unchanged');
select is(
  (select format('org=%s actor=%s ip=%s browser=%s details=%s', a.organization_id, a.user_id, host(a.ip), a.user_agent,
                 (a.metadata = jsonb_build_object('entity_type', 'organization_member', 'entity_id', :m_stf1,
                                                  'warehouse_id', null, 'before', pg_temp.r('staff'),
                                                  'after', pg_temp.r('admin'), 'reason', null))::text)
     from public.audit_logs a where a.id = :c6),
  format('org=%s actor=%s ip=203.0.113.7 browser=Mozilla/5.0 (test browser) details=true', :orgA, :adm),
  'F8: a stored row is exactly what was sent: id, organization, actor, address, browser and details');

-- The window. Two recorded-shape rows written by the owner role (which is
-- not judged): one eleven minutes old, one nine.
insert into public.audit_logs (organization_id, user_id, event, metadata, created_at) values
  (:orgA, :adm, 'user.role.changed',
   jsonb_build_object('entity_type', 'organization_member', 'entity_id', :e_old, 'warehouse_id', null,
                      'before', pg_temp.r('staff'), 'after', pg_temp.r('manager'), 'reason', null,
                      'source', 'database', 'made_as', 'authenticated', 'aal', 'aal2', 'target_user_id', :stf1),
   now() - interval '11 minutes'),
  (:orgA, :adm, 'user.role.changed',
   jsonb_build_object('entity_type', 'organization_member', 'entity_id', :e_new, 'warehouse_id', null,
                      'before', pg_temp.r('staff'), 'after', pg_temp.r('manager'), 'reason', null,
                      'source', 'database', 'made_as', 'authenticated', 'aal', 'aal2', 'target_user_id', :stf1),
   now() - interval '9 minutes');
insert into outcome (step, got) values ('F9',
  pg_temp.copy(:c14, :orgA, :adm, 'user.role.changed', :e_old, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' rows=' || pg_temp.n('user.role.changed', :e_old)
  || ' ' || pg_temp.copy(:c15, :orgA, :adm, 'user.role.changed', :e_new, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' rows=' || pg_temp.n('user.role.changed', :e_new));
select is(
  pg_temp.got('F9'),
  'ok:1 rows=2 ok:0 rows=1',
  'F9: a recorded row older than ten minutes does not claim the app''s row (it is stored); one nine minutes old does');

-- Who and what is judged. A recorded-shape row of another event, and the
-- app's matching row of that event: stored. The owner role's own insert of
-- a row for a recorded change (a restore): stored. A member's insert:
-- refused, as before.
insert into public.audit_logs (organization_id, user_id, event, metadata) values
  (:orgA, :adm, 'user.deactivated',
   jsonb_build_object('entity_type', 'organization_member', 'entity_id', :e_other, 'warehouse_id', null,
                      'before', pg_temp.r('staff'), 'after', pg_temp.r('manager'), 'reason', null, 'source', 'database'));
insert into outcome (step, got) values ('F10',
  pg_temp.copy(:c16, :orgA, :adm, 'user.deactivated', :e_other, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' rows=' || pg_temp.n('user.deactivated', :e_other)
  || ' ' || pg_temp.run(null, null,
                        pg_temp.copy_sql(:c17, :orgA, :adm, 'user.role.changed', :e_new, pg_temp.r('staff'), pg_temp.r('manager')))
  || ' rows=' || pg_temp.n('user.role.changed', :e_new)
  || ' ' || split_part(pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'),
                                   pg_temp.copy_sql(:c18, :orgA, :adm, 'user.role.changed', :e_new, pg_temp.r('staff'),
                                                    pg_temp.r('manager'))), ':', 1)
  || ' rows=' || pg_temp.n('user.role.changed', :e_new));
select is(
  pg_temp.got('F10'),
  'ok:1 rows=2 ok:1 rows=2 42501 rows=2',
  'F10: a row of another event is not judged; a row inserted by the owner role is stored; a member''s insert is refused (42501) as before');

-- The same change made twice (stf1: manager to staff, then staff to manager
-- again, by adm): three recorded rows. Whatever the app sends for them, in
-- either order, three rows stay, unchanged.
insert into outcome (step, got) values ('F11a',
  pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.role_sql(:m_stf1, 'staff'))
  || ' ' || pg_temp.run('authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.role_sql(:m_stf1, 'manager')));
select is(
  pg_temp.got('F11a')
  || ' recorded=' || (select count(*) from public.audit_logs a
                       where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' = :m_stf1
                         and a.metadata ->> 'source' = 'database'),
  'ok:1 ok:1 recorded=3',
  'F11a: the same change made a second time is recorded a second time');
insert into kept (label, print) values ('stf1-three', pg_temp.print('user.role.changed', :m_stf1));
insert into outcome (step, got) values ('F11b',
  pg_temp.copy(gen_random_uuid(), :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(gen_random_uuid(), :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('manager'), pg_temp.r('staff'))
  || ' ' || pg_temp.copy(gen_random_uuid(), :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'))
  || ' ' || pg_temp.copy(gen_random_uuid(), :orgA, :adm, 'user.role.changed', :m_stf1, pg_temp.r('staff'), pg_temp.r('manager'), true));
select is(
  pg_temp.got('F11b')
  || format(' recorded=%s same=%s',
            (select count(*) from public.audit_logs a
              where a.event = 'user.role.changed' and a.metadata ->> 'entity_id' = :m_stf1
                and a.metadata ->> 'source' = 'database'),
            (pg_temp.print('user.role.changed', :m_stf1) = (select k.print from kept k where k.label = 'stf1-three'))::text),
  'ok:0 ok:0 ok:0 ok:0 recorded=3 same=true',
  'F11b: the app''s rows for the three changes, and one more, are not stored: three recorded rows, unchanged');

-- ══ X. Each trigger alone ═════════════════════════════════════════════════
-- The same attempt with the trigger disabled, then enabled; both undone.
select is(
  pg_temp.undone('alter table public.organizations disable trigger trg_zz_record_mfa_policy_change',
                 'authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.policy_sql(:orgA, 'all_required'),
                 format('select pg_temp.n(%L, %L)::text', 'organization.mfa_policy.changed', :orgA))
  || ' / ' ||
  pg_temp.undone(null,
                 'authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.policy_sql(:orgA, 'all_required'),
                 format('select pg_temp.n(%L, %L)::text', 'organization.mfa_policy.changed', :orgA)),
  '6 / 7',
  'X1: the sign-in policy row is written by trg_zz_record_mfa_policy_change (rows with it disabled / enabled)');
select is(
  pg_temp.undone('alter table public.organization_members disable trigger trg_zz_record_member_role_change',
                 'authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.role_sql(:m_vwr, 'staff'),
                 format('select pg_temp.n(%L, %L)::text', 'user.role.changed', :m_vwr))
  || ' / ' ||
  pg_temp.undone(null,
                 'authenticated', pg_temp.claims(:adm, 'authenticated', 'aal2'), pg_temp.role_sql(:m_vwr, 'staff'),
                 format('select pg_temp.n(%L, %L)::text', 'user.role.changed', :m_vwr)),
  '1 / 2',
  'X2: the role row is written by trg_zz_record_member_role_change (rows with it disabled / enabled)');
select is(
  pg_temp.undone('alter table public.audit_logs disable trigger zz_fold_app_copy',
                 'service_role', '{"role": "service_role"}'::jsonb,
                 pg_temp.copy_sql(gen_random_uuid(), :orgA, :adm, 'user.role.changed', :m_stf3, pg_temp.r('staff'), pg_temp.r('viewer')),
                 format('select pg_temp.n(%L, %L)::text', 'user.role.changed', :m_stf3))
  || ' / ' ||
  pg_temp.undone(null,
                 'service_role', '{"role": "service_role"}'::jsonb,
                 pg_temp.copy_sql(gen_random_uuid(), :orgA, :adm, 'user.role.changed', :m_stf3, pg_temp.r('staff'), pg_temp.r('viewer')),
                 format('select pg_temp.n(%L, %L)::text', 'user.role.changed', :m_stf3)),
  '3 / 2',
  'X3: the app''s row for a recorded change is held back by zz_fold_app_copy (rows with it disabled / enabled)');
select is(
  (select string_agg(t.tgname || '=' || t.tgenabled::text, ' ' order by t.tgname) from pg_trigger t
    where not t.tgisinternal
      and t.tgname in ('trg_zz_record_mfa_policy_change', 'trg_zz_record_member_role_change', 'zz_fold_app_copy')),
  'trg_zz_record_member_role_change=O trg_zz_record_mfa_policy_change=O zz_fold_app_copy=O',
  'X4: the undone attempts left all three triggers enabled');

-- ══ Z. What this file left ════════════════════════════════════════════════
select is(
  (select string_agg(format('%s %s recorded=%s other=%s', x.event, x.org, x.recorded, x.other), ' / ' order by x.event, x.org)
     from (select a.event, case a.organization_id when :orgA then 'A' when :orgB then 'B' end as org,
                  count(*) filter (where a.metadata ->> 'source' = 'database' and a.ip is null and a.user_agent is null) as recorded,
                  count(*) filter (where a.metadata ->> 'source' is distinct from 'database') as other
             from public.audit_logs a
            where a.organization_id in (:orgA, :orgB)
              and a.event in ('user.role.changed', 'organization.mfa_policy.changed')
            group by 1, 2) x),
  'organization.mfa_policy.changed A recorded=5 other=1 / organization.mfa_policy.changed B recorded=3 other=0 / user.role.changed A recorded=12 other=8 / user.role.changed B recorded=1 other=1',
  'Z1: the rows left, by event and organization: every recorded row has no address and no browser, and each stored app row is one F7, F9 or F10 names');

select * from finish();
rollback;
