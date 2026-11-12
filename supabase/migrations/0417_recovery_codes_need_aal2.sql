-- 0417_recovery_codes_need_aal2.sql
--
-- The database now asks for the same two-step sign-in level the app already
-- asks for before it makes new recovery codes (docket S50b).
--
-- generate_mfa_recovery_codes() makes ten new recovery codes for the
-- signed-in person and removes their old set. The Settings action that calls
-- it, generateMfaRecoveryCodesAction (apps/web/src/server/actions/
-- mfa-recovery.ts), refuses a session below aal2 first, with the sentence
-- "Re-authenticate with MFA before regenerating recovery codes."; the
-- function itself asked only for a signed-in caller. Now it asks for aal2
-- too: right after its signed-in check, before it reads or writes any row, a
-- token whose aal claim is not 'aal2' is refused with 42501, hint
-- aal2_required and the same sentence (the shape of 0413's level check). A
-- token with no aal claim counts as aal1.
--
-- NUMBER. 0417 is this file's final number, assigned by the integrator: the
-- next number after 0416. It moved here from its provisional number with
-- only the header lines that name a number changed; everything else is as
-- reviewed. Nothing reads the number: the
-- added lines end in "-- S50b", the preflight is the block tagged
-- $s50b_pre$, and the pgTAP file finds the statements the CLI recorded by
-- the migration's name (recovery_codes_need_aal2).
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
--   1. A catalog preflight pins generate_mfa_recovery_codes() as it is live:
--      its body (md5(prosrc) bfb43be0864a2b962f6dbb47402b5c68, 0103's text),
--      its header (no arguments, RETURNS TABLE(code text), plpgsql, SECURITY
--      DEFINER, VOLATILE, SET search_path = public, extensions, owner
--      postgres, not strict, not leakproof, PARALLEL UNSAFE, COST 100, ROWS
--      1000), its ACL (the exact text), and that it is the only function of
--      that name in public. On any difference it stops with 55000 (hint
--      recovery_codes_aal2_preflight), naming what differs, before anything
--      changes. A second run is a difference: the body is this file's then.
--   2. The function is restated verbatim from its latest definition,
--      0103_mfa_recovery_codes_normalize.sql (no later migration redefines
--      it; 0329 restated only its grants), with the level check added after
--      the signed-in check. Every added line ends in "-- S50b", and taking
--      those lines out gives 0103's body exactly (pgTAP R1). md5(prosrc)
--      bfb43be0864a2b962f6dbb47402b5c68 -> 0ce8f19c9a2747fb9d9e909f19082f4a.
--   3. 0329's revoke and grant for the function are restated unchanged, so
--      the ACL comes out byte for byte as it was: EXECUTE for authenticated,
--      service_role and the owner, none for anon or PUBLIC.
--   consume_mfa_recovery_code() is not changed.
--
-- WHO CHANGES: no one using StockPilot. The Settings action already asks for
-- aal2 before it calls the function, and the phone app does not call it.
--
-- DATA SAFETY: no row changes. A refused call raises before the function's
-- delete, so the caller's codes stay as they were.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- No table lock, at any point. The preflight reads catalogs only. Checking
-- the body (check_function_bodies, on in the push) parses it without opening
-- a table: it declares no %ROWTYPE or %TYPE. REVOKE and GRANT write the
-- function's catalog row, and GRANT holds an AccessShareLock on the role
-- authenticated to commit (PostgreSQL locks a role while it records a
-- dependency on it): only a DROP ROLE of authenticated would wait for it.
-- A call of the function takes no lock on it, so a call in flight does not
-- hold the file up, and a call made while the file is open runs at once.
-- lock_timeout 900ms bounds anything unforeseen: another open transaction
-- changing the function's catalog row makes the file wait, then end with
-- 55P03 and nothing applied. scripts/db-concurrency/
-- 0417_migration_lock_footprint.sh checks each of these.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- The function's new refusal is 42501 with hint aal2_required. The push
-- raises 55000 (drift: nothing applied) or 55P03 (busy: nothing applied).
-- Never 40001 or 40P01 (PostgREST retries those forever, 0367).

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- The function restated below must be exactly the one this file was written
-- against: 0103's body and header, the ACL 0329 left, and no second function
-- of its name. Anything else is drift (or a second run): stop before
-- changing anything.
do $s50b_pre$
declare
  v_bad   text := '';
  v_n     integer;
  v_found boolean;
  r       record;
begin
  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'generate_mfa_recovery_codes';
  if v_n <> 1 then
    v_bad := v_bad || format(' %s functions named public.generate_mfa_recovery_codes;', v_n);
  end if;

  -- got_* names, as 0415's preflight: a field named after a PL/pgSQL keyword
  -- (r.strict) does not resolve unquoted.
  select md5(p.prosrc) as got_src, pg_get_function_identity_arguments(p.oid) as got_args,
         pg_get_function_result(p.oid) as got_res, l.lanname as got_lang, p.prokind::text as got_kind,
         p.prosecdef as got_secdef, p.provolatile::text as got_vol,
         coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
         pg_get_userbyid(p.proowner) as got_owner, p.proisstrict as got_strict,
         p.proleakproof as got_leak, p.proparallel::text as got_par, p.procost as got_cost,
         p.prorows as got_rows, coalesce(p.proacl::text, '') as got_acl
    into r
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.generate_mfa_recovery_codes()');
  v_found := found;

  if not v_found then
    v_bad := v_bad || ' public.generate_mfa_recovery_codes() missing;';
  else
    if r.got_src <> 'bfb43be0864a2b962f6dbb47402b5c68' or r.got_args <> '' or r.got_res <> 'TABLE(code text)'
       or r.got_lang <> 'plpgsql' or r.got_kind <> 'f' or not r.got_secdef or r.got_vol <> 'v'
       or r.got_cfg <> 'search_path=public, extensions' or r.got_owner <> 'postgres'
       or r.got_strict or r.got_leak or r.got_par <> 'u' or r.got_cost <> 100 or r.got_rows <> 1000 then
      v_bad := v_bad || format(' public.generate_mfa_recovery_codes() drifted (md5 %s, arguments %L, returns %s,'
                               ' language %s, kind %s, definer %s, volatility %s, %s, owner %s, strict %s,'
                               ' leakproof %s, parallel %s, cost %s, rows %s);',
                               r.got_src, r.got_args, r.got_res, r.got_lang, r.got_kind, r.got_secdef, r.got_vol,
                               r.got_cfg, r.got_owner, r.got_strict, r.got_leak, r.got_par, r.got_cost, r.got_rows);
    end if;
    if r.got_acl <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
      v_bad := v_bad || format(' public.generate_mfa_recovery_codes() grants drifted (%s);', r.got_acl);
    end if;
  end if;

  if v_bad <> '' then
    raise exception 'recovery_codes_aal2_preflight:%', v_bad
      using errcode = '55000', hint = 'recovery_codes_aal2_preflight';
  end if;
end
$s50b_pre$;

-- ═══ 1. The function ═══════════════════════════════════════════════════════
-- Restated from 0103_mfa_recovery_codes_normalize.sql:31-83, its latest
-- definition, with the level check after the signed-in check; each added
-- line ends in "-- S50b". md5(prosrc) bfb43be0864a2b962f6dbb47402b5c68 ->
-- 0ce8f19c9a2747fb9d9e909f19082f4a.
create or replace function public.generate_mfa_recovery_codes()
returns table(code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  i int;
  raw_code text;
  canonical text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  group_a text;
  group_b text;
  group_c text;
  group_d text;
  pos int;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- S50b: the two-step sign-in level the app asks for (no aal claim = aal1).
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then  -- S50b
    raise exception 'Re-authenticate with MFA before regenerating recovery codes.'  -- S50b
      using errcode = '42501', hint = 'aal2_required';  -- S50b
  end if;  -- S50b

  delete from public.mfa_recovery_codes where user_id = uid;

  for i in 1..10 loop
    -- 16 chars from a 32-char alphabet → ~80 bits of entropy.
    group_a := '';
    group_b := '';
    group_c := '';
    group_d := '';
    for pos in 1..4 loop
      group_a := group_a || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
      group_b := group_b || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
      group_c := group_c || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
      group_d := group_d || substring(alphabet
        from (1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32))::int for 1);
    end loop;
    raw_code := group_a || '-' || group_b || '-' || group_c || '-' || group_d;
    -- Store the hash of the canonical (stripped) form so the consume
    -- function can match regardless of how the user pastes it back.
    canonical := regexp_replace(upper(raw_code), '[^A-Z0-9]', '', 'g');
    insert into public.mfa_recovery_codes (user_id, code_hash)
    values (uid, encode(extensions.digest(canonical, 'sha256'), 'hex'));
    -- Return the dashed form to the UI for readability.
    code := raw_code;
    return next;
  end loop;
  return;
end;
$$;

-- ═══ 2. Grants ═════════════════════════════════════════════════════════════
-- 0329_function_grants_and_search_path.sql:250-251, unchanged. CREATE OR
-- REPLACE keeps the ACL; restating the two statements leaves it byte for
-- byte as it was (authenticated's entry comes off and goes back last, where
-- 0329 put it).
revoke execute on function public.generate_mfa_recovery_codes()           from public, anon, authenticated;
grant  execute on function public.generate_mfa_recovery_codes()           to authenticated;
