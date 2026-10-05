-- supabase/tests/0398_receiving_checklist.test.sql
-- pgTAP proof for migration 0398 (receiving checklist, F4-1; the number is
-- fixed at push time and nothing below depends on it): a versioned checklist a
-- manager publishes, and runs a manager records on receipts, written only
-- through four gated SECURITY DEFINER functions, visible exactly when the
-- purchase order is, and writing no stock.
--
-- Personas (org A unless named):
--   own       owner                       mgr, mgr2  managers, no override
--   mgrNoMan  manager, purchase_orders:manage revoked
--   mgrNoAdj  manager, stock:adjust revoked
--   mgrNoRd   manager, purchase_orders:read revoked
--   dis       manager whose account is disabled
--   stf       staff, assigned whA          stfB  staff, assigned whA2 only
--   vwr       viewer, assigned whA         vwrNoRd viewer, purchase_orders:read revoked
--   vwrMan    viewer granted purchase_orders:manage (the L4L shape, refresh c10)
--   outB      manager of org B             mgrC  manager of org C (receiving off)
--   ownD, del owner and manager of org D (the account deletion section)
--   nobody    signed in, member of nothing
--
-- A.  Shape and grants (catalog only: closed function grants are never called
--     as an API role): RLS on, SELECT only for authenticated (TRUNCATE,
--     REFERENCES, TRIGGER included), nothing for anon, the four RPCs to
--     authenticated only, the helpers to nobody; DEFINER, search_path and
--     lock_timeout; INV-25's token in each RPC body; the policies; the keys
--     and their delete actions; the unique indexes; the "Deleted user" marker
--     (0393's K7 shape on both tables) and its CHECKs; no body raises
--     40001/40P01 or runs dynamic SQL or names deleted_users.
-- P.  Publish: normalised steps, v2 retires v1 in one instant, a stale
--     expected id, a replayed client id (and that it says it made nothing:
--     created false, desk check F9), every refusal (case markers), the
--     procedure link, every denial and the module.
-- S.  Start: a run on the live version with the PO and warehouse copied, a
--     second call answers it, reversal rows refused and reversed receipts
--     allowed, another org and a missing receipt P0002, denials.
-- V.  Save: partial, every refusal (case markers), stale revision, replay
--     (and that it says it wrote nothing: saved false, desk check F9),
--     completion rules (case markers), completion stamps and finality, a run
--     on a retired version completes.
-- R.  Retire, then: an existing run is still answered, no live version and no
--     run is no_checklist, a newer version never moves a run.
-- L.  RLS: runs follow the purchase order (permission and warehouse scope),
--     versions follow membership, no API write.
-- N.  F4 writes no stock: counts and sums unchanged; reverse_receipt on a
--     receipt with a completed run succeeds and the run stays.
-- D.  An account deletion keeps versions and runs, nulls and stamps every
--     person column (the 0393 marker), and the CHECKs hold.
-- Z.  The frozen receipt objects F4 must not touch.
--
-- Case markers: each `-- case: <name>` sits above the assertion that runs
-- core receivingChecklistCases()'s case of that name against the database;
-- packages/core/src/purchasing/receiving-checklist.test.ts fails when a case
-- has no marker or a marker no case.
--
-- MUTATION TABLE (stockpilot-work/six/mutate-0398.py; each must turn the named
-- lines red):
--   M1  publish without the expected-current check            -> P8
--   M2  publish without the client-id replay                  -> P11
--   M3  the publisher floor on stock:adjust, not manage       -> P15, P16
--   M4  publish without the publisher assert                  -> P12, P13, P14, P15, P17, P18
--   M5  start checks no_checklist before the existing run     -> R3
--   M6  start without ON CONFLICT                             -> race 1 (two starts, no 23505)
--   M7  start without the recorder assert                     -> S7, S8, S9
--   M8  start allows a reversal row                           -> S4
--   M9  save without the revision check                       -> V4
--   M10 save without the replay                               -> V5, V11
--   M11 save without the recorder assert                      -> V12
--   M12 completion ignores a failed check's missing note      -> V7b, V7c
--   M13 completion counts Not applicable as missing           -> V7d
--   M14 save lets a completed run change                      -> V10
--   M15 the runs policy without the purchase-order EXISTS     -> L2, L3, L4
--   M16 the versions policy USING true                        -> L5
--   M17 retire accepts a non-live id                          -> R1
--   M18 the run trigger pair dropped                          -> A10, D1
--   M19 a run's person keys CASCADE instead of SET NULL       -> A7, D1
--   M20 normalize keeps the client's keys                     -> P1, P7d
--   M21 publish retires the live version a moment early       -> P10
--   M22 publish reports a replay as made                      -> P11b
--   M23 save reports a replay as written                      -> V5b, V11b
--
-- Roles: fixtures as the test superuser. Every call runs through pg_temp.rpc,
-- which switches role and claims with set_config inside a subtransaction (the
-- 0387/0393 helper shape), kept or always undone. begin/rollback: nothing
-- leaks. Namespace 03980000.

begin;

select plan(98);

\set orgA     '\'03980000-0000-0000-0000-00000000000a\''
\set orgB     '\'03980000-0000-0000-0000-00000000000b\''
\set orgC     '\'03980000-0000-0000-0000-00000000000c\''
\set orgD     '\'03980000-0000-0000-0000-00000000000d\''
\set own      '\'03980000-0000-0000-0000-0000000000a0\''
\set mgr      '\'03980000-0000-0000-0000-0000000000a1\''
\set mgr2     '\'03980000-0000-0000-0000-0000000000a2\''
\set mgrNoMan '\'03980000-0000-0000-0000-0000000000a3\''
\set mgrNoAdj '\'03980000-0000-0000-0000-0000000000a4\''
\set mgrNoRd  '\'03980000-0000-0000-0000-0000000000a5\''
\set dis      '\'03980000-0000-0000-0000-0000000000a6\''
\set stf      '\'03980000-0000-0000-0000-0000000000a7\''
\set stfB     '\'03980000-0000-0000-0000-0000000000a8\''
\set vwr      '\'03980000-0000-0000-0000-0000000000a9\''
\set vwrNoRd  '\'03980000-0000-0000-0000-0000000000aa\''
\set vwrMan   '\'03980000-0000-0000-0000-0000000000ab\''
\set outB     '\'03980000-0000-0000-0000-0000000000b1\''
\set mgrC     '\'03980000-0000-0000-0000-0000000000c1\''
\set ownD     '\'03980000-0000-0000-0000-0000000000d0\''
\set del      '\'03980000-0000-0000-0000-0000000000d1\''
\set nobody   '\'03980000-0000-0000-0000-0000000000ff\''
\set whA      '\'03980000-0000-0000-0000-000000000101\''
\set whA2     '\'03980000-0000-0000-0000-000000000102\''
\set whB      '\'03980000-0000-0000-0000-000000000103\''
\set whC      '\'03980000-0000-0000-0000-000000000104\''
\set whD      '\'03980000-0000-0000-0000-000000000105\''
\set itA      '\'03980000-0000-0000-0000-000000000201\''
\set itA2     '\'03980000-0000-0000-0000-000000000202\''
\set itB      '\'03980000-0000-0000-0000-000000000203\''
\set itC      '\'03980000-0000-0000-0000-000000000204\''
\set itD      '\'03980000-0000-0000-0000-000000000205\''
\set poA1     '\'03980000-0000-0000-0000-000000000301\''
\set poA2     '\'03980000-0000-0000-0000-000000000302\''
\set poB      '\'03980000-0000-0000-0000-000000000303\''
\set poC      '\'03980000-0000-0000-0000-000000000304\''
\set poD      '\'03980000-0000-0000-0000-000000000305\''
\set lnA1     '\'03980000-0000-0000-0000-000000000311\''
\set lnA2     '\'03980000-0000-0000-0000-000000000312\''
\set lnB      '\'03980000-0000-0000-0000-000000000313\''
\set lnC      '\'03980000-0000-0000-0000-000000000314\''
\set lnD      '\'03980000-0000-0000-0000-000000000315\''
\set procA    '\'03980000-0000-0000-0000-000000000401\''
\set procArch '\'03980000-0000-0000-0000-000000000402\''
\set procB    '\'03980000-0000-0000-0000-000000000403\''
\set cpA1     '\'03980000-0000-0000-0000-000000000501\''
\set cpA2     '\'03980000-0000-0000-0000-000000000502\''
\set cpA3     '\'03980000-0000-0000-0000-000000000503\''
\set cpX      '\'03980000-0000-0000-0000-000000000504\''
\set cpD1     '\'03980000-0000-0000-0000-000000000505\''
\set cpD2     '\'03980000-0000-0000-0000-000000000506\''
\set sv1      '\'03980000-0000-0000-0000-000000000601\''
\set sv2      '\'03980000-0000-0000-0000-000000000602\''
\set sv3      '\'03980000-0000-0000-0000-000000000603\''
\set sv4      '\'03980000-0000-0000-0000-000000000604\''
\set sv5      '\'03980000-0000-0000-0000-000000000605\''
\set sv6      '\'03980000-0000-0000-0000-000000000606\''
\set sv7      '\'03980000-0000-0000-0000-000000000607\''
\set missing  '\'03980000-0000-0000-0000-0000000009ff\''

-- ══ Helpers (the 0387/0393 shape, sentinel XX398) ═════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
create function pg_temp.keys(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(x, ',' order by o), '')
    from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
         with ordinality t(x, o)
$$;
-- Runs p_sql as p_role (authenticated) with the claim sub = p_sub. Kept unless
-- p_keep is false (then always undone). Answers 'ok:<value>[|<check>]' or
-- '<SQLSTATE>:<hint>:<detail reason>[:step<n> | :<key> | :m=<keys>/f=<keys>/p=<keys>]'.
create function pg_temp.rpc(p_sub uuid, p_sql text, p_keep boolean default true, p_check text default null,
                            p_role text default 'authenticated')
returns text language plpgsql as $$
declare
  v       text;
  v_seen  text;
  v_state text;
  v_msg   text;
  v_hint  text;
  v_det   text;
  r       jsonb;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    perform set_config('role', p_role, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    if not p_keep then
      raise exception using errcode = 'XX398', message = coalesce(v, 'null') || coalesce('|' || v_seen, '');
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_det = pg_exception_detail;
    if v_state = 'XX398' then
      return 'ok:' || v_msg;
    end if;
    begin
      r := nullif(v_det, '')::jsonb;
    exception when others then
      r := null;
    end;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || coalesce(r ->> 'reason', '-')
           || case when r ? 'step' then ':step' || (r ->> 'step')
                   when r ? 'key' then ':' || (r ->> 'key')
                   when r ? 'missing' then ':m=' || pg_temp.keys(r -> 'missing') || '/f='
                                          || pg_temp.keys(r -> 'failedWithoutNote') || '/p='
                                          || pg_temp.keys(r -> 'photoStepsWithoutPhoto')
                   else '' end;
  end;
  return 'ok:' || coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;
-- p_sql as the test superuser, then p_check, then always undone:
-- 'ok:<rows>|<check>' or '<SQLSTATE>:<hint>:<message>'.
create function pg_temp.undone(p_sql text, p_check text) returns text language plpgsql as $$
declare
  v_n     bigint;
  v_seen  text;
  v_state text;
  v_msg   text;
  v_hint  text;
begin
  begin
    execute p_sql;
    get diagnostics v_n = row_count;
    execute p_check into v_seen;
    raise exception using errcode = 'XX398', message = 'ok:' || v_n || '|' || coalesce(v_seen, 'null');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    if v_state = 'XX398' then
      return v_msg;
    end if;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
end $$;
-- A fixture step that must succeed: its value, or the whole file stops.
create function pg_temp.val(p text) returns text language plpgsql as $$
begin
  if p like 'ok:%' then
    return substr(p, 4);
  end if;
  raise exception 'fixture step failed: %', p;
end $$;
-- A successful call's value as jsonb (null for a refusal). VOLATILE so the
-- planner never folds the cast of a refusal's text.
create function pg_temp.okjson(p text) returns jsonb language plpgsql as $$
begin
  if p like 'ok:%' then
    return substr(p, 4)::jsonb;
  end if;
  return null;
end $$;
-- A trigger's arguments, decoded from pg_trigger.tgargs (NUL-separated; 0393's helper).
create function pg_temp.tgargs(p bytea) returns text[] language sql immutable as $$
  select coalesce(array_remove(string_to_array(encode(p, 'escape'), '\000'), ''), '{}'::text[])
$$;
-- Publish / retire / start / save calls, as SQL text for pg_temp.rpc. The
-- publish answers {version, created} and the save {run, saved} (desk check
-- F9): p_out names a column of the row, or 'created' / 'saved'.
create function pg_temp.pub(p_org uuid, p_title text, p_steps jsonb, p_expected uuid, p_client uuid,
                            p_proc uuid default null, p_binding text default 'receiving', p_out text default 'id')
returns text language sql immutable as $$
  select format('select %s::text from public.checklist_publish(%L, %L, %L, %L::jsonb, %L, %L, %L) v',
                case when p_out = 'created' then 'v.created' else '(v.version).' || p_out end,
                p_org, p_binding, p_title, p_steps, p_proc, p_expected, p_client)
$$;
create function pg_temp.retire(p_org uuid, p_version uuid) returns text language sql immutable as $$
  select format('select v.id::text from public.checklist_retire(%L, ''receiving'', %L) v', p_org, p_version)
$$;
create function pg_temp.start(p_receipt uuid) returns text language sql immutable as $$
  select format('select public.receiving_check_start(%L)::text', p_receipt)
$$;
create function pg_temp.save(p_run uuid, p_results jsonb, p_rev integer, p_save uuid, p_complete boolean,
                             p_note text default null, p_out text default 'revision')
returns text language sql immutable as $$
  select format('select %s::text from public.checklist_run_save(%L, %L::jsonb, %L, %L, %L, %L) v',
                case when p_out = 'saved' then 'v.saved' else '(v.run).' || p_out end,
                p_run, p_results, p_note, p_rev, p_save, p_complete)
$$;

-- The case-table version (core CASE_TABLE_STEPS), sent untidy: a client key,
-- padding, an unknown field and blank help, which the server drops.
create temp table j (k text primary key, v jsonb not null);
insert into j values
  ('steps', '[{"key": "x9", "kind": "check", "label": "  Packing slip matches this purchase order ", "required": true, "colour": "red"},
              {"kind": "check", "label": "Boxes arrived undamaged", "help": "  "},
              {"kind": "count", "label": "Number of boxes received", "required": false},
              {"kind": "text", "label": "Anything missing, extra or damaged?"}]'),
  ('stored', '[{"key": "s1", "kind": "check", "label": "Packing slip matches this purchase order", "help": null, "required": true},
               {"key": "s2", "kind": "check", "label": "Boxes arrived undamaged", "help": null, "required": false},
               {"key": "s3", "kind": "count", "label": "Number of boxes received", "help": null, "required": false},
               {"key": "s4", "kind": "text", "label": "Anything missing, extra or damaged?", "help": null, "required": false}]');
create temp table ids (k text primary key, v uuid not null);
grant all on j, ids to authenticated;

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,      '0398-own@test.local',      '{}'::jsonb),
  (:mgr,      '0398-mgr@test.local',      '{"full_name": "Manager One"}'::jsonb),
  (:mgr2,     '0398-mgr2@test.local',     '{}'::jsonb),
  (:mgrNoMan, '0398-mgrnoman@test.local', '{}'::jsonb),
  (:mgrNoAdj, '0398-mgrnoadj@test.local', '{}'::jsonb),
  (:mgrNoRd,  '0398-mgrnord@test.local',  '{}'::jsonb),
  (:dis,      '0398-dis@test.local',      '{}'::jsonb),
  (:stf,      '0398-stf@test.local',      '{}'::jsonb),
  (:stfB,     '0398-stfb@test.local',     '{}'::jsonb),
  (:vwr,      '0398-vwr@test.local',      '{}'::jsonb),
  (:vwrNoRd,  '0398-vwrnord@test.local',  '{}'::jsonb),
  (:vwrMan,   '0398-vwrman@test.local',   '{}'::jsonb),
  (:outB,     '0398-outb@test.local',     '{}'::jsonb),
  (:mgrC,     '0398-mgrc@test.local',     '{}'::jsonb),
  (:ownD,     '0398-ownd@test.local',     '{}'::jsonb),
  (:del,      '0398-del@test.local',      '{}'::jsonb),
  (:nobody,   '0398-nobody@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0398 Receiving A', '0398-receiving-a'),
  (:orgB, '0398 Receiving B', '0398-receiving-b'),
  (:orgC, '0398 Receiving C', '0398-receiving-c'),
  (:orgD, '0398 Receiving D', '0398-receiving-d');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,      'owner',   now()),
  (:orgA, :mgr,      'manager', now()),
  (:orgA, :mgr2,     'manager', now()),
  (:orgA, :mgrNoMan, 'manager', now()),
  (:orgA, :mgrNoAdj, 'manager', now()),
  (:orgA, :mgrNoRd,  'manager', now()),
  (:orgA, :dis,      'manager', now()),
  (:orgA, :stf,      'staff',   now()),
  (:orgA, :stfB,     'staff',   now()),
  (:orgA, :vwr,      'viewer',  now()),
  (:orgA, :vwrNoRd,  'viewer',  now()),
  (:orgA, :vwrMan,   'viewer',  now()),
  (:orgB, :outB,     'manager', now()),
  (:orgC, :mgrC,     'manager', now()),
  (:orgD, :ownD,     'owner',   now()),
  (:orgD, :del,      'manager', now());
