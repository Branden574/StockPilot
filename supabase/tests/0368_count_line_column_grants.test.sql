-- supabase/tests/0368_count_line_column_grants.test.sql
-- pgTAP proof for migration 0368 (Phase 0 S5, security).
--
-- A. cycle_count_lines: a direct PATCH of the columns the post trusts
--    (expected_quantity, item_id, warehouse_id, counted_location_id,
--    cycle_count_id) is refused, while every legitimate write shape still
--    works: recordCount, clearCount and the pre-2026-05-28 phone PATCH.
--    The granted columns now carry the app's own checks (stock:adjust,
--    warehouse write scope, bounds, same-count scan). Manager INSERT/DELETE
--    cannot forge a location, cross orgs, or touch a closed count, and
--    start_cycle_count still works.
-- B. cycle_count_ai_scans: the evidence columns cannot be rewritten, a scan
--    cannot be inserted pre-confirmed or for a closed/foreign count, and a
--    scan cannot be confirmed in someone else's name.
-- C. cycle_counts: a closed count cannot be changed or reopened, a count
--    becomes completed only by posting it (so a variance cannot be applied
--    twice), and a count cannot be inserted already closed.
--
-- Roles: fixtures as the test superuser; writes under test run with
-- `set local role authenticated` plus request.jwt.claim.sub, so grants, RLS
-- and the guard all apply for real. begin/rollback: nothing leaks.

begin;

select plan(49);

\set org      '\'03680000-0000-0000-0000-00000000000a\''
\set mgr      '\'03680000-0000-0000-0000-0000000000a1\''
\set counter  '\'03680000-0000-0000-0000-0000000000a2\''
\set other    '\'03680000-0000-0000-0000-0000000000a3\''
\set wh       '\'03680000-0000-0000-0000-0000000000b1\''
\set wh2      '\'03680000-0000-0000-0000-0000000000b2\''
\set loc      '\'03680000-0000-0000-0000-0000000000b3\''
\set itemA    '\'03680000-0000-0000-0000-0000000000c1\''
\set itemB    '\'03680000-0000-0000-0000-0000000000c2\''
\set cc       '\'03680000-0000-0000-0000-0000000000d1\''
\set ccl      '\'03680000-0000-0000-0000-0000000000d2\''
\set cc2      '\'03680000-0000-0000-0000-0000000000d3\''
\set cc3      '\'03680000-0000-0000-0000-0000000000d4\''
\set ccl3     '\'03680000-0000-0000-0000-0000000000d5\''
\set scan     '\'03680000-0000-0000-0000-0000000000e1\''
\set scan2    '\'03680000-0000-0000-0000-0000000000e2\''
\set ccl2     '\'03680000-0000-0000-0000-0000000000d6\''
\set noadj    '\'03680000-0000-0000-0000-0000000000a4\''
\set orgB     '\'03680000-0000-0000-0000-00000000000b\''
\set whB      '\'03680000-0000-0000-0000-0000000000b9\''
\set itemX    '\'03680000-0000-0000-0000-0000000000c9\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,     '0368-mgr@test.local',     '{}'::jsonb),
  (:counter, '0368-counter@test.local', '{}'::jsonb),
  (:other,   '0368-other@test.local',   '{}'::jsonb),
  (:noadj,   '0368-noadj@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, '0368 Grants Org', '0368-grants-org') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,     'manager', now()),
  (:org, :counter, 'staff',   now()),
  (:org, :other,   'staff',   now()),
  (:org, :noadj,   'staff',   now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh,  :org, '0368 Main',  'WH-0368',  'active'),
  (:wh2, :org, '0368 Annex', 'WH-0368B', 'active')
  on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:loc, :org, :wh, '67-A', 'shelf', 'rack') on conflict (id) do nothing;
-- counter and noadj are assigned to the main warehouse; other is assigned nowhere.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:org, :counter, :wh, true),
  (:org, :noadj,   :wh, true);
