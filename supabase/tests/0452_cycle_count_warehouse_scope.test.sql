-- supabase/tests/0452_cycle_count_warehouse_scope.test.sql
-- pgTAP proof for migration 0452: cycle counts, count lines, AI shelf scans
-- and scan photos follow what the member may see, in the database.
--
-- The rule ("mine" = my_warehouse_ids(); "manager" = owner, admin, manager):
--   count  member of its organization AND (manager, or the all-warehouses
--            flag; OR its header warehouse is mine; OR it has no header
--            warehouse and is assigned to me or has a line in a warehouse
--            of mine)
--   line   its count is readable AND (manager OR (the line's warehouse is
--            mine AND I may read its item))
--   scan   its count is readable AND (I took it OR manager)
--   photo  read: the count named by the path's second folder, in the path's
--            organization, AND manager there; write and delete: the service
--            role only (the app uploads and signs with it)
--
-- C/L/A/O. What each persona reads directly (the Data API's path): an owner,
--    an admin, a manager, staff and a viewer with the all-warehouses flag,
--    staff and a viewer limited to North, staff limited to South, staff with
--    North and South by rows, staff with no warehouse, a read-only auditor
--    (a viewer granted cycle_counts:read and activity_logs:read) with and
--    without the flag, an expired Act-as seat, another organization's
--    manager, anon and the service role.
-- P. cycle_counts_page answers within the same rule; p_scope_warehouse_ids
--    only narrows it.
-- G. cycle_count_line_progress, cycle_count_summary and cycle_count_lines_page
--    on a count that spans two warehouses.
-- N. The phone's offline snapshot read (open counts with their lines, the
--    caller's warehouses or no header warehouse).
-- W. Writes: line updates keep their warehouse rule; an AI scan row is filed
--    only against a count the caller may read; the creator's insert ...
--    returning and confirm keep working; a manager writes.
-- K. Scan photo objects: no API role uploads or removes one; the service role
--    still does.
-- X. The working paths: a manager starts, assigns and posts a count; the
--    assignee releases her own; the counter records her lines.
-- Q. Progress-versus-RLS parity for every persona.
-- S. Posture of the new and restated functions.
--
-- Fixtures as the test superuser; reads and writes as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace c5480000.
begin;
select plan(127);

\set org    c5480000-0000-4000-8000-00000000000a
\set org2   c5480000-0000-4000-8000-00000000000b
\set own    c5480000-0000-4000-8000-0000000000a0
\set mgr    c5480000-0000-4000-8000-0000000000a1
\set stN    c5480000-0000-4000-8000-0000000000a2
\set vwN    c5480000-0000-4000-8000-0000000000a3
\set stAll  c5480000-0000-4000-8000-0000000000a4
\set vwAll  c5480000-0000-4000-8000-0000000000a5
\set stNo   c5480000-0000-4000-8000-0000000000a6
\set stNS   c5480000-0000-4000-8000-0000000000a7
\set seat   c5480000-0000-4000-8000-0000000000a8
\set stS    c5480000-0000-4000-8000-0000000000a9
\set adm    c5480000-0000-4000-8000-0000000000aa
\set audN   c5480000-0000-4000-8000-0000000000ab
\set audAll c5480000-0000-4000-8000-0000000000ac
\set mgr2   c5480000-0000-4000-8000-0000000000b1
\set whN    c5480000-0000-4000-8000-0000000000c1
\set whS    c5480000-0000-4000-8000-0000000000c2
\set whX    c5480000-0000-4000-8000-0000000000c3
\set iN1    c5480000-0000-4000-8000-0000000000d1
\set iN2    c5480000-0000-4000-8000-0000000000d2
\set iS1    c5480000-0000-4000-8000-0000000000d3
\set iX     c5480000-0000-4000-8000-0000000000d4
\set iN3    c5480000-0000-4000-8000-0000000000d5
\set cN     c5480000-0000-4000-8000-0000000000e1
\set cS     c5480000-0000-4000-8000-0000000000e2
\set cMix   c5480000-0000-4000-8000-0000000000e3
\set cMixU  c5480000-0000-4000-8000-0000000000e4
\set cSo    c5480000-0000-4000-8000-0000000000e5
\set cMine  c5480000-0000-4000-8000-0000000000e6
\set cX     c5480000-0000-4000-8000-0000000000e9

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
    raise exception using errcode = 'P0S48', message = coalesce(r, '(null)');
  exception when sqlstate 'P0S48' then
    return sqlerrm;
  end;
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

create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case p
    when 'c5480000-0000-4000-8000-0000000000e1' then 'n'
    when 'c5480000-0000-4000-8000-0000000000e2' then 's'
    when 'c5480000-0000-4000-8000-0000000000e3' then 'mix'
    when 'c5480000-0000-4000-8000-0000000000e4' then 'mixu'
    when 'c5480000-0000-4000-8000-0000000000e5' then 'sonly'
    when 'c5480000-0000-4000-8000-0000000000e6' then 'mine'
    when 'c5480000-0000-4000-8000-0000000000e9' then 'x'
    else 'other' end $$;

create function pg_temp.counts_seen() returns text language sql as $$
  select coalesce(string_agg(pg_temp.lbl(id), ' ' order by pg_temp.lbl(id) collate "C"), '(none)')
    from public.cycle_counts where id::text like 'c5480000-%' $$;
create function pg_temp.lines_seen() returns text language sql as $$
  select coalesce(string_agg(l || ':' || n, ' ' order by l collate "C"), '(none)')
    from (select pg_temp.lbl(cycle_count_id) l, count(*) n from public.cycle_count_lines
           where cycle_count_id::text like 'c5480000-%' group by 1) s $$;
create function pg_temp.scans_seen() returns text language sql as $$
  select coalesce(string_agg(model_version, ' ' order by model_version collate "C"), '(none)')
    from public.cycle_count_ai_scans where cycle_count_id::text like 'c5480000-%' $$;
create function pg_temp.objects_seen() returns text language sql as $$
  select coalesce(string_agg(split_part(name, '/', 3), ' ' order by split_part(name, '/', 3) collate "C"), '(none)')
    from storage.objects where bucket_id = 'cycle-count-scans' and name like 'c5480000-%' $$;
-- The snapshot route's count read (apps/web/src/app/api/v1/mobile/snapshot):
-- open counts of the caller's warehouses or with no header warehouse, with
-- their lines embedded, both under the caller's RLS.
create function pg_temp.snapshot_seen(p_wh uuid[]) returns text language sql as $$
  select coalesce(string_agg(pg_temp.lbl(c.id) || ':'
           || (select count(*) from public.cycle_count_lines l where l.cycle_count_id = c.id),
           ' ' order by pg_temp.lbl(c.id) collate "C"), '(none)')
    from public.cycle_counts c
   where c.organization_id = 'c5480000-0000-4000-8000-00000000000a'
     and c.status = 'in_progress'
     and (c.warehouse_id is null or c.warehouse_id = any(p_wh)) $$;

-- Count every line of a count at its expected quantity, then post it, as the
-- caller (the manager's Approve on the web).
create function pg_temp.count_and_post(p_count uuid) returns text language plpgsql as $$
begin
  update public.cycle_count_lines
     set counted_quantity = expected_quantity, counted_by = auth.uid(), counted_at = now()
   where cycle_count_id = p_count;
  return (public.post_cycle_count(p_count)).status;
end $$;

-- ══ Fixture (as the test superuser) ═════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'own-s48@test.local', '{}'), (:'mgr', 'mgr-s48@test.local', '{}'),
  (:'stN', 'stn-s48@test.local', '{}'), (:'vwN', 'vwn-s48@test.local', '{}'),
  (:'stAll', 'stall-s48@test.local', '{}'), (:'vwAll', 'vwall-s48@test.local', '{}'),
  (:'stNo', 'stno-s48@test.local', '{}'), (:'stNS', 'stns-s48@test.local', '{}'),
  (:'seat', 'seat-s48@test.local', '{}'), (:'stS', 'sts-s48@test.local', '{}'),
  (:'adm', 'adm-s48@test.local', '{}'), (:'audN', 'audn-s48@test.local', '{}'),
  (:'audAll', 'audall-s48@test.local', '{}'), (:'mgr2', 'mgr2-s48@test.local', '{}')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'org', 'S48 Org', 's48-org'), (:'org2', 'S48 Other', 's48-other') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses, impersonation_expires_at) values
  (:'org', :'own', 'owner', now(), false, null),
  (:'org', :'adm', 'admin', now(), false, null),
  (:'org', :'mgr', 'manager', now(), false, null),
  (:'org', :'stN', 'staff', now(), false, null),
  (:'org', :'vwN', 'viewer', now(), false, null),
  (:'org', :'stAll', 'staff', now(), true, null),
  (:'org', :'vwAll', 'viewer', now(), true, null),
  (:'org', :'stNo', 'staff', now(), false, null),
  (:'org', :'stNS', 'staff', now(), false, null),
  (:'org', :'seat', 'owner', now(), false, now() - interval '1 minute'),
  (:'org', :'stS', 'staff', now(), false, null),
  (:'org', :'audN', 'viewer', now(), false, null),
  (:'org', :'audAll', 'viewer', now(), true, null),
  (:'org2', :'mgr2', 'manager', now(), false, null)
  on conflict do nothing;
