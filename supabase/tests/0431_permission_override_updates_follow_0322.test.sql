-- supabase/tests/0431_permission_override_updates_follow_0322.test.sql
-- pgTAP proof for migration 0431 (docket S62): the UPDATE rules of
-- user_permission_overrides and role_permission_overrides ask, of the row
-- being changed, what their DELETE rules ask since 0322: an admin, and either
-- the row is a grant or the writer holds the permission it is about. The
-- WITH CHECK half stays 0215's. So the database asks for the same permission
-- the app asks (actions/permissions.ts, assertCanGrant) before a restriction
-- changes. No row of any table changes.
--
-- S.  Structure: each table has one UPDATE (or ALL) rule, permissive, for
--     authenticated (S1); its USING is the table's DELETE rule (S2) and its
--     WITH CHECK the table's INSERT rule (S3), and both texts are pinned (S4);
--     the four rules per table keep their names (S5); authenticated keeps
--     EXECUTE on the two helpers they call (S6, INV-C1).
-- R.  An admin who lacks members:invite and members:remove (restricted for
--     them alone): a restriction on either key keeps its key and its person,
--     and has_permission still answers false (R1-R3); it is not deleted (R4,
--     0322); re-writing one in the app's upsert shape is refused (R5).
--     Turning a grant into a restriction, lifting a restriction on a key the
--     admin holds and writing a new restriction still work (R6-R8).
-- W.  The same for an admin whose role is restricted (W1-W5).
-- H.  An admin who holds the keys: the app's grant, restrict and Auditor
--     preset shapes (H1-H4).
-- O.  An owner changes any row (O1, O2).
-- N.  A manager and another organization's admin change nothing (N1, N2).
-- M.  Mutation: with 0215's UPDATE rules put back (undone), R1 and W1 land,
--     so they measure the new term (M1).
-- A.  The migration's own preflight and lock prelude, replayed from the
--     statements the CLI recorded (0415's method): the preflight refuses a
--     second run, passes on the pre-0431 state under any search_path, and
--     names each planted drift; the prelude takes ACCESS EXCLUSIVE on the two
--     tables and on every table supautils.policy_grants lists for this role,
--     and on nothing else.
--
-- Roles: fixtures as the test superuser. Every write as an API role runs
-- inside a subtransaction that is always undone (the role and claims are set
-- with set_config there), so every case starts from the fixture and pgTAP's
-- own statements never run as an API role. begin/rollback: nothing leaks.
-- Namespace 562c0000.

begin;

select plan(34);

\set orgA '\'562c0000-0000-0000-0000-00000000000a\''
\set orgB '\'562c0000-0000-0000-0000-00000000000b\''
\set orgC '\'562c0000-0000-0000-0000-00000000000c\''

-- Personas, by the last two digits of their ids:
--   01 owner of A
--   02 admin H of A, no override (holds every admin key)
--   03 admin R of A, members:invite and members:remove restricted for them
--   04 staff S of A (a members:remove restriction)
--   05 staff T of A (a stock:adjust restriction, a key R holds)
--   06 viewer V of A (a members:remove grant)
--   07 owner of B
--   08 admin W of B, under the admin role's members:update_role and
--      members:remove restrictions
--   09 staff U of B
--   10 admin of C
--   11 manager of A
\set p01 '\'562c0000-0000-0000-0000-000000000101\''
\set p02 '\'562c0000-0000-0000-0000-000000000102\''
\set p03 '\'562c0000-0000-0000-0000-000000000103\''
\set p04 '\'562c0000-0000-0000-0000-000000000104\''
\set p05 '\'562c0000-0000-0000-0000-000000000105\''
\set p06 '\'562c0000-0000-0000-0000-000000000106\''
\set p07 '\'562c0000-0000-0000-0000-000000000107\''
\set p08 '\'562c0000-0000-0000-0000-000000000108\''
\set p09 '\'562c0000-0000-0000-0000-000000000109\''
\set p10 '\'562c0000-0000-0000-0000-000000000110\''
\set p11 '\'562c0000-0000-0000-0000-000000000111\''

insert into auth.users (id, email, raw_user_meta_data)
  select ('562c0000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid,
         'person' || g || '@s62.test', '{}'::jsonb
    from generate_series(1, 11) g;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S62 Org A', 's62-org-a'),
  (:orgB, 'S62 Org B', 's62-org-b'),
  (:orgC, 'S62 Org C', 's62-org-c');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :p01, 'owner',   now()),
  (:orgA, :p02, 'admin',   now()),
  (:orgA, :p03, 'admin',   now()),
  (:orgA, :p04, 'staff',   now()),
  (:orgA, :p05, 'staff',   now()),
  (:orgA, :p06, 'viewer',  now()),
  (:orgB, :p07, 'owner',   now()),
  (:orgB, :p08, 'admin',   now()),
  (:orgB, :p09, 'staff',   now()),
  (:orgC, :p10, 'admin',   now()),
  (:orgA, :p11, 'manager', now());
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :p03, 'members:invite', false),
  (:orgA, :p03, 'members:remove', false),
  (:orgA, :p04, 'members:remove', false),
  (:orgA, :p05, 'stock:adjust',   false),
  (:orgA, :p06, 'members:remove', true);
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:orgB, 'admin',  'members:update_role', false),
  (:orgB, 'admin',  'members:remove',      false),
  (:orgB, 'viewer', 'members:remove',      true),
  (:orgA, 'viewer', 'reports:read',        false),
  (:orgA, 'staff',  'members:remove',      false);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- p_sql run as authenticated with p_sub's claims, ALWAYS undone: the number
