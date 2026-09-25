-- supabase/tests/0372_exception_recount_review.test.sql
-- pgTAP proof for the F1-2 review fixes in migration 0372.
--
-- A. cycle_count_line_rechecks: an open line re-checks its item when it is
--    uncounted or counted no earlier than every posted count of the item; a
--    posted line re-checked it when no count posted at or before it observed
--    the item later; a cancelled line never does. SECURITY INVOKER, callable
--    by authenticated (a computed field), not by anon.
-- E. _latest_count_lines(..., p_as_of) leaves out counts completed after the
--    evaluation began (mutation: drop the bound).
-- B. start_targeted_recount links to an open count only when its line can
--    still re-check the item: an open count whose line was counted BEFORE the
--    posted variance gets a new count instead (the review's probe; mutation:
--    drop the predicate from the classification), while one counted after it
--    is linked.
-- C. A live pointer whose line was counted before a later posted count is
--    not "live": linking it directly is refused (recount_line_already_counted)
--    and a new recount replaces it, closing it first (recount_closed, then
--    recount_linked; mutation: drop the predicate from _exc_link_recount's
--    pointer check, and the recount is refused as recount_already_linked).
-- D. A replay answers with the first call's answer (links, skips, the
--    count), stored with the key (mutation: answer with empty lists).
-- F. exceptions_sync: a row it resolves has its finished recount closed
--    first, even when that count completed after p_evaluated_at (mutation:
--    drop step 5b); an in-progress recount keeps its pointer; an open
--    count_variance whose item can no longer be counted (discontinued,
--    rental) resolves as subject_gone (mutation: drop the clause, and it reads
--    "cleared"); an active item's and another rule's rows still clear.
--
-- Fixtures as the test superuser (the rebase trigger off while lines are
-- planted, as in 0372_exception_recount.test.sql); RPCs as `authenticated`.
-- begin/rollback: nothing leaks. Namespace 03722222.

begin;

select plan(26);

\set org   '\'03722222-0000-0000-0000-00000000000a\''
\set mgr   '\'03722222-0000-0000-0000-0000000000a1\''
\set wh    '\'03722222-0000-0000-0000-0000000000b1\''
-- items
\set iS    '\'03722222-0000-0000-0000-000000000c01\''
\set iF    '\'03722222-0000-0000-0000-000000000c02\''
\set iP    '\'03722222-0000-0000-0000-000000000c03\''
\set iU    '\'03722222-0000-0000-0000-000000000c04\''
\set iN    '\'03722222-0000-0000-0000-000000000c05\''
\set iRx   '\'03722222-0000-0000-0000-000000000c06\''
\set iH    '\'03722222-0000-0000-0000-000000000c07\''
\set iL    '\'03722222-0000-0000-0000-000000000c08\''
\set iM    '\'03722222-0000-0000-0000-000000000c09\''
\set iDisc '\'03722222-0000-0000-0000-000000000c0a\''
\set iRv   '\'03722222-0000-0000-0000-000000000c0b\''
\set iAct  '\'03722222-0000-0000-0000-000000000c0c\''
\set iLbl  '\'03722222-0000-0000-0000-000000000c0d\''
-- counts
\set ccX   '\'03722222-0000-0000-0000-000000000d01\''
\set ccA   '\'03722222-0000-0000-0000-000000000d02\''
\set ccY   '\'03722222-0000-0000-0000-000000000d03\''
\set ccB   '\'03722222-0000-0000-0000-000000000d04\''
\set ccR   '\'03722222-0000-0000-0000-000000000d05\''
\set ccC   '\'03722222-0000-0000-0000-000000000d06\''
\set ccU   '\'03722222-0000-0000-0000-000000000d07\''
\set ccH0  '\'03722222-0000-0000-0000-000000000d08\''
\set ccH1  '\'03722222-0000-0000-0000-000000000d09\''
\set ccH2  '\'03722222-0000-0000-0000-000000000d0a\''
\set ccK   '\'03722222-0000-0000-0000-000000000d0b\''
\set ccL   '\'03722222-0000-0000-0000-000000000d0c\''
\set ccM   '\'03722222-0000-0000-0000-000000000d0d\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, '03722222-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:org, '0372 Review', '0372-review');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh, :org, '0372 Review WH', 'WH-0372RV', 'active');

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, is_rental, is_bundle) values
  (:iS,    :org, :wh, 'X03722-S',    'Stale line',        11, 'active', false, false),
  (:iF,    :org, :wh, 'X03722-F',    'Fresh line',        11, 'active', false, false),
  (:iP,    :org, :wh, 'X03722-P',    'Stale pointer',     12, 'active', false, false),
  (:iU,    :org, :wh, 'X03722-U',    'Uncounted line',     5, 'active', false, false),
  (:iN,    :org, :wh, 'X03722-N',    'New count',          3, 'active', false, false),
  (:iRx,   :org, :wh, 'X03722-RX',   'Rental asked for',   1, 'active', true,  false),
  (:iH,    :org, :wh, 'X03722-H',    'History',            7, 'active', false, false),
  (:iL,    :org, :wh, 'X03722-L',    'Late recount',      10, 'active', false, false),
  (:iM,    :org, :wh, 'X03722-M',    'Open recount',      10, 'active', false, false),
  (:iDisc, :org, :wh, 'X03722-DISC', 'Discontinued',       4, 'active', false, false),
  (:iRv,   :org, :wh, 'X03722-RV',   'Became rental',      4, 'active', false, false),
  (:iAct,  :org, :wh, 'X03722-ACT',  'Still active',       4, 'active', false, false),
  (:iLbl,  :org, :wh, 'X03722-LBL',  'Label discontinued', 4, 'active', false, false);

