-- supabase/tests/0452_cycle_count_item_scope.test.sql
-- pgTAP proof for migration 0452: count lines follow item visibility too
-- (inventory_items_select, nested as stock movements apply it in 0321), for a
-- viewer limited by category, a staff member limited by charter and a viewer
-- with the all-warehouses flag limited by category. The line's summary, lines
-- page and progress agree with what row level security returns, and the
-- lines a non-manager reads are exactly the lines of items they can read.
--
-- Fixtures as the test superuser; reads and writes as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace c548b000.
begin;
select plan(27);

\set org   c548b000-0000-4000-8000-00000000000a
\set mgr   c548b000-0000-4000-8000-0000000000a1
\set vwCat c548b000-0000-4000-8000-0000000000a2
\set stCh  c548b000-0000-4000-8000-0000000000a3
\set stN   c548b000-0000-4000-8000-0000000000a4
\set vwAll c548b000-0000-4000-8000-0000000000a5
\set whN   c548b000-0000-4000-8000-0000000000c1
\set whS   c548b000-0000-4000-8000-0000000000c2
\set catA  c548b000-0000-4000-8000-0000000000f1
\set chA   c548b000-0000-4000-8000-0000000000f2
\set chB   c548b000-0000-4000-8000-0000000000f3
\set iA    c548b000-0000-4000-8000-0000000000d1
\set iB    c548b000-0000-4000-8000-0000000000d2
\set iC    c548b000-0000-4000-8000-0000000000d3
\set iD    c548b000-0000-4000-8000-0000000000d4
\set iS    c548b000-0000-4000-8000-0000000000d5
\set cN    c548b000-0000-4000-8000-0000000000e1
\set cMix  c548b000-0000-4000-8000-0000000000e2

create function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return r;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

create function pg_temp.n_rb(p_sql text) returns text language plpgsql as $$
declare c int;
begin
  begin
    execute p_sql;
    get diagnostics c = row_count;
    raise exception using errcode = 'P0S4B', message = c::text;
  exception when sqlstate 'P0S4B' then
    return sqlerrm;
  end;
exception when others then
  return 'ERROR ' || sqlstate;
end $$;

create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case p
    when 'c548b000-0000-4000-8000-0000000000e1' then 'n'
    when 'c548b000-0000-4000-8000-0000000000e2' then 'mix'
    when 'c548b000-0000-4000-8000-0000000000d1' then 'A'
    when 'c548b000-0000-4000-8000-0000000000d2' then 'B'
    when 'c548b000-0000-4000-8000-0000000000d3' then 'C'
    when 'c548b000-0000-4000-8000-0000000000d4' then 'D'
    when 'c548b000-0000-4000-8000-0000000000d5' then 'S'
    else 'other' end $$;

-- n:A,B,C,D mix:A,S (the items whose lines the caller reads, per count)
create function pg_temp.lines_seen() returns text language sql as $$
  select coalesce(string_agg(l || ':' || i, ' ' order by l collate "C"), '(none)')
    from (select pg_temp.lbl(cycle_count_id) l, string_agg(pg_temp.lbl(item_id), ',' order by pg_temp.lbl(item_id) collate "C") i
            from public.cycle_count_lines where cycle_count_id::text like 'c548b000-%' group by 1) s $$;
create function pg_temp.counts_seen() returns text language sql as $$
  select coalesce(string_agg(pg_temp.lbl(id), ' ' order by pg_temp.lbl(id) collate "C"), '(none)')
    from public.cycle_counts where id::text like 'c548b000-%' $$;

-- ══ Fixture (as the test superuser) ════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mgr', 'mgr-s48b@test.local', '{}'), (:'vwCat', 'vwcat-s48b@test.local', '{}'),
  (:'stCh', 'stch-s48b@test.local', '{}'), (:'stN', 'stn-s48b@test.local', '{}'),
  (:'vwAll', 'vwall-s48b@test.local', '{}')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:'org', 'S48b Org', 's48b-org') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses) values
  (:'org', :'mgr', 'manager', now(), false),
  (:'org', :'vwCat', 'viewer', now(), false),
  (:'org', :'stCh', 'staff', now(), false),
  (:'org', :'stN', 'staff', now(), false),
  (:'org', :'vwAll', 'viewer', now(), true)
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whN', :'org', 'S48b North', 'S4BN', 'active'), (:'whS', :'org', 'S48b South', 'S4BS', 'active')
  on conflict (id) do nothing;
