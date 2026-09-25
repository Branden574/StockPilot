-- supabase/tests/0370_exception_occurrences.test.sql
-- pgTAP proof for migration 0370 (F1-1: exception occurrences).
--
-- G. Grants and structure. authenticated holds SELECT only on occurrences,
--    events and sync state (insert, update and delete fail with 42501), the
--    counters are closed to it, exceptions_sync is service_role only, the act
--    RPC is authenticated only, RLS is on everywhere.
-- S. exceptions_sync, as service_role:
--    raise gives EX-1 and a `raised` event; absent + complete resolves as
--    `cleared`; recurrence opens EX-2 linked to EX-1 with index 1 (mutation:
--    reuse the resolved row); seen again writes no event and changes facts
--    only when they differ; absent while the rule FAILED stays open, and
--    absent while TRUNCATED stays open (mutation: ignore complete_rules); a
--    hold identity stays open and never opens (mutation: treat hold as
--    absent); an older or equal evaluated_at is skipped (mutation: drop the
--    monotonic check); `reclassified` (stale_staging -> orphaned_stock),
--    `subject_gone`, cross-org entries dropped; recount pointers closed with
--    a recount_closed event before `resolved`; two open rows with a null
--    location conflict on exc_occ_one_open; malformed payloads and a future
--    evaluation time are refused; per-org numbering; sync state.
-- A. exception_occurrence_act: staff with write access acknowledge; a
--    replayed client_event_id adds one event; a second acknowledgement only
--    adds a note; a viewer gets 42501, even one granted stock:adjust by an
--    override (no write access to the warehouse; mutation: drop the
--    warehouse check); staff in another warehouse get P0002; a resolved row
--    gets occurrence_resolved; stock:adjust revoked gets 42501; a
--    null-warehouse scope needs a manager; another org gets P0002;
--    a reused client id on another occurrence is refused; a replay after the
--    row resolved still answers; the RPC never sets resolved_at.
-- R. RLS: warehouse A cannot see warehouse B; charter- and
--    category-restricted readers see only their items; a holding at a
--    null-warehouse location follows the holdings policy (visible), one at
--    another warehouse's location is hidden; another org sees nothing;
--    events follow their occurrence; sync state is members only.
-- P. item_stock_levels.positive_since: set on insert, unchanged on a top-up
--    (mutation: stamp on every update) and a partial draw, null at 0, a new
--    time on refill, a supplied value is ignored; the S1 guard still refuses a
--    direct API write. Through every ledger writer: post_receipt_v2 and
--    reverse_receipt (adjust_stock with a location and without), adjust_stock
--    directly, transfer_stock (both sides), post_cycle_count (counted
--    location path and Staging path, both directions), assemble_bundle,
--    distribute_bundle, process_return_disposition (restock and scrap).
-- B. The backfill helper stamps positive holdings with updated_at and leaves
--    updated_at unchanged (mutation: forget to disable the trigger); zero
--    rows stay null; stamped rows keep their value; both triggers are back
--    on afterwards; the helper has no grants.
--
-- TIME. now() is the transaction start for the whole file, so "stamped now"
-- is `= now()` and an older value is planted as 2020-01-01 with the
-- positive_since trigger disabled for that statement. Evaluation times are
-- now() minus N minutes, N falling as the syncs go on.
--
-- Roles: fixtures as the test superuser. Syncs run as service_role (the
-- cron's role), acts and reads as `authenticated` with request.jwt.claim.sub.
-- Closed function grants are asserted from the catalog only (a denied
-- function call is never executed here; see 0351). begin/rollback: nothing
-- leaks. Namespace 03700000.

begin;

select plan(131);

\set orgA    '\'03700000-0000-0000-0000-00000000000a\''
\set orgB    '\'03700000-0000-0000-0000-00000000000b\''
\set mgr     '\'03700000-0000-0000-0000-0000000000a1\''
\set stf     '\'03700000-0000-0000-0000-0000000000a2\''
\set stf2    '\'03700000-0000-0000-0000-0000000000a3\''
\set vwr     '\'03700000-0000-0000-0000-0000000000a4\''
\set stfCh   '\'03700000-0000-0000-0000-0000000000a5\''
\set vwrCat  '\'03700000-0000-0000-0000-0000000000a6\''
\set stfNo   '\'03700000-0000-0000-0000-0000000000a7\''
\set vwrAdj  '\'03700000-0000-0000-0000-0000000000a8\''
\set mgrB    '\'03700000-0000-0000-0000-0000000000b1\''
\set whA     '\'03700000-0000-0000-0000-0000000000c1\''
\set whA2    '\'03700000-0000-0000-0000-0000000000c2\''
\set whB     '\'03700000-0000-0000-0000-0000000000c3\''
\set rA1     '\'03700000-0000-0000-0000-0000000000d1\''
\set rA2     '\'03700000-0000-0000-0000-0000000000d2\''
\set rA3     '\'03700000-0000-0000-0000-0000000000d3\''
\set rW2     '\'03700000-0000-0000-0000-0000000000d4\''
\set lOrg    '\'03700000-0000-0000-0000-0000000000d5\''
\set rB      '\'03700000-0000-0000-0000-0000000000d6\''
\set chA1    '\'03700000-0000-0000-0000-0000000000e1\''
\set chA2    '\'03700000-0000-0000-0000-0000000000e2\''
\set catX    '\'03700000-0000-0000-0000-0000000000e3\''
\set catY    '\'03700000-0000-0000-0000-0000000000e4\''
-- occurrence items
\set iL      '\'03700000-0000-0000-0000-000000000f01\''
\set iO      '\'03700000-0000-0000-0000-000000000f02\''
\set iS      '\'03700000-0000-0000-0000-000000000f03\''
\set iG      '\'03700000-0000-0000-0000-000000000f04\''
\set iU      '\'03700000-0000-0000-0000-000000000f05\''
\set iR      '\'03700000-0000-0000-0000-000000000f06\''
\set iW2     '\'03700000-0000-0000-0000-000000000f07\''
\set iCh1    '\'03700000-0000-0000-0000-000000000f08\''
\set iCh2    '\'03700000-0000-0000-0000-000000000f09\''
\set iCatX   '\'03700000-0000-0000-0000-000000000f0a\''
\set iCatY   '\'03700000-0000-0000-0000-000000000f0b\''
\set iX      '\'03700000-0000-0000-0000-000000000f0c\''
\set iY      '\'03700000-0000-0000-0000-000000000f0d\''
\set iHold   '\'03700000-0000-0000-0000-000000000f0e\''
\set iNew    '\'03700000-0000-0000-0000-000000000f0f\''
\set itemB   '\'03700000-0000-0000-0000-000000000f10\''
-- positive_since items
\set pI      '\'03700000-0000-0000-0000-000000000101\''
\set pRC     '\'03700000-0000-0000-0000-000000000102\''
\set pRN     '\'03700000-0000-0000-0000-000000000103\''
\set pAJ     '\'03700000-0000-0000-0000-000000000104\''
\set pTR     '\'03700000-0000-0000-0000-000000000105\''
\set pCL1    '\'03700000-0000-0000-0000-000000000106\''
\set pCL2    '\'03700000-0000-0000-0000-000000000107\''
\set pCS     '\'03700000-0000-0000-0000-000000000108\''
\set pCS2    '\'03700000-0000-0000-0000-000000000109\''
\set compA   '\'03700000-0000-0000-0000-00000000010a\''
\set compB   '\'03700000-0000-0000-0000-00000000010b\''
\set pRR     '\'03700000-0000-0000-0000-00000000010c\''
\set pRS     '\'03700000-0000-0000-0000-00000000010d\''
\set pBF1    '\'03700000-0000-0000-0000-00000000010e\''
\set pBF2    '\'03700000-0000-0000-0000-00000000010f\''
\set pBF3    '\'03700000-0000-0000-0000-000000000110\''
-- counts, POs, bundles, orders, returns
\set ccDone  '\'03700000-0000-0000-0000-000000000201\''
\set ccOpen  '\'03700000-0000-0000-0000-000000000202\''
\set ccW     '\'03700000-0000-0000-0000-000000000203\''
\set lnCL1   '\'03700000-0000-0000-0000-000000000211\''
\set lnCL2   '\'03700000-0000-0000-0000-000000000212\''
\set lnCS    '\'03700000-0000-0000-0000-000000000213\''
\set lnCS2   '\'03700000-0000-0000-0000-000000000214\''
\set poW     '\'03700000-0000-0000-0000-000000000301\''
\set polRC   '\'03700000-0000-0000-0000-000000000302\''
\set polRN   '\'03700000-0000-0000-0000-000000000303\''
\set bdl     '\'03700000-0000-0000-0000-000000000401\''
\set ordW    '\'03700000-0000-0000-0000-000000000501\''
\set olRR    '\'03700000-0000-0000-0000-000000000502\''
\set olRS    '\'03700000-0000-0000-0000-000000000503\''
\set retRR   '\'03700000-0000-0000-0000-000000000504\''
\set retRS   '\'03700000-0000-0000-0000-000000000505\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,    '0370-mgr@test.local',    '{}'::jsonb),
  (:stf,    '0370-stf@test.local',    '{}'::jsonb),
  (:stf2,   '0370-stf2@test.local',   '{}'::jsonb),
  (:vwr,    '0370-vwr@test.local',    '{}'::jsonb),
  (:stfCh,  '0370-stfch@test.local',  '{}'::jsonb),
  (:vwrCat, '0370-vwrcat@test.local', '{}'::jsonb),
  (:stfNo,  '0370-stfno@test.local',  '{}'::jsonb),
  (:vwrAdj, '0370-vwradj@test.local', '{}'::jsonb),
  (:mgrB,   '0370-mgrb@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0370 Exceptions A', '0370-exceptions-a'),
  (:orgB, '0370 Exceptions B', '0370-exceptions-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :stf,    'staff',   now()),
  (:orgA, :stf2,   'staff',   now()),
  (:orgA, :vwr,    'viewer',  now()),
  (:orgA, :stfCh,  'staff',   now()),
  (:orgA, :vwrCat, 'viewer',  now()),
  (:orgA, :stfNo,  'staff',   now()),
  (:orgA, :vwrAdj, 'viewer',  now()),
  (:orgB, :mgrB,   'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0370 Main',  'WH-0370A',  'active'),
  (:whA2, :orgA, '0370 Annex', 'WH-0370A2', 'active'),
  (:whB,  :orgB, '0370 Other', 'WH-0370B',  'active');
insert into public.charters (id, organization_id, name) values
  (:chA1, :orgA, 'Charter 0370 one'),
  (:chA2, :orgA, 'Charter 0370 two');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chA1),
  (:orgA, :whA, :chA2);
insert into public.categories (id, organization_id, name) values
  (:catX, :orgA, 'Category 0370 X'),
  (:catY, :orgA, 'Category 0370 Y');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,    :whA,  null,  true),
  (:orgA, :stf2,   :whA2, null,  true),
  (:orgA, :vwr,    :whA,  null,  true),
  (:orgA, :stfCh,  :whA,  :chA1, true),
  (:orgA, :vwrCat, :whA,  null,  true),
  (:orgA, :stfNo,  :whA,  null,  true),
  (:orgA, :vwrAdj, :whA,  null,  true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwrCat, :catX);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfNo, 'stock:adjust', false),
  (:orgA, :vwrAdj, 'stock:adjust', true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rA1,  :orgA, :whA,  '70-A',     'shelf', 'rack'),
  (:rA2,  :orgA, :whA,  '70-B',     'shelf', 'rack'),
  (:rA3,  :orgA, :whA,  '70-C',     'shelf', 'rack'),
  (:rW2,  :orgA, :whA2, '70-W',     'shelf', 'rack'),
  (:lOrg, :orgA, null,  '70-ORG',   'shelf', 'rack'),
  (:rB,   :orgB, :whB,  '70-OTHER', 'shelf', 'rack');

