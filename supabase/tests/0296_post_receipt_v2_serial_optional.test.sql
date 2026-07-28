-- supabase/tests/0296_post_receipt_v2_serial_optional.test.sql
--
-- Proves the SIXTH rewrite of post_receipt_v2 changed exactly one thing.
--
-- Structure:
--   Assertions 1-2   grant + fixture anti-vacuity
--   Assertions 3-6   REGRESSION R1: tracking_type='serial' is byte-identical
--                    (serials_required on null, serial_count_mismatch on the
--                    wrong count, success on the exact count, registry rows)
--   Assertions 7-9   REGRESSION: tracking_type='lot' unchanged
--   Assertions 10-12 REGRESSION: tracking_type='none' unchanged, and 0285's
--                    over-receipt allowance survives
--   Assertions 13-18 NEW: 'serial_optional' accepts null / empty / partial /
--                    full, rejects an over-count, and posts quantity in every
--                    case (the ledger invariant holds)
--   Assertions 19-20 duplicate-serial handling is IDENTICAL for 'serial' and
--                    'serial_optional': both reach the same
--                    serial_registry (organization_id, item_id, serial_number)
--                    unique constraint and raise 23505. serial_optional does
--                    NOT get a softer duplicate rule.
--
-- Anti-vacuity: assertion 2 proves the optional fixture really carries the new
-- tracking_type, so 13-18 cannot pass by silently exercising a 'none' item.
-- The negative control (0285's body re-created over 0296's on a scratch
-- database) is recorded in .superpowers/sdd/sports-task-3-report.md.
--
-- Namespace: d0296000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(20);

\set org      '\'d0296000-0000-0000-0000-000000000001\''
\set mgr      '\'d0296000-0000-0000-0000-000000000002\''
\set wh       '\'d0296000-0000-0000-0000-000000000003\''
\set itemSer  '\'d0296000-0000-0000-0000-000000000004\''
\set itemLot  '\'d0296000-0000-0000-0000-000000000005\''
\set itemNone '\'d0296000-0000-0000-0000-000000000006\''
\set itemOpt  '\'d0296000-0000-0000-0000-000000000007\''
\set po       '\'d0296000-0000-0000-0000-000000000008\''
\set lineSer  '\'d0296000-0000-0000-0000-000000000009\''
\set lineLot  '\'d0296000-0000-0000-0000-000000000010\''
\set lineNone '\'d0296000-0000-0000-0000-000000000011\''
\set lineOpt1 '\'d0296000-0000-0000-0000-000000000012\''
\set lineOpt2 '\'d0296000-0000-0000-0000-000000000013\''
\set lineOpt3 '\'d0296000-0000-0000-0000-000000000014\''
\set lineOpt4 '\'d0296000-0000-0000-0000-000000000015\''
\set lineSer2 '\'d0296000-0000-0000-0000-000000000016\''
\set lineOpt5 '\'d0296000-0000-0000-0000-000000000017\''

insert into auth.users (id, email) values (:mgr, 'mgr-0296@example.test')
  on conflict (id) do nothing;
-- organizations.slug and warehouses.code are NOT NULL with no default (verified
-- against information_schema on the reset database), so both must be supplied.
insert into public.organizations (id, name, slug)
  values (:org, 'Receipt 0296 Org', 'receipt-0296-org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;
-- The warehouse insert trigger auto-creates this warehouse's Staging and
-- Unplaced locations, which is what post_receipt_v2 routes accepted qty into.
insert into public.warehouses (id, organization_id, name, code)
  values (:wh, :org, 'WH 0296', 'WH-0296') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values
  (:itemSer,  :org, :wh, 'R96-SER',  'Serial Item',     0, 'active', 'serial'),
  (:itemLot,  :org, :wh, 'R96-LOT',  'Lot Item',        0, 'active', 'lot'),
  (:itemNone, :org, :wh, 'R96-NONE', 'Plain Item',      0, 'active', 'none'),
  (:itemOpt,  :org, :wh, 'R96-OPT',  'Optional Serial', 0, 'active', 'serial_optional')
on conflict (id) do nothing;

delete from public.item_stock_levels
  where item_id in (:itemSer, :itemLot, :itemNone, :itemOpt);

insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po, :org, 'PO-0296-1', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
values
  (:lineSer,  :org, :po, :itemSer,  100, 0, 1),
  (:lineLot,  :org, :po, :itemLot,  100, 0, 1),
  (:lineNone, :org, :po, :itemNone, 10,  0, 1),
  (:lineOpt1, :org, :po, :itemOpt,  100, 0, 1),
  (:lineOpt2, :org, :po, :itemOpt,  100, 0, 1),
  (:lineOpt3, :org, :po, :itemOpt,  100, 0, 1),
  (:lineOpt4, :org, :po, :itemOpt,  100, 0, 1),
  (:lineSer2, :org, :po, :itemSer,  100, 0, 1),
  (:lineOpt5, :org, :po, :itemOpt,  100, 0, 1)
on conflict (id) do nothing;

-- ── 1. Grant unchanged across the rewrite ───────────────────────────────────
select ok(
  has_function_privilege('authenticated',
    'public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)', 'EXECUTE'),
  'authenticated can still EXECUTE post_receipt_v2 (grant survives the 6th rewrite)');

-- ── 2. Anti-vacuity: the optional item really carries the new value ─────────
select is(
  (select tracking_type from public.inventory_items where id = :itemOpt),
  'serial_optional',
  'fixture check: the optional item is really on tracking_type ''serial_optional''');

set local "request.jwt.claim.sub" to 'd0296000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 3-6. REGRESSION R1: 'serial' behaviour is IDENTICAL ─────────────────────
select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000009',
         'qty_received',3,'qty_accepted',3,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-ser-null','hash-0296-ser-null',null) $$,
  '23514',
  'serials_required',
  'R1: a serial item receiving qty>0 with NO serials is still BLOCKED');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000009',
         'qty_received',3,'qty_accepted',3,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('SN-A','SN-B'))),
       'idem-0296-ser-short','hash-0296-ser-short',null) $$,
  '23514',
  'serial_count_mismatch',
  'R1: a serial item with the WRONG serial count is still BLOCKED');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000009',
         'qty_received',3,'qty_accepted',3,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('SN-A','SN-B','SN-C'))),
       'idem-0296-ser-ok','hash-0296-ser-ok',null) $$,
  'R1: a serial item with exactly qty_accepted serials still succeeds');

