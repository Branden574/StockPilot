-- supabase/tests/0371_holdings_staff_scope.test.sql
-- Proves migration 0371: staff see holdings only in their own warehouses (plus
-- locations with no warehouse), and every stock RPC still behaves exactly as
-- before, for every persona.
--
--   A. POLICY SHAPE. item_stock_levels carries exactly three policies: the
--      0331 SELECT (untouched), and INSERT + UPDATE with 0202's predicates
--      verbatim. No FOR ALL, no second SELECT, no DELETE policy or grant.
--   B. NARROWING, per persona, as direct SELECTs.
--   I. item_holdings_elsewhere: the complement property (visible + hidden =
--      total) for staff, viewer and multi-warehouse staff; literal buckets and
--      placed location ids; one row per item; nothing for managers, for items
--      the caller cannot read, or across orgs; the 500-id bound; structure.
--   J. location_stock_census: exact org-wide totals for a manager (including
--      an item the manager cannot read) and for a locations:manage holder;
--      42501 for everyone else; structure.
--   C. STAFF RPC PARITY: every adjust and transfer shape a whT1 staff member
--      uses, each with literal holdings afterwards.
--   D. ERROR-CODE PARITY: the same codes and messages as before 0371, plus two
--      ORDER pins that only the bodies' own 0365 gates satisfy.
--   S. The other personas' writes (staff whT1+whT2, admin, manager) and
--      complete_picking by a whT1 staff member.
--   H. LEDGER INTEGRITY: holdings sum = on hand; movement rows carry the same
--      from/to locations as before.
--   F. THE HELPER'S OWN GATE, one line per assertion (called directly with the
--      transaction's ledger flag raised by hand).
--   G. STRUCTURE of the helper and the restated bodies.
--   E. DIVERGENCE KILL (last: it replaces the SELECT policy): with a SELECT
--      policy that hides every holding from staff, staff adjust and transfer
--      still succeed with literal quantities. This fails if the helper is
--      reverted to SECURITY INVOKER or the holdings statements are inlined
--      back into the INVOKER bodies.
--
-- HOW THE ROLES ARE SIMULATED (house convention, 0191/0282/0322/0327/0331):
-- `set local role authenticated` + request.jwt.claim.sub wherever RLS matters;
-- the jwt claim only for gate assertions that do not depend on RLS (F, and the
-- DEFINER read helpers' gates).
--
-- MUTATION RECORD (live, when 0371 landed; each mutant was one edit of the
-- migration's own text, applied inside the test's rolled-back transaction):
--   * item_stock_levels_write FOR ALL restored          -> A1 B1-B4 I3 E1
--                                                          (and 0331 test 9)
--   * helper: caller_can_write_location line dropped    -> F5 F15 E6
--   * helper: ledger.active() line dropped              -> F1 F15 E6
--   * helper: staff line dropped                        -> F3 F8 F15 E6
--   * helper: location_in_org line dropped              -> F7 F13 F15 E6
--   * helper: null-location line dropped                -> F6
--   * helper: manager floor instead of staff            -> C1-C8 C11 D1 D2 D17
--                                                          S1 S2 S7 H1 H2 F7
--                                                          F9 F10 F15 E2-E6
--   * helper: draw without its sign guard               -> D1
--   * helper reverted to SECURITY INVOKER               -> G1 E2-E6
--   * the pre-0371 bodies (holdings inlined back)       -> G4 G5 E2-E6
--   * adjust_stock body: 0365 gate dropped              -> D6 G6
--   * transfer_stock body: 0365 gate dropped            -> D7 G6
--   * item_holdings_elsewhere: grouped per location     -> I1 I2 I6
--   * item_holdings_elsewhere: scope negation dropped   -> I1 I3 I6 I7 I8 I9
--   * item_holdings_elsewhere: item-read gate dropped   -> I4 I5 I6 I12 I13
--   * location_stock_census: filtered by item read      -> J1 J4
--   * location_stock_census: permission gate dropped    -> J5 J6 J7 J8
--
-- Namespace: 03710000. Wrapped in begin/rollback; nothing leaks.

begin;

select plan(109);

\set orgS    '\'03710000-0000-0000-0000-000000000001\''
\set orgF    '\'03710000-0000-0000-0000-000000000002\''
\set u_mgr   '\'03710000-0000-0000-0000-0000000000a1\''
\set u_vwr   '\'03710000-0000-0000-0000-0000000000a2\''
\set u_stf   '\'03710000-0000-0000-0000-0000000000a3\''
\set u_lone  '\'03710000-0000-0000-0000-0000000000a4\''
\set u_both  '\'03710000-0000-0000-0000-0000000000a5\''
\set u_adm   '\'03710000-0000-0000-0000-0000000000a6\''
\set u_out   '\'03710000-0000-0000-0000-0000000000a7\''
\set u_lm    '\'03710000-0000-0000-0000-0000000000a8\''
\set whT1    '\'03710000-0000-0000-0000-0000000000b1\''
\set whT2    '\'03710000-0000-0000-0000-0000000000b2\''
\set whF     '\'03710000-0000-0000-0000-0000000000b3\''
\set locW1   '\'03710000-0000-0000-0000-0000000000e1\''
\set locW1b  '\'03710000-0000-0000-0000-0000000000e2\''
\set locW1c  '\'03710000-0000-0000-0000-0000000000e3\''
\set locW2   '\'03710000-0000-0000-0000-0000000000e4\''
\set locW2b  '\'03710000-0000-0000-0000-0000000000e5\''
\set locW2z  '\'03710000-0000-0000-0000-0000000000e6\''
\set locN    '\'03710000-0000-0000-0000-0000000000e7\''
\set locF    '\'03710000-0000-0000-0000-0000000000e8\''
\set itemA   '\'03710000-0000-0000-0000-0000000000c1\''
\set itemB   '\'03710000-0000-0000-0000-0000000000c2\''
\set itemN   '\'03710000-0000-0000-0000-0000000000c3\''
\set itemP   '\'03710000-0000-0000-0000-0000000000c4\''
\set itemF   '\'03710000-0000-0000-0000-0000000000c5\''
\set ordP    '\'03710000-0000-0000-0000-0000000000d1\''
\set nobody  '\'03710000-dead-beef-0000-000000000371\''

-- ── Fixtures (superuser, no jwt subject: RLS bypassed, service path) ─────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgr,  'mgr-0371@test.local',      '{}'::jsonb),
  (:u_vwr,  'viewer-0371@test.local',   '{}'::jsonb),
  (:u_stf,  'staff-0371@test.local',    '{}'::jsonb),
  (:u_lone, 'lone-0371@test.local',     '{}'::jsonb),
  (:u_both, 'both-0371@test.local',     '{}'::jsonb),
  (:u_adm,  'admin-0371@test.local',    '{}'::jsonb),
  (:u_out,  'outsider-0371@test.local', '{}'::jsonb),
  (:u_lm,   'locmgr-0371@test.local',   '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgS, 'Holdings Scope Org 0371',   'holdings-scope-org-0371'),
  (:orgF, 'Holdings Foreign Org 0371', 'holdings-foreign-org-0371')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgS, :u_mgr,  'manager', now()),
  (:orgS, :u_vwr,  'viewer',  now()),
  (:orgS, :u_stf,  'staff',   now()),
  (:orgS, :u_lone, 'staff',   now()),
  (:orgS, :u_both, 'staff',   now()),
  (:orgS, :u_adm,  'admin',   now()),
  (:orgS, :u_lm,   'staff',   now()),
  (:orgF, :u_out,  'manager', now())
