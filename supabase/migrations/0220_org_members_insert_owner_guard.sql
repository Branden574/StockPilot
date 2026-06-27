-- 0220_org_members_insert_owner_guard.sql
-- Code-review follow-up to 0217. The 0217 INSERT policy correctly requires
-- has_org_role(org,'admin'), closing the any-authenticated-user cross-tenant
-- takeover — BUT the role-guard trigger (0099) only fires on UPDATE/DELETE, so
-- an org ADMIN can still INSERT a row with role='owner', self-escalating
-- admin→owner (gaining billing:manage + owner immutability) or minting a second
-- owner. Extend the guard to INSERT: an authenticated caller may not create an
-- owner row. The legitimate first-owner insert runs under the SERVICE ROLE
-- (auth.uid() IS NULL — org provisioning / transferOwnership / invite-accept),
-- which the existing bypass still allows.

create or replace function public._guard_organization_member_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role / superuser bypass. The admin client (auth.uid() = NULL) runs
  -- the atomic flows (provisioning, transferOwnership, acceptInviteWithToken);
  -- the application layer enforces correctness there.
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    -- An authenticated caller (an org admin per the 0217 INSERT policy) MUST
    -- NOT mint an owner row directly — that is an admin→owner self-escalation.
    -- The first owner is created under the service role, bypassed above.
    if new.role = 'owner' then
      raise exception 'cannot create an owner row via direct insert'
        using errcode = 'insufficient_privilege';
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    -- MUST NOT promote anyone to owner (ownership transfer runs service-role).
    if new.role = 'owner' and old.role <> 'owner' then
      raise exception 'cannot promote member to owner via direct update'
        using errcode = 'insufficient_privilege';
    end if;
    -- MUST NOT demote the existing owner via a normal admin UPDATE.
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
  before insert or update or delete on public.organization_members
  for each row execute function public._guard_organization_member_changes();

revoke all on function public._guard_organization_member_changes() from public, anon, authenticated;
