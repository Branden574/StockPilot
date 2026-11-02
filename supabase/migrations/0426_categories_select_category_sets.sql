-- 0426_categories_select_category_sets.sql
--
-- categories_select reads the membership set stock_movements_select reads and
-- the two category sets inventory_items_select reads, and
-- public.user_can_see_item_category leaves the Data API (docket S49). Nothing
-- a person does in the web app or on the phone changes: every member reads
-- the same categories as before (the equivalence matrix in the 0426 test). No
-- row of any table changes.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- user_can_see_item_category(p_user_id, p_org_id, p_category_id) (0310,
-- SECURITY DEFINER) takes the person it answers about from its caller and
-- reads organization_members, user_profiles and user_category_assignments as
-- its owner. authenticated has held EXECUTE since 0129, and the body never
-- looks at the caller (the has_org_role in it is a comment, 0310:52). So any
-- signed-in account, in an organization or not, could call
-- POST /rest/v1/rpc/user_can_see_item_category with any three ids and learn,
-- past row security, whether that person is an accepted member of that
-- organization whose account is not disabled (true for staff and above and
-- for a viewer with no category limit), and which categories a limited
-- viewer holds. It wrote nothing, anon could not call it, and it never
-- widened what anyone reads: categories_select (0140), its one caller, ANDs
-- it with is_org_member and passes auth.uid(). Apart from that policy, no
-- web, phone, edge-function or database code calls it. The security suite's
-- INV-25 counted it as gated because of that comment (the suite now reads
-- code only).
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 0. Preflight: refuse (55000, hint s49_preflight, nothing applied) unless
--    categories_select is 0140's and is the table's only SELECT or ALL
--    policy, the three set helpers are 0310's bodies (definer, stable, owned
--    by postgres, executable by authenticated), and user_can_see_item_category
--    has 0129's grants and exactly one dependent, that policy.
-- 1. The lock prelude (LOCKS below).
-- 2. categories_select is dropped and created in this one transaction (never
--    ALTER: pattern 24, INV-F1). Its category rule is inventory_items_select's
--    (0229), with id in place of category_id; its membership rule is
--    stock_movements_select's form (0229), the same truth as is_org_member:
--    an accepted membership whose Act-as seat has not expired, of an account
--    that is not disabled (0310).
-- 3. user_can_see_item_category: EXECUTE goes from authenticated (and from
--    PUBLIC and anon, which hold none since 0129); service_role keeps it. The
--    body does not change. No policy calls it after step 2, so INV-C1 (a
--    function a policy names keeps authenticated EXECUTE) no longer applies to
--    it, the account_is_disabled precedent (0310).
-- 4. Comments on the policy and the function.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on public.categories
-- and, through supautils 3.4.0 (image 17.6.1.166), on every existing table
-- supautils.policy_grants lists for this role: 23 auth, storage and realtime
-- tables, auth.users and auth.sessions among them (0390, 0395, 0400, 0420).
-- The preflight reads catalogs and deparses the policy in a block that is
-- always undone, so it ends holding no table lock. REVOKE, GRANT and COMMENT
-- on the function take no table lock. So the prelude takes all of those
-- tables at once, NOWAIT, retrying up to 40 times with a 50 to 150 ms pause
-- that holds nothing (the 0390, 0395 and 0420 pattern), and no later
-- statement takes a new table lock: the file never waits while holding one,
-- so it cannot deadlock. From the prelude to the commit (milliseconds),
-- category reads, sign-ins, token refreshes, and storage and realtime
-- requests wait for the hold. lock_timeout 900ms bounds anything unforeseen
-- (a GRANT or REVOKE waits for another session's uncommitted DDL on the
-- same function). scripts/db-concurrency/0426_migration_lock_footprint.sh
-- measures all of this.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint s49_preflight: drift, or a second run; nothing applied.
-- 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied, run it
-- again. A direct call of user_can_see_item_category by a signed-in account
-- now gets 42501. Never 40001 or 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number. Of the objects this file pins, one is touched by
-- a queued migration: docket S47's (open when this was written) restates
-- user_can_see_item_category's body with CREATE OR REPLACE, which keeps the
-- function's grants and comment, and its preflight pins that body and the
-- function's posture, which this file leaves alone. This file pins the
-- function's grants and dependents, which S47's leaves alone, and not its
-- body, so the two may go in either order. No queued migration restates,
-- drops or pins categories_select or the three set helpers.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s49$
declare
  v_bad text := '';
  v_got text;
  v_pol text;
  r     record;
