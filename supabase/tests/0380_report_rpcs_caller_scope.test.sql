-- supabase/tests/0380_report_rpcs_caller_scope.test.sql
-- pgTAP proof for migration 0380: the six report aggregates answer for the
-- CALLER (their own RLS), not for the whole organization.
--
-- Before 0380, ReportsService called them through the service role, which
-- reads past RLS, so a warehouse-scoped staff member and a category-scoped
-- viewer holding reports:read got organization-wide answers: the SKUs and
-- names of items they cannot read (top movers), other warehouses' losses
-- (shrinkage totals), other warehouses' names (bundle activity).
--
-- S. Structure: plpgsql, STABLE, SECURITY INVOKER, search_path=public and
--    plan_cache_mode=force_custom_plan pinned; EXECUTE for authenticated,
--    never anon or PUBLIC; service_role keeps EXECUTE for the rollout only
--    (the follow-up that revokes it must change this file on purpose); the
--    gates are in every body; nothing writes or raises 40001/40P01.
-- G. Gates: signed out, and any caller with no user that is not the service
--    role (the test superuser included): 42501 unauthenticated. Another
--    org's manager, a disabled member, a viewer without reports:read and a
--    manager with reports:read revoked: the SAME 42501 forbidden. Bundles
--    module off: P0001 module_disabled from the two bundle functions only.
-- U. Unscoped readers: the owner, the manager and a manager of two orgs get
--    answers byte-identical to the service role's (the pre-0380 answer), for
--    every function and window.
-- K. Scoped readers: staff assigned W1 and a viewer assigned W1 + category
--    C1 get only what their own client can read: top movers, shrinkage
--    totals and bundle component value limited to readable items; a
--    warehouse they cannot read has no name in bundle activity. Movement
--    counts and out-movements follow the stock_movements policy
--    (activity_logs:read, or an item in one of the caller's warehouses,
--    checked under the caller's own item RLS, so categories apply too), and
--    bundle runs the member-wide bundle_distributions policy: each equals
--    what the persona's own client reads from those tables.
-- X. Cross-org: a manager of two orgs asking about org A never gets org B's
--    rows, and the service role's org A answer carries none either.
--
-- Roles: fixtures as the test superuser (RLS bypassed); persona calls run as
-- `authenticated` with request.jwt.claim.sub set, through pg_temp wrappers.
-- A persona call is only attempted where authenticated holds EXECUTE (on a
-- schema before 0380 the wrapper answers 'no execute' rather than tripping
-- an EXECUTE denial, which crashes the local macOS stack's backend).
-- begin/rollback: nothing leaks. Namespace 03800000.

begin;
select plan(39);

\set orgA     '\'03800000-0000-0000-0000-00000000000a\''
\set orgB     '\'03800000-0000-0000-0000-00000000000b\''
\set own      '\'03800000-0000-0000-0000-0000000000a0\''
\set mgr      '\'03800000-0000-0000-0000-0000000000a1\''
\set stf      '\'03800000-0000-0000-0000-0000000000a2\''
\set vwr      '\'03800000-0000-0000-0000-0000000000a3\''
\set vwrNoRep '\'03800000-0000-0000-0000-0000000000a4\''
\set mgrNoRep '\'03800000-0000-0000-0000-0000000000a5\''
\set dis      '\'03800000-0000-0000-0000-0000000000a6\''
\set mgrAB    '\'03800000-0000-0000-0000-0000000000a7\''
\set mgrB     '\'03800000-0000-0000-0000-0000000000b1\''
\set W1       '\'03800000-0000-0000-0000-0000000000d1\''
\set W2       '\'03800000-0000-0000-0000-0000000000d2\''
\set WB       '\'03800000-0000-0000-0000-0000000000d3\''
\set C1       '\'03800000-0000-0000-0000-000000000c11\''
\set C2       '\'03800000-0000-0000-0000-000000000c12\''
\set i1       '\'03800000-0000-0000-0000-000000000f01\''
\set i2       '\'03800000-0000-0000-0000-000000000f02\''
\set i3       '\'03800000-0000-0000-0000-000000000f03\''
\set iB       '\'03800000-0000-0000-0000-000000000f0b\''
\set K        '\'03800000-0000-0000-0000-000000000e01\''
\set KB       '\'03800000-0000-0000-0000-000000000e0b\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,      '0380-own@test.local',      '{}'::jsonb),
  (:mgr,      '0380-mgr@test.local',      '{}'::jsonb),
  (:stf,      '0380-stf@test.local',      '{}'::jsonb),
  (:vwr,      '0380-vwr@test.local',      '{}'::jsonb),
  (:vwrNoRep, '0380-vwrnorep@test.local', '{}'::jsonb),
  (:mgrNoRep, '0380-mgrnorep@test.local', '{}'::jsonb),
  (:dis,      '0380-dis@test.local',      '{}'::jsonb),
  (:mgrAB,    '0380-mgrab@test.local',    '{}'::jsonb),
  (:mgrB,     '0380-mgrb@test.local',     '{}'::jsonb)
  on conflict (id) do nothing;

-- An org insert enables the default modules (bundles among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0380 Reports A', '0380-reports-a'),
  (:orgB, '0380 Reports B', '0380-reports-b');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,      'owner',   now()),
  (:orgA, :mgr,      'manager', now()),
  (:orgA, :stf,      'staff',   now()),
  (:orgA, :vwr,      'viewer',  now()),
  (:orgA, :vwrNoRep, 'viewer',  now()),
  (:orgA, :mgrNoRep, 'manager', now()),
  (:orgA, :dis,      'manager', now()),
  (:orgA, :mgrAB,    'manager', now()),
  (:orgB, :mgrAB,    'manager', now()),
  (:orgB, :mgrB,     'manager', now());

insert into public.warehouses (id, organization_id, name, code, status) values
  (:W1, :orgA, '0380 North', 'WH-0380-1', 'active'),
  (:W2, :orgA, '0380 South', 'WH-0380-2', 'active'),
  (:WB, :orgB, '0380 B Main', 'WH-0380-B', 'active');
insert into public.categories (id, organization_id, name) values
  (:C1, :orgA, '0380 Visible'),
  (:C2, :orgA, '0380 Hidden');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,      :W1, true),
  (:orgA, :vwr,      :W1, true),
  (:orgA, :vwrNoRep, :W1, true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwr, :C1);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :vwr,      'reports:read', true),
  (:orgA, :mgrNoRep, 'reports:read', false);