update public.user_profiles set disabled_at = now() where id = :dis;
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'receiving', true, 'optional', '{}'::jsonb), (:orgA, 'purchase_orders', true, 'optional', '{}'::jsonb),
  (:orgA, 'procedures', true, 'optional', '{}'::jsonb),
  (:orgB, 'receiving', true, 'optional', '{}'::jsonb), (:orgB, 'purchase_orders', true, 'optional', '{}'::jsonb),
  (:orgC, 'receiving', false, 'optional', '{}'::jsonb), (:orgC, 'purchase_orders', true, 'optional', '{}'::jsonb),
  (:orgD, 'receiving', true, 'optional', '{}'::jsonb), (:orgD, 'purchase_orders', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = excluded.enabled;
-- The seed trigger creates Staging and Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0398 Main',   'WH-0398A',  'active'),
  (:whA2, :orgA, '0398 Annex',  'WH-0398A2', 'active'),
  (:whB,  :orgB, '0398 Bee',    'WH-0398B',  'active'),
  (:whC,  :orgC, '0398 Cee',    'WH-0398C',  'active'),
  (:whD,  :orgD, '0398 Dee',    'WH-0398D',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,     :whA,  true),
  (:orgA, :stfB,    :whA2, true),
  (:orgA, :vwr,     :whA,  true),
  (:orgA, :vwrNoRd, :whA,  true),
  (:orgA, :vwrMan,  :whA,  true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNoMan, 'purchase_orders:manage', false),
  (:orgA, :mgrNoAdj, 'stock:adjust',           false),
  (:orgA, :mgrNoRd,  'purchase_orders:read',   false),
  (:orgA, :vwrNoRd,  'purchase_orders:read',   false),
  (:orgA, :vwrMan,   'purchase_orders:manage', true);
insert into public.procedures (id, organization_id, title, archived_at) values
  (:procA,    :orgA, '0398 Receiving SOP', null),
  (:procArch, :orgA, '0398 Old SOP',       now()),
  (:procB,    :orgB, '0398 Other SOP',     null);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itA,  :orgA, :whA,  '0398-A',  '0398 Shirt',       0, 'active', 'none'),
  (:itA2, :orgA, :whA2, '0398-A2', '0398 Annex shirt', 0, 'active', 'none'),
  (:itB,  :orgB, :whB,  '0398-B',  '0398 Bee shirt',   0, 'active', 'none'),
  (:itC,  :orgC, :whC,  '0398-C',  '0398 Cee shirt',   0, 'active', 'none'),
  (:itD,  :orgD, :whD,  '0398-D',  '0398 Dee shirt',   0, 'active', 'none');
