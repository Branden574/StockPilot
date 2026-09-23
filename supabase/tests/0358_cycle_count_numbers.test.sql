-- supabase/tests/0358_cycle_count_numbers.test.sql
-- Proves migration 0358: permanent per-org cycle-count references and the
-- server-side history list.
--
--   A. Shape: column NOT NULL + > 0, unique per org, the list index, the
--      counter table locked away from the API roles, grants.
--   B. Allocation: per-org series from 1, the server's number overwrites a
--      client's, start_cycle_count (the RPC every app path uses) draws one,
--      an empty-scope start that rolls back spends nothing, a deleted count's
--      number is never handed out again, a lost counter row reseeds ABOVE the
--      org's highest number.
--   C. Immutability: the number and the org cannot change; ordinary edits,
--      assignment and cancellation keep the number.
--   D. Backfill: the real _backfill_cycle_count_numbers() re-run against
--      legacy rows (completed, canceled, empty-note, mixed-warehouse
--      selection, tied started_at): numbered started_at ASC, id ASC, above
--      any number already held, updated_at untouched, no notifications,
--      counters raised, idempotent.
--   E. format_cycle_count_number matches the TypeScript helper's boundaries.
--   F. The assignment notification names the reference.
--   G. cycle_counts_page as real users: 25 per page, clamped pages, the uuid
--      tie-break, exact number / literal text / warehouse / status /
--      started-from filters, identical totals, line progress, and the
--      warehouse-restricted member's scope (own null-warehouse assignments
--      included, a guessed reference outside it and another org's id
--      returning nothing).
--
-- Namespace cc035800. Wrapped in begin/rollback: nothing leaks.

begin;

select plan(69);

\set orgA '\'cc035800-0000-4000-8000-00000000000a\''
\set orgB '\'cc035800-0000-4000-8000-00000000000b\''
\set orgC '\'cc035800-0000-4000-8000-00000000000c\''
\set orgD '\'cc035800-0000-4000-8000-00000000000d\''
\set mgrA '\'cc035800-0000-4000-8000-0000000000a1\''
\set mgrD '\'cc035800-0000-4000-8000-0000000000a3\''
\set stfD '\'cc035800-0000-4000-8000-0000000000a4\''
\set whA1 '\'cc035800-0000-4000-8000-0000000000b1\''
\set whB  '\'cc035800-0000-4000-8000-0000000000b3\''
\set whD1 '\'cc035800-0000-4000-8000-0000000000b4\''
\set whD2 '\'cc035800-0000-4000-8000-0000000000b5\''
\set whC1 '\'cc035800-0000-4000-8000-0000000000b6\''
\set whC2 '\'cc035800-0000-4000-8000-0000000000b7\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgrA, 'mgrA-0358@test.local', '{}'::jsonb),
  (:mgrD, 'mgrD-0358@test.local', '{}'::jsonb),
  (:stfD, 'stfD-0358@test.local', '{"full_name":"Dana Stafford"}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'CC Numbers A', 'cc-numbers-a-0358'),
  (:orgB, 'CC Numbers B', 'cc-numbers-b-0358'),
  (:orgC, 'CC Numbers C', 'cc-numbers-c-0358'),
  (:orgD, 'CC Numbers D', 'cc-numbers-d-0358')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgrA, 'manager', now()),
  (:orgD, :mgrD, 'manager', now()),
  (:orgD, :stfD, 'staff',   now())
  on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'A One',        'A1-0358', 'active'),
  (:whB,  :orgB, 'B One',        'B1-0358', 'active'),
  (:whC1, :orgC, 'C One',        'C1-0358', 'active'),
  (:whC2, :orgC, 'C Two',        'C2-0358', 'active'),
  (:whD1, :orgD, 'Delta North',  'DN-0358', 'active'),
  (:whD2, :orgD, 'Delta South',  'DS-0358', 'active')
  on conflict (id) do nothing;

