-- supabase/tests/NNNN_act_as_expiry_in_access_gates.test.sql (NNNN = the
-- migration's number, given in ship order; nothing in this file reads it)
-- pgTAP proof for the S47 migration (docket item S47): an expired "act as"
-- seat no longer passes user_can_access_warehouse, user_can_access_inventory,
-- my_warehouse_ids or user_can_see_item_category, ledger._seal's warehouse
-- arm agrees with them, the maintenance guard refuses a cancel by someone
-- without maintenance_requests:manage when the request's requester was
-- deleted, and someone without it who is not the requester changes no
-- request and adds or deletes no photo row (the update and photo policies
-- admit a manager by role). Written to fail against the head before it (0415
-- when it was written) in E1-E15, D1, L1, M1-M6 and the structure lines
-- R1-R3, R5, P4, P5, F1-F3 and X1-X7; every other line passes there too.
--
-- An act-as seat is a platform admin's temporary owner membership: an
-- organization_members row whose impersonation_expires_at is 45 minutes after
-- it started. 0177 made its expiry a database rule, and 0310 gave eleven of
-- the fifteen membership helpers the expiry term, but not these four, and not
-- ledger._seal's restatement of user_can_access_warehouse. So until the sweep
-- deleted the row, the seat's own token could read the organization's rentals
-- (borrower names and emails), claim picks, record picked quantities, release
-- its claim, and complete a pick that draws nothing (which releases every
-- stock hold of the order); a manager could assign a pick to it.
--
-- Personas (organization A unless named):
--   own   the real owner
--   exp   an owner act-as seat that expired 1 minute ago
--   liv   an owner act-as seat with 40 minutes left
--   stf   staff assigned to warehouse A
--   mgr   a manager (holds maintenance_requests:manage)
--   mno   a manager whose maintenance_requests:manage is switched off (a user
--         override), who still reads every request (read_all)
--   sx    live staff of organization B with an EXPIRED owner seat in A
--   sl    live staff of organization B with a LIVE owner seat in A
-- Location X belongs to organization B but sits in warehouse A, so its
-- organization asks is_org_member and its warehouse asks
-- user_can_access_warehouse (the 0373 S3 shape): only sx and sl reach it.
--
-- E.  The expired seat: both helpers answer false whoever asks, it reads no
--     rentals or rental lines, every picking call it could make is refused
--     (claim, a pick on an unclaimed order and on its own claim, release,
--     completing a pick that draws nothing, its own claim or a one-click
--     completion), and nothing it tried was saved. Controls: warehouses and
--     is_org_member already refused it, and a completion that draws stock was
--     already refused by the stock engine.
-- A.  A real manager cannot assign a pick to the expired seat.
-- C.  Controls: a live seat, the real owner and assigned staff are unchanged.
-- D.  One fixture through every membership helper (pattern 26): each refuses
--     the expired seat (caller_is_warehouse_scoped fails safe), and each
--     admits the live seat and the owner.
-- L.  ledger._seal's warehouse arm: an expired seat in the warehouse's
--     organization is out of scope, equal to the live predicate
--     (caller_can_write_location); a live seat is in scope.
-- M.  The maintenance write rule: a manager without manage is refused a
--     cancel of a request whose requester was deleted (it stays open), as of
--     one whose requester exists; any other change to a request that is not
--     theirs (one with no requester, another member's); deleting another
--     member's photo row; and adding one (while members still hold INSERT on
--     the table: docket S9's migration revokes it, and those lines then
--     skip). The requester and a manage holder still cancel, change the
--     request and delete its photos, and the requester still adds one.
-- R.  One change per body: each restated body carries its lines tagged
--     "-- S47" (one; the guard five), and taking them out (in the guard,
--     putting the old cancel condition back) gives production's body
--     exactly; the new md5 values; the comments, new and kept; the guard's
--     trigger, and the photo guard's.
-- P.  Posture: SECURITY mode, volatility, SET clause, owner, STRICT,
--     LEAKPROOF, PARALLEL, result and EXECUTE are unchanged; the predicates
--     _seal mirrors are untouched; each body carries its term; the photo
--     guard's function is SECURITY INVOKER, pins its search_path and only
--     service_role holds EXECUTE.
-- F.  The migration's preflight, replayed from the statements the CLI
--     recorded: it refuses a second run (every body drifted, the photo
--     guard's names taken), passes on the pre-S47 bodies with the photo
--     guard gone, and refuses a drifted header.
-- X.  Mutations: each S47 line taken out of the live body, or the photo
--     guard's trigger dropped (inside an undone attempt), lets the refused
--     answer through again, so the E, D, L and M lines are not tautological.
--
-- Roles: fixtures as the test superuser. The E-C-D-M lines switch role and
-- claims with SET LOCAL, as the existing access suites do; every L, F and X
-- probe runs through pg_temp.value, which switches inside a subtransaction
-- that is always undone. begin/rollback: nothing leaks. Namespace 54700000;
-- undo code XXS47.

begin;

select plan(68);

\set org   '\'54700000-0000-0000-0000-00000000000a\''
\set orgB  '\'54700000-0000-0000-0000-00000000000b\''
\set own   '\'54700000-0000-0000-0000-0000000000a1\''
\set exp   '\'54700000-0000-0000-0000-0000000000a2\''
\set liv   '\'54700000-0000-0000-0000-0000000000a3\''
\set stf   '\'54700000-0000-0000-0000-0000000000a4\''
\set mgr   '\'54700000-0000-0000-0000-0000000000a5\''
\set mno   '\'54700000-0000-0000-0000-0000000000a6\''
\set sx    '\'54700000-0000-0000-0000-0000000000a7\''
\set sl    '\'54700000-0000-0000-0000-0000000000a8\''
\set itemS '\'54700000-0000-0000-0000-0000000000b1\''
\set itemZ '\'54700000-0000-0000-0000-0000000000b2\''
\set wh    '\'54700000-0000-0000-0000-0000000000d1\''
\set rack  '\'54700000-0000-0000-0000-0000000000d2\''
\set locX  '\'54700000-0000-0000-0000-0000000000d3\''
\set cat   '\'54700000-0000-0000-0000-0000000000d4\''
\set oA    '\'54700000-0000-0000-0000-000000000101\''
\set oB    '\'54700000-0000-0000-0000-000000000102\''
\set oC    '\'54700000-0000-0000-0000-000000000103\''
\set oD    '\'54700000-0000-0000-0000-000000000104\''
\set oE    '\'54700000-0000-0000-0000-000000000105\''
\set oF    '\'54700000-0000-0000-0000-000000000106\''
\set oP    '\'54700000-0000-0000-0000-000000000107\''
\set oQ    '\'54700000-0000-0000-0000-000000000108\''
\set oR    '\'54700000-0000-0000-0000-000000000109\''
\set lB    '\'54700000-0000-0000-0000-000000000202\''
\set lC    '\'54700000-0000-0000-0000-000000000203\''
\set lP    '\'54700000-0000-0000-0000-000000000207\''
\set lQ    '\'54700000-0000-0000-0000-000000000208\''
\set lR    '\'54700000-0000-0000-0000-000000000209\''
\set rent  '\'54700000-0000-0000-0000-000000000301\''
\set rline '\'54700000-0000-0000-0000-000000000302\''
\set mrA   '\'54700000-0000-0000-0000-000000000401\''
\set mrB   '\'54700000-0000-0000-0000-000000000402\''
\set mrC   '\'54700000-0000-0000-0000-000000000403\''
\set mrD   '\'54700000-0000-0000-0000-000000000404\''
\set pD1   '\'54700000-0000-0000-0000-000000000501\''
\set pD2   '\'54700000-0000-0000-0000-000000000502\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own, 's47-own@s47.test', '{}'::jsonb),
  (:exp, 's47-exp@s47.test', '{}'::jsonb),
  (:liv, 's47-liv@s47.test', '{}'::jsonb),
  (:stf, 's47-stf@s47.test', '{}'::jsonb),
  (:mgr, 's47-mgr@s47.test', '{}'::jsonb),
  (:mno, 's47-mno@s47.test', '{}'::jsonb),
  (:sx,  's47-sx@s47.test',  '{}'::jsonb),
  (:sl,  's47-sl@s47.test',  '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug, timezone, currency, plan) values
  (:org,  'S47 Org A', 's47-org-a', 'UTC', 'USD', 'pro'),
  (:orgB, 'S47 Org B', 's47-org-b', 'UTC', 'USD', 'pro');
insert into public.warehouses (id, organization_id, name, code, status)
values (:wh, :org, 'S47 Main', 'WH-S47', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rack, :org,  :wh, 'S47-R1', 'shelf', 'rack'),
  (:locX, :orgB, :wh, 'S47-X1', 'other', 'rack');
insert into public.categories (id, organization_id, name) values (:cat, :org, 'S47 Category');

-- exp and liv are act-as seats (owner rows with impersonation_expires_at);
-- sx and sl hold one too, beside their live staff membership of B.
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:org,  :own, 'owner',   now(),                         null),
  (:org,  :exp, 'owner',   now() - interval '50 minutes', now() - interval '1 minute'),
  (:org,  :liv, 'owner',   now() - interval '5 minutes',  now() + interval '40 minutes'),
  (:org,  :stf, 'staff',   now(),                         null),
  (:org,  :mgr, 'manager', now(),                         null),
  (:org,  :mno, 'manager', now(),                         null),
  (:org,  :sx,  'owner',   now() - interval '50 minutes', now() - interval '1 minute'),
  (:org,  :sl,  'owner',   now() - interval '5 minutes',  now() + interval '40 minutes'),
  (:orgB, :sx,  'staff',   now(),                         null),
  (:orgB, :sl,  'staff',   now(),                         null);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id)
values (:org, :stf, :wh, null);

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, category_id)
values (:itemS, :org, :wh, 'S47-S', 'Item with stock', 10, 'active', 'none', :cat),
       (:itemZ, :org, :wh, 'S47-Z', 'Item with none',   0, 'active', 'none', :cat);