insert into public.purchase_orders (id, organization_id, po_number, status, destination_location_id) values
  (:poA1, :orgA, '0398-PO-A1', 'ordered', (select id from public.locations where warehouse_id = :whA  and kind = 'staging' limit 1)),
  (:poA2, :orgA, '0398-PO-A2', 'ordered', (select id from public.locations where warehouse_id = :whA2 and kind = 'staging' limit 1)),
  (:poB,  :orgB, '0398-PO-B',  'ordered', (select id from public.locations where warehouse_id = :whB  and kind = 'staging' limit 1)),
  (:poC,  :orgC, '0398-PO-C',  'ordered', (select id from public.locations where warehouse_id = :whC  and kind = 'staging' limit 1)),
  (:poD,  :orgD, '0398-PO-D',  'ordered', (select id from public.locations where warehouse_id = :whD  and kind = 'staging' limit 1));
insert into public.purchase_order_items (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:lnA1, :orgA, :poA1, :itA,  100, 0, 5),
  (:lnA2, :orgA, :poA2, :itA2, 100, 0, 5),
  (:lnB,  :orgB, :poB,  :itB,  100, 0, 5),
  (:lnC,  :orgC, :poC,  :itC,  100, 0, 5),
  (:lnD,  :orgD, :poD,  :itD,  100, 0, 5);

-- Receipts, posted the way the app posts them (post_receipt_v2 as a manager).
create function pg_temp.post(p_sub uuid, p_po uuid, p_wh uuid, p_line uuid, p_qty integer, p_key text)
returns uuid language sql as $$
  select pg_temp.val(pg_temp.rpc(p_sub, format(
    'select v.id::text from public.post_receipt_v2(%L, %L, %L::jsonb, %L, %L) v',
    p_po, p_wh,
    jsonb_build_array(jsonb_build_object('po_line_id', p_line, 'qty_received', p_qty, 'qty_accepted', p_qty,
                                         'qty_rejected', 0, 'unit_cost', 5)),
    p_key, 'hash-' || p_key)))::uuid
$$;
insert into ids values
  ('rc1', pg_temp.post(:mgr,  :poA1, :whA,  :lnA1, 2, '0398-k1')),
  ('rc2', pg_temp.post(:mgr,  :poA1, :whA,  :lnA1, 1, '0398-k2')),
  ('rc3', pg_temp.post(:mgr,  :poA1, :whA,  :lnA1, 1, '0398-k3')),
  ('rc4', pg_temp.post(:mgr,  :poA2, :whA2, :lnA2, 1, '0398-k4')),
  ('rc5', pg_temp.post(:mgr,  :poA1, :whA,  :lnA1, 1, '0398-k5')),
  ('rcB', pg_temp.post(:outB, :poB,  :whB,  :lnB,  1, '0398-kB')),
  ('rcC', pg_temp.post(:mgrC, :poC,  :whC,  :lnC,  1, '0398-kC')),
  ('rcD', pg_temp.post(:ownD, :poD,  :whD,  :lnD,  1, '0398-kD'));
insert into ids values
  ('rc2rev', pg_temp.val(pg_temp.rpc(:mgr, format('select v.id::text from public.reverse_receipt(%L, %L) v',
                                                   (select v from ids where k = 'rc2'), '0398 test reversal')))::uuid);
select v as "rc1" from ids where k = 'rc1' \gset
select v as "rc2" from ids where k = 'rc2' \gset
select v as "rc3" from ids where k = 'rc3' \gset
select v as "rc4" from ids where k = 'rc4' \gset
select v as "rc5" from ids where k = 'rc5' \gset
select v as "rcB" from ids where k = 'rcB' \gset
select v as "rcC" from ids where k = 'rcC' \gset
select v as "rcD" from ids where k = 'rcD' \gset
select v as "rc2rev" from ids where k = 'rc2rev' \gset

-- What F4 must never change (N1 compares at the end of P, S, V, R and L).
create temp table n_before as
select (select count(*) from public.stock_movements) as sm,
       (select count(*) from public.receipts) as rc,
       (select count(*) from public.receipt_lines) as rl,
       (select coalesce(sum(quantity), 0) from public.item_stock_levels) as isl,
       (select coalesce(sum(quantity_on_hand), 0) from public.inventory_items) as qoh,
       (select coalesce(sum(quantity_received), 0) from public.purchase_order_items) as qr,
       (select string_agg(id::text || ':' || status, ',' order by id) from public.purchase_orders
         where organization_id in (:orgA, :orgB, :orgC, :orgD)) as po_status,
       (select string_agg(id::text || ':' || status, ',' order by id) from public.receipts
         where organization_id in (:orgA, :orgB, :orgC, :orgD)) as rc_status;

-- ══ A. Shape and grants ════════════════════════════════════════════════════
select is(
  (select string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text, ',' order by c.relname)
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('checklist_versions', 'checklist_runs')),
  'checklist_runs:true:false,checklist_versions:true:false',
  'A1: both tables exist with RLS enabled');
select is(
  (select string_agg(t || ':' || r || ':' || p, ',' order by t, r, p)
     from unnest(array['checklist_versions', 'checklist_runs']) t,
          unnest(array['anon', 'authenticated', 'service_role']) r,
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    where has_table_privilege(r, 'public.' || t, p)),
  'checklist_runs:authenticated:SELECT,checklist_runs:service_role:SELECT,'
  'checklist_versions:authenticated:SELECT,checklist_versions:service_role:SELECT',
  'A2: authenticated and service_role may only read either table; anon holds nothing (TRUNCATE, REFERENCES and TRIGGER included)');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text
                     || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                     || ':' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false)::text
                     || ':' || pg_get_userbyid(p.proowner)
                     || ':' || array_to_string(p.proconfig, ';'), ',' order by p.proname collate "C")
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('checklist_publish', 'checklist_retire', 'receiving_check_start', 'checklist_run_save')),
  'checklist_publish:true:true:false:false:false:postgres:search_path=public, pg_temp;lock_timeout=5s,'
  'checklist_retire:true:true:false:false:false:postgres:search_path=public, pg_temp;lock_timeout=5s,'
  'checklist_run_save:true:true:false:false:false:postgres:search_path=public, pg_temp;lock_timeout=5s,'
  'receiving_check_start:true:true:false:false:false:postgres:search_path=public, pg_temp;lock_timeout=5s',
  'A3: the four RPCs are SECURITY DEFINER, owned by postgres, EXECUTE to authenticated only (not anon, PUBLIC or service_role), search_path and lock_timeout pinned');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || p.provolatile::text
                     || ':' || (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                or has_function_privilege('anon', p.oid, 'EXECUTE')
                                or has_function_privilege('service_role', p.oid, 'EXECUTE')
                                or coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false))::text
                     || ':' || array_to_string(p.proconfig, ';'), ',' order by p.proname collate "C")
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '\_checklist\_%'),
  '_checklist_assert_publisher:true:v:false:search_path=public, pg_temp;lock_timeout=5s,'
  '_checklist_assert_recorder:true:v:false:search_path=public, pg_temp;lock_timeout=5s,'
  '_checklist_normalize_steps:false:i:false:search_path=public, pg_temp;lock_timeout=5s,'
  '_checklist_validate_results:false:i:false:search_path=public, pg_temp;lock_timeout=5s',
  'A4: the asserts (DEFINER) and the normalisers (INVOKER, IMMUTABLE) are executable by no API role and pin search_path');