-- The warehouse trigger seeded each warehouse's Staging and Unplaced.
select id as "stA" from public.locations where warehouse_id = :whA and kind = 'staging' and deleted_at is null \gset
select id as "unA" from public.locations where warehouse_id = :whA and kind = 'unplaced' and deleted_at is null \gset

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, charter_id, category_id) values
  (:iL,    :orgA, :whA,  'X0370-L',   'Label item',       0, 'active', null,  null),
  (:iO,    :orgA, :whA,  'X0370-O',   'Promised item',    0, 'active', null,  null),
  (:iS,    :orgA, :whA,  'X0370-S',   'Staged item',      0, 'active', null,  null),
  (:iG,    :orgA, :whA,  'X0370-G',   'Retired item',     0, 'active', null,  null),
  (:iU,    :orgA, :whA,  'X0370-U',   'Unplaced item',    0, 'active', null,  null),
  (:iR,    :orgA, :whA,  'X0370-R',   'Recounted item',   0, 'active', null,  null),
  (:iW2,   :orgA, :whA2, 'X0370-W2',  'Annex item',       0, 'active', null,  null),
  (:iCh1,  :orgA, :whA,  'X0370-CH1', 'Charter one item', 0, 'active', :chA1, null),
  (:iCh2,  :orgA, :whA,  'X0370-CH2', 'Charter two item', 0, 'active', :chA2, null),
  (:iCatX, :orgA, :whA,  'X0370-CX',  'Category X item',  0, 'active', null,  :catX),
  (:iCatY, :orgA, :whA,  'X0370-CY',  'Category Y item',  0, 'active', null,  :catY),
  (:iX,    :orgA, :whA,  'X0370-X',   'Org shelf item',   0, 'active', null,  null),
  (:iY,    :orgA, :whA,  'X0370-Y',   'Annex shelf item', 0, 'active', null,  null),
  (:iHold, :orgA, :whA,  'X0370-H',   'Held item',        0, 'active', null,  null),
  (:iNew,  :orgA, :whA,  'X0370-N',   'Late item',        0, 'active', null,  null),
  (:itemB, :orgB, :whB,  'X0370-B',   'Other org item',   0, 'active', null,  null);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  (:pI,    :orgA, :whA, 'P0370-I',   'Insert probe',        0,   'active'),
  (:pRC,   :orgA, :whA, 'P0370-RC',  'Received top-up',     5,   'active'),
  (:pRN,   :orgA, :whA, 'P0370-RN',  'Received new',        0,   'active'),
  (:pAJ,   :orgA, :whA, 'P0370-AJ',  'Adjusted',            4,   'active'),
  (:pTR,   :orgA, :whA, 'P0370-TR',  'Transferred',         7,   'active'),
  (:pCL1,  :orgA, :whA, 'P0370-CL1', 'Counted up on rack',  10,  'active'),
  (:pCL2,  :orgA, :whA, 'P0370-CL2', 'Counted empty',       10,  'active'),
  (:pCS,   :orgA, :whA, 'P0370-CS',  'Counted up, split',   10,  'active'),
  (:pCS2,  :orgA, :whA, 'P0370-CS2', 'Counted down, split', 13,  'active'),
  (:compA, :orgA, :whA, 'P0370-CA',  'Kit part A',          20,  'active'),
  (:compB, :orgA, :whA, 'P0370-CB',  'Kit part B',          3,   'active'),
  (:pRR,   :orgA, :whA, 'P0370-RR',  'Returned to stock',   0,   'active'),
  (:pRS,   :orgA, :whA, 'P0370-RS',  'Returned for scrap',  100, 'active'),
  (:pBF1,  :orgA, :whA, 'P0370-BF1', 'Backfill positive',   5,   'active'),
  (:pBF2,  :orgA, :whA, 'P0370-BF2', 'Backfill empty',      0,   'active'),
  (:pBF3,  :orgA, :whA, 'P0370-BF3', 'Backfill stamped',    7,   'active');