delete from public.item_stock_levels where item_id in (:itemS, :itemZ);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values (:org, :itemS, :rack, 10);

-- Orders in picking: oA, oB, oD, oE, oF unclaimed; oC claimed by exp; oP
-- claimed by exp with its line picked 0 and a hold of 2; oQ unclaimed, its
-- item has none; oR claimed by exp with its line picked 1 (a completion
-- would draw).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type, assigned_picker_id)
values
  (:oA, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', null),
  (:oB, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', null),
  (:oC, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', :exp),
  (:oD, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', null),
  (:oE, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', null),
  (:oF, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', null),
  (:oP, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', :exp),
  (:oQ, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', null),
  (:oR, :org, :wh, 'pick_slip_generated', :stf, 'internal', 'pickup', :exp);
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
values (:lB, :oB, :itemS, 2, 0, null),
       (:lC, :oC, :itemS, 2, 0, null),
       (:lP, :oP, :itemS, 2, 0, 0),
       (:lQ, :oQ, :itemZ, 2, 0, null),
       (:lR, :oR, :itemS, 2, 0, 1);
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity)
values (:org, :itemS, :wh, :oP, 2);

insert into public.rentals (id, organization_id, warehouse_id, borrower_name, expected_return_at, status)
values (:rent, :org, :wh, 'Borrower S47', now() + interval '7 days', 'out');
insert into public.rental_lines (id, rental_id, item_id, quantity) values (:rline, :rent, :itemS, 1);

-- Maintenance on; mno's manage switched off; mrA and mrC have no requester
-- (requester_user_id is ON DELETE SET NULL: their requesters deleted their
-- accounts), mrB and mrD are stf's.
insert into public.organization_modules (organization_id, module_id, enabled, tier)
values (:org, 'maintenance_requests', true, 'optional')
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:org, :mno, 'maintenance_requests:manage', false);
insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description, priority, status)
values
  (:mrA, :org, null, 'Deleted requester', 'Broken heater',  'It is cold',    'normal', 'saved'),
  (:mrB, :org, :stf, 'Staff requester',   'Leaky tap here', 'Drips',         'normal', 'saved'),
  (:mrC, :org, null, 'Deleted requester', 'Door is stuck',  'Will not open', 'normal', 'saved'),
  (:mrD, :org, :stf, 'Staff requester',   'Light is out',   'Dark corner',   'normal', 'saved');
-- Two of stf's photos on mrD, their own open request (recorded the way the
-- finalize step records them, outside the API roles).
insert into public.maintenance_request_attachments
  (id, organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
values
  (:pD1, :org, :mrD, '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/p1.jpg',
   'p1.jpg', 'p1.jpg', 'image/jpeg', 100, :stf),
  (:pD2, :org, :mrD, '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/p2.jpg',
   'p2.jpg', 'p2.jpg', 'image/jpeg', 100, :stf);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- Every membership helper's answer about organization A, warehouse A, the
-- rack, item S and the category, for auth.uid() or for p_uid where the
-- helper takes a subject.
create function pg_temp.census(p_uid uuid) returns text language sql as $f$
  select concat_ws(',',
    'is_org_member=' || public.is_org_member('54700000-0000-0000-0000-00000000000a'),
    'user_org_role=' || coalesce(public.user_org_role('54700000-0000-0000-0000-00000000000a'), '-'),
    'has_org_role=' || public.has_org_role('54700000-0000-0000-0000-00000000000a', 'viewer'),
    'has_permission=' || public.has_permission('54700000-0000-0000-0000-00000000000a', 'purchase_orders:read'),
    'rls_member_org_ids=' || (select count(*) from public.rls_member_org_ids() x where x = '54700000-0000-0000-0000-00000000000a'),
    'rls_manager_org_ids=' || (select count(*) from public.rls_manager_org_ids() x where x = '54700000-0000-0000-0000-00000000000a'),
    'rls_orgs_with_permission=' || (select count(*) from public.rls_orgs_with_permission('purchase_orders:read') x where x = '54700000-0000-0000-0000-00000000000a'),
    'rls_inv_read_full_warehouse_ids=' || (select count(*) from public.rls_inv_read_full_warehouse_ids() x where x = '54700000-0000-0000-0000-0000000000d1'),
    'rls_cat_unrestricted_org_ids=' || (select count(*) from public.rls_cat_unrestricted_org_ids() x where x = '54700000-0000-0000-0000-00000000000a'),
    'rls_exc_holding_location_ids=' || (select count(*) from public.rls_exc_holding_location_ids() x where x = '54700000-0000-0000-0000-0000000000d2'),
    'caller_can_write_location=' || public.caller_can_write_location('54700000-0000-0000-0000-0000000000d2'),
    'caller_can_read_item=' || public.caller_can_read_item('54700000-0000-0000-0000-0000000000b1'),
    'caller_is_warehouse_scoped=' || public.caller_is_warehouse_scoped('54700000-0000-0000-0000-00000000000a'),
    'my_warehouse_ids=' || (select count(*) from public.my_warehouse_ids() x where x.warehouse_id = '54700000-0000-0000-0000-0000000000d1'),
    'user_can_access_warehouse=' || public.user_can_access_warehouse(p_uid, '54700000-0000-0000-0000-0000000000d1', 'read'),
    'user_can_access_inventory=' || public.user_can_access_inventory(p_uid, '54700000-0000-0000-0000-0000000000d1', null, 'read'),
    'user_can_see_item_category=' || public.user_can_see_item_category(p_uid, '54700000-0000-0000-0000-00000000000a', '54700000-0000-0000-0000-0000000000d4'))
$f$;
-- ledger._seal for one holding at location X (pair-keyed, as the draw loops
-- key it), drawn by p_uid for organization B with the cache emptied first:
-- '<_seal's actor_scope>#live=<the live formula, caller_can_write_location
-- as p_uid>'. Run as the superuser: no API role may execute _seal.
create function pg_temp.seal_scope(p_uid uuid) returns text language plpgsql as $f$
declare v_d public.stock_draw; v_live boolean;
begin
  perform set_config('stockpilot.draw_scope', '', true);
  v_d := ledger._seal(p_uid, '54700000-0000-0000-0000-00000000000b', '54700000-0000-0000-0000-0000000000d1', 'placed',
                      array[row('54700000-0000-0000-0000-0000000000d3', -1, 'placed', 'rack',
                                '54700000-0000-0000-0000-0000000000d1', null)::public.stock_draw_holding],
                      array['54700000-0000-0000-0000-00000000000b'::uuid]);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  v_live := public.caller_can_write_location('54700000-0000-0000-0000-0000000000d3');
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('stockpilot.draw_scope', '', true);
  return coalesce(((v_d).holdings[1]).actor_scope, (v_d).actor_scope)
         || '#live=' || case when v_live then 'in_scope' else 'out_of_scope' end;
end $f$;
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image (0387's helper).
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- p_sql's one text value, as p_as (the superuser when null) with p_sub's
-- claims, after p_prep (as the superuser), inside a subtransaction that is
-- ALWAYS undone: the value ('null' for none), else
-- '<sqlstate>:<hint or ->:<message>'.
create function pg_temp.value(p_as text, p_sub uuid, p_sql text, p_prep text default null)
returns text language plpgsql as $$
declare v text; v_state text; v_msg text; v_hint text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', coalesce(p_as, ''), true);
    if p_as is not null then
      perform set_config('role', p_as, true);
    end if;
    execute p_sql into v;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XXS47', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXS47' then
    return coalesce(v, 'null');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- The guard's S47 text: its cancel line (k = 'cancel', and the line it
-- replaced, 'cancel_old') and its four-line write rule ('block', with the
-- newline before each line).
create function pg_temp.s47_text(k text) returns text language sql immutable as $$
  select case k
    when 'cancel'     then '    if not (v_manage or coalesce(old.requester_user_id = v_uid, false)) then  -- S47'
    when 'cancel_old' then '    if not (v_manage or old.requester_user_id = v_uid) then'
    when 'block'      then E'\n  if not (v_manage or coalesce(old.requester_user_id = v_uid, false)) then  -- S47'
                        || E'\n    raise exception ''Only the requester or a maintenance manager can change a request.''  -- S47'
                        || E'\n      using errcode = ''42501'';  -- S47'
                        || E'\n  end if;  -- S47'
  end
$$;
-- p_src (a body or a whole definition) of p_sig with its S47 text taken
-- out: every tagged line, or, in the guard, the old cancel condition put back
-- ('all' or 'cancel') and the write rule cut ('all' or 'block').
create function pg_temp.s47_strip(p_sig text, p_src text, p_part text default 'all') returns text
language plpgsql immutable as $$
begin
  if p_sig <> 'public.tg_maintenance_requests_guard()' then
    return regexp_replace(p_src, E'\n[^\n]*-- S47[^\n]*', '', 'g');
  end if;
  if p_part in ('all', 'cancel') then
    p_src := replace(p_src, pg_temp.s47_text('cancel'), pg_temp.s47_text('cancel_old'));
  end if;
  if p_part in ('all', 'block') then
    p_src := replace(p_src, pg_temp.s47_text('block'), '');
  end if;
  return p_src;
end $$;
-- The pre-S47 function (or, in the guard, with only p_part of its S47 text
-- taken out): the live definition of p_sig through s47_strip, then
-- re-created (only ever inside an undone subtransaction). Refuses unless the
-- body carries its S47 lines (one; the guard five) and the strip cut exactly
-- what p_part names, so a mutation never passes by cutting nothing.
create function pg_temp.unpatch(p_sig text, p_part text default 'all') returns void language plpgsql as $$
declare
  v_def  text := pg_get_functiondef(to_regprocedure(p_sig));
  v_new  text;
  v_left int;
begin
  if (select count(*) from regexp_matches(v_def, '-- S47', 'g'))
     <> (case when p_sig = 'public.tg_maintenance_requests_guard()' then 5 else 1 end) then
    raise exception 'unpatch: % does not carry its S47 lines', p_sig;
  end if;
  v_new := pg_temp.s47_strip(p_sig, v_def, p_part);
  v_left := (select count(*) from regexp_matches(v_new, '-- S47', 'g'));
  if v_left <> (case p_part when 'cancel' then 4 when 'block' then 1 else 0 end) then
    raise exception 'unpatch: % kept % S47 lines after taking out %', p_sig, v_left, p_part;
  end if;
  execute v_new;
end $$;
-- The six functions S47 restates, by signature.
create temp table s47_fn (k text primary key, sig text not null);
insert into s47_fn (k, sig) values
  ('ledger._seal',                  'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])'),
  ('my_warehouse_ids',              'public.my_warehouse_ids()'),
  ('tg_maintenance_requests_guard', 'public.tg_maintenance_requests_guard()'),
  ('user_can_access_inventory',     'public.user_can_access_inventory(uuid,uuid,uuid,text)'),
  ('user_can_access_warehouse',     'public.user_can_access_warehouse(uuid,uuid,text)'),
  ('user_can_see_item_category',    'public.user_can_see_item_category(uuid,uuid,uuid)');
-- p_keys' pre-S47 functions, as one statement list for p_prep.
create function pg_temp.pre(p_keys text[]) returns text language sql stable as $$
  select string_agg(format('select pg_temp.unpatch(%L)', f.sig), E';\n' order by k.o)
    from unnest(p_keys) with ordinality k(key, o)
    join s47_fn f on f.k = k.key
$$;
-- The photo guard taken away, as one statement list for p_prep.
create function pg_temp.drop_photo_guard() returns text language sql immutable as $$
  select 'drop trigger trg_maintenance_request_attachments_guard on public.maintenance_request_attachments;'
         || E'\ndrop function public.tg_maintenance_request_attachments_guard()'
$$;
-- The migration's preflight as the CLI recorded it (found by its dollar tag,
-- so the file's number is never read), run after p_prep inside a
-- subtransaction that is ALWAYS undone: 'ok', or '<sqlstate>:<hint>:' and
-- what its message names, sorted.
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_stmt text; v_state text; v_msg text; v_hint text;
begin
  select string_agg(st, E';\n') into v_stmt
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where position('$pre_s47$' in st) > 0;
  if v_stmt is null then
    return 'the S47 preflight is not recorded';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute v_stmt;
    raise exception using errcode = 'XXS47', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXS47' then
    return 'ok';
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':'
         || coalesce((select string_agg(m[1] || ' ' || m[2], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '([^ ;]+) (drifted|missing|exists)', 'g') m), v_msg);
end $$;

-- ══ E. The expired seat ═══════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :exp;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(not public.user_can_access_warehouse(:exp, :wh, 'read'),  'E1: the expired seat: user_can_access_warehouse read is false');
select ok(not public.user_can_access_warehouse(:exp, :wh, 'write'), 'E2: the expired seat: user_can_access_warehouse write is false');
select ok(not public.user_can_access_inventory(:exp, :wh, null, 'read'),  'E3: the expired seat: user_can_access_inventory read is false');
select ok(not public.user_can_access_inventory(:exp, :wh, null, 'write'), 'E4: the expired seat: user_can_access_inventory write is false');
select is((select count(*)::int from public.rentals where organization_id = :org), 0,
  'E5: the expired seat reads none of the organization''s rentals (borrower names and emails)');
select is((select count(*)::int from public.rental_lines where rental_id = :rent), 0,
  'E6: the expired seat reads none of its rental lines');
select is((select count(*)::int from public.warehouses where organization_id = :org), 0,
  'C1: control: warehouses were already hidden from the expired seat');
select ok(not public.is_org_member(:org), 'C2: control: is_org_member already refused the expired seat');
select throws_ok(format('select public.claim_picking(%L::uuid)', :oA), '42501', null,
  'E7: the expired seat cannot claim an unclaimed pick');
select throws_ok(format('select public.partial_pick_line(%L::uuid, 1)', :lB), '42501', null,
  'E8: the expired seat cannot record a picked quantity on an unclaimed order');
select throws_ok(format('select public.partial_pick_line(%L::uuid, 1)', :lC), '42501', null,
  'E9: the expired seat cannot record a picked quantity on its own claim');
select throws_ok(format('select public.release_picking(%L::uuid)', :oC), '42501', null,
  'E10: the expired seat cannot release its own claim');
select throws_ok(format('select public.complete_picking(%L::uuid)', :oP), '42501', null,
  'E13a: the expired seat cannot complete its own claim with every line picked 0 (nothing drawn)');
select throws_ok(format('select public.complete_picking(%L::uuid)', :oQ), '42501', null,
  'E13b: the expired seat cannot complete, in one click, an unclaimed order whose item has none (nothing drawn)');
select throws_ok(format('select public.complete_picking(%L::uuid)', :oR), '42501', null,
  'C3: control: a completion that would draw stock was already refused (the stock engine''s staff floor)');
reset role;

set local role to 'service_role';
select ok(not public.user_can_access_warehouse(:exp, :wh, 'read') and not public.user_can_access_inventory(:exp, :wh, null, 'write'),
  'E1b: the helpers answer about the subject: false for the expired seat when service_role asks too');
reset role;

select is((select coalesce((select assigned_picker_id::text from public.order_requests where id = :oA), 'null') || '/'
               || coalesce((select quantity_picked::text from public.order_request_lines where id = :lB), 'null') || '/'
               || coalesce((select assigned_picker_id::text from public.order_requests where id = :oC), 'null') || '/'
               || coalesce((select quantity_picked::text from public.order_request_lines where id = :lC), 'null')),
  'null/null/54700000-0000-0000-0000-0000000000a2/null',
  'E14: nothing the expired seat tried was saved: no claim, no picked quantity, and its own claim is kept');
select is((select o.status || '|' || coalesce(o.picking_completed_by::text, 'null') || '|'
                  || (select count(*) from public.stock_reservations r where r.order_request_id = :oP and r.released_at is null)::text
             from public.order_requests o where o.id = :oP)
          || '|' || (select status from public.order_requests where id = :oQ),
  'pick_slip_generated|null|1|pick_slip_generated',
  'E15: both orders with nothing to draw are still in picking, nobody completed them, and oP keeps its stock hold');
select is((select count(*)::int from public.stock_movements where organization_id = :org), 0,
  'C4: control: no stock moved');

-- ══ A. A real manager assigns a pick to the expired seat ══════════════════
set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select throws_ok(format('select public.assign_picking(%L::uuid, %L::uuid)', :oD, :exp), 'P0001', 'invalid_picker',
  'E11: assign_picking refuses the expired seat as the picker (invalid_picker)');
reset role;

-- ══ C. Controls: a live seat, the real owner, assigned staff ══════════════
set local "request.jwt.claim.sub" to :liv;
set local role to 'authenticated';
select ok(public.user_can_access_warehouse(:liv, :wh, 'read'), 'C5: control: a live seat keeps warehouse read');
select ok(public.user_can_access_inventory(:liv, :wh, null, 'write'), 'C6: control: a live seat keeps inventory write');
select is((select count(*)::int from public.rentals where organization_id = :org), 1, 'C7: control: a live seat reads the rental');
select lives_ok(format('select public.claim_picking(%L::uuid)', :oE), 'C8: control: a live seat claims a pick');
reset role;
set local "request.jwt.claim.sub" to :own;
set local role to 'authenticated';
select ok(public.user_can_access_warehouse(:own, :wh, 'write')
          and (select count(*) from public.rentals where organization_id = :org) = 1,
  'C9: control: the real owner is unchanged');
reset role;
set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select ok(public.user_can_access_inventory(:stf, :wh, null, 'write'), 'C10: control: assigned staff keep inventory write');
select lives_ok(format('select public.claim_picking(%L::uuid)', :oF), 'C11: control: assigned staff claim a pick');
reset role;

-- ══ D. One fixture through every membership helper (pattern 26) ═══════════
set local "request.jwt.claim.sub" to :exp;
set local role to 'authenticated';
select is(pg_temp.census(:exp),
  'is_org_member=false,user_org_role=-,has_org_role=false,has_permission=false,rls_member_org_ids=0,rls_manager_org_ids=0,rls_orgs_with_permission=0,rls_inv_read_full_warehouse_ids=0,rls_cat_unrestricted_org_ids=0,rls_exc_holding_location_ids=0,caller_can_write_location=false,caller_can_read_item=false,caller_is_warehouse_scoped=true,my_warehouse_ids=0,user_can_access_warehouse=false,user_can_access_inventory=false,user_can_see_item_category=false',
  'D1: the expired seat: every membership helper refuses (caller_is_warehouse_scoped fails safe: scoped)');
reset role;
set local "request.jwt.claim.sub" to :liv;
set local role to 'authenticated';
select is(pg_temp.census(:liv),
  'is_org_member=true,user_org_role=owner,has_org_role=true,has_permission=true,rls_member_org_ids=1,rls_manager_org_ids=1,rls_orgs_with_permission=1,rls_inv_read_full_warehouse_ids=1,rls_cat_unrestricted_org_ids=1,rls_exc_holding_location_ids=1,caller_can_write_location=true,caller_can_read_item=true,caller_is_warehouse_scoped=false,my_warehouse_ids=1,user_can_access_warehouse=true,user_can_access_inventory=true,user_can_see_item_category=true',
  'D2: control: a live seat: every membership helper admits it');
reset role;
set local "request.jwt.claim.sub" to :own;
set local role to 'authenticated';
select is(pg_temp.census(:own),
  'is_org_member=true,user_org_role=owner,has_org_role=true,has_permission=true,rls_member_org_ids=1,rls_manager_org_ids=1,rls_orgs_with_permission=1,rls_inv_read_full_warehouse_ids=1,rls_cat_unrestricted_org_ids=1,rls_exc_holding_location_ids=1,caller_can_write_location=true,caller_can_read_item=true,caller_is_warehouse_scoped=false,my_warehouse_ids=1,user_can_access_warehouse=true,user_can_access_inventory=true,user_can_see_item_category=true',
  'D3: control: the real owner: every membership helper admits them');
reset role;

-- ══ L. ledger._seal's warehouse arm ═══════════════════════════════════════
select is(pg_temp.seal_scope(:sx), 'out_of_scope#live=out_of_scope',
  'L1: _seal: a drawer who reaches location X''s warehouse only through an expired seat is out of scope, equal to the live predicate');
select is(pg_temp.seal_scope(:sl), 'in_scope#live=in_scope',
  'L2: control: _seal: the same through a live seat is in scope, equal to the live predicate');

-- ══ M. The maintenance write rule ═════════════════════════════════════════
set local "request.jwt.claim.sub" to :mno;
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_requests where id = :mrA), 1,
  'C12: control: the manager without manage still reads the request (read_all)');
select throws_ok(format($q$update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = %L$q$, :mrA),
  '42501', 'Only the requester or a maintenance manager can cancel a request.',
  'M1: without manage, a request whose requester was deleted: the cancel is refused');
select throws_ok(format($q$update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = %L$q$, :mrD),
  '42501', 'Only the requester or a maintenance manager can cancel a request.',
  'C13: control: without manage, a request whose requester exists: the cancel is refused, as before');
reset role;
select is((select status || '/' || coalesce(cancelled_at::text, 'null') from public.maintenance_requests where id = :mrA),
  'saved/null', 'M2: the request whose requester was deleted is still open');
set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select lives_ok(format($q$update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = %L$q$, :mrB),
  'C14: control: the requester cancels their own request');
reset role;
set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select lives_ok(format($q$update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = %L$q$, :mrC),
  'C15: control: a manage holder cancels a request whose requester was deleted');
reset role;
select is((select string_agg(status, ',' order by id) from public.maintenance_requests where id in (:mrB, :mrC)),
  'cancelled,cancelled', 'C16: control: both cancels landed');

-- Every other change by the manager without manage, each tried inside an
-- undone attempt (so the answer is what the caller gets, and nothing stays):
-- the update policy's role arm lets each row through, the guard's write rule
-- and the photo guard refuse it.
select is(pg_temp.value('authenticated', :mno,
            format($q$update public.maintenance_requests set subject = 'Rewritten by mno', description = 'Rewritten', priority = 'low'
                       where id = %L returning subject$q$, :mrA)),
  '42501:-:Only the requester or a maintenance manager can change a request.',
  'M3: without manage, a request whose requester was deleted: any other change is refused too');
select is(pg_temp.value('authenticated', :mno,
            format($q$update public.maintenance_requests set subject = 'Rewritten by mno', description = 'Rewritten', priority = 'low'
                       where id = %L returning subject$q$, :mrD)),
  '42501:-:Only the requester or a maintenance manager can change a request.',
  'M4: without manage, another member''s open request: any change is refused');
select is(pg_temp.value('authenticated', :mno,
            format('delete from public.maintenance_request_attachments where id = %L returning id::text', :pD1)),
  '42501:-:Only the requester or a maintenance manager can add or remove a request''s photos.',
  'M5: without manage, another member''s photo on their open request: the delete is refused');
select case when has_table_privilege('authenticated', 'public.maintenance_request_attachments', 'INSERT')
  then is(pg_temp.value('authenticated', :mno,
            format($q$insert into public.maintenance_request_attachments
                        (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
                      values (%L, %L, %L, 'm6.jpg', 'm6.jpg', 'image/jpeg', 100, %L) returning storage_path$q$,
                   :org, :mrD, '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/m6.jpg', :mno)),
          '42501:-:Only the requester or a maintenance manager can add or remove a request''s photos.',
          'M6: without manage, a photo row added to another member''s open request is refused')
  else skip('members hold no INSERT on maintenance_request_attachments (docket S9): the privilege refuses first', 1) end;
-- Controls, also undone: the requester and a manage holder still change mrD
-- and delete its photos, and the requester still adds one.
select is(pg_temp.value('authenticated', :stf,
            format($q$update public.maintenance_requests set subject = 'Edited by its requester' where id = %L returning subject$q$, :mrD)),
  'Edited by its requester', 'C17: control: the requester still changes their own open request');
select is(pg_temp.value('authenticated', :mgr,
            format($q$update public.maintenance_requests set subject = 'Edited by a manage holder' where id = %L returning subject$q$, :mrD)),
  'Edited by a manage holder', 'C18: control: a manage holder still changes another member''s request');
select is(pg_temp.value('authenticated', :stf,
            format('delete from public.maintenance_request_attachments where id = %L returning id::text', :pD2)),
  '54700000-0000-0000-0000-000000000502', 'C19: control: the requester still deletes their own photo');
select is(pg_temp.value('authenticated', :mgr,
            format('delete from public.maintenance_request_attachments where id = %L returning id::text', :pD1)),
  '54700000-0000-0000-0000-000000000501', 'C20: control: a manage holder still deletes another member''s photo');
select case when has_table_privilege('authenticated', 'public.maintenance_request_attachments', 'INSERT')
  then is(pg_temp.value('authenticated', :stf,
            format($q$insert into public.maintenance_request_attachments
                        (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
                      values (%L, %L, %L, 'c21.jpg', 'c21.jpg', 'image/jpeg', 100, %L) returning storage_path$q$,
                   :org, :mrD, '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/c21.jpg', :stf)),
          '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/c21.jpg',
          'C21: control: the requester still adds a photo row to their own open request')
  else skip('members hold no INSERT on maintenance_request_attachments (docket S9): the privilege refuses first', 1) end;

-- ══ R. One change per body ════════════════════════════════════════════════
select is(
  (select string_agg(f.k || ':tagged=' || (select count(*) from regexp_matches(p.prosrc, '-- S47', 'g'))::text || ':pre='
                     || md5(pg_temp.s47_strip(f.sig, p.prosrc)),
                     ',' order by f.k)
     from s47_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)),
  'ledger._seal:tagged=1:pre=1e6756966568825045ba05805e87d395,my_warehouse_ids:tagged=1:pre=7129bb768bce52a1ec1271be95afdffc,'
  'tg_maintenance_requests_guard:tagged=5:pre=6605c3607f283e2c3ab025d044da04c0,user_can_access_inventory:tagged=1:pre=8a214b77e32a052ca3bf07a2be39a8ae,'
  'user_can_access_warehouse:tagged=1:pre=76b4170f3d393e8a1f293ca3d4895955,user_can_see_item_category:tagged=1:pre=e6d071a182bc309168347d7c7127379e',
  'R1: one line tagged -- S47 per body (the guard five: its cancel line and its four-line write rule), and taking them out (in the guard, putting the old cancel condition back) gives production''s body exactly: 0373''s _seal, 0310''s four helpers, 0362''s guard');
select is(
  (select string_agg(f.k || '=' || md5(p.prosrc), ',' order by f.k)
     from s47_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)),
  -- Before S47 (production's, R1): _seal 1e675696, my_warehouse_ids 7129bb76,
  -- the guard 6605c360, user_can_access_inventory 8a214b77,
  -- user_can_access_warehouse 76b4170f, user_can_see_item_category e6d071a1.
  'ledger._seal=fc7686f95039a82b840c43372f01f850,my_warehouse_ids=eacc28d3bd2d1ebd09242f61b8a094ad,'
  'tg_maintenance_requests_guard=276cf27bfc1f122b7604a17b4555b357,user_can_access_inventory=f80f6ad98ba24e160661117f2c146091,'
  'user_can_access_warehouse=c3e618bb3c05d227e1f61686e5a1848f,user_can_see_item_category=e7ba372ee91b3785afe872c685cc583e',
  'R2: the six restated bodies (md5 of prosrc)');
select is(
  (select string_agg(f.k || '=' || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-'), ',' order by f.k)
     from s47_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)),
  -- Before S47: _seal 03866c5b (0373's), user_can_access_inventory d3b84a6a and
  -- user_can_access_warehouse 93acba60 (0312's), the guard 1784060d (0362's).
  -- The four new texts name the migration's number, so they are re-pinned
  -- when the file is renamed.
  'ledger._seal=daab54112ef298b061098348c5adf4c1,my_warehouse_ids=4272a860cd5b33d7ee020f2030b67228,'
  'tg_maintenance_requests_guard=f35eba29bbcd5210d30dd928a8a4884a,user_can_access_inventory=a85d154a034d10e01e445e04f8d2e3ed,'
  'user_can_access_warehouse=7d67606fe3f243ed45f1f0c8b921cf44,user_can_see_item_category=-',
  'R3: comments: the reviewed text on the two helpers, the guard and _seal; my_warehouse_ids keeps 0322''s, user_can_see_item_category has none');
select is(
  (select pg_get_triggerdef(t.oid) from pg_trigger t
    where t.tgrelid = 'public.maintenance_requests'::regclass and t.tgname = 'trg_aa_maintenance_requests_guard'),
  'CREATE TRIGGER trg_aa_maintenance_requests_guard BEFORE INSERT OR UPDATE ON public.maintenance_requests FOR EACH ROW EXECUTE FUNCTION tg_maintenance_requests_guard()',
  'R4: the guard still fires BEFORE INSERT OR UPDATE FOR EACH ROW');
select is(
  (select string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname) from pg_trigger t
    where t.tgrelid = 'public.maintenance_request_attachments'::regclass and not t.tgisinternal),
  'CREATE TRIGGER trg_maintenance_request_attachments_guard BEFORE INSERT OR DELETE ON public.maintenance_request_attachments FOR EACH ROW EXECUTE FUNCTION tg_maintenance_request_attachments_guard()',
  'R5: the photo guard fires BEFORE INSERT OR DELETE FOR EACH ROW, the only trigger on maintenance_request_attachments');

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select string_agg(p.oid::regprocedure::text || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':' || coalesce(p.proconfig::text, '-')
                     || ':' || pg_get_userbyid(p.proowner) || ':' || p.proisstrict::text || ':' || p.proleakproof::text || ':' || p.proparallel::text
                     || ':' || pg_get_function_result(p.oid), E'\n' order by p.oid::regprocedure::text)
     from s47_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)),
  E'ledger._seal(uuid,uuid,uuid,text,stock_draw_holding[],uuid[]):false:v:-:postgres:false:false:u:stock_draw\n'
  'my_warehouse_ids():true:s:{search_path=public}:postgres:false:false:u:TABLE(warehouse_id uuid)\n'
  'tg_maintenance_requests_guard():false:v:{search_path=public}:postgres:false:false:u:trigger\n'
  'user_can_access_inventory(uuid,uuid,uuid,text):true:s:{search_path=public}:postgres:false:false:u:boolean\n'
  'user_can_access_warehouse(uuid,uuid,text):true:s:{search_path=public}:postgres:false:false:u:boolean\n'
  'user_can_see_item_category(uuid,uuid,uuid):true:s:{search_path=public}:postgres:false:false:u:boolean',
  'P1: control: posture unchanged: SECURITY mode, volatility, SET clause, owner, STRICT, LEAKPROOF, PARALLEL, result');
select is(
  (select string_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '-'), E'\n' order by p.oid::regprocedure::text)
     from s47_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)),
  E'ledger._seal(uuid,uuid,uuid,text,stock_draw_holding[],uuid[]):{postgres=X/postgres}\n'
  'my_warehouse_ids():{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}\n'
  'tg_maintenance_requests_guard():{postgres=X/postgres,service_role=X/postgres}\n'
  'user_can_access_inventory(uuid,uuid,uuid,text):{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}\n'
  'user_can_access_warehouse(uuid,uuid,text):{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}\n'
  'user_can_see_item_category(uuid,uuid,uuid):{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  'P2: control: EXECUTE unchanged (CREATE OR REPLACE keeps it): authenticated and service_role on the four helpers, service_role on the guard, nobody on _seal');