-- Staff D may work in Delta North only.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id)
  values (:orgD, :stfD, :whD1) on conflict do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  ('cc035800-0000-4000-8000-0000000000c1', :orgA, :whA1, 'A-0358-1', 'A item 1', 5, 'active', 'none'),
  ('cc035800-0000-4000-8000-0000000000c2', :orgA, :whA1, 'A-0358-2', 'A item 2', 3, 'active', 'none'),
  ('cc035800-0000-4000-8000-0000000000d1', :orgD, :whD1, 'D-0358-1', 'D item 1', 4, 'active', 'none'),
  ('cc035800-0000-4000-8000-0000000000d2', :orgD, :whD1, 'D-0358-2', 'D item 2', 4, 'active', 'none'),
  ('cc035800-0000-4000-8000-0000000000d3', :orgD, :whD1, 'D-0358-3', 'D item 3', 4, 'active', 'none')
  on conflict (id) do nothing;

-- ═══ A. Shape ════════════════════════════════════════════════════════════
select col_not_null('public', 'cycle_counts', 'count_number', 'A1: count_number is NOT NULL');
select ok(
  exists (select 1 from pg_constraint
          where conrelid = 'public.cycle_counts'::regclass
            and conname = 'cycle_counts_count_number_positive'),
  'A2: count_number must be positive');
select ok(
  exists (select 1 from pg_indexes
          where schemaname = 'public' and indexname = 'cycle_counts_org_count_number_uniq'
            and indexdef ilike '%unique%(organization_id, count_number)%'),
  'A3: (organization_id, count_number) is unique');
select ok(
  exists (select 1 from pg_indexes
          where schemaname = 'public' and indexname = 'cycle_counts_org_started_id_idx'),
  'A4: the history order has its index');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.cycle_count_number_counters'::regclass),
  'A5: the counter table has RLS on');
select ok(
  not has_table_privilege('authenticated', 'public.cycle_count_number_counters', 'select')
  and not has_table_privilege('authenticated', 'public.cycle_count_number_counters', 'update')
  and not has_table_privilege('authenticated', 'public.cycle_count_number_counters', 'insert')
  and not has_table_privilege('authenticated', 'public.cycle_count_number_counters', 'delete')
  and not has_table_privilege('anon', 'public.cycle_count_number_counters', 'select'),
  'A6: no API role can read or write the counters');
select ok(
  has_function_privilege('authenticated',
    'public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer)', 'execute')
  and not has_function_privilege('anon',
    'public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer)', 'execute'),
  'A7: the list is callable by signed-in users only');
select ok(
  not has_function_privilege('authenticated', 'public.tg_cycle_counts_assign_number()', 'execute')
  and not has_function_privilege('anon', 'public.tg_cycle_counts_assign_number()', 'execute')
  and not has_function_privilege('authenticated', 'public.tg_cycle_counts_number_immutable()', 'execute'),
  'A8: the trigger functions are not executable by API roles');
select ok(
  not has_function_privilege('authenticated', 'public._backfill_cycle_count_numbers()', 'execute')
  and not has_function_privilege('anon', 'public._backfill_cycle_count_numbers()', 'execute')
  and not has_function_privilege('service_role', 'public._backfill_cycle_count_numbers()', 'execute'),
  'A9: the one-shot backfill has no runtime caller');
select ok(
  (select prosecdef from pg_proc where oid = 'public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer)'::regprocedure) = false,
  'A10: the list is SECURITY INVOKER (RLS applies)');

-- ═══ B. Allocation ═══════════════════════════════════════════════════════
insert into public.cycle_counts (id, organization_id, warehouse_id, status, started_at) values
  ('cc035800-0000-4000-8000-0000000a0001', :orgA, :whA1, 'completed', now() - interval '3 days'),
  ('cc035800-0000-4000-8000-0000000a0002', :orgA, :whA1, 'completed', now() - interval '2 days');
insert into public.cycle_counts (id, organization_id, warehouse_id, status)
  values ('cc035800-0000-4000-8000-0000000b0001', :orgB, :whB, 'in_progress');

select results_eq(
  $$ select count_number from public.cycle_counts
     where organization_id = 'cc035800-0000-4000-8000-00000000000a' order by count_number $$,
  $$ values (1::bigint), (2::bigint) $$,
  'B1: an org''s first counts are 1 and 2');
