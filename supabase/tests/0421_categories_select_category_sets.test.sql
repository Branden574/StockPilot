-- supabase/tests/0421_categories_select_category_sets.test.sql
-- pgTAP proof for migration 0421 (docket S49): categories_select reads the
-- membership set stock_movements_select reads and the two category sets
-- inventory_items_select reads, and user_can_see_item_category leaves the
-- Data API. Every member reads the same categories as before.
--
-- S.  Structure and who may call the function:
--     S1  its posture is unchanged (definer, stable, search_path, owner,
--         language, return type); the body is not pinned, so another
--         migration may restate it;
--     S2  only postgres and service_role may execute it;
--     S3  categories_select reads rls_member_org_ids and the two category sets
--         and not the function; S3b pins the policy's text;
--     S4  no policy in any schema names the function, and nothing depends on
--         it;
--     S5  a signed-in account's direct call is refused (42501), a member's
--         included; S6 anon's too;
--     S7  service_role still gets its answers;
--     S8  categories has exactly one SELECT (or ALL) policy;
--     S9  authenticated keeps EXECUTE on the three sets, each a stable
--         definer function (a revoke there would hide every category: the
--         policy runs as the reader, INV-C1);
--     S10 the plan of a category read as a signed-in member runs the three
--         sets and never the function;
--     S11 the policy and the function carry the reviewed comments; S12 what
--         those comments say of the catalog holds (the membership set is
--         stock_movements_select's, the two category sets are
--         inventory_items_select's, and the three take no argument and call
--         auth.uid() in their code).
-- E.  The row sets: 13 personas x 4 categories in 2 organizations. For each,
--     the rows categories_select returns (a real authenticated read) equal a
--     hand-written list AND the rows the pre-0421 rule passes
--     (is_org_member AND user_can_see_item_category, evaluated as the
--     superuser with the persona's claims: 0229's method). E14 repeats the
--     restricted viewer with only the request.jwt.claims JSON PostgREST sets.
-- A.  The migration's own preflight and lock prelude, replayed from the
--     statements the CLI recorded (0415's method): the preflight refuses a
--     second run, passes on the pre-0421 state under the session's
--     search_path and under an empty one (its deparse pins the path), and
--     names each planted drift; the prelude takes ACCESS EXCLUSIVE on
--     categories and on every table supautils.policy_grants lists for this
--     role, and on nothing else.
--
-- Roles: fixtures as the test superuser. Every read or call as an API role
-- runs inside a subtransaction that is always undone (the role and claims
-- are set with set_config there, 0415's helpers), so pgTAP's own statements
-- never run as an API role. begin/rollback: nothing leaks. Namespace
-- 549c0000.

begin;

select plan(32);

\set orgA  '\'549c0000-0000-0000-0000-00000000000a\''
\set orgB  '\'549c0000-0000-0000-0000-00000000000b\''
\set catA1 '\'549c0000-0000-0000-0000-0000000000a1\''
\set catA2 '\'549c0000-0000-0000-0000-0000000000a2\''
\set catB1 '\'549c0000-0000-0000-0000-0000000000b1\''
\set catB2 '\'549c0000-0000-0000-0000-0000000000b2\''

-- Personas, by the last two digits of their ids:
--   01 owner of A          02 manager of A        03 staff of A
--   04 viewer of A limited to A1                   05 viewer of A, no limit
--   06 staff of A with a stale assignment row (A1: staff are never limited)
--   07 viewer of A with no limit AND viewer of B limited to B1
--   08 invited to A, not accepted                  09 expired Act-as seat in A
--   10 live Act-as seat in A                       11 disabled staff of A
--   12 outsider (no membership)                    13 manager of B
\set p01 '\'549c0000-0000-0000-0000-000000000101\''
\set p02 '\'549c0000-0000-0000-0000-000000000102\''
\set p03 '\'549c0000-0000-0000-0000-000000000103\''
\set p04 '\'549c0000-0000-0000-0000-000000000104\''
\set p05 '\'549c0000-0000-0000-0000-000000000105\''
\set p06 '\'549c0000-0000-0000-0000-000000000106\''
\set p07 '\'549c0000-0000-0000-0000-000000000107\''
\set p08 '\'549c0000-0000-0000-0000-000000000108\''
\set p09 '\'549c0000-0000-0000-0000-000000000109\''
\set p10 '\'549c0000-0000-0000-0000-000000000110\''
\set p11 '\'549c0000-0000-0000-0000-000000000111\''
\set p12 '\'549c0000-0000-0000-0000-000000000112\''
\set p13 '\'549c0000-0000-0000-0000-000000000113\''

insert into auth.users (id, email, raw_user_meta_data)
  select ('549c0000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid,
         'person' || g || '@s49.test', '{}'::jsonb
    from generate_series(1, 13) g;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S49 Org A', 's49-org-a'),
  (:orgB, 'S49 Org B', 's49-org-b');
insert into public.categories (id, organization_id, name) values
  (:catA1, :orgA, 'S49 A1'), (:catA2, :orgA, 'S49 A2'),
  (:catB1, :orgB, 'S49 B1'), (:catB2, :orgB, 'S49 B2');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :p01, 'owner',   now(), null),
  (:orgA, :p02, 'manager', now(), null),
  (:orgA, :p03, 'staff',   now(), null),
  (:orgA, :p04, 'viewer',  now(), null),
  (:orgA, :p05, 'viewer',  now(), null),
  (:orgA, :p06, 'staff',   now(), null),
  (:orgA, :p07, 'viewer',  now(), null),
  (:orgB, :p07, 'viewer',  now(), null),
  (:orgA, :p08, 'staff',   null,  null),
  (:orgA, :p09, 'owner',   now(), now() - interval '1 minute'),
  (:orgA, :p10, 'owner',   now(), now() + interval '40 minutes'),
  (:orgA, :p11, 'staff',   now(), null),
  (:orgB, :p13, 'manager', now(), null);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :p04, :catA1),
  (:orgA, :p06, :catA1),
  (:orgB, :p07, :catB1);
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :p11;
reset role;

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- Every read and call below goes through EXECUTE, so it is planned and
-- permission-checked on each call. PL/pgSQL keeps a simple expression's
-- prepared state for the rest of the transaction, and EXECUTE privilege on a
-- function is checked only when that state is prepared: written as
-- `v := public.user_can_see_item_category(...)`, a call as anon after one as
-- authenticated was answered from the authenticated preparation, with no
-- check at all (seen on this test's first red run).
--
-- The S49 categories p_sub reads through categories_select (a real read as
-- authenticated, with only request.jwt.claim.sub set, or with only the
-- request.jwt.claims JSON when p_json), ALWAYS undone: names, sorted, '-' for
-- none, or 'error <SQLSTATE>'.
create function pg_temp.live(p_sub uuid, p_json boolean default false) returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    if p_json then
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('request.jwt.claim.role', '', true);
      perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
    else
      perform set_config('request.jwt.claims', '', true);
      perform set_config('request.jwt.claim.sub', p_sub::text, true);
      perform set_config('request.jwt.claim.role', 'authenticated', true);
    end if;
    perform set_config('role', 'authenticated', true);
    execute $q$select coalesce(string_agg(c.name, ',' order by c.name), '-')
                 from public.categories c
                where c.name like 'S49 %'$q$ into v;
    raise exception using errcode = 'XXT49', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XXT49' then v else 'error ' || v_state end;
end $$;
-- The S49 categories the pre-0421 rule passes for p_sub: 0140's
-- categories_select predicate, evaluated as the superuser (no row security)
-- with p_sub's claims set, ALWAYS undone.
create function pg_temp.old_rule(p_sub uuid) returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    execute format($q$select coalesce(string_agg(c.name, ',' order by c.name), '-')
                        from public.categories c
                       where c.name like 'S49 %%'
                         and public.is_org_member(c.organization_id)
                         and public.user_can_see_item_category(%L, c.organization_id, c.id)$q$, p_sub) into v;
    raise exception using errcode = 'XXT49', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XXT49' then v else 'error ' || v_state end;
end $$;
-- user_can_see_item_category(p_user, p_org, p_cat) called as p_as with
-- p_sub's claims, ALWAYS undone: its answer, or the error's SQLSTATE.
create function pg_temp.ask(p_as text, p_sub uuid, p_user uuid, p_org uuid, p_cat uuid) returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute format('select public.user_can_see_item_category(%L, %L, %L)::text', p_user, p_org, p_cat) into v;
    raise exception using errcode = 'XXT49', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XXT49' then v else v_state end;
end $$;
-- The plan of a category read as p_sub (authenticated), ALWAYS undone, or
-- 'error <SQLSTATE>' (EXPLAIN checks EXECUTE on the functions the plan runs).
create function pg_temp.plan_as(p_sub uuid) returns text language plpgsql as $$
declare v text := ''; v_line text; v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    for v_line in execute 'explain (costs off, verbose) select count(*) from public.categories' loop
      v := v || v_line || E'\n';
    end loop;
    raise exception using errcode = 'XXT49', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XXT49' then v else 'error ' || v_state end;
end $$;
-- categories_select as text, deparsed with search_path pinned (so the text
-- does not depend on the session's): command|permissive|roles|USING|CHECK.
create function pg_temp.policy_text() returns text language sql stable
  set search_path = public, extensions
as $$
  select pol.polcmd::text || '|' || pol.polpermissive::text || '|'
         || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
               from unnest(pol.polroles) x)
         || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
         || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
    from pg_policy pol
   where pol.polrelid = 'public.categories'::regclass and pol.polname = 'categories_select'
$$;

-- ══ S. Structure and who may call the function ════════════════════════════
select is(
  (select p.prosecdef::text || ':' || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ';'), '-')
          || ':' || pg_get_userbyid(p.proowner) || ':' || p.proisstrict::text || ':' || p.proleakproof::text
          || ':' || p.proparallel::text || ':' || l.lanname || ':' || p.prorettype::regtype::text
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'public.user_can_see_item_category(uuid,uuid,uuid)'::regprocedure),
  'true:s:search_path=public:postgres:false:false:u:plpgsql:boolean',
  'S1: user_can_see_item_category keeps its posture (SECURITY DEFINER, STABLE, search_path public, owner postgres, not STRICT or LEAKPROOF, PARALLEL UNSAFE, plpgsql, boolean); its body is not pinned here');

