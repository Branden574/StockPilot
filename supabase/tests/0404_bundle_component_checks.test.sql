-- supabase/tests/0404_bundle_component_checks.test.sql
-- pgTAP proof for migration 0404 (docket S4, with S9's bundle component
-- organization check): kits are made only from their own organization's
-- items, never from nothing, and only by the people the app lets make or hand
-- them out. Run against the pre-0404 schema (head 0401, scratch stack,
-- 2026-10-24) it fails 26 of its 54: every refusal (X1-X4, X8, O1, O3, K1,
-- K3, K4, D1, C1, C3, C4), every text and replay check (R1, R3, P2, P3, A1-A5,
-- H1, H2) and M8 (no guard to drop). What passes there too is meant to: the
-- normal paths (X5-X7, K2, C2, C5, D2, D3), the answers 0404 keeps (O2, K5,
-- K6), the fixture, posture and census checks (F, R2, P1, H3, G1, G2, Z1),
-- and the M section, which runs the old text on purpose.
--
-- Personas (organization A, plus organization B for the foreign checks):
--   own    owner                    adm    admin
--   admM   admin, bundles:manage revoked
--   mgr    manager, no override     mgrM   manager, bundles:manage revoked
--   mgrD   manager, bundles:distribute revoked (schedule:manage kept)
--   mgrDS  manager, bundles:distribute and schedule:manage revoked
--   stf    staff (default set, which holds bundles:distribute)
--   vwr    viewer (no bundles:distribute)
--   two    a manager of both organizations    outB  a manager of B only
--
-- F.  The fixture is what the matrices assume.
-- R.  One change per body: md5(prosrc) is 0404's, removing the lines tagged
--     '-- 0404' gives the pre-0404 body exactly, arguments and results are
--     unchanged, and the ledger.* fingerprint 0383 and 0385 pin moves by those
--     two bodies alone.
-- P.  Posture: SECURITY mode, SET clauses, owner and EXECUTE of the restated
--     functions and the two helpers they use; the wrapper's comment; the
--     guard trigger.
-- X.  No kit from nothing: a bundle with no component, or with optional ones
--     only, is refused by assembly and by a distribution built from
--     components, and the optional draw is undone with the refusal; kits are
--     still assembled and handed out as before (with a shortage too), and
--     pre-assembled kits still go out from a bundle with no component.
-- O.  Organization checks inside the kit functions: a component of another
--     organization is refused by whoever can see it (before 0404 the kit went
--     out without it: M3); one the caller cannot see answers as before; a
--     named event must be the kit organization's.
-- K.  The distribute_bundle gate: the persona matrix, the Schedule
--     completion arm and each of its terms, a call inside another ledger
--     call, the admin client, and assembly still answering to bundles:manage.
-- D.  bundle_distributions is written only by distribute_bundle: a raw
--     insert by a signed-in user is refused (ledger_only), the admin client
--     is not held, and an event delete still clears a distribution's link.
-- C.  The policies: a component must be an item of the bundle's
--     organization, component and bundle writes follow bundles:manage, a
--     foreign component row can still be deleted, other roles unchanged.
-- M.  Each fix, removed inside an undone subtransaction, lets its probe
--     through again (the pre-0404 behavior, reproduced on the old text).
-- A.  The migration's own preflight and lock prelude, replayed from the
--     statements the CLI recorded: the preflight refuses a second run, passes
--     on the pre-0404 state, and names a planted drift; the prelude takes the
--     three table locks.
-- H.  The four policies' text: 0140's with the terms added and nothing else.
-- G.  No function here raises 40001 or 40P01, and distribute_bundle's body is
--     the only function that writes bundle_distributions.
-- Z.  Every undone attempt changed nothing.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction (the 0387 helpers, as 0395 uses them),
-- so pgTAP's own statements never run as an API role. begin/rollback: nothing
-- leaks. Namespace 04040000.

begin;

select plan(54);