insert into public.categories (id, organization_id, name) values (:'catA', :'org', 'S48b cat A');
insert into public.charters (id, organization_id, name, code) values
  (:'chA', :'org', 'S48b charter A', 'S4BA'), (:'chB', :'org', 'S48b charter B', 'S4BB');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:'org', :'whN', :'chA'), (:'org', :'whN', :'chB');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id) values
  (:'org', :'vwCat', :'whN', null),
  (:'org', :'stCh', :'whN', :'chA'),
  (:'org', :'stN', :'whN', null),
  (:'org', :'vwAll', :'whN', null), (:'org', :'vwAll', :'whS', null)
  on conflict do nothing;
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:'org', :'vwCat', :'catA'), (:'org', :'vwAll', :'catA');
-- The two viewers are read-only auditors (granted cycle_counts:read), the
-- role this suite's warehouse rows are about. The item and category scope
-- below is theirs.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'org', :'vwCat', 'cycle_counts:read', true), (:'org', :'vwAll', 'cycle_counts:read', true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, category_id, charter_id) values
  (:'iA', :'org', :'whN', 'S4B-A', 'A in cat A', 5, 'active', 'none', :'catA', null),
  (:'iB', :'org', :'whN', 'S4B-B', 'B no category', 5, 'active', 'none', null, null),
  (:'iC', :'org', :'whN', 'S4B-C', 'C cat A charter B', 5, 'active', 'none', :'catA', :'chB'),
  (:'iD', :'org', :'whN', 'S4B-D', 'D charter A', 5, 'active', 'none', null, :'chA'),
  (:'iS', :'org', :'whS', 'S4B-S', 'S in cat A', 5, 'active', 'none', :'catA', null);
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to) values
  (:'cN',   :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null),
  (:'cMix', :'org', null,   'selection', 'in_progress', :'mgr', null);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:'cN', :'iA', :'whN', 5), (:'cN', :'iB', :'whN', 5), (:'cN', :'iC', :'whN', 5), (:'cN', :'iD', :'whN', 5),
  (:'cMix', :'iA', :'whN', 5), (:'cMix', :'iS', :'whS', 5);

set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';

-- Manager: everything.
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.counts_seen(), 'mix n', 'I1 manager: both counts');
select is(pg_temp.lines_seen(), 'mix:A,S n:A,B,C,D', 'I2 manager: every line');

-- Staff North with no charter limit.
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.lines_seen(), 'mix:A n:A,B,C,D', 'I3 staff North: every North line');

-- Viewer North limited to category A.
set local "request.jwt.claim.sub" to :'vwCat';
select is(pg_temp.counts_seen(), 'mix n', 'I4 category viewer: both counts (the count rule is by warehouse)');
select is(pg_temp.lines_seen(), 'mix:A n:A,C', 'I5 category viewer: only lines of category A items in North');
select is(pg_temp.q($$select total::text from public.cycle_count_summary('c548b000-0000-4000-8000-0000000000e1')$$),
  '2', 'I6 category viewer: the summary counts the 2 lines she may read');
select is(pg_temp.q($$select coalesce(min(full_count)::text, '0') from public.cycle_count_lines_page('c548b000-0000-4000-8000-0000000000e1')$$),
  '2', 'I7 category viewer: the lines page shows her the same 2 (item RLS, inner join)');
select is(pg_temp.q($$select line_total::text from public.cycle_count_line_progress('c548b000-0000-4000-8000-00000000000a',
     array['c548b000-0000-4000-8000-0000000000e1']::uuid[])$$),
  '2', 'I8 category viewer: progress counts the same 2');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_lines l
     where l.cycle_count_id = 'c548b000-0000-4000-8000-0000000000e1'
       and not exists (select 1 from public.inventory_items i where i.id = l.item_id)$$),
  '0', 'I9 category viewer: no line of an item she cannot open');

-- Staff North limited to charter A.
set local "request.jwt.claim.sub" to :'stCh';
select is(pg_temp.counts_seen(), 'mix n', 'I10 charter staff: both counts');
select is(pg_temp.lines_seen(), 'mix:A n:A,B,D', 'I11 charter staff: lines of generic and charter A items only');
select is(pg_temp.q($$select total::text from public.cycle_count_summary('c548b000-0000-4000-8000-0000000000e1')$$),
  '3', 'I12 charter staff: summary 3');
