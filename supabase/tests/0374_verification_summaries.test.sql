-- supabase/tests/0374_verification_summaries.test.sql
-- pgTAP proof for migration 0374 (F1-3: verification summaries).
--
-- G. Structure and grants: item_verification_summaries is SECURITY DEFINER
--    with a pinned search_path, EXECUTE to authenticated only, gated in its
--    body, never raises 40001/40P01; location_holdings_visible is SECURITY
--    INVOKER, authenticated only.
-- S. item_verification_summaries:
--    * a never-counted item gets a row with every count field null (and
--      movements "unknown", not 0);
--    * the latest physical count is _latest_count_lines' (latest OBSERVATION,
--      not latest post), with its fields, counted location kind and archived
--      state, AI assistance, and a pre-0339 line's null expected_at_start;
--    * cancelled counts, uncounted lines and in-progress lines are not a
--      physical count; the newest in-progress count is the open count;
--    * movements_since counts only via_ledger rows after the baseline and
--      excludes the count's own movement (mutation: include it -> a phantom
--      +1 on a count that corrected the book); a row with no reference is
--      counted (mutation: '=' instead of IS DISTINCT FROM drops it); the
--      window starts at the baseline, so a movement between an offline
--      capture and its post counts (mutation: start at completed_at);
--    * outside_ledger_since counts the rows a signed-in user inserted
--      directly (via_ledger false), and only in the window;
--    * item facts: rental, kit, archived, deleted, on hand;
--    * a caller scoped to one warehouse gets no row for another warehouse's
--      item; another org's item, a non-member, a signed-out caller get none;
--      a member of two orgs asking about one gets no row for the other's
--      item (mutation: drop the org pin -> a false "never counted");
--    * a member who can read the item but not its movements (no
--      activity_logs:read, and the item's warehouse outside my_warehouse_ids)
--      still gets the true count (mutation: SECURITY INVOKER);
--    * more than 500 ids is 22023 too_many_items; 500 is fine; duplicates
--      and nulls in the array give one row per item.
-- L. location_holdings_visible equals what item_stock_levels RLS shows, for
--    every persona and every location holding stock (mutation: drop the
--    my_warehouse_ids branch or the no-warehouse branch), and is false for a
--    foreign or unknown location. (Its manager and is_org_member terms restate
--    the policy word for word but cannot change an answer on their own: a
--    manager's my_warehouse_ids() is every warehouse of the org, and a
--    non-member cannot read the location at all.)
--
-- TIME. now() is the transaction start for the whole file. Counts, lines and
-- movements are planted at now() minus hours or days; the rebase trigger is
-- off while lines are planted (it would overwrite expected_quantity and
-- baseline_at).
--
-- Roles: fixtures as the test superuser with no jwt subject (movements it
-- writes are via_ledger true, as a SECURITY DEFINER or service write is);
-- the two direct movements are inserted as `authenticated` (via_ledger false,
-- stamped by the 0369 trigger). RPCs run as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace 03740000.

begin;

select plan(41);

\set orgA   '\'03740000-0000-0000-0000-00000000000a\''
\set orgB   '\'03740000-0000-0000-0000-00000000000b\''
\set mgr    '\'03740000-0000-0000-0000-0000000000a1\''
\set stf    '\'03740000-0000-0000-0000-0000000000a2\''
\set vwr    '\'03740000-0000-0000-0000-0000000000a3\''
\set stfX   '\'03740000-0000-0000-0000-0000000000a4\''
\set stf2   '\'03740000-0000-0000-0000-0000000000a5\''
\set mgrB   '\'03740000-0000-0000-0000-0000000000b1\''
\set mgrAB  '\'03740000-0000-0000-0000-0000000000b2\''
\set nobody '\'03740000-0000-0000-0000-0000000000c1\''
\set whA    '\'03740000-0000-0000-0000-0000000000d1\''
\set whA2   '\'03740000-0000-0000-0000-0000000000d2\''
\set whB    '\'03740000-0000-0000-0000-0000000000d3\''
\set rA     '\'03740000-0000-0000-0000-0000000000e1\''
\set rA2    '\'03740000-0000-0000-0000-0000000000e2\''
\set site   '\'03740000-0000-0000-0000-0000000000e3\''
\set rOld   '\'03740000-0000-0000-0000-0000000000e4\''
\set rB     '\'03740000-0000-0000-0000-0000000000e5\''
-- org A items (warehouse A unless noted)
\set iNever  '\'03740000-0000-0000-0000-000000000f01\''
\set iMatch  '\'03740000-0000-0000-0000-000000000f02\''
\set iCorr   '\'03740000-0000-0000-0000-000000000f03\''
\set iLegacy '\'03740000-0000-0000-0000-000000000f04\''
\set iSkip   '\'03740000-0000-0000-0000-000000000f05\''
\set iOrder  '\'03740000-0000-0000-0000-000000000f06\''
\set iAI     '\'03740000-0000-0000-0000-000000000f07\''
\set iW2     '\'03740000-0000-0000-0000-000000000f08\''
\set iRent   '\'03740000-0000-0000-0000-000000000f09\''
\set iKit    '\'03740000-0000-0000-0000-000000000f0a\''
\set iArch   '\'03740000-0000-0000-0000-000000000f0b\''
\set iDel    '\'03740000-0000-0000-0000-000000000f0c\''
\set iSite   '\'03740000-0000-0000-0000-000000000f0d\''
-- org B item
\set itemB   '\'03740000-0000-0000-0000-000000000f20\''
-- counts
\set ccMatch  '\'03740000-0000-0000-0000-000000000201\''
\set ccCorr   '\'03740000-0000-0000-0000-000000000202\''
\set ccLegacy '\'03740000-0000-0000-0000-000000000203\''
\set ccCan    '\'03740000-0000-0000-0000-000000000204\''
\set ccBlank  '\'03740000-0000-0000-0000-000000000205\''
\set ccOpen1  '\'03740000-0000-0000-0000-000000000206\''
\set ccOpen2  '\'03740000-0000-0000-0000-000000000207\''
\set ccO1     '\'03740000-0000-0000-0000-000000000208\''
\set ccO2     '\'03740000-0000-0000-0000-000000000209\''
\set ccAI     '\'03740000-0000-0000-0000-00000000020a\''
\set ccOther  '\'03740000-0000-0000-0000-00000000020b\''
\set ccW2     '\'03740000-0000-0000-0000-00000000020c\''
\set ccB      '\'03740000-0000-0000-0000-00000000020d\''
\set scanAI   '\'03740000-0000-0000-0000-000000000301\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,    '0374-mgr@test.local',    '{}'::jsonb),
  (:stf,    '0374-stf@test.local',    '{}'::jsonb),
  (:vwr,    '0374-vwr@test.local',    '{}'::jsonb),
  (:stfX,   '0374-stfx@test.local',   '{}'::jsonb),
  (:stf2,   '0374-stf2@test.local',   '{}'::jsonb),
  (:mgrB,   '0374-mgrb@test.local',   '{}'::jsonb),
  (:mgrAB,  '0374-mgrab@test.local',  '{}'::jsonb),
  (:nobody, '0374-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0374 Verify A', '0374-verify-a'),
  (:orgB, '0374 Verify B', '0374-verify-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr,  'manager', now()),
  (:orgA, :stf,  'staff',   now()),
  (:orgA, :vwr,  'viewer',  now()),
  (:orgA, :stfX, 'staff',   now()),
  (:orgA, :stf2, 'staff',   now()),
  (:orgB, :mgrB, 'manager', now()),
  (:orgA, :mgrAB, 'manager', now()),
  (:orgB, :mgrAB, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0374 Main',  'WH-0374A',  'active'),
  (:whA2, :orgA, '0374 Annex', 'WH-0374A2', 'active'),
  (:whB,  :orgB, '0374 Other', 'WH-0374B',  'active');
-- stf and vwr work in warehouse A, stf2 in the annex. stfX's assignment row
-- carries the WRONG organization (org B) for a warehouse of org A: the item
-- read scope (rls_inv_read_*) joins through the warehouse's org and so lets
-- stfX read warehouse A's items, while my_warehouse_ids() requires the row's
-- own organization to match and so gives stfX no warehouse at all. stfX can
-- read an item in warehouse A and none of its movements (no
-- activity_logs:read): the divergence 0371 names, and the one persona for
-- whom a SECURITY INVOKER summary would under-count.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,  :whA,  true),
  (:orgA, :vwr,  :whA,  true),
  (:orgB, :stfX, :whA,  true),
  (:orgA, :stf2, :whA2, true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rA,   :orgA, :whA,  'A-12',     'shelf', 'rack'),
  (:rA2,  :orgA, :whA2, 'N-3',      'shelf', 'rack'),
  (:site, :orgA, null,  'Job site', 'jobsite', null),
  (:rOld, :orgA, :whA,  'Z-9',      'shelf', 'rack'),
  (:rB,   :orgB, :whB,  'B-1',      'shelf', 'rack');
select id as "stA" from public.locations where warehouse_id = :whA and kind = 'staging' and deleted_at is null \gset

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, is_rental, is_bundle, deleted_at) values
  (:iNever,  :orgA, :whA,  'X0374-NEVER',  'Never counted',   4,  'active',   false, false, null),
  (:iMatch,  :orgA, :whA,  'X0374-MATCH',  'Matched',         10, 'active',   false, false, null),
  (:iCorr,   :orgA, :whA,  'X0374-CORR',   'Corrected',       10, 'active',   false, false, null),
  (:iLegacy, :orgA, :whA,  'X0374-LEGACY', 'Legacy line',     6,  'active',   false, false, null),
  (:iSkip,   :orgA, :whA,  'X0374-SKIP',   'No real count',   3,  'active',   false, false, null),
  (:iOrder,  :orgA, :whA,  'X0374-ORDER',  'Offline order',   5,  'active',   false, false, null),
  (:iAI,     :orgA, :whA,  'X0374-AI',     'AI counted',      3,  'active',   false, false, null),
  (:iW2,     :orgA, :whA2, 'X0374-W2',     'Annex item',      2,  'active',   false, false, null),
  (:iRent,   :orgA, :whA,  'X0374-RENT',   'Rental unit',     1,  'active',   true,  false, null),
  (:iKit,    :orgA, :whA,  'X0374-KIT',    'Kit phantom',     0,  'active',   false, true,  null),
  (:iArch,   :orgA, :whA,  'X0374-ARCH',   'Archived item',   0,  'archived', false, false, null),
  (:iDel,    :orgA, :whA,  'X0374-DEL',    'Deleted item',    0,  'active',   false, false, now()),
  (:iSite,   :orgA, :whA,  'X0374-SITE',   'At the job site', 0,  'active',   false, false, null),
  (:itemB,   :orgB, :whB,  'X0374-B',      'Other org item',  1,  'active',   false, false, null);

-- Holdings for L: one per location kind and warehouse (as the owner; the
-- positive_since trigger stamps them, the ledger guard lets the owner write).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :iMatch, :rA,   10),
  (:orgA, :iW2,    :rA2,  2),
  (:orgA, :iSite,  :site, 1),
  (:orgB, :itemB,  :rB,   1)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