\set orgA    '\'04040000-0000-0000-0000-00000000000a\''
\set orgB    '\'04040000-0000-0000-0000-00000000000b\''
\set own     '\'04040000-0000-0000-0000-0000000000a0\''
\set adm     '\'04040000-0000-0000-0000-0000000000a1\''
\set admM    '\'04040000-0000-0000-0000-0000000000a2\''
\set mgr     '\'04040000-0000-0000-0000-0000000000a3\''
\set mgrM    '\'04040000-0000-0000-0000-0000000000a4\''
\set mgrD    '\'04040000-0000-0000-0000-0000000000a5\''
\set mgrDS   '\'04040000-0000-0000-0000-0000000000a6\''
\set stf     '\'04040000-0000-0000-0000-0000000000a7\''
\set vwr     '\'04040000-0000-0000-0000-0000000000a8\''
\set two     '\'04040000-0000-0000-0000-0000000000a9\''
\set outB    '\'04040000-0000-0000-0000-0000000000b1\''
\set whA     '\'04040000-0000-0000-0000-0000000000d1\''
\set whA2    '\'04040000-0000-0000-0000-0000000000d2\''
\set whB     '\'04040000-0000-0000-0000-0000000000d3\''
\set itA1    '\'04040000-0000-0000-0000-0000000000e1\''
\set itA2    '\'04040000-0000-0000-0000-0000000000e2\''
\set itO     '\'04040000-0000-0000-0000-0000000000e3\''
\set itPh    '\'04040000-0000-0000-0000-0000000000e4\''
\set itB     '\'04040000-0000-0000-0000-0000000000e5\''
\set bnOk    '\'04040000-0000-0000-0000-0000000000f1\''
\set bnEmpty '\'04040000-0000-0000-0000-0000000000f2\''
\set bnOpt   '\'04040000-0000-0000-0000-0000000000f3\''
\set bnX     '\'04040000-0000-0000-0000-0000000000f4\''
\set bnXo    '\'04040000-0000-0000-0000-0000000000f5\''
\set bnPh    '\'04040000-0000-0000-0000-0000000000f6\''
\set evDone  '\'04040000-0000-0000-0000-000000000101\''
\set evOpen  '\'04040000-0000-0000-0000-000000000102\''
\set evOther '\'04040000-0000-0000-0000-000000000103\''
\set evDel   '\'04040000-0000-0000-0000-000000000104\''
\set evB     '\'04040000-0000-0000-0000-000000000105\''
\set evNone  '\'04040000-0000-0000-0000-0000000001ff\''
\set dFix    '\'04040000-0000-0000-0000-000000000201\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0404-own@test.local',   '{}'::jsonb),
  (:adm,   '0404-adm@test.local',   '{}'::jsonb),
  (:admM,  '0404-admm@test.local',  '{}'::jsonb),
  (:mgr,   '0404-mgr@test.local',   '{}'::jsonb),
  (:mgrM,  '0404-mgrm@test.local',  '{}'::jsonb),
  (:mgrD,  '0404-mgrd@test.local',  '{}'::jsonb),
  (:mgrDS, '0404-mgrds@test.local', '{}'::jsonb),
  (:stf,   '0404-stf@test.local',   '{}'::jsonb),
  (:vwr,   '0404-vwr@test.local',   '{}'::jsonb),
  (:two,   '0404-two@test.local',   '{}'::jsonb),
  (:outB,  '0404-outb@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0404 Kits A', '0404-kits-a'),
  (:orgB, '0404 Kits B', '0404-kits-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :adm,   'admin',   now()),
  (:orgA, :admM,  'admin',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :mgrM,  'manager', now()),
  (:orgA, :mgrD,  'manager', now()),
  (:orgA, :mgrDS, 'manager', now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :two,   'manager', now()),
  (:orgB, :two,   'manager', now()),
  (:orgB, :outB,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0404 Main',  'WH-0404A',  'active'),
  (:whA2, :orgA, '0404 Annex', 'WH-0404A2', 'active'),
  (:whB,  :orgB, '0404 Bee',   'WH-0404B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf, :whA, true),
  (:orgA, :vwr, :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :admM,  'bundles:manage',     false),
  (:orgA, :mgrM,  'bundles:manage',     false),
  (:orgA, :mgrD,  'bundles:distribute', false),
  (:orgA, :mgrDS, 'bundles:distribute', false),
  (:orgA, :mgrDS, 'schedule:manage',    false);
-- The Bundles and Schedule modules on for A, whatever the new-org seed did.
insert into public.organization_modules (organization_id, module_id, tier, enabled) values
  (:orgA, 'bundles',  'optional', true),
  (:orgA, 'schedule', 'optional', true)
  on conflict (organization_id, module_id) do update set enabled = true;

-- Opening stock lands in each warehouse's Unplaced bucket (tg_seed_initial_level).
-- itPh is bnPh's kit item holding 3 pre-assembled kits. itB is B's item, in
-- B's warehouse: a manager of both organizations can see it, a manager of A
-- only cannot.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, is_bundle) values
  (:itA1, :orgA, :whA, '0404-A1',          'Kit part one 0404',              100, 'active', 'none', false),
  (:itA2, :orgA, :whA, '0404-A2',          'Kit part two 0404',              100, 'active', 'none', false),
  (:itO,  :orgA, :whA, '0404-O',           'Optional part 0404',              10, 'active', 'none', false),
  (:itPh, :orgA, :whA, '__BUNDLE__0404ph', 'Pre-assembled kit 0404',           3, 'active', 'none', true),
  (:itB,  :orgB, :whB, '0404-B',           'Org B part 0404',                 10, 'active', 'none', false);

-- bnOk: 1 x A1 + 2 x A2, and 1 x O optional. bnEmpty: no component. bnOpt:
-- the optional part only. bnX and bnXo carry a component row naming B's item
-- (required in bnX, optional in bnXo), planted as the superuser the way a
-- pre-0404 REST insert left one. bnPh: no component, 3 kits pre-assembled.
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled, phantom_item_id) values
  (:bnOk,    :orgA, 'Kit 0404',                    'KIT-0404-OK', true, true, null),
  (:bnEmpty, :orgA, 'Empty kit 0404',              'KIT-0404-E',  true, true, null),
  (:bnOpt,   :orgA, 'Optional-only kit 0404',      'KIT-0404-O',  true, true, null),
  (:bnX,     :orgA, 'Planted kit 0404',            'KIT-0404-X',  true, true, null),
  (:bnXo,    :orgA, 'Planted optional kit 0404',   'KIT-0404-XO', true, true, null),
  (:bnPh,    :orgA, 'Pre-assembled kit 0404',      'KIT-0404-PH', true, true, :itPh);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  (:bnOk,  :itA1, 1, false),
  (:bnOk,  :itA2, 2, false),
  (:bnOk,  :itO,  1, true),
  (:bnOpt, :itO,  1, true),
  (:bnX,   :itA1, 1, false),
  (:bnX,   :itB,  1, false),
  (:bnXo,  :itA1, 1, false),
  (:bnXo,  :itB,  1, true);

-- evDone: a completed event handing out 1 x bnOk from whA (what the Schedule
-- saves before it calls distribute_bundle). evOpen: the same, in progress.
-- evOther: completed, another kit. evDel: completed, named by the fixture
-- distribution dFix. evB: B's completed event.
insert into public.schedule_events
  (id, organization_id, title, starts_at, warehouse_id, status, bundle_id, bundle_quantity, bundle_warehouse_id, created_by, updated_by) values
  (:evDone,  :orgA, 'Kit day 0404',         now() - interval '1 hour',  :whA, 'completed',   :bnOk,  1,    :whA, :mgr,  :mgr),
  (:evOpen,  :orgA, 'Open kit day 0404',    now() + interval '1 hour',  :whA, 'in_progress', :bnOk,  1,    :whA, :mgr,  :mgr),
  (:evOther, :orgA, 'Other kit day 0404',   now() - interval '2 hours', :whA, 'completed',   :bnOpt, 1,    :whA, :mgr,  :mgr),
  (:evDel,   :orgA, 'Deleted kit day 0404', now() - interval '3 hours', :whA, 'completed',   null,   null, null, :mgr,  :mgr),
  (:evB,     :orgB, 'Org B day 0404',       now() - interval '1 hour',  :whB, 'completed',   null,   null, null, :outB, :outB);
insert into public.bundle_distributions (id, organization_id, bundle_id, warehouse_id, quantity, schedule_event_id, notes, distributed_by)
values (:dFix, :orgA, :bnOk, :whA, 1, :evDel, '0404 fixture', :mgr);

-- ══ Helpers (0387's, as 0395 uses them) ═══════════════════════════════════
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_prep and p_check as the superuser, inside the undone
-- subtransaction), else '<sqlstate>:<hint or ->:<message>'.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX404', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX404' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('admM', :admM), ('mgr', :mgr), ('mgrM', :mgrM), ('mgrD', :mgrD),
  ('mgrDS', :mgrDS), ('stf', :stf), ('vwr', :vwr), ('two', :two), ('outB', :outB);
-- The same statement for each named persona, in the order given, each call
-- undone: 'who=<attempt>, who=<attempt>, ...'.
create function pg_temp.each(p_who text[], p_sql text, p_check text default null, p_prep text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w), p_sql, p_prep, p_check);
  end loop;
  return v;
end $$;
create function pg_temp.perm(p_who text, p_perm text) returns text language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub', (select p.id::text from persona p where p.who = p_who), true);
  v := public.has_permission('04040000-0000-0000-0000-00000000000a', p_perm);
  perform set_config('request.jwt.claim.sub', '', true);
  return p_who || ':' || p_perm || '=' || v::text;
end $$;
-- A definition with every line tagged '-- 0404' removed: the pre-0404
-- function, recreated inside an undone subtransaction by the M and A checks.
create function pg_temp.stripped(p_sig text) returns text language sql stable as $$
  select regexp_replace(pg_get_functiondef(to_regprocedure(p_sig)), E'\n[^\n]*-- 0404[^\n]*', '', 'g')
$$;

