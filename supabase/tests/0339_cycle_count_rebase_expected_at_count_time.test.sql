-- supabase/tests/0339_cycle_count_rebase_expected_at_count_time.test.sql
-- pgTAP gate for migration 0339: cycle-count variance is measured against
-- the system quantity WHEN THE LINE WAS COUNTED and applied on top of the
-- live quantity at post time, so the ledger chains and nothing is counted
-- twice. post_cycle_count v4 supersedes 0327 IN FULL, so every 0327 guard
-- is re-pinned here too.
--
-- The scenario that found the bug ("Maus I", L4L, 2026-07-23), as literals:
--   snapshot 124 -> order pick -15 (live 109) -> counter enters 89 -> post.
--   v3 wrote adjust -35 / previous 124 / new 89 (the pick subtracted twice on
--   the ledger, chain broken: prior row's new_quantity was 109).
--   v4 MUST write adjust -20 / previous 109 / new 89, with a [rebased] note
--   and NO [drift] note. Those three numbers are the pins that fail under a
--   revert to snapshot-based variance (mutation-proved at ship time).
--
-- Every literal is pinned (no tautologies): quantities, movement deltas,
-- previous/new, note text, error codes.
--
-- Namespace: 03390000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(117);

\set org      '\'03390000-0000-0000-0000-000000000001\''
\set orgU     '\'03390000-0000-0000-0000-000000000002\''
\set mgr      '\'03390000-0000-0000-0000-0000000000a1\''
\set stf      '\'03390000-0000-0000-0000-0000000000a2\''
\set outsider '\'03390000-0000-0000-0000-0000000000a3\''
\set whA      '\'03390000-0000-0000-0000-0000000000b1\''
\set whB      '\'03390000-0000-0000-0000-0000000000b2\''
\set rack     '\'03390000-0000-0000-0000-0000000000e1\''
\set itemM    '\'03390000-0000-0000-0000-0000000000c1\''
\set itemP    '\'03390000-0000-0000-0000-0000000000c2\''
\set itemN    '\'03390000-0000-0000-0000-0000000000c3\''
\set itemS    '\'03390000-0000-0000-0000-0000000000c4\''
\set itemZ    '\'03390000-0000-0000-0000-0000000000c5\''
\set itemE    '\'03390000-0000-0000-0000-0000000000c6\''
\set itemG    '\'03390000-0000-0000-0000-0000000000c7\''
\set itemL1   '\'03390000-0000-0000-0000-0000000000c8\''
\set itemL2   '\'03390000-0000-0000-0000-0000000000c9\''
\set itemW    '\'03390000-0000-0000-0000-0000000000ca\''
\set itemD    '\'03390000-0000-0000-0000-0000000000cb\''
\set itemU    '\'03390000-0000-0000-0000-0000000000cc\''
\set itemK    '\'03390000-0000-0000-0000-0000000000cd\''
\set ccMain   '\'03390000-0000-0000-0000-0000000000d1\''
\set ccNeg    '\'03390000-0000-0000-0000-0000000000d2\''
\set ccLegD   '\'03390000-0000-0000-0000-0000000000d3\''
\set ccLegU   '\'03390000-0000-0000-0000-0000000000d4\''
\set ccWh     '\'03390000-0000-0000-0000-0000000000d5\''
\set ccDone   '\'03390000-0000-0000-0000-0000000000d6\''
\set lnM      '\'03390000-0000-0000-0000-0000000000f1\''
\set lnP      '\'03390000-0000-0000-0000-0000000000f2\''
\set lnN      '\'03390000-0000-0000-0000-0000000000f3\''
\set lnS      '\'03390000-0000-0000-0000-0000000000f4\''
\set lnZ      '\'03390000-0000-0000-0000-0000000000f5\''
\set lnE      '\'03390000-0000-0000-0000-0000000000f6\''
\set lnG      '\'03390000-0000-0000-0000-0000000000f7\''
\set lnL1     '\'03390000-0000-0000-0000-0000000000f8\''
\set lnL2     '\'03390000-0000-0000-0000-0000000000f9\''
\set lnW      '\'03390000-0000-0000-0000-0000000000fa\''
\set lnD      '\'03390000-0000-0000-0000-0000000000fb\''
\set lnU      '\'03390000-0000-0000-0000-0000000000fc\''
\set lnK      '\'03390000-0000-0000-0000-0000000000fd\''
\set pickM    '\'03390000-0000-0000-0000-000000000091\''

-- ═════════════════════════════════════════════════════════════════════════════
-- Fixtures (superuser: RLS bypassed)
-- ═════════════════════════════════════════════════════════════════════════════

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,      'mgr-0339@test.local',      '{}'::jsonb),
  (:stf,      'staff-0339@test.local',    '{}'::jsonb),
  (:outsider, 'outsider-0339@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:org,  'Rebase Org 0339',   'rebase-org-0339'),
  (:orgU, 'Rebase Org U 0339', 'rebase-org-u-0339')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org,  :mgr,      'manager', now()),
  (:org,  :stf,      'staff',   now()),
  (:orgU, :outsider, 'manager', now())
on conflict do nothing;

-- The 0188 trigger auto-creates Staging + Unplaced for each warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org, 'Rebase WH A 0339', 'WH-0339-A', 'active'),
  (:whB, :org, 'Rebase WH B 0339', 'WH-0339-B', 'active')
