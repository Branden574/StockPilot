-- supabase/tests/0413_order_catalog_visibility.test.sql
-- pgTAP proof for migration 0413 (ordering visibility): which items and books
-- appear in Place an Order, who may change that, and that a hidden item can
-- never become new demand.
--
-- Personas (real `authenticated` calls with request.jwt.claim.sub):
--   own owner, adm admin, mgr manager, mgrD manager (denied by StockPilot
--   later), stf staff assigned to whA (no capability; the requester of the
--   test orders), stfA staff assigned to whA (allowed by StockPilot later),
--   vwr viewer, vwrA viewer with a charter-scoped assignment (whA, chA) and
--   one category grant (catA), allowed by StockPilot later, dis a disabled
--   manager, mgrB a manager of org B, nobody (no membership), plat the
--   platform admin's own account (no membership in A).
--
-- S.  Shape: columns, default, index, org mark, triggers, function postures
--     and grants, the two seed rows, the platform-managed key list.
-- P.  can_manage_order_catalog: owner, admin, manager yes; staff, viewer,
--     non-member, disabled no.
-- SC. Read-scope parity: the visibility write's set-based scope query agrees
--     with caller_can_read_item and with inventory_items RLS for a manager,
--     a delegated staff member and a delegated charter- and category-scoped
--     viewer, item by item.
-- W.  set_order_catalog_visibility: hide XS only (S and M untouched, every
--     other column unchanged, updated_at kept); retry is a no-op with no
--     audit row; the audit row; the org mark; forged callers refused;
--     duplicates collapsed; a foreign, unreadable, deleted, rental or kit id
--     refuses the whole call echoing only the caller's ids; input checks;
--     module off; a failure on the third row leaves nothing changed and no
--     audit row; no stock, holding, reservation or line row changes.
-- MF. The MFA parity table (48 cases): every mfa_policy x owner, admin,
--     manager, allowed staff x enrolled or not x aal1 or aal2, against the
--     app's resolveMfaState rule.
-- G.  Direct writes: the item guard refuses an UPDATE of either column for
--     staff with items:update, a manager and service_role; the same value
--     passes; an INSERT may carry hidden and is stamped by the database.
-- PE. The exception: only platform_set_permission_exception (service_role)
--     writes the key; org admins and owners (insert, update, upsert,
--     delete), service_role direct writes and role rows are refused in
--     the database; other keys are unaffected; allow gives staff only this
--     capability; compare-and-set conflict; deny a manager (single and bulk
--     refused), deny the owner; deny survives role changes (direct UPDATE
--     by an admin); reset restores; audit rows; repeat is a no-op; grants;
--     the request context carries the row and the org mark.
-- O.  The new-demand gate: direct line insert, create_order_request,
--     place_order_request (recorded hidden_from_orders, replayed),
--     service_role insert, raise by UPDATE; lowering, removal and other
--     line columns pass; the leak check (a foreign or unreadable hidden item
--     gets the RLS refusal, not the hint); a hide between step 8 and the
--     insert (probe) records item_not_orderable and leaves no order.
-- A.  add_order_request_lines and _order_request_line_top_up: happy path
--     (top-up + new line), hidden refused before any write, a hide between
--     the top-up and the insert (probe) leaves the top-up undone, every
--     direct-call refusal of the helper.
-- X.  Exchanges: the replacement order's line is exempt; a re-issue of an
--     item approved earlier passes, a new staff selection of a hidden item
--     is refused; candidates and requester options exclude hidden items.
-- L.  public_link_eligible_items excludes a hidden item and admits it again
--     on show; public_visibility never changes.
-- D.  duplicate_inventory_item copies the choice; unarchive and the first
--     receipt keep it.
-- R.  The review fix round (integrator decisions D1 and D2, three reviews):
--     the top-up helper refuses a direct call and an organization with Orders
--     off; one ceiling of 10,000 on a line's RESULTING quantity on every add
--     path (boundaries 10,000 and 10,001); moving a line to another order is
--     gated; an exchange commitment is exempt only for the exact line
--     change_return_replacement keeps, in its own transaction; the platform
--     function records the actor's own auth email and refuses an unknown
--     actor; the gate itself refuses an API writer's foreign or unreadable
--     hidden item (no hint, no detail); insert_order_request_with_lines
--     writes a portal or public-link header and its lines in one
--     transaction, so a hidden item leaves no header, line or notification,
--     and holds the same 10,000-unit line ceiling (D2).
-- C.  Census: the only UPDATE writer of the column, the bodies that read it,
--     no function writes role_default_permissions, the user override writers.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt). begin/rollback: nothing leaks. Namespace 04130000.

begin;

select plan(87);

\set orgA    '\'04130000-0000-0000-0000-00000000000a\''
\set orgB    '\'04130000-0000-0000-0000-00000000000b\''
\set orgC    '\'04130000-0000-0000-0000-00000000000c\''
\set orgM    '\'04130000-0000-0000-0000-00000000000d\''
\set own     '\'04130000-0000-0000-0000-0000000000a0\''
\set adm     '\'04130000-0000-0000-0000-0000000000a1\''
\set mgr     '\'04130000-0000-0000-0000-0000000000a2\''
\set mgrD    '\'04130000-0000-0000-0000-0000000000a3\''
\set stf     '\'04130000-0000-0000-0000-0000000000a4\''
\set stfA    '\'04130000-0000-0000-0000-0000000000a5\''
\set vwr     '\'04130000-0000-0000-0000-0000000000a6\''
\set vwrA    '\'04130000-0000-0000-0000-0000000000a7\''
\set dis     '\'04130000-0000-0000-0000-0000000000a8\''
\set mgrB    '\'04130000-0000-0000-0000-0000000000b1\''
\set nobody  '\'04130000-0000-0000-0000-0000000000c1\''
\set plat    '\'04130000-0000-0000-0000-0000000000c2\''
\set ownC    '\'04130000-0000-0000-0000-0000000000c3\''
\set mOwn    '\'04130000-0000-0000-0000-0000000000e0\''
\set mAdm    '\'04130000-0000-0000-0000-0000000000e1\''
\set mMgr    '\'04130000-0000-0000-0000-0000000000e2\''
\set mStf    '\'04130000-0000-0000-0000-0000000000e3\''
\set whA     '\'04130000-0000-0000-0000-0000000000d1\''
\set whA2    '\'04130000-0000-0000-0000-0000000000d2\''
\set whB     '\'04130000-0000-0000-0000-0000000000d3\''
\set whC     '\'04130000-0000-0000-0000-0000000000d4\''
\set whM     '\'04130000-0000-0000-0000-0000000000d5\''
\set chA     '\'04130000-0000-0000-0000-0000000000f1\''
\set catA    '\'04130000-0000-0000-0000-0000000000f8\''
\set catB    '\'04130000-0000-0000-0000-0000000000f9\''
\set grp     '\'04130000-0000-0000-0000-0000000000f0\''
\set iXS     '\'04130000-0000-0000-0000-000000000101\''
\set iS      '\'04130000-0000-0000-0000-000000000102\''
\set iM      '\'04130000-0000-0000-0000-000000000103\''
\set iBook   '\'04130000-0000-0000-0000-000000000104\''
\set iOk     '\'04130000-0000-0000-0000-000000000105\''
\set iOk2    '\'04130000-0000-0000-0000-000000000106\''
\set iFar    '\'04130000-0000-0000-0000-000000000107\''
\set iCh     '\'04130000-0000-0000-0000-000000000108\''
\set iDel    '\'04130000-0000-0000-0000-000000000109\''
\set iRent   '\'04130000-0000-0000-0000-00000000010a\''
\set iKit    '\'04130000-0000-0000-0000-00000000010b\''
\set iExp    '\'04130000-0000-0000-0000-00000000010c\''
\set iArch   '\'04130000-0000-0000-0000-00000000010d\''
\set iB      '\'04130000-0000-0000-0000-00000000010e\''
\set iC      '\'04130000-0000-0000-0000-00000000010f\''
\set iTop    '\'04130000-0000-0000-0000-000000000110\''
\set iNew    '\'04130000-0000-0000-0000-000000000111\''
\set iRace   '\'04130000-0000-0000-0000-000000000112\''
\set iPrb    '\'04130000-0000-0000-0000-000000000113\''
\set iM1     '\'04130000-0000-0000-0000-000000000114\''
\set iBH     '\'04130000-0000-0000-0000-000000000115\''
\set iFarH   '\'04130000-0000-0000-0000-000000000116\''
\set oPend   '\'04130000-0000-0000-0000-000000000201\''
\set oFar    '\'04130000-0000-0000-0000-000000000202\''
\set oShip   '\'04130000-0000-0000-0000-000000000203\''
\set oDone   '\'04130000-0000-0000-0000-000000000204\''
\set oRepl   '\'04130000-0000-0000-0000-000000000205\''
\set oAdd    '\'04130000-0000-0000-0000-000000000206\''
\set lDone   '\'04130000-0000-0000-0000-000000000301\''
\set lRepl   '\'04130000-0000-0000-0000-000000000302\''
\set lPend   '\'04130000-0000-0000-0000-000000000303\''
\set lAdd    '\'04130000-0000-0000-0000-000000000304\''
\set lX      '\'04130000-0000-0000-0000-000000000305\''
\set lY      '\'04130000-0000-0000-0000-000000000306\''
\set rma     '\'04130000-0000-0000-0000-000000000401\''
\set rmaL    '\'04130000-0000-0000-0000-000000000402\''
\set xl      '\'04130000-0000-0000-0000-000000000403\''
\set lnk     '\'04130000-0000-0000-0000-000000000501\''
\set op1     '\'04139000-0000-4000-8000-000000000001\''
\set op2     '\'04139000-0000-4000-8000-000000000002\''
\set op3     '\'04139000-0000-4000-8000-000000000003\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0413-own@ordvis.test',    '{}'::jsonb),
  (:adm,    '0413-adm@ordvis.test',    '{}'::jsonb),
  (:mgr,    '0413-mgr@ordvis.test',    '{}'::jsonb),
  (:mgrD,   '0413-mgrd@ordvis.test',   '{}'::jsonb),
  (:stf,    '0413-stf@ordvis.test',    '{}'::jsonb),
  (:stfA,   '0413-stfa@ordvis.test',   '{}'::jsonb),
  (:vwr,    '0413-vwr@ordvis.test',    '{}'::jsonb),
  (:vwrA,   '0413-vwra@ordvis.test',   '{}'::jsonb),
  (:dis,    '0413-dis@ordvis.test',    '{}'::jsonb),
  (:mgrB,   '0413-mgrb@ordvis.test',   '{}'::jsonb),
  (:nobody, '0413-nobody@ordvis.test', '{}'::jsonb),
  (:plat,   '0413-plat@ordvis.test',   '{}'::jsonb),
  (:ownC,   '0413-ownc@ordvis.test',   '{}'::jsonb),
  (:mOwn,   '0413-mown@ordvis.test',   '{}'::jsonb),
  (:mAdm,   '0413-madm@ordvis.test',   '{}'::jsonb),
  (:mMgr,   '0413-mmgr@ordvis.test',   '{}'::jsonb),
  (:mStf,   '0413-mstf@ordvis.test',   '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them). Org A's MFA
-- policy is optional so the sections before MF test one thing at a time.
insert into public.organizations (id, name, slug) values
  (:orgA, '0413 Visibility A', '0413-visibility-a'),
  (:orgB, '0413 Visibility B', '0413-visibility-b'),
  (:orgC, '0413 Visibility C', '0413-visibility-c'),
  (:orgM, '0413 Visibility M', '0413-visibility-m');
update public.organizations set mfa_policy = 'optional' where id in (:orgA, :orgB, :orgC);
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,  'owner',   now()),
  (:orgA, :adm,  'admin',   now()),
  (:orgA, :mgr,  'manager', now()),
  (:orgA, :mgrD, 'manager', now()),
  (:orgA, :stf,  'staff',   now()),
  (:orgA, :stfA, 'staff',   now()),
  (:orgA, :vwr,  'viewer',  now()),
  (:orgA, :vwrA, 'viewer',  now()),
  (:orgA, :dis,  'manager', now()),
  (:orgB, :mgrB, 'manager', now()),
  (:orgC, :ownC, 'owner',   now()),
  (:orgM, :mOwn, 'owner',   now()),
  (:orgM, :mAdm, 'admin',   now()),
  (:orgM, :mMgr, 'manager', now()),
  (:orgM, :mStf, 'staff',   now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0413 Main',  'WH-0413A',  'active'),
  (:whA2, :orgA, '0413 Annex', 'WH-0413A2', 'active'),
  (:whB,  :orgB, '0413 B',     'WH-0413B',  'active'),
  (:whC,  :orgC, '0413 C',     'WH-0413C',  'active'),
  (:whM,  :orgM, '0413 M',     'WH-0413M',  'active');
update public.warehouses set is_public_orderable = true where id = :whA;
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0413 North', 'C0413N', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chA);
insert into public.categories (id, organization_id, name) values
  (:catA, :orgA, '0413 Apparel'),
  (:catB, :orgA, '0413 Tech');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,  :whA, null, true),
  (:orgA, :stfA, :whA, null, true),
  (:orgA, :vwr,  :whA, null, true),
  (:orgA, :vwrA, :whA, :chA, true),
  (:orgM, :mStf, :whM, null, true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwrA, :catA);
