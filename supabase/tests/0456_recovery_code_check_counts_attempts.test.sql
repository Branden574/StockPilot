-- supabase/tests/0456_recovery_code_check_counts_attempts.test.sql
-- pgTAP proof for migration 0456: the recovery-code check counts its own
-- attempts. consume_mfa_recovery_code() counts every call of a signed-in
-- account with a non-empty code in public.rate_limit_buckets (key
-- 'mfa-recovery-fn:' || the account id, 10 per 15 minutes, through
-- public.increment_rate_limit) before it compares any code, and past that it
-- raises P0001 with hint rate_limited, comparing and marking nothing.
--
-- NUMBER: no check reads 0456. H4 and M2 strip the lines tagged
-- "-- attempts", and A finds the statements the CLI recorded by the
-- migration's name (recovery_code_check_counts_attempts) and its preflight by
-- the $attempts_pre$ tag, so the file can move to its final number with no
-- check changed.
--
-- B.  Behaviour, as one account at aal1: a right code answers true and marks
--     its row; a wrong code answers false; the account's count is one bucket
--     whose key is the account id and nothing of the code; calls three to ten
--     answer as before; the eleventh call within the window raises (P0001,
--     hint rate_limited) even for a right code, marks nothing and adds
--     nothing to the count; another account's count is its own; an empty
--     code still answers false and is not counted.
-- R.  Roles: anon cannot execute; service_role without an account id still
--     gets not_authenticated and nothing is counted.
-- H.  The header (definer, search_path, owner, volatility), the exact ACL,
--     the counter's grants (its owner may execute it, authenticated and anon
--     may not), and one change: taking out the lines tagged "-- attempts"
--     gives 0103's body exactly, and the count comes before the hashing and
--     the update.
-- M.  Order and mutation: with an account's bucket already at the limit, a
--     right code's row stays unused; with the tagged lines taken out of the
--     live body (undone), the eleventh call with a right code answers true,
--     so the refusal comes from those lines; a counter that errors fails the
--     call and one that answers nothing refuses it (each undone): closed.
-- A.  The migration's own preflight, replayed from the recorded statements:
--     recorded once; run again it stops (55000) naming the function; on the
--     state before the migration it passes; there, a changed body, a changed
--     ACL, a missing counter, a counter of another shape and a second
--     function of the name each stop it, named.
-- Z.  Every undone attempt changed nothing.
--
-- Run against the schema without the migration (origin/main b850db6ed, head
-- 0420, scratch stack, 2026-11-14) it fails 20 of its 27: B3-B9, R2, H1, H4,
-- H5, M1-M4 and A1-A5. What passes there too is meant to: B1 and B2 (the
-- normal path), R1, H2 and H3 (what the migration keeps), and Z1 and Z2.
--
-- Roles: fixtures as the test superuser. Every call runs through pg_temp.run,
-- which sets the role and the claims with set_config inside a
-- subtransaction, so pgTAP's own statements never run as an API role.
-- Synthetic ids and example.test addresses only. Namespace 0456a000.
-- begin/rollback: nothing leaks.

begin;
select plan(27);

\set member '\'0456a000-0000-4000-8000-0000000000a1\''
\set other  '\'0456a000-0000-4000-8000-0000000000a2\''
\set third  '\'0456a000-0000-4000-8000-0000000000a3\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:member, 'attempts-member@example.test', '{}'::jsonb),
  (:other,  'attempts-other@example.test',  '{}'::jsonb),
  (:third,  'attempts-third@example.test',  '{}'::jsonb)
on conflict (id) do nothing;

-- One call as p_as, signed in as p_sub (null: no account) with an aal claim:
-- the answer as text, or ERR:<sqlstate>:<hint>:<message>. A subtransaction:
-- a refused call leaves nothing behind, and the role and the claims are reset
-- either way. EXECUTE, so each call is prepared afresh.
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

-- A code check as p_sub at aal1: its answer.
create function pg_temp.check_code(p_sub uuid, p_code text) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub,
                     format('select public.consume_mfa_recovery_code(%L)::text', p_code), 'aal1')
$$;

-- Ten new codes for p_sub (an aal2 call), comma-separated.
create function pg_temp.new_codes(p_sub uuid) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub,
                     'select string_agg(code, '','') from public.generate_mfa_recovery_codes()', 'aal2')
