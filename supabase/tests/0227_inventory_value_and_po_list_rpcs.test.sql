-- supabase/tests/0227_inventory_value_and_po_list_rpcs.test.sql
-- Proves migration 0227: the three scale-audit RPCs —
--   inventory_value_on_hand   (service-role only, mirrors 0223/0225 posture)
--   purchase_orders_stats     (SECURITY INVOKER + authenticated, mirrors 0224)
--   purchase_orders_page      (SECURITY INVOKER + authenticated, mirrors 0224)
-- For each:
--   • exists with the declared signature,
--   • SECURITY INVOKER with search_path pinned to public,
--   • privilege matrix (value fn: anon/authenticated NO execute, service_role
--     yes; PO fns: anon NO execute, authenticated yes),
--   • live probes (42501 for revoked roles; authenticated non-member gets an
--     all-zero stats row via RLS — the real cross-org defense),
--   • behavioral: hand-computed aggregates over seeded fixtures, including
--     every predicate leg (item_type / status / deleted_at / is_rental /
--     warehouse for the value fn; tab statuses / q over po_number + supplier
--     label with %/_ escaping / warehouse EXISTS / sort / limit-offset /
--     line_count / filtered_count for the PO fns) and cross-org isolation.
--
-- now() = transaction_timestamp() is constant across this begin/rollback
-- block, so seeded offsets and the stats function's own 90-day lead window
-- share one instant — window membership below is exact, not racy.
--
-- Namespace: ac022700 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(36);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- Org A = the org under test; org B = isolation + ilike-escape fixtures.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.organizations (id, name, slug) values
  ('ac022700-0000-0000-0000-000000000001', 'Value/PO Scale Org A', 'value-po-a-0227'),
  ('ac022700-0000-0000-0000-000000000002', 'Value/PO Scale Org B', 'value-po-b-0227')
  on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac022700-0000-0000-0000-000000000003', 'ac022700-0000-0000-0000-000000000001', 'WH A1', 'WH-A1-0227', 'active'),
  ('ac022700-0000-0000-0000-000000000004', 'ac022700-0000-0000-0000-000000000001', 'WH A2', 'WH-A2-0227', 'active'),
  ('ac022700-0000-0000-0000-000000000005', 'ac022700-0000-0000-0000-000000000002', 'WH B',  'WH-B-0227',  'active')
  on conflict (id) do nothing;

-- Locations: L1 → WH A1, L2 → WH A2, L3 has NO warehouse (a PO destined there
-- must vanish under any warehouse scoping — parity with the !inner embed).
insert into public.locations (id, organization_id, name, type, warehouse_id) values
  ('ac022700-0000-0000-0000-000000000006', 'ac022700-0000-0000-0000-000000000001', 'Dock A1', 'warehouse', 'ac022700-0000-0000-0000-000000000003'),
  ('ac022700-0000-0000-0000-000000000007', 'ac022700-0000-0000-0000-000000000001', 'Dock A2', 'warehouse', 'ac022700-0000-0000-0000-000000000004'),
  ('ac022700-0000-0000-0000-000000000008', 'ac022700-0000-0000-0000-000000000001', 'Floating', 'other', null)
  on conflict (id) do nothing;

-- Suppliers: Acme (live) + Zenith (DELETED — its POs must render/search as
-- the '—' placeholder exactly like the JS supplier-map miss).
insert into public.suppliers (id, organization_id, name, deleted_at) values
  ('ac022700-0000-0000-0000-000000000009', 'ac022700-0000-0000-0000-000000000001', 'Acme Corp', null),
  ('ac022700-0000-0000-0000-00000000000a', 'ac022700-0000-0000-0000-000000000001', 'Zenith Ltd', now() - interval '1 day')
  on conflict (id) do nothing;

-- inventory_value_on_hand fixtures. Every predicate leg gets a row that would
-- perturb the hand-computed sums if that leg regressed:
--   P1 product/active/WH A1  10 × 2   = 20   (counted; warehouse-narrowable)
--   P2 product/active/WH A2   4 × 2.5 = 10   (counted in 'all', not in WH A1)
--   B1 book/active            3 × 5   = 15   (book view only)
--   P3 product/ARCHIVED     100 × 1          (excluded: status)
--   P4 product/DELETED      100 × 1          (excluded: deleted_at)
--   P5 product/RENTAL       100 × 1          (excluded: is_rental)
--   Org B product             9 × 9   = 81   (isolation)
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost,
   status, tracking_type, item_type, is_rental, deleted_at)
