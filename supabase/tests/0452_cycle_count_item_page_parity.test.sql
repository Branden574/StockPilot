-- supabase/tests/0452_cycle_count_item_page_parity.test.sql
-- pgTAP proof for migration 0452, third file: the item page's count facts
-- (item_verification_summaries: the last count and the open count holding
-- the item) equal what each persona reads directly from cycle_count_lines
-- under the line read rule, for thirteen personas: a manager; staff and a
-- viewer of one warehouse; staff with no warehouse; staff with the
-- all-warehouses flag and no assignment rows; a flagged viewer limited to a
-- category; an expired Act-as seat; a disabled account; staff here and
-- manager in another organization; a viewer limited to a category; staff
-- limited to a charter; another organization's manager.
--
-- The fixture holds a line whose warehouse is not its header's (both ways),
-- a line with no warehouse, counts with no header warehouse (assigned and
-- not), a completed count of an item since moved to another warehouse, and
-- an item moved while its count is open.
--
-- Fixtures as the test superuser; reads as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace c548f000.
begin;
select plan(15);

\set org    c548f000-0000-4000-8000-00000000000a
\set org2   c548f000-0000-4000-8000-00000000000b
\set mgr    c548f000-0000-4000-8000-0000000000a1
\set stN    c548f000-0000-4000-8000-0000000000a2
\set stS    c548f000-0000-4000-8000-0000000000a3
\set vwN    c548f000-0000-4000-8000-0000000000a4
\set st0    c548f000-0000-4000-8000-0000000000a5
\set flag0  c548f000-0000-4000-8000-0000000000a6
\set seat   c548f000-0000-4000-8000-0000000000a7
\set dis    c548f000-0000-4000-8000-0000000000a8
\set multi  c548f000-0000-4000-8000-0000000000a9
\set catVw  c548f000-0000-4000-8000-0000000000aa
\set chSt   c548f000-0000-4000-8000-0000000000ab
\set flagCat c548f000-0000-4000-8000-0000000000ac
\set mgr2   c548f000-0000-4000-8000-0000000000b1
\set whN    c548f000-0000-4000-8000-0000000000c1
\set whS    c548f000-0000-4000-8000-0000000000c2
\set whX    c548f000-0000-4000-8000-0000000000c3
\set catA   c548f000-0000-4000-8000-0000000000f1
\set chA    c548f000-0000-4000-8000-0000000000f2
\set chB    c548f000-0000-4000-8000-0000000000f3
\set iN1    c548f000-0000-4000-8000-0000000000d1
\set iS1    c548f000-0000-4000-8000-0000000000d2
\set iNull  c548f000-0000-4000-8000-0000000000d3
\set iMove  c548f000-0000-4000-8000-0000000000d4
\set iDel   c548f000-0000-4000-8000-0000000000d5
\set iCatA  c548f000-0000-4000-8000-0000000000d6
\set iChB   c548f000-0000-4000-8000-0000000000d7
\set iX     c548f000-0000-4000-8000-0000000000d8
\set cN     c548f000-0000-4000-8000-0000000000e1
\set cS     c548f000-0000-4000-8000-0000000000e2
\set cUo    c548f000-0000-4000-8000-0000000000e3
\set cUe    c548f000-0000-4000-8000-0000000000e4
\set cUm    c548f000-0000-4000-8000-0000000000e5
\set cDone  c548f000-0000-4000-8000-0000000000e6
\set cUcat  c548f000-0000-4000-8000-0000000000e7
\set cX     c548f000-0000-4000-8000-0000000000e9

create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case right(p::text, 2)
    when 'e1' then 'cN' when 'e2' then 'cS' when 'e3' then 'cUo' when 'e4' then 'cUe' when 'e5' then 'cUm'
    when 'e6' then 'cDone' when 'e7' then 'cUcat' when 'e9' then 'cX'
    when 'd1' then 'iN1' when 'd2' then 'iS1' when 'd3' then 'iNull' when 'd4' then 'iMove' when 'd5' then 'iDel'
    when 'd6' then 'iCatA' when 'd7' then 'iChB' when 'd8' then 'iX'
    else right(p::text, 4) end $$;