select is(
  (select string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname)
     from pg_proc p where p.oid in ('public.has_org_role(uuid,text)'::regprocedure, 'public.is_org_member(uuid)'::regprocedure,
                                    'public.caller_can_write_location(uuid)'::regprocedure, 'public.has_permission(uuid,text)'::regprocedure)),
  'caller_can_write_location:188634bf8552a0064bfbf1ebfecf814f,has_org_role:10422b29a6e15acd003d4f11ed28e90c,has_permission:cc0accdad7e2fdf4f88aa82aa887e85f,is_org_member:76492a6556e9f6a7c33d942aa9726f9f',
  'P3: control: the predicates _seal mirrors, and has_permission (the guard''s v_manage), are untouched');
select ok(
  (select bool_and(p.prosrc ~ 'impersonation_expires_at > (pg_catalog\.)?now\(\)\)  -- S47')
     from s47_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)
    where f.k <> 'tg_maintenance_requests_guard')
  and (select position(pg_temp.s47_text('cancel') in p.prosrc) > 0 and position(pg_temp.s47_text('block') in p.prosrc) > 0
         from pg_proc p where p.oid = 'public.tg_maintenance_requests_guard()'::regprocedure),
  'P4: each body carries its S47 term: the expiry test in five; in the guard, the definite cancel answer and the write rule');
