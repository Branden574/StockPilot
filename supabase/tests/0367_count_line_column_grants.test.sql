-- supabase/tests/0367_count_line_column_grants.test.sql
-- pgTAP proof for migration 0367 (Phase 0 S5, security).
--
-- A. cycle_count_lines: a direct PATCH of the columns the post trusts
--    (expected_quantity, item_id, warehouse_id, counted_location_id,
--    cycle_count_id) is refused, while every legitimate write shape still
--    works: recordCount, clearCount and the pre-2026-05-28 phone PATCH.
-- B. cycle_count_ai_scans: the evidence columns cannot be rewritten, and a
--    scan cannot be confirmed in someone else's name.
-- C. cycle_counts: a closed count cannot be reopened, and a count becomes
--    completed only by posting it, so a variance cannot be applied twice.
--
-- Roles: fixtures as the test superuser; writes under test run with
-- `set local role authenticated` plus request.jwt.claim.sub, so grants, RLS
-- and the guard all apply for real. begin/rollback: nothing leaks.

begin;

select plan(32);

\set org      '\'03670000-0000-0000-0000-00000000000a\''
\set mgr      '\'03670000-0000-0000-0000-0000000000a1\''
\set counter  '\'03670000-0000-0000-0000-0000000000a2\''
\set other    '\'03670000-0000-0000-0000-0000000000a3\''
\set wh       '\'03670000-0000-0000-0000-0000000000b1\''
\set wh2      '\'03670000-0000-0000-0000-0000000000b2\''
\set loc      '\'03670000-0000-0000-0000-0000000000b3\''
\set itemA    '\'03670000-0000-0000-0000-0000000000c1\''
\set itemB    '\'03670000-0000-0000-0000-0000000000c2\''
\set cc       '\'03670000-0000-0000-0000-0000000000d1\''
\set ccl      '\'03670000-0000-0000-0000-0000000000d2\''
\set cc2      '\'03670000-0000-0000-0000-0000000000d3\''
\set cc3      '\'03670000-0000-0000-0000-0000000000d4\''
\set ccl3     '\'03670000-0000-0000-0000-0000000000d5\''
\set scan     '\'03670000-0000-0000-0000-0000000000e1\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,     '0367-mgr@test.local',     '{}'::jsonb),
  (:counter, '0367-counter@test.local', '{}'::jsonb),
  (:other,   '0367-other@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, '0367 Grants Org', '0367-grants-org') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,     'manager', now()),
  (:org, :counter, 'staff',   now()),
  (:org, :other,   'staff',   now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh,  :org, '0367 Main',  'WH-0367',  'active'),
  (:wh2, :org, '0367 Annex', 'WH-0367B', 'active')
  on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:loc, :org, :wh, '67-A', 'shelf', 'rack') on conflict (id) do nothing;
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  (:itemA, :org, :wh, '0367 Counted Widget', 'SKU-0367-A', 40, 'active'),
  (:itemB, :org, :wh, '0367 Other Widget',   'SKU-0367-B',  0, 'active')
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
  (:ccl3, :cc3, :itemA, :wh, 40)
  on conflict (id) do nothing;
insert into public.cycle_count_ai_scans (id, organization_id, cycle_count_id, created_by, photo_storage_path, gemini_response, model_version)
  values (:scan, :org, :cc, :counter, 'org/0367/shelf.jpg', '{"items":[{"sku":"SKU-0367-A","count":41}]}'::jsonb, 'test-model')
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
  format($$update public.cycle_count_ai_scans set gemini_response = '{"items":[{"sku":"SKU-0367-A","count":99}]}' where id = %L$$, :scan),
  '42501', null, 'B3: the scan creator cannot rewrite what the model saw');
select throws_ok(
  format($$update public.cycle_count_ai_scans set photo_storage_path = 'org/0367/other.jpg' where id = %L$$, :scan),
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
  '42501', 'This count is already canceled, so it cannot be reopened. Start a new count instead.',
  'C4: a canceled count cannot be reopened');

-- Count and post cc3: +5 on top of 40.
update public.cycle_count_lines set counted_quantity = 45, counted_by = :mgr, counted_at = now() where id = :ccl3;
select lives_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :cc3),
  'C5: posting still completes a count (the post sets the ledger flag)');
select throws_ok(
  format($$update public.cycle_counts set status = 'in_progress' where id = %L$$, :cc3),
  '42501', 'This count is already completed, so it cannot be reopened. Start a new count instead.',
  'C6: a completed count cannot be reopened');
select throws_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :cc3),
  null, null,
  'C7: a completed count cannot be posted a second time');
reset role;

select is((select status from public.cycle_counts where id = :cc3), 'completed',
  'C8: the posted count is completed');
select is((select quantity_on_hand from public.inventory_items where id = :itemA), 45::numeric,
  'C9: the variance was applied exactly once (40 -> 45)');

-- Non-API roles are not policed (service_role crons, SECURITY DEFINER bodies, postgres).
select lives_ok(
  format($$update public.cycle_counts set status = 'in_progress' where id = %L$$, :cc2),
  'C10: the guard polices only the API roles');

select * from finish();
rollback;