select is(
  (select string_agg(p.proname, ',' order by p.proname collate "C")
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('checklist_publish', 'checklist_retire', 'receiving_check_start', 'checklist_run_save')
      and p.prosrc ~* 'auth\.uid'
      and p.prosrc ~ '_checklist_assert_(recorder|publisher)'),
  'checklist_publish,checklist_retire,checklist_run_save,receiving_check_start',
  'A5: every RPC calls its assert and names auth.uid (INV-25 reads the token; the denial tests below, not INV-25, catch a dropped assert)');
select is(
  (select string_agg(c.relname || ':' || pol.polname || ':' || pol.polcmd::text || ':' || pol.polroles::regrole[]::text
                     || ':' || (pol.polwithcheck is null)::text, ',' order by c.relname collate "C")
     from pg_policy pol join pg_class c on c.oid = pol.polrelid
    where c.relnamespace = 'public'::regnamespace and c.relname in ('checklist_versions', 'checklist_runs'))
  || '|' || (select (pg_get_expr(pol.polqual, pol.polrelid) ~ 'is_org_member\(checklist_runs\.organization_id\)'
                     and pg_get_expr(pol.polqual, pol.polrelid) ~ 'EXISTS'
                     and pg_get_expr(pol.polqual, pol.polrelid) ~ 'purchase_orders po'
                     and pg_get_expr(pol.polqual, pol.polrelid) ~ 'po\.id = checklist_runs\.purchase_order_id')::text
               from pg_policy pol where pol.polrelid = 'public.checklist_runs'::regclass)
  || '|' || (select (pg_get_expr(pol.polqual, pol.polrelid) ~ 'is_org_member\(checklist_versions\.organization_id\)')::text
               from pg_policy pol where pol.polrelid = 'public.checklist_versions'::regclass),
  'checklist_runs:checklist_runs_select:r:{authenticated}:true,checklist_versions:checklist_versions_select:r:{authenticated}:true|true|true',
  'A6: one SELECT policy each, to authenticated: versions to members, runs to members who can see the purchase order');
select is(
  (select string_agg(c.conrelid::regclass::text || '.' || a.attname || '>' || c.confrelid::regclass::text || ':' || c.confdeltype::text,
                     ',' order by c.conrelid::regclass::text collate "C", a.attname collate "C")
     from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.conrelid in ('public.checklist_versions'::regclass, 'public.checklist_runs'::regclass)),
  'checklist_runs.completed_by>user_profiles:n,checklist_runs.organization_id>organizations:c,'
  'checklist_runs.purchase_order_id>purchase_orders:c,checklist_runs.receipt_id>receipts:c,'
  'checklist_runs.started_by>user_profiles:n,checklist_runs.version_id>checklist_versions:a,'
  'checklist_runs.warehouse_id>warehouses:a,checklist_versions.organization_id>organizations:c,'
  'checklist_versions.procedure_id>procedures:n,checklist_versions.published_by>user_profiles:n,'
  'checklist_versions.retired_by>user_profiles:n',
  'A7: the keys: organization, receipt and PO cascade; version and warehouse NO ACTION (never RESTRICT); procedure and every person key SET NULL (A3 rule)');
select is(
  (select string_agg(i.relname || ':' || x.indisunique::text || ':' || coalesce(pg_get_expr(x.indpred, x.indrelid), '-'), ',' order by i.relname collate "C")
     from pg_index x join pg_class i on i.oid = x.indexrelid
    where x.indrelid in ('public.checklist_versions'::regclass, 'public.checklist_runs'::regclass) and not x.indisprimary),
  'checklist_runs_purchase_order_idx:false:-,checklist_runs_receipt_uniq:true:-,checklist_runs_version_idx:false:-,'
  'checklist_versions_client_publish_uniq:true:(client_publish_id IS NOT NULL),checklist_versions_number_uniq:true:-,'
  'checklist_versions_one_live:true:(retired_at IS NULL),checklist_versions_procedure_idx:false:(procedure_id IS NOT NULL)',
  'A8: one live version per organization and binding, one run per receipt, a client publish id used once, and the lookup indexes');
select is(
  (select string_agg(c.conrelid::regclass::text || '.' || c.conname || ':' || c.convalidated::text || ':' || c.condeferrable::text,
                     ',' order by c.conname collate "C")
     from pg_constraint c
    where c.conrelid in ('public.checklist_versions'::regclass, 'public.checklist_runs'::regclass)
      and c.conname in ('checklist_versions_published_by_deleted_chk', 'checklist_versions_retired_chk',
                        'checklist_runs_started_by_deleted_chk', 'checklist_runs_completed_by_chk')),
  'checklist_runs.checklist_runs_completed_by_chk:true:false,checklist_runs.checklist_runs_started_by_deleted_chk:true:false,'
  'checklist_versions.checklist_versions_published_by_deleted_chk:true:false,checklist_versions.checklist_versions_retired_chk:true:false',
  'A9: the exactly-one CHECKs (publisher, starter) and the pair CHECKs that accept a stamp (retirer, completer) exist and are validated');
select is(
  (select coalesce(string_agg(x.tbl || ':' || x.problem, ',' order by x.tbl), '')
     from (
       select m.tbl,
              case
                when (select count(*) from pg_trigger t where t.tgrelid = ('public.' || m.tbl)::regclass and not t.tgisinternal) <> 2
                  then 'count'
                when not exists (
                       select 1 from pg_trigger t
                        where t.tgrelid = ('public.' || m.tbl)::regclass and t.tgname = 'zzz_deleted_users_ins'
                          and t.tgtype = 7 and t.tgenabled = 'O' and t.tgfoid = 'public.tg_mark_deleted_users()'::regprocedure
                          and pg_temp.tgargs(t.tgargs) = m.cols
                          and position('WHEN ((new.deleted_users IS NOT NULL))' in pg_get_triggerdef(t.oid)) > 0)
                  then 'ins'
                when not exists (
                       select 1 from pg_trigger t
                        where t.tgrelid = ('public.' || m.tbl)::regclass and t.tgname = 'zzz_deleted_users_upd'
                          and t.tgtype = 19 and t.tgenabled = 'O' and t.tgfoid = 'public.tg_mark_deleted_users()'::regprocedure
                          and pg_temp.tgargs(t.tgargs) = m.cols
                          and position('(old.deleted_users IS NOT NULL)' in pg_get_triggerdef(t.oid)) > 0
                          and position('(new.deleted_users IS NOT NULL)' in pg_get_triggerdef(t.oid)) > 0
                          and (select bool_and(position(format('(old.%s IS NOT NULL) AND (new.%s IS NULL)', c, c) in pg_get_triggerdef(t.oid)) > 0)
                                 from unnest(m.cols) c)
                          and (select count(*) from regexp_matches(pg_get_triggerdef(t.oid), ' IS NULL\)', 'g')) = cardinality(m.cols))
                  then 'upd'
                when not exists (
                       select 1 from pg_attribute a
                        where a.attrelid = ('public.' || m.tbl)::regclass and a.attname = 'deleted_users' and not a.attisdropped
                          and a.atttypid = 'jsonb'::regtype and not a.attnotnull and not a.atthasdef)
                  then 'column'
                when m.cols is distinct from (
                       select array_agg(a.attname::text order by a.attname collate "C")
                         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                        where c.conrelid = ('public.' || m.tbl)::regclass and c.contype = 'f'
                          and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass) and c.confdeltype = 'n')
                  then 'args'
              end as problem
         from (values ('checklist_runs', array['completed_by', 'started_by']),
                      ('checklist_versions', array['published_by', 'retired_by'])) m(tbl, cols)) x
    where x.problem is not null),
  '',
  'A10: each table carries the 0393 marker: deleted_users jsonb (nullable, no default) and exactly the zzz_deleted_users_ins/_upd pair (BEFORE INSERT and UPDATE FOR EACH ROW, enabled, tg_mark_deleted_users with its SET NULL person columns, one WHEN term per column)');
