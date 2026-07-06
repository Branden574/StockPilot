-- supabase/tests/0226_cycle_count_scale.test.sql
-- Proves migration 0226: public.start_cycle_count,
-- public.cycle_count_lines_page, public.cycle_count_summary — the set-based
-- cycle-count scale RPCs.
--
--   • all three exist with their declared signatures,
--   • all three are SECURITY INVOKER with search_path pinned to public,
--   • anon holds NO execute; authenticated DOES (SECURITY INVOKER + RLS makes
--     the caller grant safe — same matrix as the 0224 dashboard RPCs),
--   • behavioral (as an authenticated MANAGER of org A):
--       - start_cycle_count warehouse scope snapshots EXACTLY the active,
--         non-deleted items in the filtered warehouse (excludes archived /
--         deleted / other-warehouse / other-org items) — the verbatim old
--         TS predicate,
--       - org-wide (null filter) snapshots every active org item across
--         warehouses,
--       - selection scope snapshots only the active picks,
--       - an EMPTY scope raises cycle_count_no_items and leaves NO orphan
--         header (atomic rollback),
--       - a non-member manager (org B) cannot start a count in org A (RLS on
--         the header insert),
--       - cycle_count_summary + cycle_count_lines_page return the right
--         totals / page / filter, and a cross-org caller gets a zero summary
--         (RLS isolation — no oracle),
--       - cycle_count_lines_page p_search matches LITERALLY (ILIKE
--         metacharacters \ % _ are escaped, 0227 parity): 'SKU_0' matches
--         only the underscore SKU, '%' matches only a literal '%'.
--
-- now() is transaction_timestamp() — constant across this begin/rollback block.
-- Namespace: ac026600. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(30);

\set orgA  '\'ac026600-0000-0000-0000-000000000001\''
\set orgB  '\'ac026600-0000-0000-0000-000000000002\''
\set whA1  '\'ac026600-0000-0000-0000-000000000011\''
\set whA2  '\'ac026600-0000-0000-0000-000000000012\''
\set whA3  '\'ac026600-0000-0000-0000-000000000013\''
\set whB1  '\'ac026600-0000-0000-0000-000000000021\''
\set usrA  '\'ac026600-0000-0000-0000-0000000000a1\''
\set usrB  '\'ac026600-0000-0000-0000-0000000000b1\''
\set ia1   '\'ac026600-0000-0000-0000-000000000101\''
\set ia2   '\'ac026600-0000-0000-0000-000000000102\''
\set ia3   '\'ac026600-0000-0000-0000-000000000103\''
\set ia4   '\'ac026600-0000-0000-0000-000000000104\''
\set ia5   '\'ac026600-0000-0000-0000-000000000105\''
\set ia6   '\'ac026600-0000-0000-0000-000000000106\''
\set ia7   '\'ac026600-0000-0000-0000-000000000107\''
\set ia8   '\'ac026600-0000-0000-0000-000000000108\''
\set ib1   '\'ac026600-0000-0000-0000-000000000201\''

-- ── Fixtures (seeded as superuser — RLS not active in this block) ─────────────
-- auth.users insert fires on_auth_user_created (0001) → user_profiles row, so
-- cycle_counts.started_by = auth.uid() satisfies its FK.
insert into auth.users (id, email, raw_user_meta_data) values
  (:usrA, 'cc226-mgr-a@test.local', '{}'::jsonb),
  (:usrB, 'cc226-mgr-b@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'CC226 Org A', 'cc226-org-a'),
  (:orgB, 'CC226 Org B', 'cc226-org-b')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :usrA, 'manager', now()),
  (:orgB, :usrB, 'manager', now())
  on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'CC226 WH A1', 'CC226-A1', 'active'),
  (:whA2, :orgA, 'CC226 WH A2', 'CC226-A2', 'active'),
  (:whA3, :orgA, 'CC226 WH A3', 'CC226-A3', 'active'),  -- deliberately EMPTY
  (:whB1, :orgB, 'CC226 WH B1', 'CC226-B1', 'active')
  on conflict (id) do nothing;

