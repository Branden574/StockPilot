-- supabase/tests/0357_inventory_distinct_racks_org_scope.test.sql
-- Proves migration 0357: inventory_distinct_racks_for_org(p_org, p_scope)
-- returns the rack labels of ONE organization, for a caller who belongs to
-- several, and never more than row level security already lets that caller
-- read.
--
-- Three properties:
--
--   A. POSTURE. The (uuid, text) signature exists; SECURITY INVOKER (RLS stays
--      in force), STABLE, search_path=public pinned; authenticated holds
--      EXECUTE, anon and PUBLIC hold none. The old one-argument function still
--      has exactly ONE signature (0329's list-integrity pin, and no PostgREST
--      ambiguity).
--
--   B. ONE ORGANIZATION. una is a manager in org A and org B. The old function
--      gives her both organizations' racks (the bug, pinned as a fixture);
--      the new one gives exactly A's for A and B's for B, per scope, without
--      soft-deleted rows, and nothing for an organization she is not in.
--
--   C. NEVER WIDER THAN RLS. ben belongs to org B only: asking for org A
--      yields nothing. A NULL organization and an unknown scope are refused
--      (22023) rather than read as "no racks". The live anon call is an
--      opt-in probe (stockpilot.pgtap_live_denial_probes), because a
--      permission-denied function call crashes the local stack's backend.
--
-- Fixtures inserted as postgres (RLS bypassed). Every SKU differs. Namespace:
-- 03570000. begin/rollback: nothing leaks.
--
-- PLAN: hand-counted 20 (A: 8, B: 7, C: 5).

begin;

select plan(20);

\set org_a  '''03570000-0000-0000-0000-00000000000a'''
\set org_b  '''03570000-0000-0000-0000-00000000000b'''
\set org_c  '''03570000-0000-0000-0000-00000000000c'''
\set una    '''03570000-0000-0000-0000-0000000000a1'''
\set ben    '''03570000-0000-0000-0000-0000000000b1'''
\set wh_a   '''03570000-0000-0000-0000-0000000000fa'''
\set wh_b   '''03570000-0000-0000-0000-0000000000fb'''
\set wh_c   '''03570000-0000-0000-0000-0000000000fc'''

insert into auth.users (id, email) values
  (:una, 'una-0357@test.local'), (:ben, 'ben-0357@test.local');
insert into public.organizations (id, name, slug) values
  (:org_a, 'Org A 0357', 'org-a-0357'),
  (:org_b, 'Org B 0357', 'org-b-0357'),
  (:org_c, 'Org C 0357', 'org-c-0357');
-- una: manager in A and in B (manager sees every warehouse under 0229).
-- ben: manager in B only. Nobody in the test belongs to C.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_a, :una, 'manager', now()),
  (:org_b, :una, 'manager', now()),
  (:org_b, :ben, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh_a, :org_a, 'WH A 0357', 'WH-0357-A', 'active'),
  (:wh_b, :org_b, 'WH B 0357', 'WH-0357-B', 'active'),
  (:wh_c, :org_c, 'WH C 0357', 'WH-0357-C', 'active');

insert into public.inventory_items
  (organization_id, warehouse_id, sku, name, item_type, status, tracking_type, custom_fields)
values
  -- org A: two item racks (one with a row), one soft-deleted, one book rack.
  (:org_a, :wh_a, 'SKU-0357-A1', 'A widget one',   'product', 'active', 'none', '{"rack_number":"3"}'),
  (:org_a, :wh_a, 'SKU-0357-A2', 'A widget two',   'product', 'active', 'none', '{"rack_number":"1","rack_row":"A"}'),
  (:org_a, :wh_a, 'SKU-0357-A3', 'A widget gone',  'product', 'active', 'none', '{"rack_number":"99"}'),
  (:org_a, :wh_a, 'SKU-0357-A4', 'A book',         'book',    'active', 'none', '{"book_rack_number":"40","book_rack_row":"B"}'),
  -- org B: one item rack, no books.
  (:org_b, :wh_b, 'SKU-0357-B1', 'B widget',       'product', 'active', 'none', '{"rack_number":"7","rack_row":"C"}'),
  -- org C: nobody here may see it.
  (:org_c, :wh_c, 'SKU-0357-C1', 'C widget',       'product', 'active', 'none', '{"rack_number":"55"}');
update public.inventory_items set deleted_at = now() where sku = 'SKU-0357-A3';

-- ═══════════════════════════════════════════════════════════════════════════
-- A. POSTURE
-- ═══════════════════════════════════════════════════════════════════════════