begin
  -- The three set helpers the new policy calls: 0310's bodies (md5 pinned
  -- by 0400 and 0413), definer, stable, owned by postgres, and executable by
  -- authenticated (INV-C1: the policy runs as the reader).
  for r in
    select v.sig, v.want, p.oid as poid, md5(p.prosrc) as got, p.prosecdef, p.provolatile::text as vol,
           pg_get_userbyid(p.proowner) as owner,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x
      from (values
        ('public.rls_member_org_ids()',            '68860888450deeef2bbf628712c5b971'),
        ('public.rls_cat_unrestricted_org_ids()',  '21ed57ccaa86b958fccbb08a621baf97'),
        ('public.rls_cat_allowed_category_ids()',  'c907f373f976df4586d340e9dbac6308')
      ) v(sig, want)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or not r.prosecdef or r.vol <> 's' or r.owner <> 'postgres' or not r.auth_x then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, owner %s, authenticated %s);',
                               r.sig, r.got, r.prosecdef, r.vol, r.owner, r.auth_x);
    end if;
  end loop;

  -- user_can_see_item_category: 0129's grants, and one dependent, the policy.
  select array_to_string(array(select x::text from unnest(p.proacl) x order by 1), ',')
    into v_got
    from pg_proc p
   where p.oid = to_regprocedure('public.user_can_see_item_category(uuid,uuid,uuid)');
  if v_got is distinct from 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then
    v_bad := v_bad || format(' user_can_see_item_category grants are not 0129''s (%s);', coalesce(v_got, 'missing'));
  end if;
  select string_agg(s.dep, ',' order by s.dep)
    into v_got
    from (select case when d.classid = 'pg_policy'::regclass
                      then (select n.nspname || '.' || c.relname || '.' || pol.polname
                              from pg_policy pol
                              join pg_class c on c.oid = pol.polrelid
                              join pg_namespace n on n.oid = c.relnamespace
                             where pol.oid = d.objid)
                      else d.classid::regclass::text || ':' || d.objid::text end as dep
            from pg_depend d
           where d.refclassid = 'pg_proc'::regclass
             and d.refobjid = to_regprocedure('public.user_can_see_item_category(uuid,uuid,uuid)')) s;
  if v_got is distinct from 'public.categories.categories_select' then
    v_bad := v_bad || format(' user_can_see_item_category dependents are not exactly categories_select (%s);',
                             coalesce(v_got, 'none'));
  end if;

  -- categories' SELECT and ALL policies are exactly 0140's categories_select.
  -- Deparsed in a block that is always undone, with search_path pinned inside
  -- it (0420's method), so the text does not depend on the session's
  -- search_path and nothing the deparse locks outlives the block. Variables
  -- keep their values when the block is undone.
  begin
    perform set_config('search_path', 'public, extensions', true);
    select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                      || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                            from unnest(pol.polroles) x)
                      || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                      || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
      into v_pol
      from pg_policy pol
     where pol.polrelid = 'public.categories'::regclass and pol.polcmd in ('r', '*');
    raise exception using errcode = 'XX549', message = 'undo';
  exception when sqlstate 'XX549' then
    null;
  end;
  if v_pol is distinct from
     'categories_select|r|true|authenticated|(( SELECT is_org_member(categories.organization_id) AS is_org_member) AND user_can_see_item_category(auth.uid(), organization_id, id))|-' then
    v_bad := v_bad || format(' categories SELECT policies are not 0140''s (%s);', coalesce(v_pol, 'none'));
  end if;

  if v_bad <> '' then
    raise exception 's49_preflight:%', v_bad using errcode = '55000', hint = 's49_preflight';
  end if;
end
$pre_s49$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * public.categories: ACCESS EXCLUSIVE (its policy statements);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a policy statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_s49$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.categories in access exclusive mode nowait;
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
end $lock_s49$;

-- ═══ 2. categories_select ═══════════════════════════════════════════════════
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using (
    organization_id in (select public.rls_member_org_ids())
    and (
      organization_id in (select public.rls_cat_unrestricted_org_ids())
      or (organization_id, id) in (select * from public.rls_cat_allowed_category_ids())
    )
  );

-- ═══ 3. user_can_see_item_category leaves the Data API ══════════════════════
revoke all on function public.user_can_see_item_category(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_can_see_item_category(uuid, uuid, uuid) to service_role;

-- ═══ 4. Comments ════════════════════════════════════════════════════════════
-- Neither text names this file's number, so a rename leaves them (and the
-- md5s the 0426 test pins) alone.
comment on policy categories_select on public.categories is
  'Members read their organization''s categories, and a viewer limited to some categories reads only those (S49). '
  'Membership is rls_member_org_ids, as in stock_movements_select. The category rule is rls_cat_unrestricted_org_ids '
  'or the (organization_id, id) pair in rls_cat_allowed_category_ids, the two sets inventory_items_select reads (0229), '
  'with id in place of category_id. The three sets take no user id: they read auth.uid() themselves, refuse disabled '
  'accounts and expired Act-as seats (0310), and are evaluated once per query. Replaces 0140''s per-row '
  'user_can_see_item_category(auth.uid(), organization_id, id).';

comment on function public.user_can_see_item_category(uuid, uuid, uuid) is
  'The category visibility rule as one predicate about the user it is given (0129; disabled-aware since 0310). '
  'No policy calls it since S49: categories_select reads rls_member_org_ids, as stock_movements_select does, and '
  'rls_cat_unrestricted_org_ids and rls_cat_allowed_category_ids, as inventory_items_select does (0229). None of '
  'the three takes a user id. EXECUTE is service_role''s only, because it answers for any user id it is given.';

reset lock_timeout;
