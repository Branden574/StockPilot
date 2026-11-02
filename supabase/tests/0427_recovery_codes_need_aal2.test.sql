-- supabase/tests/0427_recovery_codes_need_aal2.test.sql
-- pgTAP proof for migration 0427 (docket S50b, provisional number): the
-- database now asks for the same two-step sign-in level the app already asks
-- for before it makes new recovery codes. generate_mfa_recovery_codes() makes
-- codes only for a token at aal2; consume_mfa_recovery_code() is not changed.
--
-- PROVISIONAL NUMBER: no check reads 0427. R strips the lines tagged
-- "-- S50b", and A finds the statements the CLI recorded by the migration's
-- name (recovery_codes_need_aal2) and its preflight by the $s50b_pre$ tag, so
-- the file moves to its final number unchanged.
--
-- Run against the schema without the migration (origin/main 6af839a8d, head
-- 0415, scratch stack, 2026-11-02) it fails 10 of its 19: L3, L4 and L5 (each
-- call makes ten codes), L6 (those calls ran, so the codes changed), R1, R2
-- and A1-A4 (nothing recorded). What passes there too is meant to: L1 and L2
-- (the normal path), P1, P2 and C1-C3 (what the migration keeps), M1 and Z1.
-- With the five tagged lines taken out of the migration it fails L3-L6, R1,
-- R2 and A2; with only the coalesce taken out, L4-L6 and R1.
--
-- L.  The level. An aal2 token makes ten codes, and a second aal2 call
--     replaces that set with ten new ones. An aal1 token, a token with no aal
--     claim, and the request.jwt.claim.sub-only setup 0027's test used are
--     each refused (42501, hint aal2_required, the Settings action's
--     sentence), and after the three refusals the person's codes are exactly
--     as they were.
-- R.  One change: md5(prosrc) is the new body, taking out the five lines
--     tagged "-- S50b" gives 0103's body exactly, and the check comes before
--     the delete.
-- P.  The header and the ACL are as before (the exact ACL text), and it is
--     the only function of its name in public.
-- C.  consume_mfa_recovery_code() is not changed: 0103's body, its header and
--     its ACL, and it answers as before.
-- M.  Mutation: with the tagged lines taken out of the live body (inside an
--     undone attempt), the aal1 call of L3 makes ten codes, so the L refusals
--     come from those lines.
-- A.  The migration's own preflight, replayed from the recorded statements:
--     recorded once; run again it stops (55000) naming the function; on the
--     state before the migration (the body without the tagged lines) it
--     passes; there, a changed body, a changed search_path, a changed ACL and
--     a second function of the name each stop it, named.
-- Z.  Every undone attempt changed nothing.
--
-- Roles: fixtures as the test superuser. Every call runs through pg_temp.run
-- (or pg_temp.run_sub_only), which sets the role and the claims with
-- set_config inside a subtransaction, so pgTAP's own statements never run as
-- an API role. Synthetic ids and example.test addresses only. Namespace
-- 5a50b000. begin/rollback: nothing leaks.

begin;
select plan(19);

\set member '\'5a50b000-0000-4000-8000-0000000000a1\''
\set other  '\'5a50b000-0000-4000-8000-0000000000a2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:member, 's50b-member@example.test', '{}'::jsonb),
  (:other,  's50b-other@example.test',  '{}'::jsonb)
on conflict (id) do nothing;

-- One call as p_as, signed in as p_sub with an aal claim (null: no aal claim
-- at all): the answer as text, or ERR:<sqlstate>:<hint>:<message>. A
-- subtransaction: a refused call leaves nothing behind, and the role and the
-- claims are reset either way. EXECUTE, so each call is prepared afresh.
create function pg_temp.run(p_as text, p_sub uuid, p_sql text, p_aal text)
returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text; v text; v_claims jsonb;
begin
  begin
    v_claims := jsonb_build_object('sub', p_sub, 'role', p_as);
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

-- The setup 0027's test used before this migration: request.jwt.claim.sub
-- and the role only, no request.jwt.claims (so auth.jwt() is null).
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

