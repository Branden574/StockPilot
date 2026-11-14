-- supabase/tests/audit_logs_row_id_contract.test.sql
-- What the web's audit writer relies on (apps/web/src/server/services/audit.ts):
-- the writer chooses each row's id before the first try, and a later try
-- sends the same row as `insert ... on conflict (id) do nothing` (PostgREST
-- `Prefer: resolution=ignore-duplicates`, `on_conflict=id`) with the time of
-- the event in created_at. No migration is involved; this pins the table as
-- it is, so the web stays right on it.
--
-- WHAT IS PINNED
--   1. id is the primary key, and the only unique index: the skip is decided
--      by the id alone. A later try of a batch writes the rows that are not
--      there and leaves the ones that are.
--   2. As the server's role (service_role): a row with a chosen id is written;
--      the later try with the same id writes nothing and changes nothing (the
--      first row's values and time stay); with a new id it writes the row
--      with the created_at it was sent.
--   3. The other order: when a later try wrote the row first, the abandoned
--      first try that arrives after it is refused (23505): still one row.
--   4. A member and a signed-out caller cannot insert at all (RLS on, no
--      insert policy), so nobody but the server can put a row with an id in
--      the table ahead of the writer.
--
-- Namespace a0800000. Wrapped in begin/rollback: nothing leaks.
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(16);

\set rowA '\'a0800000-0000-4000-8000-0000000000a1\''
\set rowB '\'a0800000-0000-4000-8000-0000000000b1\''
\set rowC '\'a0800000-0000-4000-8000-0000000000c1\''
\set rowD '\'a0800000-0000-4000-8000-0000000000d1\''
\set member '\'a0800000-0000-4000-8000-0000000000e1\''

-- ── 1. The key ──────────────────────────────────────────────────────────────
select col_is_pk('public', 'audit_logs', 'id', 'S80/1: id is the primary key');
-- Indexes, not constraints: a plain or partial unique index makes no
-- constraint row, and any second unique index would refuse a later try's row.
select is(
  (select array_agg(c.relname::text order by c.relname)
     from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.audit_logs'::regclass and i.indisunique),
  array['audit_logs_pkey'],
  'S80/2: the primary key is the only unique index');
select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'audit_logs'),
  'S80/3: RLS is enabled');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs' and cmd <> 'SELECT'),
  0,
  'S80/4: no policy lets a member insert, update or delete');

-- ── 2. The server's role: first try, then a later try ───────────────────────
set local role to 'service_role';

select lives_ok(
  $$ insert into public.audit_logs (id, event, metadata)
     values ('a0800000-0000-4000-8000-0000000000a1', 'user.sign_in_failed', '{"try": 1}') $$,
  'S80/5: a row with an id chosen by the writer is written');
select lives_ok(
  $$ insert into public.audit_logs (id, event, metadata, created_at)
     values ('a0800000-0000-4000-8000-0000000000a1', 'user.sign_in_failed', '{"try": 2}',
             '2026-01-01 00:00:00+00')
     on conflict (id) do nothing $$,
  'S80/6: the later try with the same id is accepted');
select is(
  (select count(*)::int from public.audit_logs where id = :rowA),
  1,
  'S80/7: and writes nothing: one row');
select is(
  (select metadata->>'try' from public.audit_logs where id = :rowA),
  '1',
  'S80/8: the stored row keeps the first try''s values');
select isnt(
  (select created_at from public.audit_logs where id = :rowA),
  '2026-01-01 00:00:00+00'::timestamptz,
  'S80/9: and the first try''s time (the later try changes nothing)');

select lives_ok(
  $$ insert into public.audit_logs (id, event, metadata, created_at)
     values ('a0800000-0000-4000-8000-0000000000b1', 'user.sign_in_failed', '{"try": 2}',
             '2026-11-14 10:00:00+00')
     on conflict (id) do nothing $$,
  'S80/10: a later try whose first never landed writes the row');
select is(
  (select created_at from public.audit_logs where id = :rowB),
  '2026-11-14 10:00:00+00'::timestamptz,
  'S80/11: with the time of the event it was sent with');

-- A later try of a batch in which one row is already there writes the others.
select lives_ok(
  $$ insert into public.audit_logs (id, event, metadata, created_at)
     values ('a0800000-0000-4000-8000-0000000000a1', 'user.sign_in_failed', '{"try": 2}', '2026-11-14 10:00:00+00'),
            ('a0800000-0000-4000-8000-0000000000a2', 'user.sign_in_failed', '{"try": 2}', '2026-11-14 10:00:00+00'),
            ('a0800000-0000-4000-8000-0000000000a3', 'user.sign_in_failed', '{"try": 2}', '2026-11-14 10:00:00+00')
     on conflict (id) do nothing $$,
  'S80/15: a later try of a batch with one row already there is accepted');
select is(
  (select array_agg(metadata->>'try' order by id) from public.audit_logs
    where id in ('a0800000-0000-4000-8000-0000000000a1', 'a0800000-0000-4000-8000-0000000000a2',
                 'a0800000-0000-4000-8000-0000000000a3')),
  array['1', '2', '2'],
  'S80/16: and writes the two that were not, leaving the one that was');

-- ── 3. The other order: the later try landed first ──────────────────────────
insert into public.audit_logs (id, event, metadata, created_at)
  values (:rowC, 'user.sign_in_failed', '{"try": 2}', '2026-11-14 10:00:00+00')
  on conflict (id) do nothing;
select throws_ok(
  $$ insert into public.audit_logs (id, event, metadata)
     values ('a0800000-0000-4000-8000-0000000000c1', 'user.sign_in_failed', '{"try": 1}') $$,
  '23505', null,
  'S80/12: an abandoned first try arriving after the later one is refused: still one row');
reset role;

-- ── 4. Nobody else can put a row with an id in the table ────────────────────
set local "request.jwt.claim.sub" to 'a0800000-0000-4000-8000-0000000000e1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.audit_logs (id, event, metadata)
     values ('a0800000-0000-4000-8000-0000000000d1', 'user.sign_in_failed', '{}') $$,
  '42501', null,
  'S80/13: a member cannot insert an audit row');
reset role;

set local role to 'anon';
select throws_ok(
  $$ insert into public.audit_logs (id, event, metadata)
     values ('a0800000-0000-4000-8000-0000000000d1', 'user.sign_in_failed', '{}') $$,
  '42501', null,
  'S80/14: a signed-out caller cannot insert an audit row');
reset role;

select * from finish();
rollback;