select is(
  (select array_to_string(array(select x::text from unnest(p.proacl) x order by 1), ',')
     from pg_proc p where p.oid = 'public.user_can_see_item_category(uuid,uuid,uuid)'::regprocedure),
  'postgres=X/postgres,service_role=X/postgres',
  'S2: only postgres and service_role may execute user_can_see_item_category (authenticated, anon and PUBLIC hold nothing)');

select ok(
  (select q like '%rls_member_org_ids()%' and q like '%rls_cat_unrestricted_org_ids()%'
          and q like '%rls_cat_allowed_category_ids()%' and q not like '%user_can_see_item_category%'
          and q not like '%is_org_member%'
     from (select pg_temp.policy_text() as q) s),
  'S3: categories_select reads rls_member_org_ids and the two category sets, and neither user_can_see_item_category nor the per-row is_org_member');

-- S3b. The policy as pg_temp.policy_text() gives it (search_path 'public,
-- extensions'; the deparse breaks the last subquery over three lines):
--   r|true|authenticated|((organization_id IN ( SELECT rls_member_org_ids() AS rls_member_org_ids)) AND ((organization_id IN ( SELECT rls_cat_unrestricted_org_ids() AS rls_cat_unrestricted_org_ids)) OR ((organization_id, id) IN ( SELECT rls_cat_allowed_category_ids.organization_id,
--       rls_cat_allowed_category_ids.category_id
--      FROM rls_cat_allowed_category_ids() rls_cat_allowed_category_ids(organization_id, category_id)))))|-
-- (the second line starts with four spaces, the third with three).
select is(
  md5(pg_temp.policy_text()),
  '4cede1f12b50f20376ddd02fdfe50e43',
  'S3b: categories_select is exactly the 0421 rule: SELECT, permissive, to authenticated, the membership set AND (the unrestricted set OR the allowed pairs), no WITH CHECK');

-- S4. Nothing evaluates the function as the user any more, so it needs no
-- authenticated EXECUTE (INV-C1): no policy names it, nothing depends on it,
-- and no other function's code calls it (bodies read through the strip pass
-- security_invariants reads them with, _sec_inv_strip_re: comments and quoted
-- strings do not count; this session's own pg_temp helpers, which call it on
-- purpose, are left out).
select is(
  (select count(*)::int from pg_policies
    where coalesce(qual, '') || ' ' || coalesce(with_check, '') like '%user_can_see_item_category%')::text
  || '/' ||
  (select count(*)::int from pg_depend d
    where d.refclassid = 'pg_proc'::regclass
      and d.refobjid = 'public.user_can_see_item_category(uuid,uuid,uuid)'::regprocedure)::text
  || '/' ||
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text), '0')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(temp|toast_temp)_'
      and p.oid <> 'public.user_can_see_item_category(uuid,uuid,uuid)'::regprocedure
      and regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
          ~* '\muser_can_see_item_category\M'),
  '0/0/0',
  'S4: no policy in any schema names user_can_see_item_category, nothing depends on it, and no other function''s code calls it (so nothing needs authenticated to keep EXECUTE, INV-C1)');

