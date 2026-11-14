-- 0456_recovery_code_check_counts_attempts.sql
--
-- The recovery-code check counts its own attempts.
--
-- consume_mfa_recovery_code(p_code) marks one of the signed-in person's
-- unused recovery codes used and answers true, or answers false. The web
-- action that calls it (consumeMfaRecoveryCodeAction, apps/web/src/server/
-- actions/mfa-recovery.ts) counts each press in its own limits first. The
-- function counts as well: every call of a signed-in account with a non-empty
-- code is counted, before any code is compared, in the existing rate-limit
-- table (public.rate_limit_buckets, through public.increment_rate_limit,
-- 0048) under the key 'mfa-recovery-fn:' || the account id, 10 per 15
-- minutes. Past that the call is refused with P0001, message
-- too_many_attempts, hint rate_limited, and nothing is compared or marked.
-- The bound sits above the web action's own 5 per 15 minutes for checked
-- codes, so a person using the app always meets the app's own sentence
-- first.
--
-- NUMBER. 0456 is provisional. Nothing reads the number: the added lines end
-- in "-- attempts", the preflight is the block tagged $attempts_pre$, and the
-- pgTAP file finds the statements the CLI recorded by the migration's name
-- (recovery_code_check_counts_attempts).
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
--   0. A catalog preflight pins consume_mfa_recovery_code(text) as it is
--      live: its body (md5(prosrc) 17f255317559b1f06dfaa19e6440859b, 0103's
--      text), its header (p_code text, RETURNS boolean, plpgsql, SECURITY
--      DEFINER, VOLATILE, SET search_path = public, extensions, owner
--      postgres, not strict, not leakproof, PARALLEL UNSAFE), its ACL (the
--      exact text 0329 left) and that it is the only function of that name in
--      public; and it pins public.increment_rate_limit(text, integer,
--      integer) as the call below uses it: its body (md5(prosrc)
--      96d87ab16d9ff63468ac261a3f76139f, 0048's text, which decides what
--      "allowed" means: calls 1 to 10 of a fixed window allowed, the 11th
--      refused and not counted), RETURNS TABLE(allowed boolean, count
--      integer, reset_at timestamp with time zone), owned by postgres (the
--      owner of the function that calls it), so the call needs no grant.
--      On any difference it stops with 55000 (hint
--      recovery_code_attempts_preflight), naming what differs, before
--      anything changes. A second run is a difference: the body is this
--      file's then.
--   1. The function is restated from its latest definition,
--      0103_mfa_recovery_codes_normalize.sql:87-124 (0329 restated only its
--      grants; 0417 left it as it was), with the count added after the
--      signed-in check and the empty-code answer, before any comparison.
--      Every added line ends in "-- attempts", and taking those lines out
--      gives 0103's body exactly. md5(prosrc)
--      17f255317559b1f06dfaa19e6440859b -> 26c41958657c3e1a8c5048c6ea5bea42.
--      SEARCH PATH: kept as it is (public, extensions). INV-B5 asks that a
--      first-party function pins its search_path, which this one does. The
--      body's tables and functions are schema-qualified (public.*,
--      extensions.digest, auth.uid); the rest are pg_catalog builtins
--      (regexp_replace, upper, trim, length, encode, now, the || operator)
--      and the uid::text cast, which resolve in pg_catalog, searched before
--      public when the path does not name it, so nothing in public can
--      shadow them. The header stays byte for byte as it was.
--   2. 0329's revoke and grant for the function are restated unchanged, so
--      the ACL comes out byte for byte as it was: EXECUTE for authenticated,
--      service_role and the owner, none for anon or PUBLIC.
--      public.increment_rate_limit keeps its grants (service_role and its
--      owner only, 0318): the function runs as its owner, postgres, which
--      owns the counter too.
--   3. A comment on the function says what it does.
--
-- WHO CHANGES: no one using StockPilot in the normal way. The web action
-- refuses a sixth checked code in 15 minutes before it calls the function,
-- and the phone app does not call it. A call past ten in 15 minutes for one
-- account is refused; the web action answers that refusal with its own
-- too-many-attempts sentence.
--
-- DATA SAFETY: no stored row changes and nothing is dropped. After the file,
-- each counted call writes one row of public.rate_limit_buckets (the table
-- the web limits already write); a refused call compares nothing and marks
-- no code.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- No table lock, at any point. The preflight reads catalogs only. Checking
-- the body (check_function_bodies, on in the push) parses it without opening
-- a table: it declares no %ROWTYPE or %TYPE. REVOKE and GRANT write the
-- function's catalog row, and GRANT holds an AccessShareLock on the role
-- authenticated to commit: only a DROP ROLE of authenticated would wait for
-- it. COMMENT writes pg_description and holds a ShareUpdateExclusiveLock on
-- the function object to commit: only other DDL on the same function waits
-- for it. A call of the function takes no lock on it, so a call in flight
-- does not hold the file up. lock_timeout 900ms bounds anything unforeseen:
-- another open transaction changing the function's catalog row makes the
-- file wait, then end with 55P03 and nothing applied.
-- scripts/db-concurrency/0456_migration_lock_footprint.sh checks each of
-- these.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- The function's new refusal is P0001 with hint rate_limited. A counter
-- that errors makes the call fail with that error, and a counter that
-- answers nothing is a refusal: closed either way. The push raises 55000
-- (drift: nothing applied) or 55P03 (busy: nothing applied). Never 40001 or
-- 40P01 (PostgREST retries those forever, 0367).

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- The function restated below must be exactly the one this file was written
-- against (0103's body and header, the ACL 0329 left, no second function of
-- its name), and the counter it calls must be there, as the call uses it,
-- owned by the same owner. Anything else is drift (or a second run): stop
-- before changing anything.
do $attempts_pre$
declare
  v_bad   text := '';
  v_n     integer;
  v_found boolean;
  r       record;