insert into public.product_groups (id, organization_id, name, group_key, status) values
  (:grp, :orgA, 'New Hire Shirt', '0413-new-hire-shirt', 'active');

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, quantity_on_hand, status, category_id, charter_id,
   is_rental, awaiting_first_receipt, is_bundle, deleted_at, group_id, variant_key, variant_size,
   public_visibility, created_at, updated_at) values
  (:iXS,   :orgA, :whA,  'X0413-SH-XS', 'New Hire Shirt', 'product', 10, 'active',   :catA, null, false, false, false, null,  :grp, 'XS', 'XS', 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iS,    :orgA, :whA,  'X0413-SH-S',  'New Hire Shirt', 'product', 10, 'active',   :catA, null, false, false, false, null,  :grp, 'S',  'S',  'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iM,    :orgA, :whA,  'X0413-SH-M',  'New Hire Shirt', 'product', 10, 'active',   :catA, null, false, false, false, null,  :grp, 'M',  'M',  'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iBook, :orgA, :whA,  'X0413-BOOK',  'Field Guide to Ponds', 'book', 10, 'active', :catA, null, false, false, false, null, null, null, null, 'public', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iOk,   :orgA, :whA,  'X0413-OK',    'Fine item',      'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iOk2,  :orgA, :whA,  'X0413-OK2',   'Fine item two',  'product', 10, 'active',   :catB, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iFar,  :orgA, :whA2, 'X0413-FAR',   'Annex item',     'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iCh,   :orgA, :whA,  'X0413-CH',    'Charter item',   'product', 10, 'active',   :catA, :chA, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iDel,  :orgA, :whA,  'X0413-DEL',   'Deleted item',   'product', 0,  'active',   :catA, null, false, false, false, now(), null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iRent, :orgA, :whA,  'X0413-RNT',   'Rental item',    'product', 10, 'active',   :catA, null, true,  false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iKit,  :orgA, :whA,  'X0413-KIT',   'Kit stock',      'product', 10, 'active',   :catA, null, false, false, true,  null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iExp,  :orgA, :whA,  'X0413-EXP',   'Expected item',  'product', 0,  'active',   :catA, null, false, true,  false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iArch, :orgA, :whA,  'X0413-ARC',   'Archived item',  'product', 10, 'archived', :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iTop,  :orgA, :whA,  'X0413-TOP',   'Topped item',    'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iNew,  :orgA, :whA,  'X0413-NEW',   'Added item',     'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iRace, :orgA, :whA,  'X0413-RACE',  'Race item',      'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iPrb,  :orgA, :whA,  'X0413-PRB',   'Probe item',     'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iFarH, :orgA, :whA2, 'X0413-FARH',  'Annex hidden',   'product', 10, 'active',   :catA, null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iB,    :orgB, :whB,  'X0413-B',     'Org B item',     'product', 10, 'active',   null,  null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iBH,   :orgB, :whB,  'X0413-BH',    'Org B hidden',   'product', 10, 'active',   null,  null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iC,    :orgC, :whC,  'X0413-C',     'Org C item',     'product', 10, 'active',   null,  null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:iM1,   :orgM, :whM,  'X0413-M1',    'MFA item',       'product', 10, 'active',   null,  null, false, false, false, null,  null, null, null, 'internal_only', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');

-- The disabled manager, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- Orders placed BEFORE anything is hidden (existing history). Written as the
-- superuser: the workflow guards apply to the API roles only.
insert into public.order_requests (id, organization_id, warehouse_id, source, status, requester_user_id, fulfillment_type) values
  (:oPend, :orgA, :whA,  'internal', 'pending_approval', :stf, 'pickup'),
  (:oFar,  :orgA, :whA2, 'internal', 'pending_approval', :stf, 'pickup'),
  (:oShip, :orgA, :whA,  'internal', 'in_transit',       :stf, 'pickup'),
  (:oDone, :orgA, :whA,  'internal', 'completed',        :stf, 'pickup'),
  (:oAdd,  :orgA, :whA,  'internal', 'pending_approval', :stf, 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lPend, :oPend, :iS,   2, 0),
  (:lDone, :oDone, :iXS,  1, 1),
  (:lAdd,  :oAdd,  :iTop, 1, 0);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:oShip, :iOk, 1);

-- One public link on whA: the book is public (pool), the shirt S is entered.
insert into public.public_request_links (id, organization_id, token_hash, name, active, include_public_pool,
                                         books_enabled, items_enabled, default_max_qty, created_by)
values (:lnk, :orgA, md5('0413-link-a') || md5('0413-link-b'), '0413 Link', true, true, true, true, 5, :mgr);
insert into public.public_link_catalog_entries (link_id, item_id) values (:lnk, :iS);

-- One call as a role and a user: the result as text, or
-- ERR:<sqlstate>:<hint>:<detail> (a failed call's subtransaction is rolled
-- back with everything it wrote). p_aal sets the token's aal claim.
create function pg_temp.run(p_as text, p_sub uuid, p_sql text, p_aal text default null) returns text language plpgsql as $$
declare v_state text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub, 'role', p_as, 'aal', coalesce(p_aal, 'aal1'))::text, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;
-- The same call, answering ERR:<sqlstate>:<message> on a refusal: which code
-- path refused (the gate's own words, or the insert policy's) when the hint
-- and detail are both empty.
create function pg_temp.run_msg(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', p_as, 'aal', 'aal1')::text, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_msg, '');
  end;
  return coalesce(v, 'null');
end $$;
-- A read in its own snapshot: a plain subquery in the same SELECT as a
-- writing call sees the statement's snapshot, taken before the call wrote.
create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'null');
end $$;
-- One key of a call's JSON answer, or the refusal as it came (ERR:...).
create function pg_temp.jf(p_answer text, p_key text) returns text language plpgsql as $$
begin
  if p_answer like 'ERR:%' then
    return p_answer;
  end if;
  return coalesce(p_answer::jsonb ->> p_key, 'null');
end $$;
-- set_order_catalog_visibility as a member.
create function pg_temp.vis(p_sub uuid, p_ids uuid[], p_visible boolean, p_op uuid,
                            p_org uuid default '04130000-0000-0000-0000-00000000000a', p_aal text default null)
returns text language sql as $$
  select pg_temp.run('authenticated', p_sub,
    format('select public.set_order_catalog_visibility(%L, %L::uuid[], %L, %L, ''web'')::text', p_org, p_ids, p_visible, p_op),
    p_aal)
$$;
-- The platform function as the service role.
create function pg_temp.exc(p_org uuid, p_user uuid, p_state text, p_expected text,
                            p_perm text default 'orders:manage_catalog_visibility') returns text language sql as $$
  select pg_temp.run('service_role', null,
    format('select public.platform_set_permission_exception(%L, %L, %L, %L, %L, %L, %L)::text',
           p_org, p_user, p_perm, p_state, p_expected, '04130000-0000-0000-0000-0000000000c2', 'support@stockpilot.test'))
$$;
-- can_manage_order_catalog as a member.
create function pg_temp.can(p_sub uuid, p_org uuid default '04130000-0000-0000-0000-00000000000a') returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.can_manage_order_catalog(%L)::text', p_org))
$$;
-- An item row without the two visibility columns, the three timestamps and
-- the derived search columns: what a hide must leave untouched.
create function pg_temp.item_rest(p_id uuid) returns text language sql as $$
  select md5((to_jsonb(i) - 'order_catalog_visible' - 'order_catalog_visibility_changed_at'
              - 'search_vector' - 'embedding')::text)
    from public.inventory_items i where i.id = p_id
$$;
create function pg_temp.vis_of(p_id uuid) returns text language sql as $$
  select order_catalog_visible::text from public.inventory_items where id = p_id
$$;
-- A request for place_order_request (snake_case, as the service builds it).
create function pg_temp.req(p_placer uuid, p_item uuid, p_notes text default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'organization_id', '04130000-0000-0000-0000-00000000000a', 'placer_user_id', p_placer,
    'surface', 'web', 'warehouse_id', '04130000-0000-0000-0000-0000000000d1', 'fulfillment_type', 'pickup',
    'delivery_charter_id', null, 'on_behalf_name', null, 'on_behalf_email', null, 'notes', p_notes,
    'needed_by', null, 'lines', jsonb_build_array(jsonb_build_object('item_id', p_item, 'quantity', 1)))
$$;

-- ═══ S. Shape ═════════════════════════════════════════════════════════════
select is(
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
                     || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' order by a.attname)
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where (a.attrelid = 'public.inventory_items'::regclass
           and a.attname in ('order_catalog_visible', 'order_catalog_visibility_changed_at'))
       or (a.attrelid = 'public.organizations'::regclass and a.attname = 'order_catalog_last_hide_at')),
  'order_catalog_last_hide_at:timestamp with time zone:false:-,'
  'order_catalog_visibility_changed_at:timestamp with time zone:false:-,'
  'order_catalog_visible:boolean:true:true',
  'S1: the two item columns (NOT NULL DEFAULT true, and the nullable stamp) and the org hide mark');
select is(
  (select pg_get_indexdef('public.inventory_items_order_hidden_idx'::regclass)),
  'CREATE INDEX inventory_items_order_hidden_idx ON public.inventory_items USING btree (organization_id, warehouse_id, order_catalog_visibility_changed_at) WHERE (order_catalog_visible = false)',
  'S2: the partial index of hidden rows');
select is(
  (select string_agg(c.relname || ':' || t.tgname, ',' order by c.relname, t.tgname)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
      and t.tgname in ('trg_zz_inventory_items_order_visibility', 'trg_zz_platform_managed_permission_guard',
                       'trg_zz_order_request_lines_zz_order_visibility', 'trg_zz_order_request_lines_zz_order_visibility_upd')),
  'inventory_items:trg_zz_inventory_items_order_visibility,'
  'order_request_lines:trg_zz_order_request_lines_zz_order_visibility,'
  'order_request_lines:trg_zz_order_request_lines_zz_order_visibility_upd,'
  'role_default_permissions:trg_zz_platform_managed_permission_guard,'
  'role_permission_overrides:trg_zz_platform_managed_permission_guard,'
  'user_permission_overrides:trg_zz_platform_managed_permission_guard',
  'S3: the item guard, the two gate triggers and the three permission guards exist');
