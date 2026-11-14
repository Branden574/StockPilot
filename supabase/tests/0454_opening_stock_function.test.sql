-- supabase/tests/0454_opening_stock_function.test.sql
-- Proves migration 0454: opening stock is recorded through the stock ledger's
-- opening function, public.open_item_stock, and Duplicate opens its stock
-- through it.
--
-- PART 1 (O1)   Headers and execute rights of the new and restated functions.
-- PART 2 (W)    The web and phone create paths: an item inserted at 0 as the
--               signed-in member, then opened; size runs, bulk create and
--               imports open many items in one call, all or nothing.
-- PART 3 (O)    Where the stock lands (primary site, Unplaced fallback with a
--               null destination, organization Unplaced), decimals, the
--               15-minute window for the creator, and every refusal.
-- PART 4 (M)    Each kind of member: viewer, a viewer granted items:create
--               (no stock rights), staff without the item's warehouse,
--               manager, admin, a member of another organization, the
--               service role, anon.
-- PART 5 (L)    Duplicate.
-- PART 6 (S, R) The seed trigger places a stocked insert by the shared rule;
--               adjustments and receipts after an opening.
-- PART 7 (G)    The census of invoker writers of stock_movements outside the
--               ledger schema.
-- PART 8 (N)    The stock:adjust floor for every kind of seat (owner, a viewer
--               granted stock:adjust, staff with it turned off, pending,
--               disabled, an expired act-as seat), quantities that round to 0,
--               updated_by, the duplicateOf read check, and Duplicate when the
--               opening is refused.
--
-- Roles: every member call runs through pg_temp.run, which sets the role and
-- the JWT subject, and answers ERR:<sqlstate>:<message>:<hint>:<detail> on a
-- refusal. anon's rights are read from the catalog, never called.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(107);

\set orgA    '\'04540000-0000-4000-8000-00000000000a\''
\set orgB    '\'04540000-0000-4000-8000-00000000000b\''
\set u_stf   '\'04540000-0000-4000-8000-0000000000a1\''
\set u_stf2  '\'04540000-0000-4000-8000-0000000000a2\''
\set u_stw2  '\'04540000-0000-4000-8000-0000000000a3\''
\set u_vwr   '\'04540000-0000-4000-8000-0000000000a4\''
\set u_vic   '\'04540000-0000-4000-8000-0000000000a5\''
\set u_mgr   '\'04540000-0000-4000-8000-0000000000a6\''
\set u_adm   '\'04540000-0000-4000-8000-0000000000a7\''
\set u_mgrB  '\'04540000-0000-4000-8000-0000000000b1\''
\set whA     '\'04540000-0000-4000-8000-0000000000c1\''
\set whA2    '\'04540000-0000-4000-8000-0000000000c2\''
\set whB     '\'04540000-0000-4000-8000-0000000000c3\''
\set siteA   '\'04540000-0000-4000-8000-0000000000d1\''
\set siteA2  '\'04540000-0000-4000-8000-0000000000d2\''
\set iSite   '\'04540000-0000-4000-8000-0000000000e1\''
\set iStg    '\'04540000-0000-4000-8000-0000000000e2\''
\set iOWh    '\'04540000-0000-4000-8000-0000000000e3\''
\set iNoWh   '\'04540000-0000-4000-8000-0000000000e4\''
\set iDec    '\'04540000-0000-4000-8000-0000000000e5\''
\set iOther  '\'04540000-0000-4000-8000-0000000000e6\''
\set iOld    '\'04540000-0000-4000-8000-0000000000e7\''
\set iRecent '\'04540000-0000-4000-8000-0000000000e8\''
\set iKit    '\'04540000-0000-4000-8000-0000000000e9\''
\set iDel    '\'04540000-0000-4000-8000-0000000000ea\''
\set iMov    '\'04540000-0000-4000-8000-0000000000eb\''
\set iHold   '\'04540000-0000-4000-8000-0000000000ec\''
\set iStock  '\'04540000-0000-4000-8000-0000000000ed\''
\set iVwr    '\'04540000-0000-4000-8000-0000000000f1\''
\set iVic    '\'04540000-0000-4000-8000-0000000000f2\''
\set iStw2   '\'04540000-0000-4000-8000-0000000000f3\''
\set iMgr    '\'04540000-0000-4000-8000-0000000000f4\''
\set iAdm    '\'04540000-0000-4000-8000-0000000000f5\''
\set iLock   '\'04540000-0000-4000-8000-0000000000f6\''
\set iLockC  '\'04540000-0000-4000-8000-0000000000f7\''
\set iB      '\'04540000-0000-4000-8000-0000000000f8\''
\set iOrig   '\'04540000-0000-4000-8000-000000000101\''
\set iDupT   '\'04540000-0000-4000-8000-000000000102\''
\set iSvc    '\'04540000-0000-4000-8000-000000000103\''
\set iSeed   '\'04540000-0000-4000-8000-000000000104\''
\set iMissing '\'04540000-0000-4000-8000-0000000009ff\''
\set u_own   '\'04540000-0000-4000-8000-0000000000a8\''
\set u_norev '\'04540000-0000-4000-8000-0000000000a9\''
\set u_pend  '\'04540000-0000-4000-8000-0000000000aa\''
\set u_dis   '\'04540000-0000-4000-8000-0000000000ab\''
\set u_exp   '\'04540000-0000-4000-8000-0000000000ac\''
\set u_vsa   '\'04540000-0000-4000-8000-0000000000ad\''
\set iOwn    '\'04540000-0000-4000-8000-000000000301\''
\set iVsa    '\'04540000-0000-4000-8000-000000000302\''
\set iVsaW   '\'04540000-0000-4000-8000-000000000303\''
\set iNorev  '\'04540000-0000-4000-8000-000000000304\''
\set iPend   '\'04540000-0000-4000-8000-000000000305\''
\set iDis    '\'04540000-0000-4000-8000-000000000306\''
\set iExp    '\'04540000-0000-4000-8000-000000000307\''
\set iTiny   '\'04540000-0000-4000-8000-000000000308\''
\set iTiny2  '\'04540000-0000-4000-8000-000000000309\''
\set iUpd    '\'04540000-0000-4000-8000-00000000030a\''
\set iOnh    '\'04540000-0000-4000-8000-00000000030b\''
\set poA     '\'04540000-0000-4000-8000-000000000201\''
\set poLine  '\'04540000-0000-4000-8000-000000000202\''

