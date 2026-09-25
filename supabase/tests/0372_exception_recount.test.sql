-- supabase/tests/0372_exception_recount.test.sql
-- pgTAP proof for migration 0372 (F1-2: the targeted recount loop).
--
-- G. Structure and grants: the item index exists; _latest_count_lines is
--    SECURITY DEFINER and service_role only; start_targeted_recount is
--    SECURITY INVOKER (lock_timeout 5s) for authenticated; _exc_link_recount
--    is SECURITY DEFINER for authenticated; none raises 40001/40P01; neither
--    RPC assigns resolved_at; the recount calls start_cycle_count and never
--    inserts a count itself.
-- R. start_targeted_recount: a manager recount creates exactly the
--    occurrences' items and links them (header = the shared warehouse, null
--    when mixed); a replay returns the first answer (same count and links)
--    with created=false and no second count, also with the ids reordered
--    (0372_exception_recount_review.test.sql covers skips); the same key with another
--    payload is idempotency_conflict (mutation: drop the hash check); an item
--    already in an open count is linked and no count is created; resolved,
--    holding-rule, label, rental, kit, archived and deleted are skipped with
--    their reasons (and start_cycle_count agrees they are not countable);
--    staff (even one granted cycle_counts:assign), viewers and managers
--    without cycle_counts:assign or stock:adjust get 42501 (mutation: allow
--    staff); cross-org and unknown ids get P0002; more than 200 items is
--    refused, 200 is fine (mutation: drop the cap); an occurrence already
--    linked to a live count keeps it, even when a newer open count holds the
--    item.
-- L. _exc_link_recount called directly refuses a foreign-org count (P0002),
--    a closed or cancelled count, a count without the item, a caller who is
--    not a manager or lacks cycle_counts:assign, a caller who cannot see the
--    occurrence (P0002; mutation: skip the visibility check), a resolved or
--    non-recountable occurrence, and a second live recount; linking twice is
--    a no-op; a stale pointer is closed (recount_closed) before relinking.
-- S. The loop: recount -> staff record -> manager post / cancel -> sync. The
--    sync closes each pointer with recount_closed and resolves only the
--    occurrence whose recount matched the book; a recount that found another
--    difference stays open with new facts; a cancelled one stays open.
-- C. _latest_count_lines: ignores cancelled and in-progress counts and
--    uncounted lines, orders by coalesce(baseline_at, counted_at) and then
--    completed_at (mutation: order by completed_at), is org-scoped (a line
--    pointing at another org's item is ignored), filters by item, and returns
--    the fields the evaluator needs (number, AI-assisted, captured, counted
--    location name, countable).
-- V. count_variance through the real sync, with a reference evaluator built
--    on _latest_count_lines exactly as the plan states it: the latest line
--    wins, zero clears, a variance older than 30 days is held (never opens,
--    and an open row that ages past 30 days stays open), rental, kit,
--    archived and deleted items are excluded.
--
-- TIME. now() is the transaction start for the whole file. Planted counts and
-- lines use now() minus a few days; the rebase trigger is disabled for those
-- statements only (it would overwrite expected_quantity and baseline_at).
-- Syncs run as service_role at increasing evaluation times per org.
--
-- Roles: fixtures as the test superuser; RPCs as `authenticated` with
-- request.jwt.claim.sub; refusals are captured with pg_temp.err(), which
-- returns 'SQLSTATE:hint:message' so a hint is asserted, not just a code.
-- Closed function grants are asserted from the catalog only. begin/rollback:
-- nothing leaks. Namespace 03720000.

begin;

select plan(76);

\set orgA   '\'03720000-0000-0000-0000-00000000000a\''
\set orgB   '\'03720000-0000-0000-0000-00000000000b\''
\set orgC   '\'03720000-0000-0000-0000-00000000000c\''
\set mgr    '\'03720000-0000-0000-0000-0000000000a1\''
\set stf    '\'03720000-0000-0000-0000-0000000000a2\''
\set vwr    '\'03720000-0000-0000-0000-0000000000a3\''
\set mgrNA  '\'03720000-0000-0000-0000-0000000000a4\''
\set mgrNS  '\'03720000-0000-0000-0000-0000000000a5\''
\set stfAs  '\'03720000-0000-0000-0000-0000000000a6\''
\set mgrB   '\'03720000-0000-0000-0000-0000000000b1\''
\set mgrC   '\'03720000-0000-0000-0000-0000000000c1\''
\set whA    '\'03720000-0000-0000-0000-0000000000d1\''
\set whA2   '\'03720000-0000-0000-0000-0000000000d2\''
\set whB    '\'03720000-0000-0000-0000-0000000000d3\''
\set whC    '\'03720000-0000-0000-0000-0000000000d4\''
\set rC     '\'03720000-0000-0000-0000-0000000000e1\''
-- org A items
\set iV1    '\'03720000-0000-0000-0000-000000000f01\''
\set iR2    '\'03720000-0000-0000-0000-000000000f02\''
\set iZ     '\'03720000-0000-0000-0000-000000000f03\''
\set iP     '\'03720000-0000-0000-0000-000000000f04\''
\set iQ     '\'03720000-0000-0000-0000-000000000f05\''
\set iW2    '\'03720000-0000-0000-0000-000000000f06\''
\set iRent  '\'03720000-0000-0000-0000-000000000f07\''
\set iKit   '\'03720000-0000-0000-0000-000000000f08\''
\set iArch  '\'03720000-0000-0000-0000-000000000f09\''
\set iDel   '\'03720000-0000-0000-0000-000000000f0a\''
\set iSt    '\'03720000-0000-0000-0000-000000000f0b\''
\set iLbl   '\'03720000-0000-0000-0000-000000000f0c\''
\set iRes   '\'03720000-0000-0000-0000-000000000f0d\''
\set iK1    '\'03720000-0000-0000-0000-000000000f0e\''
\set iK2    '\'03720000-0000-0000-0000-000000000f0f\''
\set iKx    '\'03720000-0000-0000-0000-000000000f10\''
\set iL1    '\'03720000-0000-0000-0000-000000000f11\''
\set iL2    '\'03720000-0000-0000-0000-000000000f12\''
\set iL3    '\'03720000-0000-0000-0000-000000000f13\''
-- org B item
\set itemB  '\'03720000-0000-0000-0000-000000000f20\''
-- org C items
\set cL1    '\'03720000-0000-0000-0000-000000000f31\''
\set cL2    '\'03720000-0000-0000-0000-000000000f32\''
\set cL3    '\'03720000-0000-0000-0000-000000000f33\''
\set cOld   '\'03720000-0000-0000-0000-000000000f34\''
\set cAge   '\'03720000-0000-0000-0000-000000000f35\''
\set cRent  '\'03720000-0000-0000-0000-000000000f36\''
\set cKit   '\'03720000-0000-0000-0000-000000000f37\''
\set cArch  '\'03720000-0000-0000-0000-000000000f38\''
\set cDel   '\'03720000-0000-0000-0000-000000000f39\''
\set cZero  '\'03720000-0000-0000-0000-000000000f3a\''
\set cAI    '\'03720000-0000-0000-0000-000000000f3b\''
-- counts
\set ccPlain '\'03720000-0000-0000-0000-000000000201\''
\set ccK1    '\'03720000-0000-0000-0000-000000000202\''
\set ccK2    '\'03720000-0000-0000-0000-000000000203\''
\set ccKX    '\'03720000-0000-0000-0000-000000000204\''
\set ccKDone '\'03720000-0000-0000-0000-000000000205\''
\set ccKCan  '\'03720000-0000-0000-0000-000000000206\''
\set ccK3    '\'03720000-0000-0000-0000-000000000207\''
\set ccLoop0 '\'03720000-0000-0000-0000-000000000208\''
\set ccB     '\'03720000-0000-0000-0000-000000000209\''
\set ccLa    '\'03720000-0000-0000-0000-000000000211\''
\set ccLb    '\'03720000-0000-0000-0000-000000000212\''
\set ccLx    '\'03720000-0000-0000-0000-000000000213\''
\set ccLy    '\'03720000-0000-0000-0000-000000000214\''
\set ccLz    '\'03720000-0000-0000-0000-000000000215\''
\set ccLc    '\'03720000-0000-0000-0000-000000000216\''
\set ccLd    '\'03720000-0000-0000-0000-000000000217\''
\set ccLe    '\'03720000-0000-0000-0000-000000000218\''
\set ccLf    '\'03720000-0000-0000-0000-000000000219\''
\set ccLold  '\'03720000-0000-0000-0000-00000000021a\''
\set ccLage  '\'03720000-0000-0000-0000-00000000021b\''
\set ccLai   '\'03720000-0000-0000-0000-00000000021c\''
\set ccLfix  '\'03720000-0000-0000-0000-00000000021d\''
\set scanAI  '\'03720000-0000-0000-0000-000000000301\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,   '0372-mgr@test.local',   '{}'::jsonb),
  (:stf,   '0372-stf@test.local',   '{}'::jsonb),
  (:vwr,   '0372-vwr@test.local',   '{}'::jsonb),
  (:mgrNA, '0372-mgrna@test.local', '{}'::jsonb),
  (:mgrNS, '0372-mgrns@test.local', '{}'::jsonb),
  (:stfAs, '0372-stfas@test.local', '{}'::jsonb),
  (:mgrB,  '0372-mgrb@test.local',  '{}'::jsonb),
  (:mgrC,  '0372-mgrc@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0372 Recount A', '0372-recount-a'),
  (:orgB, '0372 Recount B', '0372-recount-b'),
  (:orgC, '0372 Recount C', '0372-recount-c');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :mgrNA, 'manager', now()),
  (:orgA, :mgrNS, 'manager', now()),
  (:orgA, :stfAs, 'staff',   now()),
  (:orgB, :mgrB,  'manager', now()),
  (:orgC, :mgrC,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0372 Main',  'WH-0372A',  'active'),
  (:whA2, :orgA, '0372 Annex', 'WH-0372A2', 'active'),
  (:whB,  :orgB, '0372 Other', 'WH-0372B',  'active'),
  (:whC,  :orgC, '0372 Third', 'WH-0372C',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,   :whA, true),
  (:orgA, :vwr,   :whA, true),
  (:orgA, :stfAs, :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNA, 'cycle_counts:assign', false),
  (:orgA, :mgrNS, 'stock:adjust',        false),
  (:orgA, :stfAs, 'cycle_counts:assign', true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rC, :orgC, :whC, 'Rack C-1', 'shelf', 'rack');
select id as "stA" from public.locations where warehouse_id = :whA and kind = 'staging' and deleted_at is null \gset

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, is_rental, is_bundle, deleted_at) values
  (:iV1,   :orgA, :whA,  'X0372-V1',   'Variance one',     10, 'active',   false, false, null),
  (:iR2,   :orgA, :whA,  'X0372-R2',   'Promised item',    5,  'active',   false, false, null),
  (:iZ,    :orgA, :whA,  'X0372-Z',    'Already counting', 8,  'active',   false, false, null),
  (:iP,    :orgA, :whA,  'X0372-P',    'Plain pick',       3,  'active',   false, false, null),
  (:iQ,    :orgA, :whA,  'X0372-Q',    'Second pick',      4,  'active',   false, false, null),
  (:iW2,   :orgA, :whA2, 'X0372-W2',   'Annex pick',       2,  'active',   false, false, null),
  (:iRent, :orgA, :whA,  'X0372-RENT', 'Rental unit',      1,  'active',   true,  false, null),
  (:iKit,  :orgA, :whA,  'X0372-KIT',  'Kit phantom',      0,  'active',   false, true,  null),
  (:iArch, :orgA, :whA,  'X0372-ARCH', 'Archived item',    0,  'archived', false, false, null),
  (:iDel,  :orgA, :whA,  'X0372-DEL',  'Deleted item',     0,  'active',   false, false, now()),
  (:iSt,   :orgA, :whA,  'X0372-ST',   'Staged item',      0,  'active',   false, false, null),
  (:iLbl,  :orgA, :whA,  'X0372-LBL',  'Label item',       0,  'active',   false, false, null),
  (:iRes,  :orgA, :whA,  'X0372-RES',  'Resolved item',    0,  'active',   false, false, null),
  (:iK1,   :orgA, :whA,  'X0372-K1',   'Link one',         1,  'active',   false, false, null),
  (:iK2,   :orgA, :whA,  'X0372-K2',   'Link two',         1,  'active',   false, false, null),
  (:iKx,   :orgA, :whA,  'X0372-KX',   'Link other',       1,  'active',   false, false, null),
  (:iL1,   :orgA, :whA,  'X0372-L1',   'Loop matched',     10, 'active',   false, false, null),
  (:iL2,   :orgA, :whA,  'X0372-L2',   'Loop differs',     10, 'active',   false, false, null),
  (:iL3,   :orgA, :whA,  'X0372-L3',   'Loop cancelled',   10, 'active',   false, false, null),
  (:itemB, :orgB, :whB,  'X0372-B',    'Other org item',   1,  'active',   false, false, null),
  (:cL1,   :orgC, :whC,  'X0372-C1',   'Latest wins',      12, 'active',   false, false, null),
  (:cL2,   :orgC, :whC,  'X0372-C2',   'Legacy line',      5,  'active',   false, false, null),
  (:cL3,   :orgC, :whC,  'X0372-C3',   'Tied baseline',    4,  'active',   false, false, null),
  (:cOld,  :orgC, :whC,  'X0372-OLD',  'Old variance',     7,  'active',   false, false, null),
  (:cAge,  :orgC, :whC,  'X0372-AGE',  'Aging variance',   4,  'active',   false, false, null),
  (:cRent, :orgC, :whC,  'X0372-CR',   'Rental counted',   2,  'active',   true,  false, null),
  (:cKit,  :orgC, :whC,  'X0372-CK',   'Kit counted',      0,  'active',   false, true,  null),
  (:cArch, :orgC, :whC,  'X0372-CA',   'Archived counted', 4,  'archived', false, false, null),
  (:cDel,  :orgC, :whC,  'X0372-CD',   'Deleted counted',  1,  'active',   false, false, now()),
  (:cZero, :orgC, :whC,  'X0372-CZ',   'Zero variance',    6,  'active',   false, false, null),
  (:cAI,   :orgC, :whC,  'X0372-CAI',  'AI counted',       3,  'active',   false, false, null);

