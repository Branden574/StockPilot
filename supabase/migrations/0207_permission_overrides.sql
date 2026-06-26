-- 0207_permission_overrides.sql
-- Configurable permissions (P1). Lets org admins/owners grant or revoke
-- individual permissions per ROLE and per USER on top of the static
-- ROLE_PERMISSIONS defaults (packages/core). Adds:
--   1. role_default_permissions  — GLOBAL reference, seeded from the TS map.
--   2. role_permission_overrides — per-org, per-role deltas.
--   3. user_permission_overrides — per-org, per-user deltas (beat role deltas).
--   4. has_permission(org, perm) — SQL resolver for RLS (P2+ migrate write
--      policies onto it). Mirrors core's effectivePermissions().
--
-- Resolution order (last wins): static default → role override → user override.
-- Owner is special-cased to ALWAYS true so an org can never lock itself out.
--
-- PARITY: role_default_permissions is the SQL mirror of ROLE_PERMISSIONS. A
-- change to that TS map REQUIRES a follow-up migration to keep this table in
-- sync; pgTAP (0207 tests) + the app's fail-safe-to-static-defaults both guard
-- the gap. Owner rows are intentionally NOT seeded (owner is short-circuited).

-- ── 1. Global default reference ────────────────────────────────────────────
create table if not exists public.role_default_permissions (
  role        text not null,
  permission  text not null,
  primary key (role, permission)
);

-- Seed = flatten of ROLE_PERMISSIONS for admin/manager/staff/viewer
-- (generated from packages/core/src/constants/permissions.ts).
insert into public.role_default_permissions (role, permission) values
  ('admin', 'organization:update'),
  ('admin', 'billing:read'),
  ('admin', 'members:read'),
  ('admin', 'members:invite'),
  ('admin', 'members:remove'),
  ('admin', 'members:update_role'),
  ('admin', 'members:assign_categories'),
  ('admin', 'rentals:create'),
  ('admin', 'rentals:manage'),
  ('admin', 'items:read'),
  ('admin', 'items:create'),
  ('admin', 'items:update'),
  ('admin', 'items:delete'),
  ('admin', 'items:import'),
  ('admin', 'items:export'),
  ('admin', 'stock:adjust'),
  ('admin', 'stock:transfer'),
  ('admin', 'locations:read'),
  ('admin', 'locations:manage'),
  ('admin', 'categories:read'),
  ('admin', 'categories:manage'),
  ('admin', 'suppliers:read'),
  ('admin', 'suppliers:manage'),
  ('admin', 'purchase_orders:read'),
  ('admin', 'purchase_orders:manage'),
  ('admin', 'reports:read'),
  ('admin', 'reports:export'),
  ('admin', 'activity_logs:read'),
  ('admin', 'cycle_counts:assign'),
  ('admin', 'bundles:manage'),
  ('admin', 'bundles:distribute'),
  ('admin', 'orders:request'),
  ('admin', 'orders:approve'),
  ('admin', 'orders:assign_delivery'),
  ('admin', 'schedule:manage'),
  ('admin', 'ai:manage'),
  ('admin', 'integrations:manage'),
  ('admin', 'shipping:manage'),
  ('admin', 'returns:manage'),
  ('manager', 'members:read'),
  ('manager', 'members:assign_categories'),
  ('manager', 'items:read'),
  ('manager', 'items:create'),
  ('manager', 'items:update'),
  ('manager', 'items:import'),
  ('manager', 'items:export'),
  ('manager', 'stock:adjust'),
  ('manager', 'stock:transfer'),
  ('manager', 'locations:read'),
  ('manager', 'locations:manage'),
  ('manager', 'categories:read'),
  ('manager', 'categories:manage'),
  ('manager', 'suppliers:read'),
  ('manager', 'suppliers:manage'),
  ('manager', 'purchase_orders:read'),
  ('manager', 'purchase_orders:manage'),
  ('manager', 'reports:read'),
  ('manager', 'reports:export'),
  ('manager', 'activity_logs:read'),
  ('manager', 'cycle_counts:assign'),
  ('manager', 'bundles:manage'),
  ('manager', 'bundles:distribute'),
  ('manager', 'orders:request'),
  ('manager', 'orders:approve'),
  ('manager', 'orders:assign_delivery'),
  ('manager', 'schedule:manage'),
  ('manager', 'rentals:create'),
  ('manager', 'rentals:manage'),
  ('manager', 'returns:manage'),
  ('staff', 'members:read'),
  ('staff', 'items:read'),
  ('staff', 'items:create'),
  ('staff', 'items:update'),
  ('staff', 'items:import'),
  ('staff', 'stock:adjust'),
  ('staff', 'stock:transfer'),
  ('staff', 'locations:read'),
  ('staff', 'categories:read'),
  ('staff', 'suppliers:read'),
  ('staff', 'purchase_orders:read'),
  ('staff', 'reports:read'),
  ('staff', 'bundles:distribute'),
  ('staff', 'orders:request'),
  ('staff', 'rentals:create'),
  ('viewer', 'members:read'),
  ('viewer', 'items:read'),
  ('viewer', 'locations:read'),
  ('viewer', 'categories:read'),
  ('viewer', 'suppliers:read'),
  ('viewer', 'purchase_orders:read'),
  ('viewer', 'orders:request')
