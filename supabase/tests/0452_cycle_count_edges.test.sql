-- supabase/tests/0452_cycle_count_edges.test.sql
-- pgTAP proof for migration 0452, second file: the edges of the count rules,
-- the item page's count facts, and who files an AI scan row.
--
-- V. item_verification_summaries gives an item's last count and its open
--    count only from a count line the caller may read (the line read
--    rule); the item's own fields are the same for every caller who may read
--    the item. A manager gets every count.
-- D. It counts the movements since a count past the caller's movement rule
--    (SECURITY DEFINER): a member who reads the item and its count line but
--    none of its movements gets the true number.
-- E. A line with no warehouse (managers only); a line whose warehouse is not
--    its header's, both ways; a disabled account; a member who is staff in
--    one organization and manager in another; a scan photo path whose
--    organization is not its count's, or whose count id is upper case; a
--    member with the all-warehouses flag and no assignment rows.
-- I. An AI scan row is filed by a manager, or by staff holding stock:adjust
--    on a count assigned to them or to no one.
-- P. For every persona, the item page's last count and open count equal
--    what the caller reads directly from cycle_count_lines under the line
--    rule.
-- S. Posture of the restated function.
--
-- Fixtures as the test superuser; reads and writes as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace c548e000.
begin;
select plan(70);

\set org    c548e000-0000-4000-8000-00000000000a
\set org2   c548e000-0000-4000-8000-00000000000b
\set mgr    c548e000-0000-4000-8000-0000000000a1
\set stN    c548e000-0000-4000-8000-0000000000a2
\set stS    c548e000-0000-4000-8000-0000000000a3
\set vwF    c548e000-0000-4000-8000-0000000000a4
\set flag0  c548e000-0000-4000-8000-0000000000a5
\set dis    c548e000-0000-4000-8000-0000000000a6
\set multi  c548e000-0000-4000-8000-0000000000a7
\set stN2   c548e000-0000-4000-8000-0000000000a8
\set stNoAdj c548e000-0000-4000-8000-0000000000a9
\set stX    c548e000-0000-4000-8000-0000000000aa
\set mgr2   c548e000-0000-4000-8000-0000000000b1
\set whN    c548e000-0000-4000-8000-0000000000c1
\set whS    c548e000-0000-4000-8000-0000000000c2
\set whX    c548e000-0000-4000-8000-0000000000c3
\set iN1    c548e000-0000-4000-8000-0000000000d1
\set iS1    c548e000-0000-4000-8000-0000000000d2
\set iNull  c548e000-0000-4000-8000-0000000000d3
\set iMove  c548e000-0000-4000-8000-0000000000d4
\set iMoveOpen c548e000-0000-4000-8000-0000000000d5
\set iCnt   c548e000-0000-4000-8000-0000000000d6
\set iX     c548e000-0000-4000-8000-0000000000d7
\set cN     c548e000-0000-4000-8000-0000000000e1
\set cS     c548e000-0000-4000-8000-0000000000e2
\set cDone  c548e000-0000-4000-8000-0000000000e3
\set cDoneN c548e000-0000-4000-8000-0000000000e4
\set cNa    c548e000-0000-4000-8000-0000000000e5
\set cX     c548e000-0000-4000-8000-0000000000e9

-- A value, or 'ERROR <sqlstate>'.
create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return coalesce(r, '(null)');
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- Rows a write affects, then undone (a subtransaction), or 'ERROR <sqlstate>'.
create function pg_temp.n_rb(p_sql text) returns text language plpgsql as $$
declare c int;
begin
  begin
    execute p_sql;
    get diagnostics c = row_count;
    raise exception using errcode = 'P0S48', message = c::text;
  exception when sqlstate 'P0S48' then
    return sqlerrm;
  end;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