-- 201 plain items for the 200-item cap.
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status)
select ('03720000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, :orgA, :whA,
       'X0372-BULK-' || n, 'Bulk ' || n, 0, 'active'
  from generate_series(1, 201) n;
create temp table bulk (n integer primary key, id uuid not null);
insert into bulk select n, ('03720000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid from generate_series(1, 201) n;
grant select on bulk to authenticated;

-- Counts planted as the owner. The rebase trigger is off for these
-- statements only, so expected_quantity and baseline_at are what is written.
alter table public.cycle_count_lines disable trigger cycle_count_lines_rebase_expected;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at, completed_at, completed_by, canceled_at, canceled_by) values
  (:ccPlain, :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '3 hours', null, null, null, null),
  (:ccK1,    :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '2 hours', null, null, null, null),
  (:ccK2,    :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '1 hour',  null, null, null, null),
  (:ccKX,    :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '1 hour',  null, null, null, null),
  (:ccKDone, :orgA, :whA, 'completed',   'selection', :mgr, now() - interval '4 hours', now() - interval '3 hours', :mgr, null, null),
  (:ccKCan,  :orgA, :whA, 'canceled',    'selection', :mgr, now() - interval '4 hours', null, null, now() - interval '3 hours', :mgr),
  (:ccK3,    :orgA, :whA, 'in_progress', 'selection', :mgr, now() - interval '1 hour',  null, null, null, null),
  (:ccLoop0, :orgA, :whA, 'completed',   'selection', :mgr, now() - interval '3 days',  now() - interval '2 days', :mgr, null, null),
  (:ccB,     :orgB, :whB, 'in_progress', 'selection', :mgrB, now() - interval '1 hour', null, null, null, null),
  (:ccLa,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '3 days',  now() - interval '1 day',    :mgrC, null, null),
  (:ccLb,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '5 days',  now() - interval '1 hour',   :mgrC, null, null),
  (:ccLx,    :orgC, :whC, 'canceled',    'selection', :mgrC, now() - interval '2 hours', null, null, now() - interval '30 minutes', :mgrC),
  (:ccLy,    :orgC, :whC, 'in_progress', 'selection', :mgrC, now() - interval '1 hour',  null, null, null, null),
  (:ccLz,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '1 hour',  now() - interval '10 minutes', :mgrC, null, null),
  (:ccLc,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '2 days',  now() - interval '1 day',    :mgrC, null, null),
  (:ccLd,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '3 days',  now() - interval '12 hours', :mgrC, null, null),
  (:ccLe,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '4 days',  now() - interval '2 days',   :mgrC, null, null),
  (:ccLf,    :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '4 days',  now() - interval '1 day',    :mgrC, null, null),
  (:ccLold,  :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '42 days', now() - interval '40 days',  :mgrC, null, null),
  (:ccLage,  :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '21 days', now() - interval '20 days',  :mgrC, null, null),
  (:ccLai,   :orgC, :whC, 'completed',   'selection', :mgrC, now() - interval '7 days',  now() - interval '5 days',   :mgrC, null, null);

insert into public.cycle_count_ai_scans (id, organization_id, cycle_count_id, created_by, photo_storage_path, model_version)
values (:scanAI, :orgC, :ccLai, :mgrC, '03720000/scan.jpg', 'test');

insert into public.cycle_count_lines
  (cycle_count_id, item_id, warehouse_id, expected_quantity, expected_at_start, counted_quantity,
   counted_by, counted_at, captured_at, baseline_at, counted_location_id, ai_scan_id) values
  -- org A
  (:ccPlain, :iZ,   :whA, 8,  8,  null, null, null, null, null, null, null),
  (:ccK1,    :iK1,  :whA, 1,  1,  null, null, null, null, null, null, null),
  (:ccK2,    :iK1,  :whA, 1,  1,  null, null, null, null, null, null, null),
  (:ccKX,    :iKx,  :whA, 1,  1,  null, null, null, null, null, null, null),
  (:ccKDone, :iK1,  :whA, 1,  1,  1, :mgr, now() - interval '200 minutes', null, now() - interval '200 minutes', null, null),
  (:ccKDone, :iK2,  :whA, 1,  1,  1, :mgr, now() - interval '200 minutes', null, now() - interval '200 minutes', null, null),
  (:ccKCan,  :iK1,  :whA, 1,  1,  null, null, null, null, null, null, null),
  (:ccK3,    :iK2,  :whA, 1,  1,  null, null, null, null, null, null, null),
  (:ccLoop0, :iL1,  :whA, 9,  9,  10, :mgr, now() - interval '49 hours', null, now() - interval '49 hours', null, null),
  (:ccLoop0, :iL2,  :whA, 9,  9,  10, :mgr, now() - interval '49 hours', null, now() - interval '49 hours', null, null),
  (:ccLoop0, :iL3,  :whA, 9,  9,  10, :mgr, now() - interval '49 hours', null, now() - interval '49 hours', null, null),
  -- org B
  (:ccB,     :itemB, :whB, 1, 1,  null, null, null, null, null, null, null),
  -- org C: cL1. ccLa is the latest OBSERVATION (baseline 2 days ago), ccLb
  -- the latest POST (an offline capture 4 days ago, synced and posted an hour
  -- ago). Cancelled, in-progress and uncounted lines are later still.
  (:ccLa,    :cL1,  :whC, 10, 10, 12, :mgrC, now() - interval '2 days',  null, now() - interval '2 days', null, null),
  (:ccLb,    :cL1,  :whC, 10, 10, 10, :mgrC, now() - interval '2 hours', now() - interval '4 days', now() - interval '4 days', null, null),
  (:ccLx,    :cL1,  :whC, 10, 10, 99, :mgrC, now() - interval '1 hour',  null, now() - interval '1 hour', null, null),
  (:ccLy,    :cL1,  :whC, 10, 10, 77, :mgrC, now() - interval '30 minutes', null, now() - interval '30 minutes', null, null),
  (:ccLz,    :cL1,  :whC, 10, 10, null, null, null, null, null, null, null),
  -- cL2: a line from before 0339/0369 (no baseline) observed a day ago wins
  -- over a baselined line observed two days ago, though it was posted first.
  (:ccLc,    :cL2,  :whC, 5,  null, 5, :mgrC, now() - interval '1 day',  null, null, null, null),
  (:ccLd,    :cL2,  :whC, 5,  5,  6, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null),
  -- cL3: the same baseline; the later post wins.
  (:ccLe,    :cL3,  :whC, 4,  4,  5, :mgrC, now() - interval '3 days', null, now() - interval '3 days', null, null),
  (:ccLf,    :cL3,  :whC, 4,  4,  4, :mgrC, now() - interval '3 days', null, now() - interval '3 days', null, null),
  -- variance older than 30 days; aging variance (20 days).
  (:ccLold,  :cOld, :whC, 10, 10, 7, :mgrC, now() - interval '41 days', null, now() - interval '41 days', null, null),
  (:ccLage,  :cAge, :whC, 3,  3,  4, :mgrC, now() - interval '20 days' - interval '1 hour', null, now() - interval '20 days' - interval '1 hour', null, null),
  -- not countable items with a variance, and a zero variance.
  (:ccLa,    :cRent, :whC, 3, 3,  2, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null),
  (:ccLa,    :cKit,  :whC, 1, 1,  0, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null),
  (:ccLa,    :cArch, :whC, 5, 5,  4, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null),
  (:ccLa,    :cDel,  :whC, 2, 2,  1, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null),
  (:ccLa,    :cZero, :whC, 6, 6,  6, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null),
  -- an offline, AI-assisted count at a recorded rack.
  (:ccLai,   :cAI,  :whC, 2,  2,  3, :mgrC, now() - interval '5 days', now() - interval '6 days', now() - interval '6 days', :rC, :scanAI),
  -- a line in an org C count that names an org A item (the FK-org guard).
  (:ccLa,    :iV1,  :whA, 1,  1,  5, :mgrC, now() - interval '2 days', null, now() - interval '2 days', null, null);

alter table public.cycle_count_lines enable trigger cycle_count_lines_rebase_expected;

-- ── Helpers ──────────────────────────────────────────────────────────────
-- A refusal as 'SQLSTATE:hint:message' (the statement's effects roll back).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
  return v_state || ':' || coalesce(v_hint, '') || ':' || v_msg;
end $$;

-- The plan's count_variance rule over _latest_count_lines: countable items
-- whose latest counted line differs from the book at that moment; 'present'
-- when that count completed within 30 days, 'hold' when older.
create function pg_temp.cv_eval(p_org uuid)
returns table (state text, entry jsonb) language sql as $$
  select case when l.completed_at >= now() - interval '30 days' then 'present' else 'hold' end,
         jsonb_build_object(
           'rule', 'count_variance', 'itemId', l.item_id, 'locationId', null,
           'facts', jsonb_build_object(
             'countNumber', l.count_number,
             'expected',    l.expected_quantity,
             'counted',     l.counted_quantity,
             'variance',    l.counted_quantity - l.expected_quantity),
           'conditionSince', coalesce(l.baseline_at, l.counted_at))
    from public._latest_count_lines(p_org) l
   where l.item_countable
     and l.counted_quantity <> l.expected_quantity
$$;

-- Hand-made present entries per org (the other rules), plus cv_eval.
create temp table cur_present (ord serial primary key, org uuid not null, tag text not null, entry jsonb not null, unique (org, tag));
grant all on cur_present to service_role;
grant usage on sequence cur_present_ord_seq to service_role;
create function pg_temp.e(p_rule text, p_item uuid, p_loc uuid default null)
returns jsonb language sql as $$
  select jsonb_build_object('rule', p_rule, 'itemId', p_item, 'locationId', p_loc, 'facts', '{}'::jsonb)
$$;
create function pg_temp.sync(p_org uuid, p_at timestamptz) returns jsonb language sql as $$
  select public.exceptions_sync(
    p_org, p_at,
    array['orphaned_stock', 'over_reserved', 'stale_staging', 'long_unplaced', 'label_mismatch', 'count_variance'],
    '{}', '{}',
    (select coalesce(jsonb_agg(c.entry order by c.ord), '[]'::jsonb) from cur_present c where c.org = p_org)
      || (select coalesce(jsonb_agg(v.entry order by v.entry->>'itemId'), '[]'::jsonb)
            from pg_temp.cv_eval(p_org) v where v.state = 'present'),
    (select coalesce(jsonb_agg(v.entry order by v.entry->>'itemId'), '[]'::jsonb)
       from pg_temp.cv_eval(p_org) v where v.state = 'hold'))
$$;

-- The timeline of one occurrence: kind:count:actor, in order.
create function pg_temp.tl(p_occ uuid) returns text[] language sql as $$
  select coalesce(array_agg(e.kind || ':' || coalesce(e.cycle_count_id::text, '-') || ':'
                            || coalesce(e.actor_user_id::text, 'system') order by e.created_at, e.id), '{}')
    from public.exception_occurrence_events e where e.occurrence_id = p_occ
$$;

-- ── Occurrences (org A and B) ────────────────────────────────────────────
insert into cur_present (org, tag, entry) values
  (:orgA, 'V1',   pg_temp.e('count_variance', :iV1)),
  (:orgA, 'Z',    pg_temp.e('count_variance', :iZ)),
  (:orgA, 'Rent', pg_temp.e('count_variance', :iRent)),
  (:orgA, 'Res',  pg_temp.e('count_variance', :iRes)),
  (:orgA, 'K1',   pg_temp.e('count_variance', :iK1)),
  (:orgA, 'K2',   pg_temp.e('count_variance', :iK2)),
  (:orgA, 'R2',   pg_temp.e('over_reserved',  :iR2)),
  (:orgA, 'St',   pg_temp.e('stale_staging',  :iSt, :'stA')),
  (:orgA, 'Lbl',  pg_temp.e('label_mismatch', :iLbl)),
  (:orgB, 'B',    pg_temp.e('count_variance', :itemB));

set local role to 'service_role';
select pg_temp.sync(:orgA, now() - interval '60 minutes') as "syncA1" \gset
select pg_temp.sync(:orgB, now() - interval '60 minutes') as "syncB1" \gset
delete from cur_present where tag = 'Res';
select pg_temp.sync(:orgA, now() - interval '59 minutes') as "syncA2" \gset
reset role;

select id as "oV1"   from public.exception_occurrences where item_id = :iV1   and rule = 'count_variance' \gset
select id as "oZ"    from public.exception_occurrences where item_id = :iZ    and rule = 'count_variance' \gset
select id as "oRent" from public.exception_occurrences where item_id = :iRent and rule = 'count_variance' \gset
select id as "oRes"  from public.exception_occurrences where item_id = :iRes  and rule = 'count_variance' \gset
select id as "oK1"   from public.exception_occurrences where item_id = :iK1   and rule = 'count_variance' \gset
select id as "oK2"   from public.exception_occurrences where item_id = :iK2   and rule = 'count_variance' \gset
select id as "oR2"   from public.exception_occurrences where item_id = :iR2   and rule = 'over_reserved' \gset
select id as "oSt"   from public.exception_occurrences where item_id = :iSt   and rule = 'stale_staging' \gset
select id as "oLbl"  from public.exception_occurrences where item_id = :iLbl  and rule = 'label_mismatch' \gset
select id as "oL1"   from public.exception_occurrences where item_id = :iL1   and rule = 'count_variance' \gset
select id as "oL2"   from public.exception_occurrences where item_id = :iL2   and rule = 'count_variance' \gset
select id as "oL3"   from public.exception_occurrences where item_id = :iL3   and rule = 'count_variance' \gset
select id as "oB"    from public.exception_occurrences where item_id = :itemB and rule = 'count_variance' \gset

-- Guard the fixtures: a silently missing row would let a refusal pass for the
-- wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items where id::text like '03720000-%') <> 232
     or (select count(*) from public.exception_occurrences where item_id::text like '03720000-%') <> 13
     or (select count(*) from public.exception_occurrences
          where item_id::text like '03720000-%' and resolved_at is not null) <> 1
     or (select count(*) from public.cycle_count_lines l join public.cycle_counts c on c.id = l.cycle_count_id
          where c.id::text like '03720000-%') <> 30
  then raise exception '0372 test fixtures incomplete'; end if;
end $$;

-- ═══ G. Structure and grants ══════════════════════════════════════════════
select ok(
  (select indexdef ~ '\(item_id\)$' from pg_indexes
    where schemaname = 'public' and tablename = 'cycle_count_lines' and indexname = 'cycle_count_lines_item_idx'),
  'G1: cycle_count_lines(item_id) is indexed');
select ok(
  (select p.prosecdef and 'search_path=public' = any (p.proconfig)
          and p.proacl is not null
          and not exists (select 1 from unnest(p.proacl) a where a::text like '=%')
     from pg_proc p where p.oid = 'public._latest_count_lines(uuid, uuid[], timestamptz)'::regprocedure)
  and has_function_privilege('service_role', 'public._latest_count_lines(uuid, uuid[], timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._latest_count_lines(uuid, uuid[], timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._latest_count_lines(uuid, uuid[], timestamptz)', 'EXECUTE'),
  'G2: _latest_count_lines is SECURITY DEFINER with a pinned search_path, executable by service_role only (catalog)');
select ok(
  (select not p.prosecdef and 'lock_timeout=5s' = any (p.proconfig) and 'search_path=public' = any (p.proconfig)
     from pg_proc p where p.oid = 'public.start_targeted_recount(uuid, uuid[], uuid[], text, text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.start_targeted_recount(uuid, uuid[], uuid[], text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.start_targeted_recount(uuid, uuid[], uuid[], text, text)', 'EXECUTE'),
  'G3: start_targeted_recount is SECURITY INVOKER with lock_timeout 5s, for authenticated, not anon');
select ok(
  (select p.prosecdef and 'search_path=public' = any (p.proconfig)
     from pg_proc p where p.oid = 'public._exc_link_recount(uuid, uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public._exc_link_recount(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._exc_link_recount(uuid, uuid)', 'EXECUTE'),
  'G4: _exc_link_recount is SECURITY DEFINER for authenticated (gated in its body), not anon');
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public._latest_count_lines(uuid, uuid[], timestamptz)'::regprocedure,
                    'public.start_targeted_recount(uuid, uuid[], uuid[], text, text)'::regprocedure,
                    'public._exc_link_recount(uuid, uuid)'::regprocedure)
      and p.prosrc ~ '(40001|40P01|serialization_failure|deadlock_detected)'),
  0,
  'G5: none of the three raises 40001 or 40P01 (PostgREST retries 40001 forever)');