-- The read-only auditor's two grants (0279).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'org', :'audN', 'cycle_counts:read', true), (:'org', :'audN', 'activity_logs:read', true),
  (:'org', :'audAll', 'cycle_counts:read', true), (:'org', :'audAll', 'activity_logs:read', true);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whN', :'org', 'S48 North', 'S48N', 'active'), (:'whS', :'org', 'S48 South', 'S48S', 'active'),
  (:'whX', :'org2', 'S48 Other', 'S48X', 'active') on conflict (id) do nothing;
-- The all-warehouses flag keeps an assignment row for every warehouse (0280).
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:'org', :'stN', :'whN'), (:'org', :'vwN', :'whN'),
  (:'org', :'stAll', :'whN'), (:'org', :'stAll', :'whS'),
  (:'org', :'vwAll', :'whN'), (:'org', :'vwAll', :'whS'),
  (:'org', :'stNS', :'whN'), (:'org', :'stNS', :'whS'),
  (:'org', :'stS', :'whS'),
  (:'org', :'audN', :'whN'),
  (:'org', :'audAll', :'whN'), (:'org', :'audAll', :'whS')
  on conflict do nothing;
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:'iN1', :'org', :'whN', 'S48-N1', 'North one', 5, 'active', 'none'),
  (:'iN2', :'org', :'whN', 'S48-N2', 'North two', 5, 'active', 'none'),
  (:'iN3', :'org', :'whN', 'S48-N3', 'North three', 5, 'active', 'none'),
  (:'iS1', :'org', :'whS', 'S48-S1', 'South one', 5, 'active', 'none'),
  (:'iX',  :'org2', :'whX', 'S48-X1', 'Other one', 5, 'active', 'none')
  on conflict (id) do nothing;