on conflict do nothing;

-- The 0188 trigger creates Staging + Unplaced per warehouse (kinds 'staging'
-- and 'unplaced'); they are referenced below by (warehouse, kind).
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whT1, :orgS, 'Scope WH One 0371', 'WH1-0371', 'active'),
  (:whT2, :orgS, 'Scope WH Two 0371', 'WH2-0371', 'active'),
  (:whF,  :orgF, 'Foreign WH 0371',   'WHF-0371', 'active')
on conflict (id) do nothing;

-- viewer, staff and u_lm: whT1 only. u_both: whT1 + whT2. u_lone: none.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:orgS, :u_vwr,  :whT1),
  (:orgS, :u_stf,  :whT1),
  (:orgS, :u_lm,   :whT1),
  (:orgS, :u_both, :whT1),
  (:orgS, :u_both, :whT2)
on conflict do nothing;

-- u_lm holds locations:manage by override (not a staff default).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:orgS, :u_lm, 'locations:manage', true);

-- Bins are kind NULL (the 0292 placed shape). created_at is staggered so
-- apply_level_delta's placed draw order (by created_at) is deterministic; the
-- auto-created Staging/Unplaced rows carry now() and sort last anyway.
-- locN is an org-level location with NO warehouse (the DC4 Site shape).
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:locW1,  :orgS, :whT1, 'Scope W1 0371',   'bin',       null, now() - interval '10 minutes'),
  (:locW1b, :orgS, :whT1, 'Scope W1b 0371',  'bin',       null, now() - interval '9 minutes'),
  (:locW1c, :orgS, :whT1, 'Scope W1c 0371',  'bin',       null, now() - interval '8 minutes'),
  (:locW2,  :orgS, :whT2, 'Scope W2 0371',   'bin',       null, now() - interval '7 minutes'),
  (:locW2b, :orgS, :whT2, 'Scope W2b 0371',  'bin',       null, now() - interval '6 minutes'),
  (:locW2z, :orgS, :whT2, 'Scope W2z 0371',  'bin',       null, now() - interval '5 minutes'),
  (:locN,   :orgS, null,  'Scope Site 0371', 'warehouse', null, now() - interval '4 minutes'),
  (:locF,   :orgF, :whF,  'Foreign F 0371',  'bin',       null, now() - interval '3 minutes')
on conflict (id) do nothing;

-- itemA (whT1): split across both warehouses, the Site and whT2's Staging and
-- Unplaced; a zero row at W2z. itemB (whT2): only in whT2. itemN has NO
-- warehouse, so no member (manager included) can read it through
-- inventory_items RLS. itemP (whT1): the pick item. itemF: the foreign org's.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemA, :orgS, :whT1, 'HS-0371-A', 'Split Item 0371',        17, 'active', 'none'),
  (:itemB, :orgS, :whT2, 'HS-0371-B', 'Other WH Item 0371',      6, 'active', 'none'),
  (:itemN, :orgS, null,  'HS-0371-N', 'No-warehouse Item 0371',  7, 'active', 'none'),
  (:itemP, :orgS, :whT1, 'HS-0371-P', 'Pick Item 0371',          3, 'active', 'none'),
  (:itemF, :orgF, :whF,  'HS-0371-F', 'Foreign Item 0371',       9, 'active', 'none')
on conflict (id) do nothing;

