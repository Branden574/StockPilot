-- supabase/tests/0342_cycle_count_location_reconciliation.test.sql
-- pgTAP gate for migration 0342: a positive cycle-count variance goes back into
-- the location that was counted, not into Staging.
--
-- ═══ WHAT THIS FILE HAD TO TRANSLATE ═══
--
-- A cycle-count line is ITEM-level. `expected_quantity` is the item's TOTAL
-- quantity_on_hand across every location, rebased at count time by 0339. So
-- "Rack R1 says 10, the counter enters 12" is NOT expressible: entering 12
-- asserts the item's total is 12, not that R1 holds 12.
--
-- The scenarios below are therefore written in the model that exists — the
-- counter enters a TOTAL, and the surplus is attributed to the single placed
-- location the item occupies. What is pinned is the part that was actually
-- broken: where the surplus LANDS. Staging must not absorb it, other racks must
-- not move, and Σ item_stock_levels must still equal quantity_on_hand.
--
-- Every literal is pinned (no tautologies): per-location quantities, on-hand,
-- movement deltas, ledger chain, error codes.
--
-- Namespace: 03420000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(55);

\set org      '\'03420000-0000-0000-0000-000000000001\''
\set orgU     '\'03420000-0000-0000-0000-000000000002\''
\set mgr      '\'03420000-0000-0000-0000-0000000000a1\''
\set whA      '\'03420000-0000-0000-0000-0000000000b1\''
\set whB      '\'03420000-0000-0000-0000-0000000000b2\''
\set whU      '\'03420000-0000-0000-0000-0000000000b3\''
\set rackA    '\'03420000-0000-0000-0000-0000000000e1\''
\set rackB    '\'03420000-0000-0000-0000-0000000000e2\''
\set crateC   '\'03420000-0000-0000-0000-0000000000e3\''
\set rackWhB  '\'03420000-0000-0000-0000-0000000000e4\''
\set rackU    '\'03420000-0000-0000-0000-0000000000e5\''
\set rackDead '\'03420000-0000-0000-0000-0000000000e6\''
\set itemI    '\'03420000-0000-0000-0000-0000000000c1\''
\set itemB    '\'03420000-0000-0000-0000-0000000000c2\''
\set itemS    '\'03420000-0000-0000-0000-0000000000c3\''
\set itemM    '\'03420000-0000-0000-0000-0000000000c4\''
\set itemN    '\'03420000-0000-0000-0000-0000000000c5\''
\set itemZ    '\'03420000-0000-0000-0000-0000000000c6\''
\set itemD    '\'03420000-0000-0000-0000-0000000000c7\''
\set itemK    '\'03420000-0000-0000-0000-0000000000c8\''
\set itemR    '\'03420000-0000-0000-0000-0000000000c9\''
\set itemW    '\'03420000-0000-0000-0000-0000000000ca\''
\set itemX    '\'03420000-0000-0000-0000-0000000000cb\''
\set itemDeep '\'03420000-0000-0000-0000-0000000000cc\''
\set ccMain   '\'03420000-0000-0000-0000-0000000000d1\''
\set ccWh     '\'03420000-0000-0000-0000-0000000000d2\''
\set ccOrg    '\'03420000-0000-0000-0000-0000000000d3\''
\set lnI      '\'03420000-0000-0000-0000-0000000000f1\''
\set lnB      '\'03420000-0000-0000-0000-0000000000f2\''
\set lnS      '\'03420000-0000-0000-0000-0000000000f3\''
\set lnM      '\'03420000-0000-0000-0000-0000000000f4\''
\set lnN      '\'03420000-0000-0000-0000-0000000000f5\''
\set lnZ      '\'03420000-0000-0000-0000-0000000000f6\''
\set lnD      '\'03420000-0000-0000-0000-0000000000f7\''
\set lnK      '\'03420000-0000-0000-0000-0000000000f8\''
\set lnW      '\'03420000-0000-0000-0000-0000000000f9\''
\set lnX      '\'03420000-0000-0000-0000-0000000000fa\''
\set lnDeep   '\'03420000-0000-0000-0000-0000000000fb\''