select is(
  (select p.prosecdef::text || ':' || p.provolatile::text || ':' || coalesce(p.proconfig::text, '-') || ':' || pg_get_userbyid(p.proowner)
          || ':' || p.proisstrict::text || ':' || p.proleakproof::text || ':' || p.proparallel::text || ':' || pg_get_function_result(p.oid)
          || ':' || coalesce(p.proacl::text, '-') || ':' || md5(p.prosrc) || ':' || coalesce(md5(obj_description(p.oid, 'pg_proc')), '-')
     from pg_proc p where p.oid = to_regprocedure('public.tg_maintenance_request_attachments_guard()')),
  'false:v:{search_path=public}:postgres:false:false:u:trigger:{postgres=X/postgres,service_role=X/postgres}:d896b5511d7e7036c663f9309acfc91c:68328a75e9060258ad775ccd1fddd8cf',
  'P5: the photo guard''s function: SECURITY INVOKER, volatile, search_path pinned, owned by postgres, EXECUTE for service_role only, its reviewed body and comment');

-- ══ F. The migration's preflight, replayed ════════════════════════════════
select is(pg_temp.try_pre(null),
  '55000:s47_preflight:ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[]) drifted, '
  'public.my_warehouse_ids() drifted, public.tg_maintenance_request_attachments_guard() exists, public.tg_maintenance_requests_guard() drifted, '
  'public.user_can_access_inventory(uuid,uuid,uuid,text) drifted, public.user_can_access_warehouse(uuid,uuid,text) drifted, '
  'public.user_can_see_item_category(uuid,uuid,uuid) drifted, trg_maintenance_request_attachments_guard exists',
  'F1: a second run is refused before anything is applied (55000, hint s47_preflight): every body it restates has drifted from its pin, and the photo guard''s two names are taken');