-- The 0199 trigger seeds an opening row per item; clear and place explicitly
-- so every quantity below is a literal this file controls.
delete from public.item_stock_levels where item_id in (:itemA, :itemB, :itemN, :itemP, :itemF);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgS, :itemA, :locW1,  5),
  (:orgS, :itemA, :locW2,  4),
  (:orgS, :itemA, :locW2b, 2),
  (:orgS, :itemA, :locW2z, 0),
  (:orgS, :itemA, :locN,   3),
  (:orgS, :itemA, (select id from public.locations where warehouse_id = :whT2 and kind = 'staging'),  2),
  (:orgS, :itemA, (select id from public.locations where warehouse_id = :whT2 and kind = 'unplaced'), 1),
  (:orgS, :itemB, :locW2,  6),
  (:orgS, :itemN, :locW2,  7),
  (:orgS, :itemP, :locW1c, 3),
  (:orgF, :itemF, :locF,   9);

insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
values (:ordP, :orgS, :whT1, 'pick_slip_generated', 'internal', :u_stf, 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (:ordP, :itemP, 2);

-- Short labels for literal snapshots.
create temp table lbl (id uuid primary key, tag text not null);
grant select on lbl to authenticated;
insert into lbl values
  (:locW1, 'W1'), (:locW1b, 'W1b'), (:locW1c, 'W1c'), (:locW2, 'W2'), (:locW2b, 'W2b'),
  (:locW2z, 'W2z'), (:locN, 'N'), (:locF, 'F');
insert into lbl select id, 'S1' from public.locations where warehouse_id = :whT1 and kind = 'staging';
insert into lbl select id, 'U1' from public.locations where warehouse_id = :whT1 and kind = 'unplaced';
insert into lbl select id, 'S2' from public.locations where warehouse_id = :whT2 and kind = 'staging';
insert into lbl select id, 'U2' from public.locations where warehouse_id = :whT2 and kind = 'unplaced';

create function pg_temp.snap(p_item uuid) returns text language sql as $f$
  select string_agg(coalesce(b.tag, '?') || '=' || s.quantity::int, ',' order by coalesce(b.tag, '?') collate "C")
    from public.item_stock_levels s left join lbl b on b.id = s.location_id
   where s.item_id = p_item;
$f$;

-- ══════════════════════════════════════════════════════════════════════════
-- 0. CONTROL (superuser)
-- ══════════════════════════════════════════════════════════════════════════
select is(pg_temp.snap(:itemA), 'N=3,S2=2,U2=1,W1=5,W2=4,W2b=2,W2z=0',
  'CONTROL: itemA holds 7 rows summing 17 (whT1 5, whT2 4+2+0+2+1, Site 3)');

-- ══════════════════════════════════════════════════════════════════════════
-- A. POLICY SHAPE
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select string_agg(policyname || ':' || cmd || ':' || permissive, ',' order by policyname)
     from pg_policies where schemaname = 'public' and tablename = 'item_stock_levels'),
  'item_stock_levels_insert:INSERT:PERMISSIVE,item_stock_levels_select:SELECT:PERMISSIVE,item_stock_levels_update:UPDATE:PERMISSIVE',
  'A1: item_stock_levels has exactly the 0331 SELECT policy plus INSERT and UPDATE policies: no FOR ALL, no second SELECT, no DELETE');
select is(
  (select roles::text || '|' || coalesce(qual, '<none>') || '|' || with_check
     from pg_policies where schemaname = 'public' and tablename = 'item_stock_levels'
      and policyname = 'item_stock_levels_insert'),
  '{authenticated}|<none>|(( SELECT has_org_role(item_stock_levels.organization_id, ''staff''::text) AS has_org_role) AND ( SELECT location_in_org(item_stock_levels.location_id, item_stock_levels.organization_id) AS location_in_org))',
  'A2: the INSERT policy is 0202''s WITH CHECK verbatim (staff AND location_in_org), for authenticated only');
select is(
  (select roles::text || '|' || qual || '|' || with_check
     from pg_policies where schemaname = 'public' and tablename = 'item_stock_levels'
      and policyname = 'item_stock_levels_update'),
  '{authenticated}|( SELECT has_org_role(item_stock_levels.organization_id, ''staff''::text) AS has_org_role)|(( SELECT has_org_role(item_stock_levels.organization_id, ''staff''::text) AS has_org_role) AND ( SELECT location_in_org(item_stock_levels.location_id, item_stock_levels.organization_id) AS location_in_org))',
  'A3: the UPDATE policy is 0202''s USING and WITH CHECK verbatim (location_in_org kept: pattern #24)');
select ok(
  not has_table_privilege('authenticated', 'public.item_stock_levels', 'DELETE')
  and not has_table_privilege('anon', 'public.item_stock_levels', 'DELETE'),
  'A4: no API role holds DELETE on item_stock_levels (0364), so no DELETE policy is needed');

-- ══════════════════════════════════════════════════════════════════════════
-- B. NARROWING: direct SELECT per persona
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.role" to 'authenticated';

set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = :itemA),
  '2/8', 'B1: whT1 STAFF sees 2 of itemA''s 7 holdings, 5 + 3 = 8 (was 7/17 through the FOR ALL policy)');
select is(
  (select string_agg(b.tag, ',' order by b.tag collate "C") from public.item_stock_levels s join lbl b on b.id = s.location_id
    where s.item_id = :itemA),
  'N,W1', 'B2: ... exactly the whT1 bin and the no-warehouse Site');
select is(
  (select count(*)::int from public.item_stock_levels where location_id = :locW2),
  0, 'B3: whT1 STAFF sees no holding of any item at a whT2 bin');
reset role;

set local "request.jwt.claim.sub" to :u_lone;
set local role to 'authenticated';
select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = :itemA),
  '1/3', 'B4: UNASSIGNED staff sees only the no-warehouse Site holding (owner Q3)');
