-- supabase/tests/0276_realtime_po_imports.test.sql
-- Proves migration 0276 published po_imports for realtime, and that RLS
-- still scopes who may SELECT it (Realtime delivers a row event only to
-- subscribers whose RLS lets them read that row, so the SELECT policy IS
-- the realtime authorization boundary). Mirrors 0209's test shape, minus
-- REPLICA IDENTITY: po_imports transitions are INSERT/UPDATE only (cancel
-- is an UPDATE to status='canceled', never a DELETE), and default replica
-- identity delivers those — same accepted posture as the 0024 tables.

begin;
select plan(3);

-- ── Published for realtime ─────────────────────────────────────────────────
select ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'po_imports'
  ),
  'po_imports is in the supabase_realtime publication'
);

-- ── RLS is the delivery boundary: enabled + org-scoped SELECT policy ───────
select ok(
  (select c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'po_imports'),
  'po_imports has RLS enabled (realtime events are RLS-filtered)'
);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'po_imports'
      and cmd        = 'SELECT'
  ),
  'po_imports has a SELECT policy (the realtime authorization boundary)'
);

select * from finish();
rollback;