insert into public.cycle_counts (id, organization_id, warehouse_id, scope, status, started_by, assigned_to) values
  (:'cN',    :'org', :'whN', 'warehouse', 'in_progress', :'mgr', null),
  (:'cS',    :'org', :'whS', 'warehouse', 'in_progress', :'mgr', null),
  (:'cMix',  :'org', null,   'selection', 'in_progress', :'mgr', :'stS'),
  (:'cMixU', :'org', null,   'warehouse', 'in_progress', :'mgr', null),
  (:'cSo',   :'org', null,   'selection', 'in_progress', :'mgr', :'mgr'),
  (:'cMine', :'org', null,   'selection', 'in_progress', :'mgr', :'stN'),
  (:'cX',    :'org2', :'whX', 'warehouse', 'in_progress', :'mgr2', null);
insert into public.cycle_count_lines (cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:'cN', :'iN1', :'whN', 5), (:'cN', :'iN2', :'whN', 5),
  (:'cS', :'iS1', :'whS', 5),
  (:'cMix', :'iN1', :'whN', 5), (:'cMix', :'iS1', :'whS', 5),
  (:'cMixU', :'iN2', :'whN', 5), (:'cMixU', :'iS1', :'whS', 5),
  (:'cSo', :'iS1', :'whS', 5),
  (:'cMine', :'iS1', :'whS', 5),
  (:'cX', :'iX', :'whX', 5);
insert into public.cycle_count_ai_scans (id, organization_id, cycle_count_id, created_by, photo_storage_path, model_version) values
  ('c5480000-0000-4000-8000-0000000000f1', :'org', :'cS',   :'stS', :'org' || '/' || :'cS'   || '/a.webp', 'sS'),
  ('c5480000-0000-4000-8000-0000000000f2', :'org', :'cMix', :'stS', :'org' || '/' || :'cMix' || '/b.webp', 'sMix'),
  ('c5480000-0000-4000-8000-0000000000f3', :'org', :'cMix', :'mgr', :'org' || '/' || :'cMix' || '/c.webp', 'sMix2');
insert into storage.objects (bucket_id, name) values
  ('cycle-count-scans', :'org' || '/' || :'cS' || '/o_s.webp'),
  ('cycle-count-scans', :'org' || '/' || :'cMix' || '/o_mix.webp'),
  ('cycle-count-scans', :'org' || '/not-a-uuid/o_bad.webp'),
  ('cycle-count-scans', :'org2' || '/' || :'cX' || '/o_x.webp');

-- ══ As each persona ══════════════════════════════════════════════════════
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';

set local "request.jwt.claim.sub" to :'own';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C1 owner: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L1 owner: every line');
select is(pg_temp.scans_seen(), 'sMix sMix2 sS', 'A1 owner: every scan');
select is(pg_temp.objects_seen(), 'o_mix.webp o_s.webp', 'O1 owner: the scan photos filed under a count');

set local "request.jwt.claim.sub" to :'adm';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C1b admin: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L1b admin: every line');
select is(pg_temp.scans_seen(), 'sMix sMix2 sS', 'A1b admin: every scan');
select is(pg_temp.objects_seen(), 'o_mix.webp o_s.webp', 'O1b admin: the scan photos filed under a count');