select is(
  (select coalesce(string_agg(p.proname || ':' || f.flag, ',' order by p.proname, f.flag), '')
     from pg_proc p
     cross join lateral (values
       ('retryable', p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$),
       ('dynamic', regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M'),
       ('marker', p.prosrc ~ '\mdeleted_users\M'),
       ('ledger', p.prosrc ~* 'stockpilot\.ledger|ledger\.')) f(flag, hit)
    where p.pronamespace = 'public'::regnamespace and f.hit
      and p.proname in ('checklist_publish', 'checklist_retire', 'receiving_check_start', 'checklist_run_save',
                        '_checklist_assert_recorder', '_checklist_assert_publisher',
                        '_checklist_normalize_steps', '_checklist_validate_results')),
  '',
  'A11: no checklist function raises 40001/40P01 (0367), runs dynamic SQL (0359), writes the deleted_users marker (0393 K14) or touches the ledger');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'checklist\_%' or p.proname like '\_checklist\_%' or p.proname = 'receiving_check_start')
      and coalesce(obj_description(p.oid, 'pg_proc'), '') ~ 'Receiving checklist \(F4-1\)')
  || '|' || (obj_description('public.checklist_versions'::regclass, 'pg_class') ~ 'F4-1')::text
  || '|' || (obj_description('public.checklist_runs'::regclass, 'pg_class') ~ 'F4-1')::text,
  '8|true|true',
  'A12: every function and both tables say what they are in their comments');

-- ══ P. Publish ═════════════════════════════════════════════════════════════
insert into ids values ('v1', pg_temp.val(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, '  Delivery checks  ', (select v from j where k = 'steps'), null, :cpA1)))::uuid);
select v as "v1" from ids where k = 'v1' \gset
select is(
  (select v.version_number || '|' || v.title || '|' || (v.steps = (select j.v from j where j.k = 'stored'))::text || '|'
          || (v.published_by = :mgr)::text || '|' || (v.retired_at is null)::text || '|' || v.binding || '|'
          || (v.client_publish_id = :cpA1)::text || '|' || coalesce(v.procedure_id::text, '-')
     from public.checklist_versions v where v.id = :'v1'),
  '1|Delivery checks|true|true|true|receiving|true|-',
  'P1: version 1: keys s1..s4 by position, labels and title trimmed, the client key, padding, blank help and the unknown field dropped; published by the caller, live');

-- case: steps_zero
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', '[]'::jsonb, :'v1', :cpX), false),
  '22023:checklist_invalid:step_count', 'P2: no steps is refused (checklist_invalid step_count)');
-- case: steps_twenty_one
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T',
    (select jsonb_agg(jsonb_build_object('kind', 'check', 'label', 'Slip matches')) from generate_series(1, 21)), :'v1', :cpX), false),
  '22023:checklist_invalid:step_count', 'P3: 21 steps are refused');
-- case: steps_photo_kind
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T',
    '[{"kind": "check", "label": "Slip matches"}, {"kind": "photo", "label": "Slip photo"}]'::jsonb, :'v1', :cpX), false),
  '22023:checklist_invalid:photo_not_available:step2', 'P4: a photo step is refused until F4-2, naming the step');
-- case: steps_unknown_kind
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', '[{"kind": "scale", "label": "Weight"}]'::jsonb, :'v1', :cpX), false),
  '22023:checklist_invalid:unknown_kind:step1', 'P5: an unknown kind is refused');
-- case: steps_blank_label
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T',
    jsonb_build_array(jsonb_build_object('kind', 'check', 'label', 'Slip matches'), jsonb_build_object('kind', 'check', 'label', 'Slip matches'),
                      jsonb_build_object('kind', 'check', 'label', E' \t ')), :'v1', :cpX), false),
  '22023:checklist_invalid:label_required:step3', 'P6: a blank label is refused (spaces and tabs only)');
-- case: steps_label_121
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', jsonb_build_array(jsonb_build_object('kind', 'check', 'label', repeat('L', 121))), :'v1', :cpX), false),
  '22023:checklist_invalid:label_too_long:step1', 'P7a: a 121-character label is refused');
-- case: steps_help_301
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', jsonb_build_array(jsonb_build_object('kind', 'text', 'label', 'Notes', 'help', repeat('H', 301))), :'v1', :cpX), false),
  '22023:checklist_invalid:help_too_long:step1', 'P7b: 301 characters of help are refused');
-- case: steps_required_not_boolean
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', '[{"kind": "check", "label": "Slip matches", "required": "yes"}]'::jsonb, :'v1', :cpX), false),
  '22023:checklist_invalid:required_not_boolean:step1', 'P7c: required must be true or false');
-- case: steps_normalised
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T',
    jsonb_build_array(jsonb_build_object('key', 'zz', 'kind', 'check', 'label', '  Slip matches  ', 'required', true, 'colour', 'red'),
                      jsonb_build_object('kind', 'count', 'label', 'Boxes', 'help', '   '),
                      jsonb_build_object('kind', 'text', 'label', repeat('L', 120), 'help', repeat('H', 300))),
    :'v1', :cpX, null, 'receiving', 'steps'), false),
  'ok:' || jsonb_build_array(
            jsonb_build_object('key', 's1', 'kind', 'check', 'label', 'Slip matches', 'help', null, 'required', true),
            jsonb_build_object('key', 's2', 'kind', 'count', 'label', 'Boxes', 'help', null, 'required', false),
            jsonb_build_object('key', 's3', 'kind', 'text', 'label', repeat('L', 120), 'help', repeat('H', 300), 'required', false))::text,
  'P7d: boundaries pass (120-character label, 300 of help); keys by position, unknown fields and the client key dropped (undone)');
-- case: title_blank
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, '   ', (select v from j where k = 'steps'), :'v1', :cpX), false),
  '22023:checklist_invalid:title_required', 'P7e: a blank title is refused');
-- case: title_81
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, repeat('T', 81), (select v from j where k = 'steps'), :'v1', :cpX), false),
  '22023:checklist_invalid:title_too_long', 'P7f: an 81-character title is refused');
-- case: title_80_trimmed
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, '  ' || repeat('T', 80) || '  ', (select v from j where k = 'steps'), :'v1', :cpX, null, 'receiving', 'title'), false),
  'ok:' || repeat('T', 80), 'P7g: an 80-character title passes, trimmed (undone)');

select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), null, :cpX), false),
  'P0001:checklist_changed:-', 'P8: an expected id that is not the live version (null while v1 is live) is refused: checklist_changed');
select is(
  pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v1', :cpX, :procB), false) || ','
  || pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v1', :cpX, :procArch), false) || ','
  || pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v1', :cpX, :procA, 'receiving', 'procedure_id'), false),
  '22023:checklist_invalid:procedure_not_available,22023:checklist_invalid:procedure_not_available,ok:' || :procA,
  'P9: the instructions link must be a live procedure of the organization: another org''s and an archived one are refused, a live one is kept');

insert into ids values ('v2', pg_temp.val(pg_temp.rpc(:mgr2, pg_temp.pub(:orgA, 'Delivery checks', (select v from j where k = 'steps'), :'v1', :cpA2)))::uuid);
select v as "v2" from ids where k = 'v2' \gset
select is(
  (select count(*) filter (where retired_at is null)::text || '|'
          || (select v.version_number::text from public.checklist_versions v where v.id = :'v2') || '|'
          || (select (o.retired_at = n.published_at and o.retired_by = :mgr2 and n.published_by = :mgr2)::text
                from public.checklist_versions o, public.checklist_versions n where o.id = :'v1' and n.id = :'v2')
     from public.checklist_versions where organization_id = :orgA),
  '1|2|true',
  'P10: version 2 with the right expected id retires version 1 in the same instant, by the same person: exactly one live');
select is(
  pg_temp.rpc(:mgr2, pg_temp.pub(:orgA, 'Something else', '[{"kind": "text", "label": "x"}]'::jsonb, :'v1', :cpA2), true,
              format('select count(*)::text from public.checklist_versions where organization_id = %L', :orgA)),
  'ok:' || :'v2' || '|2',
  'P11: a replayed client publish id answers the version it made, even with a stale expected id and other content, and makes no version 3');
select is(
  pg_temp.rpc(:mgr2, pg_temp.pub(:orgA, 'Something else', '[{"kind": "text", "label": "x"}]'::jsonb, :'v1', :cpA2, null, 'receiving', 'created'), false),
  'ok:false',
  'P11b: the replay says this call made nothing (created false), so the app writes no second audit row (desk check F9)');
select is(
  pg_temp.rpc(:stf,      pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false) || ','
  || pg_temp.rpc(:vwr,   pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false),
  '42501:not_publisher:-,42501:not_publisher:-',
  'P12: staff and viewers may not publish (42501)');