values
  ('ac022700-0000-0000-0000-000000000010', 'ac022700-0000-0000-0000-000000000001',
   'ac022700-0000-0000-0000-000000000003', 'VP-P1', 'Prod 1', 10, 2,   'active',   'none', 'product', false, null),
  ('ac022700-0000-0000-0000-000000000011', 'ac022700-0000-0000-0000-000000000001',
   'ac022700-0000-0000-0000-000000000004', 'VP-P2', 'Prod 2', 4,  2.5, 'active',   'none', 'product', false, null),
  ('ac022700-0000-0000-0000-000000000012', 'ac022700-0000-0000-0000-000000000001',
   'ac022700-0000-0000-0000-000000000003', 'VP-B1', 'Book 1', 3,  5,   'active',   'none', 'book',    false, null),
  ('ac022700-0000-0000-0000-000000000013', 'ac022700-0000-0000-0000-000000000001',
   'ac022700-0000-0000-0000-000000000003', 'VP-P3', 'Prod 3', 100, 1,  'archived', 'none', 'product', false, null),
  ('ac022700-0000-0000-0000-000000000014', 'ac022700-0000-0000-0000-000000000001',
   'ac022700-0000-0000-0000-000000000003', 'VP-P4', 'Prod 4', 100, 1,  'active',   'none', 'product', false, now() - interval '1 hour'),
  ('ac022700-0000-0000-0000-000000000015', 'ac022700-0000-0000-0000-000000000001',
   'ac022700-0000-0000-0000-000000000003', 'VP-P5', 'Prod 5', 100, 1,  'active',   'none', 'product', true,  null),
  ('ac022700-0000-0000-0000-000000000016', 'ac022700-0000-0000-0000-000000000002',
   'ac022700-0000-0000-0000-000000000005', 'VP-PB', 'Prod B', 9,  9,   'active',   'none', 'product', false, null)
  on conflict (id) do nothing;

-- Purchase orders (org A). created_at offsets give a deterministic
-- created_at DESC, id ASC order: 1006, 1008, 1004, 1003, 1002, 1001, 1005, 1007.
-- Hand-computed stats (no warehouse scope):
--   total_count 8, total_value 100+200+50+400+300+60+70+900 = 2080
--   open  = {1001 draft, 1002 ordered, 1003 expected_inbound,
--            1004 partially_received} → open_count 4, committed 750,
--            distinct open suppliers {Acme, Zenith} = 2
--   inbound = {1002, 1003, 1004} → 3; next ETA = 1003 (now+2d earliest)
--   avg lead (received within 90d): 1005 = (−5d) − (−15d) = 10 d;
--            1006 (NULL ordered_at → created_at fallback) = (−1d) − (−5d) = 4 d;
--            1007 received 100d ago → OUT of window. avg = 7.
insert into public.purchase_orders
  (id, organization_id, po_number, supplier_id, destination_location_id, status,
   expected_at, ordered_at, received_at, total, created_at)