insert into auth.users (id, email, raw_user_meta_data)
select u::uuid, 'pp-' || right(u, 2) || '-s48@test.local', '{}'
  from unnest(array[:'mgr', :'stN', :'stS', :'vwN', :'st0', :'flag0', :'seat', :'dis', :'multi', :'catVw', :'chSt', :'flagCat', :'mgr2']) u
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:'org', 'S48P Org', 's48p-org'), (:'org2', 'S48P Other', 's48p-other');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses, impersonation_expires_at) values
  (:'org', :'mgr', 'manager', now(), false, null),
  (:'org', :'stN', 'staff', now(), false, null),
  (:'org', :'stS', 'staff', now(), false, null),
  (:'org', :'vwN', 'viewer', now(), false, null),
  (:'org', :'st0', 'staff', now(), false, null),
  (:'org', :'flag0', 'staff', now(), true, null),
  (:'org', :'seat', 'owner', now(), false, now() - interval '1 minute'),
  (:'org', :'dis', 'staff', now(), false, null),
  (:'org', :'multi', 'staff', now(), false, null),
  (:'org2', :'multi', 'manager', now(), false, null),
  (:'org', :'catVw', 'viewer', now(), false, null),
  (:'org', :'chSt', 'staff', now(), false, null),
  (:'org', :'flagCat', 'viewer', now(), true, null),
  (:'org2', :'mgr2', 'manager', now(), false, null);
update public.user_profiles set disabled_at = now() where id = :'dis';
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whN', :'org', 'S48P North', 'S8PN', 'active'), (:'whS', :'org', 'S48P South', 'S8PS', 'active'),
  (:'whX', :'org2', 'S48P X', 'S8PX', 'active');
insert into public.categories (id, organization_id, name) values (:'catA', :'org', 'S48P cat A');
insert into public.charters (id, organization_id, name, code) values (:'chA', :'org', 'S48P ch A', 'S8PA'), (:'chB', :'org', 'S48P ch B', 'S8PB');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values (:'org', :'whN', :'chA'), (:'org', :'whN', :'chB');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id) values
  (:'org', :'stN', :'whN', null), (:'org', :'stS', :'whS', null), (:'org', :'vwN', :'whN', null),
  (:'org', :'dis', :'whN', null), (:'org', :'multi', :'whN', null), (:'org', :'catVw', :'whN', null),
  (:'org', :'chSt', :'whN', :'chA'),
  (:'org', :'flagCat', :'whN', null), (:'org', :'flagCat', :'whS', null)
  on conflict do nothing;
delete from public.user_warehouse_assignments where user_id = :'flag0';
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:'org', :'catVw', :'catA'), (:'org', :'flagCat', :'catA');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, category_id, charter_id) values
  (:'iN1',  :'org', :'whN', 'S8P-N1', 'North one', 5, 'active', 'none', null, null),
  (:'iS1',  :'org', :'whS', 'S8P-S1', 'South one', 5, 'active', 'none', null, null),
  (:'iNull',:'org', null,   'S8P-NU', 'No warehouse', 5, 'active', 'none', null, null),
  (:'iMove',:'org', :'whS', 'S8P-MV', 'Moves S to N', 5, 'active', 'none', null, null),
  (:'iDel', :'org', :'whN', 'S8P-DL', 'Later deleted', 5, 'active', 'none', null, null),
  (:'iCatA',:'org', :'whN', 'S8P-CA', 'Cat A North', 5, 'active', 'none', :'catA', null),
  (:'iChB', :'org', :'whN', 'S8P-CB', 'Charter B North', 5, 'active', 'none', null, :'chB'),
  (:'iX',   :'org2', :'whX', 'S8P-X1', 'Other', 5, 'active', 'none', null, null);
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to) values
  (:'cN',   :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null),
  (:'cS',   :'org', :'whS', 'warehouse', 'in_progress', :'mgr', null),
  (:'cUo',  :'org', null,   'selection', 'in_progress', :'mgr', :'stS'),
  (:'cUe',  :'org', null,   'selection', 'in_progress', :'mgr', null),
  (:'cUm',  :'org', null,   'selection', 'in_progress', :'mgr', :'stN'),
  (:'cDone',:'org', :'whS', 'warehouse', 'in_progress', :'mgr', null),
  (:'cUcat',:'org', null,   'selection', 'in_progress', :'mgr', null),
  (:'cX',   :'org2', :'whX', 'warehouse', 'in_progress', :'mgr2', null);
