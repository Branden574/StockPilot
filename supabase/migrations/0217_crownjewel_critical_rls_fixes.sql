-- 0217_crownjewel_critical_rls_fixes.sql
-- Two CRITICAL data-security fixes from the deep crown-jewel review (2026-06-27).

-- ── #6 CROSS-TENANT TAKEOVER: organization_members self-insert ──────────────
-- The INSERT policy (0140) allowed `user_id = auth.uid()` with ANY role into
-- ANY org, and the role-guard trigger (0099) only covers UPDATE/DELETE — so any
-- authenticated user who knows an org's id could `insert ... (org, auth.uid(),
-- 'owner', now())` and become OWNER of that org (full cross-tenant takeover).
-- Every legitimate member insert goes through the SERVICE-ROLE admin client (org
-- creation organization.ts:74, provisioning platform-admin.ts:150, invites
-- team.ts) which bypasses RLS — so the self-insert branch serves no legitimate
-- purpose. Require admin on the TARGET org.
drop policy if exists organization_members_insert on public.organization_members;
create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check ( ( SELECT public.has_org_role(organization_id, 'admin') ) );

-- ── #3 IMPERSONATION PERSISTENCE: has_permission() ignores expiry ───────────
-- has_org_role (hardened in 0177) filters expired platform-admin "Act as"
-- grants, but has_permission() did NOT — so an EXPIRED impersonation kept
-- owner-level WRITE access via the `has_org_role(manager) OR has_permission(...)`
-- branch on the P3/P5 write RLS (items/stock/POs/etc). Add the same expiry
-- guard to the membership lookup. Body otherwise identical to 0207.
create or replace function public.has_permission(org_id uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with usr as (
    select m.role
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
    limit 1
  )
  select case
    when not exists (select 1 from usr) then false
    when (select role from usr) = 'owner' then true
    else coalesce(
      ( select upo.granted
          from public.user_permission_overrides upo
         where upo.organization_id = org_id
           and upo.user_id = auth.uid()
           and upo.permission = perm ),
      ( select rpo.granted
          from public.role_permission_overrides rpo
         where rpo.organization_id = org_id
           and rpo.role = (select role from usr)
           and rpo.permission = perm ),
      ( select true
          from public.role_default_permissions rdp
         where rdp.role = (select role from usr)
           and rdp.permission = perm ),
      false
    )
  end
$$;
