-- supabase/tests/0304_item_import_batches.test.sql
--
-- Proves 0304: the generic items-CSV import fingerprints its file per org, so a
-- same-file re-upload can WARN instead of silently double-importing — and the
-- hash is never permanently blocked.
--
-- Live verification (Demo Co, 2026-07-28, report line 11) re-uploaded a
-- byte-identical CSV and got "no indication whatsoever that the file had been
-- seen before". These assertions are the database half of that fix.
--
-- Assertion index (15):
--    1  item_import_batches exists
--    2  sha256 is NOT NULL (a batch without a fingerprint dedupes nothing)
--    3  superseded_at is NULLABLE (a live batch has none)
--    4  the live-uniqueness index exists
--    5  organization_id FKs organizations(id)
--    6  superseded_by_id is a SELF-reference (lineage, 0286's shape)
--    7  RLS is enabled
--    8  a manager may record a batch in their own org
--    9  DEDUPE: a second LIVE batch of the same file in the same org is refused
--   10  ORG SCOPING: another org's identical file is unaffected
--   11  NEVER PERMANENTLY BLOCKED: superseding the predecessor frees the hash
--       for exactly one new live batch
--   12  ...and the predecessor SURVIVES, counts intact (superseded, not deleted)
--   13  ...and a THIRD live batch is refused again — the index still guards
--   14  WRITE GATE: a STAFF member CAN record a batch — items:import is a
--       staff default (0207:102) and the service writes on the caller's own
--       user-authed client, so a role floor would lock out the very users for
--       whom CSV import is a daily job
--   15  ...while a member whose items:import is REVOKED cannot
--   16  READ SCOPING: another org's member cannot see these batches at all
--
-- Namespace: 51304000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(16);

\set orgA  '\'51304000-0000-0000-0000-000000000001\''
\set orgB  '\'51304000-0000-0000-0000-000000000002\''
\set mgrA  '\'51304000-0000-0000-0000-000000000003\''
\set stfA  '\'51304000-0000-0000-0000-000000000004\''
\set stfR  '\'51304000-0000-0000-0000-000000000006\''
\set mgrB  '\'51304000-0000-0000-0000-000000000005\''
\set b1    '\'51304000-0000-0000-0000-0000000000e1\''
\set b2    '\'51304000-0000-0000-0000-0000000000e2\''
\set b3    '\'51304000-0000-0000-0000-0000000000e3\''

-- The on_auth_user_created trigger auto-creates the user_profiles rows.
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgrA, 'mgrA-0304@test.local', '{}'::jsonb),
  (:stfA, 'stfA-0304@test.local', '{}'::jsonb),
  (:stfR, 'stfR-0304@test.local', '{}'::jsonb),
  (:mgrB, 'mgrB-0304@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Import Org A 0304', 'import-org-a-0304'),
  (:orgB, 'Import Org B 0304', 'import-org-b-0304') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgrA, 'manager', now()),
  (:orgA, :stfA, 'staff',   now()),
  (:orgA, :stfR, 'staff',   now()),
  (:orgB, :mgrB, 'manager', now()) on conflict do nothing;

-- stfR is a staff member whose items:import has been REVOKED by an admin.
-- has_permission() resolves user override -> role override -> static default,
-- so this is the exact mechanism a real org uses to take the permission away.
insert into public.user_permission_overrides
  (organization_id, user_id, permission, granted)
  values (:orgA, :stfR, 'items:import', false) on conflict do nothing;

-- ── 1-3. The table and its columns ──────────────────────────────────────────
select has_table('public', 'item_import_batches',
  'item_import_batches exists');
select col_not_null('public', 'item_import_batches', 'sha256',
  'sha256 is NOT NULL — a batch with no fingerprint dedupes nothing');
select col_is_null('public', 'item_import_batches', 'superseded_at',
  'superseded_at is NULLABLE — a live batch has none');

-- ── 4. The dedupe guard ─────────────────────────────────────────────────────
select has_index('public', 'item_import_batches',
  'item_import_batches_org_sha_live_uniq',
  'the live (organization_id, sha256) unique index exists');

-- ── 5-6. Ownership and lineage ──────────────────────────────────────────────
select fk_ok('public', 'item_import_batches', 'organization_id',
             'public', 'organizations', 'id',
  'organization_id references organizations(id)');
select fk_ok('public', 'item_import_batches', 'superseded_by_id',
             'public', 'item_import_batches', 'id',
  'superseded_by_id is a SELF-reference — lineage, like po_imports 0286');

-- ── 7. RLS ──────────────────────────────────────────────────────────────────
select is(
  (select relrowsecurity from pg_class
    where oid = 'public.item_import_batches'::regclass),
  true,
  'row level security is enabled on item_import_batches');