select is(
  (select count_number from public.cycle_counts where id = 'cc035800-0000-4000-8000-0000000b0001'),
  1::bigint, 'B2: numbering is per organization (org B starts at 1)');

-- A client-chosen number is replaced by the server's.
insert into public.cycle_counts (id, organization_id, warehouse_id, status, count_number)
  values ('cc035800-0000-4000-8000-0000000a0003', :orgA, :whA1, 'completed', 999);
select is(
  (select count_number from public.cycle_counts where id = 'cc035800-0000-4000-8000-0000000a0003'),
  3::bigint, 'B3: a count_number supplied on insert is overwritten by the next number');

-- The RPC every app path goes through (warehouse / selection / group counts).
set local "request.jwt.claim.sub" to 'cc035800-0000-4000-8000-0000000000a1';
-- (Read back in the NEXT statement: a query cannot see rows its own function
-- call inserted, because its snapshot predates the call.)
select cycle_count_id as b4_id from public.start_cycle_count(
  'cc035800-0000-4000-8000-00000000000a', 'selection', null, null,
  array['cc035800-0000-4000-8000-0000000000c1']::uuid[], 'rpc start') \gset
select is(
  (select count_number from public.cycle_counts where id = :'b4_id'),
  4::bigint, 'B4: start_cycle_count draws the next number');

-- An empty scope raises inside start_cycle_count; its header and its number
-- roll back together.
select throws_ok(
  $$ select * from public.start_cycle_count(
       'cc035800-0000-4000-8000-00000000000a', 'selection', null, null,
       array['cc035800-0000-4000-8000-00000000ffff']::uuid[], 'empty') $$,
  'P0001', 'cycle_count_no_items',
  'B5: an empty-scope start fails');
select cycle_count_id as b6_id from public.start_cycle_count(
  'cc035800-0000-4000-8000-00000000000a', 'warehouse',
  'cc035800-0000-4000-8000-0000000000b1', 'cc035800-0000-4000-8000-0000000000b1',
  null, 'after empty') \gset
select is(
  (select count_number from public.cycle_counts where id = :'b6_id'),
  5::bigint, 'B6: the failed start spent no number (next is 5, not 6)');

-- Delete the newest count: its number is never handed out again.
delete from public.cycle_counts where organization_id = :orgA and count_number = 5;
insert into public.cycle_counts (id, organization_id, warehouse_id, status)
  values ('cc035800-0000-4000-8000-0000000a0006', :orgA, :whA1, 'in_progress');
select is(
  (select count_number from public.cycle_counts where id = 'cc035800-0000-4000-8000-0000000a0006'),
  6::bigint, 'B7: a deleted count''s number is not reused (MAX+1 would have given 5)');

-- A lost counter row reseeds from the org's highest number, never from 1.
delete from public.cycle_count_number_counters where organization_id = :orgA;
insert into public.cycle_counts (id, organization_id, warehouse_id, status)
  values ('cc035800-0000-4000-8000-0000000a0007', :orgA, :whA1, 'in_progress');
select is(
  (select count_number from public.cycle_counts where id = 'cc035800-0000-4000-8000-0000000a0007'),
  7::bigint, 'B8: a missing counter row reseeds above the highest number');
select is(
  (select last_number from public.cycle_count_number_counters where organization_id = :orgA),
  7::bigint, 'B9: the counter holds the last number handed out');
select is(
  (select count(*)::int from public.cycle_counts where organization_id = :orgA)
    = (select count(distinct count_number)::int from public.cycle_counts where organization_id = :orgA),
  true, 'B10: no two counts in the org share a number');

-- ═══ C. Immutability ═════════════════════════════════════════════════════
select throws_ok(
  $$ update public.cycle_counts set count_number = 42
     where id = 'cc035800-0000-4000-8000-0000000a0001' $$,
  '42501', 'cycle_count_number_immutable',
  'C1: a count''s number cannot be changed');