-- ── Helpers ─────────────────────────────────────────────────────────────────
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub, 'role', p_as, 'aal', 'aal1')::text, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_msg, '') || ':' || coalesce(v_hint, '')
           || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;

-- open_item_stock as a member: the number of rows it returned, or ERR:...
create function pg_temp.open(p_sub uuid, p_org uuid, p_lines jsonb) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub,
    format('select count(*)::text from public.open_item_stock(%L, %L::jsonb)', p_org, p_lines));
$$;

-- An item's on-hand | sum of holdings | movement count | sum of movements.
create function pg_temp.st(p_item uuid) returns text language sql as $$
  select coalesce((select quantity_on_hand::text from public.inventory_items where id = p_item), 'gone')
    || '|' || coalesce((select sum(quantity)::text from public.item_stock_levels where item_id = p_item), 'none')
    || '|' || (select count(*)::text from public.stock_movements where item_id = p_item)
    || '|' || coalesce((select sum(quantity_change)::text from public.stock_movements where item_id = p_item), '0');
$$;

-- Where an item's one holding is: <kind or site>:<warehouse or org>.
create function pg_temp.loc(p_item uuid) returns text language sql as $$
  select coalesce(string_agg(coalesce(l.kind, 'site') || ':' || coalesce(l.warehouse_id::text, 'org'), ',' order by l.id), 'none')
    from public.item_stock_levels s join public.locations l on l.id = s.location_id
   where s.item_id = p_item;
$$;

-- An item's 'initial' movement: type | via_ledger | user | to | reason | reference type | reference id.
create function pg_temp.mv(p_item uuid) returns text language sql as $$
  select coalesce(string_agg(m.movement_type || '|' || coalesce(m.via_ledger::text, 'null') || '|'
           || coalesce(m.user_id::text, 'null') || '|' || coalesce(m.to_location_id::text, 'null') || '|'
           || coalesce(m.reason, 'null') || '|' || coalesce(m.reference_type, 'null') || '|'
           || coalesce(m.reference_id::text, 'null'), ',' order by m.created_at, m.id), 'none')
    from public.stock_movements m where m.item_id = p_item;
$$;

-- ── Fixtures (as postgres: RLS bypassed, guards exempt) ─────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_stf,  'stf-0454@test.local',  '{}'::jsonb),
  (:u_stf2, 'stf2-0454@test.local', '{}'::jsonb),
  (:u_stw2, 'stw2-0454@test.local', '{}'::jsonb),
  (:u_vwr,  'vwr-0454@test.local',  '{}'::jsonb),
  (:u_vic,  'vic-0454@test.local',  '{}'::jsonb),
  (:u_mgr,  'mgr-0454@test.local',  '{}'::jsonb),
  (:u_adm,  'adm-0454@test.local',  '{}'::jsonb),
  (:u_mgrB, 'mgrb-0454@test.local', '{}'::jsonb),
  (:u_own,  'own-0454@test.local',  '{}'::jsonb),
  (:u_norev,'norev-0454@test.local','{}'::jsonb),
  (:u_pend, 'pend-0454@test.local', '{}'::jsonb),
  (:u_dis,  'dis-0454@test.local',  '{}'::jsonb),
  (:u_exp,  'exp-0454@test.local',  '{}'::jsonb),
  (:u_vsa,  'vsa-0454@test.local',  '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Opening Org A 0454', 'opening-org-a-0454'),
  (:orgB, 'Opening Org B 0454', 'opening-org-b-0454');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_stf,  'staff',   now()),
  (:orgA, :u_stf2, 'staff',   now()),
  (:orgA, :u_stw2, 'staff',   now()),
  (:orgA, :u_vwr,  'viewer',  now()),
  (:orgA, :u_vic,  'viewer',  now()),
  (:orgA, :u_mgr,  'manager', now()),
  (:orgA, :u_adm,  'admin',   now()),
  (:orgB, :u_mgrB, 'manager', now()),
  (:orgA, :u_own,   'owner',   now()),
  (:orgA, :u_norev, 'staff',   now()),
  (:orgA, :u_pend,  'staff',   null),
  (:orgA, :u_dis,   'staff',   now()),
  (:orgA, :u_exp,   'admin',   now()),
  (:orgA, :u_vsa,   'viewer',  now());
-- An act-as seat whose time is up, and a disabled account.
update public.organization_members set impersonation_expires_at = now() - interval '1 minute'
 where organization_id = :orgA and user_id = :u_exp;
insert into public.user_profiles (id, email, disabled_at) values (:u_dis, 'dis-0454@test.local', now())
on conflict (id) do update set disabled_at = excluded.disabled_at;

-- The warehouse trigger creates each warehouse's Staging and Unplaced.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, 'Opening WH A 0454',  'O0454A',  'active'),
  (:whA2, :orgA, 'Opening WH A2 0454', 'O0454A2', 'active'),
  (:whB,  :orgB, 'Opening WH B 0454',  'O0454B',  'active');

-- Sites (kind null) in each A warehouse.
insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:siteA,  :orgA, :whA,  'Site A 0454',  'room'),
  (:siteA2, :orgA, :whA2, 'Site A2 0454', 'room');

insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :u_stf,  :whA,  true),
  (:orgA, :u_stf2, :whA,  true),
  (:orgA, :u_stw2, :whA2, true),
  (:orgA, :u_vwr,  :whA,  true),
  (:orgA, :u_vic,  :whA,  true),
  (:orgA, :u_norev, :whA, true),
  (:orgA, :u_pend,  :whA, true),
  (:orgA, :u_dis,   :whA, true),
  (:orgA, :u_vsa,   :whA, true);

-- u_vic may create items but holds no stock right; u_vsa is a viewer granted
-- items:create and stock:adjust; u_norev is staff with stock:adjust turned off.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :u_vic,   'items:create', true),
  (:orgA, :u_vsa,   'items:create', true),
  (:orgA, :u_vsa,   'stock:adjust', true),
  (:orgA, :u_norev, 'stock:adjust', false);

-- Fresh items at 0, created by the member named (as the create paths leave
-- them: the 0364 guard stamps created_by and created_at on a member's insert).
insert into public.inventory_items
  (id, organization_id, warehouse_id, primary_location_id, sku, name, quantity_on_hand, status, item_type,
   created_by, created_at) values
  (:iSite,   :orgA, :whA,  :siteA,  'O0454-SITE',   'Site primary',     0, 'active', 'product', :u_stf,  now()),
  (:iStg,    :orgA, :whA,  null,    'O0454-STG',    'Staging primary',  0, 'active', 'product', :u_stf,  now()),
  (:iOWh,    :orgA, :whA,  :siteA2, 'O0454-OWH',    'Other wh primary', 0, 'active', 'product', :u_stf,  now()),
  (:iNoWh,   :orgA, null,  null,    'O0454-NOWH',   'No warehouse',     0, 'active', 'product', :u_stf,  now()),
  (:iDec,    :orgA, :whA,  null,    'O0454-DEC',    'Decimal',          0, 'active', 'product', :u_stf,  now()),
  (:iOther,  :orgA, :whA,  null,    'O0454-OTHER',  'Another member',   0, 'active', 'product', :u_stf2, now()),
  (:iOld,    :orgA, :whA,  null,    'O0454-OLD',    'Sixteen minutes',  0, 'active', 'product', :u_stf,  now() - interval '16 minutes'),
  (:iRecent, :orgA, :whA,  null,    'O0454-RECENT', 'Fourteen minutes', 0, 'active', 'product', :u_stf,  now() - interval '14 minutes'),
  (:iMov,    :orgA, :whA,  null,    'O0454-MOV',    'Has a movement',   0, 'active', 'product', :u_stf,  now()),
  (:iHold,   :orgA, :whA,  null,    'O0454-HOLD',   'Has a holding',    0, 'active', 'product', :u_stf,  now()),
  (:iVwr,    :orgA, :whA,  null,    'O0454-VWR',    'Viewer item',      0, 'active', 'product', :u_vwr,  now()),
  (:iVic,    :orgA, :whA,  null,    'O0454-VIC',    'Items:create item',0, 'active', 'product', :u_vic,  now()),
  (:iStw2,   :orgA, :whA,  null,    'O0454-STW2',   'Not my warehouse', 0, 'active', 'product', :u_stw2, now()),
  (:iMgr,    :orgA, :whA,  null,    'O0454-MGR',    'Manager item',     0, 'active', 'product', :u_mgr,  now()),
  (:iAdm,    :orgA, :whA2, null,    'O0454-ADM',    'Admin item',       0, 'active', 'product', :u_adm,  now()),
  (:iLock,   :orgA, :whA,  null,    'O0454-LOCK',   'Lock probe',       0, 'active', 'product', :u_mgrB, now()),
  (:iLockC,  :orgA, :whA,  null,    'O0454-LOCKC',  'Lock control',     0, 'active', 'product', :u_mgrB, now()),
  (:iB,      :orgB, :whB,  null,    'O0454-B',      'Org B item',       0, 'active', 'product', :u_mgrB, now()),
  (:iOwn,    :orgA, :whA,  null,    'O0454-OWN',    'Owner item',       0, 'active', 'product', :u_own,  now()),
  (:iVsa,    :orgA, null,  null,    'O0454-VSA',    'Viewer no wh',     0, 'active', 'product', :u_vsa,  now()),
  (:iVsaW,   :orgA, :whA,  null,    'O0454-VSAW',   'Viewer in wh',     0, 'active', 'product', :u_vsa,  now()),
  (:iNorev,  :orgA, :whA,  null,    'O0454-NOREV',  'Adjust off',       0, 'active', 'product', :u_norev,now()),
  (:iPend,   :orgA, :whA,  null,    'O0454-PEND',   'Pending',          0, 'active', 'product', :u_pend, now()),
  (:iDis,    :orgA, :whA,  null,    'O0454-DIS',    'Disabled',         0, 'active', 'product', :u_dis,  now()),
  (:iExp,    :orgA, :whA,  null,    'O0454-EXP',    'Expired act-as',   0, 'active', 'product', :u_exp,  now()),
  (:iTiny,   :orgA, :whA,  null,    'O0454-TINY',   'Rounds to 0',      0, 'active', 'product', :u_stf,  now()),
  (:iTiny2,  :orgA, :whA,  null,    'O0454-TINY2',  'Rounds up',        0, 'active', 'product', :u_stf,  now());
-- iUpd: last updated by someone else, so the opening's updated_by shows.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by, created_at, updated_by)
values (:iUpd, :orgA, :whA, 'O0454-UPD', 'Updated by', 0, 'active', 'product', :u_stf, now(), :u_mgr);
-- iOnh: on-hand set after the insert, so it has stock on hand but no holding
-- and no movement (the seed trigger runs on insert only).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by, created_at)
values (:iOnh, :orgA, :whA, 'O0454-ONH', 'On hand only', 0, 'active', 'product', :u_stf, now());
update public.inventory_items set quantity_on_hand = 4 where id = :iOnh;
update public.inventory_items set primary_location_id =
  (select id from public.locations where warehouse_id = :whA and kind = 'staging')
 where id = :iStg;
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, is_bundle, created_by, created_at)
values (:iKit, :orgA, :whA, 'O0454-KIT', 'Kit', 0, 'active', 'product', true, :u_stf, now());
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, deleted_at, created_by, created_at)
values (:iDel, :orgA, :whA, 'O0454-DEL', 'Deleted', 0, 'active', 'product', now(), :u_stf, now());
-- iStock is inserted with stock (the seed trigger places it); iMov gets a
-- movement and iHold a holding without either touching on-hand.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by, created_at)
values (:iStock, :orgA, :whA, 'O0454-STOCK', 'Already stocked', 5, 'active', 'product', :u_stf, now());
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id)
values (:orgA, :iMov, 'adjust', 0, 0, 0, :u_stf);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
values (:orgA, :iHold, (select id from public.locations where warehouse_id = :whA and kind = 'unplaced'), 3);