-- of rows it wrote (an UPDATE whose USING refuses a row writes 0), or
-- 'ERR:<SQLSTATE>'. p_prep runs first, as the superuser (the M case plants
-- a rule there). p_after runs last, as the superuser with p_sub's claims
-- still set, so has_permission answers for p_sub and a read sees every row;
-- its value follows ' / '. Every statement goes through EXECUTE, so it is
-- planned and permission-checked on each call.
create function pg_temp.try(p_sub uuid, p_sql text, p_after text default null, p_prep text default null)
returns text language plpgsql as $$
declare v text; v_after text; v_rows bigint; v_state text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    begin
      execute p_sql;
      get diagnostics v_rows = row_count;
      v := v_rows::text;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
      v := 'ERR:' || v_state;
    end;
    perform set_config('role', 'none', true);
    if p_after is not null then
      execute p_after into v_after;
      v := v || ' / ' || coalesce(v_after, 'null');
    end if;
    raise exception using errcode = 'XX562', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'XX562' then
      v := 'helper ERR:' || v_state;
    end if;
  end;
  return v;
end $$;
-- p_sql (one value) as authenticated with p_sub's claims, ALWAYS undone.
create function pg_temp.ask(p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    execute p_sql into v;
    raise exception using errcode = 'XX562', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XX562' then coalesce(v, 'null') else 'ERR:' || v_state end;
end $$;
-- The app's write, as PostgREST runs supabase-js's upsert: one INSERT whose
-- ON CONFLICT branch sets every column sent (actions/permissions.ts).
create function pg_temp.upsert_user(p_org uuid, p_user uuid, p_perm text, p_granted boolean, p_by uuid)
returns text language sql immutable as $$
  select format($q$insert into public.user_permission_overrides
      (organization_id, user_id, permission, granted, updated_by, updated_at)
    values (%L, %L, %L, %L, %L, now())
    on conflict (organization_id, user_id, permission) do update
      set organization_id = excluded.organization_id, user_id = excluded.user_id,
          permission = excluded.permission, granted = excluded.granted,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at$q$,
    p_org, p_user, p_perm, p_granted, p_by)
$$;
create function pg_temp.upsert_role(p_org uuid, p_role text, p_perms text[], p_granted boolean, p_by uuid)
returns text language sql immutable as $$
  select format($q$insert into public.role_permission_overrides
      (organization_id, role, permission, granted, updated_by, updated_at)
    select %L, %L, k, %L, %L, now() from unnest(%L::text[]) k
    on conflict (organization_id, role, permission) do update
      set organization_id = excluded.organization_id, role = excluded.role,
          permission = excluded.permission, granted = excluded.granted,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at$q$,
    p_org, p_role, p_granted, p_by, p_perms)
$$;
-- A user override's state as the superuser: 'none', 'grant' or 'restriction'.
create function pg_temp.u(p_org uuid, p_user uuid, p_perm text) returns text language sql stable as $$
  select coalesce((select case when o.granted then 'grant' else 'restriction' end
                     from public.user_permission_overrides o
                    where o.organization_id = p_org and o.user_id = p_user and o.permission = p_perm), 'none')
$$;
create function pg_temp.r(p_org uuid, p_role text, p_perm text) returns text language sql stable as $$
  select coalesce((select case when o.granted then 'grant' else 'restriction' end
                     from public.role_permission_overrides o
                    where o.organization_id = p_org and o.role = p_role and o.permission = p_perm), 'none')
$$;
-- A rule as text, deparsed with search_path pinned (so the text does not
-- depend on the session's): command|permissive|roles|USING|CHECK.
create function pg_temp.policy_text(p_table regclass, p_name text) returns text language sql stable
  set search_path = public, extensions
as $$
  select pol.polcmd::text || '|' || pol.polpermissive::text || '|'
         || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
               from unnest(pol.polroles) x)
         || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
         || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
    from pg_policy pol
   where pol.polrelid = p_table and pol.polname = p_name
$$;
create function pg_temp.policy_part(p_table regclass, p_name text, p_part text) returns text language sql stable
  set search_path = public, extensions
as $$
  select case p_part when 'using' then pg_get_expr(pol.polqual, pol.polrelid)
                     else pg_get_expr(pol.polwithcheck, pol.polrelid) end
    from pg_policy pol
   where pol.polrelid = p_table and pol.polname = p_name
$$;

-- ══ S. Structure ══════════════════════════════════════════════════════════
select is(
  (select string_agg(c.relname || ':' || pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text
                     || '|' || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                                  from unnest(pol.polroles) x), ', ' order by c.relname, pol.polname)
     from pg_policy pol join pg_class c on c.oid = pol.polrelid
    where pol.polrelid in ('public.user_permission_overrides'::regclass, 'public.role_permission_overrides'::regclass)
      and pol.polcmd in ('w', '*')),
  'role_permission_overrides:role_permission_overrides_update|w|true|authenticated, '
  'user_permission_overrides:user_permission_overrides_update|w|true|authenticated',
  'S1: each override table has exactly one UPDATE (or ALL) rule, permissive, for authenticated');

