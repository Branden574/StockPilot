-- supabase/tests/0361_rental_rpcs.test.sql
-- Proves migration 0361 (rental checkout, return and cancel as single
-- transactions).
--
-- PART 1 (1-4)   Grants, and the lock that serializes checkouts.
-- PART 2 (5-19)  create_rental: header, lines and holds together; the
--                availability check counts other holds and aggregates
--                duplicate lines; every refusal writes nothing.
-- PART 3 (20-29) return_rental / cancel_rental: out -> returned / cancelled
--                with the holds released in the same call; idempotent; the
--                permission and warehouse gates; other orgs see nothing.
--
-- Actors are set with request.jwt.claim.sub (the functions are SECURITY
-- DEFINER and gate on auth.uid()). Run via `supabase test db` after
-- `supabase db reset`.

begin;
select plan(29);

\set orgA   '\'03610000-0000-0000-0000-00000000000a\''
\set orgB   '\'03610000-0000-0000-0000-00000000000b\''
\set u_stf  '\'03610000-0000-0000-0000-0000000000a1\''
\set u_mgr  '\'03610000-0000-0000-0000-0000000000a2\''
\set u_vwr  '\'03610000-0000-0000-0000-0000000000a3\''
\set u_out  '\'03610000-0000-0000-0000-0000000000a4\''
\set u_mgrB '\'03610000-0000-0000-0000-0000000000b1\''
\set whA    '\'03610000-0000-0000-0000-0000000000c1\''
\set whA2   '\'03610000-0000-0000-0000-0000000000c2\''
\set whB    '\'03610000-0000-0000-0000-0000000000c3\''
\set rA     '\'03610000-0000-0000-0000-0000000000d1\''
\set nA     '\'03610000-0000-0000-0000-0000000000d2\''
\set rA2    '\'03610000-0000-0000-0000-0000000000d3\''
\set rB     '\'03610000-0000-0000-0000-0000000000d4\''
\set held   '\'03610000-0000-0000-0000-0000000000e1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_stf,  'stf-0361@test.local',  '{"full_name":"Staff 0361"}'::jsonb),
  (:u_mgr,  'mgr-0361@test.local',  '{}'::jsonb),
  (:u_vwr,  'vwr-0361@test.local',  '{}'::jsonb),
  (:u_out,  'out-0361@test.local',  '{}'::jsonb),
  (:u_mgrB, 'mgrb-0361@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Rental Org A 0361', 'rental-org-a-0361'),
  (:orgB, 'Rental Org B 0361', 'rental-org-b-0361');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_stf,  'staff',   now()),
  (:orgA, :u_mgr,  'manager', now()),
  (:orgA, :u_vwr,  'viewer',  now()),
  (:orgB, :u_mgrB, 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:orgA, 'rentals', true, 'optional'),
  (:orgB, 'rentals', true, 'optional')
on conflict (organization_id, module_id) do update set enabled = true;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, 'Rental WH A 0361',  'R0361A',  'active'),
  (:whA2, :orgA, 'Rental WH A2 0361', 'R0361A2', 'active'),
  (:whB,  :orgB, 'Rental WH B 0361',  'R0361B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :u_stf, :whA, true),
  (:orgA, :u_vwr, :whA, true);
-- A viewer granted rentals:create still has only READ on the warehouse.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :u_vwr, 'rentals:create', true);

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, is_rental, status, item_type) values
  (:rA,  :orgA, :whA,  'R0361-A',  'Projector A', 5, true,  'active', 'asset'),
  (:nA,  :orgA, :whA,  'R0361-N',  'Not rental',  5, false, 'active', 'asset'),
  (:rA2, :orgA, :whA2, 'R0361-A2', 'Projector 2', 5, true,  'active', 'asset'),
  (:rB,  :orgB, :whB,  'R0361-B',  'Projector B', 5, true,  'active', 'asset');

-- 3 of Projector A are already out on another rental.
insert into public.rentals (id, organization_id, warehouse_id, borrower_name, expected_return_at, status) values
  (:held, :orgA, :whA, 'Earlier borrower', now() + interval '7 days', 'out');
insert into public.stock_reservations (organization_id, item_id, warehouse_id, quantity, rental_id) values
  (:orgA, :rA, :whA, 3, :held);

-- ═══ PART 1 ═════════════════════════════════════════════════════════════════
select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('create_rental', 'return_rental', 'cancel_rental')),
  '1: authenticated may call the three rental functions');
select ok(
  not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
               where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('create_rental', 'return_rental', 'cancel_rental')
                 and a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole)),
  '2: PUBLIC and anon may not');
select ok(
  not exists (select 1 from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
               where has_table_privilege('authenticated', 'public.stock_reservations', p)
                  or has_table_privilege('anon', 'public.stock_reservations', p)),
  '3: no API role writes stock_reservations (the policies already refused; now the grants do too)');
select ok(
  (select p.prosrc ~* 'order by it\.id\s+for update of it' from pg_proc p
    where p.oid = 'public.create_rental(uuid, uuid, text, text, timestamptz, text, jsonb)'::regprocedure),
  '4: checkout locks the requested items in id order before checking availability (serializes the last unit)');