$$;

-- The read-backs below are volatile: a stable function reads with the
-- calling statement's snapshot, so it would not see a call made earlier in
-- the same statement.
-- One code's stored hash (the function's canonical form).
create function pg_temp.hash_of(p_code text) returns text language sql immutable as $$
  select encode(extensions.digest(regexp_replace(upper(p_code), '[^A-Z0-9]', '', 'g'), 'sha256'), 'hex')
$$;
-- Whether p_user's row for p_code is marked used: 'used', 'unused' or 'none'.
create function pg_temp.mark_of(p_user uuid, p_code text) returns text language sql volatile as $$
  select coalesce((select case when used_at is null then 'unused' else 'used' end
                     from public.mfa_recovery_codes
                    where user_id = p_user and code_hash = pg_temp.hash_of(p_code)), 'none')
$$;
-- Every row a person holds (id, hash, used, created), as one checksum.
create function pg_temp.rows_of(p_user uuid) returns text language sql volatile as $$
  select coalesce(md5(string_agg(id::text || '|' || code_hash || '|' || coalesce(used_at::text, '-') || '|'
                                 || created_at::text, ',' order by id)), 'none')
    from public.mfa_recovery_codes where user_id = p_user
$$;
-- An account's bucket of the function: 'count|window_ms', or 'none'.
create function pg_temp.bucket(p_user uuid) returns text language sql volatile as $$
  select coalesce((select b.count::text || '|' || b.window_ms::text
                     from public.rate_limit_buckets b where b.key = 'mfa-recovery-fn:' || p_user::text), 'none')
$$;

-- The function's state before the migration: the live body without the lines
-- tagged "-- attempts", under the same header (CREATE OR REPLACE keeps the
-- ACL).
create function pg_temp.old_body_sql() returns text language sql stable as $$
  select format('create or replace function public.consume_mfa_recovery_code(p_code text) returns boolean'
                ' language plpgsql security definer set search_path = public, extensions as %L',
                regexp_replace(p.prosrc, E'[^\n]*-- attempts[^\n]*\n', '', 'g'))
    from pg_proc p where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure
$$;

-- The statements the CLI recorded for this migration (found by its name, not
-- its number) that open the block tagged p_tag, and how many there are.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'recovery_code_check_counts_attempts' and position(E'\ndo ' || p_tag in E'\n' || st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'recovery_code_check_counts_attempts' and position(E'\ndo ' || p_tag in E'\n' || st) > 0
$$;

-- The migration's preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and what its message names, sorted. 'missing' when the
-- CLI recorded no preflight (the schema without the migration).
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_pre text := pg_temp.mig('$attempts_pre$');
begin
  if v_pre = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute v_pre;
    raise exception using errcode = 'XX456', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX456' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(v_hint, '') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(public\.(?:consume_mfa_recovery_code\(text\)|increment_rate_limit\(text, integer, integer\)) (?:grants drifted|drifted|missing)|[0-9]+ functions named)', 'g') m),
                     v_msg);
end $$;

-- p_prep, then one code check as p_sub, ALWAYS undone: the answer and the
-- mark of p_code's row after the call, as 'answer / mark'.
create function pg_temp.undone_check(p_prep text, p_sub uuid, p_code text) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute p_prep;
    v := pg_temp.check_code(p_sub, p_code) || ' / ' || pg_temp.mark_of(p_sub, p_code);
    raise exception using errcode = 'XX456', message = 'undo';
  exception when sqlstate 'XX456' then
    null;
  end;
  return v;
end $$;

-- What the undone attempts below must leave as it was.
create function pg_temp.state() returns text language sql volatile as $$
  select (select md5(p.prosrc) || '|' || coalesce(p.proacl::text, '') || '|' || coalesce(array_to_string(p.proconfig, ';'), '')
            from pg_proc p where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure)
         || '|' || (select md5(p.prosrc) || '|' || coalesce(p.proacl::text, '')
                      from pg_proc p where p.oid = 'public.increment_rate_limit(text, integer, integer)'::regprocedure)
         || '|' || (select count(*) from pg_proc p
                     where p.pronamespace = 'public'::regnamespace
                       and p.proname in ('consume_mfa_recovery_code', 'increment_rate_limit'))::text
         || '|' || (select coalesce(md5(string_agg(b.key || '|' || b.count::text, ',' order by b.key)), 'none')
                      from public.rate_limit_buckets b where b.key like 'mfa-recovery-fn:%')
         || '|' || (select coalesce(md5(string_agg(c.id::text || '|' || coalesce(c.used_at::text, '-'), ',' order by c.id)), 'none')
                      from public.mfa_recovery_codes c)