-- noadj has stock:adjust revoked (0207 user override).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  values (:org, :noadj, 'stock:adjust', false);
-- A second org with its own item (the cross-org probes).
insert into public.organizations (id, name, slug)
  values (:orgB, '0368 Other Org', '0368-other-org') on conflict (id) do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whB, :orgB, '0368 B Main', 'WH-0368X', 'active') on conflict (id) do nothing;
-- The manager also belongs to org B, so org B's item is VISIBLE to them: only
-- the policy's same-org check (not RLS visibility) can refuse the probe.
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:orgB, :mgr, 'manager', now()) on conflict do nothing;
insert into public.inventory_items (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status)
  values (:itemX, :orgB, :whB, '0368 Foreign Widget', 'SKU-0368-X', 777, 'active') on conflict (id) do nothing;
-- Guard the fixtures themselves: a silently missing row would make the
-- refusals below pass for the wrong reason.
do $$ begin
  if (select count(*) from public.user_warehouse_assignments
       where user_id in ('03680000-0000-0000-0000-0000000000a2','03680000-0000-0000-0000-0000000000a4')) <> 2
     or not exists (select 1 from public.organization_members where user_id = '03680000-0000-0000-0000-0000000000a4')
     or not exists (select 1 from public.user_permission_overrides where user_id = '03680000-0000-0000-0000-0000000000a4')
     or not exists (select 1 from public.inventory_items where id = '03680000-0000-0000-0000-0000000000c9')
  then raise exception '0368 test fixtures incomplete'; end if;
end $$;
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  (:itemA, :org, :wh, '0368 Counted Widget', 'SKU-0368-A', 40, 'active'),
  (:itemB, :org, :wh, '0368 Other Widget',   'SKU-0368-B',  0, 'active')
  on conflict (id) do nothing;

-- cc: in progress, assigned to the staff counter (sections A and B).
-- cc2: in progress, for the cancel/reopen transitions (section C).
-- cc3: in progress, counted then posted (section C).
insert into public.cycle_counts (id, organization_id, warehouse_id, status, started_by, assigned_to) values
  (:cc,  :org, :wh, 'in_progress', :mgr, :counter),
  (:cc2, :org, :wh, 'in_progress', :mgr, null),
  (:cc3, :org, :wh, 'in_progress', :mgr, null)
  on conflict (id) do nothing;
insert into public.cycle_count_lines (id, cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:ccl,  :cc,  :itemA, :wh, 40),
  (:ccl2, :cc2, :itemA, :wh, 40),
  (:ccl3, :cc3, :itemA, :wh, 40)
  on conflict (id) do nothing;
insert into public.cycle_count_ai_scans (id, organization_id, cycle_count_id, created_by, photo_storage_path, gemini_response, model_version)
  values (:scan, :org, :cc, :counter, 'org/0368/shelf.jpg', '{"items":[{"sku":"SKU-0368-A","count":41}]}'::jsonb, 'test-model'),
         (:scan2, :org, :cc3, :mgr, 'org/0368/other.jpg', '{}'::jsonb, 'test-model')
  on conflict (id) do nothing;

-- ═══ A. cycle_count_lines ═════════════════════════════════════════════════
select is(
  (select array_agg(c order by c) from unnest(array['expected_quantity','expected_at_start','item_id','warehouse_id',
      'counted_location_id','cycle_count_id','id','created_at','updated_at']) c
    where has_column_privilege('authenticated', 'public.cycle_count_lines', c, 'UPDATE')),
  null::text[],
  'A1: authenticated can UPDATE none of the columns the post trusts');
select is(
  (select array_agg(c order by c) from unnest(array['counted_quantity','reason','notes','counted_by','counted_at','ai_scan_id']) c
    where has_column_privilege('authenticated', 'public.cycle_count_lines', c, 'UPDATE')),
  array['ai_scan_id','counted_at','counted_by','counted_quantity','notes','reason'],
  'A2: authenticated keeps UPDATE on exactly the columns recordCount/clearCount write');
