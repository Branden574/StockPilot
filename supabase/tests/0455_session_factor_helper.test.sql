-- supabase/tests/0455_session_factor_helper.test.sql
-- pgTAP proof for migration 0455: a schema, gate, holding two functions.
--   gate.session_meets_mfa() answers whether the session on the request has
--     met the account's sign-in factors: true when there is no account on the
--     request, when the token's aal claim is aal2, or when the account has no
--     verified factor; false otherwise. A token with no aal claim counts as
--     aal1. If the factor table cannot be read because of a catalog error
--     (42P01, 3F000, 42703, 42501) it answers true, records the SQLSTATE in
--     the transaction setting sp_gate.catalog_error and logs once; any other
--     error is raised.
--   gate.factor_read_state() answers one of four words about whether the
--     helper's owner can read factor rows: ok, blind, catalog or error.
-- Nothing calls either function: the migration adds them and their grants
-- and changes no row, policy or setting.
--
-- NUMBER: no check reads 0455. A finds the statements the CLI recorded by
-- the migration's name (session_factor_helper) and its preflight by the
-- $gate_pre$ tag, so the file can move to another number with no check
-- changed.
--
-- Run against the schema without the migration (origin/main b850db6ed, head
-- 0420, scratch stack, 2026-11-14) it fails 39 of its 40: every check but Z1
-- (the schema and both functions are missing).
--
-- R.  The rule, one session shape per check: no factor at aal1 (true); a
--     planted verified factor at aal1 (false: the helper sees the row, so a
--     helper that could not see factor rows fails here instead of answering
--     true for everyone); the same with no aal claim (false); the same at
--     aal2 (true); only an unverified factor (true); no account on the
--     request (true); anon and service_role may not call it (42501).
-- V.  Variants: a verified webauthn factor and a verified phone factor
--     (false); one verified beside one unverified, and two verified (false);
--     the verified factor removed (true again); aal3 (false: only aal2
--     passes); the request.jwt.claim.sub-only setup older tests use (false,
--     no claims means aal1); an account id with no auth.users row (true).
-- D.  Catalog errors, on a twin: the helper's own definition from
--     pg_get_functiondef with its name and the factor table's name swapped
--     (D1 checks it is otherwise the same text). Then: the table dropped
--     (true, flag 42P01), the column renamed (true, flag 42703), the twin's
--     owner without SELECT on the table (true, flag 42501), a division by
--     zero injected (the call raises 22012); a flag already set keeps its
--     first SQLSTATE. The real body's one handler names exactly the four
--     conditions.
-- P.  factor_read_state() answers ok for anon; authenticated and
--     service_role may not call it.
-- O.  The owner's premises: postgres owns both functions, may select
--     auth.mfa_factors and holds BYPASSRLS (row security is on for that
--     table).
-- H.  Structure: both headers and bodies (md5), the exact ACLs, the
--     schema's owner, ACL and contents.
-- M.  Mutation: with the status term taken out of the live body (undone),
--     the unverified-only account answers false; with the aal2 line taken
--     out, the enrolled account at aal2 answers false. So R5 and R4 come
--     from those lines.
-- A.  The migration's own preflight, replayed from the recorded statements:
--     recorded once; run again it stops (55000) naming the schema; on the
--     state before the migration it passes; there, run as a role that may
--     not select the factor table and has neither BYPASSRLS nor SUPERUSER,
--     it stops naming both.
-- Z.  Every undone attempt changed nothing.
--
-- Roles: fixtures as the test superuser. Every call runs through pg_temp.run
-- (or pg_temp.run_sub_only), which sets the role and the claims with
-- set_config inside a subtransaction, so pgTAP's own statements never run as
-- an API role. Synthetic ids and example.test addresses only. Namespace
-- 9a7e0000. begin/rollback: nothing leaks.

begin;
select plan(40);