-- The original for Duplicate: in whA, the site as primary, 10 on hand.
-- iDupT: a fresh item of u_stf for the duplicateOf checks.
insert into public.inventory_items
  (id, organization_id, warehouse_id, primary_location_id, sku, name, quantity_on_hand, status, item_type, created_by) values
  (:iOrig, :orgA, :whA, :siteA, 'O0454-ORIG', 'Original', 10, 'active', 'product', :u_mgr),
  (:iDupT, :orgA, :whA, null,   'O0454-DUPT', 'Dup target', 0, 'active', 'product', :u_stf);

-- ═══ PART 1: headers ════════════════════════════════════════════════════════
select is(
  (select prosecdef::text || '|' || array_to_string(proconfig, ',') || '|' || pg_get_userbyid(proowner)
     from pg_proc where oid = 'public.open_item_stock(uuid, jsonb)'::regprocedure),
  'true|search_path=public|postgres',
  'O1a: open_item_stock is SECURITY DEFINER with search_path public, owned by postgres');
select is(
  has_function_privilege('authenticated', 'public.open_item_stock(uuid, jsonb)', 'execute')::text || '|'
  || has_function_privilege('service_role', 'public.open_item_stock(uuid, jsonb)', 'execute')::text || '|'
  || has_function_privilege('anon', 'public.open_item_stock(uuid, jsonb)', 'execute')::text || '|'
  || exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = 'public.open_item_stock(uuid, jsonb)'::regprocedure
                and a.grantee = 0 and a.privilege_type = 'EXECUTE')::text,
  'true|true|false|false',
  'O1b: authenticated and service_role may execute open_item_stock; anon and PUBLIC may not');
select is(
  (select pg_get_function_result(oid) from pg_proc where oid = 'public.open_item_stock(uuid, jsonb)'::regprocedure),
  'TABLE(opened_item_id uuid, opened_location_id uuid, opened_movement_id uuid)',
  'O1c: open_item_stock returns one row per opened line');
select is(
  (select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') || '|'
          || has_function_privilege('authenticated', p.oid, 'execute')::text || '|'
          || has_function_privilege('service_role', p.oid, 'execute')::text || '|'
          || has_function_privilege('anon', p.oid, 'execute')::text || '|'
          || exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)::text
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_opening_stock_location'),
  'true|search_path=public|false|false|false|false',
  'O1d: _opening_stock_location is SECURITY DEFINER and executable by its owner only');
select is(
  (select prosecdef::text || '|' || array_to_string(proconfig, ',') || '|' || pg_get_userbyid(proowner) || '|'
          || has_function_privilege('authenticated', oid, 'execute')::text || '|'
          || has_function_privilege('service_role', oid, 'execute')::text || '|'
          || has_function_privilege('anon', oid, 'execute')::text
     from pg_proc where oid = 'public.duplicate_inventory_item(uuid, jsonb)'::regprocedure),
  'false|search_path=public|postgres|true|true|false',
  'O1e: duplicate_inventory_item keeps SECURITY INVOKER, search_path, owner and execute rights');
select is(
  (select prosecdef::text || '|' || array_to_string(proconfig, ',') || '|' || pg_get_userbyid(proowner) || '|'
          || has_function_privilege('authenticated', oid, 'execute')::text || '|'
          || has_function_privilege('service_role', oid, 'execute')::text
     from pg_proc where oid = 'public.tg_seed_initial_level()'::regprocedure),
  'true|search_path=public|postgres|false|true',
  'O1f: tg_seed_initial_level keeps SECURITY DEFINER, search_path, owner and execute rights');
select is(
  (select string_agg(tgname::text || ':' || tgenabled::text, ',' order by tgname) from pg_trigger
    where tgrelid = 'public.inventory_items'::regclass and tgfoid = 'public.tg_seed_initial_level()'::regprocedure),
  'trg_seed_initial_level:O',
  'O1g: the seed trigger is still the one AFTER INSERT trigger calling tg_seed_initial_level');

-- ═══ PART 2: the create paths ══════════════════════════════════════════════
-- W1-W6: single create on the web and through the phone's route
-- (InventoryService.create): the member inserts the item at 0, then opens it.
create temp table w (k text primary key, id uuid);
grant all on w to authenticated;
insert into w values ('web', null);
update w set id = (pg_temp.run('authenticated', :u_stf::uuid, format(
  $$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by)
    values (%L, %L, 'O0454-WEB', 'Web create', 0, 'active', 'product', %L) returning id::text$$,
  :orgA, :whA, :u_stf)))::uuid where k = 'web';
select is(pg_temp.st((select id from w where k = 'web')), '0.0000|none|0|0',
  'W1: a member''s item inserted at 0 has no holding and no movement');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', (select id from w where k = 'web'), 'quantity', 7))),
  '1', 'W2: the creator opens 7 on the new item (one row returned)');
select is(pg_temp.st((select id from w where k = 'web')), '7.0000|7.0000|1|7.0000',
  'W3: on-hand 7, holdings 7, one movement summing to 7');
select is(pg_temp.loc((select id from w where k = 'web')), 'unplaced:' || :whA::text,
  'W4: the stock waits in the warehouse''s Unplaced');