-- Lines as the superuser, triggers off for the odd shapes (a line whose warehouse differs from its header's or is null).
set local session_replication_role = replica;
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:'cN', :'iN1', :'whN', 5), (:'cN', :'iS1', :'whS', 5), (:'cN', :'iNull', null, 5), (:'cN', :'iDel', :'whN', 5),
  (:'cN', :'iChB', :'whN', 5), (:'cN', :'iCatA', :'whN', 5),
  (:'cS', :'iS1', :'whS', 5), (:'cS', :'iN1', :'whN', 5),
  (:'cUo', :'iN1', :'whN', 5), (:'cUo', :'iS1', :'whS', 5),
  (:'cUm', :'iS1', :'whS', 5),
  (:'cUcat', :'iN1', :'whN', 5),
  (:'cX', :'iX', :'whX', 5);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity, counted_by, counted_at)
  values (:'cDone', :'iMove', :'whS', 5, 7, :'stS', now() - interval '1 hour');
update public.cycle_counts set status = 'completed', completed_at = now() - interval '30 minutes', completed_by = :'mgr' where id = :'cDone';
update public.inventory_items set warehouse_id = :'whN' where id = :'iMove';
set local session_replication_role = origin;

-- The item moved while its count is open: iCatA North to South, its line in
-- the North count still North.
set local session_replication_role = replica;
update public.inventory_items set warehouse_id = :'whS' where id = :'iCatA';
set local session_replication_role = origin;

-- Every item of the fixture, and the latest counted line per item (the one
-- source of "last physical count", read here as the superuser).
create temporary table s48p_items on commit drop as
  select id from public.inventory_items where id::text like 'c548f000-%' and organization_id = :'org';
create temporary table s48p_latest on commit drop as
  select l.item_id, l.cycle_count_id from public._latest_count_lines(:'org', null) l;
grant select on s48p_items, s48p_latest to authenticated;

-- What the item page answers: item, last count, open count.
create function pg_temp.page_facts() returns text language plpgsql as $$
begin
  return (select coalesce(string_agg(pg_temp.lbl(v.item_id) || ':' || coalesce(pg_temp.lbl(v.cycle_count_id), '-')
                                     || ':' || coalesce(pg_temp.lbl(v.open_count_id), '-'),
                                     ' ' order by pg_temp.lbl(v.item_id) collate "C"), '(none)')
            from public.item_verification_summaries('c548f000-0000-4000-8000-00000000000a',
                   (select array_agg(id) from s48p_items)) v);
end $$;
-- What the caller reads directly under the line rule: the item's latest
-- counted line when it is readable, and the newest in-progress count among
-- the item's readable lines; for every item the caller reads.
create function pg_temp.direct_facts() returns text language plpgsql as $$
begin
  return (select coalesce(string_agg(pg_temp.lbl(i.id) || ':'
             || coalesce(pg_temp.lbl((select t.cycle_count_id from s48p_latest t
                                       where t.item_id = i.id
                                         and exists (select 1 from public.cycle_count_lines l
                                                      where l.cycle_count_id = t.cycle_count_id and l.item_id = i.id))), '-')
             || ':'
             || coalesce(pg_temp.lbl((select l.cycle_count_id from public.cycle_count_lines l
                                       join public.cycle_counts c on c.id = l.cycle_count_id
                                      where l.item_id = i.id
                                        and c.organization_id = 'c548f000-0000-4000-8000-00000000000a'
                                        and c.status = 'in_progress'
                                      order by c.started_at desc, c.id desc
                                      limit 1)), '-'),
             ' ' order by pg_temp.lbl(i.id) collate "C"), '(none)')
            from public.inventory_items i
           where i.id in (select id from s48p_items));
end $$;

set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';

set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P1 manager: the item page equals the direct read');
select ok(pg_temp.page_facts() like '%iMove:cDone:-%',
  'P1b manager: the moved item''s last count is the South count (the parity is not vacuous)');
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P2 staff North: the item page equals the direct read');
select ok(pg_temp.page_facts() like '%iMove:-:-%' and pg_temp.page_facts() like '%iN1:-:%',
  'P2b staff North: the moved item shows no South count');
set local "request.jwt.claim.sub" to :'stS';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P3 staff South: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P4 viewer North: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'st0';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P5 staff with no warehouse: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'flag0';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P6 flagged staff with no assignment rows: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'flagCat';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P7 flagged viewer limited to a category: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'seat';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P8 expired Act-as seat: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'dis';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P9 disabled account: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'multi';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P10 staff here, manager elsewhere: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'catVw';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P11 viewer limited to a category: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'chSt';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P12 staff limited to a charter: the item page equals the direct read');
set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.page_facts(), pg_temp.direct_facts(), 'P13 another organization''s manager: the item page equals the direct read');

select * from finish();
rollback;