on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :whA, 'Rack 0339', 'bin', 'rack')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemM,  :org, :whA, 'RB-0339-M',  'Maus I (snapshot 124, pick -15, count 89)', 124, 'active', 'none'),
  (:itemP,  :org, :whA, 'RB-0339-P',  'Post-count pick item',                       109, 'active', 'none'),
  (:itemN,  :org, :whA, 'RB-0339-N',  'No-drift negative item',                      10, 'active', 'none'),
  (:itemS,  :org, :whA, 'RB-0339-S',  'No-drift positive item',                      10, 'active', 'none'),
  (:itemZ,  :org, :whA, 'RB-0339-Z',  'Drift zero-variance item',                   124, 'active', 'none'),
  (:itemE,  :org, :whA, 'RB-0339-E',  'Drift counted-equals-start item',            124, 'active', 'none'),
  (:itemG,  :org, :whA, 'RB-0339-G',  'Negative-result item',                         5, 'active', 'none'),
  (:itemL1, :org, :whA, 'RB-0339-L1', 'Legacy drifted item',                         20, 'active', 'none'),
  (:itemL2, :org, :whA, 'RB-0339-L2', 'Legacy undrifted item',                       20, 'active', 'none'),
  (:itemW,  :org, :whA, 'RB-0339-W',  'Warehouse-moved item',                         8, 'active', 'none'),
  (:itemD,  :org, :whA, 'RB-0339-D',  'Soft-deleted item',                            8, 'active', 'none'),
  (:itemU,  :org, :whA, 'RB-0339-U',  'Uncounted item',                               5, 'active', 'none'),
  (:itemK,  :org, :whA, 'RB-0339-K',  'Cleared-count item',                          30, 'active', 'none')
on conflict (id) do nothing;

-- The 0199 trigger seeds an Unplaced row per item; clear and place every unit
-- in the rack so each quantity below is a literal this file controls.
delete from public.item_stock_levels
  where item_id in (:itemM, :itemP, :itemN, :itemS, :itemZ, :itemE, :itemG,
                    :itemL1, :itemL2, :itemW, :itemD, :itemU, :itemK);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :itemM,  :rack, 124),
  (:org, :itemP,  :rack, 109),
  (:org, :itemN,  :rack,  10),
  (:org, :itemS,  :rack,  10),
  (:org, :itemZ,  :rack, 124),
  (:org, :itemE,  :rack, 124),
  (:org, :itemG,  :rack,   5),
  (:org, :itemL1, :rack,  20),
  (:org, :itemL2, :rack,  20),
  (:org, :itemW,  :rack,   8),
  (:org, :itemD,  :rack,   8),
  (:org, :itemU,  :rack,   5),
  (:org, :itemK,  :rack,  30)
on conflict (item_id, location_id) do nothing;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccMain, :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccNeg,  :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccLegD, :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccLegU, :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccWh,   :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccDone, :org, :whA, 'completed',   'warehouse', :mgr, now())
on conflict (id) do nothing;

-- Session START: every line snapshots the live quantity, counted is null
-- (this is what start_cycle_count writes).
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id) values
  (:lnM, :ccMain, :itemM, 124, null, :whA),
  (:lnP, :ccMain, :itemP, 109, null, :whA),
  (:lnN, :ccMain, :itemN,  10, null, :whA),
  (:lnS, :ccMain, :itemS,  10, null, :whA),
  (:lnZ, :ccMain, :itemZ, 124, null, :whA),
  (:lnE, :ccMain, :itemE, 124, null, :whA),
  (:lnD, :ccMain, :itemD,   8, null, :whA),
  (:lnU, :ccMain, :itemU,   5, null, :whA),
  (:lnK, :ccMain, :itemK,  30, null, :whA),
  (:lnG, :ccNeg,  :itemG,   5, null, :whA),
  (:lnW, :ccWh,   :itemW,   8, null, :whA)
on conflict do nothing;

-- Legacy lines: inserted ALREADY COUNTED (the trigger stamps them), then the
-- stamp is removed below to reproduce a pre-0339 row exactly.
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, notes, warehouse_id) values
  (:lnL1, :ccLegD, :itemL1, 20, 15, 'legacy drifted note',   :whA),
  (:lnL2, :ccLegU, :itemL2, 20, 15, 'legacy undrifted note', :whA)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Structure pins
-- ═════════════════════════════════════════════════════════════════════════════

select has_column('public', 'cycle_count_lines', 'expected_at_start',
  '0339: cycle_count_lines.expected_at_start exists');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.cycle_count_lines'::regclass
             and tgname = 'cycle_count_lines_rebase_expected'
             and not tgisinternal
             and (tgtype & 2)  = 2     -- BEFORE
             and (tgtype & 4)  = 4     -- INSERT
             and (tgtype & 16) = 16),  -- UPDATE
  '0339: cycle_count_lines_rebase_expected is a BEFORE INSERT OR UPDATE row trigger'
);

select ok(
  (select p.prosecdef from pg_proc p
    where p.oid = 'public.tg_cycle_count_line_rebase_expected()'::regprocedure),
  '0339: the rebase trigger fn is SECURITY DEFINER (the writer''s inventory read scope cannot keep the stale snapshot)'
);
select ok(
  (select 'search_path=public' = any(p.proconfig) from pg_proc p
    where p.oid = 'public.tg_cycle_count_line_rebase_expected()'::regprocedure),
  '0339: the rebase trigger fn pins search_path=public'
);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.tg_cycle_count_line_rebase_expected()'::regprocedure
       and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  '0339: PUBLIC holds no EXECUTE on the rebase trigger fn'
);
select ok(
  not has_function_privilege('anon', 'public.tg_cycle_count_line_rebase_expected()', 'execute'),
  '0339: anon holds no EXECUTE on the rebase trigger fn'
);
select ok(
  not has_function_privilege('authenticated', 'public.tg_cycle_count_line_rebase_expected()', 'execute'),
  '0339: authenticated holds no EXECUTE on the rebase trigger fn (firing does not need it)'
);