-- Exact holdings (the 0199 trigger seeded Unplaced rows; replace them).
delete from public.item_stock_levels
 where item_id in (:pI, :pRC, :pRN, :pAJ, :pTR, :pCL1, :pCL2, :pCS, :pCS2,
                   :compA, :compB, :pRR, :pRS, :pBF1, :pBF2, :pBF3);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :pRC,   :'stA', 5),
  (:orgA, :pAJ,   :rA1, 4),
  (:orgA, :pTR,   :rA1, 3), (:orgA, :pTR, :rA2, 4),
  (:orgA, :pCL1,  :rA1, 10),
  (:orgA, :pCL2,  :rA2, 10),
  (:orgA, :pCS,   :rA1, 5), (:orgA, :pCS,  :rA2, 5),
  (:orgA, :pCS2,  :rA1, 5), (:orgA, :pCS2, :rA2, 5), (:orgA, :pCS2, :'stA', 3),
  (:orgA, :compA, :rA3, 20),
  (:orgA, :compB, :rA3, 3),
  (:orgA, :pRS,   :'stA', 100),
  (:orgA, :pBF1,  :rA1, 5),
  (:orgA, :pBF2,  :rA2, 0),
  (:orgA, :pBF3,  :rA3, 7);

-- Counts for the recount-pointer step and the count writer.
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at, completed_at, completed_by) values
  (:ccDone, :orgA, :whA, 'completed',   'selection', :mgr, now() - interval '2 hours', now() - interval '90 minutes', :mgr),
  (:ccOpen, :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '2 hours', null, null),
  (:ccW,    :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '1 hour',  null, null);
insert into public.cycle_count_lines (id, cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:lnCL1, :ccW, :pCL1, :whA, 10),
  (:lnCL2, :ccW, :pCL2, :whA, 10),
  (:lnCS,  :ccW, :pCS,  :whA, 10),
  (:lnCS2, :ccW, :pCS2, :whA, 13);

-- A PO to receive against.
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:poW, :orgA, 'PO-0370-W', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:polRC, :orgA, :poW, :pRC, 10, 0, 1),
  (:polRN, :orgA, :poW, :pRN, 10, 0, 1);

-- A kit: 2 x part A + 3 x part B.
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  (:bdl, :orgA, 'Kit 0370', 'KIT-0370', true, true);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  (:bdl, :compA, 2, false),
  (:bdl, :compB, 3, false);

-- A fulfilled order to return against.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type) values
  (:ordW, :orgA, :whA, 'in_transit', :mgr, 'internal', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:olRR, :ordW, :pRR, 10, 5),
  (:olRS, :ordW, :pRS, 10, 5);

-- Plant an OLD positive_since (2020-01-01) on stocked holdings, with the
-- trigger off for this statement only, so "kept" and "stamped now" differ.
create function pg_temp.plant(p_items uuid[]) returns void language plpgsql as $$
begin
  alter table public.item_stock_levels disable trigger trg_item_stock_levels_positive_since;
  update public.item_stock_levels set positive_since = '2020-01-01 00:00:00+00'
   where item_id = any (p_items) and quantity > 0;
  alter table public.item_stock_levels enable trigger trg_item_stock_levels_positive_since;
end $$;
select pg_temp.plant(array[:pRC, :pAJ, :pTR, :pCL1, :pCL2, :pCS, :pCS2, :compA, :compB, :pRS]::uuid[]);

-- positive_since of one holding.
create function pg_temp.ps(p_item uuid, p_loc uuid) returns timestamptz language sql as $$
  select positive_since from public.item_stock_levels where item_id = p_item and location_id = p_loc
$$;

-- Sync helpers. One present/hold entry; the current present set lives in
-- cur_present (insertion order = the evaluator's order = numbering order).
create function pg_temp.e(p_rule text, p_item uuid, p_loc uuid default null, p_facts jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('rule', p_rule, 'itemId', p_item, 'locationId', p_loc, 'facts', p_facts)
$$;
create temp table cur_present (ord serial primary key, tag text not null unique, entry jsonb not null);
grant all on cur_present to service_role;
grant usage on sequence cur_present_ord_seq to service_role;
create function pg_temp.sync(
  p_minutes_ago integer,
  p_complete    text[] default array['orphaned_stock', 'over_reserved', 'stale_staging', 'long_unplaced', 'label_mismatch'],
  p_failed      text[] default '{}',
  p_truncated   text[] default '{}',
  p_hold        jsonb  default '[]'::jsonb,
  p_extra       jsonb  default '[]'::jsonb,
  p_org         uuid   default '03700000-0000-0000-0000-00000000000a')
returns jsonb language sql as $$
  select public.exceptions_sync(
    p_org, now() - make_interval(mins => p_minutes_ago),
    p_complete, p_failed, p_truncated,
    (select coalesce(jsonb_agg(c.entry order by c.ord), '[]'::jsonb) from cur_present c) || p_extra,
    p_hold)
$$;

-- Guard the fixtures: a silently missing row would let a refusal pass for the
-- wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items where id::text like '03700000-%') <> 32
     or (select count(*) from public.user_warehouse_assignments where user_id::text like '03700000-%') <> 7
     or (select count(*) from public.item_stock_levels
          where item_id::text like '03700000-%' and positive_since = '2020-01-01 00:00:00+00') <> 14
  then raise exception '0370 test fixtures incomplete'; end if;
end $$;

-- ═══ G. Grants and structure ══════════════════════════════════════════════
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.exception_occurrences'::regclass, 'public.exception_occurrence_events'::regclass,
                    'public.exception_occurrence_counters'::regclass, 'public.exception_sync_state'::regclass)),
  'G1: RLS is on for all four tables');
select ok(
  has_table_privilege('authenticated', 'public.exception_occurrences', 'SELECT')
  and has_table_privilege('authenticated', 'public.exception_occurrence_events', 'SELECT')
  and has_table_privilege('authenticated', 'public.exception_sync_state', 'SELECT')
  and not has_table_privilege('anon', 'public.exception_occurrences', 'SELECT')
  and not has_table_privilege('anon', 'public.exception_occurrence_events', 'SELECT')
  and not has_table_privilege('anon', 'public.exception_sync_state', 'SELECT'),
  'G2: authenticated may read occurrences, events and sync state; anon may not');
select is(
  (select count(*)::int
     from unnest(array['public.exception_occurrences', 'public.exception_occurrence_events',
                       'public.exception_occurrence_counters', 'public.exception_sync_state']) t(tbl),
          unnest(array['anon', 'authenticated']) r(rol),
          unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
    where has_table_privilege(r.rol, t.tbl, p.priv)),
  0,
  'G3: no write-class privilege on any of the four tables for anon or authenticated');
select ok(
  not has_table_privilege('authenticated', 'public.exception_occurrence_counters', 'SELECT')
  and not has_table_privilege('anon', 'public.exception_occurrence_counters', 'SELECT'),
  'G4: the counters are closed to the API roles');
select ok(
  not has_function_privilege('authenticated', 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)', 'EXECUTE'),
  'G5: exceptions_sync is executable by service_role only (catalog; never called as a denied role)');
select ok(
  (select not p.prosecdef
          and 'lock_timeout=8s' = any (p.proconfig)
          and 'search_path=public' = any (p.proconfig)
     from pg_proc p where p.oid = 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)'::regprocedure),
  'G6: exceptions_sync is SECURITY INVOKER with lock_timeout 8s and a pinned search_path');
select ok(
  has_function_privilege('authenticated', 'public.exception_occurrence_act(uuid, text, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exception_occurrence_act(uuid, text, text, text)', 'EXECUTE')
  and (select p.prosecdef from pg_proc p where p.oid = 'public.exception_occurrence_act(uuid, text, text, text)'::regprocedure),
  'G7: exception_occurrence_act is SECURITY DEFINER, executable by authenticated, not anon');
select ok(
  has_function_privilege('authenticated', 'public._exc_occurrence_visible(uuid, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._exc_occurrence_visible(uuid, uuid, uuid)', 'EXECUTE'),
  'G8: the visibility predicate is callable by authenticated (the policy runs it) and not anon');
select ok(
  (select p.prosrc !~* 'resolved_(at|reason)\s*=[^=]' from pg_proc p
    where p.oid = 'public.exception_occurrence_act(uuid, text, text, text)'::regprocedure),
  'G9: the act RPC body never assigns resolved_at or resolved_reason');