-- ═════════════════════════════════════════════════════════════════════════════
-- Fixtures (superuser: RLS bypassed)
-- ═════════════════════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr-0342@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:org,  'Loc Recon Org 0342',   'loc-recon-org-0342'),
  (:orgU, 'Loc Recon Org U 0342', 'loc-recon-org-u-0342')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now())
on conflict do nothing;

-- The 0188 trigger auto-creates Staging + Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org,  'Recon WH A 0342', 'WH-0342-A', 'active'),
  (:whB, :org,  'Recon WH B 0342', 'WH-0342-B', 'active'),
  (:whU, :orgU, 'Recon WH U 0342', 'WH-0342-U', 'active')
on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rackA,    :org,  :whA, 'Rack A 0342',    'bin', 'rack'),
  (:rackB,    :org,  :whA, 'Rack B 0342',    'bin', 'rack'),
  (:crateC,   :org,  :whA, 'Crate C 0342',   'bin', 'crate'),
  (:rackWhB,  :org,  :whB, 'Rack WhB 0342',  'bin', 'rack'),
  (:rackU,    :orgU, :whU, 'Rack U 0342',    'bin', 'rack'),
  (:rackDead, :org,  :whA, 'Rack Dead 0342', 'bin', 'rack')
on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, item_type) values
  (:itemI,    :org, :whA, 'LR-0342-I',  'Item, one rack, finds more',        10, 'active', 'none', 'product'),
  (:itemB,    :org, :whA, 'LR-0342-B',  'Book in a crate, finds more',       20, 'active', 'none', 'book'),
  (:itemS,    :org, :whA, 'LR-0342-S',  'Rack plus existing Staging',        15, 'active', 'none', 'product'),
  (:itemM,    :org, :whA, 'LR-0342-M',  'Two racks: ambiguous',              30, 'active', 'none', 'product'),
  (:itemN,    :org, :whA, 'LR-0342-N',  'One rack, finds fewer',             10, 'active', 'none', 'product'),
  (:itemZ,    :org, :whA, 'LR-0342-Z',  'Zero variance',                     10, 'active', 'none', 'product'),
  (:itemD,    :org, :whA, 'LR-0342-D',  'Counted rack archived before post', 10, 'active', 'none', 'product'),
  (:itemK,    :org, :whA, 'LR-0342-K',  'Count then cleared',                10, 'active', 'none', 'product'),
  (:itemR,    :org, :whA, 'LR-0342-R',  'Receiving regression',              10, 'active', 'none', 'product'),
  (:itemW,    :org, :whA, 'LR-0342-W',  'Location in the wrong warehouse',   10, 'active', 'none', 'product'),
  (:itemX,    :org, :whA, 'LR-0342-X',  'Location in another org',           10, 'active', 'none', 'product'),
  (:itemDeep, :org, :whA, 'LR-0342-DP', 'Shortfall deeper than the rack',    15, 'active', 'none', 'product')
on conflict (id) do nothing;

-- The 0199 trigger seeds an Unplaced row per item; clear so every quantity
-- below is a literal this file controls.
delete from public.item_stock_levels
  where item_id in (:itemI, :itemB, :itemS, :itemM, :itemN, :itemZ, :itemD,
                    :itemK, :itemR, :itemW, :itemX, :itemDeep);

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :itemI,    :rackA,  10),
  (:org, :itemB,    :crateC, 20),
  (:org, :itemS,    :rackA,  10),
  (:org, :itemM,    :rackA,  10),
  (:org, :itemM,    :rackB,  20),
  (:org, :itemN,    :rackA,  10),
  (:org, :itemZ,    :rackA,  10),
  (:org, :itemD,    :rackDead, 10),
  (:org, :itemK,    :rackA,  10),
  (:org, :itemR,    :rackA,  10),
  (:org, :itemW,    :rackA,  10),
  (:org, :itemX,    :rackA,  10),
  (:org, :itemDeep, :rackA,   5)
on conflict (item_id, location_id) do nothing;