-- The same query as another persona (the claim is transaction-local).
create function pg_temp.as_(p_uid uuid, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  return pg_temp.q(p_sql);
end $$;

create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case right(p::text, 2)
    when 'e1' then 'cN' when 'e2' then 'cS' when 'e3' then 'cDone' when 'e4' then 'cDoneN'
    when 'e5' then 'cNa' when 'e9' then 'cX'
    when 'd1' then 'iN1' when 'd2' then 'iS1' when 'd3' then 'iNull' when 'd4' then 'iMove'
    when 'd5' then 'iMoveOpen' when 'd6' then 'iCnt' when 'd7' then 'iX'
    when 'a1' then 'mgr' when 'a2' then 'stN' when 'a3' then 'stS'
    else right(p::text, 4) end $$;

create function pg_temp.counts_seen() returns text language sql as $$
  select coalesce(string_agg(pg_temp.lbl(id), ' ' order by pg_temp.lbl(id) collate "C"), '(none)')
    from public.cycle_counts where id::text like 'c548e000-%' $$;
create function pg_temp.lines_seen() returns text language sql as $$
  select coalesce(string_agg(l || ':' || i, ' ' order by l collate "C"), '(none)')
    from (select pg_temp.lbl(cycle_count_id) l,
                 string_agg(pg_temp.lbl(item_id), ',' order by pg_temp.lbl(item_id) collate "C") i
            from public.cycle_count_lines where cycle_count_id::text like 'c548e000-%' group by 1) s $$;
create function pg_temp.objects_seen() returns text language sql as $$
  select coalesce(string_agg(split_part(name, '/', 3), ' ' order by split_part(name, '/', 3) collate "C"), '(none)')
    from storage.objects where bucket_id = 'cycle-count-scans' and lower(name) like 'c548e000-%' $$;
-- The item page's count facts for one item: last count, its quantity and
-- counter, movements since, then the open count.
create function pg_temp.facts(p_item uuid) returns text language sql as $$
  select coalesce(string_agg(
           coalesce(pg_temp.lbl(v.cycle_count_id), '-') || '|' || coalesce(trim_scale(v.counted_quantity)::text, '-')
           || '|' || coalesce(pg_temp.lbl(v.counted_by), '-') || '|' || coalesce(v.movements_since::text, '-')
           || '|' || coalesce(v.count_number::text, '-') || '|' || coalesce(v.completed_at::text, '-')
           || '|open:' || coalesce(pg_temp.lbl(v.open_count_id), '-') || '|' || coalesce(v.open_count_number::text, '-'), ' '),
         '(no row)')
    from public.item_verification_summaries('c548e000-0000-4000-8000-00000000000a', array[p_item]) v $$;
-- The item's own fields on the same page.
create function pg_temp.item_fields(p_item uuid) returns text language sql as $$
  select coalesce(string_agg(concat_ws('|', v.item_status, v.item_is_rental, v.item_is_bundle, v.item_deleted,
           v.item_countable, trim_scale(v.quantity_on_hand)), ' '), '(no row)')
    from public.item_verification_summaries('c548e000-0000-4000-8000-00000000000a', array[p_item]) v $$;
create function pg_temp.scan_insert(p_count uuid, p_org uuid) returns text language sql as $$
  select pg_temp.n_rb(format(
    'insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, model_version) '
    || 'values (%L, %L, auth.uid(), %L, ''i'') returning id',
    p_org, p_count, p_org::text || '/' || p_count::text || '/i.webp')) $$;

-- ══ Fixture (as the test superuser) ═════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select u::uuid, 'edge-' || right(u, 2) || '-s48@test.local', '{}'
  from unnest(array[:'mgr', :'stN', :'stS', :'vwF', :'flag0', :'dis', :'multi', :'stN2', :'stNoAdj', :'stX', :'mgr2']) u
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'org', 'S48 Edge Org', 's48-edge-org'), (:'org2', 'S48 Edge Other', 's48-edge-other') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses, impersonation_expires_at) values
  (:'org', :'mgr', 'manager', now(), false, null),
  (:'org', :'stN', 'staff', now(), false, null),
  (:'org', :'stS', 'staff', now(), false, null),
  (:'org', :'vwF', 'viewer', now(), true, null),
  (:'org', :'flag0', 'staff', now(), true, null),
  (:'org', :'dis', 'staff', now(), false, null),
  (:'org', :'multi', 'staff', now(), false, null),
  (:'org2', :'multi', 'manager', now(), false, null),
  (:'org', :'stN2', 'staff', now(), false, null),
  (:'org', :'stNoAdj', 'staff', now(), false, null),
  (:'org', :'stX', 'staff', now(), false, null),
  (:'org2', :'mgr2', 'manager', now(), false, null)
  on conflict do nothing;