reset role;

set local "request.jwt.claim.sub" to :u_both;
set local role to 'authenticated';
select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = :itemA),
  '7/17', 'B5: whT1+whT2 staff sees all 7 holdings');
reset role;

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = :itemA),
  '7/17', 'B6: a MANAGER sees all 7 holdings');
reset role;

set local "request.jwt.claim.sub" to :u_adm;
set local role to 'authenticated';
select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = :itemA),
  '7/17', 'B7: an ADMIN sees all 7 holdings');
reset role;

set local "request.jwt.claim.sub" to :u_vwr;
set local role to 'authenticated';
select is(
  (select count(*) || '/' || coalesce(sum(quantity), 0)::int from public.item_stock_levels where item_id = :itemA),
  '2/8', 'B8: a whT1 VIEWER is unchanged: 2 holdings, 8 units');
reset role;

set local "request.jwt.claim.sub" to :u_out;
set local role to 'authenticated';
select is(
  (select count(*)::int from public.item_stock_levels where organization_id = :orgS),
  0, 'B9: an org OUTSIDER sees none of the org''s holdings');
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- I. item_holdings_elsewhere
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select is(
  (select string_agg(staged::int || '/' || unplaced::int || '/' || placed::int || '/'
                     || array_to_string(placed_location_ids, ' '), ';')
     from public.item_holdings_elsewhere(array[:itemA::uuid])),
  '2/1/6/' || :locW2 || ' ' || :locW2b,
  'I1: whT1 staff, itemA: 2 in Staging, 1 in Unplaced, 6 placed, on W2 and W2b (the zero row at W2z is not a holding)');
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA::uuid])),
  1, 'I2: one row per item, never one per location');
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemA)
  + (select coalesce(sum(staged + unplaced + placed), 0) from public.item_holdings_elsewhere(array[:itemA::uuid])),
  17::numeric, 'I3: COMPLEMENT (whT1 staff): visible 8 + hidden 9 = the true 17');
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemB::uuid])),
  0, 'I4: an item the caller cannot read (itemB, whT2) gets no row');
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemF::uuid])),
  0, 'I5: another org''s item gets no row');
select is(
  (select string_agg(item_id::text, ',') from public.item_holdings_elsewhere(array[:itemA, :itemB, :itemF, :itemP]::uuid[])),
  :itemA, 'I6: a mixed request returns exactly itemA (itemB unreadable, itemF foreign, itemP has nothing hidden)');
reset role;

set local "request.jwt.claim.sub" to :u_vwr;
set local role to 'authenticated';
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemA)
  + (select coalesce(sum(staged + unplaced + placed), 0) from public.item_holdings_elsewhere(array[:itemA::uuid])),
  17::numeric, 'I7: COMPLEMENT (whT1 viewer): visible + hidden = 17');
reset role;

set local "request.jwt.claim.sub" to :u_both;
set local role to 'authenticated';
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemA)
  + (select coalesce(sum(staged + unplaced + placed), 0) from public.item_holdings_elsewhere(array[:itemA::uuid])),
  17::numeric, 'I8: COMPLEMENT (whT1+whT2 staff): visible 17 + hidden 0 = 17');
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA::uuid])),
  0, 'I9: whT1+whT2 staff has nothing hidden: no row');
reset role;

set local "request.jwt.claim.sub" to :u_mgr;
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA, :itemB]::uuid[])),
  0, 'I10: a MANAGER gets no rows (sees everything; the app skips the call)');
set local "request.jwt.claim.sub" to :u_adm;
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA, :itemB]::uuid[])),
  0, 'I11: an ADMIN gets no rows');
set local "request.jwt.claim.sub" to :u_lone;
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA::uuid])),
  0, 'I12: unassigned staff cannot read itemA: no row');
set local "request.jwt.claim.sub" to :u_out;
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA, :itemB, :itemN]::uuid[])),
  0, 'I13: an org OUTSIDER gets nothing for the org''s items');
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(
  $$select * from public.item_holdings_elsewhere(array(select gen_random_uuid() from generate_series(1, 501)))$$,
  '22023', 'too_many_items', 'I14: more than 500 ids raises 22023 too_many_items');
select lives_ok(
  $$select * from public.item_holdings_elsewhere(array(select gen_random_uuid() from generate_series(1, 500)))$$,
  'I15: exactly 500 ids is accepted');
select is(
  (select count(*)::int from public.item_holdings_elsewhere(null)),
  0, 'I16: a null array gets no rows');
set local "request.jwt.claim.sub" to '';
select is(
  (select count(*)::int from public.item_holdings_elsewhere(array[:itemA::uuid])),
  0, 'I17: a null subject gets no rows');

select ok(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig::text like '%search_path=public%'
          and pg_get_function_result(p.oid) = 'TABLE(item_id uuid, staged numeric, unplaced numeric, placed numeric, placed_location_ids uuid[])'
     from pg_proc p where p.oid = 'public.item_holdings_elsewhere(uuid[])'::regprocedure)
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.item_holdings_elsewhere(uuid[])'::regprocedure
                     and a.grantee = 0 and a.privilege_type = 'EXECUTE')
  and not has_function_privilege('anon', 'public.item_holdings_elsewhere(uuid[])', 'execute')
  and has_function_privilege('authenticated', 'public.item_holdings_elsewhere(uuid[])', 'execute')
  and has_function_privilege('service_role', 'public.item_holdings_elsewhere(uuid[])', 'execute'),
  'I18: item_holdings_elsewhere is SECURITY DEFINER, STABLE, search_path pinned, aggregate-only result, closed to PUBLIC/anon');

