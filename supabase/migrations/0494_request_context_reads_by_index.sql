-- 0494_request_context_reads_by_index.sql
--
-- get_request_context() reads the caller's own profile row and membership
-- rows through their indexes, and keeps its query plan for the life of a
-- database connection. Same answer, same row level security, same grants.
-- DB-only. No row is written, and no table, index or policy changes.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
-- Every signed-in page render and every /api call asks this function first
-- (0355). Measured on a local stack with 4,017 membership rows across 400
-- organizations, one call cost about 71 ms whether the caller belonged to
-- 1, 3 or 10 organizations. The time was two whole-table scans:
--
--   * `where p.id = auth.uid()` on user_profiles and `where m.user_id =
--     auth.uid()` on organization_members were not used as index conditions.
--     auth.uid() is inlined to coalesce(nullif(current_setting(..)), (..
--     ::jsonb ->> 'sub'))::uuid, which calls functions that are not
--     leakproof, so the planner must keep that condition BEHIND the tables'
--     row level security. So every row of both tables was first checked by
--     its policy (is_org_member(), a SECURITY DEFINER call, once per row;
--     on user_profiles the orgmates policy's own join, once per row) and
--     only then compared with the caller. About 8,000 policy calls and
--     29,000 buffer reads per request, growing with the number of members
--     in ALL organizations, not with the caller's own.
--   * Written `(select auth.uid())`, the caller's id is computed once per
--     call (an init plan) and is a plain parameter, which the planner may
--     use as an index condition ahead of the policy: user_profiles_pkey and
--     organization_members_user_idx. The policy then runs on the caller's
--     own rows only, exactly as before.
--
-- The rest of the body (the organization row, the override lists, the
-- enabled modules) already read by index and is unchanged.
--
-- PL/pgSQL instead of SQL: a SQL function that cannot be inlined is parsed
-- and planned again on every call; a PL/pgSQL function keeps the plan of its
-- statement for the connection, and PostgREST keeps its connections. The
-- plan has no parameters and no constant taken from the caller: the
-- caller's id is read when the plan runs, and Postgres plans a statement
-- under row level security for the role that runs it and plans it again
-- when the role, row_security or a policy of these tables changes. The
-- statement is the same text as the SQL body (the two predicates above
-- aside).
--
-- ── WHAT DOES NOT CHANGE ──────────────────────────────────────────────────
--   * The answer, key for key and in the same order: user_id, the profile
--     (six keys), every ACCEPTED membership oldest first (created_at, then
--     organization id), each with its organization (eleven keys), the role
--     and user overrides (ordered by permission) and the enabled module ids
--     (ordered). Both predicates mean what they meant: auth.uid() is STABLE,
--     one value for the whole call.
--   * SECURITY INVOKER: every table is read under the caller's row level
--     security, and the policies run on every row the function returns. A
--     disabled account, an expired Act-as seat, an invitation not accepted:
--     excluded as before. STABLE (PostgREST serves it from a read-only
--     transaction), search_path pinned to public, pg_temp.
--   * No caching between requests: the answer is read afresh on every call,
--     so a role change, a removal, an override or a sign-in policy change
--     bites on the next request. Only the PLAN is kept, never a row.
--   * Grants: EXECUTE for authenticated and service_role, none for public
--     or anon (restated below).
--
-- ── STEPS ─────────────────────────────────────────────────────────────────
-- 0. Preflight: refuse (55000, hint request_context_preflight, nothing
--    applied) unless the live function is 0413's body (md5(prosrc), SQL,
--    SECURITY INVOKER, STABLE, search_path public, pg_temp, owned by
--    postgres).
-- 1. CREATE OR REPLACE with the new body (same name, no arguments, returns
--    jsonb).
-- 2. Comment, then the grants restated.
-- 3. Post-condition: PL/pgSQL, INVOKER, STABLE, the pinned search_path, owner
--    postgres, EXECUTE for authenticated and service_role only.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION locks only the function's own catalog row; no
-- table lock is taken (the PL/pgSQL validator checks syntax and opens no
-- table). Calls already running finish on the old body; calls that start
-- after the commit use the new one. lock_timeout 900ms bounds any wait.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint request_context_preflight: drift, or a second run; nothing
-- applied. The function itself raises nothing new. Never 40001 or 40P01
-- (PostgREST retries those, 0367).
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restate 0413's body (section 16 of 0413_order_catalog_visibility.sql). The
-- answer is the same either way, so the application needs no change.
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After 0413 (the body it replaces) and every lower number.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_request_context$
declare
  v_bad text := '';
  r record;