-- itemS also holds 5 in whA's Staging (total 15) — the bucket that must not
-- absorb the variance. itemDeep holds 10 in Staging (total 15).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :org, :itemS, l.id, 5 from public.locations l
 where l.warehouse_id = :whA and l.kind = 'staging' and l.deleted_at is null limit 1
on conflict (item_id, location_id) do update set quantity = 5;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :org, :itemDeep, l.id, 10 from public.locations l
 where l.warehouse_id = :whA and l.kind = 'staging' and l.deleted_at is null limit 1
on conflict (item_id, location_id) do update set quantity = 10;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccMain, :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccWh,   :org, :whA, 'in_progress', 'warehouse', :mgr, now()),
  (:ccOrg,  :org, :whA, 'in_progress', 'warehouse', :mgr, now())
on conflict (id) do nothing;

insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id) values
  (:lnI,    :ccMain, :itemI,    10, null, :whA),
  (:lnB,    :ccMain, :itemB,    20, null, :whA),
  (:lnS,    :ccMain, :itemS,    15, null, :whA),
  (:lnM,    :ccMain, :itemM,    30, null, :whA),
  (:lnN,    :ccMain, :itemN,    10, null, :whA),
  (:lnZ,    :ccMain, :itemZ,    10, null, :whA),
  (:lnD,    :ccMain, :itemD,    10, null, :whA),
  (:lnK,    :ccMain, :itemK,    10, null, :whA),
  (:lnDeep, :ccMain, :itemDeep, 15, null, :whA),
  (:lnW,    :ccWh,   :itemW,    10, null, :whA),
  (:lnX,    :ccOrg,  :itemX,    10, null, :whA)
on conflict (id) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. SHAPE
-- ═════════════════════════════════════════════════════════════════════════════
select has_column('public', 'cycle_count_lines', 'counted_location_id',
  '0342: cycle_count_lines.counted_location_id exists');

select ok(
  (select p.prosecdef from pg_proc p
    where p.oid = 'public.apply_cycle_count_location_delta(uuid,uuid,uuid,numeric)'::regprocedure),
  '0342: apply_cycle_count_location_delta is SECURITY DEFINER');
select ok(
  (select 'search_path=public' = any(p.proconfig) from pg_proc p
    where p.oid = 'public.apply_cycle_count_location_delta(uuid,uuid,uuid,numeric)'::regprocedure),
  '0342: apply_cycle_count_location_delta pins search_path=public');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.apply_cycle_count_location_delta(uuid,uuid,uuid,numeric)'::regprocedure
       and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  '0342: PUBLIC holds no EXECUTE on apply_cycle_count_location_delta');

-- TEST 15 — writer parity by construction. Every writer (web, mobile, barcode,
-- AI shelf scan, offline replay) reaches this table by setting
-- counted_quantity, so stamping in this trigger is what makes them identical.
select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.cycle_count_lines'::regclass
             and tgname = 'cycle_count_lines_rebase_expected'
             and not tgisinternal
             and (tgtype & 2)  = 2
             and (tgtype & 4)  = 4
             and (tgtype & 16) = 16),
  '0342: the stamping trigger is still BEFORE INSERT OR UPDATE (every writer passes through it)');

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. THE COUNTER RECORDS — as the authenticated manager, through RLS
-- ═════════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

update public.cycle_count_lines set counted_quantity = 15, counted_by = :mgr, counted_at = now() where id = :lnI;
update public.cycle_count_lines set counted_quantity = 24, counted_by = :mgr, counted_at = now() where id = :lnB;
update public.cycle_count_lines set counted_quantity = 17, counted_by = :mgr, counted_at = now() where id = :lnS;
update public.cycle_count_lines set counted_quantity = 35, counted_by = :mgr, counted_at = now() where id = :lnM;
update public.cycle_count_lines set counted_quantity =  7, counted_by = :mgr, counted_at = now() where id = :lnN;
update public.cycle_count_lines set counted_quantity = 10, counted_by = :mgr, counted_at = now() where id = :lnZ;
update public.cycle_count_lines set counted_quantity = 13, counted_by = :mgr, counted_at = now() where id = :lnD;
update public.cycle_count_lines set counted_quantity = 12, counted_by = :mgr, counted_at = now() where id = :lnK;
update public.cycle_count_lines set counted_quantity =  8, counted_by = :mgr, counted_at = now() where id = :lnDeep;