select throws_ok(
  $$ update public.cycle_counts set organization_id = 'cc035800-0000-4000-8000-00000000000b'
     where id = 'cc035800-0000-4000-8000-0000000a0001' $$,
  '42501', 'cycle_count_org_immutable',
  'C2: a count cannot move to another organization''s series');
select throws_ok(
  $$ update public.cycle_counts set count_number = null
     where id = 'cc035800-0000-4000-8000-0000000a0001' $$,
  '42501', 'cycle_count_number_immutable',
  'C3: a count''s number cannot be cleared');

update public.cycle_counts
   set notes = 'edited', assigned_to = :mgrA
 where id = 'cc035800-0000-4000-8000-0000000a0006';
update public.cycle_counts
   set status = 'canceled', canceled_at = now()
 where id = 'cc035800-0000-4000-8000-0000000a0006';
select is(
  (select count_number from public.cycle_counts where id = 'cc035800-0000-4000-8000-0000000a0006'),
  6::bigint, 'C4: notes, assignment and cancellation keep the number');
select lives_ok(
  $$ update public.cycle_counts set count_number = count_number
     where id = 'cc035800-0000-4000-8000-0000000a0001' $$,
  'C5: writing the same number back is not a change');

-- ═══ D. Backfill (the real function, against legacy rows) ═══════════════
-- Recreate the pre-0358 world for org C: rows with no number, inserted with
-- the allocator off and NOT NULL relaxed (all inside this rolled-back
-- transaction). One row already carries a number (7) to prove it is kept and
-- numbering continues above it.
alter table public.cycle_counts disable trigger trg_cycle_counts_assign_number;
alter table public.cycle_counts alter column count_number drop not null;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, scope, status, notes, started_at, completed_at, canceled_at,
   assigned_to, created_at, updated_at, count_number)
values
  -- oldest: completed, real warehouse, empty note
  ('cc035800-0000-4000-8000-0000000c0001', :orgC, :whC1, 'warehouse', 'completed', '',
   timestamptz '2024-01-01 10:00+00', timestamptz '2024-01-02 10:00+00', null, null,
   timestamptz '2024-01-01 10:00+00', timestamptz '2024-01-05 10:00+00', null),
  -- canceled, org-wide, null note
  ('cc035800-0000-4000-8000-0000000c0002', :orgC, null, 'warehouse', 'canceled', null,
   timestamptz '2024-02-01 10:00+00', null, timestamptz '2024-02-02 10:00+00', null,
   timestamptz '2024-02-01 10:00+00', timestamptz '2024-02-05 10:00+00', null),
  -- three counts started at the same instant; the uuid decides (…0005 < …0009 < …000f)
  ('cc035800-0000-4000-8000-0000000c000f', :orgC, null, 'selection', 'completed', 'mixed pick',
   timestamptz '2024-03-01 10:00+00', timestamptz '2024-03-02 10:00+00', null, :mgrA,
   timestamptz '2024-03-01 10:00+00', timestamptz '2024-03-05 10:00+00', null),
  ('cc035800-0000-4000-8000-0000000c0005', :orgC, :whC2, 'selection', 'completed', 'tie a',
   timestamptz '2024-03-01 10:00+00', timestamptz '2024-03-02 10:00+00', null, null,
   timestamptz '2024-03-01 10:00+00', timestamptz '2024-03-05 10:00+00', null),
  ('cc035800-0000-4000-8000-0000000c0009', :orgC, :whC1, 'warehouse', 'completed', 'tie b',
   timestamptz '2024-03-01 10:00+00', timestamptz '2024-03-02 10:00+00', null, null,
   timestamptz '2024-03-01 10:00+00', timestamptz '2024-03-05 10:00+00', null),
  -- newest: still open
  ('cc035800-0000-4000-8000-0000000c0006', :orgC, :whC1, 'warehouse', 'in_progress', 'open',
   timestamptz '2024-04-01 10:00+00', null, null, null,
   timestamptz '2024-04-01 10:00+00', timestamptz '2024-04-05 10:00+00', null),
  -- already numbered (a partial earlier rollout): kept as 7
  ('cc035800-0000-4000-8000-0000000c0007', :orgC, :whC1, 'warehouse', 'completed', 'kept',
   timestamptz '2023-06-01 10:00+00', timestamptz '2023-06-02 10:00+00', null, null,
   timestamptz '2023-06-01 10:00+00', timestamptz '2023-06-05 10:00+00', 7);

