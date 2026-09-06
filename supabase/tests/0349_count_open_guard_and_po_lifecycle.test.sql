-- supabase/tests/0349_count_open_guard_and_po_lifecycle.test.sql
-- pgTAP proof for migration 0349. Three independent defects:
--
--   SP-087  A count recorded WHILE post_cycle_count is looping used to commit
--           against the in_progress snapshot: the post wrote the ledger from
--           the OLD number and the line kept the NEW one. Section A proves the
--           parent-status guard now refuses a line write on a closed count
--           (assertions 1, 2, 5, 6, 7 and 9 fail on the pre-0349 head, where nothing
--           but a non-locking RLS subselect stood in the way).
--
--   SP-128  Fully reversing the only receipt on an IMPORT-created PO demoted
--           it from 'expected_inbound' to 'ordered' — wrong tab, wrong badge,
--           and a status-change notification for a state it was never in.
--           Assertion 11 fails on the pre-0349 head ('ordered').
--
--   SP-063  post_receipt_v2 accepted DRAFT POs, so receiving bypassed the PO
--           approval threshold that every other transition out of draft must
--           clear. Assertions 15-18 fail on the pre-0349 head (the call succeeds
--           and the draft flips to 'received').
--
-- HOW THE ROLES ARE SIMULATED. As in 0346: assertions here depend on
-- auth.uid() (has_org_role inside the RPCs, and 0349's own service-path
-- exemption), never on RLS, so everything runs as the test superuser with
-- `set local "request.jwt.claim.sub"`. An EMPTY sub makes auth.uid() null,
-- i.e. the service_role / postgres path. psql does NOT interpolate :vars
-- inside dollar-quoted blocks, so those carry literal uuids (same as 0183).
--
-- Run via `supabase test db` after `supabase db reset`. begin/rollback so
-- nothing leaks.

begin;

select plan(21);

\set org      '\'03490000-0000-0000-0000-00000000000a\''
\set mgr      '\'03490000-0000-0000-0000-0000000000a1\''
\set counter  '\'03490000-0000-0000-0000-0000000000a2\''
\set wh       '\'03490000-0000-0000-0000-0000000000b1\''
-- Section A (cycle count)
\set itemA    '\'03490000-0000-0000-0000-0000000000c1\''
\set cc       '\'03490000-0000-0000-0000-0000000000d1\''
\set ccl      '\'03490000-0000-0000-0000-0000000000d2\''
-- Section B (PO lifecycle on reversal)
\set itemB    '\'03490000-0000-0000-0000-0000000000c2\''
\set itemC    '\'03490000-0000-0000-0000-0000000000c3\''
\set itemD    '\'03490000-0000-0000-0000-0000000000c4\''
\set poImp    '\'03490000-0000-0000-0000-0000000000e1\''
\set poOrd    '\'03490000-0000-0000-0000-0000000000e2\''
\set poImpOrd '\'03490000-0000-0000-0000-0000000000e3\''
\set lnImp    '\'03490000-0000-0000-0000-0000000000f1\''
\set lnOrd    '\'03490000-0000-0000-0000-0000000000f2\''
\set lnImpOrd '\'03490000-0000-0000-0000-0000000000f3\''
-- Section C (draft receiving)
\set itemE    '\'03490000-0000-0000-0000-0000000000c5\''
\set itemF    '\'03490000-0000-0000-0000-0000000000c6\''
\set itemG    '\'03490000-0000-0000-0000-0000000000c7\''
\set poDraft  '\'03490000-0000-0000-0000-0000000000e4\''
\set poCtrl   '\'03490000-0000-0000-0000-0000000000e5\''
\set poCanc   '\'03490000-0000-0000-0000-0000000000e6\''
\set lnDraft  '\'03490000-0000-0000-0000-0000000000f4\''
\set lnCtrl   '\'03490000-0000-0000-0000-0000000000f5\''
\set lnCanc   '\'03490000-0000-0000-0000-0000000000f6\''