select is(
  pg_temp.ask('authenticated', :p03, :p01, :orgA, :catA1) || '/' || pg_temp.ask('authenticated', :p12, :p04, :orgA, :catA2),
  '42501/42501',
  'S5: a signed-in account''s call of user_can_see_item_category is refused (42501), for a member of the organization and for an outsider');

select is(
  pg_temp.ask('anon', null, :p01, :orgA, :catA1),
  '42501',
  'S6: anon is still refused (42501)');

select is(
  pg_temp.ask('service_role', null, :p03, :orgA, :catA1) || '/' || pg_temp.ask('service_role', null, :p12, :orgA, :catA1)
  || '/' || pg_temp.ask('service_role', null, :p11, :orgA, :catA1) || '/' || pg_temp.ask('service_role', null, :p04, :orgA, :catA2),
  'true/false/false/false',
  'S7: service_role still gets the answers: an active staff member yes; an outsider, a disabled member and a restricted viewer''s other category no');

select is(
  (select string_agg(policyname || ':' || cmd || ':' || permissive || ':' || array_to_string(roles, ','), ', ' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'categories' and cmd in ('SELECT', 'ALL')),
  'categories_select:SELECT:PERMISSIVE:authenticated',
  'S8: categories has exactly one SELECT or ALL policy, categories_select');

select is(
  (select string_agg(p.proname || ':' || has_function_privilege('authenticated', p.oid, 'execute')::text
                     || ':' || p.prosecdef::text || ':' || p.provolatile::text, ', ' order by p.proname)
     from pg_proc p
    where p.oid in ('public.rls_member_org_ids()'::regprocedure,
                    'public.rls_cat_unrestricted_org_ids()'::regprocedure,
                    'public.rls_cat_allowed_category_ids()'::regprocedure)),
  'rls_cat_allowed_category_ids:true:true:s, rls_cat_unrestricted_org_ids:true:true:s, rls_member_org_ids:true:true:s',
  'S9 (outage guard, INV-C1): authenticated keeps EXECUTE on the three sets the policy reads, and each stays SECURITY DEFINER and STABLE');

select is(
  (select coalesce(string_agg(f, ',' order by f), '-')
     from unnest(array['rls_member_org_ids', 'rls_cat_unrestricted_org_ids', 'rls_cat_allowed_category_ids',
                       'user_can_see_item_category', 'is_org_member']) f
    where position(f in pg_temp.plan_as(:p04)) > 0),
  'rls_cat_allowed_category_ids,rls_cat_unrestricted_org_ids,rls_member_org_ids',
  'S10: a restricted viewer''s category read runs the three sets and never user_can_see_item_category or is_org_member');

-- S11. The two comments section 4 of the migration writes (md5 of each text;
-- the texts are in the migration). Neither names the migration's number, so
-- a rename leaves these values alone.
select is(
  (select coalesce(md5(obj_description(pol.oid, 'pg_policy')), '-') from pg_policy pol
    where pol.polrelid = 'public.categories'::regclass and pol.polname = 'categories_select')
  || '/' || coalesce(md5(obj_description('public.user_can_see_item_category(uuid,uuid,uuid)'::regprocedure, 'pg_proc')), '-'),
  'bb74e95b96721dfe6f6663036372678f/855d484431d536a595efed45d73dd788',
  'S11: categories_select and user_can_see_item_category carry the reviewed comments');

-- S12. What those comments say of the catalog: stock_movements_select reads
-- rls_member_org_ids, inventory_items_select reads the two category sets (and
-- not rls_member_org_ids: the comments name stock_movements_select for that
-- set), and the three sets take no argument and call auth.uid() in their code
-- (bodies read without comments and quoted strings).
select is(
  (select string_agg(c.relname || ':'
                     || coalesce((select string_agg(f, '+' order by f)
                                    from unnest(array['rls_member_org_ids', 'rls_cat_unrestricted_org_ids',
                                                      'rls_cat_allowed_category_ids']) f
                                   where position(f || '()' in pg_get_expr(pol.polqual, pol.polrelid)) > 0), 'none'),
                     ', ' order by c.relname)
     from pg_policy pol join pg_class c on c.oid = pol.polrelid
    where (pol.polrelid, pol.polname) in (('public.inventory_items'::regclass, 'inventory_items_select'),
                                          ('public.stock_movements'::regclass, 'stock_movements_select')))
  || ' | ' ||
  (select string_agg(p.proname || ':' || p.pronargs::text || ':'
                     || (regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
                           ~* $re$\mauth\.uid\M$re$)::text, ', ' order by p.proname)
     from pg_proc p
    where p.oid in ('public.rls_member_org_ids()'::regprocedure,
                    'public.rls_cat_unrestricted_org_ids()'::regprocedure,
                    'public.rls_cat_allowed_category_ids()'::regprocedure)),
  'inventory_items:rls_cat_allowed_category_ids+rls_cat_unrestricted_org_ids, stock_movements:rls_member_org_ids'
  ' | rls_cat_allowed_category_ids:0:true, rls_cat_unrestricted_org_ids:0:true, rls_member_org_ids:0:true',
  'S12: what the comments say holds: stock_movements_select reads rls_member_org_ids, inventory_items_select reads the two category sets and not rls_member_org_ids, and the three sets take no argument and call auth.uid() in their code');

-- ══ E. The row sets: live = the hand list = the pre-0421 rule ══════════════
select is(pg_temp.live(:p01) || ' | ' || pg_temp.old_rule(:p01), 'S49 A1,S49 A2 | S49 A1,S49 A2',
  'E01: the owner of A reads A''s two categories (live | pre-0421 rule)');
select is(pg_temp.live(:p02) || ' | ' || pg_temp.old_rule(:p02), 'S49 A1,S49 A2 | S49 A1,S49 A2',
  'E02: a manager of A reads A''s two categories');
select is(pg_temp.live(:p03) || ' | ' || pg_temp.old_rule(:p03), 'S49 A1,S49 A2 | S49 A1,S49 A2',
  'E03: staff of A read A''s two categories');
select is(pg_temp.live(:p04) || ' | ' || pg_temp.old_rule(:p04), 'S49 A1 | S49 A1',
  'E04: a viewer of A limited to A1 reads A1 only');
select is(pg_temp.live(:p05) || ' | ' || pg_temp.old_rule(:p05), 'S49 A1,S49 A2 | S49 A1,S49 A2',
  'E05: a viewer of A with no limit reads A''s two categories');
select is(pg_temp.live(:p06) || ' | ' || pg_temp.old_rule(:p06), 'S49 A1,S49 A2 | S49 A1,S49 A2',
  'E06: staff of A with a stale assignment row are not limited');
select is(pg_temp.live(:p07) || ' | ' || pg_temp.old_rule(:p07), 'S49 A1,S49 A2,S49 B1 | S49 A1,S49 A2,S49 B1',
  'E07: a viewer with no limit in A and limited to B1 in B reads A''s two categories and B1');
select is(pg_temp.live(:p08) || ' | ' || pg_temp.old_rule(:p08), '- | -',
  'E08: an invitation not yet accepted reads none');
select is(pg_temp.live(:p09) || ' | ' || pg_temp.old_rule(:p09), '- | -',
  'E09: an expired Act-as seat reads none');
select is(pg_temp.live(:p10) || ' | ' || pg_temp.old_rule(:p10), 'S49 A1,S49 A2 | S49 A1,S49 A2',
  'E10: a live Act-as seat reads A''s two categories');
select is(pg_temp.live(:p11) || ' | ' || pg_temp.old_rule(:p11), '- | -',
  'E11: a disabled member reads none');
select is(pg_temp.live(:p12) || ' | ' || pg_temp.old_rule(:p12), '- | -',
  'E12: an outsider reads none');
select is(pg_temp.live(:p13) || ' | ' || pg_temp.old_rule(:p13), 'S49 B1,S49 B2 | S49 B1,S49 B2',
  'E13: a manager of B reads B''s two categories and none of A''s');
select is(pg_temp.live(:p04, true), 'S49 A1',
  'E14: the restricted viewer with only the request.jwt.claims JSON PostgREST sets still reads A1 only');

-- ══ A. The migration's own preflight and lock prelude ══════════════════════
-- The statements the CLI recorded for version 0421 that contain p_tag. The
-- tags are the file's own, $pre_s49$ and $lock_s49$.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = '0421' and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = '0421' and position(p_tag in st) > 0
$$;
-- The pre-0421 state: 0140's categories_select and 0129's grant.
create function pg_temp.pre_0421() returns text language sql immutable as $$
  select $p$drop policy categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using (
    (SELECT public.is_org_member(organization_id))
    and public.user_can_see_item_category(auth.uid(), organization_id, id)
  );
grant execute on function public.user_can_see_item_category(uuid, uuid, uuid) to authenticated$p$
$$;
-- The preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and the checks its message reports, sorted; 'missing'
-- when the CLI recorded no preflight (an empty EXECUTE would read as 'ok').
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text;
begin
  if pg_temp.mig('$pre_s49$') = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('$pre_s49$');
    raise exception using errcode = 'XXT49', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXT49' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(\S+ drifted|\S+ missing|grants|dependents|SELECT policies)', 'g') m),
                     v_msg);