create temp table _cc0358_before on commit drop as
  select id, updated_at, started_at, completed_at, canceled_at, status, notes, assigned_to, warehouse_id
  from public.cycle_counts where organization_id = :orgC;
create temp table _cc0358_notif on commit drop as
  select count(*) as n from public.notifications;

select is(public._backfill_cycle_count_numbers() >= 6, true,
  'D1: the backfill numbers the legacy rows');

select results_eq(
  $$ select id::text, count_number from public.cycle_counts
     where organization_id = 'cc035800-0000-4000-8000-00000000000c'
     order by count_number $$,
  $$ values
       ('cc035800-0000-4000-8000-0000000c0007', 7::bigint),
       ('cc035800-0000-4000-8000-0000000c0001', 8::bigint),
       ('cc035800-0000-4000-8000-0000000c0002', 9::bigint),
       ('cc035800-0000-4000-8000-0000000c0005', 10::bigint),
       ('cc035800-0000-4000-8000-0000000c0009', 11::bigint),
       ('cc035800-0000-4000-8000-0000000c000f', 12::bigint),
       ('cc035800-0000-4000-8000-0000000c0006', 13::bigint) $$,
  'D2: oldest first by started_at then id, above the number already held (7 kept)');
select is(
  (select count(*)::int from _cc0358_before b join public.cycle_counts c using (id)
    where b.updated_at is distinct from c.updated_at),
  0, 'D3: updated_at is untouched by the backfill');
select is(
  (select count(*)::int from _cc0358_before b join public.cycle_counts c using (id)
    where (b.started_at, b.completed_at, b.canceled_at, b.status, b.notes, b.assigned_to, b.warehouse_id)
      is distinct from (c.started_at, c.completed_at, c.canceled_at, c.status, c.notes, c.assigned_to, c.warehouse_id)),
  0, 'D4: no date, status, note, assignee or warehouse changes');
select is(
  (select count(*) from public.notifications) - (select n from _cc0358_notif),
  0::bigint, 'D5: the backfill sends no notifications');
select is(
  (select last_number from public.cycle_count_number_counters where organization_id = :orgC),
  13::bigint, 'D6: the org''s counter starts above every backfilled number');
select is(public._backfill_cycle_count_numbers(), 0::bigint,
  'D7: a second run numbers nothing');
select ok(
  (select tgenabled = 'O' from pg_trigger
    where tgrelid = 'public.cycle_counts'::regclass and tgname = 'cycle_counts_updated_at'),
  'D8: the updated_at trigger is back on after the backfill');

alter table public.cycle_counts alter column count_number set not null;
alter table public.cycle_counts enable trigger trg_cycle_counts_assign_number;

insert into public.cycle_counts (id, organization_id, warehouse_id, status)
  values ('cc035800-0000-4000-8000-0000000c0010', :orgC, :whC1, 'in_progress');
select is(
  (select count_number from public.cycle_counts where id = 'cc035800-0000-4000-8000-0000000c0010'),
  14::bigint, 'D9: live allocation continues after the backfilled series');

-- ═══ E. SQL formatter matches the TypeScript helper ══════════════════════
select is(public.format_cycle_count_number(1), 'CC-000001', 'E1: pads to six digits');
select is(public.format_cycle_count_number(42), 'CC-000042', 'E2: CC-000042');
select is(public.format_cycle_count_number(999999), 'CC-999999', 'E3: six nines');
select is(public.format_cycle_count_number(1000000), 'CC-1000000', 'E4: seven digits are not truncated');
select is(public.format_cycle_count_number(0), null, 'E5: zero has no reference');

-- ═══ F. Notification names the reference ═════════════════════════════════
update public.cycle_counts set assigned_to = :mgrA, notes = 'Aisle 4'
 where id = 'cc035800-0000-4000-8000-0000000a0007';