select is(pg_temp.mv((select id from w where k = 'web')),
  'initial|true|' || :u_stf::text || '|null|null|null|null',
  'W5: one ''initial'' movement, written by the ledger, attributed to the creator, destination null (Unplaced)');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', (select id from w where k = 'web'), 'quantity', 7))),
  'ERR:42501:opening_stock_refused::' || (select id::text from w where k = 'web'),
  'W6: a second opening of the same item is refused');

-- W7-W10: a size run, bulk create and imports insert many items at 0 in one
-- statement and open them in one call, each with its own quantity.
insert into w values ('b1', null), ('b2', null), ('b3', null);
select pg_temp.run('authenticated', :u_stf::uuid, format(
  $$with ins as (
      insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by)
      select %L, %L, 'O0454-RUN-' || n, 'Run ' || n, 0, 'active', 'product', %L from generate_series(1, 3) n
      returning id, sku)
    update w set id = ins.id from ins where w.k = 'b' || right(ins.sku, 1) returning 1$$,
  :orgA, :whA, :u_stf));
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', (select id from w where k = 'b1'), 'quantity', 1),
    jsonb_build_object('itemId', (select id from w where k = 'b2'), 'quantity', 2),
    jsonb_build_object('itemId', (select id from w where k = 'b3'), 'quantity', 3))),
  '3', 'W7: one call opens three new items');
select is(pg_temp.st((select id from w where k = 'b1')) || ',' || pg_temp.st((select id from w where k = 'b2'))
          || ',' || pg_temp.st((select id from w where k = 'b3')),
  '1.0000|1.0000|1|1.0000,2.0000|2.0000|1|2.0000,3.0000|3.0000|1|3.0000',
  'W8: each item gets its own quantity, holding and movement');
-- All or nothing: a batch with one refused line opens none of the others.
insert into w values ('c1', null), ('c2', null);
select pg_temp.run('authenticated', :u_stf::uuid, format(
  $$with ins as (
      insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by)
      select %L, %L, 'O0454-BATCH-' || n, 'Batch ' || n, 0, 'active', 'product', %L from generate_series(1, 2) n
      returning id, sku)
    update w set id = ins.id from ins where w.k = 'c' || right(ins.sku, 1) returning 1$$,
  :orgA, :whA, :u_stf));
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', (select id from w where k = 'c1'), 'quantity', 4),
    jsonb_build_object('itemId', :iOther::uuid, 'quantity', 4),
    jsonb_build_object('itemId', (select id from w where k = 'c2'), 'quantity', 4))),
  'ERR:P0002:item_not_found::' || :iOther::text,
  'W9: a batch naming another member''s item is refused as an unknown id');
select is(pg_temp.st((select id from w where k = 'c1')) || ',' || pg_temp.st((select id from w where k = 'c2')),
  '0.0000|none|0|0,0.0000|none|0|0',
  'W10: and nothing of that batch was written');

-- ═══ PART 3: where stock lands, the window, refusals ═══════════════════════
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iSite::uuid, 'quantity', 5))),
  '1', 'O2: an item whose primary is a site of its warehouse opens');
select is(pg_temp.loc(:iSite) || '|' || pg_temp.mv(:iSite),
  'site:' || :whA::text || '|initial|true|' || :u_stf::text || '|' || :siteA::text || '|null|null|null',
  'O3: the stock is at the site, and the movement names it as the destination');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iStg::uuid, 'quantity', 5))),
  '1', 'O4: an item whose primary is the Staging location opens');
select is(pg_temp.loc(:iStg) || '|' || pg_temp.mv(:iStg),
  'unplaced:' || :whA::text || '|initial|true|' || :u_stf::text || '|null|null|null|null',
  'O5: a Staging primary falls back to Unplaced, with a null destination');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOWh::uuid, 'quantity', 5))),
  '1', 'O6: an item whose primary is in another warehouse opens');
select is(pg_temp.loc(:iOWh) || '|' || pg_temp.mv(:iOWh),
  'unplaced:' || :whA::text || '|initial|true|' || :u_stf::text || '|null|null|null|null',
  'O7: a primary in another warehouse falls back to the item''s own Unplaced, with a null destination');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iNoWh::uuid, 'quantity', 5))),
  '1', 'O8: an item with no warehouse opens');
select is(pg_temp.loc(:iNoWh) || '|' || pg_temp.st(:iNoWh),
  'unplaced:org|5.0000|5.0000|1|5.0000',
  'O9: its stock is at the organization''s Unplaced, created on demand');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iDec::uuid, 'quantity', 2.5))),
  '1', 'O10: a decimal quantity opens');
select is(pg_temp.st(:iDec), '2.5000|2.5000|1|2.5000', 'O11: 2.5 on hand, held and moved');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOther::uuid, 'quantity', 5))),
  'ERR:P0002:item_not_found::' || :iOther::text,
  'O12: another member''s new item answers P0002, as an unknown id');
-- The locking query names the caller as creator, so the other member's row
-- was never locked by W9 or O12 (a lock rolled back still leaves xmax; M11
-- below shows the control).
select is((select xmax::text from public.inventory_items where id = :iOther), '0',
  'O12b: and its row was not locked');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOld::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iOld::text,
  'O13: the creator''s item created 16 minutes ago is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iRecent::uuid, 'quantity', 5))),
  '1', 'O14: the creator''s item created 14 minutes ago opens');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iKit::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iKit::text,
  'O15: a kit is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iDel::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iDel::text,
  'O16: a deleted item is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iMov::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iMov::text,
  'O17: an item with a movement is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iHold::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iHold::text,
  'O18: an item with a holding is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iStock::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iStock::text,
  'O19: an item with stock on hand is refused');