begin
  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'consume_mfa_recovery_code';
  if v_n <> 1 then
    v_bad := v_bad || format(' %s functions named public.consume_mfa_recovery_code;', v_n);
  end if;

  -- got_* names, as 0415's and 0417's preflights: a field named after a
  -- PL/pgSQL keyword (r.strict) does not resolve unquoted.
  select md5(p.prosrc) as got_src, pg_get_function_identity_arguments(p.oid) as got_args,
         pg_get_function_result(p.oid) as got_res, l.lanname as got_lang, p.prokind::text as got_kind,
         p.prosecdef as got_secdef, p.provolatile::text as got_vol,
         coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
         pg_get_userbyid(p.proowner) as got_owner, p.proisstrict as got_strict,
         p.proleakproof as got_leak, p.proparallel::text as got_par,
         coalesce(p.proacl::text, '') as got_acl
    into r
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.consume_mfa_recovery_code(text)');
  v_found := found;

  if not v_found then
    v_bad := v_bad || ' public.consume_mfa_recovery_code(text) missing;';
  else
    if r.got_src <> '17f255317559b1f06dfaa19e6440859b' or r.got_args <> 'p_code text' or r.got_res <> 'boolean'
       or r.got_lang <> 'plpgsql' or r.got_kind <> 'f' or not r.got_secdef or r.got_vol <> 'v'
       or r.got_cfg <> 'search_path=public, extensions' or r.got_owner <> 'postgres'
       or r.got_strict or r.got_leak or r.got_par <> 'u' then
      v_bad := v_bad || format(' public.consume_mfa_recovery_code(text) drifted (md5 %s, arguments %L, returns %s,'
                               ' language %s, kind %s, definer %s, volatility %s, %s, owner %s, strict %s,'
                               ' leakproof %s, parallel %s);',
                               r.got_src, r.got_args, r.got_res, r.got_lang, r.got_kind, r.got_secdef, r.got_vol,
                               r.got_cfg, r.got_owner, r.got_strict, r.got_leak, r.got_par);
    end if;
    if r.got_acl <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
      v_bad := v_bad || format(' public.consume_mfa_recovery_code(text) grants drifted (%s);', r.got_acl);
    end if;
  end if;

  -- The counter, as the call below uses it: three arguments (text, integer,
  -- integer), 0048's body (what "allowed" means), one row with a boolean
  -- "allowed", owned by postgres so the function (owned by postgres) may
  -- call it without a grant.
  select md5(p.prosrc) as got_src, pg_get_function_result(p.oid) as got_res, p.prokind::text as got_kind,
         pg_get_userbyid(p.proowner) as got_owner
    into r
    from pg_proc p
   where p.oid = to_regprocedure('public.increment_rate_limit(text, integer, integer)');
  v_found := found;

  if not v_found then
    v_bad := v_bad || ' public.increment_rate_limit(text, integer, integer) missing;';
  elsif r.got_src <> '96d87ab16d9ff63468ac261a3f76139f'
        or r.got_res <> 'TABLE(allowed boolean, count integer, reset_at timestamp with time zone)'
        or r.got_kind <> 'f' or r.got_owner <> 'postgres'
        or not has_function_privilege('postgres', 'public.increment_rate_limit(text, integer, integer)', 'EXECUTE') then
    v_bad := v_bad || format(' public.increment_rate_limit(text, integer, integer) drifted (md5 %s, returns %s, kind %s, owner %s);',
                             r.got_src, r.got_res, r.got_kind, r.got_owner);
  end if;

  if v_bad <> '' then
    raise exception 'recovery_code_attempts_preflight:%', v_bad
      using errcode = '55000', hint = 'recovery_code_attempts_preflight';
  end if;