select is(
  (select string_agg((pg_get_triggerdef(t.oid) ~ x.want)::text, ',' order by t.tgname)
     from pg_trigger t
     join (values
       ('trg_zz_inventory_items_order_visibility', '^CREATE TRIGGER \S+ BEFORE INSERT OR UPDATE OF order_catalog_visible, order_catalog_visibility_changed_at ON public\.inventory_items FOR EACH ROW EXECUTE FUNCTION tg_inventory_items_order_visibility_guard\(\)$'),
       ('trg_zz_order_request_lines_zz_order_visibility', '^CREATE TRIGGER \S+ BEFORE INSERT ON public\.order_request_lines FOR EACH ROW EXECUTE FUNCTION tg_order_request_lines_order_visibility\(\)$'),
       ('trg_zz_order_request_lines_zz_order_visibility_upd', '^CREATE TRIGGER \S+ BEFORE UPDATE OF quantity_requested, item_id, order_request_id ON public\.order_request_lines FOR EACH ROW WHEN \(\(\(new\.quantity_requested > old\.quantity_requested\) OR \(new\.item_id IS DISTINCT FROM old\.item_id\) OR \(new\.order_request_id IS DISTINCT FROM old\.order_request_id\)\)\) EXECUTE FUNCTION tg_order_request_lines_order_visibility\(\)$')
     ) x(name, want) on x.name = t.tgname
    where t.tgrelid in ('public.inventory_items'::regclass, 'public.order_request_lines'::regclass)),
  'true,true,true',
  'S4: the item guard fires on INSERT and on UPDATE OF the two columns; the gate on INSERT, and on UPDATE OF quantity, item or order only when the quantity rises, the item changes or the line moves to another order');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef || ':' || p.provolatile::text
                     || ':' || has_function_privilege('anon', p.oid, 'execute')
                     || ':' || has_function_privilege('authenticated', p.oid, 'execute')
                     || ':' || has_function_privilege('service_role', p.oid, 'execute')
                     || ':' || coalesce((select c from unnest(p.proconfig) c where c like 'search_path=%'), '-'),
                     ',' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('set_order_catalog_visibility', 'can_manage_order_catalog', '_platform_managed_permissions',
                        'platform_set_permission_exception', '_order_items_hidden_from_orders', 'add_order_request_lines',
                        '_order_request_line_top_up', 'tg_inventory_items_order_visibility_guard',
                        'tg_platform_managed_permission_guard', 'tg_order_request_lines_order_visibility',
                        'insert_order_request_with_lines')),
  '_order_items_hidden_from_orders:false:s:false:true:false:search_path=public, pg_temp,'
  '_order_request_line_top_up:true:v:false:true:false:search_path=public, pg_temp,'
  '_platform_managed_permissions:false:i:true:true:true:search_path=public, pg_temp,'
  'add_order_request_lines:false:v:false:true:false:search_path=public, pg_temp,'
  'can_manage_order_catalog:false:s:false:true:false:search_path=public, pg_temp,'
  'insert_order_request_with_lines:false:v:false:false:true:search_path=public, pg_temp,'
  'platform_set_permission_exception:true:v:false:false:true:search_path=public, pg_temp,'
  'set_order_catalog_visibility:true:v:false:true:false:search_path=public, pg_temp,'
  'tg_inventory_items_order_visibility_guard:false:v:false:false:false:search_path=public, pg_temp,'
  'tg_order_request_lines_order_visibility:true:v:false:false:false:search_path=public, pg_temp,'
  'tg_platform_managed_permission_guard:false:v:false:false:false:search_path=public, pg_temp',
  'S5: each new function''s SECURITY mode, volatility, EXECUTE grants (anon, authenticated, service_role) and pinned search_path');
select is(
  (select string_agg(role, ',' order by role) from public.role_default_permissions
    where permission = 'orders:manage_catalog_visibility')
  || '|' || (select public._platform_managed_permissions()::text),
  'admin,manager|{orders:manage_catalog_visibility}',
  'S6: the key is seeded for admin and manager only (the owner holds every key), and it is the one platform-managed key');
select is(
  (select count(*)::int from public.inventory_items where id::text like '04130000-%' and not order_catalog_visible),
  0,
  'S7: every record starts shown (the column default): nothing is hidden by the push');
select is(
  (select prosecdef::text || ':' || coalesce((select c from unnest(proconfig) c where c like 'search_path=%'), '-')
     from pg_proc where oid = 'public.duplicate_inventory_item(uuid, jsonb)'::regprocedure)
  || '|' || (select prosecdef::text || ':' || has_function_privilege('authenticated', oid, 'execute')::text
                    || ':' || has_function_privilege('service_role', oid, 'execute')::text
               from pg_proc where oid = 'public.public_link_eligible_items(uuid, uuid)'::regprocedure)
  || '|' || (select has_function_privilege('authenticated', oid, 'execute')::text
               from pg_proc where oid = 'public.return_exchange_candidates(uuid, uuid, text, integer)'::regprocedure)
  || '|' || (select has_function_privilege('authenticated', oid, 'execute')::text
               from pg_proc where oid = 'public._return_exchange_item_ok(uuid, uuid, text, uuid)'::regprocedure)
  || '|' || (select prosecdef::text || ':' || has_function_privilege('anon', oid, 'execute')::text
               from pg_proc where oid = 'public.get_request_context()'::regprocedure),
  'false:search_path=public|true:false:true|true|false|false:false',
  'S8: the re-bodied functions keep their posture (duplicate INVOKER pinned to public; public links service-role only; candidates to authenticated; the item check no API EXECUTE; the request context INVOKER, no anon)');

select is(
  (select string_agg(m[1], ',' order by m[1])
     from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') as m
    where c.conrelid = 'public.platform_admin_audit'::regclass and c.conname = 'platform_admin_audit_action_check'),
  'acted_as_end,acted_as_start,billing_changed,deletion_passphrase_set,org_deleted,org_provisioned,password_reset_sent,'
  'permission_exception_changed,ticket_updated,user_disabled,user_reenabled,viewed_org',
  'S9: the re-added platform audit CHECK accepts every value it accepted before (the eleven through 0308) plus permission_exception_changed, and nothing else');

-- ═══ P. Who holds the capability by default ═══════════════════════════════
select is(
  pg_temp.can(:own) || ',' || pg_temp.can(:adm) || ',' || pg_temp.can(:mgr) || ',' || pg_temp.can(:stf) || ','
  || pg_temp.can(:vwr) || ',' || pg_temp.can(:nobody) || ',' || pg_temp.can(:dis) || ',' || pg_temp.can(:mgrB),
  'true,true,true,false,false,false,false,false',
  'P1: owner, admin and manager hold it; staff, viewer, a non-member, a disabled manager and another org''s manager do not');
select is(
  pg_temp.run('anon', null, format('select public.can_manage_order_catalog(%L)::text', :orgA)),
  'ERR:42501::',
  'P2: anon cannot call the capability check');

-- ═══ SC. Read-scope parity (before anything is hidden: visible=true is a
-- no-op that still runs the scope query) ═══════════════════════════════════
select is(pg_temp.exc(:orgA, :stfA, 'allow', 'default')::jsonb ->> 'after', 'allow', 'SC0a: StockPilot allows the staff member stfA');
select is(pg_temp.exc(:orgA, :vwrA, 'allow', 'default')::jsonb ->> 'after', 'allow', 'SC0b: StockPilot allows the scoped viewer vwrA');
create temp table _sc (persona text, item uuid, write_ok boolean, can_read boolean, rls_read boolean, eligible boolean) on commit drop;
grant all on _sc to authenticated;
do $$
declare
  p record; it uuid; v text; v_can text; v_rls text;
begin
  for p in select * from (values ('mgr', '04130000-0000-0000-0000-0000000000a2'::uuid),
                                 ('stfA', '04130000-0000-0000-0000-0000000000a5'::uuid),
                                 ('vwrA', '04130000-0000-0000-0000-0000000000a7'::uuid)) x(name, sub) loop
    foreach it in array array['04130000-0000-0000-0000-000000000105', '04130000-0000-0000-0000-000000000106',
                              '04130000-0000-0000-0000-000000000107', '04130000-0000-0000-0000-000000000108',
                              '04130000-0000-0000-0000-000000000109', '04130000-0000-0000-0000-00000000010a',
                              '04130000-0000-0000-0000-00000000010b', '04130000-0000-0000-0000-00000000010c',
                              '04130000-0000-0000-0000-00000000010d', '04130000-0000-0000-0000-00000000010e']::uuid[] loop
      v := pg_temp.vis(p.sub, array[it], true, '04139000-0000-4000-8000-0000000000ff');
      v_can := pg_temp.run('authenticated', p.sub, format('select public.caller_can_read_item(%L)::text', it));
      v_rls := pg_temp.run('authenticated', p.sub, format('select (count(*) = 1)::text from public.inventory_items where id = %L', it));
      insert into _sc values (p.name, it, v not like 'ERR:%', v_can = 'true', v_rls = 'true',
        (select ii.deleted_at is null and not ii.is_rental and not coalesce(ii.is_bundle, false)
           from public.inventory_items ii where ii.id = it));
    end loop;
  end loop;
end $$;
select is(
  (select count(*)::int from _sc where write_ok is distinct from (can_read and rls_read and eligible and item::text <> '04130000-0000-0000-0000-00000000010e')
                                     or can_read is distinct from rls_read),
  0,
  'SC1: for every persona and record, the write accepts exactly what caller_can_read_item and the inventory_items policy let the caller read (and is not deleted, a rental or a kit; never another org''s)');
select is(
  (select string_agg(persona || '=' || (select string_agg(right(s2.item::text, 3), ' ' order by s2.item) from _sc s2
                                         where s2.persona = s.persona and s2.write_ok), ',' order by persona)
     from (select distinct persona from _sc) s),
  'mgr=105 106 107 108 10c 10d,stfA=105 106 108 10c 10d,vwrA=105 108 10c 10d',
  'SC2: the manager reaches both warehouses; the delegated staff member only their own warehouse (not the annex); the scoped viewer only records of their category in their warehouse (not the Tech record, not the annex)');

-- ═══ W. set_order_catalog_visibility ══════════════════════════════════════
create temp table _before on commit drop as
  select (select pg_temp.item_rest(:iXS)) as xs, (select pg_temp.item_rest(:iS)) as s, (select pg_temp.item_rest(:iM)) as m,
         (select count(*) from public.stock_movements where item_id in (:iXS, :iS, :iM)) as moves,
         (select count(*) from public.audit_logs where organization_id = :orgA and event = 'item.order_visibility_changed') as audits,
         (select coalesce(sum(quantity_requested), 0) from public.order_request_lines where item_id in (:iXS, :iS, :iM)) as demand,
         (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), '')) from public.item_stock_levels l where l.item_id in (:iXS, :iS, :iM)) as levels;
select is(
  pg_temp.vis(:mgr, array[:iXS]::uuid[], false, :op1)::jsonb - 'organizationId',
  jsonb_build_object('operationId', :op1, 'visible', false, 'changed', jsonb_build_array(:iXS), 'unchanged', '[]'::jsonb,
                     'warehouseIds', jsonb_build_array(:whA)),
  'W1: a manager hides the XS shirt: the answer names it changed, and the warehouse whose ordering catalog to refresh');
select is(
  pg_temp.vis_of(:iXS) || ',' || pg_temp.vis_of(:iS) || ',' || pg_temp.vis_of(:iM)
  || '|' || ((select order_catalog_visibility_changed_at from public.inventory_items where id = :iXS) is not null)::text
  || '|' || (select updated_at = '2020-01-01T00:00:00Z' from public.inventory_items where id = :iXS)::text
  || '|' || (pg_temp.item_rest(:iXS) = (select xs from _before) and pg_temp.item_rest(:iS) = (select s from _before)
             and pg_temp.item_rest(:iM) = (select m from _before))::text,
  'false,true,true|true|true|true',
  'W2: only XS is hidden (S and M stay shown), it is stamped, updated_at did not move, and no other column of the three records changed (SKU, group, size, stock, charter, status)');
select is(
  ((select count(*) from public.stock_movements where item_id in (:iXS, :iS, :iM)) = (select moves from _before))::text
  || ',' || ((select coalesce(sum(quantity_requested), 0) from public.order_request_lines where item_id in (:iXS, :iS, :iM)) = (select demand from _before))::text
  || ',' || ((select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), '')) from public.item_stock_levels l where l.item_id in (:iXS, :iS, :iM)) = (select levels from _before))::text
  || ',' || (select count(*) from public.order_request_lines where id = :lDone and quantity_requested = 1 and quantity_fulfilled = 1)::text,
  'true,true,true,1',
  'W3: hiding wrote no stock movement, no holding, no demand change, and the order placed before it is untouched');
select is(
  (select count(*)::text from public.audit_logs where organization_id = :orgA and event = 'item.order_visibility_changed')
  || '|' || (select user_id::text || '|' || (metadata - 'entity_id' - 'operation_id')::text || '|' || (metadata->>'entity_id') || '|' || (metadata->>'operation_id')
               from public.audit_logs where organization_id = :orgA and event = 'item.order_visibility_changed'),
  ((select audits from _before) + 1)::text || '|' || :mgr || '|'
  || '{"after": {"order_catalog_visible": false}, "before": {"order_catalog_visible": true}, "reason": null, "surface": "web", "entity_type": "inventory_item", "warehouse_id": "' || :whA || '", "operation_size": 1, "acting_as_platform": false}|'
  || :iXS || '|' || :op1,
  'W4: one audit row in the same transaction: the actual actor, the record, its warehouse, before and after, the operation id and size, the surface, not acting as platform');