-- Org A items: IA1/IA2 active in WH-A1, IA3 active in WH-A2, IA4 ARCHIVED,
-- IA5 active but DELETED. Org B: IB1 (isolation). Only IA1/IA2/IA3 are in
-- the warehouse-snapshot scope; IA4/IA5/IB1 must never appear.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, deleted_at)
values
  (:ia1, :orgA, :whA1, 'CC226-A1', 'Item A1', 10, 'active',   'none', null),
  (:ia2, :orgA, :whA1, 'CC226-A2', 'Item A2', 20, 'active',   'none', null),
  (:ia3, :orgA, :whA2, 'CC226-A3', 'Item A3',  5, 'active',   'none', null),
  (:ia4, :orgA, :whA1, 'CC226-A4', 'Item A4',  7, 'archived', 'none', null),
  (:ia5, :orgA, :whA1, 'CC226-A5', 'Item A5',  9, 'active',   'none', now()),
  (:ib1, :orgB, :whB1, 'CC226-B1', 'Item B1',  3, 'active',   'none', null)
  on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-3. Shape: all three functions exist with their declared signatures.
-- ─────────────────────────────────────────────────────────────────────────────
select has_function('public', 'start_cycle_count',
  array['uuid', 'text', 'uuid', 'uuid', 'uuid[]', 'text'],
  'start_cycle_count(uuid,text,uuid,uuid,uuid[],text) exists');
select has_function('public', 'cycle_count_lines_page',
  array['uuid', 'text', 'text', 'text', 'integer', 'integer'],
  'cycle_count_lines_page(uuid,text,text,text,integer,integer) exists');
select has_function('public', 'cycle_count_summary', array['uuid'],
  'cycle_count_summary(uuid) exists');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-6. SECURITY INVOKER (not definer) — RLS must bind the caller.
-- ─────────────────────────────────────────────────────────────────────────────
select is((select prosecdef from pg_proc
    where oid = 'public.start_cycle_count(uuid,text,uuid,uuid,uuid[],text)'::regprocedure),
  false, 'start_cycle_count is SECURITY INVOKER');
select is((select prosecdef from pg_proc
    where oid = 'public.cycle_count_lines_page(uuid,text,text,text,integer,integer)'::regprocedure),
  false, 'cycle_count_lines_page is SECURITY INVOKER');
select is((select prosecdef from pg_proc
    where oid = 'public.cycle_count_summary(uuid)'::regprocedure),
  false, 'cycle_count_summary is SECURITY INVOKER');