select is(
  (pg_temp.policy_part('public.user_permission_overrides', 'user_permission_overrides_update', 'using')
     = pg_temp.policy_part('public.user_permission_overrides', 'user_permission_overrides_delete', 'using'))::text
  || ',' ||
  (pg_temp.policy_part('public.role_permission_overrides', 'role_permission_overrides_update', 'using')
     = pg_temp.policy_part('public.role_permission_overrides', 'role_permission_overrides_delete', 'using'))::text,
  'true,true',
  'S2: each UPDATE rule asks of the row it changes what the table''s DELETE rule asks (0322)');

select is(
  (pg_temp.policy_part('public.user_permission_overrides', 'user_permission_overrides_update', 'check')
     = pg_temp.policy_part('public.user_permission_overrides', 'user_permission_overrides_insert', 'check'))::text
  || ',' ||
  (pg_temp.policy_part('public.role_permission_overrides', 'role_permission_overrides_update', 'check')
     = pg_temp.policy_part('public.role_permission_overrides', 'role_permission_overrides_insert', 'check'))::text,
  'true,true',
  'S3: each UPDATE rule''s WITH CHECK is still the table''s INSERT rule (0215)');

select is(
  pg_temp.policy_text('public.user_permission_overrides', 'user_permission_overrides_update') || E'\n'
  || pg_temp.policy_text('public.role_permission_overrides', 'role_permission_overrides_update'),
  'w|true|authenticated'
  || '|(( SELECT has_org_role(user_permission_overrides.organization_id, ''admin''::text) AS has_org_role) AND ((granted = true) OR ( SELECT has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) AS has_permission)))'
  || '|(( SELECT has_org_role(user_permission_overrides.organization_id, ''admin''::text) AS has_org_role) AND ((granted = false) OR ( SELECT has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) AS has_permission)))'
  || E'\n' || 'w|true|authenticated'
  || '|(( SELECT has_org_role(role_permission_overrides.organization_id, ''admin''::text) AS has_org_role) AND ((granted = true) OR ( SELECT has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) AS has_permission)))'
  || '|(( SELECT has_org_role(role_permission_overrides.organization_id, ''admin''::text) AS has_org_role) AND ((granted = false) OR ( SELECT has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) AS has_permission)))',
  'S4: the two UPDATE rules'' text (USING: an admin, and a grant or a held permission; WITH CHECK: 0215''s)');

