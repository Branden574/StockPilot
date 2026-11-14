-- supabase/tests/0460_cycle_count_reads_follow_count_permission.test.sql
-- pgTAP proof for migration 0460: cycle count rows are read by members who
-- hold a count permission (cycle_counts:read or stock:adjust), on top of the
-- warehouse rule of 0452; the Exception Center reads its recount facts
-- through exception_recount_facts.
--
-- C/L. What each persona reads directly (the Data API's path): an owner, an
--    admin, a manager, a manager whose two count permissions were revoked by
--    a per-member override, staff of North (a counter), staff of North whose
--    two count permissions were revoked, staff of North with stock:adjust
--    revoked (reads through cycle_counts:read), a viewer of North, a viewer
--    with the all-warehouses flag, a read-only auditor (a viewer granted
--    cycle_counts:read), a viewer granted stock:adjust only, an expired and a
--    live Act-as seat, another organization's manager, anon, the service role.
-- F. The functions that read counts: cycle_counts_page, cycle_count_summary,
--    cycle_count_lines_page (SECURITY INVOKER), cycle_count_line_progress
--    (restated) for a viewer and a counter; item_verification_summaries (the
--    Physical count card, kept) still answers a viewer.
-- E. exception_recount_facts: the recount facts of an exception the caller
--    can read, for that exception's item only; nothing for an exception the
--    caller cannot read, another organization's, an expired seat, anon.
-- S. Posture of the new and restated functions and the two rules.
-- G. exception_recount_facts answers row for row what its first form did
--    (progress per pair, the gate per row, kept below as
--    s93_facts_first_form) for every persona on several exceptions sharing
--    one count, several counts, a posted count, a count in another warehouse
--    and holding rules; a counter of one warehouse and a count of another;
--    the lines read for 200 exceptions on one 2,000-line count; a disabled
--    account.
--
-- Fixtures as the test superuser; reads as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace c5930000.
begin;
select plan(100);

\set org      c5930000-0000-4000-8000-00000000000a
\set org2     c5930000-0000-4000-8000-00000000000b
\set own      c5930000-0000-4000-8000-0000000000a0
\set adm      c5930000-0000-4000-8000-0000000000a1
\set mgr      c5930000-0000-4000-8000-0000000000a2
\set mgrOff   c5930000-0000-4000-8000-0000000000a3
\set stN      c5930000-0000-4000-8000-0000000000a4
\set stOff    c5930000-0000-4000-8000-0000000000a5
\set stRead   c5930000-0000-4000-8000-0000000000a6
\set vwN      c5930000-0000-4000-8000-0000000000a7
\set vwAll    c5930000-0000-4000-8000-0000000000a8
\set audN     c5930000-0000-4000-8000-0000000000a9
\set vwAdj    c5930000-0000-4000-8000-0000000000aa
\set seatExp  c5930000-0000-4000-8000-0000000000ab
\set seatLive c5930000-0000-4000-8000-0000000000ac
\set mgr2     c5930000-0000-4000-8000-0000000000b1
\set whN      c5930000-0000-4000-8000-0000000000c1
\set whS      c5930000-0000-4000-8000-0000000000c2
\set whX      c5930000-0000-4000-8000-0000000000c3
\set iN1      c5930000-0000-4000-8000-0000000000d1
\set iN2      c5930000-0000-4000-8000-0000000000d2
\set iN3      c5930000-0000-4000-8000-0000000000d3
\set iS1      c5930000-0000-4000-8000-0000000000d4
\set iX       c5930000-0000-4000-8000-0000000000d5
\set cN       c5930000-0000-4000-8000-0000000000e1
\set cS       c5930000-0000-4000-8000-0000000000e2
\set cDone    c5930000-0000-4000-8000-0000000000e3
\set cX       c5930000-0000-4000-8000-0000000000e9
\set occA     c5930000-0000-4000-8000-0000000000f1
\set occS     c5930000-0000-4000-8000-0000000000f2
\set occC     c5930000-0000-4000-8000-0000000000f3
\set occX     c5930000-0000-4000-8000-0000000000f9

-- A value, or 'ERROR <sqlstate>'.
create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return r;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- A value, then undone (a subtransaction), or 'ERROR <sqlstate>'.
create function pg_temp.q_rb(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  begin
    execute p_sql into r;
    raise exception using errcode = 'P0S93', message = coalesce(r, '(null)');
  exception when sqlstate 'P0S93' then
    return sqlerrm;
  end;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case right(p::text, 2)
    when 'e1' then 'n' when 'e2' then 's' when 'e3' then 'done' when 'e9' then 'x'
    else right(p::text, 4) end $$;

create function pg_temp.counts_seen() returns text language sql as $$
  select coalesce(string_agg(pg_temp.lbl(id), ' ' order by pg_temp.lbl(id) collate "C"), '(none)')
    from public.cycle_counts where id::text like 'c5930000-%' $$;
create function pg_temp.lines_seen() returns text language sql as $$
  select coalesce(string_agg(l || ':' || n, ' ' order by l collate "C"), '(none)')
    from (select pg_temp.lbl(cycle_count_id) l, count(*) n from public.cycle_count_lines
           where cycle_count_id::text like 'c5930000-%' group by 1) s $$;

-- exception_recount_facts for some exceptions, one token per row:
--   count:a(ctive)|c(losed)|n(amed only):status:counted/total:line found:counted/expected:numbered
-- Read through EXECUTE so a missing function is an answer, not an abort.
create function pg_temp.facts(p_exc uuid[], p_org uuid default 'c5930000-0000-4000-8000-00000000000a')
returns text language plpgsql as $$
declare r text;
begin
  execute $q$
    select coalesce(string_agg(
             pg_temp.lbl(f.cycle_count_id) || ':'
             || case when f.is_active_recount then 'a' when f.is_closed_recount then 'c' else 'n' end || ':'
             || f.status || ':'
             || coalesce(f.line_counted::text, '-') || '/' || coalesce(f.line_total::text, '-') || ':'
             || coalesce(f.line_found::text, '-') || ':'
             || coalesce(trim_scale(f.counted_quantity)::text, '-') || '/'
             || coalesce(trim_scale(f.expected_quantity)::text, '-') || ':'
             || (f.count_number is not null)::text,
             ' ' order by right(f.exception_id::text, 2), pg_temp.lbl(f.cycle_count_id) collate "C"), '(none)')
      from public.exception_recount_facts($2, $1) f $q$
    into r using p_exc, p_org;
  return r;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- ══ Fixture (as the test superuser) ═════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select u::uuid, 'u' || right(u, 2) || '-s93@test.local', '{}'
  from unnest(array[:'own', :'adm', :'mgr', :'mgrOff', :'stN', :'stOff', :'stRead', :'vwN', :'vwAll',
                    :'audN', :'vwAdj', :'seatExp', :'seatLive', :'mgr2']) u
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'org', 'S93 Org', 's93-org'), (:'org2', 'S93 Other', 's93-other') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses, impersonation_expires_at) values
  (:'org', :'own', 'owner', now(), false, null),
  (:'org', :'adm', 'admin', now(), false, null),
  (:'org', :'mgr', 'manager', now(), false, null),
  (:'org', :'mgrOff', 'manager', now(), false, null),
  (:'org', :'stN', 'staff', now(), false, null),
  (:'org', :'stOff', 'staff', now(), false, null),
  (:'org', :'stRead', 'staff', now(), false, null),
  (:'org', :'vwN', 'viewer', now(), false, null),
  (:'org', :'vwAll', 'viewer', now(), true, null),
  (:'org', :'audN', 'viewer', now(), false, null),
  (:'org', :'vwAdj', 'viewer', now(), false, null),
  (:'org', :'seatExp', 'owner', now(), false, now() - interval '1 minute'),
  (:'org', :'seatLive', 'staff', now(), false, now() + interval '1 hour'),
  (:'org2', :'mgr2', 'manager', now(), false, null)
  on conflict do nothing;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'org', :'mgrOff', 'cycle_counts:read', false), (:'org', :'mgrOff', 'stock:adjust', false),
  (:'org', :'stOff',  'cycle_counts:read', false), (:'org', :'stOff',  'stock:adjust', false),
  (:'org', :'stRead', 'stock:adjust', false),
  (:'org', :'audN',   'cycle_counts:read', true),
  (:'org', :'vwAdj',  'stock:adjust', true);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whN', :'org', 'S93 North', 'S93N', 'active'), (:'whS', :'org', 'S93 South', 'S93S', 'active'),
  (:'whX', :'org2', 'S93 Other', 'S93X', 'active') on conflict (id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:'org', :'stN', :'whN'), (:'org', :'stOff', :'whN'), (:'org', :'stRead', :'whN'),
  (:'org', :'vwN', :'whN'), (:'org', :'vwAll', :'whN'), (:'org', :'vwAll', :'whS'),
  (:'org', :'audN', :'whN'), (:'org', :'vwAdj', :'whN'), (:'org', :'seatLive', :'whN')
  on conflict do nothing;
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:'iN1', :'org', :'whN', 'S93-N1', 'North one', 5, 'active', 'none'),
  (:'iN2', :'org', :'whN', 'S93-N2', 'North two', 5, 'active', 'none'),
  (:'iN3', :'org', :'whN', 'S93-N3', 'North three', 5, 'active', 'none'),
  (:'iS1', :'org', :'whS', 'S93-S1', 'South one', 5, 'active', 'none'),
  (:'iX',  :'org2', :'whX', 'S93-X1', 'Other one', 5, 'active', 'none')
  on conflict (id) do nothing;
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to, started_at) values
  (:'cDone', :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null, now() - interval '2 hours'),
  (:'cN',    :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null, now() - interval '1 hour'),
  (:'cS',    :'org', :'whS', 'warehouse', 'in_progress', :'mgr', null, now() - interval '1 hour'),
  (:'cX',    :'org2', :'whX', 'warehouse', 'in_progress', :'mgr2', null, now() - interval '1 hour');