-- The pre-0404 state, statement by statement: the three bodies without
-- their 0404 lines, the four policies as 0140 wrote them, no guard trigger.
create temp table pre404 (k text primary key, stmt text not null);
insert into pre404 (k, stmt) values
  ('fn_assemble',   pg_temp.stripped('ledger.assemble_bundle(uuid,numeric,uuid,text)')),
  ('fn_distribute', pg_temp.stripped('ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)')),
  ('fn_wrapper',    pg_temp.stripped('public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)')),
  ('pol_components', $s$alter policy bundle_components_write on public.bundle_components
  using (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.has_org_role(b.organization_id, 'manager'))
    )
  )
  with check (
    exists (
      select 1 from public.bundles b
      where b.id = bundle_components.bundle_id
        and (SELECT public.has_org_role(b.organization_id, 'manager'))
    )
  )$s$),
  ('pol_insert', $s$alter policy bundles_insert on public.bundles
  with check ((SELECT public.has_org_role(organization_id, 'manager')))$s$),
  ('pol_update', $s$alter policy bundles_update on public.bundles
  with check ((SELECT public.has_org_role(organization_id, 'manager')))$s$),
  ('pol_delete', $s$alter policy bundles_delete on public.bundles
  using ((SELECT public.has_org_role(organization_id, 'admin')))$s$),
  ('trigger', 'drop trigger trg_zz_bundle_distributions_guard on public.bundle_distributions');
create function pg_temp.pre(p_keys text[]) returns text language sql stable as $$
  select string_agg(p.stmt, E';\n' order by k.o)
    from unnest(p_keys) with ordinality k(key, o)
    join pre404 p on p.k = k.key
$$;