\set nofactor   '\'9a7e0000-0000-4000-8000-0000000000a1\''
\set totp       '\'9a7e0000-0000-4000-8000-0000000000a2\''
\set webauthn   '\'9a7e0000-0000-4000-8000-0000000000a3\''
\set phone      '\'9a7e0000-0000-4000-8000-0000000000a4\''
\set mixed      '\'9a7e0000-0000-4000-8000-0000000000a5\''
\set twoverif   '\'9a7e0000-0000-4000-8000-0000000000a6\''
\set unverif    '\'9a7e0000-0000-4000-8000-0000000000a7\''
\set removed    '\'9a7e0000-0000-4000-8000-0000000000a8\''
\set ghost      '\'9a7e0000-0000-4000-8000-0000000000a9\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:nofactor, 'gate-nofactor@example.test', '{}'::jsonb),
  (:totp,     'gate-totp@example.test',     '{}'::jsonb),
  (:webauthn, 'gate-webauthn@example.test', '{}'::jsonb),
  (:phone,    'gate-phone@example.test',    '{}'::jsonb),
  (:mixed,    'gate-mixed@example.test',    '{}'::jsonb),
  (:twoverif, 'gate-two@example.test',      '{}'::jsonb),
  (:unverif,  'gate-unverified@example.test', '{}'::jsonb),
  (:removed,  'gate-removed@example.test',  '{}'::jsonb)
on conflict (id) do nothing;

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, phone) values
  ('9a7e0000-0000-4000-8000-000000000102', :totp,     'gate totp',       'totp',     'verified',   now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000103', :webauthn, 'gate webauthn',   'webauthn', 'verified',   now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000104', :phone,    'gate phone',      'phone',    'verified',   now(), now(), '+15550100001'),
  ('9a7e0000-0000-4000-8000-000000000105', :mixed,    'gate mixed one',  'totp',     'verified',   now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000115', :mixed,    'gate mixed two',  'totp',     'unverified', now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000106', :twoverif, 'gate two one',    'totp',     'verified',   now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000116', :twoverif, 'gate two two',    'webauthn', 'verified',   now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000107', :unverif,  'gate unverified', 'totp',     'unverified', now(), now(), null),
  ('9a7e0000-0000-4000-8000-000000000108', :removed,  'gate removed',    'totp',     'verified',   now(), now(), null);

-- One call as p_as, signed in as p_sub (null: no account) with an aal claim
-- (null: no aal claim at all): the answer as text, or
-- ERR:<sqlstate>:<hint>:<message>. A subtransaction: the role and the claims
-- are reset either way. EXECUTE, so each call is prepared afresh.
create function pg_temp.run(p_as text, p_sub uuid, p_sql text, p_aal text)
returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text; v text; v_claims jsonb;
begin
  begin
    v_claims := jsonb_build_object('role', p_as);
    if p_sub is not null then
      v_claims := v_claims || jsonb_build_object('sub', p_sub);
    end if;
    if p_aal is not null then
      v_claims := v_claims || jsonb_build_object('aal', p_aal);
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claims', v_claims::text, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_msg, '');
  end;
  return coalesce(v, 'null');
end $$;

-- The setup older tests use: request.jwt.claim.sub and the role only, no
-- request.jwt.claims (so auth.jwt() is null).
create function pg_temp.run_sub_only(p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text; v text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_msg, '');
  end;
  return coalesce(v, 'null');
end $$;

-- The helper's answer for one session, as an authenticated caller.
create function pg_temp.meets(p_sub uuid, p_aal text) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, 'select gate.session_meets_mfa()::text', p_aal)
$$;

-- An error answer without its message text: ERR:<sqlstate>.
create function pg_temp.code(p text) returns text language sql immutable as $$
  select case when p like 'ERR:%' then 'ERR:' || split_part(p, ':', 2) else p end
$$;

-- ══ R. The rule ════════════════════════════════════════════════════════════
select is(pg_temp.meets(:nofactor, 'aal1'), 'true',
  'R1: an account with no factor, at aal1: true');
select is(pg_temp.meets(:totp, 'aal1'), 'false',
  'R2: an account with a planted verified factor, at aal1: false (the helper sees the factor row)');