-- Lines as the superuser, triggers off (counted values set directly).
set local session_replication_role = replica;
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity, counted_by, counted_at) values
  (:'cDone', :'iN1', :'whN', 5, 7, :'stN', now() - interval '90 minutes'),
  (:'cDone', :'iN3', :'whN', 5, 5, :'stN', now() - interval '90 minutes'),
  (:'cN',    :'iN1', :'whN', 5, 4, :'stN', now() - interval '10 minutes'),
  (:'cN',    :'iN2', :'whN', 5, null, null, null),
  (:'cS',    :'iS1', :'whS', 5, null, null, null),
  (:'cX',    :'iX',  :'whX', 5, null, null, null);
update public.cycle_counts set status = 'completed', completed_at = now() - interval '80 minutes', completed_by = :'mgr'
 where id = :'cDone';
set local session_replication_role = origin;
-- Exceptions as exceptions_sync would store them (item-level rules):
--   occA  North item iN1, its recount cN open, an earlier recount cDone closed
--   occS  South item iS1, its recount cN (which holds no line of iS1)
--   occC  North item iN2, resolved by confirming the count cDone
--   occX  the other organization's item, its recount cX
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, recount_cycle_count_id) values
  (:'occA', :'org',  1, 'count_variance', :'iN1', null, :'whN', now(), now(), :'cN'),
  (:'occS', :'org',  2, 'count_variance', :'iS1', null, :'whS', now(), now(), :'cN'),
  (:'occX', :'org2', 1, 'count_variance', :'iX',  null, :'whX', now(), now(), :'cX');
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, resolved_at, resolved_reason,
   confirmed_at, confirmed_by, confirmed_cycle_count_id, confirmed_quantity, confirmed_on_record, confirmed_as) values
  (:'occC', :'org', 3, 'count_variance', :'iN2', null, :'whN', now(), now(), now(), 'confirmed',
   now(), :'stN', :'cDone', 5, 5, 'counter');
insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, cycle_count_id) values
  (:'org', :'occA', 'recount_linked', :'cDone'),
  (:'org', :'occA', 'recount_closed', :'cDone'),
  (:'org', :'occA', 'recount_linked', :'cN'),
  (:'org', :'occS', 'recount_linked', :'cN'),
  (:'org2', :'occX', 'recount_linked', :'cX');

-- ══ As each persona ══════════════════════════════════════════════════════
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';

set local "request.jwt.claim.sub" to :'own';
select is(pg_temp.counts_seen(), 'done n s', 'C1 owner: every count');
select is(pg_temp.lines_seen(), 'done:2 n:2 s:1', 'L1 owner: every line');
set local "request.jwt.claim.sub" to :'adm';
select is(pg_temp.counts_seen(), 'done n s', 'C2 admin: every count');
select is(pg_temp.lines_seen(), 'done:2 n:2 s:1', 'L2 admin: every line');
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.counts_seen(), 'done n s', 'C3 manager: every count');
select is(pg_temp.lines_seen(), 'done:2 n:2 s:1', 'L3 manager: every line');
set local "request.jwt.claim.sub" to :'mgrOff';
select is(pg_temp.counts_seen(), '(none)', 'C4 a manager whose two count permissions were revoked reads no count');
select is(pg_temp.lines_seen(), '(none)', 'L4 nor any line');
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.counts_seen(), 'done n', 'C5 counter (staff North): the counts of her warehouse, as under 0452');
select is(pg_temp.lines_seen(), 'done:2 n:2', 'L5 counter: their lines');
set local "request.jwt.claim.sub" to :'stOff';
select is(pg_temp.counts_seen(), '(none)', 'C6 staff whose two count permissions were revoked reads no count');
select is(pg_temp.lines_seen(), '(none)', 'L6 nor any line');
set local "request.jwt.claim.sub" to :'stRead';
select is(pg_temp.counts_seen(), 'done n', 'C7 staff with stock:adjust revoked still reads through cycle_counts:read');
select is(pg_temp.lines_seen(), 'done:2 n:2', 'L7 and the lines');
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.counts_seen(), '(none)', 'C8 viewer North reads no count');
select is(pg_temp.lines_seen(), '(none)', 'L8 viewer North reads no line');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_lines where cycle_count_id = 'c5930000-0000-4000-8000-0000000000e1'$$),
  '0', 'L8b viewer North: the lines of one count by id, 0 rows');
set local "request.jwt.claim.sub" to :'vwAll';
select is(pg_temp.counts_seen(), '(none)', 'C9 viewer with the all-warehouses flag reads no count');
select is(pg_temp.lines_seen(), '(none)', 'L9 nor any line');
set local "request.jwt.claim.sub" to :'audN';
select is(pg_temp.counts_seen(), 'done n', 'C10 read-only auditor granted cycle_counts:read: the counts of her warehouse');
select is(pg_temp.lines_seen(), 'done:2 n:2', 'L10 and their lines');
set local "request.jwt.claim.sub" to :'vwAdj';
select is(pg_temp.counts_seen(), 'done n', 'C11 viewer granted stock:adjust only reads the counts of her warehouse');
select is(pg_temp.lines_seen(), 'done:2 n:2', 'L11 and their lines');
set local "request.jwt.claim.sub" to :'seatExp';
select is(pg_temp.counts_seen(), '(none)', 'C12 an expired Act-as seat reads no count');
select is(pg_temp.lines_seen(), '(none)', 'L12 nor any line');
set local "request.jwt.claim.sub" to :'seatLive';
select is(pg_temp.counts_seen(), 'done n', 'C13 a live Act-as seat (staff North) reads as its role allows');
select is(pg_temp.lines_seen(), 'done:2 n:2', 'L13 and the lines');
set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.counts_seen(), 'x', 'C14 another organization''s manager reads only his own count');
select is(pg_temp.lines_seen(), 'x:1', 'L14 and its line');

-- ══ F. Functions that read counts ═════════════════════════════════════════
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.q($$select coalesce(min(total_count), 0)::text from public.cycle_counts_page('c5930000-0000-4000-8000-00000000000a', p_page_size => 100)$$),
  '0', 'F1 viewer: cycle_counts_page answers no count');
select is(pg_temp.q($$select coalesce(min(total), 0)::text from public.cycle_count_summary('c5930000-0000-4000-8000-0000000000e1')$$),
  '0', 'F2 viewer: cycle_count_summary counts no line');
select is(pg_temp.q($$select coalesce(min(full_count), 0)::text from public.cycle_count_lines_page('c5930000-0000-4000-8000-0000000000e1')$$),
  '0', 'F3 viewer: cycle_count_lines_page shows no line');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c5930000-0000-4000-8000-00000000000a',
     array['c5930000-0000-4000-8000-0000000000e1', 'c5930000-0000-4000-8000-0000000000e3']::uuid[])$$),
  '0', 'F4 viewer: cycle_count_line_progress gives no row');
select is(pg_temp.q($$select pg_temp.lbl(cycle_count_id) || '/' || pg_temp.lbl(open_count_id)
     from public.item_verification_summaries('c5930000-0000-4000-8000-00000000000a', array['c5930000-0000-4000-8000-0000000000d1']::uuid[])$$),
  'done/n', 'F5 viewer: the Physical count card still names the last count and the open count (kept by design)');
select is(pg_temp.q($$select trim_scale(counted_quantity)::text || '/' || trim_scale(expected_quantity)::text
     from public.item_verification_summaries('c5930000-0000-4000-8000-00000000000a', array['c5930000-0000-4000-8000-0000000000d1']::uuid[])$$),
  '7/5', 'F6 viewer: and the card''s counted and on-record quantities');

set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.q($$select min(total_count)::text from public.cycle_counts_page('c5930000-0000-4000-8000-00000000000a', p_page_size => 100)$$),
  '2', 'F7 counter: cycle_counts_page totals her 2 counts');