-- ══════════════════════════════════════════════════════════════════════════
-- J. location_stock_census
-- ══════════════════════════════════════════════════════════════════════════
-- W2 holds itemA 4 + itemB 6 + itemN 7 = 3 rows / 17. itemN has no warehouse,
-- so even a manager's RLS read (the archive guard's inventory_items!inner
-- embed) misses it: the blindness the census fixes.
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select is(
  (select count(*)::int from public.item_stock_levels s join public.inventory_items i on i.id = s.item_id
    where s.location_id = :locW2 and s.quantity > 0),
  2, 'J0: CONTROL: a manager''s RLS read of W2 through inventory_items sees 2 of its 3 holdings');
reset role;
select is(
  (select holding_rows || '/' || total_quantity::int from public.location_stock_census(:locW2)),
  '3/17', 'J1: a manager''s census of W2 is exact: 3 holdings / 17 units, including an item the manager cannot read');
select is(
  (select holding_rows || '/' || total_quantity::int from public.location_stock_census(:locW2z)),
  '0/0', 'J2: a location holding only a zero row is empty (0/0)');
select throws_ok(
  format($$select * from public.location_stock_census(%L)$$, :nobody),
  '42501', 'forbidden', 'J3: an unknown location raises the same 42501 (no existence oracle)');

set local "request.jwt.claim.sub" to :u_lm;
select is(
  (select holding_rows || '/' || total_quantity::int from public.location_stock_census(:locW2)),
  '3/17', 'J4: whT1 staff WITH locations:manage gets the exact org-wide census of a whT2 bin');
select throws_ok(
  format($$select * from public.location_stock_census(%L)$$, :locF),
  '42501', 'forbidden', 'J5: ... but not of another org''s location');

set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(
  format($$select * from public.location_stock_census(%L)$$, :locW1),
  '42501', 'forbidden', 'J6: staff WITHOUT locations:manage is refused, even at their own bin');
set local "request.jwt.claim.sub" to :u_vwr;
select throws_ok(
  format($$select * from public.location_stock_census(%L)$$, :locW1),
  '42501', 'forbidden', 'J7: a viewer is refused');
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(
  format($$select * from public.location_stock_census(%L)$$, :locW2),
  '42501', 'forbidden', 'J8: an org OUTSIDER is refused');
set local "request.jwt.claim.sub" to '';
select throws_ok(
  format($$select * from public.location_stock_census(%L)$$, :locW2),
  '42501', 'forbidden', 'J9: a null subject is refused');

select ok(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig::text like '%search_path=public%'
          and pg_get_function_result(p.oid) = 'TABLE(holding_rows integer, total_quantity numeric)'
     from pg_proc p where p.oid = 'public.location_stock_census(uuid)'::regprocedure)
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.location_stock_census(uuid)'::regprocedure
                     and a.grantee = 0 and a.privilege_type = 'EXECUTE')
  and not has_function_privilege('anon', 'public.location_stock_census(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.location_stock_census(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.location_stock_census(uuid)', 'execute'),
  'J10: location_stock_census is SECURITY DEFINER, STABLE, search_path pinned, aggregate-only result, closed to PUBLIC/anon');

-- ══════════════════════════════════════════════════════════════════════════
-- C. STAFF RPC PARITY (whT1 staff, public wrappers, as the user)
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -2, 'remove', %L, 'c1')$$, :itemA, :locW1),
  'C1: adjust -2 at the whT1 bin (conditional draw)');
select lives_ok(format($$select public.adjust_stock(%L, 1, 'adjust', %L, 'c2')$$, :itemA, :locW1),
  'C2: adjust +1 at the whT1 bin (upsert onto an existing row)');
select lives_ok(format($$select public.adjust_stock(%L, 2, 'adjust', (select id from public.locations where warehouse_id = %L and kind = 'unplaced'), 'c3')$$, :itemA, :whT1),
  'C3: adjust +2 into whT1 Unplaced (upsert creating a new row)');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 2, 'c4')$$, :itemA, :locW1, :locW1b),
  'C4: transfer 2 whT1 bin -> whT1 bin (new destination row)');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1, 'c5')$$, :itemA, :locW1, :locW1b),
  'C5: transfer 1 whT1 bin -> whT1 bin (existing destination row)');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1, 'c6')$$, :itemA, :locW1b, :locN),
  'C6: transfer 1 whT1 bin -> no-warehouse Site');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1, 'c7')$$, :itemA, :locN, :locW1),
  'C7: transfer 1 no-warehouse Site -> whT1 bin');
select lives_ok(format($$select public.adjust_stock(%L, -1, 'remove', %L, 'c8')$$, :itemA, :locN),
  'C8: adjust -1 at the no-warehouse Site');
select lives_ok(format($$select public.adjust_stock(%L, 1, 'adjust', null, 'c9')$$, :itemA),
  'C9: adjust +1 with no location (lands in whT1 Staging through apply_level_delta)');
select lives_ok(format($$select public.adjust_stock(%L, -1, 'remove', null, 'c10')$$, :itemA),
  'C10: adjust -1 with no location (placed draw-down through apply_level_delta)');
reset role;
-- W1: 5 -2 +1 -2 -1 +1 -1 = 1; W1b: +2 +1 -1 = 2; N: 3 +1 -1 -1 = 2; U1: 2;
-- S1: 1; C10 drew the oldest placed holding, W1.
select is(pg_temp.snap(:itemA), 'N=2,S1=1,S2=2,U1=2,U2=1,W1=1,W1b=2,W2=4,W2b=2,W2z=0',
  'C11: literal itemA holdings after the staff sequence');