update public.user_profiles set disabled_at = now() where id = :'dis';
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'org', :'stNoAdj', 'stock:adjust', false);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whN', :'org', 'S48E North', 'S48EN', 'active'), (:'whS', :'org', 'S48E South', 'S48ES', 'active'),
  (:'whX', :'org2', 'S48E Other', 'S48EX', 'active') on conflict (id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:'org', :'stN', :'whN'), (:'org', :'stS', :'whS'), (:'org', :'dis', :'whN'), (:'org', :'multi', :'whN'),
  (:'org', :'stN2', :'whN'), (:'org', :'stNoAdj', :'whN'),
  (:'org', :'vwF', :'whN'), (:'org', :'vwF', :'whS')
  on conflict do nothing;
-- stX: South by her own row, and a row for North filed under the other
-- organization. The item read scope joins through the warehouse's
-- organization and lets her read North's items; my_warehouse_ids asks the
-- row's own organization and gives her South only, so the movement rule
-- (0321) shows her none of a North item's movements.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:'org', :'stX', :'whS'), (:'org2', :'stX', :'whN')
  on conflict do nothing;
-- The flagged staff member with no assignment rows (the flag's trigger, 0280,
-- gives rows on warehouse insert; this member has none).
delete from public.user_warehouse_assignments where user_id = :'flag0';
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:'iN1',  :'org', :'whN', 'S48E-N1', 'North one', 5, 'active', 'none'),
  (:'iS1',  :'org', :'whS', 'S48E-S1', 'South one', 5, 'active', 'none'),
  (:'iNull',:'org', null,   'S48E-NU', 'No warehouse', 5, 'active', 'none'),
  (:'iMove',:'org', :'whS', 'S48E-MV', 'Counted in South', 5, 'active', 'none'),
  (:'iMoveOpen', :'org', :'whN', 'S48E-MO', 'Open in North', 5, 'active', 'none'),
  (:'iCnt', :'org', :'whN', 'S48E-CN', 'Counted in North', 5, 'active', 'none'),
  (:'iX',   :'org2', :'whX', 'S48E-X1', 'Other one', 5, 'active', 'none')
  on conflict (id) do nothing;
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to, started_at) values
  (:'cN',     :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null,    now() - interval '2 hours'),
  (:'cS',     :'org', :'whS', 'warehouse', 'in_progress', :'mgr', null,    now() - interval '1 hour'),
  (:'cDone',  :'org', :'whS', 'warehouse', 'in_progress', :'mgr', null,    now() - interval '5 hours'),
  (:'cDoneN', :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null,    now() - interval '4 hours'),
  (:'cNa',    :'org', :'whN', 'warehouse', 'in_progress', :'mgr', :'stN2', now() - interval '3 hours'),
  (:'cX',     :'org2', :'whX', 'warehouse', 'in_progress', :'mgr2', null,  now() - interval '1 hour');
-- Lines as the superuser with triggers off, for the shapes the app does not
-- make by itself: a line whose warehouse is not its header's, a line with no
-- warehouse, an item moved after its count.
set local session_replication_role = replica;
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:'cN', :'iN1', :'whN', 5), (:'cN', :'iS1', :'whS', 5), (:'cN', :'iNull', null, 5), (:'cN', :'iMoveOpen', :'whN', 5),
  (:'cS', :'iS1', :'whS', 5), (:'cS', :'iN1', :'whN', 5),
  (:'cNa', :'iCnt', :'whN', 5),
  (:'cX', :'iX', :'whX', 5);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity, counted_by, counted_at) values
  (:'cDone',  :'iMove', :'whS', 5, 7, :'stS', now() - interval '4 hours'),
  (:'cDoneN', :'iCnt',  :'whN', 5, 4, :'stN', now() - interval '3 hours');