select ok(
  (select bool_and(p.prosrc !~* 'resolved_(at|reason)\s*=[^=]') from pg_proc p
    where p.oid in ('public.start_targeted_recount(uuid, uuid[], uuid[], text, text)'::regprocedure,
                    'public._exc_link_recount(uuid, uuid)'::regprocedure)),
  'G6: neither RPC assigns resolved_at or resolved_reason (only the sync resolves)');
select ok(
  (select p.prosrc ~ 'public\.start_cycle_count\(' and p.prosrc !~* 'insert\s+into\s+public\.cycle_count'
     from pg_proc p where p.oid = 'public.start_targeted_recount(uuid, uuid[], uuid[], text, text)'::regprocedure),
  'G7: the recount calls the frozen start_cycle_count and never inserts a count or line itself');

-- ═══ R. start_targeted_recount ════════════════════════════════════════════
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- R1-R4: a manager recount from two occurrences.
select public.start_targeted_recount(:orgA, array[:'oV1', :'oR2']::uuid[], null, 'Recount: 2 items', 'key-1') as "r1" \gset
select is(
  :'r1'::jsonb - 'cycleCountId' - 'countNumber',
  jsonb_build_object(
    'lineCount', 2, 'created', true, 'replay', false,
    'linked', (select jsonb_agg(x order by x::text) from unnest(array[:'oV1', :'oR2']::uuid[]) x),
    'linkedExisting', '[]'::jsonb, 'skipped', '[]'::jsonb),
  'R1: a recount of two open occurrences creates a count and links both');