-- The codes of one answer, as the stored hashes (the function's own
-- canonical form), sorted; and a person's unused stored hashes, sorted.
create function pg_temp.hashes(p_codes text) returns text language sql immutable as $$
  select coalesce(string_agg(h, ',' order by h), '')
    from (select encode(extensions.digest(regexp_replace(upper(c), '[^A-Z0-9]', '', 'g'), 'sha256'), 'hex') as h
            from unnest(string_to_array(p_codes, ',')) c) s
$$;
create function pg_temp.unused(p_user uuid) returns text language sql stable as $$
  select coalesce(string_agg(code_hash, ',' order by code_hash), '')
    from public.mfa_recovery_codes where user_id = p_user and used_at is null
$$;
-- Every row a person holds (id, hash, used, created), as one checksum.
create function pg_temp.rows_of(p_user uuid) returns text language sql stable as $$
  select coalesce(md5(string_agg(id::text || '|' || code_hash || '|' || coalesce(used_at::text, '-') || '|'
                                 || created_at::text, ',' order by id)), 'none')
    from public.mfa_recovery_codes where user_id = p_user
$$;
-- An answer of generate as '10 codes' when it is ten distinct codes of the
-- XXXX-XXXX-XXXX-XXXX shape, else the answer itself.
create function pg_temp.shape(p_codes text) returns text language sql immutable as $$
  select case
           when p_codes like 'ERR:%' then p_codes
           else (select count(distinct c)::text || ' codes'
                   from unnest(string_to_array(p_codes, ',')) c
                  where c ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$')
         end
$$;

-- The function's state before the migration: the live body without the lines
-- tagged "-- S50b", under the same header (CREATE OR REPLACE keeps the ACL).
create function pg_temp.old_body_sql() returns text language sql stable as $$
  select format('create or replace function public.generate_mfa_recovery_codes() returns table(code text)'
                ' language plpgsql security definer set search_path = public, extensions as %L',
                regexp_replace(p.prosrc, E'[^\n]*-- S50b[^\n]*\n', '', 'g'))
    from pg_proc p where p.oid = 'public.generate_mfa_recovery_codes()'::regprocedure
$$;

-- The statements the CLI recorded for this migration (found by its name, not
-- its number) that open the block tagged p_tag (a line starting "do <tag>"),
-- and how many there are. The CLI records the file's header comment with its
-- first statement, and that comment names the tag, so a bare search for the
-- tag would also pick up that statement.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'recovery_codes_need_aal2' and position(E'\ndo ' || p_tag in E'\n' || st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'recovery_codes_need_aal2' and position(E'\ndo ' || p_tag in E'\n' || st) > 0
$$;

-- The migration's preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and what its message names, sorted. 'missing' when the
-- CLI recorded no preflight (the schema without the migration).
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_pre text := pg_temp.mig('$s50b_pre$');
begin
  if v_pre = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute v_pre;
    raise exception using errcode = 'XX50B', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX50B' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(v_hint, '') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(public\.generate_mfa_recovery_codes\(\) (?:grants drifted|drifted|missing)|[0-9]+ functions named)', 'g') m),
                     v_msg);
end $$;

-- The live body with the tagged lines taken out, ALWAYS undone, and an aal1
-- call of it: its answer.
create function pg_temp.mutant_call(p_sub uuid) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute pg_temp.old_body_sql();
    v := pg_temp.shape(pg_temp.run('authenticated', p_sub,
           'select string_agg(code, '','') from public.generate_mfa_recovery_codes()', 'aal1'));
    raise exception using errcode = 'XX50B', message = 'undo';
  exception when sqlstate 'XX50B' then
    null;
  end;
  return v;
end $$;

-- What the undone attempts below must leave as it was.
create function pg_temp.state(p_user uuid) returns text language sql stable as $$
  select (select md5(p.prosrc) || '|' || coalesce(p.proacl::text, '') || '|' || coalesce(array_to_string(p.proconfig, ';'), '')
            from pg_proc p where p.oid = 'public.generate_mfa_recovery_codes()'::regprocedure)
         || '|' || (select count(*) from pg_proc p
                     where p.pronamespace = 'public'::regnamespace and p.proname = 'generate_mfa_recovery_codes')::text
         || '|' || pg_temp.rows_of(p_user)