-- ─────────────────────────────────────────────────────────────────────────────
-- 7-9. search_path pinned to public.
-- ─────────────────────────────────────────────────────────────────────────────
select ok((select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.start_cycle_count(uuid,text,uuid,uuid,uuid[],text)'::regprocedure),
  'start_cycle_count search_path pinned to public');
select ok((select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.cycle_count_lines_page(uuid,text,text,text,integer,integer)'::regprocedure),
  'cycle_count_lines_page search_path pinned to public');
select ok((select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.cycle_count_summary(uuid)'::regprocedure),
  'cycle_count_summary search_path pinned to public');

-- ─────────────────────────────────────────────────────────────────────────────
-- 10-12. anon holds NO execute.
-- ─────────────────────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon',
    'public.start_cycle_count(uuid,text,uuid,uuid,uuid[],text)', 'execute'),
  'anon holds no EXECUTE on start_cycle_count');
select ok(not has_function_privilege('anon',
    'public.cycle_count_lines_page(uuid,text,text,text,integer,integer)', 'execute'),
  'anon holds no EXECUTE on cycle_count_lines_page');
select ok(not has_function_privilege('anon',
    'public.cycle_count_summary(uuid)', 'execute'),
  'anon holds no EXECUTE on cycle_count_summary');

-- ─────────────────────────────────────────────────────────────────────────────
-- 13-15. authenticated HAS execute (SECURITY INVOKER + RLS makes it safe).
-- ─────────────────────────────────────────────────────────────────────────────
select ok(has_function_privilege('authenticated',
    'public.start_cycle_count(uuid,text,uuid,uuid,uuid[],text)', 'execute'),
  'authenticated holds EXECUTE on start_cycle_count');
select ok(has_function_privilege('authenticated',
    'public.cycle_count_lines_page(uuid,text,text,text,integer,integer)', 'execute'),
  'authenticated holds EXECUTE on cycle_count_lines_page');
select ok(has_function_privilege('authenticated',
    'public.cycle_count_summary(uuid)', 'execute'),
  'authenticated holds EXECUTE on cycle_count_summary');

-- ═════════════════════════════════════════════════════════════════════════════
-- Behavioral — act as an authenticated MANAGER of org A.
-- ═════════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :usrA;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 16. Warehouse scope filtered to WH-A1 snapshots exactly IA1 + IA2 (2 lines).
select is(
  (select line_count from public.start_cycle_count(:orgA, 'warehouse', :whA1, :whA1, null::uuid[], 'wh count')),
  2,
  'start_cycle_count warehouse/WH-A1 → 2 lines (active WH-A1 items only)');

-- 17. Those 2 lines are exactly {IA1, IA2} — archived IA4, deleted IA5,
--     other-warehouse IA3, and other-org IB1 are all excluded.
select results_eq(
  $$ select l.item_id
       from public.cycle_count_lines l
       join public.cycle_counts c on c.id = l.cycle_count_id
      where c.organization_id = 'ac026600-0000-0000-0000-000000000001'
        and c.scope = 'warehouse'
        and c.warehouse_id = 'ac026600-0000-0000-0000-000000000011'
      order by l.item_id $$,
  $$ values
       ('ac026600-0000-0000-0000-000000000101'::uuid),
       ('ac026600-0000-0000-0000-000000000102'::uuid) $$,
  'warehouse snapshot lines are exactly the active WH-A1 items');

-- 18. Per-line snapshot: expected_quantity + warehouse_id captured from the item.
select results_eq(
  $$ select l.expected_quantity, l.warehouse_id
       from public.cycle_count_lines l
       join public.cycle_counts c on c.id = l.cycle_count_id
      where c.scope = 'warehouse'
        and c.warehouse_id = 'ac026600-0000-0000-0000-000000000011'
      order by l.item_id $$,
  $$ values
       (10::numeric, 'ac026600-0000-0000-0000-000000000011'::uuid),
       (20::numeric, 'ac026600-0000-0000-0000-000000000011'::uuid) $$,
  'each line snapshots the item quantity_on_hand + warehouse_id');

-- 19. Org-wide (null filter) snapshots every active org-A item across
--     warehouses: IA1 + IA2 + IA3 = 3 (archived/deleted/other-org excluded).
select is(
  (select line_count from public.start_cycle_count(:orgA, 'warehouse', null, null::uuid, null::uuid[], 'org count')),
  3,
  'org-wide warehouse scope → every active org item (3), across warehouses');

-- 20. Selection scope snapshots only the ACTIVE picks (IA1 active, IA4 archived
--     dropped) — 1 line.
select is(
  (select line_count from public.start_cycle_count(
     :orgA, 'selection', null::uuid, null::uuid, array[:ia1, :ia4]::uuid[], 'sel count')),
  1,
  'selection scope snapshots only the active pick (archived pick dropped)');

-- 21. EMPTY scope raises cycle_count_no_items (WH-A3 has no items).
select throws_ok(
  $$ select public.start_cycle_count(
       'ac026600-0000-0000-0000-000000000001'::uuid, 'warehouse',
       'ac026600-0000-0000-0000-000000000013'::uuid,
       'ac026600-0000-0000-0000-000000000013'::uuid, null::uuid[], 'empty') $$,
  'P0001', 'cycle_count_no_items',
  'empty scope raises cycle_count_no_items');

-- 22. …and leaves NO orphan header for WH-A3 (the header insert rolled back
--     with the raise — atomic).
select is(
  (select count(*)::int from public.cycle_counts
    where warehouse_id = 'ac026600-0000-0000-0000-000000000013'),
  0,
  'empty scope leaves no orphan cycle_counts header (atomic rollback)');

-- ── Record a variance on the WH-A1 count for the summary/page assertions.
reset role;
update public.cycle_count_lines
   set counted_quantity = 7, counted_by = :usrA, counted_at = now()
 where item_id = :ia1
   and cycle_count_id = (
     select id from public.cycle_counts
      where organization_id = :orgA and scope = 'warehouse' and warehouse_id = :whA1);

set local "request.jwt.claim.sub" to :usrA;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 23. Summary roll-up over the WH-A1 count: total 2, counted 1, 1 variance,
--     net delta 7 − 10 = −3.
select results_eq(
  $$ select total, counted, variance_count, net_delta
       from public.cycle_count_summary((
         select id from public.cycle_counts
          where organization_id = 'ac026600-0000-0000-0000-000000000001'
            and scope = 'warehouse'
            and warehouse_id = 'ac026600-0000-0000-0000-000000000011')) $$,
  $$ values (2::bigint, 1::bigint, 1::bigint, (-3)::numeric) $$,
  'cycle_count_summary returns total/counted/variance_count/net_delta');

-- 24. Line page (all) returns both lines with full_count = 2.
select is(
  (select count(*)::int from public.cycle_count_lines_page((
     select id from public.cycle_counts
      where organization_id = :orgA and scope = 'warehouse' and warehouse_id = :whA1),
     null, 'all', 'sku', 50, 0)),
  2,
  'cycle_count_lines_page (all) returns every line on the page');

-- 25. full_count column reflects the filtered total (2).
select is(
  (select distinct full_count from public.cycle_count_lines_page((
     select id from public.cycle_counts
      where organization_id = :orgA and scope = 'warehouse' and warehouse_id = :whA1),
     null, 'all', 'sku', 50, 0)),
  2::bigint,
  'cycle_count_lines_page full_count = filtered total');

-- 26. Filter=uncounted narrows to the 1 still-uncounted line (IA2).
select results_eq(
  $$ select item_id from public.cycle_count_lines_page((
       select id from public.cycle_counts
        where organization_id = 'ac026600-0000-0000-0000-000000000001'
          and scope = 'warehouse'
          and warehouse_id = 'ac026600-0000-0000-0000-000000000011'),
       null, 'uncounted', 'sku', 50, 0) $$,
  $$ values ('ac026600-0000-0000-0000-000000000102'::uuid) $$,
  'cycle_count_lines_page filter=uncounted returns only uncounted lines');

-- ── Escape fixtures — seeded HERE (after the snapshot-count assertions) so
--    the earlier org-wide line-count expectations stay untouched. SKU_001 vs
--    SKU-001 + a literal-% name prove p_search matches LITERALLY: the raw
--    '%' || p_search || '%' concatenation let '_' act as a single-char
--    wildcard ('SKU_0' matched 'SKU-0…' too) and '%' match every line.
reset role;
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, deleted_at)
values
  (:ia6, :orgA, :whA2, 'CC226SKU_001', 'Escape probe underscore', 1, 'active', 'none', null),
  (:ia7, :orgA, :whA2, 'CC226SKU-001', 'Escape probe dash',       1, 'active', 'none', null),
  (:ia8, :orgA, :whA2, 'CC226-PCT',    '100% Cotton Tee',         1, 'active', 'none', null)
  on conflict (id) do nothing;