insert into public.inventory_items
  (id, organization_id, warehouse_id, category_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type) values
  (:i1, :orgA, :W1, :C1, 'R0380-1', 'North visible', 100, 10,  'active', 'none'),
  (:i2, :orgA, :W2, :C1, 'R0380-2', 'South secret',  100, 100, 'active', 'none'),
  (:i3, :orgA, :W1, :C2, 'R0380-3', 'North hidden',  100, 1,   'active', 'none'),
  (:iB, :orgB, :WB, null, 'R0380-B', 'Other org',    100, 7,   'active', 'none');

insert into public.bundles (id, organization_id, name, sku) values
  (:K,  :orgA, 'Kit 0380',   'K-0380'),
  (:KB, :orgB, 'Kit 0380 B', 'K-0380-B');
insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, distributed_at) values
  -- South x2 (3 + 4), North x1 (1): top warehouse South, 3 runs, 8 kits.
  (:orgA, :K,  :W2, 3, now() - interval '6 days'),
  (:orgA, :K,  :W2, 4, now() - interval '5 days'),
  (:orgA, :K,  :W1, 1, now() - interval '4 days'),
  (:orgB, :KB, :WB, 9, now() - interval '4 days');

insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, reference_type, reference_id, created_at) values
  (:orgA, :i1, 'add',     20, 0, 20,  null, null, now() - interval '5 days'),
  (:orgA, :i1, 'remove',  -4, 20, 16, null, null, now() - interval '4 days'),
  (:orgA, :i1, 'adjust',  -1, 16, 15, null, null, now() - interval '3 days'),
  (:orgA, :i1, 'add',     999, 0, 999, null, null, now() - interval '40 days'),
  (:orgA, :i2, 'add',     50, 0, 50,  null, null, now() - interval '5 days'),
  (:orgA, :i2, 'remove',  -10, 50, 40, null, null, now() - interval '4 days'),
  (:orgA, :i2, 'adjust',  -2, 40, 38, null, null, now() - interval '3 days'),
  (:orgA, :i3, 'add',     8, 0, 8,    null, null, now() - interval '5 days'),
  (:orgA, :i3, 'adjust',  -3, 8, 5,   null, null, now() - interval '3 days'),
  (:orgA, :i2, 'bundle_distribution', -5, 38, 33, 'bundle', :K, now() - interval '6 days'),
  (:orgA, :i1, 'bundle_distribution', -1, 15, 14, 'bundle', :K, now() - interval '6 days'),
  (:orgB, :iB, 'adjust',  -9, 100, 91, null, null, now() - interval '3 days'),
  (:orgB, :iB, 'bundle_distribution', -2, 91, 89, 'bundle', :KB, now() - interval '4 days');