-- Counts planted as the owner. The rebase trigger is off for these
-- statements only, so expected_quantity and baseline_at are what is written.
alter table public.cycle_count_lines disable trigger cycle_count_lines_rebase_expected;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at, completed_at, completed_by, canceled_at, canceled_by) values
  (:ccMatch,  :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '3 days',  now() - interval '2 days' + interval '1 hour', :mgr, null, null),
  (:ccCorr,   :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '2 days',  now() - interval '20 hours', :mgr, null, null),
  (:ccLegacy, :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '60 days', now() - interval '59 days',  :mgr, null, null),
  (:ccCan,    :orgA, :whA,  'canceled',    'selection', :mgr, now() - interval '5 hours', null, null, now() - interval '4 hours', :mgr),
  (:ccBlank,  :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '6 hours', now() - interval '5 hours', :mgr, null, null),
  (:ccOpen1,  :orgA, :whA,  'in_progress', 'selection', :mgr, now() - interval '3 hours', null, null, null, null),
  (:ccOpen2,  :orgA, :whA,  'in_progress', 'selection', :mgr, now() - interval '1 hour',  null, null, null, null),
  (:ccO1,     :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '3 days',  now() - interval '1 day',    :mgr, null, null),
  (:ccO2,     :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '5 days',  now() - interval '1 hour',   :mgr, null, null),
  (:ccAI,     :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '7 days',  now() - interval '5 days',   :mgr, null, null),
  (:ccOther,  :orgA, :whA,  'completed',   'selection', :mgr, now() - interval '1 day',   now() - interval '12 hours', :mgr, null, null),
  (:ccW2,     :orgA, :whA2, 'completed',   'selection', :mgr, now() - interval '2 days',  now() - interval '1 day',    :mgr, null, null),
  (:ccB,      :orgB, :whB,  'completed',   'selection', :mgrB, now() - interval '2 days', now() - interval '1 day',    :mgrB, null, null);