select is(pg_temp.st(:iKit) || ',' || pg_temp.st(:iDel) || ',' || pg_temp.st(:iOther) || ',' || pg_temp.st(:iOld),
  '0.0000|none|0|0,0.0000|none|0|0,0.0000|none|0|0,0.0000|none|0|0',
  'O20: every refused item is unchanged');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', :iRecent::uuid, 'quantity', 1),
    jsonb_build_object('itemId', :iRecent::uuid, 'quantity', 1))),
  'ERR:22023:duplicate_item::', 'O21: a repeated itemId is refused');
select is(pg_temp.open(:u_stf, :orgA,
    (select jsonb_agg(jsonb_build_object('itemId', gen_random_uuid(), 'quantity', 1)) from generate_series(1, 1001))),
  'ERR:22023:too_many_items::', 'O22: more than 1,000 lines are refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOther::uuid, 'quantity', 0))),
  'ERR:22023:invalid_lines::', 'O23: a quantity of 0 is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOther::uuid, 'quantity', -1))),
  'ERR:22023:invalid_lines::', 'O24: a negative quantity is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOther::uuid, 'quantity', '5'))),
  'ERR:22023:invalid_lines::', 'O25: a quantity that is not a number is refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', 'not-a-uuid', 'quantity', 5))),
  'ERR:22023:invalid_lines::', 'O26: an itemId that is not a uuid is refused');
select is(pg_temp.open(:u_stf, :orgA, '{"itemId": "x"}'::jsonb),
  'ERR:22023:invalid_lines::', 'O27: lines that are not an array are refused');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', :iOther::uuid, 'quantity', 1, 'duplicateOf', 'nope'))),
  'ERR:22023:invalid_lines::', 'O28: a duplicateOf that is not a uuid is refused');
create temp table cnt as
  select (select count(*) from public.stock_movements) as movements,
         (select count(*) from public.item_stock_levels) as holdings;
select is(pg_temp.open(:u_stf, :orgA, '[]'::jsonb), '0', 'O29: an empty array returns no rows');
select is(
  (select count(*) from public.stock_movements)::text || '|' || (select count(*) from public.item_stock_levels)::text,
  (select movements::text || '|' || holdings::text from cnt),
  'O30: and writes nothing');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iMissing::uuid, 'quantity', 1))),
  'ERR:P0002:item_not_found::' || :iMissing::text, 'O31: an unknown item gives P0002');

-- ═══ PART 4: each kind of member ══════════════════════════════════════════
select is(pg_temp.open(:u_vwr, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iVwr::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'M1: a viewer is refused (hint stock:adjust)');
select is(pg_temp.open(:u_vic, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iVic::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'M2: a member with items:create and no stock right is refused (hint stock:adjust)');
select is(pg_temp.st(:iVwr) || ',' || pg_temp.st(:iVic), '0.0000|none|0|0,0.0000|none|0|0',
  'M3: their items stay at 0 with no holding and no movement');
select is(pg_temp.open(:u_stw2, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iStw2::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:warehouse_write:' || :iStw2::text,
  'M4: staff without write on the item''s warehouse are refused (hint warehouse_write)');
select is(pg_temp.open(:u_stf2, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOther::uuid, 'quantity', 6))),
  '1', 'M5: staff assigned to the warehouse open their own new item');
select is(pg_temp.open(:u_mgr, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iMgr::uuid, 'quantity', 5))),
  '1', 'M6: a manager with no warehouse assignment opens their own new item');
select is(pg_temp.open(:u_adm, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iAdm::uuid, 'quantity', 5))),
  '1', 'M7: an admin opens their own new item');
select is(pg_temp.st(:iOther) || ',' || pg_temp.st(:iMgr) || ',' || pg_temp.st(:iAdm),
  '6.0000|6.0000|1|6.0000,5.0000|5.0000|1|5.0000,5.0000|5.0000|1|5.0000',
  'M8: and each is recorded in full');