reset role;

-- STAMPED AT COUNT TIME, from the single placed location.
select is((select counted_location_id from public.cycle_count_lines where id = :lnI), :rackA::uuid,
  '0342: a one-rack item stamps that rack when the count is recorded');
select is((select counted_location_id from public.cycle_count_lines where id = :lnB), :crateC::uuid,
  '0342: a book in a crate stamps the CRATE (crates are placements too)');
select is((select counted_location_id from public.cycle_count_lines where id = :lnS), :rackA::uuid,
  '0342: Staging is excluded from the candidates, so rack+Staging is still unambiguous');

-- TEST 9 — MULTI-LOCATION AMBIGUITY: no guess.
select is((select counted_location_id from public.cycle_count_lines where id = :lnM), null::uuid,
  '0342: two racks holding the SKU stamps nothing — it never guesses');

-- clearCount forgets the location.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = null, counted_by = null, counted_at = null
 where id = :lnK;
reset role;
select is((select counted_location_id from public.cycle_count_lines where id = :lnK), null::uuid,
  '0342: clearing a count clears the stamped location (a stale rack cannot decide a later recount)');
select is((select expected_quantity from public.cycle_count_lines where id = :lnK), 10::numeric,
  '0342: clearing a count still restores the start snapshot (0339 preserved)');

-- Archive the counted rack AFTER the count, BEFORE the post.
update public.locations set deleted_at = now() where id = :rackDead;

-- TEST 10 — post-count movement must survive the post.
update public.inventory_items set quantity_on_hand = 8 where id = :itemI;   -- someone picked 2
update public.item_stock_levels set quantity = 8 where item_id = :itemI and location_id = :rackA;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. POST
-- ═════════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok($$ select public.post_cycle_count('03420000-0000-0000-0000-0000000000d1'::uuid) $$,
  '0342: posting the main count succeeds');
reset role;

-- ── TEST 1 — ITEM POSITIVE VARIANCE lands on the counted rack ────────────────
-- Counted 15 against a count-time base of 10 => +5, applied on top of the live
-- 8 that the post-count pick left. 8 + 5 = 13, all of it on Rack A.
select is((select quantity_on_hand from public.inventory_items where id = :itemI), 13::numeric,
  '0342/T1: on hand is the live quantity plus the variance (post-count pick preserved)');
select is((select quantity from public.item_stock_levels where item_id = :itemI and location_id = :rackA), 13::numeric,
  '0342/T1: the whole +5 landed on the counted rack');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemI and l.kind = 'staging'),
  0::numeric,
  '0342/T1: Staging did NOT absorb the surplus — this is the bug');

-- ── TEST 2 — BOOK POSITIVE VARIANCE lands in the crate ───────────────────────
select is((select quantity from public.item_stock_levels where item_id = :itemB and location_id = :crateC), 24::numeric,
  '0342/T2: a book''s +4 landed in its crate');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemB and l.kind = 'staging'),
  0::numeric,
  '0342/T2: books do not appear on the put-away worklist after a count');

-- ── TEST 3 — EXISTING STAGING IS NOT TOUCHED ─────────────────────────────────
-- 10 on Rack A + 5 already in Staging = 15. Counter reports a total of 17.
-- The +2 belongs on the rack; the 5 in Staging were already staged and stay.
select is((select quantity from public.item_stock_levels where item_id = :itemS and location_id = :rackA), 12::numeric,
  '0342/T3: the +2 went to the rack');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemS and l.kind = 'staging'),
  5::numeric,
  '0342/T3: the 5 units already in Staging are untouched');
select is((select quantity_on_hand from public.inventory_items where id = :itemS), 17::numeric,
  '0342/T3: on hand is 17');

-- ── TEST 4 + 9 — AMBIGUOUS: other racks unchanged, falls back to Staging ─────
select is((select quantity from public.item_stock_levels where item_id = :itemM and location_id = :rackA), 10::numeric,
  '0342/T4: rack A untouched when the target was ambiguous');