-- ══ Fixtures (test superuser; auth.uid() comes from the claim set below) ══
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,     '0349-mgr@test.local',     '{}'::jsonb),
  (:counter, '0349-counter@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, '0349 Guard Org', '0349-guard-org') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,     'manager', now()),
  (:org, :counter, 'staff',   now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, '0349 Main', 'WH-0349', 'active') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status) values
  (:itemA, :org, :wh, '0349 Counted Widget', 'SKU-0349-A', 40, 'active'),
  (:itemB, :org, :wh, '0349 Import Widget',  'SKU-0349-B',  0, 'active'),
  (:itemC, :org, :wh, '0349 Ordered Widget', 'SKU-0349-C',  0, 'active'),
  (:itemD, :org, :wh, '0349 ImpOrd Widget',  'SKU-0349-D',  0, 'active'),
  (:itemE, :org, :wh, '0349 Draft Widget',   'SKU-0349-E',  0, 'active'),
  (:itemF, :org, :wh, '0349 Control Widget', 'SKU-0349-F',  0, 'active'),
  (:itemG, :org, :wh, '0349 Cancel Widget',  'SKU-0349-G',  0, 'active')
  on conflict (id) do nothing;

-- ── Section A fixture: an in-progress count assigned to the staff counter ──
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, started_by, assigned_to)
  values (:cc, :org, :wh, 'in_progress', :mgr, :counter)
  on conflict (id) do nothing;
insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, warehouse_id, expected_quantity)
  values (:ccl, :cc, :itemA, :wh, 40)
  on conflict (id) do nothing;

-- ── Section B/C fixtures: four POs in four different lifecycle states ──
-- poImp:    created by an import — 'expected_inbound', ordered_at NULL.
-- poOrd:    an ordinary PO somebody ordered — ordered_at stamped, no import.
-- poImpOrd: imported AND later explicitly ordered — ordered_at stamped.
-- poDraft / poCtrl / poCanc: section C.
insert into public.purchase_orders (id, organization_id, po_number, status, ordered_at, notes) values
  (:poImp,    :org, 'PO-0349-IMP',    'expected_inbound', null,  'Imported from PO file (po_import 0349)'),
  (:poOrd,    :org, 'PO-0349-ORD',    'ordered',          now(), null),
  (:poImpOrd, :org, 'PO-0349-IMPORD', 'ordered',          now(), 'Imported from PO file (po_import 0349b)'),
  (:poDraft,  :org, 'PO-0349-DRAFT',  'draft',            null,  null),
  (:poCtrl,   :org, 'PO-0349-CTRL',   'ordered',          now(), null),
  (:poCanc,   :org, 'PO-0349-CANC',   'cancelled',        now(), null)
  on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:lnImp,    :org, :poImp,    :itemB, 10, 0, 5),
  (:lnOrd,    :org, :poOrd,    :itemC, 10, 0, 5),
  (:lnImpOrd, :org, :poImpOrd, :itemD, 10, 0, 5),
  (:lnDraft,  :org, :poDraft,  :itemE, 10, 0, 5),
  (:lnCtrl,   :org, :poCtrl,   :itemF, 10, 0, 5),
  (:lnCanc,   :org, :poCanc,   :itemG, 10, 0, 5)
  on conflict (id) do nothing;

-- The import rows that make poImp / poImpOrd import-created.
insert into public.po_imports
  (organization_id, uploaded_by, source_type, file_name, file_mime_type,
   file_size, storage_path, sha256, status, approved_po_id) values
  (:org, :mgr, 'pdf', '0349-a.pdf', 'application/pdf', 1024,
   'org/0349/a.pdf', repeat('a', 64), 'approved', :poImp),
  (:org, :mgr, 'pdf', '0349-b.pdf', 'application/pdf', 1024,
   'org/0349/b.pdf', repeat('b', 64), 'approved', :poImpOrd);

-- Act as the staff counter for section A.
set local "request.jwt.claim.sub" to '03490000-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — SP-087: a closed count refuses line writes
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. The trigger is installed.
select has_trigger(
  'public', 'cycle_count_lines', 'cycle_count_lines_assert_open',
  'A1: cycle_count_lines carries the 0349 assert-open trigger'
);

-- 2. Same-timing triggers fire in NAME order, and the refusal must come before
--    0339's rebase does any work. This pins the name, not just its existence.
select is(
  (select tgname::text from pg_trigger
    where tgrelid = 'public.cycle_count_lines'::regclass
      and not tgisinternal
    order by tgname limit 1),
  'cycle_count_lines_assert_open',
  'A2: the assert-open trigger sorts first, so it fires before the 0339 rebase'
);

-- 3. The open case is untouched: the assignee still records a count.
select lives_ok(
  $$ update public.cycle_count_lines
        set counted_quantity = 40, counted_by = '03490000-0000-0000-0000-0000000000a2',
            counted_at = now()
      where id = '03490000-0000-0000-0000-0000000000d2' $$,
  'A3: recording a count on an in_progress cycle count still works'
);