-- post_cycle_count posture carried from 0327/0329.
select ok(
  not (select p.prosecdef from pg_proc p
        where p.oid = 'public.post_cycle_count(uuid)'::regprocedure),
  '0339: post_cycle_count stays SECURITY INVOKER (RLS applies to its writes)'
);
select ok(
  (select 'search_path=public' = any(p.proconfig) from pg_proc p
    where p.oid = 'public.post_cycle_count(uuid)'::regprocedure),
  '0339: post_cycle_count pins search_path=public'
);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.post_cycle_count(uuid)'::regprocedure
       and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  '0339: PUBLIC holds no EXECUTE on post_cycle_count'
);
select ok(
  not has_function_privilege('anon', 'public.post_cycle_count(uuid)', 'execute'),
  '0339: anon holds no EXECUTE on post_cycle_count'
);
select ok(
  has_function_privilege('authenticated', 'public.post_cycle_count(uuid)', 'execute'),
  '0339: authenticated holds EXECUTE on post_cycle_count'
);
-- Wiring pins (0327): the Σ still goes through the definer helper and the
-- levels are still reconciled staging_first.
select ok(
  (select p.prosrc like '%_cycle_count_org_stock_sum%' from pg_proc p
    where p.oid = 'public.post_cycle_count(uuid)'::regprocedure),
  '0339: post_cycle_count computes its reconciliation sum via _cycle_count_org_stock_sum (0327 wiring pin carried)'
);
select ok(
  (select p.prosrc like '%apply_level_delta%' and p.prosrc like '%staging_first%' from pg_proc p
    where p.oid = 'public.post_cycle_count(uuid)'::regprocedure),
  '0339: post_cycle_count reconciles item_stock_levels via apply_level_delta(..., staging_first) (0196 wiring pin carried)'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The trigger on INSERT: an already-counted insert is stamped + rebased.
--    (Legacy fixture lines, before the stamp is removed.)
-- ═════════════════════════════════════════════════════════════════════════════

select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnL1),
  20::numeric,
  '0339 trigger/insert: a line inserted already counted gets expected_at_start = its snapshot (20)'
);
select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnL1),
  20::numeric,
  '0339 trigger/insert: expected_quantity rebased to the live qty (20 — no drift at insert)'
);
select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnM),
  null::numeric,
  '0339 trigger/insert: a start() line (counted null) is NOT stamped — expected_at_start stays null until counted'
);

-- Reproduce pre-0339 rows: counted, no stamp, expected = start snapshot.
-- (An update that does not touch counted_quantity does not fire the trigger.)
update public.cycle_count_lines
   set expected_at_start = null, expected_quantity = 20
 where id in (:lnL1, :lnL2);

select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnL1),
  null::numeric,
  'CONTROL: legacy line L1 has expected_at_start null (pre-0339 shape reproduced)'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. MOVEMENTS BETWEEN START AND COUNT (as the warehouse would): Maus pick.
-- ═════════════════════════════════════════════════════════════════════════════

-- The order pick: 124 -> 109, on its own ledger row (this is the row the
-- count row must CHAIN from).
insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, reason, user_id, reference_type)
  values (:pickM, :org, :itemM, 'remove', -15, 124, 109, 'order pick (fixture)', :mgr, 'order_request');
update public.inventory_items set quantity_on_hand = 109 where id = :itemM;
update public.item_stock_levels set quantity = 109 where item_id = :itemM and location_id = :rack;

-- Drift zero-variance + counted-equals-start items: -15 before the count too.
update public.inventory_items set quantity_on_hand = 109 where id in (:itemZ, :itemE);
update public.item_stock_levels set quantity = 109 where item_id in (:itemZ, :itemE) and location_id = :rack;

-- Cleared-count item: -5 before the count.
update public.inventory_items set quantity_on_hand = 25 where id = :itemK;
update public.item_stock_levels set quantity = 25 where item_id = :itemK and location_id = :rack;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. THE COUNTER RECORDS — as the authenticated manager, through RLS, so the
--    trigger fires under the real writer role.
-- ═════════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

update public.cycle_count_lines
   set counted_quantity = 89, counted_by = :mgr, counted_at = now()
 where id = :lnM;                                              -- Maus: shelf holds 89
update public.cycle_count_lines
   set counted_quantity = 89, counted_by = :mgr, counted_at = now()
 where id = :lnP;                                              -- P: 109 live, counts 89
update public.cycle_count_lines
   set counted_quantity = 7, counted_by = :mgr, counted_at = now()
 where id = :lnN;                                              -- N: 10 -> 7
update public.cycle_count_lines
   set counted_quantity = 13, counted_by = :mgr, counted_at = now()
 where id = :lnS;                                              -- S: 10 -> 13
update public.cycle_count_lines
   set counted_quantity = 109, counted_by = :mgr, counted_at = now()
 where id = :lnZ;                                              -- Z: live 109, counts 109
update public.cycle_count_lines
   set counted_quantity = 124, counted_by = :mgr, counted_at = now()
 where id = :lnE;                                              -- E: live 109, counts 124
update public.cycle_count_lines
   set counted_quantity = 3, counted_by = :mgr, counted_at = now()
 where id = :lnD;                                              -- D: item is soft-deleted below
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :mgr, counted_at = now()
 where id = :lnK;                                              -- K: live 25, counts 20, cleared below
update public.cycle_count_lines
   set counted_quantity = 0, counted_by = :mgr, counted_at = now()
 where id = :lnG;                                              -- G: live 5, counts 0
update public.cycle_count_lines
   set counted_quantity = 6, counted_by = :mgr, counted_at = now()
 where id = :lnW;                                              -- W: live 8, counts 6

reset role;

-- Maus line after the count: rebased to the count-time qty, start kept.
select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnM),
  109::numeric,
  '0339 Maus/count: expected_quantity rebased 124 -> 109 (the pick left before the counter arrived)'
);
select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnM),
  124::numeric,
  '0339 Maus/count: expected_at_start keeps the start snapshot 124'
);
select is(
  (select counted_quantity - expected_quantity from public.cycle_count_lines where id = :lnM),
  -20::numeric,
  '0339 Maus/count: the variance every reader shows is counted - expected = 89 - 109 = -20 (NOT -35)'
);
-- Undrifted lines: rebase is a no-op and start = expected.
select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnP),
  109::numeric,
  '0339 trigger: an undrifted line keeps expected_quantity = 109'
);
select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnP),
  109::numeric,
  '0339 trigger: an undrifted line is stamped expected_at_start = 109'
);
select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnZ),
  109::numeric,
  '0339 trigger: drifted zero-variance line rebased 124 -> 109'
);
select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnE),
  109::numeric,
  '0339 trigger: drifted counted-equals-start line rebased 124 -> 109'
);
select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnK),
  25::numeric,
  '0339 trigger: cleared-count line rebased 30 -> 25 on count'
);