set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C2 manager: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L2 manager: every line');
select is(pg_temp.scans_seen(), 'sMix sMix2 sS', 'A2 manager: every scan');
select is(pg_temp.objects_seen(), 'o_mix.webp o_s.webp', 'O2 manager: the scan photos filed under a count');

set local "request.jwt.claim.sub" to :'stAll';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C3 staff with the all-warehouses flag: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L3 flag staff: every line');
select is(pg_temp.scans_seen(), '(none)', 'A3 flag staff: only her own scans (none here)');
select is(pg_temp.objects_seen(), '(none)', 'O3 flag staff: no scan photo by her own token (the app signs them with the service role)');

set local "request.jwt.claim.sub" to :'vwAll';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C4 viewer with the flag: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L4 flag viewer: every line');
select is(pg_temp.scans_seen(), '(none)', 'A4 flag viewer: no one else''s scans');

set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.counts_seen(), 'mine mix mixu n', 'C5 staff North: North, the no-warehouse counts with a North line, and her own');
select is(pg_temp.lines_seen(), 'mix:1 mixu:1 n:2', 'L5 staff North: only North lines');
select is(pg_temp.scans_seen(), '(none)', 'A5 staff North: only her own scans (none here)');
select is(pg_temp.objects_seen(), '(none)', 'O5 staff North: no scan photo by her own token');
select is(pg_temp.q($$select min(total_count)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a', p_page_size => 100)$$),
  '4', 'P1 staff North: the list with no scope passed totals her 4');
select is(pg_temp.q($$select count(*)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a',
     p_number => (select count_number from public.cycle_counts where false))$$), '4',
  'P1b staff North: a null number filter is no filter');
select is(pg_temp.q($$select count(*)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a',
     p_scope_warehouse_ids => array['c5480000-0000-4000-8000-0000000000c2']::uuid[])$$),
  '1', 'P2 staff North: a South scope gives only her own no-warehouse assignment');
select is(pg_temp.q($$select count(*)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a',
     p_scope_warehouse_ids => array['c5480000-0000-4000-8000-0000000000c1']::uuid[])$$),
  '2', 'P3 staff North: the web''s own scope (North) gives North and her assignment');
select is(pg_temp.q($$select coalesce(string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total, ' ' order by pg_temp.lbl(cycle_count_id) collate "C"), '(none)')
     from public.cycle_count_line_progress('c5480000-0000-4000-8000-00000000000a',
       array['c5480000-0000-4000-8000-0000000000e2', 'c5480000-0000-4000-8000-0000000000e3']::uuid[])$$),
  'mix:1', 'G1 staff North: progress counts her North line of the mixed count and nothing of the South count');
select is(pg_temp.q($$select total::text from public.cycle_count_summary('c5480000-0000-4000-8000-0000000000e3')$$),
  '1', 'G2 staff North: the mixed count''s summary counts her one line');
select is(pg_temp.q($$select coalesce(min(full_count)::text, '0') from public.cycle_count_lines_page('c5480000-0000-4000-8000-0000000000e3')$$),
  '1', 'G3 staff North: the mixed count''s lines page shows her one line');
select is(pg_temp.snapshot_seen(array['c5480000-0000-4000-8000-0000000000c1']::uuid[]),
  'mine:0 mix:1 mixu:1 n:2', 'N1 staff North: the snapshot read gets her counts with only her lines');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 3
     where cycle_count_id = 'c5480000-0000-4000-8000-0000000000e4' and warehouse_id = 'c5480000-0000-4000-8000-0000000000c1'$$),
  '1', 'W1 staff North: records her North line of the unassigned mixed count');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 3
     where cycle_count_id = 'c5480000-0000-4000-8000-0000000000e4' and warehouse_id = 'c5480000-0000-4000-8000-0000000000c2'$$),
  '0', 'W2 staff North: cannot record its South line');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 3
     where cycle_count_id = 'c5480000-0000-4000-8000-0000000000e2'$$),
  '0', 'W3 staff North: nor a line of the South count');
select is(pg_temp.n_rb($$insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, model_version)
     values ('c5480000-0000-4000-8000-00000000000a', 'c5480000-0000-4000-8000-0000000000e2', 'c5480000-0000-4000-8000-0000000000a2',
             'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e2/z.webp', 'w4')$$),
  'ERROR 42501', 'W4 staff North: an AI scan is filed only against a count she may read (South refused)');
select is(pg_temp.q($$select count(*)::text from public.cycle_counts where id = 'c5480000-0000-4000-8000-0000000000e6'$$),
  '1', 'C5b staff North: her own no-warehouse assignment stays visible (assignee arm)');