select is(pg_temp.try_pre(pg_temp.pre(array['ledger._seal', 'my_warehouse_ids', 'tg_maintenance_requests_guard',
                                            'user_can_access_inventory', 'user_can_access_warehouse', 'user_can_see_item_category'])
                          || E';\n' || pg_temp.drop_photo_guard()),
  'ok',
  'F2: on the six pre-S47 bodies (R1''s), with the photo guard gone, the preflight passes: its pins are production''s bodies and headers');
select is(pg_temp.try_pre(pg_temp.pre(array['ledger._seal', 'my_warehouse_ids', 'tg_maintenance_requests_guard',
                                            'user_can_access_inventory', 'user_can_access_warehouse', 'user_can_see_item_category'])
                          || E';\n' || pg_temp.drop_photo_guard()
                          || E';\nalter function public.user_can_see_item_category(uuid, uuid, uuid) security invoker'),
  '55000:s47_preflight:public.user_can_see_item_category(uuid,uuid,uuid) drifted',
  'F3: a drifted header (SECURITY INVOKER) on a pre-S47 body is refused too, naming only that function');

-- ══ X. Mutations: each S47 line taken out, the photo guard dropped ═════════
select is(pg_temp.value(null, null, format('select pg_temp.seal_scope(%L)', :sx), pg_temp.pre(array['ledger._seal'])),
  'in_scope#live=out_of_scope',
  'X1: _seal''s S47 line taken out (the helpers kept): L1''s drawer is in scope again and _seal disagrees with the live predicate');