set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.exception_occurrences (organization_id, occurrence_number, rule, item_id, first_seen_at, last_seen_at)
           values (%L, 999, 'label_mismatch', %L, now(), now())$$, :orgA, :iL),
  '42501', null, 'G10: authenticated cannot insert an occurrence');
select throws_ok($$update public.exception_occurrences set facts = '{}'::jsonb$$,
  '42501', null, 'G11: authenticated cannot update occurrences');
select throws_ok($$delete from public.exception_occurrences$$,
  '42501', null, 'G12: authenticated cannot delete occurrences');
select throws_ok(
  format($$insert into public.exception_occurrence_events (organization_id, occurrence_id, kind)
           values (%L, gen_random_uuid(), 'resolved')$$, :orgA),
  '42501', null, 'G13: authenticated cannot insert a timeline event (no forged resolution)');
select throws_ok($$update public.exception_occurrence_events set note = 'x'$$,
  '42501', null, 'G14: authenticated cannot update events');
select throws_ok($$delete from public.exception_occurrence_events$$,
  '42501', null, 'G15: authenticated cannot delete events');
select throws_ok(
  format($$insert into public.exception_sync_state (organization_id, tracking_started_at, last_evaluated_at, last_synced_at)
           values (%L, now(), now(), now())$$, :orgA),
  '42501', null, 'G16: authenticated cannot insert sync state');
select throws_ok($$update public.exception_sync_state set last_evaluated_at = now() + interval '1 year'$$,
  '42501', null, 'G17: authenticated cannot update sync state (no pinning the monotonic clock)');
select throws_ok($$delete from public.exception_sync_state$$,
  '42501', null, 'G18: authenticated cannot delete sync state');
select throws_ok($$select * from public.exception_occurrence_counters$$,
  '42501', null, 'G19: authenticated cannot read the counters');
reset role;

-- ═══ S. exceptions_sync ═══════════════════════════════════════════════════
set local role to 'service_role';

-- S1-S4: the first sync raises EX-1 with a raised event and starts tracking.
insert into cur_present (tag, entry) values ('L', pg_temp.e('label_mismatch', :iL));
select is(
  pg_temp.sync(60),
  '{"skipped": false, "raised": 1, "seen": 0, "resolved": 0, "recountsClosed": 0, "dropped": 0}'::jsonb,
  'S1: the first sync raises one occurrence');
select is(
  (select row(o.occurrence_number, o.rule, o.location_id, o.warehouse_id, o.recurrence_index,
              o.previous_occurrence_id, o.resolved_at, o.first_seen_at = now() - interval '60 minutes',
              o.last_seen_at = o.first_seen_at)::text
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id = :iL),
  row(1::bigint, 'label_mismatch', null::uuid, :whA::uuid, 0, null::uuid, null::timestamptz, true, true)::text,
  'S2: it is EX-1, item-level, stamped with the item''s warehouse, first and last seen at the evaluation');
select is(
  (select array_agg(e.kind || ':' || coalesce(e.actor_user_id::text, 'system'))
     from public.exception_occurrence_events e
     join public.exception_occurrences o on o.id = e.occurrence_id
    where o.item_id = :iL),
  array['raised:system'],
  'S3: exactly one raised event, written by the system');
select is(
  (select row(tracking_started_at = now() - interval '60 minutes',
              last_evaluated_at = now() - interval '60 minutes')::text
     from public.exception_sync_state where organization_id = :orgA),
  row(true, true)::text,
  'S4: sync state starts tracking at the first evaluation');

-- S5-S6: absent while its rule is complete resolves as cleared.
delete from cur_present where tag = 'L';
select is(
  (pg_temp.sync(59))->>'resolved', '1',
  'S5: the next sync, without it, resolves it');
select is(
  (select row(o.resolved_reason, o.resolved_at = now() - interval '59 minutes',
              (select count(*) from public.exception_occurrence_events e
                where e.occurrence_id = o.id and e.kind = 'resolved' and e.actor_user_id is null))::text
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id = :iL),
  row('cleared', true, 1::bigint)::text,
  'S6: resolved as cleared at the evaluation time, with one system resolved event');

-- S7-S8: recurrence opens EX-2 linked to EX-1. Mutation: reuse the resolved
-- row, and EX-1 reopens with no EX-2.
insert into cur_present (tag, entry) values ('L', pg_temp.e('label_mismatch', :iL, null, '{"a": 1}'::jsonb));
select is((pg_temp.sync(58))->>'raised', '1', 'S7: the condition returns and one occurrence is raised');
select is(
  (select array_agg(row(o.occurrence_number, o.resolved_reason, o.recurrence_index,
                        o.previous_occurrence_id = (select p.id from public.exception_occurrences p
                                                     where p.organization_id = :orgA and p.occurrence_number = 1))::text
                    order by o.occurrence_number)
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id = :iL),
  array[row(1::bigint, 'cleared', 0, null::boolean)::text,
        row(2::bigint, null::text, 1, true)::text],
  'S8: EX-1 stays resolved; EX-2 is open, recurrence 1, linked to EX-1');

-- S9-S11: twelve more conditions, raised in the evaluator's order; the open
-- EX-2 is seen again with no event.
insert into cur_present (tag, entry) values
  ('O',    pg_temp.e('over_reserved',  :iO)),
  ('S',    pg_temp.e('stale_staging',  :iS, :'stA', '{"units": 3}'::jsonb)),
  ('G',    pg_temp.e('over_reserved',  :iG)),
  ('U',    pg_temp.e('long_unplaced',  :iU, :'unA')),
  ('R',    pg_temp.e('over_reserved',  :iR)),
  ('W2',   pg_temp.e('label_mismatch', :iW2)),
  ('Ch1',  pg_temp.e('label_mismatch', :iCh1)),
  ('Ch2',  pg_temp.e('label_mismatch', :iCh2)),
  ('CatX', pg_temp.e('label_mismatch', :iCatX)),
  ('CatY', pg_temp.e('label_mismatch', :iCatY)),
  ('X',    pg_temp.e('orphaned_stock', :iX, :lOrg)),
  ('Y',    pg_temp.e('orphaned_stock', :iY, :rW2));
select is(
  pg_temp.sync(57),
  '{"skipped": false, "raised": 12, "seen": 1, "resolved": 0, "recountsClosed": 0, "dropped": 0}'::jsonb,
  'S9: twelve raised, one seen again');
select is(
  (select array_agg(o.item_id::text order by o.occurrence_number)
     from public.exception_occurrences o where o.organization_id = :orgA and o.occurrence_number between 3 and 14),
  array[:iO, :iS, :iG, :iU, :iR, :iW2, :iCh1, :iCh2, :iCatX, :iCatY, :iX, :iY]::text[],
  'S10: numbered EX-3..EX-14 in the evaluator''s order');
select is(
  (select row(o.last_seen_at = now() - interval '57 minutes', o.facts,
              (select count(*) from public.exception_occurrence_events e where e.occurrence_id = o.id))::text
     from public.exception_occurrences o where o.organization_id = :orgA and o.occurrence_number = 2),
  row(true, '{"a": 1}'::jsonb, 1::bigint)::text,
  'S11: EX-2 seen again: last_seen_at moves, facts unchanged, no new event');
select is(
  (select array_agg(coalesce(o.warehouse_id::text, 'none') order by o.item_id)
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id in (:iW2, :iX, :iY)),
  array[:whA2, 'none', :whA2]::text[],
  'S12: the scope stamp is derived: the item''s warehouse (item rule), none for a null-warehouse location, the location''s warehouse (holding rule)');

-- S13: facts change only when they differ, still with no event.
update cur_present set entry = pg_temp.e('label_mismatch', :iL, null, '{"a": 2}'::jsonb) where tag = 'L';
select pg_temp.sync(56);
select is(
  (select row(o.facts, (select count(*) from public.exception_occurrence_events e where e.occurrence_id = o.id))::text
     from public.exception_occurrences o where o.organization_id = :orgA and o.occurrence_number = 2),
  row('{"a": 2}'::jsonb, 1::bigint)::text,
  'S13: new facts are stored, and seeing the row again still writes no event');

