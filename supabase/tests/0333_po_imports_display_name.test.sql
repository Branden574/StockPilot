-- supabase/tests/0333_po_imports_display_name.test.sql
-- Proves migration 0333: po_imports gains a nullable, user-editable
-- `display_name` label, and duplicate identity is COMPLETELY untouched by it.
--
-- Two halves, and the second is the load-bearing one:
--
--   A. The column itself — exists, stays NULLABLE (no backfill; historical rows
--      keep rendering file_name), and its inline CHECK bounds the text at
--      `between 1 and 160`: 1 accepted, 160 accepted, 161 refused, '' refused,
--      NULL accepted.
--
--   B. po_imports_org_sha_uniq is UNCHANGED. Same-file detection is and stays
--      sha256-based; naming two imports differently must not let a duplicate
--      through. The definition this migration must leave exactly as 0287
--      (supabase/migrations/0287_po_import_supersede_for_reimport.sql:38-43)
--      left it is, verbatim:
--
--        create unique index po_imports_org_sha_uniq
--          on public.po_imports (organization_id, sha256)
--          where status <> all (array['failed'::text, 'canceled'::text, 'duplicate'::text])
--            and superseded_at is null;
--
--      Pinned three ways rather than by string-matching pg_get_indexdef's
--      output (whose parenthesisation/casing is a Postgres formatting detail,
--      not the property under test): the KEY COLUMNS are pinned literally to
--      exactly {organization_id, sha256} with indnatts = 2 (so no fourth
--      column — display_name least of all — can join the key), the predicate is
--      pinned to never mention display_name, and then the rule is exercised
--      FUNCTIONALLY: same (org, sha256) with two different display_names still
--      collides with 23505, while the two documented escape hatches (a dead
--      status, a superseded predecessor) still let a re-import through.
--
-- Fixtures inserted as postgres (bypassing RLS — column CHECKs and unique
-- indexes are not RLS boundaries). Namespace: a0333000. begin/rollback.
--
-- PLAN: hand-counted 16 assertions — A: 8 (3 structural + 5 functional CHECK),
-- B: 8 (5 structural + 3 functional duplicate-identity).

begin;

select plan(16);

\set org  '\'a0333000-0000-0000-0000-000000000001\''
\set usr  '\'a0333000-0000-0000-0000-000000000002\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'display-name-0333@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Display Name Org 0333', 'display-name-0333')
  on conflict (id) do nothing;

-- One helper so every insert below differs ONLY in the two columns under test
-- (sha256 and display_name). storage_path is shaped to satisfy
-- po_imports_storage_path_safe (0323).
create or replace function pg_temp.mk_import(p_sha text, p_display text)
returns uuid language sql as $$
  insert into public.po_imports (
    organization_id, uploaded_by, source_type, file_name, file_mime_type,
    file_size, storage_path, sha256, status, display_name
  ) values (
    'a0333000-0000-0000-0000-000000000001', 'a0333000-0000-0000-0000-000000000002',
    'csv', 'image.jpg', 'text/csv', 10,
    'a0333000-0000-0000-0000-000000000001/po-imports/' || p_sha || '.csv',
    p_sha, 'uploaded', p_display
  ) returning id;
$$;

-- ── A. the column ───────────────────────────────────────────────────────────
select has_column('public', 'po_imports', 'display_name',
  'po_imports.display_name exists');
select col_is_null('public', 'po_imports', 'display_name',
  'po_imports.display_name is NULLABLE — no backfill; unnamed rows still render file_name');
select col_has_check('public', 'po_imports', 'display_name',
  'po_imports.display_name carries its length CHECK');

-- NULL is the historical/default state and must stay insertable.
select lives_ok(
  $$ select pg_temp.mk_import(repeat('a', 64), null) $$,
  'a NULL display_name is accepted (an unnamed import is still a valid import)');

-- The two ends of `between 1 and 160`.
select lives_ok(
  $$ select pg_temp.mk_import(repeat('b', 64), 'A') $$,
  'a 1-character display_name is accepted (lower bound of the CHECK)');
select lives_ok(
  $$ select pg_temp.mk_import(repeat('c', 64), repeat('x', 160)) $$,
  'a 160-character display_name is accepted (upper bound of the CHECK)');

select throws_ok(
  $$ select pg_temp.mk_import(repeat('d', 64), repeat('x', 161)) $$,
  '23514', null,
  'a 161-character display_name is REFUSED by the length CHECK');
select throws_ok(
  $$ select pg_temp.mk_import(repeat('e', 64), '') $$,
  '23514', null,
  'an empty-string display_name is REFUSED — "no name" is spelled NULL, not ''''');

-- ── B. duplicate identity is untouched ──────────────────────────────────────
select has_index('public', 'po_imports', 'po_imports_org_sha_uniq',
  'the partial unique index po_imports_org_sha_uniq still exists');
select index_is_unique('public', 'po_imports', 'po_imports_org_sha_uniq',
  'po_imports_org_sha_uniq is still UNIQUE');

select is(
  (select indnatts from pg_index where indexrelid = 'public.po_imports_org_sha_uniq'::regclass),
  2::smallint,
  'po_imports_org_sha_uniq still keys on exactly 2 columns (nothing was added to the key)');

select is(
  (select array_agg(pg_get_indexdef('public.po_imports_org_sha_uniq'::regclass, k, true) order by k)
     from generate_series(1, 2) as k),
  array['organization_id', 'sha256'],
  'po_imports_org_sha_uniq still keys on exactly (organization_id, sha256)');

select ok(
  (select pg_get_expr(indpred, indrelid) not like '%display_name%'
     from pg_index where indexrelid = 'public.po_imports_org_sha_uniq'::regclass),
  'po_imports_org_sha_uniq''s partial predicate does not mention display_name');

-- FUNCTIONAL: a different name does NOT make a different file. repeat('a',64)
-- was already inserted above with a NULL name; naming this one must not help.
select throws_ok(
  $$ select pg_temp.mk_import(repeat('a', 64), 'August DC4 Book Order') $$,
  '23505', null,
  'a second live import of the SAME sha256 is refused even under a different display_name');

-- The two documented escape hatches still work, so this migration neither
-- tightened nor loosened the rule.
update public.po_imports set status = 'canceled' where sha256 = repeat('b', 64);
select lives_ok(
  $$ select pg_temp.mk_import(repeat('b', 64), 'redo of a cancelled import') $$,
  'a dead-status predecessor still frees the hash (status half of the predicate intact)');

update public.po_imports set superseded_at = now() where sha256 = repeat('c', 64);
select lives_ok(
  $$ select pg_temp.mk_import(repeat('c', 64), 'redo after supersede') $$,
  'a superseded predecessor still frees the hash (0287 half of the predicate intact)');

select * from finish();
rollback;