select is(
  pg_temp.vis(:mgr, array[:iXS]::uuid[], false, :op1)::jsonb - 'organizationId' - 'operationId' - 'visible'
  || jsonb_build_object('audits', pg_temp.q(format('select count(*)::text from public.audit_logs where organization_id = %L and event = ''item.order_visibility_changed''', :orgA))::int),
  jsonb_build_object('changed', '[]'::jsonb, 'unchanged', jsonb_build_array(:iXS), 'warehouseIds', jsonb_build_array(:whA),
                     'audits', (select audits from _before) + 1),
  'W5: a retry (same operation) changes nothing and writes no second audit row; it still names the warehouse, so a retry repairs a failed refresh');
select is(
  ((select order_catalog_last_hide_at from public.organizations where id = :orgA)
     >= (select order_catalog_visibility_changed_at from public.inventory_items where id = :iXS))::text
  || '|' || (select order_catalog_last_hide_at is null from public.organizations where id = :orgB)::text,
  'true|true',
  'W6: the hide stamped the organization''s mark, never earlier than the item stamp; another organization''s mark is untouched');
create temp table _mark on commit drop as select order_catalog_last_hide_at as at from public.organizations where id = :orgA;
select is(
  (pg_temp.vis(:mgr, array[:iM, :iM]::uuid[], false, :op2)::jsonb -> 'changed')::text
  || '|' || (pg_temp.vis(:mgr, array[:iM]::uuid[], true, :op3)::jsonb -> 'changed')::text
  || '|' || pg_temp.q(format('select (order_catalog_last_hide_at >= %L::timestamptz)::text from public.organizations where id = %L', (select at from _mark), :orgA))
  || '|' || pg_temp.vis_of(:iM),
  '["' || :iM || '"]|["' || :iM || '"]|true|true',
  'W7: duplicate ids collapse to one change; Show writes the record back to shown (and a show never moves the mark backwards)');
create temp table _mark2 on commit drop as select order_catalog_last_hide_at as at from public.organizations where id = :orgA;
select is(
  pg_temp.vis(:mgr, array[:iM]::uuid[], true, :op3) || '|'
  || pg_temp.q(format('select (order_catalog_last_hide_at = %L::timestamptz)::text from public.organizations where id = %L', (select at from _mark2), :orgA)),
  '{"changed": [], "visible": true, "unchanged": ["' || :iM || '"], "operationId": "' || :op3 || '", "warehouseIds": ["' || :whA || '"], "organizationId": "' || :orgA || '"}|true',
  'W8: a show that changes nothing leaves the mark as it was');
select is(
  pg_temp.vis(:stf, array[:iOk]::uuid[], false, :op1) || ' ' || pg_temp.vis(:vwr, array[:iOk]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:nobody, array[:iOk]::uuid[], false, :op1) || ' ' || pg_temp.vis(:dis, array[:iOk]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:mgrB, array[:iOk]::uuid[], false, :op1) || ' '
  || pg_temp.run('authenticated', null, format('select public.set_order_catalog_visibility(%L, array[%L]::uuid[], false, %L, ''web'')::text', :orgA, :iOk, :op1)) || ' '
  || pg_temp.run('anon', null, format('select public.set_order_catalog_visibility(%L, array[%L]::uuid[], false, %L, ''web'')::text', :orgA, :iOk, :op1)) || '|'
  || pg_temp.vis_of(:iOk),
  'ERR:42501:order_catalog_forbidden: ERR:42501:order_catalog_forbidden: ERR:42501:order_catalog_forbidden: '
  'ERR:42501:order_catalog_forbidden: ERR:42501:order_catalog_forbidden: ERR:42501:unauthenticated: ERR:42501::|true',
  'W9: staff, a viewer, a non-member, a disabled manager, another org''s manager, a signed-out call and anon (no EXECUTE) are refused; nothing changed');
select is(
  pg_temp.vis(:mgr, array[:iOk, :iB]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:stfA, array[:iOk, :iFar]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:mgr, array[:iDel, :iRent, :iKit, :iOk]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:mgr, array['04130000-0000-0000-0000-0000000009ff', :iOk]::uuid[], false, :op1) || '|'
  || pg_temp.vis_of(:iOk) || '|'
  || pg_temp.q(format('select count(*)::text from public.audit_logs where organization_id = %L and event = ''item.order_visibility_changed'' and metadata->>''entity_id'' = %L', :orgA, :iOk)),
  'ERR:P0002:order_catalog_items_unavailable:["' || :iB || '"] '
  'ERR:P0002:order_catalog_items_unavailable:["' || :iFar || '"] '
  'ERR:P0002:order_catalog_items_unavailable:["' || :iDel || '", "' || :iRent || '", "' || :iKit || '"] '
  'ERR:P0002:order_catalog_items_unavailable:["04130000-0000-0000-0000-0000000009ff"]|true|0',
  'W10: another org''s id, a record outside a delegated member''s warehouse, a deleted record, a rental, a kit and an unknown id each refuse the WHOLE call, naming only ids the caller sent; nothing applied, nothing audited');
select is(
  pg_temp.vis(:mgr, array[]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:mgr, array[null]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:mgr, array(select gen_random_uuid() from generate_series(1, 501)), false, :op1) || ' '
  || pg_temp.vis(:mgr, array[:iOk]::uuid[], null, :op1) || ' '
  || pg_temp.vis(:mgr, array[:iOk]::uuid[], false, null) || ' '
  || pg_temp.run('authenticated', :mgr, format('select public.set_order_catalog_visibility(%L, array[%L]::uuid[], false, %L, ''email'')::text', :orgA, :iOk, :op1)),
  'ERR:22023:order_catalog_invalid:itemIds ERR:22023:order_catalog_invalid:itemIds ERR:22023:order_catalog_invalid:itemIds '
  'ERR:22023:order_catalog_invalid:visible ERR:22023:order_catalog_invalid:operationId ERR:22023:order_catalog_invalid:surface',
  'W11: no ids, only nulls, more than 500 ids, no target state, no operation id, an unknown surface');
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
select is(
  pg_temp.vis(:mgr, array[:iOk]::uuid[], false, :op1),
  'ERR:42501:module_disabled:',
  'W12: with the Orders module off nobody can change ordering visibility');
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';
-- Partial-failure injection: a probe that raises on the third changed row.
create function public._zz0413_probe_third() returns trigger language plpgsql set search_path = public as $$
begin
  if new.id = '04130000-0000-0000-0000-000000000106' and new.order_catalog_visible is false then
    raise exception 'probe: third row fails' using errcode = 'XX000';
  end if;
  return new;
end $$;
create trigger trg_zz_0413_probe_third after update on public.inventory_items
  for each row execute function public._zz0413_probe_third();
select is(
  pg_temp.vis(:mgr, array[:iOk, :iBook, :iOk2]::uuid[], false, :op2) || '|'
  || pg_temp.vis_of(:iOk) || pg_temp.vis_of(:iBook) || pg_temp.vis_of(:iOk2) || '|'
  || pg_temp.q(format('select count(*)::text from public.audit_logs where organization_id = %L and event = ''item.order_visibility_changed'' and metadata->>''operation_id'' = %L and metadata->>''entity_id'' <> %L', :orgA, :op2, :iM)),
  'ERR:XX000::|truetruetrue|0',
  'W13: a failure on the third row leaves all three shown and no audit row (one transaction, never "all updated" after a partial failure)');
drop trigger trg_zz_0413_probe_third on public.inventory_items;
drop function public._zz0413_probe_third();

-- ═══ MF. MFA parity with the app's resolveMfaState ════════════════════════
create temp table _mfa (policy text, role text, enrolled boolean, aal text, expected text) on commit drop;
insert into _mfa values
  ('optional', 'owner', false, 'aal1', 'ok'),
  ('optional', 'owner', false, 'aal2', 'ok'),
  ('optional', 'owner', true, 'aal1', 'aal2_required'),
  ('optional', 'owner', true, 'aal2', 'ok'),
  ('optional', 'admin', false, 'aal1', 'ok'),
  ('optional', 'admin', false, 'aal2', 'ok'),
  ('optional', 'admin', true, 'aal1', 'aal2_required'),
  ('optional', 'admin', true, 'aal2', 'ok'),
  ('optional', 'manager', false, 'aal1', 'ok'),
  ('optional', 'manager', false, 'aal2', 'ok'),
  ('optional', 'manager', true, 'aal1', 'aal2_required'),
  ('optional', 'manager', true, 'aal2', 'ok'),
  ('optional', 'staff', false, 'aal1', 'ok'),
  ('optional', 'staff', false, 'aal2', 'ok'),
  ('optional', 'staff', true, 'aal1', 'aal2_required'),
  ('optional', 'staff', true, 'aal2', 'ok'),
  ('admins_required', 'owner', false, 'aal1', 'mfa_required'),
  ('admins_required', 'owner', false, 'aal2', 'mfa_required'),
  ('admins_required', 'owner', true, 'aal1', 'aal2_required'),
  ('admins_required', 'owner', true, 'aal2', 'ok'),
  ('admins_required', 'admin', false, 'aal1', 'mfa_required'),
  ('admins_required', 'admin', false, 'aal2', 'mfa_required'),
  ('admins_required', 'admin', true, 'aal1', 'aal2_required'),
  ('admins_required', 'admin', true, 'aal2', 'ok'),
  ('admins_required', 'manager', false, 'aal1', 'ok'),
  ('admins_required', 'manager', false, 'aal2', 'ok'),
  ('admins_required', 'manager', true, 'aal1', 'aal2_required'),
  ('admins_required', 'manager', true, 'aal2', 'ok'),
  ('admins_required', 'staff', false, 'aal1', 'ok'),
  ('admins_required', 'staff', false, 'aal2', 'ok'),
  ('admins_required', 'staff', true, 'aal1', 'aal2_required'),
  ('admins_required', 'staff', true, 'aal2', 'ok'),
  ('all_required', 'owner', false, 'aal1', 'mfa_required'),
  ('all_required', 'owner', false, 'aal2', 'mfa_required'),
  ('all_required', 'owner', true, 'aal1', 'aal2_required'),
  ('all_required', 'owner', true, 'aal2', 'ok'),
  ('all_required', 'admin', false, 'aal1', 'mfa_required'),
  ('all_required', 'admin', false, 'aal2', 'mfa_required'),
  ('all_required', 'admin', true, 'aal1', 'aal2_required'),
  ('all_required', 'admin', true, 'aal2', 'ok'),
  ('all_required', 'manager', false, 'aal1', 'mfa_required'),
  ('all_required', 'manager', false, 'aal2', 'mfa_required'),
  ('all_required', 'manager', true, 'aal1', 'aal2_required'),
  ('all_required', 'manager', true, 'aal2', 'ok'),
  ('all_required', 'staff', false, 'aal1', 'mfa_required'),
  ('all_required', 'staff', false, 'aal2', 'mfa_required'),
  ('all_required', 'staff', true, 'aal1', 'aal2_required'),
  ('all_required', 'staff', true, 'aal2', 'ok');
-- The allowed staff member of org M (StockPilot's exception, written as the
-- superuser for this section).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:orgM, :mStf, 'orders:manage_catalog_visibility', true);
create temp table _mfa_got (policy text, role text, enrolled boolean, aal text, got text) on commit drop;
do $$
declare
  c record; v_sub uuid; v text;
begin
  for c in select * from _mfa loop
    v_sub := case c.role when 'owner' then '04130000-0000-0000-0000-0000000000e0'::uuid
                         when 'admin' then '04130000-0000-0000-0000-0000000000e1'::uuid
                         when 'manager' then '04130000-0000-0000-0000-0000000000e2'::uuid
                         else '04130000-0000-0000-0000-0000000000e3'::uuid end;
    update public.organizations set mfa_policy = c.policy where id = '04130000-0000-0000-0000-00000000000d';
    delete from auth.mfa_factors where user_id = v_sub;
    if c.enrolled then
      insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), v_sub, '0413 authenticator', 'totp', 'verified', now(), now());
    end if;
    v := pg_temp.vis(v_sub, array['04130000-0000-0000-0000-000000000114']::uuid[], true,
                     '04139000-0000-4000-8000-0000000000fe', '04130000-0000-0000-0000-00000000000d', c.aal);
    insert into _mfa_got values (c.policy, c.role, c.enrolled, c.aal,
      case when v like 'ERR:%' then split_part(v, ':', 3) else 'ok' end);
  end loop;
  delete from auth.mfa_factors where user_id in ('04130000-0000-0000-0000-0000000000e0', '04130000-0000-0000-0000-0000000000e1',
                                                 '04130000-0000-0000-0000-0000000000e2', '04130000-0000-0000-0000-0000000000e3');