select (:'r1'::jsonb->>'cycleCountId') as "x1" \gset
select is(
  (select row(c.status, c.scope, c.warehouse_id, c.started_by, c.notes, c.count_number = (:'r1'::jsonb->>'countNumber')::bigint,
              (select array_agg(l.item_id order by l.item_id) from public.cycle_count_lines l where l.cycle_count_id = c.id))::text
     from public.cycle_counts c where c.id = :'x1'),
  row('in_progress', 'selection', :whA::uuid, :mgr::uuid, 'Recount: 2 items', true, array[:iV1, :iR2]::uuid[])::text,
  'R2: it is an ordinary in-progress selection count of exactly those items, headed by their shared warehouse, started by the manager');
select is(
  (select array_agg(o.recount_cycle_count_id::text order by o.id) from public.exception_occurrences o where o.id in (:'oV1', :'oR2')),
  array[:'x1', :'x1'],
  'R3: both occurrences point at the new count');
select is(
  pg_temp.tl(:'oV1'),
  array['raised:-:system', 'recount_linked:' || :'x1' || ':' || :mgr],
  'R4: the timeline gains one recount_linked event, by the manager, naming the count');

-- R5-R7: replays.
select count(*) as "ccA" from public.cycle_counts where organization_id = :orgA \gset
select is(
  public.start_targeted_recount(:orgA, array[:'oV1', :'oR2']::uuid[], null, 'Recount: 2 items', 'key-1'),
  :'r1'::jsonb || '{"created": false, "replay": true}'::jsonb,
  'R5: a replay returns the first answer (same count, line count and links) with created=false');