update public.cycle_counts set status = 'completed', completed_at = now() - interval '150 minutes', completed_by = :'mgr'
 where id in (:'cDone', :'cDoneN');
-- Moved after the count: iMove South to North (its last count is South's);
-- iMoveOpen North to South while its North count is open.
update public.inventory_items set warehouse_id = :'whN' where id = :'iMove';
update public.inventory_items set warehouse_id = :'whS' where id = :'iMoveOpen';
set local session_replication_role = origin;
-- Two movements of the moved item after its South count (the trigger stamps
-- a superuser's write as through the ledger).
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at) values
  (:'org', :'iMove', 'adjust', 1, 5, 6, now() - interval '1 hour'),
  (:'org', :'iMove', 'adjust', -1, 6, 5, now() - interval '30 minutes');
insert into storage.objects (bucket_id, name) values
  ('cycle-count-scans', :'org' || '/' || :'cS' || '/p_cs.webp'),
  ('cycle-count-scans', :'org2' || '/' || :'cS' || '/p_wrongorg.webp'),
  ('cycle-count-scans', :'org' || '/' || upper(:'cS') || '/p_upper.webp'),
  ('cycle-count-scans', :'org2' || '/' || :'cX' || '/p_cx.webp');
-- Every item of the fixture, and the latest counted line per item (the one
-- source of "last physical count", read here as the superuser).
create temporary table s48e_items on commit drop as
  select id from public.inventory_items where id::text like 'c548e000-%' and organization_id = :'org';
create temporary table s48e_latest on commit drop as
  select l.item_id, l.cycle_count_id from public._latest_count_lines(:'org', null) l;
grant select on s48e_items, s48e_latest to authenticated;

-- What the item page answers: item, last count, open count.
create function pg_temp.page_facts() returns text language plpgsql as $$
begin
  return (select coalesce(string_agg(pg_temp.lbl(v.item_id) || ':' || coalesce(pg_temp.lbl(v.cycle_count_id), '-')
                                     || ':' || coalesce(pg_temp.lbl(v.open_count_id), '-'),
                                     ' ' order by pg_temp.lbl(v.item_id) collate "C"), '(none)')
            from public.item_verification_summaries('c548e000-0000-4000-8000-00000000000a',
                   (select array_agg(id) from s48e_items)) v);
end $$;
-- What the caller reads directly under the line rule: the item's latest
-- counted line when it is readable, and the newest in-progress count among
-- the item's readable lines; for every item the caller reads.
create function pg_temp.direct_facts() returns text language plpgsql as $$
begin
  return (select coalesce(string_agg(pg_temp.lbl(i.id) || ':'
             || coalesce(pg_temp.lbl((select t.cycle_count_id from s48e_latest t
                                       where t.item_id = i.id
                                         and exists (select 1 from public.cycle_count_lines l
                                                      where l.cycle_count_id = t.cycle_count_id and l.item_id = i.id))), '-')
             || ':'
             || coalesce(pg_temp.lbl((select l.cycle_count_id from public.cycle_count_lines l
                                       join public.cycle_counts c on c.id = l.cycle_count_id
                                      where l.item_id = i.id
                                        and c.organization_id = 'c548e000-0000-4000-8000-00000000000a'
                                        and c.status = 'in_progress'
                                      order by c.started_at desc, c.id desc
                                      limit 1)), '-'),
             ' ' order by pg_temp.lbl(i.id) collate "C"), '(none)')
            from public.inventory_items i
           where i.id in (select id from s48e_items));
end $$;

set local "request.jwt.claim.sub" to :'stNoAdj';
select is(public.has_permission(:'org', 'stock:adjust'), false,
  'I0 fixture: the member whose stock:adjust is revoked does not hold it');
set local "request.jwt.claim.sub" to '';

-- ══ As each persona ══════════════════════════════════════════════════════
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';

-- V. The item page's count facts.
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.facts(:'iMove'), '-|-|-|-|-|-|open:-|-',
  'V1 staff North: an item now in North whose last count is a South line she cannot read: no count facts');