select is(
  (select title from public.notifications
    where metadata->>'cycle_count_id' = 'cc035800-0000-4000-8000-0000000a0007'
    order by created_at desc limit 1),
  'Cycle count assigned to you: CC-000007 · Aisle 4',
  'F1: the assignment notification leads with the reference');
select is(
  (select (metadata->>'count_number')::bigint from public.notifications
    where metadata->>'cycle_count_id' = 'cc035800-0000-4000-8000-0000000a0007' limit 1),
  7::bigint, 'F2: its metadata carries the number');

-- ═══ G. The history list, as real users ══════════════════════════════════
-- Org D: 137 counts, numbered 1..137 in start order. Warehouse by n % 3
-- (0 North, 1 South, 2 none: a selection, assigned to staff D when n % 6 = 2).
-- Counts 50, 51 and 52 share one start instant and their uuids run the other
-- way (50 has the largest), so only the uuid can order them.
insert into public.cycle_counts
  (id, organization_id, warehouse_id, scope, status, notes, started_by, started_at, assigned_to)
select
  case n when 50 then 'cc035800-0000-4000-8001-0000000000f3'::uuid
         when 51 then 'cc035800-0000-4000-8001-0000000000f1'::uuid
         when 52 then 'cc035800-0000-4000-8001-0000000000f2'::uuid
         else ('cc035800-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid end,
  'cc035800-0000-4000-8000-00000000000d',
  case n % 3 when 0 then 'cc035800-0000-4000-8000-0000000000b4'::uuid
             when 1 then 'cc035800-0000-4000-8000-0000000000b5'::uuid end,
  case when n % 3 = 2 then 'selection' else 'warehouse' end,
  case when n >= 130 then 'in_progress' when n % 10 = 0 then 'canceled' else 'completed' end,
  case n % 5 when 0 then null
             when 1 then ''
             when 2 then 'Aisle ' || n || ' bay 50'
             when 3 then '50% off shelf_' || n
             else 'O''Brien shelfX1 (Q' || (n % 4 + 1) || ') count' end,
  'cc035800-0000-4000-8000-0000000000a3',
  case when n in (50, 51, 52) then timestamptz '2025-02-21 12:00+00'
       else timestamptz '2025-01-01 12:00+00' + n * interval '1 day' end,
  case when n % 6 = 2 then 'cc035800-0000-4000-8000-0000000000a4'::uuid end
from generate_series(1, 137) n
order by n;

-- Count 135 (Delta North, still open) has three lines, two counted.
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity)
select c.id, i.id, i.warehouse_id, 4, case when i.sku = 'D-0358-3' then null else 4 end
from public.cycle_counts c
join public.inventory_items i on i.organization_id = c.organization_id
where c.organization_id = :orgD and c.count_number = 135;

-- As the manager of org D.
set local "request.jwt.claim.sub" to 'cc035800-0000-4000-8000-0000000000a3';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(distinct count_number)::int from public.cycle_counts
    where organization_id = 'cc035800-0000-4000-8000-00000000000d'),
  137, 'G1: org D has 137 distinct numbers');
select results_eq(
  $$ select count(*)::int, min(total_count)::int, min(effective_page), max(count_number)::int, min(count_number)::int
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => 1) $$,
  $$ values (25, 137, 1, 137, 113) $$,
  'G2: page 1 is the newest 25 of 137');
select results_eq(
  $$ select count(*)::int, min(effective_page), max(count_number)::int, min(count_number)::int
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => 2) $$,
  $$ values (25, 2, 112, 88) $$,
  'G3: page 2 is sessions 26-50');
select results_eq(
  $$ select count(*)::int, min(effective_page), max(count_number)::int, min(count_number)::int
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => 6) $$,
  $$ values (12, 6, 12, 1) $$,
  'G4: the last page holds the remaining 12');
select results_eq(
  $$ select count(*)::int, min(effective_page)
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => 99) $$,
  $$ values (12, 6) $$,
  'G5: a page past the end is answered with the last real page');