-- 4. ...and the value actually landed.
select is(
  (select counted_quantity from public.cycle_count_lines where id = :ccl),
  40::numeric(14,4),
  'A4: the recorded count persisted'
);

-- Close the count the way post_cycle_count does at the end of its loop.
update public.cycle_counts set status = 'completed', completed_at = now() where id = :cc;

-- 5. THE BUG. Before 0349 this UPDATE succeeded (the 0282 RLS subselect is
--    non-locking and is bypassed entirely by a definer/service path), leaving
--    counted=45 on a posted count whose ledger says 40.
select throws_ok(
  $$ update public.cycle_count_lines
        set counted_quantity = 45, counted_by = '03490000-0000-0000-0000-0000000000a2',
            counted_at = now()
      where id = '03490000-0000-0000-0000-0000000000d2' $$,
  '22023', 'cycle_count_not_open',
  'A5: a line write on a COMPLETED count is refused with cycle_count_not_open'
);

-- 6. Nothing changed — the refusal is a real abort, not a partial write.
select is(
  (select counted_quantity from public.cycle_count_lines where id = :ccl),
  40::numeric(14,4),
  'A6: the refused write left the recorded count untouched'
);

-- 7. Cancelled counts are equally closed.
update public.cycle_counts set status = 'canceled' where id = :cc;
select throws_ok(
  $$ update public.cycle_count_lines
        set notes = 'late edit'
      where id = '03490000-0000-0000-0000-0000000000d2' $$,
  '22023', 'cycle_count_not_open',
  'A7: any line write on a CANCELED count is refused, not just a count write'
);

-- 8. The service path is deliberately unchanged (0331/0341/0346 gate shape):
--    auth.uid() null still takes the header lock but is not refused, so
--    migration backfills keep working. No service-role writer to
--    cycle_count_lines exists in the app, so this does not reopen the race.
set local "request.jwt.claim.sub" to '';
select lives_ok(
  $$ update public.cycle_count_lines
        set notes = 'backfill'
      where id = '03490000-0000-0000-0000-0000000000d2' $$,
  'A8: the service path (auth.uid() null) is still allowed to write'
);
set local "request.jwt.claim.sub" to '03490000-0000-0000-0000-0000000000a1';

-- 9. 0329 trigger-function posture: firing does not need EXECUTE. Written as a
--    catalog count rather than has_function_privilege('public.fn()') so a
--    missing function fails this assertion instead of aborting the whole file.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'tg_cycle_count_line_assert_open'
      and not has_function_privilege('authenticated', p.oid, 'execute')),
  1,
  'A9: the trigger function exists and authenticated holds no EXECUTE on it'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — SP-128: a full reversal restores the PO's pre-receipt state
-- (acting as the manager from here on: both RPCs gate on has_org_role manager)
-- ═══════════════════════════════════════════════════════════════════════════

-- Receive the import-created PO in full, then reverse the only receipt.
do $$ begin
  perform public.post_receipt_v2(
    '03490000-0000-0000-0000-0000000000e1',
    '03490000-0000-0000-0000-0000000000b1',
    '[{"po_line_id":"03490000-0000-0000-0000-0000000000f1","qty_received":10,"qty_accepted":10,"qty_rejected":0,"unit_cost":5}]'::jsonb,
    '0349-key-imp', '0349-hash-imp', null);
end $$;

-- 10. Sanity: the forward roll is unchanged.
select is(
  (select status from public.purchase_orders where id = :poImp),
  'received',
  'B10: receiving all 10 units marks the import PO received'
);

do $$ begin
  perform public.reverse_receipt(
    (select id from public.receipts
      where purchase_order_id = '03490000-0000-0000-0000-0000000000e1'
        and status = 'posted' limit 1),
    '0349 reversal');
end $$;

-- 11. THE BUG. Pre-0349 this returned 'ordered' — a state this PO was never
--     in, moving it out of the In-transit tab and firing a bogus
--     'received -> ordered' notification.
select is(
  (select status from public.purchase_orders where id = :poImp),
  'expected_inbound',
  'B11: full reversal of an import-created PO restores expected_inbound, not ordered'
);

-- 12. received_at still cleared, so it can be received again (0183 contract).
select ok(
  (select received_at is null from public.purchase_orders where id = :poImp),
  'B12: received_at is cleared on full reversal'
);

