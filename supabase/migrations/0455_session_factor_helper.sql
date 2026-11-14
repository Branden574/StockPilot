-- 0455_session_factor_helper.sql
--
-- Adds a schema, gate, and two functions in it: a helper that answers
-- whether the session on the request has met the account's sign-in factors,
-- and a check that answers whether the helper's owner can read factor rows.
-- Nothing calls either function: no policy, role setting, web or phone code
-- changes, and no row of any table changes.
--
-- NUMBER. 0455 is provisional; the integrator sets the final number. Nothing
-- in the database carries it (the comments on the schema and the functions do
-- not name it), the preflight is the block tagged $gate_pre$, and the pgTAP
-- file finds the statements the CLI recorded by the migration's name
-- (session_factor_helper). Only file names and cross-references in comments
-- carry the number.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────────
--   0. A catalog preflight stops with 55000 (hint gate_helper_preflight),
--      naming what differs, before anything changes, unless: schema gate does
--      not exist; auth.mfa_factors exists with user_id (uuid) and status, and
--      status has the label verified; a valid index on it leads with user_id;
--      the migration role, which will own both functions, may select the
--      table and, when the table has row security on, has BYPASSRLS or
--      SUPERUSER (without one of those the helper would see no factor row
--      and answer true for every account, with no error); auth.uid() (uuid)
--      and auth.jwt() (jsonb) exist. A second run stops: the schema exists.
--   1. Schema gate. The Data API serves only the schemas in its settings
--      (public and graphql_public), so neither function is an RPC. USAGE for
--      anon, authenticated and service_role; nothing for PUBLIC.
--   2. gate.session_meets_mfa() returns boolean: true when the request
--      carries no account (auth.uid() is null), when the token's aal claim is
--      exactly aal2, or when the account has no factor with status verified
--      (totp, webauthn and phone all count; an unverified factor does not);
--      false otherwise. A token with no aal claim counts as aal1. PL/pgSQL,
--      SECURITY DEFINER (authenticated cannot read auth.mfa_factors), STABLE,
--      search_path empty, no argument. Every table, type and function name in
--      both bodies and in the preflight is schema-qualified; operators and
--      COALESCE resolve in pg_catalog, and PostgreSQL never looks in the
--      temporary schema for a function or an operator. If the
--      factor read fails with one of four catalog errors (undefined_table
--      42P01, invalid_schema_name 3F000, undefined_column 42703,
--      insufficient_privilege 42501) it answers true, records the SQLSTATE in
--      the transaction setting sp_gate.catalog_error (the first one only) and
--      writes one LOG line per transaction. Any other error is raised.
--      EXECUTE for authenticated only.
--   3. gate.factor_read_state() returns text, one of four words and nothing
--      about any account. It runs the helper's read (user_id and status) for
--      an id no account has: ok (the owner reads factor rows), blind (the table
--      has row security on and the owner has neither BYPASSRLS nor SUPERUSER,
--      so the helper would see no row), catalog (one of the four catalog
--      errors above), error (anything else). PL/pgSQL, SECURITY DEFINER,
--      STABLE, search_path empty. EXECUTE for anon only.
--   4. Comments on the schema and both functions.
--   5. reset lock_timeout, so the bound does not carry to a later file.
--
-- WHO CHANGES: no one using StockPilot. Nothing calls the two functions.
--
-- DATA SAFETY: no row changes. The file writes catalog rows only.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- No table lock, at any point. The preflight reads catalogs only
-- (to_regclass, has_table_privilege and the pg_class, pg_attribute, pg_enum,
-- pg_index and pg_roles reads take no lock on auth.mfa_factors). CREATE
-- FUNCTION checks a PL/pgSQL body by parsing it, without opening a table
-- (neither body declares %TYPE or %ROWTYPE). CREATE SCHEMA, REVOKE, GRANT and
-- COMMENT write catalog rows of the new objects and lock only those objects,
-- which no other session can see before commit. Recording the owner and the
-- grants holds an AccessShareLock on four roles until commit: postgres and
-- the grantees anon, authenticated and service_role (PostgreSQL locks a role
-- while it records a dependency on it); only a DROP ROLE of one of them would
-- wait for it. lock_timeout 900ms bounds anything unforeseen: another open
-- transaction that has created a schema named gate makes the file wait in its
-- CREATE SCHEMA, then end with 55P03 and nothing applied.
-- scripts/db-concurrency/0455_migration_lock_footprint.sh checks each of
-- these.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- The push raises 55000 (drift or a second run: nothing applied) or 55P03
-- (busy: nothing applied). Never 40001 or 40P01 (PostgREST retries those
-- forever, 0367). What the helper does when the factor table cannot be read
-- is proven with a local superuser by
-- scripts/db-concurrency/0455_gate_catalog_errors.sh.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
do $gate_pre$
declare
  v_bad    pg_catalog.text := '';
  v_tbl    pg_catalog.regclass := pg_catalog.to_regclass('auth.mfa_factors');
  v_status pg_catalog.oid;
  v_rls    pg_catalog.bool;
  v_exempt pg_catalog.bool;
