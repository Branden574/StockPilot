-- supabase/tests/0452_cycle_count_ai_scan_recount.test.sql
-- pgTAP proof for migration 0452: a counter recounts or clears a line that
-- another person recorded from an AI shelf scan, whoever may read that scan.
--
-- cycle_count_lines_update's WITH CHECK asks that a line's ai_scan_id names a
-- scan of the same count. Since 0452 it asks cc_ai_scan_in_count (SECURITY
-- DEFINER, inside the caller's organizations only), not the scan table under
-- the caller's row level security, because scans are read only by their
-- creator and owners, admins and managers. recordCount and clearCount leave
-- ai_scan_id as it is, so the check meets other people's scans.
--
-- Fixtures as the test superuser; writes as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace c5490000.
begin;
select plan(9);

\set org   c5490000-0000-4000-8000-00000000000a
\set org2  c5490000-0000-4000-8000-00000000000b
\set mgr   c5490000-0000-4000-8000-0000000000a1
\set stX   c5490000-0000-4000-8000-0000000000a2
\set stY   c5490000-0000-4000-8000-0000000000a3
\set stP   c5490000-0000-4000-8000-0000000000a4
\set stQ   c5490000-0000-4000-8000-0000000000a5
\set whN   c5490000-0000-4000-8000-0000000000c1
\set whS   c5490000-0000-4000-8000-0000000000c2
\set whW   c5490000-0000-4000-8000-0000000000c3
\set iN1   c5490000-0000-4000-8000-0000000000d1
\set iS1   c5490000-0000-4000-8000-0000000000d2
\set iW1   c5490000-0000-4000-8000-0000000000d3
\set cMix  c5490000-0000-4000-8000-0000000000e1
\set cOrg  c5490000-0000-4000-8000-0000000000e2
\set sX    c5490000-0000-4000-8000-0000000000f1
\set sM    c5490000-0000-4000-8000-0000000000f2
\set sP    c5490000-0000-4000-8000-0000000000f3

-- Rows a write affects, then undone (a subtransaction), or 'ERROR <sqlstate>'.
create function pg_temp.n_rb(p_sql text) returns text language plpgsql as $$
declare c int;
begin
  begin
    execute p_sql;
    get diagnostics c = row_count;
    raise exception using errcode = 'P0S49', message = c::text;
  exception when sqlstate 'P0S49' then
    return sqlerrm;
  end;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- Rows a write affects, kept, or 'ERROR <sqlstate>'.
create function pg_temp.n_keep(p_sql text) returns text language plpgsql as $$
declare c int;
begin
  execute p_sql;
  get diagnostics c = row_count;
  return c::text;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- ══ Fixture (as the test superuser) ════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mgr', 'mgr-s49@test.local', '{}'), (:'stX', 'stx-s49@test.local', '{}'),
  (:'stY', 'sty-s49@test.local', '{}'), (:'stP', 'stp-s49@test.local', '{}'),
  (:'stQ', 'stq-s49@test.local', '{}')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'org', 'S49 Org', 's49-org'), (:'org2', 'S49 One Site', 's49-one') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:'org', :'mgr', 'manager', now()),
  (:'org', :'stX', 'staff', now()),
  (:'org', :'stY', 'staff', now()),
  (:'org2', :'stP', 'staff', now()),
  (:'org2', :'stQ', 'staff', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whN', :'org', 'S49 North', 'S49N', 'active'), (:'whS', :'org', 'S49 South', 'S49S', 'active'),
  (:'whW', :'org2', 'S49 Only', 'S49W', 'active') on conflict (id) do nothing;
-- X and Y may each work in BOTH warehouses (by rows, no flag): the app's
-- whole-count gate (assertSessionAccess) lets them count the mixed count.
-- P and Q work in their organization's only warehouse.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:'org', :'stX', :'whN'), (:'org', :'stX', :'whS'),
  (:'org', :'stY', :'whN'), (:'org', :'stY', :'whS'),
  (:'org2', :'stP', :'whW'), (:'org2', :'stQ', :'whW')
  on conflict do nothing;
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:'iN1', :'org', :'whN', 'S49-N1', 'North one', 5, 'active', 'none'),
  (:'iS1', :'org', :'whS', 'S49-S1', 'South one', 5, 'active', 'none'),
  (:'iW1', :'org2', :'whW', 'S49-W1', 'Only one', 5, 'active', 'none')
  on conflict (id) do nothing;
-- A selection spanning both warehouses (header null, unassigned) and an
-- org-wide count in a one-warehouse organization (header null, unassigned).
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to) values
  (:'cMix', :'org',  null, 'selection', 'in_progress', :'mgr', null),
  (:'cOrg', :'org2', null, 'warehouse', 'in_progress', :'stP', null);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:'cMix', :'iN1', :'whN', 5), (:'cMix', :'iS1', :'whS', 5),
  (:'cOrg', :'iW1', :'whW', 5);