-- The statements the CLI recorded for 0404 that contain p_tag (0392's).
create function pg_temp.mig(p_version text, p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = p_version and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_version text, p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = p_version and position(p_tag in st) > 0
$$;
-- 0404's preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and the names its message reports, sorted.
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('0404', '$pre404$');
    raise exception using errcode = 'XX404', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX404' then
    return 'ok';
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':'
         || coalesce((select string_agg(m[1] || ' ' || m[2], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '([^ ;]+) (drifted|missing|already exists)', 'g') m), v_msg);
end $$;
-- The table locks this backend holds on the three kit tables after p_sql,
-- ALWAYS undone (the locks go with the subtransaction).
create function pg_temp.locks_after(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_sql is not null then
      execute p_sql;
    end if;
    select string_agg(c.relname || '=' || l.mode, ', ' order by c.relname, l.mode) into v
      from pg_locks l join pg_class c on c.oid = l.relation
     where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
       and c.relnamespace = 'public'::regnamespace
       and c.relname in ('bundles', 'bundle_components', 'bundle_distributions')
       and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock');
    raise exception using errcode = 'XX404', message = 'undo';
  exception when sqlstate 'XX404' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

-- ══ F. The fixture is what the matrices assume ════════════════════════════
select is(
  pg_temp.perm('admM', 'bundles:manage') || ' ' || pg_temp.perm('admM', 'bundles:distribute') || ' '
  || pg_temp.perm('mgrM', 'bundles:manage') || ' ' || pg_temp.perm('mgrM', 'bundles:distribute') || ' '
  || pg_temp.perm('mgrD', 'bundles:distribute') || ' ' || pg_temp.perm('mgrD', 'schedule:manage') || ' '
  || pg_temp.perm('mgrD', 'bundles:manage') || ' '
  || pg_temp.perm('mgrDS', 'bundles:distribute') || ' ' || pg_temp.perm('mgrDS', 'schedule:manage') || ' '
  || pg_temp.perm('mgr', 'bundles:distribute') || ' ' || pg_temp.perm('stf', 'bundles:distribute') || ' '
  || pg_temp.perm('stf', 'bundles:manage') || ' ' || pg_temp.perm('vwr', 'bundles:distribute') || ' '
  || pg_temp.perm('two', 'bundles:manage'),
  'admM:bundles:manage=false admM:bundles:distribute=true mgrM:bundles:manage=false mgrM:bundles:distribute=true '
  'mgrD:bundles:distribute=false mgrD:schedule:manage=true mgrD:bundles:manage=true '
  'mgrDS:bundles:distribute=false mgrDS:schedule:manage=false mgr:bundles:distribute=true stf:bundles:distribute=true '
  'stf:bundles:manage=false vwr:bundles:distribute=false two:bundles:manage=true',
  'F1: the personas hold what the matrices assume (the revoked admin and managers, staff holding bundles:distribute without bundles:manage, a viewer without either, the two-organization manager)');
select is(
  (select string_agg(i.sku || '=' || i.quantity_on_hand::int || '/' || coalesce((select sum(l.quantity)::int from public.item_stock_levels l where l.item_id = i.id), 0), ' ' order by i.sku collate "C")
     from public.inventory_items i where i.id in (:itA1, :itA2, :itO, :itPh, :itB))
  || ' ' || public.module_enabled(:orgA, 'bundles')::text || '/' || public.module_enabled(:orgA, 'schedule')::text,
  '0404-A1=100/100 0404-A2=100/100 0404-B=10/10 0404-O=10/10 __BUNDLE__0404ph=3/3 true/true',
  'F2: stock on record equals the holdings for every fixture item, B''s included, and the Bundles and Schedule modules are on for A');
select is(
  (select string_agg(b.sku || '=' || coalesce((select string_agg(i.sku || case when c.is_optional then '?' else '' end, '+' order by i.sku collate "C")
                                                 from public.bundle_components c join public.inventory_items i on i.id = c.item_id
                                                where c.bundle_id = b.id), '-'), ' ' order by b.sku collate "C")
     from public.bundles b where b.organization_id = :orgA),
  'KIT-0404-E=- KIT-0404-O=0404-O? KIT-0404-OK=0404-A1+0404-A2+0404-O? KIT-0404-PH=- KIT-0404-X=0404-A1+0404-B KIT-0404-XO=0404-A1+0404-B?',
  'F3: the kits are as described: none of bnEmpty and bnPh''s components, bnOpt''s only optional, and the planted rows naming B''s item');

-- Everything below must leave this unchanged (Z1): every attempt is undone.
create function pg_temp.state() returns text language sql stable as $$
  select (select md5(string_agg(i.id::text || ':' || i.quantity_on_hand::text || ':' || coalesce(i.deleted_at::text, ''), ',' order by i.id))
            from public.inventory_items i
           where i.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select coalesce(sum(l.quantity), 0)::text from public.item_stock_levels l
                  where l.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select count(*) from public.stock_movements m
                  where m.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select md5(string_agg(d.id::text || coalesce(d.schedule_event_id::text, ''), ',' order by d.id)) from public.bundle_distributions d
                  where d.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select md5(string_agg(b.id::text || b.name || b.is_active::text || coalesce(b.phantom_item_id::text, ''), ',' order by b.id))
                   from public.bundles b
                  where b.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select md5(string_agg(c.bundle_id::text || c.item_id::text || c.quantity::text || c.is_optional::text, ',' order by c.bundle_id, c.item_id))
                   from public.bundle_components c join public.bundles b on b.id = c.bundle_id
                  where b.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select md5(string_agg(e.id::text || e.status, ',' order by e.id)) from public.schedule_events e
                  where e.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select count(*) from public.notifications n
                  where n.organization_id in ('04040000-0000-0000-0000-00000000000a', '04040000-0000-0000-0000-00000000000b'))
      || '|' || (select md5(string_agg(m.module_id || m.enabled::text, ',' order by m.module_id)) from public.organization_modules m
                  where m.organization_id = '04040000-0000-0000-0000-00000000000a')
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ R. One change per body ═══════════════════════════════════════════════
select is(
  (select string_agg(v.fn || '=' || md5(p.prosrc) || '|' || md5(regexp_replace(p.prosrc, E'\n[^\n]*-- 0404[^\n]*', '', 'g'))
                     || '|' || (select count(*) from regexp_matches(p.prosrc, '-- 0404', 'g'))::text, E'\n' order by v.n)
     from (values (1, 'ledger.assemble_bundle(uuid,numeric,uuid,text)'),
                  (2, 'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  (3, 'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)')) v(n, fn)
     join pg_proc p on p.oid = to_regprocedure(v.fn)),
  E'ledger.assemble_bundle(uuid,numeric,uuid,text)=e19c6fcd92ee9edd4846f9fc12ab60f5|a2967a282fbdf76c10c2808f35760973|12\n'
  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)=71515ab72a12abc128b82fe2bf684d5c|d78bf6b0471c49981b6a8df064e6b895|18\n'
  'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)=4b731f8a78341906009971d042f5ed56|f0ef2bde4103221457cf632769ce36c7|22',
  'R1: each restated body has 0404''s text, and removing its lines tagged -- 0404 (12, 18 and 22) gives the pre-0404 body exactly (the 0373 bodies a2967a28 and d78bf6b0, the 0359 wrapper f0ef2bde): the added lines are the only change');
select is(
  (select string_agg(pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid), E'\n' order by v.n)
     from (values (1, 'ledger.assemble_bundle(uuid,numeric,uuid,text)'),
                  (2, 'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  (3, 'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)')) v(n, fn)
     join pg_proc p on p.oid = to_regprocedure(v.fn)),
  E'p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text DEFAULT NULL::text -> TABLE(phantom_item_id uuid, phantom_qty numeric)\n'
  'p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text -> uuid\n'
  'p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text -> uuid',
  'R2: arguments, defaults and results are unchanged (installed phones call the wrapper by name with these arguments)');
-- 0383 Z2 and 0385 Z2 pin a fingerprint of every ledger.* function (their
-- query, verbatim). 0404 re-pins both; this shows the new value moves from the
-- old one by the two restated bodies alone.
create function pg_temp.ledger_fp() returns text language sql stable as $$
  select md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ledger'
$$;
create function pg_temp.ledger_fp_after(p_prep text) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute p_prep;
    v := pg_temp.ledger_fp();
    raise exception using errcode = 'XX404', message = 'undo';
  exception when sqlstate 'XX404' then
    null;
  end;
  return v;
end $$;
select is(
  pg_temp.ledger_fp() || ' / ' || pg_temp.ledger_fp_after(pg_temp.pre(array['fn_assemble', 'fn_distribute'])),
  '50660ce2baefc2f2d345a9468b42fc46|18 / 1c283e932202295a91e5c118f0873689|18',
  'R3: the ledger.* fingerprint 0383 Z2 and 0385 Z2 pin is 50660ce2|18 after 0404, and with the two restated ledger bodies taken back to their pre-0404 text it is their old pin (1c283e93|18) exactly: nothing else in ledger moved');

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select string_agg(v.fn || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|'
                     || pg_get_userbyid(p.proowner) || '|'
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('service_role', p.oid, 'EXECUTE')::text, E'\n' order by v.n)
     from (values (1, 'ledger.assemble_bundle(uuid,numeric,uuid,text)'),
                  (2, 'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  (3, 'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  (4, 'public.item_in_org(uuid,uuid)'),
                  (5, 'public.tg_ledger_only_guard()')) v(n, fn)
     join pg_proc p on p.oid = to_regprocedure(v.fn)),
  E'ledger.assemble_bundle(uuid,numeric,uuid,text)|false|v|{search_path=public}|postgres|true|false|true\n'
  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)|false|v|{search_path=public}|postgres|true|false|true\n'
  'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)|false|v|{search_path=public}|postgres|true|false|true\n'
  'public.item_in_org(uuid,uuid)|true|s|{search_path=public}|postgres|true|false|true\n'
  'public.tg_ledger_only_guard()|false|v|{search_path=public}|postgres|false|false|true',
  'P1: the three restated functions stay SECURITY INVOKER with search_path pinned, owned by postgres, executable by authenticated and service_role and not anon; item_in_org (the organization check) is SECURITY DEFINER, so its answer does not depend on what the caller can read; the guard (0359''s, unchanged) is executable by neither authenticated nor anon');
select is(
  position('Since 0404 an API role''s direct call needs bundles:distribute, or, for the Schedule''s completion of an event that hands out this kit, schedule:manage'
           in coalesce(obj_description('public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure, 'pg_proc'), '')) > 0,
  true,
  'P2: the wrapper''s comment says what it now enforces');
select is(
  (select string_agg(t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid), E'\n' order by t.tgname)
     from pg_trigger t
    where t.tgrelid = 'public.bundle_distributions'::regclass and not t.tgisinternal),
  E'trg_bundle_distributions_shortage|O|CREATE TRIGGER trg_bundle_distributions_shortage AFTER INSERT ON public.bundle_distributions FOR EACH ROW EXECUTE FUNCTION _notify_bundle_shortage()\n'
  'trg_zz_bundle_distributions_guard|O|CREATE TRIGGER trg_zz_bundle_distributions_guard BEFORE INSERT OR DELETE OR UPDATE ON public.bundle_distributions FOR EACH ROW EXECUTE FUNCTION tg_ledger_only_guard()',
  'P3: bundle_distributions carries 0359''s ledger-only guard as a BEFORE row trigger on insert, update and delete, beside its shortage notifier');

-- ══ X. No kit from nothing; kits as before ════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 5, %L)', :bnEmpty, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 1, %L)', :bnOpt, :whA)),
  'P0001:-:bundle_no_required_components / P0001:-:bundle_no_required_components',
  'X1: assembling kits from a bundle with no component, or with optional components only, is refused (P0001 bundle_no_required_components)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false)', :bnEmpty, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, true)', :bnEmpty, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false)', :bnOpt, :whA)),
  'P0001:-:bundle_no_required_components / P0001:-:bundle_no_required_components / P0001:-:bundle_no_required_components',
  'X2: handing out kits built from such a bundle is refused the same way, with or without allowing a shortage');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$do $d$ begin perform * from public.assemble_bundle(%L, 1, %L); exception when others then perform set_config('t0404.err', sqlerrm, true); end $d$$q$, :bnOpt, :whA),
    null,
    format($q$select current_setting('t0404.err', true)
                     || '|' || (select quantity_on_hand::int from public.inventory_items where id = %L)::text
                     || '|' || (select coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = %L)::text
                     || '|' || (select count(*) from public.stock_movements where item_id = %L and movement_type like 'bundle%%')::text
                     || '|' || (select count(*) from public.bundles where id = %L and phantom_item_id is not null)::text$q$,
           :itO, :itO, :itO, :bnOpt)),
  'ok:0:bundle_no_required_components|10|10|0|0',
  'X3: the optional part the refused assembly had already drawn is put back with the refusal, even when the caller catches it: its stock, holdings and movements are as before and no kit item was created');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$do $d$ begin perform public.distribute_bundle(%L, 1, %L, false); exception when others then perform set_config('t0404.err', sqlerrm, true); end $d$$q$, :bnOpt, :whA),
    null,
    format($q$select current_setting('t0404.err', true)
                     || '|' || (select quantity_on_hand::int from public.inventory_items where id = %L)::text
                     || '|' || (select count(*) from public.stock_movements where item_id = %L and movement_type like 'bundle%%')::text
                     || '|' || (select count(*) from public.bundle_distributions where bundle_id = %L)::text$q$,
           :itO, :itO, :bnOpt)),
  'ok:0:bundle_no_required_components|10|0|0',
  'X4: the same for a refused distribution: the optional draw is undone and no distribution is recorded');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 2, %L)', :bnOk, :whA), null,
    format($q$select (select string_agg(quantity_on_hand::int::text, '|' order by sku collate "C") from public.inventory_items where id in (%L, %L, %L))
                     || '|' || (select i.quantity_on_hand::int from public.bundles b join public.inventory_items i on i.id = b.phantom_item_id where b.id = %L)::text
                     || '|' || (select count(*) from public.stock_movements where reference_id = %L and movement_type = 'bundle_assembly')::text$q$,
           :itA1, :itA2, :itO, :bnOk, :bnOk)),
  'ok:1:98|96|8|2|4',
  'X5: a kit with required components is still assembled: 2 kits draw 2, 4 and 2 (the optional part included) and land 2 on the kit item, with one movement each');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 3, %L, false)', :bnOk, :whA), null,
    format($q$select (select string_agg(quantity_on_hand::int::text, '|' order by sku collate "C") from public.inventory_items where id in (%L, %L, %L))
                     || '|' || (select string_agg(d.quantity::int::text || '/' || d.shortage_recorded::text, ',') from public.bundle_distributions d where d.bundle_id = %L and d.id <> %L)$q$,
           :itA1, :itA2, :itO, :bnOk, :dFix)),
  'ok:1:97|94|7|3/false',
  'X6: kits are still handed out from components: 3 kits draw 3, 6 and 3 and record one distribution of 3 with no shortage');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 60, %L, true)', :bnOk, :whA), null,
    format($q$select (select string_agg(quantity_on_hand::int::text, '|' order by sku collate "C") from public.inventory_items where id in (%L, %L, %L))
                     || '|' || (select string_agg(d.quantity::int::text || '/' || d.shortage_recorded::text, ',') from public.bundle_distributions d where d.bundle_id = %L and d.id <> %L)$q$,
           :itA1, :itA2, :itO, :bnOk, :dFix)),
  'ok:1:40|0|0|60/true',
  'X7: and with a shortage allowed: 60 kits draw what there is (60, 100 of 120, and the optional 10) and record the shortage');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 2, %L, false)', :bnPh, :whA), null,
    format('select quantity_on_hand::int::text from public.inventory_items where id = %L', :itPh)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 4, %L, false)', :bnPh, :whA)),
  'ok:1:1 / P0001:-:bundle_no_required_components',
  'X8: kits already assembled are still handed out from a bundle with no component (2 of its 3), but a fourth kit would have to be built from nothing and is refused');

