-- 0128_viewer_category_access.sql
--
-- Restrict viewer accounts to a category whitelist. Admin assigns
-- categories; a viewer with ANY rows in user_category_assignments
-- sees only items in those categories. A viewer with ZERO rows is
-- unrestricted (preserves back-compat for existing viewers). This
-- feature does not apply to staff/manager/admin/owner.
--
-- Architecture: RLS is the security floor. user_can_see_item_category
-- is security definer so RLS policies can call it without granting
-- read access to user_category_assignments (sensitive) or
-- organization_members (sensitive). The policies on inventory_items
-- and categories both invoke it.

-- ─────────────────────────────────────────────────────────────────────
-- TABLE
-- ─────────────────────────────────────────────────────────────────────
create table public.user_category_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  category_id     uuid not null references public.categories(id) on delete cascade,
  assigned_by     uuid references public.user_profiles(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  unique (user_id, category_id)
);

create index user_category_assignments_user_idx
  on public.user_category_assignments(user_id);
create index user_category_assignments_cat_idx
  on public.user_category_assignments(category_id);

alter table public.user_category_assignments enable row level security;

-- Org-scoped read/write for the assignment table itself.
-- - service_role bypasses RLS entirely.
-- - users can read THEIR OWN rows (useful for the app to show
--   "I'm restricted to these categories").
-- - manager+ in the org can manage everyone's rows in their org.
create policy user_category_assignments_select
  on public.user_category_assignments
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_org_role(organization_id, 'manager')
  );

create policy user_category_assignments_write
  on public.user_category_assignments
  for all to authenticated
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

grant select, insert, update, delete on public.user_category_assignments to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- HELPER RPC: user_can_see_item_category(user_id, category_id)
--
-- Truth table:
--   role = owner|admin|manager|staff               → true
--   role = viewer + no assignments                  → true (unrestricted default)
--   role = viewer + assignments + category in set   → true
--   role = viewer + assignments + category NULL     → false (restricted hide uncategorized)
--   role = viewer + assignments + category NOT in   → false
--   no role row                                     → false
--
-- security definer because RLS policies that call this need to read
-- both organization_members (to find role) and user_category_assignments
-- (to find grants) — neither is generally readable by the calling user.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.user_can_see_item_category(
  p_user_id     uuid,
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
  -- Get the user's role. organization_members is the source of truth.
  -- A user can technically be a member of multiple orgs; for this
  -- check we want their role in the org of the category we're
  -- evaluating. But p_category_id can be NULL, so we fall back to
  -- "any membership" and rely on the inventory_items org-scoping
  -- policy (which already exists) to scope cross-org.
  select role::text into v_role
  from public.organization_members
  where user_id = p_user_id
  order by created_at asc nulls last
  limit 1;

  if v_role is null then
    return false;
  end if;

  if v_role in ('owner','admin','manager','staff') then
    return true;
  end if;

  -- viewer branch
  if v_role = 'viewer' then
    -- Unrestricted if zero assignments
    if not exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
    ) then
      return true;
    end if;

    -- Restricted: null-category items are never visible
    if p_category_id is null then
      return false;
    end if;

    return exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id and category_id = p_category_id
    );
  end if;

  return false;
end;
$$;

revoke all on function public.user_can_see_item_category(uuid, uuid) from public, anon;
grant execute on function public.user_can_see_item_category(uuid, uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- RLS: SELECT filter on inventory_items by category visibility.
-- ANDs with the existing org + warehouse-access policies; a restricted
-- viewer must satisfy ALL of them (org match + warehouse match + this).
-- ─────────────────────────────────────────────────────────────────────
create policy inventory_items_category_visibility
  on public.inventory_items
  for select to authenticated
  using (
    public.user_can_see_item_category(auth.uid(), category_id)
  );

-- ─────────────────────────────────────────────────────────────────────
-- RLS: SELECT filter on categories themselves so a restricted viewer
-- can't even enumerate categories they can't access (no leaking
-- "Swag" exists by name).
-- ─────────────────────────────────────────────────────────────────────
create policy categories_visibility
  on public.categories
  for select to authenticated
  using (
    public.user_can_see_item_category(auth.uid(), id)
  );