select is(pg_temp.meets(:totp, null), 'false',
  'R3: the same account with no aal claim counts as aal1: false');
select is(pg_temp.meets(:totp, 'aal2'), 'true',
  'R4: the same account at aal2: true');
select is(pg_temp.meets(:unverif, 'aal1'), 'true',
  'R5: an account whose only factor is unverified, at aal1: true');
select is(pg_temp.meets(null, null) || '/' || pg_temp.meets(null, 'aal1'), 'true/true',
  'R6: no account on the request (no sub), with or without an aal claim: true');
select is(
  pg_temp.code(pg_temp.run('anon', null, 'select gate.session_meets_mfa()::text', null)) || '/' ||
  pg_temp.code(pg_temp.run('service_role', null, 'select gate.session_meets_mfa()::text', null)),
  'ERR:42501/ERR:42501',
  'R7: anon and service_role may not call the helper (42501)');

-- ══ V. Variants ════════════════════════════════════════════════════════════
select is(pg_temp.meets(:webauthn, 'aal1') || '/' || pg_temp.meets(:phone, 'aal1'), 'false/false',
  'V1: a verified webauthn factor and a verified phone factor count, at aal1: false');
select is(pg_temp.meets(:mixed, 'aal1') || '/' || pg_temp.meets(:twoverif, 'aal1'), 'false/false',
  'V2: one verified beside one unverified, and two verified, at aal1: false');
select is(pg_temp.meets(:removed, 'aal1'), 'false',
  'V3: an account with a verified factor, before it is removed: false');
delete from auth.mfa_factors where user_id = :removed;
select is(pg_temp.meets(:removed, 'aal1'), 'true',
  'V4: the same account after its verified factor is removed: true again');
select is(pg_temp.meets(:totp, 'aal3') || '/' || pg_temp.meets(:totp, 'AAL2') || '/' || pg_temp.meets(:totp, ''), 'false/false/false',
  'V5: only the exact value aal2 passes: aal3, AAL2 and an empty aal claim are false for an enrolled account');
select is(
  pg_temp.run_sub_only(:totp, 'select gate.session_meets_mfa()::text') || '/' ||
  pg_temp.run_sub_only(:nofactor, 'select gate.session_meets_mfa()::text'),
  'false/true',
  'V6: the request.jwt.claim.sub-only setup (no claims, so aal1): false for an enrolled account, true for one with no factor');
select is(pg_temp.meets(:ghost, 'aal1'), 'true',
  'V7: an account id with no auth.users row: true (it holds no factor)');
select is(
  pg_temp.meets(:totp, 'aal1') || '/' || pg_temp.meets(:nofactor, 'aal1') || '/' || pg_temp.meets(:totp, 'aal1'),
  'false/true/false',
  'V8: answers do not carry from one account to the next within a transaction');

-- ══ D. Catalog errors, on a twin ═══════════════════════════════════════════
-- The twin lives in a schema made here (rolled back at the end): the
-- helper's own definition with its name and the factor table's name swapped.
create schema gate_twin;
create table gate_twin.factors (user_id uuid not null, status text not null);
insert into gate_twin.factors values (:totp, 'verified'), (:unverif, 'unverified');
grant usage on schema gate_twin to authenticated;

create function pg_temp.twin_sql(p_name text, p_inject text) returns text language sql stable as $$
  select replace(replace(replace(pg_get_functiondef(to_regprocedure('gate.session_meets_mfa()')),
                                 'gate.session_meets_mfa()', 'gate_twin.' || p_name || '()'),
                         'auth.mfa_factors', 'gate_twin.factors'),
                 'return not exists (', 'return ' || p_inject || 'not exists (')
$$;
-- Without the helper (the schema before the migration) the twins are stand-ins
-- that answer null, so the D checks fail instead of stopping the file.
do $$ begin
  if to_regprocedure('gate.session_meets_mfa()') is not null then
    execute pg_temp.twin_sql('meets', '');
    execute pg_temp.twin_sql('meets_div', '1 / (length(v_uid::text) - 36) = 1 and ');
  else
    create function gate_twin.meets() returns boolean language sql as 'select null::boolean';
    create function gate_twin.meets_div() returns boolean language sql as 'select null::boolean';
  end if;