-- S14-S16: absent while its rule FAILED (or was TRUNCATED) stays open.
-- Mutation: ignore complete_rules, and both resolve.
delete from cur_present where tag in ('O', 'U');
select is(
  (pg_temp.sync(55,
     array['orphaned_stock', 'stale_staging', 'long_unplaced', 'label_mismatch'],
     array['over_reserved'],
     array['long_unplaced']))->>'resolved',
  '0',
  'S14: nothing resolves when the absent rows'' rules failed or were truncated');
select is(
  (select array_agg(o.resolved_at is null order by o.item_id)
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id in (:iO, :iU)),
  array[true, true],
  'S15: the over_reserved row (rule failed) and the long_unplaced row (listed complete but truncated) stay open');
select is(
  (select row(complete_rules, failed_rules, truncated_rules)::text
     from public.exception_sync_state where organization_id = :orgA),
  row(array['label_mismatch', 'orphaned_stock', 'stale_staging'],
      array['over_reserved'], array['long_unplaced'])::text,
  'S16: sync state records only the rules the evaluation could vouch for, and which failed or were truncated');

-- S17-S18: a hold identity stays open and never opens. Mutation: treat hold
-- as absent, and the iO row resolves.
insert into cur_present (tag, entry) values ('U', pg_temp.e('long_unplaced', :iU, :'unA'));
select is(
  (pg_temp.sync(54, p_hold => jsonb_build_array(pg_temp.e('over_reserved', :iO), pg_temp.e('label_mismatch', :iHold))))->>'resolved',
  '0',
  'S17: a complete rule''s absent row that is HELD does not resolve');
select is(
  (select row((select resolved_at is null from public.exception_occurrences
                where organization_id = :orgA and item_id = :iO),
              (select count(*) from public.exception_occurrences where item_id = :iHold))::text),
  row(true, 0::bigint)::text,
  'S18: the held row stays open, and a held identity with no row opens nothing');

-- S19-S21: an evaluation at or before the last applied one is skipped.
-- Mutation: drop the monotonic check, and iNew opens and a row resolves.
select is(
  pg_temp.sync(60, p_extra => jsonb_build_array(pg_temp.e('label_mismatch', :iNew))),
  jsonb_build_object('skipped', true, 'lastEvaluatedAt', now() - interval '54 minutes'),
  'S19: an older evaluation is skipped and says so');
select is(
  (pg_temp.sync(54, p_extra => jsonb_build_array(pg_temp.e('label_mismatch', :iNew))))->>'skipped',
  'true',
  'S20: an evaluation at the same time is skipped too');
select is(
  (select row((select count(*) from public.exception_occurrences where item_id = :iNew),
              (select last_evaluated_at = now() - interval '54 minutes'
                 from public.exception_sync_state where organization_id = :orgA),
              (select resolved_at is null from public.exception_occurrences
                where organization_id = :orgA and item_id = :iO))::text),
  row(0::bigint, true, true)::text,
  'S21: a skipped evaluation changes nothing (no new row, clock unchanged, the absent iO row still open)');

-- S22-S29: one sync that reclassifies, retires, drops cross-org entries and
-- closes a recount pointer before resolving.
reset role;
update public.inventory_items set status = 'archived' where id = :iG;
update public.exception_occurrences set recount_cycle_count_id = :ccDone
 where organization_id = :orgA and item_id = :iR and resolved_at is null;
update public.exception_occurrences set recount_cycle_count_id = :ccOpen
 where organization_id = :orgA and item_id = :iO and resolved_at is null;
set local role to 'service_role';
insert into cur_present (tag, entry) values ('O', pg_temp.e('over_reserved', :iO));
delete from cur_present where tag in ('S', 'G', 'R');
insert into cur_present (tag, entry) values ('S-orphan', pg_temp.e('orphaned_stock', :iS, :'stA'));
select is(
  pg_temp.sync(53, p_extra => jsonb_build_array(
    pg_temp.e('over_reserved', :itemB),              -- another org's item
    pg_temp.e('orphaned_stock', :iL, :rB))),          -- this org's item at another org's location
  '{"skipped": false, "raised": 1, "seen": 10, "resolved": 3, "recountsClosed": 1, "dropped": 2}'::jsonb,
  'S22: one raised, ten seen, three resolved, one recount closed, two cross-org entries dropped');
select is(
  (select array_agg(o.rule || ':' || coalesce(o.resolved_reason, 'open') order by o.occurrence_number)
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id = :iS),
  array['stale_staging:reclassified', 'orphaned_stock:open'],
  'S23: stale_staging becomes orphaned_stock at the same holding: reclassified, and the new rule opens');
select is(
  (select resolved_reason from public.exception_occurrences where organization_id = :orgA and item_id = :iG),
  'subject_gone',
  'S24: an archived item''s row resolves as subject_gone');
select is(
  (select count(*)::int from public.exception_occurrences
    where item_id = :itemB or location_id = :rB),
  0,
  'S25: no row was opened from a cross-org entry, in either org');
select is(
  (select row(o.recount_cycle_count_id, o.resolved_reason)::text
     from public.exception_occurrences o where o.organization_id = :orgA and o.item_id = :iR),
  row(null::uuid, 'cleared')::text,
  'S26: the closed recount pointer is cleared and the row resolves');
select is(
  (select array_agg(e.kind || ':' || coalesce(e.cycle_count_id::text, '-') order by e.created_at, e.id)
     from public.exception_occurrence_events e
     join public.exception_occurrences o on o.id = e.occurrence_id
    where o.item_id = :iR),
  array['raised:-', 'recount_closed:' || :ccDone, 'resolved:-'],
  'S27: the timeline reads raised, recount_closed (naming the count), resolved');
select is(
  (select recount_cycle_count_id from public.exception_occurrences
    where organization_id = :orgA and item_id = :iO and resolved_at is null),
  :ccOpen::uuid,
  'S28: a pointer to a count still in progress is kept');
select is(
  (select max(occurrence_number) from public.exception_occurrences where organization_id = :orgA),
  15::bigint,
  'S29: numbering continues without gaps (EX-15 is the reclassified row)');

-- S30-S31: per-org numbering, and a second org's sync touches nothing of A.
select is(
  public.exceptions_sync(:orgB, now() - interval '50 minutes', array['over_reserved', 'label_mismatch'], '{}', '{}',
    jsonb_build_array(pg_temp.e('over_reserved', :itemB), pg_temp.e('label_mismatch', :iL)), '[]'),
  '{"skipped": false, "raised": 1, "seen": 0, "resolved": 0, "recountsClosed": 0, "dropped": 1}'::jsonb,
  'S30: an org B sync drops org A''s item and raises only its own');
reset role;
select is(
  (select row((select array_agg(occurrence_number) from public.exception_occurrences where organization_id = :orgB),
              (select count(*) from public.exception_occurrences where organization_id = :orgA and resolved_at is null))::text),
  row(array[1::bigint], 11::bigint)::text,
  'S31: org B''s first occurrence is its own EX-1, and org A''s eleven open rows are untouched');
set local role to 'service_role';

-- S32: two open rows for one identity with a null location conflict.
reset role;
select throws_ok(
  format($$insert into public.exception_occurrences
             (organization_id, occurrence_number, rule, item_id, location_id, first_seen_at, last_seen_at)
           values (%L, 900, 'label_mismatch', %L, null, now(), now())$$, :orgA, :iW2),
  '23505', null,
  'S32: a second open label_mismatch row for the same item conflicts on exc_occ_one_open (NULLS NOT DISTINCT)');
set local role to 'service_role';

-- S33-S36: refusals are P0001 with a hint and apply nothing.
select throws_ok(
  format($$select public.exceptions_sync(%L, now() - interval '40 minutes', '{}', '{}', '{}',
           jsonb_build_array(jsonb_build_object('rule', 'stale_staging', 'itemId', %L)), '[]')$$, :orgA, :iNew),
  'P0001', 'exceptions_sync_bad_payload: malformed present or hold entry',
  'S33: a holding rule without a location is refused');
