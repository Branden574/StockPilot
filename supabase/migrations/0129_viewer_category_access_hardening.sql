-- 0129_viewer_category_access_hardening.sql
--
-- Three security fixes on the viewer-category-visibility feature
-- shipped in 0128:
--
-- 1) RLS bypass via policy OR'ing
--    Postgres RLS policies of the same (table, command, role) are
--    OR'd, not AND'd. 0128 added new SELECT policies
--    inventory_items_category_visibility and categories_visibility,
--    but the pre-existing inventory_items_select (migration 0008)
--    and categories_select (migration 0003) were still active —
--    meaning a restricted viewer's row would satisfy the OLD policy
--    and slip past the new filter entirely. The category-visibility
--    feature wasn't actually filtering at the DB. This migration
--    REPLACES the existing select policies so the visibility check
--    is AND'd into the existing predicates.
--
-- 2) Cross-org role bypass in user_can_see_item_category
--    The 0128 RPC picked role from the user's OLDEST membership
--    across ALL orgs. A viewer-with-grants in org B who also held
--    manager role in org A (older) would bypass restrictions in B.
--    This rewrites the RPC to take p_org_id explicitly and only
--    consider the role IN THAT ORG, with accepted_at-is-not-null
--    filter so pending invites can't grant elevated privileges.
--
-- 3) Atomic-replace for set_user_category_access
--    The JS service used DELETE-then-INSERT, two separate Supabase
--    requests. If the INSERT failed after the DELETE succeeded, the
--    viewer ended up with zero rows = unrestricted (silent privilege
--    escalation). New SECURITY DEFINER RPC does both inside one
--    transaction — failure rolls back, viewer stays restricted.

-- ─────────────────────────────────────────────────────────────────────
-- 1) Rewrite user_can_see_item_category to be org-aware
-- ─────────────────────────────────────────────────────────────────────
-- The signature changes: (p_user_id uuid, p_org_id uuid, p_category_id uuid).
-- Old 2-arg version is dropped at the end after the policies that
-- referenced it are rebuilt to call the new one.
create or replace function public.user_can_see_item_category(
  p_user_id     uuid,
  p_org_id      uuid,
  p_category_id uuid
) returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_role text;
begin
  -- Resolve the user's role IN THIS SPECIFIC ORG.
  -- accepted_at IS NOT NULL excludes pending invites — same gate
  -- has_org_role uses (migration 0001).
  select role::text into v_role
  from public.organization_members
  where user_id = p_user_id
    and organization_id = p_org_id
    and accepted_at is not null
  limit 1;

  if v_role is null then
    return false;
  end if;

  if v_role in ('owner','admin','manager','staff') then
    return true;
  end if;

  -- viewer branch
  if v_role = 'viewer' then
    -- Unrestricted if zero assignments IN THIS ORG.
    if not exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
        and organization_id = p_org_id
    ) then
      return true;
    end if;

    -- Restricted: null-category items are never visible.
    if p_category_id is null then
      return false;
    end if;

    return exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
        and organization_id = p_org_id
        and category_id = p_category_id
    );
  end if;

  return false;
end;
$$;

revoke all on function public.user_can_see_item_category(uuid, uuid, uuid) from public, anon;
grant execute on function public.user_can_see_item_category(uuid, uuid, uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 2) Replace inventory_items SELECT policy so the visibility filter
--    is AND'd with the existing warehouse-access predicate.
--    DROP the 0128 standalone policy too — it's now redundant.
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists inventory_items_category_visibility on public.inventory_items;
drop policy if exists inventory_items_select on public.inventory_items;

create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    public.user_can_access_inventory(auth.uid(), warehouse_id, charter_id, 'read')
    and public.user_can_see_item_category(auth.uid(), organization_id, category_id)
  );

-- ─────────────────────────────────────────────────────────────────────
-- 3) Replace categories SELECT policy so the visibility filter is
--    AND'd with the existing org-membership predicate.
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists categories_visibility on public.categories;
drop policy if exists categories_select on public.categories;

create policy categories_select on public.categories
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    and public.user_can_see_item_category(auth.uid(), organization_id, id)
  );

-- ─────────────────────────────────────────────────────────────────────
-- 4) Drop the old 2-arg version of the RPC — no callers now use it
--    (the policies were the only callers and have been rebuilt above).
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.user_can_see_item_category(uuid, uuid);

-- ─────────────────────────────────────────────────────────────────────
-- 5) Atomic-replace RPC for setting a user's category access.
--    Replaces the JS service's DELETE-then-INSERT with a single
--    server-side transaction so a mid-flight failure can't leave the
--    viewer in the "no rows = unrestricted" state.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.set_user_category_access(
  p_org_id        uuid,
  p_user_id       uuid,
  p_caller_id     uuid,
  p_category_ids  uuid[]
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Authorization is enforced at the service layer (assertPermission),
  -- but defense in depth: caller must be manager+ in THIS org.
  if not public.has_org_role(p_org_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Target user must be a member of THIS org.
  if not exists (
    select 1 from public.organization_members
    where user_id = p_user_id
      and organization_id = p_org_id
  ) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Atomic replace.
  delete from public.user_category_assignments
  where user_id = p_user_id and organization_id = p_org_id;

  if p_category_ids is not null and array_length(p_category_ids, 1) > 0 then
    insert into public.user_category_assignments
      (organization_id, user_id, category_id, assigned_by)
    select p_org_id, p_user_id, unnest(p_category_ids), p_caller_id;
  end if;
end;
$$;

revoke all on function public.set_user_category_access(uuid, uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_user_category_access(uuid, uuid, uuid, uuid[]) to authenticated;