end $$;
select is(
  (select coalesce(string_agg(format('%s/%s/%s/%s want %s got %s', m.policy, m.role, m.enrolled, m.aal, m.expected, g.got), '; '), '')
     from _mfa m join _mfa_got g using (policy, role, enrolled, aal)
    where g.got is distinct from m.expected),
  '',
  'MF1: for all 48 combinations of policy, role, enrolment and aal the database refuses exactly where the app''s rule does (mfa_required without a verified factor, aal2_required with one at aal1)');
select is(
  (select count(*)::int from _mfa_got),
  48,
  'MF2: the parity table ran every case');
-- ═══ G. Direct writes of the columns ══════════════════════════════════════
select is(
  pg_temp.run('authenticated', :stf, format('update public.inventory_items set order_catalog_visible = false where id = %L', :iOk)) || ' '
  || pg_temp.run('authenticated', :mgr, format('update public.inventory_items set order_catalog_visible = false where id = %L', :iOk)) || ' '
  || pg_temp.run('authenticated', :mgr, format('update public.inventory_items set order_catalog_visibility_changed_at = now() where id = %L', :iOk)) || ' '
  || pg_temp.run('service_role', null, format('update public.inventory_items set order_catalog_visible = false where id = %L', :iOk)) || ' '
  || pg_temp.run('service_role', null, format('update public.inventory_items set order_catalog_visible = true where id = %L', :iXS)) || '|'
  || pg_temp.vis_of(:iOk) || pg_temp.vis_of(:iXS),
  'ERR:42501:order_visibility_managed: ERR:42501:order_visibility_managed: ERR:42501:order_visibility_managed: '
  'ERR:42501:order_visibility_managed: ERR:42501:order_visibility_managed:|truefalse',
  'G1: staff with items:update, a manager (even one who holds the capability) and service_role cannot write either column directly, to hide or to show');
select is(
  pg_temp.run('authenticated', :mgr, format('update public.inventory_items set name = ''Fine item (renamed)'', order_catalog_visible = true where id = %L returning null', :iOk))
  || '|' || pg_temp.q(format('select name from public.inventory_items where id = %L', :iOk)),
  'null|Fine item (renamed)',
  'G2: an ordinary edit that carries the unchanged value (a full-row PATCH) still works');
select is(
  pg_temp.run('authenticated', :mgr, format(
    'insert into public.inventory_items (organization_id, warehouse_id, sku, name, order_catalog_visible, order_catalog_visibility_changed_at) '
    'values (%L, %L, ''X0413-INS-H'', ''Inserted hidden'', false, ''2001-01-01'') returning (order_catalog_visibility_changed_at > ''2020-01-01'')::text || '':'' || order_catalog_visible::text',
    :orgA, :whA)) || ' '
  || pg_temp.run('authenticated', :mgr, format(
    'insert into public.inventory_items (organization_id, warehouse_id, sku, name, order_catalog_visibility_changed_at) '
    'values (%L, %L, ''X0413-INS-S'', ''Inserted shown'', ''2001-01-01'') returning coalesce(order_catalog_visibility_changed_at::text, ''null'') || '':'' || order_catalog_visible::text',
    :orgA, :whA)),
  'true:false null:true',
  'G3: an INSERT may create a hidden record and the database stamps it; a shown insert carries no stamp, whatever was sent');

-- ═══ PE. Only StockPilot sets the exception ═══════════════════════════════
select is(
  pg_temp.run('authenticated', :adm, format('insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values (%L, %L, ''orders:manage_catalog_visibility'', true)', :orgA, :stf)) || ' '
  || pg_temp.run('authenticated', :own, format('insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values (%L, %L, ''orders:manage_catalog_visibility'', false)', :orgA, :mgr)) || ' '
  || pg_temp.run('authenticated', :own, format('update public.user_permission_overrides set granted = false where organization_id = %L and user_id = %L and permission = ''orders:manage_catalog_visibility''', :orgA, :stfA)) || ' '
  || pg_temp.run('authenticated', :adm, format('delete from public.user_permission_overrides where organization_id = %L and user_id = %L and permission = ''orders:manage_catalog_visibility''', :orgA, :stfA)) || ' '
  || pg_temp.run('authenticated', :adm, format('insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values (%L, %L, ''orders:manage_catalog_visibility'', false) on conflict (organization_id, user_id, permission) do update set granted = excluded.granted', :orgA, :stfA)) || ' '
  || pg_temp.run('authenticated', :adm, format('update public.user_permission_overrides set permission = ''orders:manage_catalog_visibility'' where organization_id = %L and user_id = %L and permission = ''items:export'' returning permission', :orgA, :stf)) || ' '
  || pg_temp.run('authenticated', :own, format('insert into public.role_permission_overrides (organization_id, role, permission, granted) values (%L, ''staff'', ''orders:manage_catalog_visibility'', true)', :orgA)) || ' '
  || pg_temp.run('authenticated', :own, format('insert into public.role_permission_overrides (organization_id, role, permission, granted) values (%L, ''manager'', ''orders:manage_catalog_visibility'', false)', :orgA)),
  'ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed: '
  'ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed: null '
  'ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed:',
  'PE1: an admin or owner cannot insert, update, upsert or delete the key''s user rows (a protected exception included), nor write a role row for it (an update renaming nothing matched no row)');
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values (:orgA, :stf, 'items:export', true);
select is(
  pg_temp.run('authenticated', :adm, format('update public.user_permission_overrides set permission = ''orders:manage_catalog_visibility'' where organization_id = %L and user_id = %L and permission = ''items:export''', :orgA, :stf)) || ' '
  || pg_temp.run('authenticated', :adm, format('update public.user_permission_overrides set granted = false where organization_id = %L and user_id = %L and permission = ''items:export'' returning granted::text', :orgA, :stf)) || ' '
  || pg_temp.run('service_role', null, format('insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values (%L, %L, ''orders:manage_catalog_visibility'', true)', :orgA, :stf)) || ' '
  || pg_temp.run('service_role', null, format('delete from public.user_permission_overrides where organization_id = %L and user_id = %L and permission = ''orders:manage_catalog_visibility''', :orgA, :stfA)) || ' '
  || pg_temp.run('service_role', null, 'insert into public.role_default_permissions (role, permission) values (''staff'', ''orders:manage_catalog_visibility'')') || ' '
  || pg_temp.run('service_role', null, 'delete from public.role_default_permissions where role = ''manager'' and permission = ''orders:manage_catalog_visibility''') || ' '
  || pg_temp.run('service_role', null, 'update public.role_default_permissions set role = ''viewer'' where role = ''admin'' and permission = ''orders:manage_catalog_visibility''') || ' '
  || pg_temp.run('authenticated', :own, 'insert into public.role_default_permissions (role, permission) values (''viewer'', ''orders:manage_catalog_visibility'')'),
  'ERR:42501:permission_platform_managed: false ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed: '
  'ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed: ERR:42501:permission_platform_managed:',
  'PE2: renaming another key''s row into the key is refused while other keys stay editable; every service_role write of the key (user rows and the global defaults) is refused; so is an owner''s default row (the guard fires before the table''s own policies)');
select is(
  pg_temp.can(:stfA) || ',' || pg_temp.can(:vwrA)
  || '|' || pg_temp.run('authenticated', :stfA, format('select public.has_permission(%L, ''orders:approve'')::text || '','' || public.has_permission(%L, ''returns:manage'')::text || '','' || public.has_permission(%L, ''items:delete'')::text', :orgA, :orgA, :orgA))
  || '|' || (select role from public.organization_members where organization_id = :orgA and user_id = :stfA)
  || '|' || (pg_temp.vis(:stfA, array[:iOk2]::uuid[], false, :op1)::jsonb ->> 'changed'),
  'true,true|false,false,false|staff|["' || :iOk2 || '"]',
  'PE3: the allowed staff member and viewer hold the capability and nothing else (no approval, no returns, no delete), stay staff, and can hide a record in their scope');
select is(
  pg_temp.exc(:orgA, :stfA, 'deny', 'default') || ' ' || pg_temp.exc(:orgA, :stfA, 'default', 'deny') || '|' || pg_temp.can(:stfA),
  'ERR:P0001:permission_exception_changed:allow ERR:P0001:permission_exception_changed:allow|true',
  'PE4: compare-and-set: a console row that saw another state is a conflict naming the current state, and nothing changes');
select is(
  pg_temp.exc(:orgA, :mgrD, 'deny', 'default')::jsonb || '{}'::jsonb,
  '{"after": "deny", "before": "default", "changed": true, "targetRole": "manager"}'::jsonb,
  'PE5: StockPilot denies a manager');
select is(
  pg_temp.can(:mgrD) || ' ' || pg_temp.vis(:mgrD, array[:iOk]::uuid[], false, :op1) || ' '
  || pg_temp.vis(:mgrD, array[:iOk, :iOk2, :iBook]::uuid[], true, :op1),
  'false ERR:42501:order_catalog_forbidden: ERR:42501:order_catalog_forbidden:',
  'PE6: the denied manager''s next single and bulk calls are refused');
-- Role changes by an admin, straight through the API (the direct UPDATE path).
select is(
  pg_temp.run('authenticated', :adm, format('update public.organization_members set role = ''admin'' where organization_id = %L and user_id = %L returning role', :orgA, :mgrD))
  || ' ' || pg_temp.can(:mgrD)
  || ' ' || pg_temp.run('authenticated', :adm, format('update public.organization_members set role = ''staff'' where organization_id = %L and user_id = %L returning role', :orgA, :mgrD))
  || ' ' || pg_temp.run('authenticated', :adm, format('update public.organization_members set role = ''manager'' where organization_id = %L and user_id = %L returning role', :orgA, :mgrD))
  || ' ' || pg_temp.can(:mgrD)
  || ' ' || (select granted::text from public.user_permission_overrides where organization_id = :orgA and user_id = :mgrD and permission = 'orders:manage_catalog_visibility'),
  'admin false staff manager false false',
  'PE7: the deny survives promotion to admin and a demote-and-restore by an admin: only StockPilot changes it');
select is(
  (pg_temp.exc(:orgA, :mgrD, 'default', 'deny')::jsonb ->> 'after') || ' ' || pg_temp.can(:mgrD)
  || ' ' || pg_temp.q(format('select count(*)::text from public.user_permission_overrides where organization_id = %L and user_id = %L and permission = ''orders:manage_catalog_visibility''', :orgA, :mgrD)),
  'default true 0',
  'PE8: reset removes the row and returns the manager to the role default');
select is(
  (pg_temp.exc(:orgA, :own, 'deny', 'default')::jsonb ->> 'targetRole') || ' ' || pg_temp.can(:own)
  || ' ' || pg_temp.vis(:own, array[:iOk]::uuid[], false, :op1)
  || ' ' || pg_temp.run('authenticated', :own, format('select public.has_permission(%L, ''orders:manage_catalog_visibility'')::text', :orgA))
  || ' ' || (pg_temp.exc(:orgA, :own, 'default', 'deny')::jsonb ->> 'after') || ' ' || pg_temp.can(:own),
  'owner false ERR:42501:order_catalog_forbidden: true default true',
  'PE9: an explicit deny holds for the owner too (has_permission''s owner short-circuit is not enough), and reset restores it');
select is(
  pg_temp.exc(:orgA, :stfA, 'allow', 'allow')::jsonb || '{}'::jsonb,
  '{"after": "allow", "before": "allow", "changed": false, "targetRole": "staff"}'::jsonb,
  'PE10: setting the current state again writes nothing');
select is(
  (select count(*)::text from public.platform_admin_audit where target_organization_id = :orgA and action = 'permission_exception_changed')
  || '|' || (select detail::text from public.platform_admin_audit where target_organization_id = :orgA and target_user_id = :mgrD
               and action = 'permission_exception_changed' and detail->>'after' = 'deny')
  || '|' || (select actor_user_id::text || ',' || actor_email from public.platform_admin_audit where target_user_id = :mgrD and detail->>'after' = 'deny')
  || '|' || (select (metadata - 'entity_id')::text || ',' || user_id::text from public.audit_logs
               where organization_id = :orgA and event = 'permissions.platform_exception_changed'
                 and metadata->>'entity_id' = :mgrD and metadata->>'after' = 'deny'),
  '6|{"after": "deny", "before": "default", "permission": "orders:manage_catalog_visibility", "target_role": "manager"}'
  || '|' || :plat || ',0413-plat@ordvis.test'
  || '|{"after": "deny", "before": "default", "permission": "orders:manage_catalog_visibility", "entity_type": "user", "target_role": "manager", "platform_admin_email": "0413-plat@ordvis.test"},' || :plat,
  'PE11: each change is audited twice (platform audit and the org''s own log), with the actor, the actor''s own sign-in email (never the email the caller passed), the target, before and after; the no-op wrote neither');
