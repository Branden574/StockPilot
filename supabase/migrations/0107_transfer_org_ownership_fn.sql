-- 0107_transfer_org_ownership_fn.sql
-- SECURITY DEFINER function that atomically swaps the owner role
-- between two organization_members rows. Used by the application-
-- layer transferOwnership flow.
--
-- Why a function (vs. two separate UPDATEs from the admin client):
--   * Atomicity — the swap must succeed or fail as one transaction.
--     A crash mid-swap would otherwise leave the org with no owner.
--   * Single audit-able SQL surface — RLS gets out of the way for
--     this one operation; the function enforces invariants once
--     instead of trusting every caller to do the same checks.
--   * Bypass of `_guard_organization_member_changes` happens via the
--     existing `auth.uid() is null` branch, so we run as definer
--     with no current end-user identity.
--
-- The function returns the *new* owner's user_id on success, so the
-- caller can use it for audit logging without doing a follow-up
-- SELECT.

create or replace function public.transfer_org_ownership(
  p_organization_id uuid,
  p_caller_user_id  uuid,
  p_target_user_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_member_id uuid;
  v_target_member_id uuid;
  v_target_role text;
begin
  -- Caller must be the current owner of this org.
  select id into v_caller_member_id
    from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_caller_user_id
     and role = 'owner'
     and accepted_at is not null;
  if v_caller_member_id is null then
    raise exception 'caller is not the current owner'
      using errcode = 'insufficient_privilege';
  end if;

  -- Target must be an accepted member of the same org and NOT the caller.
  if p_target_user_id = p_caller_user_id then
    raise exception 'cannot transfer ownership to yourself'
      using errcode = 'invalid_parameter_value';
  end if;
  select id, role into v_target_member_id, v_target_role
    from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_target_user_id
     and accepted_at is not null;
  if v_target_member_id is null then
    raise exception 'target user is not an active member of this organization'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_target_role = 'owner' then
    raise exception 'target is already the owner'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Atomic swap. Both UPDATEs run under SECURITY DEFINER, so
  -- auth.uid() is the postgres role (not the calling user), which
  -- means the role-guard trigger's "service-role" branch fires and
  -- allows the owner demotion + the non-owner promotion to owner.
  update public.organization_members
     set role = 'admin'
   where id = v_caller_member_id;

  update public.organization_members
     set role = 'owner'
   where id = v_target_member_id;

  return p_target_user_id;
end;
$$;

revoke all on function public.transfer_org_ownership(uuid, uuid, uuid)
  from public, anon, authenticated;

-- Only the service role (and superuser) may call this. The action
-- layer uses createAdminClient() which runs with the service role.
grant execute on function public.transfer_org_ownership(uuid, uuid, uuid)
  to service_role;

comment on function public.transfer_org_ownership(uuid, uuid, uuid) is
  'Atomically transfers org ownership from p_caller_user_id to p_target_user_id. '
  'Returns the new owner user_id. Service-role only — the application layer '
  'must verify the caller actually IS the owner (and ideally require AAL2 + '
  'a password re-confirm) before invoking.';