select ok(
  not has_table_privilege('anon', 'public.cycle_count_lines', 'INSERT')
  and not has_table_privilege('anon', 'public.cycle_count_lines', 'UPDATE')
  and not has_table_privilege('anon', 'public.cycle_count_lines', 'DELETE'),
  'A3: anon holds no write grant on cycle_count_lines');

set local "request.jwt.claim.sub"  to :counter;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  format($$update public.cycle_count_lines set expected_quantity = 0 where id = %L$$, :ccl),
  '42501', null, 'A4: the counter cannot rewrite expected_quantity (the forge)');
select throws_ok(
  format($$update public.cycle_count_lines set item_id = %L where id = %L$$, :itemB, :ccl),
  '42501', null, 'A5: the counter cannot re-point a line at another item');
select throws_ok(
  format($$update public.cycle_count_lines set warehouse_id = %L where id = %L$$, :wh2, :ccl),
  '42501', null, 'A6: the counter cannot move a line to another warehouse');
select throws_ok(
  format($$update public.cycle_count_lines set counted_location_id = %L where id = %L$$, :loc, :ccl),
  '42501', null, 'A7: the counter cannot choose where the post puts the variance');
select throws_ok(
  format($$update public.cycle_count_lines set cycle_count_id = %L where id = %L$$, :cc2, :ccl),
  '42501', null, 'A8: the counter cannot move a line to another count');
select throws_ok(
  format($$update public.cycle_count_lines set counted_quantity = 41, expected_quantity = 0 where id = %L$$, :ccl),
  '42501', null, 'A9: bundling a forged column with a legitimate one is still refused');

-- The legitimate shapes.
select lives_ok(
  format($$update public.cycle_count_lines
             set counted_quantity = 41, reason = 'found one', notes = 'shelf 2',
                 counted_by = %L, counted_at = now(), ai_scan_id = %L
           where id = %L$$, :counter, :scan, :ccl),
  'A10: the recordCount write shape (with ai_scan_id) still works');
select lives_ok(
  format($$update public.cycle_count_lines
             set counted_quantity = null, reason = null, notes = null, counted_by = null, counted_at = null
           where id = %L$$, :ccl),
  'A11: the clearCount write shape still works');
select lives_ok(
  format($$update public.cycle_count_lines set counted_quantity = 42, counted_by = %L, counted_at = now() where id = %L$$,
         :counter, :ccl),
  'A12: the pre-2026-05-28 phone PATCH shape still works');
reset role;

select is((select counted_quantity from public.cycle_count_lines where id = :ccl), 42::numeric,
  'A13: the legitimate record landed');
select is((select expected_quantity from public.cycle_count_lines where id = :ccl), 40::numeric,
  'A14: expected_quantity is still set by the 0339 rebase trigger (the live on-hand), not by the caller');
select is((select item_id from public.cycle_count_lines where id = :ccl), :itemA::uuid,
  'A15: the line still points at its own item after all the refused PATCHes');

-- The granted columns carry the app's own checks.
set local "request.jwt.claim.sub"  to :counter;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$update public.cycle_count_lines set counted_quantity = -5, counted_by = %L, counted_at = now() where id = %L$$, :counter, :ccl),
  '23514', null, 'A16: a negative count is refused (it would block the whole post)');
select throws_ok(
  format($$update public.cycle_count_lines set reason = repeat('x', 201) where id = %L$$, :ccl),
  '23514', null, 'A17: a reason longer than the API allows is refused');
select throws_ok(
  format($$update public.cycle_count_lines set ai_scan_id = %L where id = %L$$, :scan2, :ccl),
  '42501', null, 'A18: a line cannot cite another count''s AI scan');
reset role;