select is(pg_temp.as_(:'stN', $$select pg_temp.item_fields('c548e000-0000-4000-8000-0000000000d4')$$),
          pg_temp.as_(:'mgr', $$select pg_temp.item_fields('c548e000-0000-4000-8000-0000000000d4')$$),
  'V2 the same item''s own fields are the same for her and a manager');
set local "request.jwt.claim.sub" to :'mgr';
select ok(pg_temp.facts(:'iMove') like 'cDone|7|stS|2|%|open:-|-',
  'V3 manager: the same item''s last count is the South count, 7 counted by South staff, 2 movements since');
select ok(pg_temp.facts(:'iMoveOpen') like '-|-|-|-|-|-|open:cN|%',
  'V4 manager: the item moved to South is being counted in the North count');
select ok(pg_temp.facts(:'iN1') like '%|open:cS|%',
  'V5 manager: an item in two open counts gives the newest one');
set local "request.jwt.claim.sub" to :'stS';
select is(pg_temp.facts(:'iMoveOpen'), '-|-|-|-|-|-|open:-|-',
  'V6 staff South: the item now in South is in an open North count she cannot read: no open count');
select is(pg_temp.as_(:'stS', $$select pg_temp.item_fields('c548e000-0000-4000-8000-0000000000d5')$$),
          pg_temp.as_(:'mgr', $$select pg_temp.item_fields('c548e000-0000-4000-8000-0000000000d5')$$),
  'V7 that item''s own fields are the same for her and a manager');
set local "request.jwt.claim.sub" to :'stN';
select ok(pg_temp.facts(:'iN1') like '%|open:cN|%',
  'V8 staff North: of the two open counts holding a North item, the one whose line she may read');
select ok(pg_temp.facts(:'iCnt') like 'cDoneN|4|stN|0|%|open:cNa|%',
  'V9 staff North: a North item''s last count and open count, both North');
select is(pg_temp.q($$select count(*)::text from public.item_verification_summaries('c548e000-0000-4000-8000-00000000000a',
     array['c548e000-0000-4000-8000-0000000000d2']::uuid[])$$),
  '0', 'V10 staff North: an item she cannot read gets no row');
set local "request.jwt.claim.sub" to :'vwF';
select ok(pg_temp.facts(:'iMove') like 'cDone|7|stS|2|%',
  'V11 viewer with the flag and both warehouses: the South count of an item now in North');
set local "request.jwt.claim.sub" to :'flag0';
select is(pg_temp.facts(:'iCnt'), '(no row)',
  'V12 flagged staff with no assignment rows: no item, so no row');

-- E. Edges.
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.counts_seen(), 'cDone cDoneN cN cNa cS', 'E1 manager: every count of the organization');
select is(pg_temp.lines_seen(), 'cDone:iMove cDoneN:iCnt cN:iMoveOpen,iN1,iNull,iS1 cNa:iCnt cS:iN1,iS1',
  'E2 manager: every line, the one with no warehouse included');
select is(pg_temp.objects_seen(), 'p_cs.webp',
  'E3 manager: the photo whose path names its count''s organization; not one under another organization, not an upper-case count id');

set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.counts_seen(), 'cDoneN cN cNa', 'E4 staff North: the North counts');
select is(pg_temp.lines_seen(), 'cDoneN:iCnt cN:iN1 cNa:iCnt',
  'E5 staff North: North lines of items she may read; not the South line of the North count, not the line with no warehouse');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_lines where cycle_count_id = 'c548e000-0000-4000-8000-0000000000e1' and warehouse_id is null$$),
  '0', 'E6 staff North: the line with no warehouse is not hers');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_lines where cycle_count_id = 'c548e000-0000-4000-8000-0000000000e2'$$),
  '0', 'E7 staff North: the South count''s North line is not hers (the count is not)');

set local "request.jwt.claim.sub" to :'stS';
select is(pg_temp.counts_seen(), 'cDone cS', 'E8 staff South: the South counts');
select is(pg_temp.lines_seen(), 'cS:iS1',
  'E9 staff South: South lines of items she may read; not the North count''s South line, not the South count''s North line, not the South line of an item now in North');