select is(pg_temp.value('authenticated', :exp,
            format($q$select (select count(*) from public.rentals where organization_id = %L)::text
                             || '/' || public.user_can_access_warehouse(%L, %L, 'read')::text
                             || '/' || public.user_can_access_inventory(%L, %L, null, 'write')::text
                             || '/' || case when (public.claim_picking(%L)).assigned_picker_id = %L::uuid then 'claimed' else 'not claimed' end$q$,
                   :org, :exp, :wh, :exp, :wh, :oA, :exp),
            pg_temp.pre(array['user_can_access_inventory', 'user_can_access_warehouse'])),
  '1/true/true/claimed',
  'X2: the two helpers'' S47 lines taken out: the expired seat reads the rental and claims a pick again');
select is(pg_temp.value('authenticated', :exp, format('select pg_temp.census(%L)', :exp),
                        pg_temp.pre(array['my_warehouse_ids', 'user_can_see_item_category'])),
  'is_org_member=false,user_org_role=-,has_org_role=false,has_permission=false,rls_member_org_ids=0,rls_manager_org_ids=0,rls_orgs_with_permission=0,rls_inv_read_full_warehouse_ids=0,rls_cat_unrestricted_org_ids=0,rls_exc_holding_location_ids=1,caller_can_write_location=false,caller_can_read_item=false,caller_is_warehouse_scoped=true,my_warehouse_ids=1,user_can_access_warehouse=false,user_can_access_inventory=false,user_can_see_item_category=true',
  'X3: the two siblings'' S47 lines taken out: my_warehouse_ids, rls_exc_holding_location_ids (through it) and user_can_see_item_category admit the expired seat again');