select is((select quantity from public.item_stock_levels where item_id = :itemM and location_id = :rackB), 20::numeric,
  '0342/T4: rack B untouched when the target was ambiguous');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemM and l.kind = 'staging'),
  5::numeric,
  '0342/T9: an ambiguous target falls back to the OLD behaviour rather than picking a rack');

-- ── TEST 12 — NEGATIVE VARIANCE comes off the counted rack ───────────────────
select is((select quantity from public.item_stock_levels where item_id = :itemN and location_id = :rackA), 7::numeric,
  '0342/T12: a shortfall is taken from the counted rack');
select is((select quantity_on_hand from public.inventory_items where id = :itemN), 7::numeric,
  '0342/T12: on hand follows');

-- A shortfall DEEPER than the counted rack holds: rack empties, remainder
-- drains Staging through the old path. Rack 5 + Staging 10 = 15, counted 8.
select is((select quantity from public.item_stock_levels where item_id = :itemDeep and location_id = :rackA), 0::numeric,
  '0342/T12: a deep shortfall empties the counted rack but never drives it negative');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemDeep and l.kind = 'staging'),
  8::numeric,
  '0342/T12: the remainder of a deep shortfall drains Staging (old path still reachable)');

-- ── TEST 11 — ZERO VARIANCE mutates nothing ──────────────────────────────────
select is((select quantity from public.item_stock_levels where item_id = :itemZ and location_id = :rackA), 10::numeric,
  '0342/T11: a zero-variance line leaves its levels alone');
select is((select count(*) from public.stock_movements where item_id = :itemZ), 0::bigint,
  '0342/T11: a zero-variance line writes no ledger row');

-- ── ARCHIVED COUNTED LOCATION — soft fallback, not a failed post ─────────────
select is((select quantity_on_hand from public.inventory_items where id = :itemD), 13::numeric,
  '0342: a count whose rack was archived before posting still posts');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemD and l.kind = 'staging'),
  3::numeric,
  '0342: an archived target falls back to Staging rather than failing the whole count');

-- ── LEDGER — chain and location metadata ─────────────────────────────────────
select is((select quantity_change from public.stock_movements where item_id = :itemI), 5::numeric,
  '0342: the ledger records the variance, not the difference from live');
select is((select previous_quantity from public.stock_movements where item_id = :itemI), 8::numeric,
  '0342: previous_quantity chains from the LIVE quantity (0339 preserved)');
select is((select new_quantity from public.stock_movements where item_id = :itemI), 13::numeric,
  '0342: previous + change = new');
select is((select movement_type from public.stock_movements where item_id = :itemI), 'adjust',
  '0342: it is an ADJUST, never a transfer — the stock never came from anywhere');
select is((select to_location_id from public.stock_movements where item_id = :itemI), :rackA::uuid,
  '0342: the counted rack travels on the ledger row so history reads "+5, Rack A"');
select is((select from_location_id from public.stock_movements where item_id = :itemI), null::uuid,
  '0342: a positive adjust sets only the destination side (no fake transfer)');
select is((select from_location_id from public.stock_movements where item_id = :itemN), :rackA::uuid,
  '0342: a negative adjust records the rack it came off');
select is((select to_location_id from public.stock_movements where item_id = :itemN), null::uuid,
  '0342: a negative adjust sets only the source side');
select ok(
  (select notes like '%[drift]%' from public.stock_movements where item_id = :itemI),
  '0342: the drift breadcrumb still explains the post-count pick (0339 preserved)');

-- ── TEST 13 — Σ item_stock_levels = quantity_on_hand, for every item ─────────
select is(
  (select count(*) from public.inventory_items ii
     where ii.organization_id = :org
       and ii.quantity_on_hand is distinct from (
         select coalesce(sum(s.quantity), 0) from public.item_stock_levels s where s.item_id = ii.id)),
  0::bigint,
  '0342/T13: Σ item_stock_levels = quantity_on_hand for every item in the org');