select is(pg_temp.open(:u_mgrB, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iLock::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'M9: a member of another organization is refused in it');
select is(pg_temp.open(:u_mgrB, :orgB, jsonb_build_array(jsonb_build_object('itemId', :iLock::uuid, 'quantity', 5))),
  'ERR:P0002:item_not_found::' || :iLock::text,
  'M10: naming another organization''s item from one''s own gives P0002');
-- The locking query filters on the organization, so the other organization's
-- row is never locked: its xmax stays 0. Control: a lock taken and rolled
-- back in a subtransaction leaves xmax set, so the probe sees a lock.
do $$
begin
  perform 1 from public.inventory_items where id = '04540000-0000-4000-8000-0000000000f7' for update;
  raise exception 'roll back';
exception when others then null;
end $$;
select is(
  (select xmax::text from public.inventory_items where id = :iLock) || '|'
  || ((select xmax::text from public.inventory_items where id = :iLockC) <> '0')::text,
  '0|true',
  'M11: the other organization''s row was not locked (control: a rolled-back lock is seen)');
select is(pg_temp.open(:u_mgrB, :orgB, jsonb_build_array(jsonb_build_object('itemId', :iB::uuid, 'quantity', 2))),
  '1', 'M12: the other organization''s manager opens their own item in their organization');
select is(pg_temp.run('service_role', null, format(
    'select count(*)::text from public.open_item_stock(%L, %L::jsonb)', :orgA,
    jsonb_build_array(jsonb_build_object('itemId', :iLockC::uuid, 'quantity', 1)))),
  'ERR:42501:forbidden::', 'M13: the service role (no signed-in user) is refused');
select is(pg_temp.run('authenticated', :u_stf::uuid, format(
    'select count(*)::text from public.open_item_stock(null, %L::jsonb)',
    jsonb_build_array(jsonb_build_object('itemId', :iLockC::uuid, 'quantity', 1)))),
  'ERR:42501:forbidden::', 'M14: no organization is refused');
select ok(not has_function_privilege('anon', 'public.open_item_stock(uuid, jsonb)', 'execute'),
  'M15: anon cannot execute open_item_stock');
select ok(not has_function_privilege('anon', 'public.duplicate_inventory_item(uuid, jsonb)', 'execute'),
  'M16: anon cannot execute duplicate_inventory_item');

-- ═══ PART 5: Duplicate ═════════════════════════════════════════════════════
insert into w values ('d5', null), ('d0', null);
update w set id = pg_temp.run('authenticated', :u_stf::uuid, format(
    $$select public.duplicate_inventory_item(%L, '{"sku": "O0454-COPY5", "quantity": 5, "bin_location": "Copy 5"}'::jsonb)::text$$,
    :iOrig))::uuid where k = 'd5';
select is(pg_temp.st((select id from w where k = 'd5')), '5.0000|5.0000|1|5.0000',
  'L1: a copy with 5 has 5 on hand, held and moved');
select is(pg_temp.mv((select id from w where k = 'd5')),
  'initial|true|' || :u_stf::text || '|' || :siteA::text || '|duplicate_initial_count|duplicate|' || :iOrig::text,
  'L2: the copy''s opening movement is written by the ledger, names the original and its site');
select is(pg_temp.loc((select id from w where k = 'd5')) || '|'
          || (select (created_by = :u_stf::uuid)::text from public.inventory_items where id = (select id from w where k = 'd5')),
  'site:' || :whA::text || '|true',
  'L3: the copy''s stock is at the original''s site, and the copy is the caller''s');
update w set id = pg_temp.run('authenticated', :u_stf::uuid, format(
    $$select public.duplicate_inventory_item(%L, '{"sku": "O0454-COPY0", "quantity": 0, "bin_location": "Copy 0"}'::jsonb)::text$$,
    :iOrig))::uuid where k = 'd0';
select is(pg_temp.st((select id from w where k = 'd0')), '0.0000|none|0|0',
  'L4: a copy with 0 writes no holding and no movement');
select is(pg_temp.run('authenticated', :u_stf::uuid, format(
    $$select public.duplicate_inventory_item(%L, '{"sku": "O0454-COPYN", "quantity": -1, "bin_location": "Copy N"}'::jsonb)::text$$,
    :iOrig)),
  'ERR:22023:quantity_must_not_be_negative::', 'L5: a negative quantity is still refused');
select is(left(pg_temp.run('authenticated', :u_vic::uuid, format(
    $$select public.duplicate_inventory_item(%L, '{"sku": "O0454-COPYV", "quantity": 5, "bin_location": "Copy V"}'::jsonb)::text$$,
    :iOrig)), 28),
  'ERR:P0002:original_not_found', 'L6: a viewer granted items:create copying with stock is refused before anything is written, as before');
select is((select count(*)::text from public.inventory_items where sku = 'O0454-COPYV'),
  '0', 'L7: and no copy was made');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', :iDupT::uuid, 'quantity', 1, 'duplicateOf', :iDupT::uuid))),
  'ERR:22023:invalid_duplicate_of::' || :iDupT::text, 'L8: duplicateOf may not name the item itself');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', :iDupT::uuid, 'quantity', 1, 'duplicateOf', :iB::uuid))),
  'ERR:22023:invalid_duplicate_of::' || :iB::text, 'L9: duplicateOf may not name another organization''s item');
select is(
  (select count(*)::text from public.stock_movements where item_id = :iOrig),
  '0', 'L10: the original''s ledger is untouched by its copies');

-- ═══ PART 6: the seed trigger, adjustments, receipts ═══════════════════════
select is(pg_temp.run('service_role', null, format(
    $$insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
      values (%L, %L, %L, 'O0454-SVC', 'Service stocked', 7, 'active', 'product') returning id::text$$,
    :iSvc, :orgA, :whA)),
  :iSvc::text, 'S1: the service role inserts an item with stock');
select is(pg_temp.st(:iSvc) || '|' || pg_temp.loc(:iSvc), '7.0000|7.0000|0|0|unplaced:' || :whA::text,
  'S2: the seed trigger places it in the warehouse''s Unplaced, as 0199 did');
insert into public.inventory_items
  (id, organization_id, warehouse_id, primary_location_id, sku, name, quantity_on_hand, status, item_type)
values (:iSeed, :orgA, :whA, :siteA, 'O0454-SEED', 'Seeded at site', 4, 'active', 'product');
select is(pg_temp.st(:iSeed) || '|' || pg_temp.loc(:iSeed), '4.0000|4.0000|0|0|site:' || :whA::text,
  'S3: a stocked insert with a site primary is seeded at the site, as 0199 did');
select is(pg_temp.run('authenticated', :u_stf::uuid, format(
    $$select (public.adjust_stock(p_item_id => %L, p_quantity_change => 3, p_movement_type => 'add',
              p_notes => 'after opening 0454')).quantity_on_hand::text$$,
    (select id from w where k = 'web'))),
  '10.0000', 'R1: an adjustment after the opening works as before');
select is(pg_temp.st((select id from w where k = 'web')), '10.0000|10.0000|2|10.0000',
  'R2: on-hand, holdings and the movements agree after it');
insert into public.purchase_orders (id, organization_id, po_number, status)
values (:poA, :orgA, 'PO-0454-1', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
values (:poLine, :orgA, :poA, (select id from w where k = 'web'), 4, 0, 1);
select is(pg_temp.run('authenticated', :u_mgr::uuid, format(
    $$select (public.post_receipt_v2(%L, %L, %L::jsonb, 'idem-0454', 'hash-0454', null)).status::text$$,
    :poA, :whA, jsonb_build_array(jsonb_build_object('po_line_id', :poLine::uuid, 'qty_received', 4,
                                                     'qty_accepted', 4, 'qty_rejected', 0, 'unit_cost', 1)))),
  'posted', 'R3: a receipt after the opening posts as before');
select is(pg_temp.st((select id from w where k = 'web')), '14.0000|14.0000|3|14.0000',
  'R4: on-hand, holdings and the movements agree after it');
select is(
  (select count(*)::int from public.inventory_items i
    where i.organization_id in (:orgA, :orgB) and i.sku like 'O0454-%'
      and i.id not in (:iStock, :iSvc, :iSeed, :iOrig, :iOnh)
      and i.quantity_on_hand <> coalesce((select sum(m.quantity_change) from public.stock_movements m where m.item_id = i.id), 0)),
  0, 'R5: every item opened here sums its movements to its on-hand');

-- ═══ PART 7: the census ════════════════════════════════════════════════════
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger') and p.prokind = 'f'
      and p.prosrc ~* $re$(insert\s+into|merge\s+into(\s+only)?|update(\s+only)?|delete\s+from(\s+only)?)\s+("?public"?\s*\.\s*)?"?stock_movements\M$re$
      and n.nspname <> 'ledger' and not p.prosecdef),
  array['public._dedup_rack_locations'],
  'G1: outside the ledger schema, the only invoker writer of stock_movements is the postgres-only location dedup helper');