-- ══════════════════════════════════════════════════════════════════════════
-- D. ERROR-CODE PARITY (same codes and messages as before 0371)
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select throws_ok(format($$select public.adjust_stock(%L, -3, 'remove', %L)$$, :itemA, :locN),
  'P0001', 'insufficient_stock', 'D1: a draw beyond the holding (3 of 2) raises P0001 insufficient_stock');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW1c, :locW1),
  'P0001', 'insufficient_stock', 'D2: a transfer from a location with no row still raises P0001 insufficient_stock (the dropped seed was dead)');
select throws_ok(format($$select public.adjust_stock(%L, 1, 'adjust', %L)$$, :itemA, :locW2),
  '42501', 'forbidden', 'D3: +1 into a whT2 bin: 42501 forbidden');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW2, :locW1),
  '42501', 'forbidden', 'D4: transfer FROM a whT2 bin: 42501 forbidden');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW1, :locW2),
  '42501', 'forbidden', 'D5: transfer TO a whT2 bin: 42501 forbidden');
-- ORDER pins: only the bodies' own 0365 gates answer 'forbidden' here. Without
-- them the on-hand total guard (D6) or the source draw (D7) would raise P0001
-- first; the helper's identical 'forbidden' is never reached.
select throws_ok(format($$select public.adjust_stock(%L, -1000, 'remove', %L)$$, :itemA, :locW2),
  '42501', 'forbidden', 'D6: -1000 at a whT2 bin is refused by the 0365 gate BEFORE the on-hand guard');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1000)$$, :itemA, :locW1, :locW2),
  '42501', 'forbidden', 'D7: 1000 whT1 -> whT2 is refused by the 0365 gate BEFORE the source draw');
select throws_ok(format($$select public.adjust_stock(%L, -1, 'remove', %L)$$, :itemB, :locW2),
  'P0002', 'item_not_found', 'D8: the whT2 item: P0002 item_not_found (inventory_items RLS on the item lock)');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemB, :locW2, :locW1),
  'P0002', 'item_not_found', 'D9: transfer of the whT2 item: P0002 item_not_found');
select throws_ok(format($$select public.adjust_stock(%L, 1, 'adjust', %L)$$, :itemA, :locF),
  '42501', 'location_org_mismatch', 'D10: a location in another org: 42501 location_org_mismatch');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW1, :locF),
  '42501', 'location_org_mismatch', 'D11: transfer into another org''s location: 42501 location_org_mismatch');
reset role;

set local "request.jwt.claim.sub" to :u_vwr;
set local role to 'authenticated';
select throws_ok(format($$select public.adjust_stock(%L, 1, 'adjust', %L)$$, :itemA, :locW1),
  'P0002', 'item_not_found', 'D12: a whT1 VIEWER adjusting: P0002 (unchanged)');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW1, :locW1b),
  'P0002', 'item_not_found', 'D13: a whT1 VIEWER transferring: P0002 (unchanged)');
reset role;

set local "request.jwt.claim.sub" to :u_lone;
set local role to 'authenticated';
select throws_ok(format($$select public.adjust_stock(%L, 1, 'adjust', %L)$$, :itemA, :locN),
  'P0002', 'item_not_found', 'D14: UNASSIGNED staff adjusting: P0002 (unchanged)');
select throws_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locN, :locW1),
  'P0002', 'item_not_found', 'D15: UNASSIGNED staff transferring: P0002 (unchanged)');
select throws_ok(format($$select public.complete_picking(%L)$$, :ordP),
  '42501', 'forbidden', 'D16: UNASSIGNED staff picking a whT1 order: 42501 forbidden (unchanged)');
reset role;

select is(pg_temp.snap(:itemA) || ' qoh=' || (select quantity_on_hand::int from public.inventory_items where id = :itemA),
  'N=2,S1=1,S2=2,U1=2,U2=1,W1=1,W1b=2,W2=4,W2b=2,W2z=0 qoh=17',
  'D17: every refusal left itemA untouched');

-- ══════════════════════════════════════════════════════════════════════════
-- S. THE OTHER PERSONAS' WRITES, AND complete_picking
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_both;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -1, 'remove', %L)$$, :itemA, :locW2),
  'S1: whT1+whT2 staff adjusts -1 at a whT2 bin');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW2, :locW1),
  'S2: whT1+whT2 staff transfers whT2 -> whT1');
reset role;

set local "request.jwt.claim.sub" to :u_adm;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, 1, 'adjust', (select id from public.locations where warehouse_id = %L and kind = 'staging'))$$, :itemA, :whT2),
  'S3: an admin adjusts +1 into whT2 Staging');
reset role;

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 2)$$, :itemB, :locW2, :locW1),
  'S4: a manager transfers the whT2 item into a whT1 bin (cross-warehouse)');
select lives_ok(format($$select public.adjust_stock(%L, 1, 'adjust', (select id from public.locations where warehouse_id = %L and kind = 'unplaced'))$$, :itemA, :whT2),
  'S5: a manager adjusts +1 into whT2 Unplaced (the helper''s manager branch)');
reset role;

set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.complete_picking(%L)$$, :ordP),
  'S6: whT1 staff completes a whT1 pick (SECURITY DEFINER chain, null-location draw)');
reset role;

select is(pg_temp.snap(:itemA), 'N=2,S1=1,S2=3,U1=2,U2=2,W1=2,W1b=2,W2=2,W2b=2,W2z=0',
  'S7: literal itemA holdings after the whT1+whT2 staff, admin and manager writes');
