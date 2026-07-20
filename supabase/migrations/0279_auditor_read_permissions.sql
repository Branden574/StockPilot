-- 0279_auditor_read_permissions.sql
-- ============================================================================
-- Auditor visibility, Unit 1 (2026-07-20 owner request): read-only auditors
-- log in and "don't see anything" because five surfaces (cycle counts,
-- schedule, bundles, rentals, returns) gate their nav/pages on WRITE
-- permissions, and the audit log is hardcoded to a manager+ RLS floor. This
-- migration lays the DB groundwork:
--
-- 1. Five new grantable READ permissions — cycle_counts:read, schedule:read,
--    bundles:read, rentals:read, returns:read — seeded into
--    role_default_permissions to MIRROR the current write-perm holders
--    exactly (admin + manager: all five; staff: cycle_counts/bundles/rentals;
--    viewer: none). Zero behavior change for existing roles; a viewer gains a
--    surface only when an admin grants the read perm via the matrix.
--    Pattern of migs 0250/0261/0274; the 0207 parity pgTAP counts these rows
--    (96 -> 109). ROLE_PERMISSIONS in packages/core is the TS twin.
--
-- 2. rls_orgs_with_permission(p_permission): a permission-aware sibling of
--    rls_manager_org_ids (0230) — "every org where I'm an active member AND
--    has_permission(org, p) resolves true". Same zero-arg-per-row / STABLE /
--    SECURITY DEFINER shape so `organization_id in (select ...)` policies
--    hash-materialize it once per statement (perf posture of 0229/0230/0272).
--    Deviation from 0230: search_path pinned to '' (fully-qualified refs)
--    rather than 'public' — strictly tighter, same semantics.
--
-- 3. audit_logs SELECT policy swap: the 0272 policy's rls_manager_org_ids
--    (a hard manager+ ROLE floor no grant can cross) is replaced with
--    rls_orgs_with_permission('activity_logs:read'). Managers/admins hold
--    activity_logs:read by default, so they keep exactly the access they
--    have today; a viewer/staff granted activity_logs:read (role or user
--    override) can now actually read the rows their new page shows.
-- ============================================================================

-- ── 1. Default-permission seed (13 rows; mirrors ROLE_PERMISSIONS in core;
--       the 0207 parity pgTAP counts these rows). Owner rows are never
--       seeded — has_permission() short-circuits owner to true. ─────────────
insert into public.role_default_permissions (role, permission) values
  ('admin',   'cycle_counts:read'),
  ('admin',   'schedule:read'),
  ('admin',   'bundles:read'),
  ('admin',   'rentals:read'),
  ('admin',   'returns:read'),
  ('manager', 'cycle_counts:read'),
  ('manager', 'schedule:read'),
  ('manager', 'bundles:read'),
  ('manager', 'rentals:read'),
  ('manager', 'returns:read'),
  -- Staff already hold the matching WRITE perms on these three surfaces
  -- (stock:adjust drives cycle counts, bundles:distribute, rentals:create),
  -- so the read perms keep what they see today unchanged. Staff do NOT get
  -- schedule:read / returns:read — those surfaces were manager+ before.
  ('staff',   'cycle_counts:read'),
  ('staff',   'bundles:read'),
  ('staff',   'rentals:read')
on conflict (role, permission) do nothing;

-- ── 2. rls_orgs_with_permission(p_permission) ───────────────────────────────
-- Membership predicate mirrors rls_manager_org_ids (0230): accepted and not
-- an expired impersonation grant. The impersonation guard matters — dropping
-- it would let an EXPIRED platform-admin "Act as" membership (0177) pass the
-- has_permission check (which only looks at accepted_at) and regain
-- audit_logs read. has_permission (0207) then resolves owner short-circuit,
-- user override, role override, and role default in that order.
create or replace function public.rls_orgs_with_permission(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = (select auth.uid())
    and m.accepted_at is not null
    and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    and public.has_permission(m.organization_id, p_permission)
$$;

comment on function public.rls_orgs_with_permission(text) is
  'RLS helper (0279): every org where auth.uid() is an accepted, unexpired member AND has_permission(org, p_permission) is true — rls_manager_org_ids (0230) with the role floor replaced by the configurable-permission resolver, for hashed IN probes on permission-gated tables.';

revoke all on function public.rls_orgs_with_permission(text) from public, anon;
grant execute on function public.rls_orgs_with_permission(text) to authenticated;

-- ── 3. audit_logs SELECT: role floor -> grantable permission ────────────────
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (organization_id in (select public.rls_orgs_with_permission('activity_logs:read')));