select is(pg_temp.q($$select total::text || '/' || counted::text from public.cycle_count_summary('c5930000-0000-4000-8000-0000000000e1')$$),
  '2/1', 'F8 counter: cycle_count_summary unchanged');
select is(pg_temp.q($$select min(full_count)::text from public.cycle_count_lines_page('c5930000-0000-4000-8000-0000000000e1')$$),
  '2', 'F9 counter: cycle_count_lines_page unchanged');
select is(pg_temp.q($$select string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total || '/' || line_counted, ' ' order by pg_temp.lbl(cycle_count_id) collate "C")
     from public.cycle_count_line_progress('c5930000-0000-4000-8000-00000000000a',
       array['c5930000-0000-4000-8000-0000000000e1', 'c5930000-0000-4000-8000-0000000000e3']::uuid[])$$),
  'done:2/2 n:2/1', 'F10 counter: cycle_count_line_progress unchanged');
select is(pg_temp.q($$select pg_temp.lbl(cycle_count_id) || '/' || pg_temp.lbl(open_count_id)
     from public.item_verification_summaries('c5930000-0000-4000-8000-00000000000a', array['c5930000-0000-4000-8000-0000000000d1']::uuid[])$$),
  'done/n', 'F11 counter: the Physical count card unchanged');

set local "request.jwt.claim.sub" to :'stOff';
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c5930000-0000-4000-8000-00000000000a',
     array['c5930000-0000-4000-8000-0000000000e1']::uuid[])$$),
  '0', 'F12 staff with both count permissions revoked: no progress row');
set local "request.jwt.claim.sub" to :'audN';
select is(pg_temp.q($$select string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total || '/' || line_counted, ' ')
     from public.cycle_count_line_progress('c5930000-0000-4000-8000-00000000000a',
       array['c5930000-0000-4000-8000-0000000000e1']::uuid[])$$),
  'n:2/1', 'F13 auditor: progress as the line rule lets her read');
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.q($$select string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total || '/' || line_counted, ' ' order by pg_temp.lbl(cycle_count_id) collate "C")
     from public.cycle_count_line_progress('c5930000-0000-4000-8000-00000000000a',
       array['c5930000-0000-4000-8000-0000000000e1', 'c5930000-0000-4000-8000-0000000000e2']::uuid[])$$),
  'n:2/1 s:1/0', 'F14 manager: progress of every count');
set local "request.jwt.claim.sub" to :'mgrOff';
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c5930000-0000-4000-8000-00000000000a',
     array['c5930000-0000-4000-8000-0000000000e1']::uuid[])$$),
  '0', 'F15 manager with both count permissions revoked: no progress row');

-- ══ E. exception_recount_facts ═══════════════════════════════════════════
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.facts(array[:'occA']::uuid[]),
  'done:c:completed:-/-:true:7/5:true n:a:in_progress:1/2:true:4/5:true',
  'E1 viewer North: the open recount (1 of 2 counted, the item''s line 4 against 5) and the closed recount (7 against 5) of an exception she can read');
select is(pg_temp.facts(array[:'occS']::uuid[]), '(none)',
  'E2 viewer North: nothing for an exception on a South item she cannot read');
select is(pg_temp.facts(array[:'occX']::uuid[]), '(none)',
  'E3 viewer North: nothing for another organization''s exception asked under her organization');
select is(pg_temp.facts(array[:'occX']::uuid[], :'org2'), '(none)',
  'E3b viewer North: nothing when she names the other organization');
select is(pg_temp.facts(array[:'occC']::uuid[]), 'done:n:completed:-/-:-:-/-:true',
  'E4 viewer North: a confirmed exception gives the confirming count''s number and status only');
select is(pg_temp.facts(array[:'occA', :'occS', :'occX']::uuid[]),
  'done:c:completed:-/-:true:7/5:true n:a:in_progress:1/2:true:4/5:true',
  'E5 viewer North: a mixed request answers only the exception she can read');
select is(pg_temp.q($$select count(*)::text from public.exception_recount_facts('c5930000-0000-4000-8000-00000000000a', array['c5930000-0000-4000-8000-0000000000f1']::uuid[]) f
     where f.counted_quantity is not null and f.counted_quantity not in (4, 7)$$),
  '0', 'E6 viewer North: no line of another item of the count (iN2, iN3) is returned');

set local "request.jwt.claim.sub" to :'vwAll';
select is(pg_temp.facts(array[:'occS']::uuid[]), 'n:a:in_progress:1/2:false:-/-:true',
  'E7 flag viewer: the South exception''s recount, which holds no line of its item: no line, never another item''s');

set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.facts(array[:'occA']::uuid[]),
  'done:c:completed:-/-:true:7/5:true n:a:in_progress:1/2:true:4/5:true',
  'E8 counter: the same facts');
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.facts(array[:'occA', :'occS', :'occC']::uuid[]),
  'done:c:completed:-/-:true:7/5:true n:a:in_progress:1/2:true:4/5:true n:a:in_progress:1/2:false:-/-:true done:n:completed:-/-:-:-/-:true',
  'E9 manager: every exception of the organization');
select is(pg_temp.facts(array[:'occX']::uuid[]), '(none)', 'E10 manager: nothing of another organization');
set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.facts(array[:'occX']::uuid[], :'org2'), 'x:a:in_progress:0/1:true:-/5:true',
  'E11 another organization''s manager: his own exception');
select is(pg_temp.facts(array[:'occX']::uuid[]), '(none)',
  'E11b and nothing of it when asked under an organization he is not a member of');
select is(pg_temp.facts(array[:'occA']::uuid[]), '(none)', 'E12 and nothing of this organization');
select is(pg_temp.facts(array[:'occA']::uuid[], :'org2'), '(none)', 'E12b nor of this organization''s exception named under his own');
set local "request.jwt.claim.sub" to :'seatExp';
select is(pg_temp.facts(array[:'occA']::uuid[]), '(none)', 'E13 an expired Act-as seat gets nothing');
set local "request.jwt.claim.sub" to :'seatLive';
select is(pg_temp.facts(array[:'occA']::uuid[]),
  'done:c:completed:-/-:true:7/5:true n:a:in_progress:1/2:true:4/5:true',
  'E14 a live Act-as seat gets what its role reads');