select is(
  (select string_agg(c.relname || ':' || pol.polname || ':' || pol.polcmd::text, ', ' order by c.relname, pol.polname)
     from pg_policy pol join pg_class c on c.oid = pol.polrelid
    where pol.polrelid in ('public.user_permission_overrides'::regclass, 'public.role_permission_overrides'::regclass)),
  'role_permission_overrides:role_permission_overrides_delete:d, role_permission_overrides:role_permission_overrides_insert:a, '
  'role_permission_overrides:role_permission_overrides_select:r, role_permission_overrides:role_permission_overrides_update:w, '
  'user_permission_overrides:user_permission_overrides_delete:d, user_permission_overrides:user_permission_overrides_insert:a, '
  'user_permission_overrides:user_permission_overrides_select:r, user_permission_overrides:user_permission_overrides_update:w',
  'S5: each table keeps its four rules, one per command');

select is(
  has_function_privilege('authenticated', 'public.has_permission(uuid,text)', 'execute')::text || ','
  || has_function_privilege('authenticated', 'public.has_org_role(uuid,text)', 'execute')::text,
  'true,true',
  'S6: authenticated keeps EXECUTE on has_permission and has_org_role (the rules run as the writer, INV-C1)');

-- ══ R. An admin restricted for themselves ═════════════════════════════════
select is(
  pg_temp.ask(:p03, format($q$select public.has_org_role(%1$L, 'admin')::text || '|'
                                  || public.has_permission(%1$L, 'members:invite')::text || '|'
                                  || public.has_permission(%1$L, 'members:remove')::text || '|'
                                  || public.has_permission(%1$L, 'stock:adjust')::text$q$, :orgA)),
  'true|false|false|true',
  'R0: R is an admin of A who lacks members:invite and members:remove and holds stock:adjust');

select is(
  pg_temp.try(:p03,
    format($q$update public.user_permission_overrides set permission = 'reports:read'
               where organization_id = %L and user_id = %L and permission = 'members:invite'$q$, :orgA, :p03),
    format($q$select pg_temp.u(%1$L, %2$L, 'members:invite') || ',' || pg_temp.u(%1$L, %2$L, 'reports:read')$q$, :orgA, :p03)),
  '0 / restriction,none',
  'R1: an admin who lacks members:invite does not change the key of a restriction on it');

select is(
  pg_temp.try(:p03,
    format($q$update public.user_permission_overrides set permission = 'reports:read'
               where organization_id = %L and user_id = %L and permission = 'members:invite'$q$, :orgA, :p03),
    format($q$select public.has_permission(%L, 'members:invite')::text$q$, :orgA)),
  '0 / false',
  'R2: and still lacks members:invite afterwards');

select is(
  pg_temp.try(:p03,
    format($q$update public.user_permission_overrides set user_id = %L
               where organization_id = %L and user_id = %L and permission = 'members:remove'$q$, :p05, :orgA, :p03),
    format($q$select pg_temp.u(%1$L, %2$L, 'members:remove') || ',' || pg_temp.u(%1$L, %3$L, 'members:remove')
                || ',' || public.has_permission(%1$L, 'members:remove')::text$q$, :orgA, :p03, :p05)),
  '0 / restriction,none,false',
  'R3: an admin who lacks members:remove does not move a restriction on it to another member, and still lacks the key');

select is(
  pg_temp.try(:p03,
    format($q$delete from public.user_permission_overrides
               where organization_id = %L and user_id = %L and permission = 'members:remove'$q$, :orgA, :p03),
    format($q$select pg_temp.u(%L, %L, 'members:remove')$q$, :orgA, :p03)),
  '0 / restriction',
  'R4 (control, 0322): nor deletes it');

select is(
  pg_temp.try(:p03, pg_temp.upsert_user(:orgA, :p04, 'members:remove', false, :p03),
    format($q$select pg_temp.u(%L, %L, 'members:remove')$q$, :orgA, :p04)),
  'ERR:42501 / restriction',
  'R5: an admin who lacks members:remove re-writing a restriction on it in the app''s upsert shape is refused (42501); the restriction stays');

select is(
  pg_temp.try(:p03, pg_temp.upsert_user(:orgA, :p06, 'members:remove', false, :p03),
    format($q$select pg_temp.u(%L, %L, 'members:remove')$q$, :orgA, :p06)),
  '1 / restriction',
  'R6 (control): R turns viewer V''s members:remove grant into a restriction (a restriction never needs the key)');