select is(pg_temp.snap(:itemB) || ' | ' || pg_temp.snap(:itemP),
  'W1=2,W2=4 | W1c=1', 'S8: itemB moved 2 into whT1; the pick drew 2 of itemP''s 3 from W1c');

-- ══════════════════════════════════════════════════════════════════════════
-- H. LEDGER INTEGRITY
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select string_agg(i.sku || ':' || i.quantity_on_hand::int || '=' ||
                     (select coalesce(sum(s.quantity), 0)::int from public.item_stock_levels s where s.item_id = i.id),
                     ',' order by i.sku)
     from public.inventory_items i where i.id in (:itemA, :itemB, :itemP)),
  'HS-0371-A:18=18,HS-0371-B:6=6,HS-0371-P:1=1',
  'H1: for every item touched, on hand equals the sum of its holdings');
select is(
  (select string_agg(x.r, ',' order by x.r collate "C")
     from (select m.movement_type || ':' || m.quantity_change::int || ':' || coalesce(m.moved_quantity::int::text, '-')
                  || ':' || coalesce(bf.tag, '-') || '>' || coalesce(bt.tag, '-') as r
             from public.stock_movements m
             left join lbl bf on bf.id = m.from_location_id
             left join lbl bt on bt.id = m.to_location_id
            where m.item_id = :itemA and m.created_at = now()) x),
  'adjust:1:-:->-,adjust:1:-:->S2,adjust:1:-:->U2,adjust:1:-:->W1,adjust:2:-:->U1,remove:-1:-:->-,remove:-1:-:N>-,remove:-1:-:W2>-,remove:-2:-:W1>-,transfer:0:1:N>W1,transfer:0:1:W1>W1b,transfer:0:1:W1b>N,transfer:0:1:W2>W1,transfer:0:2:W1>W1b',
  'H2: itemA''s movement rows carry the same from/to locations and quantities as before 0371');

-- ══════════════════════════════════════════════════════════════════════════
-- F. THE HELPER'S OWN GATE (direct calls; jwt claim only; flag by hand)
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local stockpilot.ledger to '';
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locW1),
  '42501', 'ledger_only', 'F1: a direct call outside a ledger RPC: 42501 ledger_only');

do $$ begin perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true); end $$;

set local "request.jwt.claim.sub" to :u_vwr;
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locW1),
  '42501', 'forbidden', 'F2: a VIEWER (below the staff floor), even with the flag: 42501 forbidden');
-- caller_can_write_location is TRUE for any member at a location with no
-- warehouse, so here the staff line is the only thing refusing the viewer.
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locN),
  '42501', 'forbidden', 'F3: a VIEWER at the no-warehouse Site: 42501 forbidden (only the staff floor stops it)');
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locW1),
  '42501', 'forbidden', 'F4: an org OUTSIDER: 42501 forbidden');
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locW2),
  '42501', 'forbidden', 'F5: whT1 staff at a whT2 bin (not writable): 42501 forbidden');
select throws_ok(format($$select ledger.apply_holding_delta(%L, null, 1)$$, :itemA),
  '22023', 'location_required', 'F6: a null location: 22023 location_required');
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locF),
  '42501', 'location_org_mismatch', 'F7: another org''s location: 42501 location_org_mismatch');
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :nobody, :locW1),
  '42501', 'forbidden', 'F8: an unknown item answers forbidden to a user (no existence oracle)');
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, -1)$$, :itemA, :locW1c),
  'P0001', 'insufficient_stock', 'F9: a draw with no row: P0001 insufficient_stock');
select lives_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locW1),
  'F10: whT1 staff at a whT1 bin, inside a ledger transaction: allowed');
set local "request.jwt.claim.sub" to :u_mgr;
select lives_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locW2),
  'F11: a manager at a whT2 bin: allowed (manager branch)');
set local "request.jwt.claim.sub" to '';
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :nobody, :locW1),
  'P0002', 'item_not_found', 'F12: service path, unknown item: P0002 item_not_found');
select throws_ok(format($$select ledger.apply_holding_delta(%L, %L, 1)$$, :itemA, :locF),
  '42501', 'location_org_mismatch', 'F13: service path, another org''s location: still 42501 location_org_mismatch');
select lives_ok(format($$select ledger.apply_holding_delta(%L, %L, -1)$$, :itemA, :locW2b),
  'F14: service path draw: allowed');
set local stockpilot.ledger to '';
select is(pg_temp.snap(:itemA), 'N=2,S1=1,S2=3,U1=2,U2=2,W1=3,W1b=2,W2=3,W2b=1,W2z=0',
  'F15: exactly the three allowed calls wrote (W1 +1, W2 +1, W2b -1)');

-- ══════════════════════════════════════════════════════════════════════════
-- G. STRUCTURE
-- ══════════════════════════════════════════════════════════════════════════
select ok(
  (select p.prosecdef and p.proconfig::text like '%search_path=public%' and p.provolatile = 'v'
     from pg_proc p where p.oid = 'ledger.apply_holding_delta(uuid, uuid, numeric)'::regprocedure),
  'G1: ledger.apply_holding_delta is SECURITY DEFINER, VOLATILE, with search_path=public pinned');