select is(pg_temp.facts(null::uuid[]), '(none)', 'E15 no ids: no rows');
select is(pg_temp.q($$select count(*)::text from public.exception_recount_facts('c5930000-0000-4000-8000-00000000000a',
     (select array_agg(gen_random_uuid()) from generate_series(1, 501)))$$),
  'ERROR 22023', 'E16 more than 500 ids are refused (22023)');

set local role anon;
set local "request.jwt.claim.role" to 'anon';
set local "request.jwt.claim.sub" to '';
select is(pg_temp.facts(array[:'occA']::uuid[]), 'ERROR 42501', 'E17 anon cannot call exception_recount_facts');
select ok(pg_temp.q('select count(*)::text from public.cycle_counts') in ('0', 'ERROR 42501'), 'C15 anon reads no count');
select ok(pg_temp.q('select count(*)::text from public.cycle_count_lines') in ('0', 'ERROR 42501'), 'L15 anon reads no line');

set local role service_role;
set local "request.jwt.claim.role" to 'service_role';
select is(pg_temp.counts_seen(), 'done n s x', 'C16 the service role (crons) reads every count');
select is(pg_temp.lines_seen(), 'done:2 n:2 s:1 x:1', 'L16 and every line');
select is(pg_temp.facts(array[:'occA']::uuid[]), '(none)', 'E18 the service role with no signed-in user gets no recount facts');

-- ══ S. Posture ═══════════════════════════════════════════════════════════
reset role;
select is(pg_temp.q($$select (p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     and pg_get_userbyid(p.proowner) = 'postgres')::text
     from pg_proc p where p.oid = 'public.exception_recount_facts(uuid, uuid[])'::regprocedure$$), 'true',
  'S1 exception_recount_facts: STABLE SECURITY DEFINER, search_path empty, owned by postgres');
select is(pg_temp.q($$select (has_function_privilege('authenticated', 'public.exception_recount_facts(uuid, uuid[])', 'execute')
     and has_function_privilege('service_role', 'public.exception_recount_facts(uuid, uuid[])', 'execute')
     and not has_function_privilege('anon', 'public.exception_recount_facts(uuid, uuid[])', 'execute'))::text$$), 'true',
  'S2 exception_recount_facts: authenticated and service_role execute, anon does not');
select is(pg_temp.q($$select count(*)::text from information_schema.routine_privileges
     where routine_schema = 'public' and routine_name = 'exception_recount_facts' and grantee = 'PUBLIC'$$), '0',
  'S3 exception_recount_facts: no EXECUTE for PUBLIC');
select is(pg_temp.q($$select (p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public']
     and pg_get_userbyid(p.proowner) = 'postgres')::text
     from pg_proc p where p.oid = 'public.cycle_count_line_progress(uuid, uuid[])'::regprocedure$$), 'true',
  'S4 cycle_count_line_progress stays STABLE SECURITY DEFINER, search_path public, owned by postgres');
select is(pg_temp.q($$select (has_function_privilege('authenticated', 'public.cycle_count_line_progress(uuid, uuid[])', 'execute')
     and not has_function_privilege('anon', 'public.cycle_count_line_progress(uuid, uuid[])', 'execute'))::text$$), 'true',
  'S5 cycle_count_line_progress keeps its grants');
select is(pg_temp.q($$select string_agg(polname, ',' order by polname) from pg_policy
     where polrelid in ('public.cycle_counts'::regclass, 'public.cycle_count_lines'::regclass)
       and pg_get_expr(polqual, polrelid) like '%rls_orgs_with_permission(''cycle_counts:read''::text)%'
       and pg_get_expr(polqual, polrelid) like '%rls_orgs_with_permission(''stock:adjust''::text)%'
       and pg_get_expr(polqual, polrelid) not like '%has_permission(%'$$),
  'cycle_count_lines_select,cycle_counts_select',
  'S6 both read rules ask the two permissions through the hashed set helper (once per statement), never has_permission per row');
select is(pg_temp.q($$select string_agg(polname, ',' order by polname) from pg_policy
     where polrelid in ('public.cycle_counts'::regclass, 'public.cycle_count_lines'::regclass)
       and polcmd = 'r'$$),
  'cycle_count_lines_select,cycle_counts_select', 'S7 still one read rule on each table');
select is(pg_temp.q($$select string_agg(polname, ',' order by polname) from pg_policy
     where polrelid = 'public.cycle_counts'::regclass
       and pg_get_expr(polqual, polrelid) like '%rls_all_warehouses_org_ids()%'
       and pg_get_expr(polqual, polrelid) like '%my_warehouse_ids()%'
       and pg_get_expr(polqual, polrelid) like '%rls_cc_unheaded_count_ids()%'$$),
  'cycle_counts_select', 'S8 the count rule keeps 0452''s warehouse terms');
select is(pg_temp.q($$select string_agg(polname, ',' order by polname) from pg_policy
     where polrelid = 'public.cycle_count_lines'::regclass
       and pg_get_expr(polqual, polrelid) like '%rls_manager_org_ids()%'
       and pg_get_expr(polqual, polrelid) like '%my_warehouse_ids()%'
       and pg_get_expr(polqual, polrelid) like '%inventory_items%'$$),
  'cycle_count_lines_select', 'S9 the line rule keeps 0452''s warehouse and item terms');

-- ══ The other read rules' writes: a counter still records, a viewer does not ═
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.q_rb($$with u as (update public.cycle_count_lines set counted_quantity = 3
     where cycle_count_id = 'c5930000-0000-4000-8000-0000000000e1' and item_id = 'c5930000-0000-4000-8000-0000000000d2'
     returning 1) select count(*)::text from u$$),
  '1', 'W1 counter: records a line of her count and reads it back');
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.q_rb($$with u as (update public.cycle_count_lines set counted_quantity = 3
     where cycle_count_id = 'c5930000-0000-4000-8000-0000000000e1' returning 1) select count(*)::text from u$$),
  '0', 'W2 viewer: records no line');