select is(
  pg_temp.run('authenticated', :own, format('select public.platform_set_permission_exception(%L, %L, ''orders:manage_catalog_visibility'', ''allow'', ''default'', %L, ''x@example.org'')::text', :orgA, :stf, :own)) || ' '
  || pg_temp.exc(:orgA, :nobody, 'allow', 'default') || ' '
  || pg_temp.exc(:orgA, :stf, 'allow', 'default', 'items:update') || ' '
  || pg_temp.exc(:orgA, :stf, 'maybe', 'default'),
  'ERR:42501:: ERR:P0002:member_not_found: ERR:22023:permission_not_platform_managed: ERR:22023:permission_exception_invalid:state',
  'PE12: an owner (authenticated) cannot call the platform function; a non-member target, an ordinary key and an unknown state are refused');
select is(
  (pg_temp.exc(:orgC, :ownC, 'deny', 'default')::jsonb ->> 'after')
  || ' ' || pg_temp.run('service_role', null, format('delete from public.organizations where id = %L returning ''deleted''', :orgC))
  || ' ' || pg_temp.q(format('select count(*)::text from public.user_permission_overrides where organization_id = %L', :orgC)),
  'deny deleted 0',
  'PE13: deleting an organization (service role) cascades its exception rows past the guard');
select is(
  pg_temp.run('authenticated', :stfA, $q$select (m->'user_overrides')::text || '|' || (m->'organization' ? 'order_catalog_last_hide_at')::text || '|' || ((m->'organization'->>'order_catalog_last_hide_at') is not null)::text
                                         from jsonb_array_elements(public.get_request_context()->'memberships') m
                                        where m->>'organization_id' = '04130000-0000-0000-0000-00000000000a'$q$),
  '[{"granted": true, "permission": "orders:manage_catalog_visibility"}]|true|true',
  'PE14: the request context carries the member''s exception row and the organization''s hide mark');

-- ═══ O. The new-demand gate ═══════════════════════════════════════════════
-- XS is hidden (W1). The requester stf may order (orders:request).
select is(
  pg_temp.run('authenticated', :stf, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oPend, :iXS)) || ' '
  || pg_temp.run('authenticated', :stf, format('select (public.create_order_request(jsonb_build_object(''organization_id'', %L, ''warehouse_id'', %L, ''requester_user_id'', %L, ''fulfillment_type'', ''pickup''), jsonb_build_array(jsonb_build_object(''item_id'', %L, ''quantity'', 1)))).id::text', :orgA, :whA, :stf, :iXS)) || ' '
  || pg_temp.run('service_role', null, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oPend, :iXS)),
  'ERR:P0001:order_item_hidden:' || :iXS || ' ERR:P0001:order_item_hidden:' || :iXS || ' ERR:P0001:order_item_hidden:' || :iXS,
  'O1: a hidden item is refused as a new line by a direct insert, by the legacy create_order_request RPC and by the service role (public links, portal)');
select is(
  pg_temp.run('authenticated', :stf, format('select public.place_order_request(%L::jsonb, %L)::text', pg_temp.req(:stf, :iXS), '04139100-0000-4000-8000-000000000001'))::jsonb #>> '{refusal}'
  || '|' || (pg_temp.run('authenticated', :stf, format('select public.place_order_request(%L::jsonb, %L)::text', pg_temp.req(:stf, :iXS), '04139100-0000-4000-8000-000000000001'))::jsonb ->> 'replay')
  || '|' || pg_temp.q(format('select count(*)::text from public.order_requests r join public.order_request_lines l on l.order_request_id = r.id where r.organization_id = %L and l.item_id = %L and r.id <> %L', :orgA, :iXS, :oDone)),
  '{"detail": {"' || :iXS || '": "hidden_from_orders"}, "reason": "item_not_orderable"}|true|0',
  'O2: place_order_request records item_not_orderable with the reason hidden_from_orders (the top-level reason old clients know), replays it, and creates no order');
select is(
  pg_temp.run('authenticated', :stf, format('select public.place_order_request(%L::jsonb, %L)::text',
    pg_temp.req(:stf, :iXS) || jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('item_id', :iXS, 'quantity', 1), jsonb_build_object('item_id', :iDel, 'quantity', 1))),
    '04139100-0000-4000-8000-000000000002'))::jsonb #>> '{refusal,detail}',
  '{"' || :iXS || '": "hidden_from_orders", "' || :iDel || '": "deleted"}',
  'O3: hidden is reported beside the existing reasons');
select is(
  pg_temp.run('service_role', null, format('update public.order_request_lines set quantity_requested = 3 where id = %L', :lDone)) || ' '
  || pg_temp.run('service_role', null, format('update public.order_request_lines set quantity_requested = 1, notes = ''same'' where id = %L returning quantity_requested::int::text', :lDone)) || ' '
  || pg_temp.run('service_role', null, format('update public.order_request_lines set quantity_picked = 1, returned_quantity = 0 where id = %L returning quantity_picked::int::text', :lDone)) || ' '
  || pg_temp.run('service_role', null, format('update public.order_request_lines set item_id = %L where id = %L', :iXS, :lPend)),
  'ERR:P0001:order_item_hidden:' || :iXS || ' 1 1 ERR:P0001:order_item_hidden:' || :iXS,
  'O4: on an order placed before the hide, raising the hidden line or switching a line to the hidden item is refused; the same quantity, notes, picking and returns columns still write');
select is(
  pg_temp.run('service_role', null, format('update public.order_request_lines set quantity_requested = 2 where id = %L returning quantity_requested::int::text', :lDone)) || ' '
  || pg_temp.run('service_role', null, format('update public.order_request_lines set quantity_requested = 1 where id = %L returning quantity_requested::int::text', :lDone)) || ' '
  || pg_temp.run('service_role', null, format('update public.order_requests set notes = ''Leave at the desk'' where id = %L returning notes', :oPend)),
  'ERR:P0001:order_item_hidden:' || :iXS || ' 1 Leave at the desk',
  'O5: lowering is never checked (a raise is); a header note edit fires no line trigger');
-- Lowering a line of the hidden item, then removing it, on an open order.
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) select :oPend, :iM, 3;
select pg_temp.vis(:mgr, array[:iM]::uuid[], false, :op1) is not null as hid_m \gset
select is(
  pg_temp.run('service_role', null, format('update public.order_request_lines set quantity_requested = 1 where order_request_id = %L and item_id = %L returning quantity_requested::int::text', :oPend, :iM)) || ' '
  || pg_temp.run('service_role', null, format('delete from public.order_request_lines where order_request_id = %L and item_id = %L returning item_id::text', :oPend, :iM)),
  '1 ' || :iM,
  'O6: a hidden item''s existing line can be lowered and removed');
-- Leak check: an item the writer cannot see answers as any unreadable item.
select pg_temp.vis(:mgr, array[:iFarH]::uuid[], false, :op1) is not null as hid_far \gset
update public.inventory_items set order_catalog_visible = false where id = :iBH;
select is(
  pg_temp.run('authenticated', :stf, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oPend, :iBH)) || ' '
  || pg_temp.run('authenticated', :stf, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oFar, :iFarH)),
  'ERR:42501:: ERR:42501::',
  'O7: another organization''s hidden item and a hidden item outside the writer''s warehouses get the insert policy''s refusal, never the hidden hint (nothing about them leaks)');
select is(
  pg_temp.run_msg('authenticated', :stf, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oPend, :iBH)) || ' | '
  || pg_temp.run_msg('authenticated', :stf, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oFar, :iFarH)),
  'ERR:42501:This order line is not allowed. | ERR:42501:This order line is not allowed.',
  'O7b: the gate itself fails closed for those writes (integrator decision D1 item 5): it never hands a hidden item on to the insert policy, and its refusal names nothing');
-- A hide between place_order_request's step 8 and its insert (a probe in
-- the create's own transaction; the two-session script proves the real race).
create function public._zz0413_probe_hide() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.inventory_items set order_catalog_visible = false where id = '04130000-0000-0000-0000-000000000113';
  return new;
end $$;
create trigger trg_aa_0413_probe_hide after insert on public.order_requests
  for each row when (new.notes = 'probe-hide') execute function public._zz0413_probe_hide();
select is(
  pg_temp.run('authenticated', :stf, format('select public.place_order_request(%L::jsonb, %L)::text', pg_temp.req(:stf, :iPrb, 'probe-hide'), '04139100-0000-4000-8000-000000000003'))::jsonb #>> '{refusal,reason}'
  || '|' || pg_temp.q(format('select count(*)::text from public.order_requests where organization_id = %L and notes = ''probe-hide''', :orgA))
  || '|' || pg_temp.q('select outcome from public.order_submissions where key = ''04139100-0000-4000-8000-000000000003''')
  || '|' || pg_temp.vis_of(:iPrb),
  'item_not_orderable|0|refused|true',
  'O8: the gate''s refusal inside the create is caught and recorded as item_not_orderable; the header rolled back with it (the probe''s hide too)');
drop trigger trg_aa_0413_probe_hide on public.order_requests;
drop function public._zz0413_probe_hide();

-- ═══ A. Add items in one transaction ══════════════════════════════════════
select is(
  pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
    jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 2), jsonb_build_object('itemId', :iNew, 'quantity', 1),
                      jsonb_build_object('itemId', :iNew, 'quantity', 2))))::jsonb
  || jsonb_build_object('top', pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd))::int,
                        'new', pg_temp.q(format('select sum(quantity_requested)::int::text from public.order_request_lines where order_request_id = %L and item_id = %L', :oAdd, :iNew))::int),
  jsonb_build_object('orderId', :oAdd, 'added', jsonb_build_array(:iNew), 'merged', jsonb_build_array(:iTop), 'top', 3, 'new', 3),
  'A1: the requester adds one new item (two entries summed) and tops up an existing line, in one call');
select is(
  pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
    jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 5), jsonb_build_object('itemId', :iXS, 'quantity', 1))))
  || '|' || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd)),
  'ERR:P0001:order_item_hidden:' || :iXS || '|3',
  'A2: a hidden item is refused before anything is written: the top-up in the same call did not happen');
create function public._zz0413_probe_add() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.item_id = '04130000-0000-0000-0000-000000000112' then
    update public.inventory_items set order_catalog_visible = false where id = new.item_id;
  end if;
  return new;
end $$;
create trigger trg_aa_0413_probe_add before insert on public.order_request_lines
  for each row execute function public._zz0413_probe_add();
select is(
  pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
    jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 4), jsonb_build_object('itemId', :iRace, 'quantity', 1))))
  || '|' || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd))
  || '|' || pg_temp.q(format('select count(*)::text from public.order_request_lines where order_request_id = %L and item_id = %L', :oAdd, :iRace)),
  'ERR:P0001:order_item_hidden:' || :iRace || '|3|0',
  'A3: an item hidden after the checks but before its insert (the top-up already written) is refused by the gate and the whole call rolls back: zero rows changed');
drop trigger trg_aa_0413_probe_add on public.order_request_lines;
drop function public._zz0413_probe_add();
select is(
  pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oShip, '[{"itemId": "04130000-0000-0000-0000-000000000105", "quantity": 1}]')) || ' '
  || pg_temp.run('authenticated', :stfA, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd, '[{"itemId": "04130000-0000-0000-0000-000000000105", "quantity": 1}]')) || ' '
  || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd, '[{"itemId": "04130000-0000-0000-0000-000000000107", "quantity": 1}]')) || ' '
  || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd, '[{"itemId": "04130000-0000-0000-0000-00000000010c", "quantity": 1}]')) || ' '
  || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd, '[{"itemId": "04130000-0000-0000-0000-00000000010b", "quantity": 1}]')) || ' '
  || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd, '[{"itemId": "04130000-0000-0000-0000-000000000105", "quantity": 1.5}]')) || ' '
  || pg_temp.run('authenticated', :mgrB, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd, '[{"itemId": "04130000-0000-0000-0000-000000000105", "quantity": 1}]')),
  'ERR:P0001:order_closed:in_transit ERR:42501:order_edit_forbidden: '
  'ERR:P0001:order_item_not_addable:{"itemId": "04130000-0000-0000-0000-000000000107", "reason": "not_found"} '
  'ERR:P0001:order_item_not_addable:{"itemId": "04130000-0000-0000-0000-00000000010c", "reason": "awaiting_first_receipt"} '
  'ERR:P0001:order_item_not_addable:{"itemId": "04130000-0000-0000-0000-00000000010b", "reason": "kit"} '
  'ERR:22023:order_lines_invalid:quantity ERR:P0002:order_not_found:',
  'A4: Add items keeps the service''s rules: shipped orders, someone neither requester nor approver, an item the caller cannot read, an Expected item, a kit, a fractional quantity, another org''s member');