end $$;
grant execute on function gate_twin.meets(), gate_twin.meets_div() to authenticated;

-- One twin call as the enrolled account at aal1 after p_ddl, with the flag
-- set to p_flag first, ALWAYS undone: '<answer>|<flag>', or the error.
create function pg_temp.twin_case(p_fn text, p_ddl text, p_flag text) returns text language plpgsql as $$
declare v text;
begin
  begin
    perform set_config('sp_gate.catalog_error', coalesce(p_flag, ''), true);
    if p_ddl is not null then
      execute p_ddl;
    end if;
    v := pg_temp.run('authenticated', '9a7e0000-0000-4000-8000-0000000000a2', format(
           'select gate_twin.%s()::text || ''|'' || coalesce(nullif(current_setting(''sp_gate.catalog_error'', true), ''''), ''none'')',
           p_fn), 'aal1');
    raise exception using errcode = 'XX9A7', message = 'undo';
  exception
    when sqlstate 'XX9A7' then null;
    when others then return 'ERR:' || sqlstate;
  end;
  return v;
end $$;

select is(
  (select replace(replace(pg_get_functiondef(to_regprocedure('gate_twin.meets()')),
                          'gate_twin.meets()', 'gate.session_meets_mfa()'), 'gate_twin.factors', 'auth.mfa_factors'))
  = pg_get_functiondef(to_regprocedure('gate.session_meets_mfa()'))
  and (select count(*) from regexp_matches(pg_get_functiondef(to_regprocedure('gate.session_meets_mfa()')), 'auth\.mfa_factors', 'g')) = 1,
  true,
  'D1: the twin is the helper''s own definition but for its name and the factor table''s name (which the helper names once)');
select is(pg_temp.twin_case('meets', null, null) || ' / ' || pg_temp.twin_case('meets', null, null),
  'false|none / false|none',
  'D2: control: with nothing broken the twin answers false for the enrolled account and sets no flag');
select is(pg_temp.twin_case('meets', 'drop table gate_twin.factors', null), 'true|42P01',
  'D3: the table dropped (42P01): the twin answers true and records 42P01');
select is(pg_temp.twin_case('meets', 'alter table gate_twin.factors rename column status to status_gone', null), 'true|42703',
  'D4: the column renamed (42703): the twin answers true and records 42703');
select is(pg_temp.twin_case('meets', 'grant create on schema gate_twin to authenticated; alter function gate_twin.meets() owner to authenticated', null), 'true|42501',
  'D5: the twin''s owner may not select the table (42501; the owner made authenticated, which holds no SELECT on it): the twin answers true and records 42501');
select is(pg_temp.code(pg_temp.twin_case('meets_div', null, null)), 'ERR:22012',
  'D6: any other error is raised: a division by zero injected into the read makes the call fail (22012), not answer true');
select is(pg_temp.twin_case('meets', 'drop table gate_twin.factors', '42703'), 'true|42703',
  'D7: a flag already set in the transaction keeps its first SQLSTATE (the helper records and logs once per transaction)');
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '\mexception\M', 'gi'))::text || '|'
          || (select count(*) from regexp_matches(p.prosrc, '\mothers\M', 'gi'))::text || '|'
          || (position('when undefined_table or undefined_column or insufficient_privilege or invalid_schema_name then' in p.prosrc) > 0)::text
     from pg_proc p where p.oid = to_regprocedure('gate.session_meets_mfa()')),
  '1|0|true',
  'D8: the real body has one exception handler, naming exactly undefined_table, undefined_column, insufficient_privilege and invalid_schema_name, and no OTHERS');

-- ══ P. The premise check ═══════════════════════════════════════════════════
select is(pg_temp.run('anon', null, 'select gate.factor_read_state()', null), 'ok',
  'P1: factor_read_state() answers ok for anon (the owner can read factor rows)');
select is(
  pg_temp.code(pg_temp.run('authenticated', :totp, 'select gate.factor_read_state()', 'aal2')) || '/' ||
  pg_temp.code(pg_temp.run('service_role', null, 'select gate.factor_read_state()', null)),
  'ERR:42501/ERR:42501',
  'P2: authenticated and service_role may not call factor_read_state() (42501)');

-- ══ O. The owner's premises ════════════════════════════════════════════════
select is(
  (select string_agg(pg_get_userbyid(p.proowner), ',' order by p.proname) from pg_proc p
    where p.pronamespace = to_regnamespace('gate'))
  || '|' || (select (r.rolbypassrls or r.rolsuper)::text from pg_roles r where r.rolname = 'postgres')
  || '|' || has_table_privilege('postgres', 'auth.mfa_factors', 'SELECT')::text
  || '|' || (select c.relrowsecurity::text from pg_class c where c.oid = 'auth.mfa_factors'::regclass),
  'postgres,postgres|true|true|true',
  'O1: postgres owns both functions, holds BYPASSRLS and may select auth.mfa_factors, whose row security is on');

-- ══ H. Structure ═══════════════════════════════════════════════════════════
select is(
  (select pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || l.lanname || '|'
          || p.prokind::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
          || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || p.proisstrict::text || '|'
          || p.proleakproof::text || '|' || p.proparallel::text || '|' || md5(p.prosrc)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure('gate.session_meets_mfa()')),
  '|boolean|plpgsql|f|true|s|search_path=""|false|false|u|420ee7cb8a1b292336383cb4f3376d1d',
  'H1: session_meets_mfa(): no arguments, boolean, plpgsql, SECURITY DEFINER, STABLE, search_path empty, not strict, not leakproof, parallel unsafe, and its body (md5)');
select is(
  (select pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || l.lanname || '|'
          || p.prokind::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
          || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || p.proisstrict::text || '|'
          || p.proleakproof::text || '|' || p.proparallel::text || '|' || md5(p.prosrc)
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure('gate.factor_read_state()')),
  '|text|plpgsql|f|true|s|search_path=""|false|false|u|774e6fb49825b3558626b883d1ef47ad',
  'H2: factor_read_state(): no arguments, text, plpgsql, SECURITY DEFINER, STABLE, search_path empty, not strict, not leakproof, parallel unsafe, and its body (md5)');
select is(
  (select coalesce(p.proacl::text, '') from pg_proc p where p.oid = to_regprocedure('gate.session_meets_mfa()'))
  || ' ' ||
  (select coalesce(p.proacl::text, '') from pg_proc p where p.oid = to_regprocedure('gate.factor_read_state()')),
  '{postgres=X/postgres,authenticated=X/postgres} {postgres=X/postgres,anon=X/postgres}',
  'H3: the exact ACLs: session_meets_mfa() for authenticated only, factor_read_state() for anon only; nothing for PUBLIC');
select is(
  (select string_agg(r || ':' || has_function_privilege(r, to_regprocedure('gate.session_meets_mfa()'), 'EXECUTE')::text
                       || ',' || has_function_privilege(r, to_regprocedure('gate.factor_read_state()'), 'EXECUTE')::text, ' ' order by r)
     from unnest(array['anon', 'authenticated', 'service_role']) r),
  'anon:false,true authenticated:true,false service_role:false,false',
  'H4: what each API role may execute, by privilege check (direct or through PUBLIC)');
select is(
  (select pg_get_userbyid(n.nspowner) || '|' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'gate'),
  'postgres|{postgres=UC/postgres,anon=U/postgres,authenticated=U/postgres,service_role=U/postgres}',
  'H5: schema gate is owned by postgres; USAGE for anon, authenticated and service_role; CREATE for none of them; nothing for PUBLIC');
select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ',' order by p.proname), '') from pg_proc p
    where p.pronamespace = to_regnamespace('gate'))
  || '|' || (select count(*) from pg_class c where c.relnamespace = to_regnamespace('gate'))::text
  || '|' || (select count(*) from pg_type t where t.typnamespace = to_regnamespace('gate'))::text,
  'gate.factor_read_state(),gate.session_meets_mfa()|0|0',
  'H6: schema gate holds exactly the two functions, and no relation or type');
select is(
  (select coalesce(string_agg((obj_description(p.oid, 'pg_proc') is not null)::text, ',' order by p.proname), '')
     from pg_proc p where p.pronamespace = to_regnamespace('gate')) || '|'
  || (obj_description(to_regnamespace('gate'), 'pg_namespace') is not null)::text,
  'true,true|true',
  'H7: the schema and both functions carry a comment');

-- ══ M, A: undone attempts ═════════════════════════════════════════════════
create function pg_temp.state() returns text language sql stable as $$
  select (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || '/' || coalesce(p.proacl::text, ''), ',' order by p.proname)
            from pg_proc p where p.pronamespace = to_regnamespace('gate'))
         || '|' || (select coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'gate')
         || '|' || (select count(*) from auth.mfa_factors where user_id::text like '9a7e0000-%')::text
$$;
create temp table _snap on commit drop as select pg_temp.state() as v;

-- The live helper with one line pattern taken out (or replaced), ALWAYS
-- undone, and one call of it: its answer.
create function pg_temp.mutant(p_from text, p_to text, p_sub uuid, p_aal text) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute replace(pg_get_functiondef(to_regprocedure('gate.session_meets_mfa()')), p_from, p_to);
    v := pg_temp.meets(p_sub, p_aal);
    raise exception using errcode = 'XX9A7', message = 'undo';
  exception
    when sqlstate 'XX9A7' then null;
    when others then return 'ERR:' || sqlstate;
  end;
  return v;
end $$;

select is(pg_temp.mutant(' and f.status = ''verified''', '', :unverif, 'aal1'), 'false',
  'M1: with the status term taken out (undone), the unverified-only account answers false: R5 comes from that term');