$$;

-- ══ L. The level ═══════════════════════════════════════════════════════════
create temp table _sets (k text primary key, codes text) on commit drop;
insert into _sets values
  ('a', pg_temp.run('authenticated', :member, $q$select string_agg(code, ',') from public.generate_mfa_recovery_codes()$q$, 'aal2'));
insert into _sets values
  ('b', pg_temp.run('authenticated', :member, $q$select string_agg(code, ',') from public.generate_mfa_recovery_codes()$q$, 'aal2'));

select is(pg_temp.shape((select codes from _sets where k = 'a')), '10 codes',
  'L1: an aal2 token makes ten codes');
select is(pg_temp.unused(:member) || '|' || (select count(*) from public.mfa_recovery_codes where user_id = :member)::text,
          pg_temp.hashes((select codes from _sets where k = 'b')) || '|10',
  'L2: a second aal2 call replaces the set: the person holds exactly its ten new codes and none of the first set');

create temp table _before on commit drop as select pg_temp.rows_of(:member) as v;

select is(pg_temp.run('authenticated', :member, $q$select count(*)::text from public.generate_mfa_recovery_codes()$q$, 'aal1'),
          'ERR:42501:aal2_required:Re-authenticate with MFA before regenerating recovery codes.',
  'L3: an aal1 token is refused (42501, hint aal2_required, the Settings action''s sentence)');
select is(pg_temp.run('authenticated', :member, $q$select count(*)::text from public.generate_mfa_recovery_codes()$q$, null),
          'ERR:42501:aal2_required:Re-authenticate with MFA before regenerating recovery codes.',
  'L4: a token with no aal claim is refused as aal1');
select is(pg_temp.run_sub_only(:member, $q$select count(*)::text from public.generate_mfa_recovery_codes()$q$),
          'ERR:42501:aal2_required:Re-authenticate with MFA before regenerating recovery codes.',
  'L5: the request.jwt.claim.sub-only setup (no claims, so no aal) is refused, which is why 0027''s test now sets an aal2 claim');
select is(pg_temp.rows_of(:member), (select v from _before),
  'L6: after the three refused calls the person''s codes are exactly as they were (the same rows, hashes and state)');

-- ══ R. One change ══════════════════════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || md5(regexp_replace(p.prosrc, E'[^\n]*-- S50b[^\n]*\n', '', 'g'))
     from pg_proc p where p.oid = 'public.generate_mfa_recovery_codes()'::regprocedure),
  '0ce8f19c9a2747fb9d9e909f19082f4a|bfb43be0864a2b962f6dbb47402b5c68',
  'R1: the body is the S50b one (md5 0ce8f19c), and taking out the tagged lines gives 0103''s body exactly (bfb43be0): the level check is the only change');
select is(
  (select (select count(*) from regexp_matches(p.prosrc, '-- S50b', 'g'))::text || '|'
          || (position('aal2_required' in p.prosrc) between 1 and position('delete from public.mfa_recovery_codes' in p.prosrc))::text
     from pg_proc p where p.oid = 'public.generate_mfa_recovery_codes()'::regprocedure),
  '5|true',
  'R2: five lines are tagged "-- S50b", and the level check comes before the delete');

-- ══ P. Posture ═════════════════════════════════════════════════════════════
select is(
  (select pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || l.lanname || '|'
          || p.prokind::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
          || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || p.proisstrict::text || '|' || p.proleakproof::text || '|' || p.proparallel::text || '|'
          || p.procost::text || '|' || p.prorows::text || '|'
          || (select count(*) from pg_proc q
               where q.pronamespace = 'public'::regnamespace and q.proname = 'generate_mfa_recovery_codes')::text
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'public.generate_mfa_recovery_codes()'::regprocedure),
  '|TABLE(code text)|plpgsql|f|true|v|search_path=public, extensions|postgres|false|false|u|100|1000|1',
  'P1: the header is as before (no arguments, TABLE(code text), plpgsql, SECURITY DEFINER, volatile, search_path public, extensions, owner postgres, cost 100, rows 1000) and it is the only function of its name in public');