select is(pg_temp.q_rb($$select coalesce((public.release_cycle_count('c5480000-0000-4000-8000-0000000000e6', 'handing back')).assigned_to::text, 'released')$$),
  'released', 'X1 staff North: the assignee releases her own count');

set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.counts_seen(), 'mix mixu n', 'C6 viewer North: North and the no-warehouse counts with a North line');
select is(pg_temp.lines_seen(), 'mix:1 mixu:1 n:2', 'L6 viewer North: only North lines');
select is(pg_temp.scans_seen(), '(none)', 'A6 viewer North: no scans');
select is(pg_temp.objects_seen(), '(none)', 'O6 viewer North: no scan photo');
select is(pg_temp.q($$select min(total_count)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a', p_page_size => 100)$$),
  '3', 'P4 viewer North: the list with no scope totals her 3');
select is(pg_temp.snapshot_seen(array['c5480000-0000-4000-8000-0000000000c1']::uuid[]),
  'mix:1 mixu:1 n:2', 'N2 viewer North: the snapshot read gets North''s counts with only North lines');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 3
     where cycle_count_id = 'c5480000-0000-4000-8000-0000000000e1'$$),
  '0', 'W1v viewer North: reads North''s lines but records none');

set local "request.jwt.claim.sub" to :'audN';
select is(pg_temp.counts_seen(), 'mix mixu n', 'C12 auditor without the flag: only the counts of her warehouse');
select is(pg_temp.lines_seen(), 'mix:1 mixu:1 n:2', 'L12 auditor without the flag: only North lines');
select is(pg_temp.scans_seen(), '(none)', 'A12 auditor without the flag: no scans');
select is(pg_temp.q($$select min(total_count)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a', p_page_size => 100)$$),
  '3', 'P12 auditor without the flag: the list totals 3');

set local "request.jwt.claim.sub" to :'audAll';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C13 auditor with the flag: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L13 auditor with the flag: every line');
select is(pg_temp.scans_seen(), '(none)', 'A13 auditor with the flag: no one else''s scans');
select is(pg_temp.objects_seen(), '(none)', 'O13 auditor with the flag: no scan photo by her own token');

set local "request.jwt.claim.sub" to :'stS';
select is(pg_temp.counts_seen(), 'mine mix mixu s sonly', 'C7 staff South: South and the no-warehouse counts with a South line');
select is(pg_temp.lines_seen(), 'mine:1 mix:1 mixu:1 s:1 sonly:1', 'L7 staff South: only South lines');
select is(pg_temp.scans_seen(), 'sMix sS', 'A7 staff South: her own two scans');
select is(pg_temp.objects_seen(), '(none)', 'O7 staff South: no scan photo by her own token, even of her own scans');
select is(pg_temp.n_rb($$insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, model_version)
     values ('c5480000-0000-4000-8000-00000000000a', 'c5480000-0000-4000-8000-0000000000e3', 'c5480000-0000-4000-8000-0000000000a9',
             'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e3/w5.webp', 'w5') returning id$$),
  '1', 'W5 staff South: files and reads back a scan of her mixed count (insertAiScan''s insert ... returning)');
select is(pg_temp.n_rb($$insert into public.cycle_count_ai_scans (organization_id, cycle_count_id, created_by, photo_storage_path, model_version)
     values ('c5480000-0000-4000-8000-00000000000a', 'c5480000-0000-4000-8000-0000000000e2', 'c5480000-0000-4000-8000-0000000000a9',
             'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e2/w6.webp', 'w6') returning id$$),
  '1', 'W6 staff South: and of the South count');
select is(pg_temp.n_rb($$update public.cycle_count_ai_scans set confirmed_at = now(), confirmed_by = 'c5480000-0000-4000-8000-0000000000a9'
     where model_version = 'sMix' returning id$$),
  '1', 'W7 staff South: confirms her own scan of the mixed count (markAiScanConfirmed)');
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 4, counted_by = 'c5480000-0000-4000-8000-0000000000a9', counted_at = now()
     where cycle_count_id = 'c5480000-0000-4000-8000-0000000000e3' and warehouse_id = 'c5480000-0000-4000-8000-0000000000c2'$$),
  '1', 'X2 staff South: the assignee records her South line of her mixed count');

set local "request.jwt.claim.sub" to :'stNS';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly', 'C8 staff North and South by rows: every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1', 'L8 staff North and South: every line');
select is(pg_temp.scans_seen(), '(none)', 'A8 staff North and South: no one else''s scans');