insert into public.cycle_count_ai_scans (id, organization_id, cycle_count_id, created_by, photo_storage_path, model_version)
values (:scanAI, :orgA, :ccAI, :mgr, '03740000/scan.jpg', 'test');

insert into public.cycle_count_lines
  (cycle_count_id, item_id, warehouse_id, expected_quantity, expected_at_start, counted_quantity,
   counted_by, counted_at, captured_at, baseline_at, counted_location_id, ai_scan_id) values
  -- iMatch: matched the book at rack A-12, observed 2 days ago.
  (:ccMatch,  :iMatch,  :whA,  10, 10, 10, :stf, now() - interval '2 days', null, now() - interval '2 days', :rA, null),
  -- iCorr: the book said 8, the shelf held 10; the post wrote +2 (its own
  -- movement, below) 20 hours ago, after the 1-day-old baseline.
  (:ccCorr,   :iCorr,   :whA,  8,  8,  10, :stf, now() - interval '1 day', null, now() - interval '1 day', null, null),
  -- iLegacy: a line from before 0339 (no expected_at_start, no baseline).
  (:ccLegacy, :iLegacy, :whA,  6,  null, 6, :mgr, now() - interval '59 days', null, null, null, null),
  -- iSkip: a cancelled count (counted), a posted count that left it blank,
  -- and two open counts (the newer is the open count).
  (:ccCan,    :iSkip,   :whA,  3,  3,  9,    :stf, now() - interval '4 hours', null, now() - interval '4 hours', null, null),
  (:ccBlank,  :iSkip,   :whA,  3,  null, null, null, null, null, null, null, null),
  (:ccOpen1,  :iSkip,   :whA,  3,  3,  7,    :stf, now() - interval '2 hours', null, now() - interval '2 hours', null, null),
  (:ccOpen2,  :iSkip,   :whA,  3,  null, null, null, null, null, null, null, null),
  -- iOrder: ccO1 observed 2 days ago (posted a day ago); ccO2 an offline
  -- capture from 4 days ago, synced and posted an hour ago. The latest
  -- OBSERVATION (ccO1) is the physical count, not the latest post.
  (:ccO1,     :iOrder,  :whA,  5,  5,  5, :stf, now() - interval '2 days', null, now() - interval '2 days', null, null),
  (:ccO2,     :iOrder,  :whA,  6,  6,  7, :stf, now() - interval '2 hours', now() - interval '4 days', now() - interval '4 days', null, null),
  -- iAI: offline and AI-assisted, at rack Z-9 (archived below).
  (:ccAI,     :iAI,     :whA,  2,  2,  3, :stf, now() - interval '5 days', now() - interval '6 days', now() - interval '6 days', :rOld, :scanAI),
  -- the counts named by movements below
  (:ccOther,  :iNever,  :whA,  4,  4,  null, null, null, null, null, null, null),
  (:ccW2,     :iW2,     :whA2, 2,  2,  2, :stf2, now() - interval '1 day', null, now() - interval '1 day', null, null),
  (:ccB,      :itemB,   :whB,  1,  1,  1, :mgrB, now() - interval '1 day', null, now() - interval '1 day', null, null),
  -- rental and archived items were counted once (their rows still say so).
  (:ccMatch,  :iRent,   :whA,  1,  1,  1, :stf, now() - interval '2 days', null, now() - interval '2 days', null, null),
  (:ccMatch,  :iArch,   :whA,  2,  2,  0, :stf, now() - interval '2 days', null, now() - interval '2 days', null, null);