end $$;
-- The tables (outside the catalogs) this backend holds in ACCESS EXCLUSIVE
-- mode after p_sql, ALWAYS undone (the locks go with the subtransaction);
-- 'missing' for an empty p_sql.
create function pg_temp.ae_locks(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_sql = '' then
    return 'missing';
  end if;
  begin
    if p_sql is not null then
      execute p_sql;
    end if;
    select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) into v
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
       and l.mode = 'AccessExclusiveLock' and c.relpersistence = 'p'
       and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
    raise exception using errcode = 'XXT49', message = 'undo';
  exception when sqlstate 'XXT49' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

select is(
  pg_temp.mig_count('$pre_s49$')::text || '/' || pg_temp.mig_count('$lock_s49$')::text,
  '1/1',
  'A1: the CLI recorded 0421''s preflight and lock prelude exactly once each (this section runs that text)');

select is(
  pg_temp.try_pre(null),
  '55000:s49_preflight:SELECT policies, dependents, grants',
  'A2: run again after 0421, the preflight stops before changing anything (55000) and names the policy, the dependents and the grants 0421 changed');

select is(
  pg_temp.try_pre(pg_temp.pre_0421()) || ' / ' || pg_temp.try_pre(pg_temp.pre_0421() || $p$;set local search_path = ''$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0421() || $p$;set local search_path = pg_catalog$p$),
  'ok / ok / ok',
  'A3: on the pre-0421 state the preflight passes, under the session''s search_path, an empty one and pg_catalog alone (its policy text is deparsed under a pinned search_path)');