alter table public.cycle_count_lines disable trigger cycle_count_lines_rebase_expected;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at, completed_at, completed_by, canceled_at, canceled_by) values
  -- iS: X open, counted 2 h ago; A posted 55 min ago with a +1 observed 1 h ago.
  (:ccX,  :org, :wh, 'in_progress', 'warehouse', :mgr, now() - interval '3 hours',  null, null, null, null),
  (:ccA,  :org, :wh, 'completed',   'selection', :mgr, now() - interval '70 minutes', now() - interval '55 minutes', :mgr, null, null),
  -- iF: Y open, counted 30 min ago; B posted 50 min ago, observed 1 h ago.
  (:ccY,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '2 hours',  null, null, null, null),
  (:ccB,  :org, :wh, 'completed',   'selection', :mgr, now() - interval '70 minutes', now() - interval '50 minutes', :mgr, null, null),
  -- iP: R open (the pointer), counted 3 h ago; C posted 1 h ago, observed 2 h ago.
  (:ccR,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '4 hours',  null, null, null, null),
  (:ccC,  :org, :wh, 'completed',   'selection', :mgr, now() - interval '3 hours',  now() - interval '1 hour', :mgr, null, null),
  -- iU: an open count with the item uncounted.
  (:ccU,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour',   null, null, null, null),
  -- iH: H1 posted 2 h ago (observed 3 h ago), H2 posted 1 h ago (observed
  -- 90 min ago), H0 posted 30 min ago but observed 4 h ago.
  (:ccH1, :org, :wh, 'completed',   'selection', :mgr, now() - interval '4 hours',  now() - interval '2 hours', :mgr, null, null),
  (:ccH2, :org, :wh, 'completed',   'selection', :mgr, now() - interval '2 hours',  now() - interval '1 hour', :mgr, null, null),
  (:ccH0, :org, :wh, 'completed',   'selection', :mgr, now() - interval '5 hours',  now() - interval '30 minutes', :mgr, null, null),
  -- iH: a cancelled count with a counted line.
  (:ccK,  :org, :wh, 'canceled',    'selection', :mgr, now() - interval '20 minutes', null, null, now() - interval '10 minutes', :mgr),
  -- iL: its recount, posted 5 min ago; iM: its recount, still open.
  (:ccL,  :org, :wh, 'completed',   'selection', :mgr, now() - interval '1 hour',   now() - interval '5 minutes', :mgr, null, null),
  (:ccM,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour',   null, null, null, null);

insert into public.cycle_count_lines
  (cycle_count_id, item_id, warehouse_id, expected_quantity, expected_at_start, counted_quantity,
   counted_by, counted_at, baseline_at) values
  (:ccX,  :iS, :wh, 10, 10, 10,   :mgr, now() - interval '2 hours',    now() - interval '2 hours'),
  (:ccA,  :iS, :wh, 10, 10, 11,   :mgr, now() - interval '1 hour',     now() - interval '1 hour'),
  (:ccY,  :iF, :wh, 11, 10, 11,   :mgr, now() - interval '30 minutes', now() - interval '30 minutes'),
  (:ccB,  :iF, :wh, 10, 10, 11,   :mgr, now() - interval '1 hour',     now() - interval '1 hour'),
  (:ccR,  :iP, :wh, 11, 11, 11,   :mgr, now() - interval '3 hours',    now() - interval '3 hours'),
  (:ccC,  :iP, :wh, 11, 11, 12,   :mgr, now() - interval '2 hours',    now() - interval '2 hours'),
  (:ccU,  :iU, :wh, 5,  5,  null, null, null, null),
  (:ccH1, :iH, :wh, 7,  7,  7,    :mgr, now() - interval '3 hours',    now() - interval '3 hours'),
  (:ccH2, :iH, :wh, 7,  7,  7,    :mgr, now() - interval '90 minutes', now() - interval '90 minutes'),
  (:ccH0, :iH, :wh, 7,  7,  7,    :mgr, now() - interval '4 hours',    now() - interval '4 hours'),
  (:ccK,  :iH, :wh, 7,  7,  9,    :mgr, now() - interval '15 minutes', now() - interval '15 minutes'),
  (:ccL,  :iL, :wh, 10, 10, 10,   :mgr, now() - interval '20 minutes', now() - interval '20 minutes'),
  (:ccM,  :iM, :wh, 10, 10, null, null, null, null);

alter table public.cycle_count_lines enable trigger cycle_count_lines_rebase_expected;

-- ── Helpers ──────────────────────────────────────────────────────────────
-- A call's jsonb answer, or {"error": "SQLSTATE:hint"} (its effects roll back).
create function pg_temp.try_json(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; v_state text; v_hint text;
begin
  execute p_sql into v;
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return jsonb_build_object('error', v_state || ':' || coalesce(v_hint, ''));
end $$;

create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;

create function pg_temp.e(p_rule text, p_item uuid) returns jsonb language sql as $$
  select jsonb_build_object('rule', p_rule, 'itemId', p_item, 'locationId', null, 'facts', '{}'::jsonb)
$$;

create temp table cur_present (item uuid primary key, rule text not null);
grant all on cur_present to service_role;
insert into cur_present (item, rule) values
  (:iS, 'count_variance'), (:iF, 'count_variance'), (:iP, 'count_variance'),
  (:iU, 'count_variance'), (:iN, 'count_variance'), (:iL, 'count_variance'),
  (:iM, 'count_variance'), (:iDisc, 'count_variance'), (:iRv, 'count_variance'),
  (:iAct, 'count_variance'), (:iLbl, 'label_mismatch');

create function pg_temp.sync(p_org uuid, p_at timestamptz) returns jsonb language sql as $$
  select public.exceptions_sync(
    p_org, p_at,
    array['orphaned_stock', 'over_reserved', 'stale_staging', 'long_unplaced', 'label_mismatch', 'count_variance'],
    '{}', '{}',
    (select coalesce(jsonb_agg(pg_temp.e(c.rule, c.item) order by c.item), '[]'::jsonb) from cur_present c),
    '[]'::jsonb)
$$;

create function pg_temp.tl(p_occ uuid) returns text[] language sql as $$
  select coalesce(array_agg(e.kind || ':' || coalesce(e.cycle_count_id::text, '-') || ':'
                            || coalesce(e.actor_user_id::text, 'system') order by e.created_at, e.id), '{}')
    from public.exception_occurrence_events e where e.occurrence_id = p_occ
$$;

create function pg_temp.rechecks(p_cc uuid, p_item uuid) returns boolean language sql as $$
  select public.cycle_count_line_rechecks(l) from public.cycle_count_lines l
   where l.cycle_count_id = p_cc and l.item_id = p_item
$$;

-- Raise every occurrence.
set local role to 'service_role';
select pg_temp.sync(:org, now() - interval '60 minutes') as "sync1" \gset
reset role;

select id as "oS"    from public.exception_occurrences where item_id = :iS    \gset
select id as "oF"    from public.exception_occurrences where item_id = :iF    \gset
select id as "oP"    from public.exception_occurrences where item_id = :iP    \gset
select id as "oU"    from public.exception_occurrences where item_id = :iU    \gset
select id as "oN"    from public.exception_occurrences where item_id = :iN    \gset
select id as "oL"    from public.exception_occurrences where item_id = :iL    \gset
select id as "oM"    from public.exception_occurrences where item_id = :iM    \gset
select id as "oDisc" from public.exception_occurrences where item_id = :iDisc \gset
select id as "oRv"   from public.exception_occurrences where item_id = :iRv   \gset
select id as "oAct"  from public.exception_occurrences where item_id = :iAct  \gset
select id as "oLbl"  from public.exception_occurrences where item_id = :iLbl  \gset

-- The stale pointer: oP already points at R (as a recount once linked it).
update public.exception_occurrences set recount_cycle_count_id = :ccR where id = :'oP';

do $$ begin
  if (select count(*) from public.exception_occurrences where item_id::text like '03722222-%' and resolved_at is null) <> 11
     or (select count(*) from public.cycle_count_lines l where l.cycle_count_id::text like '03722222-%') <> 13
  then raise exception '0372 review fixtures incomplete'; end if;
end $$;

-- ═══ A. cycle_count_line_rechecks ═════════════════════════════════════════
select is(pg_temp.rechecks(:ccU, :iU), true,
  'A1: an uncounted line in an open count re-checks its item');
select is(pg_temp.rechecks(:ccX, :iS), false,
  'A2: an open line counted before a later posted count of the item does not');
select is(pg_temp.rechecks(:ccY, :iF), true,
  'A3: an open line counted after every posted count of the item does');
select is(pg_temp.rechecks(:ccH0, :iH), false,
  'A4: a posted line observed before counts posted ahead of it did not re-check the item');
select is(pg_temp.rechecks(:ccH1, :iH), true,
  'A5: a posted line that was the latest when posted did, though a later count observed later');
select is(pg_temp.rechecks(:ccK, :iH), false,
  'A6: a cancelled count''s line never re-checks');
select ok(
  (select not p.prosecdef and p.provolatile = 's'
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and not has_function_privilege('anon', p.oid, 'EXECUTE')
     from pg_proc p where p.oid = 'public.cycle_count_line_rechecks(public.cycle_count_lines)'::regprocedure),
  'A7: cycle_count_line_rechecks is a STABLE SECURITY INVOKER function for authenticated, not anon (catalog)');

-- ═══ E. _latest_count_lines as of the evaluation ═════════════════════════
set local role to 'service_role';
select is(
  (select l.cycle_count_id from public._latest_count_lines(:org, array[:iH]::uuid[], now() - interval '90 minutes') l),
  :ccH1::uuid,
  'E1: counts completed after p_as_of are left out (H2, posted 1 h ago, is not seen at -90 min)');
select is(
  (select l.cycle_count_id from public._latest_count_lines(:org, array[:iH]::uuid[]) l),
  :ccH2::uuid,
  'E2: with no bound the latest observation wins');
reset role;

-- ═══ B. A recount links only to a line that can still re-check ═══════════
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select pg_temp.try_json(format($$select public.start_targeted_recount(%L, array[%L]::uuid[], null, null, 'rv-s')$$,
                               :org, :'oS')) as "rS" \gset
select is(
  row(:'rS'::jsonb->'error', :'rS'::jsonb->'created', :'rS'::jsonb->'lineCount', :'rS'::jsonb->'linkedExisting')::text,
  row(null::jsonb, 'true'::jsonb, '1'::jsonb, '[]'::jsonb)::text,
  'B1: an open count whose line was counted before the variance is not "already counting": a new count is made');
select is(
  (select row(o.recount_cycle_count_id = (:'rS'::jsonb->>'cycleCountId')::uuid,
              exists (select 1 from public.cycle_count_lines l
                       where l.cycle_count_id = o.recount_cycle_count_id and l.item_id = :iS),
              (select count(*) from public.exception_occurrence_events e
                where e.occurrence_id = o.id and e.cycle_count_id = :ccX))::text
     from public.exception_occurrences o where o.id = :'oS'),
  row(true, true, 0)::text,
  'B2: the exception points at the new count, which holds the item; the stale count is never linked');

select pg_temp.try_json(format($$select public.start_targeted_recount(%L, array[%L]::uuid[], null, null, 'rv-f')$$,
                               :org, :'oF')) as "rF" \gset
select is(
  row(:'rF'::jsonb->'created', :'rF'::jsonb#>'{linkedExisting,0,cycleCountId}',
      (select recount_cycle_count_id from public.exception_occurrences where id = :'oF'))::text,
  row('false'::jsonb, to_jsonb(:ccY::text), :ccY::uuid)::text,
  'B3: an open count whose line was counted after the variance is linked, and no count is made');

-- ═══ C. A stale live pointer is replaced ═════════════════════════════════
select is(
  pg_temp.err(format('select public._exc_link_recount(%L, %L)', :'oP', :ccR)),
  'P0001:recount_line_already_counted',
  'C1: linking to a count whose line was counted before a later posted count is refused');

select pg_temp.try_json(format($$select public.start_targeted_recount(%L, array[%L]::uuid[], null, null, 'rv-p')$$,
                               :org, :'oP')) as "rP" \gset
select is(
  row(:'rP'::jsonb->'error', :'rP'::jsonb->'created',
      (select recount_cycle_count_id from public.exception_occurrences where id = :'oP')
        = (:'rP'::jsonb->>'cycleCountId')::uuid)::text,
  row(null::jsonb, 'true'::jsonb, true)::text,
  'C2: a recount of an exception whose live recount can no longer re-check it makes a new count and points at it');
select is(
  (pg_temp.tl(:'oP'))[2:3],
  array['recount_closed:' || :ccR || ':system',
        'recount_linked:' || (:'rP'::jsonb->>'cycleCountId') || ':' || :mgr],
  'C3: the old recount is closed first (system), then the new one linked (by the manager)');

-- ═══ D. A replay says what the first call did ════════════════════════════
select public.start_targeted_recount(:org, array[:'oU']::uuid[], null, null, 'rv-u') as "rU" \gset
select is(
  row(:'rU'::jsonb->'created', :'rU'::jsonb#>'{linkedExisting,0,cycleCountId}',
      :'rU'::jsonb#>'{linkedExisting,0,occurrenceIds}')::text,
  row('false'::jsonb, to_jsonb(:ccU::text), jsonb_build_array(:'oU'::uuid))::text,
  'D1: a link-only recount reports the count it linked to');
select is(
  public.start_targeted_recount(:org, array[:'oU']::uuid[], null, null, 'rv-u'),
  :'rU'::jsonb || '{"replay": true}'::jsonb,
  'D2: its replay answers with the same links (not "no count was started")');

select public.start_targeted_recount(:org, array[:'oN']::uuid[], array[:iRx]::uuid[], 'Recount: New count', 'rv-n') as "rN" \gset
select is(
  public.start_targeted_recount(:org, array[:'oN']::uuid[], array[:iRx]::uuid[], null, 'rv-n'),
  :'rN'::jsonb || '{"created": false, "replay": true}'::jsonb,
  'D3: a replay of a created count answers with the same count, line count, links and skips');
select is(
  row(:'rN'::jsonb->'created', :'rN'::jsonb#>'{skipped,0,itemId}', :'rN'::jsonb#>'{skipped,0,reason}',
      (select k.response from public.idempotency_keys k
        where k.organization_id = :org and k.scope = 'targeted_recount' and k.key = 'rv-n') = :'rN'::jsonb)::text,
  row('true'::jsonb, to_jsonb(:iRx::text), '"not_countable"'::jsonb, true)::text,
  'D4: the first answer (with its skip) is stored with the key');

reset role;

-- ═══ F. exceptions_sync step 5 ═══════════════════════════════════════════
update public.exception_occurrences set recount_cycle_count_id = :ccL where id = :'oL';
update public.exception_occurrences set recount_cycle_count_id = :ccM where id = :'oM';
update public.inventory_items set status = 'discontinued' where id in (:iDisc, :iLbl);
update public.inventory_items set is_rental = true where id = :iRv;
delete from cur_present where item in (:iL, :iM, :iDisc, :iRv, :iAct, :iLbl);

set local role to 'service_role';
select pg_temp.sync(:org, now() - interval '10 minutes') as "sync2" \gset
reset role;
select is(
  row(:'sync2'::jsonb->'resolved', :'sync2'::jsonb->'recountsClosed')::text,
  row('6'::jsonb, '1'::jsonb)::text,
  'F1: six rows resolve; the one whose recount is over has it closed, although it completed after the evaluation began');
select is(
  row((select recount_cycle_count_id from public.exception_occurrences where id = :'oL'),
      (pg_temp.tl(:'oL'))[2:3])::text,
  row(null::uuid, array['recount_closed:' || :ccL || ':system', 'resolved:-:system'])::text,
  'F2: its timeline reads recount_closed, then resolved, and the pointer is cleared');
select is(
  (select row(recount_cycle_count_id, resolved_reason)::text from public.exception_occurrences where id = :'oM'),
  row(:ccM::uuid, 'cleared')::text,
  'F3: a recount still in progress keeps its pointer (it closes when that count does)');
select is(
  (select resolved_reason from public.exception_occurrences where id = :'oDisc'),
  'subject_gone',
  'F4: an open count_variance on an item now discontinued resolves as subject_gone, not cleared');
select is(
  (select resolved_reason from public.exception_occurrences where id = :'oRv'),
  'subject_gone',
  'F5: an open count_variance on an item now rental equipment resolves as subject_gone');
select is(
  (select resolved_reason from public.exception_occurrences where id = :'oAct'),
  'cleared',
  'F6: an active item''s count_variance still clears');
select is(
  (select resolved_reason from public.exception_occurrences where id = :'oLbl'),
  'cleared',
  'F7: another rule on a discontinued item still clears (0370''s reasons are unchanged)');

select * from finish();
rollback;