values
  ('ac022700-0000-0000-0000-000000000021', 'ac022700-0000-0000-0000-000000000001',
   'PO-1001', 'ac022700-0000-0000-0000-000000000009', 'ac022700-0000-0000-0000-000000000006',
   'draft', null, null, null, 100, now() - interval '10 days'),
  ('ac022700-0000-0000-0000-000000000022', 'ac022700-0000-0000-0000-000000000001',
   'PO-1002', 'ac022700-0000-0000-0000-000000000009', 'ac022700-0000-0000-0000-000000000006',
   'ordered', now() + interval '5 days', now() - interval '9 days', null, 200, now() - interval '9 days'),
  ('ac022700-0000-0000-0000-000000000023', 'ac022700-0000-0000-0000-000000000001',
   'PO-1003', null, 'ac022700-0000-0000-0000-000000000008',
   'expected_inbound', now() + interval '2 days', null, null, 50, now() - interval '8 days'),
  ('ac022700-0000-0000-0000-000000000024', 'ac022700-0000-0000-0000-000000000001',
   'PO-1004', 'ac022700-0000-0000-0000-00000000000a', 'ac022700-0000-0000-0000-000000000007',
   'partially_received', now() + interval '9 days', null, null, 400, now() - interval '7 days'),
  ('ac022700-0000-0000-0000-000000000025', 'ac022700-0000-0000-0000-000000000001',
   'PO-1005', null, 'ac022700-0000-0000-0000-000000000006',
   'received', null, now() - interval '15 days', now() - interval '5 days', 300, now() - interval '15 days'),
  ('ac022700-0000-0000-0000-000000000026', 'ac022700-0000-0000-0000-000000000001',
   'PO-1006', null, 'ac022700-0000-0000-0000-000000000007',
   'received', null, null, now() - interval '1 day', 60, now() - interval '5 days'),
  ('ac022700-0000-0000-0000-000000000027', 'ac022700-0000-0000-0000-000000000001',
   'PO-1007', null, null,
   'received', null, now() - interval '110 days', now() - interval '100 days', 70, now() - interval '110 days'),
  ('ac022700-0000-0000-0000-000000000028', 'ac022700-0000-0000-0000-000000000001',
   'PO-1008', null, null,
   'cancelled', null, null, null, 900, now() - interval '6 days'),
  -- Org B: isolation + ilike-escape fixture (its po_number carries literal
  -- '_' and '%' — the JS .includes() treated them literally, so must ILIKE).
  ('ac022700-0000-0000-0000-000000000029', 'ac022700-0000-0000-0000-000000000002',
   'PO-WILD_50%', null, null,
   'ordered', null, null, null, 777, now() - interval '1 day')
  on conflict (id) do nothing;

-- Two lines on PO-1002 → line_count 2 (the embed-count parity check).
insert into public.purchase_order_items
  (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
values
  ('ac022700-0000-0000-0000-000000000001', 'ac022700-0000-0000-0000-000000000022',
   'ac022700-0000-0000-0000-000000000010', 5, 2),
  ('ac022700-0000-0000-0000-000000000001', 'ac022700-0000-0000-0000-000000000022',
   'ac022700-0000-0000-0000-000000000011', 3, 2.5);

-- ═════════════════════════════════════════════════════════════════════════════
-- SHAPE + PRIVILEGE MATRIX (16)
-- ═════════════════════════════════════════════════════════════════════════════

-- inventory_value_on_hand(uuid, text, uuid) — service-role only ─────────────
select has_function('public', 'inventory_value_on_hand',
  array['uuid', 'text', 'uuid'], 'inventory_value_on_hand exists');
select is((select prosecdef from pg_proc
  where oid = 'public.inventory_value_on_hand(uuid, text, uuid)'::regprocedure),
  false, 'inventory_value_on_hand is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.inventory_value_on_hand(uuid, text, uuid)'::regprocedure),
  'inventory_value_on_hand search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.inventory_value_on_hand(uuid, text, uuid)', 'execute'),
  'inventory_value_on_hand: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.inventory_value_on_hand(uuid, text, uuid)', 'execute'),
  'inventory_value_on_hand: authenticated has no EXECUTE (no cross-org oracle)');
select ok(has_function_privilege('service_role',
  'public.inventory_value_on_hand(uuid, text, uuid)', 'execute'),
  'inventory_value_on_hand: service_role has EXECUTE');

-- purchase_orders_stats(uuid, uuid[]) — invoker + authenticated ─────────────
select has_function('public', 'purchase_orders_stats',
  array['uuid', 'uuid[]'], 'purchase_orders_stats exists');
select is((select prosecdef from pg_proc
  where oid = 'public.purchase_orders_stats(uuid, uuid[])'::regprocedure),
  false, 'purchase_orders_stats is SECURITY INVOKER (RLS binds the caller)');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.purchase_orders_stats(uuid, uuid[])'::regprocedure),
  'purchase_orders_stats search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.purchase_orders_stats(uuid, uuid[])', 'execute'),
  'purchase_orders_stats: anon has no EXECUTE');
select ok(has_function_privilege('authenticated',
  'public.purchase_orders_stats(uuid, uuid[])', 'execute'),
  'purchase_orders_stats: authenticated holds EXECUTE (RLS-scoped user client)');

-- purchase_orders_page(uuid, uuid[], text[], text, int, int) ────────────────
select has_function('public', 'purchase_orders_page',
  array['uuid', 'uuid[]', 'text[]', 'text', 'integer', 'integer'],
  'purchase_orders_page exists');