alter table public.cycle_count_lines enable trigger cycle_count_lines_rebase_expected;

-- Rack Z-9 was archived after the AI count.
update public.locations set deleted_at = now() - interval '1 day' where id = :rOld;

-- Movements written as the owner: via_ledger true (the 0369 trigger stamps
-- every non-API write true, as it does a SECURITY DEFINER ledger body).
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
   moved_quantity, from_location_id, to_location_id, reference_type, reference_id, created_at) values
  -- iMatch (baseline 2 days ago):
  --   before the baseline: not "since"
  (:orgA, :iMatch, 'adjust',     1, 9, 10,  null, null, null, null,            null,     now() - interval '3 days'),
  --   a transfer with no reference: since
  (:orgA, :iMatch, 'transfer',   0, 10, 10, 1,    :rA,  :'stA', null,            null,     now() - interval '1 day'),
  --   ANOTHER count's correction: since
  (:orgA, :iMatch, 'adjust',     1, 10, 11, null, null, null, 'cycle_count',   :ccOther, now() - interval '12 hours'),
  --   a receipt: since
  (:orgA, :iMatch, 'receive_po', 2, 11, 13, null, null, null, 'purchase_order', gen_random_uuid(), now() - interval '6 hours'),
  --   ITS OWN count's correction (a matched count writes none; this is the
  --   shape a post would stamp): never "since" its own count
  (:orgA, :iMatch, 'adjust',     0, 13, 13, null, null, null, 'cycle_count',   :ccMatch, now() - interval '2 days' + interval '1 hour'),
  -- iCorr: only its own +2, stamped at post time after the baseline.
  (:orgA, :iCorr,  'adjust',     2, 8, 10,  null, null, null, 'cycle_count',   :ccCorr,  now() - interval '20 hours'),
  -- iLegacy (no baseline; its window starts at counted_at, 59 days ago).
  (:orgA, :iLegacy, 'adjust',    1, 5, 6,   null, null, null, null,            null,     now() - interval '10 days'),
  -- iAI (captured offline 6 days ago, synced and posted 5 days ago): a
  -- movement between the capture and the post is "since" the count, whose
  -- book was taken at the capture moment (0369).
  (:orgA, :iAI,    'adjust',     1, 2, 3,   null, null, null, null,            null,     now() - interval '5 days' - interval '12 hours'),
  -- iW2 and itemB each moved once since their counts.
  (:orgA, :iW2,    'adjust',     1, 1, 2,   null, null, null, null,            null,     now() - interval '2 hours'),
  (:orgB, :itemB,  'adjust',     1, 0, 1,   null, null, null, null,            null,     now() - interval '2 hours');