select is(
  public.start_targeted_recount(:orgA, array[:'oR2', :'oV1', :'oR2']::uuid[], '{}'::uuid[], null, 'key-1')->>'cycleCountId',
  :'x1',
  'R6: the same request with the ids reordered and repeated is the same request (the hash is over sorted ids)');
select is(
  (select count(*) from public.cycle_counts where organization_id = :orgA)::text || '|' || array_length(pg_temp.tl(:'oV1'), 1),
  :'ccA' || '|2',
  'R7: no second count and no second link event exist');

-- R8: the same key with another request. Mutation: drop the hash check.
select is(
  pg_temp.err(format($$select public.start_targeted_recount(%L, array[%L]::uuid[], null, null, 'key-1')$$, :orgA, :'oV1')),
  'P0001:idempotency_conflict:idempotency_conflict',
  'R8: the same key with a different payload is idempotency_conflict');

-- R9-R11: an item already in an open count is linked to it; no count is made.
select public.start_targeted_recount(:orgA, array[:'oZ']::uuid[], null, null, 'key-2') as "r9" \gset
select is(
  :'r9'::jsonb,
  jsonb_build_object(
    'cycleCountId', null, 'countNumber', null, 'lineCount', 0, 'created', false, 'replay', false,
    'linked', '[]'::jsonb,
    'linkedExisting', (select jsonb_build_array(jsonb_build_object(
        'cycleCountId', c.id, 'countNumber', c.count_number, 'assignedTo', c.assigned_to,
        'startedAt', c.started_at, 'itemIds', jsonb_build_array(:iZ::uuid),
        'occurrenceIds', jsonb_build_array(:'oZ'::uuid)))
       from public.cycle_counts c where c.id = :ccPlain),
    'skipped', '[]'::jsonb),
  'R9: an item already being counted is linked to that count and reported, with no new count');
select is(
  (select count(*) from public.cycle_counts where organization_id = :orgA)::text || '|'
    || (select recount_cycle_count_id::text from public.exception_occurrences where id = :'oZ'),
  :'ccA' || '|' || :ccPlain,
  'R10: no count was created and the occurrence points at the open count');
select is(
  public.start_targeted_recount(:orgA, array[:'oZ']::uuid[], null, null, 'key-2'),
  :'r9'::jsonb || '{"replay": true}'::jsonb,
  'R11: a replay of a request that created no count answers with no count, and still names the count it linked to');