set local "request.jwt.claim.sub" to :'stNo';
select is(pg_temp.counts_seen(), '(none)', 'C9 staff with no warehouse: no counts');
select is(pg_temp.lines_seen(), '(none)', 'L9 staff with no warehouse: no lines');
select is(pg_temp.q($$select min(total_count)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a')$$),
  null, 'P5 staff with no warehouse: an empty list');

set local "request.jwt.claim.sub" to :'seat';
select is(pg_temp.counts_seen(), '(none)', 'C10 an expired Act-as seat reads no count');
select is(pg_temp.lines_seen(), '(none)', 'L10 nor any line');

set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.counts_seen(), 'x', 'C11 another organization''s manager reads only his own organization''s count');
select is(pg_temp.lines_seen(), 'x:1', 'L11 and only its line');
select is(pg_temp.scans_seen(), '(none)', 'A11 and no scan of this organization');
select is(pg_temp.objects_seen(), 'o_x.webp', 'O11 and only his own organization''s photo');
select is(pg_temp.q($$select public.cc_ai_scan_in_count('c5480000-0000-4000-8000-0000000000f1', 'c5480000-0000-4000-8000-0000000000e2')::text$$),
  'false', 'S9 cc_ai_scan_in_count answers false outside the caller''s organizations');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c5480000-0000-4000-8000-00000000000a',
     array['c5480000-0000-4000-8000-0000000000e1']::uuid[])$$),
  '0', 'G5 another organization''s manager: no progress row for this organization''s count');

set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.q($$select public.cc_ai_scan_in_count('c5480000-0000-4000-8000-0000000000f1', 'c5480000-0000-4000-8000-0000000000e2')::text$$),
  'true', 'S10 cc_ai_scan_in_count: inside the organization it checks the link without reading the scan');
select is(pg_temp.q($$select public.cc_ai_scan_in_count('c5480000-0000-4000-8000-0000000000f1', 'c5480000-0000-4000-8000-0000000000e1')::text$$),
  'false', 'S11 cc_ai_scan_in_count: a scan of another count is not this count''s');

set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.n_rb($$update public.cycle_count_lines set counted_quantity = 4
     where cycle_count_id = 'c5480000-0000-4000-8000-0000000000e2'$$),
  '1', 'W8 a manager records a South line');
select is(pg_temp.q($$select coalesce(string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total, ' ' order by pg_temp.lbl(cycle_count_id) collate "C"), '(none)')
     from public.cycle_count_line_progress('c5480000-0000-4000-8000-00000000000a',
       array['c5480000-0000-4000-8000-0000000000e2', 'c5480000-0000-4000-8000-0000000000e3']::uuid[])$$),
  'mix:2 s:1', 'G4 a manager''s progress counts every line');
select is(pg_temp.q($$select min(total_count)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a', p_page_size => 100)$$),
  '6', 'P6 a manager''s list totals 6');
select is(pg_temp.q_rb($$select line_count::text from public.start_cycle_count('c5480000-0000-4000-8000-00000000000a', 'selection',
     'c5480000-0000-4000-8000-0000000000c1', null, array['c5480000-0000-4000-8000-0000000000d5']::uuid[], 'x3')$$),
  '1', 'X3 a manager starts a count and reads it back');
select is(pg_temp.q_rb($$select (public.assign_cycle_count('c5480000-0000-4000-8000-0000000000e1', 'c5480000-0000-4000-8000-0000000000a2')).assigned_to::text$$),
  'c5480000-0000-4000-8000-0000000000a2', 'X4 a manager assigns a North count to the North staff member');
select is(pg_temp.q_rb($$select pg_temp.count_and_post('c5480000-0000-4000-8000-0000000000e3')$$),
  'completed', 'X5 a manager counts and posts a count that spans two warehouses');

-- ══ anon and the service role ════════════════════════════════════════════
set local role anon;
set local "request.jwt.claim.role" to 'anon';
set local "request.jwt.claim.sub" to '';
select ok(pg_temp.q('select count(*)::text from public.cycle_counts') in ('0', 'ERROR 42501'), 'C14 anon reads no count');
select ok(pg_temp.q('select count(*)::text from public.cycle_count_lines') in ('0', 'ERROR 42501'), 'L14 anon reads no line');
select ok(pg_temp.q('select count(*)::text from public.cycle_count_ai_scans') in ('0', 'ERROR 42501'), 'A14 anon reads no scan');
select ok(pg_temp.q($$select count(*)::text from storage.objects where bucket_id = 'cycle-count-scans'$$) in ('0', 'ERROR 42501'),
  'O14 anon reads no scan photo');
select is(pg_temp.q($$select count(*)::text from public.cycle_counts_page('c5480000-0000-4000-8000-00000000000a')$$),
  'ERROR 42501', 'P14 anon cannot call cycle_counts_page');
select is(pg_temp.q($$select count(*)::text from public.cycle_count_line_progress('c5480000-0000-4000-8000-00000000000a',
     array['c5480000-0000-4000-8000-0000000000e1']::uuid[])$$),
  'ERROR 42501', 'G14 anon cannot call cycle_count_line_progress');
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k0.png')$$),
  'ERROR 42501', 'K0 anon uploads no scan photo');