-- Two rows inserted DIRECTLY by a signed-in staff member (via_ledger false):
-- one after iMatch's baseline, one before it.
set local "request.jwt.claim.sub" to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id, created_at) values
  (:orgA, :iMatch, 'adjust', 5, 13, 18, :stf, now() - interval '1 hour'),
  (:orgA, :iMatch, 'adjust', 5, 13, 18, :stf, now() - interval '4 days');
reset role;
set local "request.jwt.claim.sub" to '';

-- ── Helpers ──────────────────────────────────────────────────────────────
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
  return v_state || ':' || coalesce(v_hint, '') || ':' || v_msg;
end $$;

-- One summary row as a persona, captured into a temp table the persona can
-- write (the assertions then read it as the owner).
create temp table s (who text not null, r jsonb not null);
grant all on s to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items where id::text like '03740000-%') <> 14
     or (select count(*) from public.cycle_count_lines l
          where l.cycle_count_id::text like '03740000-%') <> 15
     or (select count(*) from public.stock_movements m
          where m.item_id::text like '03740000-%' and not m.via_ledger) <> 2
     or (select count(*) from public.stock_movements m
          where m.item_id::text like '03740000-%' and m.via_ledger) <> 10
  then raise exception '0374 test fixtures incomplete'; end if;
end $$;

-- ═══ G. Structure and grants ══════════════════════════════════════════════
select ok(
  (select p.prosecdef and 'search_path=public' = any (p.proconfig)
     from pg_proc p where p.oid = 'public.item_verification_summaries(uuid, uuid[])'::regprocedure)
  and has_function_privilege('authenticated', 'public.item_verification_summaries(uuid, uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.item_verification_summaries(uuid, uuid[])', 'EXECUTE')
  and not exists (select 1 from pg_proc p, unnest(p.proacl) a
                   where p.oid = 'public.item_verification_summaries(uuid, uuid[])'::regprocedure
                     and a::text like '=%'),
  'G1: item_verification_summaries is SECURITY DEFINER, search_path pinned, EXECUTE to authenticated and not anon or PUBLIC (catalog)');
select ok(
  (select p.prosrc ~ 'auth\.uid\(\)' and p.prosrc ~ 'is_org_member\(p_org\)'
          and p.prosrc ~ 'caller_can_read_item\(i\.id\)' and p.prosrc ~ 'i\.organization_id = p_org'
          and p.prosrc !~ '40001|40P01'
     from pg_proc p where p.oid = 'public.item_verification_summaries(uuid, uuid[])'::regprocedure),
  'G2: its gates are in its own body (signed in, member, readable item in the org) and it never raises 40001/40P01');
select ok(
  (select not p.prosecdef and 'search_path=public' = any (p.proconfig)
     from pg_proc p where p.oid = 'public.location_holdings_visible(uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.location_holdings_visible(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.location_holdings_visible(uuid)', 'EXECUTE'),
  'G3: location_holdings_visible is SECURITY INVOKER, search_path pinned, EXECUTE to authenticated and not anon (catalog)');

-- ═══ S. item_verification_summaries ═══════════════════════════════════════
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
insert into s
select 'mgr', to_jsonb(v)
  from public.item_verification_summaries(
         :orgA,
         array[:iNever, :iMatch, :iCorr, :iLegacy, :iSkip, :iOrder, :iAI, :iW2,
               :iRent, :iKit, :iArch, :iDel, :itemB]::uuid[]) v;
reset role;

select is(
  (select array_agg((r->>'item_id')::uuid order by r->>'item_id') from s where who = 'mgr'),
  array[:iNever, :iMatch, :iCorr, :iLegacy, :iSkip, :iOrder, :iAI, :iW2, :iRent, :iKit, :iArch, :iDel]::uuid[],
  'S1: one row per readable item of the org, the never-counted ones included; another org''s item gets none');

select is(
  (select row(r->'cycle_count_id', r->'count_number', r->'completed_at', r->'counted_by', r->'counted_quantity',
              r->'expected_quantity', r->'counted_location_id', r->'ai_assisted',
              r->'movements_since', r->'outside_ledger_since', r->'open_count_id')::text
     from s where who = 'mgr' and (r->>'item_id')::uuid = :iNever),
  row('null'::jsonb, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb,
      'null'::jsonb, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb, 'null'::jsonb)::text,
  'S2: a never-counted item (only in a count that left it blank) has every count field null; movements since are unknown (null), never 0');