set local "request.jwt.claim.sub" to :'vwAdj';
select is(pg_temp.q_rb($$with u as (update public.cycle_count_lines set counted_quantity = 2, counted_by = 'c5930000-0000-4000-8000-0000000000aa', counted_at = now()
     where cycle_count_id = 'c5930000-0000-4000-8000-0000000000e1' and item_id = 'c5930000-0000-4000-8000-0000000000d1'
     returning 1) select count(*)::text from u$$),
  '0', 'W3 viewer granted stock:adjust: reads but records no line (the update rule asks staff)');

-- ══ Manager role override revoking both (an organization's own choice) ═══
reset role;
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:'org', 'staff', 'cycle_counts:read', false), (:'org', 'staff', 'stock:adjust', false);
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.counts_seen(), '(none)', 'C17 an organization that revokes both permissions from staff: staff read no count');
select is(pg_temp.lines_seen(), '(none)', 'L17 nor any line');
select is(pg_temp.facts(array[:'occA']::uuid[]),
  'done:c:completed:-/-:true:7/5:true n:a:in_progress:1/2:true:4/5:true',
  'E19 and still get the recount facts of an exception they can read (the Exception Center)');
set local "request.jwt.claim.sub" to :'stRead';
select is(pg_temp.counts_seen(), '(none)', 'C18 the role override reaches staff who had one permission left');
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.counts_seen(), 'done n s', 'C19 managers are untouched by a staff role override');
reset role;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'org', :'stN', 'cycle_counts:read', true);
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.counts_seen(), 'done n', 'C20 a per-member grant wins over the role override');
select is(pg_temp.lines_seen(), 'done:2 n:2', 'L20 and the lines');

-- ══ Cost: the line read of one count asks no permission per row ══════════
-- EXPLAIN (ANALYZE, VERBOSE) as the counter: every node that computes a
-- permission set runs once (loops=1) for a count with two lines, and the
-- rules probe the sets as hashed subplans.
reset role;
create function pg_temp.plan_lines(p_uid uuid) returns text[] language plpgsql as $$
declare r text[] := '{}'; l text;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  for l in execute 'explain (analyze, verbose, costs off, timing off, summary off) select * from public.cycle_count_lines where cycle_count_id = ''c5930000-0000-4000-8000-0000000000e1''' loop
    r := r || l;
  end loop;
  reset role;
  return r;
end $$;
create function pg_temp.permission_set_loops(p_plan text[]) returns text language sql as $$
  select 'sets=' || count(*) || ' run_once_or_never=' || count(*) filter (
           where p_plan[i - 1] like '%loops=1)%' or p_plan[i - 1] like '%never executed%')
    from generate_subscripts(p_plan, 1) i
   where i > 1 and p_plan[i] like '%Output:%rls_orgs_with_permission(%' $$;
select is(pg_temp.permission_set_loops(pg_temp.plan_lines(:'stN')), 'sets=4 run_once_or_never=4',
  'P1 the counter''s line read computes each of the four permission sets at most once (loops=1), not per row');
select ok(array_to_string(pg_temp.plan_lines(:'stN'), E'\n') ilike '%hashed SubPlan%'
      and array_to_string(pg_temp.plan_lines(:'stN'), E'\n') not like '%has_permission(%',
  'P2 the rules probe hashed sets and call has_permission on no row');

-- ══ G. Parity with the first form, edges, cost ════════════════════════════
reset role;
-- Fixtures as the superuser with no request claims (the count number
-- trigger reads them).
set local "request.jwt.claim.role" to '';
set local "request.jwt.claim.sub" to '';
\set vwDis    c5930000-0000-4000-8000-0000000000ad
\set lN       c5930000-0000-4000-8000-0000000000c4
\set lS       c5930000-0000-4000-8000-0000000000c5
\set cBig     c5930000-0000-4000-8000-0000000000e4
\set occN3    c5930000-0000-4000-8000-0000000000f4
\set occH1    c5930000-0000-4000-8000-0000000000f5
\set occH2    c5930000-0000-4000-8000-0000000000f6
\set occD     c5930000-0000-4000-8000-0000000000f7