select is((select prosecdef from pg_proc
  where oid = 'public.purchase_orders_page(uuid, uuid[], text[], text, integer, integer)'::regprocedure),
  false, 'purchase_orders_page is SECURITY INVOKER (RLS binds the caller)');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.purchase_orders_page(uuid, uuid[], text[], text, integer, integer)'::regprocedure),
  'purchase_orders_page search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.purchase_orders_page(uuid, uuid[], text[], text, integer, integer)', 'execute'),
  'purchase_orders_page: anon has no EXECUTE');
select ok(has_function_privilege('authenticated',
  'public.purchase_orders_page(uuid, uuid[], text[], text, integer, integer)', 'execute'),
  'purchase_orders_page: authenticated holds EXECUTE (RLS-scoped user client)');

-- ═════════════════════════════════════════════════════════════════════════════
-- LIVE PRIVILEGE / ISOLATION PROBES (5)
--
-- PROD/CI ONLY (0230 pattern): the macOS local stack segfaults the backend
-- when throws_ok trips an EXECUTE denial on a function (known class — see
-- 0230's refresh_org_daily_stats probe for the full note). The property is
-- already pinned statically above (the anon/authenticated has_function_privilege
-- checks). Opt in where the stack is verified safe with:
-- set stockpilot.pgtap_live_denial_probes = 'on';
-- ═════════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000001'::uuid, 'product', null) $$,
      '42501', null, 'anon cannot execute inventory_value_on_hand')
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select * from public.purchase_orders_stats('ac022700-0000-0000-0000-000000000001'::uuid, null) $$,
      '42501', null, 'anon cannot execute purchase_orders_stats')
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000001'::uuid, 'product', null) $$,
      '42501', null, 'authenticated cannot execute inventory_value_on_hand (not even for its own org)')
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

set local role to 'service_role';
select lives_ok(
  $$ select public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000001'::uuid, 'product', null) $$,
  'service_role can execute inventory_value_on_hand');
reset role;

-- Cross-org isolation for the authenticated-executable stats fn: a NON-MEMBER
-- aggregates zero rows (RLS) — the real defense, since authenticated may call.
set local "request.jwt.claim.sub" to 'ac022700-dead-dead-dead-000000000099';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select total_count from public.purchase_orders_stats('ac022700-0000-0000-0000-000000000001'::uuid, null)),
  0::bigint,
  'authenticated non-member gets a zero stats row (RLS isolation — no cross-org leak)');
reset role;

-- ═════════════════════════════════════════════════════════════════════════════
-- inventory_value_on_hand BEHAVIORAL (4) — every predicate leg would perturb
-- these hand-computed sums if it regressed (see the fixture table above).
-- ═════════════════════════════════════════════════════════════════════════════

select is(
  public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000001'::uuid, 'product', null),
  30::numeric,
  'value(product, all warehouses) = 30 — archived/deleted/rental/book/org-B all excluded');

select is(
  public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000001'::uuid, 'product',
    'ac022700-0000-0000-0000-000000000003'::uuid),
  20::numeric,
  'value(product, WH A1) = 20 — warehouse narrowing applies');

select is(
  public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000001'::uuid, 'book', null),
  15::numeric,
  'value(book) = 15 — item_type split (the reason the 0179 views could not be reused)');

select is(
  public.inventory_value_on_hand('ac022700-0000-0000-0000-000000000002'::uuid, 'product', null),
  81::numeric,
  'value(org B, product) = 81 — org scoping in both directions');

-- ═════════════════════════════════════════════════════════════════════════════
-- purchase_orders_stats BEHAVIORAL (2)
-- ═════════════════════════════════════════════════════════════════════════════

select results_eq(
  $$ select total_count, total_value, open_count, committed_value,
            open_supplier_count, inbound_count, next_eta_po_number, avg_lead_days
       from public.purchase_orders_stats('ac022700-0000-0000-0000-000000000001'::uuid, null) $$,
  -- total_value = 1180 (100+200+50+400+300+60+70), excluding the cancelled
  -- PO-1008's 900 — migration 0232 fixed total_value to exclude cancelled
  -- orders; total_count (8) still counts every row, cancelled included.
  $$ values (8::bigint, 1180::numeric, 4::bigint, 750::numeric,
             2::bigint, 3::bigint, 'PO-1003'::text, 7::numeric) $$,
  'stats (no scope): totals/open/committed/suppliers/inbound/next-ETA/avg-lead all hand-computed');