-- ── TEST 5 — nothing new appears as unplaced work ────────────────────────────
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id in (:itemI, :itemB, :itemS) and l.kind in ('staging', 'unplaced')),
  5::numeric,
  '0342/T5: the only staged units are the 5 that were already staged before the count');

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. SCOPE REFUSALS — hard, because the trigger cannot produce these
-- ═════════════════════════════════════════════════════════════════════════════
-- These two must actually be COUNTED first: post_cycle_count only walks lines
-- with a counted_quantity, so an uncounted line is skipped and no refusal can
-- fire. (The first draft of this file missed that and the refusals silently
-- never ran.) Counting stamps rack A; the overwrite below then plants the bad
-- target — and it survives, because the stamping trigger is UPDATE OF
-- counted_quantity and does not fire for a location-only write.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 13, counted_by = :mgr, counted_at = now() where id = :lnW;
update public.cycle_count_lines set counted_quantity = 13, counted_by = :mgr, counted_at = now() where id = :lnX;
reset role;

update public.cycle_count_lines set counted_location_id = :rackWhB where id = :lnW;
update public.cycle_count_lines set counted_location_id = :rackU   where id = :lnX;

select is((select counted_location_id from public.cycle_count_lines where id = :lnW), :rackWhB::uuid,
  '0342: the cross-warehouse target really is planted (a location-only write does not re-stamp)');

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- TEST 7 — cross-WAREHOUSE destination.
select throws_ok(
  $$ select public.post_cycle_count('03420000-0000-0000-0000-0000000000d2'::uuid) $$,
  '22023', 'cycle_count_location_out_of_scope',
  '0342/T7: a counted location in another warehouse is refused');

-- TEST 8 — cross-ORG destination.
select throws_ok(
  $$ select public.post_cycle_count('03420000-0000-0000-0000-0000000000d3'::uuid) $$,
  '42501', 'cycle_count_location_out_of_org',
  '0342/T8: a counted location in another organization is refused');

reset role;

-- No partial mutation from either refusal.
select is((select quantity_on_hand from public.inventory_items where id = :itemW), 10::numeric,
  '0342/T7: the refused warehouse-mismatch post mutated nothing');
select is((select quantity_on_hand from public.inventory_items where id = :itemX), 10::numeric,
  '0342/T8: the refused cross-org post mutated nothing');
select is((select status from public.cycle_counts where id = :ccWh), 'in_progress',
  '0342/T7: the refused count stays open');

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. TEST 6 — RECEIVING REGRESSION: apply_level_delta still stages increments
-- ═════════════════════════════════════════════════════════════════════════════
-- The whole point of routing around apply_level_delta instead of changing it.
-- A receipt genuinely enters the building and genuinely awaits put-away.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ select public.apply_level_delta('03420000-0000-0000-0000-0000000000c9'::uuid, 7, 'placed') $$,
  '0342/T6: apply_level_delta still runs for a receipt-shaped increment');
reset role;

select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemR and l.kind = 'staging'),
  7::numeric,
  '0342/T6: a positive apply_level_delta STILL lands in Staging — receiving is unchanged');
select is((select quantity from public.item_stock_levels where item_id = :itemR and location_id = :rackA), 10::numeric,
  '0342/T6: it did not touch the rack');

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. THE HELPER, DIRECTLY
-- ═════════════════════════════════════════════════════════════════════════════
select is(
  public.apply_cycle_count_location_delta(:itemI, :rackA, :org, 0),
  0::numeric,
  '0342: a zero delta is a no-op');
select is(
  public.apply_cycle_count_location_delta(:itemI, null, :org, 5),
  5::numeric,
  '0342: a null location returns the delta unapplied for the caller to route');
select is(
  public.apply_cycle_count_location_delta(:itemI, :rackA, :org, -1000),
  -987::numeric,
  '0342: a shortfall bigger than the location holds returns the unabsorbed remainder');
select is(
  (select quantity from public.item_stock_levels where item_id = :itemI and location_id = :rackA),
  0::numeric,
  '0342: ...and empties the location rather than driving it negative');

select * from finish();
rollback;