select throws_ok(
  format($$select public.exceptions_sync(%L, now() - interval '40 minutes', array['nonsense'], '{}', '{}', '[]', '[]')$$, :orgA),
  'P0001', 'exceptions_sync_bad_payload: unknown rule name',
  'S34: an unknown rule name is refused');
select throws_ok(
  format($$select public.exceptions_sync(%L, now() + interval '1 hour', '{}', '{}', '{}', '[]', '[]')$$, :orgA),
  'P0001', 'exceptions_sync_evaluated_at_in_future',
  'S35: an evaluation dated in the future is refused (it would pin the clock)');
select is(
  (select row(tracking_started_at = now() - interval '60 minutes',
              last_evaluated_at = now() - interval '53 minutes')::text
     from public.exception_sync_state where organization_id = :orgA),
  row(true, true)::text,
  'S36: tracking_started_at is kept from the first sync; last_evaluated_at is the last applied one');
reset role;

-- ═══ A. exception_occurrence_act ══════════════════════════════════════════
select id as "occO"  from public.exception_occurrences where organization_id = :orgA and item_id = :iO and resolved_at is null \gset
select id as "occU"  from public.exception_occurrences where organization_id = :orgA and item_id = :iU and resolved_at is null \gset
select id as "occX"  from public.exception_occurrences where organization_id = :orgA and item_id = :iX and resolved_at is null \gset
select id as "occL1" from public.exception_occurrences where organization_id = :orgA and occurrence_number = 1 \gset
select id as "occW2" from public.exception_occurrences where organization_id = :orgA and item_id = :iW2 \gset
select id as "occY"  from public.exception_occurrences where organization_id = :orgA and item_id = :iY \gset

set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select is(
  (select row(r.id = :'occO'::uuid, r.acknowledged_by, r.acknowledged_at is not null, r.resolved_at)::text
     from public.exception_occurrence_act(:'occO', 'acknowledge', '  checking rack  ', 'k1') r),
  row(true, :stf::uuid, true, null::timestamptz)::text,
  'A1: staff with write access acknowledge; the row comes back stamped and still open');
select lives_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', 'checking rack', 'k1')$$, :'occO'),
  'A2: a replay of the same client_event_id succeeds');
reset role;
select is(
  (select array_agg(e.kind || ':' || coalesce(e.actor_user_id::text, 'system') || ':' || coalesce(e.note, '') || ':' || coalesce(e.client_event_id, '')
                    order by e.created_at, e.id)
     from public.exception_occurrence_events e where e.occurrence_id = :'occO'),
  array['raised:system::', 'acknowledged:' || :stf || ':checking rack:k1'],
  'A3: one acknowledged event (note trimmed); the replay added nothing');

set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select is(
  (select r.acknowledged_by from public.exception_occurrence_act(:'occO', 'acknowledge', 'second look', 'k2') r),
  :stf::uuid,
  'A4: a later acknowledgement keeps the first acknowledger');
set local "request.jwt.claim.sub" to :stf;
select lives_ok(
  format($$select public.exception_occurrence_act(%L, 'note', 'moved two to 70-B', 'k3')$$, :'occO'),
  'A5: staff add a note');
reset role;
select is(
  (select array_agg(e.kind || ':' || e.actor_user_id::text order by e.created_at, e.id)
     from public.exception_occurrence_events e where e.occurrence_id = :'occO' and e.kind = 'note'),
  array['note:' || :mgr, 'note:' || :stf],
  'A6: the second acknowledgement and the note are note events by their authors');

set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'note', '   ', null)$$, :'occO'),
  '22023', 'note_required', 'A7: a note action needs a note');
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'resolve', null, null)$$, :'occO'),
  '22023', 'invalid_action', 'A8: there is no resolve action');
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occL1'),
  'P0001', 'occurrence_resolved', 'A9: a resolved row is refused with occurrence_resolved');
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, 'k1')$$, :'occU'),
  'P0001', 'client_event_id_conflict', 'A10: a client_event_id already used on another occurrence is refused');
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occX'),
  '42501', 'forbidden', 'A11: a scope with no warehouse (org-level location) needs a manager');

set local "request.jwt.claim.sub" to :vwr;
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occU'),
  '42501', 'forbidden', 'A12: a viewer who can see the row cannot act on it');
set local "request.jwt.claim.sub" to :vwrAdj;
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occU'),
  '42501', 'forbidden', 'A12b: a viewer granted stock:adjust by override still has no write access to the warehouse');
set local "request.jwt.claim.sub" to :stfNo;
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occU'),
  '42501', 'forbidden', 'A13: staff without stock:adjust cannot act');
set local "request.jwt.claim.sub" to :stf2;
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occU'),
  'P0002', 'occurrence_not_found', 'A14: staff in another warehouse get not-found (existence is not leaked)');
set local "request.jwt.claim.sub" to :mgrB;
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occU'),
  'P0002', 'occurrence_not_found', 'A15: another org''s manager gets not-found');
set local "request.jwt.claim.sub" to '';
select throws_ok(
  format($$select public.exception_occurrence_act(%L, 'acknowledge', null, null)$$, :'occU'),
  '42501', 'not_authenticated', 'A16: no signed-in user, no action');

set local "request.jwt.claim.sub" to :mgr;
select is(
  (select r.acknowledged_by from public.exception_occurrence_act(:'occX', 'acknowledge', null, null) r),
  :mgr::uuid,
  'A17: a manager acknowledges the org-level row');
set local "request.jwt.claim.sub" to :stf;
select is(
  (select r.acknowledged_by from public.exception_occurrence_act(:'occU', 'acknowledge', 'offline tap', 'k9') r),
  :stf::uuid,
  'A18: staff acknowledge the unplaced row (client id k9)');
reset role;
select is(
  (select count(*)::int from public.exception_occurrences
    where organization_id = :orgA and resolved_at is not null and acknowledged_at is not null),
  0,
  'A19: acting never resolved anything');

-- ═══ R. RLS ═══════════════════════════════════════════════════════════════
-- Org A holds 15 rows over 13 items (EX-1..EX-15). Org B holds 1.
select is(
  (select count(*)::int from public.exception_occurrences where organization_id = :orgA),
  15, 'R0: fixture check: org A holds fifteen occurrences');

set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select is((select count(*)::int from public.exception_occurrences), 15,
  'R1: a manager sees every org A row (and none of org B)');

set local "request.jwt.claim.sub" to :stf;
select is(
  (select row(count(*), count(*) filter (where item_id in (:iW2, :iY)), count(*) filter (where item_id = :iX))::text
     from public.exception_occurrences),
  row(13::bigint, 0::bigint, 1::bigint)::text,
  'R2: warehouse A staff see 13: not the annex item, not the holding on an annex location, but the org-level location''s holding');
select is(
  (select row(count(*) filter (where occurrence_id in (:'occW2', :'occY')),
              count(*) filter (where occurrence_id = :'occO'))::text
     from public.exception_occurrence_events),
  row(0::bigint, 4::bigint)::text,
  'R3: events follow their occurrence: none of the hidden rows'' events, all four of a visible row''s');
select is(
  (select count(*)::int from public.exception_sync_state), 1,
  'R4: a member reads their own org''s sync state only');

set local "request.jwt.claim.sub" to :stf2;
select is(
  (select array_agg(item_id) from public.exception_occurrences),
  array[:iW2::uuid],
  'R5: annex staff see only the annex item''s row (warehouse B cannot see warehouse A)');
select is(
  (select count(*)::int from public.exception_occurrence_events
    where occurrence_id <> all (select id from public.exception_occurrences)),
  0,
  'R6: and no event of a row they cannot see');
select is(
  (select count(*)::int from public.exception_occurrence_events), 1,
  'R7: annex staff see exactly the one raised event of their row');