set local "request.jwt.claim.sub" to :'vwF';
select is(pg_temp.counts_seen(), 'cDone cDoneN cN cNa cS', 'E10 viewer with the flag: every count');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_lines where warehouse_id is null and cycle_count_id::text like 'c548e000-%'$$),
  '0', 'E11 viewer with the flag: the line with no warehouse is a manager''s only');
select is(pg_temp.objects_seen(), '(none)', 'E12 viewer with the flag: no scan photo');

set local "request.jwt.claim.sub" to :'flag0';
select is(pg_temp.counts_seen(), 'cDone cDoneN cN cNa cS', 'E13 flagged staff with no assignment rows: every count');
select is(pg_temp.lines_seen(), '(none)', 'E14 flagged staff with no assignment rows: no line');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c548e000-0000-4000-8000-00000000000a',
     array['c548e000-0000-4000-8000-0000000000e1', 'c548e000-0000-4000-8000-0000000000e2']::uuid[])$$),
  '0', 'E15 flagged staff with no assignment rows: progress counts no line');

set local "request.jwt.claim.sub" to :'dis';
select is(pg_temp.counts_seen(), '(none)', 'E16 disabled account: no count');
select is(pg_temp.lines_seen(), '(none)', 'E17 disabled account: no line');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c548e000-0000-4000-8000-00000000000a',
     array['c548e000-0000-4000-8000-0000000000e1']::uuid[])$$),
  '0', 'E18 disabled account: no progress');
select is(pg_temp.q($$select count(*)::text from public.item_verification_summaries('c548e000-0000-4000-8000-00000000000a',
     array['c548e000-0000-4000-8000-0000000000d1']::uuid[])$$),
  '0', 'E19 disabled account: no item summary');
select is(pg_temp.scan_insert(:'cN', :'org'), 'ERROR 42501', 'E20 disabled account: files no AI scan row');

set local "request.jwt.claim.sub" to :'multi';
select is(pg_temp.counts_seen(), 'cDoneN cN cNa cX',
  'E21 staff North here and manager elsewhere: North counts here, every count there');
select is(pg_temp.lines_seen(), 'cDoneN:iCnt cN:iN1 cNa:iCnt cX:iX',
  'E22 the same member: North lines here, every line there');
select is(pg_temp.objects_seen(), 'p_cx.webp',
  'E23 the same member: scan photos of the organization she manages only');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c548e000-0000-4000-8000-00000000000a',
     array['c548e000-0000-4000-8000-0000000000e2']::uuid[])$$),
  '0', 'E24 the same member: progress of a South count here counts nothing');
select is(pg_temp.q($$select coalesce(sum(line_total), 0)::text from public.cycle_count_line_progress('c548e000-0000-4000-8000-00000000000b',
     array['c548e000-0000-4000-8000-0000000000e9']::uuid[])$$),
  '1', 'E25 the same member: progress of the count she manages counts its line');

set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.counts_seen(), 'cX', 'E26 the other organization''s manager: only her own count');
select is(pg_temp.objects_seen(), 'p_cx.webp',
  'E27 the other organization''s manager: not a photo filed under her organization for a count of another');