select is(pg_temp.q($$select coalesce(min(full_count)::text, '0') from public.cycle_count_lines_page('c548b000-0000-4000-8000-0000000000e1')$$),
  '3', 'I13 charter staff: the lines page shows the same 3');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 4, counted_by = 'c548b000-0000-4000-8000-0000000000a3', counted_at = now()
     where cycle_count_id = 'c548b000-0000-4000-8000-0000000000e1' and item_id = 'c548b000-0000-4000-8000-0000000000d4'$$),
  '1', 'I14 charter staff: records the charter A line');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 4, counted_by = 'c548b000-0000-4000-8000-0000000000a3', counted_at = now()
     where cycle_count_id = 'c548b000-0000-4000-8000-0000000000e1' and item_id = 'c548b000-0000-4000-8000-0000000000d3'$$),
  '0', 'I15 charter staff: does not record the line of a charter B item she cannot open');

-- Viewer with the all-warehouses flag, limited to category A.
set local "request.jwt.claim.sub" to :'vwAll';
select is(pg_temp.counts_seen(), 'mix n', 'I16 flag viewer: both counts');
select is(pg_temp.lines_seen(), 'mix:A,S n:A,C', 'I17 flag viewer limited to category A: only category A lines, in every warehouse');

-- Parity: the progress helper equals what RLS returns.
reset role;
create function pg_temp.parity(p_uid uuid) returns text language plpgsql as $$
declare a text; b text;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  select coalesce(string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total || '/' || line_counted, ' ' order by pg_temp.lbl(cycle_count_id) collate "C"), '-')
    into a
    from public.cycle_count_line_progress('c548b000-0000-4000-8000-00000000000a',
           array['c548b000-0000-4000-8000-0000000000e1', 'c548b000-0000-4000-8000-0000000000e2']::uuid[]);
  select coalesce(string_agg(pg_temp.lbl(cycle_count_id) || ':' || n || '/' || c, ' ' order by pg_temp.lbl(cycle_count_id) collate "C"), '-')
    into b
    from (select cycle_count_id, count(*) n, count(counted_quantity) c from public.cycle_count_lines
           where cycle_count_id::text like 'c548b000-%' group by 1) s;
  reset role;
  return case when a = b then 'equal' else 'DIFF progress=' || a || ' rls=' || b end;
end $$;
select is(pg_temp.parity(:'mgr'),   'equal', 'IQ1 parity manager');
select is(pg_temp.parity(:'stN'),   'equal', 'IQ2 parity staff North');
select is(pg_temp.parity(:'vwCat'), 'equal', 'IQ3 parity category viewer');
select is(pg_temp.parity(:'stCh'),  'equal', 'IQ4 parity charter staff');
select is(pg_temp.parity(:'vwAll'), 'equal', 'IQ5 parity flag viewer limited by category');

-- The item rule matches inventory_items_select exactly: the lines a
-- non-manager reads are those of items they can read, in their warehouses.
create function pg_temp.items_vs_lines(p_uid uuid) returns text language plpgsql as $$
declare a text; b text;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  select coalesce(string_agg(distinct pg_temp.lbl(l.item_id), ',' order by pg_temp.lbl(l.item_id)), '-') into a
    from public.cycle_count_lines l where l.cycle_count_id = 'c548b000-0000-4000-8000-0000000000e1';
  select coalesce(string_agg(pg_temp.lbl(i.id), ',' order by pg_temp.lbl(i.id)), '-') into b
    from public.inventory_items i
   where i.id in ('c548b000-0000-4000-8000-0000000000d1', 'c548b000-0000-4000-8000-0000000000d2',
                  'c548b000-0000-4000-8000-0000000000d3', 'c548b000-0000-4000-8000-0000000000d4');
  reset role;
  return case when a = b then 'equal' else 'DIFF lines=' || a || ' items=' || b end;
end $$;
select is(pg_temp.items_vs_lines(:'stN'),   'equal', 'IR1 staff North: lines = readable items');
select is(pg_temp.items_vs_lines(:'vwCat'), 'equal', 'IR2 category viewer: lines = readable items');
select is(pg_temp.items_vs_lines(:'stCh'),  'equal', 'IR3 charter staff: lines = readable items');
select is(pg_temp.items_vs_lines(:'vwAll'), 'equal', 'IR4 flag viewer: lines = readable items');
select is(pg_temp.items_vs_lines(:'mgr'),   'equal', 'IR5 manager: lines = readable items');

select * from finish();
rollback;