select is(
  pg_temp.rpc(:nobody, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false) || ','
  || pg_temp.rpc(:dis,   pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false) || ','
  || pg_temp.rpc(:outB,  pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false),
  '42501:not_member:-,42501:not_member:-,42501:not_member:-',
  'P13: a non-member, a disabled manager and another organization''s manager may not publish (42501)');
select is(pg_temp.rpc(null, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false),
  '42501:not_authenticated:-', 'P14: an unsigned call is refused');
select is(pg_temp.rpc(:mgrNoMan, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false),
  '42501:not_publisher:-', 'P15: a manager whose purchase_orders:manage was revoked may not publish');
select is(pg_temp.rpc(:mgrNoAdj, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX, null, 'receiving', 'version_number'), false),
  'ok:3', 'P16: a manager without stock:adjust still publishes (purchasing configuration needs manage, not adjust; undone)');
select is(pg_temp.rpc(:mgrNoAdj, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX, null, 'receiving', 'created'), false),
  'ok:true', 'P16b: a publish that made the version says so (created true; undone)');
select is(pg_temp.rpc(:vwrMan, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX), false),
  '42501:not_publisher:-', 'P17: a viewer granted purchase_orders:manage may not publish (manager floor)');
select is(pg_temp.rpc(:mgrC, pg_temp.pub(:orgC, 'T', (select v from j where k = 'steps'), null, :cpX), false),
  'P0001:module_disabled:-', 'P18: with receiving off, publishing is refused (module_disabled)');
select is(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'T', (select v from j where k = 'steps'), :'v2', :cpX, null, 'rentals'), false),
  '22023:checklist_invalid:unknown_binding', 'P19: only the receiving binding exists');

-- ══ S. Start ═══════════════════════════════════════════════════════════════
select pg_temp.rpc(:mgr, pg_temp.start(:'rc1')) as "s1" \gset
select is(coalesce((pg_temp.okjson(:'s1') - 'runId')::text, :'s1'), '{"created": true, "versionNumber": 2}',
  'S1: a posted receipt gets a run on the live version (created)');
select pg_temp.val(:'s1')::jsonb ->> 'runId' as "run1" \gset
select is(
  (select (r.version_id = :'v2')::text || '|' || (r.purchase_order_id = :poA1)::text || '|' || (r.warehouse_id = :whA)::text
          || '|' || (r.receipt_id = :'rc1')::text || '|' || (r.started_by = :mgr)::text || '|' || r.status || '|'
          || r.revision || '|' || r.results::text || '|' || (r.organization_id = :orgA)::text || '|' || r.binding
          || '|' || coalesce(r.completed_by::text, '-') || '|' || coalesce(r.deleted_users::text, '-')
          || '|' || coalesce(r.note, '-') || '|' || coalesce(r.last_save_id::text, '-')
     from public.checklist_runs r where r.id = :'run1'),
  'true|true|true|true|true|in_progress|0|{}|true|receiving|-|-|-|-',
  'S2: the run copies the PO and warehouse from the receipt, names who started it, and starts empty at revision 0');
select is(coalesce(pg_temp.okjson(pg_temp.rpc(:mgr2, pg_temp.start(:'rc1')))::text, 'refused'),
  jsonb_build_object('runId', :'run1', 'created', false, 'versionNumber', 2)::text,
  'S3: a second start for the receipt (another manager) answers the same run, created false');
select is(pg_temp.rpc(:mgr, pg_temp.start(:'rc2rev'), false), 'P0001:receipt_not_checkable:-',
  'S4: a reversal row has no checklist (receipt_not_checkable)');
select pg_temp.rpc(:mgr, pg_temp.start(:'rc2')) as "s2" \gset
select is(coalesce((pg_temp.okjson(:'s2') - 'runId')::text, :'s2'), '{"created": true, "versionNumber": 2}',
  'S5: a reversed receipt can still carry a run');
select pg_temp.val(:'s2')::jsonb ->> 'runId' as "run2" \gset
select is(
  pg_temp.rpc(:mgr, pg_temp.start(:'rcB'), false) || ',' || pg_temp.rpc(:mgr, pg_temp.start(:missing), false) || ','
  || pg_temp.rpc(:nobody, pg_temp.start(:'rc1'), false) || ',' || pg_temp.rpc(:dis, pg_temp.start(:'rc1'), false),
  'P0002:receipt_not_found:-,P0002:receipt_not_found:-,P0002:receipt_not_found:-,P0002:receipt_not_found:-',
  'S6: another organization''s receipt, a missing one, a non-member and a disabled manager all read as not found');
select is(pg_temp.rpc(:stf, pg_temp.start(:'rc3'), false) || ',' || pg_temp.rpc(:vwr, pg_temp.start(:'rc3'), false),
  '42501:not_recorder:-,42501:not_recorder:-',
  'S7: staff and viewers may not record a checklist (42501)');
select is(pg_temp.rpc(:mgrNoAdj, pg_temp.start(:'rc3'), false) || ',' || pg_temp.rpc(:mgrNoRd, pg_temp.start(:'rc3'), false),
  '42501:not_recorder:-,42501:not_recorder:-',
  'S8: a manager whose stock:adjust or purchase_orders:read was revoked may not record');
select is(pg_temp.rpc(null, pg_temp.start(:'rc3'), false) || ',' || pg_temp.rpc(:mgrC, pg_temp.start(:'rcC'), false),
  '42501:not_authenticated:-,P0001:module_disabled:-',
  'S9: an unsigned call is refused, and with receiving off a start is refused (module_disabled)');

-- ══ V. Save ════════════════════════════════════════════════════════════════
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "pass"}, "s3": {"value": 12}}', 0, :sv1, false)), 'ok:1',
  'V1: a partial save stores the answers at revision 1');
select is(
  (select r.results::text || '|' || r.status || '|' || (r.last_save_id = :sv1)::text || '|' || (r.completed_at is null)::text
     from public.checklist_runs r where r.id = :'run1'),
  '{"s1": {"value": "pass"}, "s3": {"value": 12}}|in_progress|true|true',
  'V2: the stored answers are exactly what was saved, and the run is still in progress');

-- case: results_unknown_key
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s9": {"value": "pass"}}', 1, :sv2, false), false),
  '22023:checklist_invalid:unknown_step:s9', 'V3a: an answer for a step that is not on the version is refused');
-- case: results_maybe
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "maybe"}}', 1, :sv2, false), false),
  '22023:checklist_invalid:not_a_check_answer:s1', 'V3b: a check answers pass, fail or na only');
-- case: results_fraction
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s3": {"value": 1.5}}', 1, :sv2, false), false),
  '22023:checklist_invalid:not_a_whole_number:s3', 'V3c: a count is a whole number');
-- case: results_negative
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s3": {"value": -1}}', 1, :sv2, false), false),
  '22023:checklist_invalid:count_out_of_range:s3', 'V3d: a count is never negative');
-- case: results_over_a_million
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s3": {"value": 1000001}}', 1, :sv2, false), false),
  '22023:checklist_invalid:count_out_of_range:s3', 'V3e: a count is at most 1,000,000');
-- case: results_count_as_text
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s3": {"value": "12"}}', 1, :sv2, false), false),
  '22023:checklist_invalid:not_a_whole_number:s3', 'V3f: a count sent as text is refused');
-- case: results_text_501
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', jsonb_build_object('s4', jsonb_build_object('value', repeat('x', 501))), 1, :sv2, false), false),
  '22023:checklist_invalid:text_too_long:s4', 'V3g: a text answer is at most 500 characters');
-- case: results_note_301
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', jsonb_build_object('s2', jsonb_build_object('value', 'pass', 'note', repeat('n', 301))), 1, :sv2, false), false),
  '22023:checklist_invalid:note_too_long:s2', 'V3h: a step note is at most 300 characters');
-- case: results_partial_ok
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "pass"}, "s3": {"value": 12}, "s4": {"value": "  one box short  "}}', 1, :sv2, false, null, 'results'), false),
  'ok:' || '{"s1": {"value": "pass"}, "s3": {"value": 12}, "s4": {"value": "one box short"}}'::jsonb::text,
  'V3i: a valid partial save is stored trimmed (undone)');
-- case: results_blank_left_out
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": null, "note": "   "}, "s4": {"value": "  "}}', 1, :sv2, false, null, 'results'), false),
  'ok:{}', 'V3j: blank answers and notes are left out (undone)');
-- case: results_limits_ok
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1',
    jsonb_build_object('s2', jsonb_build_object('value', 'na', 'note', repeat('n', 300)), 's3', jsonb_build_object('value', 1000000),
                       's4', jsonb_build_object('value', repeat('x', 500))), 1, :sv2, false, null, 'results'), false),
  'ok:' || jsonb_build_object('s2', jsonb_build_object('value', 'na', 'note', repeat('n', 300)), 's3', jsonb_build_object('value', 1000000),
                              's4', jsonb_build_object('value', repeat('x', 500)))::text,
  'V3k: the boundaries pass: a 300-character note, 1,000,000, 500 characters (undone)');