select is(
  (select row((r->>'cycle_count_id')::uuid,
              (r->>'count_number')::bigint = (select c.count_number from public.cycle_counts c where c.id = :ccMatch),
              (r->>'completed_at')::timestamptz = now() - interval '2 days' + interval '1 hour',
              (r->>'completed_by')::uuid, (r->>'counted_by')::uuid,
              (r->>'baseline_at')::timestamptz = now() - interval '2 days',
              r->>'captured_at',
              (r->>'expected_quantity')::numeric, (r->>'expected_at_start')::numeric, (r->>'counted_quantity')::numeric,
              (r->>'counted_location_id')::uuid, r->>'counted_location_name', r->>'counted_location_kind',
              (r->>'counted_location_archived')::boolean, (r->>'ai_assisted')::boolean,
              r->>'scope', (r->>'quantity_on_hand')::numeric, (r->>'item_countable')::boolean)::text
     from s where who = 'mgr' and (r->>'item_id')::uuid = :iMatch),
  row(:ccMatch::uuid, true, true, :mgr::uuid, :stf::uuid, true, null::text,
      10.0000::numeric, 10.0000::numeric, 10.0000::numeric, :rA::uuid, 'A-12', 'rack', false, false,
      'selection', 10.0000::numeric, true)::text,
  'S3: the latest count''s fields: count and number, posted when and by whom, counted by whom, baseline, book, counted, counted location with kind, not archived, not AI; the item''s on hand and countability');

select is(
  (select (r->>'movements_since')::int from s where who = 'mgr' and (r->>'item_id')::uuid = :iMatch),
  3,
  'S4: movements since = ledger rows after the baseline (a transfer with no reference, another count''s correction, a receipt); not the one before it, not its own count''s movement, not the direct insert');

select is(
  (select (r->>'outside_ledger_since')::int from s where who = 'mgr' and (r->>'item_id')::uuid = :iMatch),
  1,
  'S5: outside the ledger since = the directly inserted row after the baseline (not the one before it)');

-- Mutation: include the count's own movement -> iCorr reads "1 movement
-- since" the moment its correction was posted.
select is(
  (select row((r->>'movements_since')::int, (r->>'expected_quantity')::numeric,
              (r->>'counted_quantity')::numeric)::text
     from s where who = 'mgr' and (r->>'item_id')::uuid = :iCorr),
  row(0, 8.0000::numeric, 10.0000::numeric)::text,
  'S6: a count that corrected the book (8 -> 10) reads 0 movements since: its own correction, stamped after the baseline, is excluded');

select is(
  (select row(r->>'expected_at_start', r->>'baseline_at', (r->>'counted_quantity')::numeric,
              (r->>'movements_since')::int)::text
     from s where who = 'mgr' and (r->>'item_id')::uuid = :iLegacy),
  row(null::text, null::text, 6.0000::numeric, 1)::text,
  'S7: a line from before 0339 has no expected_at_start and no baseline; its window starts at counted_at');

select is(
  (select row(r->>'cycle_count_id', (r->>'open_count_id')::uuid,
              (r->>'open_count_number')::bigint = (select c.count_number from public.cycle_counts c where c.id = :ccOpen2))::text
     from s where who = 'mgr' and (r->>'item_id')::uuid = :iSkip),
  row(null::text, :ccOpen2::uuid, true)::text,
  'S8: a cancelled count, a posted count that left the line blank and an open count''s counted line are not a physical count; the newest open count is the open count');

select is(
  (select (r->>'cycle_count_id')::uuid from s where who = 'mgr' and (r->>'item_id')::uuid = :iOrder),
  :ccO1::uuid,
  'S9: the physical count is the latest OBSERVATION (_latest_count_lines), not the latest post of an older offline capture');

select is(
  (select row((r->>'ai_assisted')::boolean, (r->>'captured_at')::timestamptz = now() - interval '6 days',
              (r->>'counted_location_id')::uuid, r->>'counted_location_name',
              (r->>'counted_location_archived')::boolean, (r->>'movements_since')::int)::text
     from s where who = 'mgr' and (r->>'item_id')::uuid = :iAI),
  row(true, true, :rOld::uuid, 'Z-9', true, 1)::text,
  'S10: an offline, AI-assisted count at a rack archived since: capture time, AI flag, the archived flag, and a movement between the capture and the post counts as since (the window starts at the baseline, not the post)');

select is(
  (select string_agg(i.sku || '=' || (s.r->>'item_countable') || '/' || (s.r->>'item_is_rental') || '/'
                     || (s.r->>'item_is_bundle') || '/' || (s.r->>'item_status') || '/' || (s.r->>'item_deleted'),
                     ',' order by i.sku)
     from s join public.inventory_items i on i.id = (s.r->>'item_id')::uuid
    where s.who = 'mgr' and i.id in (:iRent, :iKit, :iArch, :iDel)),
  'X0374-ARCH=false/false/false/archived/false,X0374-DEL=false/false/false/active/true,X0374-KIT=false/false/true/active/false,X0374-RENT=false/true/false/active/false',
  'S11: rental, kit, archived and deleted items are not countable, and say why');

select is(
  (select (r->>'cycle_count_id')::uuid from s where who = 'mgr' and (r->>'item_id')::uuid = :iRent),
  :ccMatch::uuid,
  'S12: an item that can no longer be counted still shows the count it had');