insert into public.cycle_count_ai_scans (id, organization_id, cycle_count_id, created_by, photo_storage_path, model_version) values
  (:'sX', :'org',  :'cMix', :'stX', :'org'  || '/' || :'cMix' || '/x.webp', 'sX'),
  (:'sM', :'org',  :'cMix', :'mgr', :'org'  || '/' || :'cMix' || '/m.webp', 'sM'),
  (:'sP', :'org2', :'cOrg', :'stP', :'org2' || '/' || :'cOrg' || '/p.webp', 'sP');

set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';

-- 1. X records the North line from HIS scan (the AI review's record call).
set local "request.jwt.claim.sub" to :'stX';
select is(pg_temp.n_keep($$update public.cycle_count_lines
     set counted_quantity = 4, counted_by = 'c5490000-0000-4000-8000-0000000000a2', counted_at = now(),
         ai_scan_id = 'c5490000-0000-4000-8000-0000000000f1'
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e1' and item_id = 'c5490000-0000-4000-8000-0000000000d1'
   returning id$$),
  '1', 'V1 X records the North line of the mixed count from his own AI scan');

-- 2. The manager records the South line from HER scan.
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.n_keep($$update public.cycle_count_lines
     set counted_quantity = 3, counted_by = 'c5490000-0000-4000-8000-0000000000a1', counted_at = now(),
         ai_scan_id = 'c5490000-0000-4000-8000-0000000000f2'
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e1' and item_id = 'c5490000-0000-4000-8000-0000000000d2'
   returning id$$),
  '1', 'V2 the manager records the South line from her own AI scan');

-- 3. Y (both warehouses, same rights as X) recounts by hand: recordCount
--    without aiScanId leaves ai_scan_id as it is.
set local "request.jwt.claim.sub" to :'stY';
select is(pg_temp.n_rb($$update public.cycle_count_lines
     set counted_quantity = 6, counted_by = 'c5490000-0000-4000-8000-0000000000a3', counted_at = now()
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e1' and item_id = 'c5490000-0000-4000-8000-0000000000d1'
   returning id$$),
  '1', 'V3 Y recounts the North line X recorded from X''s scan');
select is(pg_temp.n_rb($$update public.cycle_count_lines
     set counted_quantity = null, reason = null, notes = null, counted_by = null, counted_at = null
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e1' and item_id = 'c5490000-0000-4000-8000-0000000000d1'
   returning id$$),
  '1', 'V4 Y clears that line (clearCount)');
select is(pg_temp.n_rb($$update public.cycle_count_lines
     set counted_quantity = 2, counted_by = 'c5490000-0000-4000-8000-0000000000a3', counted_at = now()
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e1' and item_id = 'c5490000-0000-4000-8000-0000000000d2'
   returning id$$),
  '1', 'V5 Y recounts the South line the manager recorded from her scan');

-- 4. X recounts his own AI-recorded line.
set local "request.jwt.claim.sub" to :'stX';
select is(pg_temp.n_rb($$update public.cycle_count_lines
     set counted_quantity = 7, counted_by = 'c5490000-0000-4000-8000-0000000000a2', counted_at = now()
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e1' and item_id = 'c5490000-0000-4000-8000-0000000000d1'
   returning id$$),
  '1', 'V6 X recounts his own AI-recorded line');

-- 5. One-warehouse organization, org-wide count (header null): P records
--    from his scan, then Q recounts or clears it by hand.
set local "request.jwt.claim.sub" to :'stP';
select is(pg_temp.n_keep($$update public.cycle_count_lines
     set counted_quantity = 4, counted_by = 'c5490000-0000-4000-8000-0000000000a4', counted_at = now(),
         ai_scan_id = 'c5490000-0000-4000-8000-0000000000f3'
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e2'
   returning id$$),
  '1', 'V7 P records the org-wide count''s line from his own AI scan');
set local "request.jwt.claim.sub" to :'stQ';
select is(pg_temp.n_rb($$update public.cycle_count_lines
     set counted_quantity = 6, counted_by = 'c5490000-0000-4000-8000-0000000000a5', counted_at = now()
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e2'
   returning id$$),
  '1', 'V8 Q (same single warehouse) recounts that line by hand');
select is(pg_temp.n_rb($$update public.cycle_count_lines
     set counted_quantity = null, reason = null, notes = null, counted_by = null, counted_at = null
   where cycle_count_id = 'c5490000-0000-4000-8000-0000000000e2'
   returning id$$),
  '1', 'V9 Q clears that line');

select * from finish();
rollback;