select is(
  (select coalesce(p.proacl::text, '') || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
          || (not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text
     from pg_proc p where p.oid = 'public.generate_mfa_recovery_codes()'::regprocedure),
  '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}|true|false|true|true',
  'P2: the ACL is byte for byte as before: EXECUTE for authenticated and service_role, none for anon or PUBLIC');

-- ══ C. consume_mfa_recovery_code() is not changed ═════════════════════════
select is(
  (select md5(p.prosrc) || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|'
          || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|'
          || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, '')
     from pg_proc p where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure),
  '17f255317559b1f06dfaa19e6440859b|p_code text|boolean|true|v|search_path=public, extensions|postgres|{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}',
  'C1: consume_mfa_recovery_code() keeps 0103''s body (md5 17f25531), its header and its ACL');

insert into _sets values
  ('c', pg_temp.run('authenticated', :member, $q$select string_agg(code, ',') from public.generate_mfa_recovery_codes()$q$, 'aal2'));

select is(
  pg_temp.run('authenticated', :member,
    format('select public.consume_mfa_recovery_code(%L)::text', (select split_part(codes, ',', 1) from _sets where k = 'c')), 'aal1')
  || '/' ||
  pg_temp.run('authenticated', :member,
    format('select public.consume_mfa_recovery_code(%L)::text', (select split_part(codes, ',', 1) from _sets where k = 'c')), 'aal1'),
  'true/false',
  'C2: consume_mfa_recovery_code() answers as it did before: true once for the owner''s unused code, then false');
select is(
  pg_temp.run('authenticated', :other,
    format('select public.consume_mfa_recovery_code(%L)::text', (select split_part(codes, ',', 2) from _sets where k = 'c')), 'aal2')
  || '/' || (select count(*) from public.mfa_recovery_codes
              where user_id = :member and used_at is null
                and code_hash = pg_temp.hashes((select split_part(codes, ',', 2) from _sets where k = 'c')))::text,
  'false/1',
  'C3: another account''s call with that person''s code answers false, and the code is left as it was');

-- ══ M, A: undone attempts ═════════════════════════════════════════════════
create temp table _snap on commit drop as select pg_temp.state(:member) as v;

select is(pg_temp.mutant_call(:member), '10 codes',
  'M1: with the tagged lines taken out of the live body (undone), the aal1 call makes ten codes: the L refusals come from those lines');

select is(pg_temp.mig_count('$s50b_pre$'), 1::bigint,
  'A1: the CLI recorded the migration''s preflight exactly once (this section runs that text)');
select is(pg_temp.try_pre(null),
  '55000:recovery_codes_aal2_preflight:public.generate_mfa_recovery_codes() drifted',
  'A2: run again after the migration, the preflight stops before changing anything (55000) and names the function');
select is(pg_temp.try_pre(pg_temp.old_body_sql()), 'ok',
  'A3: on the state before the migration (the body without the tagged lines) the preflight passes: its pins are that state''s');
select is(
  pg_temp.try_pre(replace(pg_temp.old_body_sql(), E'\nbegin\n', E'\nbegin\n  -- drift probe\n'))
  || ' / ' ||
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'alter function public.generate_mfa_recovery_codes() set search_path = public')
  || ' / ' ||
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'grant execute on function public.generate_mfa_recovery_codes() to anon')
  || ' / ' ||
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'create function public.generate_mfa_recovery_codes(p_drift integer) returns table(code text)'
                  || ' language sql as $d$ select null::text $d$'),
  '55000:recovery_codes_aal2_preflight:public.generate_mfa_recovery_codes() drifted'
  || ' / 55000:recovery_codes_aal2_preflight:public.generate_mfa_recovery_codes() drifted'
  || ' / 55000:recovery_codes_aal2_preflight:public.generate_mfa_recovery_codes() grants drifted'
  || ' / 55000:recovery_codes_aal2_preflight:2 functions named',
  'A4: on that state, a changed body, a changed search_path, a changed ACL and a second function of the name each stop it (55000), named');

select is(pg_temp.state(:member), (select v from _snap),
  'Z1: every undone attempt changed nothing (the body, the ACL, the settings, the functions of the name, the person''s codes)');

select * from finish();
rollback;
