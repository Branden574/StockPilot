-- 0099_organization_members_role_guard.sql
--
-- Tighten the RLS surface on `organization_members` so an admin cannot
-- (via direct UPDATE/DELETE through the authenticated client):
--   * promote anyone to `owner`
--   * demote the existing `owner` to any other role
--   * delete the `owner` row
--
-- The existing `organization_members_update` policy (migration 0003)
-- gates UPDATE on `has_org_role(organization_id, 'admin')` only — admins
-- could rewrite any row's role, including the owner's. The
-- `organization_members_delete` policy had the same hole for the owner.
--
-- Postgres row policies don't expose NEW in their CHECK clause (Supabase
-- Postgres flat-out errors on `with check ... new.role <> 'owner' ...`),
-- so we enforce the constraints via a row-level BEFORE trigger which
-- DOES see NEW/OLD. The trigger is SECURITY DEFINER so it can read
-- auth.uid() and bypass when the operation is performed under the
-- service role (where auth.uid() is NULL) — that's how the application
-- layer's `transferOwnership` flow (which uses the admin client) is
-- allowed to perform the atomic swap.

create or replace function public._guard_organization_member_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role / superuser bypass. The admin client used by
  -- `transferOwnership` and `acceptInviteWithToken` runs with
  -- auth.uid() = NULL. We accept those writes; the application
  -- layer enforces the correct policy (owner-only, target valid).
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE' then
    -- An admin (or any authenticated caller) MUST NOT promote anyone
    -- to owner. The owner role is reassigned only via the
    -- ownership-transfer flow, which runs under the service role
    -- and bypasses this trigger via the auth.uid() is null branch.
    if new.role = 'owner' and old.role <> 'owner' then
      raise exception 'cannot promote member to owner via direct update'
        using errcode = 'insufficient_privilege';
    end if;

    -- The existing owner row MUST NOT be demoted via a normal admin
    -- UPDATE. transferOwnership demotes via the service role.
    if old.role = 'owner' and new.role <> 'owner' then
      raise exception 'cannot demote the owner via direct update'
        using errcode = 'insufficient_privilege';
    end if;

    return new;
  elsif tg_op = 'DELETE' then
    -- The owner row MUST NOT be deleted via a normal admin DELETE.
    if old.role = 'owner' then
      raise exception 'cannot remove the owner via direct delete'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists organization_members_role_guard on public.organization_members;
create trigger organization_members_role_guard
  before update or delete on public.organization_members
  for each row execute function public._guard_organization_member_changes();

-- The function is invoked via the trigger, so EXECUTE doesn't need to
-- be opened up. Lock it down explicitly.
revoke all on function public._guard_organization_member_changes() from public, anon, authenticated;

comment on function public._guard_organization_member_changes() is
  'BEFORE UPDATE/DELETE guard on organization_members. Blocks promoting '
  'anyone to owner, demoting the existing owner, and deleting the owner '
  'row from non-service-role paths. Bypassed under the service role '
  'where auth.uid() IS NULL — that path is reserved for atomic flows '
  'like transferOwnership and acceptInviteWithToken.';