-- clearCount: counted -> null restores the start snapshot.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = null, counted_by = null, counted_at = null
 where id = :lnK;
reset role;

select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnK),
  30::numeric,
  '0339 clearCount: clearing the count restores expected_quantity to the start snapshot (25 -> 30)'
);
select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnK),
  30::numeric,
  '0339 clearCount: expected_at_start is kept (30)'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. MOVEMENTS BETWEEN COUNT AND POST.
-- ═════════════════════════════════════════════════════════════════════════════

-- P: a pick of 15 leaves AFTER the count (109 -> 94).
update public.inventory_items set quantity_on_hand = 94 where id = :itemP;
update public.item_stock_levels set quantity = 94 where item_id = :itemP and location_id = :rack;

-- G: the last 5 leave after the count (5 -> 0); counted 0 vs base 5 = -5.
update public.inventory_items set quantity_on_hand = 0 where id = :itemG;
update public.item_stock_levels set quantity = 0 where item_id = :itemG and location_id = :rack;

-- L1: legacy drifted — the item moved (20 -> 18) and there is no count-time stamp.
update public.inventory_items set quantity_on_hand = 18 where id = :itemL1;
update public.item_stock_levels set quantity = 18 where item_id = :itemL1 and location_id = :rack;

-- W: the item moved to another warehouse mid-count.
update public.inventory_items set warehouse_id = :whB where id = :itemW;

-- D: the item was soft-deleted after being counted.
update public.inventory_items set deleted_at = now() where id = :itemD;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. GUARDS (0327 carried + new), before the legit post.
-- ═════════════════════════════════════════════════════════════════════════════

-- Not found (P0002).
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$select public.post_cycle_count('03390000-0000-0000-0000-00000000dead'::uuid)$$,
  'P0002', 'cycle_count_not_found',
  '0339 guard: unknown count raises cycle_count_not_found (P0002)'
);
-- Not open (22023).
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccDone),
  '22023', 'cycle_count_not_open',
  '0339 guard: a completed count raises cycle_count_not_open (22023)'
);
-- Warehouse move (22023).
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccWh),
  '22023', 'item_out_of_scope',
  '0339 guard: an item moved to another warehouse mid-count raises item_out_of_scope (22023) — 0079/0327 guard carried'
);
-- Negative result (P0001, new).
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccNeg),
  'P0001', 'cycle_count_negative_result',
  '0339 guard: counted 0 at live 5, then -5 after the count -> live + variance = -5 raises cycle_count_negative_result (P0001)'
);
-- Legacy drifted (P0001, new).
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccLegD),
  'P0001', 'cycle_count_stale_line',
  '0339 guard: a pre-0339 counted line whose stock moved (20 -> 18) raises cycle_count_stale_line (P0001) instead of guessing'
);
reset role;

-- The refused posts wrote nothing.
select is(
  (select count(*) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id in (:ccWh, :ccNeg, :ccLegD)),
  0::bigint,
  '0339 guard: refused posts wrote NO stock_movements rows'
);
select is(
  (select array_agg(status order by id) from public.cycle_counts where id in (:ccWh, :ccNeg, :ccLegD)),
  array['in_progress','in_progress','in_progress'],
  '0339 guard: refused counts stay in_progress'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemG),
  0::numeric,
  '0339 guard: the negative-result item is untouched at 0'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemL1),
  18::numeric,
  '0339 guard: the legacy drifted item is untouched at 18'
);

-- Staff cannot post. The header lock is `select ... for update`, which under
-- RLS also applies the cycle_counts UPDATE policy (has_org_role manager) as a
-- filter, so a staff caller never sees the row: not_found (P0002) — the same
-- outcome v2/v3 produced. The explicit has_org_role manager gate behind it is
-- defence in depth and is pinned by source below.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccLegU),
  'P0002', 'cycle_count_not_found',
  '0339 guard: org staff cannot post (RLS hides the header under FOR UPDATE: cycle_count_not_found)'
);
reset role;
select ok(
  (select p.prosrc like '%has_org_role(v_cc.organization_id, ''manager'')%' from pg_proc p
    where p.oid = 'public.post_cycle_count(uuid)'::regprocedure),
  '0339 guard: post_cycle_count still carries the explicit has_org_role manager gate (0079/0327 forbidden branch)'
);
-- Outsider: the count is invisible under RLS (SECURITY INVOKER), so the
-- outsider gets not_found rather than a confirmation the count exists.
set local "request.jwt.claim.sub"  to :outsider;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccLegU),
  'P0002', 'cycle_count_not_found',
  '0339 guard: an outsider manager cannot post another org''s count (not_found under RLS)'
);
reset role;
select is(
  (select status from public.cycle_counts where id = :ccLegU),
  'in_progress',
  '0339 guard: the count refused to staff/outsider is still in_progress'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. LEGIT POST — the main count, as the authenticated manager.
-- ═════════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.post_cycle_count(%L)$$, :ccMain),
  '0339: the manager posts the main count'
);
select lives_ok(
  format($$select public.post_cycle_count(%L)$$, :ccLegU),
  '0339: the manager posts the legacy undrifted count'
);
reset role;

select is(
  (select status from public.cycle_counts where id = :ccMain),
  'completed',
  '0339: main count completed'
);
select is(
  (select completed_by from public.cycle_counts where id = :ccMain),
  :mgr::uuid,
  '0339: completed_by is the posting manager'
);