-- ══ O. Organization checks inside the kit functions ═══════════════════════
select is(
  pg_temp.attempt('authenticated', :two, format('select * from public.assemble_bundle(%L, 1, %L)', :bnX, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :two, format('select public.distribute_bundle(%L, 1, %L, false)', :bnX, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :two, format('select * from public.assemble_bundle(%L, 1, %L)', :bnXo, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :two, format('select public.distribute_bundle(%L, 1, %L, false)', :bnXo, :whA)),
  '42501:-:component_not_in_org / 42501:-:component_not_in_org / 42501:-:component_not_in_org / 42501:-:component_not_in_org',
  'O1: a manager of both organizations, who can see B''s item, is refused a kit with a component of another organization (42501 component_not_in_org), required or optional, assembling or handing out');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 1, %L)', :bnX, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false)', :bnX, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 1, %L)', :bnXo, :whA), null,
       format($q$select (select quantity_on_hand::int from public.inventory_items where id = %L)::text
                        || '|' || (select count(*) from public.stock_movements where item_id = %L)::text$q$, :itB, :itB)),
  'P0001:-:component_not_visible / P0001:-:component_not_visible / ok:1:10|0',
  'O2: a manager of A only, who cannot see B''s item, answers as before: a required one is not in their view (component_not_visible), an optional one is skipped, and nothing of B is read or drawn');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false, %L)', :bnOk, :whA, :evB)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false, %L)', :bnOk, :whA, :evNone)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false, %L)', :bnOk, :whA, :evDone), null,
       format('select count(*)::text from public.bundle_distributions where schedule_event_id = %L', :evDone)),
  'P0002:-:schedule_event_not_found / P0002:-:schedule_event_not_found / ok:1:1',
  'O3: a distribution naming another organization''s event, or no event at all, is refused (P0002 schedule_event_not_found) before anything is written; one naming the kit organization''s own event is recorded against it');

-- ══ K. The distribute_bundle gate ═════════════════════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'admM', 'mgr', 'mgrM', 'two', 'mgrD', 'mgrDS', 'vwr', 'stf', 'outB'],
               format('select public.distribute_bundle(%L, 1, %L, false)', :bnOk, :whA)),
  'own=ok:1, adm=ok:1, admM=ok:1, mgr=ok:1, mgrM=ok:1, two=ok:1, mgrD=42501:permission:forbidden, '
  'mgrDS=42501:permission:forbidden, vwr=42501:permission:forbidden, stf=P0002:-:bundle_not_found, outB=P0002:-:bundle_not_found',
  'K1: a direct call needs bundles:distribute: the owner, admins and managers holding it hand out kits (bundles:manage revoked or not), a manager without it and the viewer are refused (42501, hint permission); staff, who hold it, still get the body''s answer, and so does another organization''s manager, who cannot read the kit');
select is(
  pg_temp.attempt('authenticated', :mgrD,
    format($q$select public.distribute_bundle(%L, 1, %L, true, %L, 'Auto-distributed on event completion')$q$, :bnOk, :whA, :evDone), null,
    format('select count(*)::text from public.bundle_distributions where schedule_event_id = %L', :evDone)),
  'ok:1:1',
  'K2: the Schedule''s completion still hands out the event''s kit for a manager without bundles:distribute: schedule:manage, the module on, and a completed event of this organization naming this kit, quantity and warehouse (what ScheduleService.update sends after saving the completion)');
select is(
  pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 2, %L, true, %L)', :bnOk, :whA, :evDone)) || ' / '
  || pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, true, %L)', :bnOk, :whA2, :evDone)) || ' / '
  || pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, true, %L)', :bnOk, :whA, :evOther)) || ' / '
  || pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, true, %L)', :bnOk, :whA, :evOpen)) || ' / '
  || pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, true, %L)', :bnOk, :whA, :evB)) || ' / '
  || pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, true, null)', :bnOk, :whA)),
  '42501:permission:forbidden / 42501:permission:forbidden / 42501:permission:forbidden / '
  '42501:permission:forbidden / 42501:permission:forbidden / 42501:permission:forbidden',
  'K3: every term of that arm counts: another quantity, another warehouse, an event for another kit, an event not completed, another organization''s event, or no event, and the call is refused');