select ok(
  not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
               where p.oid = 'ledger.apply_holding_delta(uuid, uuid, numeric)'::regprocedure
                 and a.grantee = 0 and a.privilege_type = 'EXECUTE')
  and not has_function_privilege('anon', 'ledger.apply_holding_delta(uuid, uuid, numeric)', 'execute')
  and has_function_privilege('authenticated', 'ledger.apply_holding_delta(uuid, uuid, numeric)', 'execute')
  and has_function_privilege('service_role', 'ledger.apply_holding_delta(uuid, uuid, numeric)', 'execute'),
  'G2: PUBLIC and anon hold no EXECUTE on the helper; authenticated (the INVOKER bodies call it as the user) and service_role do');
select ok(
  (select bool_and(not p.prosecdef) and count(*) = 2 from pg_proc p
    where p.oid in ('ledger.adjust_stock(uuid, numeric, text, uuid, text, text, text)'::regprocedure,
                    'ledger.transfer_stock(uuid, uuid, uuid, numeric, text)'::regprocedure)),
  'G3: ledger.adjust_stock and ledger.transfer_stock stay SECURITY INVOKER (their item lock under RLS is the per-item authorization)');
select ok(
  (select bool_and(regexp_replace(p.prosrc, '--[^\n]*', '', 'g') !~* 'item_stock_levels') from pg_proc p
    where p.oid in ('ledger.adjust_stock(uuid, numeric, text, uuid, text, text, text)'::regprocedure,
                    'ledger.transfer_stock(uuid, uuid, uuid, numeric, text)'::regprocedure)),
  'G4: neither INVOKER body touches item_stock_levels any more (comments stripped)');
select ok(
  (select p.prosrc ~ 'perform ledger\.apply_holding_delta\(p_item_id, p_location_id, p_quantity_change\);'
     from pg_proc p where p.oid = 'ledger.adjust_stock(uuid, numeric, text, uuid, text, text, text)'::regprocedure)
  and (select p.prosrc ~ 'perform ledger\.apply_holding_delta\(p_item_id, p_from_location_id, -p_quantity\);[\s\S]*perform ledger\.apply_holding_delta\(p_item_id, p_to_location_id, p_quantity\);'
     from pg_proc p where p.oid = 'ledger.transfer_stock(uuid, uuid, uuid, numeric, text)'::regprocedure),
  'G5: both bodies write holdings only through ledger.apply_holding_delta (transfer: source, then destination)');
select ok(
  (select p.prosrc ~ 'if p_location_id is not null\s+and not public\.has_org_role\(v_item\.organization_id, ''manager''\)\s+and not public\.caller_can_write_location\(p_location_id\) then\s+raise exception ''forbidden'' using errcode = ''42501'';'
     from pg_proc p where p.oid = 'ledger.adjust_stock(uuid, numeric, text, uuid, text, text, text)'::regprocedure)
  and (select p.prosrc ~ 'if not public\.has_org_role\(v_item\.organization_id, ''manager''\)\s+and not \(public\.caller_can_write_location\(p_from_location_id\)\s+and public\.caller_can_write_location\(p_to_location_id\)\) then\s+raise exception ''forbidden'' using errcode = ''42501'';'
     from pg_proc p where p.oid = 'ledger.transfer_stock(uuid, uuid, uuid, numeric, text)'::regprocedure),
  'G6: the restated bodies keep their 0365 write-location gates verbatim');
select is(
  (select string_agg(distinct m[1], ',' order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, 'errcode\s*=\s*''([0-9A-Z]{5})''', 'g') m
    where p.oid in ('ledger.apply_holding_delta(uuid, uuid, numeric)'::regprocedure,
                    'public.item_holdings_elsewhere(uuid[])'::regprocedure,
                    'public.location_stock_census(uuid)'::regprocedure)),
  '22023,42501,P0001,P0002',
  'G7: the three new functions raise only 22023, 42501, P0001 and P0002 (never a retryable 40001/40P01)');

-- ══════════════════════════════════════════════════════════════════════════
-- E. DIVERGENCE KILL (last: replaces the SELECT policy inside this rolled-back
--    transaction). A SELECT policy that hides EVERY holding from staff: the
--    staff RPC writes must still succeed, because no holdings statement reads
--    through the caller's SELECT scope any more.
-- ══════════════════════════════════════════════════════════════════════════
drop policy item_stock_levels_select on public.item_stock_levels;
create policy item_stock_levels_select on public.item_stock_levels for select to authenticated
  using ((select public.has_org_role(organization_id, 'manager')));

set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select is(
  (select count(*)::int from public.item_stock_levels where item_id = :itemA),
  0, 'E1: CONTROL: under the hide-everything policy whT1 staff sees no holding at all');
select lives_ok(format($$select public.adjust_stock(%L, -1, 'remove', %L)$$, :itemA, :locW1b),
  'E2: staff draw -1 at an INVISIBLE whT1 holding still succeeds');
select lives_ok(format($$select public.adjust_stock(%L, 2, 'adjust', %L)$$, :itemA, :locW1b),
  'E3: staff +2 upsert onto an INVISIBLE existing row still succeeds');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW1b, :locW1),
  'E4: staff transfer between two INVISIBLE rows still succeeds');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1)$$, :itemA, :locW1, :locW1c),
  'E5: staff transfer into a NEW row still succeeds');
reset role;
select is(
  pg_temp.snap(:itemA) || ' qoh=' || (select quantity_on_hand::int from public.inventory_items where id = :itemA),
  'N=2,S1=1,S2=3,U1=2,U2=2,W1=3,W1b=2,W1c=1,W2=3,W2b=1,W2z=0 qoh=19',
  'E6: literal: W1b 2 -1 +2 -1 = 2, W1 3 +1 -1 = 3, W1c new 1; on hand 18 -1 +2 = 19');

select * from finish();
rollback;