-- ── Maus I: the case that found the bug ─────────────────────────────────────
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemM),
  89::numeric,
  '0339 Maus/post: on-hand = 89 (what the counter saw)'
);
select is(
  (select count(*) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  1::bigint,
  '0339 Maus/post: exactly one adjust row for the item'
);
select is(
  (select quantity_change from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  -20::numeric,
  '0339 Maus/post: quantity_change = -20 (89 - 109): the pick is counted ONCE, on its own row — NOT -35'
);
select is(
  (select previous_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  109::numeric,
  '0339 Maus/post: previous_quantity = 109 (the live qty), NOT the snapshot 124'
);
select is(
  (select previous_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  (select new_quantity from public.stock_movements where id = :pickM),
  '0339 Maus/post: THE LEDGER CHAINS — the count row''s previous_quantity equals the pick row''s new_quantity'
);
select is(
  (select new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  89::numeric,
  '0339 Maus/post: new_quantity = 89'
);
select is(
  (select notes from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  '[rebased] expected 124.0000 at start, 109.0000 when counted',
  '0339 Maus/post: the note records the rebase (start 124, count-time 109) and carries NO [drift] tag'
);
select is(
  (select movement_type || '|' || reason || '|' || reference_type from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  'adjust|Cycle count adjustment|cycle_count',
  '0339 Maus/post: adjust / default reason / reference_type cycle_count (0079 shape carried)'
);
select is(
  (select user_id from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemM),
  :mgr::uuid,
  '0339 Maus/post: the movement is attributed to the posting manager'
);
select is(
  (select quantity from public.item_stock_levels where item_id = :itemM and location_id = :rack),
  89::numeric,
  '0339 Maus/post: rack holding reconciled to 89'
);
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemM),
  89::numeric,
  '0339 Maus/post: Σ item_stock_levels = on-hand = 89'
);

-- ── P: a pick between COUNT and POST is preserved on top ────────────────────
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemP),
  74::numeric,
  '0339 post-count pick: on-hand = 74 (live 94 + variance -20): the post-count pick is PRESERVED, not erased'
);
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemP),
  '-20.0000|94.0000|74.0000',
  '0339 post-count pick: change -20, previous 94 (live at post), new 74'
);
select is(
  (select notes from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemP),
  '[drift] live qty 94.0000 differed from count-time qty 109.0000 at post time; variance applied on top',
  '0339 post-count pick: the note records the post-count drift and carries NO [rebased] tag'
);
select is(
  (select quantity from public.item_stock_levels where item_id = :itemP and location_id = :rack),
  74::numeric,
  '0339 post-count pick: rack holding reconciled to 74'
);

-- ── N: no drift, negative variance (0196 A carried) ─────────────────────────
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemN),
  7::numeric,
  '0339 no-drift negative: on-hand 10 -> 7'
);
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity || '|' || coalesce(notes, '<null>')
     from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemN),
  '-3.0000|10.0000|7.0000|<null>',
  '0339 no-drift negative: change -3, previous 10, new 7, no note'
);
select is(
  (select quantity from public.item_stock_levels where item_id = :itemN and location_id = :rack),
  7::numeric,
  '0339 no-drift negative: rack drawn 10 -> 7'
);
select is(
  (select count(*) from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = :itemN and l.kind = 'staging'),
  0::bigint,
  '0339 no-drift negative: no Staging row created'
);

-- ── S: no drift, positive variance (0196 B carried) ─────────────────────────
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemS),
  13::numeric,
  '0339 no-drift positive: on-hand 10 -> 13'
);
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemS),
  '3.0000|10.0000|13.0000',
  '0339 no-drift positive: change +3, previous 10, new 13'
);
-- INVERTED BY 0342. These two pinned the surplus going to Staging, which was
-- the behaviour and was the bug: three units the counter found ON the rack were
-- added to the put-away worklist. 0342 stamps the counted location at count
-- time and reconciles there. The 0339 guarantees this file exists for — the
-- count-time rebase and the ledger chain, asserted immediately above — are
-- untouched by that change.
select is(
  (select quantity from public.item_stock_levels where item_id = :itemS and location_id = :rack),
  13::numeric,
  '0342: the +3 surplus returns to the counted rack (10 -> 13)'
);
select is(
  (select isl.quantity from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = :itemS and l.warehouse_id = :whA and l.kind = 'staging' and l.deleted_at is null
    limit 1),
  null::numeric,
  '0342: Staging never sees the surplus — no row is created for it'
);

-- ── Z: drift, zero variance -> nothing posted ───────────────────────────────
select is(
  (select count(*) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemZ),
  0::bigint,
  '0339 drift zero-variance: counted 109 at live 109 (snapshot 124) writes NO movement row (v3 would have written -15)'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemZ),
  109::numeric,
  '0339 drift zero-variance: on-hand unchanged at 109'
);

-- ── E: drift, counted equals the START snapshot -> +15 (v3 wrote nothing) ───
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemE),
  124::numeric,
  '0339 drift counted-equals-start: counted 124 at live 109 -> on-hand 124 (v3 silently discarded this line)'
);
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemE),
  '15.0000|109.0000|124.0000',
  '0339 drift counted-equals-start: change +15, previous 109, new 124'
);
select is(
  (select notes from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain and item_id = :itemE),
  '[rebased] expected 124.0000 at start, 109.0000 when counted',
  '0339 drift counted-equals-start: [rebased] note, no [drift] (live equalled the count-time qty at post)'
);

-- ── D / U / K: deleted item, uncounted line, cleared line are all skipped ────
select is(
  (select count(*) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain
      and item_id in (:itemD, :itemU, :itemK)),
  0::bigint,
  '0339 skips: soft-deleted item, uncounted line and cleared line write NO movement rows (0079/0327 skips carried)'
);
select is(
  (select array_agg(quantity_on_hand order by id) from public.inventory_items
    where id in (:itemD, :itemU, :itemK)),
  array[8::numeric, 5::numeric, 25::numeric],
  '0339 skips: their on-hand is untouched (8, 5, 25)'
);

-- ── Whole-count net ─────────────────────────────────────────────────────────
select is(
  (select count(*) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain),
  5::bigint,
  '0339 net: the main count wrote exactly 5 adjust rows (M, P, N, S, E)'
);
select is(
  (select sum(quantity_change) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccMain),
  -25::numeric,
  '0339 net: Σ quantity_change = -20 -20 -3 +3 +15 = -25'
);
select is(
  (select sum(l.counted_quantity - l.expected_quantity) from public.cycle_count_lines l
    where l.cycle_count_id = :ccMain and l.counted_quantity is not null
      and l.item_id not in (:itemD)),
  -25::numeric,
  '0339 net: the on-screen net (Σ counted - expected over posted lines) equals the ledger net -25 — the dialog promise holds'
);