select is(
  pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, true, %L)', :bnOk, :whA, :evDone),
    format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'schedule'$q$, :orgA)) || ' / '
  || pg_temp.attempt('authenticated', :mgrDS, format('select public.distribute_bundle(%L, 1, %L, true, %L)', :bnOk, :whA, :evDone)),
  '42501:permission:forbidden / 42501:permission:forbidden',
  'K4: and the arm needs the Schedule module on and schedule:manage: with the module off, or for a manager without schedule:manage, the completed event does not let the call through');
select is(
  pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, false)', :bnOk, :whA),
                  $p$select set_config('stockpilot.ledger', pg_current_xact_id()::text, true)$p$) || ' / '
  || pg_temp.attempt('service_role', :mgrD, format('select public.distribute_bundle(%L, 1, %L, false)', :bnOk, :whA)),
  'ok:1 / ok:1',
  'K5: a call inside another ledger call of the same transaction is not asked again, and the admin client (service_role) is not held, even carrying the claims of a manager without bundles:distribute');
select is(
  pg_temp.attempt('authenticated', :mgrD, format('select * from public.assemble_bundle(%L, 1, %L)', :bnOk, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgrM, format('select * from public.assemble_bundle(%L, 1, %L)', :bnOk, :whA)),
  'ok:1 / 42501:permission:forbidden',
  'K6: assembly still answers to bundles:manage alone (0395): a manager without bundles:distribute assembles, one without bundles:manage does not');

-- ══ D. bundle_distributions is written only by distribute_bundle ══════════
select is(
  pg_temp.each(array['stf', 'mgr', 'own'],
    format($q$insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values (%L, %L, %L, 1, 'raw 0404')$q$, :orgA, :bnOk, :whA)),
  'stf=42501:Post or reverse a receipt, adjust, transfer or count instead of writing the table.:ledger_only, '
  'mgr=42501:Post or reverse a receipt, adjust, transfer or count instead of writing the table.:ledger_only, '
  'own=42501:Post or reverse a receipt, adjust, transfer or count instead of writing the table.:ledger_only',
  'D1: a signed-in user''s raw insert into bundle_distributions is refused (42501 ledger_only), staff included: a distribution can no longer be recorded with no stock drawn');
select is(
  pg_temp.attempt('service_role', null,
    format($q$insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values (%L, %L, %L, 1, 'admin 0404')$q$, :orgA, :bnOk, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format($q$update public.bundle_distributions set notes = 'changed' where id = %L$q$, :dFix)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('delete from public.bundle_distributions where id = %L', :dFix)),
  'ok:1 / ok:0 / ok:0',
  'D2: the admin client is not held; a signed-in user''s update or delete still matches no row (no policy grants either, as before)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('delete from public.schedule_events where id = %L', :evDel), null,
    format($q$select coalesce(schedule_event_id::text, 'null') from public.bundle_distributions where id = %L$q$, :dFix)),
  'ok:1:null',
  'D3: deleting an event a distribution names still clears the link: the foreign key action runs as the table owner, which the guard does not hold');

-- ══ C. The policies ═══════════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format('insert into public.bundle_components (bundle_id, item_id, quantity) values (%L, %L, 1)', :bnOk, :itB)) || ' / '
  || pg_temp.attempt('authenticated', :two, format('insert into public.bundle_components (bundle_id, item_id, quantity) values (%L, %L, 1)', :bnOk, :itB)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('update public.bundle_components set item_id = %L where bundle_id = %L and item_id = %L', :itB, :bnOk, :itO)),
  '42501:-:new row violates row-level security policy for table "bundle_components" / '
  '42501:-:new row violates row-level security policy for table "bundle_components" / '
  '42501:-:new row violates row-level security policy for table "bundle_components"',
  'C1: a component naming another organization''s item is refused (42501), even for a manager of both organizations, and an existing component cannot be changed to name one');
select is(
  pg_temp.attempt('authenticated', :mgr, format('insert into public.bundle_components (bundle_id, item_id, quantity) values (%L, %L, 1)', :bnEmpty, :itA1)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('update public.bundle_components set quantity = 3 where bundle_id = %L and item_id = %L', :bnOk, :itA1)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('delete from public.bundle_components where bundle_id = %L and item_id = %L', :bnX, :itB)),
  'ok:1 / ok:1 / ok:1',
  'C2: a manager still adds, changes and removes the organization''s own components, and can remove a component row that already names another organization''s item');
select is(
  pg_temp.attempt('authenticated', :mgrM, format('insert into public.bundle_components (bundle_id, item_id, quantity) values (%L, %L, 1)', :bnEmpty, :itA1)) || ' / '
  || pg_temp.attempt('authenticated', :mgrM, format('update public.bundle_components set quantity = 3 where bundle_id = %L and item_id = %L', :bnOk, :itA1)) || ' / '
  || pg_temp.attempt('authenticated', :mgrM, format('delete from public.bundle_components where bundle_id = %L and item_id = %L', :bnOk, :itO)),
  '42501:-:new row violates row-level security policy for table "bundle_components" / ok:0 / ok:0',
  'C3: a manager without bundles:manage no longer adds, changes or removes components through the API, as the app already refused');
select is(
  pg_temp.attempt('authenticated', :mgrM, format($q$insert into public.bundles (organization_id, name) values (%L, 'Raw kit 0404')$q$, :orgA)) || ' / '
  || pg_temp.attempt('authenticated', :mgrM, format($q$update public.bundles set name = 'Renamed 0404' where id = %L$q$, :bnOk)) || ' / '
  || pg_temp.attempt('authenticated', :admM, format('delete from public.bundles where id = %L', :bnEmpty)),
  '42501:-:new row violates row-level security policy for table "bundles" / '
  '42501:-:new row violates row-level security policy for table "bundles" / ok:0',
  'C4: without bundles:manage a manager no longer creates, renames or archives a bundle, and an admin no longer deletes one');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$insert into public.bundles (organization_id, name) values (%L, 'Raw kit 0404')$q$, :orgA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format($q$update public.bundles set name = 'Renamed 0404' where id = %L$q$, :bnOk)) || ' / '
  || pg_temp.attempt('authenticated', :adm, format('delete from public.bundles where id = %L', :bnEmpty)) || ' / '
  || pg_temp.attempt('authenticated', :stf, format($q$insert into public.bundles (organization_id, name) values (%L, 'Raw kit 0404')$q$, :orgA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('delete from public.bundles where id = %L', :bnEmpty)) || ' / '
  || pg_temp.attempt('authenticated', :outB, format($q$update public.bundles set name = 'Renamed 0404' where id = %L$q$, :bnOk)),
  'ok:1 / ok:1 / ok:1 / 42501:-:new row violates row-level security policy for table "bundles" / ok:0 / ok:0',
  'C5: with it nothing changes: a manager creates and renames, an admin deletes; staff, a manager deleting and another organization''s manager are refused as before');