-- ═══ PART 2: create_rental ══════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;

create temp table t_r (id uuid) on commit drop;
insert into t_r select public.create_rental(:whA, null, 'Borrower One', 'b1@test.local',
  now() + interval '3 days', 'first',
  jsonb_build_array(jsonb_build_object('item_id', :rA, 'quantity', 2, 'notes', 'with cable')));

select is((select row(organization_id, warehouse_id, status, created_by, borrower_name)::text
             from public.rentals where id = (select id from t_r)),
  row(:orgA::uuid, :whA::uuid, 'out', :u_stf::uuid, 'Borrower One')::text,
  '5: staff checks out: the rental is out, in the warehouse''s org, created by the caller');
select is((select count(*)::int from public.rental_lines where rental_id = (select id from t_r) and quantity = 2 and notes = 'with cable'), 1,
  '6: ... its line was written');
select is((select sum(quantity) from public.stock_reservations where rental_id = (select id from t_r) and released_at is null), 2::numeric,
  '7: ... and its hold, in the same call');

select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :rA),
  '22023', 'Projector A: only 0 available to rent (5 on hand, 5 already reserved) — 1 requested.',
  '8: the next unit is refused: 5 on hand, 3 + 2 already held');
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1),
                             jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :rA2, :rA2),
  '22023', 'All items must be in the rental warehouse.',
  '9: an item from another warehouse is refused');
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :nA),
  '22023', 'One or more items are not rental items.',
  '10: a non-rental item is refused');
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :rB),
  'P0002', 'One or more items were not found.',
  '11: another org''s item is not found');
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() - interval '2 days', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :rA),
  '22023', 'Expected return date must be in the future.',
  '12: a return date in the past is refused');
select throws_ok(
  format($$select public.create_rental(%L, %L, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :u_out, :rA),
  '22023', 'borrower_not_member',
  '13: a borrower who is not a member of the org is refused');
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 0)))$$, :whA, :rA),
  '22023', 'lines_invalid',
  '14: a zero quantity is refused');
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whB, :rB),
  'P0002', 'warehouse_not_found',
  '15: another org''s warehouse is not found');

set local "request.jwt.claim.sub" to :u_vwr;
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Two', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$$, :whA, :rA),
  '42501', 'forbidden',
  '16: a viewer holding rentals:create but only read access to the warehouse is refused');

select is((select count(*)::int from public.rentals where organization_id = :orgA), 2,
  '17: none of the refused checkouts left a header');
select is((select count(*)::int from public.stock_reservations where organization_id = :orgA and released_at is null), 2,
  '18: ... or a hold');

-- The duplicate-line trap: two lines of one item are summed before comparing.
update public.stock_reservations set released_at = now() where rental_id = :held;
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(
  format($$select public.create_rental(%L, null, 'Borrower Three', null, now() + interval '1 day', null,
           jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 2),
                             jsonb_build_object('item_id', %L, 'quantity', 2)))$$, :whA, :rA, :rA),
  '22023', 'Projector A: only 3 available to rent (5 on hand, 2 already reserved) — 4 requested.',
  '19: two lines of the same item are counted together (2 + 2 > 3 available)');

-- ═══ PART 3: return_rental / cancel_rental ══════════════════════════════════
select is(public.return_rental((select id from t_r), 'all good'), 'returned',
  '20: staff returns the rental');
select is((select row(status, returned_by, return_notes)::text from public.rentals where id = (select id from t_r)),
  row('returned', :u_stf::uuid, 'all good')::text,
  '21: ... it is returned, by the caller');
select is((select count(*)::int from public.stock_reservations
            where rental_id = (select id from t_r) and released_reason = 'rental_returned' and released_at is not null), 1,
  '22: ... and its hold was released in the same call');
select is(public.return_rental((select id from t_r), 'again'), 'noop',
  '23: returning it again is a no-op');

update public.stock_reservations set released_at = null, released_reason = null where rental_id = :held;
select throws_ok(
  format($$select public.cancel_rental(%L, 'changed plans')$$, :held),
  '42501', 'forbidden',
  '24: staff (no rentals:manage) cannot cancel');
set local "request.jwt.claim.sub" to :u_mgrB;
select throws_ok(
  format($$select public.return_rental(%L, null)$$, :held),
  'P0002', 'rental_not_found',
  '25: another org''s manager cannot see the rental');
set local "request.jwt.claim.sub" to :u_mgr;
select is(public.cancel_rental(:held, 'changed plans'), 'cancelled',
  '26: a manager cancels');
select is((select row(status, cancelled_by, cancellation_reason)::text from public.rentals where id = :held),
  row('cancelled', :u_mgr::uuid, 'changed plans')::text,
  '27: ... it is cancelled, by the caller');
select is((select count(*)::int from public.stock_reservations
            where rental_id = :held and released_reason = 'rental_cancelled' and released_at is not null), 1,
  '28: ... and its hold was released');
set local "request.jwt.claim.sub" to '';
select throws_ok(
  format($$select public.return_rental(%L, null)$$, :held),
  '42501', 'forbidden',
  '29: an unauthenticated call is refused');

select * from finish();
rollback;
