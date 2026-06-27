-- 0215_permission_override_no_escalation_rls.sql
-- Encode the "you can only GRANT a permission you already hold" invariant in
-- RLS, so it holds regardless of write path. Until now this lived ONLY in the
-- app action (assertCanGrant in actions/permissions.ts); the override tables'
-- INSERT/UPDATE policies checked only has_org_role(...,'admin'), so an admin
-- writing the table directly could grant themselves an owner-reserved
-- permission (e.g. billing:manage). has_permission(org, perm) resolves for the
-- WRITER (auth.uid()), so a granted=true row now requires the writer to hold
-- that permission. Revokes/denies (granted=false) stay unrestricted. The app's
-- assertCanGrant remains as defense-in-depth.

-- ── role_permission_overrides ──────────────────────────────────────────────
drop policy if exists role_permission_overrides_insert on public.role_permission_overrides;
create policy role_permission_overrides_insert on public.role_permission_overrides
  for insert to authenticated
  with check (
    ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') )
    and (
      role_permission_overrides.granted = false
      or ( SELECT public.has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) )
    )
  );

drop policy if exists role_permission_overrides_update on public.role_permission_overrides;
create policy role_permission_overrides_update on public.role_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') )
    and (
      role_permission_overrides.granted = false
      or ( SELECT public.has_permission(role_permission_overrides.organization_id, role_permission_overrides.permission) )
    )
  );

-- ── user_permission_overrides ──────────────────────────────────────────────
drop policy if exists user_permission_overrides_insert on public.user_permission_overrides;
create policy user_permission_overrides_insert on public.user_permission_overrides
  for insert to authenticated
  with check (
    ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') )
    and (
      user_permission_overrides.granted = false
      or ( SELECT public.has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) )
    )
  );

drop policy if exists user_permission_overrides_update on public.user_permission_overrides;
create policy user_permission_overrides_update on public.user_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) )
  with check (
    ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') )
    and (
      user_permission_overrides.granted = false
      or ( SELECT public.has_permission(user_permission_overrides.organization_id, user_permission_overrides.permission) )
    )
  );