begin
  if pg_catalog.to_regnamespace('gate') is not null then
    v_bad := v_bad || ' schema gate already exists;';
  end if;

  if v_tbl is null then
    v_bad := v_bad || ' auth.mfa_factors missing;';
  else
    if not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = v_tbl and a.attname = 'user_id' and not a.attisdropped
                      and a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype) then
      v_bad := v_bad || ' auth.mfa_factors.user_id (uuid) missing;';
    end if;
    select a.atttypid into v_status
      from pg_catalog.pg_attribute a
     where a.attrelid = v_tbl and a.attname = 'status' and not a.attisdropped;
    if v_status is null then
      v_bad := v_bad || ' auth.mfa_factors.status missing;';
    elsif not exists (select 1 from pg_catalog.pg_enum e where e.enumtypid = v_status and e.enumlabel = 'verified') then
      v_bad := v_bad || ' auth.mfa_factors.status has no label verified;';
    end if;
    if not exists (select 1 from pg_catalog.pg_index i
                     join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = v_tbl and i.indisvalid and a.attname = 'user_id') then
      v_bad := v_bad || ' no valid index on auth.mfa_factors leads with user_id;';
    end if;
    if not pg_catalog.has_table_privilege(current_user, v_tbl, 'SELECT') then
      v_bad := v_bad || pg_catalog.format(' the migration role (%s) may not select auth.mfa_factors;', current_user);
    end if;
    select c.relrowsecurity into v_rls from pg_catalog.pg_class c where c.oid = v_tbl;
    select r.rolbypassrls or r.rolsuper into v_exempt from pg_catalog.pg_roles r where r.rolname = current_user;
    if v_rls and not coalesce(v_exempt, false) then
      v_bad := v_bad || pg_catalog.format(' auth.mfa_factors has row security on and the migration role (%s) has neither BYPASSRLS nor SUPERUSER;',
                               current_user);
    end if;
  end if;

  if pg_catalog.to_regprocedure('auth.uid()') is null
     or pg_catalog.pg_get_function_result(pg_catalog.to_regprocedure('auth.uid()')) <> 'uuid' then
    v_bad := v_bad || ' auth.uid() returning uuid missing;';
  end if;
  if pg_catalog.to_regprocedure('auth.jwt()') is null
     or pg_catalog.pg_get_function_result(pg_catalog.to_regprocedure('auth.jwt()')) <> 'jsonb' then
    v_bad := v_bad || ' auth.jwt() returning jsonb missing;';
  end if;

  if v_bad <> '' then
    raise exception 'gate_helper_preflight:%', v_bad
      using errcode = '55000', hint = 'gate_helper_preflight';
  end if;
end
$gate_pre$;

-- ═══ 1. The schema ═════════════════════════════════════════════════════════
create schema gate;
revoke all on schema gate from public, anon, authenticated, service_role;
grant usage on schema gate to anon, authenticated, service_role;

-- ═══ 2. The helper ═════════════════════════════════════════════════════════
create function gate.session_meets_mfa()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid pg_catalog.uuid := auth.uid();
begin
  if v_uid is null then return true; end if;                                    -- no account on the request
  if coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then return true; end if;  -- the session is at aal2
  begin
    return not exists (select 1 from auth.mfa_factors f
                        where f.user_id = v_uid and f.status = 'verified');
  exception
    when undefined_table or undefined_column or insufficient_privilege or invalid_schema_name then
      -- The factor table cannot be read: answer true, keep the first SQLSTATE
      -- of the transaction and write one LOG line per transaction.
      if coalesce(pg_catalog.current_setting('sp_gate.catalog_error', true), '') = '' then
        perform pg_catalog.set_config('sp_gate.catalog_error', sqlstate, true);
        raise log 'aal2_gate catalog_error sqlstate=% (the factor table cannot be read; the helper answers true)', sqlstate;
      end if;
      return true;
  end;
end
$$;

revoke all on function gate.session_meets_mfa() from public, anon, authenticated, service_role;
grant execute on function gate.session_meets_mfa() to authenticated;

-- ═══ 3. The premise check ══════════════════════════════════════════════════
create function gate.factor_read_state()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- The same predicate as the helper, for an id no account has: both columns
  -- are read, through the index that leads with user_id.
  perform 1 from auth.mfa_factors f
   where f.user_id = '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid and f.status = 'verified'
   limit 1;
  if (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'auth.mfa_factors'::pg_catalog.regclass)
     and not (select r.rolbypassrls or r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    return 'blind';      -- the owner would see no factor row
  end if;
  return 'ok';
exception
  when undefined_table or undefined_column or insufficient_privilege or invalid_schema_name then return 'catalog';
  when others then return 'error';
end
$$;

revoke all on function gate.factor_read_state() from public, anon, authenticated, service_role;
grant execute on function gate.factor_read_state() to anon;

-- ═══ 4. Comments ═══════════════════════════════════════════════════════════
comment on schema gate is
  'Functions about the session''s sign-in level. Not served by the Data API. '
  'USAGE for anon, authenticated and service_role.';
comment on function gate.session_meets_mfa() is
  'True when the request carries no account, when the token''s aal claim is aal2, or when the account '
  'has no verified factor; false otherwise. A catalog error reading auth.mfa_factors answers true, '
  'sets sp_gate.catalog_error and logs once per transaction; any other error is raised. '
  'SECURITY DEFINER; EXECUTE for authenticated only.';
comment on function gate.factor_read_state() is
  'ok, blind, catalog or error: whether this function''s owner (the owner of gate.session_meets_mfa) can read '
  'factor rows. Nothing about any account. EXECUTE for anon only.';

-- The 900 ms bound applies to this file only.
reset lock_timeout;