-- ── As manager A (org A), under RLS ─────────────────────────────────────────
set local "request.jwt.claim.sub" to '51304000-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 8. A manager records the first import of a file ─────────────────────────
select lives_ok(
  $$ insert into public.item_import_batches
       (id, organization_id, sha256, file_name, row_count, created_count,
        imported_by)
     values ('51304000-0000-0000-0000-0000000000e1',
             '51304000-0000-0000-0000-000000000001',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'verify-sports-import.csv', 4, 4,
             '51304000-0000-0000-0000-000000000003') $$,
  'a manager may record an import batch in their own organization');

-- ── 9. THE FIX: the same file, live, twice, in one org is refused ───────────
-- This is the assertion that stands for report line 11. Without the partial
-- unique index the second upload lands and the org's stock silently doubles.
select throws_ok(
  $$ insert into public.item_import_batches
       (organization_id, sha256, file_name, row_count, created_count)
     values ('51304000-0000-0000-0000-000000000001',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'verify-sports-import.csv', 4, 4) $$,
  '23505', NULL,
  'a SECOND live batch of the same file in the same org is refused');

-- ── 10. …while another organization's identical file is untouched ───────────
reset role;
set local "request.jwt.claim.sub" to '51304000-0000-0000-0000-000000000005';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.item_import_batches
       (organization_id, sha256, file_name, row_count, created_count)
     values ('51304000-0000-0000-0000-000000000002',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'verify-sports-import.csv', 4, 4) $$,
  'the SAME file in ANOTHER organization is unaffected — dedupe is org-scoped');

-- ── 11-13. Supersede frees the hash for exactly one new live batch ──────────
reset role;
set local "request.jwt.claim.sub" to '51304000-0000-0000-0000-000000000003';
set local role to 'authenticated';

-- Stamp superseded_at FIRST (the successor does not exist yet, so lineage is
-- patched afterwards) — exactly the order the service has to use, because the
-- self-FK cannot point at a row that has not been inserted.
update public.item_import_batches set superseded_at = now() where id = :b1;

select lives_ok(
  $$ insert into public.item_import_batches
       (id, organization_id, sha256, file_name, row_count, created_count)
     values ('51304000-0000-0000-0000-0000000000e2',
             '51304000-0000-0000-0000-000000000001',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'verify-sports-import.csv', 4, 4) $$,
  'superseding the predecessor frees the hash — a file is NEVER permanently '
  'blocked (requirements: distinguish a retry from an intentional second run)');

update public.item_import_batches set superseded_by_id = :b2 where id = :b1;

select is(
  (select created_count::text || '/' || coalesce(file_name, 'NULL') || '/'
          || coalesce(superseded_by_id::text, 'NULL')
     from public.item_import_batches where id = :b1),
  '4/verify-sports-import.csv/51304000-0000-0000-0000-0000000000e2',
  'the predecessor SURVIVES with its counts and file name intact and points at '
  'its successor — superseded, never deleted, so the audit trail stays readable');

select throws_ok(
  $$ insert into public.item_import_batches
       (organization_id, sha256, file_name, row_count, created_count)
     values ('51304000-0000-0000-0000-000000000001',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'verify-sports-import.csv', 4, 4) $$,
  '23505', NULL,
  'a THIRD live batch is refused again — one supersede frees exactly ONE slot');

-- ── 14. THE WRITE GATE: a STAFF member CAN record a batch ───────────────────
-- REVIEW FIX. This policy used to demand has_org_role(...,'manager'). But
-- items:import is a STAFF default (0207:102) and ItemImportBatchesService.claim
-- writes on the caller's own user-authed client, so a manager floor made every
-- staff CSV import raise 42501 before a single item was created — breaking the
-- import for exactly the people who use it most. The gate is the PERMISSION.
reset role;
set local "request.jwt.claim.sub" to '51304000-0000-0000-0000-000000000004';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.item_import_batches
       (organization_id, sha256, file_name, row_count, created_count)
     values ('51304000-0000-0000-0000-000000000001',
             'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
             'staff.csv', 1, 1) $$,
  'a STAFF member CAN record a batch — items:import is a staff default, and a '
  'role floor here would lock staff out of CSV import entirely');

-- ── 15. …while a member whose items:import is REVOKED cannot ────────────────
reset role;
set local "request.jwt.claim.sub" to '51304000-0000-0000-0000-000000000006';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.item_import_batches
       (organization_id, sha256, file_name, row_count, created_count)
     values ('51304000-0000-0000-0000-000000000001',
             'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
             'revoked.csv', 1, 1) $$,
  '42501',
  'new row violates row-level security policy for table "item_import_batches"',
  'a member whose items:import is revoked cannot record or forge a fingerprint');

-- ── 16. Read scoping: org B's manager sees none of org A's batches ──────────
reset role;
set local "request.jwt.claim.sub" to '51304000-0000-0000-0000-000000000005';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.item_import_batches
    where organization_id = '51304000-0000-0000-0000-000000000001'),
  0,
  'another organization''s member sees none of org A''s import batches');

select * from finish();
rollback;