select results_eq(
  $$ select total_count, total_value, open_count, committed_value,
            open_supplier_count, inbound_count, next_eta_po_number, avg_lead_days
       from public.purchase_orders_stats('ac022700-0000-0000-0000-000000000001'::uuid,
         array['ac022700-0000-0000-0000-000000000003'::uuid]) $$,
  $$ values (3::bigint, 600::numeric, 2::bigint, 300::numeric,
             1::bigint, 1::bigint, 'PO-1002'::text, 10::numeric) $$,
  'stats (WH A1 scope): NULL-destination and NULL-warehouse POs vanish (!inner embed parity)');

-- ═════════════════════════════════════════════════════════════════════════════
-- purchase_orders_page BEHAVIORAL (9)
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. Full first page, created_at DESC id ASC — org B's PO never appears.
select results_eq(
  $$ select po_number, filtered_count
       from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
         null, null, null, 30, 0) $$,
  $$ values ('PO-1006'::text, 8::bigint), ('PO-1008', 8::bigint), ('PO-1004', 8::bigint),
            ('PO-1003', 8::bigint), ('PO-1002', 8::bigint), ('PO-1001', 8::bigint),
            ('PO-1005', 8::bigint), ('PO-1007', 8::bigint) $$,
  'page (all): full ordered list with filtered_count, cross-org isolated');

-- 2. Tab statuses ('in transit' partition).
select results_eq(
  $$ select po_number, filtered_count
       from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
         null, array['expected_inbound', 'partially_received'], null, 30, 0) $$,
  $$ values ('PO-1004'::text, 2::bigint), ('PO-1003', 2::bigint) $$,
  'page (statuses): tab partition filters server-side');

-- 3. q matches po_number substring (case-insensitive containment).
select results_eq(
  $$ select po_number from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
       null, null, 'po-1003', 30, 0) $$,
  $$ values ('PO-1003'::text) $$,
  'page (q): po_number substring match, case-insensitive');

-- 4. q matches the supplier LABEL (live supplier name).
select results_eq(
  $$ select po_number from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
       null, null, 'acme', 30, 0) $$,
  $$ values ('PO-1002'::text), ('PO-1001') $$,
  'page (q): supplier-name match finds that supplier''s POs, ordered');

-- 5. DELETED supplier renders '—', so its name must NOT match (JS map-miss parity).
select is(
  (select count(*) from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
     null, null, 'zenith', 30, 0)),
  0::bigint,
  'page (q): a deleted supplier''s name never matches (label degraded to —)');

-- 6. '_' in q is a LITERAL underscore (JS .includes parity), not a wildcard.
select results_eq(
  $$ select po_number from public.purchase_orders_page('ac022700-0000-0000-0000-000000000002'::uuid,
       null, null, '_50%', 30, 0) $$,
  $$ values ('PO-WILD_50%'::text) $$,
  'page (q): _ and % match literally when present in the po_number');

-- 7. '%' in q is a LITERAL percent — '%WILD' is not a substring of PO-WILD_50%.
select is(
  (select count(*) from public.purchase_orders_page('ac022700-0000-0000-0000-000000000002'::uuid,
     null, null, '%WILD', 30, 0)),
  0::bigint,
  'page (q): % does not act as a wildcard (a leading-%% query matches nothing)');

-- 8. limit/offset window: rows 4-6 of the ordered list, count still 8.
select results_eq(
  $$ select po_number, filtered_count
       from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
         null, null, null, 3, 3) $$,
  $$ values ('PO-1003'::text, 8::bigint), ('PO-1002', 8::bigint), ('PO-1001', 8::bigint) $$,
  'page (window): limit/offset paginate the same ordering; filtered_count is the full set');

-- 9. line_count reproduces the purchase_order_items(count) embed.
select is(
  (select line_count from public.purchase_orders_page('ac022700-0000-0000-0000-000000000001'::uuid,
     null, null, 'po-1002', 30, 0)),
  2::bigint,
  'page: line_count = number of purchase_order_items rows for the PO');

select * from finish();
rollback;