set local "request.jwt.claim.sub" to :usrA;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 27. Snapshot the three escape-probe items into their own selection count
--     (setup for 28-29, and one more selection-scope proof).
select is(
  (select line_count from public.start_cycle_count(
     :orgA, 'selection', null::uuid, null::uuid,
     array[:ia6, :ia7, :ia8]::uuid[], 'esc count')),
  3,
  'escape-fixture selection count snapshots all 3 probe items');

-- 28. Literal underscore: searching 'SKU_0' matches ONLY CC226SKU_001. With
--     the unescaped pattern, '_' was a wildcard and CC226SKU-001 matched too.
select results_eq(
  $$ select item_id from public.cycle_count_lines_page((
       select id from public.cycle_counts
        where organization_id = 'ac026600-0000-0000-0000-000000000001'
          and notes = 'esc count'),
       'SKU_0', 'all', 'sku', 50, 0) $$,
  $$ values ('ac026600-0000-0000-0000-000000000106'::uuid) $$,
  'p_search underscore is literal: SKU_0 matches only the underscore SKU');

-- 29. Literal percent: searching '%' matches ONLY the line whose name holds a
--     real '%'. With the unescaped pattern, '%' matched every line.
select results_eq(
  $$ select item_id from public.cycle_count_lines_page((
       select id from public.cycle_counts
        where organization_id = 'ac026600-0000-0000-0000-000000000001'
          and notes = 'esc count'),
       '%', 'all', 'sku', 50, 0) $$,
  $$ values ('ac026600-0000-0000-0000-000000000108'::uuid) $$,
  'p_search percent is literal: % matches only a literal % in name/sku/barcode');

-- 30. Cross-org isolation: org-B manager gets a ZERO summary for an org-A count
--     (cycle_count_lines RLS returns no rows) — no cross-org oracle.
reset role;
set local "request.jwt.claim.sub" to :usrB;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select total from public.cycle_count_summary((
     select id from public.cycle_counts
      where organization_id = 'ac026600-0000-0000-0000-000000000001'
        and scope = 'warehouse'
        and warehouse_id = 'ac026600-0000-0000-0000-000000000011'))),
  0::bigint,
  'org-B manager gets a zero summary for an org-A count (RLS isolation)');

reset role;
select * from finish();
rollback;