select is(
  (select count(*)::int from public.serial_registry where item_id = :itemSer),
  3,
  'R1: three serial_registry rows were written, one per unit');

-- ── 7-9. REGRESSION: 'lot' behaviour is IDENTICAL ───────────────────────────
select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000010',
         'qty_received',5,'qty_accepted',5,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-lot-null','hash-0296-lot-null',null) $$,
  '23514',
  'lot_required',
  'lot item with no lots is still BLOCKED');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000010',
         'qty_received',5,'qty_accepted',5,'qty_rejected',0,'unit_cost',1,
         'lots', jsonb_build_array(jsonb_build_object(
           'lot_number','L1','expiration_date','2027-01-01','qty_base',2)))),
       'idem-0296-lot-short','hash-0296-lot-short',null) $$,
  '23514',
  'lot_qty_mismatch',
  'lot quantities that do not sum to qty_accepted are still BLOCKED');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000010',
         'qty_received',5,'qty_accepted',5,'qty_rejected',0,'unit_cost',1,
         'lots', jsonb_build_array(jsonb_build_object(
           'lot_number','L1','expiration_date','2027-01-01','qty_base',5)))),
       'idem-0296-lot-ok','hash-0296-lot-ok',null) $$,
  'a lot receipt whose lots sum correctly still succeeds');

-- ── 10-12. REGRESSION: 'none', over-receipt (0285), and the ledger ──────────
select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000011',
         'qty_received',25,'qty_accepted',25,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-over','hash-0296-over',null) $$,
  '0285 over-receipt allowance survives: 25 accepted against 10 ordered still posts');

select is(
  (select quantity_on_hand from public.inventory_items where id = :itemNone),
  25::numeric,
  'the over-received quantity landed on quantity_on_hand');

select is(
  (select coalesce(sum(quantity_change), 0) from public.stock_movements
     where item_id = 'd0296000-0000-0000-0000-000000000006'::uuid),
  25::numeric,
  'LEDGER INVARIANT: SUM(stock_movements) equals quantity_on_hand for the plain item');

-- ── 13-18. NEW: 'serial_optional' ───────────────────────────────────────────
select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000012',
         'qty_received',4,'qty_accepted',4,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-opt-null','hash-0296-opt-null',null) $$,
  'serial_optional accepts a receipt with NO serials at all (no fake placeholders needed)');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000013',
         'qty_received',4,'qty_accepted',4,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array())),
       'idem-0296-opt-empty','hash-0296-opt-empty',null) $$,
  'serial_optional accepts an EMPTY serials array (which ''serial'' would reject)');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000014',
         'qty_received',4,'qty_accepted',4,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('OPT-1','OPT-2'))),
       'idem-0296-opt-partial','hash-0296-opt-partial',null) $$,
  'serial_optional accepts a PARTIAL tagging (2 serials against 4 units)');

select is(
  (select count(*)::int from public.serial_registry where item_id = :itemOpt),
  2,
  'exactly the two supplied serials were registered — the untagged 2 units created no rows');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000015',
         'qty_received',2,'qty_accepted',2,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('OPT-X','OPT-Y','OPT-Z'))),
       'idem-0296-opt-over','hash-0296-opt-over',null) $$,
  '23514',
  'serial_count_exceeds_quantity',
  'serial_optional REJECTS more serials than accepted units (no double-counting)');

select is(
  (select quantity_on_hand from public.inventory_items where id = :itemOpt),
  12::numeric,
  'LEDGER INVARIANT: all three successful optional receipts (4+4+4) posted quantity');

-- ── 19-20. Duplicate serials behave the SAME under both serial modes ────────
-- Both counts satisfy their own validation rule (2 = 2 for 'serial';
-- 2 <= 2 for 'serial_optional'), so both reach the insert loop and both hit
-- serial_registry_organization_id_item_id_serial_number_key. serial_optional
-- must NOT be a softer path for duplicates — that is the case the receiving
-- service now maps to a 'conflict' ServiceError.
select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000016',
         'qty_received',2,'qty_accepted',2,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('SN-D','SN-D'))),
       'idem-0296-ser-dup','hash-0296-ser-dup',null) $$,
  '23505',
  null,
  'baseline: a repeated serial on a ''serial'' item violates the registry unique key');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000017',
         'qty_received',2,'qty_accepted',2,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('OPT-D','OPT-D'))),
       'idem-0296-opt-dup','hash-0296-opt-dup',null) $$,
  '23505',
  null,
  'serial_optional raises the SAME 23505 on a repeated serial — no softer duplicate rule');

select * from finish();
rollback;