-- Staff with stock:adjust revoked, and staff with no access to the warehouse,
-- change nothing (RLS USING filters the row; the update touches 0 rows).
set local "request.jwt.claim.sub"  to :noadj;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 4000, counted_by = :noadj, counted_at = now() where id = :ccl2;
reset role;
select is((select counted_quantity from public.cycle_count_lines where id = :ccl2), null::numeric,
  'A19: staff without stock:adjust cannot record a count');
set local "request.jwt.claim.sub"  to :other;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 4000, counted_by = :other, counted_at = now() where id = :ccl2;
reset role;
select is((select counted_quantity from public.cycle_count_lines where id = :ccl2), null::numeric,
  'A20: staff with no access to the line''s warehouse cannot record a count');

-- Manager INSERT / DELETE.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_location_id)
           values (%L, %L, %L, 40, %L)$$, :cc, :itemB, :wh, :loc),
  '42501', null, 'A21: a manager cannot insert a line with a chosen counted location');
select throws_ok(
  format($$insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity)
           values (%L, %L, null, 0)$$, :cc, :itemB),
  '42501', null, 'A22: a manager cannot insert a line whose warehouse differs from its item''s');
select throws_ok(
  format($$insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity)
           values (%L, %L, %L, 0)$$, :cc, :itemX, :whB),
  '42501', null, 'A23: a manager cannot insert another org''s item (the on-hand leak)');
select lives_ok(
  format($$insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity)
           values (%L, %L, %L, 0)$$, :cc, :itemB, :wh),
  'A24: the start_cycle_count insert shape still works on an open count');
select lives_ok(
  format($$select * from public.start_cycle_count(%L::uuid, 'selection', %L::uuid, null, array[%L::uuid], 'started in 0368 test')$$,
         :org, :wh, :itemB),
  'A25: start_cycle_count still creates a count with its lines');
reset role;

-- ═══ B. cycle_count_ai_scans ══════════════════════════════════════════════
select is(
  (select array_agg(c order by c) from unnest(array['gemini_response','photo_storage_path','model_version','created_by',
      'cycle_count_id','organization_id','created_at','id']) c
    where has_column_privilege('authenticated', 'public.cycle_count_ai_scans', c, 'UPDATE')),
  null::text[],
  'B1: authenticated cannot UPDATE the scan evidence columns');
select ok(
  not has_table_privilege('anon', 'public.cycle_count_ai_scans', 'INSERT')
  and not has_table_privilege('anon', 'public.cycle_count_ai_scans', 'UPDATE')
  and not has_table_privilege('anon', 'public.cycle_count_ai_scans', 'DELETE'),
  'B2: anon holds no write grant on cycle_count_ai_scans');

set local "request.jwt.claim.sub"  to :counter;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$update public.cycle_count_ai_scans set gemini_response = '{"items":[{"sku":"SKU-0368-A","count":99}]}' where id = %L$$, :scan),
  '42501', null, 'B3: the scan creator cannot rewrite what the model saw');
select throws_ok(
  format($$update public.cycle_count_ai_scans set photo_storage_path = 'org/0368/other.jpg' where id = %L$$, :scan),
  '42501', null, 'B4: the scan creator cannot swap the photo');
select throws_ok(
  format($$update public.cycle_count_ai_scans set confirmed_at = now(), confirmed_by = %L where id = %L$$, :other, :scan),
  '42501', null, 'B5: a scan cannot be confirmed in someone else''s name');
select lives_ok(
  format($$update public.cycle_count_ai_scans set confirmed_at = now(), confirmed_by = %L where id = %L$$, :counter, :scan),
  'B6: the markAiScanConfirmed write shape (confirmed by the caller) still works');
reset role;
select is((select confirmed_by from public.cycle_count_ai_scans where id = :scan), :counter::uuid,
  'B7: the confirmation landed under the caller');