$$;

-- A code no account holds (the codes' shape, a value the generator's
-- alphabet cannot make: it has no 0 or 1).
\set wrong '\'Z0Z0-Z0Z0-Z0Z0-Z0Z1\''

create temp table _sets (k text primary key, codes text) on commit drop;
insert into _sets values ('m', pg_temp.new_codes(:member)), ('o', pg_temp.new_codes(:other)), ('t', pg_temp.new_codes(:third));
create function pg_temp.code(p_set text, p_n int) returns text language sql stable as $$
  select split_part(codes, ',', p_n) from _sets where k = p_set
$$;

-- ══ B. Behaviour ═══════════════════════════════════════════════════════════
select is(pg_temp.check_code(:member, pg_temp.code('m', 1)) || ' / ' || pg_temp.mark_of(:member, pg_temp.code('m', 1)),
          'true / used',
  'B1: a right code answers true and marks its row used');
select is(pg_temp.check_code(:member, :wrong), 'false',
  'B2: a wrong code answers false');
select is(pg_temp.bucket(:member), '2|900000',
  'B3: each of the two calls was counted in the account''s bucket, a 15-minute window');
select is(
  (select string_agg(b.key, ',' order by b.key) from public.rate_limit_buckets b where b.key like 'mfa-recovery-fn:%')
  || ' / ' ||
  (select count(*) from public.rate_limit_buckets b
    where position(upper(:wrong) in upper(b.key)) > 0
       or position(regexp_replace(upper(:wrong), '[^A-Z0-9]', '', 'g') in upper(b.key)) > 0
       or position(regexp_replace(upper(pg_temp.code('m', 1)), '[^A-Z0-9]', '', 'g') in upper(b.key)) > 0
       or position(upper(pg_temp.code('m', 1)) in upper(b.key)) > 0)::text,
  'mfa-recovery-fn:0456a000-0000-4000-8000-0000000000a1 / 0',
  'B4: the bucket key is the account id after the prefix, and no key holds anything of a code');
select is(
  (select string_agg(pg_temp.check_code(:member, :wrong), ',' order by g) from generate_series(3, 10) g)
  || ' / ' || pg_temp.bucket(:member),
  'false,false,false,false,false,false,false,false / 10|900000',
  'B5: calls three to ten answer as before (false for a wrong code), and the count reaches ten');

create temp table _before on commit drop as select pg_temp.rows_of(:member) as v;

select is(pg_temp.check_code(:member, pg_temp.code('m', 2)),
          'ERR:P0001:rate_limited:too_many_attempts',
  'B6: the eleventh call within the window raises (P0001, hint rate_limited), even for a right code');
select is(pg_temp.mark_of(:member, pg_temp.code('m', 2)) || ' / ' || (pg_temp.rows_of(:member) = (select v from _before))::text
          || ' / ' || pg_temp.bucket(:member),
          'unused / true / 10|900000',
  'B7: the refused right code is still unused, the person''s codes are exactly as they were, and the count stays at ten');
select is(pg_temp.check_code(:other, :wrong) || ',' || pg_temp.check_code(:other, pg_temp.code('o', 1))
          || ' / ' || pg_temp.mark_of(:other, pg_temp.code('o', 1))
          || ' / ' || pg_temp.bucket(:other) || ' / ' || pg_temp.bucket(:member),
          'false,true / used / 2|900000 / 10|900000',
  'B8: another account''s count is its own: its calls answer as before while the first account is past the bound');
select is(pg_temp.check_code(:member, '') || ',' || pg_temp.check_code(:member, '   ')
          || ',' || pg_temp.run('authenticated', :member, 'select public.consume_mfa_recovery_code(null)::text', 'aal1')
          || ' / ' || pg_temp.bucket(:member),
          'false,false,false / 10|900000',
  'B9: an empty or null code still answers false before anything is counted');