-- The first form of exception_recount_facts, verbatim but for its name.
create function public.s93_facts_first_form(p_org uuid, p_exception_ids uuid[])
returns table (
  exception_id      uuid,
  cycle_count_id    uuid,
  is_active_recount boolean,
  is_closed_recount boolean,
  count_number      bigint,
  status            text,
  completed_at      timestamptz,
  line_total        bigint,
  line_counted      bigint,
  line_found        boolean,
  counted_quantity  numeric,
  expected_quantity numeric,
  rechecks          boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Gate 1: a signed-in caller, arguments present, at most 500 ids.
  if auth.uid() is null or p_org is null or p_exception_ids is null then
    return;
  end if;
  if cardinality(p_exception_ids) > 500 then
    raise exception 'too_many_exceptions' using errcode = '22023', hint = 'too_many_exceptions';
  end if;
  -- Gate 2: an accepted, enabled member of the organization asked about.
  if not public.is_org_member(p_org) then
    return;
  end if;

  return query
  with occ as materialized (
    -- Gate 3, per exception: of p_org, and the caller may see it (0370's
    -- one rule: member, can read the item, and for a holding rule can see
    -- the holding).
    select o.id, o.organization_id, o.item_id, o.recount_cycle_count_id, o.confirmed_cycle_count_id
      from public.exception_occurrences o
     where o.id = any (p_exception_ids)
       and o.organization_id = p_org
       and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
  ),
  named as (
    -- The counts the exception names: its open recount, the count that
    -- confirmed it, and every count its timeline names.
    select n.exception_id, n.cycle_count_id, bool_or(n.active) as active, bool_or(n.closed) as closed
      from (
        select x.id as exception_id, x.recount_cycle_count_id as cycle_count_id, true as active, false as closed
          from occ x
         where x.recount_cycle_count_id is not null
        union all
        select x.id, x.confirmed_cycle_count_id, false, false
          from occ x
         where x.confirmed_cycle_count_id is not null
        union all
        select x.id, e.cycle_count_id, false, e.kind = 'recount_closed'
          from occ x
          join public.exception_occurrence_events e
            on e.occurrence_id = x.id
           and e.organization_id = x.organization_id
         where e.cycle_count_id is not null
      ) n
     group by n.exception_id, n.cycle_count_id
  )
  select nm.exception_id,
         c.id,
         nm.active,
         nm.closed,
         c.count_number::bigint,
         c.status::text,
         c.completed_at,
         pr.line_total,
         pr.line_counted,
         case when wl.with_line then l.id is not null end,
         case when wl.with_line then l.counted_quantity::numeric end,
         case when wl.with_line then l.expected_quantity::numeric end,
         case when wl.with_line and l.id is not null then public.cycle_count_line_rechecks(l) end
    from named nm
    join occ x on x.id = nm.exception_id
    join public.cycle_counts c
      on c.id = nm.cycle_count_id
     and c.organization_id = x.organization_id
    -- The item's line, for a recount that is open or posted (what the
    -- outcome words read).
    cross join lateral (
      select (nm.active or nm.closed) and c.status::text in ('in_progress', 'completed') as with_line
    ) wl
    left join public.cycle_count_lines l
      on wl.with_line
     and l.cycle_count_id = c.id
     and l.item_id = x.item_id
    -- An open recount's progress: the lines the caller's warehouses hold
    -- whose item they may read (a manager: every line), as 0452's line rule
    -- reads them.
    left join lateral (
      select count(*)::bigint as line_total,
             count(*) filter (where pl.counted_quantity is not null)::bigint as line_counted
        from public.cycle_count_lines pl
       where pl.cycle_count_id = c.id
         and (
           c.organization_id in (select public.rls_manager_org_ids())
           or (
             pl.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
             and exists (
               select 1 from public.inventory_items i
                where i.id = pl.item_id
                  and (
                    i.warehouse_id in (select public.rls_inv_read_full_warehouse_ids())
                    or (i.charter_id is null
                        and i.warehouse_id in (select public.rls_inv_read_assigned_warehouse_ids()))
                    or (i.warehouse_id, i.charter_id) in (select * from public.rls_inv_read_warehouse_charter_ids())
                  )
                  and (
                    i.organization_id in (select public.rls_cat_unrestricted_org_ids())
                    or (i.organization_id, i.category_id) in (select * from public.rls_cat_allowed_category_ids())
                  )
             )
           )
         )
    ) pr
      on (nm.active or nm.closed) and c.status::text = 'in_progress'
   order by nm.exception_id, c.id;
end;
$$;
alter function public.s93_facts_first_form(uuid, uuid[]) owner to postgres;
grant execute on function public.s93_facts_first_form(uuid, uuid[]) to authenticated;

insert into auth.users (id, email, raw_user_meta_data)
values (:'vwDis', 'uad-s93@test.local', '{}') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses)
values (:'org', :'vwDis', 'viewer', now(), false) on conflict do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id)
values (:'org', :'vwDis', :'whN') on conflict do nothing;
update public.user_profiles set disabled_at = now() where id = :'vwDis';
insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:'lN', :'org', :'whN', 'S93 North bin', 'bin'), (:'lS', :'org', :'whS', 'S93 South bin', 'bin')
  on conflict (id) do nothing;
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
select ('c5930000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, :'org', :'whN', 'S93-B' || g, 'S93 big ' || g, 5, 'active', 'none'
  from generate_series(1, 2000) g;
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to, started_at) values
  (:'cBig', :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null, now() - interval '30 minutes');