set local role service_role;
set local "request.jwt.claim.role" to 'service_role';
select is(pg_temp.counts_seen(), 'mine mix mixu n s sonly x', 'C15 the service role (the weekly digest''s read) reads every count');
select is(pg_temp.lines_seen(), 'mine:1 mix:2 mixu:2 n:2 s:1 sonly:1 x:1', 'L15 and every line');
select is(pg_temp.scans_seen(), 'sMix sMix2 sS', 'A15 and every scan');
select is(pg_temp.objects_seen(), 'o_bad.webp o_mix.webp o_s.webp o_x.webp', 'O15 and every scan photo');
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k7.png')$$),
  '1', 'K7 the service role uploads a scan photo (the ai-scan route)');
select set_config('storage.allow_delete_query', 'true', true);
select is(pg_temp.n_rb($$delete from storage.objects where bucket_id = 'cycle-count-scans'
     and name = 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e2/o_s.webp'$$),
  '1', 'K8 the service role removes a scan photo');
select set_config('storage.allow_delete_query', 'false', true);

-- ══ Scan photo writes by an API role ═════════════════════════════════════
set local role authenticated;
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'stN';
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e2/k1.png')$$),
  'ERROR 42501', 'K1 staff North: uploads no scan photo under a South count');
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k2.png')$$),
  'ERROR 42501', 'K2 staff North: nor under her own warehouse''s count (the route uploads with the service role)');
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/not-a-count/k3.png')$$),
  'ERROR 42501', 'K3 staff North: nor under a folder that is no count');
set local "request.jwt.claim.sub" to :'vwN';
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k3v.png')$$),
  'ERROR 42501', 'K3v viewer North: uploads no scan photo');
set local "request.jwt.claim.sub" to :'mgr';
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k4.png')$$),
  'ERROR 42501', 'K4 a manager uploads no scan photo by his own token');