-- Σ levels = on-hand for every item the post touched.
select is(
  (select count(*) from public.inventory_items ii
    where ii.id in (:itemM, :itemP, :itemN, :itemS, :itemZ, :itemE)
      and ii.quantity_on_hand <> (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = ii.id)),
  0::bigint,
  '0339 invariant: Σ item_stock_levels = quantity_on_hand for every posted item'
);

-- ── Legacy undrifted count posts normally, notes untouched ───────────────────
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemL2),
  15::numeric,
  '0339 legacy undrifted: posts 20 -> 15'
);
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity || '|' || notes from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccLegU and item_id = :itemL2),
  '-5.0000|20.0000|15.0000|legacy undrifted note',
  '0339 legacy undrifted: change -5, previous 20, new 15, the line note carried verbatim (no null-swallow, no [rebased])'
);
select is(
  (select status from public.cycle_counts where id = :ccLegU),
  'completed',
  '0339 legacy undrifted: count completed'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Recount after a refusal re-stamps the legacy line and it posts.
-- ═════════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
-- clear (counted null -> expected restored from a null stamp = unchanged 20)
update public.cycle_count_lines
   set counted_quantity = null, counted_by = null, counted_at = null
 where id = :lnL1;
-- recount: the shelf holds 15 now
update public.cycle_count_lines
   set counted_quantity = 15, counted_by = :mgr, counted_at = now()
 where id = :lnL1;
reset role;

select is(
  (select expected_at_start || '|' || expected_quantity from public.cycle_count_lines where id = :lnL1),
  '20.0000|18.0000',
  '0339 recount: the legacy line is stamped (start 20) and rebased to the live 18'
);

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.post_cycle_count(%L)$$, :ccLegD),
  '0339 recount: after clear + recount the formerly stale count posts'
);
reset role;

select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity || '|' || notes from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccLegD and item_id = :itemL1),
  E'-3.0000|18.0000|15.0000|legacy drifted note\n[rebased] expected 20.0000 at start, 18.0000 when counted',
  '0339 recount: change -3 (15 - 18), previous 18, new 15; the line note is kept and the rebase appended'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemL1),
  15::numeric,
  '0339 recount: on-hand 18 -> 15'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Idempotence guard: a posted count cannot be posted again.
-- ═════════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccMain),
  '22023', 'cycle_count_not_open',
  '0339: posting the completed main count again raises cycle_count_not_open'
);
reset role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. RECOUNT AFTER A MOVEMENT (t1) + FIRST-ONLY STAMP (t2).
--    A line counted at 89 while live was 124, then a pick of 15 leaves, then
--    the counter re-enters 89 — the SAME number. The trigger fires whenever
--    counted_quantity is in the SET list (UPDATE OF, no WHEN-changed guard):
--    a recount landing on the same number is still a count taken NOW, so
--    expected_quantity is re-stamped to the new live 109 and the variance is
--    re-derived (-20, not the stale -35). expected_at_start is written ONCE
--    (124) and never overwritten by later counts; clearCount restores
--    expected_quantity from it; the [rebased] note at post says
--    'expected 124.0000 at start'.
--    Mutation-proved: (t1) firing only when the value changes leaves
--    expected at 124 after the recount and posts -35; (t2) overwriting
--    expected_at_start on every count moves the start to 109, clearCount
--    restores 109 and the [rebased] note disappears.
-- ═════════════════════════════════════════════════════════════════════════════

\set itemR  '\'03390000-0000-0000-0000-0000000001c1\''
\set ccRe   '\'03390000-0000-0000-0000-0000000001d1\''
\set lnR    '\'03390000-0000-0000-0000-0000000001f1\''
\set pickR  '\'03390000-0000-0000-0000-000000000192\''

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemR, :org, :whA, 'RB-0339-R', 'Recount-after-movement item (124, count 89, pick -15, recount 89)', 124, 'active', 'none')
on conflict (id) do nothing;
delete from public.item_stock_levels where item_id = :itemR;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :itemR, :rack, 124) on conflict (item_id, location_id) do nothing;
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccRe, :org, :whA, 'in_progress', 'warehouse', :mgr, now())
on conflict (id) do nothing;
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id) values
  (:lnR, :ccRe, :itemR, 124, null, :whA)
on conflict do nothing;

-- Count 1: the counter enters 89 while live is still 124.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 89, counted_by = :mgr, counted_at = now()
 where id = :lnR;
reset role;

select is(
  (select expected_at_start || '|' || expected_quantity || '|' || (counted_quantity - expected_quantity)
     from public.cycle_count_lines where id = :lnR),
  '124.0000|124.0000|-35.0000',
  '0339 recount/t1: first count at live 124 -> start 124, expected 124, variance -35 (nothing has moved yet)'
);

-- A pick of 15 leaves AFTER that count (124 -> 109), on its own ledger row.
insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, reason, user_id, reference_type)
  values (:pickR, :org, :itemR, 'remove', -15, 124, 109, 'order pick after first count (fixture)', :mgr, 'order_request');
update public.inventory_items set quantity_on_hand = 109 where id = :itemR;
update public.item_stock_levels set quantity = 109 where item_id = :itemR and location_id = :rack;

-- Count 2: the counter re-enters 89 — the SAME value. counted_quantity is in
-- the SET list, so the trigger must fire and re-stamp expected to the live 109.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 89, counted_by = :mgr, counted_at = now()
 where id = :lnR;
reset role;

select is(
  (select expected_quantity from public.cycle_count_lines where id = :lnR),
  109::numeric,
  '0339 recount/t1: recounting the SAME 89 after the pick re-stamps expected_quantity to the NEW live 109 (the trigger fires on UPDATE OF counted_quantity even when the value is unchanged)'
);
select is(
  (select counted_quantity - expected_quantity from public.cycle_count_lines where id = :lnR),
  -20::numeric,
  '0339 recount/t1: the variance is re-derived: 89 - 109 = -20 (NOT the stale -35)'
);
select is(
  (select expected_at_start from public.cycle_count_lines where id = :lnR),
  124::numeric,
  '0339 recount/t2: expected_at_start stays 124 after the recount — the start snapshot is written ONCE'
);