-- The helper runs only inside add_order_request_lines, which raises the
-- transaction-bound flag stockpilot.add_lines around its writes (R2 proves a
-- direct call is refused). Raised here the same way, so A5 and A6 exercise the
-- helper's own re-checks (defence in depth) as Add items reaches them.
select set_config('stockpilot.add_lines', pg_current_xact_id()::text, true) is not null as add_flag_up \gset
select is(
  pg_temp.run('authenticated', :stfA, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iTop)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oShip, :iOk)) || ' '
  || pg_temp.run('authenticated', :mgrB, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iTop)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 0)::text', :oAdd, :iTop)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iOk)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oFar, :iFarH)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iBH)) || ' '
  || pg_temp.run('authenticated', :mgr, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oDone, :iXS)) || ' '
  || pg_temp.run('authenticated', :mgr, format('select public._order_request_line_top_up(%L, %L, 2)::text', :oPend, :iS)) || '|'
  || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd)) || ','
  || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lPend)),
  'ERR:42501:order_edit_forbidden: ERR:P0001:order_closed:in_transit ERR:P0002:order_not_found: ERR:22023:order_lines_invalid:quantity '
  'ERR:P0002:order_line_not_found: ERR:42501:warehouse_read: ERR:P0001:order_item_not_addable:{"itemId": "' || :iBH || '", "reason": "not_found"} '
  'ERR:P0001:order_closed:completed |3,4',
  'A5: inside Add items the top-up helper re-checks everything: not the requester or an approver, a shipped order, a foreign member, a zero delta, no such line, an order in a warehouse the caller cannot read, another organization''s item, a closed order; an approver''s valid top-up works');
select is(
  pg_temp.run('authenticated', :mgr, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oPend, :iS)) || '|'
  || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lPend)),
  '|5',
  'A6: (the helper answers void)');
select set_config('stockpilot.add_lines', '', true) is not null as add_flag_down \gset

-- ═══ X. Exchanges ═════════════════════════════════════════════════════════
-- A return of the completed order's XS line, approved EARLIER with XS as the
-- replacement (a commitment), and its replacement order. XS is hidden.
insert into public.returns (id, organization_id, order_request_id, status, source, reason_code)
values (:rma, :orgA, :oDone, 'approved', 'internal', 'wrong_item');
insert into public.return_lines (id, return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
values (:rmaL, :rma, :orgA, :lDone, :iXS, 1, 'restock');
insert into public.order_requests (id, organization_id, warehouse_id, source, status, requester_user_id, fulfillment_type, replacement_for_return_id)
values (:oRepl, :orgA, :whA, 'internal', 'pending_approval', :stf, 'pickup', :rma);
select is(
  pg_temp.run('postgres', null, format('insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested) values (%L, %L, %L, 1) returning item_id::text', :lRepl, :oRepl, :iXS)),
  :iXS,
  'X1: a replacement order''s line for a hidden item is accepted (an approved commitment, exempt from the gate)');
insert into public.return_exchange_lines (id, organization_id, return_id, return_line_id, requested_item_id, requested_quantity, requested_by_kind, requested_by)
values (:xl, :orgA, :rma, :rmaL, :iXS, 1, 'staff', :mgr);
update public.return_exchange_lines
   set status = 'approved', approved_item_id = :iXS, approved_quantity = 1, approved_by = :mgr,
       approved_at = now() - interval '1 day', replacement_order_request_id = :oRepl, replacement_order_line_id = :lRepl, revision = 1
 where id = :xl;
select is(
  pg_temp.run('authenticated', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) || ' '
  || pg_temp.run('authenticated', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iM)) || ' '
  || pg_temp.run('authenticated', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iS)),
  'ERR:42501:: ERR:42501:: ERR:42501::',
  'X2: the item check has no API EXECUTE (it runs inside the definer exchange functions)');
-- change_return_replacement names the exchange line it keeps on its approved
-- item in a transaction-bound flag (stockpilot.exchange_kept_lines, this
-- transaction's id, then the line ids); the check exempts only that line.
-- Raised here as change_return_replacement raises it for a re-issue of xl.
select set_config('stockpilot.exchange_kept_lines', pg_current_xact_id()::text || '|' || :xl, true) is not null as kept_up \gset
select is(
  pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) || ' '
  || pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iM)) || ' '
  || pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iS)),
  'true false true',
  'X3: as the definer functions call it: a re-issue of the item an earlier transaction approved on the kept line passes though it is hidden; a NEW selection of a hidden item is refused; a shown one passes');
update public.return_exchange_lines set approved_at = now(), revision = 2 where id = :xl;
select is(
  pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)),
  'false',
  'X4: an approval made in this same transaction is not yet a commitment (approved_at < now() fails), so a first approval of a hidden item is refused');
update public.return_exchange_lines set approved_at = now() - interval '1 day', revision = 3 where id = :xl;
select set_config('stockpilot.exchange_kept_lines', '', true) is not null as kept_down \gset
select is(
  pg_temp.run('authenticated', :mgr, format('select string_agg(s->>''itemId'', '','' order by s->>''itemId'') from jsonb_array_elements(public.return_exchange_candidates(%L, %L, null, 30)->''siblings'') s', :oDone, :lDone))
  || '|' || pg_temp.run('authenticated', :mgr, format('select coalesce(string_agg(s->>''itemId'', '',''), '''') from jsonb_array_elements(public.return_exchange_candidates(%L, %L, ''Shirt'', 30)->''matches'') s', :oDone, :lDone))
  || '|' || (select string_agg(o.item_id::text, ',' order by o.item_id) from public._return_exchange_requester_options(:oDone, false) o),
  :iS || '||' || :iS,
  'X5: staff candidates (siblings and search) and the requester''s options offer only shown records: S, never hidden XS or M');

-- ═══ L. Public links ══════════════════════════════════════════════════════
select is(
  (select string_agg(right(item_id::text, 3), ',' order by item_id) from public.public_link_eligible_items(:lnk, :whA)
    where item_id in (:iS, :iBook))
  || '|' || (pg_temp.vis(:mgr, array[:iS, :iBook]::uuid[], false, :op2)::jsonb -> 'changed')::text
  || '|' || pg_temp.q(format('select coalesce(string_agg(right(item_id::text, 3), '','' order by item_id), '''') from public.public_link_eligible_items(%L, %L) where item_id in (%L, %L)', :lnk, :whA, :iS, :iBook))
  || '|' || (pg_temp.vis(:mgr, array[:iS, :iBook]::uuid[], true, :op3)::jsonb -> 'changed')::text
  || '|' || pg_temp.q(format('select coalesce(string_agg(right(item_id::text, 3), '','' order by item_id), '''') from public.public_link_eligible_items(%L, %L) where item_id in (%L, %L)', :lnk, :whA, :iS, :iBook))
  || '|' || pg_temp.q(format('select string_agg(public_visibility, '','' order by id) from public.inventory_items where id in (%L, %L)', :iS, :iBook)),
  '102,104|["' || :iS || '", "' || :iBook || '"]||["' || :iS || '", "' || :iBook || '"]|102,104|internal_only,public',
  'L1: a hidden entry and a hidden public-pool book leave the link (page and submit share the predicate); shown again they return; public_visibility never changes');
select is(
  (select count(*)::text from public.public_link_eligible_items(:lnk, :whA) where item_id = :iOk)
  || '|' || (pg_temp.vis(:mgr, array[:iOk]::uuid[], true, :op3)::jsonb ->> 'unchanged')
  || '|' || pg_temp.q(format('select count(*)::text from public.public_link_eligible_items(%L, %L) where item_id = %L', :lnk, :whA, :iOk)),
  '0|["' || :iOk || '"]|0',
  'L2: an internal-only record that is shown in Orders is still not on the link: Show never publishes');

-- ═══ D. Duplicate, unarchive, first receipt keep the choice ═══════════════
select pg_temp.run('authenticated', :mgr, format('select public.duplicate_inventory_item(%L, %L::jsonb)::text',
         :iXS, '{"sku": "X0413-SH-XS-COPY", "variant_size": "XL"}')) as dup_xs \gset
select pg_temp.run('authenticated', :mgr, format('select public.duplicate_inventory_item(%L, %L::jsonb)::text',
         :iS, '{"sku": "X0413-SH-S-COPY", "variant_size": "L"}')) as dup_s \gset
select is(
  (select ii.order_catalog_visible::text || ':' || (ii.order_catalog_visibility_changed_at is not null)::text || ':' || ii.public_visibility
     from public.inventory_items ii where ii.id::text = :'dup_xs')
  || ' ' || (select ii.order_catalog_visible::text || ':' || coalesce(ii.order_catalog_visibility_changed_at::text, 'null')
               from public.inventory_items ii where ii.id::text = :'dup_s'),
  'false:true:internal_only true:null',
  'D1: a copy of a hidden record is hidden (stamped by the database); a copy of a shown one is shown; public visibility is never copied');
select pg_temp.vis(:mgr, array[:iArch, :iExp]::uuid[], false, :op1) is not null as hid_arch \gset
update public.inventory_items set status = 'active' where id = :iArch;
update public.inventory_items set quantity_on_hand = 4 where id = :iExp;
select is(
  pg_temp.vis_of(:iArch) || ',' || (select status from public.inventory_items where id = :iArch)
  || '|' || pg_temp.vis_of(:iExp) || ',' || (select awaiting_first_receipt::text from public.inventory_items where id = :iExp),
  'false,active|false,false',
  'D2: unarchiving keeps a hidden choice, and the first receipt clears only awaiting_first_receipt');

-- ═══ R. The review fix round ══════════════════════════════════════════════
-- State here: lAdd (oAdd, iTop) holds 3; lPend (oPend, iS) holds 5; XS, M
-- and OK2 are hidden, OK and the book are shown; Orders is on for org A.
-- R1, D1 item 1: the helper checks the Orders module itself, even inside Add
-- items (the flag raised as add_order_request_lines raises it).
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
select set_config('stockpilot.add_lines', pg_current_xact_id()::text, true) is not null as add_flag_r1 \gset
select is(
  pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iTop))
  || ' ' || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
              jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 1))))
  || '|' || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd)),
  'ERR:42501:module_disabled: ERR:42501:module_disabled:|3',
  'R1: with Orders off the top-up helper refuses (module_disabled) as Add items does; the line is unchanged');
select set_config('stockpilot.add_lines', '', true) is not null as add_flag_r1_down \gset
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';
-- R2, D1 item 1: a direct call (no flag of this transaction) is refused, so
-- it can neither skip the service's audit row and hold sync nor raise demand
-- past the service's checks.
select is(
  pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iTop)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 20000000)::text', :oAdd, :iTop)) || ' '
  || pg_temp.run('authenticated', :mgr, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oPend, :iS)) || '|'
  || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd)) || ','
  || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lPend)),
  'ERR:42501:order_top_up_direct: ERR:42501:order_top_up_direct: ERR:42501:order_top_up_direct:|3,5',
  'R2: the top-up helper called directly is refused for the requester and for an approver alike (any delta); nothing changes');
select is(
  pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
    jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 1))))::jsonb
  || jsonb_build_object('top', pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd))::int,
                        'flag', pg_temp.q('select coalesce(current_setting(''stockpilot.add_lines'', true), '''')')),
  jsonb_build_object('orderId', :oAdd, 'added', '[]'::jsonb, 'merged', jsonb_build_array(:iTop), 'top', 4, 'flag', ''),
  'R3: Add items still tops up an existing line through the helper (the flag is raised for the call and put back)');