-- The disabled member, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ── Helpers ──────────────────────────────────────────────────────────────
create temp table fns (fn text primary key, sig regprocedure not null, bundle boolean not null);
insert into fns values
  ('report_movement_type_summary',  'public.report_movement_type_summary(uuid, timestamptz)', false),
  ('report_top_movers',             'public.report_top_movers(uuid, timestamptz, integer)', false),
  ('report_shrinkage_totals',       'public.report_shrinkage_totals(uuid, timestamptz)', false),
  ('report_item_out_movements',     'public.report_item_out_movements(uuid, timestamptz)', false),
  ('report_bundle_activity',        'public.report_bundle_activity(uuid, timestamptz)', true),
  ('report_bundle_component_value', 'public.report_bundle_component_value(uuid, timestamptz)', true);
grant select on fns to authenticated, service_role;

-- One window anchor for the whole file: now() is constant in a transaction.
create function pg_temp.since(p_days int) returns timestamptz language sql stable as
  $$ select now() - make_interval(days => p_days) $$;

-- Switch to a persona (role authenticated with its sub) and back.
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
end $$;
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- One function's whole answer as stable text: every row as jsonb, in the
-- function's own order (top movers is ordered; the rest are sorted here).
create function pg_temp.answer(p_fn text, p_org uuid, p_days int) returns text language plpgsql as $$
declare v text;
begin
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(r) - ''ordinality'' order by %s), ''[]''::jsonb)::text
       from public.%I(%L::uuid, %L::timestamptz) with ordinality r',
    case when p_fn = 'report_top_movers' then 'r.ordinality' else '(to_jsonb(r) - ''ordinality'')::text' end,
    p_fn, p_org, pg_temp.since(p_days))
    into v;
  return v;
end $$;

-- A persona's answer, or 'no execute' where authenticated cannot run it
-- (a schema before 0380), or 'SQLSTATE:hint' when it raises.
create function pg_temp.answer_as(p_user uuid, p_fn text, p_org uuid, p_days int) returns text language plpgsql as $$
declare v text; v_state text; v_hint text;
begin
  if not has_function_privilege('authenticated', (select sig from fns where fn = p_fn), 'execute') then
    return 'no execute';
  end if;
  perform pg_temp.as_user(p_user);
  begin
    v := pg_temp.answer(p_fn, p_org, p_days);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    perform pg_temp.as_owner();
    return v_state || ':' || coalesce(v_hint, '');
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- The service role's answer (no user: the pre-0380 call and the rollout path).
create function pg_temp.answer_svc(p_fn text, p_org uuid, p_days int) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  v := pg_temp.answer(p_fn, p_org, p_days);
  perform set_config('role', 'none', true);
  return v;
end $$;

-- The error a persona's call raises: 'SQLSTATE:hint', 'no error' or 'no execute'.
create function pg_temp.err_as(p_user uuid, p_fn text, p_org uuid) returns text language plpgsql as $$
declare v_state text; v_hint text;
begin
  if not has_function_privilege('authenticated', (select sig from fns where fn = p_fn), 'execute') then
    return 'no execute';
  end if;
  perform pg_temp.as_user(p_user);
  begin
    execute format('select count(*) from public.%I(%L::uuid, %L::timestamptz)', p_fn, p_org, pg_temp.since(30));
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    perform pg_temp.as_owner();
    return v_state || ':' || coalesce(v_hint, '');
  end;
  perform pg_temp.as_owner();
  return 'no error';