-- I. Who files an AI scan row (the route inserts with the member's own token).
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.scan_insert(:'cNa', :'org'), '1', 'I1 manager: on a count assigned to someone else');
set local "request.jwt.claim.sub" to :'stN2';
select is(pg_temp.scan_insert(:'cNa', :'org'), '1', 'I2 staff: on the count assigned to her, reading back its id');
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.scan_insert(:'cNa', :'org'), 'ERROR 42501', 'I3 staff: not on a count assigned to someone else');
select is(pg_temp.scan_insert(:'cN', :'org'), '1', 'I4 staff: on an unassigned count of her warehouse');
select is(pg_temp.scan_insert(:'cS', :'org'), 'ERROR 42501', 'I5 staff: not on a count she cannot read');
set local "request.jwt.claim.sub" to :'stNoAdj';
select is(pg_temp.scan_insert(:'cN', :'org'), 'ERROR 42501', 'I6 staff without stock:adjust: not even on an unassigned count');
set local "request.jwt.claim.sub" to :'flag0';
select is(pg_temp.scan_insert(:'cS', :'org'), '1', 'I7 flagged staff with no assignment rows: on an unassigned count');
set local "request.jwt.claim.sub" to :'vwF';
select is(pg_temp.scan_insert(:'cS', :'org'), 'ERROR 42501', 'I8 viewer: none');
set local "request.jwt.claim.sub" to :'multi';
select is(pg_temp.scan_insert(:'cNa', :'org'), 'ERROR 42501', 'I9 staff here: not on a count assigned to someone else');
select is(pg_temp.scan_insert(:'cX', :'org2'), '1', 'I10 the same member, manager there: on that organization''s count');
set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.scan_insert(:'cN', :'org'), 'ERROR 42501', 'I11 another organization''s manager: none here');

-- D. Movements since the count, counted past the caller's movement rule.
set local "request.jwt.claim.sub" to :'stX';
select is(pg_temp.q($$select count(*)::text from public.inventory_items where id = 'c548e000-0000-4000-8000-0000000000d4'$$),
  '1', 'D1 (control) stX reads the item now in North');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_lines where cycle_count_id = 'c548e000-0000-4000-8000-0000000000e3'$$),
  '1', 'D2 (control) stX reads its line in the South count');
select is(pg_temp.q($$select count(*)::text from public.stock_movements where item_id = 'c548e000-0000-4000-8000-0000000000d4'$$),
  '0', 'D3 (control) stX reads none of its movements under the movement rule');
select ok(pg_temp.facts(:'iMove') like 'cDone|7|stS|2|%',
  'D4 stX: the item page counts its 2 movements since the count (SECURITY DEFINER)');

-- P. The item page equals the direct read under the line rule, for every persona.
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P1 manager: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P2 staff North: the item page equals the direct read');
select ok(pg_temp.page_facts() like '%iCnt:cDoneN:cNa%' and pg_temp.page_facts() like '%iMove:-:-%',
  'P2b staff North: a North count shows, a South one does not (the parity is not vacuous)');
set local "request.jwt.claim.sub" to :'stS';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P3 staff South: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'vwF';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P4 viewer with the flag: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'flag0';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P5 flagged staff with no rows: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'dis';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P6 disabled account: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'multi';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P7 staff here, manager elsewhere: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'stN2';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P8 assignee staff: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'stNoAdj';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P9 staff without stock:adjust: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'stX';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P10 stX: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P11 the other organization''s manager: the item page equals the direct read');

reset role;

-- S. Posture.
select is((select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public']
             and pg_get_userbyid(p.proowner) = 'postgres'
             from pg_proc p where p.oid = 'public.item_verification_summaries(uuid,uuid[])'::regprocedure),
  true, 'S1 item_verification_summaries keeps STABLE SECURITY DEFINER, search_path public, owner postgres');
select is((select proacl::text from pg_proc where oid = 'public.item_verification_summaries(uuid,uuid[])'::regprocedure),
  '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  'S2 item_verification_summaries keeps its grants');
select is(pg_get_function_result('public.item_verification_summaries(uuid,uuid[])'::regprocedure),
  'TABLE(item_id uuid, item_status text, item_is_rental boolean, item_is_bundle boolean, item_deleted boolean, item_countable boolean, quantity_on_hand numeric, cycle_count_id uuid, count_number bigint, scope text, completed_at timestamp with time zone, completed_by uuid, counted_by uuid, counted_at timestamp with time zone, captured_at timestamp with time zone, baseline_at timestamp with time zone, expected_quantity numeric, expected_at_start numeric, counted_quantity numeric, counted_location_id uuid, counted_location_name text, counted_location_kind text, counted_location_type text, counted_location_archived boolean, ai_assisted boolean, movements_since integer, outside_ledger_since integer, open_count_id uuid, open_count_number bigint)',
  'S3 item_verification_summaries returns the same columns (0374''s)');

select * from finish();
rollback;