select is(
  (select prosrc ~* $re$insert\s+into\s+public\.stock_movements$re$ from pg_proc
    where oid = 'public.open_item_stock(uuid, jsonb)'::regprocedure)::text || '|'
  || (select prosrc ~* 'open_item_stock' from pg_proc
       where oid = 'public.duplicate_inventory_item(uuid, jsonb)'::regprocedure)::text,
  'true|true',
  'G2: the opening movement is written by open_item_stock, which Duplicate calls');

-- ═══ PART 8: the floor, rounding, updated_by, duplicateOf, Duplicate ═══════
select is(pg_temp.open(:u_own, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOwn::uuid, 'quantity', 5))),
  '1', 'N1: an owner opens their own new item');
select is(pg_temp.open(:u_vsa, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iVsa::uuid, 'quantity', 5))),
  '1', 'N2: a viewer granted items:create and stock:adjust opens their own new item that has no warehouse');
select is(pg_temp.st(:iVsa) || '|' || pg_temp.mv(:iVsa),
  '5.0000|5.0000|1|5.0000|initial|true|' || :u_vsa::text || '|null|null|null|null',
  'N3: recorded in full and attributed to them');
select is(pg_temp.open(:u_vsa, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iVsaW::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:warehouse_write:' || :iVsaW::text,
  'N4: the same viewer is refused in a warehouse, which a viewer may not write');
select is(pg_temp.open(:u_norev, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iNorev::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'N5: staff whose stock:adjust is turned off are refused (hint stock:adjust)');
select is(pg_temp.st(:iNorev), '0.0000|none|0|0', 'N6: and their item stays at 0 with nothing written');
select is(pg_temp.open(:u_pend, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iPend::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'N7: a member who has not accepted the invitation is refused');
select is(pg_temp.open(:u_dis, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iDis::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'N8: a disabled account is refused');
select is(pg_temp.open(:u_exp, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iExp::uuid, 'quantity', 5))),
  'ERR:42501:forbidden:stock:adjust:', 'N9: an act-as seat whose time is up is refused');
select is(pg_temp.st(:iPend) || ',' || pg_temp.st(:iDis) || ',' || pg_temp.st(:iExp),
  '0.0000|none|0|0,0.0000|none|0|0,0.0000|none|0|0', 'N10: and none of their items was written');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iTiny::uuid, 'quantity', 0.00004))),
  'ERR:22023:invalid_lines::', 'N11: a quantity that rounds to 0 at four decimals is refused');
select is(pg_temp.st(:iTiny), '0.0000|none|0|0', 'N12: and nothing was written for it');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iTiny2::uuid, 'quantity', 0.00005))),
  '1', 'N13: a quantity that rounds up to 0.0001 opens');
select is(pg_temp.st(:iTiny2), '0.0001|0.0001|1|0.0001', 'N14: as 0.0001 on hand, held and moved');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iUpd::uuid, 'quantity', 3))),
  '1', 'N15: the creator opens an item someone else last updated');
select is((select updated_by::text from public.inventory_items where id = :iUpd), :u_stf::text,
  'N16: and the item now names the opener as its last updater');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(
    jsonb_build_object('itemId', :iDupT::uuid, 'quantity', 1, 'duplicateOf', :iAdm::uuid))),
  'ERR:22023:invalid_duplicate_of::' || :iAdm::text,
  'N17: duplicateOf may not name an item of the organization the caller cannot read');
select is(pg_temp.run('authenticated', :u_norev::uuid, format(
    $$select public.duplicate_inventory_item(%L, '{"sku": "O0454-COPYR", "quantity": 5, "bin_location": "Copy R"}'::jsonb)::text$$,
    :iOrig)),
  'ERR:42501:forbidden:stock:adjust:', 'N18: Duplicate with stock by staff whose stock:adjust is off is refused');
select is((select count(*)::text from public.inventory_items where sku = 'O0454-COPYR'), '0',
  'N19: and the copy was rolled back with the refused opening');
select ok(pg_temp.run('authenticated', :u_norev::uuid, format(
    $$select public.duplicate_inventory_item(%L, '{"sku": "O0454-COPYZ", "quantity": 0, "bin_location": "Copy Z"}'::jsonb)::text$$,
    :iOrig)) ~ '^[0-9a-f-]{36}$', 'N20: the same member copies it with a quantity of 0');
select is((select string_agg(quantity_on_hand::text || '|' || pg_temp.st(id), ',') from public.inventory_items where sku = 'O0454-COPYZ'),
  '0.0000|0.0000|none|0|0', 'N21: one copy, with nothing on hand and nothing written');
select is(pg_temp.open(:u_stf, :orgA, jsonb_build_array(jsonb_build_object('itemId', :iOnh::uuid, 'quantity', 5))),
  'ERR:42501:opening_stock_refused::' || :iOnh::text,
  'N22: an item with stock on hand and no holding or movement is refused');
select is(pg_temp.st(:iOnh), '4.0000|none|0|0', 'N23: and is unchanged');

select * from finish();
rollback;