select results_eq(
  $$ select count(*)::int, min(effective_page)
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => -3) $$,
  $$ values (25, 1) $$,
  'G6: a page below 1 is page 1');
select is(
  (select count(*)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page_size => 5000)),
  100, 'G7: the page size is bounded');
select results_eq(
  $$ select count_number::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => 4)
     where count_number between 49 and 53 $$,
  $$ values (53), (50), (52), (51), (49) $$,
  'G8: tied start times are ordered by uuid (descending), deterministically');
select is(
  (select sum(n)::int from (
     select count(*) as n from generate_series(1, 6) p,
       lateral public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => p)) s),
  137, 'G9: every session appears on exactly one page');
select is(
  (select count(distinct id)::int from generate_series(1, 6) p,
     lateral public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_page => p)),
  137, 'G10: no session appears on two pages');

-- Search.
select results_eq(
  $$ select count_number::int, total_count::int
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_number => 42) $$,
  $$ values (42, 1) $$,
  'G11: an exact number finds that count wherever it sits in history');
select is(
  (select count(*)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_number => 0)),
  0, 'G12: a number that cannot exist finds nothing');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_text => '50%')),
  27, 'G13: "%" is matched literally (27 notes say "50%", not every note with a 50)');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_text => 'shelf_1')),
  9, 'G14: "_" is matched literally (shelfX1 is not shelf_1)');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_text => 'NORTH')),
  45, 'G15: text matches the warehouse name, case-insensitively');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_text => 'o''brien shelfx1 (q1)')),
  7, 'G16: quotes and parentheses are ordinary characters');
select is(
  (select count(*)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_text => '\')),
  0, 'G17: a lone backslash is searched for, not an error');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_status => 'canceled')),
  12, 'G18: the status filter reaches canceled history');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_started_from => timestamptz '2025-05-01 00:00+00')),
  18, 'G19: started-from counts only sessions started at or after the instant');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_text => 'north', p_status => 'in_progress')),
  2, 'G20: search and status combine, and the total follows both');
select results_eq(
  $$ select line_total::int, line_counted::int
     from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d', p_number => 135) $$,
  $$ values (3, 2) $$,
  'G21: line progress is aggregated on the server');

-- As staff D, who may work in Delta North only.
set local "request.jwt.claim.sub" to 'cc035800-0000-4000-8000-0000000000a4';

select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_scope_warehouse_ids => array['cc035800-0000-4000-8000-0000000000b4']::uuid[], p_page_size => 100)),
  68, 'G22: a restricted member sees her warehouse''s 45 counts plus her 23 null-warehouse assignments');
select is(
  (select count(*)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_scope_warehouse_ids => array['cc035800-0000-4000-8000-0000000000b4']::uuid[], p_page_size => 100)
    where not (warehouse_id = 'cc035800-0000-4000-8000-0000000000b4'
               or (warehouse_id is null and assigned_to = 'cc035800-0000-4000-8000-0000000000a4'))),
  0, 'G23: nothing outside that scope is returned');
select is(
  (select count(*)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_number => 1, p_scope_warehouse_ids => array['cc035800-0000-4000-8000-0000000000b4']::uuid[])),
  0, 'G24: guessing the reference of a South count reveals nothing');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_text => 'south', p_scope_warehouse_ids => array['cc035800-0000-4000-8000-0000000000b4']::uuid[])),
  null, 'G25: searching for the other warehouse by name finds nothing');
select is(
  (select min(total_count)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_status => 'in_progress',
     p_scope_warehouse_ids => array['cc035800-0000-4000-8000-0000000000b4']::uuid[])),
  3, 'G26: scoped totals count only what the member may see (2 North + 1 own assignment open)');
select is(
  (select assignee_name from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000d',
     p_number => 2, p_scope_warehouse_ids => array['cc035800-0000-4000-8000-0000000000b4']::uuid[])),
  'Dana Stafford', 'G27: the assignee''s name comes back with the row');
select is(
  (select count(*)::int from public.cycle_counts_page('cc035800-0000-4000-8000-00000000000a')),
  0, 'G28: another organization''s id returns nothing (RLS)');

select * from finish();

rollback;
