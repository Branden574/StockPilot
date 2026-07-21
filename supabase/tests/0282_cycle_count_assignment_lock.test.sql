-- supabase/tests/0282_cycle_count_assignment_lock.test.sql
-- Proves migration 0282: cycle-count assignment / lock / release / reassign.
--
--   • the provenance + version columns exist,
--   • a manager can assign an in-progress count to a staffer (version bumps),
--   • a NON-assignee staffer is BLOCKED by RLS from writing a count line
--     (the assignee lock — the exact takeover bug this migration closes),
--   • the ASSIGNED staffer CAN write their line,
--   • a manager (non-assignee) CAN write (override),
--   • release with a blank reason is rejected (reason required),
--   • a non-assignee non-manager cannot release (forbidden),
--   • the assignee can self-release (assignment clears, version bumps),
--   • a non-manager cannot assign (forbidden),
--   • a manager can force-reassign an active count with a reason.
--
-- Namespace: cc028200. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(15);

\set org   '\'cc028200-0000-0000-0000-000000000001\''
\set mgr   '\'cc028200-0000-0000-0000-000000000002\''
\set stfA  '\'cc028200-0000-0000-0000-000000000003\''
\set stfB  '\'cc028200-0000-0000-0000-000000000004\''
\set whA   '\'cc028200-0000-0000-0000-00000000000a\''
\set item  '\'cc028200-0000-0000-0000-000000000010\''
\set cnt   '\'cc028200-0000-0000-0000-0000000000c0\''
\set line  '\'cc028200-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,  'mgr-0282@test.local',  '{}'::jsonb),
  (:stfA, 'stfA-0282@test.local', '{}'::jsonb),
  (:stfB, 'stfB-0282@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Count Org 0282', 'count-org-0282') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,  'manager', now()),
  (:org, :stfA, 'staff',   now()),
  (:org, :stfB, 'staff',   now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:whA, :org, 'WH A 0282', 'WH-A-0282', 'active') on conflict (id) do nothing;

-- Both staffers have write access to warehouse A.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:org, :stfA, :whA),
  (:org, :stfB, :whA) on conflict do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :whA, 'SKU-0282', 'Count Item 0282', 100, 'active', 'none')
  on conflict (id) do nothing;

-- An in-progress, initially-UNASSIGNED count + one line.
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, started_by)
  values (:cnt, :org, :whA, 'in_progress', :mgr) on conflict (id) do nothing;
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, warehouse_id, expected_quantity)
  values (:line, :cnt, :item, :whA, 100) on conflict (id) do nothing;

-- ── 1-3. Columns exist ──────────────────────────────────────────────────────
select has_column('public', 'cycle_counts', 'assignment_claimed_at', 'assignment_claimed_at exists');
select has_column('public', 'cycle_counts', 'assignment_claimed_by', 'assignment_claimed_by exists');
select has_column('public', 'cycle_counts', 'assignment_version',    'assignment_version exists');

-- ── As a manager: assign the count to staff A ───────────────────────────────
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 4. Manager assigns.
select lives_ok(
  $$ select public.assign_cycle_count(
       'cc028200-0000-0000-0000-0000000000c0',
       'cc028200-0000-0000-0000-000000000003') $$,
  'a manager can assign an in-progress cycle count to a staffer');
-- 5. The count is now assigned to staff A.
select is(
  (select assigned_to from public.cycle_counts where id = :cnt),
  :stfA, 'the count is now assigned to staff A');
-- 6. The assignment version bumped from 0 to 1.
select is(
  (select assignment_version from public.cycle_counts where id = :cnt),
  1, 'assignment_version bumped to 1 on assign');

-- ── As staff B (NOT the assignee): blocked by the assignee-lock RLS ──────────
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000004';

-- 7. Staff B's line write is silently filtered by RLS (0 rows) — value unchanged.
update public.cycle_count_lines
  set counted_quantity = 55, counted_by = 'cc028200-0000-0000-0000-000000000004'
  where id = :line;
select is(
  (select counted_quantity from public.cycle_count_lines where id = :line),
  null::numeric,
  'a non-assignee staffer CANNOT record a count on another user''s assigned count (the lock)');

-- ── As staff A (the assignee): can record ───────────────────────────────────
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000003';

-- 8. The assignee records successfully.
update public.cycle_count_lines
  set counted_quantity = 7, counted_by = 'cc028200-0000-0000-0000-000000000003'
  where id = :line;
select is(
  (select counted_quantity from public.cycle_count_lines where id = :line),
  7::numeric, 'the assigned staffer CAN record a count on their line');

-- ── As a manager (non-assignee): override write ─────────────────────────────
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000002';

-- 9. Manager override records successfully.
update public.cycle_count_lines
  set counted_quantity = 9, counted_by = 'cc028200-0000-0000-0000-000000000002'
  where id = :line;
select is(
  (select counted_quantity from public.cycle_count_lines where id = :line),
  9::numeric, 'a manager can override-record on an assigned count');

-- ── Release validation ──────────────────────────────────────────────────────
-- 10. Blank reason is rejected.
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000003';
select throws_ok(
  $$ select public.release_cycle_count('cc028200-0000-0000-0000-0000000000c0', '   ') $$,
  'P0001', null,
  'release with a blank reason is rejected (release_reason_required)');

-- 11. A non-assignee non-manager cannot release.
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000004';
select throws_ok(
  $$ select public.release_cycle_count('cc028200-0000-0000-0000-0000000000c0', 'shift ending') $$,
  '42501', null,
  'a non-assignee non-manager cannot release the count (forbidden)');

-- 12. The assignee self-releases with a reason.
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000003';
select lives_ok(
  $$ select public.release_cycle_count('cc028200-0000-0000-0000-0000000000c0', 'shift ending') $$,
  'the assignee can self-release with a reason');
select is(
  (select assigned_to from public.cycle_counts where id = :cnt),
  null::uuid, 'the count is unassigned again after release');

-- ── Assign / force-reassign authorization ───────────────────────────────────
-- 13. A non-manager cannot assign.
select throws_ok(
  $$ select public.assign_cycle_count(
       'cc028200-0000-0000-0000-0000000000c0',
       'cc028200-0000-0000-0000-000000000003') $$,
  '42501', null,
  'a non-manager cannot assign a cycle count (forbidden)');

-- 14. A manager can force-reassign an active count with a reason.
set local "request.jwt.claim.sub" to 'cc028200-0000-0000-0000-000000000002';
-- First re-assign to A so there is an active assignment to force away.
select public.assign_cycle_count(
  'cc028200-0000-0000-0000-0000000000c0',
  'cc028200-0000-0000-0000-000000000003');
select lives_ok(
  $$ select public.force_reassign_cycle_count(
       'cc028200-0000-0000-0000-0000000000c0',
       'cc028200-0000-0000-0000-000000000004',
       'staff A went home mid-shift') $$,
  'a manager can force-reassign an active count with a reason');

reset role;
select * from finish();
rollback;
