-- supabase/tests/0279_auditor_read_permissions.test.sql
-- pgTAP proof of migration 0279 (auditor read permissions):
--   1. The 13-row role_default_permissions seed mirrors ROLE_PERMISSIONS in
--      packages/core (staff holds cycle_counts:read, viewer does not,
--      manager holds returns:read). The total-count parity guard lives in
--      the 0207 test (96 -> 109).
--   2. rls_orgs_with_permission(p_permission) exists and resolves through
--      has_permission (owner short-circuit / user override / role override /
--      role default).
--   3. The audit_logs SELECT policy now follows the grantable
--      activity_logs:read permission instead of a hard manager+ role floor:
--      managers keep access (they hold the perm by default), a plain viewer
--      is denied, and a viewer granted activity_logs:read via a role
--      override CAN read.
--
-- Run via `supabase test db`. begin/rollback so nothing leaks. Users are
-- "become"d via request.jwt.claim.sub so auth.uid() resolves inside the
-- SECURITY DEFINER helpers.

begin;

select plan(8);

\set org_id  '\'ab027900-0000-0000-0000-0000000000aa\''
\set mgr_id  '\'ab027900-0000-0000-0000-000000000001\''
\set view_id '\'ab027900-0000-0000-0000-000000000002\''

-- ── Fixtures (seeded as the test superuser — RLS bypassed) ─────────────────
-- auth.users insert fires on_auth_user_created → creates user_profiles rows.
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr_id,  'mgr@auditor0279.test',  '{}'::jsonb),
  (:view_id, 'view@auditor0279.test', '{}'::jsonb);

insert into public.organizations (id, name, slug)
  values (:org_id, 'Auditor Read Test Org', 'auditor-read-test-org');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_id, :mgr_id,  'manager', now()),
  (:org_id, :view_id, 'viewer',  now());

insert into public.audit_logs (organization_id, user_id, event, metadata)
  values (:org_id, :mgr_id, 'test.audit_event', '{"note":"0279 fixture"}'::jsonb);

-- ── 1. Seed parity spot checks (count parity lives in the 0207 test) ───────
select ok(
  exists (select 1 from public.role_default_permissions
           where role = 'staff' and permission = 'cycle_counts:read'),
  'staff default includes cycle_counts:read'
);
select ok(
  not exists (select 1 from public.role_default_permissions
               where role = 'viewer' and permission = 'cycle_counts:read'),
  'viewer default excludes cycle_counts:read (grant-only)'
);
select ok(
  exists (select 1 from public.role_default_permissions
           where role = 'manager' and permission = 'returns:read'),
  'manager default includes returns:read'
);

-- ── 2. Helper exists ───────────────────────────────────────────────────────
select has_function('public', 'rls_orgs_with_permission', array['text'],
  'rls_orgs_with_permission(text) exists');

-- ── 3. audit_logs SELECT follows activity_logs:read ────────────────────────
-- Manager holds activity_logs:read by default → reads the row (unchanged
-- from the pre-0279 manager+ floor).
set local "request.jwt.claim.sub" to 'ab027900-0000-0000-0000-000000000001'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.audit_logs where organization_id = :org_id),
  1,
  'manager (default activity_logs:read) can read audit_logs'
);
reset role;

-- Plain viewer lacks activity_logs:read → zero rows.
set local "request.jwt.claim.sub" to 'ab027900-0000-0000-0000-000000000002'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.audit_logs where organization_id = :org_id),
  0,
  'plain viewer (no activity_logs:read) reads zero audit_logs rows'
);
reset role;

-- Grant activity_logs:read to the viewer ROLE via an override (as superuser),
-- and the same viewer session can now read — the exact auditor unlock.
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org_id, 'viewer', 'activity_logs:read', true);

set local "request.jwt.claim.sub" to 'ab027900-0000-0000-0000-000000000002'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.audit_logs where organization_id = :org_id),
  1,
  'viewer granted activity_logs:read via role override CAN read audit_logs'
);
select ok(
  :org_id in (select public.rls_orgs_with_permission('activity_logs:read')),
  'rls_orgs_with_permission(activity_logs:read) returns the org for the granted viewer'
);
reset role;

select * from finish();
rollback;