-- R4 to R6, D1 item 2: one ceiling, 10,000 units, on the RESULTING quantity
-- of a line on every add path (place_order_request's per-item cap).
select is(
  pg_temp.jf(pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
     jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 9996)))), 'merged')
  || '|' || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd))
  || '|' || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
              jsonb_build_array(jsonb_build_object('itemId', :iTop, 'quantity', 1))))
  || '|' || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd)),
  '["' || :iTop || '"]|10000|ERR:22023:order_lines_invalid:quantity|10000',
  'R4: a top-up may bring a line to exactly 10,000 units; one more is refused (22023 order_lines_invalid, quantity) and nothing changes');
select is(
  pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
    jsonb_build_array(jsonb_build_object('itemId', :iOk, 'quantity', 10001)))) || ' '
  || pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
       jsonb_build_array(jsonb_build_object('itemId', :iOk, 'quantity', 6000), jsonb_build_object('itemId', :iOk, 'quantity', 4001)))) || '|'
  || pg_temp.q(format('select count(*)::text from public.order_request_lines where order_request_id = %L and item_id = %L', :oAdd, :iOk)) || '|'
  || pg_temp.jf(pg_temp.run('authenticated', :stf, format('select public.add_order_request_lines(%L, %L::jsonb)::text', :oAdd,
        jsonb_build_array(jsonb_build_object('itemId', :iOk, 'quantity', 6000), jsonb_build_object('itemId', :iOk, 'quantity', 4000)))), 'added') || '|'
  || pg_temp.q(format('select sum(quantity_requested)::int::text from public.order_request_lines where order_request_id = %L and item_id = %L', :oAdd, :iOk)),
  'ERR:22023:order_lines_invalid:quantity ERR:22023:order_lines_invalid:quantity|0|["' || :iOk || '"]|10000',
  'R5: a new line of 10,001 units, or two entries summing to 10,001, is refused before anything is written; 10,000 is added');
select set_config('stockpilot.add_lines', pg_current_xact_id()::text, true) is not null as add_flag_r6 \gset
select is(
  pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 1)::text', :oAdd, :iTop)) || ' '
  || pg_temp.run('authenticated', :stf, format('select public._order_request_line_top_up(%L, %L, 20000000)::text', :oAdd, :iTop)) || '|'
  || pg_temp.q(format('select quantity_requested::int::text from public.order_request_lines where id = %L', :lAdd)),
  'ERR:22023:order_lines_invalid:quantity ERR:22023:order_lines_invalid:quantity|10000',
  'R6: the helper itself refuses a top-up past 10,000 on the resulting line (it used to accept 20,000,000 per call)');
select set_config('stockpilot.add_lines', '', true) is not null as add_flag_r6_down \gset
-- R7: moving a line to another order is new demand there (the UPDATE trigger
-- fires on order_request_id too), for every writer, the service role included.
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lX, :oDone, :iPrb, 7, 7),
  (:lY, :oDone, :iBook, 1, 1);
select pg_temp.vis(:mgr, array[:iPrb]::uuid[], false, :op1) is not null as hid_prb \gset
select is(
  pg_temp.run('service_role', null, format('update public.order_request_lines set order_request_id = %L where id = %L returning order_request_id::text', :oAdd, :lX)) || ' '
  || pg_temp.run('service_role', null, format('update public.order_request_lines set order_request_id = %L where id = %L returning order_request_id::text', :oAdd, :lY)) || '|'
  || pg_temp.q(format('select order_request_id::text from public.order_request_lines where id = %L', :lX)),
  'ERR:P0001:order_item_hidden:' || :iPrb || ' ' || :oAdd || '|' || :oDone,
  'R7: a hidden item''s line cannot be moved onto another order (the same insert is refused); a shown item''s line still moves');
-- R8, D1 item 4: the exchange exemption is the exact line
-- change_return_replacement keeps, in its own transaction. xl (approved a day
-- ago for hidden XS on oDone) is the commitment.
select pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) as r8_none \gset
select set_config('stockpilot.exchange_kept_lines', pg_current_xact_id()::text || '|' || :lPend, true) is not null as r8_flag_other \gset
select pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) as r8_other \gset
select set_config('stockpilot.exchange_kept_lines', '1|' || :xl, true) is not null as r8_flag_stale \gset
select pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) as r8_stale \gset
update public.return_exchange_lines set status = 'cancelled' where id = :xl;
select set_config('stockpilot.exchange_kept_lines', pg_current_xact_id()::text || '|' || :xl, true) is not null as r8_flag_kept \gset
select pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) as r8_kept \gset
select set_config('stockpilot.exchange_kept_lines', '', true) is not null as r8_flag_down \gset
select pg_temp.run('postgres', :mgr, format('select public._return_exchange_item_ok(%L, %L, ''staff'')::text', :oDone, :iXS)) as r8_cancelled \gset
select is(
  :'r8_none' || ' ' || :'r8_other' || ' ' || :'r8_stale' || ' ' || :'r8_kept' || ' ' || :'r8_cancelled',
  'false false false true false',
  'R8: a hidden item is a new staff selection unless THIS transaction''s change keeps that very exchange line on it: no flag, a flag naming another line or another transaction all refuse; approved then cancelled, the line passes only when its re-issue names it');
-- R9, D1 item 3: the platform function takes the actor's email from their own
-- sign-in account and refuses an actor id with none (PE11 shows the email).
select is(
  pg_temp.run('service_role', null, format('select public.platform_set_permission_exception(%L, %L, ''orders:manage_catalog_visibility'', ''allow'', ''default'', %L, ''support@stockpilot.test'')::text',
    :orgA, :vwr, '04130000-0000-0000-0000-0000000009fe'))
  || '|' || pg_temp.q(format('select count(*)::text from public.user_permission_overrides where organization_id = %L and user_id = %L and permission = ''orders:manage_catalog_visibility''', :orgA, :vwr)),
  'ERR:22023:permission_exception_invalid:actor|0',
  'R9: an actor id with no sign-in account is refused and nothing is written');
-- R10 to R12: insert_order_request_with_lines, the portal's and the public
-- link's one write (header, optional track token and lines, one transaction).
select is(
  pg_temp.run('authenticated', :stf, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA), '[]'))
  || ' ' || pg_temp.run('anon', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA), '[]')),
  'ERR:42501:: ERR:42501::',
  'R10: only the service role may call it');
select pg_temp.q('select count(*)::text from public.notifications') as r11_notes \gset
select is(
  pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'portal',
                       'requester_user_id', :stf, 'requester_name', 'R11 Customer', 'fulfillment_type', 'pickup', 'notes', 'R11 hidden'),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 1, 'unit_cost_at_request', 2),
                      jsonb_build_object('item_id', :iXS, 'quantity_requested', 1, 'unit_cost_at_request', 2, 'unit_price_at_request', null))))
  || '|' || pg_temp.q(format('select count(*)::text from public.order_requests where organization_id = %L and notes = ''R11 hidden''', :orgA))
  || '|' || pg_temp.q('select count(*)::text from public.notifications'),
  'ERR:P0001:order_item_hidden:' || :iXS || '|0|' || :'r11_notes',
  'R11: a portal order naming a hidden item leaves no header, no line and no New order request notification (it used to notify for a header it then deleted)');
select pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb, %L)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_confirmation', 'source', 'public_link',
                       'requester_email', 'r12-visitor@example.org', 'requester_name', 'R12 Visitor', 'fulfillment_type', 'pickup',
                       'notes', 'R12 ok', 'confirmation_token_hash', md5('r12-a') || md5('r12-b'),
                       'confirmation_token_expires_at', now() + interval '1 day'),
    jsonb_build_array(jsonb_build_object('item_id', :iS, 'quantity_requested', 2, 'unit_cost_at_request', 3, 'notes', 'size S'),
                      jsonb_build_object('item_id', :iBook, 'quantity_requested', 1, 'unit_cost_at_request', 4)),
    md5('r12-c') || md5('r12-d'))) as r12 \gset
select is(
  coalesce((select (s.j ->> 'status') || '|' || (s.j ->> 'source') || '|' || (s.j ->> 'requester_email')
              || '|' || pg_temp.q(format('select string_agg(right(item_id::text, 3) || ''x'' || trim_scale(quantity_requested)::text || '':'' || trim_scale(unit_cost_at_request)::text || '':'' || coalesce(notes, ''-''), '','' order by item_id) from public.order_request_lines where order_request_id = %L', s.j ->> 'id'))
              || '|' || pg_temp.q(format('select count(*)::text from public.order_request_secrets where order_request_id = %L and public_track_token = %L', s.j ->> 'id', md5('r12-c') || md5('r12-d')))
              from (select (case when :'r12' like 'ERR:%' then null else :'r12' end)::jsonb as j) s
             where s.j is not null),
           :'r12'),
  'pending_confirmation|public_link|r12-visitor@example.org|102x2:3:size S,104x1:4:-|1',
  'R12: a public-link order is written whole: the header (answered as its row), the track token''s side row and its lines');
select is(
  pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'internal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup'),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 1)))) || ' '
  || pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'approved', 'source', 'portal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup'),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 1)))) || ' '
  || pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'portal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup', 'id', :oAdd),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 1)))) || ' '
  || pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'portal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup'), '[]')) || ' '
  || pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'portal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup'),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 1), jsonb_build_object('item_id', :iOk, 'quantity_requested', 2)))) || ' '
  || pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'portal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup'),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 0)))),
  'ERR:22023:order_request_invalid:source ERR:22023:order_request_invalid:status ERR:22023:order_request_invalid:header '
  'ERR:22023:order_request_invalid:lines ERR:22023:order_request_invalid:lines ERR:22023:order_request_invalid:lines',
  'R12b: it writes only a new portal or public-link request, from the header columns those two send (an id, a status past approval, an internal source, no line, a repeated item or a quantity under 1 are refused)');
-- R12c (integrator D2): the one line ceiling, 10,000 units, holds on this
-- path too, in the order_lines_invalid contract every other path uses.
select is(
  pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
    jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_approval', 'source', 'portal',
                       'requester_user_id', :stf, 'fulfillment_type', 'pickup', 'notes', 'R12c over'),
    jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 10001))))
  || '|' || pg_temp.q(format('select count(*)::text from public.order_requests where organization_id = %L and notes = ''R12c over''', :orgA))
  || '|' || (case when pg_temp.run('service_role', null, format('select public.insert_order_request_with_lines(%L::jsonb, %L::jsonb)::text',
                jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'status', 'pending_confirmation', 'source', 'public_link',
                                   'requester_email', 'r12c-visitor@example.org', 'requester_name', 'R12c Visitor', 'fulfillment_type', 'pickup',
                                   'notes', 'R12c at'),
                jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity_requested', 10000)))) like 'ERR:%'
              then 'refused' else 'written' end)
  || '|' || coalesce(pg_temp.q(format('select string_agg(trim_scale(l.quantity_requested)::text, '','') from public.order_request_lines l join public.order_requests r on r.id = l.order_request_id where r.organization_id = %L and r.notes = ''R12c at''', :orgA)), '-'),
  'ERR:22023:order_lines_invalid:quantity|0|written|10000',
  'R12c: a line above 10,000 units is refused as order_lines_invalid quantity and nothing is written; exactly 10,000 is written');

-- ═══ C. Census ════════════════════════════════════════════════════════════
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'set\s+order_catalog_visible')
  || '|' || (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'ledger'::regnamespace) and p.prosrc ~* 'order_catalog_visible\M'),
  'set_order_catalog_visibility|_order_items_hidden_from_orders,_return_exchange_item_ok,_return_exchange_requester_options,'
  'add_order_request_lines,duplicate_inventory_item,public_link_eligible_items,return_exchange_candidates,'
  'set_order_catalog_visibility,tg_inventory_items_order_visibility_guard,tg_order_request_lines_order_visibility',
  'C1: the only function that UPDATEs the column is set_order_catalog_visibility; these are every body that names it (duplicate is the one INSERT that carries it)');
select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'ledger'::regnamespace)
      and p.prosrc ~* '(insert\s+into|update(\s+only)?|delete\s+from(\s+only)?|merge\s+into)\s+("?public"?\s*\.\s*)?"?role_default_permissions\M')
  || '|' || (select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'ledger'::regnamespace) and p.prosecdef
      and p.prosrc ~* '(insert\s+into|update(\s+only)?|merge\s+into)\s+("?public"?\s*\.\s*)?"?user_permission_overrides\M'),
  '|platform_set_permission_exception',
  'C2: no function writes the global role defaults (a definer one would pass the guard as postgres), and the only definer function that inserts or updates user overrides is the platform function');

select * from finish();
rollback;