-- A caller scoped to warehouse A: no row for the annex item.
set local "request.jwt.claim.sub" to :stf;
set local role to 'authenticated';
insert into s
select 'stf', to_jsonb(v)
  from public.item_verification_summaries(:orgA, array[:iMatch, :iW2]::uuid[]) v;
reset role;
select is(
  (select array_agg((r->>'item_id')::uuid) from s where who = 'stf'),
  array[:iMatch]::uuid[],
  'S13: staff scoped to warehouse A get no row for warehouse B''s item');

set local "request.jwt.claim.sub" to :stf2;
set local role to 'authenticated';
insert into s
select 'stf2', to_jsonb(v)
  from public.item_verification_summaries(:orgA, array[:iMatch, :iW2]::uuid[]) v;
reset role;
select is(
  (select array_agg(row((r->>'item_id')::uuid, (r->>'movements_since')::int)::text) from s where who = 'stf2'),
  array[row(:iW2::uuid, 1)::text],
  'S14: and the annex''s staff get only the annex item, with its count');

-- The viewer (no activity_logs:read, warehouse A assigned) sees the same
-- numbers as the manager.
set local "request.jwt.claim.sub" to :vwr;
set local role to 'authenticated';
insert into s
select 'vwr', to_jsonb(v) from public.item_verification_summaries(:orgA, array[:iMatch]::uuid[]) v;
reset role;
select is(
  (select row((r->>'movements_since')::int, (r->>'outside_ledger_since')::int)::text from s where who = 'vwr'),
  row(3, 1)::text,
  'S15: a viewer gets the same counts as the manager');

-- stfX reads iMatch (item scope) but none of its movements (movement scope).
set local "request.jwt.claim.sub" to :stfX;
set local role to 'authenticated';
select is(
  (select count(*)::int from public.stock_movements m where m.item_id = :iMatch),
  0,
  'S16 (control): stfX can read none of iMatch''s movements under the stock_movements SELECT policy');
select is(
  (select count(*)::int from public.inventory_items i where i.id = :iMatch),
  1,
  'S17 (control): yet stfX can read the item itself');
insert into s
select 'stfX', to_jsonb(v) from public.item_verification_summaries(:orgA, array[:iMatch]::uuid[]) v;
reset role;
-- Mutation: SECURITY INVOKER -> stfX gets 0 (or, with _latest_count_lines
-- still service_role only, no answer at all).
select is(
  (select row((r->>'movements_since')::int, (r->>'outside_ledger_since')::int,
              (r->>'cycle_count_id')::uuid)::text from s where who = 'stfX'),
  row(3, 1, :ccMatch::uuid)::text,
  'S18: a member without activity_logs:read who cannot see the item''s movements still gets the true counts');

-- Not a member, another org's manager, signed out: nothing.
set local "request.jwt.claim.sub" to :nobody;
set local role to 'authenticated';
select is(
  (select count(*)::int from public.item_verification_summaries(:orgA, array[:iMatch, :iNever]::uuid[])),
  0,
  'S19: a signed-in user who is not a member of the org gets no rows');
set local "request.jwt.claim.sub" to :mgrB;
select is(
  (select count(*)::int from public.item_verification_summaries(:orgA, array[:iMatch, :iNever]::uuid[])),
  0,
  'S20: another org''s manager asking about this org gets no rows');
select is(
  (select array_agg(v.item_id) from public.item_verification_summaries(:orgB, array[:itemB, :iMatch]::uuid[]) v),
  array[:itemB]::uuid[],
  'S21: and asking about their own org with a foreign item id gets only their own item');
-- A manager of BOTH orgs can read iMatch, but asking about org B must not
-- answer for an org A item: _latest_count_lines(org B) holds none of its
-- counts, so the row would read "never counted".
set local "request.jwt.claim.sub" to :mgrAB;
select is(
  (select array_agg(row(v.item_id, v.cycle_count_id)::text)
     from public.item_verification_summaries(:orgB, array[:itemB, :iMatch]::uuid[]) v),
  array[row(:itemB::uuid, :ccB::uuid)::text],
  'S27: a member of two orgs asking about one gets no row for the other org''s item (never a false "never counted")');
set local "request.jwt.claim.sub" to '';
select is(
  (select count(*)::int from public.item_verification_summaries(:orgA, array[:iMatch]::uuid[])),
  0,
  'S22: no signed-in user: no rows');

-- Arguments.
set local "request.jwt.claim.sub" to :mgr;
select is(
  pg_temp.err(format('select * from public.item_verification_summaries(%L, array(select gen_random_uuid() from generate_series(1, 501)))', :orgA)),
  '22023:too_many_items:too_many_items',
  'S23: more than 500 ids is refused (22023 too_many_items)');