-- ══ M. Each fix, removed, lets its probe through again ════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 5, %L)', :bnEmpty, :whA),
    (select stmt from pre404 where k = 'fn_assemble'),
    format($q$select (select i.quantity_on_hand::int from public.bundles b join public.inventory_items i on i.id = b.phantom_item_id where b.id = %L)::text
                     || '|' || (select count(*) from public.stock_movements where reference_id = %L)::text$q$, :bnEmpty, :bnEmpty)),
  'ok:1:5|1',
  'M1: without its 0404 lines, assemble_bundle makes 5 kits from an empty bundle: the kit item gains 5 and the only movement is that gain (the 2026-10-05 probe)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false)', :bnEmpty, :whA),
    (select stmt from pre404 where k = 'fn_distribute'),
    format($q$select (select count(*) from public.bundle_distributions where bundle_id = %L)::text
                     || '|' || (select count(*) from public.stock_movements where reference_id = %L)::text$q$, :bnEmpty, :bnEmpty)),
  'ok:1:1|0',
  'M2: without them, distribute_bundle records a distribution of an empty bundle with nothing drawn');
select is(
  pg_temp.attempt('authenticated', :two, format('select * from public.assemble_bundle(%L, 1, %L)', :bnXo, :whA),
    (select stmt from pre404 where k = 'fn_assemble')) || ' / '
  || pg_temp.attempt('authenticated', :two, format('select public.distribute_bundle(%L, 1, %L, true)', :bnX, :whA),
    (select stmt from pre404 where k = 'fn_distribute'),
    format($q$select (select string_agg(d.shortage_recorded::text, ',') from public.bundle_distributions d where d.bundle_id = %L)
                     || '|' || (select quantity_on_hand::int from public.inventory_items where id = %L)::text$q$, :bnX, :itB)),
  'ok:1 / ok:1:true|10',
  'M3: without them, a manager of both organizations still makes A''s kit naming B''s item (the optional one skipped) and hands it out (the required one recorded as short): B''s stock was never drawn, only because it sits in B''s warehouse, and the kit went out without it');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.distribute_bundle(%L, 1, %L, false, %L)', :bnOk, :whA, :evB),
    (select stmt from pre404 where k = 'fn_distribute'),
    format('select count(*)::text from public.bundle_distributions where schedule_event_id = %L and organization_id = %L', :evB, :orgA)),
  'ok:1:1',
  'M4: without them, A''s distribution takes B''s event: the one distribution bundle_distributions_event_uniq keeps for that event is now A''s, so B''s own completion would hit 23505 and hand out nothing');
select is(
  pg_temp.attempt('authenticated', :mgrD, format('select public.distribute_bundle(%L, 1, %L, false)', :bnOk, :whA),
    (select stmt from pre404 where k = 'fn_wrapper')),
  'ok:1',
  'M5: without the wrapper''s 0404 lines, a manager whose bundles:distribute is revoked hands out kits by calling it directly');
select is(
  pg_temp.attempt('authenticated', :mgr, format('insert into public.bundle_components (bundle_id, item_id, quantity) values (%L, %L, 1)', :bnOk, :itB),
    (select stmt from pre404 where k = 'pol_components')) || ' / '
  || pg_temp.attempt('authenticated', :mgrM, format('insert into public.bundle_components (bundle_id, item_id, quantity) values (%L, %L, 1)', :bnEmpty, :itA1),
    (select stmt from pre404 where k = 'pol_components')),
  'ok:1 / ok:1',
  'M6: with 0140''s component policy, a manager adds another organization''s item to a kit, and a manager without bundles:manage changes components');
select is(
  pg_temp.attempt('authenticated', :mgrM, format($q$insert into public.bundles (organization_id, name) values (%L, 'Raw kit 0404')$q$, :orgA),
    (select stmt from pre404 where k = 'pol_insert')) || ' / '
  || pg_temp.attempt('authenticated', :mgrM, format($q$update public.bundles set name = 'Renamed 0404' where id = %L$q$, :bnOk),
    (select stmt from pre404 where k = 'pol_update')) || ' / '
  || pg_temp.attempt('authenticated', :admM, format('delete from public.bundles where id = %L', :bnEmpty),
    (select stmt from pre404 where k = 'pol_delete')),
  'ok:1 / ok:1 / ok:1',
  'M7: with 0140''s bundle policies, a manager without bundles:manage creates and renames bundles and an admin without it deletes one');
select is(
  pg_temp.attempt('authenticated', :stf,
    format($q$insert into public.bundle_distributions (organization_id, bundle_id, warehouse_id, quantity, notes) values (%L, %L, %L, 1, 'raw 0404')$q$, :orgA, :bnOk, :whA),
    (select stmt from pre404 where k = 'trigger')),
  'ok:1',
  'M8: without the guard, a staff member records a distribution through the API with no stock drawn');
select is(
  pg_temp.attempt('authenticated', :mgrM, format('select public.distribute_bundle(%L, 1, %L, false)', :bnOk, :whA),
    $p$alter policy bundles_update on public.bundles
         using ((SELECT public.has_org_role(organization_id, 'manager')) and (SELECT public.has_permission(organization_id, 'bundles:manage')))$p$),
  'P0002:-:bundle_not_found',
  'M9: why bundles_update keeps its USING on the role: with bundles:manage there too, distribute_bundle''s SELECT ... FOR UPDATE no longer finds the kit for a manager who may hand it out but not edit it');

-- ══ A. The migration's own preflight and lock prelude ══════════════════════
select is(
  pg_temp.mig_count('0404', '$pre404$')::text || '/' || pg_temp.mig_count('0404', '$lock404$')::text,
  '1/1',
  'A1: the CLI recorded 0404''s preflight and lock prelude exactly once each (this section runs that text)');
select is(
  pg_temp.try_pre(null),
  '55000:bundle_checks_preflight:bundle_components.bundle_components_write drifted, bundles.bundles_delete drifted, '
  'bundles.bundles_insert drifted, bundles.bundles_update drifted, '
  'ledger.assemble_bundle(uuid,numeric,uuid,text) drifted, '
  'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text) drifted, '
  'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text) drifted, '
  'trg_zz_bundle_distributions_guard already exists',
  'A2: run again after 0404, the preflight stops before changing anything (55000) and names every body, policy and trigger 0404 changed');
select is(
  pg_temp.try_pre(pg_temp.pre(array['fn_assemble', 'fn_distribute', 'fn_wrapper', 'pol_components', 'pol_insert', 'pol_update', 'pol_delete', 'trigger'])),
  'ok',
  'A3: on the pre-0404 state (the bodies without their 0404 lines, 0140''s policies, no guard) the preflight passes: its pins are that state''s, which the R and H checks tie to the restated text');