select is(
  pg_temp.try(:p03,
    format($q$update public.user_permission_overrides set granted = true
               where organization_id = %L and user_id = %L and permission = 'stock:adjust'$q$, :orgA, :p05),
    format($q$select pg_temp.u(%L, %L, 'stock:adjust')$q$, :orgA, :p05)),
  '1 / grant',
  'R7 (control): R lifts staff T''s restriction on stock:adjust, a key R holds');

select is(
  pg_temp.try(:p03, pg_temp.upsert_user(:orgA, :p04, 'members:invite', false, :p03),
    format($q$select pg_temp.u(%L, %L, 'members:invite')$q$, :orgA, :p04)),
  '1 / restriction',
  'R8 (control): R writes a new restriction on a key R lacks (the upsert''s insert path)');

-- ══ W. An admin under a restriction on the admin role ═════════════════════
select is(
  pg_temp.try(:p08,
    format($q$update public.role_permission_overrides set role = 'viewer'
               where organization_id = %L and role = 'admin' and permission = 'members:update_role'$q$, :orgB),
    format($q$select pg_temp.r(%1$L, 'admin', 'members:update_role') || ',' || pg_temp.r(%1$L, 'viewer', 'members:update_role')
                || ',' || public.has_permission(%1$L, 'members:update_role')::text$q$, :orgB)),
  '0 / restriction,none,false',
  'W1: an admin whose role lacks members:update_role does not move the role''s restriction on it to another role, and still lacks the key');

select is(
  pg_temp.try(:p08,
    format($q$update public.role_permission_overrides set permission = 'reports:read'
               where organization_id = %L and role = 'admin' and permission = 'members:update_role'$q$, :orgB),
    format($q$select pg_temp.r(%1$L, 'admin', 'members:update_role') || ',' || public.has_permission(%1$L, 'members:update_role')::text$q$, :orgB)),
  '0 / restriction,false',
  'W2: nor changes its key');

select is(
  pg_temp.try(:p08, pg_temp.upsert_role(:orgB, 'admin', array['members:remove'], false, :p08),
    format($q$select pg_temp.r(%L, 'admin', 'members:remove')$q$, :orgB)),
  'ERR:42501 / restriction',
  'W3: re-writing the role''s members:remove restriction in the app''s upsert shape is refused (42501); the restriction stays');

select is(
  pg_temp.try(:p08, pg_temp.upsert_role(:orgB, 'viewer', array['members:remove'], false, :p08),
    format($q$select pg_temp.r(%L, 'viewer', 'members:remove')$q$, :orgB)),
  '1 / restriction',
  'W4 (control): W turns the viewer role''s members:remove grant into a restriction');

select is(
  pg_temp.try(:p08,
    format($q$delete from public.role_permission_overrides
               where organization_id = %L and role = 'admin' and permission = 'members:update_role'$q$, :orgB),
    format($q$select pg_temp.r(%L, 'admin', 'members:update_role')$q$, :orgB)),
  '0 / restriction',
  'W5 (control, 0322): nor deletes the role''s restriction');

-- ══ H. An admin who holds the keys: the app's shapes ══════════════════════
select is(
  pg_temp.try(:p02, pg_temp.upsert_user(:orgA, :p04, 'members:remove', true, :p02),
    format($q$select pg_temp.u(%L, %L, 'members:remove')$q$, :orgA, :p04)),
  '1 / grant',
  'H1: H''s grant over staff S''s members:remove restriction lands (the Roles page''s grant)');

select is(
  pg_temp.try(:p02, pg_temp.upsert_user(:orgA, :p04, 'members:remove', false, :p02)
                    || ';' || pg_temp.upsert_user(:orgA, :p06, 'members:remove', false, :p02),
    format($q$select pg_temp.u(%1$L, %2$L, 'members:remove') || ',' || pg_temp.u(%1$L, %3$L, 'members:remove')$q$, :orgA, :p04, :p06)),
  '1 / restriction,restriction',
  'H2: H re-writes staff S''s restriction and turns viewer V''s grant into one (the Roles page''s restrict)');