-- 1
select has_function('public', 'inventory_distinct_racks_for_org', array['uuid', 'text'],
  'inventory_distinct_racks_for_org(uuid, text) exists');
-- 2
select is(
  (select p.prosecdef from pg_proc p
    where p.oid = 'public.inventory_distinct_racks_for_org(uuid, text)'::regprocedure),
  false,
  'SECURITY INVOKER: row level security still applies on top of the organization predicate');
-- 3
select is(
  (select p.provolatile::text from pg_proc p
    where p.oid = 'public.inventory_distinct_racks_for_org(uuid, text)'::regprocedure),
  's', 'STABLE');
-- 4
select ok(
  (select 'search_path=public' = any(p.proconfig) from pg_proc p
    where p.oid = 'public.inventory_distinct_racks_for_org(uuid, text)'::regprocedure),
  'carries the repo-standard search_path=public pin (0329 posture)');
-- 5
select ok(
  has_function_privilege('authenticated', 'public.inventory_distinct_racks_for_org(uuid, text)', 'execute'),
  'authenticated holds EXECUTE');
-- 6
select ok(
  not has_function_privilege('anon', 'public.inventory_distinct_racks_for_org(uuid, text)', 'execute'),
  'anon holds no EXECUTE');
-- 7. A NULL proacl is itself PUBLIC-executable, so read the ACL rows directly.
select is(
  (select count(*)::int
     from pg_proc p,
     lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
    where p.oid = 'public.inventory_distinct_racks_for_org(uuid, text)'::regprocedure
      and (a::text like '=%' or a::text like 'anon=%')),
  0,
  'no PUBLIC and no anon grant survives in the ACL');
-- 8
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_distinct_racks'),
  1,
  'inventory_distinct_racks still has exactly ONE signature (0329 pin; no PostgREST ambiguity)');

-- ═══════════════════════════════════════════════════════════════════════════
-- B. ONE ORGANIZATION (una: manager in A and B)
-- ═══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to '03570000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 9. The bug, as a fixture: the old function has no organization predicate.
select is(
  public.inventory_distinct_racks('items'),
  array['1-A', '3', '7-C']::text[],
  'fixture: the OLD function mixes org A''s and org B''s racks for a two-org user');
-- 10
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000a', 'items'),
  array['1-A', '3']::text[],
  'org A, items: exactly A''s racks (the soft-deleted rack 99 is not one)');
-- 11
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000b', 'items'),
  array['7-C']::text[],
  'org B, items: exactly B''s racks');
-- 12
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000a', 'books'),
  array['40-B']::text[],
  'org A, books: the book rack only (book keys, books only)');
-- 13
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000b', 'books'),
  '{}'::text[],
  'org B, books: none, as an empty array (not null)');
-- 14
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000c', 'items'),
  '{}'::text[],
  'org C, where she is not a member: nothing (RLS still applies)');
-- 15
select ok(
  not ('55' = any(public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000a', 'items'))
    or '7-C' = any(public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000a', 'items'))),
  'org A never carries another organization''s rack');

-- ═══════════════════════════════════════════════════════════════════════════
-- C. NEVER WIDER THAN RLS, AND NO SILENT EMPTIES
-- ═══════════════════════════════════════════════════════════════════════════

-- 16
select throws_ok(
  $$ select public.inventory_distinct_racks_for_org(null, 'items') $$,
  '22023', 'invalid_org',
  'a NULL organization is refused, not read as "no racks"');
-- 17
select throws_ok(
  $$ select public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000a', 'bins') $$,
  '22023', 'invalid_scope',
  'an unknown scope is refused');

set local role to postgres;
set local "request.jwt.claim.sub" to '03570000-0000-0000-0000-0000000000b1';
set local role to 'authenticated';

-- 18
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000a', 'items'),
  '{}'::text[],
  'ben (org B only) asking for org A gets nothing: the predicate cannot widen RLS');
-- 19
select is(
  public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000b', 'items'),
  array['7-C']::text[],
  'ben gets his own organization''s racks');

set local role to postgres;
set local "request.jwt.claim.sub" to '';
set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';

-- 20. Live EXECUTE-denial probe, opt-in only: a permission-denied FUNCTION
--     error crashes the local stack's backend (the known class, see 0223 and
--     0230). The property is pinned statically above (tests 6-7).
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select public.inventory_distinct_racks_for_org('03570000-0000-0000-0000-00000000000b', 'items') $$,
      '42501', null,
      'anon cannot call it')
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;

set local role to postgres;
select * from finish();
rollback;
