-- 0420_permission_override_updates_follow_0322.sql
--
-- The database now asks for the same permission the app asks before a
-- restriction changes (docket S62). The UPDATE rules of
-- user_permission_overrides and role_permission_overrides ask, of the row
-- being changed, what the tables' DELETE rules have asked since 0322: an
-- admin, and either the row is a grant or the writer holds the permission it
-- is about. Their WITH CHECK half stays 0215's word for word. No row of any
-- table changes.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- The Roles page (actions/permissions.ts) lets an owner or admin change or
-- clear a restriction only on a permission they hold themselves
-- (assertCanGrant). The database asked that of a new or changed row since
-- 0215 (WITH CHECK) and of a deleted row since 0322 (MED-14). It now asks it
-- of the row an UPDATE starts from too:
--   USING      has_org_role(org, 'admin')
--              AND (granted = true OR has_permission(org, permission))
--              -- 0322's DELETE rule, read from the update side
--   WITH CHECK 0215's, unchanged.
-- So a grant row still changes freely (a grant can become a restriction
-- without the permission, as before), and a restriction row changes only for
-- a writer who holds its permission. Owners hold every permission
-- (has_permission, 0310), so an owner still changes any row. Nothing a person
-- does in the web app or on the phone changes: the one write the Roles page
-- makes that now meets the rule, saving "restricted" over a row that already
-- says restricted for a permission the admin lacks, is absorbed by the action
-- (it re-reads the row and answers as before).
--
--   0. Preflight: refuse (55000, hint s62_preflight, nothing applied) unless
--      has_permission and has_org_role are 0310's bodies (md5 pinned by 0400
--      and 0413), definer, owned by postgres and executable by authenticated
--      (INV-C1: the rules run as the writer), and each table's UPDATE and ALL
--      rules are exactly 0215's <table>_update.
--   1. The lock prelude (LOCKS below).
--   2. The two rules are dropped and created in this one transaction (never
--      ALTER: pattern 24, INV-F1). Every column of the rule's own table is
--      qualified (pattern 25).
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on the table and,
-- through supautils 3.4.0 (image 17.6.1.166), on every existing table
-- supautils.policy_grants lists for this role: 23 auth, storage and realtime
-- tables, auth.users and auth.sessions among them (0390, 0395, 0400, 0415).
-- The preflight reads catalogs and deparses the rules in a block that is
-- always undone, so it ends holding no table lock. So the prelude takes all
-- of those tables at once, NOWAIT, retrying up to 40 times with a 50 to 150
-- ms pause that holds nothing (the 0390, 0395, 0400 and 0415 pattern), and
-- no later statement takes a new table lock: the file never waits while
-- holding one, so it cannot deadlock. From the prelude to the commit (ms),
-- permission reads (has_permission reads both tables in many rules),
-- sign-ins, token refreshes, and storage and realtime requests wait for the
-- hold. lock_timeout 900ms bounds anything unforeseen.
-- scripts/db-concurrency/0420_migration_lock_footprint.sh measures all of
-- this.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint s62_preflight: drift, or a second run; nothing applied.
-- 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied, run it
-- again. Never 40001 or 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number. No queued migration restates, drops or pins the
-- two UPDATE rules. Queued migrations that pin has_permission's or
-- has_org_role's body leave it alone, as this file does. A queued one that
-- revokes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on the two tables
-- touches no rule, so the two may go in either order.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s62$
declare
  v_bad text := '';
  v_pol text;
  r     record;