begin
  select md5(p.prosrc) as got, p.prosecdef, p.provolatile::text as vol,
         pg_get_userbyid(p.proowner) as owner, l.lanname::text as lang,
         coalesce(array_to_string(p.proconfig, ','), '-') as cfg
    into r
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.get_request_context()');
  if not found then
    v_bad := ' public.get_request_context() missing;';
  -- md5(prosrc) of 0413's body, written in two halves.
  elsif r.got <> ('8187cbf44b70aa45' || '99175da691ae1649') or r.prosecdef or r.vol <> 's'
        or r.owner <> 'postgres' or r.lang <> 'sql' or r.cfg <> 'search_path=public, pg_temp' then
    v_bad := format(' public.get_request_context() drifted (md5 %s, definer %s, volatility %s, owner %s, language %s, config %s);',
                    r.got, r.prosecdef, r.vol, r.owner, r.lang, r.cfg);
  end if;

  if v_bad <> '' then
    raise exception 'request_context_preflight:%', v_bad using errcode = '55000', hint = 'request_context_preflight';
  end if;
end
$pre_request_context$;

-- ═══ 1. The body ════════════════════════════════════════════════════════════
create or replace function public.get_request_context()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
begin
  -- The caller's id is read once, as (select auth.uid()), where it picks
  -- the rows: see 0494.
  return (
    select jsonb_build_object(
      'user_id', auth.uid(),
      'profile', (
        select jsonb_build_object(
                 'id', p.id,
                 'email', p.email,
                 'full_name', p.full_name,
                 'avatar_url', p.avatar_url,
                 'default_organization_id', p.default_organization_id,
                 'disabled_at', p.disabled_at)
          from public.user_profiles p
         where p.id = (select auth.uid())
      ),
      'memberships', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'organization_id', m.organization_id,
                   'role', m.role,
                   'organization', (
                     select jsonb_build_object(
                              'id', o.id,
                              'name', o.name,
                              'logo_url', o.logo_url,
                              'terminology', o.terminology,
                              'mfa_policy', o.mfa_policy,
                              'timezone', o.timezone,
                              'nav_overrides', o.nav_overrides,
                              'dashboard_layout', o.dashboard_layout,
                              'order_status_config', o.order_status_config,
                              'all_modules_comp', o.all_modules_comp,
                              'order_catalog_last_hide_at', o.order_catalog_last_hide_at)
                       from public.organizations o
                      where o.id = m.organization_id),
                   'role_overrides', coalesce((
                     select jsonb_agg(jsonb_build_object('permission', r.permission, 'granted', r.granted)
                                      order by r.permission)
                       from public.role_permission_overrides r
                      where r.organization_id = m.organization_id
                        and r.role = m.role), '[]'::jsonb),
                   'user_overrides', coalesce((
                     select jsonb_agg(jsonb_build_object('permission', u.permission, 'granted', u.granted)
                                      order by u.permission)
                       from public.user_permission_overrides u
                      where u.organization_id = m.organization_id
                        and u.user_id = m.user_id), '[]'::jsonb),
                   'enabled_modules', coalesce((
                     select jsonb_agg(om.module_id order by om.module_id)
                       from public.organization_modules om
                      where om.organization_id = m.organization_id
                        and om.enabled), '[]'::jsonb)
                 )
                 order by m.created_at, m.organization_id)
          from public.organization_members m
         where m.user_id = (select auth.uid())
           and m.accepted_at is not null
      ), '[]'::jsonb)
    )
  );
end;
$function$;

-- ═══ 2. Comment and grants ══════════════════════════════════════════════════
comment on function public.get_request_context() is
  'Caller-only request context (profile, accepted memberships, org settings, permission overrides, enabled modules) in one round trip. SECURITY INVOKER: reads under the caller''s RLS. Applies no policy; the application resolves org, permissions, account status and MFA from it. See 0355; 0413 added the hide mark; 0494 reads the caller''s rows by index and keeps the plan per connection.';

revoke all on function public.get_request_context() from public;
revoke all on function public.get_request_context() from anon;
grant execute on function public.get_request_context() to authenticated;
grant execute on function public.get_request_context() to service_role;

-- ═══ 3. Post-condition ══════════════════════════════════════════════════════
do $post_request_context$
declare
  r record;
begin
  select p.prosecdef, p.provolatile::text as vol, pg_get_userbyid(p.proowner) as owner,
         l.lanname::text as lang, coalesce(array_to_string(p.proconfig, ','), '-') as cfg,
         has_function_privilege('public', p.oid, 'execute') as public_x,
         has_function_privilege('anon', p.oid, 'execute') as anon_x,
         has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
         has_function_privilege('service_role', p.oid, 'execute') as svc_x
    into r
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = 'public.get_request_context()'::regprocedure;
  if r.prosecdef or r.vol <> 's' or r.owner <> 'postgres' or r.lang <> 'plpgsql'
     or r.cfg <> 'search_path=public, pg_temp' or r.public_x or r.anon_x or not r.auth_x or not r.svc_x then
    raise exception 'request_context_postcondition: definer %, volatility %, owner %, language %, config %, public %, anon %, authenticated %, service_role %',
                    r.prosecdef, r.vol, r.owner, r.lang, r.cfg, r.public_x, r.anon_x, r.auth_x, r.svc_x
      using errcode = '55000', hint = 'request_context_postcondition';
  end if;
end
$post_request_context$;