-- Count 3: the counter taps 89 once more (nothing moved in between). The
-- start must still not move, even though expected (109) now differs from it.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 89, counted_by = :mgr, counted_at = now()
 where id = :lnR;
reset role;

select is(
  (select expected_at_start || '|' || expected_quantity from public.cycle_count_lines where id = :lnR),
  '124.0000|109.0000',
  '0339 recount/t2: a third count while expected (109) differs from start leaves start at 124 and expected at 109'
);

-- clearCount: expected_quantity is restored from the ONE start snapshot (124),
-- not from the last count-time value (109).
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = null, counted_by = null, counted_at = null
 where id = :lnR;
reset role;

select is(
  (select expected_at_start || '|' || expected_quantity from public.cycle_count_lines where id = :lnR),
  '124.0000|124.0000',
  '0339 recount/t2: clearCount restores expected_quantity to the start snapshot 124 (start kept at 124)'
);

-- Count 4: 89 again; live is 109 -> expected 109; then post.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 89, counted_by = :mgr, counted_at = now()
 where id = :lnR;
select is(
  (select expected_at_start || '|' || expected_quantity from public.cycle_count_lines where id = :lnR),
  '124.0000|109.0000',
  '0339 recount: after clear the recount stamps expected 109 again and start is still 124'
);
select lives_ok(
  format($$select public.post_cycle_count(%L)$$, :ccRe),
  '0339 recount: the manager posts the recount'
);
reset role;

select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccRe and item_id = :itemR),
  '-20.0000|109.0000|89.0000',
  '0339 recount/post: change -20 (89 - 109), previous 109 (live), new 89 — the pick that left between count 1 and count 2 is NOT subtracted again'
);
select is(
  (select previous_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccRe and item_id = :itemR),
  (select new_quantity from public.stock_movements where id = :pickR),
  '0339 recount/post: the count row chains from the pick row (previous 109 = pick new_quantity 109)'
);
select is(
  (select notes from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccRe and item_id = :itemR),
  '[rebased] expected 124.0000 at start, 109.0000 when counted',
  '0339 recount/t2: the [rebased] note says ''expected 124.0000 at start'' — the first-only stamp survives every recount'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemR),
  89::numeric,
  '0339 recount/post: on-hand 109 -> 89'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. THE FORBIDDEN GATE, BEHAVIOURALLY (m3).
--     Who can reach `raise exception 'forbidden'`? The header lock is
--     `select ... for update` and post_cycle_count is SECURITY INVOKER, so
--     for the `authenticated` role RLS applies the cycle_counts UPDATE policy
--     (has_org_role(organization_id,'manager') — the SAME predicate as the
--     gate) as a row filter: a non-manager never sees the header and gets
--     cycle_count_not_found (pinned in section 5, staff + outsider). For
--     authenticated callers the 42501 branch is therefore defence in depth
--     that RLS makes unreachable — stated plainly.
--     It IS reachable, and load-bearing, for a connection that BYPASSES RLS
--     and carries no user: service_role holds EXECUTE on post_cycle_count
--     (project default privileges; verified in prod 2026-08-17) and
--     rolbypassrls, and auth.uid() is null there, so has_org_role is false.
--     Without the gate such a call would COMPLETE the count with
--     completed_by null. The line below is counted at zero variance on
--     purpose: with a variance line the SECURITY DEFINER Σ helper would also
--     refuse ('unauthenticated'), and the failure under mutation would be
--     ambiguous; at zero variance the gate is the ONLY thing standing.
--     Mutation-proved: replacing the raise with null completes the count
--     under service_role (throws_ok + status pins fail).
-- ═════════════════════════════════════════════════════════════════════════════

\set itemV  '\'03390000-0000-0000-0000-0000000001c2\''
\set ccSvc  '\'03390000-0000-0000-0000-0000000001d2\''
\set lnV    '\'03390000-0000-0000-0000-0000000001f2\''

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemV, :org, :whA, 'RB-0339-V', 'Service-role gate item', 10, 'active', 'none')
on conflict (id) do nothing;
delete from public.item_stock_levels where item_id = :itemV;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :itemV, :rack, 10) on conflict (item_id, location_id) do nothing;
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccSvc, :org, :whA, 'in_progress', 'warehouse', :mgr, now())
on conflict (id) do nothing;
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id) values
  (:lnV, :ccSvc, :itemV, 10, null, :whA)
on conflict do nothing;

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 10, counted_by = :mgr, counted_at = now()
 where id = :lnV;                                              -- zero variance
reset role;

-- The service connection: no user, RLS bypassed.
set local "request.jwt.claim.sub"  to '';
set local "request.jwt.claim.role" to 'service_role';
set local role to 'service_role';
select ok(
  auth.uid() is null,
  'CONTROL: the service_role connection carries no user (auth.uid() is null)'
);
select is(
  (select status from public.cycle_counts where id = :ccSvc),
  'in_progress',
  'CONTROL: service_role SEES the open header (RLS bypassed) — so the refusal below is the gate, not not_found'
);
select ok(
  not public.has_org_role(:org, 'manager'),
  'CONTROL: has_org_role(org, manager) is false with no user'
);
select throws_ok(
  format($$select public.post_cycle_count(%L)$$, :ccSvc),
  '42501', 'forbidden',
  '0339 gate: a service_role connection that can see the header but is not a manager is refused by the explicit has_org_role gate: forbidden (42501)'
);
reset role;