end $$;

-- A compact reading of a persona's rows, for the scoped assertions.
create function pg_temp.q(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text; v_state text;
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql into v;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform pg_temp.as_owner();
    return 'ERR ' || v_state;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;
-- q() runs arbitrary reads as a persona; only after 0380 can it reach the
-- report functions (answer_as guards the pre-0380 case for the numbers).
create function pg_temp.q_fn(p_user uuid, p_fn text, p_sql text) returns text language plpgsql as $$
begin
  if not has_function_privilege('authenticated', (select sig from fns where fn = p_fn), 'execute') then
    return 'no execute';
  end if;
  return pg_temp.q(p_user, p_sql);
end $$;

create temp table res (k text primary key, v text);
grant all on res to authenticated, service_role;

-- ══ S. Structure ══════════════════════════════════════════════════════════
select is(
  (select array_agg(f.fn order by f.fn) from fns f join pg_proc p on p.oid = f.sig
     join pg_language l on l.oid = p.prolang
    where l.lanname = 'plpgsql' and p.provolatile = 's' and not p.prosecdef
      and p.proconfig @> array['search_path=public', 'plan_cache_mode=force_custom_plan']),
  (select array_agg(fn order by fn) from fns),
  'S1: all six are plpgsql, STABLE, SECURITY INVOKER, with search_path=public and plan_cache_mode=force_custom_plan pinned');

select is(
  (select array_agg(f.fn order by f.fn) from fns f
    where has_function_privilege('authenticated', f.sig, 'execute')),
  (select array_agg(fn order by fn) from fns),
  'S2: authenticated can execute all six (0380; they were service_role only)');

select is(
  (select count(*) from fns f
    where has_function_privilege('anon', f.sig, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = f.sig and a.grantee = 0 and a.privilege_type = 'EXECUTE')),
  0::bigint,
  'S3: neither anon nor PUBLIC can execute any of the six');

select is(
  (select array_agg(f.fn order by f.fn) from fns f
    where has_function_privilege('service_role', f.sig, 'execute')),
  (select array_agg(fn order by fn) from fns),
  'S4: service_role keeps EXECUTE for the rollout only (the follow-up revoke must change this assertion)');

select ok(
  (select bool_and(p.prosrc ~ 'auth\.uid\(\)'
                   and p.prosrc ~ 'is_org_member\(p_organization_id\)'
                   and p.prosrc ~ $re$has_permission\(p_organization_id, 'reports:read'\)$re$
                   and p.prosrc ~ $re$current_user <> 'service_role'$re$
                   and (not f.bundle or p.prosrc ~ $re$module_enabled\(p_organization_id, 'bundles'\)$re$)
                   and p.prosrc !~ '40001|40P01'
                   and p.prosrc !~* '\m(insert\s+into|update\s+public|delete\s+from|truncate)\M')
     from fns f join pg_proc p on p.oid = f.sig),
  'S5: every body holds its gates (signed in, member with reports:read; bundles module for the bundle pair), writes nothing, never raises 40001/40P01');

-- ══ G. Gates ══════════════════════════════════════════════════════════════
-- Signed out: role authenticated with no sub.
select is(
  (select array_agg(distinct pg_temp.err_as(null, fn, :orgA)) from fns),
  array['42501:unauthenticated'],
  'G1: signed out (authenticated, no user): every function raises 42501 unauthenticated');

-- A caller with no user that is not the service role (here the test superuser).
do $$
declare v_state text; v_hint text; r text := '';
begin
  -- As the table owner (superuser), no claims.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  begin
    perform count(*) from public.report_top_movers('03800000-0000-0000-0000-00000000000a'::uuid, now() - interval '30 days', 50);
    r := 'no error';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    r := v_state || ':' || coalesce(v_hint, '');
  end;
  insert into res values ('G2', r);
end $$;
select is((select v from res where k = 'G2'), '42501:unauthenticated',
  'G2: with no user, only the service role is answered: the superuser gets 42501 unauthenticated');

select is(
  (select array_agg(distinct pg_temp.err_as(u, fn, :orgA))
     from fns, unnest(array[:mgrB, :dis, :vwrNoRep, :mgrNoRep]::uuid[]) u),
  array['42501:forbidden'],
  'G3: another org''s manager, a disabled member, a viewer without reports:read and a manager with reports:read revoked: the SAME 42501 forbidden from all six');

select is(
  (select array_agg(distinct pg_temp.err_as(u, fn, :orgA))
     from fns, unnest(array[:own, :mgr, :stf, :vwr, :mgrAB]::uuid[]) u),
  array['no error'],
  'G4: the owner, the manager, staff, the reports:read viewer and a two-org manager are answered');

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'bundles';
select is(
  (select array_agg(fn || '=' || pg_temp.err_as(:mgr, fn, :orgA) order by fn) from fns),
  array['report_bundle_activity=P0001:module_disabled',
        'report_bundle_component_value=P0001:module_disabled',
        'report_item_out_movements=no error',
        'report_movement_type_summary=no error',
        'report_shrinkage_totals=no error',
        'report_top_movers=no error'],
  'G5: bundles module off: the two bundle functions raise P0001 module_disabled, the other four still answer');
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'bundles';

select isnt(
  pg_temp.answer_svc('report_top_movers', :orgA, 30),
  '[]',
  'G6: the service role (no user) is still answered during the rollout');

-- ══ U. Unscoped readers: byte-identical to the service role ═══════════════
select is(
  (select array_agg(fn || '@' || d order by fn, d) from fns, unnest(array[30, 90, 365]) d
    where pg_temp.answer_as(:mgr, fn, :orgA, d) is distinct from pg_temp.answer_svc(fn, :orgA, d)),
  null::text[],
  'U1: the manager''s answer equals the service role''s for all six functions at 30, 90 and 365 days');
select is(
  (select array_agg(fn || '@' || d order by fn, d) from fns, unnest(array[30, 90, 365]) d
    where pg_temp.answer_as(:own, fn, :orgA, d) is distinct from pg_temp.answer_svc(fn, :orgA, d)),
  null::text[],
  'U2: the owner''s answer equals the service role''s for all six functions at 30, 90 and 365 days');
select is(
  (select array_agg(fn || '@' || d order by fn, d) from fns, unnest(array[30, 90, 365]) d
    where pg_temp.answer_as(:mgrAB, fn, :orgA, d) is distinct from pg_temp.answer_svc(fn, :orgA, d)),
  null::text[],
  'U3: a manager of two orgs asking about org A gets the service role''s org A answer, exactly');

-- The numbers themselves (the manager), so U1-U3 cannot pass on two empty answers.
select is(pg_temp.answer_as(:mgr, 'report_top_movers', :orgA, 30),
  format('[{"sku": "R0380-2", "name": "South secret", "item_id": "%s", "total_in": 50.0000, "total_out": 17.0000, "movement_count": 4}, '
         '{"sku": "R0380-1", "name": "North visible", "item_id": "%s", "total_in": 20.0000, "total_out": 6.0000, "movement_count": 4}, '
         '{"sku": "R0380-3", "name": "North hidden", "item_id": "%s", "total_in": 8.0000, "total_out": 3.0000, "movement_count": 2}]',
         :i2, :i1, :i3),
  'U4: manager top movers: South secret 50/17/4, North visible 20/6/4, North hidden 8/3/2 (the 40-day add excluded)');
select is(pg_temp.answer_as(:mgr, 'report_shrinkage_totals', :orgA, 30),
  '[{"total_cost": 213.00000000, "total_units": 6.0000}]',
  'U5: manager shrinkage: 6 units, 213 (1x10 + 2x100 + 3x1)');
select is(pg_temp.answer_as(:mgr, 'report_bundle_component_value', :orgA, 30),
  format('[{"bundle_id": "%s", "component_value_out": 510.00000000}]', :K),
  'U6: manager bundle component value: 510 (5x100 + 1x10)');
select is(
  pg_temp.q_fn(:mgr, 'report_bundle_activity', format(
    $s$select string_agg(bundle_sku || ' ' || runs || '/' || kits_out || ' ' || coalesce(top_warehouse_name, '-'), '; ')
         from public.report_bundle_activity(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  'K-0380 3/8.0000 0380 South',
  'U7: manager bundle activity: K-0380 3 runs, 8 kits, top warehouse 0380 South');
select is(
  pg_temp.q_fn(:mgr, 'report_movement_type_summary', format(
    $s$select string_agg(movement_type || ' ' || movement_count || '/' || total_qty, '; ' order by movement_type)
         from public.report_movement_type_summary(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  'add 3/78.0000; adjust 3/6.0000; bundle_distribution 2/6.0000; remove 2/14.0000',
  'U8: manager movement types: add 3/78, adjust 3/6, bundle_distribution 2/6, remove 2/14');

-- ══ K. Scoped readers ═════════════════════════════════════════════════════
-- Staff assigned W1: i1 and i3 (both in W1). Not i2 (W2).
select is(
  pg_temp.q_fn(:stf, 'report_top_movers', format(
    $s$select string_agg(sku, ',' order by sku) from public.report_top_movers(%L::uuid, %L::timestamptz, 50)$s$, :orgA, pg_temp.since(30))),
  'R0380-1,R0380-3',
  'K1: staff (W1) top movers: only W1 items; the South item''s SKU and name are gone');
select is(pg_temp.answer_as(:stf, 'report_shrinkage_totals', :orgA, 30),
  '[{"total_cost": 13.00000000, "total_units": 4.0000}]',
  'K2: staff shrinkage: 4 units, 13 (W1 only; was 6 / 213 org-wide)');
select is(pg_temp.answer_as(:stf, 'report_bundle_component_value', :orgA, 30),
  format('[{"bundle_id": "%s", "component_value_out": 10.00000000}]', :K),
  'K3: staff bundle component value: 10 (the W1 draw only; was 510)');
select is(
  pg_temp.q_fn(:stf, 'report_bundle_activity', format(
    $s$select string_agg(bundle_sku || ' ' || runs || '/' || kits_out || ' ' || coalesce(top_warehouse_name, '-'), '; ')
         from public.report_bundle_activity(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  'K-0380 3/8.0000 -',
  'K4: staff bundle activity: runs and kits follow bundle_distributions (member-wide), but the South warehouse''s name is not given');

-- Viewer assigned W1 + category C1: i1 only among items.
select is(
  pg_temp.q_fn(:vwr, 'report_top_movers', format(
    $s$select string_agg(sku, ',' order by sku) from public.report_top_movers(%L::uuid, %L::timestamptz, 50)$s$, :orgA, pg_temp.since(30))),
  'R0380-1',
  'K5: category-scoped viewer top movers: only the W1 + C1 item (not the other warehouse''s, not the hidden category''s)');
select is(pg_temp.answer_as(:vwr, 'report_shrinkage_totals', :orgA, 30),
  '[{"total_cost": 10.00000000, "total_units": 1.0000}]',
  'K6: viewer shrinkage: 1 unit, 10');
select is(pg_temp.answer_as(:vwr, 'report_bundle_component_value', :orgA, 30),
  format('[{"bundle_id": "%s", "component_value_out": 10.00000000}]', :K),
  'K7: viewer bundle component value: 10');
select is(
  pg_temp.q_fn(:vwr, 'report_bundle_activity', format(
    $s$select string_agg(bundle_sku || ' ' || coalesce(top_warehouse_name, '-'), '; ')
         from public.report_bundle_activity(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  'K-0380 -',
  'K8: viewer bundle activity: no name for a warehouse the viewer cannot read');

-- Movement counts and out-movements follow the stock_movements policy
-- (activity_logs:read, or an item in one of the caller's warehouses; the
-- item check itself runs under the caller's item RLS, so a hidden category
-- is out too): each equals what the persona's own client reads from
-- stock_movements.
select is(
  pg_temp.q_fn(:stf, 'report_movement_type_summary', format(
    $s$select (select string_agg(movement_type || ' ' || movement_count || '/' || total_qty, '; ' order by movement_type)
                 from public.report_movement_type_summary(%L::uuid, %L::timestamptz))
             = (select string_agg(movement_type || ' ' || c || '/' || q, '; ' order by movement_type) from (
                  select movement_type, count(*) c, coalesce(sum(abs(coalesce(quantity_change, 0))), 0)::numeric q
                    from public.stock_movements where organization_id = %L and created_at >= %L::timestamptz
                   group by movement_type) s)$s$,
    :orgA, pg_temp.since(30), :orgA, pg_temp.since(30))),
  'true',
  'K9: staff movement types equal the staff member''s own stock_movements rows (W1 only)');
select is(
  pg_temp.q_fn(:vwr, 'report_movement_type_summary', format(
    $s$select string_agg(movement_type || ' ' || movement_count || '/' || total_qty, '; ' order by movement_type)
         from public.report_movement_type_summary(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  'add 1/20.0000; adjust 1/1.0000; bundle_distribution 1/1.0000; remove 1/4.0000',
  'K10: viewer movement types: only the W1 + C1 item''s movements (the policy''s item check runs under the viewer''s own item RLS, so the hidden category is out too)');
select is(
  pg_temp.q_fn(:vwr, 'report_item_out_movements', format(
    $s$select string_agg(item_id::text || '=' || units_out, ',' order by item_id)
         from public.report_item_out_movements(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  format('%s=6.0000', :i1),
  'K11: viewer out-movements: the one readable item only (the South and hidden-category ids are gone)');
select is(
  pg_temp.q_fn(:stf, 'report_item_out_movements', format(
    $s$select string_agg(item_id::text || '=' || units_out, ',' order by item_id)
         from public.report_item_out_movements(%L::uuid, %L::timestamptz)$s$, :orgA, pg_temp.since(30))),
  format('%s=6.0000,%s=3.0000', :i1, :i3),
  'K12: staff out-movements: W1 items only, and a readable item keeps every one of its out-movements (6 for North visible)');

-- The leak itself, pinned: the service role (the pre-0380 call) still hands
-- out the South item, so K1-K12 are the policies at work, not empty fixtures.
select ok(
  pg_temp.answer_svc('report_top_movers', :orgA, 30) ~ 'South secret'
  and pg_temp.answer_svc('report_bundle_activity', :orgA, 30) ~ '0380 South',
  'K13: CONTROL: the organization-wide answer (service role) carries the South item and warehouse');

-- ══ X. Cross-org ══════════════════════════════════════════════════════════
select ok(
  not (pg_temp.answer_as(:mgrAB, 'report_top_movers', :orgA, 365) ~ 'R0380-B')
  and not (pg_temp.answer_as(:mgrAB, 'report_bundle_activity', :orgA, 365) ~ 'K-0380-B')
  and not (pg_temp.answer_svc('report_shrinkage_totals', :orgA, 365) ~ '"total_units": 15'),
  'X1: org A answers never carry org B rows, for a two-org manager or the service role');
select is(
  pg_temp.q_fn(:mgrAB, 'report_top_movers', format(
    $s$select string_agg(sku, ',') from public.report_top_movers(%L::uuid, %L::timestamptz, 50)$s$, :orgB, pg_temp.since(30))),
  'R0380-B',
  'X2: the same manager asking about org B gets org B only');
select is(
  pg_temp.err_as(:mgrB, 'report_top_movers', :orgA),
  '42501:forbidden',
  'X3: a manager of org B only is refused org A');

-- Nothing here writes: the fixture counts are unchanged.
select is(
  (select count(*) from public.stock_movements where organization_id in (:orgA, :orgB)),
  13::bigint,
  'W1: no function wrote a movement');

-- Signed-in persona inside the org, direct own-client read, as a control
-- that the persona helpers really switch the role (not the superuser).
select is(
  pg_temp.q(:vwr, format($s$select count(*)::text from public.inventory_items where organization_id = %L$s$, :orgA)),
  '1',
  'CONTROL: the viewer''s own client reads exactly one org A item');
select is(
  pg_temp.q(:stf, format($s$select count(*)::text from public.inventory_items where organization_id = %L$s$, :orgA)),
  '2',
  'CONTROL: the staff member''s own client reads exactly two org A items');

-- 0225's contract that stays: anon never, search_path pinned.
select is(
  (select count(*) from fns f join pg_proc p on p.oid = f.sig where p.proconfig @> array['search_path=public']),
  6::bigint,
  'S6: search_path=public on all six (0225)');

select * from finish();
rollback;