-- ══ R. Roles ═══════════════════════════════════════════════════════════════
select is(pg_temp.run('anon', null, format('select public.consume_mfa_recovery_code(%L)::text', pg_temp.code('m', 3)), null),
          'ERR:42501::permission denied for function consume_mfa_recovery_code',
  'R1: anon cannot execute the function');
select is(pg_temp.run('service_role', null, format('select public.consume_mfa_recovery_code(%L)::text', pg_temp.code('m', 3)), null)
          || ' / ' || (select count(*) from public.rate_limit_buckets b where b.key like 'mfa-recovery-fn:%')::text
          || ' / ' || pg_temp.mark_of(:member, pg_temp.code('m', 3)),
          'ERR:42501::not_authenticated / 2 / unused',
  'R2: service_role without an account id still gets not_authenticated, and nothing is counted or marked');

-- ══ H. Header, grants, one change ═════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|'
          || l.lanname || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
          || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || p.proisstrict::text || '|' || p.proleakproof::text || '|' || p.proparallel::text || '|'
          || (select count(*) from pg_proc q
               where q.pronamespace = 'public'::regnamespace and q.proname = 'consume_mfa_recovery_code')::text
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure),
  '26c41958657c3e1a8c5048c6ea5bea42|p_code text|boolean|plpgsql|true|v|search_path=public, extensions|postgres|false|false|u|1',
  'H1: the header: body md5 26c41958, p_code text, boolean, plpgsql, SECURITY DEFINER, volatile, search_path public, extensions, owner postgres, the only function of its name');