set local "request.jwt.claim.sub"  to :counter;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, gemini_response, model_version, confirmed_at, confirmed_by)
           values (%L, %L, %L, 'org/0368/fake.jpg', '{}'::jsonb, 'm', now(), %L)$$, :org, :cc, :counter, :mgr),
  '42501', null, 'B8: a scan cannot be inserted already confirmed');
select throws_ok(
  format($$insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, gemini_response, model_version)
           values (%L, %L, %L, 'org/0368/fake.jpg', '{}'::jsonb, 'm')$$, :orgB, :cc, :counter),
  '42501', null, 'B9: a scan cannot claim another org for this count');
select lives_ok(
  format($$insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, gemini_response, model_version)
           values (%L, %L, %L, 'org/0368/new.jpg', '{}'::jsonb, 'm')$$, :org, :cc, :counter),
  'B10: the createAiScan insert shape still works');
reset role;

-- ═══ C. cycle_counts status transitions ═══════════════════════════════════
select has_trigger('public', 'cycle_counts', 'trg_zz_cycle_counts_status_guard',
  'C1: the status guard is installed');

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  format($$update public.cycle_counts set status = 'completed', completed_at = now(), completed_by = %L where id = %L$$, :mgr, :cc2),
  '42501', 'A count is completed only by posting it.',
  'C2: a manager cannot mark a count completed without posting it');
select lives_ok(
  format($$update public.cycle_counts set status = 'canceled', canceled_at = now(), canceled_by = %L where id = %L$$, :mgr, :cc2),
  'C3: the cancel write shape (in_progress -> canceled) still works');
select throws_ok(
  format($$update public.cycle_counts set status = 'in_progress' where id = %L$$, :cc2),
  '42501', 'This count is already canceled, so it cannot be changed or reopened. Start a new count instead.',
  'C4: a canceled count cannot be reopened');

-- Count and post cc3: +5 on top of 40.
update public.cycle_count_lines set counted_quantity = 45, counted_by = :mgr, counted_at = now() where id = :ccl3;
select lives_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :cc3),
  'C5: posting still completes a count (the post sets the ledger flag)');
select throws_ok(
  format($$update public.cycle_counts set status = 'in_progress' where id = %L$$, :cc3),
  '42501', 'This count is already completed, so it cannot be changed or reopened. Start a new count instead.',
  'C6: a completed count cannot be reopened');
select throws_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :cc3),
  null, null,
  'C7: a completed count cannot be posted a second time');
select throws_ok(
  format($$update public.cycle_counts set completed_by = %L, completed_at = '2020-01-01' where id = %L$$, :counter, :cc3),
  '42501', null, 'C11: a closed count''s record cannot be rewritten');
select throws_ok(
  format($$insert into public.cycle_counts (organization_id, warehouse_id, status, started_by, completed_at, completed_by)
           values (%L, %L, 'completed', %L, now(), %L)$$, :org, :wh, :mgr, :mgr),
  '42501', 'A count starts in progress.', 'C12: a count cannot be inserted already completed');
delete from public.cycle_count_lines where id = :ccl3;
select throws_ok(
  format($$insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values (%L, %L, %L, 0)$$, :cc3, :itemB, :wh),
  '42501', null, 'C14: a line cannot be added to a completed count');
reset role;

select is((select status from public.cycle_counts where id = :cc3), 'completed',
  'C8: the posted count is completed');
select is((select count(*) from public.cycle_count_lines where id = :ccl3), 1::bigint,
  'C13: a completed count''s lines cannot be deleted (its record stands)');
select is((select quantity_on_hand from public.inventory_items where id = :itemA), 45::numeric,
  'C9: the variance was applied exactly once (40 -> 45)');

-- Non-API roles are not policed (service_role crons, SECURITY DEFINER bodies, postgres).
select lives_ok(
  format($$update public.cycle_counts set status = 'in_progress' where id = %L$$, :cc2),
  'C10: the guard polices only the API roles');

select * from finish();
rollback;
