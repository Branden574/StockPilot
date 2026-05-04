-- ============================================================================
-- 0007_internal_company.sql — Internal-company inventory model
--
-- Pivots the app from public SaaS to invite-only internal tool:
--   • New entity: charters (top-level group, renamable per-org)
--   • New entity: warehouses (first-class, charter-scoped, contact info)
--   • Existing locations become bins/zones inside a warehouse
--   • New entity: user_warehouse_assignments (which warehouses a user can
--     access). Super admin / manager have implicit access to all.
--   • organizations gains a terminology JSONB so "Charter" can be relabeled
--     ("Region", "Division", "Branch") without schema changes.
--   • inventory_items gains warehouse_id for fast warehouse-scoped queries.
--   • RLS helper: user_can_access_warehouse() — used in policies + services.
--   • Audit log writer: log_audit() function, signature stable for app layer.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────
-- TERMINOLOGY: per-org configurable labels
-- ─────────────────────────────────────────────────────────────────────
alter table public.organizations
  add column if not exists terminology jsonb not null default jsonb_build_object(
    'charter_singular', 'Charter',
    'charter_plural',   'Charters',
    'warehouse_singular', 'Warehouse',
    'warehouse_plural',   'Warehouses'
  );

-- ─────────────────────────────────────────────────────────────────────
-- CHARTERS (a.k.a. region / division / branch)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.charters (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  code            text,
  description     text,
  status          text not null default 'active'
                  check (status in ('active', 'inactive', 'archived')),
  notes           text,
  created_by      uuid references public.user_profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, code)
);
create index if not exists charters_org_idx on public.charters(organization_id);
create trigger charters_set_updated_at
  before update on public.charters
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- WAREHOUSES (first-class)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.warehouses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  charter_id      uuid references public.charters(id) on delete set null,
  name            text not null,
  code            text not null,
  address         jsonb,
  contact_name    text,
  contact_email   citext,
  contact_phone   text,
  manager_user_id uuid references public.user_profiles(id) on delete set null,
  status          text not null default 'active'
                  check (status in ('active', 'inactive', 'archived')),
  notes           text,
  created_by      uuid references public.user_profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, code)
);
create index if not exists warehouses_org_idx on public.warehouses(organization_id);
create index if not exists warehouses_charter_idx on public.warehouses(charter_id);
create trigger warehouses_set_updated_at
  before update on public.warehouses
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- LOCATIONS gain a warehouse_id (existing rows get backfilled below)
-- ─────────────────────────────────────────────────────────────────────
alter table public.locations
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;
create index if not exists locations_warehouse_idx on public.locations(warehouse_id);