select is(
  (select coalesce(p.proacl::text, '') || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
          || (not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text
     from pg_proc p where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure),
  '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}|true|false|true|true',
  'H2: the ACL is byte for byte 0329''s: EXECUTE for authenticated and service_role, none for anon or PUBLIC');
select is(
  (select pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('postgres', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
     from pg_proc p where p.oid = 'public.increment_rate_limit(text, integer, integer)'::regprocedure),
  'postgres|true|false|false|true',
  'H3: the counter is owned by postgres, the function''s owner, who may execute it; authenticated and anon still may not');
select is(
  (select md5(regexp_replace(p.prosrc, E'[^\n]*-- attempts[^\n]*\n', '', 'g')) || '|'
          || (select count(*) from regexp_matches(p.prosrc, '-- attempts', 'g'))::text || '|'
          || (position('public.increment_rate_limit(' in p.prosrc) between 1 and position('extensions.digest(' in p.prosrc))::text || '|'
          || (position('public.increment_rate_limit(' in p.prosrc) < position('update public.mfa_recovery_codes' in p.prosrc))::text || '|'
          || (position('length(trim(p_code)) = 0' in p.prosrc) between 1 and position('public.increment_rate_limit(' in p.prosrc))::text
     from pg_proc p where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure),
  '17f255317559b1f06dfaa19e6440859b|8|true|true|true',
  'H4: taking out the eight lines tagged "-- attempts" gives 0103''s body exactly (17f25531), and the count comes after the empty-code answer and before the hashing and the update');
select is(
  (select position('mfa-recovery-fn:'' || uid::text, 10, 900000)' in p.prosrc) > 0
          and position('p_code' in substring(p.prosrc from position('public.increment_rate_limit(' in p.prosrc) for 80)) = 0
     from pg_proc p where p.oid = 'public.consume_mfa_recovery_code(text)'::regprocedure),
  true,
  'H5: the counter is called with the prefix and the account id, 10, and a 15-minute window, and with nothing of the code');

-- ══ M. Order and mutation ═════════════════════════════════════════════════
-- The third account's bucket at the bound before its first call (as the
-- table's own writer would leave it).
insert into public.rate_limit_buckets (key, count, window_started_at, window_ms, expires_at)
values ('mfa-recovery-fn:' || :third::text, 10, now(), 900000, now() + interval '15 minutes');

select is(pg_temp.check_code(:third, pg_temp.code('t', 1)) || ' / ' || pg_temp.mark_of(:third, pg_temp.code('t', 1)),
          'ERR:P0001:rate_limited:too_many_attempts / unused',
  'M1: with the bucket already at the bound, a right code is refused and its row stays unused: the count comes before the comparison');

create temp table _snap on commit drop as select pg_temp.state() as v;

select is(pg_temp.undone_check(pg_temp.old_body_sql(), :member, pg_temp.code('m', 2)), 'true / used',
  'M2: with the tagged lines taken out of the live body (undone), the eleventh call with a right code answers true: the refusal comes from those lines');
select is(
  pg_temp.undone_check(
    'create or replace function public.increment_rate_limit(p_key text, p_limit integer, p_window_ms integer)'
    || ' returns table (allowed boolean, count integer, reset_at timestamptz) language plpgsql security definer'
    || ' set search_path = public as ''begin raise exception ''''counter_down''''; end''',
    :other, pg_temp.code('o', 2)),
  'ERR:P0001::counter_down / unused',
  'M3: a counter that errors fails the call with its error and the right code stays unused (undone): closed');
select is(
  pg_temp.undone_check(
    'create or replace function public.increment_rate_limit(p_key text, p_limit integer, p_window_ms integer)'
    || ' returns table (allowed boolean, count integer, reset_at timestamptz) language plpgsql security definer'
    || ' set search_path = public as ''begin return; end''',
    :other, pg_temp.code('o', 2)),
  'ERR:P0001:rate_limited:too_many_attempts / unused',
  'M4: a counter that answers nothing refuses the call and the right code stays unused (undone): closed');

-- ══ A. The preflight, replayed ════════════════════════════════════════════
select is(pg_temp.mig_count('$attempts_pre$'), 1::bigint,
  'A1: the CLI recorded the migration''s preflight exactly once (this section runs that text)');
select is(pg_temp.try_pre(null),
  '55000:recovery_code_attempts_preflight:public.consume_mfa_recovery_code(text) drifted',
  'A2: run again after the migration, the preflight stops before changing anything (55000) and names the function');
select is(pg_temp.try_pre(pg_temp.old_body_sql()), 'ok',
  'A3: on the state before the migration (the body without the tagged lines) the preflight passes: its pins are that state''s');
select is(
  pg_temp.try_pre(replace(pg_temp.old_body_sql(), E'\nbegin\n', E'\nbegin\n  -- drift probe\n'))
  || ' / ' ||
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'grant execute on function public.consume_mfa_recovery_code(text) to anon')
  || ' / ' ||
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'alter function public.increment_rate_limit(text, integer, integer) rename to increment_rate_limit_moved')
  || ' / ' ||
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'create function public.consume_mfa_recovery_code(p_drift integer) returns boolean'
                  || ' language sql as ''select false'''),
  '55000:recovery_code_attempts_preflight:public.consume_mfa_recovery_code(text) drifted'
  || ' / 55000:recovery_code_attempts_preflight:public.consume_mfa_recovery_code(text) grants drifted'
  || ' / 55000:recovery_code_attempts_preflight:public.increment_rate_limit(text, integer, integer) missing'
  || ' / 55000:recovery_code_attempts_preflight:2 functions named',
  'A4: on that state, a changed body, a changed ACL, a missing counter and a second function of the name each stop it (55000), named');
select is(
  pg_temp.try_pre(pg_temp.old_body_sql() || ';'
                  || 'drop function public.increment_rate_limit(text, integer, integer);'
                  || 'create function public.increment_rate_limit(p_key text, p_limit integer, p_window_ms integer)'
                  || ' returns boolean language sql security definer set search_path = public as ''select true'''),
  '55000:recovery_code_attempts_preflight:public.increment_rate_limit(text, integer, integer) drifted',
  'A5: on that state, a counter that answers another shape (a boolean, not the row the call reads) stops it (55000), named');

-- ══ Z. Undone ═════════════════════════════════════════════════════════════
select is(pg_temp.state(), (select v from _snap),
  'Z1: every undone attempt changed nothing (the bodies, the ACLs, the functions of the names, the buckets, every code''s mark)');

-- The bound is ten for the third account too: its one refused call above
-- added nothing, and nothing in this file reset it.
select is(pg_temp.bucket(:third), '10|900000',
  'Z2: a refused call adds nothing to the count');

select * from finish();
rollback;