end
$attempts_pre$;

-- ═══ 1. The function ═══════════════════════════════════════════════════════
-- Restated from 0103_mfa_recovery_codes_normalize.sql:87-124, its latest
-- definition, with the count after the empty-code answer; each added line
-- ends in "-- attempts". md5(prosrc) 17f255317559b1f06dfaa19e6440859b ->
-- 26c41958657c3e1a8c5048c6ea5bea42.
-- The bound (10 per 15 minutes) must stay at least twice the web action's
-- RECOVERY_CODE_CHECKS (5 per 15 minutes, apps/web/src/server/actions/
-- mfa-recovery.ts): two of the action's windows can overlap one of these, so
-- a person using the app meets the app's own pause first.
create or replace function public.consume_mfa_recovery_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  canonical text;
  legacy text;
  hashed_canonical text;
  hashed_legacy text;
  matched_id uuid;
  under_limit boolean;  -- attempts
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_code is null or length(trim(p_code)) = 0 then
    return false;
  end if;
  -- Count the call for this account before any code is compared: 10 in 15 minutes.  -- attempts
  -- The key holds the account id only. A counter that errors fails the call.  -- attempts
  select r.allowed into under_limit  -- attempts
    from public.increment_rate_limit('mfa-recovery-fn:' || uid::text, 10, 900000) r;  -- attempts
  if under_limit is distinct from true then  -- attempts
    raise exception 'too_many_attempts' using errcode = 'P0001', hint = 'rate_limited';  -- attempts
  end if;  -- attempts
  -- New canonical form: strip every non-alphanumeric char and uppercase.
  -- Tolerates pasted codes with or without dashes / inside whitespace.
  canonical := regexp_replace(upper(p_code), '[^A-Z0-9]', '', 'g');
  hashed_canonical := encode(extensions.digest(canonical, 'sha256'), 'hex');
  -- Legacy fallback for codes generated under 0027 before this migration.
  -- Original normalization kept the dashes inside the hashed input.
  legacy := upper(trim(p_code));
  hashed_legacy := encode(extensions.digest(legacy, 'sha256'), 'hex');

  update public.mfa_recovery_codes
    set used_at = now()
    where user_id = uid
      and used_at is null
      and (code_hash = hashed_canonical or code_hash = hashed_legacy)
    returning id into matched_id;
  return matched_id is not null;
end;
$$;

-- ═══ 2. Grants ═════════════════════════════════════════════════════════════
-- 0329_function_grants_and_search_path.sql:241-242, unchanged. CREATE OR
-- REPLACE keeps the ACL; restating the two statements leaves it byte for
-- byte as it was (authenticated's entry comes off and goes back last, where
-- 0329 put it). Nothing is granted on public.increment_rate_limit.
revoke execute on function public.consume_mfa_recovery_code(text)         from public, anon, authenticated;
grant  execute on function public.consume_mfa_recovery_code(text)         to authenticated;

-- ═══ 3. Comment ════════════════════════════════════════════════════════════
comment on function public.consume_mfa_recovery_code(text) is
  'Marks one unused recovery code of the signed-in account used and answers true, or answers false. '
  'Each call with a non-empty code is counted for the account first (10 in 15 minutes, '
  'public.increment_rate_limit); past that it raises P0001, hint rate_limited, and compares nothing.';

reset lock_timeout;