select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": "pass"}}', 0, :sv3, false), false),
  'P0001:checklist_run_changed:-', 'V4: a save made on an older revision is refused (checklist_run_changed)');
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": "fail"}}', 0, :sv1, false), true,
                      format('select r.results::text from public.checklist_runs r where r.id = %L', :'run1')),
  'ok:1|{"s1": {"value": "pass"}, "s3": {"value": 12}}',
  'V5: a resent save id answers the row as it stands (revision 1, the first answers), whatever the new body says');
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": "pass"}}', 1, :sv2, false, null, 'saved'), false),
  'ok:true', 'V5a: a save that wrote says so (saved true; undone)');
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": "fail"}}', 0, :sv1, false, null, 'saved'), false),
  'ok:false', 'V5b: the resent save id says this call wrote nothing (saved false; desk check F9)');
select is(
  pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{}', 1, :sv2, false, repeat('n', 1001)), false) || ','
  || pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{}', 1, null, false), false) || ','
  || pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{}', null, :sv2, false), false),
  '22023:checklist_invalid:run_note_too_long,22023:checklist_invalid:required,22023:checklist_invalid:required',
  'V6: the run note is at most 1,000 characters, and a save names its save id and its revision');

-- case: complete_missing_required
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": "pass"}}', 1, :sv4, true, null, 'status'), false),
  '22023:checklist_incomplete:-:m=s1/f=/p=', 'V7a: completing needs every required step (checklist_incomplete names it)');
-- case: complete_fail_without_note
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "pass"}, "s2": {"value": "fail"}}', 1, :sv4, true, null, 'status'), false),
  '22023:checklist_incomplete:-:m=/f=s2/p=', 'V7b: completing needs a note on every failed check, required or not');
-- case: complete_both_lists
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s2": {"value": "fail"}}', 1, :sv4, true, null, 'status'), false),
  '22023:checklist_incomplete:-:m=s1/f=s2/p=', 'V7c: both lists at once, in step order');
-- case: complete_not_applicable_counts
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "na"}}', 1, :sv4, true, null, 'status'), false),
  'ok:completed', 'V7d: Not applicable on a required check completes (undone)');
-- case: complete_fail_with_note
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "fail", "note": "Two boxes crushed"}}', 1, :sv4, true, null, 'status'), false),
  'ok:completed', 'V7e: a failed check with a note completes (undone)');
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "na"}}', 1, :sv4, true, null, 'saved'), false),
  'ok:true', 'V7f: a save that completes the run says it wrote (saved true; undone): the app audits this completion');

select is(pg_temp.rpc(:mgr2, pg_temp.save(:'run1',
    '{"s1": {"value": "fail", "note": "Two boxes crushed"}, "s2": {"value": "na"}, "s3": {"value": 3}, "s4": {"value": "  two boxes short  "}}',
    1, :sv5, true, '  Driver waited  ', 'status')), 'ok:completed',
  'V8: a manager completes the run');
select is(
  (select r.status || '|' || (r.completed_by = :mgr2)::text || '|' || (r.completed_at is not null)::text || '|' || r.revision
          || '|' || r.results::text || '|' || r.note || '|' || (r.started_by = :mgr)::text
     from public.checklist_runs r where r.id = :'run1'),
  'completed|true|true|2|' || '{"s1": {"value": "fail", "note": "Two boxes crushed"}, "s2": {"value": "na"}, "s3": {"value": 3}, "s4": {"value": "two boxes short"}}'::jsonb::text
  || '|Driver waited|true',
  'V9: completing stamps who and when, keeps who started it, and stores the answers and the run note trimmed');
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run1', '{"s1": {"value": "pass"}}', 2, :sv6, false), false),
  'P0001:checklist_run_completed:-', 'V10: a completed run is final (checklist_run_completed)');
select is(pg_temp.rpc(:mgr2, pg_temp.save(:'run1', '{}', 1, :sv5, true, null, 'status'), false),
  'ok:completed', 'V11: the completing save, resent, answers the completed run (a replay, not a refusal)');
select is(pg_temp.rpc(:mgr2, pg_temp.save(:'run1', '{}', 1, :sv5, true, null, 'saved'), false),
  'ok:false', 'V11b: the resent completing save says it wrote nothing (saved false): no second completion audit row (desk check F9)');
select is(
  pg_temp.rpc(:stf, pg_temp.save(:'run2', '{}', 0, :sv6, false), false) || ','
  || pg_temp.rpc(:vwr, pg_temp.save(:'run2', '{}', 0, :sv6, false), false) || ','
  || pg_temp.rpc(:mgrNoAdj, pg_temp.save(:'run2', '{}', 0, :sv6, false), false),
  '42501:not_recorder:-,42501:not_recorder:-,42501:not_recorder:-',
  'V12: staff, viewers and a manager without stock:adjust may not save');
select is(
  pg_temp.rpc(:outB, pg_temp.save(:'run2', '{}', 0, :sv6, false), false) || ','
  || pg_temp.rpc(:nobody, pg_temp.save(:'run2', '{}', 0, :sv6, false), false) || ','
  || pg_temp.rpc(:mgr, pg_temp.save(:missing, '{}', 0, :sv6, false), false) || ','
  || pg_temp.rpc(null, pg_temp.save(:'run2', '{}', 0, :sv6, false), false),
  'P0002:checklist_run_not_found:-,P0002:checklist_run_not_found:-,P0002:checklist_run_not_found:-,42501:not_authenticated:-',
  'V13: another organization''s manager, a non-member and a missing run read as not found; an unsigned save is refused');

-- ══ R. Retire, and what it leaves ═══════════════════════════════════════════
select pg_temp.rpc(:mgr, pg_temp.start(:'rc3')) as "s3" \gset
select pg_temp.val(:'s3')::jsonb ->> 'runId' as "run3" \gset
select is(pg_temp.rpc(:stf, pg_temp.retire(:orgA, :'v2'), false) || ',' || pg_temp.rpc(:mgr, pg_temp.retire(:orgA, :'v1'), false),
  '42501:not_publisher:-,P0001:checklist_changed:-',
  'R1: staff may not turn the checklist off, and only the live version can be turned off');
select is(pg_temp.rpc(:mgr, pg_temp.retire(:orgA, :'v2'), true,
                      format('select count(*) filter (where retired_at is null) || ''/'' || bool_and(retired_at is not null)::text || ''/'' || (select (retired_by = %L)::text from public.checklist_versions where id = %L) from public.checklist_versions where organization_id = %L', :mgr, :'v2', :orgA)),
  'ok:' || :'v2' || '|0/true/true',
  'R2: turning off leaves no live version, and names who turned it off');
select is(coalesce(pg_temp.okjson(pg_temp.rpc(:mgr, pg_temp.start(:'rc1')))::text, 'refused'),
  jsonb_build_object('runId', :'run1', 'created', false, 'versionNumber', 2)::text,
  'R3: after the turn-off a start for a receipt with a run still answers it (correction 2)');
select is(pg_temp.rpc(:mgr, pg_temp.start(:'rc5'), false), 'P0001:no_checklist:-',
  'R4: with nothing live and no run, a start is refused (no_checklist)');
select is(pg_temp.rpc(:mgr, pg_temp.save(:'run3', '{"s1": {"value": "pass"}}', 0, :sv6, true, null, 'status')), 'ok:completed',
  'R5: a run on a retired version still completes');
insert into ids values ('v3', pg_temp.val(pg_temp.rpc(:mgr, pg_temp.pub(:orgA, 'Delivery checks', (select v from j where k = 'steps'), null, :cpA3)))::uuid);
select v as "v3" from ids where k = 'v3' \gset
select is(
  (select string_agg((r.version_id = :'v2')::text, ',' order by r.started_at)
     from public.checklist_runs r where r.id in (:'run1', :'run2', :'run3'))
  || '|' || (select v.version_number::text from public.checklist_versions v where v.id = :'v3'),
  'true,true,true|3',
  'R6: a newer version never moves a run: the three runs keep version 2 after version 3 is published');

-- ══ L. Visibility ══════════════════════════════════════════════════════════
select pg_temp.rpc(:mgr, pg_temp.start(:'rc4')) as "s4" \gset
select pg_temp.val(:'s4')::jsonb ->> 'runId' as "run4" \gset
create function pg_temp.seen(p_sub uuid) returns text language sql as $$
  select pg_temp.rpc(p_sub, format(
    'select (select count(*) filter (where purchase_order_id = %L) || ''/'' || count(*) filter (where purchase_order_id = %L)
               from public.checklist_runs where organization_id = %L)
            || ''|'' || (select count(*) from public.checklist_versions where organization_id = %L)',
    '03980000-0000-0000-0000-000000000301', '03980000-0000-0000-0000-000000000302',
    '03980000-0000-0000-0000-00000000000a', '03980000-0000-0000-0000-00000000000a'))
$$;
select is(pg_temp.seen(:mgr) || ',' || pg_temp.seen(:own), 'ok:3/1|3,ok:3/1|3',
  'L1: managers and owners see every run (3 on PO A1, 1 on PO A2) and every version');