set local "request.jwt.claim.sub" to :stfCh;
select is(
  (select row(count(*), count(*) filter (where item_id = :iCh1), count(*) filter (where item_id = :iCh2))::text
     from public.exception_occurrences),
  row(12::bigint, 1::bigint, 0::bigint)::text,
  'R8: charter-scoped staff see charter-one and uncharted items, never charter two''s');

set local "request.jwt.claim.sub" to :vwrCat;
select is(
  (select array_agg(item_id) from public.exception_occurrences),
  array[:iCatX::uuid],
  'R9: a category-restricted viewer sees only their category''s items');

set local "request.jwt.claim.sub" to :vwr;
select is((select count(*)::int from public.exception_occurrences), 13,
  'R10: an unrestricted viewer reads what warehouse A staff read');

set local "request.jwt.claim.sub" to :mgrB;
select is(
  (select row((select count(*) from public.exception_occurrences where organization_id = :orgA),
              (select count(*) from public.exception_occurrence_events where organization_id = :orgA),
              (select count(*) from public.exception_sync_state where organization_id = :orgA),
              (select count(*) from public.exception_occurrences))::text),
  row(0::bigint, 0::bigint, 0::bigint, 1::bigint)::text,
  'R11: another org sees none of org A''s occurrences, events or sync state, and its own one row');
reset role;

-- A20-A21: a replay that arrives after the row resolved still answers.
set local role to 'service_role';
delete from cur_present where tag = 'U';
select is((pg_temp.sync(52))->>'resolved', '1', 'A20: the unplaced row clears on the next sync');
reset role;
set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select is(
  (select row(r.id = :'occU'::uuid, r.resolved_reason)::text
     from public.exception_occurrence_act(:'occU', 'acknowledge', 'offline tap', 'k9') r),
  row(true, 'cleared')::text,
  'A21: the phone''s late replay of k9 returns the (now resolved) row instead of an error');
reset role;
select is(
  (select count(*)::int from public.exception_occurrence_events where occurrence_id = :'occU' and kind = 'acknowledged'),
  1, 'A22: and adds nothing');

-- ═══ P. positive_since ════════════════════════════════════════════════════
select is(
  (select format_type(a.atttypid, a.atttypmod) || ':' || (not a.attnotnull)::text
     from pg_attribute a where a.attrelid = 'public.item_stock_levels'::regclass and a.attname = 'positive_since'),
  'timestamp with time zone:true',
  'P1: item_stock_levels.positive_since is a nullable timestamptz');
select is(
  (select array_agg(t.tgname::text order by t.tgname)
     from pg_trigger t
    where t.tgrelid = 'public.item_stock_levels'::regclass and not t.tgisinternal
      and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2),
  array['item_stock_levels_set_updated_at', 'trg_item_stock_levels_positive_since', 'trg_zz_item_stock_levels_guard'],
  'P2: the stamp is a BEFORE ROW trigger that fires before the S1 guard (name order)');
select ok(
  (select not p.prosecdef and 'search_path=public' = any (p.proconfig)
          and p.prosrc !~* '\m(select|from|perform)\M'
     from pg_proc p where p.oid = 'public.tg_item_stock_levels_positive_since()'::regprocedure),
  'P3: the trigger function is SECURITY INVOKER, pinned, and reads nothing');

-- Direct writes as the owner (the guard exempts it), to pin the semantics.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity, positive_since)
  values (:orgA, :pI, :rA1, 5, '2001-01-01');
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity, positive_since)
  values (:orgA, :pI, :rA2, 0, '2001-01-01');
select is(
  array[pg_temp.ps(:pI, :rA1) = now(), pg_temp.ps(:pI, :rA2) is null],
  array[true, true],
  'P4: an insert with stock is stamped now, an empty insert is null, and a supplied value is ignored on both');
select pg_temp.plant(array[:pI]::uuid[]);
update public.item_stock_levels set quantity = 8 where item_id = :pI and location_id = :rA1;
select is(pg_temp.ps(:pI, :rA1), '2020-01-01 00:00:00+00'::timestamptz,
  'P5: a top-up keeps the age (mutation: stamp on every update)');
update public.item_stock_levels set quantity = 3 where item_id = :pI and location_id = :rA1;
select is(pg_temp.ps(:pI, :rA1), '2020-01-01 00:00:00+00'::timestamptz,
  'P6: a partial draw keeps the age');
update public.item_stock_levels set positive_since = '2001-01-01' where item_id = :pI and location_id = :rA1;
select is(pg_temp.ps(:pI, :rA1), '2020-01-01 00:00:00+00'::timestamptz,
  'P7: writing the column directly changes nothing');
update public.item_stock_levels set quantity = 0 where item_id = :pI and location_id = :rA1;
select is(pg_temp.ps(:pI, :rA1), null::timestamptz, 'P8: empty is null');
update public.item_stock_levels set quantity = 4, positive_since = '2001-01-01' where item_id = :pI and location_id = :rA1;
select is(pg_temp.ps(:pI, :rA1), now(), 'P9: a refill starts a new age (and the supplied value is ignored)');

set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select throws_ok(
  format($$update public.item_stock_levels set positive_since = '2001-01-01' where item_id = %L$$, :pI),
  '42501', 'ledger_only',
  'P10: the S1 guard still refuses a direct API write that touches only positive_since');
select throws_ok(
  format($$update public.item_stock_levels set quantity = 99 where item_id = %L$$, :pI),
  '42501', 'ledger_only',
  'P11: and a direct quantity write (the trigger does not open a path around the guard)');
reset role;

-- ── Ledger writers ────────────────────────────────────────────────────────
-- post_receipt_v2 (adjust_stock into Staging): a top-up keeps the age, a new
-- holding starts one. reverse_receipt (adjust_stock, no location,
-- staging_first): a holding that stays stocked keeps its age, one emptied is
-- null.
create temp table rcpt (id uuid) on commit drop;
grant all on rcpt to authenticated;
set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select lives_ok(
  format($$insert into rcpt select (public.post_receipt_v2(%L, %L,
             jsonb_build_array(
               jsonb_build_object('po_line_id', %L, 'qty_received', 2, 'qty_accepted', 2, 'qty_rejected', 0, 'unit_cost', 1),
               jsonb_build_object('po_line_id', %L, 'qty_received', 2, 'qty_accepted', 2, 'qty_rejected', 0, 'unit_cost', 1)),
             'key-0370', 'hash-0370')).id$$, :poW, :whA, :polRC, :polRN),
  'W1: a manager posts a receipt');
reset role;
select is(
  array[pg_temp.ps(:pRC, :'stA') = '2020-01-01 00:00:00+00'::timestamptz,
        pg_temp.ps(:pRN, :'stA') = now()],
  array[true, true],
  'W2: post_receipt_v2: the topped-up Staging holding keeps its age, the new one is stamped now');
set local role to 'authenticated';
select lives_ok(
  $$select public.reverse_receipt((select id from rcpt), '0370 reversal')$$,
  'W3: the manager reverses it');
reset role;
select is(
  array[pg_temp.ps(:pRC, :'stA') = '2020-01-01 00:00:00+00'::timestamptz,
        pg_temp.ps(:pRN, :'stA') is null],
  array[true, true],
  'W4: reverse_receipt: the holding still stocked keeps its age, the emptied one is null');

-- adjust_stock directly (the phone's path), as staff.
set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L::uuid, 3, 'add', %L::uuid, 'probe')$$, :pAJ, :rA1),
  'W5: staff add 3 at a rack');
reset role;
select is(pg_temp.ps(:pAJ, :rA1), '2020-01-01 00:00:00+00'::timestamptz, 'W6: adjust_stock top-up keeps the age');
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L::uuid, -7, 'remove', %L::uuid, 'probe')$$, :pAJ, :rA1),
  'W7: staff remove all 7 from the rack');
select lives_ok(format($$select public.adjust_stock(%L::uuid, 2, 'add', null, 'probe')$$, :pAJ),
  'W8: staff add 2 with no location (lands in Staging)');
reset role;
select is(
  array[pg_temp.ps(:pAJ, :rA1) is null, pg_temp.ps(:pAJ, :'stA') = now()],
  array[true, true],
  'W9: adjust_stock: the emptied rack is null, the new Staging holding is stamped now');