set local session_replication_role = replica;
-- cS (South) also holds a line of the North item iN3, stored under South.
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity, counted_by, counted_at) values
  (:'cS', :'iN3', :'whS', 5, 6, :'mgr', now() - interval '5 minutes');
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity, counted_by, counted_at)
select :'cBig', ('c5930000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, :'whN', 5,
       case when g % 2 = 0 then 5 end, case when g % 2 = 0 then :'mgr'::uuid end, case when g % 2 = 0 then now() end
  from generate_series(1, 2000) g;
set local session_replication_role = origin;
--   occN3  North item iN3, its recount the South count cS (line stored under South)
--   occH1  a holding rule at a North location, recount cN
--   occH2  a holding rule at a South location on the North item iN1, recount cN
--   occD   North item iN3, cleared, its recount the posted count cDone
--   200 exceptions on the first 200 items of cBig, each with cBig as its recount
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, recount_cycle_count_id) values
  (:'occN3', :'org', 10, 'count_variance', :'iN3', null, :'whN', now(), now(), :'cS'),
  (:'occH1', :'org', 11, 'orphaned_stock', :'iN2', :'lN', :'whN', now(), now(), :'cN'),
  (:'occH2', :'org', 12, 'orphaned_stock', :'iN1', :'lS', :'whS', now(), now(), :'cN');
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, recount_cycle_count_id, resolved_at, resolved_reason) values
  (:'occD',  :'org', 13, 'count_variance', :'iN3', null, :'whN', now(), now(), :'cDone', now(), 'cleared');
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, recount_cycle_count_id)
select ('c5930000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid, :'org', 100 + g, 'count_variance',
       ('c5930000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, null, :'whN', now(), now(), :'cBig'
  from generate_series(1, 200) g;
insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, cycle_count_id) values
  (:'org', :'occN3', 'recount_linked', :'cS'),
  (:'org', :'occH1', 'recount_linked', :'cN'),
  (:'org', :'occH2', 'recount_linked', :'cN'),
  (:'org', :'occD',  'recount_linked', :'cDone'),
  (:'org', :'occD',  'recount_closed', :'cDone'),
  (:'org', :'occD',  'recount_linked', :'cN');
analyze public.cycle_count_lines;
analyze public.exception_occurrences;

-- The first form's answer and today's, as one text each, for one caller.
create function pg_temp.parity(p_uid uuid, p_org uuid, p_ids uuid[]) returns text language plpgsql as $$
declare a text; b text; n int;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  select coalesce(string_agg(f::text, ';' order by f::text), ''), count(*) into a, n
    from public.s93_facts_first_form(p_org, p_ids) f;
  select coalesce(string_agg(f::text, ';' order by f::text), '') into b
    from public.exception_recount_facts(p_org, p_ids) f;
  reset role;
  return case when a = b then 'same:' || n else 'differ' end;
end $$;
create function pg_temp.parity_all() returns text language plpgsql as $$
declare
  ids uuid[] := array['c5930000-0000-4000-8000-0000000000f1', 'c5930000-0000-4000-8000-0000000000f2',
                      'c5930000-0000-4000-8000-0000000000f3', 'c5930000-0000-4000-8000-0000000000f9',
                      'c5930000-0000-4000-8000-0000000000f4', 'c5930000-0000-4000-8000-0000000000f5',
                      'c5930000-0000-4000-8000-0000000000f6', 'c5930000-0000-4000-8000-0000000000f7',
                      'c5930000-0000-4000-a000-000000000001', 'c5930000-0000-4000-a000-000000000002',
                      gen_random_uuid()]::uuid[];
  who uuid; o uuid; r text; bad text := ''; rows int := 0;
begin
  foreach who in array array['c5930000-0000-4000-8000-0000000000a0', 'c5930000-0000-4000-8000-0000000000a1',
      'c5930000-0000-4000-8000-0000000000a2', 'c5930000-0000-4000-8000-0000000000a3',
      'c5930000-0000-4000-8000-0000000000a4', 'c5930000-0000-4000-8000-0000000000a5',
      'c5930000-0000-4000-8000-0000000000a6', 'c5930000-0000-4000-8000-0000000000a7',
      'c5930000-0000-4000-8000-0000000000a8', 'c5930000-0000-4000-8000-0000000000a9',
      'c5930000-0000-4000-8000-0000000000aa', 'c5930000-0000-4000-8000-0000000000ab',
      'c5930000-0000-4000-8000-0000000000ac', 'c5930000-0000-4000-8000-0000000000ad',
      'c5930000-0000-4000-8000-0000000000b1']::uuid[] loop
    foreach o in array array['c5930000-0000-4000-8000-00000000000a', 'c5930000-0000-4000-8000-00000000000b']::uuid[] loop
      r := pg_temp.parity(who, o, ids);
      if r = 'differ' then bad := bad || right(who::text, 2) || '@' || right(o::text, 1) || ' ';
      else rows := rows + split_part(r, ':', 2)::int; end if;
    end loop;
  end loop;
  return case when bad = '' then 'same rows=' || rows else 'differ: ' || bad end;
end $$;
-- Lines of cycle_count_lines this transaction has read so far.
create function pg_temp.lines_read_so_far() returns bigint language sql as $$
  select coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)
    from pg_stat_xact_user_tables where relid = 'public.cycle_count_lines'::regclass $$;
-- One call of exception_recount_facts for the 200 exceptions on cBig:
-- its row count and the lines it read.
create function pg_temp.big_call(p_uid uuid) returns text language plpgsql as $$
declare b0 bigint; n int; ids uuid[];
begin
  select array_agg(('c5930000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid) into ids from generate_series(1, 200) g;
  b0 := pg_temp.lines_read_so_far();
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  select count(*) into n from public.exception_recount_facts('c5930000-0000-4000-8000-00000000000a', ids);
  reset role;
  return 'rows=' || n || ' lines_read_under_6000=' || ((pg_temp.lines_read_so_far() - b0) < 6000)::text;
end $$;

select is(pg_temp.parity_all(), 'same rows=119',
  'G1 every persona, under both organizations: exception_recount_facts answers row for row what its first form answers');
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.facts(array[:'occH1']::uuid[]), 'n:a:in_progress:1/2:true:-/5:true',
  'G2 viewer North: a holding rule at a North location gives its recount');
select is(pg_temp.facts(array[:'occH2']::uuid[]), '(none)',
  'G3 viewer North: nothing for a holding rule at a South location');
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.facts(array[:'occH2']::uuid[]), 'n:a:in_progress:1/2:true:4/5:true',
  'G4 manager: the holding rule at the South location');
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.q($$select (select count(*) from public.cycle_counts where id = 'c5930000-0000-4000-8000-0000000000e2')
       || ' ' || (select count(*) from public.cycle_count_lines where cycle_count_id = 'c5930000-0000-4000-8000-0000000000e2')$$)
     || ' ' || pg_temp.facts(array[:'occN3']::uuid[]),
  '0 0 s:a:in_progress:0/0:true:6/5:true',
  'G5 counter of North and a South count holding her North item: 0 counts and 0 lines read directly; through exception_recount_facts the count''s number and status and her item''s line, with progress over her warehouses'' lines');
reset role;
select is(pg_temp.big_call(:'vwN'), 'rows=200 lines_read_under_6000=true',
  'G6 viewer: 200 exceptions on one 2,000-line open count read each line about once');
select is(pg_temp.big_call(:'mgr'), 'rows=200 lines_read_under_6000=true',
  'G7 manager: the same');
select is(pg_temp.q($$select pg_get_function_result('public.exception_recount_facts(uuid, uuid[])'::regprocedure)$$),
  'TABLE(exception_id uuid, cycle_count_id uuid, is_active_recount boolean, is_closed_recount boolean, count_number bigint, status text, completed_at timestamp with time zone, line_total bigint, line_counted bigint, line_found boolean, counted_quantity numeric, expected_quantity numeric, rechecks boolean)',
  'S10 exception_recount_facts returns these thirteen columns');
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'vwDis';
select is(pg_temp.counts_seen(), '(none)', 'C21 a disabled account reads no count');
select is(pg_temp.facts(array[:'occA']::uuid[]), '(none)', 'E20 a disabled account gets no recount facts');
reset role;

select * from finish();
rollback;