-- ─────────────────────────────────────────────────────────────────────
-- INVENTORY_ITEMS gain a warehouse_id (the item's home warehouse)
-- ─────────────────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;
create index if not exists inventory_items_warehouse_idx
  on public.inventory_items(organization_id, warehouse_id)
  where deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────
-- USER ↔ WAREHOUSE assignments
-- A user with role staff/viewer is restricted to these. Manager/admin/owner
-- have implicit access to all warehouses in their org.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.user_warehouse_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete cascade,
  charter_id      uuid references public.charters(id) on delete set null,
  is_primary      boolean not null default true,
  assigned_by     uuid references public.user_profiles(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  unique (user_id, warehouse_id)
);
create index if not exists user_warehouse_assignments_user_idx
  on public.user_warehouse_assignments(user_id);
create index if not exists user_warehouse_assignments_wh_idx
  on public.user_warehouse_assignments(warehouse_id);

-- ─────────────────────────────────────────────────────────────────────
-- ORGANIZATION_INVITES gain warehouse + charter assignment fields
-- ─────────────────────────────────────────────────────────────────────
alter table public.organization_invites
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null,
  add column if not exists charter_id   uuid references public.charters(id)   on delete set null,
  add column if not exists message      text;

-- ─────────────────────────────────────────────────────────────────────
-- BACKFILL: every org that already has locations gets a default
-- "Main Warehouse", and existing locations + items roll up to it.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  org_row record;
  new_wh_id uuid;
begin
  for org_row in
    select id, name from public.organizations
    where exists (
      select 1 from public.locations l where l.organization_id = organizations.id
    ) and not exists (
      select 1 from public.warehouses w where w.organization_id = organizations.id
    )
  loop
    insert into public.warehouses (organization_id, name, code, status)
    values (org_row.id, 'Main Warehouse', 'MAIN', 'active')
    returning id into new_wh_id;

    update public.locations
       set warehouse_id = new_wh_id
     where organization_id = org_row.id and warehouse_id is null;

    update public.inventory_items
       set warehouse_id = new_wh_id
     where organization_id = org_row.id and warehouse_id is null;
  end loop;
end$$;

-- ─────────────────────────────────────────────────────────────────────
-- HELPER: user_can_access_warehouse(uid, wh_id, op)
-- op is 'read' or 'write'. Returns true if:
--   • user is owner/admin/manager in the warehouse's org
--   • OR user has a row in user_warehouse_assignments for this warehouse
--     AND (op = 'read' OR user role >= staff)
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.user_can_access_warehouse(
  p_user_id uuid,
  p_warehouse_id uuid,
  p_op text default 'read'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with wh as (
    select organization_id from public.warehouses where id = p_warehouse_id
  ),
  member as (
    select m.role
    from public.organization_members m, wh
    where m.user_id = p_user_id
      and m.organization_id = wh.organization_id
      and m.accepted_at is not null
    limit 1
  )
  select case
    -- super admin + manager: full access
    when (select role from member) in ('owner', 'admin', 'manager') then true
    -- staff/viewer: must be assigned, and viewer can only read
    when (select role from member) = 'staff' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    when (select role from member) = 'viewer' and p_op = 'read' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    else false
  end;
$$;

grant execute on function public.user_can_access_warehouse(uuid, uuid, text) to authenticated;

-- Convenience: warehouses the calling user can read
create or replace function public.my_warehouse_ids()
returns table (warehouse_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with my_role as (
    select organization_id, role
    from public.organization_members
    where user_id = auth.uid() and accepted_at is not null
  )
  -- super_admin / manager: every warehouse in their org(s)
  select w.id
  from public.warehouses w
  join my_role mr on mr.organization_id = w.organization_id
  where mr.role in ('owner', 'admin', 'manager')
  union
  -- staff / viewer: only assigned warehouses
  select uwa.warehouse_id
  from public.user_warehouse_assignments uwa
  join my_role mr on mr.organization_id = uwa.organization_id
  where uwa.user_id = auth.uid()
    and mr.role in ('staff', 'viewer');
$$;

grant execute on function public.my_warehouse_ids() to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- AUDIT LOG WRITER (callable from app layer)
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.log_audit(
  p_organization_id uuid,
  p_event text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security invoker
as $$
  insert into public.audit_logs (organization_id, user_id, event, metadata)
  values (p_organization_id, auth.uid(), p_event, p_metadata);
$$;

grant execute on function public.log_audit(uuid, text, jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- RLS for the new tables
-- ─────────────────────────────────────────────────────────────────────
alter table public.charters enable row level security;
alter table public.warehouses enable row level security;
alter table public.user_warehouse_assignments enable row level security;

-- charters: org members can read; only admin+ can write
create policy charters_select on public.charters
  for select to authenticated
  using (public.is_org_member(organization_id));
create policy charters_admin_write on public.charters
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- warehouses: org members can read but only those they can access via the
-- helper; admin+ can write any.
create policy warehouses_select on public.warehouses
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    and (
      public.has_org_role(organization_id, 'manager')
      or public.user_can_access_warehouse(auth.uid(), id, 'read')
    )
  );
create policy warehouses_admin_write on public.warehouses
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- user_warehouse_assignments: a user can read their own; admin+ can manage.
create policy uwa_select_own on public.user_warehouse_assignments
  for select to authenticated
  using (user_id = auth.uid() or public.has_org_role(organization_id, 'admin'));
create policy uwa_admin_write on public.user_warehouse_assignments
  for all to authenticated
  using (public.has_org_role(organization_id, 'admin'))
  with check (public.has_org_role(organization_id, 'admin'));

-- ─────────────────────────────────────────────────────────────────────
-- Tighten existing inventory RLS so warehouse_user/viewer can only see
-- items in warehouses they're assigned to. Manager/admin unchanged.
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists inventory_items_select on public.inventory_items;
create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    public.is_org_member(organization_id)
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null  -- pre-migration items still visible
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'read')
    )
  );

drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated
  with check (
    public.has_org_role(organization_id, 'staff')
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (
    public.has_org_role(organization_id, 'staff')
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  )
  with check (
    public.has_org_role(organization_id, 'staff')
    and (
      public.has_org_role(organization_id, 'manager')
      or warehouse_id is null
      or public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write')
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- DONE
-- ─────────────────────────────────────────────────────────────────────