select is(
  pg_temp.try(:p02,
    pg_temp.upsert_role(:orgA, 'viewer', array['reports:read', 'activity_logs:read', 'cycle_counts:read', 'schedule:read',
                                               'bundles:read', 'rentals:read', 'returns:read', 'items:export', 'reports:export'],
                        true, :p02),
    format($q$select count(*) filter (where granted)::text || ' of ' || count(*)::text
                from public.role_permission_overrides where organization_id = %L and role = 'viewer'$q$, :orgA)),
  '9 / 9 of 9',
  'H3: H applies the Auditor preset to viewers, over the viewer role''s reports:read restriction');

select is(
  pg_temp.try(:p02, pg_temp.upsert_role(:orgA, 'staff', array['members:remove'], false, :p02),
    format($q$select pg_temp.r(%L, 'staff', 'members:remove')$q$, :orgA)),
  '1 / restriction',
  'H4: H re-writes the staff role''s members:remove restriction (the Roles page''s role restrict)');

-- ══ O. An owner changes any row ═══════════════════════════════════════════
select is(
  pg_temp.try(:p01,
    format($q$update public.user_permission_overrides set permission = 'reports:read'
               where organization_id = %1$L and user_id = %2$L and permission = 'members:invite'$q$, :orgA, :p03))
  || ' | ' ||
  pg_temp.try(:p01,
    format($q$update public.user_permission_overrides set user_id = %3$L
               where organization_id = %1$L and user_id = %2$L and permission = 'members:remove'$q$, :orgA, :p03, :p05))
  || ' | ' ||
  pg_temp.try(:p01,
    format($q$update public.user_permission_overrides set granted = true
               where organization_id = %1$L and user_id = %2$L and permission = 'members:remove'$q$, :orgA, :p03))
  || ' | ' ||
  pg_temp.try(:p01, pg_temp.upsert_user(:orgA, :p03, 'members:invite', false, :p01)),
  '1 | 1 | 1 | 1',
  'O1: the owner of A changes the key and the person of a restriction, lifts one and re-writes one');

select is(
  pg_temp.try(:p07,
    format($q$update public.role_permission_overrides set role = 'viewer'
               where organization_id = %L and role = 'admin' and permission = 'members:update_role'$q$, :orgB))
  || ' | ' ||
  pg_temp.try(:p07, pg_temp.upsert_role(:orgB, 'admin', array['members:remove'], false, :p07)),
  '1 | 1',
  'O2: the owner of B moves a role''s restriction to another role and re-writes another');

-- ══ N. No one else ════════════════════════════════════════════════════════
select is(
  pg_temp.try(:p11,
    format($q$update public.user_permission_overrides set granted = true
               where organization_id = %L and user_id = %L and permission = 'stock:adjust'$q$, :orgA, :p05),
    format($q$select pg_temp.u(%L, %L, 'stock:adjust')$q$, :orgA, :p05)),
  '0 / restriction',
  'N1 (control): a manager of A changes no override row');

select is(
  pg_temp.try(:p10,
    format($q$update public.user_permission_overrides set granted = true
               where organization_id = %L and user_id = %L and permission = 'stock:adjust'$q$, :orgA, :p05),
    format($q$select pg_temp.u(%L, %L, 'stock:adjust')$q$, :orgA, :p05)),
  '0 / restriction',
  'N2 (control): another organization''s admin changes no override row of A');

-- ══ M. Mutation: 0215's UPDATE rules back, undone ═════════════════════════
select is(
  pg_temp.try(:p03,
    format($q$update public.user_permission_overrides set permission = 'reports:read'
               where organization_id = %L and user_id = %L and permission = 'members:invite'$q$, :orgA, :p03),
    null,
    $p$drop policy user_permission_overrides_update on public.user_permission_overrides;
create policy user_permission_overrides_update on public.user_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') )
    and (
      user_permission_overrides.granted = false
      or ( SELECT public.has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) )
    )
  )$p$)
  || ' | ' ||
  pg_temp.try(:p08,
    format($q$update public.role_permission_overrides set role = 'viewer'
               where organization_id = %L and role = 'admin' and permission = 'members:update_role'$q$, :orgB),
    null,
    $p$drop policy role_permission_overrides_update on public.role_permission_overrides;
create policy role_permission_overrides_update on public.role_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') )
    and (
      role_permission_overrides.granted = false
      or ( SELECT public.has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) )
    )
  )$p$),
  '1 | 1',
  'M1: with 0215''s UPDATE rules put back (undone), R1 and W1 land, so they measure the new term');