select is(
  (select count(*)::int from public.item_verification_summaries(
     :orgA, array(select gen_random_uuid() from generate_series(1, 499)) || array[:iMatch]::uuid[])),
  1,
  'S24: 500 ids is accepted');
select is(
  (select count(*)::int from public.item_verification_summaries(:orgA, array[:iMatch, :iMatch, null]::uuid[])),
  1,
  'S25: a repeated id and a null give one row per item');
select is(
  (select count(*)::int from public.item_verification_summaries(:orgA, null)),
  0,
  'S26: a null array gives no rows');
reset role;

-- ═══ L. location_holdings_visible ═════════════════════════════════════════
-- For each persona: which of the four locations holding stock (A-12 in A,
-- N-3 in the annex, the warehouse-less job site, B-1 in org B) the function
-- says are visible, and which ones RLS actually shows a holding at.
create function pg_temp.lhv(p_locs uuid[]) returns text language sql as $$
  select string_agg(l.name || '=' || public.location_holdings_visible(l.id), ',' order by l.name)
    from public.locations l where l.id = any (p_locs)
$$;
create function pg_temp.rls(p_locs uuid[]) returns text language sql as $$
  select string_agg(l.name || '=' || exists (select 1 from public.item_stock_levels s where s.location_id = l.id),
                    ',' order by l.name)
    from (select x as id, n.name from unnest(p_locs) x
            join lateral (select name from public.locations where id = x) n on true) l
$$;
-- The persona's own reading of the locations is RLS'd too (locations_select
-- is org-wide), so the foreign location reads as absent to lhv; rls() takes
-- names through the owner-free lateral read above, which is RLS'd the same
-- way, and prints nothing for it either.
create temp table lv (who text, fn text, rls text);
grant all on lv to authenticated;

set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
insert into lv select 'mgr', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
set local "request.jwt.claim.sub" to :stf;
insert into lv select 'stf', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
set local "request.jwt.claim.sub" to :vwr;
insert into lv select 'vwr', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
set local "request.jwt.claim.sub" to :stfX;
insert into lv select 'stfX', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
set local "request.jwt.claim.sub" to :stf2;
insert into lv select 'stf2', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
set local "request.jwt.claim.sub" to :mgrB;
insert into lv select 'mgrB', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
set local "request.jwt.claim.sub" to :nobody;
insert into lv select 'nobody', pg_temp.lhv(array[:rA, :rA2, :site, :rB]::uuid[]), pg_temp.rls(array[:rA, :rA2, :site, :rB]::uuid[]);
reset role;
set local "request.jwt.claim.sub" to '';

select is(
  (select count(*)::int from lv where fn is distinct from rls),
  0,
  'L1: for every persona, location_holdings_visible says exactly which locations item_stock_levels RLS shows holdings at');
select is(
  (select fn from lv where who = 'mgr'),
  'A-12=true,Job site=true,N-3=true',
  'L2: a manager sees every location of the org');
select is(
  (select fn from lv where who = 'stf'),
  'A-12=true,Job site=true,N-3=false',
  'L3: staff in warehouse A: A-12 and the warehouse-less job site, not the annex');
select is(
  (select fn from lv where who = 'vwr'),
  'A-12=true,Job site=true,N-3=false',
  'L4: a viewer in warehouse A: the same');
select is(
  (select fn from lv where who = 'stf2'),
  'A-12=false,Job site=true,N-3=true',
  'L5: staff in the annex: the annex and the job site');
select is(
  (select fn from lv where who = 'stfX'),
  'A-12=false,Job site=true,N-3=false',
  'L6: stfX (an assignment row carrying another org): only the warehouse-less job site, as RLS');
select is(
  (select fn from lv where who = 'mgrB'),
  'B-1=true',
  'L7: another org''s manager: only their own location (org A''s are not even readable)');
select is(
  (select coalesce(fn, '') from lv where who = 'nobody'),
  '',
  'L8: a non-member: nothing');

set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select is(
  public.location_holdings_visible(:rB) or public.location_holdings_visible(gen_random_uuid())
    or public.location_holdings_visible(null),
  false,
  'L9: a foreign, unknown or null location is false');
reset role;

-- ═══ Z. The file's own assumptions ═══════════════════════════════════════
select is(
  (select count(*)::int from public.stock_movements m
    where m.item_id = :iMatch and m.via_ledger
      and m.created_at > now() - interval '2 days'),
  4,
  'Z1 (control): iMatch has four ledger rows after its baseline, one of them its own count''s, so S4''s 3 is the exclusion at work');
select is(
  (select count(*)::int from public.stock_movements m
    where m.item_id = :iMatch and m.via_ledger and m.reference_type is null
      and m.created_at > now() - interval '2 days'),
  1,
  'Z2 (control): one of them has no reference at all (the transfer), so S4 also proves a reference-less row is counted');

select * from finish();
rollback;