select is(pg_temp.mutant('= ''aal2'' then return true', '= ''never'' then return true', :totp, 'aal2'), 'false',
  'M2: with the aal2 line made inert (undone), the enrolled account at aal2 answers false: R4 comes from that line');

-- The statements the CLI recorded for this migration (found by its name, not
-- its number) that open the block tagged p_tag, and how many there are.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'session_factor_helper' and position(E'\ndo ' || p_tag in E'\n' || st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'session_factor_helper' and position(E'\ndo ' || p_tag in E'\n' || st) > 0
$$;

-- The migration's preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:<message>'. 'missing' when the CLI recorded no preflight.
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_pre text := pg_temp.mig('$gate_pre$');
begin
  if v_pre = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute v_pre;
    raise exception using errcode = 'XX9A7', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX9A7' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_msg, '');
end $$;

select is(pg_temp.mig_count('$gate_pre$'), 1::bigint,
  'A1: the CLI recorded the migration''s preflight exactly once (this section runs that text)');
select is(pg_temp.try_pre(null),
  '55000:gate_helper_preflight:gate_helper_preflight: schema gate already exists;',
  'A2: run again after the migration, the preflight stops before changing anything (55000) and names the schema');
select is(pg_temp.try_pre('set local client_min_messages = warning; drop schema gate cascade'), 'ok',
  'A3: on the state before the migration (no schema gate) the preflight passes');
select is(pg_temp.try_pre('set local client_min_messages = warning; drop schema gate cascade; set local role authenticated'),
  '55000:gate_helper_preflight:gate_helper_preflight: the migration role (authenticated) may not select auth.mfa_factors;'
  || ' auth.mfa_factors has row security on and the migration role (authenticated) has neither BYPASSRLS nor SUPERUSER;',
  'A4: on that state, run as a role that may not select the factor table and has neither BYPASSRLS nor SUPERUSER, it stops (55000) naming both');

select is(pg_temp.state(), (select v from _snap),
  'Z1: every undone attempt changed nothing (the functions, their bodies and ACLs, the schema ACL, the fixture factors)');

select * from finish();
rollback;