select is(pg_temp.seen(:vwr) || ',' || pg_temp.seen(:stf), 'ok:3/0|3,ok:3/0|3',
  'L2: a viewer and staff assigned to warehouse A see the runs on its PO, not the run on a PO destined for warehouse A2');
select is(pg_temp.seen(:stfB), 'ok:0/1|3',
  'L3: staff assigned to warehouse A2 see only the run on its PO');
select is(pg_temp.seen(:vwrNoRd), 'ok:0/0|3',
  'L4: a viewer whose purchase_orders:read was revoked sees no run (the PO is hidden), and still the versions');
select is(pg_temp.seen(:outB) || ',' || pg_temp.seen(:nobody) || ',' || pg_temp.seen(:dis), 'ok:0/0|0,ok:0/0|0,ok:0/0|0',
  'L5: another organization, a non-member and a disabled member see no run and no version');
select is(
  pg_temp.rpc(:mgr, format($q$insert into public.checklist_versions (organization_id, binding, version_number, title, steps, published_by)
                              values (%L, 'receiving', 9, 'Forged', '[{"key": "s1", "kind": "check", "label": "x", "help": null, "required": false}]', %L) returning id::text$q$, :orgA, :mgr), false) || ','
  || pg_temp.rpc(:mgr, format('update public.checklist_runs set note = %L where id = %L returning id::text', 'forged', :'run2'), false) || ','
  || pg_temp.rpc(:mgr, format('delete from public.checklist_versions where id = %L returning id::text', :'v3'), false) || ','
  || pg_temp.rpc(:mgr, format('delete from public.checklist_runs where id = %L returning id::text', :'run2'), false) || ','
  || pg_temp.rpc(:mgr, format('update public.checklist_runs set deleted_users = %L where id = %L returning id::text', '{"started_by": "2026-01-01"}', :'run2'), false) || ','
  || pg_temp.rpc(null, 'select count(*)::text from public.checklist_runs', false, null, 'anon'),
  '42501:-:-,42501:-:-,42501:-:-,42501:-:-,42501:-:-,42501:-:-',
  'L6: no API role writes either table (not even a manager, and not the marker), and anon cannot read them');

-- ══ N. F4 writes no stock ══════════════════════════════════════════════════
select is(
  (select ((select count(*) from public.stock_movements) = b.sm)::text || ',' || ((select count(*) from public.receipts) = b.rc)::text
          || ',' || ((select count(*) from public.receipt_lines) = b.rl)::text
          || ',' || ((select coalesce(sum(quantity), 0) from public.item_stock_levels) = b.isl)::text
          || ',' || ((select coalesce(sum(quantity_on_hand), 0) from public.inventory_items) = b.qoh)::text
          || ',' || ((select coalesce(sum(quantity_received), 0) from public.purchase_order_items) = b.qr)::text
          || ',' || ((select string_agg(id::text || ':' || status, ',' order by id) from public.purchase_orders
                       where organization_id in (:orgA, :orgB, :orgC, :orgD)) = b.po_status)::text
          || ',' || ((select string_agg(id::text || ':' || status, ',' order by id) from public.receipts
                       where organization_id in (:orgA, :orgB, :orgC, :orgD)) = b.rc_status)::text
     from n_before b),
  'true,true,true,true,true,true,true,true',
  'N1: every publish, retire, start and save above left stock, movements, holdings, receipts, receipt lines and the purchase orders exactly as they were');
select is(pg_temp.rpc(:mgr, format('select v.status from public.reverse_receipt(%L, %L) v', :'rc3', '0398 reversal of a checked receipt'), true,
                      format('select r.status || ''/'' || (select status from public.receipts where id = %L) || ''/'' || r.revision from public.checklist_runs r where r.id = %L', :'rc3', :'run3')),
  'ok:reversal|completed/reversed/1',
  'N2: reverse_receipt on a receipt with a completed run succeeds, and the run stays as it was');

-- ══ D. An account deletion keeps the records and stamps the people ═════════
insert into ids values ('vD1', pg_temp.val(pg_temp.rpc(:del, pg_temp.pub(:orgD, 'Delivery checks', (select v from j where k = 'steps'), null, :cpD1)))::uuid);
select v as "vD1" from ids where k = 'vD1' \gset
select pg_temp.val(pg_temp.rpc(:del, pg_temp.retire(:orgD, :'vD1'))) as "vD1r" \gset
select pg_temp.val(pg_temp.rpc(:ownD, pg_temp.pub(:orgD, 'Delivery checks', (select v from j where k = 'steps'), null, :cpD2))) as "vD2" \gset
select pg_temp.rpc(:del, pg_temp.start(:'rcD')) as "sD" \gset
select pg_temp.val(:'sD')::jsonb ->> 'runId' as "runD" \gset
select pg_temp.val(pg_temp.rpc(:del, pg_temp.save(:'runD', '{"s1": {"value": "pass"}}', 0, :sv7, true, null, 'status'))) as "runDdone" \gset
select is(
  pg_temp.undone(format('delete from auth.users where id = %L', :del),
    format($q$select (select coalesce(v.published_by::text, 'null') || '/' || coalesce(v.retired_by::text, 'null') || '/'
                             || (v.deleted_users ? 'published_by')::text || '/' || (v.deleted_users ? 'retired_by')::text
                        from public.checklist_versions v where v.id = %L)
              || '|' || (select coalesce(r.started_by::text, 'null') || '/' || coalesce(r.completed_by::text, 'null') || '/'
                                || (r.deleted_users ? 'started_by')::text || '/' || (r.deleted_users ? 'completed_by')::text
                                || '/' || r.status || '/' || (r.completed_at is not null)::text
                           from public.checklist_runs r where r.id = %L)
              || '|' || (select count(*) from public.checklist_versions where organization_id = %L)
              || '/' || (select count(*) from public.checklist_runs where organization_id = %L)
              || '|' || (select (v.published_by = %L)::text from public.checklist_versions v where v.id = %L)$q$,
           :'vD1', :'runD', :orgD, :orgD, :ownD, :'vD2')),
  'ok:1|null/null/true/true|null/null/true/true/completed/true|2/1|true',
  'D1: deleting the account of a manager who published, turned off, started and completed: both rows are kept, every person column is null and stamped (the 0393 marker; the CHECKs hold), the run stays completed, and the other publisher is untouched (undone)');
select is(
  (select count(*) from public.checklist_runs where deleted_users is not null)::text || '/'
  || (select count(*) from public.checklist_versions where deleted_users is not null)::text || '/'
  || (select count(*) from public.checklist_runs where organization_id = :orgD and started_by = :del)::text,
  '0/0/1',
  'D2: no run or version carries a stamp while its people exist: every publish, retire, start and save above wrote none, and the deletion was undone');

-- ══ Z. The frozen receipt objects ══════════════════════════════════════════
select is(
  (select string_agg(n.nspname || '.' || p.proname || ':' || md5(p.prosrc), ',' order by n.nspname collate "C", p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('ledger', 'post_receipt_v2'), ('ledger', 'reverse_receipt'),
                                     ('public', 'recompute_po_status'), ('public', 'tg_ledger_only_guard'))),
  'ledger.post_receipt_v2:f044c3a1ea7b125a094a42f736db77c8,ledger.reverse_receipt:11a98ae96479445f86c303d85c9e0b8f,'
  'public.recompute_po_status:3a9059d9d540d0a1e8b5ae9a22231028,public.tg_ledger_only_guard:17b5b1303f86319f8500b1e9b5cec211',
  'Z1: the receipt ledger bodies, recompute_po_status and the ledger guard are the text production runs (F4 changes none of them)');
select is(
  (select string_agg(c.relname || '.' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)), ',' order by c.relname collate "C", t.tgname collate "C")
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relnamespace = 'public'::regnamespace and c.relname in ('receipts', 'receipt_lines', 'receipt_line_lots')
      and t.tgname like 'trg\_zz\_%guard'),
  'receipt_line_lots.trg_zz_receipt_line_lots_guard:d9d7423348f38f2cf06b8cc653c63870,'
  'receipt_lines.trg_zz_receipt_lines_guard:6f362d282bd740b799dbfe52fff957ef,'
  'receipts.trg_zz_receipts_guard:b955b18ce9a8b1386a734f58fdbfd2f3',
  'Z2: the three receipt guards are the definitions production runs');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prorettype::regtype::text,
                     ',' order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('post_receipt_v2', 'reverse_receipt')),
  'post_receipt_v2:false:p_purchase_order_id uuid, p_warehouse_id uuid, p_lines jsonb, p_idempotency_key text, p_request_hash text, p_notes text:receipts,'
  'reverse_receipt:false:p_receipt_id uuid, p_reason text:receipts',
  'Z3: the receipt RPCs installed phones call keep their contract (INVOKER, arguments, result)');

select * from finish();
rollback;