select set_config('storage.allow_delete_query', 'true', true);
select is(pg_temp.n_rb($$delete from storage.objects where bucket_id = 'cycle-count-scans'
     and name = 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e3/o_mix.webp'$$),
  '0', 'K5 a manager removes no scan photo by his own token');
set local "request.jwt.claim.sub" to :'own';
select is(pg_temp.n_rb($$delete from storage.objects where bucket_id = 'cycle-count-scans'
     and name = 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e3/o_mix.webp'$$),
  '0', 'K6 nor does the owner');
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k6.png')$$),
  'ERROR 42501', 'K6b and the owner uploads none');
set local "request.jwt.claim.sub" to :'mgr2';
select is(pg_temp.n_rb($$insert into storage.objects (bucket_id, name)
     values ('cycle-count-scans', 'c5480000-0000-4000-8000-00000000000a/c5480000-0000-4000-8000-0000000000e1/k9.png')$$),
  'ERROR 42501', 'K9 another organization''s manager uploads nothing into this organization''s folder');
select set_config('storage.allow_delete_query', 'false', true);

-- ══ Parity: the progress helper equals what RLS returns, for every persona ══
reset role;
create function pg_temp.parity(p_uid uuid) returns text language plpgsql as $$
declare a text; b text;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  select coalesce(string_agg(pg_temp.lbl(cycle_count_id) || ':' || line_total || '/' || line_counted, ' ' order by pg_temp.lbl(cycle_count_id) collate "C"), '-')
    into a
    from public.cycle_count_line_progress('c5480000-0000-4000-8000-00000000000a',
           array['c5480000-0000-4000-8000-0000000000e1','c5480000-0000-4000-8000-0000000000e2',
                 'c5480000-0000-4000-8000-0000000000e3','c5480000-0000-4000-8000-0000000000e4',
                 'c5480000-0000-4000-8000-0000000000e5','c5480000-0000-4000-8000-0000000000e6']::uuid[]);
  select coalesce(string_agg(pg_temp.lbl(cycle_count_id) || ':' || n || '/' || c, ' ' order by pg_temp.lbl(cycle_count_id) collate "C"), '-')
    into b
    from (select cycle_count_id, count(*) n, count(counted_quantity) c from public.cycle_count_lines
           where cycle_count_id::text like 'c5480000-%' and cycle_count_id <> 'c5480000-0000-4000-8000-0000000000e9'
           group by 1) s;
  reset role;
  return case when a = b then 'equal' else 'DIFF progress=' || a || ' rls=' || b end;
end $$;
select is(pg_temp.parity(:'own'),    'equal', 'Q1 parity owner');
select is(pg_temp.parity(:'mgr'),    'equal', 'Q2 parity manager');
select is(pg_temp.parity(:'stAll'),  'equal', 'Q3 parity flag staff');
select is(pg_temp.parity(:'vwAll'),  'equal', 'Q4 parity flag viewer');
select is(pg_temp.parity(:'stN'),    'equal', 'Q5 parity staff North');
select is(pg_temp.parity(:'vwN'),    'equal', 'Q6 parity viewer North');
select is(pg_temp.parity(:'stS'),    'equal', 'Q7 parity staff South');
select is(pg_temp.parity(:'stNS'),   'equal', 'Q8 parity staff North and South');
select is(pg_temp.parity(:'stNo'),   'equal', 'Q9 parity staff with no warehouse');
select is(pg_temp.parity(:'adm'),    'equal', 'Q10 parity admin');
select is(pg_temp.parity(:'audN'),   'equal', 'Q11 parity auditor without the flag');
select is(pg_temp.parity(:'audAll'), 'equal', 'Q12 parity auditor with the flag');
select is(pg_temp.parity(:'seat'),   'equal', 'Q13 parity expired Act-as seat');

-- ══ Posture of the new and restated functions ════════════════════════════
select is(pg_temp.q($$select (p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public'])::text
     from pg_proc p where p.oid = 'public.rls_all_warehouses_org_ids()'::regprocedure$$), 'true',
  'S1 rls_all_warehouses_org_ids: STABLE SECURITY DEFINER, search_path public');
select is(pg_temp.q($$select (has_function_privilege('authenticated', 'public.rls_all_warehouses_org_ids()', 'execute')
     and has_function_privilege('service_role', 'public.rls_all_warehouses_org_ids()', 'execute')
     and not has_function_privilege('anon', 'public.rls_all_warehouses_org_ids()', 'execute'))::text$$), 'true',
  'S2 rls_all_warehouses_org_ids: authenticated and service_role execute, anon does not');
select is(pg_temp.q($$select (p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public'])::text
     from pg_proc p where p.oid = 'public.rls_cc_unheaded_count_ids()'::regprocedure$$), 'true',
  'S3 rls_cc_unheaded_count_ids: STABLE SECURITY DEFINER, search_path public');
select is(pg_temp.q($$select (has_function_privilege('authenticated', 'public.rls_cc_unheaded_count_ids()', 'execute')
     and has_function_privilege('service_role', 'public.rls_cc_unheaded_count_ids()', 'execute')
     and not has_function_privilege('anon', 'public.rls_cc_unheaded_count_ids()', 'execute'))::text$$), 'true',
  'S4 rls_cc_unheaded_count_ids: authenticated and service_role execute, anon does not');
select is(pg_temp.q($$select (p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public']
     and pg_get_userbyid(p.proowner) = 'postgres')::text
     from pg_proc p where p.oid = 'public.cycle_count_line_progress(uuid, uuid[])'::regprocedure$$), 'true',
  'S5 cycle_count_line_progress stays STABLE SECURITY DEFINER, search_path public, owned by postgres');
select is(pg_temp.q($$select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and policyname like 'cycle-count-scans%'$$),
  'cycle-count-scans org read:SELECT',
  'S6 the scan photo bucket has one policy for API roles: read');
select is(pg_temp.q($$select (p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public'])::text
     from pg_proc p where p.oid = 'public.cc_ai_scan_in_count(uuid, uuid)'::regprocedure$$), 'true',
  'S7 cc_ai_scan_in_count: STABLE SECURITY DEFINER, search_path public');
select is(pg_temp.q($$select (has_function_privilege('authenticated', 'public.cc_ai_scan_in_count(uuid, uuid)', 'execute')
     and has_function_privilege('service_role', 'public.cc_ai_scan_in_count(uuid, uuid)', 'execute')
     and not has_function_privilege('anon', 'public.cc_ai_scan_in_count(uuid, uuid)', 'execute'))::text$$), 'true',
  'S8 cc_ai_scan_in_count: authenticated and service_role execute, anon does not');
select is(pg_temp.q($$select (has_function_privilege('authenticated', 'public.cycle_count_line_progress(uuid, uuid[])', 'execute')
     and has_function_privilege('service_role', 'public.cycle_count_line_progress(uuid, uuid[])', 'execute')
     and not has_function_privilege('anon', 'public.cycle_count_line_progress(uuid, uuid[])', 'execute'))::text$$), 'true',
  'S12 cycle_count_line_progress keeps its grants: authenticated and service_role execute, anon does not');
select is(pg_temp.q($$select (not p.prosecdef)::text from pg_proc p
     where p.oid = 'public.cycle_counts_page(uuid, bigint, text, text, uuid, uuid, boolean, timestamptz, uuid[], integer, integer)'::regprocedure$$),
  'true', 'S13 cycle_counts_page stays SECURITY INVOKER, so the table rule scopes it');

select * from finish();
rollback;