-- R12-R13: mixed: one item already counting, one new.
select public.start_targeted_recount(:orgA, null, array[:iZ, :iP]::uuid[], 'Recount: 2 items', 'key-3') as "r12" \gset
select (:'r12'::jsonb->>'cycleCountId') as "x2" \gset
select is(
  row(:'r12'::jsonb->'created', :'r12'::jsonb->'lineCount',
      (select array_agg(l.item_id) from public.cycle_count_lines l where l.cycle_count_id = :'x2'),
      :'r12'::jsonb#>'{linkedExisting,0,cycleCountId}', :'r12'::jsonb#>'{linkedExisting,0,itemIds}',
      :'r12'::jsonb#>'{linkedExisting,0,occurrenceIds}', jsonb_array_length(:'r12'::jsonb->'linkedExisting'))::text,
  row('true'::jsonb, '1'::jsonb, array[:iP]::uuid[], to_jsonb(:ccPlain::text), jsonb_build_array(:iZ::uuid),
      '[]'::jsonb, 1)::text,
  'R12: only the item nobody is counting gets the new count; the other is reported as already counting');
select is(
  (select c.warehouse_id from public.cycle_counts c where c.id = :'x2'),
  :whA::uuid,
  'R13: the new count is headed by the warehouse its items share');

-- R14: items from two warehouses: the header is null (as CycleCountsService.start()).
select (public.start_targeted_recount(:orgA, null, array[:iW2, :iQ]::uuid[], null, 'key-mixed')->>'cycleCountId') as "x3" \gset
select is(
  (select row(c.warehouse_id, (select count(*) from public.cycle_count_lines l where l.cycle_count_id = c.id))::text
     from public.cycle_counts c where c.id = :'x3'),
  row(null::uuid, 2::bigint)::text,
  'R14: a recount spanning two warehouses has no header warehouse');

-- R15-R17: what is skipped, and why.
select public.start_targeted_recount(:orgA,
  array[:'oRes', :'oSt', :'oLbl', :'oRent']::uuid[],
  array[:iKit, :iArch, :iDel, :iRent]::uuid[], null, 'key-skip') as "r15" \gset
select is(
  :'r15'::jsonb->'skipped',
  jsonb_build_array(
    jsonb_build_object('occurrenceId', :'oRent'::uuid, 'itemId', :iRent::uuid, 'reason', 'not_countable'),
    jsonb_build_object('occurrenceId', null,           'itemId', :iKit::uuid,  'reason', 'not_countable'),
    jsonb_build_object('occurrenceId', null,           'itemId', :iArch::uuid, 'reason', 'not_countable'),
    jsonb_build_object('occurrenceId', null,           'itemId', :iDel::uuid,  'reason', 'not_countable'),
    jsonb_build_object('occurrenceId', :'oSt'::uuid,   'itemId', :iSt::uuid,   'reason', 'not_recountable'),
    jsonb_build_object('occurrenceId', :'oLbl'::uuid,  'itemId', :iLbl::uuid,  'reason', 'not_recountable'),
    jsonb_build_object('occurrenceId', :'oRes'::uuid,  'itemId', :iRes::uuid,  'reason', 'resolved')),
  'R15: resolved, holding-rule, label, rental, kit, archived and deleted are each skipped once, with the reason');
select is(
  row(:'r15'::jsonb->'created', :'r15'::jsonb->'cycleCountId', :'r15'::jsonb->'linked', :'r15'::jsonb->'linkedExisting',
      (select count(*) from public.exception_occurrences
        where id in (:'oRes', :'oSt', :'oLbl', :'oRent') and recount_cycle_count_id is not null))::text,
  row('false'::jsonb, 'null'::jsonb, '[]'::jsonb, '[]'::jsonb, 0::bigint)::text,
  'R16: nothing countable, so no count and no link');
select is(
  pg_temp.err(format($$select public.start_cycle_count(%L, 'selection', null, null, array[%L, %L, %L, %L]::uuid[], null)$$,
                     :orgA, :iRent, :iKit, :iArch, :iDel)),
  'P0001::cycle_count_no_items',
  'R17: start_cycle_count agrees those items are not countable (one predicate, two callers)');

-- R18-R24: who may recount. Mutation: allow staff.
set local "request.jwt.claim.sub" to :stf;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :iP)),
  '42501::forbidden', 'R18: staff get 42501');
set local "request.jwt.claim.sub" to :stfAs;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :iZ)),
  '42501::forbidden', 'R19: staff granted cycle_counts:assign still get 42501 (the manager floor)');
set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, array[%L]::uuid[])$$, :orgA, :'oV1')),
  '42501::forbidden', 'R20: viewers get 42501');
set local "request.jwt.claim.sub" to :mgrNA;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :iP)),
  '42501::forbidden', 'R21: a manager without cycle_counts:assign gets 42501');
set local "request.jwt.claim.sub" to :mgrNS;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :iP)),
  '42501::forbidden', 'R22: a manager without stock:adjust gets 42501');
set local "request.jwt.claim.sub" to :mgrB;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :iP)),
  '42501::forbidden', 'R23: a manager of another org gets 42501 for this org');
set local "request.jwt.claim.sub" to '';
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :iP)),
  '42501::not_authenticated', 'R24: no session gets 42501');

-- R25-R27: ids from elsewhere read as not found.
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, array[%L]::uuid[])$$, :orgA, :'oB')),
  'P0002::occurrence_not_found', 'R25: another org''s occurrence is P0002');
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[%L]::uuid[])$$, :orgA, :itemB)),
  'P0002::item_not_found', 'R26: another org''s item is P0002');
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, array[gen_random_uuid()])$$, :orgA)),
  'P0002::occurrence_not_found', 'R27: an unknown occurrence is P0002');

-- R28-R31: arguments and the 200-item cap. Mutation: drop the cap.
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, null, array(select id from bulk order by n))$$, :orgA)),
  '22023:recount_too_many_items:recount_too_many_items', 'R28: 201 items are refused');
select is(pg_temp.err(format($$select public.start_targeted_recount(%L, array[%L]::uuid[], array(select id from bulk where n <= 200 order by n))$$, :orgA, :'oV1')),
  '22023:recount_too_many_items:recount_too_many_items', 'R29: 200 items plus an occurrence''s item are refused (the cap is on the union)');
select (public.start_targeted_recount(:orgA, null, array(select id from bulk where n <= 200 order by n), null, 'key-200')->>'cycleCountId') as "x4" \gset
select is(
  (select count(*) from public.cycle_count_lines l where l.cycle_count_id = :'x4'),
  200::bigint,
  'R30: 200 items make one 200-line count');
select is(
  pg_temp.err(format($$select public.start_targeted_recount(%L, '{}'::uuid[], null)$$, :orgA))
    || '|' || pg_temp.err(format($$select public.start_targeted_recount(%L, null, array[null]::uuid[])$$, :orgA)),
  '22023:recount_nothing_selected:recount_nothing_selected|22023:invalid_argument:invalid_argument',
  'R31: an empty request and a null id are refused');

-- R32: an occurrence already linked to a live count keeps it, with no new
-- event (the link is a no-op).
select public.start_targeted_recount(:orgA, array[:'oV1']::uuid[], null, null, 'key-4') as "r32" \gset
select is(
  row(:'r32'::jsonb#>'{linkedExisting,0,cycleCountId}', array_length(pg_temp.tl(:'oV1'), 1))::text,
  row(to_jsonb(:'x1'::text), 2)::text,
  'R32: recounting an occurrence already being recounted links nothing new and makes no count');

-- ═══ L. _exc_link_recount called directly ═════════════════════════════════
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccB)),
  'P0002::cycle_count_not_found', 'L1: a count from another org is P0002');