begin
  -- The two helpers the rules call: 0310's bodies, definer, owned by
  -- postgres, and executable by authenticated.
  for r in
    select v.sig, v.want, p.oid as poid, md5(p.prosrc) as got, p.prosecdef,
           pg_get_userbyid(p.proowner) as owner,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x
      from (values
        ('public.has_permission(uuid,text)', 'cc0accdad7e2fdf4f88aa82aa887e85f'),
        ('public.has_org_role(uuid,text)',   '10422b29a6e15acd003d4f11ed28e90c')
      ) v(sig, want)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or not r.prosecdef or r.owner <> 'postgres' or not r.auth_x then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s, authenticated %s);',
                               r.sig, r.got, r.prosecdef, r.owner, r.auth_x);
    end if;
  end loop;

  -- Each table's UPDATE and ALL rules are exactly 0215's <table>_update.
  -- Deparsed in a block that is always undone, with search_path pinned inside
  -- it, so the text does not depend on the session's search_path and nothing
  -- the deparse locks outlives the block. Variables keep their values when
  -- the block is undone.
  for r in
    select v.tbl, v.want
      from (values
        ('public.user_permission_overrides',
         'user_permission_overrides_update|w|true|authenticated'
         '|( SELECT has_org_role(user_permission_overrides.organization_id, ''admin''::text) AS has_org_role)'
         '|(( SELECT has_org_role(user_permission_overrides.organization_id, ''admin''::text) AS has_org_role)'
         ' AND ((granted = false) OR ( SELECT has_permission(user_permission_overrides.organization_id,'
         ' user_permission_overrides.permission) AS has_permission)))'),
        ('public.role_permission_overrides',
         'role_permission_overrides_update|w|true|authenticated'
         '|( SELECT has_org_role(role_permission_overrides.organization_id, ''admin''::text) AS has_org_role)'
         '|(( SELECT has_org_role(role_permission_overrides.organization_id, ''admin''::text) AS has_org_role)'
         ' AND ((granted = false) OR ( SELECT has_permission(role_permission_overrides.organization_id,'
         ' role_permission_overrides.permission) AS has_permission)))')
      ) v(tbl, want)
  loop
    v_pol := null;
    begin
      perform set_config('search_path', 'public, extensions', true);
      select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                        || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                              from unnest(pol.polroles) x)
                        || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                        || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
        into v_pol
        from pg_policy pol
       where pol.polrelid = to_regclass(r.tbl) and pol.polcmd in ('w', '*');
      raise exception using errcode = 'XX562', message = 'undo';
    exception when sqlstate 'XX562' then
      null;
    end;
    if v_pol is distinct from r.want then
      v_bad := v_bad || format(' %s UPDATE rules are not 0215''s (%s);', r.tbl, coalesce(v_pol, 'none'));
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 's62_preflight:%', v_bad using errcode = '55000', hint = 's62_preflight';
  end if;
end
$pre_s62$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * the two override tables: ACCESS EXCLUSIVE (their rule statements);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a rule statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_s62$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.user_permission_overrides, public.role_permission_overrides
        in access exclusive mode nowait;
      if v_grants is not null then
        for v_name in
          select jsonb_array_elements_text(coalesce(v_grants::jsonb -> current_user::text, '[]'::jsonb))
        loop
          v_rel := to_regclass(v_name);
          if v_rel is not null then
            execute format('lock table only %s in access exclusive mode nowait', v_rel);
          end if;
        end loop;
      end if;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_s62$;

-- ═══ 2. The two UPDATE rules ════════════════════════════════════════════════
drop policy if exists user_permission_overrides_update on public.user_permission_overrides;
create policy user_permission_overrides_update on public.user_permission_overrides
  for update to authenticated
  using (
    -- CONJUNCT 1 of 2: the admin floor, as 0207 and 0215.
    ( select public.has_org_role(user_permission_overrides.organization_id, 'admin') )

    -- CONJUNCT 2 of 2: the row being changed is a grant, or the writer holds
    -- its permission (0322's DELETE rule).
    and (
      user_permission_overrides.granted = true
      or ( select public.has_permission(
             user_permission_overrides.organization_id,
             user_permission_overrides.permission) )
    )
  )
  with check (
    ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') )
    and (
      user_permission_overrides.granted = false
      or ( SELECT public.has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) )
    )
  );

drop policy if exists role_permission_overrides_update on public.role_permission_overrides;
create policy role_permission_overrides_update on public.role_permission_overrides
  for update to authenticated
  using (
    -- CONJUNCT 1 of 2: the admin floor, as 0207 and 0215.
    ( select public.has_org_role(role_permission_overrides.organization_id, 'admin') )

    -- CONJUNCT 2 of 2: the row being changed is a grant, or the writer holds
    -- its permission (0322's DELETE rule).
    and (
      role_permission_overrides.granted = true
      or ( select public.has_permission(
             role_permission_overrides.organization_id,
             role_permission_overrides.permission) )
    )
  )
  with check (
    ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') )
    and (
      role_permission_overrides.granted = false
      or ( SELECT public.has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) )
    )
  );

reset lock_timeout;