select is(
  pg_temp.try_pre(pg_temp.pre(array['fn_assemble', 'fn_distribute', 'fn_wrapper', 'pol_components', 'pol_insert', 'pol_update', 'pol_delete', 'trigger'])
                  || $p$;
create or replace function public.item_in_org(p_item_id uuid, p_org_id uuid)
returns boolean language sql security definer set search_path = public stable as $f$
  select p_item_id is null or exists (select 1 from public.inventory_items
                                       where id = p_item_id and organization_id = p_org_id and deleted_at is null)
$f$$p$) || ' / '
  || pg_temp.try_pre(pg_temp.pre(array['fn_assemble', 'fn_distribute', 'fn_wrapper', 'pol_components', 'pol_insert', 'pol_update', 'pol_delete', 'trigger'])
                     || ';alter function ledger.assemble_bundle(uuid, numeric, uuid, text) set search_path = public, pg_temp') || ' / '
  || pg_temp.try_pre(pg_temp.pre(array['fn_assemble', 'fn_distribute', 'fn_wrapper', 'pol_components', 'pol_insert', 'pol_update', 'pol_delete', 'trigger'])
                     || $p$;alter policy bundles_delete on public.bundles using ((SELECT public.has_org_role(organization_id, 'owner')))$p$) || ' / '
  || pg_temp.try_pre(pg_temp.pre(array['fn_assemble', 'fn_distribute', 'fn_wrapper', 'pol_components', 'pol_insert', 'pol_update', 'pol_delete'])),
  '55000:bundle_checks_preflight:public.item_in_org(uuid,uuid) drifted / '
  '55000:bundle_checks_preflight:ledger.assemble_bundle(uuid,numeric,uuid,text) drifted / '
  '55000:bundle_checks_preflight:bundles.bundles_delete drifted / '
  '55000:bundle_checks_preflight:trg_zz_bundle_distributions_guard already exists',
  'A4: on that state, one planted drift stops it and is named: a helper body, a body''s SET clause, a policy''s text, a guard already there');
select is(
  pg_temp.locks_after(null) || ' / ' || pg_temp.locks_after(pg_temp.mig('0404', '$lock404$')),
  'none / bundle_components=AccessExclusiveLock, bundle_distributions=ShareRowExclusiveLock, bundles=AccessExclusiveLock',
  'A5: the lock prelude takes, at once, what the policy changes and the trigger take later (ACCESS EXCLUSIVE on bundles and bundle_components, SHARE ROW EXCLUSIVE on bundle_distributions), so no later statement waits holding a lock');

-- ══ H. The four policies' text ════════════════════════════════════════════
-- 0140's text as production deparses it (the 2026-10-24 schema dump, unquoted)
-- with the added terms in the same shape; nothing else moves.
select is(
  (select coalesce(qual, '') || E'\n' || coalesce(with_check, '')
     from pg_policies where schemaname = 'public' and tablename = 'bundle_components' and policyname = 'bundle_components_write'),
  replace($o$(EXISTS ( SELECT 1
   FROM bundles b
  WHERE ((b.id = bundle_components.bundle_id) AND ( SELECT has_org_role(b.organization_id, 'manager'::text) AS has_org_role))))$o$,
          $a$AS has_org_role))))$a$,
          $a$AS has_org_role) AND ( SELECT has_permission(b.organization_id, 'bundles:manage'::text) AS has_permission))))$a$)
  || E'\n'
  || replace($o$(EXISTS ( SELECT 1
   FROM bundles b
  WHERE ((b.id = bundle_components.bundle_id) AND ( SELECT has_org_role(b.organization_id, 'manager'::text) AS has_org_role))))$o$,
          $a$AS has_org_role))))$a$,
          $a$AS has_org_role) AND ( SELECT has_permission(b.organization_id, 'bundles:manage'::text) AS has_permission) AND ( SELECT item_in_org(bundle_components.item_id, b.organization_id) AS item_in_org))))$a$),
  'H1: bundle_components_write is 0140''s text with bundles:manage added to USING and WITH CHECK, and the item''s organization to WITH CHECK only');
select is(
  (select string_agg(policyname || '=' || coalesce(qual, '-') || ' | ' || coalesce(with_check, '-'), E'\n' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'bundles'
      and policyname in ('bundles_delete', 'bundles_insert', 'bundles_update')),
  $e$bundles_delete=(( SELECT has_org_role(bundles.organization_id, 'admin'::text) AS has_org_role) AND ( SELECT has_permission(bundles.organization_id, 'bundles:manage'::text) AS has_permission)) | -$e$ || E'\n'
  || $e$bundles_insert=- | (( SELECT has_org_role(bundles.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT has_permission(bundles.organization_id, 'bundles:manage'::text) AS has_permission))$e$ || E'\n'
  || $e$bundles_update=( SELECT has_org_role(bundles.organization_id, 'manager'::text) AS has_org_role) | (( SELECT has_org_role(bundles.organization_id, 'manager'::text) AS has_org_role) AND ( SELECT has_permission(bundles.organization_id, 'bundles:manage'::text) AS has_permission))$e$,
  'H2: bundles_insert and bundles_update (WITH CHECK) and bundles_delete (USING) are 0140''s text with bundles:manage added; bundles_update''s USING is unchanged');
select is(
  (select string_agg(tablename || '.' || policyname || '|' || cmd || '|' || roles::text || '|' || permissive, E'\n' order by tablename, policyname)
     from pg_policies where schemaname = 'public' and tablename in ('bundles', 'bundle_components', 'bundle_distributions')),
  E'bundle_components.bundle_components_select|SELECT|{authenticated}|PERMISSIVE\n'
  'bundle_components.bundle_components_write|ALL|{authenticated}|PERMISSIVE\n'
  'bundle_distributions.bundle_distributions_insert|INSERT|{authenticated}|PERMISSIVE\n'
  'bundle_distributions.bundle_distributions_select|SELECT|{authenticated}|PERMISSIVE\n'
  'bundles.bundles_delete|DELETE|{authenticated}|PERMISSIVE\n'
  'bundles.bundles_insert|INSERT|{authenticated}|PERMISSIVE\n'
  'bundles.bundles_select|SELECT|{authenticated}|PERMISSIVE\n'
  'bundles.bundles_update|UPDATE|{authenticated}|PERMISSIVE',
  'H3: the three tables keep the same policies, commands, roles and PERMISSIVE mode (ALTER POLICY changed text only)');

-- ══ G. Never a retryable error; one writer ════════════════════════════════
select is(
  (select string_agg(v.fn || '=' || (p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected')::text, ', ' order by v.n)
     from (values (1, 'ledger.assemble_bundle(uuid,numeric,uuid,text)'),
                  (2, 'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  (3, 'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'),
                  (4, 'public.item_in_org(uuid,uuid)'),
                  (5, 'public.tg_ledger_only_guard()')) v(n, fn)
     join pg_proc p on p.oid = to_regprocedure(v.fn)),
  'ledger.assemble_bundle(uuid,numeric,uuid,text)=false, ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)=false, '
  'public.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)=false, public.item_in_org(uuid,uuid)=false, public.tg_ledger_only_guard()=false',
  'G1: none of the five names 40001 or 40P01 (PostgREST retries those forever)');
select is(
  (select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
      and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(only\s+)?(public\.)?bundle_distributions\M'),
  'ledger.distribute_bundle',
  'G2: distribute_bundle''s body is the only function that writes bundle_distributions, so the guard stops no other writer');

-- ══ Z. Every undone attempt changed nothing ═══════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the undone attempts left every item, holding, movement, distribution, bundle, component, event, notification and module as it was');

select * from finish();
rollback;