on conflict (role, permission) do nothing;

alter table public.role_default_permissions enable row level security;

-- Read-only static reference: any authenticated user may read it; only
-- migrations write it (no insert/update/delete grant).
drop policy if exists role_default_permissions_select on public.role_default_permissions;
create policy role_default_permissions_select on public.role_default_permissions
  for select to authenticated
  using (true);

grant select on public.role_default_permissions to authenticated;

-- ── 2. Per-org role overrides ──────────────────────────────────────────────
create table if not exists public.role_permission_overrides (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role            text not null check (role in ('owner','admin','manager','staff','viewer')),
  permission      text not null,
  granted         boolean not null,
  updated_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, role, permission)
);

alter table public.role_permission_overrides enable row level security;

-- Any active org member may READ the org's role overrides (needed so the app
-- can compute each member's effective permissions under their own RLS).
drop policy if exists role_permission_overrides_select on public.role_permission_overrides;
create policy role_permission_overrides_select on public.role_permission_overrides
  for select to authenticated
  using ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'viewer') ) );

-- Only admins+ may WRITE overrides.
drop policy if exists role_permission_overrides_insert on public.role_permission_overrides;
create policy role_permission_overrides_insert on public.role_permission_overrides
  for insert to authenticated
  with check ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) );

drop policy if exists role_permission_overrides_update on public.role_permission_overrides;
create policy role_permission_overrides_update on public.role_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) )
  with check ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) );

drop policy if exists role_permission_overrides_delete on public.role_permission_overrides;
create policy role_permission_overrides_delete on public.role_permission_overrides
  for delete to authenticated
  using ( ( SELECT public.has_org_role(role_permission_overrides.organization_id, 'admin') ) );

grant select, insert, update, delete on public.role_permission_overrides to authenticated;

-- ── 3. Per-user overrides ──────────────────────────────────────────────────
create table if not exists public.user_permission_overrides (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  permission      text not null,
  granted         boolean not null,
  updated_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id, permission)
);

alter table public.user_permission_overrides enable row level security;

-- A user may read THEIR OWN overrides (to compute their effective perms);
-- admins+ may read all of the org's user overrides (to render the matrix).
drop policy if exists user_permission_overrides_select on public.user_permission_overrides;
create policy user_permission_overrides_select on public.user_permission_overrides
  for select to authenticated
  using (
    user_permission_overrides.user_id = ( SELECT auth.uid() )
    or ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') )
  );

drop policy if exists user_permission_overrides_insert on public.user_permission_overrides;
create policy user_permission_overrides_insert on public.user_permission_overrides
  for insert to authenticated
  with check ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) );

drop policy if exists user_permission_overrides_update on public.user_permission_overrides;
create policy user_permission_overrides_update on public.user_permission_overrides
  for update to authenticated
  using ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) )
  with check ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) );

drop policy if exists user_permission_overrides_delete on public.user_permission_overrides;
create policy user_permission_overrides_delete on public.user_permission_overrides
  for delete to authenticated
  using ( ( SELECT public.has_org_role(user_permission_overrides.organization_id, 'admin') ) );

grant select, insert, update, delete on public.user_permission_overrides to authenticated;

-- ── 4. has_permission(org, perm) — SQL resolver for RLS ────────────────────
-- security definer so it reads the override tables regardless of the caller's
-- RLS (mirrors has_org_role). Resolution: owner ⇒ true; else user override →
-- role override → static default → false. Returns false for non-members.
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