select is(
  pg_temp.try_pre(pg_temp.pre_0421() || $p$;
create or replace function public.rls_member_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $f$
  select m.organization_id from public.organization_members m where m.user_id = auth.uid()
$f$$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0421() || $p$;
revoke all on function public.rls_cat_allowed_category_ids() from public, authenticated$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0421() || $p$;
create policy s49_extra_read on public.categories for select to authenticated using (true)$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0421() || $p$;
create policy s49_other_user on public.suppliers for select to authenticated
  using (public.user_can_see_item_category(auth.uid(), organization_id, null))$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0421() || $p$;
grant execute on function public.user_can_see_item_category(uuid, uuid, uuid) to anon$p$),
  '55000:s49_preflight:public.rls_member_org_ids() drifted / '
  '55000:s49_preflight:public.rls_cat_allowed_category_ids() drifted / '
  '55000:s49_preflight:SELECT policies / '
  '55000:s49_preflight:dependents / '
  '55000:s49_preflight:grants',
  'A4: on that state each planted drift stops it and is named: a set helper''s body, authenticated losing EXECUTE on a set, a second SELECT policy on categories, a second caller of the function, a grant to anon');

select is(
  pg_temp.ae_locks(null) || ' / ' || pg_temp.ae_locks(pg_temp.mig('$lock_s49$')),
  'none / ' || (select string_agg(x, ',' order by x) from (
                  select 'public.categories' as x
                  union
                  select n.nspname || '.' || c.relname
                    from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                                                            -> current_user::text, '[]'::jsonb)) g(name)
                    join pg_class c on c.oid = to_regclass(g.name)
                    join pg_namespace n on n.oid = c.relnamespace) s),
  'A5: the lock prelude takes ACCESS EXCLUSIVE on categories and on every table supautils.policy_grants lists for this role, at once, and on nothing else (the policy statements take exactly that set)');

select * from finish();
rollback;