-- 13. The 0183 contract for an ORDINARY PO is unchanged.
do $$ begin
  perform public.post_receipt_v2(
    '03490000-0000-0000-0000-0000000000e2',
    '03490000-0000-0000-0000-0000000000b1',
    '[{"po_line_id":"03490000-0000-0000-0000-0000000000f2","qty_received":10,"qty_accepted":10,"qty_rejected":0,"unit_cost":5}]'::jsonb,
    '0349-key-ord', '0349-hash-ord', null);
  perform public.reverse_receipt(
    (select id from public.receipts
      where purchase_order_id = '03490000-0000-0000-0000-0000000000e2'
        and status = 'posted' limit 1),
    '0349 reversal');
end $$;
select is(
  (select status from public.purchase_orders where id = :poOrd),
  'ordered',
  'B13: full reversal of an ordinary ordered PO still rolls back to ordered'
);

-- 14. An imported PO that WAS later explicitly ordered (ordered_at stamped)
--     keeps rolling back to 'ordered' — the import row alone is not enough.
do $$ begin
  perform public.post_receipt_v2(
    '03490000-0000-0000-0000-0000000000e3',
    '03490000-0000-0000-0000-0000000000b1',
    '[{"po_line_id":"03490000-0000-0000-0000-0000000000f3","qty_received":10,"qty_accepted":10,"qty_rejected":0,"unit_cost":5}]'::jsonb,
    '0349-key-impord', '0349-hash-impord', null);
  perform public.reverse_receipt(
    (select id from public.receipts
      where purchase_order_id = '03490000-0000-0000-0000-0000000000e3'
        and status = 'posted' limit 1),
    '0349 reversal');
end $$;
select is(
  (select status from public.purchase_orders where id = :poImpOrd),
  'ordered',
  'B14: an imported PO that was explicitly ordered rolls back to ordered'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — SP-063: a DRAFT PO is not receivable
-- ═══════════════════════════════════════════════════════════════════════════

-- 15. THE BUG. Pre-0349 'draft' was in the accepted status set, so this posted
--     stock and flipped the unapproved draft straight to 'received'.
select throws_ok(
  $$ select public.post_receipt_v2(
       '03490000-0000-0000-0000-0000000000e4',
       '03490000-0000-0000-0000-0000000000b1',
       '[{"po_line_id":"03490000-0000-0000-0000-0000000000f4","qty_received":10,"qty_accepted":10,"qty_rejected":0,"unit_cost":5}]'::jsonb,
       '0349-key-draft', '0349-hash-draft', null) $$,
  '22023', 'po_not_ordered',
  'C15: receiving a DRAFT PO is refused with po_not_ordered'
);

-- 16-18. The refusal happens before ANY write.
select is(
  (select status from public.purchase_orders where id = :poDraft),
  'draft',
  'C16: the refused draft PO is still a draft'
);
select is(
  (select count(*)::int from public.receipts where purchase_order_id = :poDraft),
  0,
  'C17: no receipt row was created for the draft PO'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :itemE),
  0::numeric(14,4),
  'C18: no stock was posted for the draft PO'
);

-- 19-20. CONTROL: the refusal is specific to draft. An ordered PO still
--        receives exactly as before.
select lives_ok(
  $$ do $x$ begin perform public.post_receipt_v2(
       '03490000-0000-0000-0000-0000000000e5',
       '03490000-0000-0000-0000-0000000000b1',
       '[{"po_line_id":"03490000-0000-0000-0000-0000000000f5","qty_received":10,"qty_accepted":10,"qty_rejected":0,"unit_cost":5}]'::jsonb,
       '0349-key-ctrl', '0349-hash-ctrl', null); end $x$ $$,
  'C19: an ORDERED PO still receives normally'
);
select is(
  (select status from public.purchase_orders where id = :poCtrl),
  'received',
  'C20: the control PO reached received'
);

-- 21. A closed PO keeps the ORIGINAL error — the new branch did not swallow it.
select throws_ok(
  $$ select public.post_receipt_v2(
       '03490000-0000-0000-0000-0000000000e6',
       '03490000-0000-0000-0000-0000000000b1',
       '[{"po_line_id":"03490000-0000-0000-0000-0000000000f6","qty_received":1,"qty_accepted":1,"qty_rejected":0,"unit_cost":5}]'::jsonb,
       '0349-key-canc', '0349-hash-canc', null) $$,
  '22023', 'po_already_closed',
  'C21: a cancelled PO still raises po_already_closed'
);

select * from finish();
rollback;