select is(
  pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccKDone)) || '|'
    || pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccKCan)),
  'P0001:recount_count_not_open:recount_count_not_open|P0001:recount_count_not_open:recount_count_not_open',
  'L2: a completed or cancelled count is refused');
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccKX)),
  'P0001:recount_item_not_in_count:recount_item_not_in_count', 'L3: a count that does not hold the item is refused');
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oRes', :ccK1)),
  'P0001:occurrence_resolved:occurrence_resolved', 'L4: a resolved occurrence is refused');
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oSt', :ccK1)),
  'P0001:not_recountable:not_recountable', 'L5: a holding-rule occurrence is refused');
set local "request.jwt.claim.sub" to :stf;
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccK1)),
  '42501::forbidden', 'L6: staff get 42501');
set local "request.jwt.claim.sub" to :mgrNA;
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccK1)),
  '42501::forbidden', 'L7: a manager without cycle_counts:assign gets 42501');
-- Mutation: skip the visibility check (the other org's manager then learns
-- the row exists: 42501 instead of P0002).
set local "request.jwt.claim.sub" to :mgrB;
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccK1)),
  'P0002::occurrence_not_found', 'L8: a caller who cannot see the occurrence gets P0002 (existence not leaked)');
set local "request.jwt.claim.sub" to '';
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccK1)),
  '42501::not_authenticated', 'L9: no session gets 42501');
set local "request.jwt.claim.sub" to :mgr;
select is(
  (select coalesce(recount_cycle_count_id::text, '-') || '|' || array_length(pg_temp.tl(id), 1)
     from public.exception_occurrences where id = :'oK1'),
  '-|1',
  'L10: the refusals changed nothing (no pointer, no event)');
select public._exc_link_recount(:'oK1', :ccK1) as "l11" \gset
select is(:'l11'::boolean, true, 'L11: a manager links an open occurrence to a count holding its item');
select public._exc_link_recount(:'oK1', :ccK1) as "l12" \gset
select is(
  row(:'l12'::boolean, pg_temp.tl(:'oK1'))::text,
  row(false, array['raised:-:system', 'recount_linked:' || :ccK1 || ':' || :mgr])::text,
  'L12: linking it again is a no-op (false, no second event)');
select is(pg_temp.err(format($$select public._exc_link_recount(%L, %L)$$, :'oK1', :ccK2)),
  'P0001:recount_already_linked:recount_already_linked', 'L13: a second live recount is refused');

-- L14: a stale pointer (the count is over, the sync has not run) is closed
-- first, then relinked, and the timeline reads in order.
reset role;
update public.exception_occurrences set recount_cycle_count_id = :ccKDone where id = :'oK2';
set local role to 'authenticated';
select public._exc_link_recount(:'oK2', :ccK3) as "l14" \gset
select is(
  row(:'l14'::boolean, pg_temp.tl(:'oK2'))::text,
  row(true, array['raised:-:system', 'recount_closed:' || :ccKDone || ':system', 'recount_linked:' || :ccK3 || ':' || :mgr])::text,
  'L14: a stale pointer is closed with recount_closed before the new link');

-- R33: the item is in two open counts; the occurrence already points at the
-- older one, which wins over the newest (no recount_already_linked), and the
-- result reports the item and the occurrence under that one count.
select public.start_targeted_recount(:orgA, array[:'oK1']::uuid[], null, null, 'key-5') as "r33" \gset
select is(
  row((select jsonb_agg(e - 'countNumber' - 'startedAt' - 'assignedTo') from jsonb_array_elements(:'r33'::jsonb->'linkedExisting') e),
      (select recount_cycle_count_id::text from public.exception_occurrences where id = :'oK1'),
      array_length(pg_temp.tl(:'oK1'), 1))::text,
  row(jsonb_build_array(jsonb_build_object('cycleCountId', :ccK1::uuid, 'itemIds', jsonb_build_array(:iK1::uuid),
                                           'occurrenceIds', jsonb_build_array(:'oK1'::uuid))),
      :ccK1, 2)::text,
  'R33: the count an occurrence already points at is kept over a newer open count, and reported as the one count');

-- ═══ S. The loop: recount, record, post or cancel, sync ═══════════════════
select (public.start_targeted_recount(:orgA, array[:'oL1', :'oL2']::uuid[], null, 'Recount: 2 items', 'key-loop')->>'cycleCountId') as "xL" \gset
select (public.start_targeted_recount(:orgA, array[:'oL3']::uuid[], null, 'Recount: Loop cancelled', 'key-cancel')->>'cycleCountId') as "xC" \gset

-- Staff count: L1 matches the book (10), L2 finds 13.
set local "request.jwt.claim.sub" to :stf;
update public.cycle_count_lines set counted_quantity = 10, counted_by = :stf, counted_at = now()
 where cycle_count_id = :'xL' and item_id = :iL1;
update public.cycle_count_lines set counted_quantity = 13, counted_by = :stf, counted_at = now()
 where cycle_count_id = :'xL' and item_id = :iL2;
-- The frozen post locks its count FOR UPDATE, which runs under the
-- manager-only UPDATE policy, so to staff the count reads as not found.
select is(pg_temp.err(format($$select public.post_cycle_count(%L)$$, :'xL'))
            || '|' || (select status from public.cycle_counts where id = :'xL'),
  'P0002::cycle_count_not_found|in_progress', 'S1: staff cannot post the recount (the manager posts)');

set local "request.jwt.claim.sub" to :mgr;
select is((public.post_cycle_count(:'xL')).status, 'completed', 'S2: the manager posts the recount');
update public.cycle_counts set status = 'canceled', canceled_by = :mgr, canceled_at = now()
 where id = :'xC' and status = 'in_progress';
select is((select status from public.cycle_counts where id = :'xC'), 'canceled', 'S3: the manager cancels the other recount');
select is(
  (select string_agg(i.sku || '=' || i.quantity_on_hand::int, ',' order by i.sku) from public.inventory_items i where i.id in (:iL1, :iL2, :iL3)),
  'X0372-L1=10,X0372-L2=13,X0372-L3=10',
  'S4: the post corrected only the item that differed (an ordinary count post; F1 wrote no stock)');
reset role;