select is(
  (select status || '|' || coalesce(completed_by::text, '<null>') || '|' || coalesce(completed_at::text, '<null>')
     from public.cycle_counts where id = :ccSvc),
  'in_progress|<null>|<null>',
  '0339 gate: the refused count stays in_progress with no completed_by/completed_at'
);
select is(
  (select count(*) from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccSvc),
  0::bigint,
  '0339 gate: the refused service_role post wrote NO stock_movements rows'
);
select ok(
  has_function_privilege('service_role', 'public.post_cycle_count(uuid)', 'execute')
  and (select rolbypassrls from pg_roles where rolname = 'service_role'),
  '0339 gate: service_role holds EXECUTE + BYPASSRLS — the caller for whom this gate is load-bearing exists (revoke the grant and retire this section together)'
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 11. LEVEL RECONCILIATION vs the naive delta (m8).
--     post_cycle_count calls apply_level_delta(v_new - Σlevels), not
--     apply_level_delta(v_diff). The two are equal only while Σ item_stock_levels
--     = quantity_on_hand at post time. Pre-v4 inconsistencies exist (a level
--     row edited by hand, a pre-0199 item), so build two DRIFTED fixtures:
--       Q1: on-hand 50, rack holds 47 (Σ short by 3)
--       Q2: on-hand 50, rack holds 53 (Σ long by 3)
--     Both counted 48 at live 50 (variance -2 each). v4 must leave
--     Σ levels = 48 = on-hand for BOTH: Q1 gets +1 (48 - 47) into Staging and
--     its rack is untouched; Q2 is drawn 53 -> 48. The naive delta would
--     apply -2 to both: Q1 rack 45 (Σ 45 != 48), Q2 rack 51 (Σ 51 != 48).
--     Mutation-proved: `v_new - v_levels_sum` -> `v_diff` fails the Σ, rack
--     and Staging pins for both items.
-- ═════════════════════════════════════════════════════════════════════════════

\set itemQ1 '\'03390000-0000-0000-0000-0000000001c3\''
\set itemQ2 '\'03390000-0000-0000-0000-0000000001c4\''
\set ccLvl  '\'03390000-0000-0000-0000-0000000001d3\''
\set lnQ1   '\'03390000-0000-0000-0000-0000000001f3\''
\set lnQ2   '\'03390000-0000-0000-0000-0000000001f4\''

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemQ1, :org, :whA, 'RB-0339-Q1', 'Levels short of on-hand (50 vs rack 47)', 50, 'active', 'none'),
  (:itemQ2, :org, :whA, 'RB-0339-Q2', 'Levels long of on-hand (50 vs rack 53)',  50, 'active', 'none')
on conflict (id) do nothing;
delete from public.item_stock_levels where item_id in (:itemQ1, :itemQ2);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :itemQ1, :rack, 47),
  (:org, :itemQ2, :rack, 53)
on conflict (item_id, location_id) do nothing;
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccLvl, :org, :whA, 'in_progress', 'warehouse', :mgr, now())
on conflict (id) do nothing;
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id) values
  (:lnQ1, :ccLvl, :itemQ1, 50, null, :whA),
  (:lnQ2, :ccLvl, :itemQ2, 50, null, :whA)
on conflict do nothing;

select is(
  (select array_agg(s.quantity order by ii.sku) from public.inventory_items ii
     join public.item_stock_levels s on s.item_id = ii.id
    where ii.id in (:itemQ1, :itemQ2)),
  array[47::numeric, 53::numeric],
  'CONTROL: the drifted fixtures hold rack 47 (Q1) and 53 (Q2) against on-hand 50 — Σ levels != on-hand before the post'
);

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 48, counted_by = :mgr, counted_at = now()
 where id in (:lnQ1, :lnQ2);
select lives_ok(
  format($$select public.post_cycle_count(%L)$$, :ccLvl),
  '0339 levels: the manager posts the drifted-levels count'
);
reset role;

-- Q1: Σ short. The ledger row is the plain variance; the levels are
-- reconciled to the NEW on-hand, not nudged by the variance.
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccLvl and item_id = :itemQ1),
  '-2.0000|50.0000|48.0000',
  '0339 levels/Q1: ledger row change -2, previous 50, new 48 (the level drift never leaks into the ledger)'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemQ1),
  48::numeric,
  '0339 levels/Q1: on-hand 50 -> 48'
);
-- INVERTED BY 0342, same reason. The Σ arithmetic this pair was written to
-- protect is unchanged and still load-bearing: the reconciliation delta is
-- (new on-hand − Σ levels) = 48 − 47 = +1, NOT the naive −2 that would leave
-- the rack at 45. Only its DESTINATION moved, from Staging to the counted rack.
select is(
  (select quantity from public.item_stock_levels where item_id = :itemQ1 and location_id = :rack),
  48::numeric,
  '0342 levels/Q1: the +1 delta (48 - 47) goes to the counted rack; the naive -2 would still leave 45'
);
select is(
  (select isl.quantity from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = :itemQ1 and l.warehouse_id = :whA and l.kind = 'staging' and l.deleted_at is null
    limit 1),
  null::numeric,
  '0342 levels/Q1: Staging is untouched by the reconciliation'
);
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemQ1),
  48::numeric,
  '0339 levels/Q1: Σ item_stock_levels = 48 = on-hand after the post (the pre-existing -3 drift is reconciled away)'
);

-- Q2: Σ long. staging_first draw of 5 (53 -> 48); no Staging row exists so
-- the whole draw comes from the rack.
select is(
  (select quantity_change || '|' || previous_quantity || '|' || new_quantity from public.stock_movements
    where reference_type = 'cycle_count' and reference_id = :ccLvl and item_id = :itemQ2),
  '-2.0000|50.0000|48.0000',
  '0339 levels/Q2: ledger row change -2, previous 50, new 48'
);
select is(
  (select quantity from public.item_stock_levels where item_id = :itemQ2 and location_id = :rack),
  48::numeric,
  '0339 levels/Q2: rack drawn 53 -> 48 (Σ 53 -> 48 is -5; the naive -2 would leave 51)'
);
select is(
  (select count(*) from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = :itemQ2 and l.kind = 'staging'),
  0::bigint,
  '0339 levels/Q2: no Staging row was created for a draw-down'
);
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemQ2),
  48::numeric,
  '0339 levels/Q2: Σ item_stock_levels = 48 = on-hand after the post (the pre-existing +3 drift is reconciled away)'
);

select * from finish();
rollback;
