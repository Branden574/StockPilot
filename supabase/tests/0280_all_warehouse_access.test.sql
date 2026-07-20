-- supabase/tests/0280_all_warehouse_access.test.sql
-- pgTAP for migration 0280 (all-warehouse access):
--   1-2. all_warehouses columns exist on organization_members and
--        organization_invites.
--   3.   A flagged, ACCEPTED member gets a user_warehouse_assignments row
--        when a warehouse is inserted into their org.
--   4.   The trigger row is null-charter, non-primary, org-stamped.
--   5.   An unflagged member gets no row.
--   6.   A flagged but NOT-accepted (pending) member gets no row.
--   7-8. Duplicate safety: re-running the trigger body's INSERT verbatim
--        neither errors nor duplicates. The arbiter must name the 0008
--        partial unique index (uwa_user_wh_no_charter_uniq) — a bare
--        (user_id, warehouse_id) target would raise 42P10 because 0008
--        dropped that full unique constraint. A true trigger-level duplicate
--        is unreachable in one statement (assignment rows FK-depend on the
--        warehouse row that the trigger fires for), so the statement shape is
--        exercised directly.
--   9.   A SECOND warehouse insert grants the flagged member another row
--        (one row per warehouse, not a one-shot backfill).
--
-- Namespace: ab280000 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(9);

\set org      '\'ab280000-0000-0000-0000-000000000001\''
\set uFlag    '\'ab280000-0000-0000-0000-000000000002\''
\set uPlain   '\'ab280000-0000-0000-0000-000000000003\''
\set uPending '\'ab280000-0000-0000-0000-000000000004\''
\set wh1      '\'ab280000-0000-0000-0000-000000000005\''
\set wh2      '\'ab280000-0000-0000-0000-000000000006\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- auth.users insert bootstraps user_profiles via the 0001 trigger.
-- ─────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:uFlag,    'all-wh-flagged-0280@test.local',  '{}'::jsonb),
  (:uPlain,   'all-wh-plain-0280@test.local',    '{}'::jsonb),
  (:uPending, 'all-wh-pending-0280@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'pgtap all-warehouse org', 'pgtap-all-warehouse-org-0280')
  on conflict (id) do nothing;

insert into public.organization_members
    (organization_id, user_id, role, accepted_at, all_warehouses)
  values
    (:org, :uFlag,    'staff',  now(), true),
    (:org, :uPlain,   'staff',  now(), false),
    (:org, :uPending, 'viewer', null,  true)
  on conflict do nothing;

-- 1-2. Columns exist.
select has_column('public', 'organization_members', 'all_warehouses',
  'organization_members.all_warehouses exists (0280)');
select has_column('public', 'organization_invites', 'all_warehouses',
  'organization_invites.all_warehouses exists (0280)');

-- Warehouse insert fires the trigger.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh1, :org, 'All-WH Trigger Test 1', 'WH-A280A', 'active');

-- 3. Flagged + accepted member got exactly one row.
select is(
  (select count(*)::int from public.user_warehouse_assignments
    where user_id = :uFlag and warehouse_id = :wh1),
  1, 'flagged accepted member gets an assignment row on warehouse insert');

-- 4. Row shape: null charter, non-primary, org-stamped.
select is(
  (select (charter_id is null and is_primary = false and organization_id = :org)
     from public.user_warehouse_assignments
    where user_id = :uFlag and warehouse_id = :wh1),
  true, 'trigger row is null-charter, non-primary, and org-stamped');

-- 5. Unflagged member untouched.
select is(
  (select count(*)::int from public.user_warehouse_assignments
    where user_id = :uPlain and warehouse_id = :wh1),
  0, 'unflagged member gets no row');

-- 6. Flagged but pending (accepted_at is null) member untouched.
select is(
  (select count(*)::int from public.user_warehouse_assignments
    where user_id = :uPending and warehouse_id = :wh1),
  0, 'flagged but unaccepted member gets no row');

-- 7-8. Conflict safety of the trigger body's INSERT (arbiter must infer the
-- 0008 null-charter partial unique index).
select lives_ok(
  $q$
    insert into public.user_warehouse_assignments
      (organization_id, user_id, warehouse_id, charter_id, is_primary, assigned_by)
    select w.organization_id, m.user_id, w.id, null, false, null
      from public.warehouses w
      join public.organization_members m on m.organization_id = w.organization_id
     where w.id = 'ab280000-0000-0000-0000-000000000005'
       and m.all_warehouses = true
       and m.accepted_at is not null
    on conflict (user_id, warehouse_id) where charter_id is null do nothing
  $q$,
  're-running the grant insert is conflict-safe (partial-index arbiter, 0280)');
select is(
  (select count(*)::int from public.user_warehouse_assignments
    where user_id = :uFlag and warehouse_id = :wh1),
  1, 'no duplicate row after the conflict-safe re-run');

-- 9. A second warehouse insert grants another row to the flagged member.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh2, :org, 'All-WH Trigger Test 2', 'WH-A280B', 'active');
select is(
  (select count(*)::int from public.user_warehouse_assignments
    where user_id = :uFlag and warehouse_id in (:wh1, :wh2)),
  2, 'each new warehouse grants the flagged member one more row');

select * from finish();
rollback;