-- The system sync after the post (the service's after() follow-up).
set local role to 'service_role';
select pg_temp.sync(:orgA, now() + interval '10 seconds') as "syncLoop" \gset
reset role;
select is(
  (:'syncLoop'::jsonb)->'recountsClosed',
  '3'::jsonb,
  'S5: the sync closes the three recount pointers whose counts are over');
select is(
  row((select resolved_reason from public.exception_occurrences where id = :'oL1'),
      (select recount_cycle_count_id from public.exception_occurrences where id = :'oL1'),
      pg_temp.tl(:'oL1'))::text,
  row('cleared', null::uuid,
      array['raised:-:system', 'recount_linked:' || :'xL' || ':' || :mgr, 'recount_closed:' || :'xL' || ':system', 'resolved:-:system'])::text,
  'S6: the recount that matched the book resolves it: raised, recount linked, recount closed, resolved');
select is(
  row((select resolved_at from public.exception_occurrences where id = :'oL2'),
      (select recount_cycle_count_id from public.exception_occurrences where id = :'oL2'),
      (select facts->>'variance' from public.exception_occurrences where id = :'oL2'),
      (select (facts->>'countNumber')::bigint = (select count_number from public.cycle_counts where id = :'xL')
         from public.exception_occurrences where id = :'oL2'),
      pg_temp.tl(:'oL2'))::text,
  row(null::timestamptz, null::uuid, '3.0000', true,
      array['raised:-:system', 'recount_linked:' || :'xL' || ':' || :mgr, 'recount_closed:' || :'xL' || ':system'])::text,
  'S7: a recount that found another difference keeps it open, with the new count''s facts');
select is(
  row((select resolved_at from public.exception_occurrences where id = :'oL3'),
      (select recount_cycle_count_id from public.exception_occurrences where id = :'oL3'),
      pg_temp.tl(:'oL3'))::text,
  row(null::timestamptz, null::uuid,
      array['raised:-:system', 'recount_linked:' || :'xC' || ':' || :mgr, 'recount_closed:' || :'xC' || ':system'])::text,
  'S8: a cancelled recount closes the pointer and leaves it open');
select is(
  (select array_agg(o.recount_cycle_count_id::text order by o.id) from public.exception_occurrences o where o.id in (:'oV1', :'oR2')),
  array[:'x1', :'x1'],
  'S9: pointers to counts still in progress are left alone');

-- ═══ C. _latest_count_lines ═══════════════════════════════════════════════
select is(
  (select l.cycle_count_id from public._latest_count_lines(:orgC, array[:cL1]::uuid[]) l),
  :ccLa::uuid,
  'C1: the latest OBSERVATION wins over a later post of an older (offline) observation; cancelled, in-progress and uncounted lines are ignored');
select is(
  (select l.cycle_count_id from public._latest_count_lines(:orgC, array[:cL2]::uuid[]) l),
  :ccLc::uuid,
  'C2: a line with no baseline is placed by counted_at');
select is(
  (select l.cycle_count_id from public._latest_count_lines(:orgC, array[:cL3]::uuid[]) l),
  :ccLf::uuid,
  'C3: on the same baseline, the later post wins');
select is(
  (select array_agg(l.item_id order by l.item_id) from public._latest_count_lines(:orgC) l),
  array[:cL1, :cL2, :cL3, :cOld, :cAge, :cRent, :cKit, :cArch, :cDel, :cZero, :cAI]::uuid[],
  'C4: one row per counted item of the org; a line naming another org''s item is ignored');
select is(
  (select array_agg(l.item_id order by l.item_id) from public._latest_count_lines(:orgA) l),
  array[:iK1, :iK2, :iL1, :iL2, :iL3]::uuid[],
  'C5: org A sees only its own completed counts (including the posted recount)');
select is(
  (select row(l.count_number = c.count_number, l.scope, l.completed_at = c.completed_at, l.completed_by, l.counted_by,
              l.captured_at = now() - interval '6 days', l.baseline_at = now() - interval '6 days',
              l.expected_quantity, l.expected_at_start, l.counted_quantity, l.counted_location_id,
              l.counted_location_name, l.ai_assisted, l.line_warehouse_id, l.item_name, l.item_sku,
              l.item_warehouse_id, l.item_countable)::text
     from public._latest_count_lines(:orgC, array[:cAI]::uuid[]) l
     join public.cycle_counts c on c.id = l.cycle_count_id),
  row(true, 'selection', true, :mgrC::uuid, :mgrC::uuid, true, true, 2::numeric(14,4), 2::numeric(14,4),
      3::numeric(14,4), :rC::uuid, 'Rack C-1', true, :whC::uuid, 'AI counted', 'X0372-CAI', :whC::uuid, true)::text,
  'C6: the fields: number, scope, who and when, capture and baseline, quantities, counted location and name, AI-assisted, item');
select is(
  (select string_agg(i.sku || '=' || l.item_countable, ',' order by i.sku)
     from public._latest_count_lines(:orgC, array[:cRent, :cKit, :cArch, :cDel, :cZero]::uuid[]) l
     join public.inventory_items i on i.id = l.item_id),
  'X0372-CA=false,X0372-CD=false,X0372-CK=false,X0372-CR=false,X0372-CZ=true',
  'C7: rental, kit, archived and deleted items are not countable (start_cycle_count''s predicate)');

-- ═══ V. count_variance through the sync ═══════════════════════════════════
select is(
  (select array_agg((v.state, v.entry->>'itemId', v.entry#>>'{facts,variance}')::text order by v.entry->>'itemId')
     from pg_temp.cv_eval(:orgC) v),
  array[('present', :cL1, '2.0000')::text, ('hold', :cOld, '-3.0000')::text,
        ('present', :cAge, '1.0000')::text, ('present', :cAI, '1.0000')::text],
  'V1: the latest line decides (C1 +2; C2 and C3 matched last); older than 30 days is held; not countable items and zero variance are left out');

set local role to 'service_role';
select pg_temp.sync(:orgC, now() - interval '10 minutes') as "syncC1" \gset
reset role;
select is(
  (select array_agg(o.item_id order by o.item_id) from public.exception_occurrences o
    where o.organization_id = :orgC and o.rule = 'count_variance' and o.resolved_at is null),
  array[:cL1, :cAge, :cAI]::uuid[],
  'V2: the sync opens count_variance for the present items only; the held one does not open');
select is(
  (select row(o.location_id, o.warehouse_id, o.condition_since = now() - interval '2 days')::text
     from public.exception_occurrences o where o.organization_id = :orgC and o.item_id = :cL1),
  row(null::uuid, :whC::uuid, true)::text,
  'V3: count_variance is item-level, stamped with the item''s warehouse, condition since the observation');

-- Zero clears: a later count of C1 matches the book. Planted as the owner
-- with no API claims (the numbering trigger treats a JWT caller who is not a
-- manager of the org as a refused insert and leaves the number null).
set local "request.jwt.claim.sub"  to '';
set local "request.jwt.claim.role" to '';
alter table public.cycle_count_lines disable trigger cycle_count_lines_rebase_expected;
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at, completed_at, completed_by)
values (:ccLfix, :orgC, :whC, 'completed', 'selection', :mgrC, now() - interval '30 minutes', now() - interval '8 minutes', :mgrC);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, expected_at_start, counted_quantity, counted_by, counted_at, baseline_at)
values (:ccLfix, :cL1, :whC, 12, 12, 12, :mgrC, now() - interval '20 minutes', now() - interval '20 minutes');
alter table public.cycle_count_lines enable trigger cycle_count_lines_rebase_expected;
-- Aging: the 20-day count is now 31 days old.
update public.cycle_counts set completed_at = now() - interval '31 days' where id = :ccLage;

set local role to 'service_role';
select pg_temp.sync(:orgC, now() - interval '5 minutes') as "syncC2" \gset
reset role;
select is(
  (select o.resolved_reason from public.exception_occurrences o where o.organization_id = :orgC and o.item_id = :cL1),
  'cleared',
  'V4: a later count that matches the book exactly clears it');
select is(
  (select row(o.resolved_at, (select count(*) from public.exception_occurrences o2
                                where o2.organization_id = :orgC and o2.item_id = :cAge))::text
     from public.exception_occurrences o where o.organization_id = :orgC and o.item_id = :cAge),
  row(null::timestamptz, 1::bigint)::text,
  'V5: a variance that ages past 30 days is held: its open row stays open (it never ages out)');
select is(
  (select count(*)::int from public.exception_occurrences o
    where o.organization_id = :orgC and o.item_id in (:cOld, :cRent, :cKit, :cArch, :cDel, :cZero)),
  0,
  'V6: the old, not countable and zero-variance items never opened');

select * from finish();
rollback;