-- transfer_stock, both sides.
set local role to 'authenticated';
select lives_ok(format($$select public.transfer_stock(%L::uuid, %L::uuid, %L::uuid, 3)$$, :pTR, :rA1, :rA2),
  'W10: staff move all 3 from 70-A to 70-B');
select lives_ok(format($$select public.transfer_stock(%L::uuid, %L::uuid, %L::uuid, 1)$$, :pTR, :rA2, :rA3),
  'W11: staff move 1 from 70-B to the empty 70-C');
reset role;
select is(
  array[pg_temp.ps(:pTR, :rA1) is null,
        pg_temp.ps(:pTR, :rA2) = '2020-01-01 00:00:00+00'::timestamptz,
        pg_temp.ps(:pTR, :rA3) = now()],
  array[true, true, true],
  'W12: transfer_stock: the emptied source is null, the topped-up and partly drawn one keeps its age, the new destination is stamped now');

-- post_cycle_count. Counted-location path (one shelf holding): +2 tops the
-- rack up, 0 empties it. Staging path (two shelf holdings, no counted
-- location): +2 lands in Staging, -3 drains Staging first.
set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 12, counted_by = :mgr, counted_at = now() where id = :lnCL1;
update public.cycle_count_lines set counted_quantity = 0,  counted_by = :mgr, counted_at = now() where id = :lnCL2;
update public.cycle_count_lines set counted_quantity = 12, counted_by = :mgr, counted_at = now() where id = :lnCS;
update public.cycle_count_lines set counted_quantity = 10, counted_by = :mgr, counted_at = now() where id = :lnCS2;
reset role;
select is(
  (select array_agg(coalesce(counted_location_id::text, 'staging') order by id)
     from public.cycle_count_lines where cycle_count_id = :ccW),
  array[:rA1, :rA2, 'staging', 'staging']::text[],
  'W13: fixture check: two lines route to their rack, two to Staging');
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccW), 'W14: the manager posts the count');
reset role;
select is(
  array[pg_temp.ps(:pCL1, :rA1) = '2020-01-01 00:00:00+00'::timestamptz,
        pg_temp.ps(:pCL2, :rA2) is null],
  array[true, true],
  'W15: post_cycle_count, counted location: the topped-up rack keeps its age, the emptied rack is null');
select is(
  array[pg_temp.ps(:pCS, :'stA') = now(),
        pg_temp.ps(:pCS, :rA1) = '2020-01-01 00:00:00+00'::timestamptz,
        pg_temp.ps(:pCS2, :'stA') is null,
        pg_temp.ps(:pCS2, :rA2) = '2020-01-01 00:00:00+00'::timestamptz],
  array[true, true, true, true],
  'W16: post_cycle_count, Staging path: a found surplus starts a Staging age, a loss empties Staging to null, racks untouched keep theirs');

-- assemble_bundle and distribute_bundle.
set local role to 'authenticated';
select lives_ok(format($$select public.assemble_bundle(%L::uuid, 1, %L::uuid, '0370')$$, :bdl, :whA),
  'W17: the manager assembles one kit');
reset role;
select phantom_item_id as "phantom" from public.bundles where id = :bdl \gset
select is(
  array[pg_temp.ps(:compA, :rA3) = '2020-01-01 00:00:00+00'::timestamptz,
        pg_temp.ps(:compB, :rA3) is null,
        pg_temp.ps(:'phantom', :'stA') = now()],
  array[true, true, true],
  'W18: assemble_bundle: a part drawn partly keeps its age, a part used up is null, the kit''s Staging holding is stamped now');
set local role to 'authenticated';
select lives_ok(format($$select public.distribute_bundle(%L::uuid, 1, %L::uuid, false)$$, :bdl, :whA),
  'W19: the manager distributes the kit');
reset role;
select is(pg_temp.ps(:'phantom', :'stA'), null::timestamptz,
  'W20: distribute_bundle: the kit''s emptied Staging holding is null');

-- process_return_disposition: restock lands in Staging (new holding: now);
-- scrap is +n then -n from Staging (a stocked holding keeps its age).
set local role to 'authenticated';
insert into public.returns (id, organization_id, order_request_id, status) values
  (:retRR, :orgA, :ordW, 'received'),
  (:retRS, :orgA, :ordW, 'received');
insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values
  (:retRR, :orgA, :olRR, :pRR, 3, 'restock'),
  (:retRS, :orgA, :olRS, :pRS, 4, 'scrap');
select lives_ok(format($$select public.process_return_disposition(%L::uuid)$$, :retRR),
  'W21: the manager restocks a return');
select lives_ok(format($$select public.process_return_disposition(%L::uuid)$$, :retRS),
  'W22: the manager scraps a return');
reset role;
select is(
  array[pg_temp.ps(:pRR, :'stA') = now(),
        pg_temp.ps(:pRS, :'stA') = '2020-01-01 00:00:00+00'::timestamptz,
        (select quantity from public.item_stock_levels where item_id = :pRS and location_id = :'stA') = 100],
  array[true, true, true],
  'W23: process_return_disposition: a restock starts a Staging age; a scrap (net zero) keeps the old one');

-- ═══ B. Backfill ══════════════════════════════════════════════════════════
-- Plant legacy rows: no positive_since and an old updated_at, with both
-- triggers off for the plant.
alter table public.item_stock_levels disable trigger item_stock_levels_set_updated_at;
alter table public.item_stock_levels disable trigger trg_item_stock_levels_positive_since;
update public.item_stock_levels set positive_since = null, updated_at = '2021-06-01 00:00:00+00'
 where item_id = :pBF1;
update public.item_stock_levels set positive_since = null, updated_at = '2021-06-02 00:00:00+00'
 where item_id = :pBF2;
update public.item_stock_levels set positive_since = '2022-01-01 00:00:00+00', updated_at = '2021-06-03 00:00:00+00'
 where item_id = :pBF3;
alter table public.item_stock_levels enable trigger trg_item_stock_levels_positive_since;
alter table public.item_stock_levels enable trigger item_stock_levels_set_updated_at;

select cmp_ok(public._backfill_item_stock_levels_positive_since(), '>=', 1::bigint,
  'B1: the backfill stamps at least the planted legacy row');
select is(
  (select row(positive_since, updated_at)::text from public.item_stock_levels where item_id = :pBF1),
  row('2021-06-01 00:00:00+00'::timestamptz, '2021-06-01 00:00:00+00'::timestamptz)::text,
  'B2: a positive legacy holding gets positive_since = updated_at, and updated_at is unchanged (mutation: forget to disable the trigger)');
select is(
  (select row(positive_since, updated_at)::text from public.item_stock_levels where item_id = :pBF2),
  row(null::timestamptz, '2021-06-02 00:00:00+00'::timestamptz)::text,
  'B3: an empty holding stays null and untouched');
select is(
  (select positive_since from public.item_stock_levels where item_id = :pBF3),
  '2022-01-01 00:00:00+00'::timestamptz,
  'B4: a holding that already has a value keeps it (the backfill is idempotent)');
select is(
  (select array_agg(t.tgname::text || ':' || t.tgenabled::text order by t.tgname)
     from pg_trigger t
    where t.tgrelid = 'public.item_stock_levels'::regclass and not t.tgisinternal),
  array['item_stock_levels_set_updated_at:O', 'trg_item_stock_levels_positive_since:O', 'trg_zz_item_stock_levels_guard:O'],
  'B5: every trigger is back on after the backfill');
select ok(
  not has_function_privilege('authenticated', 'public._backfill_item_stock_levels_positive_since()', 'EXECUTE')
  and not has_function_privilege('anon', 'public._backfill_item_stock_levels_positive_since()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public._backfill_item_stock_levels_positive_since()', 'EXECUTE'),
  'B6: the backfill helper has no API grants');
select is(
  (select count(*)::int from public.item_stock_levels where quantity > 0 and positive_since is null),
  0,
  'B7: no stocked holding is left without positive_since');

select * from finish();
rollback;