select is(pg_temp.value('authenticated', :mno,
            format($q$update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = %L returning status$q$, :mrA),
            pg_temp.pre(array['tg_maintenance_requests_guard'])),
  'cancelled',
  'X4: the guard''s pre-S47 body (the old cancel condition back, the write rule out): M1''s cancel goes through again');
select is(pg_temp.value('authenticated', :mno,
            format($q$with u as (update public.maintenance_requests set subject = 'Rewritten by mno', description = 'Rewritten', priority = 'low'
                                  where id in (%L, %L) returning id)
                      select count(*)::text from u$q$, :mrA, :mrD),
            $p$select pg_temp.unpatch('public.tg_maintenance_requests_guard()', 'block')$p$),
  '2',
  'X5: the guard''s write rule alone taken out (the cancel line kept): M3''s and M4''s changes go through again');
select is(pg_temp.value('authenticated', :mno,
            format('delete from public.maintenance_request_attachments where id = %L returning id::text', :pD1),
            'drop trigger trg_maintenance_request_attachments_guard on public.maintenance_request_attachments'),
  '54700000-0000-0000-0000-000000000501',
  'X6: the photo guard''s trigger dropped: M5''s delete goes through again');
select case when has_table_privilege('authenticated', 'public.maintenance_request_attachments', 'INSERT')
  then is(pg_temp.value('authenticated', :mno,
            format($q$insert into public.maintenance_request_attachments
                        (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
                      values (%L, %L, %L, 'm6.jpg', 'm6.jpg', 'image/jpeg', 100, %L) returning storage_path$q$,
                   :org, :mrD, '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/m6.jpg', :mno),
            'drop trigger trg_maintenance_request_attachments_guard on public.maintenance_request_attachments'),
          '54700000-0000-0000-0000-00000000000a/54700000-0000-0000-0000-000000000404/m6.jpg',
          'X7: the photo guard''s trigger dropped: M6''s photo row goes in again')
  else skip('members hold no INSERT on maintenance_request_attachments (docket S9): the privilege refuses first', 1) end;

select * from finish();
rollback;