-- ══ A. The migration's own preflight and lock prelude ══════════════════════
-- The statements the CLI recorded for this file that contain p_tag, found by
-- the file's name so a renumbering does not change this section. The tags
-- are the file's own, $pre_s62$ and $lock_s62$.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'permission_override_updates_follow_0322' and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'permission_override_updates_follow_0322' and position(p_tag in st) > 0
$$;
-- The pre-0431 state: 0215's two UPDATE rules.
create function pg_temp.pre_0431() returns text language sql immutable as $$
  select $p$drop policy user_permission_overrides_update on public.user_permission_overrides;
create policy user_permission_overrides_update on public.user_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') )
    and (
      user_permission_overrides.granted = false
      or ( SELECT public.has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) )
    )
  );
drop policy role_permission_overrides_update on public.role_permission_overrides;
create policy role_permission_overrides_update on public.role_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') )
    and (
      role_permission_overrides.granted = false
      or ( SELECT public.has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) )
    )
  )$p$
$$;
-- The preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and the checks its message reports, sorted; 'missing'
-- when the CLI recorded no preflight (an empty EXECUTE would read as 'ok').
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text;
begin
  if pg_temp.mig('$pre_s62$') = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('$pre_s62$');
    raise exception using errcode = 'XXT62', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXT62' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(\S+ drifted|\S+ missing|\S+ UPDATE rules)', 'g') m),
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
    raise exception using errcode = 'XXT62', message = 'undo';
  exception when sqlstate 'XXT62' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

select is(
  pg_temp.mig_count('$pre_s62$')::text || '/' || pg_temp.mig_count('$lock_s62$')::text,
  '1/1',
  'A1: the CLI recorded the preflight and the lock prelude exactly once each (this section runs that text)');

select is(
  pg_temp.try_pre(null),
  '55000:s62_preflight:public.role_permission_overrides UPDATE rules, public.user_permission_overrides UPDATE rules',
  'A2: run again after the migration, the preflight stops before changing anything (55000) and names both tables'' UPDATE rules');

select is(
  pg_temp.try_pre(pg_temp.pre_0431()) || ' / ' || pg_temp.try_pre(pg_temp.pre_0431() || $p$;set local search_path = ''$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0431() || $p$;set local search_path = pg_catalog$p$),
  'ok / ok / ok',
  'A3: on the pre-0431 state the preflight passes, under the session''s search_path, an empty one and pg_catalog alone');

select is(
  pg_temp.try_pre(pg_temp.pre_0431() || $p$;
create or replace function public.has_permission(org_id uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $f$ select true $f$$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0431() || $p$;
create or replace function public.has_org_role(org_id uuid, min_role text) returns boolean
language sql stable security definer set search_path = public as $f$ select true $f$$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0431() || $p$;
revoke execute on function public.has_permission(uuid, text) from public, authenticated$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0431() || $p$;
create policy s62_extra_update on public.role_permission_overrides for update to authenticated using (true)$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0431() || $p$;
create policy s62_extra_all on public.user_permission_overrides for all to authenticated using (true)$p$),
  '55000:s62_preflight:public.has_permission(uuid,text) drifted / '
  '55000:s62_preflight:public.has_org_role(uuid,text) drifted / '
  '55000:s62_preflight:public.has_permission(uuid,text) drifted / '
  '55000:s62_preflight:public.role_permission_overrides UPDATE rules / '
  '55000:s62_preflight:public.user_permission_overrides UPDATE rules',
  'A4: on that state each planted drift stops it and is named: either helper''s body, authenticated losing EXECUTE on has_permission, a second UPDATE rule, an ALL rule');

select is(
  pg_temp.ae_locks(null) || ' / ' || pg_temp.ae_locks(pg_temp.mig('$lock_s62$')),
  'none / ' || (select string_agg(x, ',' order by x) from (
                  select 'public.role_permission_overrides' as x
                  union
                  select 'public.user_permission_overrides'
                  union
                  select n.nspname || '.' || c.relname
                    from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                                                            -> current_user::text, '[]'::jsonb)) g(name)
                    join pg_class c on c.oid = to_regclass(g.name)
                    join pg_namespace n on n.oid = c.relnamespace) s),
  'A5: the lock prelude takes ACCESS EXCLUSIVE on the two override tables and on every table supautils.policy_grants lists for this role, at once, and on nothing else');

select * from finish();
rollback;
