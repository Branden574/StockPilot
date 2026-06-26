-- supabase/tests/0209_realtime_permission_overrides.test.sql
-- Proves migration 0209 published the permission-override tables for realtime,
-- and that RLS still scopes who may SELECT them (Supabase Realtime delivers a
-- row event only to subscribers whose RLS lets them read that row, so the SELECT
-- policy IS the realtime authorization boundary).

begin;
select plan(6);

-- ── REPLICA IDENTITY FULL (mig 0210) — required so DELETE events (taking a
--    permission away clears the override row) carry the full old row, letting
--    Realtime evaluate RLS + deliver them. Without it, revokes need a refresh. ─
select is(
  (select c.relreplident::text from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'role_permission_overrides'),
  'f',
  'role_permission_overrides has REPLICA IDENTITY FULL (DELETE events deliverable)'
);
select is(
  (select c.relreplident::text from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_permission_overrides'),
  'f',
  'user_permission_overrides has REPLICA IDENTITY FULL (DELETE events deliverable)'
);

-- ── Published for realtime ─────────────────────────────────────────────────
select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'role_permission_overrides'
  ),
  'role_permission_overrides is in the supabase_realtime publication'
);
select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'user_permission_overrides'
  ),
  'user_permission_overrides is in the supabase_realtime publication'
);

-- ── RLS still scopes realtime delivery (cross-tenant cannot read) ──────────
\set orgA   '\'a9000000-0000-0000-0000-0000000000a9\''
\set orgB   '\'b9000000-0000-0000-0000-0000000000b9\''
\set userA  '\'a9000000-0000-0000-0000-0000000000aa\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:userA, 'a@rt.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'RT Org A', 'rt-org-a'),
  (:orgB, 'RT Org B', 'rt-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :userA, 'viewer', now());
-- A role override in orgA (userA's org) and one in orgB (foreign).
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:orgA, 'viewer', 'reports:export', true),
  (:orgB, 'viewer', 'reports:export', true);

set local "request.jwt.claim.sub" to 'a9000000-0000-0000-0000-0000000000aa'; -- userA
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.role_permission_overrides
     where organization_id = 'a9000000-0000-0000-0000-0000000000a9'),
  1,
  'viewer can SELECT (→ receive realtime for) their OWN org role overrides'
);
select is(
  (select count(*)::int from public.role_permission_overrides
     where organization_id = 'b9000000-0000-0000-0000-0000000000b9'),
  0,
  'viewer cannot SELECT (→ never receives realtime for) another org''s overrides'
);
reset role;

select * from finish();
rollback;
